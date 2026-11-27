'use strict';

const {
  HOTBAR_START,
  SWORD_PRIORITY,
  AXE_PRIORITY,
  hasStatusEffect
} = require('./constants');
const {
  parseItemEnchantments,
  getItemDurabilityInfo
} = require('./enchant_utils');

const ELYTRA_MAX_DURABILITY = 432;

/**
 * Scans inventory for all Maces (Density / Breach / Wind Burst), Axes, and Swords,
 * and checks whether the Axe is positioned to the right of all Maces on the hotbar.
 */
function scanWeaponEnchantments(bot) {
  const empty = {
    maces: [],
    densityMace: null,
    breachMace: null,
    windBurstMace: null,
    bestAxe: null,
    bestSword: null,
    axeRightOfMace: false
  };
  if (!bot || !bot.inventory || !Array.isArray(bot.inventory.slots)) return empty;

  const hotbarStart = bot.inventory.hotbarStart || HOTBAR_START;
  const slots = bot.inventory.slots;
  const maces = [];
  let bestAxe = null;
  let bestSword = null;

  for (let slot = 0; slot < slots.length; slot++) {
    const item = slots[slot];
    if (!item || !item.name) continue;
    const inHotbar = slot >= hotbarStart && slot < hotbarStart + 9;
    const hotbarIndex = inHotbar ? slot - hotbarStart : -1;

    if (item.name === 'mace') {
      const ench = parseItemEnchantments(item);
      maces.push({
        slot,
        hotbarIndex,
        item,
        density: ench.density,
        breach: ench.breach,
        wind_burst: ench.wind_burst
      });
    } else if (AXE_PRIORITY.includes(item.name)) {
      const tier = AXE_PRIORITY.indexOf(item.name);
      if (!bestAxe || (inHotbar && bestAxe.hotbarIndex < 0) || (inHotbar === (bestAxe.hotbarIndex >= 0) && tier < bestAxe.tier)) {
        bestAxe = { slot, hotbarIndex, item, tier };
      }
    } else if (SWORD_PRIORITY.includes(item.name)) {
      const tier = SWORD_PRIORITY.indexOf(item.name);
      if (!bestSword || (inHotbar && bestSword.hotbarIndex < 0) || (inHotbar === (bestSword.hotbarIndex >= 0) && tier < bestSword.tier)) {
        bestSword = { slot, hotbarIndex, item, tier };
      }
    }
  }

  const pickBest = (cmp) => {
    if (maces.length === 0) return null;
    const sorted = maces.slice().sort(cmp);
    return sorted[0];
  };

  const densityMace = pickBest((a, b) =>
    (b.density - a.density) ||
    (b.wind_burst - a.wind_burst) ||
    ((b.hotbarIndex >= 0 ? 1 : 0) - (a.hotbarIndex >= 0 ? 1 : 0))
  );
  const breachMace = pickBest((a, b) =>
    (b.breach - a.breach) ||
    (b.wind_burst - a.wind_burst) ||
    ((b.hotbarIndex >= 0 ? 1 : 0) - (a.hotbarIndex >= 0 ? 1 : 0))
  );
  const windBurstMace = pickBest((a, b) =>
    (b.wind_burst - a.wind_burst) ||
    (b.breach - a.breach) ||
    ((b.hotbarIndex >= 0 ? 1 : 0) - (a.hotbarIndex >= 0 ? 1 : 0))
  );

  let maxMaceIdx = -1;
  for (const m of maces) {
    if (m.hotbarIndex > maxMaceIdx) maxMaceIdx = m.hotbarIndex;
  }
  const axeRightOfMace = Boolean(bestAxe && bestAxe.hotbarIndex >= 0 && maxMaceIdx >= 0 && bestAxe.hotbarIndex > maxMaceIdx);

  return {
    maces,
    densityMace,
    breachMace,
    windBurstMace,
    bestAxe,
    bestSword,
    axeRightOfMace
  };
}

