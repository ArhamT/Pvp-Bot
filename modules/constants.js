'use strict';

const { Vec3 } = require('vec3');

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
        const block = bot.blockAt(new Vec3(bx, by, bz));
        if (block && predicate(block)) {
          return block;
        }
      }
    }
  }
  return null;
}

function posKey(pos) {
  return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
}

function isAirLike(block) {
  return Boolean(
    !block ||
    block.name === 'air' ||
    block.name === 'cave_air' ||
    block.name === 'void_air'
  );
}

/**
 * Returns true strictly for water/lava source blocks (level === 0 / metadata === 0).
 * Flowing streams (level > 0, metadata > 0, flowing_water, flowing_lava) return false.
 */
function isLiquidSource(block) {
  if (!block || (block.name !== 'water' && block.name !== 'lava')) return false;
  if (typeof block.getProperties === 'function') {
    const props = block.getProperties();
    if (props && props.level !== undefined) {
      return Number(props.level) === 0;
    }
  }
  if (typeof block.metadata === 'number') {
    return block.metadata === 0;
  }
  return true;
}

const PARTIAL_NON_SUFFOCATING_PATTERN = /slab|stairs|trapdoor|carpet|snow|farmland|dirt_path|grass_path|soul_sand|chest|bed|daylight_detector|enchanting_table|pressure_plate|fence|_wall|cake|hopper|cauldron|lantern|anvil|brewing_stand|composter|lectern|stonecutter|scaffolding|lily_pad|end_rod|chain|iron_bars|glass_pane/;

/**
 * Returns the world-space vertical collision bounds `{ minY, maxY }` of a solid block,
 * or `null` if non-solid/passable. Uses `block.shapes` (exact prismarine-block AABBs)
 * when available, with accurate fallbacks for slabs, trapdoors, stairs, carpets, paths, etc.
 */
function getBlockCollisionBounds(block) {
  if (!block || block.boundingBox !== 'block') return null;
  const by = block.position ? Math.floor(block.position.y) : 0;

  if (Array.isArray(block.shapes)) {
    if (block.shapes.length === 0) return null;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const s of block.shapes) {
      if (!Array.isArray(s) || s.length < 6) continue;
      if (s[1] < minY) minY = s[1];
      if (s[4] > maxY) maxY = s[4];
    }
    if (minY === Infinity || maxY === -Infinity) return null;
    return { minY: by + minY, maxY: by + maxY };
  }

  const name = String(block.name || '');
  let props = null;
  if (typeof block.getProperties === 'function') {
    try {
      props = block.getProperties();
    } catch (_) {
      props = null;
    }
  }

  if (name.includes('carpet')) return { minY: by, maxY: by + 0.0625 };
  if (name.includes('trapdoor')) {
    if (props && (props.open === true || props.open === 'true')) {
      return { minY: by, maxY: by + 1.0 };
    }
    if (props && props.half === 'top') {
      return { minY: by + 0.8125, maxY: by + 1.0 };
    }
    return { minY: by, maxY: by + 0.1875 };
  }
  if (name.includes('slab')) {
    if (props && props.type === 'double') return { minY: by, maxY: by + 1.0 };
    if (props && props.type === 'top') return { minY: by + 0.5, maxY: by + 1.0 };
    return { minY: by, maxY: by + 0.5 };
  }
  if (name === 'snow') {
    const layers = props && props.layers !== undefined ? Number(props.layers) : 1;
    if (layers <= 1) return null;
    return { minY: by, maxY: by + Math.min(1.0, (layers - 1) * 0.125) };
  }
  if (name.includes('daylight_detector')) return { minY: by, maxY: by + 0.375 };
  if (name.includes('bed')) return { minY: by, maxY: by + 0.5625 };
  if (name === 'enchanting_table') return { minY: by, maxY: by + 0.75 };
  if (name === 'soul_sand' || name.includes('chest')) return { minY: by, maxY: by + 0.875 };
  if (name === 'farmland' || name === 'dirt_path' || name === 'grass_path') return { minY: by, maxY: by + 0.9375 };
  if (name.includes('fence') || name.endsWith('_wall')) return { minY: by, maxY: by + 1.5 };

  return { minY: by, maxY: by + 1.0 };
}

