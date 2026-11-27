'use strict';

const { getHotbarStart, findInventoryItem } = require('../inventory_utils');
const { detectIncomingMaceAttack } = require('../mace_elytra');

/**
 * High-tier Smart Shield Skill (`modules/survival/shield_skill.js`):
 * - Tracks 5-second Axe shield-stun cooldown via `set_cooldown` & `entity_status === 30`
 * - Supports both off-hand shield and hotbar main-hand shield (with 1-tick post-swap settle & guaranteed slot restore)
 * - Mace anti-stun bait detection (drops shield + flags sidestep when diving enemy holds Axe)
 * - Exposes `requestShield(reason, ticks)` so `burst/defense.js` never raises shields out-of-sync
 */
const shieldSkillMethods = {
  _handleShieldDisabledEvent(durationMs = 5000) {
    const now = Date.now();
    this.shieldDisabledUntil = Math.max(this.shieldDisabledUntil || 0, now + durationMs);
    this.lowerShield();
  },

  isShieldOnCooldown(now = Date.now()) {
    return now < (this.shieldDisabledUntil || 0);
  },

  /**
   * Unified external shield request (used by `burst/defense.js` to block explosive blasts cleanly).
   */
  requestShield(reason = 'burst', ticks = 8) {
    if (this.survCfg.shieldEnabled === false || !this.bot || !this.bot.entity) return false;
    const now = Date.now();
    if (this.isShieldOnCooldown(now)) return false;

    const offhand = this.getOffhandItem();
    const hasOffhandShield = Boolean(offhand && offhand.name === 'shield');
    const hotbarShield = hasOffhandShield ? null : this._findHotbarShield();
    if (!hasOffhandShield && !hotbarShield) return false;

    if (hasOffhandShield) {
      if (!this.isShielding) {
        if (typeof this.bot.activateItem === 'function') this.bot.activateItem(true);
        this.isShielding = true;
        this.shieldHand = 'off-hand';
        this.shieldHoldTicks = 0;
      }
      this.shieldTicksRemaining = Math.max(this.shieldTicksRemaining, ticks);
      this.shieldingForExternal = reason;
      return true;
    }

    // Main-hand hotbar shield: 1-tick settle before activateItem(false)
    if (this.bot.quickBarSlot !== hotbarShield.hotbarIndex) {
      if (this.prevShieldHotbarSlot < 0) {
        this.prevShieldHotbarSlot = typeof this.bot.quickBarSlot === 'number' ? this.bot.quickBarSlot : 0;
      }
      if (typeof this.bot.setQuickBarSlot === 'function') {
        this.bot.setQuickBarSlot(hotbarShield.hotbarIndex);
      }
      this.pendingMainhandShieldSlot = hotbarShield.hotbarIndex;
      return true;
    }

    this.pendingMainhandShieldSlot = -1;
    if (!this.isShielding) {
      if (typeof this.bot.activateItem === 'function') this.bot.activateItem(false);
      this.isShielding = true;
      this.shieldHand = 'main-hand';
      this.shieldHoldTicks = 0;
    }
    this.shieldTicksRemaining = Math.max(this.shieldTicksRemaining, ticks);
    this.shieldingForExternal = reason;
    return true;
  },

  isEnemyDrawingBow(target) {
    if (!target || !target.position) return false;
    const range = this.survCfg.shieldBowDetectRange || 12.0;
    const dist = this.bot.entity.position.distanceTo(target.position);
    if (dist > range) return false;

    const held = target.heldItem || (Array.isArray(target.equipment) ? target.equipment[0] : null);
    if (!held || (held.name !== 'bow' && held.name !== 'crossbow')) return false;

    const meta = target.metadata || {};
    const handFlags = Number(meta[8] || 0);
    const using = Boolean(target.usingItem || (handFlags & 0x01) !== 0);
    if (using) return true;

    // Crossbow already loaded and aimed toward us
    if (held.name === 'crossbow') {
      const toBotX = this.bot.entity.position.x - target.position.x;
      const toBotZ = this.bot.entity.position.z - target.position.z;
      const len = Math.sqrt(toBotX * toBotX + toBotZ * toBotZ) || 1;
      const lookX = -Math.sin(target.yaw || 0);
      const lookZ = -Math.cos(target.yaw || 0);
      if ((lookX * (toBotX / len) + lookZ * (toBotZ / len)) > 0.78) {
        return true;
      }
    }
    return false;
  },

  isEnemyRushingMelee(target, weaponCooldownProgress = 1.0) {
    if (!target || !target.position || weaponCooldownProgress >= 0.85) return false;
    const range = this.survCfg.shieldRushDetectRange || 4.5;
    const dist = this.bot.entity.position.distanceTo(target.position);
    if (dist > range) return false;

    const held = target.heldItem || (Array.isArray(target.equipment) ? target.equipment[0] : null);
    if (!held || !held.name) return false;
    // Never raise shield into an Axe user (they will disable our shield for 5 seconds!)
    if (held.name.endsWith('_axe')) return false;
    const isSword = held.name.endsWith('_sword') || held.name === 'mace';
    if (!isSword) return false;

    const toBotX = this.bot.entity.position.x - target.position.x;
    const toBotZ = this.bot.entity.position.z - target.position.z;
    const len = Math.sqrt(toBotX * toBotX + toBotZ * toBotZ) || 1;
    const lookX = -Math.sin(target.yaw || 0);
    const lookZ = -Math.cos(target.yaw || 0);
    return (lookX * (toBotX / len) + lookZ * (toBotZ / len)) > 0.65;
  },

  _findHotbarShield() {
    const found = findInventoryItem(this.bot, 'shield', { hotbarOnly: true });
    if (!found || found.quickBarSlot < 0) return null;
    const start = getHotbarStart(this.bot);
    return { item: found.item, slot: start + found.quickBarSlot, hotbarIndex: found.quickBarSlot };
  },

  _restorePreShieldHotbarSlot() {
    if (this.prevShieldHotbarSlot >= 0 && typeof this.bot.setQuickBarSlot === 'function') {
      if (this.bot.quickBarSlot !== this.prevShieldHotbarSlot) {
        this.bot.setQuickBarSlot(this.prevShieldHotbarSlot);
      }
    }
    this.prevShieldHotbarSlot = -1;
    this.pendingMainhandShieldSlot = -1;
  },

  tickShield(target, weaponCooldownProgress = 1.0) {
    this.maceAntiStunActive = false;
    this.maceShieldThreat = null;

    if (this.survCfg.shieldEnabled === false || !this.bot || !this.bot.entity || !target || !target.isValid) {
      if (this.isShielding || this.pendingMainhandShieldSlot >= 0) this.lowerShield();
      return false;
    }

    const now = Date.now();
    // Shield disabled by enemy Axe stun -> never waste ticks trying to block
    if (this.isShieldOnCooldown(now)) {
      if (this.isShielding || this.pendingMainhandShieldSlot >= 0) this.lowerShield();
      return false;
    }

    const offhand = this.getOffhandItem();
    const hasOffhandShield = Boolean(offhand && offhand.name === 'shield');
    const hotbarShield = hasOffhandShield ? null : this._findHotbarShield();
    const maceThreat = detectIncomingMaceAttack(this.bot, target, null, weaponCooldownProgress);
    this.maceShieldThreat = maceThreat;

    // Anti-Stun-Slam Bait check runs EVEN for main-hand shield / before shield availability early-exit
    if (maceThreat.antiStunBait) {
      this.maceAntiStunActive = true;
      if (this.isShielding || this.pendingMainhandShieldSlot >= 0) {
        this.lowerShield();
      }
      return false;
    }

    if (!hasOffhandShield && !hotbarShield) {
      if (this.isShielding || this.pendingMainhandShieldSlot >= 0) this.lowerShield();
      return false;
    }

    // Drop shield immediately if enemy switches to Axe within melee range (bait/avoid 5s stun)
    const enemyHeld = target.heldItem || (Array.isArray(target.equipment) ? target.equipment[0] : null);
    if (
      enemyHeld && enemyHeld.name && enemyHeld.name.endsWith('_axe') &&
      this.bot.entity.position.distanceTo(target.position) <= 4.3 &&
      !this.shieldingForExternal
    ) {
      if (this.isShielding || this.pendingMainhandShieldSlot >= 0) {
        this.lowerShield();
      }
      return false;
    }

    if (this.isShielding) {
      this.shieldHoldTicks++;
      this.shieldTicksRemaining--;

      if (this.shieldingForMace) {
        if (maceThreat.shouldShield && this.shieldHoldTicks < 28) {
          return true;
        }
        if (maceThreat.postImpactWindow && this.shieldHoldTicks >= 4) {
          this.lowerShield();
          return false;
        }
      }

      if (this.shieldTicksRemaining <= 0 || this.shieldHoldTicks >= 24) {
        this.lowerShield();
        return false;
      }
      return true;
    }

    // Complete pending 1-tick main-hand shield settle
    if (this.pendingMainhandShieldSlot >= 0) {
      const stillNeeded = Boolean(maceThreat.shouldShield || this.isEnemyDrawingBow(target) || this.isEnemyRushingMelee(target, weaponCooldownProgress));
      if (!stillNeeded || !hotbarShield) {
        this._restorePreShieldHotbarSlot();
        return false;
      }
      if (this.bot.quickBarSlot === this.pendingMainhandShieldSlot && typeof this.bot.activateItem === 'function') {
        this.bot.activateItem(false);
        this.isShielding = true;
        this.shieldHand = 'main-hand';
        this.shieldingForMace = Boolean(maceThreat.shouldShield);
        this.shieldTicksRemaining = maceThreat.shouldShield ? 12 : (this.survCfg.shieldBlockDurationTicks || 10);
        this.shieldHoldTicks = 0;
        this.pendingMainhandShieldSlot = -1;
        return true;
      }
      this._restorePreShieldHotbarSlot();
      return false;
    }

    const maceCooldownMs = 280;
    const normalCooldownMs = this.survCfg.shieldCooldownMs || 1200;

    if (maceThreat.shouldShield && (now - this.lastMaceShieldEndTime) >= maceCooldownMs) {
      if (hasOffhandShield) {
        if (typeof this.bot.activateItem === 'function') this.bot.activateItem(true);
        this.isShielding = true;
        this.shieldHand = 'off-hand';
        this.shieldingForMace = true;
        this.shieldTicksRemaining = 12;
        this.shieldHoldTicks = 0;
        return true;
      }
      if (hotbarShield && typeof this.bot.setQuickBarSlot === 'function') {
        this.prevShieldHotbarSlot = typeof this.bot.quickBarSlot === 'number' ? this.bot.quickBarSlot : 0;
        this.bot.setQuickBarSlot(hotbarShield.hotbarIndex);
        this.pendingMainhandShieldSlot = hotbarShield.hotbarIndex;
        return true;
      }
    }

    if ((now - this.lastShieldEndTime) < normalCooldownMs) {
      return false;
    }

    const shouldBlockNormal = this.isEnemyDrawingBow(target) || this.isEnemyRushingMelee(target, weaponCooldownProgress);
    if (!shouldBlockNormal) return false;

    if (hasOffhandShield) {
      if (typeof this.bot.activateItem === 'function') this.bot.activateItem(true);
      this.isShielding = true;
      this.shieldHand = 'off-hand';
      this.shieldingForMace = false;
      this.shieldTicksRemaining = this.survCfg.shieldBlockDurationTicks || 10;
      this.shieldHoldTicks = 0;
      return true;
    }

    if (hotbarShield && typeof this.bot.setQuickBarSlot === 'function') {
      this.prevShieldHotbarSlot = typeof this.bot.quickBarSlot === 'number' ? this.bot.quickBarSlot : 0;
      this.bot.setQuickBarSlot(hotbarShield.hotbarIndex);
      this.pendingMainhandShieldSlot = hotbarShield.hotbarIndex;
      return true;
    }

    return false;
  },

  lowerShield() {
    const wasMace = this.shieldingForMace;
    const wasMainHand = this.shieldHand === 'main-hand' || this.pendingMainhandShieldSlot >= 0;
    if (this.isShielding) {
      try {
        if (typeof this.bot.deactivateItem === 'function') this.bot.deactivateItem();
      } catch (_) {}
      this.isShielding = false;
      this.lastShieldEndTime = Date.now();
      if (wasMace) this.lastMaceShieldEndTime = Date.now();
    }
    this.shieldHand = 'off-hand';
    this.shieldingForMace = false;
    this.shieldingForExternal = null;
    this.shieldTicksRemaining = 0;
    this.shieldHoldTicks = 0;
    if (wasMainHand) {
      this._restorePreShieldHotbarSlot();
    }
  }
};

module.exports = { shieldSkillMethods };
