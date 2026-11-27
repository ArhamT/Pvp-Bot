'use strict';

const { Vec3 } = require('vec3');
const { getEnchantmentLevel } = require('../enchant_utils');
const { CRYSTAL_POWER, isNonNullAir } = require('./shared');
const { findFeetBlastShieldSpot } = require('./cpvp_footwork');
const { collectCrystalPositions, hasExistingCrystalAt } = require('./surround_city');

/**
 * Plans an Obsidian + End Crystal placement along the target's sprint-knockback landing trajectory,
 * scaling forward knockback projection by the sword's Knockback enchantment level.
 */
function planHitCrystalTrajectory(burst, target, swordItem = null) {
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

  const kbLvl = swordItem ? getEnchantmentLevel(swordItem, 'knockback') : 0;
  const projDist = 1.8 + kbLvl * 0.65;
  const targetLandingFeet = new Vec3(
    target.position.x + ux * projDist,
    target.position.y + 0.65,
    target.position.z + uz * projDist
  );

  const forwardSteps = [projDist - 0.5, projDist, projDist + 0.5, projDist + 0.9];
  const lateralOffsets = [0, 0.5, -0.5];
  const dyLevels = [-1, 0];
  const seenKeys = new Set();
  const liveCrystals = collectCrystalPositions(burst.bot);
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
        if (hasExistingCrystalAt(burst.bot, crystalSpace, liveCrystals)) continue;
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
  _planHitCrystalIfReady(target) {
    if (this.burstCfg.hitCrystalEnabled === false || this.burstCfg.crystalEnabled === false) return null;
    if (!target || !target.isValid || !this.bot || !this.bot.entity) return null;

    const now = Date.now();
    const crystalCd = this.burstCfg.crystalCooldownMs !== undefined ? this.burstCfg.crystalCooldownMs : 50;
    const hitCd = this.burstCfg.hitCrystalCooldownMs !== undefined ? this.burstCfg.hitCrystalCooldownMs : 250;
    if ((now - this.lastCrystalTime) < crystalCd) return null;
    if ((now - this.lastHitCrystalTime) < hitCd) return null;

    // Require sword cooldown >= 0.85 so sprint-knockback actually launches the opponent!
    if (this.combat && typeof this.combat.getCooldownProgress === 'function' && this.combat.getCooldownProgress() < 0.85) {
      return null;
    }

    if (!this._findItem('end_crystal')) return null;
    const swordRecord = this._findBestSword();
    if (!swordRecord) return null;

    const maxHitRange = this.burstCfg.hitCrystalMaxRange || 3.4;
    const reachDist = this._getReachDistanceToEntity(target);
    if (reachDist > maxHitRange) return null;

    if (target.onGround === false && target.velocity && target.velocity.y > 0.15) return null;

    return planHitCrystalTrajectory(this, target, swordRecord.item);
  },

  _canStartHitCrystal(target) {
    return Boolean(this._planHitCrystalIfReady(target));
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
    const aimStatus = this.aimer.stepTowardsPoint(torsoPos, { speedMultiplier: 2.0, toleranceRad: 0.22 });
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

    const cached = this.activePlan && this.activePlan.cachedTrajectory;
    const trajPlan = cached || planHitCrystalTrajectory(this, target, swordRecord.item) ||
      this._findBestCrystalPlacement(target, this._getPredictedTargetFeet(target, 2));
    if (!trajPlan) {
      this._resetOffensiveState(true);
      return false;
    }

    this.activePlan = trajPlan;
    this.stepDelayTicks = 1;
    this._enterState(
      trajPlan.coverSpot
        ? 'CRYSTAL_COVER'
        : (trajPlan.needsObsidian ? 'CRYSTAL_PLACE_OBSIDIAN' : 'CRYSTAL_PLACE_CRYSTAL')
    );
    return true;
  }
};

module.exports = {
  planHitCrystalTrajectory,
  hitCrystalMethods
};
