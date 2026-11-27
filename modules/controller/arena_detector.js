'use strict';

const { isSpearItem } = require('../constants');

const LOBBY_MENU_KEYWORDS = [
  'kit editor', 'kiteditor', 'edit kit', 'edit kits', 'kit layout', 'kits menu', 'select kit', 'custom kit',
  'settings', 'setting', 'preferences', 'options',
  'queue', 'queues', 'unranked', 'ranked', 'casual', 'matchmaking', 'quick play', 'play again', 'rematch',
  'join queue', 'leave queue',
  'party', 'create party', 'party menu', 'party duel', 'party games',
  'spectate', 'spectator', 'watch match', 'live matches',
  'cosmetics', 'cosmetic', 'profile', 'leaderboard', 'leaderboards', 'statistics', 'your stats', 'stats',
  'server selector', 'game menu', 'main menu', 'return to lobby', 'back to lobby', 'back to hub',
  'leave lobby', 'back to spawn',
  'play duels', 'duel menu', 'duels menu', 'ffa menu', 'join ffa', 'bot duel', 'fight bot',
  'events', 'tournament', 'tournaments',
  'hide players', 'show players', 'player visibility',
  'right-click to', 'right click to', 'click to open', 'click to join',
  'click to edit', 'click to queue', 'click to spectate', 'click to toggle'
];

// Definite menu-only items when unarmored (without real fight consumables)
const LOBBY_MENU_ITEM_NAMES = new Set([
  'compass', 'clock', 'nether_star', 'comparator', 'repeater',
  'writable_book', 'knowledge_book', 'book', 'enchanted_book', 'name_tag',
  'anvil', 'chipped_anvil', 'damaged_anvil', 'paper', 'player_head',
  'painting', 'item_frame', 'redstone_torch', 'lever',
  'emerald', 'chest', 'ender_chest', 'ender_eye',
  'gray_dye', 'lime_dye', 'red_dye'
]);

const COMBAT_CONSUMABLE_NAMES = new Set([
  'totem_of_undying', 'end_crystal', 'respawn_anchor', 'tnt_minecart',
  'golden_apple', 'enchanted_golden_apple', 'splash_potion', 'lingering_potion',
  'wind_charge', 'ender_pearl', 'cobweb', 'lava_bucket'
]);

const _itemReadableTextCache = new WeakMap();

function stripColorCodes(text) {
  if (!text) return '';
  return String(text).replace(/§.|&[0-9a-fk-orx]/gi, '').trim();
}

/**
 * Recursively flattens Minecraft JSON / NBT / MC 1.21+ chat components (including MiniMessage /
 * RGB hex gradients where every character is a separate `extra` node) into plain readable text.
 */
function extractComponentPlainText(node, depth = 0) {
  if (node === null || node === undefined || depth > 12) return '';

  if (typeof node === 'string') {
    const trimmed = node.trim();
    if (!trimmed) return '';
    if ((trimmed[0] === '{' && trimmed[trimmed.length - 1] === '}') ||
        (trimmed[0] === '[' && trimmed[trimmed.length - 1] === ']')) {
      try {
        const parsed = JSON.parse(trimmed);
        return extractComponentPlainText(parsed, depth + 1);
      } catch (_) {
        return trimmed;
      }
    }
    return trimmed;
  }

  if (typeof node === 'number' || typeof node === 'boolean') return '';

  if (Array.isArray(node)) {
    // Array of chat sibling nodes (e.g. gradient characters) concatenate directly;
    // array of lore lines or separate entries separated if they have spaces already
    let out = '';
    for (let i = 0; i < node.length; i++) {
      const part = extractComponentPlainText(node[i], depth + 1);
      if (!part) continue;
      out += part;
    }
    return out;
  }

  if (typeof node === 'object') {
    // Prismarine-nbt wrapper: { type: 'string'|'compound'|'list', value: ... }
    if (typeof node.type === 'string' && node.value !== undefined) {
      if (node.type === 'string') {
        return extractComponentPlainText(node.value, depth + 1);
      }
      if (node.type === 'list' && node.value && Array.isArray(node.value.value)) {
        return node.value.value
          .map((entry) => extractComponentPlainText(entry, depth + 1))
          .filter(Boolean)
          .join(' ');
      }
      if (node.type === 'compound') {
        return extractComponentPlainText(node.value, depth + 1);
      }
    }

    // Standard Minecraft TextComponent: { text: "...", extra: [...] } (concatenate directly for gradients!)
    let out = '';
    if (node.text !== undefined) {
      out += extractComponentPlainText(node.text, depth + 1);
    }
    if (node[''] !== undefined) {
      out += extractComponentPlainText(node[''], depth + 1);
    }
    if (Array.isArray(node.extra)) {
      out += extractComponentPlainText(node.extra, depth + 1);
    } else if (node.extra && typeof node.extra === 'object') {
      out += extractComponentPlainText(node.extra, depth + 1);
    }
    if (Array.isArray(node.with)) {
      out += ' ' + extractComponentPlainText(node.with, depth + 1);
    }
    if (typeof node.translate === 'string' && !out) {
      out += node.translate;
    }
    if (out) return out;

    // Fallback: inspect data/value wrappers (MC 1.21 component entries)
    if (node.data !== undefined) {
      return extractComponentPlainText(node.data, depth + 1);
    }
    if (node.value !== undefined) {
      return extractComponentPlainText(node.value, depth + 1);
    }
  }

  return '';
}

/**
 * Extracts flattened, color-stripped, lowercase custom name + lore text from any MC 1.19–1.21.11+ item.
 * WeakMap-cached per item instance for O(1) lookups.
 */
