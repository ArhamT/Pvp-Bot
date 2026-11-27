'use strict';

const {
  HOTBAR_START,
  SWORD_PRIORITY,
  AXE_PRIORITY,
  isSpearItem
} = require('../constants');
const { parseItemEnchantments, getEnchantmentLevel } = require('../enchant_utils');
const { getHotbarStart, findInventoryItem } = require('../inventory_utils');
const { scanWeaponEnchantments } = require('../mace_elytra');

let pvpGetAttackSpeed = null;
try {
  const { getAttackSpeed } = require('mineflayer-pvp/lib/Cooldown');
  if (typeof getAttackSpeed === 'function') {
    pvpGetAttackSpeed = getAttackSpeed;
  }
} catch (_) {
  pvpGetAttackSpeed = null;
}

const WEAPON_ATTACK_SPEED = {
  netherite_sword: 1.6, diamond_sword: 1.6, iron_sword: 1.6, stone_sword: 1.6, golden_sword: 1.6, wooden_sword: 1.6,
  netherite_axe: 1.0, diamond_axe: 1.0, iron_axe: 0.9, stone_axe: 0.8, golden_axe: 1.0, wooden_axe: 0.8,
  mace: 0.6,
  trident: 1.1
};

/**
 * Weapon & Cooldown Tracker (`modules/combat/weapon_tracker.js`):
 * - Uses WeakMap-cached `enchant_utils` (zero regex recompilation)
 * - Tracks 1.9+ attack cooldowns, hotbar slots, target armor level, and target shield/facing state
 */
