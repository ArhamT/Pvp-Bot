'use strict';

const {
  getItemMetadataText,
  usesZeroBasedEffectIds,
  getStatusEffect
} = require('../constants');
const {
  DEFAULT_BUFF_DURATION_MS,
  VANILLA_POTION_ID_TO_KEY,
  ZERO_BASED_EFFECT_TO_KIND,
  ZERO_BASED_EFFECT_TO_CLASS,
  ONE_BASED_EFFECT_TO_KIND
} = require('./constants');

const _potionClassCache = new WeakMap();

function _unwrapVal(val) {
  let cur = val;
  while (cur && typeof cur === 'object' && 'value' in cur && !Array.isArray(cur)) {
    cur = cur.value;
  }
  return cur;
}

function _extractPotionMetadata(item) {
  const keys = [];
  const customEffects = []; // Array<{ id: number, amplifier: number }>

  const inspect = (obj, depth = 0) => {
    if (!obj || depth > 8) return;
    if (typeof obj === 'string') {
      keys.push(obj.toLowerCase());
      return;
    }
    if (Array.isArray(obj)) {
      for (const el of obj) inspect(el, depth + 1);
      return;
    }
    if (obj instanceof Map) {
      for (const [k, v] of obj.entries()) {
        if (String(k).includes('potion_contents') || String(k).includes('potion')) {
          inspect(v, depth + 1);
        }
      }
      return;
    }
    if (typeof obj !== 'object') return;

    if (obj.type === 'potion_contents' && obj.data) {
      inspect(obj.data, depth + 1);
      return;
    }
    if (obj.potionId !== undefined && typeof obj.potionId === 'number') {
      const mapped = VANILLA_POTION_ID_TO_KEY[obj.potionId];
      if (mapped) keys.push(mapped);
    }
    if (obj.potion !== undefined) {
      const p = _unwrapVal(obj.potion);
      if (typeof p === 'number' && VANILLA_POTION_ID_TO_KEY[p]) {
        keys.push(VANILLA_POTION_ID_TO_KEY[p]);
      } else if (typeof p === 'string') {
        keys.push(p.toLowerCase());
      }
    }
    if (obj.Potion !== undefined) {
      const p = _unwrapVal(obj.Potion);
      if (typeof p === 'string') keys.push(p.toLowerCase());
    }
    if (Array.isArray(obj.customEffects)) {
      for (const ce of obj.customEffects) {
        if (ce && typeof ce.id === 'number') {
          const amp = typeof ce.amplifier === 'number' ? ce.amplifier : 0;
          customEffects.push({ id: ce.id, amplifier: amp });
        }
      }
    }
    if (Array.isArray(obj.custom_effects)) {
      for (const ce of obj.custom_effects) {
        if (ce && typeof ce.id === 'number') {
          const amp = typeof ce.amplifier === 'number' ? ce.amplifier : 0;
          customEffects.push({ id: ce.id, amplifier: amp });
        }
      }
    }
    if (obj.value && typeof obj.value === 'object') {
      inspect(obj.value, depth + 1);
    }
    if (obj.data && typeof obj.data === 'object') {
      inspect(obj.data, depth + 1);
    }
  };

  if (item.components) inspect(item.components);
  if (item.componentMap) inspect(item.componentMap);
  if (item.nbt) inspect(item.nbt);
  if (item.customName) keys.push(String(item.customName).toLowerCase());

  return { keys, customEffects };
}

function _classifyPotionKey(key) {
  if (!key) return null;
  const k = String(key).toLowerCase().replace(/^minecraft:/, '');
  if (k.includes('harm') || k.includes('poison') || k.includes('weakness') || k.includes('slowness') || k.includes('wither') || k.includes('infest') || k.includes('oozing') || k.includes('weaving') || k.includes('wind_charged')) {
    return 'harmful';
  }
  if (k.includes('strong_healing') || k.includes('healing_ii') || k.includes('health ii')) {
    return 'heal2';
  }
  if (k.includes('healing') || k.includes('instant_health')) {
    return 'heal1';
  }
  if (k.includes('strength')) return 'strength';
  if (k.includes('swiftness') || k.includes('speed')) return 'swiftness';
  if (k.includes('fire_resistance') || k.includes('fire_res')) return 'fire_res';
  if (k.includes('regeneration') || k.includes('regen')) return 'regen';
  if (k.includes('turtle_master')) return 'turtle_master';
  if (k === 'water' || k === 'mundane' || k === 'thick' || k === 'awkward' || k.includes('water_breathing') || k.includes('night_vision') || k.includes('invisibility') || k.includes('slow_falling') || k.includes('leaping')) {
    return 'other';
  }
  return null;
}

/**
 * WeakMap-cached potion classifier (O(1) per item instance in 20-TPS loops).
 * Properly distinguishes Instant Health I (`heal1`) vs Instant Health II (`heal2`) by amplifier.
 */
