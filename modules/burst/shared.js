'use strict';

const {
  BLAST_SHIELD_BLOCK_PRIORITY,
  COVER_BLOCK_PRIORITY,
  posKey,
  sameBlockPos,
  isAirLike,
  isNonNullAir
} = require('../constants');

const CRYSTAL_POWER = 6.0;
const ANCHOR_POWER = 5.0;

// Blast-resistant solid blocks ONLY (NEVER cobweb — cobwebs have empty boundingBox and don't block blast rays!)
const DEFENSE_BLOCK_PRIORITY = [
  ...BLAST_SHIELD_BLOCK_PRIORITY,
  ...COVER_BLOCK_PRIORITY.filter((b) => !BLAST_SHIELD_BLOCK_PRIORITY.includes(b))
];

function isCrystalEntity(entity) {
  if (!entity || !entity.isValid) return false;
  const name = String(entity.name || '').toLowerCase();
  const display = String(entity.displayName || '').toLowerCase();
  return name === 'end_crystal' || name === 'ender_crystal' || name === 'endercrystal' || display === 'end crystal';
}

const ARMOR_STATS = {
  netherite_helmet: { armor: 3, toughness: 3 },
  netherite_chestplate: { armor: 8, toughness: 3 },
  netherite_leggings: { armor: 6, toughness: 3 },
  netherite_boots: { armor: 3, toughness: 3 },
  diamond_helmet: { armor: 3, toughness: 2 },
  diamond_chestplate: { armor: 8, toughness: 2 },
  diamond_leggings: { armor: 6, toughness: 2 },
  diamond_boots: { armor: 3, toughness: 2 },
  iron_helmet: { armor: 2, toughness: 0 },
  iron_chestplate: { armor: 6, toughness: 0 },
  iron_leggings: { armor: 5, toughness: 0 },
  iron_boots: { armor: 2, toughness: 0 },
  turtle_helmet: { armor: 2, toughness: 0 },
  chainmail_helmet: { armor: 2, toughness: 0 },
  chainmail_chestplate: { armor: 5, toughness: 0 },
  chainmail_leggings: { armor: 4, toughness: 0 },
  chainmail_boots: { armor: 1, toughness: 0 },
  golden_helmet: { armor: 2, toughness: 0 },
  golden_chestplate: { armor: 5, toughness: 0 },
  golden_leggings: { armor: 3, toughness: 0 },
  golden_boots: { armor: 1, toughness: 0 },
  leather_helmet: { armor: 1, toughness: 0 },
  leather_chestplate: { armor: 3, toughness: 0 },
  leather_leggings: { armor: 2, toughness: 0 },
  leather_boots: { armor: 1, toughness: 0 }
};

module.exports = {
  CRYSTAL_POWER,
  ANCHOR_POWER,
  BLAST_SHIELD_BLOCK_PRIORITY,
  COVER_BLOCK_PRIORITY,
  DEFENSE_BLOCK_PRIORITY,
  ARMOR_STATS,
  posKey,
  sameBlockPos,
  isAirLike,
  isNonNullAir,
  isCrystalEntity
};
