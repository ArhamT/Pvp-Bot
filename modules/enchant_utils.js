'use strict';

const { getItemMetadataText } = require('./constants');

const TRACKED_ENCHANTS = Object.freeze([
  'protection',
  'blast_protection',
  'fire_protection',
  'projectile_protection',
  'feather_falling',
  'depth_strider',
  'swift_sneak',
  'thorns',
  'sharpness',
  'smite',
  'bane_of_arthropods',
  'knockback',
  'fire_aspect',
  'sweeping_edge',
  'density',
  'breach',
  'wind_burst',
  'efficiency',
  'unbreaking',
  'mending',
  'quick_charge',
  'multishot',
  'piercing',
  'power',
  'punch',
  'flame',
  'infinity',
  'lunge',
  'loyalty',
  'riptide',
  'impaling'
]);

// Pre-compiled regexes (zero per-call RegExp allocation)
const ENCHANT_REGEX_MAP = Object.create(null);
for (const key of TRACKED_ENCHANTS) {
  ENCHANT_REGEX_MAP[key] = new RegExp(`${key}[^0-9]{0,24}(\\d+)`);
}

const _parsedEnchantCache = new WeakMap();

function unwrapNbt(val) {
  let cur = val;
  while (cur && typeof cur === 'object' && 'value' in cur && !Array.isArray(cur)) {
    cur = cur.value;
  }
  return cur;
}

function normalizeEnchantName(raw) {
  if (typeof raw !== 'string') return '';
  const lower = raw.trim().toLowerCase();
  return lower.startsWith('minecraft:') ? lower.slice('minecraft:'.length) : lower;
}

function createEmptyEnchantMap() {
  const out = Object.create(null);
  for (const key of TRACKED_ENCHANTS) {
    out[key] = 0;
  }
  return out;
}

/**
 * Parses Minecraft 1.20.4–1.21.11+ item enchantments across `enchants`, `components` (Array/Object),
 * `componentMap` (Map), legacy `nbt`, and fallback metadata text.
 * WeakMap-cached per item object for O(1) repeated lookups in 20-TPS loops.
 */
function parseItemEnchantments(item) {
  if (!item || typeof item !== 'object') return createEmptyEnchantMap();

  const cached = _parsedEnchantCache.get(item);
  if (cached) return cached;

  const result = createEmptyEnchantMap();

  const record = (nameRaw, lvlRaw) => {
    const name = normalizeEnchantName(nameRaw);
    if (!name || !(name in result)) return;
    const rawNum = Number(unwrapNbt(lvlRaw));
    const lvl = Number.isFinite(rawNum) && rawNum > 0 ? Math.min(255, Math.floor(rawNum)) : 1;
    if (lvl > result[name]) {
      result[name] = lvl;
    }
  };

  const inspectContainer = (container) => {
    const unwrapped = unwrapNbt(container);
    if (!unwrapped) return;

    if (Array.isArray(unwrapped)) {
      for (const entry of unwrapped) {
        if (!entry || typeof entry !== 'object') continue;
        const id = unwrapNbt(entry.id !== undefined ? entry.id : entry.name);
        const lvl = entry.level !== undefined ? entry.level : entry.lvl;
        record(id, lvl);
      }
      return;
    }

    if (unwrapped instanceof Map) {
      for (const [key, val] of unwrapped.entries()) {
        record(key, val);
      }
      return;
    }

    if (typeof unwrapped === 'object') {
      if (unwrapped.levels) inspectContainer(unwrapped.levels);
      if (unwrapped.enchantments) inspectContainer(unwrapped.enchantments);
      for (const [key, val] of Object.entries(unwrapped)) {
        if (key === 'levels' || key === 'enchantments') continue;
        record(key, val);
      }
    }
  };

  if (Array.isArray(item.enchants)) {
    inspectContainer(item.enchants);
  }

  if (Array.isArray(item.components)) {
    for (const comp of item.components) {
      if (!comp || typeof comp !== 'object') continue;
      const type = normalizeEnchantName(comp.type || '');
      if (type === 'enchantments' || type === 'stored_enchantments') {
        inspectContainer(comp.data || comp.value || comp);
      }
    }
  } else if (item.components && typeof item.components === 'object') {
    inspectContainer(item.components.enchantments || item.components['minecraft:enchantments']);
    inspectContainer(item.components.stored_enchantments || item.components['minecraft:stored_enchantments']);
  }

  if (item.componentMap instanceof Map) {
    inspectContainer(
      item.componentMap.get('enchantments') ||
      item.componentMap.get('minecraft:enchantments')
    );
    inspectContainer(
      item.componentMap.get('stored_enchantments') ||
      item.componentMap.get('minecraft:stored_enchantments')
    );
  }

  if (item.nbt && typeof item.nbt === 'object') {
    const nbtVal = unwrapNbt(item.nbt);
    if (nbtVal && typeof nbtVal === 'object') {
      if (nbtVal.Enchantments) inspectContainer(nbtVal.Enchantments);
      if (nbtVal.ench) inspectContainer(nbtVal.ench);
    }
  }

  // Fallback text scan (strip specialized protection types before matching generic 'protection')
  const rawText = getItemMetadataText(item);
  if (rawText) {
    for (const specProt of ['blast_protection', 'fire_protection', 'projectile_protection']) {
      if (!rawText.includes(specProt)) continue;
      const m = rawText.match(ENCHANT_REGEX_MAP[specProt]);
      if (m && Number(m[1]) > result[specProt]) {
        result[specProt] = Number(m[1]);
      } else if (result[specProt] === 0) {
        result[specProt] = 1;
      }
    }

    const stripped = rawText
      .replace(/blast_protection/g, '')
      .replace(/fire_protection/g, '')
      .replace(/projectile_protection/g, '');

    for (const key of TRACKED_ENCHANTS) {
      if (key === 'blast_protection' || key === 'fire_protection' || key === 'projectile_protection') continue;
      if (!stripped.includes(key)) continue;
      const m = stripped.match(ENCHANT_REGEX_MAP[key]);
      if (m && Number(m[1]) > result[key]) {
        result[key] = Number(m[1]);
      } else if (result[key] === 0) {
        result[key] = 1;
      }
    }
  }

  Object.freeze(result);
  _parsedEnchantCache.set(item, result);
  return result;
}

