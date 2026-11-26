'use strict';

const { Vec3 } = require('vec3');
const { isAirLike } = require('../constants');
const { findNearestLiquidSource } = require('../inventory_utils');

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
    if (refBlock && refBlock.boundingBox === 'block' && isAirLike(this.bot.blockAt(feetPos))) {
      Promise.resolve(this.bot.placeBlock(refBlock, new Vec3(0, 1, 0))).catch(() => {});
    }
    this.pillarActive = false;
    return true;
  }
};

module.exports = { liquidEscapeMethods, PILLAR_BLOCK_PRIORITY };