/**
 * Validates worn and carried armor: flags Blast Protection pieces and checks full Protection IV.
 */
function validateArmorInventory(bot) {
  const flaggedPieces = [];
  let fullProtectionIV = true;
  if (!bot || !bot.inventory || !Array.isArray(bot.inventory.slots)) {
    return { fullProtectionIV: false, hasBlastProtection: false, flaggedPieces };
  }

  for (const item of bot.inventory.slots) {
    if (!item || !item.name) continue;
    if (
      item.name.endsWith('_helmet') ||
      item.name.endsWith('_chestplate') ||
      item.name.endsWith('_leggings') ||
      item.name.endsWith('_boots')
    ) {
      const ench = parseItemEnchantments(item);
      if (ench.blast_protection > 0) {
        flaggedPieces.push({ slot: item.slot, name: item.name, blast_protection: ench.blast_protection });
      }
    }
  }

  for (const slotIdx of [5, 6, 7, 8]) {
    const piece = bot.inventory.slots[slotIdx];
    if (!piece) {
      fullProtectionIV = false;
      continue;
    }
    const ench = parseItemEnchantments(piece);
    if (ench.blast_protection > 0 || ench.protection < 4) {
      fullProtectionIV = false;
    }
  }

  return {
    fullProtectionIV,
    hasBlastProtection: flaggedPieces.length > 0,
    flaggedPieces
  };
}

/**
 * Selects Density vs Breach Mace by fall height:
 * - fallDistance >= 5.0 (default, configurable via `densityMinFallDistance`) -> Density Mace
 * - fallDistance < 5.0 -> Breach Mace
 */
function selectMaceForFall(fallDistance, weaponMap, options = {}) {
  if (!weaponMap || !Array.isArray(weaponMap.maces) || weaponMap.maces.length === 0) return null;
  const preferWindBurst = options.preferWindBurst !== false;
  const minDensityFall = options.densityMinFallDistance !== undefined ? options.densityMinFallDistance : 5.0;
  const useDensity = fallDistance >= minDensityFall;

  const ranked = weaponMap.maces.slice().sort((a, b) => {
    if (useDensity) {
      if (b.density !== a.density) return b.density - a.density;
    } else {
      if (b.breach !== a.breach) return b.breach - a.breach;
    }
    if (preferWindBurst && b.wind_burst !== a.wind_burst) {
      return b.wind_burst - a.wind_burst;
    }
    return ((b.hotbarIndex >= 0 ? 1 : 0) - (a.hotbarIndex >= 0 ? 1 : 0));
  });

  const chosen = ranked[0];
  return {
    item: chosen.item,
    hotbarIndex: chosen.hotbarIndex,
    isDensity: chosen.density > 0,
    isBreach: chosen.breach > 0,
    isWindBurst: chosen.wind_burst > 0
  };
}

/**
 * Extracts structured target combat state from entity properties & metadata (no visual cues).
 */
function buildTargetState(target) {
  if (!target || !target.position) return null;
  const meta = target.metadata || {};
  const entityFlags = Number(meta[0] || 0);
  const handFlags = Number(meta[8] || 0);
  const eq = Array.isArray(target.equipment) ? target.equipment : [];
  const mainHand = eq[0] || null;
  const offHand = eq[1] || null;

  const isGliding = Boolean(
    target.elytraFlying ||
    target.pose === 1 ||
    (typeof target.height === 'number' && target.height <= 0.7) ||
    (entityFlags & 0x80) !== 0
  );
  const hasShield = Boolean(
    (mainHand && mainHand.name === 'shield') ||
    (offHand && offHand.name === 'shield')
  );
  const isBlocking = Boolean(
    hasShield &&
    (target.usingItem || (handFlags & 0x01) !== 0)
  );
  const hasTotemOffhand = Boolean(offHand && offHand.name === 'totem_of_undying');

  return {
    position: target.position,
    velocity: target.velocity || { x: 0, y: 0, z: 0 },
    yaw: typeof target.yaw === 'number' ? target.yaw : 0,
    pitch: typeof target.pitch === 'number' ? target.pitch : 0,
    height: isGliding ? 0.6 : (target.height || 1.8),
    isGliding,
    isBlocking,
    hasTotemOffhand
  };
}

