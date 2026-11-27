'use strict';

const { OFFHAND_SLOT, clearMovementControls } = require('../constants');
const { getHotbarStart, isSlotInHotbar, findInventoryItem } = require('../inventory_utils');

/**
 * High-tier AutoTotem & Offhand Safety Skill (`modules/survival/auto_totem.js`):
 * - Deduplicated totem-pop event handling (never double-cancels timer on dual entityStatus events)
 * - Proper exponential backoff on rejected swaps (no window-click storms in locked lobbies)
 * - Anti-InventoryMove brief pause on BOTH totem and offhand shield window clicks
 * - Hotbar backup totem awareness + emergency Double-Hand totem hold at critical HP <= 4
 */
const autoTotemMethods = {
  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },

  _sleepTotemPause(ms) {
    return new Promise((resolve) => {
      if (this._disposed || ms <= 0) {
        resolve();
        return;
      }
      this._totemPauseResolve = resolve;
      this._totemPauseTimer = setTimeout(() => {
        this._totemPauseTimer = null;
        this._totemPauseResolve = null;
        resolve();
      }, ms);
    });
  },

  _cancelPendingTotemTimers() {
    this.totemSwapPending = false;
    if (this.totemDelayTimer) {
      clearTimeout(this.totemDelayTimer);
      this.totemDelayTimer = null;
    }
    if (this._totemDelayResolve) {
      const r = this._totemDelayResolve;
      this._totemDelayResolve = null;
      r();
    }
    if (this._totemPauseTimer) {
      clearTimeout(this._totemPauseTimer);
      this._totemPauseTimer = null;
    }
    if (this._totemPauseResolve) {
      const r = this._totemPauseResolve;
      this._totemPauseResolve = null;
      r();
    }
    this._totemMovementPaused = false;
  },

  _pauseMovementForTotemSwap() {
    clearMovementControls(this.bot);
  },

  _isHotbarSlot(slot) {
    return isSlotInHotbar(this.bot, slot);
  },

  _handleUpdateSlot(slot, _oldItem, newItem) {
    if (!this.activeInCombat || this._disposed) return;
    if (slot === this._getOffhandSlotIndex()) {
      if (!newItem || newItem.name !== 'totem_of_undying') {
        this.ensureTotemPriority({ immediate: true });
      }
    }
  },

  _handleHealth() {
    if (!this.activeInCombat || this._disposed) return;
    if (this.needsTotemSwap()) {
      this.ensureTotemPriority({ immediate: true });
    }
  },

  _handleTotemPop() {
    if (!this.activeInCombat || this._disposed) return;
    const now = Date.now();
    // Deduplicate dual `_client.on('entity_status')` + `bot.on('entityStatus')` firings for the same pop
    if ((now - (this._lastTotemPopEventAt || 0)) < 120) {
      return;
    }
    this._lastTotemPopEventAt = now;
    this.totemPopReplenishPending = true;
    this.totemRetryBackoffMs = 0;

    // Immediately double-hand a hotbar totem if one is in hotbar & HP is critical while offhand re-equips
    this._tryEmergencyDoubleHandTotem();

    if (this.totemDelayTimer) {
      this._cancelPendingTotemTimers();
    }
    this.ensureTotemPriority({ fromPop: true });
  },

  _tryEmergencyDoubleHandTotem() {
    if (!this.bot || !this.bot.entity || this.bot.health > 6) return false;
    const offhand = this.getOffhandItem();
    if (offhand && offhand.name === 'totem_of_undying') return false;
    const hbTotem = findInventoryItem(this.bot, 'totem_of_undying', { hotbarOnly: true });
    if (hbTotem && hbTotem.quickBarSlot >= 0 && typeof this.bot.setQuickBarSlot === 'function') {
      if (this.bot.quickBarSlot !== hbTotem.quickBarSlot) {
        this.bot.setQuickBarSlot(hbTotem.quickBarSlot);
      }
      return true;
    }
    return false;
  },

  _getOffhandSlotIndex() {
    if (typeof this.bot.getEquipmentDestSlot === 'function') {
      try {
        return this.bot.getEquipmentDestSlot('off-hand');
      } catch (_) {
        return OFFHAND_SLOT;
      }
    }
    return OFFHAND_SLOT;
  },

  getOffhandItem() {
    if (!this.bot.inventory || !this.bot.inventory.slots) return null;
    return this.bot.inventory.slots[this._getOffhandSlotIndex()] || null;
  },

  findTotemInInventory() {
    if (!this.bot.inventory || !Array.isArray(this.bot.inventory.slots)) return null;
    const offhandSlot = this._getOffhandSlotIndex();
    const start = getHotbarStart(this.bot);
    const slots = this.bot.inventory.slots;

    // Prefer hotbar totem first for fastest F-swap / minimal window distance
    for (let i = 0; i < 9; i++) {
      const item = slots[start + i];
      if (item && item.name === 'totem_of_undying') return item;
    }
    for (let s = 0; s < slots.length; s++) {
      if (s === offhandSlot || (s >= start && s < start + 9)) continue;
      const item = slots[s];
      if (item && item.name === 'totem_of_undying') return item;
    }
    return null;
  },

  needsTotemSwap() {
    if (this.survCfg.totemAutoEquip === false || !this.activeInCombat || this._disposed) return false;
    const offhand = this.getOffhandItem();
    if (offhand && offhand.name === 'totem_of_undying') return false;
    return Boolean(this.findTotemInInventory());
  },

  async _executeTotemSwap() {
    if (this._disposed || !this.activeInCombat) {
      this.totemPopReplenishPending = false;
      this.totemSwapPending = false;
      return;
    }

    const totem = this.findTotemInInventory();
    if (!totem) {
      this.totemPopReplenishPending = false;
      this.totemSwapPending = false;
      return;
    }

    const offhand = this.getOffhandItem();
    if (offhand && offhand.name === 'totem_of_undying') {
      this.totemPopReplenishPending = false;
      this.totemSwapPending = false;
      this.totemRetryBackoffMs = 0;
      return;
    }

    this.totemEquipInFlight = true;
    const pauseMs = this.survCfg.totemPauseMovementMs !== undefined ? this.survCfg.totemPauseMovementMs : 50;
    const fromMainInventory = !this._isHotbarSlot(totem.slot);

    try {
      if (fromMainInventory && pauseMs > 0) {
        this._totemMovementPaused = true;
        this._pauseMovementForTotemSwap();
        await this._sleepTotemPause(Math.min(pauseMs, 80));
        if (this._disposed || !this.activeInCombat) return;
      }

      if (typeof this.bot.equip === 'function') {
        await this.bot.equip(totem, 'off-hand');
      }

      const after = this.getOffhandItem();
      if (after && after.name === 'totem_of_undying') {
        this.totemRetryBackoffMs = 0;
        this.totemPopReplenishPending = false;
      } else {
        // Server reverted/rejected swap -> clear pop-pending so exponential backoff prevents click storms!
        this.totemPopReplenishPending = false;
        this.totemRetryBackoffMs = this.totemRetryBackoffMs
          ? Math.min(8000, this.totemRetryBackoffMs * 2)
          : 500;
      }
    } catch (_) {
      this.totemPopReplenishPending = false;
      this.totemRetryBackoffMs = this.totemRetryBackoffMs
        ? Math.min(8000, this.totemRetryBackoffMs * 2)
        : 500;
    } finally {
      this._totemMovementPaused = false;
      this.totemEquipInFlight = false;
      this.totemSwapPending = false;
      this.totemEquipPromise = null;
    }
  },

  ensureTotemPriority(opts = {}) {
    if (this._disposed || !this.activeInCombat || this.survCfg.totemAutoEquip === false) {
      return false;
    }

    const offhand = this.getOffhandItem();
    if (offhand && offhand.name === 'totem_of_undying') {
      this.totemPopReplenishPending = false;
      this.totemRetryBackoffMs = 0;
      return false;
    }

    const totem = this.findTotemInInventory();
    if (!totem) {
      this.totemPopReplenishPending = false;
      return false;
    }

    if (this.totemEquipInFlight || this.totemSwapPending) {
      if (this._totemMovementPaused) {
        this._pauseMovementForTotemSwap();
      }
      return true;
    }

    const now = Date.now();
    if (this.totemRetryBackoffMs > 0 && (now - this.lastTotemAttemptAt) < this.totemRetryBackoffMs) {
      return false;
    }

    const popDelay = this.survCfg.totemPopDelayMs !== undefined ? this.survCfg.totemPopDelayMs : 50;
    const minDelay = this.survCfg.totemEquipDelayMinMs !== undefined ? this.survCfg.totemEquipDelayMinMs : 50;
    const maxDelay = this.survCfg.totemEquipDelayMaxMs !== undefined ? this.survCfg.totemEquipDelayMaxMs : 100;
    const delayMs = (opts.fromPop || this.totemPopReplenishPending)
      ? popDelay
      : (opts.immediate ? minDelay : (minDelay + Math.floor(Math.random() * Math.max(1, maxDelay - minDelay + 1))));

    this.lastTotemAttemptAt = now;
    this.totemSwapPending = true;

    this.totemEquipPromise = new Promise((resolve) => {
      this._totemDelayResolve = resolve;
      this.totemDelayTimer = setTimeout(() => {
        this.totemDelayTimer = null;
        this._totemDelayResolve = null;
        this._executeTotemSwap().finally(resolve);
      }, Math.max(0, delayMs));
    });

    return true;
  },

  /**
   * Ensures offhand safety in combat:
   * Priority 1: Totem of Undying in offhand (and emergency double-hand when HP <= 6 after pop).
   * Priority 2: Shield in offhand if no totems remain (with anti-InventoryMove pause for main-inv swaps).
   */
  ensureOffhandSafety() {
    if (!this.activeInCombat || this._disposed) return false;

    if (this.ensureTotemPriority()) {
      return true;
    }

    const offhand = this.getOffhandItem();
    if (offhand && (offhand.name === 'totem_of_undying' || offhand.name === 'shield')) {
      return false;
    }

    if (this.survCfg.shieldEnabled === false || this.equipBusy || this.totemEquipInFlight) {
      return false;
    }

    const now = Date.now();
    if (this.offhandRetryBackoffMs > 0 && (now - this.lastOffhandAttemptAt) < this.offhandRetryBackoffMs) {
      return false;
    }

    const shieldFound = findInventoryItem(this.bot, 'shield');
    if (!shieldFound || !shieldFound.item) return false;

    this.lastOffhandAttemptAt = now;
    const fromMainInv = !this._isHotbarSlot(shieldFound.item.slot);
    if (fromMainInv) {
      this._pauseMovementForTotemSwap();
    }

    this._equipSafe(shieldFound.item, 'off-hand').then((ok) => {
      const after = this.getOffhandItem();
      if (ok && after && after.name === 'shield') {
        this.offhandRetryBackoffMs = 0;
      } else {
        this.offhandRetryBackoffMs = this.offhandRetryBackoffMs
          ? Math.min(8000, this.offhandRetryBackoffMs * 2)
          : 600;
      }
    }).catch(() => {});

    return false;
  }
};

module.exports = { autoTotemMethods };
