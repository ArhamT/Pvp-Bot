'use strict';

const OFFHAND_SLOT = 45;
const HOTBAR_START = 36;
const TORSO_SLOT = 6;

const PEARL_SPEED = 1.5;
const PEARL_GRAVITY = 0.03;
const PEARL_DRAG = 0.99;

const SWORD_PRIORITY = [
  'netherite_sword',
  'diamond_sword',
  'iron_sword',
  'stone_sword',
  'golden_sword',
  'wooden_sword'
];

const AXE_PRIORITY = [
  'netherite_axe',
  'diamond_axe',
  'iron_axe',
  'stone_axe',
  'golden_axe',
  'wooden_axe'
];

const CHESTPLATE_PRIORITY = [
  'netherite_chestplate',
  'diamond_chestplate',
  'iron_chestplate',
  'chainmail_chestplate',
  'golden_chestplate',
  'leather_chestplate'
];

const HAZARD_BLOCKS = new Set([
  'lava',
  'flowing_lava',
  'fire',
  'soul_fire',
  'campfire',
  'soul_campfire',
  'magma_block',
  'cobweb',
  'sweet_berry_bush',
  'wither_rose',
  'cactus'
]);

const ROAM_HAZARD_BLOCKS = new Set([...HAZARD_BLOCKS, 'water', 'flowing_water']);

const _itemMetaTextCache = new WeakMap();

/**
 * Returns true if an item is any variant of Spear or Trident.
 */
function isSpearItem(item) {
  if (!item) return false;
  const name = String(item.name || '').toLowerCase();
  const custom = String(item.customName || item.displayName || '').toLowerCase();
  return name.includes('spear') || name.includes('trident') || custom.includes('spear');
}

/**
 * Clears all 6 directional/action movement controls safely on a Mineflayer bot.
 */
function clearMovementControls(bot) {
  if (!bot || typeof bot.setControlState !== 'function') return;
  bot.setControlState('forward', false);
  bot.setControlState('back', false);
  bot.setControlState('left', false);
  bot.setControlState('right', false);
  bot.setControlState('sprint', false);
  bot.setControlState('jump', false);
}

/**
 * Returns a lowercase serialized view of an item's enchants/NBT/components,
 * WeakMap-cached per item instance to avoid repeated per-tick JSON allocations.
 */
function getItemMetadataText(item) {
  if (!item || typeof item !== 'object') return '';
  const cached = _itemMetaTextCache.get(item);
  if (cached !== undefined) return cached;

  let text = '';
  try {
    const parts = [];
    if (item.enchants) parts.push(JSON.stringify(item.enchants));
    if (item.nbt) parts.push(JSON.stringify(item.nbt));
    if (item.components) parts.push(JSON.stringify(item.components));
    if (item.componentMap instanceof Map) {
      for (const [k, v] of item.componentMap.entries()) {
        parts.push(String(k), JSON.stringify(v));
      }
    }
    text = parts.join(' ').toLowerCase();
  } catch (_) {
    text = '';
  }

  _itemMetaTextCache.set(item, text);
  return text;
}

/**
 * Checks whether an item's cached metadata references `enchantName`.
 */
function hasItemEnchant(item, enchantName) {
  if (!item || !enchantName) return false;
  return getItemMetadataText(item).includes(String(enchantName).toLowerCase());
}

/**
 * Checks the bot's full 0.6-wide player hitbox (center + 4 corners at ±0.29) across feet (y)
 * and head (y+1) and returns the first block matching `predicate`, or null.
 * Prevents missing cobwebs, water, lava, or solid blocks that clip the edge of the player hitbox.
 */
function findOverlappingBlock(bot, predicate) {
  if (!bot || !bot.entity || !bot.entity.position || typeof bot.blockAt !== 'function' || typeof predicate !== 'function') {
    return null;
  }
  const pos = bot.entity.position;
  const seen = new Set();
  const offsets = [0, -0.29, 0.29];
  for (const dy of [0, 1]) {
    const by = Math.floor(pos.y + dy);
    for (const ox of offsets) {
      for (const oz of offsets) {
        const bx = Math.floor(pos.x + ox);
        const bz = Math.floor(pos.z + oz);
        const key = `${bx},${by},${bz}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const block = bot.blockAt({ x: bx, y: by, z: bz });
        if (block && predicate(block)) {
          return block;
        }
      }
    }
  }
  return null;
}

module.exports = {
  OFFHAND_SLOT,
  HOTBAR_START,
  TORSO_SLOT,
  PEARL_SPEED,
  PEARL_GRAVITY,
  PEARL_DRAG,
  SWORD_PRIORITY,
  AXE_PRIORITY,
  CHESTPLATE_PRIORITY,
  HAZARD_BLOCKS,
  ROAM_HAZARD_BLOCKS,
  isSpearItem,
  clearMovementControls,
  getItemMetadataText,
  hasItemEnchant,
  findOverlappingBlock
};