/**
 * 3-branch Shield Countering logic:
 * 1. BACKSTAB (preferred airborne when behind or able to flank the 180° shield arc)
 * 2. STUN_SLAM (Axe -> Mace smash when airborne or either player is gliding)
 * 3. SHIELD_DRAIN (continuous pressure when unable to backstab or stun-slam)
 */
function evaluateShieldCounter(bot, targetState, equipInfo = {}) {
  if (!bot || !bot.entity || !bot.entity.position || !targetState || !targetState.isBlocking) {
    return { strategy: 'NONE', dot: 1, behindTarget: false };
  }

  const dx = bot.entity.position.x - targetState.position.x;
  const dz = bot.entity.position.z - targetState.position.z;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 0.01) {
    return { strategy: 'BACKSTAB', dot: -1, behindTarget: true };
  }

  const toBotX = dx / len;
  const toBotZ = dz / len;
  const lookX = -Math.sin(targetState.yaw);
  const lookZ = -Math.cos(targetState.yaw);
  const dot = lookX * toBotX + lookZ * toBotZ;

  if (dot < 0 || (equipInfo.isAirborne && dot < 0.25)) {
    return { strategy: 'BACKSTAB', dot, behindTarget: dot < 0 };
  }

  if (equipInfo.hasAxe && equipInfo.hasMace && (equipInfo.isAirborne || targetState.isGliding || equipInfo.isGliding)) {
    return { strategy: 'STUN_SLAM', dot, behindTarget: false };
  }

  return { strategy: 'SHIELD_DRAIN', dot, behindTarget: false };
}

/**
 * Checks `bot.entity.effects` for Slow Falling (MC 1.20.4 id 28 / 1.20.5+ id 27).
 */
function hasSlowFalling(bot) {
  return hasStatusEffect(bot, 'slow_falling');
}

/**
 * Detects an incoming enemy Dive Bomb (`dy > 5` and steep downward `vy < -0.6` closing horizontally).
 */
function detectEnemyDiveBomb(bot, targetState) {
  if (!bot || !bot.entity || !bot.entity.position || !targetState || !targetState.position) {
    return { threat: false, dy: 0, vy: 0, horizDist: Infinity };
  }
  const botPos = bot.entity.position;
  const tPos = targetState.position;
  const vel = targetState.velocity || { x: 0, y: 0, z: 0 };
  const dy = tPos.y - botPos.y;
  const vy = typeof vel.y === 'number' ? vel.y : 0;
  const dx = botPos.x - tPos.x;
  const dz = botPos.z - tPos.z;
  const horizDist = Math.sqrt(dx * dx + dz * dz);

  if (dy <= 5.0 || vy >= -0.6) {
    return { threat: false, dy, vy, horizDist };
  }

  const closingSpeed = horizDist > 0.05
    ? ((vel.x || 0) * (dx / horizDist) + (vel.z || 0) * (dz / horizDist))
    : 1.0;
  const threat = horizDist <= 5.0 || (horizDist <= 12.0 && closingSpeed > 0.05);

  return { threat, dy, vy, horizDist };
}

function getElytraDurabilityInfo(item) {
  if (!item || item.name !== 'elytra') {
    return { valid: false, remaining: 0, max: ELYTRA_MAX_DURABILITY };
  }
  const info = getItemDurabilityInfo(item, ELYTRA_MAX_DURABILITY);
  return {
    valid: info.valid,
    remaining: info.remaining,
    max: info.max
  };
}

