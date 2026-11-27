'use strict';

const { Vec3 } = require('vec3');
const { isAirLike: isConstantsAirLike } = require('./constants');

const CRYSTAL_POWER = 6.0;

const BLAST_SHIELD_BLOCK_PRIORITY = [
  'obsidian',
  'glowstone',
  'cobbled_deepslate',
  'cobblestone',
  'stone',
  'deepslate',
  'end_stone'
];

const SURROUND_SOLID_BLOCKS = new Set([
  'obsidian',
  'bedrock',
  'crying_obsidian',
  'respawn_anchor',
  'ancient_debris',
  'netherite_block'
]);

const CARDINAL_OFFSETS = [
  new Vec3(1, 0, 0),
  new Vec3(-1, 0, 0),
  new Vec3(0, 0, 1),
  new Vec3(0, 0, -1)
];

// Preserves strict non-null semantics for CPvP block placement (unloaded null chunks are NOT air)
function isAirLike(block) {
  return Boolean(block) && isConstantsAirLike(block);
}

function isCrystalEntity(entity) {
  if (!entity || !entity.isValid) return false;
  const name = String(entity.name || '').toLowerCase();
  const display = String(entity.displayName || '').toLowerCase();
  return name === 'end_crystal' || name === 'ender_crystal' || name === 'endercrystal' || display === 'end crystal';
}

function sameBlockPos(a, b) {
  if (!a || !b) return false;
  return Math.floor(a.x) === Math.floor(b.x) &&
    Math.floor(a.y) === Math.floor(b.y) &&
    Math.floor(a.z) === Math.floor(b.z);
}

/**
 * Checks whether any valid End Crystal entity already occupies `blockPos`.
 */
