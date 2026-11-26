'use strict';

const { Vec3 } = require('vec3');
const { clamp, normalizeAngle } = require('../aim');
const {
  HOTBAR_START,
  OFFHAND_SLOT,
  SWORD_PRIORITY,
  getItemMetadataText,
  hasItemEnchant
} = require('../constants');
const {
  BLAST_SHIELD_BLOCK_PRIORITY,
  isTargetInSurround,
  hasExistingCrystalAt,
  findFeetBlastShieldSpot,
  planHitCrystalTrajectory,
  planSurroundPressurePlacement
} = require('../cpvp_tactics');
const {
  HOTBAR_END,
  CRYSTAL_POWER,
  ANCHOR_POWER,
  COVER_BLOCK_PRIORITY,
  DEFENSE_BLOCK_PRIORITY,
  ARMOR_STATS,
  PLACEMENT_FACES,
  posKey,
  isAirLike,
  isCrystalEntity
} = require('./shared');

const burstDefenseMethods = {
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

    // 1. Structured item.enchants array
    if (Array.isArray(item.enchants)) {
      for (const e of item.enchants) {
        if (e) inspectEntry(e.name || e.id, e.lvl !== undefined ? e.lvl : e.level);
      }
    }

    // 2. 1.20.5+ item.components
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

    // 3. Legacy NBT fallback via cached metadata inspection (avoiding double-counting blast_protection)
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

    // Sample points across feet, lower torso, upper torso, and head
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

    // Lower Y-level comparison: feet situated below the blast origin receive strong vertical blast reduction
    const yDelta = blastPos.y - entityPos.y;
    if (yDelta > 0.25) {
      const lowerYMultiplier = clamp(1.0 - yDelta * 0.35, 0.35, 0.85);
      damage *= lowerYMultiplier;
    }

    // Apply armor defense, toughness, and Blast Protection / Protection EPF
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
  },

  _scanNearbyExplosiveThreats(target) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) return null;
    const botPos = this.bot.entity.position;
    const radius = this.burstCfg.antiExplosiveRadius || 4.5;

    // 1. Live End Crystal entities near bot's feet
    if (this.bot.entities) {
      let closestCrystal = null;
      let closestDist = Infinity;
      for (const entity of Object.values(this.bot.entities)) {
        if (!isCrystalEntity(entity) || !entity.position) continue;
        const cFloor = entity.position.floored();
        if (this._isOwnPlacement(cFloor) || this._isOwnPlacement(cFloor.offset(0, -1, 0))) continue;
        const d = botPos.distanceTo(entity.position);
        if (d <= radius && d < closestDist) {
          closestDist = d;
          closestCrystal = entity;
        }
      }
      if (closestCrystal) {
        return {
          type: 'end_crystal',
          entityId: closestCrystal.id,
          blockPos: closestCrystal.position.floored().offset(0, -1, 0),
          blastOrigin: closestCrystal.position.clone(),
          detectedAt: Date.now()
        };
      }
    }

    // 2. Nearby Respawn Anchors (and enemy-held crystal obsidian traps)
    if (typeof this.bot.blockAt === 'function') {
      const bx = Math.floor(botPos.x);
      const by = Math.floor(botPos.y);
      const bz = Math.floor(botPos.z);
      const rInt = Math.ceil(radius);

      const targetHoldingCrystal = Boolean(
        target &&
        target.isValid &&
        Array.isArray(target.equipment) &&
        target.equipment.some((eq) => eq && eq.name === 'end_crystal')
      );
      const targetHoldingGlowstone = Boolean(
        target &&
        target.isValid &&
        Array.isArray(target.equipment) &&
        target.equipment.some((eq) => eq && eq.name === 'glowstone')
      );

      let anchorThreat = null;
      let anchorDist = Infinity;
      let obsThreat = null;
      let obsDist = Infinity;

      for (let dx = -rInt; dx <= rInt; dx++) {
        for (let dy = -1; dy <= 2; dy++) {
          for (let dz = -rInt; dz <= rInt; dz++) {
            const pos = new Vec3(bx + dx, by + dy, bz + dz);
            const center = pos.offset(0.5, 0.5, 0.5);
            const dist = botPos.distanceTo(center);
            if (dist > radius) continue;
            if (this._isOwnPlacement(pos)) continue;

            const block = this.bot.blockAt(pos);
            if (!block) continue;

            if (block.name === 'respawn_anchor' && dist < anchorDist) {
              const charges = this._getAnchorCharges(block);
              // Ignore uncharged abandoned anchors unless opponent is actively holding glowstone
              if (charges < 1 && !targetHoldingGlowstone) continue;
              const cand = {
                type: 'respawn_anchor',
                blockPos: pos,
                blastOrigin: center,
                detectedAt: Date.now()
              };
              if (this._isDefendedThreat(cand)) continue;
              anchorDist = dist;
              anchorThreat = cand;
            } else if (targetHoldingCrystal && block.name === 'obsidian' && dist < obsDist) {
              const above = this.bot.blockAt(pos.offset(0, 1, 0));
              if (isAirLike(above)) {
                const cand = {
                  type: 'obsidian',
                  blockPos: pos,
                  blastOrigin: pos.offset(0.5, 1.0, 0.5),
                  detectedAt: Date.now()
                };
                if (this._isDefendedThreat(cand)) continue;
                obsDist = dist;
                obsThreat = cand;
              }
            }
          }
        }
      }

      if (anchorThreat) return anchorThreat;
      if (obsThreat) return obsThreat;
    }

    return null;
  },

  _isThreatStillValid(threat) {
    if (!threat || !this.bot || !this.bot.entity) return false;
    const radius = (this.burstCfg.antiExplosiveRadius || 4.5) + 0.75;
    if (this.bot.entity.position.distanceTo(threat.blastOrigin) > radius) return false;
    if ((Date.now() - threat.detectedAt) > 1500) return false;

    if (threat.type === 'end_crystal') {
      if (this.bot.entities && threat.entityId !== undefined) {
        const ent = this.bot.entities[threat.entityId];
        return Boolean(ent && ent.isValid);
      }
      return true;
    }

    if (typeof this.bot.blockAt === 'function' && threat.blockPos) {
      const b = this.bot.blockAt(threat.blockPos);
      if (!b || b.name !== threat.type) return false;
      if (threat.type === 'obsidian') {
        const above = this.bot.blockAt(threat.blockPos.offset(0, 1, 0));
        if (above && !isAirLike(above)) return false;
      }
    }
    return true;
  },

  _planDefensiveBlock(threat) {
    if (!threat || !this.bot || !this.bot.entity || typeof this.bot.blockAt !== 'function') return null;

    const blockRecord = this._findItem(DEFENSE_BLOCK_PRIORITY);
    if (!blockRecord) return null;

    const botPos = this.bot.entity.position;
    const eyePos = this.aimer ? this.aimer.getEyePosition() : botPos.offset(0, 1.62, 0);
    const toBlast = threat.blastOrigin.minus(botPos);
    const horizLen = Math.sqrt(toBlast.x * toBlast.x + toBlast.z * toBlast.z);

    const candidatePositions = [];

    // 1. Place blocking block directly between bot's feet and explosive origin
    if (horizLen >= 0.8) {
      const stepDist = Math.min(1.2, horizLen * 0.5);
      const midPos = new Vec3(
        Math.floor(botPos.x + (toBlast.x / horizLen) * stepDist),
        Math.floor(botPos.y),
        Math.floor(botPos.z + (toBlast.z / horizLen) * stepDist)
      );
      candidatePositions.push(midPos);
    }

    // 2. If threat is enemy obsidian (no crystal yet), block directly on top of the obsidian
    if (threat.type === 'obsidian' && threat.blockPos) {
      candidatePositions.push(threat.blockPos.offset(0, 1, 0));
    }

    for (const spot of candidatePositions) {
      if (eyePos.distanceTo(spot.offset(0.5, 0.5, 0.5)) > 4.5) continue;
      if (this._intersectsEntityHitbox(spot, botPos)) continue;
      const existing = this.bot.blockAt(spot);
      if (!isAirLike(existing)) continue;

      const ref = this._findPlacementRef(spot);
      if (ref) {
        return {
          blockRecord,
          placePos: spot,
          refPos: ref.refPos,
          face: ref.face,
          aimPos: ref.aimPos
        };
      }
    }

    return null;
  },

  /**
   * High-priority anti-crystal / anti-anchor defense tick.
   * Returns true if BurstModule is actively taking defensive action against an explosive threat.
   */
  tickDefense(target) {
    this._updateFallDistance();

    if (this.burstCfg.antiExplosiveEnabled === false || !this.bot || !this.bot.entity) {
      this._clearDefenseState();
      return false;
    }

    // Scan for live threats and merge with event-detected threats
    const scanned = this._scanNearbyExplosiveThreats(target);
    if (scanned) {
      this._registerThreat(scanned);
    }

    if (this.activeThreat && (this._isDefendedThreat(this.activeThreat) || !this._isThreatStillValid(this.activeThreat))) {
      this._clearDefenseState();
      return false;
    }

    if (!this.activeThreat) {
      this._clearDefenseState();
      return false;
    }

    // Do not interrupt our own active ANCHOR_* detonation sequence for non-crystal threats
    if (this.state.startsWith('ANCHOR_') && this.activeThreat.type !== 'end_crystal') {
      return false;
    }

    // High-priority defense preempts offensive bursts (but preserves lethal fall clutch)
    if (this.state !== 'IDLE' && this.state !== 'WIND_CLUTCH') {
      this._resetOffensiveState(false);
    }

    const threat = this.activeThreat;

    // Initialize defense plan if IDLE
    if (this.defenseState === 'IDLE') {
      const blockPlan = this._planDefensiveBlock(threat);
      if (blockPlan) {
        this.defenseState = 'DEFENSE_BLOCK';
        this.defensePlan = blockPlan;
        this.defenseTicksRemaining = 10;
      } else {
        this.defenseState = 'DEFENSE_SHIELD';
        this.defensePlan = null;
        this.defenseTicksRemaining = 6;
      }
    }

    this.defenseTicksRemaining--;
    if (this.defenseTicksRemaining < 0) {
      this._markDefendedThreat(threat, 2500);
      this._clearDefenseState();
      return false;
    }

    if (this.defenseState === 'DEFENSE_BLOCK' && this.defensePlan) {
      const plan = this.defensePlan;
      this.bot.setControlState('sprint', false);

      // Step 1: Smoothly aim at placement face & ensure blocking block is held (sequential across ticks)
      const aimStatus = this.aimer.stepTowardsPoint(plan.aimPos, {
        speedMultiplier: 1.4,
        toleranceRad: 0.18
      });

      const equipRes = this._ensureItemHeld(plan.blockRecord);
      if (!equipRes.found) {
        // Block ran out; fall back to crouch-shield
        this.defenseState = 'DEFENSE_SHIELD';
        this.defensePlan = null;
        return this._tickDefenseShield(threat);
      }

      // Anticheat safety: never swap + place in the same tick
      if (equipRes.swappedThisTick || !equipRes.held || !aimStatus.aligned) {
        return true;
      }

      const refBlock = this.bot.blockAt(plan.refPos);
      const targetAir = this.bot.blockAt(plan.placePos);
      if (refBlock && refBlock.boundingBox === 'block' && isAirLike(targetAir)) {
        this._markOwnPlacement(plan.placePos);
        if (typeof this.bot.placeBlock === 'function') {
          Promise.resolve(this.bot.placeBlock(refBlock, plan.face)).catch(() => {});
        }
      }

      // If threat was a live crystal or respawn anchor, follow up with brief crouch-shield
      if (threat.type === 'end_crystal' || threat.type === 'respawn_anchor') {
        this.defenseState = 'DEFENSE_SHIELD';
        this.defensePlan = null;
        this.defenseTicksRemaining = 5;
      } else {
        this._markDefendedThreat(threat, 2500);
        this._clearDefenseState();
      }
      return true;
    }

    return this._tickDefenseShield(threat);
  },

  _tickDefenseShield(threat) {
    this.bot.setControlState('sprint', false);
    this.bot.setControlState('sneak', true);

    this.aimer.stepTowardsPoint(threat.blastOrigin, {
      speedMultiplier: 1.4,
      toleranceRad: 0.16
    });

    const offhand = this._getOffhandItem();
    const hasShield = (offhand && offhand.name === 'shield') ||
      (this.bot.heldItem && this.bot.heldItem.name === 'shield');

    if (hasShield && !this.defenseShieldRaised && typeof this.bot.activateItem === 'function') {
      const useOffhand = Boolean(offhand && offhand.name === 'shield');
      this.bot.activateItem(useOffhand);
      this.defenseShieldRaised = true;
    }

    if (this.defenseTicksRemaining <= 0) {
      this._markDefendedThreat(threat, 2500);
      this._clearDefenseState();
    }
    return true;
  }
};

module.exports = { burstDefenseMethods };
