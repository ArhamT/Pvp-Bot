'use strict';

const {
  SWORD_PRIORITY,
  AXE_PRIORITY,
  BLAST_SHIELD_BLOCK_PRIORITY,
  COVER_BLOCK_PRIORITY,
  isSpearItem,
  clearMovementControls
} = require('../constants');
const { parseItemEnchantments } = require('../enchant_utils');
const { getHotbarStart, getInventoryItems } = require('../inventory_utils');
const { validateArmorInventory, scanWeaponEnchantments } = require('../mace_elytra');
const { GAPPLE_PRIORITY, ARMOR_SLOTS, ARMOR_MATERIAL_SCORE } = require('./constants');

const ARMOR_MATERIAL_KEYS = Object.keys(ARMOR_MATERIAL_SCORE);

/**
 * Armor Scoring / Auto-Equip & Multi-Kit Hotbar Sorter (`modules/survival/armor_hotbar.js`):
 * - Fixes Blast Protection naked-slot bug (soft penalty instead of -1 rejection; allows 1x Blast Prot IV leggings in CPvP kits)
 * - Factors durability, Protection, Fire Protection, Feather Falling, Depth Strider, Swift Sneak, Unbreaking, Mending
 * - Multi-kit-aware hotbar sorting: Mace/Elytra, CPvP, PotPvP, Cart, and Sword/SMP
 * - Anti-InventoryMove safe pauses around window clicks
 */
