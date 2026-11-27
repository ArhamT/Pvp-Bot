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

/**
 * Blast-resistant solid cover priority (obsidian/ancient debris first; NEVER cobweb).
 */
const BLAST_SHIELD_BLOCK_PRIORITY = [
  'obsidian',
  'crying_obsidian',
  'respawn_anchor',
  'ancient_debris',
  'ender_chest',
  'cobbled_deepslate',
  'cobblestone',
  'deepslate',
  'stone',
  'end_stone',
  'netherrack',
  'dirt'
];

/**
 * General solid building/cover/escape block priority (cheap solid blocks first, obsidian fallback).
 */
const COVER_BLOCK_PRIORITY = [
  'cobblestone',
  'cobbled_deepslate',
  'netherrack',
  'dirt',
  'stone',
  'oak_planks',
  'spruce_planks',
  'birch_planks',
  'jungle_planks',
  'acacia_planks',
  'dark_oak_planks',
  'mangrove_planks',
  'cherry_planks',
  'bamboo_planks',
  'crimson_planks',
  'warped_planks',
  'end_stone',
  'deepslate',
  'sandstone',
  'blackstone',
  'basalt',
  'andesite',
  'diorite',
  'granite',
  'obsidian'
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

/**
 * Canonical status effect ID tables for MC <=1.20.4 (1-based) vs MC 1.20.5–1.21.11+ (0-based).
 */
const EFFECT_IDS = Object.freeze({
  speed: { zero: 0, one: 1, names: ['speed', 'swiftness'] },
  slowness: { zero: 1, one: 2, names: ['slowness'] },
  strength: { zero: 4, one: 5, names: ['strength'] },
  instant_health: { zero: 5, one: 6, names: ['instant_health', 'instanthealth', 'healing'] },
  regeneration: { zero: 9, one: 10, names: ['regeneration'] },
  resistance: { zero: 10, one: 11, names: ['resistance', 'damage_resistance'] },
  fire_resistance: { zero: 11, one: 12, names: ['fire_resistance', 'fireresistance', 'fire resistance'] },
  water_breathing: { zero: 12, one: 13, names: ['water_breathing', 'waterbreathing'] },
  slow_falling: { zero: 27, one: 28, names: ['slow_falling', 'slowfalling', 'slow falling'] }
});

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
 * Determines whether the connected Minecraft server uses 0-based effect IDs (MC 1.20.5+).
 */
function usesZeroBasedEffectIds(bot) {
  if (bot && bot.registry && bot.registry.effectsByName) {
    const speed = bot.registry.effectsByName.Speed || bot.registry.effectsByName.speed;
    if (speed && typeof speed.id === 'number') {
      return speed.id === 0;
    }
  }
  const ver = String((bot && bot.version) || '');
  return !ver || /^1\.(20\.[5-9]|21|2[2-9])/.test(ver);
}

/**
 * Returns the active effect entry (or null) for `effectKey` on `entity` (defaults to `bot.entity`),
 * strictly respecting MC 1.20.4 (1-based) vs MC 1.20.5+ (0-based) IDs and `bot.registry`.
 */
function getStatusEffect(bot, effectKey, entity = null) {
  const ent = entity || (bot && bot.entity);
  if (!ent || !ent.effects) return null;
  const spec = EFFECT_IDS[effectKey];
  if (!spec) return null;

  const effects = ent.effects;
  let targetId = null;

  if (bot && bot.registry && bot.registry.effectsByName) {
    for (const candidateName of spec.names) {
      const camel = candidateName.replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase());
      const reg = bot.registry.effectsByName[camel] || bot.registry.effectsByName[candidateName];
      if (reg && typeof reg.id === 'number') {
        targetId = reg.id;
        break;
      }
    }
  }

  if (targetId === null) {
    targetId = usesZeroBasedEffectIds(bot) ? spec.zero : spec.one;
  }

  if (effects instanceof Map) {
    if (effects.has(targetId)) return effects.get(targetId);
    if (effects.has(String(targetId))) return effects.get(String(targetId));
    for (const n of spec.names) {
      if (effects.has(n)) return effects.get(n);
    }
    return null;
  }

  if (Array.isArray(effects)) {
    for (const e of effects) {
      if (!e) continue;
      if (Number(e.id) === targetId) return e;
      const n = String(e.name || e.displayName || '').toLowerCase();
      if (n && spec.names.some((k) => n.includes(k))) return e;
    }
    return null;
  }

  if (typeof effects === 'object') {
    if (effects[targetId]) return effects[targetId];
    if (effects[String(targetId)]) return effects[String(targetId)];
    for (const n of spec.names) {
      if (effects[n]) return effects[n];
    }
    for (const [key, eff] of Object.entries(effects)) {
      if (!eff) continue;
      const eid = eff.id !== undefined ? Number(eff.id) : Number(key);
      if (eid === targetId) return eff;
      const n = String(eff.name || eff.displayName || '').toLowerCase();
      if (n && spec.names.some((k) => n.includes(k))) return eff;
      if (bot && bot.registry && bot.registry.effects && bot.registry.effects[eid]) {
        const regName = String(bot.registry.effects[eid].name || bot.registry.effects[eid].displayName || '').toLowerCase();
        if (regName && spec.names.some((k) => regName.includes(k))) return eff;
      }
    }
  }

  return null;
}

