'use strict';

const { Vec3 } = require('vec3');
const { isAirLike } = require('../constants');
const { findNearestLiquidSource } = require('../inventory_utils');
const { canSeeBlockFace } = require('../placement_los');

const PILLAR_BLOCK_PRIORITY = [
  'obsidian', 'cobbled_deepslate', 'cobblestone', 'stone', 'deepslate',
  'netherrack', 'dirt', 'oak_planks', 'spruce_planks', 'end_stone'
];

/**
 * Lava escape, water shore climb, water-source lookup, and pillar-out mixin for EscapeModule.
 */
const liquidEscapeMethods = {
  _findNearestWaterSource(centerPos, maxRadius = 3) {
    const found = findNearestLiquidSource(this.bot, this.aimer, centerPos, 4.3, {
      liquidName: 'water',
      maxRadius
    });
    return found ? found.pos : null;
  },

  _tickLavaEscape(target) {
    const now = Date.now();
    this.activeMode = 'LAVA_ESCAPE';
    this.modeTicks++;

    if (typeof this.bot.setControlState === 'function') {
      this.bot.setControlState('sneak', false);
      this.bot.setControlState('jump', true);
    }

    // 1. Water bucket extinguish / obsidian bridge when available
    if (this.lavaWaterState === 'EQUIP_WAIT') {
      this.lavaWaterTicks--;
      this.aimer.stepTowardsAngles(this.bot.entity.yaw, -Math.PI / 2, { speedMultiplier: 1.6, force: true });
      if (this.lavaWaterTicks <= 0 && this.bot.heldItem && this.bot.heldItem.name === 'water_bucket') {
        if (typeof this.bot.activateItem === 'function') this.bot.activateItem(false);
        this.lastLavaWaterAt = now;
        this.lavaWaterState = 'PICKUP_WAIT';
        this.lavaWaterTicks = 2;
      }
      return true;
    }

    if (this.lavaWaterState === 'PICKUP_WAIT') {
      this.lavaWaterTicks--;
      const emptyBucket = this._findItem('bucket');
      const waterSrc = this._findNearestWaterSource(this.bot.entity.position, 3);
      if (emptyBucket && waterSrc) {
        const eq = this._ensureItemHeld(emptyBucket);
        this.aimer.stepTowardsPoint(waterSrc.offset(0.5, 0.35, 0.5), { speedMultiplier: 1.8, force: true });
        if (!eq.swapped) {
          if (typeof this.bot.activateItem === 'function') this.bot.activateItem(false);
          if (this.lavaWaterTicks <= 0) {
            this.lavaWaterState = 'IDLE';
          }
        }
        return true;
      }
      if (this.lavaWaterTicks <= 0) {
        this.lavaWaterState = 'IDLE';
      }
      return true;
    }

    if (!this.isInLava()) {
      this.activeMode = 'IDLE';
      this.modeTicks = 0;
      return false;
    }

    const waterCooldown = this.escapeCfg.lavaWaterCooldownMs || 2500;
    const waterBucket = (now - this.lastLavaWaterAt) >= waterCooldown ? this._findItem('water_bucket') : null;
    if (waterBucket) {
      const eq = this._ensureItemHeld(waterBucket);
      this.aimer.stepTowardsAngles(this.bot.entity.yaw, -Math.PI / 2, { speedMultiplier: 1.6, force: true });
      if (eq.swapped) {
        this.lavaWaterState = 'EQUIP_WAIT';
        this.lavaWaterTicks = 1;
      } else {
        if (typeof this.bot.activateItem === 'function') this.bot.activateItem(false);
        this.lastLavaWaterAt = now;
        this.lavaWaterState = 'PICKUP_WAIT';
        this.lavaWaterTicks = 2;
      }
      return true;
    }

    // 2. Steer toward nearest dry land
    const awayPos = (target && target.position) ? target.position : null;
    const dryExit = this._findBestEscapeYaw(awayPos, true);
    if (dryExit && !dryExit.hasLava) {
      this.pearlSettleTicks = 0;
      this.aimer.stepTowardsAngles(dryExit.yaw, 0.05, { speedMultiplier: 1.4, toleranceRad: 0.25 });
      if (typeof this.bot.setControlState === 'function') {
        this.bot.setControlState('forward', true);
        this.bot.setControlState('back', false);
        this.bot.setControlState('left', false);
        this.bot.setControlState('right', false);
        this.bot.setControlState('sprint', false);
        this.bot.setControlState('jump', true);
      }
      return true;
    }

    // 3. Boxed in lava pit: Ender Pearl out upward toward sky
    const pearl = this._findItem('ender_pearl');
    if (pearl) {
      const eq = this._ensureItemHeld(pearl);
      const escapeYaw = awayPos
        ? Math.atan2(-(this.bot.entity.position.x - awayPos.x), -(this.bot.entity.position.z - awayPos.z))
        : this.bot.entity.yaw;
      this.aimer.stepTowardsAngles(escapeYaw, 40 * (Math.PI / 180), { speedMultiplier: 1.6, force: true });
      if (eq.swapped) {
        this.pearlSettleTicks = 1;
        return true;
      }
      if (this.pearlSettleTicks > 0) {
        this.pearlSettleTicks--;
        return true;
      }
      if (typeof this.bot.activateItem === 'function') {
        this.bot.activateItem(false);
      }
      return true;
    }

    // 4. Fallback: pillar out using solid block under feet
    return this._tickPillarOut() || true;
  },

  /**
   * 1-tick Water Bucket self-extinguish when taking fire damage (Fire Aspect, Flame bow, flint & steel, fire blocks).
   * Skips when Fire Resistance is active, in the Nether, or high in mid-air without ground beneath.
   */
  _tickFireExtinguish(context = {}) {
    const now = Date.now();
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) {
      this.fireWaterState = 'IDLE';
      this.fireWaterPos = null;
      return false;
    }

    // Water evaporates in the Nether
    const dim = String((this.bot.game && this.bot.game.dimension) || '').toLowerCase();
    if (dim.includes('nether')) {
      this.fireWaterState = 'IDLE';
      this.fireWaterPos = null;
      return false;
    }

    // Phase 1: Waiting 1 settle tick after swapping to water_bucket
    if (this.fireWaterState === 'EQUIP_PLACE') {
      const wb = this._findItem('water_bucket');
      if (!wb || (!this.isOnFire() && this.fireWaterTicks <= 0)) {
        this.fireWaterState = 'IDLE';
        this.fireWaterPos = null;
        this.activeMode = 'IDLE';
        return false;
      }
      this.aimer.stepTowardsAngles(this.bot.entity.yaw, -Math.PI / 2, { speedMultiplier: 1.8, force: true });
      const eq = this._ensureItemHeld(wb);
      if (eq.swapped || !eq.held) return true;
      if (typeof this.bot.activateItem === 'function') {
        this.bot.activateItem(false);
      }
      this.lastFireWaterAt = now;
      this.fireWaterPos = this.bot.entity.position.floored();
      this.fireWaterState = 'PICKUP_WAIT';
      this.fireWaterTicks = 3;
      return true;
    }

    // Phase 2: Scoop water right back up into empty bucket after fire is extinguished
    if (this.fireWaterState === 'PICKUP_WAIT') {
      this.fireWaterTicks--;
      const emptyBucket = this._findItem('bucket');
      const waterSrc = this._findNearestWaterSource(this.fireWaterPos || this.bot.entity.position, 3);
      if (this.fireWaterTicks <= 2 && emptyBucket && waterSrc) {
        this.aimer.stepTowardsPoint(waterSrc.offset(0.5, 0.35, 0.5), { speedMultiplier: 1.8, force: true });
        const eq = this._ensureItemHeld(emptyBucket);
        if (!eq.swapped && eq.held) {
          if (typeof this.bot.activateItem === 'function') {
            this.bot.activateItem(false);
          }
          this.fireWaterState = 'IDLE';
          this.fireWaterPos = null;
          this.activeMode = 'IDLE';
        }
        return true;
      }
      if (this.fireWaterTicks <= 0 || !emptyBucket) {
        this.fireWaterState = 'IDLE';
        this.fireWaterPos = null;
        this.activeMode = 'IDLE';
        return false;
      }
      return true;
    }

    // Entry gate: must be on fire, without Fire Resistance, off cooldown, with water_bucket and ground beneath
    if (!this.isOnFire() || this.hasFireResistance(context) || this.isInWater()) {
      return false;
    }
    const cooldown = this.escapeCfg.fireWaterCooldownMs || 2500;
    if ((now - this.lastFireWaterAt) < cooldown) {
      return false;
    }
    const waterBucket = this._findItem('water_bucket');
    if (!waterBucket) {
      return false;
    }

    // Only place water when grounded or within 2 blocks of solid ground (don't waste mid-air)
    let hasGroundBelow = Boolean(this.bot.entity.onGround);
    if (!hasGroundBelow && typeof this.bot.blockAt === 'function') {
      const pos = this.bot.entity.position;
      for (let d = 1; d <= 2; d++) {
        const b = this.bot.blockAt(pos.offset(0, -d, 0));
        if (b && b.boundingBox === 'block') {
          hasGroundBelow = true;
          break;
        }
      }
    }
    if (!hasGroundBelow) {
      return false;
    }

    this.activeMode = 'FIRE_EXTINGUISH';
    this.aimer.stepTowardsAngles(this.bot.entity.yaw, -Math.PI / 2, { speedMultiplier: 1.8, force: true });
    const eq = this._ensureItemHeld(waterBucket);
    if (eq.swapped || !eq.held) {
      this.fireWaterState = 'EQUIP_PLACE';
      this.fireWaterTicks = 2;
      return true;
    }

    if (typeof this.bot.activateItem === 'function') {
      this.bot.activateItem(false);
    }
    this.lastFireWaterAt = now;
    this.fireWaterPos = this.bot.entity.position.floored();
    this.fireWaterState = 'PICKUP_WAIT';
    this.fireWaterTicks = 3;
    return true;
  },

  _tickWaterEscape(target) {
    if (!this.isInWater()) {
      this.waterStuckTicks = 0;
      this.lastWaterCheckPos = null;
      return false;
    }

    const pos = this.bot.entity.position;
    const headBlock = typeof this.bot.blockAt === 'function' ? this.bot.blockAt(pos.offset(0, 1, 0)) : null;
    const headSubmerged = Boolean(headBlock && (headBlock.name === 'water' || headBlock.name === 'flowing_water'));

    if (this.lastWaterCheckPos) {
      const dx = pos.x - this.lastWaterCheckPos.x;
      const dz = pos.z - this.lastWaterCheckPos.z;
      const moved = Math.sqrt(dx * dx + dz * dz);
      if (moved < 0.06 || this.bot.entity.isCollidedHorizontally || headSubmerged) {
        this.waterStuckTicks++;
      } else {
        this.waterStuckTicks = 0;
      }
    }
    this.lastWaterCheckPos = pos.clone();

    if (!headSubmerged && this.waterStuckTicks < 4) {
      return false;
    }

    this.activeMode = 'WATER_ESCAPE';
    const dryShore = this._findBestEscapeYaw(null, true);
    const desiredYaw = dryShore
      ? dryShore.yaw
      : (target && target.position
          ? Math.atan2(-(target.position.x - pos.x), -(target.position.z - pos.z))
          : this.bot.entity.yaw);

    if (this.aimer) {
      this.aimer.stepTowardsAngles(desiredYaw, 0.12, { speedMultiplier: 1.5 });
    }
    if (typeof this.bot.setControlState === 'function') {
      this.bot.setControlState('sneak', false);
      this.bot.setControlState('sprint', false);
      this.bot.setControlState('forward', true);
      this.bot.setControlState('back', false);
      this.bot.setControlState('left', false);
      this.bot.setControlState('right', false);
      this.bot.setControlState('jump', true);
    }
    return true;
  },

  _tickPillarOut() {
    if (typeof this.bot.placeBlock !== 'function' || typeof this.bot.blockAt !== 'function') return false;
    const pos = this.bot.entity.position;
    const aboveHead = this.bot.blockAt(pos.offset(0, 2, 0));
    if (aboveHead && aboveHead.boundingBox === 'block') return false;

    const blockRec = this._findItem(PILLAR_BLOCK_PRIORITY);
    if (!blockRec) return false;

    const eq = this._ensureItemHeld(blockRec);
    this.aimer.stepTowardsAngles(this.bot.entity.yaw, -Math.PI / 2, { speedMultiplier: 1.6, force: true });
    if (typeof this.bot.setControlState === 'function') {
      this.bot.setControlState('jump', true);
    }

    if (eq.swapped) {
      this.pillarSettleTicks = 1;
      this.pillarActive = true;
      return true;
    }
    if (this.pillarSettleTicks > 0) {
      this.pillarSettleTicks--;
      return true;
    }

    const belowPos = pos.floored().offset(0, -1, 0);
    const refBlock = this.bot.blockAt(belowPos);
    const feetPos = pos.floored();
    if (
      refBlock &&
      refBlock.boundingBox === 'block' &&
      isAirLike(this.bot.blockAt(feetPos)) &&
      canSeeBlockFace(this.bot, belowPos, new Vec3(0, 1, 0), { aimer: this.aimer, maxReach: 4.5 })
    ) {
      Promise.resolve(this.bot.placeBlock(refBlock, new Vec3(0, 1, 0))).catch(() => {});
    }
    this.pillarActive = false;
    return true;
  }
};

module.exports = { liquidEscapeMethods, PILLAR_BLOCK_PRIORITY };
