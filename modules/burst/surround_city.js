'use strict';

const { Vec3 } = require('vec3');
const { findVisibleBlockFace } = require('../placement_los');
const { canMineBlock } = require('../mining');
const { CRYSTAL_POWER, isCrystalEntity, isAirLike, isNonNullAir, sameBlockPos } = require('./shared');
const { findFeetBlastShieldSpot } = require('./cpvp_footwork');

const SURROUND_SOLID_BLOCKS = new Set([
  'obsidian',
  'bedrock',
  'crying_obsidian',
  'respawn_anchor',
  'ancient_debris',
  'netherite_block'
]);

const CITY_BREAKABLE_BLOCKS = new Set([
  'obsidian',
  'crying_obsidian',
  'cobblestone',
  'cobbled_deepslate',
  'stone',
  'deepslate',
  'end_stone',
  'respawn_anchor',
  'oak_planks',
  'spruce_planks'
]);

const CARDINAL_OFFSETS = [
  new Vec3(1, 0, 0),
  new Vec3(-1, 0, 0),
  new Vec3(0, 0, 1),
  new Vec3(0, 0, -1)
];

function collectCrystalPositions(bot) {
  const out = [];
  if (!bot || !bot.entities) return out;
  for (const entity of Object.values(bot.entities)) {
    if (isCrystalEntity(entity) && entity.position) {
      out.push(entity.position);
    }
  }
  return out;
}

function hasExistingCrystalAt(bot, blockPos, precollectedPositions = null) {
  if (!blockPos) return false;
  const list = precollectedPositions || collectCrystalPositions(bot);
  if (list.length === 0) return false;
  const cx = blockPos.x + 0.5;
  const cy = blockPos.y;
  const cz = blockPos.z + 0.5;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (sameBlockPos(p, blockPos)) return true;
    const dx = p.x - cx;
    const dy = p.y - cy;
    const dz = p.z - cz;
    if ((dx * dx + dy * dy + dz * dz) <= 0.64) return true;
  }
  return false;
}

/**
 * Returns true when the target is camped inside a 1x1 obsidian/bedrock surround.
 */
function isTargetInSurround(bot, target) {
  if (!bot || typeof bot.blockAt !== 'function' || !target || !target.position) return false;
  const feet = target.position.floored();
  let surroundCount = 0;
  let solidCount = 0;

  for (const offset of CARDINAL_OFFSETS) {
    const block = bot.blockAt(feet.plus(offset));
    if (!block) continue;
    if (SURROUND_SOLID_BLOCKS.has(block.name)) {
      surroundCount++;
      solidCount++;
    } else if (block.boundingBox === 'block') {
      solidCount++;
    }
  }

  return surroundCount >= 3 || solidCount === 4;
}

/**
 * Plans outer-rim (y + 1) / head-height End Crystal placements to pressure opponents camped in 1x1 surrounds.
 */