/**
 * Returns the integer level (0 if absent) of `enchantName` on `item`.
 */
function getEnchantmentLevel(item, enchantName) {
  if (!item || !enchantName) return 0;
  const key = normalizeEnchantName(enchantName);
  const parsed = parseItemEnchantments(item);
  if (key in parsed) return parsed[key];
  const raw = getItemMetadataText(item);
  if (!raw || !raw.includes(key)) return 0;
  const m = raw.match(new RegExp(`${key}[^0-9]{0,24}(\\d+)`));
  return m ? (Number(m[1]) || 1) : 1;
}

/**
 * Extracts item durability info across MC 1.20.4 (`nbt.Damage`) and MC 1.20.5–1.21.11+
 * (`durabilityUsed`, Array/Object `components`, `componentMap`).
 */
function getItemDurabilityInfo(item, fallbackMax = 0) {
  if (!item || typeof item !== 'object') {
    return { valid: false, used: 0, remaining: 0, max: fallbackMax, ratio: 1 };
  }

  let used = 0;
  if (typeof item.durabilityUsed === 'number' && Number.isFinite(item.durabilityUsed)) {
    used = item.durabilityUsed;
  } else if (Array.isArray(item.components)) {
    for (const comp of item.components) {
      if (!comp || typeof comp !== 'object') continue;
      const type = normalizeEnchantName(comp.type || '');
      if (type === 'damage') {
        const val = Number(unwrapNbt(comp.data !== undefined ? comp.data : comp.value));
        if (Number.isFinite(val)) {
          used = val;
          break;
        }
      }
    }
  } else if (item.components && typeof item.components === 'object') {
    const rawDmg = item.components.damage !== undefined ? item.components.damage : item.components['minecraft:damage'];
    const val = Number(unwrapNbt(rawDmg));
    if (Number.isFinite(val)) used = val;
  } else if (item.componentMap instanceof Map) {
    const rawDmg = item.componentMap.get('damage') || item.componentMap.get('minecraft:damage');
    const val = Number(unwrapNbt(rawDmg));
    if (Number.isFinite(val)) used = val;
  } else if (item.nbt && typeof item.nbt === 'object') {
    const nbtVal = unwrapNbt(item.nbt);
    const dmg = nbtVal && nbtVal.Damage !== undefined ? Number(unwrapNbt(nbtVal.Damage)) : NaN;
    if (Number.isFinite(dmg)) used = dmg;
  }

  const max = (typeof item.maxDurability === 'number' && item.maxDurability > 0)
    ? item.maxDurability
    : fallbackMax;

  if (max <= 0) {
    return { valid: false, used: Math.max(0, used), remaining: 0, max: 0, ratio: 1 };
  }

  const remaining = Math.max(0, max - Math.max(0, used));
  return {
    valid: true,
    used: Math.max(0, used),
    remaining,
    max,
    ratio: remaining / max
  };
}

/**
 * Computes vanilla explosion EPF for a single armor piece:
 * Protection = 1 * level, Blast Protection = 2 * level.
 */
function getArmorBlastEPF(item) {
  if (!item) return 0;
  const ench = parseItemEnchantments(item);
  return (ench.protection || 0) + (ench.blast_protection || 0) * 2;
}

module.exports = {
  TRACKED_ENCHANTS,
  unwrapNbt,
  normalizeEnchantName,
  parseItemEnchantments,
  getEnchantmentLevel,
  getItemDurabilityInfo,
  getArmorBlastEPF
};