function shouldConserveElytra(bot, threshold = 50) {
  if (!bot || !bot.inventory || !Array.isArray(bot.inventory.slots)) {
    return { low: false, remaining: ELYTRA_MAX_DURABILITY, item: null };
  }
  const torsoSlot = typeof bot.getEquipmentDestSlot === 'function' ? bot.getEquipmentDestSlot('torso') : 6;
  const worn = bot.inventory.slots[torsoSlot];
  const elytra = (worn && worn.name === 'elytra')
    ? worn
    : bot.inventory.slots.find((i) => i && i.name === 'elytra');
  if (!elytra) {
    return { low: false, remaining: 0, item: null };
  }
  const info = getElytraDurabilityInfo(elytra);
  return {
    low: info.remaining < threshold,
    remaining: info.remaining,
    item: elytra
  };
}

/**
 * Executes an attribute-swap attack in the same tick window:
 * holds base Sword/Axe, switches quickbar slot to target Mace, and calls `bot.attack(target)`.
 * When `durabilityDrainMode` is true, skips swapping and performs a standard attack.
 */
function executeAttributeSwapAttack(bot, target, baseSel, maceSel, options = {}) {
  if (!bot || !target || typeof bot.attack !== 'function') return false;

  if (options.durabilityDrainMode) {
    bot.attack(target);
    return true;
  }

  if (
    baseSel &&
    typeof baseSel.hotbarIndex === 'number' &&
    baseSel.hotbarIndex >= 0 &&
    typeof bot.setQuickBarSlot === 'function' &&
    bot.quickBarSlot !== baseSel.hotbarIndex
  ) {
    bot.setQuickBarSlot(baseSel.hotbarIndex);
  }

  if (
    maceSel &&
    typeof maceSel.hotbarIndex === 'number' &&
    maceSel.hotbarIndex >= 0 &&
    typeof bot.setQuickBarSlot === 'function' &&
    bot.quickBarSlot !== maceSel.hotbarIndex
  ) {
    bot.setQuickBarSlot(maceSel.hotbarIndex);
  }

  bot.attack(target);
  return true;
}

/**
 * Returns true if the engagement is a Mace / Wind Charge / Elytra duel context.
 */
function isMaceDuelContext(bot, target) {
  const isMaceGear = (item) => Boolean(
    item &&
    (item.name === 'mace' || item.name === 'wind_charge' || item.name === 'elytra')
  );

  if (bot && bot.inventory) {
    const items = typeof bot.inventory.items === 'function'
      ? bot.inventory.items()
      : (Array.isArray(bot.inventory.slots) ? bot.inventory.slots : []);
    if (items.some(isMaceGear)) return true;
  }

  if (target) {
    if (isMaceGear(target.heldItem)) return true;
    if (Array.isArray(target.equipment) && target.equipment.some(isMaceGear)) return true;
    if (bot && bot.entity && bot.entity.position && target.position) {
      const dy = target.position.y - bot.entity.position.y;
      const vy = target.velocity && typeof target.velocity.y === 'number' ? target.velocity.y : 0;
      if (dy >= 2.0 && vy <= -0.25) return true;
    }
  }

  return false;
}

/**
 * Pro high-tier Mace smash threat detector:
 * - Raises shield pre-impact (`estTicks <= 11`, covering Minecraft's 5-tick shield warm-up)
 *   for aerial dive smashes, close Wind Burst bounce chains, and grounded Breach swaps.
 * - Detects Axe Stun-Slam dive bait (`dy >= 1.2 && vy < -0.08` holding an Axe) so the bot
 *   drops shield & sidesteps the stun instead of eating a 5s shield disable.
 * - Flags `postImpactWindow` right after impact/landing for zero-delay counter-punish.
 */
