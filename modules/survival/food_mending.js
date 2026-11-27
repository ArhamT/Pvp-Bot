'use strict';

const { getEnchantmentLevel, getItemDurabilityInfo } = require('../enchant_utils');
const { findInventoryItem, ensureItemHeld } = require('../inventory_utils');
const {
  GAPPLE_PRIORITY,
  HEAL_FOOD_PRIORITY,
  ARMOR_SLOTS,
  ARMOR_MAX_DURABILITY
} = require('./constants');

/**
 * Food / Gapple Eating, Mending-Verified XP Armor Repair, & Spare Armor Swap Skill
 * (`modules/survival/food_mending.js`):
 * - Fixes same-tick XP bottle swap + throw via `ensureItemHeld` 1-tick settle
 * - Verifies `mending` enchantment before burning XP bottles
 * - Mid-fight spare armor hot-swap when any worn piece drops below 15% durability
 * - Cancellation-token safe eating
 */
const foodMendingMethods = {
  getItemDurabilityRatio(item) {
    if (!item || !item.name) return 1.0;
    const fallbackMax = ARMOR_MAX_DURABILITY[item.name] || 0;
    const info = getItemDurabilityInfo(item, fallbackMax);
    return info.valid ? info.ratio : 1.0;
  },

  getLowestWornArmorDurability(requireMending = false) {
    if (!this.bot || !this.bot.inventory || !Array.isArray(this.bot.inventory.slots)) {
      return { ratio: 1.0, slot: -1, item: null, hasMending: false };
    }
    let lowest = { ratio: 1.0, slot: -1, item: null, hasMending: false };
    for (const spec of ARMOR_SLOTS) {
      const piece = this.bot.inventory.slots[spec.slotIndex];
      if (!piece) continue;
      const hasMending = getEnchantmentLevel(piece, 'mending') > 0;
      if (requireMending && !hasMending) continue;
      const ratio = this.getItemDurabilityRatio(piece);
      if (ratio < lowest.ratio) {
        lowest = { ratio, slot: spec.slotIndex, item: piece, hasMending };
      }
    }
    return lowest;
  },

  /**
   * Hot-swaps a spare armor piece from inventory whenever a worn piece drops below 15% durability.
   */
  trySwapSpareArmor() {
    if (!this.bot || !this.bot.inventory || !Array.isArray(this.bot.inventory.slots)) return false;
    if (this.equipBusy || this.sortingInProgress || this.totemEquipInFlight) return false;
    const now = Date.now();
    if ((now - (this._lastSpareArmorCheckAt || 0)) < 1000) return false;
    this._lastSpareArmorCheckAt = now;

    const slots = this.bot.inventory.slots;
    for (const spec of ARMOR_SLOTS) {
      const worn = slots[spec.slotIndex];
      if (!worn) continue;
      const wornRatio = this.getItemDurabilityRatio(worn);
      if (wornRatio >= 0.15) continue;

      let bestSpare = null;
      let bestScore = -1;
      for (let s = 9; s < slots.length; s++) {
        const cand = slots[s];
        if (!cand || !cand.name) continue;
        const matches = cand.name.endsWith(spec.suffix) || spec.extra.includes(cand.name);
        if (!matches) continue;
        if (this.getItemDurabilityRatio(cand) < 0.35) continue;
        const sc = this.scoreArmorItem(cand);
        if (sc > bestScore) {
          bestScore = sc;
          bestSpare = cand;
        }
      }
      if (bestSpare) {
        this._equipSafe(bestSpare, spec.dest).catch(() => {});
        return true;
      }
    }
    return false;
  },

  findXpBottle() {
    const found = findInventoryItem(this.bot, 'experience_bottle');
    return found ? found.item : null;
  },

  tickArmorXpMend(target) {
    if (this.survCfg.xpMendEnabled === false || !this.bot || !this.bot.entity) {
      this.isXpMending = false;
      return false;
    }
    const minHp = this.survCfg.xpMendMinHealth !== undefined ? this.survCfg.xpMendMinHealth : 13;
    const startRatio = this.survCfg.xpMendDurabilityRatio !== undefined ? this.survCfg.xpMendDurabilityRatio : 0.45;
    const stopRatio = this.survCfg.xpMendStopRatio !== undefined ? this.survCfg.xpMendStopRatio : 0.78;
    const dist = (target && target.position) ? this.bot.entity.position.distanceTo(target.position) : 99;

    const xpFound = findInventoryItem(this.bot, 'experience_bottle');
    // Only mend armor that actually carries the Mending enchantment!
    const lowest = this.getLowestWornArmorDurability(true);

    if (!xpFound || !lowest.item || this.bot.health < minHp || dist < 3.6) {
      this.isXpMending = false;
      return false;
    }

    if (!this.isXpMending && lowest.ratio > startRatio) {
      return false;
    }
    if (this.isXpMending && lowest.ratio >= stopRatio) {
      this.isXpMending = false;
      this.pendingWeaponRestoreTicks = 1;
      return false;
    }

    this.isXpMending = true;
    const aim = this.aimer
      ? this.aimer.stepTowardsAngles(this.bot.entity.yaw, -84 * (Math.PI / 180), { speedMultiplier: 2.0, toleranceRad: 0.25 })
      : { aligned: true };

    if (typeof this.bot.setControlState === 'function') {
      this.bot.setControlState('sprint', false);
      this.bot.setControlState('jump', false);
    }

    // Strictly anti-cheat safe: wait 1 tick after hotbar swap before throwing XP bottle!
    const eq = ensureItemHeld(this.bot, xpFound);
    if (eq.swapped || !eq.held || !aim.aligned) {
      return true;
    }

    const now = Date.now();
    const intervalMs = this.survCfg.xpMendThrowIntervalMs !== undefined ? this.survCfg.xpMendThrowIntervalMs : 150;
    if ((now - this.lastXpThrowTime) >= intervalMs && typeof this.bot.activateItem === 'function') {
      // Instant throwable: NEVER call deactivateItem()!
      this.bot.activateItem(false);
      this.lastXpThrowTime = now;
    }
    return true;
  },

  findGoldenApple() {
    const found = findInventoryItem(this.bot, GAPPLE_PRIORITY);
    return found ? found.item : null;
  },

  findBestHealFood() {
    const found = findInventoryItem(this.bot, HEAL_FOOD_PRIORITY);
    return found ? found.item : null;
  },

  _startEatingFood(food) {
    if (!food || this.isConsuming || this._disposed) return false;
    if ((Date.now() - this.lastConsumeFailAt) < 400) return false;

    const isGapple = food.name === 'golden_apple' || food.name === 'enchanted_golden_apple';
    const token = ++this._consumeToken;
    this.isConsuming = true;
    this.isDrinkingPotion = false;
    this.consumeStartTime = Date.now();
    this.lowerShield();

    this._equipSingleForConsume(food).then(async (ok) => {
      if (!ok || this._disposed || this._consumeToken !== token) {
        if (this._consumeToken === token) {
          this.isConsuming = false;
          this.lastConsumeFailAt = Date.now();
        }
        return;
      }
      if (typeof this.bot.setControlState === 'function') {
        this.bot.setControlState('sprint', false);
      }
      if (typeof this.bot.consume === 'function') {
        await this.bot.consume();
      }
      if (this._consumeToken === token && !this._disposed) {
        if (isGapple) {
          this.justAteGappleAt = Date.now();
          this._markBuffApplied('regen');
        }
        this.isConsuming = false;
        this.pendingWeaponRestoreTicks = 1;
      }
    }).catch(() => {
      if (this._consumeToken === token) {
        try { if (typeof this.bot.deactivateItem === 'function') this.bot.deactivateItem(); } catch (_) {}
        this.isConsuming = false;
        this.lastConsumeFailAt = Date.now();
      }
    });

    return true;
  }
};

module.exports = { foodMendingMethods };
