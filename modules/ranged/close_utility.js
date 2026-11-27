'use strict';

const { Vec3 } = require('vec3');
const { isAirLike, isLiquidSource } = require('../constants');
const { findInventoryItem, ensureItemHeld } = require('../inventory_utils');
const { canSeeBlockFace, hasClearRaySegment } = require('../placement_los');

/**
 * High-tier Offensive Close-Utility Traps (`modules/ranged/close_utility.js`):
 * - Predictive Cobweb & Lava-Bucket traps (leads moving target 2–3 ticks ahead!)
 * - Strictly enforces 1-tick post-swap settle + aim alignment + `canSeeBlockFace` LOS
 * - Self-proximity safety guard (never burns self with own lava)
 * - Exposes `isManagingOwnLava()` so `LiquidDenyModule` never scoops our own offensive lava!
 */
const closeUtilityMethods = {
  isManagingOwnLava() {
    if (this.pendingAction && (this.pendingAction.type === 'lava_place' || this.pendingAction.type === 'lava_pickup')) {
      return true;
    }
    if (this.activeLavaPos && (Date.now() - this.activeLavaPlacedAt) < 2400) {
      return true;
    }
    return false;
  },

  _predictTrapCell(target) {
    if (!target || !target.position) return null;
    if (this.prediction && typeof this.prediction.predictPosition === 'function') {
      return this.prediction.predictPosition(target, 2).position.floored();
    }
    const vel = target.velocity || { x: 0, y: 0, z: 0 };
    return new Vec3(
      Math.floor(target.position.x + vel.x * 2),
      Math.floor(target.position.y),
      Math.floor(target.position.z + vel.z * 2)
    );
  },

  tryCloseUtility(target) {
    if (this.rangedCfg.enabled === false || !this.bot || !this.bot.entity || !target || !target.isValid || !target.position) {
      return false;
    }
    if (this.pendingAction || typeof this.bot.blockAt !== 'function') return false;

    const now = Date.now();
    const botPos = this.bot.entity.position;
    const eyePos = this.aimer ? this.aimer.getEyePosition() : botPos.offset(0, 1.62, 0);

    // 1. Scheduled pickup of our own previously placed offensive lava
    if (this.activeLavaPos) {
      const pickupDelay = this.rangedCfg.lavaPickupDelayMs !== undefined ? this.rangedCfg.lavaPickupDelayMs : 1400;
      const elapsed = now - this.activeLavaPlacedAt;
      if (elapsed > 4500) {
        this.activeLavaPos = null;
      } else if (elapsed >= pickupDelay) {
        const b = this.bot.blockAt(this.activeLavaPos);
        const center = this.activeLavaPos.offset(0.5, 0.35, 0.5);
        const emptyBucket = findInventoryItem(this.bot, 'bucket');
        if (
          emptyBucket &&
          isLiquidSource(b) && b.name === 'lava' &&
          eyePos.distanceTo(center) <= 4.3 &&
          hasClearRaySegment(this.bot, eyePos, center)
        ) {
          this.pendingAction = {
            type: 'lava_pickup',
            item: emptyBucket.item,
            targetPos: this.activeLavaPos.clone(),
            aimPos: center,
            ticks: 0,
            settleTicks: 0
          };
          return true;
        }
        if (!isLiquidSource(b)) {
          this.activeLavaPos = null;
        }
      }
    }

    const dist = botPos.distanceTo(target.position);

    // 2. Predictive Offensive Cobweb
    if (this.rangedCfg.cobwebEnabled !== false) {
      const minR = this.rangedCfg.cobwebMinRange !== undefined ? this.rangedCfg.cobwebMinRange : 2.2;
      const maxR = this.rangedCfg.cobwebMaxRange !== undefined ? this.rangedCfg.cobwebMaxRange : 4.0;
      const cd = this.rangedCfg.cobwebCooldownMs !== undefined ? this.rangedCfg.cobwebCooldownMs : 5500;
      const web = (dist >= minR && dist <= maxR && (now - this.lastCobwebAt) >= cd)
        ? findInventoryItem(this.bot, 'cobweb')
        : null;

      if (web) {
        const trapCell = this._predictTrapCell(target);
        const existing = trapCell ? this.bot.blockAt(trapCell) : null;
        const floorPos = trapCell ? trapCell.offset(0, -1, 0) : null;
        const floorBlock = floorPos ? this.bot.blockAt(floorPos) : null;
        const botFeet = botPos.floored();

        if (
          trapCell && existing && isAirLike(existing) &&
          floorBlock && floorBlock.boundingBox === 'block' &&
          !(trapCell.x === botFeet.x && trapCell.z === botFeet.z) &&
          trapCell.offset(0.5, 0.5, 0.5).distanceTo(botPos) >= 1.4
        ) {
          const vis = canSeeBlockFace(this.bot, floorPos, new Vec3(0, 1, 0), { aimer: this.aimer, maxReach: 4.4 });
          if (vis) {
            this.pendingAction = {
              type: 'cobweb',
              item: web.item,
              refPos: floorPos,
              face: new Vec3(0, 1, 0),
              aimPos: vis.aimPos,
              ticks: 0,
              settleTicks: 0
            };
            return true;
          }
        }
      }
    }

    // 3. Predictive Offensive Lava Bucket (strict LOS + self-burn protection!)
    if (this.rangedCfg.lavaEnabled !== false) {
      const minR = this.rangedCfg.lavaMinRange !== undefined ? this.rangedCfg.lavaMinRange : 2.5;
      const maxR = this.rangedCfg.lavaMaxRange !== undefined ? this.rangedCfg.lavaMaxRange : 4.0;
      const cd = this.rangedCfg.lavaCooldownMs !== undefined ? this.rangedCfg.lavaCooldownMs : 7500;
      const lava = (dist >= minR && dist <= maxR && (now - this.lastLavaAt) >= cd && this.bot.health >= 11)
        ? findInventoryItem(this.bot, 'lava_bucket')
        : null;

      if (lava) {
        const trapCell = this._predictTrapCell(target);
        const existing = trapCell ? this.bot.blockAt(trapCell) : null;
        const floorPos = trapCell ? trapCell.offset(0, -1, 0) : null;
        const floorBlock = floorPos ? this.bot.blockAt(floorPos) : null;

        // Self-burn safety: keep at least 2.1b separation from bot feet so lava flow doesn't touch us
        if (
          trapCell && existing && isAirLike(existing) &&
          floorBlock && floorBlock.boundingBox === 'block' &&
          trapCell.offset(0.5, 0.5, 0.5).distanceTo(botPos) >= 2.1
        ) {
          const vis = canSeeBlockFace(this.bot, floorPos, new Vec3(0, 1, 0), { aimer: this.aimer, maxReach: 4.3 });
          if (vis) {
            this.pendingAction = {
              type: 'lava_place',
              item: lava.item,
              targetPos: trapCell,
              refPos: floorPos,
              face: new Vec3(0, 1, 0),
              aimPos: vis.aimPos,
              ticks: 0,
              settleTicks: 0
            };
            return true;
          }
        }
      }
    }

    return false;
  },

  _tickPendingCloseUtility(act) {
    const aim = this.aimer
      ? this.aimer.stepTowardsPoint(act.aimPos, { speedMultiplier: 2.0, toleranceRad: 0.22 })
      : { aligned: true };

    if (typeof this.bot.setControlState === 'function') {
      this.bot.setControlState('sprint', false);
    }

    const eq = ensureItemHeld(this.bot, { item: act.item });
    if (eq.swapped || !eq.held || !aim.aligned) {
      act.settleTicks = eq.swapped ? 1 : act.settleTicks;
      return true;
    }
    if (act.settleTicks > 0) {
      act.settleTicks--;
      return true;
    }

    const now = Date.now();
    if (act.type === 'cobweb') {
      const refBlock = this.bot.blockAt(act.refPos);
      if (
        refBlock &&
        refBlock.boundingBox === 'block' &&
        typeof this.bot.placeBlock === 'function' &&
        canSeeBlockFace(this.bot, act.refPos, act.face, { aimer: this.aimer, maxReach: 4.5 })
      ) {
        Promise.resolve(this.bot.placeBlock(refBlock, act.face)).catch(() => {});
        this.lastCobwebAt = now;
      }
      this.pendingAction = null;
      return true;
    }

    if (act.type === 'lava_place') {
      if (
        typeof this.bot.activateItem === 'function' &&
        canSeeBlockFace(this.bot, act.refPos, act.face, { aimer: this.aimer, maxReach: 4.5 })
      ) {
        this.bot.activateItem(false);
        this.lastLavaAt = now;
        this.activeLavaPos = act.targetPos.clone();
        this.activeLavaPlacedAt = now;
      }
      this.pendingAction = null;
      return true;
    }

    if (act.type === 'lava_pickup') {
      const eyePos = this.aimer ? this.aimer.getEyePosition() : this.bot.entity.position.offset(0, 1.62, 0);
      if (
        typeof this.bot.activateItem === 'function' &&
        hasClearRaySegment(this.bot, eyePos, act.aimPos)
      ) {
        this.bot.activateItem(false);
      }
      this.activeLavaPos = null;
      this.pendingAction = null;
      return true;
    }

    this.pendingAction = null;
    return false;
  }
};

module.exports = { closeUtilityMethods };