function classifyPotionItem(item) {
  if (!item || typeof item !== 'object') return 'other';
  if (item.name !== 'splash_potion' && item.name !== 'potion' && item.name !== 'lingering_potion') {
    return 'other';
  }

  const cached = _potionClassCache.get(item);
  if (cached !== undefined) return cached;

  let result = 'other';
  const { keys, customEffects } = _extractPotionMetadata(item);

  for (const key of keys) {
    const cls = _classifyPotionKey(key);
    if (cls && cls !== 'other') {
      result = cls;
      break;
    }
  }

  if (result === 'other' && customEffects.length > 0) {
    for (const eff of customEffects) {
      if (eff.id === 5) {
        result = eff.amplifier >= 1 ? 'heal2' : 'heal1';
        break;
      }
      const mapped = ZERO_BASED_EFFECT_TO_CLASS[eff.id];
      if (mapped) {
        result = mapped;
        break;
      }
    }
  }

  if (result === 'other') {
    const raw = getItemMetadataText(item);
    if (raw) {
      const cls = _classifyPotionKey(raw);
      if (cls) result = cls;
    }
  }

  if (result === 'other' && item.name === 'splash_potion' && keys.length === 0 && customEffects.length === 0) {
    // Unknown splash potion with stripped metadata: treat conservatively as heal1 if not harmful
    const raw = getItemMetadataText(item);
    if (!raw || (!raw.includes('harm') && !raw.includes('poison') && !raw.includes('slow') && !raw.includes('weak'))) {
      result = 'unknown_splash';
    }
  } else if (result === 'other' && item.name === 'potion' && keys.length === 0 && customEffects.length === 0) {
    result = 'unknown_drink';
  }

  _potionClassCache.set(item, result);
  return result;
}

const BUFF_KIND_TO_EFFECT_KEY = {
  strength: 'strength',
  swiftness: 'speed',
  fire_res: 'fire_resistance',
  regen: 'regeneration',
  turtle_master: 'resistance'
};

const potionClassifierMethods = {
  _classifyPotion(item) {
    return classifyPotionItem(item);
  },

  _usesZeroBasedEffectIds() {
    return usesZeroBasedEffectIds(this.bot);
  },

  _mapEffectIdToKind(effectId) {
    const id = Number(effectId);
    if (!Number.isFinite(id)) return null;
    if (this.bot && this.bot.registry && this.bot.registry.effects && this.bot.registry.effects[id]) {
      const regName = String(this.bot.registry.effects[id].name || this.bot.registry.effects[id].displayName || '').toLowerCase();
      if (regName.includes('strength')) return 'strength';
      if (regName.includes('speed') || regName.includes('swiftness')) return 'swiftness';
      if (regName.includes('fire_res') || regName.includes('fireres')) return 'fire_res';
      if (regName.includes('regen')) return 'regen';
      if (regName.includes('resistance')) return 'turtle_master';
    }
    return this._usesZeroBasedEffectIds()
      ? (ZERO_BASED_EFFECT_TO_KIND[id] || null)
      : (ONE_BASED_EFFECT_TO_KIND[id] || null);
  },

  _handleEntityEffect(entity, effect) {
    if (!this.bot || !this.bot.entity || !entity || entity.id !== this.bot.entity.id || !effect) return;
    const kind = this._mapEffectIdToKind(effect.id);
    if (!kind) return;
    const durTicks = typeof effect.duration === 'number' && effect.duration > 0 ? effect.duration : 1600;
    const durMs = Math.max(2000, durTicks * 50 - 3000);
    this.activeBuffUntil.set(kind, Date.now() + durMs);
  },

  _handleEntityEffectEnd(entity, effect) {
    if (!this.bot || !this.bot.entity || !entity || entity.id !== this.bot.entity.id || !effect) return;
    const kind = this._mapEffectIdToKind(effect.id);
    if (kind) {
      this.activeBuffUntil.delete(kind);
    }
  },

  _handleClearBuffs() {
    this.activeBuffUntil.clear();
  },

  _markBuffApplied(kind) {
    if (!kind) return;
    const durMs = DEFAULT_BUFF_DURATION_MS[kind] || 60000;
    this.activeBuffUntil.set(kind, Date.now() + durMs);
  },

  /**
   * Checks whether buff `kind` is currently active.
   * Respects tracked `activeBuffUntil` expiration first (fixing stale Mineflayer `eff.duration`).
   */
  isBuffActive(kind) {
    if (!kind) return false;
    const now = Date.now();
    if (this.activeBuffUntil.has(kind)) {
      const until = this.activeBuffUntil.get(kind);
      if (until > now) return true;
      // Tracked timer expired: re-buff proactively instead of trusting static eff.duration
      return false;
    }

    const effKey = BUFF_KIND_TO_EFFECT_KEY[kind];
    if (effKey) {
      const eff = getStatusEffect(this.bot, effKey);
      if (eff) {
        const durTicks = typeof eff.duration === 'number' && eff.duration > 0 ? eff.duration : 1200;
        this.activeBuffUntil.set(kind, now + Math.max(2000, durTicks * 50 - 3000));
        return true;
      }
    }
    return false;
  },

  getPotionInventorySummary() {
    const summary = {
      heal2: 0,
      heal1: 0,
      strength: 0,
      swiftness: 0,
      fire_res: 0,
      regen: 0,
      turtle_master: 0,
      harmful: 0,
      other: 0
    };
    if (!this.bot || !this.bot.inventory || !Array.isArray(this.bot.inventory.slots)) return summary;
    for (const item of this.bot.inventory.slots) {
      if (!item || (item.name !== 'splash_potion' && item.name !== 'potion' && item.name !== 'lingering_potion')) {
        continue;
      }
      const cls = this._classifyPotion(item);
      if (cls in summary) summary[cls] += item.count || 1;
      else summary.other += item.count || 1;
    }
    return summary;
  }
};

module.exports = {
  classifyPotionItem,
  potionClassifierMethods
};
