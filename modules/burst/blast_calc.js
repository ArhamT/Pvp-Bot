'use strict';

const { Vec3 } = require('vec3');
const { clamp } = require('../aim');
const { getStatusEffectAmplifier } = require('../constants');
const { getArmorBlastEPF } = require('../enchant_utils');
const { CRYSTAL_POWER, ARMOR_STATS, posKey } = require('./shared');

/**
 * Optimized Explosion Physics & Blast Damage Calculator (`modules/burst/blast_calc.js`):
 * - Uses WeakMap-cached `enchant_utils.getArmorBlastEPF`
 * - Caches per-entity armor/EPF/Resistance stats per physics tick
 * - Zero `new Vec3` per-step allocations inside `_isRayOccluded`
 * - Accurately models Resistance effect (-20%/lvl) & pure raycast exposure
 */
const blastCalcMethods = {
  _getArmorItems(entity) {
    const items = [];
    if (!entity) return items;

    const isBotEntity = this.bot && this.bot.entity && (
      entity === this.bot.entity ||
      (entity.id !== undefined && entity.id === this.bot.entity.id)
    );

    if (isBotEntity && this.bot.inventory && this.bot.inventory.slots) {
      for (const slot of [5, 6, 7, 8]) {
        const piece = this.bot.inventory.slots[slot];
        if (piece && piece.name && ARMOR_STATS[piece.name]) {
          items.push(piece);
        }
      }
      if (items.length > 0) return items;
    }

    if (Array.isArray(entity.equipment)) {
      for (const piece of entity.equipment) {
        if (piece && piece.name && ARMOR_STATS[piece.name]) {
          items.push(piece);
        }
      }
    }

    return items;
  },

  _extractArmorBlastEPF(item) {
    return getArmorBlastEPF(item);
  },

  _getCachedEntityDefense(entity) {
    if (!entity) return { armorPoints: 0, armorToughness: 0, totalEPF: 0, resistanceMult: 1.0 };
    const now = Date.now();
    if (!this._entityDefenseCache) {
      this._entityDefenseCache = new Map();
      this._entityDefenseCacheAt = 0;
    }
    if ((now - this._entityDefenseCacheAt) > 45) {
      this._entityDefenseCache.clear();
      this._entityDefenseCacheAt = now;
    }

    const key = entity.id !== undefined ? entity.id : (entity.username || 'self');
    const cached = this._entityDefenseCache.get(key);
    if (cached) return cached;

    const armorItems = this._getArmorItems(entity);
    let armorPoints = 0;
    let armorToughness = 0;
    let totalEPF = 0;

    for (let i = 0; i < armorItems.length; i++) {
      const piece = armorItems[i];
      const stats = ARMOR_STATS[piece.name];
      if (stats) {
        armorPoints += stats.armor;
        armorToughness += stats.toughness;
      }
      totalEPF += getArmorBlastEPF(piece);
    }

    // Factor Minecraft Resistance status effect (-20% per level, e.g., Enchanted Gapple / Turtle Master)
    const resAmp = getStatusEffectAmplifier(this.bot, 'resistance', entity);
    const resistanceMult = resAmp >= 0 ? Math.max(0, 1.0 - (resAmp + 1) * 0.2) : 1.0;

    const result = { armorPoints, armorToughness, totalEPF, resistanceMult };
    this._entityDefenseCache.set(key, result);
    return result;
  },

  _isRayOccluded(fromPos, toPos, virtualSolidKeys = null) {
    if (!this.bot || typeof this.bot.blockAt !== 'function') return false;

    const dx = toPos.x - fromPos.x;
    const dy = toPos.y - fromPos.y;
    const dz = toPos.z - fromPos.z;
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (length < 0.2) return false;

    const stepSize = 0.25;
    const steps = Math.floor(length / stepSize);
    const ox = Math.floor(fromPos.x);
    const oy = Math.floor(fromPos.y);
    const oz = Math.floor(fromPos.z);
    const ex = Math.floor(toPos.x);
    const ey = Math.floor(toPos.y);
    const ez = Math.floor(toPos.z);

    const probe = this._rayProbeVec || (this._rayProbeVec = new Vec3(0, 0, 0));
    let lastBx = ox;
    let lastBy = oy;
    let lastBz = oz;

    for (let i = 1; i < steps; i++) {
      const t = (i * stepSize) / length;
      const bx = Math.floor(fromPos.x + dx * t);
      const by = Math.floor(fromPos.y + dy * t);
      const bz = Math.floor(fromPos.z + dz * t);

      if (bx === lastBx && by === lastBy && bz === lastBz) continue;
      lastBx = bx;
      lastBy = by;
      lastBz = bz;

      if ((bx === ox && by === oy && bz === oz) || (bx === ex && by === ey && bz === ez)) continue;

      if (virtualSolidKeys) {
        const key = `${bx},${by},${bz}`;
        if (typeof virtualSolidKeys === 'string' && key === virtualSolidKeys) return true;
        if (typeof virtualSolidKeys.has === 'function' && virtualSolidKeys.has(key)) return true;
      }

      probe.x = bx;
      probe.y = by;
      probe.z = bz;
      const block = this.bot.blockAt(probe);
      if (block && block.boundingBox === 'block') {
        return true;
      }
    }
    return false;
  },

  /**
   * Estimates vanilla Minecraft explosion damage from `blastPos` to an entity at `entityPos`, factoring:
   * - Euclidean distance vs explosion diameter (`power * 2`)
   * - Multi-point raycast block occlusion between blast center and entity feet/torso/head
   * - Worn armor defense points, armor toughness, Protection/Blast Protection EPF, and Resistance effect
   */
  estimateBlastDamage(blastPos, entityPos, entity = null, power = CRYSTAL_POWER, virtualSolidPos = null) {
    if (!blastPos || !entityPos) return 0;

    const doubleRadius = power * 2.0;
    const dx = blastPos.x - entityPos.x;
    const dy = blastPos.y - entityPos.y;
    const dz = blastPos.z - entityPos.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq >= doubleRadius * doubleRadius) return 0;
    const dist = Math.sqrt(distSq);

    const height = (entity && entity.height) || 1.8;
    const halfW = 0.25;
    let virtualSolidKeys = null;
    if (Array.isArray(virtualSolidPos)) {
      const set = new Set();
      for (const v of virtualSolidPos) {
        if (v) set.add(posKey(v));
      }
      if (set.size > 0) virtualSolidKeys = set;
    } else if (virtualSolidPos) {
      virtualSolidKeys = posKey(virtualSolidPos);
    }

    const pt = this._samplePtVec || (this._samplePtVec = new Vec3(0, 0, 0));
    const offsets = [
      [0, 0.1, 0],
      [halfW, 0.15, 0],
      [-halfW, 0.15, 0],
      [0, 0.15, halfW],
      [0, 0.15, -halfW],
      [0, height * 0.45, 0],
      [0, height * 0.72, 0],
      [0, height * 0.92, 0]
    ];

    let visibleCount = 0;
    for (let i = 0; i < offsets.length; i++) {
      pt.x = entityPos.x + offsets[i][0];
      pt.y = entityPos.y + offsets[i][1];
      pt.z = entityPos.z + offsets[i][2];
      if (!this._isRayOccluded(blastPos, pt, virtualSolidKeys)) {
        visibleCount++;
      }
    }

    const exposure = visibleCount / offsets.length;
    if (exposure <= 0) return 0;

    const impact = (1.0 - dist / doubleRadius) * exposure;
    let damage = ((impact * impact + impact) / 2.0) * 7.0 * doubleRadius + 1.0;

    const def = this._getCachedEntityDefense(entity);

    if (def.armorPoints > 0) {
      const effectiveArmor = clamp(
        def.armorPoints - damage / (2.0 + def.armorToughness / 4.0),
        def.armorPoints / 5.0,
        20.0
      );
      damage *= 1.0 - effectiveArmor / 25.0;
    }

    if (def.resistanceMult < 1.0) {
      damage *= def.resistanceMult;
    }

    if (def.totalEPF > 0) {
      const clampedEPF = Math.min(20, def.totalEPF);
      damage *= 1.0 - clampedEPF * 0.04;
    }

    return Math.max(0, damage);
  }
};

module.exports = { blastCalcMethods };
