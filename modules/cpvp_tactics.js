'use strict';

const { isAirLike: isConstantsAirLike } = require('./constants');
const { CRYSTAL_POWER, isCrystalEntity } = require('./burst/shared');
const { BLAST_SHIELD_BLOCK_PRIORITY, findFeetBlastShieldSpot } = require('./burst/cpvp_footwork');
const {
  SURROUND_SOLID_BLOCKS,
  CARDINAL_OFFSETS,
  hasExistingCrystalAt,
  isTargetInSurround,
  planSurroundPressurePlacement
} = require('./burst/surround_city');
const { planHitCrystalTrajectory } = require('./burst/hit_crystal');

function isAirLike(block) {
  return Boolean(block) && isConstantsAirLike(block);
}

/**
 * Backward-compatible re-export barrel for separated CPvP tactic modules in `modules/burst/`.
 */
module.exports = {
  CRYSTAL_POWER,
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