const weaponTrackerMethods = {
  _getEnchantmentLevel(item, enchantName) {
    return getEnchantmentLevel(item, enchantName);
  },

  _isSpearItem(item) {
    return isSpearItem(item);
  },

  scanHotbarSlots() {
    const empty = {
      swordSlot: -1,
      axeSlot: -1,
      maceSlot: -1,
      breachMaceSlot: -1,
      densityMaceSlot: -1,
      windBurstMaceSlot: -1,
      spearSlot: -1,
      bowSlot: -1,
      crossbowSlot: -1,
      pearlSlot: -1,
      totemSlot: -1,
      windChargeSlot: -1,
      crystalSlot: -1,
      obsidianSlot: -1,
      anchorSlot: -1,
      glowstoneSlot: -1,
      waterBucketSlot: -1,
      lavaBucketSlot: -1,
      cobwebSlot: -1
    };

    if (!this.bot || !this.bot.inventory || !Array.isArray(this.bot.inventory.slots)) {
      this.hotbarSlots = empty;
      return empty;
    }

    const start = getHotbarStart(this.bot);
    const slots = this.bot.inventory.slots;
    let bestSwordTier = Infinity;
    let bestAxeTier = Infinity;
    let bestMaceScore = -1;
    let bestBreach = 0;
    let bestDensity = 0;
    let bestWindBurst = 0;

    for (let i = 0; i < 9; i++) {
      const item = slots[start + i];
      if (!item || !item.name) continue;
      const name = item.name;

      const swordTier = SWORD_PRIORITY.indexOf(name);
      if (swordTier >= 0 && swordTier < bestSwordTier) {
        bestSwordTier = swordTier;
        empty.swordSlot = i;
      }

      const axeTier = AXE_PRIORITY.indexOf(name);
      if (axeTier >= 0 && axeTier < bestAxeTier) {
        bestAxeTier = axeTier;
        empty.axeSlot = i;
      }

      if (name === 'mace') {
        const ench = parseItemEnchantments(item);
        const total = (ench.density || 0) * 2 + (ench.breach || 0) * 2 + (ench.wind_burst || 0) * 2 + 1;
        if (total > bestMaceScore) {
          bestMaceScore = total;
          empty.maceSlot = i;
        }
        if (ench.breach > bestBreach) {
          bestBreach = ench.breach;
          empty.breachMaceSlot = i;
        }
        if (ench.density > bestDensity) {
          bestDensity = ench.density;
          empty.densityMaceSlot = i;
        }
        if (ench.wind_burst > bestWindBurst) {
          bestWindBurst = ench.wind_burst;
          empty.windBurstMaceSlot = i;
        }
      }

      if (empty.spearSlot < 0 && isSpearItem(item)) empty.spearSlot = i;
      if (empty.bowSlot < 0 && name === 'bow') empty.bowSlot = i;
      if (empty.crossbowSlot < 0 && name === 'crossbow') empty.crossbowSlot = i;
      if (empty.pearlSlot < 0 && name === 'ender_pearl') empty.pearlSlot = i;
      if (empty.totemSlot < 0 && name === 'totem_of_undying') empty.totemSlot = i;
      if (empty.windChargeSlot < 0 && name === 'wind_charge') empty.windChargeSlot = i;
      if (empty.crystalSlot < 0 && name === 'end_crystal') empty.crystalSlot = i;
      if (empty.obsidianSlot < 0 && name === 'obsidian') empty.obsidianSlot = i;
      if (empty.anchorSlot < 0 && name === 'respawn_anchor') empty.anchorSlot = i;
      if (empty.glowstoneSlot < 0 && name === 'glowstone') empty.glowstoneSlot = i;
      if (empty.waterBucketSlot < 0 && name === 'water_bucket') empty.waterBucketSlot = i;
      if (empty.lavaBucketSlot < 0 && name === 'lava_bucket') empty.lavaBucketSlot = i;
      if (empty.cobwebSlot < 0 && name === 'cobweb') empty.cobwebSlot = i;
    }

    if (empty.breachMaceSlot < 0 && empty.maceSlot >= 0) {
      empty.breachMaceSlot = empty.maceSlot;
    }
    this.hotbarSlots = empty;
    this.weaponEnchantMap = scanWeaponEnchantments(this.bot);
    return empty;
  },

  getHotbarSlots() {
    if (!this.hotbarSlots) this.scanHotbarSlots();
    return this.hotbarSlots;
  },

  getAttackCooldownMs(item = null) {
    const held = item || (this.bot ? this.bot.heldItem : null);
    if (!held || !held.name) {
      return this.combatCfg.defaultAttackCooldownMs || 625;
    }
    if (pvpGetAttackSpeed) {
      try {
        const speed = pvpGetAttackSpeed(held.name);
        if (typeof speed === 'number' && speed > 0) {
          return Math.round(1000 / speed);
        }
      } catch (_) {}
    }
    const baseSpeed = WEAPON_ATTACK_SPEED[held.name] || (isSpearItem(held) ? 1.1 : 4.0);
    return Math.round(1000 / baseSpeed);
  },

  getCooldownProgress() {
    const now = Date.now();
    const held = this.bot ? this.bot.heldItem : null;
    const heldSlot = this.bot && typeof this.bot.quickBarSlot === 'number' ? this.bot.quickBarSlot : -1;
    const heldType = held ? held.type : -1;

    if (heldSlot !== this.lastHeldSlot || heldType !== this.lastHeldType) {
      this.lastHeldSlot = heldSlot;
      this.lastHeldType = heldType;
      this.lastSwapOrAttackTime = now;
    }

    const cdMs = this.getAttackCooldownMs(held);
    if (cdMs <= 0) return 1.0;
    return Math.min(1.0, Math.max(0, (now - this.lastSwapOrAttackTime) / cdMs));
  },

  _recordAttackSwing(now = Date.now()) {
    this.lastAttackTime = now;
    this.lastSwapOrAttackTime = now;
    if (this.bot) {
      this.lastHeldSlot = typeof this.bot.quickBarSlot === 'number' ? this.bot.quickBarSlot : -1;
      this.lastHeldType = this.bot.heldItem ? this.bot.heldItem.type : -1;
    }
  },

  /**
   * Computes exact vanilla 3D distance from bot eye position to target's AABB.
   */
  getReachDistance(target) {
    if (!this.bot || !this.bot.entity || !target || !target.position) return Infinity;
    const eye = this.aimer ? this.aimer.getEyePosition() : this.bot.entity.position.offset(0, 1.62, 0);
    const halfW = 0.3;
    const height = target.height || 1.8;
    const cx = Math.max(target.position.x - halfW, Math.min(eye.x, target.position.x + halfW));
    const cy = Math.max(target.position.y, Math.min(eye.y, target.position.y + height));
    const cz = Math.max(target.position.z - halfW, Math.min(eye.z, target.position.z + halfW));
    const dx = eye.x - cx;
    const dy = eye.y - cy;
    const dz = eye.z - cz;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  },

  isTargetHeavilyArmored(target) {
    if (!target || !Array.isArray(target.equipment)) return false;
    let armoredPieces = 0;
    for (let i = 2; i <= 5; i++) {
      const piece = target.equipment[i];
      if (!piece || !piece.name) continue;
      if (piece.name.startsWith('netherite_') || piece.name.startsWith('diamond_')) {
        armoredPieces++;
      }
    }
    return armoredPieces >= 3;
  },

  isTargetFacingBot(target) {
    if (!this.bot || !this.bot.entity || !target || !target.position) return true;
    const dx = this.bot.entity.position.x - target.position.x;
    const dz = this.bot.entity.position.z - target.position.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.05) return true;
    const yaw = typeof target.yaw === 'number' ? target.yaw : 0;
    const lookX = -Math.sin(yaw);
    const lookZ = -Math.cos(yaw);
    return (lookX * (dx / len) + lookZ * (dz / len)) > 0.05;
  },

  isTargetRaisingShield(target) {
    if (!target) return false;
    if (Date.now() < this.targetShieldDisabledUntil) return false;
    const eq = Array.isArray(target.equipment) ? target.equipment : [];
    const hasShield = Boolean(
      (eq[0] && eq[0].name === 'shield') ||
      (eq[1] && eq[1].name === 'shield')
    );
    if (!hasShield) return false;
    const meta = target.metadata || {};
    const handFlags = Number(meta[8] || 0);
    return Boolean(target.usingItem || (handFlags & 0x01) !== 0);
  },

  _selectHotbarSlot(slotIdx) {
    if (typeof slotIdx !== 'number' || slotIdx < 0 || slotIdx > 8) return false;
    if (!this.bot || typeof this.bot.setQuickBarSlot !== 'function') return false;
    if (this.bot.quickBarSlot === slotIdx) return false;
    this.bot.setQuickBarSlot(slotIdx);
    this.lastHeldSlot = slotIdx;
    this.lastHeldType = this.bot.heldItem ? this.bot.heldItem.type : -1;
    this.lastSwapOrAttackTime = Date.now();
    return true;
  },

  _findBestWeaponItem(priority) {
    const found = findInventoryItem(this.bot, priority);
    return found ? found.item : null;
  },

  _equipFast(item) {
    if (!item || !this.bot) return false;
    const start = getHotbarStart(this.bot);
    if (typeof item.slot === 'number' && item.slot >= start && item.slot < start + 9) {
      return this._selectHotbarSlot(item.slot - start);
    }
    if (!this._equipInFlight && typeof this.bot.equip === 'function') {
      this._equipInFlight = true;
      Promise.resolve(this.bot.equip(item, 'hand'))
        .catch(() => {})
        .finally(() => { this._equipInFlight = false; });
      return true;
    }
    return false;
  },

  _updateWeaponForTarget(target, reachDist, canShieldBreak) {
    const slots = this.getHotbarSlots();
    const now = Date.now();

    // 1. Axe Shield Break ONLY if target is raising shield AND actually facing us (otherwise flank-crit with Sword!)
    if (
      canShieldBreak &&
      this.combatCfg.shieldBreakWithAxe !== false &&
      this.isTargetRaisingShield(target) &&
      this.isTargetFacingBot(target) &&
      reachDist <= 3.6
    ) {
      if (slots.axeSlot >= 0) {
        this._selectHotbarSlot(slots.axeSlot);
        return 'axe_shield_break';
      }
      const axe = this._findBestWeaponItem(AXE_PRIORITY);
      if (axe) {
        this._equipFast(axe);
        return 'axe_shield_break';
      }
    }

    // 2. Spear midrange hysteresis (3.25b–4.05b) to prevent hotbar thrashing at the 3.0b boundary
    const spearReach = this.combatCfg.spearReach || 4.1;
    const holdingSpear = isSpearItem(this.bot.heldItem);
    const useSpearRange = holdingSpear ? (reachDist > 2.95 && reachDist <= spearReach) : (reachDist > 3.25 && reachDist <= spearReach);
    if (slots.spearSlot >= 0 && useSpearRange) {
      this._selectHotbarSlot(slots.spearSlot);
      return 'spear';
    }

    // 3. Default melee weapon: Sword > Axe
    if (slots.swordSlot >= 0) {
      this._selectHotbarSlot(slots.swordSlot);
      return 'sword';
    }
    if (slots.axeSlot >= 0) {
      this._selectHotbarSlot(slots.axeSlot);
      return 'axe';
    }

    // Throttled inventory fallback when neither sword nor axe is in hotbar
    if ((now - (this._lastFallbackWeaponCheckAt || 0)) >= 400) {
      this._lastFallbackWeaponCheckAt = now;
      const fallback = this._findBestWeaponItem(SWORD_PRIORITY) || this._findBestWeaponItem(AXE_PRIORITY);
      if (fallback) this._equipFast(fallback);
    }
    return 'hand';
  }
};

module.exports = { weaponTrackerMethods, WEAPON_ATTACK_SPEED };
