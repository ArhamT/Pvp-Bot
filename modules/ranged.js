'use strict';

const {
  isHazardBlock,
  isPositionSafe,
  isDirectionSafe
} = require('./constants');
const { hasClearRaySegment } = require('./placement_los');
const { bowCrossbowMethods } = require('./ranged/bow_crossbow');
const { enderPearlSkillMethods } = require('./ranged/ender_pearl_skill');
const { closeUtilityMethods } = require('./ranged/close_utility');

/**
 * Modular Ranged & Tactical Utility Coordinator combining:
 * - `ranged/bow_crossbow.js`       — predictive Bow/Crossbow/Firework ballistics + DDA LOS
 * - `ranged/ender_pearl_skill.js`  — shared-cooldown Chase / Agro-Cancel / Defensive Pearls
 * - `ranged/close_utility.js`      — predictive 1-tick-settled Cobweb & Lava traps
 */
class RangedModule {
  constructor(bot, config, aimer, prediction = null) {
    this.bot = bot;
    this.config = config || {};
    this.rangedCfg = (config && config.ranged) ? config.ranged : {};
    this.aimer = aimer;
    this.prediction = prediction;

    // Active state
    this.pendingAction = null;
    this.drawingWeapon = null; // null | 'bow' | 'crossbow'
    this.drawTicks = 0;
    this.targetDrawTicks = 0;
    this.crossbowFirePending = false;
    this.crossbowFireTicks = 0;
    this.lastBowShotAt = 0;
    this.lastCrossbowShotAt = 0;
    this.rangedStrafeDir = Math.random() < 0.5 ? -1 : 1;
    this.rangedStrafeTicks = 12;

    // Close utility state
    this.lastCobwebAt = 0;
    this.lastLavaAt = 0;
    this.activeLavaPos = null;
    this.activeLavaPlacedAt = 0;

    // Combo hit tracker for agro-cancel pearls
    this.recentComboHits = 0;
    this.lastHurtAt = 0;

    this._onEntityHurt = (entity) => {
      if (!this.bot || !this.bot.entity || !entity || entity.id !== this.bot.entity.id) return;
      const now = Date.now();
      if ((now - this.lastHurtAt) < 1100) {
        this.recentComboHits++;
      } else {
        this.recentComboHits = 1;
      }
      this.lastHurtAt = now;
    };

    if (this.bot && typeof this.bot.on === 'function') {
      this.bot.on('entityHurt', this._onEntityHurt);
    }
  }

  dispose() {
    this.cancel();
    if (this.bot && typeof this.bot.removeListener === 'function') {
      this.bot.removeListener('entityHurt', this._onEntityHurt);
    }
  }

  notifyTeleport() {
    this.cancel();
  }

  isBusy() {
    return Boolean(this.pendingAction || this.drawingWeapon || this.crossbowFirePending);
  }

  cancel() {
    this._cancelBowDraw();
    this.pendingAction = null;
  }

  notifyTeleport() {
    this.cancel();
    this.activeLavaPos = null;
    this.activeLavaPlacedAt = 0;
  }

  hasClearLineOfSight(targetPos) {
    if (!this.bot || !this.bot.entity || !targetPos) return false;
    const eye = this.aimer ? this.aimer.getEyePosition() : this.bot.entity.position.offset(0, 1.62, 0);
    return hasClearRaySegment(this.bot, eye, targetPos);
  }

  isHazardBlock(block) {
    return isHazardBlock(block);
  }

  isPositionSafe(pos) {
    const maxDrop = this.rangedCfg.maxSafeDropBlocks !== undefined ? this.rangedCfg.maxSafeDropBlocks : 3;
    return isPositionSafe(this.bot, pos, maxDrop);
  }

  isDirectionSafe(yaw, dist = 1.5) {
    const maxDrop = this.rangedCfg.maxSafeDropBlocks !== undefined ? this.rangedCfg.maxSafeDropBlocks : 3;
    return isDirectionSafe(this.bot, -Math.sin(yaw), -Math.cos(yaw), dist, maxDrop);
  }

  tick(target) {
    if (this.rangedCfg.enabled === false || !this.bot || !this.bot.entity) {
      if (this.isBusy()) this.cancel();
      return false;
    }

    if (this.pendingAction) {
      this.pendingAction.ticks = (this.pendingAction.ticks || 0) + 1;
      if (this.pendingAction.ticks > 16) {
        this.pendingAction = null;
        return false;
      }
      if (this.pendingAction.type === 'pearl') {
        return this._tickPendingPearl(this.pendingAction);
      }
      return this._tickPendingCloseUtility(this.pendingAction);
    }

    // Opportunistic agro-cancel pearl when combo-locked
    if (target && target.isValid && this.tryEnderPearl(target, 'agro_cancel')) {
      return this._tickPendingPearl(this.pendingAction);
    }

    return this._tickBowOrCrossbow(target);
  }
}

Object.assign(
  RangedModule.prototype,
  bowCrossbowMethods,
  enderPearlSkillMethods,
  closeUtilityMethods
);

module.exports = { RangedModule };
