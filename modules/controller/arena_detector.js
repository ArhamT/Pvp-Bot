'use strict';

const { getItemMetadataText } = require('../constants');

const LOBBY_MENU_KEYWORDS = [
  'kit editor', 'kiteditor', 'edit kit', 'settings', 'preferences',
  'unranked', 'ranked', 'join queue', 'queue', 'spectate', 'party',
  'cosmetics', 'leaderboard', 'statistics', 'stats', 'profile',
  'server selector', 'game menu', 'main menu', 'return to lobby',
  'leave queue', 'play duels', 'duel menu', 'ffa menu'
];

const LOBBY_MENU_ITEM_NAMES = new Set([
  'compass', 'clock', 'nether_star', 'comparator', 'repeater',
  'writable_book', 'knowledge_book', 'book', 'paper',
  'name_tag', 'player_head', 'anvil'
]);

function stripColorCodes(text) {
  if (!text) return '';
  return String(text).replace(/§.|&[0-9a-fk-orx]/gi, '').trim();
}

/**
 * Arena classification, spawn/lobby menu detection, combat-kit validation,
 * and FFA red_wool safe-zone target filtering mixin for PvPBotController.
 */
const arenaDetectorMethods = {
  _isWearingCombatArmor() {
    if (!this.bot || !this.bot.inventory || !this.bot.inventory.slots) return false;
    for (const slot of [5, 6, 7, 8]) {
      const item = this.bot.inventory.slots[slot];
      if (item && item.name && (
        item.name.endsWith('_helmet') ||
        item.name.endsWith('_chestplate') ||
        item.name.endsWith('_leggings') ||
        item.name.endsWith('_boots') ||
        item.name === 'elytra'
      )) {
        return true;
      }
    }
    return false;
  },

  _hasLobbyMenuItems() {
    if (!this.bot || !this.bot.inventory || !Array.isArray(this.bot.inventory.slots)) return false;
    const wearingArmor = this._isWearingCombatArmor();

    for (const item of this.bot.inventory.slots) {
      if (!item || !item.name) continue;
      if (!wearingArmor && LOBBY_MENU_ITEM_NAMES.has(item.name)) {
        return true;
      }

      const customStr = item.customName
        ? (typeof item.customName === 'string' ? item.customName : JSON.stringify(item.customName))
        : '';
      const rawText = `${getItemMetadataText(item)} ${customStr} ${item.displayName || ''}`;
      const cleanText = stripColorCodes(rawText).toLowerCase();
      if (cleanText && LOBBY_MENU_KEYWORDS.some((kw) => cleanText.includes(kw))) {
        return true;
      }
    }
    return false;
  },

  _hasCombatKit() {
    if (this._hasLobbyMenuItems()) return false;
    if (this._isWearingCombatArmor()) return true;
    if (!this.bot || !this.bot.inventory || !Array.isArray(this.bot.inventory.slots)) return false;

    for (const item of this.bot.inventory.slots) {
      if (!item || !item.name) continue;
      const n = item.name;
      if (
        n === 'netherite_sword' || n === 'diamond_sword' || n === 'iron_sword' ||
        n === 'mace' || n === 'end_crystal' || n === 'respawn_anchor' ||
        n === 'totem_of_undying' || n === 'wind_charge' || n === 'crossbow' ||
        n === 'bow' || n === 'trident' || n.endsWith('_spear')
      ) {
        return true;
      }
    }
    return false;
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
      // Even with 1–2 players in an FFA arena, if any player is inside a red_wool safe zone -> FFA!
      if (this.redWoolZone && nearby.some((p) => this.redWoolZone.isPositionInSafeZone(p.entity.position))) {
        this.inFfaArena = true;
        return 'FFA';
      }
      if (nearby.length >= 1) return 'DUELS';
    }

    return 'LOBBY';
  },

  /**
   * Returns true if `playerEntity` is currently inside the FFA `red_wool` safe-zone radius
   * and MUST be ignored (never ignored in 1v1 Duels arenas).
   */
  _isPlayerInFfaSafeZone(playerEntity, arenaMode = null) {
    if (!playerEntity || !playerEntity.position || !this.redWoolZone) return false;
    if (this.inDuelArena || this.pendingDuelReady || arenaMode === 'DUELS') return false;
    if (this.redWoolZone.isPositionInSafeZone(playerEntity.position)) {
      if (this._hasCombatKit()) {
        this.inFfaArena = true;
      }
      return true;
    }
    return false;
  },

  _pickEngageableTarget(arenaMode, maxRange) {
    const nearby = this._listNearbyPlayers();
    for (const candidate of nearby) {
      if (candidate.dist > maxRange) break;
      if (this._isPlayerInFfaSafeZone(candidate.entity, arenaMode)) {
        continue;
      }
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