const armorHotbarMethods = {
  async _equipSafe(item, destination = 'hand') {
    if (!item || !this.bot || typeof this.bot.equip !== 'function') return false;
    if (this.equipBusy) return false;
    this.equipBusy = true;
    try {
      await this.bot.equip(item, destination);
      return true;
    } catch (_) {
      return false;
    } finally {
      this.equipBusy = false;
    }
  },

  validateArmor() {
    return validateArmorInventory(this.bot);
  },

  _isCpvpKitInventory() {
    const items = getInventoryItems(this.bot);
    return items.some((i) => i && (i.name === 'end_crystal' || i.name === 'respawn_anchor'));
  },

  scoreArmorItem(item, options = {}) {
    if (!item || !item.name) return -1;
    const name = item.name;
    let base = 0;
    for (let i = 0; i < ARMOR_MATERIAL_KEYS.length; i++) {
      const mat = ARMOR_MATERIAL_KEYS[i];
      if (name.startsWith(mat)) {
        base = ARMOR_MATERIAL_SCORE[mat];
        break;
      }
    }
    if (base === 0) return -1;

    const ench = parseItemEnchantments(item);
    const isCpvp = options.isCpvp !== undefined ? options.isCpvp : this._isCpvpKitInventory();
    const isLeggings = name.endsWith('_leggings');

    let score = base;
    score += (ench.protection || 0) * 12;
    score += (ench.fire_protection || 0) * 3;
    score += (ench.feather_falling || 0) * 3;
    score += (ench.depth_strider || 0) * 2;
    score += (ench.swift_sneak || 0) * 2;
    score += (ench.unbreaking || 0) * 1.5;
    score += (ench.mending || 0) * 3;

    if (ench.blast_protection > 0) {
      if (isCpvp && isLeggings) {
        // HT1 CPvP meta: 1x Blast Prot IV leggings + 3x Prot IV gives maximum crystal/anchor survival
        score += ench.blast_protection * 12.5;
      } else if (this.survCfg.rejectBlastProtection !== false) {
        // Soft penalty so Prot IV always wins when available, but NEVER leaves the slot naked!
        score -= 15;
      } else {
        score += ench.blast_protection * 6;
      }
    }

    // Penalize critically damaged armor (<15% remaining) so fresh spares replace broken pieces
    const durRatio = this.getItemDurabilityRatio(item);
    if (durRatio < 0.15) {
      score -= 45;
    } else {
      score += durRatio * 4;
    }

    return score;
  },

  async equipBestArmor() {
    if (!this.activeInCombat || this._disposed || !this.bot || !this.bot.inventory) return;
    if (this.equipBusy) return;

    const isCpvp = this._isCpvpKitInventory();
    const slots = this.bot.inventory.slots || [];
    const delayMs = this.survCfg.inventoryClickDelayMs || 120;

    for (const spec of ARMOR_SLOTS) {
      if (this._disposed || !this.activeInCombat) return;
      const worn = slots[spec.slotIndex];
      // Never auto-strip Elytra if currently wearing one during aerial combat
      if (spec.dest === 'torso' && worn && worn.name === 'elytra') continue;

      const wornScore = worn ? this.scoreArmorItem(worn, { isCpvp }) : -1;
      let bestItem = null;
      let bestScore = wornScore;

      for (let s = 9; s < slots.length; s++) {
        const item = slots[s];
        if (!item || !item.name) continue;
        const matches = item.name.endsWith(spec.suffix) || spec.extra.includes(item.name);
        if (!matches) continue;
        const sc = this.scoreArmorItem(item, { isCpvp });
        if (sc > bestScore) {
          bestScore = sc;
          bestItem = item;
        }
      }

      if (bestItem) {
        clearMovementControls(this.bot);
        await this._equipSafe(bestItem, spec.dest);
        await this._sleep(delayMs);
      }
    }
  },

  async sortHotbar() {
    if (
      this.survCfg.autoSortHotbar === false ||
      !this.activeInCombat ||
      this._disposed ||
      this.sortingInProgress ||
      !this.bot || !this.bot.inventory ||
      typeof this.bot.moveSlotItem !== 'function'
    ) {
      return;
    }

    this.sortingInProgress = true;
    const delayMs = this.survCfg.inventoryClickDelayMs || 120;

    try {
      const start = getHotbarStart(this.bot);
      const items = getInventoryItems(this.bot);
      const usedSlots = new Set();

      const pickFirst = (predicate) => {
        for (const it of items) {
          if (!it || usedSlots.has(it.slot)) continue;
          if (predicate(it)) {
            usedSlots.add(it.slot);
            return it;
          }
        }
        return null;
      };

      const pickByPriority = (list) => {
        for (const name of list) {
          const found = pickFirst((it) => it.name === name);
          if (found) return found;
        }
        return null;
      };

      const weaponMap = scanWeaponEnchantments(this.bot);
      const hasMaceKit = weaponMap.maces.length > 0 || items.some((i) => i.name === 'wind_charge' || i.name === 'elytra');
      const hasCpvpKit = items.some((i) => i.name === 'end_crystal' || i.name === 'respawn_anchor');
      const hasCartKit = items.some((i) => i.name === 'tnt_minecart');

      const desired = new Array(9).fill(null);

      if (hasMaceKit) {
        // HT1 Mace / Elytra hotbar: [0:Sword, 1:Density/WindMace, 2:BreachMace, 3:Axe(right of Mace!), 4:WindCharge, 5:Pearl, 6:Gapple/Spear, 7:Water/Rocket, 8:Totem/Shield]
        desired[0] = pickByPriority(SWORD_PRIORITY);
        const m1 = weaponMap.densityMace || weaponMap.windBurstMace || weaponMap.maces[0];
        if (m1 && m1.item) { usedSlots.add(m1.item.slot); desired[1] = m1.item; }
        const m2 = weaponMap.breachMace && (!m1 || weaponMap.breachMace.slot !== m1.slot) ? weaponMap.breachMace : null;
        if (m2 && m2.item) { usedSlots.add(m2.item.slot); desired[2] = m2.item; }
        desired[3] = pickByPriority(AXE_PRIORITY);
        desired[4] = pickFirst((i) => i.name === 'wind_charge');
        desired[5] = pickFirst((i) => i.name === 'ender_pearl');
        desired[6] = pickFirst((i) => isSpearItem(i)) || pickByPriority(GAPPLE_PRIORITY);
        desired[7] = pickFirst((i) => i.name === 'firework_rocket') || pickFirst((i) => i.name === 'water_bucket');
        desired[8] = pickByPriority(GAPPLE_PRIORITY) || pickFirst((i) => i.name === 'totem_of_undying') || pickFirst((i) => i.name === 'shield');
      } else if (hasCpvpKit) {
        // HT1 CPvP hotbar: [0:Sword, 1:Obsidian, 2:EndCrystal, 3:Anchor, 4:Glowstone, 5:Pearl, 6:Gapple, 7:Pickaxe/XP, 8:Totem]
        desired[0] = pickByPriority(SWORD_PRIORITY) || pickByPriority(AXE_PRIORITY);
        desired[1] = pickByPriority(BLAST_SHIELD_BLOCK_PRIORITY);
        desired[2] = pickFirst((i) => i.name === 'end_crystal');
        desired[3] = pickFirst((i) => i.name === 'respawn_anchor') || pickByPriority(AXE_PRIORITY);
        desired[4] = pickFirst((i) => i.name === 'glowstone') || pickFirst((i) => i.name === 'experience_bottle');
        desired[5] = pickFirst((i) => i.name === 'ender_pearl');
        desired[6] = pickByPriority(GAPPLE_PRIORITY);
        desired[7] = pickFirst((i) => i.name === 'netherite_pickaxe' || i.name === 'diamond_pickaxe') || pickFirst((i) => i.name === 'experience_bottle');
        desired[8] = pickFirst((i) => i.name === 'totem_of_undying');
      } else if (hasCartKit) {
        // Cart PvP hotbar: [0:Sword, 1:Axe, 2:Crossbow/Bow, 3:Rail, 4:TNT Cart, 5:ShieldBlock, 6:Gapple, 7:Water/Pearl, 8:Totem]
        desired[0] = pickByPriority(SWORD_PRIORITY);
        desired[1] = pickByPriority(AXE_PRIORITY);
        desired[2] = pickFirst((i) => i.name === 'crossbow' || i.name === 'bow');
        desired[3] = pickFirst((i) => i.name.includes('rail'));
        desired[4] = pickFirst((i) => i.name === 'tnt_minecart');
        desired[5] = pickByPriority(BLAST_SHIELD_BLOCK_PRIORITY);
        desired[6] = pickByPriority(GAPPLE_PRIORITY);
        desired[7] = pickFirst((i) => i.name === 'ender_pearl' || i.name === 'water_bucket');
        desired[8] = pickFirst((i) => i.name === 'totem_of_undying');
      } else {
        // General Sword / PotPvP / SMP / UHC hotbar
        desired[0] = pickByPriority(SWORD_PRIORITY) || pickByPriority(AXE_PRIORITY);
        desired[1] = pickByPriority(AXE_PRIORITY) || pickFirst((i) => isSpearItem(i)) || pickFirst((i) => i.name === 'crossbow' || i.name === 'bow');
        desired[2] = pickFirst((i) => i.name === 'ender_pearl') || pickFirst((i) => i.name === 'crossbow' || i.name === 'bow');
        desired[3] = pickByPriority(GAPPLE_PRIORITY) || pickFirst((i) => i.name === 'cobweb');
        desired[4] = pickFirst((i) => i.name === 'water_bucket') || pickFirst((i) => i.name === 'lava_bucket');
        desired[5] = pickFirst((i) => i.name === 'cobweb') || pickFirst((i) => i.name === 'lava_bucket') || pickByPriority(COVER_BLOCK_PRIORITY);
        desired[6] = pickFirst((i) => i.name === 'splash_potion' && (this._classifyPotion(i) === 'heal2' || this._classifyPotion(i) === 'heal1'));
        desired[7] = pickFirst((i) => i.name === 'splash_potion' && (this._classifyPotion(i) === 'heal2' || this._classifyPotion(i) === 'heal1')) || pickFirst((i) => i.name === 'experience_bottle');
        desired[8] = pickFirst((i) => i.name === 'totem_of_undying') || pickFirst((i) => i.name === 'shield') || pickFirst((i) => i.name === 'splash_potion');
      }

      for (let i = 0; i < 9; i++) {
        if (this._disposed || !this.activeInCombat) break;
        const want = desired[i];
        if (!want) continue;
        const targetSlot = start + i;
        if (want.slot === targetSlot) continue;
        // Re-verify item still exists at want.slot
        const live = this.bot.inventory.slots[want.slot];
        if (!live || live.name !== want.name) continue;
        clearMovementControls(this.bot);
        try {
          await this.bot.moveSlotItem(want.slot, targetSlot);
          await this._sleep(delayMs);
        } catch (_) {}
      }
    } finally {
      this.sortingInProgress = false;
    }
  },

  async autoEquipAndSort() {
    if (!this.activeInCombat || this._disposed) return;
    await this.equipBestArmor();
    if (!this.activeInCombat || this._disposed) return;
    await this.sortHotbar();
    if (!this.activeInCombat || this._disposed) return;
    this.ensureOffhandSafety();
  }
};

module.exports = { armorHotbarMethods };
