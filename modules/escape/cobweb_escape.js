'use strict';

const { findInventoryItem, ensureItemHeld } = require('../inventory_utils');
const { canThrowPearl, markPearlThrown } = require('../pearl_ballistics');

/**
 * 3-tier Cobweb Escape mixin for EscapeModule (0.6-wide hitbox aware):
 * 1. Water Bucket (via unified WaterBucketController) -> place on cobweb -> scoop back.
 * 2. Ender Pearl (shared cooldown + safe yaw + aim alignment + 1-tick settle).
 * 3. Sword / Shears dig (via BlockMiner).
 */
const cobwebEscapeMethods = {
  _tickCobwebEscape(cobwebBlock, target) {
    const now = Date.now();
    this._setActiveMode('COBWEB_ESCAPE');
    this.modeTicks++;

    if (typeof this.bot.setControlState === 'function') {
      this.bot.setControlState('sprint', false);
      this.bot.setControlState('sneak', false);
      if (
        cobwebBlock && cobwebBlock.position && this.bot.entity && this.bot.entity.position &&
        cobwebBlock.position.y >= Math.floor(this.bot.entity.position.y) + 2
      ) {
        this.bot.setControlState('jump', false);
      }
    }

    // Continue active cobweb water place/pickup
    if (this.waterCtrl.isActive('cobweb')) {
      const busy = this.waterCtrl.tick({
        kind: 'cobweb',
        targetPos: (cobwebBlock && cobwebBlock.position) || this.waterCtrl.targetPos,
        aimPoint: ((cobwebBlock && cobwebBlock.position) || this.waterCtrl.targetPos || this.bot.entity.position).offset(0.5, 0.1, 0.5),
        pickupTicks: 6,
        checkStillNeeded: () => Boolean(this.findOverlappingCobweb())
      });
      if (!busy) {
        this._setActiveMode('IDLE');
      }
      return busy;
    }

    if (!cobwebBlock) {
      this._setActiveMode('IDLE');
      return false;
    }

    // Tier 1: Water Bucket
    if (this.waterCtrl.canStart('cobweb', 500, now)) {
      const pos = cobwebBlock.position.floored();
      return this.waterCtrl.tick({
        kind: 'cobweb',
        targetPos: pos,
        aimPoint: pos.offset(0.5, 0.1, 0.5),
        pickupTicks: 6,
        checkStillNeeded: () => Boolean(this.findOverlappingCobweb())
      });
    }

    // Tier 2: Ender Pearl (shared cooldown + safe yaw + aim alignment)
    const pearl = canThrowPearl(this.bot, { emergency: true, cooldownMs: 2000, now })
      ? findInventoryItem(this.bot, 'ender_pearl')
      : null;
    if (pearl) {
      const openExit = this._findBestEscapeYaw(null, true);
      const escapeYaw = openExit
        ? openExit.yaw
        : (target && target.position
            ? Math.atan2(-(target.position.x - this.bot.entity.position.x), -(target.position.z - this.bot.entity.position.z))
            : this.bot.entity.yaw);
      const aim = this.aimer
        ? this.aimer.stepTowardsAngles(escapeYaw, 28 * (Math.PI / 180), { speedMultiplier: 1.7, toleranceRad: 0.25 })
        : { aligned: true };
      const eq = ensureItemHeld(this.bot, pearl);
      if (eq.swapped || !eq.held || !aim.aligned) {
        this.cobwebPearlSettleTicks = eq.swapped ? 1 : this.cobwebPearlSettleTicks;
        return true;
      }
      if (this.cobwebPearlSettleTicks > 0) {
        this.cobwebPearlSettleTicks--;
        return true;
      }
      if (typeof this.bot.activateItem === 'function') {
        this.bot.activateItem(false);
        markPearlThrown(this.bot, 'cobweb_escape', now);
      }
      this.lastCobwebPearlAt = now;
      this._setActiveMode('IDLE');
      return true;
    }

    // Tier 3: Break cobweb with Sword / Shears
    return this._tickBlockStuckEscape(cobwebBlock, true);
  }
};

module.exports = { cobwebEscapeMethods };
