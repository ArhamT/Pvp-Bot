'use strict';

const { OFFHAND_SLOT, isDirectionSafe } = require('../constants');
const { getEnchantmentLevel } = require('../enchant_utils');
const {
  getHotbarStart,
  findInventoryItem,
  findItemByPredicate,
  isCrossbowCharged,
  ensureItemHeld
} = require('../inventory_utils');
const { hasClearRaySegment } = require('../placement_los');
const { solveProjectileTrajectory } = require('../pearl_ballistics');

const ARROW_NAMES = ['arrow', 'spectral_arrow', 'tipped_arrow'];

/**
 * High-tier Bow & Crossbow Skill (`modules/ranged/bow_crossbow.js`):
 * - Supports Quick Charge, zero-G Firework Rocket ballistics, high-angle (+85°) arcs, & exact 3D DDA LOS
 * - Multi-crossbow hotbar volley cycling & shield-bait cancel
 * - Unpredictable strafe-while-drawing (only checks desired strafe side instead of 4-way scan)
 */
const bowCrossbowMethods = {
  _hasArrows() {
    return Boolean(findInventoryItem(this.bot, ARROW_NAMES));
  },

  _hasOffhandFirework() {
    if (!this.bot || !this.bot.inventory || !this.bot.inventory.slots) return false;
    const off = this.bot.inventory.slots[OFFHAND_SLOT];
    return Boolean(off && off.name === 'firework_rocket');
  },

  _isUsingFireworkAmmo(crossbowItem) {
    if (crossbowItem && isCrossbowCharged(crossbowItem)) {
      const { getItemMetadataText } = require('../constants');
      return getItemMetadataText(crossbowItem).includes('firework');
    }
    return this._hasOffhandFirework();
  },

  _getCrossbowChargeTicks(item) {
    const base = this.rangedCfg.crossbowChargeTicks !== undefined ? this.rangedCfg.crossbowChargeTicks : 26;
    const qc = getEnchantmentLevel(item, 'quick_charge');
    return Math.max(10, base - qc * 5);
  },

  _findChargedCrossbow() {
    const found = findItemByPredicate(this.bot, (it) => it && it.name === 'crossbow' && isCrossbowCharged(it));
    return found ? found.item : null;
  },

  _findUnchargedCrossbow() {
    if (!this._hasArrows() && !this._hasOffhandFirework()) return null;
    const found = findItemByPredicate(this.bot, (it) => it && it.name === 'crossbow' && !isCrossbowCharged(it));
    return found ? found.item : null;
  },

  _findBow() {
    if (!this._hasArrows()) return null;
    const found = findInventoryItem(this.bot, 'bow');
    return found ? found.item : null;
  },

  _strafeWhileDrawing(targetYaw) {
    if (!this.bot || typeof this.bot.setControlState !== 'function') return;
    this.rangedStrafeTicks--;
    if (this.rangedStrafeTicks <= 0) {
      this.rangedStrafeDir = -this.rangedStrafeDir;
      this.rangedStrafeTicks = 8 + Math.floor(Math.random() * 14);
    }

    const sideYaw = targetYaw + (this.rangedStrafeDir > 0 ? Math.PI / 2 : -Math.PI / 2);
    const dx = -Math.sin(sideYaw);
    const dz = -Math.cos(sideYaw);
    if (!isDirectionSafe(this.bot, dx, dz, 1.4, 3)) {
      this.rangedStrafeDir = -this.rangedStrafeDir;
    }

    this.bot.setControlState('forward', false);
    this.bot.setControlState('back', false);
    this.bot.setControlState('sprint', false);
    this.bot.setControlState('jump', false);
    this.bot.setControlState('left', this.rangedStrafeDir < 0);
    this.bot.setControlState('right', this.rangedStrafeDir > 0);
  },

  _isTargetBlockingRanged(target) {
    if (!target) return false;
    const eq = Array.isArray(target.equipment) ? target.equipment : [];
    const hasShield = Boolean((eq[0] && eq[0].name === 'shield') || (eq[1] && eq[1].name === 'shield'));
    if (!hasShield) return false;
    const meta = target.metadata || {};
    return Boolean(target.usingItem || (Number(meta[8] || 0) & 0x01) !== 0);
  },

  _tickBowOrCrossbow(target) {
    if (!this.bot || !this.bot.entity || !target || !target.isValid || !target.position) {
      this._cancelBowDraw();
      return false;
    }

    const now = Date.now();
    const eyePos = this.aimer ? this.aimer.getEyePosition() : this.bot.entity.position.offset(0, 1.62, 0);
    const targetTorso = target.position.offset(0, (target.height || 1.8) * 0.65, 0);
    const dist = eyePos.distanceTo(targetTorso);
    const maxRange = this.rangedCfg.bowMaxRange || 28.0;

    // 1. Continue active charged-crossbow fire (1-tick settled)
    if (this.crossbowFirePending) {
      const item = this._findChargedCrossbow();
      if (!item || dist > maxRange || !hasClearRaySegment(this.bot, eyePos, targetTorso)) {
        this.crossbowFirePending = false;
        return false;
      }

      const isFirework = this._isUsingFireworkAmmo(item);
      const sol = solveProjectileTrajectory(eyePos, target.position, target.velocity, {
        speed: isFirework ? 1.6 : 3.15,
        gravity: isFirework ? 0 : 0.05,
        drag: isFirework ? 1.0 : 0.99,
        targetHeightOffset: (target.height || 1.8) * 0.65
      });
      const aim = sol && this.aimer
        ? this.aimer.stepTowardsAngles(sol.yaw, sol.pitch, { speedMultiplier: 2.0, toleranceRad: 0.14 })
        : { aligned: true };

      const eq = ensureItemHeld(this.bot, { item }, { exactCrossbowCharge: true });
      if (eq.swapped || !eq.held || !aim.aligned) {
        this.crossbowFireTicks++;
        if (this.crossbowFireTicks > 14) {
          this.crossbowFirePending = false;
          return false;
        }
        return true;
      }

      if (typeof this.bot.activateItem === 'function') {
        this.bot.activateItem(false);
      }
      this.lastCrossbowShotAt = now;
      this.crossbowFirePending = false;
      this.crossbowFireTicks = 0;
      return true;
    }

    // 2. Continue active bow / crossbow draw
    if (this.drawingWeapon) {
      this.drawTicks++;
      const minCancelDist = this.drawingWeapon === 'crossbow' ? 4.5 : 6.0;
      const targetShielded = this._isTargetBlockingRanged(target);

      // Abort draw if enemy rushes into melee range or we lose LOS for bow
      if (dist < minCancelDist || dist > maxRange + 2 || this.drawTicks > 60) {
        this._cancelBowDraw();
        return false;
      }

      const targetYaw = Math.atan2(-(target.position.x - eyePos.x), -(target.position.z - eyePos.z));
      this._strafeWhileDrawing(targetYaw);

      const isFirework = this.drawingWeapon === 'crossbow' && this._hasOffhandFirework();
      const sol = solveProjectileTrajectory(eyePos, target.position, target.velocity, {
        speed: this.drawingWeapon === 'crossbow' ? (isFirework ? 1.6 : 3.15) : 3.0,
        gravity: isFirework ? 0 : 0.05,
        drag: isFirework ? 1.0 : 0.99,
        targetHeightOffset: (target.height || 1.8) * 0.65
      });

      const aim = sol && this.aimer
        ? this.aimer.stepTowardsAngles(sol.yaw, sol.pitch, { speedMultiplier: 1.75, toleranceRad: 0.14 })
        : { aligned: true };

      if (this.drawingWeapon === 'crossbow') {
        const req = this.targetDrawTicks || 26;
        if (this.drawTicks >= req) {
          try { if (typeof this.bot.deactivateItem === 'function') this.bot.deactivateItem(); } catch (_) {}
          this.drawingWeapon = null;
          this.drawTicks = 0;
          // Immediately transition to fire if target is visible & not shielding
          if (hasClearRaySegment(this.bot, eyePos, targetTorso) && (!targetShielded || isFirework)) {
            this.crossbowFirePending = true;
            this.crossbowFireTicks = 0;
          }
          return true;
        }
        return true;
      }

      // Bow release when fully drawn, aligned, clear LOS, and opponent not blocking
      const reqBow = this.rangedCfg.bowChargeTicks || 21;
      if (this.drawTicks >= reqBow && aim.aligned && hasClearRaySegment(this.bot, eyePos, targetTorso)) {
        if (targetShielded && this.drawTicks < reqBow + 10) {
          // Hold bow briefly to bait shield drop
          return true;
        }
        try { if (typeof this.bot.deactivateItem === 'function') this.bot.deactivateItem(); } catch (_) {}
        this.lastBowShotAt = now;
        this.drawingWeapon = null;
        this.drawTicks = 0;
        return false;
      }
      return true;
    }

    // 3. Evaluate starting a new Crossbow fire / Crossbow load / Bow draw
    if (dist > maxRange) return false;
    const hasLos = hasClearRaySegment(this.bot, eyePos, targetTorso);

    if (this.rangedCfg.crossbowEnabled !== false) {
      const xbowCd = this.rangedCfg.crossbowShotCooldownMs !== undefined ? this.rangedCfg.crossbowShotCooldownMs : 1400;
      const charged = this._findChargedCrossbow();
      const loadedMin = this.rangedCfg.crossbowLoadedMinRange !== undefined ? this.rangedCfg.crossbowLoadedMinRange : 4.2;

      if (charged && dist >= loadedMin && hasLos && (now - this.lastCrossbowShotAt) >= xbowCd) {
        const isFirework = this._isUsingFireworkAmmo(charged);
        if (!this._isTargetBlockingRanged(target) || isFirework) {
          this.crossbowFirePending = true;
          this.crossbowFireTicks = 0;
          return this._tickBowOrCrossbow(target);
        }
      }

      const uncharged = this._findUnchargedCrossbow();
      const loadMin = this.rangedCfg.crossbowMinRange !== undefined ? this.rangedCfg.crossbowMinRange : 6.5;
      if (uncharged && dist >= loadMin) {
        const eq = ensureItemHeld(this.bot, { item: uncharged }, { exactCrossbowCharge: true });
        if (eq.swapped || !eq.held) return true;
        if (typeof this.bot.activateItem === 'function') {
          this.bot.activateItem(false);
          this.drawingWeapon = 'crossbow';
          this.drawTicks = 0;
          this.targetDrawTicks = this._getCrossbowChargeTicks(uncharged);
          return true;
        }
      }
    }

    if (this.rangedCfg.bowEnabled === true && hasLos) {
      const bowMin = this.rangedCfg.bowMinRange !== undefined ? this.rangedCfg.bowMinRange : 9.0;
      const bowCd = this.rangedCfg.bowShotCooldownMs !== undefined ? this.rangedCfg.bowShotCooldownMs : 3000;
      const bow = (dist >= bowMin && (now - this.lastBowShotAt) >= bowCd) ? this._findBow() : null;
      if (bow) {
        const eq = ensureItemHeld(this.bot, { item: bow });
        if (eq.swapped || !eq.held) return true;
        if (typeof this.bot.activateItem === 'function') {
          this.bot.activateItem(false);
          this.drawingWeapon = 'bow';
          this.drawTicks = 0;
          this.targetDrawTicks = this.rangedCfg.bowChargeTicks || 21;
          return true;
        }
      }
    }

    return false;
  },

  _cancelBowDraw() {
    if (this.drawingWeapon) {
      try { if (typeof this.bot.deactivateItem === 'function') this.bot.deactivateItem(); } catch (_) {}
    }
    this.drawingWeapon = null;
    this.drawTicks = 0;
    this.targetDrawTicks = 0;
    this.crossbowFirePending = false;
    this.crossbowFireTicks = 0;
  }
};

module.exports = { bowCrossbowMethods };