function hasExistingCrystalAt(bot, blockPos) {
  if (!bot || !bot.entities || !blockPos) return false;
  const center = blockPos.offset(0.5, 0, 0.5);
  for (const entity of Object.values(bot.entities)) {
    if (!isCrystalEntity(entity) || !entity.position) continue;
    if (sameBlockPos(entity.position.floored(), blockPos) || entity.position.distanceTo(center) <= 0.8) {
      return true;
    }
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
 * Evaluates and plans Feet Blast-Shielding before detonating an explosive within <= 3.5b on the same Y-level.
 */
function findFeetBlastShieldSpot(burst, blastPos, excludedPos = null) {
  if (!burst || !burst.bot || !burst.bot.entity || typeof burst.bot.blockAt !== 'function' || !blastPos) {
    return { needed: false, alreadyOccluded: false, spot: null };
  }

  const botPos = burst.bot.entity.position;
  const shieldRange = (burst.burstCfg && burst.burstCfg.feetBlastShieldRange) || 3.5;
  const dist = botPos.distanceTo(blastPos);
  const sameYLevel = Math.abs(Math.floor(botPos.y) - Math.floor(blastPos.y)) <= 1 && botPos.y >= blastPos.y - 0.5;

  if (dist > shieldRange || !sameYLevel) {
    return { needed: false, alreadyOccluded: false, spot: null };
  }

  if (burst._isRayOccluded(blastPos, botPos.offset(0, 0.15, 0))) {
    return { needed: false, alreadyOccluded: true, spot: null };
  }

  const blockRecord = burst._findItem(BLAST_SHIELD_BLOCK_PRIORITY);
  if (!blockRecord) {
    return { needed: true, alreadyOccluded: false, spot: null };
  }

  const dx = blastPos.x - botPos.x;
  const dz = blastPos.z - botPos.z;
  const horizLen = Math.sqrt(dx * dx + dz * dz);
  if (horizLen < 0.8) {
    return { needed: true, alreadyOccluded: false, spot: null };
  }

  const ux = dx / horizLen;
  const uz = dz / horizLen;
  const botFloorY = Math.floor(botPos.y);

  const primaryPos = new Vec3(
    Math.floor(botPos.x + ux * 1.0),
    botFloorY,
    Math.floor(botPos.z + uz * 1.0)
  );
  const cardinalPos = Math.abs(ux) >= Math.abs(uz)
    ? new Vec3(Math.floor(botPos.x) + Math.sign(ux), botFloorY, Math.floor(botPos.z))
    : new Vec3(Math.floor(botPos.x), botFloorY, Math.floor(botPos.z) + Math.sign(uz));

  const candidates = [primaryPos];
  if (!sameBlockPos(cardinalPos, primaryPos)) {
    candidates.push(cardinalPos);
  }

  const eyePos = burst.aimer ? burst.aimer.getEyePosition() : botPos.offset(0, 1.62, 0);

  for (const placePos of candidates) {
    if (excludedPos && sameBlockPos(placePos, excludedPos)) continue;
    if (burst._intersectsEntityHitbox(placePos, botPos)) continue;
    const targetBlock = burst.bot.blockAt(placePos);
    if (!isAirLike(targetBlock)) continue;
    if (eyePos.distanceTo(placePos.offset(0.5, 0.5, 0.5)) > 4.5) continue;

    const ref = burst._findPlacementRef(placePos);
    if (!ref) continue;

    return {
      needed: true,
      alreadyOccluded: false,
      spot: {
        blockRecord,
        placePos,
        refPos: ref.refPos,
        face: ref.face,
        aimPos: ref.aimPos
      }
    };
  }

  return { needed: true, alreadyOccluded: false, spot: null };
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

  // Projected target position after upward sprint-knockback launch
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
        if (!baseBlock || !isAirLike(aboveBlock)) continue;
        if (hasExistingCrystalAt(burst.bot, crystalSpace)) continue;
        if (burst._intersectsEntityHitbox(crystalSpace, botPos)) continue;

        let needsObsidian = false;
        let obsidianRef = null;
        if (baseBlock.name === 'obsidian' || baseBlock.name === 'bedrock') {
          needsObsidian = false;
        } else if (isAirLike(baseBlock) && obsidianItem) {
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
 * Plans outer-rim (y + 1) / head-height End Crystal placements to pressure opponents camped in 1x1 obsidian surrounds.
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
    // Direct surround rim blocks at y = ty (crystal at ty + 1, head height)
    { offset: new Vec3(1, 0, 0), priorityBonus: 2.0 },
    { offset: new Vec3(-1, 0, 0), priorityBonus: 2.0 },
    { offset: new Vec3(0, 0, 1), priorityBonus: 2.0 },
    { offset: new Vec3(0, 0, -1), priorityBonus: 2.0 },
    // Outer rim at y + 1 (place Obsidian at y + 1, detonate crystal at head/helmet height y + 2)
    { offset: new Vec3(1, 1, 0), priorityBonus: 2.2 },
    { offset: new Vec3(-1, 1, 0), priorityBonus: 2.2 },
    { offset: new Vec3(0, 1, 1), priorityBonus: 2.2 },
    { offset: new Vec3(0, 1, -1), priorityBonus: 2.2 },
    { offset: new Vec3(1, 1, 1), priorityBonus: 1.5 },
    { offset: new Vec3(1, 1, -1), priorityBonus: 1.5 },
    { offset: new Vec3(-1, 1, 1), priorityBonus: 1.5 },
    { offset: new Vec3(-1, 1, -1), priorityBonus: 1.5 },
    // Outer rim at y = ty (corner / 2-out obsidian + head-height crystal)
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

  for (const spec of candidateSpecs) {
    const basePos = new Vec3(tx + spec.offset.x, ty + spec.offset.y, tz + spec.offset.z);
    if (eyePos.distanceTo(basePos.offset(0.5, 0.8, 0.5)) > 4.5) continue;

    const baseBlock = burst.bot.blockAt(basePos);
    const crystalSpace = basePos.offset(0, 1, 0);
    const aboveBlock = burst.bot.blockAt(crystalSpace);
    if (!baseBlock || !isAirLike(aboveBlock)) continue;
    if (hasExistingCrystalAt(burst.bot, crystalSpace)) continue;
    if (burst._intersectsEntityHitbox(crystalSpace, botPos)) continue;
    if (burst._intersectsEntityHitbox(crystalSpace, target.position, target.height || 1.8)) continue;

    let needsObsidian = false;
    let obsidianRef = null;
    if (baseBlock.name === 'obsidian' || baseBlock.name === 'bedrock') {
      needsObsidian = false;
    } else if (isAirLike(baseBlock) && obsidianItem) {
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

module.exports = {
  BLAST_SHIELD_BLOCK_PRIORITY,
  SURROUND_SOLID_BLOCKS,
  CARDINAL_OFFSETS,
  isAirLike,
  isCrystalEntity,
  hasExistingCrystalAt,
  isTargetInSurround,
  findFeetBlastShieldSpot,
  planHitCrystalTrajectory,
  planSurroundPressurePlacement
};
