'use strict';

/**
 * Unified 3-tier Cobweb Escape mixin for EscapeModule (0.6-wide hitbox aware):
 * 1. Water Bucket: equip (1-tick settle) -> place water on cobweb -> scoop water back into bucket.
 * 2. Ender Pearl (when no water bucket or water failed): equip (1-tick settle) -> pearl out safely.
 * 3. Sword / Shears break (when no water bucket and no ender pearl): equip sword & dig the cobweb.
 */
const cobwebEscapeMethods = {
  _tickCobwebEscape(cobwebBlock, target) {
    const now = Date.now();
    this.activeMode = 'COBWEB_ESCAPE';
    this.modeTicks++;

    if (typeof this.bot.setControlState === 'function') {
      this.bot.setControlState('sprint', false);
      this.bot.setControlState('sneak', false);
    }

    // Phase A: Active water placement / pickup sub-states
    if (this.cobwebWaterState === 'EQUIP_PLACE') {
      const wb = this._findItem('water_bucket');
      const webPos = (cobwebBlock && cobwebBlock.position) || this.cobwebWaterPos;
      if (!wb || !webPos) {
        this.cobwebWaterState = 'IDLE';
        this.cobwebWaterPos = null;
        return false;
      }
      this.aimer.stepTowardsPoint(webPos.offset(0.5, 0.1, 0.5), { speedMultiplier: 1.8, force: true });
      const eq = this._ensureItemHeld(wb);
      if (eq.swapped || !eq.held) return true;
      if (typeof this.bot.activateItem === 'function') {
        this.bot.activateItem(false);
      }
      this.cobwebWaterState = 'WAIT_CLEAR_AND_PICKUP';
      this.cobwebWaterTicks = 6;
      return true;
    }

    if (this.cobwebWaterState === 'WAIT_CLEAR_AND_PICKUP') {
      this.cobwebWaterTicks--;
      const stillInWeb = Boolean(this.findOverlappingCobweb());
      const emptyBucket = this._findItem('bucket');
      const waterSrc = this._findNearestWaterSource(this.cobwebWaterPos || this.bot.entity.position, 3);

      // Give server at least 1 tick to clear cobweb & convert bucket before scooping back
      if (this.cobwebWaterTicks <= 5 && emptyBucket && waterSrc && (!stillInWeb || this.cobwebWaterTicks <= 3)) {
        this.aimer.stepTowardsPoint(waterSrc.offset(0.5, 0.35, 0.5), { speedMultiplier: 1.8, force: true });
        const eq = this._ensureItemHeld(emptyBucket);
        if (!eq.swapped && eq.held) {
          if (typeof this.bot.activateItem === 'function') {
            this.bot.activateItem(false);
          }
          this.cobwebWaterState = 'IDLE';
          this.cobwebWaterPos = null;
          this.activeMode = 'IDLE';
        }
        return true;
      }

      if (this.cobwebWaterTicks <= 0 || (!stillInWeb && !emptyBucket)) {
        if (stillInWeb) {
          this.cobwebWaterFailedUntil = now + 3000;
        }
        this.cobwebWaterState = 'IDLE';
        this.cobwebWaterPos = null;
        this.activeMode = 'IDLE';
        return false;
      }
      return true;
    }

    if (!cobwebBlock) {
      this.activeMode = 'IDLE';
      return false;
    }

    // Tier 1: Water Bucket
    const waterBucket = now >= this.cobwebWaterFailedUntil ? this._findItem('water_bucket') : null;
    if (waterBucket) {
      this.cobwebWaterPos = cobwebBlock.position.floored();
      this.aimer.stepTowardsPoint(this.cobwebWaterPos.offset(0.5, 0.1, 0.5), { speedMultiplier: 1.8, force: true });
      const eq = this._ensureItemHeld(waterBucket);
      if (eq.swapped || !eq.held) {
        this.cobwebWaterState = 'EQUIP_PLACE';
        return true;
      }
      if (typeof this.bot.activateItem === 'function') {
        this.bot.activateItem(false);
      }
      this.cobwebWaterState = 'WAIT_CLEAR_AND_PICKUP';
      this.cobwebWaterTicks = 6;
      return true;
    }

    // Tier 2: Ender Pearl (when no water bucket is available or water failed)
    const pearl = (now - this.lastCobwebPearlAt) >= 2000 ? this._findItem('ender_pearl') : null;
    if (pearl) {
      const openExit = this._findBestEscapeYaw(null, true);
      const escapeYaw = openExit
        ? openExit.yaw
        : (target && target.position
            ? Math.atan2(-(target.position.x - this.bot.entity.position.x), -(target.position.z - this.bot.entity.position.z))
            : this.bot.entity.yaw);
      this.aimer.stepTowardsAngles(escapeYaw, 28 * (Math.PI / 180), { speedMultiplier: 1.6, force: true });
      const eq = this._ensureItemHeld(pearl);
      if (eq.swapped || !eq.held) {
        this.cobwebPearlSettleTicks = 1;
        return true;
      }
      if (this.cobwebPearlSettleTicks > 0) {
        this.cobwebPearlSettleTicks--;
        return true;
      }
      if (typeof this.bot.activateItem === 'function') {
        this.bot.activateItem(false);
      }
      this.lastCobwebPearlAt = now;
      this.activeMode = 'IDLE';
      return true;
    }

    // Tier 3: Break cobweb with Sword (or shears fallback) when no water bucket & no ender pearl
    return this._tickBlockStuckEscape(cobwebBlock, true);
  }
};

module.exports = { cobwebEscapeMethods };