function hasStatusEffect(bot, effectKey, entity = null) {
  return Boolean(getStatusEffect(bot, effectKey, entity));
}

function getStatusEffectAmplifier(bot, effectKey, entity = null) {
  const eff = getStatusEffect(bot, effectKey, entity);
  if (!eff) return -1;
  return typeof eff.amplifier === 'number' ? eff.amplifier : 0;
}

/**
 * Single-pass hitbox sample across feet (0.05), torso (0.9), and head (1.78) corners.
 * Returns `{ inLava, inFire, inWater, cobweb }` with zero duplicate block lookups per tick.
 */
function sampleBodyHazards(bot) {
  const res = { inLava: false, inFire: false, inWater: false, cobweb: null };
  if (!bot || !bot.entity || !bot.entity.position) return res;

  if (bot.entity.isInLava) res.inLava = true;
  if (bot.entity.isInWater) res.inWater = true;
  if (bot.entity.onFire || bot.entity.isOnFire || (bot.entity.metadata && (Number(bot.entity.metadata[0]) & 0x01))) {
    res.inFire = true;
  }

  if (typeof bot.blockAt !== 'function') return res;

  const pos = bot.entity.position;
  const seen = new Set();
  const offsets = [0, -0.29, 0.29];
  const probe = new Vec3(0, 0, 0);

  for (const dy of [0.05, 0.9, 1.78]) {
    const by = Math.floor(pos.y + dy);
    for (const ox of offsets) {
      const bx = Math.floor(pos.x + ox);
      for (const oz of offsets) {
        const bz = Math.floor(pos.z + oz);
        const key = ((bx & 0x1fffff) * 1099511627776) + ((by & 0xfff) * 2097152) + (bz & 0x1fffff);
        if (seen.has(key)) continue;
        seen.add(key);
        probe.x = bx;
        probe.y = by;
        probe.z = bz;
        const b = bot.blockAt(probe);
        if (!b || !b.name) continue;
        const name = b.name;
        if (name === 'lava' || name === 'flowing_lava') res.inLava = true;
        else if (name === 'fire' || name === 'soul_fire') res.inFire = true;
        else if (name === 'water' || name === 'flowing_water') res.inWater = true;
        else if (name === 'cobweb' && !res.cobweb) res.cobweb = b;
      }
    }
  }
  return res;
}

/**
 * Checks the bot's full 0.6-wide player hitbox (center + 4 corners at ±0.29) across feet,
 * torso, and head and returns the first block matching `predicate`, or null.
 */
