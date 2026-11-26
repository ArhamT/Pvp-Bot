'use strict';

const GAPPLE_PRIORITY = [
  'enchanted_golden_apple',
  'golden_apple'
];

const HEAL_FOOD_PRIORITY = [
  'enchanted_golden_apple',
  'golden_apple',
  'golden_carrot',
  'cooked_beef',
  'cooked_porkchop',
  'cooked_mutton',
  'cooked_salmon',
  'cooked_chicken',
  'bread'
];

const LOS_BLOCK_NAMES = new Set([
  'cobblestone',
  'cobbled_deepslate',
  'stone',
  'deepslate',
  'dirt',
  'coarse_dirt',
  'netherrack',
  'obsidian',
  'oak_planks',
  'spruce_planks',
  'birch_planks',
  'jungle_planks',
  'acacia_planks',
  'dark_oak_planks',
  'mangrove_planks',
  'cherry_planks',
  'bamboo_planks',
  'sandstone',
  'bricks',
  'stone_bricks',
  'end_stone',
  'white_wool',
  'red_wool',
  'blue_wool'
]);

const ARMOR_SLOTS = [
  { dest: 'head', slotIndex: 5, suffix: '_helmet', extra: ['turtle_helmet'] },
  { dest: 'torso', slotIndex: 6, suffix: '_chestplate', extra: [] },
  { dest: 'legs', slotIndex: 7, suffix: '_leggings', extra: [] },
  { dest: 'feet', slotIndex: 8, suffix: '_boots', extra: [] }
];

const ARMOR_MATERIAL_SCORE = {
  netherite: 60,
  diamond: 50,
  iron: 35,
  turtle: 32,
  chainmail: 28,
  golden: 22,
  leather: 15
};

const ARMOR_MAX_DURABILITY = {
  leather_helmet: 55, leather_chestplate: 80, leather_leggings: 75, leather_boots: 65,
  golden_helmet: 77, golden_chestplate: 112, golden_leggings: 105, golden_boots: 91,
  chainmail_helmet: 165, chainmail_chestplate: 240, chainmail_leggings: 225, chainmail_boots: 195,
  iron_helmet: 165, iron_chestplate: 240, iron_leggings: 225, iron_boots: 195,
  turtle_helmet: 275,
  diamond_helmet: 363, diamond_chestplate: 528, diamond_leggings: 495, diamond_boots: 429,
  netherite_helmet: 407, netherite_chestplate: 592, netherite_leggings: 555, netherite_boots: 481
};

// Default fallback durations (ms) applied immediately when bot uses a buff potion
// (overridden with exact server tick duration when `entityEffect` packet arrives)
const DEFAULT_BUFF_DURATION_MS = {
  strength: 80000,      // Strength II = 1:30 (90s)
  swiftness: 80000,     // Speed II = 1:30 (90s)
  fire_res: 165000,     // Fire Res = 3:00–8:00 (180s+)
  regen: 20000,         // Regen II = 0:22
  turtle_master: 18000, // Turtle Master = 0:20
  unknown_drink: 85000
};

// Exact 0-based `minecraft:potion` registry order for MC 1.20.5–1.21.4+ (matches Mojang/ViaVersion Potions1_20_5)
const VANILLA_POTION_ID_TO_KEY = [
  'water',                // 0
  'mundane',              // 1
  'thick',                // 2
  'awkward',              // 3
  'night_vision',         // 4
  'long_night_vision',    // 5
  'invisibility',         // 6
  'long_invisibility',    // 7
  'leaping',              // 8
  'long_leaping',         // 9
  'strong_leaping',       // 10
  'fire_resistance',      // 11
  'long_fire_resistance', // 12
  'swiftness',            // 13
  'long_swiftness',       // 14
  'strong_swiftness',     // 15
  'slowness',             // 16
  'long_slowness',        // 17
  'strong_slowness',      // 18
  'turtle_master',        // 19
  'long_turtle_master',   // 20
  'strong_turtle_master', // 21
  'water_breathing',      // 22
  'long_water_breathing', // 23
  'healing',              // 24
  'strong_healing',       // 25
  'harming',              // 26
  'strong_harming',       // 27
  'poison',               // 28
  'long_poison',          // 29
  'strong_poison',        // 30
  'regeneration',         // 31
  'long_regeneration',    // 32
  'strong_regeneration',  // 33
  'strength',             // 34
  'long_strength',        // 35
  'strong_strength',      // 36
  'weakness',             // 37
  'long_weakness',        // 38
  'luck',                 // 39
  'slow_falling',         // 40
  'long_slow_falling',    // 41
  'wind_charged',         // 42
  'weaving',              // 43
  'oozing',               // 44
  'infested'              // 45
];

// Standard MC Java status effect IDs (0-based in >= 1.20.5, 1-based in <= 1.20.4)
const ZERO_BASED_EFFECT_TO_KIND = {
  0: 'swiftness',
  4: 'strength',
  9: 'regen',
  10: 'turtle_master',
  11: 'fire_res'
};

const ZERO_BASED_EFFECT_TO_CLASS = {
  0: 'swiftness',
  1: 'harmful',       // slowness
  4: 'strength',
  5: 'heal2',         // instant_health
  6: 'harmful',       // instant_damage
  9: 'regen',
  10: 'turtle_master',
  11: 'fire_res',
  17: 'harmful',      // weakness
  18: 'harmful',      // poison
  19: 'harmful',      // wither
  35: 'harmful',      // wind_charged
  36: 'harmful',      // weaving
  37: 'harmful',      // oozing
  38: 'harmful'       // infested
};

const ONE_BASED_EFFECT_TO_KIND = {
  1: 'swiftness',
  5: 'strength',
  10: 'regen',
  11: 'turtle_master',
  12: 'fire_res'
};

/**
 * Highest-priority survival module handling:
 * 1. Event-driven + per-tick Totem of Undying management (slot 45, human-like reaction delay + anti-InventoryMove pause).
 * 2. Smart Retreating (<= 11 HP): smooth 180° turn, sprint-jump escape, line-of-sight block placement behind,
 *    Golden Apple / Enchanted Golden Apple eating, and downward (-90° pitch) Splash Instant Health II throws while moving forward.
 * 3. Smart Shielding: raises offhand shield against bow draws within 12 blocks or sword/axe rushes during weapon cooldown.
 * 4. Protection-scored Armor auto-equip & PvP Hotbar auto-sorting (Slots 0–8).
 */

module.exports = {
  GAPPLE_PRIORITY,
  HEAL_FOOD_PRIORITY,
  LOS_BLOCK_NAMES,
  ARMOR_SLOTS,
  ARMOR_MATERIAL_SCORE,
  ARMOR_MAX_DURABILITY,
  DEFAULT_BUFF_DURATION_MS,
  VANILLA_POTION_ID_TO_KEY,
  ZERO_BASED_EFFECT_TO_KIND,
  ZERO_BASED_EFFECT_TO_CLASS,
  ONE_BASED_EFFECT_TO_KIND
};
