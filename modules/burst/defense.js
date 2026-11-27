'use strict';

const { Vec3 } = require('vec3');
const { canSeeBlockFace } = require('../placement_los');
const {
  CRYSTAL_POWER,
  DEFENSE_BLOCK_PRIORITY,
  posKey,
  isAirLike,
  isCrystalEntity
} = require('./shared');

/**
 * Dedicated Anti-Crystal & Anti-Anchor Defense Module (`modules/burst/defense.js`):
 * Tracks enemy explosive placements (`obsidian`, `respawn_anchor`, `end_crystal`),
 * places feet blast-shield cover blocks (`DEFENSE_BLOCK`), or raises shield (`DEFENSE_SHIELD`).
 */
const burstDefenseMethods = {
  _markOwnPlacement(pos, ttlMs = 2500) {
    if (!pos) return;
    const now = Date.now();
    this.ownPlacements.set(posKey(pos), now + ttlMs);
    for (const [k, exp] of this.ownPlacements.entries()) {
      if (exp < now) this.ownPlacements.delete(k);
    }
  },

  _isOwnPlacement(pos) {
    if (!pos) return false;
    const key = posKey(pos);
    const exp = this.ownPlacements.get(key);
    if (!exp) return false;
    if (Date.now() > exp) {
      this.ownPlacements.delete(key);
      return false;
    }
    return true;
  },

  _handleBlockUpdate(oldBlock, newBlock) {
    if (this.burstCfg.antiExplosiveEnabled === false) return;
    if (!newBlock || !newBlock.position || !this.bot || !this.bot.entity || !this.bot.entity.position) return;

    const name = newBlock.name;
    if (name !== 'obsidian' && name !== 'respawn_anchor') return;
    if (oldBlock && oldBlock.name === name) return;
    if (this._isOwnPlacement(newBlock.position)) return;

    const radius = this.burstCfg.antiExplosiveRadius || 4.5;
    const botPos = this.bot.entity.position;
    const blockCenter = newBlock.position.offset(0.5, 0.5, 0.5);
    const dist = botPos.distanceTo(blockCenter);
    const yDiff = Math.abs(newBlock.position.y - botPos.y);

    if (dist <= radius && yDiff <= 2.5) {
      const blastOrigin = name === 'obsidian'
        ? newBlock.position.offset(0.5, 1.0, 0.5)
        : newBlock.position.offset(0.5, 0.5, 0.5);
      this._registerThreat({
        type: name,
        blockPos: newBlock.position.clone(),
        blastOrigin,
        detectedAt: Date.now()
      });
    }
  },

  _handleEntitySpawn(entity) {
    if (!isCrystalEntity(entity) || !entity.position || !this.bot || !this.bot.entity) return;

    if (
      this.activePlan &&
      this.activePlan.kind === 'crystal' &&
      this.activePlan.blastPos &&
      (this.state === 'CRYSTAL_DETONATE' || this.state === 'CRYSTAL_PLACE_CRYSTAL') &&
      entity.position.distanceTo(this.activePlan.blastPos) <= 2.5
    ) {
      this.activePlan.spawnedCrystal = entity;
      this.stepDelayTicks = 0;
      return;
    }

    if (this.burstCfg.antiExplosiveEnabled === false) return;

    const crystalFloor = entity.position.floored();
    if (this._isOwnPlacement(crystalFloor) || this._isOwnPlacement(crystalFloor.offset(0, -1, 0))) {
      return;
    }

    const radius = this.burstCfg.antiExplosiveRadius || 4.5;
    const dist = this.bot.entity.position.distanceTo(entity.position);
    if (dist <= radius) {
      this._registerThreat({
        type: 'end_crystal',
        entityId: entity.id,
        blockPos: crystalFloor.offset(0, -1, 0),
        blastOrigin: entity.position.clone(),
        detectedAt: Date.now()
      });
    }
  },

  _registerThreat(threat) {
    const priority = (t) => {
      if (!t) return 0;
      if (t.type === 'end_crystal') return 3;
      if (t.type === 'respawn_anchor') return 2;
      return 1;
    };

    if (!this.activeThreat || priority(threat) >= priority(this.activeThreat)) {
      this.activeThreat = threat;
      if (this.defenseState === 'IDLE') {
        this.defensePlan = null;
      }
    }
  },

  _threatKey(threat) {
    if (!threat) return '';
    const ref = threat.blockPos || threat.blastOrigin;
    return ref ? `${threat.type}:${posKey(ref)}` : `${threat.type}`;
  },

  _markDefendedThreat(threat, ttlMs = 2500) {
    const key = this._threatKey(threat);
    if (!key) return;
    const now = Date.now();
    this.defendedThreats.set(key, now + ttlMs);
    for (const [k, exp] of this.defendedThreats.entries()) {
      if (exp <= now) this.defendedThreats.delete(k);
    }
  },

  _isDefendedThreat(threat) {
    const key = this._threatKey(threat);
    if (!key) return false;
    const exp = this.defendedThreats.get(key);
    if (!exp) return false;
    if (Date.now() > exp) {
      this.defendedThreats.delete(key);
      return false;
    }
    return true;
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
      if (
        refBlock &&
        refBlock.boundingBox === 'block' &&
        isAirLike(targetAir) &&
        canSeeBlockFace(this.bot, refBlock.position, plan.face, { aimer: this.aimer })
      ) {
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
