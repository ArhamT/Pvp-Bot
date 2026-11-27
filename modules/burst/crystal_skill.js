'use strict';

const { Vec3 } = require('vec3');
const { canSeeBlockFace } = require('../placement_los');
const { findFeetBlastShieldSpot } = require('./cpvp_footwork');
const { collectCrystalPositions, hasExistingCrystalAt } = require('./surround_city');
const {
  CRYSTAL_POWER,
  isAirLike,
  isCrystalEntity
} = require('./shared');

const crystalSkillMethods = {
  /**
   * Scans nearby End Crystal entities for an immediate advantageous detonation (CPvP instant pop).
   */
  _findExistingPoppableCrystal(target, predictedFeet) {
    if (!this.bot || !this.bot.entities || !this.bot.entity) return null;
    const botPos = this.bot.entity.position;
    const eyePos = this.aimer ? this.aimer.getEyePosition() : botPos.offset(0, 1.62, 0);
    const minSafeHp = 6;
    let bestPlan = null;
    let bestScore = 0;

    for (const entity of Object.values(this.bot.entities)) {
      if (!isCrystalEntity(entity) || !entity.position) continue;
      if (eyePos.distanceTo(entity.position.offset(0, 0.5, 0)) > 4.6) continue;
      if (entity.position.distanceTo(predictedFeet) > 5.5) continue;

      const targetDmg = this.estimateBlastDamage(entity.position, predictedFeet, target, CRYSTAL_POWER);
      const rawSelfDmg = this.estimateBlastDamage(entity.position, botPos, this.bot.entity, CRYSTAL_POWER);
      const feetShield = findFeetBlastShieldSpot(this, entity.position, null);
      const coverSpot = feetShield.spot;
      const effectiveSelfDmg = coverSpot
        ? this.estimateBlastDamage(entity.position, botPos, this.bot.entity, CRYSTAL_POWER, coverSpot.placePos)
        : rawSelfDmg;

      if (targetDmg < 4.0) continue;
      if (targetDmg <= effectiveSelfDmg) continue;
      if ((this.bot.health - effectiveSelfDmg) <= minSafeHp) continue;

      const score = targetDmg - effectiveSelfDmg * 1.25;
      if (score > bestScore) {
        bestScore = score;
        bestPlan = { entity, coverSpot };
      }
    }
    return bestPlan;
  },

  _findBestCrystalPlacement(target, predictedFeet) {
    if (this.burstCfg.crystalEnabled === false) return null;
    const now = Date.now();
    const crystalCd = this.burstCfg.crystalCooldownMs !== undefined ? this.burstCfg.crystalCooldownMs : 50;
    if ((now - this.lastCrystalTime) < crystalCd) return null;

    const crystalItem = this._findItem('end_crystal');
    if (!crystalItem) return null;
    if (!this.bot || typeof this.bot.blockAt !== 'function') return null;

    const botPos = this.bot.entity.position;
    const maxCrystalRange = this.burstCfg.crystalMaxRange || 4.5;
    if (botPos.distanceTo(target.position) > maxCrystalRange) return null;

    const obsidianItem = this._findItem('obsidian');
    const scanRadius = this.burstCfg.scanRadius || 4.5;
    const scanRadiusSq = scanRadius * scanRadius;
    const rInt = Math.ceil(scanRadius);
    const eyePos = this.aimer ? this.aimer.getEyePosition() : botPos.offset(0, 1.62, 0);
    const minSafeHp = this._isHoldingOffhandTotem() ? 4 : 6;
    const lowTargetHp = Boolean(
      this._isInTotemPunishWindow() ||
      (typeof target.health === 'number' && target.health <= 6)
    );
    const minTargetDmg = lowTargetHp ? 2.2 : 4.0;

    // Pre-collect all live crystal positions once (eliminates N*M entity scan inside 3D loop!)
    const liveCrystals = collectCrystalPositions(this.bot);

    const cx = Math.floor(predictedFeet.x);
    const cy = Math.floor(predictedFeet.y);
    const cz = Math.floor(predictedFeet.z);

    let best = null;

    for (let dx = -rInt; dx <= rInt; dx++) {
      const bx = cx + dx;
      const ddxT = (bx + 0.5) - predictedFeet.x;
      const ddxE = (bx + 0.5) - eyePos.x;
      for (let dy = -2; dy <= 1; dy++) {
        const by = cy + dy;
        const ddyT = (by + 1.0) - predictedFeet.y;
        const ddyE = (by + 0.8) - eyePos.y;
        for (let dz = -rInt; dz <= rInt; dz++) {
          const bz = cz + dz;
          const ddzT = (bz + 0.5) - predictedFeet.z;
          if ((ddxT * ddxT + ddyT * ddyT + ddzT * ddzT) > scanRadiusSq) continue;
          const ddzE = (bz + 0.5) - eyePos.z;
          if ((ddxE * ddxE + ddyE * ddyE + ddzE * ddzE) > 20.25) continue;

          const basePos = new Vec3(bx, by, bz);
          const blastPos = new Vec3(bx + 0.5, by + 1.0, bz + 0.5);

          const baseBlock = this.bot.blockAt(basePos);
          const crystalSpace = new Vec3(bx, by + 1, bz);
          const aboveBlock = this.bot.blockAt(crystalSpace);
          if (!baseBlock || !isAirLike(aboveBlock)) continue;
          if (hasExistingCrystalAt(this.bot, crystalSpace, liveCrystals)) continue;

          if (this._intersectsEntityHitbox(crystalSpace, botPos)) continue;
          if (this._intersectsEntityHitbox(crystalSpace, target.position, target.height || 1.8)) continue;

          let needsObsidian = false;
          let obsidianRef = null;

          if (baseBlock.name === 'obsidian' || baseBlock.name === 'bedrock') {
            if (!canSeeBlockFace(this.bot, basePos, new Vec3(0, 1, 0), { aimer: this.aimer })) continue;
            needsObsidian = false;
          } else if (isAirLike(baseBlock) && obsidianItem) {
            if (this._intersectsEntityHitbox(basePos, botPos)) continue;
            if (this._intersectsEntityHitbox(basePos, target.position, target.height || 1.8)) continue;
            obsidianRef = this._findPlacementRef(basePos);
            if (!obsidianRef) continue;
            if (!canSeeBlockFace(this.bot, basePos, new Vec3(0, 1, 0), { aimer: this.aimer })) continue;
            needsObsidian = true;
          } else {
            continue;
          }

          const targetDmg = this.estimateBlastDamage(blastPos, predictedFeet, target, CRYSTAL_POWER);
          if (targetDmg < minTargetDmg) continue;

          const rawSelfDmg = this.estimateBlastDamage(
            blastPos,
            botPos,
            this.bot.entity,
            CRYSTAL_POWER,
            needsObsidian ? basePos : null
          );
          const feetShield = findFeetBlastShieldSpot(this, blastPos, basePos);
          const coverSpot = feetShield.spot;
          if (feetShield.needed && !coverSpot && rawSelfDmg > 4.0) continue;

          const effectiveSelfDmg = coverSpot
            ? this.estimateBlastDamage(
                blastPos,
                botPos,
                this.bot.entity,
                CRYSTAL_POWER,
                [coverSpot.placePos, needsObsidian ? basePos : null]
              )
            : rawSelfDmg;

          if (targetDmg <= effectiveSelfDmg) continue;
          if ((this.bot.health - effectiveSelfDmg) <= minSafeHp) continue;

          const score = targetDmg - effectiveSelfDmg * 1.35 - (needsObsidian ? 1.0 : 0);
          if (!best || score > best.score) {
            best = {
              kind: 'crystal',
              score,
              targetDmg,
              selfDmg: effectiveSelfDmg,
              basePos,
              blastPos,
              needsObsidian,
              obsidianRef,
              coverSpot
            };
          }
        }
      }
    }

    return best;
  },

  /**
   * Evaluates whether the bot should IMMEDIATELY Double-Pop / Triple-Pop another End Crystal
   * onto `basePos` on the very next tick after detonation (HT1 rapid crystal chain!).
   */
  _canContinueDoublePop(target, basePos, currentChainCount = 0) {
    if (this.burstCfg.doublePopEnabled === false) return false;
    if (!target || !target.isValid || !target.position || !basePos || !this.bot || !this.bot.entity) {
      return false;
    }

    const maxChain = this._isInTotemPunishWindow() ? 4 : 3;
    if (currentChainCount >= maxChain) return false;
    if (!this._findItem('end_crystal')) return false;

    const baseBlock = typeof this.bot.blockAt === 'function' ? this.bot.blockAt(basePos) : null;
    if (!baseBlock || (baseBlock.name !== 'obsidian' && baseBlock.name !== 'bedrock')) return false;

    const crystalSpace = basePos.offset(0, 1, 0);
    if (!isAirLike(this.bot.blockAt(crystalSpace))) return false;
    if (hasExistingCrystalAt(this.bot, crystalSpace)) return false;

    const botPos = this.bot.entity.position;
    if (this._intersectsEntityHitbox(crystalSpace, botPos)) return false;
    if (this._intersectsEntityHitbox(crystalSpace, target.position, target.height || 1.8)) return false;

    if (!canSeeBlockFace(this.bot, basePos, new Vec3(0, 1, 0), { aimer: this.aimer, maxReach: 4.5 })) {
      return false;
    }

    const blastPos = basePos.offset(0.5, 1.0, 0.5);
    const predictedFeet = this._getPredictedTargetFeet(target, 2);
    if (blastPos.distanceTo(predictedFeet) > 4.6) return false;

    const targetDmg = this.estimateBlastDamage(blastPos, predictedFeet, target, CRYSTAL_POWER);
    const selfDmg = this.estimateBlastDamage(blastPos, botPos, this.bot.entity, CRYSTAL_POWER);
    const minSafeHp = this._isHoldingOffhandTotem() ? 4 : 6;

    if (targetDmg < 4.0) return false;
    if (targetDmg <= selfDmg && !this._isInTotemPunishWindow()) return false;
    if ((this.bot.health - selfDmg) <= minSafeHp) return false;

    return true;
  },

  _findCrystalEntityNear(pos, maxDist = 2.2) {
    if (!this.bot || !this.bot.entities || !pos) return null;
    let closest = null;
    let closestDist = maxDist;
    for (const entity of Object.values(this.bot.entities)) {
      if (!isCrystalEntity(entity) || !entity.position) continue;
      const d = entity.position.distanceTo(pos);
      if (d < closestDist) {
        closestDist = d;
        closest = entity;
      }
    }
    return closest;
  },

  _tickCrystalState(target) {
    const plan = this.activePlan;
    if (!plan) {
      this._resetOffensiveState(true);
      return false;
    }

    this.stateTicks++;
    if (this.stateTicks > 35) {
      this._resetOffensiveState(true);
      return false;
    }
    if (target && target.isValid && target.position && this.bot.entity.position.distanceTo(target.position) > 5.8) {
      this._resetOffensiveState(true);
      return false;
    }

    // Step 0 (Hit-Crystal): delegated to dedicated `modules/burst/hit_crystal.js`
    if (this.state === 'CRYSTAL_HIT_LAUNCH') {
      return this._tickHitCrystalLaunch(target);
    }

    this._applyCpvpFootwork(target, plan.blastPos, plan.coverSpot ? plan.coverSpot.placePos : null);

    // Optional Feet Blast-Shield Cover Placement before crystal
    if (this.state === 'CRYSTAL_COVER') {
      const cover = plan.coverSpot;
      const nextState = plan.detonateOnly
        ? 'CRYSTAL_DETONATE'
        : (plan.needsObsidian ? 'CRYSTAL_PLACE_OBSIDIAN' : 'CRYSTAL_PLACE_CRYSTAL');
      if (!cover) {
        this._enterState(nextState);
        return true;
      }
      const aimStatus = this.aimer.stepTowardsPoint(cover.aimPos, { speedMultiplier: 2.0, toleranceRad: 0.2 });
      const equipRes = this._ensureItemHeld(cover.blockRecord);
      if (!equipRes.found) {
        this._enterState(nextState);
        return true;
      }
      if (this.stepDelayTicks > 0 || equipRes.swappedThisTick || !equipRes.held || !aimStatus.aligned) {
        return true;
      }

      const refBlock = this.bot.blockAt(cover.refPos);
      if (
        refBlock &&
        refBlock.boundingBox === 'block' &&
        isAirLike(this.bot.blockAt(cover.placePos)) &&
        canSeeBlockFace(this.bot, refBlock.position, cover.face, { aimer: this.aimer })
      ) {
        this._markOwnPlacement(cover.placePos);
        if (typeof this.bot.placeBlock === 'function') {
          Promise.resolve(this.bot.placeBlock(refBlock, cover.face)).catch(() => {});
        }
      }
      this.stepDelayTicks = this.placeDelayTicks;
      this._enterState(nextState);
      return true;
    }

    // Step 1: Place Obsidian if needed
    if (this.state === 'CRYSTAL_PLACE_OBSIDIAN') {
      const existingBase = this.bot.blockAt(plan.basePos);
      if (existingBase && (existingBase.name === 'obsidian' || existingBase.name === 'bedrock')) {
        this._enterState('CRYSTAL_PLACE_CRYSTAL');
        return true;
      }

      const obsItem = this._findItem('obsidian');
      if (!obsItem || !plan.obsidianRef) {
        this._resetOffensiveState(true);
        return false;
      }

      const aimStatus = this.aimer.stepTowardsPoint(plan.obsidianRef.aimPos, {
        speedMultiplier: 2.0,
        toleranceRad: 0.2
      });
      const equipRes = this._ensureItemHeld(obsItem);
      if (this.stepDelayTicks > 0 || equipRes.swappedThisTick || !equipRes.held || !aimStatus.aligned) {
        return true;
      }

      const refBlock = this.bot.blockAt(plan.obsidianRef.refPos);
      if (
        !refBlock ||
        refBlock.boundingBox !== 'block' ||
        !canSeeBlockFace(this.bot, refBlock.position, plan.obsidianRef.face, { aimer: this.aimer })
      ) {
        this._resetOffensiveState(true);
        return false;
      }

      this._markOwnPlacement(plan.basePos);
      if (typeof this.bot.placeBlock === 'function') {
        Promise.resolve(this.bot.placeBlock(refBlock, plan.obsidianRef.face)).catch(() => {});
      }

      this.stepDelayTicks = this.placeDelayTicks;
      this._enterState('CRYSTAL_PLACE_CRYSTAL');
      return true;
    }

    // Step 2: Place End Crystal on top of Obsidian / Bedrock
    if (this.state === 'CRYSTAL_PLACE_CRYSTAL') {
      const baseBlock = this.bot.blockAt(plan.basePos);
      if (!baseBlock || (baseBlock.name !== 'obsidian' && baseBlock.name !== 'bedrock')) {
        if (this.stateTicks < 10) return true;
        this._resetOffensiveState(true);
        return false;
      }

      const crystalItem = this._findItem('end_crystal');
      if (!crystalItem) {
        this._resetOffensiveState(true);
        return false;
      }

      const topVis = canSeeBlockFace(this.bot, plan.basePos, new Vec3(0, 1, 0), { aimer: this.aimer });
      if (!topVis) {
        this._resetOffensiveState(true);
        return false;
      }

      const topFaceAim = topVis.aimPos;
      const aimStatus = this.aimer.stepTowardsPoint(topFaceAim, {
        speedMultiplier: 2.0,
        toleranceRad: 0.2
      });
      const equipRes = this._ensureItemHeld(crystalItem);
      if (this.stepDelayTicks > 0 || equipRes.swappedThisTick || !equipRes.held || !aimStatus.aligned) {
        return true;
      }

      this._markOwnPlacement(plan.basePos);
      this._markOwnPlacement(plan.basePos.offset(0, 1, 0));

      if (typeof this.bot.activateBlock === 'function') {
        Promise.resolve(this.bot.activateBlock(baseBlock, new Vec3(0, 1, 0))).catch(() => {});
      } else if (typeof this.bot.placeBlock === 'function') {
        Promise.resolve(this.bot.placeBlock(baseBlock, new Vec3(0, 1, 0))).catch(() => {});
      } else if (typeof this.bot.placeEntity === 'function') {
        Promise.resolve(this.bot.placeEntity(baseBlock, new Vec3(0, 1, 0))).catch(() => {});
      }

      this.stepDelayTicks = this.placeDelayTicks;
      this._enterState('CRYSTAL_DETONATE');
      return true;
    }

    // Step 3: Spawn-Tick Crystal Detonation + Instant HT1 Double-Pop / Triple-Pop Chain!
    if (this.state === 'CRYSTAL_DETONATE') {
      const crystalEntity = (plan.spawnedCrystal && plan.spawnedCrystal.isValid)
        ? plan.spawnedCrystal
        : this._findCrystalEntityNear(plan.blastPos, 2.5);
      const aimPos = crystalEntity ? crystalEntity.position.offset(0, 0.5, 0) : plan.blastPos.offset(0, 0.5, 0);
      const aimStatus = this.aimer.stepTowardsPoint(aimPos, {
        speedMultiplier: 2.0,
        toleranceRad: 0.3
      });

      if (!crystalEntity || (this.stepDelayTicks > 0 && !plan.spawnedCrystal) || !aimStatus.aligned) {
        return true;
      }

      if (typeof this.bot.attack === 'function') {
        this.bot.attack(crystalEntity);
      }
      this.lastCrystalTime = Date.now();

      const nextChain = (plan.chainCount || 0) + 1;
      if (plan.basePos && this._canContinueDoublePop(target, plan.basePos, nextChain)) {
        this.activePlan = {
          kind: 'crystal',
          basePos: plan.basePos,
          blastPos: plan.basePos.offset(0.5, 1.0, 0.5),
          needsObsidian: false,
          obsidianRef: null,
          coverSpot: null,
          spawnedCrystal: null,
          chainCount: nextChain
        };
        this._enterState('CRYSTAL_PLACE_CRYSTAL');
        this.stepDelayTicks = this.placeDelayTicks;
        return true;
      }

      this._resetOffensiveState(true);
      return true;
    }

    return false;
  }
};

module.exports = { crystalSkillMethods };
