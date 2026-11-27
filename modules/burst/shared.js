'use strict';

const { Vec3 } = require('vec3');
const { posKey, isAirLike } = require('../constants');
const {
  CRYSTAL_POWER,
  BLAST_SHIELD_BLOCK_PRIORITY,
  isCrystalEntity
} = require('../cpvp_tactics');

const HOTBAR_END = 44;
const ANCHOR_POWER = 5.0;
const COVER_BLOCK_PRIORITY = BLAST_SHIELD_BLOCK_PRIORITY;

const DEFENSE_BLOCK_PRIORITY = [
  'cobweb', 'obsidian', 'cobbled_deepslate', 'cobblestone', 'stone',
  'deepslate', 'netherrack', 'dirt', 'oak_planks', 'spruce_planks',
  'birch_planks', 'stone_bricks', 'end_stone'
];

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

const PLACEMENT_FACES = [
  { offset: new Vec3(0, -1, 0), face: new Vec3(0, 1, 0) },
  { offset: new Vec3(1, 0, 0), face: new Vec3(-1, 0, 0) },
  { offset: new Vec3(-1, 0, 0), face: new Vec3(1, 0, 0) },
  { offset: new Vec3(0, 0, 1), face: new Vec3(0, 0, -1) },
  { offset: new Vec3(0, 0, -1), face: new Vec3(0, 0, 1) },
  { offset: new Vec3(0, 1, 0), face: new Vec3(0, -1, 0) }
];

module.exports = {
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
};
