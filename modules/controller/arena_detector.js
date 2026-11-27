'use strict';

const { getItemMetadataText, isSpearItem } = require('../constants');

const LOBBY_MENU_KEYWORDS = [
  'kit editor', 'kiteditor', 'edit kit', 'preferences',
  'unranked', 'ranked', 'join queue', 'leave queue', 'spectate',
  'cosmetics', 'leaderboard', 'statistics',
  'server selector', 'game menu', 'main menu', 'return to lobby',
  'play duels', 'duel menu', 'ffa menu'
];

const LOBBY_MENU_ITEM_NAMES = new Set([
  'compass', 'clock', 'nether_star', 'comparator', 'repeater',
  'writable_book', 'knowledge_book', 'book', 'name_tag'
]);

function stripColorCodes(text) {
  if (!text) return '';
  return String(text).replace(/§.|&[0-9a-fk-orx]/gi, '').trim();
}

/**
 * Cached Arena classification, spawn/lobby menu detection, combat-kit validation,
 * and FFA red_wool safe-zone target filtering mixin for PvPBotController.
 * Inventory flags are invalidated lazily via `inventory.updateSlot` (eliminates 40–60Hz scans!).
 */
const arenaDetectorMethods = {
  _invalidateArenaInventoryCache() {
    this._arenaInvCache = null;
  },

  _getArenaInventoryFlags() {
    if (this._arenaInvCache) return this._arenaInvCache;

    const flags = { wearingArmor: false, hasLobbyMenu: false, hasCombatKit: false };
    if (!this.bot || !this.bot.inventory || !Array.isArray(this.bot.inventory.slots)) {
      return flags;
    }

    const slots = this.bot.inventory.slots;
    for (const slot of [5, 6, 7, 8]) {
      const item = slots[slot];
      if (item && item.name && (
        item.name.endsWith('_helmet') ||
        item.name.endsWith('_chestplate') ||
        item.name.endsWith('_leggings') ||
        item.name.endsWith('_boots') ||
        item.name === 'elytra'
      )) {
        flags.wearingArmor = true;
        break;
      }
    }

    let hasWeaponOrUtility = flags.wearingArmor;

    for (let s = 0; s < slots.length; s++) {
      const item = slots[s];
      if (!item || !item.name) continue;
      const n = item.name;

      if (!flags.wearingArmor && LOBBY_MENU_ITEM_NAMES.has(n)) {
        flags.hasLobbyMenu = true;
      }

      if (!flags.hasLobbyMenu) {
        const customStr = item.customName
          ? (typeof item.customName === 'string' ? item.customName : JSON.stringify(item.customName))
          : '';
        if (customStr || item.displayName) {
          const rawText = `${getItemMetadataText(item)} ${customStr} ${item.displayName || ''}`;
          const cleanText = stripColorCodes(rawText).toLowerCase();
          if (cleanText && LOBBY_MENU_KEYWORDS.some((kw) => cleanText.includes(kw))) {
            flags.hasLobbyMenu = true;
          }
        }
      }

      if (!hasWeaponOrUtility) {
        if (
          n.endsWith('_sword') || n.endsWith('_axe') || isSpearItem(item) ||
          n === 'mace' || n === 'end_crystal' || n === 'respawn_anchor' ||
          n === 'totem_of_undying' || n === 'wind_charge' || n === 'crossbow' ||
          n === 'bow' || n === 'shield' || n === 'golden_apple' ||
          n === 'enchanted_golden_apple' || n === 'splash_potion' ||
          n === 'ender_pearl' || n === 'cobweb' || n === 'lava_bucket' ||
          n === 'tnt_minecart'
        ) {
          hasWeaponOrUtility = true;
        }
      }
    }

    flags.hasCombatKit = !flags.hasLobbyMenu && hasWeaponOrUtility;
    this._arenaInvCache = flags;
    return flags;
  },

  _isWearingCombatArmor() {
    return this._getArenaInventoryFlags().wearingArmor;
  },

  _hasLobbyMenuItems() {
    return this._getArenaInventoryFlags().hasLobbyMenu;
  },

  _hasCombatKit() {
    return this._getArenaInventoryFlags().hasCombatKit;
  },

  _detectArenaMode() {
    if (!this.bot || !this.bot.entity) return 'LOBBY';
    if (this._hasLobbyMenuItems()) return 'LOBBY';
    if (this.inDuelArena || this.pendingDuelReady) return 'DUELS';

    const hasKit = this._hasCombatKit();
    const pos = this.bot.entity.position;
    const botInRedWool = Boolean(this.redWoolZone && pos && this.redWoolZone.isPositionInSafeZone(pos));
    const knownRedWool = Boolean(
      this.redWoolZone && (
        typeof this.redWoolZone.hasKnownZone === 'function'
          ? this.redWoolZone.hasKnownZone()
          : (typeof this.redWoolZone.wasRecentlyInZone === 'function' && this.redWoolZone.wasRecentlyInZone(180000))
      )
    );

    if (this.inFfaArena || (hasKit && (botInRedWool || knownRedWool))) {
      return 'FFA';
    }

    const recentlyEndedDuel = (Date.now() - this.duelEndedAt) < 10000;
    if (hasKit && !recentlyEndedDuel) {
      const nearby = this._listNearbyPlayers();
      if (nearby.length >= 3) return 'FFA';
      if (this.redWoolZone && nearby.some((p) => this.redWoolZone.isPositionInSafeZone(p.entity.position))) {
        return 'FFA';
      }
      if (nearby.length >= 1) return 'DUELS';
    }

    return 'LOBBY';
  },

  _isPlayerInFfaSafeZone(playerEntity, arenaMode = null) {
    if (!playerEntity || !playerEntity.position || !this.redWoolZone) return false;
    if (this.inDuelArena || this.pendingDuelReady || arenaMode === 'DUELS') return false;
    return Boolean(this.redWoolZone.isPositionInSafeZone(playerEntity.position));
  },

  _pickEngageableTarget(arenaMode, maxRange) {
    const nearby = this._listNearbyPlayers();
    for (let i = 0; i < nearby.length; i++) {
      const candidate = nearby[i];
      if (candidate.dist > maxRange) break;
      if (this._isPlayerInFfaSafeZone(candidate.entity, arenaMode)) continue;
      return candidate;
    }
    return null;
  }
};

module.exports = {
  arenaDetectorMethods,
  LOBBY_MENU_KEYWORDS,
  LOBBY_MENU_ITEM_NAMES,
  stripColorCodes
};
