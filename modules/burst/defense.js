'use strict';

const { Vec3 } = require('vec3');
const { canSeeBlockFace } = require('../placement_los');
const {
  DEFENSE_BLOCK_PRIORITY,
  posKey,
  isAirLike,
  isCrystalEntity
} = require('./shared');

/**
 * Dedicated Anti-Crystal & Anti-Anchor Defense Module (`modules/burst/defense.js`):
 * - Event-driven (`blockUpdate` + `entitySpawn`) + throttled fallback scan (eliminates 9,680 blockAt/sec!)
 * - Places SOLID feet blast-shield blocks (NEVER cobweb!)
 * - Delegates shield raising to `survival.requestShield(...)` when attached (synced shield state!)
 */
const burstDefenseMethods = {
  _markOwnPlacement(pos, ttlMs = 2500) {
    if (!pos) return;
    const now = Date.now();
    this.ownPlacements.set(posKey(pos), now + ttlMs);
    if (this.ownPlacements.size > 48) {
      for (const [k, exp] of this.ownPlacements.entries()) {
        if (exp < now) this.ownPlacements.delete(k);
      }
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

    // For obsidian, only preempt if dangerously close to our feet (<= 3.5b) and air above it
    if (name === 'obsidian') {
      if (dist > Math.min(3.5, radius) || yDiff > 1.8) return;
      if (typeof this.bot.blockAt === 'function') {
        const above = this.bot.blockAt(newBlock.position.offset(0, 1, 0));
        if (!isAirLike(above)) return;
      }
    }

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
    if (this.defendedThreats.size > 48) {
      for (const [k, exp] of this.defendedThreats.entries()) {
        if (exp <= now) this.defendedThreats.delete(k);
      }
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
    const now = Date.now();
    const botPos = this.bot.entity.position;
    const radius = this.burstCfg.antiExplosiveRadius || 4.5;
    const radiusSq = radius * radius;

    // 1. Live End Crystal entities near bot's feet (cheap entity loop every tick)
    if (this.bot.entities) {
      let closestCrystal = null;
      let closestDistSq = Infinity;
      for (const entity of Object.values(this.bot.entities)) {
        if (!isCrystalEntity(entity) || !entity.position) continue;
        const dSq = botPos.distanceSquared(entity.position);
        if (dSq > radiusSq || dSq >= closestDistSq) continue;
        const cFloor = entity.position.floored();
        if (this._isOwnPlacement(cFloor) || this._isOwnPlacement(cFloor.offset(0, -1, 0))) continue;
        closestDistSq = dSq;
        closestCrystal = entity;
      }
      if (closestCrystal) {
        return {
          type: 'end_crystal',
          entityId: closestCrystal.id,
          blockPos: closestCrystal.position.floored().offset(0, -1, 0),
          blastOrigin: closestCrystal.position.clone(),
          detectedAt: now
        };
      }
    }

    // 2. Throttle 3D block scan to every 200ms (blockUpdate catches fresh anchors/obsidian instantly!)
    if ((now - (this._lastThreatBlockScanAt || 0)) < 200) {
      return null;
    }
    // Skip block scan completely if no target within 10 blocks
    if (target && target.position && botPos.distanceSquared(target.position) > 100.0) {
      return null;
    }
    this._lastThreatBlockScanAt = now;

    if (typeof this.bot.blockAt === 'function') {
      const bx = Math.floor(botPos.x);
      const by = Math.floor(botPos.y);
      const bz = Math.floor(botPos.z);
      const rInt = Math.ceil(radius);

      const targetEq = (target && target.isValid && Array.isArray(target.equipment)) ? target.equipment : [];
      const targetHoldingCrystal = targetEq.some((eq) => eq && eq.name === 'end_crystal');
      const targetHoldingGlowstone = targetEq.some((eq) => eq && eq.name === 'glowstone');

      let anchorThreat = null;
      let anchorDistSq = Infinity;
      let obsThreat = null;
      let obsDistSq = Infinity;
      const probe = new Vec3(0, 0, 0);

      for (let dx = -rInt; dx <= rInt; dx++) {
        const x = bx + dx;
        const ddx = (x + 0.5) - botPos.x;
        for (let dy = -1; dy <= 2; dy++) {
          const y = by + dy;
          const ddy = (y + 0.5) - botPos.y;
          for (let dz = -rInt; dz <= rInt; dz++) {
            const z = bz + dz;
            const ddz = (z + 0.5) - botPos.z;
            const distSq = ddx * ddx + ddy * ddy + ddz * ddz;
            if (distSq > radiusSq) continue;

            probe.x = x;
            probe.y = y;
            probe.z = z;
            if (this._isOwnPlacement(probe)) continue;

            const block = this.bot.blockAt(probe);
            if (!block) continue;

            if (block.name === 'respawn_anchor' && distSq < anchorDistSq) {
              const charges = this._getAnchorCharges(block);
              if (charges < 1 && !targetHoldingGlowstone) continue;
              const pos = new Vec3(x, y, z);
              const cand = {
                type: 'respawn_anchor',
                blockPos: pos,
                blastOrigin: new Vec3(x + 0.5, y + 0.5, z + 0.5),
                detectedAt: now
              };
              if (this._isDefendedThreat(cand)) continue;
              anchorDistSq = distSq;
              anchorThreat = cand;
            } else if (targetHoldingCrystal && block.name === 'obsidian' && distSq < obsDistSq && distSq <= 3.5 * 3.5) {
              const above = this.bot.blockAt(new Vec3(x, y + 1, z));
              if (isAirLike(above)) {
                const pos = new Vec3(x, y, z);
                const cand = {
                  type: 'obsidian',
                  blockPos: pos,
                  blastOrigin: new Vec3(x + 0.5, y + 1.0, z + 0.5),
                  detectedAt: now
                };
                if (this._isDefendedThreat(cand)) continue;
                obsDistSq = distSq;
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
    if (horizLen >= 0.8) {
      const stepDist = Math.min(1.2, horizLen * 0.5);
      const midPos = new Vec3(
        Math.floor(botPos.x + (toBlast.x / horizLen) * stepDist),
        Math.floor(botPos.y),
        Math.floor(botPos.z + (toBlast.z / horizLen) * stepDist)
      );
      candidatePositions.push(midPos);
    }

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

  tickDefense(target) {
    if (this.burstCfg.antiExplosiveEnabled === false || !this.bot || !this.bot.entity) {
      this._clearDefenseState();
      return false;
    }

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

    if (this.state.startsWith('ANCHOR_') && this.activeThreat.type !== 'end_crystal') {
      return false;
    }

    if (this.state !== 'IDLE') {
      this._resetOffensiveState(false);
    }

    const threat = this.activeThreat;

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
      if (typeof this.bot.setControlState === 'function') {
        this.bot.setControlState('sprint', false);
      }

      const aimStatus = this.aimer.stepTowardsPoint(plan.aimPos, {
        speedMultiplier: 1.5,
        toleranceRad: 0.18
      });

      const equipRes = this._ensureItemHeld(plan.blockRecord);
      if (!equipRes.found) {
        this.defenseState = 'DEFENSE_SHIELD';
        this.defensePlan = null;
        return this._tickDefenseShield(threat);
      }

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
    if (typeof this.bot.setControlState === 'function') {
      this.bot.setControlState('sprint', false);
      this.bot.setControlState('sneak', true);
    }

    this.aimer.stepTowardsPoint(threat.blastOrigin, {
      speedMultiplier: 1.5,
      toleranceRad: 0.16
    });

    // Delegate shield control to SurvivalModule when attached so shield state & cooldown stay in sync!
    if (this.survival && typeof this.survival.requestShield === 'function') {
      this.survival.requestShield('burst_defense', Math.max(2, this.defenseTicksRemaining));
    } else {
      const offhand = this._getOffhandItem();
      const hasShield = (offhand && offhand.name === 'shield') ||
        (this.bot.heldItem && this.bot.heldItem.name === 'shield');
      if (hasShield && !this.defenseShieldRaised && typeof this.bot.activateItem === 'function') {
        const useOffhand = Boolean(offhand && offhand.name === 'shield');
        this.bot.activateItem(useOffhand);
        this.defenseShieldRaised = true;
      }
    }

    if (this.defenseTicksRemaining <= 0) {
      this._markDefendedThreat(threat, 2500);
      this._clearDefenseState();
    }
    return true;
  }
};

module.exports = { burstDefenseMethods };
