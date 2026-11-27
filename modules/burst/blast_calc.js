'use strict';

const { Vec3 } = require('vec3');
const { clamp } = require('../aim');
const { getItemMetadataText } = require('../constants');
const { CRYSTAL_POWER, ARMOR_STATS, posKey } = require('./shared');

/**
 * Explosion Physics & Blast Damage Calculator (`modules/burst/blast_calc.js`):
 * Shared by Crystal, Hit-Crystal, Anchor, Surround Pressure, and Anti-Explosive Defense.
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
    if (!item) return 0;
    let blastProt = 0;
    let genericProt = 0;

    const inspectEntry = (nameRaw, lvlRaw) => {
      const name = String(nameRaw || '').toLowerCase();
      const lvl = Math.max(0, Math.min(5, Number(lvlRaw) || 0));
      if (!lvl) return;
      if (name.includes('blast_protection')) {
        blastProt = Math.max(blastProt, lvl);
      } else if (
        name === 'protection' ||
        name === 'minecraft:protection' ||
        (name.endsWith(':protection') && !name.includes('blast') && !name.includes('fire') && !name.includes('projectile'))
      ) {
        genericProt = Math.max(genericProt, lvl);
      }
    };

    if (Array.isArray(item.enchants)) {
      for (const e of item.enchants) {
        if (e) inspectEntry(e.name || e.id, e.lvl !== undefined ? e.lvl : e.level);
      }
    }

    if (Array.isArray(item.components)) {
      for (const comp of item.components) {
        if (!comp) continue;
        const type = String(comp.type || '').toLowerCase();
        if (type.includes('enchantment')) {
          const data = comp.data || comp.value || comp;
          const list = data && (data.enchantments || data.levels || data);
          if (Array.isArray(list)) {
            for (const e of list) {
              if (e) inspectEntry(e.name || e.id, e.lvl !== undefined ? e.lvl : e.level);
            }
          } else if (list && typeof list === 'object') {
            for (const [k, v] of Object.entries(list)) {
              inspectEntry(k, v);
            }
          }
        }
      }
    } else if (item.components && typeof item.components === 'object') {
      const enchObj = item.components.enchantments || item.components['minecraft:enchantments'];
      const levels = enchObj && (enchObj.levels || enchObj);
      if (levels && typeof levels === 'object') {
        for (const [k, v] of Object.entries(levels)) {
          inspectEntry(k, v);
        }
      }
    }

    if (blastProt === 0 && genericProt === 0 && (item.nbt || item.components)) {
      const raw = getItemMetadataText(item);
      const blastMatch = raw.match(/blast_protection[^0-9]{0,24}(\d+)/);
      if (blastMatch) {
        blastProt = Math.min(5, parseInt(blastMatch[1], 10));
      }
      const stripped = raw.replace(/blast_protection/g, '').replace(/fire_protection/g, '').replace(/projectile_protection/g, '');
      const protMatch = stripped.match(/protection[^0-9]{0,24}(\d+)/);
      if (protMatch) {
        genericProt = Math.min(5, parseInt(protMatch[1], 10));
      }
    }

    return blastProt * 2 + genericProt;
  },

  _isRayOccluded(fromPos, toPos, virtualSolidKeys = null) {
    if (!this.bot || typeof this.bot.blockAt !== 'function') return false;

    const delta = toPos.minus(fromPos);
    const length = delta.norm();
    if (length < 0.2) return false;

    const stepSize = 0.25;
    const steps = Math.floor(length / stepSize);
    const originVoxel = posKey(fromPos);
    const destVoxel = posKey(toPos);

    for (let i = 1; i < steps; i++) {
      const t = (i * stepSize) / length;
      const sample = new Vec3(
        fromPos.x + delta.x * t,
        fromPos.y + delta.y * t,
        fromPos.z + delta.z * t
      );
      const key = posKey(sample);
      if (key === originVoxel || key === destVoxel) continue;
      if (virtualSolidKeys) {
        if (typeof virtualSolidKeys === 'string' && key === virtualSolidKeys) return true;
        if (typeof virtualSolidKeys.has === 'function' && virtualSolidKeys.has(key)) return true;
      }

      const block = this.bot.blockAt(sample);
      if (block && block.boundingBox === 'block') {
        return true;
      }
    }
    return false;
  },

  /**
   * Estimates Minecraft explosion damage from `blastPos` to an entity at `entityPos`, factoring:
   * - Euclidean distance vs explosion diameter (`power * 2`)
   * - Multi-point raycast block occlusion between blast center and entity feet/torso/head
   * - Lower Y-level blast reduction (feet below blast plane take substantially less damage)
   * - Worn armor defense points, armor toughness, and Blast Protection / Protection EPF
   */
  estimateBlastDamage(blastPos, entityPos, entity = null, power = CRYSTAL_POWER, virtualSolidPos = null) {
    if (!blastPos || !entityPos) return 0;

    const doubleRadius = power * 2.0;
    const dist = blastPos.distanceTo(entityPos);
    if (dist >= doubleRadius) return 0;

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

    const samplePoints = [
      entityPos.offset(0, 0.1, 0),
      entityPos.offset(halfW, 0.15, 0),
      entityPos.offset(-halfW, 0.15, 0),
      entityPos.offset(0, 0.15, halfW),
      entityPos.offset(0, 0.15, -halfW),
      entityPos.offset(0, height * 0.45, 0),
      entityPos.offset(0, height * 0.72, 0),
      entityPos.offset(0, height * 0.92, 0)
    ];

    let visibleCount = 0;
    for (const pt of samplePoints) {
      if (!this._isRayOccluded(blastPos, pt, virtualSolidKeys)) {
        visibleCount++;
      }
    }

    const exposure = visibleCount / samplePoints.length;
    if (exposure <= 0) return 0;

    const impact = (1.0 - dist / doubleRadius) * exposure;
    let damage = ((impact * impact + impact) / 2.0) * 7.0 * doubleRadius + 1.0;

    const yDelta = blastPos.y - entityPos.y;
    if (yDelta > 0.25) {
      const lowerYMultiplier = clamp(1.0 - yDelta * 0.35, 0.35, 0.85);
      damage *= lowerYMultiplier;
    }

    const armorItems = this._getArmorItems(entity);
    let armorPoints = 0;
    let armorToughness = 0;
    let totalEPF = 0;

    for (const piece of armorItems) {
      const stats = ARMOR_STATS[piece.name];
      if (stats) {
        armorPoints += stats.armor;
        armorToughness += stats.toughness;
      }
      totalEPF += this._extractArmorBlastEPF(piece);
    }

    if (armorPoints > 0) {
      const effectiveArmor = clamp(
        armorPoints - damage / (2.0 + armorToughness / 4.0),
        armorPoints / 5.0,
        20.0
      );
      damage *= 1.0 - effectiveArmor / 25.0;
    }

    if (totalEPF > 0) {
      const clampedEPF = Math.min(20, totalEPF);
      damage *= 1.0 - clampedEPF * 0.04;
    }

    return Math.max(0, damage);
  }
};

module.exports = { blastCalcMethods };
