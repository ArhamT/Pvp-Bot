'use strict';

const { findInventoryItem, ensureItemHeld } = require('../inventory_utils');
const { canThrowPearl, markPearlThrown } = require('../pearl_ballistics');

/**
 * Lava escape, Fire self-extinguish, and Water shore climb mixin for EscapeModule.
 * Uses unified `WaterBucketController` and shared `pearl_ballistics` cooldowns.
 */
const liquidEscapeMethods = {
  _findNearestWaterSource(centerPos, maxRadius = 3) {
    return this.waterCtrl.findNearestWater(centerPos, maxRadius);
  },

  _tickLavaEscape(target) {
    const now = Date.now();
    this._setActiveMode('LAVA_ESCAPE');
    this.modeTicks++;

    if (typeof this.bot.setControlState === 'function') {
      this.bot.setControlState('sneak', false);
      this.bot.setControlState('jump', true);
    }

    // 1. Continue or start Water Bucket extinguish / obsidian bridge
    if (this.waterCtrl.isActive('lava')) {
      const busy = this.waterCtrl.tick({
        kind: 'lava',
        pitchOverride: -Math.PI / 2,
        pickupTicks: 3,
        checkStillNeeded: () => this.isInLava()
      });
      if (!busy && !this.isInLava()) {
        this._setActiveMode('IDLE');
      }
      return busy || this.isInLava();
    }

    if (!this.isInLava()) {
      this._setActiveMode('IDLE');
      return false;
    }

    const waterCooldown = this.escapeCfg.lavaWaterCooldownMs || 2500;
    if (this.waterCtrl.canStart('lava', waterCooldown, now)) {
      return this.waterCtrl.tick({
        kind: 'lava',
        pitchOverride: -Math.PI / 2,
        pickupTicks: 3,
        checkStillNeeded: () => this.isInLava()
      });
    }

    // 2. Steer toward nearest dry land
    const awayPos = (target && target.position) ? target.position : null;
    const dryExit = this._findBestEscapeYaw(awayPos, true);
    if (dryExit && !dryExit.hasLava) {
      this.pearlSettleTicks = 0;
      if (this.aimer) {
        this.aimer.stepTowardsAngles(dryExit.yaw, 0.05, { speedMultiplier: 1.5, toleranceRad: 0.25 });
      }
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

    // 3. Boxed in lava pit: Ender Pearl out upward toward safe open sky (cooldown-gated!)
    const pearl = canThrowPearl(this.bot, { emergency: true, cooldownMs: 1800, now })
      ? findInventoryItem(this.bot, 'ender_pearl')
      : null;
    if (pearl) {
      const escapeYaw = dryExit
        ? dryExit.yaw
        : (awayPos
            ? Math.atan2(-(this.bot.entity.position.x - awayPos.x), -(this.bot.entity.position.z - awayPos.z))
            : this.bot.entity.yaw);
      const aim = this.aimer
        ? this.aimer.stepTowardsAngles(escapeYaw, 40 * (Math.PI / 180), { speedMultiplier: 1.7, toleranceRad: 0.25 })
        : { aligned: true };
      const eq = ensureItemHeld(this.bot, pearl);
      if (eq.swapped || !eq.held || !aim.aligned) {
        this.pearlSettleTicks = eq.swapped ? 1 : this.pearlSettleTicks;
        return true;
      }
      if (this.pearlSettleTicks > 0) {
        this.pearlSettleTicks--;
        return true;
      }
      if (typeof this.bot.activateItem === 'function') {
        this.bot.activateItem(false);
        markPearlThrown(this.bot, 'lava_escape', now);
      }
      return true;
    }

    // 4. Fallback: pillar out using solid block under feet
    return this._tickPillarOut() || true;
  },

  /**
   * Water Bucket self-extinguish when taking fire damage (Fire Aspect, Flame bow, fire blocks).
   * Skips when Fire Resistance is active (MC 1.20.4 & 1.20.5+ ID-safe), in Nether, or mid-air.
   */
  _tickFireExtinguish(context = {}) {
    const now = Date.now();
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) {
      this.waterCtrl.cancel();
      return false;
    }

    if (this.waterCtrl.isActive('fire')) {
      const busy = this.waterCtrl.tick({
        kind: 'fire',
        pitchOverride: -Math.PI / 2,
        pickupTicks: 3,
        checkStillNeeded: () => this.isOnFire()
      });
      if (!busy) {
        this._setActiveMode('IDLE');
      }
      return busy;
    }

    if (!this.isOnFire() || this.hasFireResistance(context) || this.isInWater()) {
      return false;
    }

    const cooldown = this.escapeCfg.fireWaterCooldownMs || 2500;
    if (!this.waterCtrl.canStart('fire', cooldown, now)) {
      return false;
    }

    // Only place water when grounded or within 2 blocks of solid ground
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
    if (!hasGroundBelow) return false;

    this._setActiveMode('FIRE_EXTINGUISH');
    return this.waterCtrl.tick({
      kind: 'fire',
      pitchOverride: -Math.PI / 2,
      pickupTicks: 3,
      checkStillNeeded: () => this.isOnFire()
    });
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

    this._setActiveMode('WATER_ESCAPE');
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
  }
};

module.exports = { liquidEscapeMethods };