function getItemReadableNameAndLore(item) {
  if (!item || typeof item !== 'object') return '';
  const cached = _itemReadableTextCache.get(item);
  if (cached !== undefined) return cached;

  const chunks = [];
  const pushNode = (val) => {
    if (val === null || val === undefined) return;
    const text = stripColorCodes(extractComponentPlainText(val));
    if (text) chunks.push(text);
  };

  if (item.customName) pushNode(item.customName);

  // MC 1.20.5–1.21.11+ components (Array form: [{ type: 'custom_name', data: ... }])
  if (Array.isArray(item.components)) {
    for (let i = 0; i < item.components.length; i++) {
      const comp = item.components[i];
      if (!comp || !comp.type) continue;
      const t = String(comp.type).toLowerCase().replace(/^minecraft:/, '');
      if (t === 'custom_name' || t === 'item_name' || t === 'lore') {
        if (t === 'lore' && Array.isArray(comp.data)) {
          for (const line of comp.data) pushNode(line);
        } else {
          pushNode(comp.data !== undefined ? comp.data : comp.value);
        }
      }
    }
  } else if (item.components && typeof item.components === 'object') {
    for (const [k, v] of Object.entries(item.components)) {
      const t = String(k).toLowerCase().replace(/^minecraft:/, '');
      if (t === 'custom_name' || t === 'item_name' || t === 'lore') {
        if (t === 'lore' && Array.isArray(v)) {
          for (const line of v) pushNode(line);
        } else {
          pushNode(v);
        }
      }
    }
  }

  if (item.componentMap instanceof Map) {
    for (const [k, v] of item.componentMap.entries()) {
      const t = String(k).toLowerCase().replace(/^minecraft:/, '');
      if (t === 'custom_name' || t === 'item_name' || t === 'lore') {
        if (t === 'lore' && v && Array.isArray(v.data)) {
          for (const line of v.data) pushNode(line);
        } else {
          pushNode(v && v.data !== undefined ? v.data : v);
        }
      }
    }
  }

  // Legacy MC <=1.20.4 NBT display.Name / display.Lore
  if (item.nbt && item.nbt.value && item.nbt.value.display && item.nbt.value.display.value) {
    const disp = item.nbt.value.display.value;
    if (disp.Name) pushNode(disp.Name);
    if (disp.Lore) pushNode(disp.Lore);
  }

  const combined = chunks.join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
  _itemReadableTextCache.set(item, combined);
  return combined;
}

/**
 * Cached Arena classification, spawn/lobby menu detection (with MC 1.21 gradient flattening),
 * combat-kit validation, and FFA red_wool safe-zone target filtering mixin for PvPBotController.
 */
const arenaDetectorMethods = {
  _invalidateArenaInventoryCache() {
    this._arenaInvCache = null;
    this._arenaInvCacheAt = 0;
  },

  _getArenaInventoryFlags() {
    const now = Date.now();
    // 250ms TTL fallback protects against bulk window_items packets that bypass updateSlot
    if (this._arenaInvCache && (now - (this._arenaInvCacheAt || 0)) < 250) {
      return this._arenaInvCache;
    }

    const flags = {
      wearingArmor: false,
      hasLobbyMenu: false,
      lobbyReason: null,
      hasCombatKit: false
    };
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

    let hasCombatWeapon = flags.wearingArmor;
    let hasCombatConsumable = false;
    let firstUnarmoredLobbyItem = null;

    for (let s = 0; s < slots.length; s++) {
      const item = slots[s];
      if (!item || !item.name) continue;
      const n = item.name;

      // 1. Check flattened custom name & lore (catches Settings, Queue, Kit Editor, Party, etc. even with RGB gradients!)
      const readable = getItemReadableNameAndLore(item);
      let itemIsLobbyMenu = false;
      if (readable) {
        for (let k = 0; k < LOBBY_MENU_KEYWORDS.length; k++) {
          const kw = LOBBY_MENU_KEYWORDS[k];
          if (readable.includes(kw)) {
            flags.hasLobbyMenu = true;
            if (!flags.lobbyReason) flags.lobbyReason = kw;
            itemIsLobbyMenu = true;
            break;
          }
        }
      }

      if (LOBBY_MENU_ITEM_NAMES.has(n) && !firstUnarmoredLobbyItem) {
        firstUnarmoredLobbyItem = n;
      }

      // 2. Do NOT count a lobby menu sword/bow/item (e.g. "Unranked Queue" Iron Sword) as a combat kit!
      if (itemIsLobbyMenu) continue;

      if (COMBAT_CONSUMABLE_NAMES.has(n)) {
        hasCombatConsumable = true;
        hasCombatWeapon = true;
      } else if (!hasCombatWeapon) {
        if (
          n.endsWith('_sword') || n.endsWith('_axe') || isSpearItem(item) ||
          n === 'mace' || n === 'crossbow' || n === 'bow' || n === 'shield'
        ) {
          hasCombatWeapon = true;
        }
      }
    }

    // 3. Unarmored spawn heuristic: carrying lobby menu items (comparator, book, anvil, clock, compass, player_head, etc.)
    // without wearing armor or carrying real PvP consumables (potions/gapples/totems/crystals/anchors)
    if (!flags.hasLobbyMenu && !flags.wearingArmor && !hasCombatConsumable && firstUnarmoredLobbyItem) {
      flags.hasLobbyMenu = true;
      flags.lobbyReason = `item:${firstUnarmoredLobbyItem}`;
    }

    flags.hasCombatKit = !flags.hasLobbyMenu && hasCombatWeapon;
    this._arenaInvCache = flags;
    this._arenaInvCacheAt = now;
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
  stripColorCodes,
  extractComponentPlainText,
  getItemReadableNameAndLore
};
