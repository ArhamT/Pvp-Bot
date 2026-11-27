'use strict';

const { Vec3 } = require('vec3');
const { isAirLike: isConstantsAirLike } = require('../constants');
const { CRYSTAL_POWER } = require('./shared');
const { findFeetBlastShieldSpot } = require('./cpvp_footwork');
const { hasExistingCrystalAt } = require('./surround_city');

function isNonNullAir(block) {
  return Boolean(block) && isConstantsAirLike(block);
}

/**
 * Plans an Obsidian + End Crystal placement along the target's sprint-knockback landing trajectory.
 */
function planHitCrystalTrajectory(burst, target) {
  if (!burst || !burst.bot || !burst.bot.entity || typeof burst.bot.blockAt !== 'function') return null;
  if (!target || !target.isValid || !target.position) return null;

  const crystalItem = burst._findItem('end_crystal');
  if (!crystalItem) return null;

  const obsidianItem = burst._findItem('obsidian');
  const botPos = burst.bot.entity.position;
  const eyePos = burst.aimer ? burst.aimer.getEyePosition() : botPos.offset(0, 1.62, 0);
  const minSafeHp = 6;

  const dx = target.position.x - botPos.x;
  const dz = target.position.z - botPos.z;
  const horizLen = Math.sqrt(dx * dx + dz * dz);
  if (horizLen < 0.05) return null;

  const ux = dx / horizLen;
  const uz = dz / horizLen;
  const lx = -uz;
  const lz = ux;

  const targetLandingFeet = new Vec3(
    target.position.x + ux * 1.8,
    target.position.y + 0.65,
    target.position.z + uz * 1.8
  );

  const forwardSteps = [1.3, 1.8, 2.3, 2.7];
  const lateralOffsets = [0, 0.5, -0.5];
  const dyLevels = [-1, 0];
  const seenKeys = new Set();
  let best = null;

  for (const fwd of forwardSteps) {
    for (const lat of lateralOffsets) {
      for (const dy of dyLevels) {
        const basePos = new Vec3(
          Math.floor(target.position.x + ux * fwd + lx * lat),
          Math.floor(target.position.y) + dy,
          Math.floor(target.position.z + uz * fwd + lz * lat)
        );
        const key = `${basePos.x},${basePos.y},${basePos.z}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);

        if (eyePos.distanceTo(basePos.offset(0.5, 0.8, 0.5)) > 4.5) continue;

        const baseBlock = burst.bot.blockAt(basePos);
        const crystalSpace = basePos.offset(0, 1, 0);
        const aboveBlock = burst.bot.blockAt(crystalSpace);
        if (!baseBlock || !isNonNullAir(aboveBlock)) continue;
        if (hasExistingCrystalAt(burst.bot, crystalSpace)) continue;
        if (burst._intersectsEntityHitbox(crystalSpace, botPos)) continue;

        let needsObsidian = false;
        let obsidianRef = null;
        if (baseBlock.name === 'obsidian' || baseBlock.name === 'bedrock') {
          needsObsidian = false;
        } else if (isNonNullAir(baseBlock) && obsidianItem) {
          if (burst._intersectsEntityHitbox(basePos, botPos)) continue;
          obsidianRef = burst._findPlacementRef(basePos);
          if (!obsidianRef) continue;
          needsObsidian = true;
        } else {
          continue;
        }

        const blastPos = basePos.offset(0.5, 1.0, 0.5);
        const targetDmg = burst.estimateBlastDamage(blastPos, targetLandingFeet, target, CRYSTAL_POWER);
        if (targetDmg < 4.0) continue;

        const feetShield = findFeetBlastShieldSpot(burst, blastPos, basePos);
        const coverSpot = feetShield.spot;
        const effectiveSelfDmg = burst.estimateBlastDamage(
          blastPos,
          botPos,
          burst.bot.entity,
          CRYSTAL_POWER,
          [coverSpot ? coverSpot.placePos : null, needsObsidian ? basePos : null]
        );

        if (targetDmg <= effectiveSelfDmg) continue;
        if ((burst.bot.health - effectiveSelfDmg) <= minSafeHp) continue;

        const score = targetDmg - effectiveSelfDmg * 1.3 - (needsObsidian ? 0.5 : 0) + 1.0;
        if (!best || score > best.score) {
          best = {
            kind: 'crystal',
            isHitCrystal: true,
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
}

/**
 * Dedicated Hit-Crystal Skill (`modules/burst/hit_crystal.js`):
 * Sprint-knockback sword launch -> predictive Obsidian placement under airborne opponent -> End Crystal pop!
 */
const hitCrystalMethods = {
  _canStartHitCrystal(target) {
    if (this.burstCfg.hitCrystalEnabled === false || this.burstCfg.crystalEnabled === false) return false;
    if (!target || !target.isValid || !this.bot || !this.bot.entity) return false;

    const now = Date.now();
    if ((now - this.lastCrystalTime) < (this.burstCfg.crystalCooldownMs || 50)) return false;
    if ((now - this.lastHitCrystalTime) < (this.burstCfg.hitCrystalCooldownMs || 250)) return false;

    if (!this._findItem('end_crystal')) return false;
    if (!this._findBestSword()) return false;

    const maxHitRange = this.burstCfg.hitCrystalMaxRange || 3.4;
    const reachDist = this._getReachDistanceToEntity(target);
    if (reachDist > maxHitRange) return false;

    if (target.onGround === false && target.velocity && target.velocity.y > 0.15) return false;

    return Boolean(planHitCrystalTrajectory(this, target));
  },

  _tickHitCrystalLaunch(target) {
    if (!target || !target.isValid || this.stateTicks > 10) {
      this._resetOffensiveState(true);
      return false;
    }

    const maxHitRange = this.burstCfg.hitCrystalMaxRange || 3.4;
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
    const aimStatus = this.aimer.stepTowardsPoint(torsoPos, { speedMultiplier: 2.0, toleranceRad: 0.22, force: true });
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
};

module.exports = {
  planHitCrystalTrajectory,
  hitCrystalMethods
};