/**
 * Returns true only if the player's inner body hitbox at `pos` is genuinely embedded inside
 * `block`'s collision geometry. Standing ON a slab, trapdoor, stair, carpet, path, etc. returns false.
 */
function isPlayerEmbeddedInBlock(pos, block) {
  if (!pos || !block || block.boundingBox !== 'block') return false;
  const bx = block.position ? Math.floor(block.position.x) : Math.floor(pos.x);
  const by = block.position ? Math.floor(block.position.y) : Math.floor(pos.y);
  const bz = block.position ? Math.floor(block.position.z) : Math.floor(pos.z);

  const pMinX = pos.x - 0.18;
  const pMaxX = pos.x + 0.18;
  const pMinY = pos.y + 0.12;
  const pMaxY = pos.y + 1.72;
  const pMinZ = pos.z - 0.18;
  const pMaxZ = pos.z + 0.18;

  if (Array.isArray(block.shapes)) {
    if (block.shapes.length === 0) return false;
    for (const s of block.shapes) {
      if (!Array.isArray(s) || s.length < 6) continue;
      if (
        (bx + s[3]) > pMinX && (bx + s[0]) < pMaxX &&
        (by + s[4]) > pMinY && (by + s[1]) < pMaxY &&
        (bz + s[5]) > pMinZ && (bz + s[2]) < pMaxZ
      ) {
        return true;
      }
    }
    return false;
  }

  const name = String(block.name || '');
  const bounds = getBlockCollisionBounds(block);
  if (!bounds) return false;

  if (PARTIAL_NON_SUFFOCATING_PATTERN.test(name) && (pos.y - by) > 0.02) {
    return false;
  }

  return bounds.maxY > pMinY && bounds.minY < pMaxY;
}

/**
 * Evaluates walkability, auto-step (<= 0.6b), jumpable ledge (0.6..1.25b), headroom,
 * and immediate floor support at column `(x, z)` from feet height `y`.
 * Handles slabs, trapdoors, stairs, carpets, snow layers, paths, and floating slab bridges.
 */
function inspectColumnStep(bot, x, y, z) {
  const result = {
    walkable: true,
    needsJump: false,
    blocked: false,
    hasFloor: false,
    stepHeight: 0,
    targetFeetY: y
  };
  if (!bot || typeof bot.blockAt !== 'function') return result;

  const bx = Math.floor(x);
  const by = Math.floor(y);
  const bz = Math.floor(z);

  const solids = [];
  let bestStepTop = null;
  let supportTop = null;

  for (let dy = -1; dy <= 2; dy++) {
    const b = bot.blockAt(new Vec3(bx, by + dy, bz));
    if (!b) continue;
    const bounds = getBlockCollisionBounds(b);
    if (!bounds) continue;
    solids.push(bounds);

    if (dy <= 1) {
      if (bounds.maxY > y + 0.02 && bounds.maxY <= y + 1.25) {
        if (bestStepTop === null || bounds.maxY > bestStepTop) {
          bestStepTop = bounds.maxY;
        }
      } else if (dy <= 0 && bounds.maxY <= y + 0.05) {
        if (supportTop === null || bounds.maxY > supportTop) {
          supportTop = bounds.maxY;
        }
      }
    }
  }

  if (bestStepTop !== null) {
    result.targetFeetY = bestStepTop;
    result.stepHeight = bestStepTop - y;
    result.hasFloor = true;
  } else if (supportTop !== null) {
    result.targetFeetY = supportTop;
    result.stepHeight = 0;
    result.hasFloor = true;
  }

  for (const bounds of solids) {
    if (bounds.maxY > result.targetFeetY + 0.05 && bounds.minY < result.targetFeetY + 1.75) {
      result.blocked = true;
      result.walkable = false;
      result.needsJump = false;
      return result;
    }
  }

  if (result.stepHeight > 0.6) {
    result.walkable = false;
    result.needsJump = true;
  } else {
    result.walkable = true;
    result.needsJump = false;
  }

  return result;
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
  findOverlappingBlock,
  posKey,
  isAirLike,
  isLiquidSource,
  getBlockCollisionBounds,
  isPlayerEmbeddedInBlock,
  inspectColumnStep
};
