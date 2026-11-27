'use strict';

const { findInventoryItem, ensureItemHeld, findNearestLiquidSource } = require('../inventory_utils');

/**
 * Unified anti-cheat-safe Water Bucket FSM (`EQUIP_PLACE -> PICKUP_WAIT`)
 * shared by Cobweb Escape, Fire Extinguish, and Lava Escape.
 * Enforces:
 * - 1-tick post-swap settle (`!eq.swapped && eq.held`)
 * - Aim alignment check before `activateItem(false)`
 * - Nether dimension guard (water evaporates in Nether)
 * - Clean bucket pickup recovery
 */
class WaterBucketController {
  constructor(bot, aimer) {
    this.bot = bot;
    this.aimer = aimer;
    this.state = 'IDLE'; // 'IDLE' | 'EQUIP_PLACE' | 'PICKUP_WAIT'
    this.kind = null; // 'cobweb' | 'fire' | 'lava'
    this.targetPos = null;
    this.ticks = 0;
    this.lastPlacedAt = { cobweb: 0, fire: 0, lava: 0 };
    this.failedUntil = { cobweb: 0, fire: 0, lava: 0 };
  }

  isActive(kind = null) {
    if (this.state === 'IDLE') return false;
    return kind ? this.kind === kind : true;
  }

  cancel() {
    this.state = 'IDLE';
    this.kind = null;
    this.targetPos = null;
    this.ticks = 0;
  }

  isInNether() {
    const dim = String((this.bot && this.bot.game && this.bot.game.dimension) || '').toLowerCase();
    return dim.includes('nether');
  }

  canStart(kind, cooldownMs = 2500, now = Date.now()) {
    if (this.isInNether()) return false;
    if (this.state !== 'IDLE' && this.kind !== kind) return false;
    if (now < (this.failedUntil[kind] || 0)) return false;
    if ((now - (this.lastPlacedAt[kind] || 0)) < cooldownMs) return false;
    return Boolean(findInventoryItem(this.bot, 'water_bucket'));
  }

  findNearestWater(centerPos, maxRadius = 3) {
    const found = findNearestLiquidSource(this.bot, this.aimer, centerPos, 4.3, {
      liquidName: 'water',
      maxRadius
    });
    return found ? found.pos : null;
  }

  /**
   * Advances or starts a water-bucket place-and-pickup cycle.
   * `options`: `{ kind, aimPoint, pitchOverride, pickupTicks, checkStillNeeded }`
   * Returns `true` while owning the tick, `false` once finished/aborted.
   */
  tick(options) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position || this.isInNether()) {
      this.cancel();
      return false;
    }

    const now = Date.now();
    const kind = options.kind;
    const pickupTicks = options.pickupTicks !== undefined ? options.pickupTicks : 4;

    if (this.state === 'PICKUP_WAIT' && this.kind === kind) {
      this.ticks--;
      const stillNeeded = typeof options.checkStillNeeded === 'function' ? options.checkStillNeeded() : false;
      const emptyBucket = findInventoryItem(this.bot, 'bucket');
      const waterSrc = this.findNearestWater(this.targetPos || this.bot.entity.position, 3);

      // Give server >= 1 tick for water to clear cobweb/fire before scooping
      if (this.ticks <= Math.max(1, pickupTicks - 1) && emptyBucket && waterSrc && (!stillNeeded || this.ticks <= 2)) {
        const aim = this.aimer
          ? this.aimer.stepTowardsPoint(waterSrc.offset(0.5, 0.35, 0.5), { speedMultiplier: 1.85, toleranceRad: 0.25 })
          : { aligned: true };
        const eq = ensureItemHeld(this.bot, emptyBucket);
        if (!eq.swapped && eq.held && aim.aligned) {
          if (typeof this.bot.activateItem === 'function') {
            this.bot.activateItem(false);
          }
          this.cancel();
          return false;
        }
        return true;
      }

      if (this.ticks <= 0 || (!stillNeeded && !emptyBucket)) {
        if (stillNeeded) {
          this.failedUntil[kind] = now + 2800;
        }
        this.cancel();
        return false;
      }
      return true;
    }

    // Start or continue EQUIP_PLACE
    const wb = findInventoryItem(this.bot, 'water_bucket');
    if (!wb) {
      this.cancel();
      return false;
    }

    this.kind = kind;
    this.state = 'EQUIP_PLACE';
    if (options.targetPos) {
      this.targetPos = options.targetPos.floored();
    } else if (!this.targetPos) {
      this.targetPos = this.bot.entity.position.floored();
    }

    let aim = { aligned: true };
    if (this.aimer) {
      if (options.aimPoint) {
        aim = this.aimer.stepTowardsPoint(options.aimPoint, { speedMultiplier: 1.85, toleranceRad: 0.25 });
      } else {
        const pitch = options.pitchOverride !== undefined ? options.pitchOverride : -Math.PI / 2;
        aim = this.aimer.stepTowardsAngles(this.bot.entity.yaw, pitch, { speedMultiplier: 1.85, toleranceRad: 0.25 });
      }
    }

    const eq = ensureItemHeld(this.bot, wb);
    if (eq.swapped || !eq.held || !aim.aligned) {
      return true;
    }

    if (typeof this.bot.activateItem === 'function') {
      this.bot.activateItem(false);
    }
    this.lastPlacedAt[kind] = now;
    this.state = 'PICKUP_WAIT';
    this.ticks = pickupTicks;
    return true;
  }
}

module.exports = { WaterBucketController };