function planSurroundPressurePlacement(burst, target, predictedFeet) {
  if (!burst || !burst.bot || !burst.bot.entity || typeof burst.bot.blockAt !== 'function') return null;
  if (!target || !target.isValid || !target.position) return null;

  const crystalItem = burst._findItem('end_crystal');
  if (!crystalItem) return null;

  const obsidianItem = burst._findItem('obsidian');
  const botPos = burst.bot.entity.position;
  const eyePos = burst.aimer ? burst.aimer.getEyePosition() : botPos.offset(0, 1.62, 0);
  const minSafeHp = 6;

  const tx = Math.floor(target.position.x);
  const ty = Math.floor(target.position.y);
  const tz = Math.floor(target.position.z);
  const headPos = target.position.offset(0, 1.55, 0);
  const evalFeet = predictedFeet || target.position;

  const candidateSpecs = [
    { offset: new Vec3(1, 0, 0), priorityBonus: 2.0 },
    { offset: new Vec3(-1, 0, 0), priorityBonus: 2.0 },
    { offset: new Vec3(0, 0, 1), priorityBonus: 2.0 },
    { offset: new Vec3(0, 0, -1), priorityBonus: 2.0 },
    { offset: new Vec3(1, 1, 0), priorityBonus: 2.2 },
    { offset: new Vec3(-1, 1, 0), priorityBonus: 2.2 },
    { offset: new Vec3(0, 1, 1), priorityBonus: 2.2 },
    { offset: new Vec3(0, 1, -1), priorityBonus: 2.2 },
    { offset: new Vec3(1, 1, 1), priorityBonus: 1.5 },
    { offset: new Vec3(1, 1, -1), priorityBonus: 1.5 },
    { offset: new Vec3(-1, 1, 1), priorityBonus: 1.5 },
    { offset: new Vec3(-1, 1, -1), priorityBonus: 1.5 },
    { offset: new Vec3(1, 0, 1), priorityBonus: 1.0 },
    { offset: new Vec3(1, 0, -1), priorityBonus: 1.0 },
    { offset: new Vec3(-1, 0, 1), priorityBonus: 1.0 },
    { offset: new Vec3(-1, 0, -1), priorityBonus: 1.0 },
    { offset: new Vec3(2, 0, 0), priorityBonus: 0.6 },
    { offset: new Vec3(-2, 0, 0), priorityBonus: 0.6 },
    { offset: new Vec3(0, 0, 2), priorityBonus: 0.6 },
    { offset: new Vec3(0, 0, -2), priorityBonus: 0.6 }
  ];

  let best = null;
  const liveCrystals = collectCrystalPositions(burst.bot);

  for (const spec of candidateSpecs) {
    const basePos = new Vec3(tx + spec.offset.x, ty + spec.offset.y, tz + spec.offset.z);
    if (eyePos.distanceTo(basePos.offset(0.5, 0.8, 0.5)) > 4.5) continue;

    const baseBlock = burst.bot.blockAt(basePos);
    const crystalSpace = basePos.offset(0, 1, 0);
    const aboveBlock = burst.bot.blockAt(crystalSpace);
    if (!baseBlock || !isNonNullAir(aboveBlock)) continue;
    if (hasExistingCrystalAt(burst.bot, crystalSpace, liveCrystals)) continue;
    if (burst._intersectsEntityHitbox(crystalSpace, botPos)) continue;
    if (burst._intersectsEntityHitbox(crystalSpace, target.position, target.height || 1.8)) continue;

    let needsObsidian = false;
    let obsidianRef = null;
    if (baseBlock.name === 'obsidian' || baseBlock.name === 'bedrock') {
      needsObsidian = false;
    } else if (isNonNullAir(baseBlock) && obsidianItem) {
      if (burst._intersectsEntityHitbox(basePos, botPos)) continue;
      if (burst._intersectsEntityHitbox(basePos, target.position, target.height || 1.8)) continue;
      obsidianRef = burst._findPlacementRef(basePos);
      if (!obsidianRef) continue;
      needsObsidian = true;
    } else {
      continue;
    }

    const blastPos = basePos.offset(0.5, 1.0, 0.5);
    if (burst._isRayOccluded(blastPos, headPos)) continue;

    const targetDmg = burst.estimateBlastDamage(blastPos, evalFeet, target, CRYSTAL_POWER);
    if (targetDmg < 1.5) continue;

    const feetShield = findFeetBlastShieldSpot(burst, blastPos, basePos);
    const coverSpot = feetShield.spot;
    const effectiveSelfDmg = burst.estimateBlastDamage(
      blastPos,
      botPos,
      burst.bot.entity,
      CRYSTAL_POWER,
      [coverSpot ? coverSpot.placePos : null, needsObsidian ? basePos : null]
    );

    if (targetDmg <= effectiveSelfDmg && effectiveSelfDmg > 2.5) continue;
    if ((burst.bot.health - effectiveSelfDmg) <= minSafeHp) continue;

    const score = targetDmg + spec.priorityBonus - effectiveSelfDmg * 1.25 - (needsObsidian ? 0.5 : 0);
    if (!best || score > best.score) {
      best = {
        kind: 'crystal',
        isSurroundPressure: true,
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

  return best;
}

/**
 * Anti-Surround & HT1 "City" Mining skill (`modules/burst/surround_city.js`).
 */
const surroundCityMethods = {
  _findSurroundCityBlock(target) {
    if (this.burstCfg.cityMineEnabled === false) return null;
    if (!target || !target.isValid || !target.position || !this.bot || !this.bot.entity) return null;
    if (typeof this.bot.blockAt !== 'function' || typeof this.bot.dig !== 'function') return null;
    if (!this._findItem('end_crystal') && !this._findItem('respawn_anchor')) return null;
    if (!isTargetInSurround(this.bot, target)) return null;

    const botPos = this.bot.entity.position;
    if (botPos.distanceTo(target.position) > 4.5) return null;

    const feet = target.position.floored();
    let best = null;
    let bestScore = -Infinity;

    for (const offset of CARDINAL_OFFSETS) {
      const pos = feet.plus(offset);
      const block = this.bot.blockAt(pos);
      if (!block || !CITY_BREAKABLE_BLOCKS.has(block.name)) continue;
      if (!canMineBlock(this.bot, block)) continue;

      const vis = findVisibleBlockFace(this.bot, pos, { aimer: this.aimer, maxReach: 4.5 });
      if (!vis) continue;

      const below = this.bot.blockAt(pos.offset(0, -1, 0));
      const crystalReadyFloor = below && (below.name === 'obsidian' || below.name === 'bedrock');
      const outerFloor = this.bot.blockAt(pos.plus(offset).offset(0, -1, 0));
      const outerCrystalReady = outerFloor && (outerFloor.name === 'obsidian' || outerFloor.name === 'bedrock');

      const speedBonus = block.name === 'obsidian' || block.name === 'crying_obsidian' ? 0 : 3.5;
      const score = speedBonus + (crystalReadyFloor ? 2.5 : 0) + (outerCrystalReady ? 1.5 : 0) - vis.distance * 0.5;
      if (score > bestScore) {
        bestScore = score;
        best = { block, pos, offset, vis };
      }
    }

    return best;
  },

  _tickCpvpCityMine(target) {
    const plan = this.activePlan;
    this.stateTicks++;
    if (
      !plan ||
      !plan.cityPos ||
      !target ||
      !target.isValid ||
      this.stateTicks > 260 ||
      this.bot.entity.position.distanceTo(target.position) > 5.2
    ) {
      if (this.miner) this.miner.cancel();
      this._resetOffensiveState(true);
      return false;
    }

    const block = this.bot.blockAt(plan.cityPos);
    if (!block || isAirLike(block) || block.boundingBox !== 'block') {
      if (this.miner) this.miner.cancel();
      const predictedFeet = this._getPredictedTargetFeet(target, 1);
      const crystalPlan = this._findBestCrystalPlacement(target, predictedFeet);
      if (crystalPlan) {
        this.activePlan = crystalPlan;
        this.stepDelayTicks = 0;
        this._enterState(
          crystalPlan.coverSpot
            ? 'CRYSTAL_COVER'
            : (crystalPlan.needsObsidian ? 'CRYSTAL_PLACE_OBSIDIAN' : 'CRYSTAL_PLACE_CRYSTAL')
        );
        return this._tickCrystalState(target);
      }
      this._resetOffensiveState(false);
      return false;
    }

    const res = this.miner.mineBlockTick(block);
    if (res.status === 'unreachable' || res.status === 'unbreakable' || res.status === 'failed') {
      if (this.miner) this.miner.cancel();
      this._resetOffensiveState(true);
      return false;
    }
    return true;
  }
};

module.exports = {
  SURROUND_SOLID_BLOCKS,
  CITY_BREAKABLE_BLOCKS,
  CARDINAL_OFFSETS,
  collectCrystalPositions,
  hasExistingCrystalAt,
  isTargetInSurround,
  planSurroundPressurePlacement,
  surroundCityMethods
};
