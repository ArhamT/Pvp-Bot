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
    if ((now - this.lastCrystalTime) < (this.burstCfg.crystalCooldownMs || 100)) return null;

    const crystalItem = this._findItem('end_crystal');
    if (!crystalItem) return null;
    if (!this.bot || typeof this.bot.blockAt !== 'function') return null;

    const botPos = this.bot.entity.position;
    const maxCrystalRange = this.burstCfg.crystalMaxRange || 4.5;
    if (botPos.distanceTo(target.position) > maxCrystalRange) return null;

    const obsidianItem = this._findItem('obsidian');
    const scanRadius = this.burstCfg.scanRadius || 4.5;
    const rInt = Math.ceil(scanRadius);
    const eyePos = this.aimer ? this.aimer.getEyePosition() : botPos.offset(0, 1.62, 0);
    const minSafeHp = 6;

    const cx = Math.floor(predictedFeet.x);
    const cy = Math.floor(predictedFeet.y);
    const cz = Math.floor(predictedFeet.z);

    let best = null;

    for (let dx = -rInt; dx <= rInt; dx++) {
      for (let dy = -2; dy <= 1; dy++) {
        for (let dz = -rInt; dz <= rInt; dz++) {
          const basePos = new Vec3(cx + dx, cy + dy, cz + dz);
          const blastPos = basePos.offset(0.5, 1.0, 0.5);

          if (blastPos.distanceTo(predictedFeet) > scanRadius) continue;
          if (eyePos.distanceTo(basePos.offset(0.5, 0.8, 0.5)) > 4.5) continue;

          const baseBlock = this.bot.blockAt(basePos);
          const crystalSpace = basePos.offset(0, 1, 0);
          const aboveBlock = this.bot.blockAt(crystalSpace);
          if (!baseBlock || !isAirLike(aboveBlock)) continue;
          if (hasExistingCrystalAt(this.bot, crystalSpace)) continue;

          // Ensure crystal space does not collide with target or bot
          if (this._intersectsEntityHitbox(crystalSpace, botPos)) continue;
          if (this._intersectsEntityHitbox(crystalSpace, target.position, target.height || 1.8)) continue;

          let needsObsidian = false;
          let obsidianRef = null;

          if (baseBlock.name === 'obsidian' || baseBlock.name === 'bedrock') {
            needsObsidian = false;
          } else if (isAirLike(baseBlock) && obsidianItem) {
            if (this._intersectsEntityHitbox(basePos, botPos)) continue;
            if (this._intersectsEntityHitbox(basePos, target.position, target.height || 1.8)) continue;
            obsidianRef = this._findPlacementRef(basePos);
            if (!obsidianRef) continue;
            needsObsidian = true;
          } else {
            continue;
          }

          const targetDmg = this.estimateBlastDamage(blastPos, predictedFeet, target, CRYSTAL_POWER);
          if (targetDmg < 4.0) continue;

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

  _canStartHitCrystal(target) {
    if (this.burstCfg.hitCrystalEnabled === false || this.burstCfg.crystalEnabled === false) return false;
    if (!target || !target.isValid || !this.bot || !this.bot.entity) return false;

    const now = Date.now();
    if ((now - this.lastCrystalTime) < (this.burstCfg.crystalCooldownMs || 100)) return false;
    if ((now - this.lastHitCrystalTime) < (this.burstCfg.hitCrystalCooldownMs || 350)) return false;

    if (!this._findItem('end_crystal')) return false;
    if (!this._findBestSword()) return false;

    const maxHitRange = this.burstCfg.hitCrystalMaxRange || 3.2;
    const reachDist = this._getReachDistanceToEntity(target);
    if (reachDist > maxHitRange) return false;

    // Only initiate hit-launch when opponent is grounded/low so sprint-knockback launches them upward
    if (target.onGround === false && target.velocity && target.velocity.y > 0.15) return false;

    return Boolean(planHitCrystalTrajectory(this, target));
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

    // Step 0 (Hit-Crystal): Sprint-knockback melee hit -> trajectory Obsidian -> End Crystal -> Spawn-Tick Detonate
    if (this.state === 'CRYSTAL_HIT_LAUNCH') {
      if (!target || !target.isValid || this.stateTicks > 10) {
        this._resetOffensiveState(true);
        return false;
      }

      const maxHitRange = this.burstCfg.hitCrystalMaxRange || 3.2;
      const reachDist = this._getReachDistanceToEntity(target);
      if (reachDist > maxHitRange + 0.35) {
        this._resetOffensiveState(true);
        return false;
      }

      const swordRecord = this._findBestSword();
      if (!swordRecord) {
        this._resetOffensiveState(true);
        return false;
      }

      const torsoPos = target.position.offset(0, (target.height || 1.8) * 0.65, 0);
      const aimStatus = this.aimer.stepTowardsPoint(torsoPos, { speedMultiplier: 1.5, toleranceRad: 0.2 });
      const equipRes = this._ensureItemHeld(swordRecord);

      if (typeof this.bot.setControlState === 'function') {
        this.bot.setControlState('forward', true);
        this.bot.setControlState('sprint', this.bot.food > 6);
      }

      if (this.stepDelayTicks > 0 || equipRes.swappedThisTick || !equipRes.held || !aimStatus.aligned || reachDist > maxHitRange) {
        return true;
      }

      if (typeof this.bot.attack === 'function') {
        this.bot.attack(target);
      }
      this.lastHitCrystalTime = Date.now();
      if (typeof this.bot.setControlState === 'function') {
        this.bot.setControlState('sprint', false);
        this.bot.setControlState('forward', false);
      }

      const trajPlan = planHitCrystalTrajectory(this, target) ||
        this._findBestCrystalPlacement(target, this._getPredictedTargetFeet(target, 2));
      if (!trajPlan) {
        this._resetOffensiveState(true);
        return false;
      }

      this.activePlan = trajPlan;
      this.stepDelayTicks = 1;
      if (trajPlan.coverSpot) {
        this.state = 'CRYSTAL_COVER';
      } else if (trajPlan.needsObsidian) {
        this.state = 'CRYSTAL_PLACE_OBSIDIAN';
      } else {
        this.state = 'CRYSTAL_PLACE_CRYSTAL';
      }
      return true;
    }

    this.bot.setControlState('sprint', false);

    // Optional Feet Blast-Shield Cover Placement before crystal
    if (this.state === 'CRYSTAL_COVER') {
      const cover = plan.coverSpot;
      const nextState = plan.detonateOnly
        ? 'CRYSTAL_DETONATE'
        : (plan.needsObsidian ? 'CRYSTAL_PLACE_OBSIDIAN' : 'CRYSTAL_PLACE_CRYSTAL');
      if (!cover) {
        this.state = nextState;
        return true;
      }
      const aimStatus = this.aimer.stepTowardsPoint(cover.aimPos, { speedMultiplier: 1.35, toleranceRad: 0.16 });
      const equipRes = this._ensureItemHeld(cover.blockRecord);
      if (!equipRes.found) {
        this.state = nextState;
        return true;
      }
      if (this.stepDelayTicks > 0 || equipRes.swappedThisTick || !equipRes.held || !aimStatus.aligned) {
        return true;
      }

      const refBlock = this.bot.blockAt(cover.refPos);
      if (refBlock && refBlock.boundingBox === 'block' && isAirLike(this.bot.blockAt(cover.placePos))) {
        this._markOwnPlacement(cover.placePos);
        if (typeof this.bot.placeBlock === 'function') {
          Promise.resolve(this.bot.placeBlock(refBlock, cover.face)).catch(() => {});
        }
      }
      this.stepDelayTicks = this.placeDelayTicks;
      this.state = nextState;
      return true;
    }

    // Step 1: Place Obsidian if needed
    if (this.state === 'CRYSTAL_PLACE_OBSIDIAN') {
      const existingBase = this.bot.blockAt(plan.basePos);
      if (existingBase && (existingBase.name === 'obsidian' || existingBase.name === 'bedrock')) {
        this.state = 'CRYSTAL_PLACE_CRYSTAL';
        return true;
      }

      const obsItem = this._findItem('obsidian');
      if (!obsItem || !plan.obsidianRef) {
        this._resetOffensiveState(true);
        return false;
      }

      const aimStatus = this.aimer.stepTowardsPoint(plan.obsidianRef.aimPos, {
        speedMultiplier: 1.35,
        toleranceRad: 0.16
      });
      const equipRes = this._ensureItemHeld(obsItem);
      if (this.stepDelayTicks > 0 || equipRes.swappedThisTick || !equipRes.held || !aimStatus.aligned) {
        return true;
      }

      const refBlock = this.bot.blockAt(plan.obsidianRef.refPos);
      if (!refBlock || refBlock.boundingBox !== 'block') {
        this._resetOffensiveState(true);
        return false;
      }

      this._markOwnPlacement(plan.basePos);
      if (typeof this.bot.placeBlock === 'function') {
        Promise.resolve(this.bot.placeBlock(refBlock, plan.obsidianRef.face)).catch(() => {});
      }

      this.stepDelayTicks = this.placeDelayTicks;
      this.state = 'CRYSTAL_PLACE_CRYSTAL';
      return true;
    }

    // Step 2: Place End Crystal on top of Obsidian / Bedrock
    if (this.state === 'CRYSTAL_PLACE_CRYSTAL') {
      const baseBlock = this.bot.blockAt(plan.basePos);
      if (!baseBlock || (baseBlock.name !== 'obsidian' && baseBlock.name !== 'bedrock')) {
        // Wait briefly for server block update if we just placed obsidian
        if (this.stateTicks < 10) return true;
        this._resetOffensiveState(true);
        return false;
      }

      const crystalItem = this._findItem('end_crystal');
      if (!crystalItem) {
        this._resetOffensiveState(true);
        return false;
      }

      const topFaceAim = plan.basePos.offset(0.5, 1.0, 0.5);
      const aimStatus = this.aimer.stepTowardsPoint(topFaceAim, {
        speedMultiplier: 1.35,
        toleranceRad: 0.16
      });
      const equipRes = this._ensureItemHeld(crystalItem);
      if (this.stepDelayTicks > 0 || equipRes.swappedThisTick || !equipRes.held || !aimStatus.aligned) {
        return true;
      }

      this._markOwnPlacement(plan.basePos);
      this._markOwnPlacement(plan.basePos.offset(0, 1, 0));

      // In Mineflayer, End Crystals are placed on Obsidian/Bedrock via activateBlock on the top face (0, 1, 0).
      // Using placeEntity fails/throws on end_crystal in Mineflayer 4.x.
      if (typeof this.bot.activateBlock === 'function') {
        Promise.resolve(this.bot.activateBlock(baseBlock, new Vec3(0, 1, 0))).catch(() => {});
      } else if (typeof this.bot.placeBlock === 'function') {
        Promise.resolve(this.bot.placeBlock(baseBlock, new Vec3(0, 1, 0))).catch(() => {});
      } else if (typeof this.bot.placeEntity === 'function') {
        Promise.resolve(this.bot.placeEntity(baseBlock, new Vec3(0, 1, 0))).catch(() => {});
      }

      // Detonate strictly on the next tick (sequential anticheat safety)
      this.stepDelayTicks = this.placeDelayTicks;
      this.state = 'CRYSTAL_DETONATE';
      return true;
    }

    // Step 3: Spawn-Tick Crystal Detonation
    if (this.state === 'CRYSTAL_DETONATE') {
      const crystalEntity = (plan.spawnedCrystal && plan.spawnedCrystal.isValid)
        ? plan.spawnedCrystal
        : this._findCrystalEntityNear(plan.blastPos, 2.5);
      const aimPos = crystalEntity ? crystalEntity.position.offset(0, 0.5, 0) : plan.blastPos.offset(0, 0.5, 0);
      const aimStatus = this.aimer.stepTowardsPoint(aimPos, {
        speedMultiplier: 1.65,
        toleranceRad: 0.28
      });

      if (!crystalEntity || (this.stepDelayTicks > 0 && !plan.spawnedCrystal) || !aimStatus.aligned) {
        return true;
      }

      if (typeof this.bot.attack === 'function') {
        this.bot.attack(crystalEntity);
      }
      this.lastCrystalTime = Date.now();
      this._resetOffensiveState(true);
      return true;
    }

    return false;
  }
};

module.exports = { crystalSkillMethods };