function detectIncomingMaceAttack(bot, target, targetState = null, weaponCooldownProgress = 1.0) {
  const empty = {
    threat: false,
    shouldShield: false,
    antiStunBait: false,
    postImpactWindow: false,
    reason: 'none',
    estTicks: Infinity,
    horizDist: Infinity,
    dist3D: Infinity,
    dy: 0,
    vy: 0
  };
  if (!bot || !bot.entity || !bot.entity.position || !target || !target.position) {
    return empty;
  }

  const state = targetState || buildTargetState(target);
  const botPos = bot.entity.position;
  const tPos = target.position;
  const vel = (state && state.velocity) || target.velocity || { x: 0, y: 0, z: 0 };

  const dx = botPos.x - tPos.x;
  const dy = tPos.y - botPos.y;
  const dz = botPos.z - tPos.z;
  const vy = typeof vel.y === 'number' ? vel.y : 0;
  const horizDist = Math.sqrt(dx * dx + dz * dz);
  const dist3D = Math.sqrt(dx * dx + dy * dy + dz * dz);

  const closingSpeed = horizDist > 0.05
    ? ((vel.x || 0) * (dx / horizDist) + (vel.z || 0) * (dz / horizDist))
    : 1.0;

  const enemyHeld = target.heldItem || (Array.isArray(target.equipment) ? target.equipment[0] : null);
  const enemyHeldName = enemyHeld && enemyHeld.name ? String(enemyHeld.name).toLowerCase() : '';
  const holdingMace = enemyHeldName === 'mace';
  const holdingAxe = enemyHeldName.endsWith('_axe');
  const isGliding = Boolean((state && state.isGliding) || target.elytraFlying);

  const estTicks = dy <= 3.0
    ? 2
    : Math.min(20, (dy - 2.2) / Math.max(0.15, Math.abs(vy) + 0.16));

  // Anti-Stun-Slam Bait: diving attacker switched to Axe to disable our shield -> drop & sidestep
  if (dy >= 1.2 && vy < -0.08 && holdingAxe && horizDist <= 6.5) {
    return {
      threat: true,
      shouldShield: false,
      antiStunBait: true,
      postImpactWindow: false,
      reason: 'axe_stun_bait',
      estTicks,
      horizDist,
      dist3D,
      dy,
      vy
    };
  }

  const maceContext = holdingMace || isMaceDuelContext(bot, target);

  // 1. Aerial dive / Elytra-Mace smash approaching pre-impact window
  const diveWindow = Boolean(
    maceContext &&
    dy >= 1.4 &&
    (vy <= -0.14 || isGliding) &&
    (horizDist <= 4.5 || (horizDist <= 8.0 && closingSpeed > 0.04)) &&
    estTicks <= 11
  );

  // 2. Close Wind Burst / Wind Charge bounce smash chain
  const bounceWindow = Boolean(
    holdingMace &&
    (!target.onGround || dy >= 1.1) &&
    vy < -0.04 &&
    dist3D <= 5.8
  );

  // 3. Grounded Breach Mace pressure while our weapon is on cooldown
  const groundBreachWindow = Boolean(
    holdingMace &&
    dist3D <= 4.0 &&
    weaponCooldownProgress < 0.85
  );

  let shouldShield = false;
  let reason = 'none';
  if (diveWindow) {
    shouldShield = true;
    reason = 'mace_dive_smash';
  } else if (bounceWindow) {
    shouldShield = true;
    reason = 'mace_bounce_smash';
  } else if (groundBreachWindow) {
    shouldShield = true;
    reason = 'mace_ground_breach';
  }

  const postImpactWindow = Boolean(
    !shouldShield &&
    (target.onGround || (dy < 1.1 && vy >= -0.05))
  );

  return {
    threat: shouldShield,
    shouldShield,
    antiStunBait: false,
    postImpactWindow,
    reason,
    estTicks,
    horizDist,
    dist3D,
    dy,
    vy
  };
}

module.exports = {
  ELYTRA_MAX_DURABILITY,
  parseItemEnchantments,
  scanWeaponEnchantments,
  validateArmorInventory,
  selectMaceForFall,
  buildTargetState,
  evaluateShieldCounter,
  hasSlowFalling,
  detectEnemyDiveBomb,
  isMaceDuelContext,
  detectIncomingMaceAttack,
  getElytraDurabilityInfo,
  shouldConserveElytra,
  executeAttributeSwapAttack
};