function findOverlappingBlock(bot, predicate) {
  if (!bot || !bot.entity || !bot.entity.position || typeof bot.blockAt !== 'function' || typeof predicate !== 'function') {
    return null;
  }
  const pos = bot.entity.position;
  const seen = new Set();
  const offsets = [0, -0.29, 0.29];
  const probe = new Vec3(0, 0, 0);

  for (const dy of [0.05, 0.9, 1.78]) {
    const by = Math.floor(pos.y + dy);
    for (const ox of offsets) {
      const bx = Math.floor(pos.x + ox);
      for (const oz of offsets) {
        const bz = Math.floor(pos.z + oz);
        const key = `${bx},${by},${bz}`;
        if (seen.has(key)) continue;
        seen.add(key);
        probe.x = bx;
        probe.y = by;
        probe.z = bz;
        const block = bot.blockAt(probe);
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

function sameBlockPos(a, b) {
  return Boolean(
    a && b &&
    Math.floor(a.x) === Math.floor(b.x) &&
    Math.floor(a.y) === Math.floor(b.y) &&
    Math.floor(a.z) === Math.floor(b.z)
  );
}

function isAirLike(block) {
  return Boolean(
    !block ||
    block.name === 'air' ||
    block.name === 'cave_air' ||
    block.name === 'void_air'
  );
}

function isNonNullAir(block) {
  return Boolean(block) && isAirLike(block);
}

function isHazardBlock(block) {
  return Boolean(block && block.name && HAZARD_BLOCKS.has(block.name));
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
 * or `null` if non-solid/passable.
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
 * hazards (lava/fire/cobweb/cactus), and immediate floor support at column `(x, z)` from feet height `y`.
 */
function inspectColumnStep(bot, x, y, z) {
  const result = {
    walkable: true,
    needsJump: false,
    blocked: false,
    hasFloor: false,
    hasHazard: false,
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
    if (dy >= -1 && dy <= 1 && HAZARD_BLOCKS.has(b.name)) {
      result.hasHazard = true;
    }
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

/**
 * Checks whether standing/stepping at `pos` is safe (no hazards, no wall block, no >maxDrop void cliff).
 */
function isPositionSafe(bot, pos, maxDrop = 3) {
  if (!bot || typeof bot.blockAt !== 'function' || !pos) return true;
  const col = inspectColumnStep(bot, pos.x, pos.y, pos.z);
  if (col.hasHazard || col.blocked) return false;
  if (col.hasFloor) return true;

  const bx = Math.floor(pos.x);
  const by = Math.floor(pos.y);
  const bz = Math.floor(pos.z);
  for (let drop = 2; drop <= maxDrop; drop++) {
    const b = bot.blockAt(new Vec3(bx, by - drop, bz));
    if (b && HAZARD_BLOCKS.has(b.name)) return false;
    if (b && b.boundingBox === 'block') return true;
  }
  return false;
}

/**
 * Samples along normalized horizontal direction `(dirX, dirZ)` up to `dist` blocks from bot feet.
 */
function isDirectionSafe(bot, dirX, dirZ, dist = 2.0, maxDrop = 3) {
  if (!bot || !bot.entity || !bot.entity.position) return true;
  const pos = bot.entity.position;
  const steps = Math.max(1, Math.ceil(dist));
  for (let i = 1; i <= steps; i++) {
    const d = Math.min(dist, i * 0.9);
    const sample = new Vec3(pos.x + dirX * d, pos.y, pos.z + dirZ * d);
    if (!isPositionSafe(bot, sample, maxDrop)) return false;
  }
  return true;
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
  BLAST_SHIELD_BLOCK_PRIORITY,
  COVER_BLOCK_PRIORITY,
  HAZARD_BLOCKS,
  ROAM_HAZARD_BLOCKS,
  EFFECT_IDS,
  isSpearItem,
  clearMovementControls,
  getItemMetadataText,
  hasItemEnchant,
  usesZeroBasedEffectIds,
  getStatusEffect,
  hasStatusEffect,
  getStatusEffectAmplifier,
  sampleBodyHazards,
  findOverlappingBlock,
  posKey,
  sameBlockPos,
  isAirLike,
  isNonNullAir,
  isHazardBlock,
  isLiquidSource,
  getBlockCollisionBounds,
  isPlayerEmbeddedInBlock,
  inspectColumnStep,
  isPositionSafe,
  isDirectionSafe
};
