'use strict';

const { Vec3 } = require('vec3');
const { clamp } = require('./aim');
const {
  HOTBAR_START,
  OFFHAND_SLOT,
  SWORD_PRIORITY,
  hasItemEnchant
} = require('./constants');
const {
  findVisiblePlacementRef,
  findVisibleBlockFace
} = require('./placement_los');
const { BlockMiner } = require('./mining');
const {
  CRYSTAL_POWER,
  ANCHOR_POWER
} = require('./burst/shared');
const { blastCalcMethods } = require('./burst/blast_calc');
const { burstDefenseMethods } = require('./burst/defense');
const { cpvpFootworkMethods } = require('./burst/cpvp_footwork');
const {
  isTargetInSurround,
  planSurroundPressurePlacement,
  surroundCityMethods
} = require('./burst/surround_city');
const { hitCrystalMethods } = require('./burst/hit_crystal');
const { crystalSkillMethods } = require('./burst/crystal_skill');
const { anchorSkillMethods } = require('./burst/anchor_skill');
const { windChargeSkillMethods } = require('./burst/wind_charge_skill');
const { cpvpMobilityMethods } = require('./burst/cpvp_mobility');

class BurstModule {
  constructor(bot, config, aimer, prediction = null, combat = null) {
    this.bot = bot;
    this.config = config || {};
    this.burstCfg = (config && config.burst) || {};
    this.aimer = aimer;
    this.prediction = prediction;
    this.combat = combat;
    this.miner = new BlockMiner(bot, aimer);

    const tickRateMs = (config && config.physics && config.physics.tickRateMs) || 50;
    const placeDelayMs = this.burstCfg.crystalPlaceDelayMs !== undefined ? this.burstCfg.crystalPlaceDelayMs : 50;
    this.placeDelayTicks = Math.max(1, Math.round(placeDelayMs / tickRateMs));

    // Offensive burst state machine
    // IDLE | CRYSTAL_COVER | CRYSTAL_PLACE_OBSIDIAN | CRYSTAL_PLACE_CRYSTAL | CRYSTAL_DETONATE
    // | ANCHOR_PLACE | ANCHOR_CHARGE | ANCHOR_SWITCH_SLOT | ANCHOR_SHIELD_COVER | ANCHOR_DETONATE
    // | WIND_AIM_LAUNCH | WIND_FIRE | WIND_ASCENDING | WIND_DESCENDING | WIND_CLUTCH
    this.state = 'IDLE';
    this.activePlan = null;
    this.stateTicks = 0;
    this.stepDelayTicks = 0;
    this.equipBusy = false;

    // Cooldowns & CPvP unstick mobility state
    this.lastCrystalTime = 0;
    this.lastHitCrystalTime = 0;
    this.hitCrystalTarget = null;
    this.lastAnchorTime = 0;
    this.lastWindChargeTime = 0;
    this.lastCpvpPearlAt = 0;
    this.cpvpStuckTicks = 0;
    this.lastCpvpPos = null;
    this.cpvpDigging = false;
    this.cpvpDigStartedAt = 0;
    this.lastTargetId = null;
    this.totemPopPunishUntil = 0;
    this.targetTotemPopCount = 0;

    // Offensive shield/sneak state (used during anchor detonation)
    this.anchorShieldRaised = false;

    // Anti-explosive defensive state machine
    // IDLE | DEFENSE_BLOCK | DEFENSE_SHIELD
    this.defenseState = 'IDLE';
    this.activeThreat = null;
    this.defensePlan = null;
    this.defenseTicksRemaining = 0;
    this.defenseShieldRaised = false;

    // Track our own recent placements, failed anchors, and recently defended threats
    this.ownPlacements = new Map();
    this.failedAnchors = new Map();
    this.defendedThreats = new Map();

    // Real fall-distance tracking for Wind Charge Mace & Clutch
    this.fallDistance = 0;
    this.lastBotY = (bot && bot.entity && bot.entity.position) ? bot.entity.position.y : null;
    this.windLaunchStartY = 0;
    this.windPeakY = 0;
    this.clutchFired = false;

    // Bind world/entity event listeners (including entityStatus=35 Totem-Pop detection)
    this._onBlockUpdate = this._handleBlockUpdate.bind(this);
    this._onEntitySpawn = this._handleEntitySpawn.bind(this);
    this._onEntityStatus = this._handleEntityStatus.bind(this);
    if (this.bot && typeof this.bot.on === 'function') {
      this.bot.on('blockUpdate', this._onBlockUpdate);
      this.bot.on('entitySpawn', this._onEntitySpawn);
      this.bot.on('entityStatus', this._onEntityStatus);
    }
  }

  /**
   * Unbinds all listeners and resets internal state cleanly.
   */
  dispose() {
    if (this.bot && typeof this.bot.removeListener === 'function') {
      this.bot.removeListener('blockUpdate', this._onBlockUpdate);
      this.bot.removeListener('entitySpawn', this._onEntitySpawn);
      this.bot.removeListener('entityStatus', this._onEntityStatus);
    }
    this._clearDefenseState();
    this._resetOffensiveState(true);
    this.ownPlacements.clear();
    this.failedAnchors.clear();
    this.defendedThreats.clear();
  }

  /**
   * Returns true while actively executing an anti-explosive defense, crystal/anchor burst,
   * or wind-charge launch/clutch sequence.
   */
  isBusy() {
    return this.defenseState !== 'IDLE' || this.state !== 'IDLE';
  }

  /**
   * Aborts any non-safety offensive sequence cleanly.
   * Preserves active anti-explosive defense and lethal fall clutches.
   */
  cancel() {
    if (this.miner) this.miner.cancel();
    if (this.state === 'IDLE' || this.state === 'WIND_CLUTCH') {
      return;
    }

    // If airborne mid-launch with lethal fall risk, transition to clutch instead of abandoning
    if (
      (this.state === 'WIND_ASCENDING' || this.state === 'WIND_DESCENDING') &&
      this.bot &&
      this.bot.entity &&
      !this.bot.entity.onGround &&
      (this.fallDistance >= 3.0 || this._getHeightAboveGround() > 3.5) &&
      this._findClutchItem()
    ) {
      this.state = 'WIND_CLUTCH';
      this.stateTicks = 0;
      this.clutchFired = false;
      return;
    }

    this._resetOffensiveState(true);
  }

  _resetOffensiveState(releaseControls = false) {
    if (this.anchorShieldRaised) {
      try { this.bot.deactivateItem(); } catch (_) {}
      this.anchorShieldRaised = false;
    }
    if (releaseControls && this.bot && typeof this.bot.setControlState === 'function') {
      if (this.defenseState === 'IDLE') {
        this.bot.setControlState('sneak', false);
      }
      this.bot.setControlState('jump', false);
      this.bot.setControlState('forward', false);
      this.bot.setControlState('left', false);
      this.bot.setControlState('right', false);
    }
    this.state = 'IDLE';
    this.activePlan = null;
    this.stateTicks = 0;
    this.stepDelayTicks = 0;
    this.clutchFired = false;
  }

  _clearDefenseState() {
    if (this.defenseShieldRaised) {
      try { this.bot.deactivateItem(); } catch (_) {}
      this.defenseShieldRaised = false;
    }
    if (this.bot && typeof this.bot.setControlState === 'function') {
      this.bot.setControlState('sneak', false);
    }
    this.defenseState = 'IDLE';
    this.activeThreat = null;
    this.defensePlan = null;
    this.defenseTicksRemaining = 0;
  }

  _getHotbarStart() {
    return (this.bot && this.bot.inventory && this.bot.inventory.hotbarStart) || HOTBAR_START;
  }

  _getOffhandSlotIndex() {
    if (this.bot && typeof this.bot.getEquipmentDestSlot === 'function') {
      return this.bot.getEquipmentDestSlot('off-hand');
    }
    return OFFHAND_SLOT;
  }

  _getOffhandItem() {
    if (!this.bot || !this.bot.inventory || !this.bot.inventory.slots) return null;
    return this.bot.inventory.slots[this._getOffhandSlotIndex()] || null;
  }

  _findItemInHotbar(predicate) {
    if (!this.bot || !this.bot.inventory || !this.bot.inventory.slots) return null;
    const start = this._getHotbarStart();
    for (let i = 0; i < 9; i++) {
      const item = this.bot.inventory.slots[start + i];
      if (item && predicate(item)) {
        return { item, quickBarSlot: i };
      }
    }
    return null;
  }

  _findItem(nameOrList, hotbarOnly = false) {
    if (!this.bot || !this.bot.inventory) return null;
    const names = Array.isArray(nameOrList) ? nameOrList : [nameOrList];

    for (const name of names) {
      const inHotbar = this._findItemInHotbar((item) => item.name === name);
      if (inHotbar) return inHotbar;
    }

    if (hotbarOnly) return null;

    const allItems = typeof this.bot.inventory.items === 'function' ? this.bot.inventory.items() : [];
    for (const name of names) {
      const found = allItems.find((i) => i && i.name === name);
      if (found) return { item: found, quickBarSlot: -1 };
    }
    return null;
  }

  _findBestMace(hotbarOnly = false) {
    const start = this._getHotbarStart();
    if (this.combat && typeof this.combat.getHotbarSlots === 'function' && this.bot.inventory && this.bot.inventory.slots) {
      const slots = this.combat.getHotbarSlots();
      if (slots && typeof slots.breachMaceSlot === 'number' && slots.breachMaceSlot >= 0) {
        const item = this.bot.inventory.slots[start + slots.breachMaceSlot];
        if (item && item.name === 'mace') {
          return { item, quickBarSlot: slots.breachMaceSlot };
        }
      }
      if (slots && typeof slots.maceSlot === 'number' && slots.maceSlot >= 0) {
        const item = this.bot.inventory.slots[start + slots.maceSlot];
        if (item && item.name === 'mace') {
          return { item, quickBarSlot: slots.maceSlot };
        }
      }
    }

    // Prefer a mace with breach enchantment if present in hotbar
    const breachHotbar = this._findItemInHotbar((item) => item.name === 'mace' && hasItemEnchant(item, 'breach'));
    if (breachHotbar) return breachHotbar;

    return this._findItem('mace', hotbarOnly);
  }

  _findBestSword() {
    if (!this.bot || !this.bot.inventory || !this.bot.inventory.slots) return null;
    const start = this._getHotbarStart();
    if (this.combat && typeof this.combat.getHotbarSlots === 'function') {
      const slots = this.combat.getHotbarSlots();
      if (slots && typeof slots.swordSlot === 'number' && slots.swordSlot >= 0) {
        const item = this.bot.inventory.slots[start + slots.swordSlot];
        if (item && item.name.endsWith('_sword')) {
          return { item, quickBarSlot: slots.swordSlot };
        }
      }
    }
    const kbSword = this._findItemInHotbar((item) => item.name.endsWith('_sword') && hasItemEnchant(item, 'knockback'));
    if (kbSword) return kbSword;
    return this._findItem(SWORD_PRIORITY, false);
  }

  _findVisibleBlockFace(blockPos) {
    const vis = findVisibleBlockFace(this.bot, blockPos, {
      aimer: this.aimer,
      maxReach: 4.5
    });
    return vis ? vis.face : null;
  }

  /**
   * Ensures an item is held in main hand sequentially across ticks.
   * Returns { held: boolean, swappedThisTick: boolean, found: boolean }.
   * Never performs swap + action in the same tick.
   */
  _ensureItemHeld(foundRecord) {
    if (!foundRecord || !foundRecord.item) {
      return { held: false, swappedThisTick: false, found: false };
    }

    const current = this.bot.heldItem;
    if (
      current &&
      current.name === foundRecord.item.name &&
      (foundRecord.quickBarSlot < 0 || this.bot.quickBarSlot === foundRecord.quickBarSlot)
    ) {
      return { held: true, swappedThisTick: false, found: true };
    }

    if (foundRecord.quickBarSlot >= 0 && typeof this.bot.setQuickBarSlot === 'function') {
      this.bot.setQuickBarSlot(foundRecord.quickBarSlot);
      return { held: false, swappedThisTick: true, found: true };
    }

    if (!this.equipBusy && typeof this.bot.equip === 'function') {
      this.equipBusy = true;
      Promise.resolve(this.bot.equip(foundRecord.item, 'hand'))
        .catch(() => {})
        .finally(() => {
          this.equipBusy = false;
        });
      return { held: false, swappedThisTick: true, found: true };
    }

    return { held: false, swappedThisTick: true, found: true };
  }

  _findPlacementRef(airPos) {
    return findVisiblePlacementRef(this.bot, airPos, {
      aimer: this.aimer,
      maxReach: 4.5
    });
  }

  _intersectsEntityHitbox(blockPos, entityPos, height = 1.8) {
    if (!blockPos || !entityPos) return false;
    const minX = entityPos.x - 0.35;
    const maxX = entityPos.x + 0.35;
    const minY = entityPos.y;
    const maxY = entityPos.y + height;
    const minZ = entityPos.z - 0.35;
    const maxZ = entityPos.z + 0.35;

    return (
      blockPos.x < maxX && (blockPos.x + 1) > minX &&
      blockPos.y < maxY && (blockPos.y + 1) > minY &&
      blockPos.z < maxZ && (blockPos.z + 1) > minZ
    );
  }

  _getPredictedTargetFeet(target, leadTicks = 3) {
    if (!target || !target.position) return new Vec3(0, 0, 0);
    if (this.prediction && typeof this.prediction.predictPosition === 'function') {
      const pred = this.prediction.predictPosition(target, leadTicks);
      if (pred && pred.position) return pred.position.clone();
      if (pred && typeof pred.x === 'number') return pred.clone();
    }
    return target.position.clone();
  }

  _getReachDistanceToEntity(entity) {
    if (!this.bot || !this.bot.entity || !entity || !entity.position) return Infinity;
    const eye = this.aimer ? this.aimer.getEyePosition() : this.bot.entity.position.offset(0, 1.62, 0);
    const halfW = 0.3;
    const height = entity.height || 1.8;
    const cx = clamp(eye.x, entity.position.x - halfW, entity.position.x + halfW);
    const cy = clamp(eye.y, entity.position.y, entity.position.y + height);
    const cz = clamp(eye.z, entity.position.z - halfW, entity.position.z + halfW);
    return eye.distanceTo(new Vec3(cx, cy, cz));
  }

  _updateFallDistance() {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) return;
    const pos = this.bot.entity.position;
    const feetBlock = typeof this.bot.blockAt === 'function' ? this.bot.blockAt(pos) : null;
    const inLiquidOrWeb = feetBlock && (
      feetBlock.name === 'water' ||
      feetBlock.name === 'flowing_water' ||
      feetBlock.name === 'lava' ||
      feetBlock.name === 'flowing_lava' ||
      feetBlock.name === 'cobweb'
    );

    if (this.bot.entity.onGround || inLiquidOrWeb) {
      this.fallDistance = 0;
    } else if (this.lastBotY !== null && pos.y < this.lastBotY) {
      this.fallDistance += (this.lastBotY - pos.y);
    }
    this.lastBotY = pos.y;
  }

  _getHeightAboveGround(maxScan = 16) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) return 0;
    if (this.bot.entity.onGround) return 0;
    if (typeof this.bot.blockAt !== 'function') return maxScan;

    const pos = this.bot.entity.position;
    const startY = Math.floor(pos.y);
    for (let dy = 1; dy <= maxScan; dy++) {
      const b = this.bot.blockAt(new Vec3(Math.floor(pos.x), startY - dy, Math.floor(pos.z)));
      if (b && b.boundingBox === 'block') {
        return Math.max(0, pos.y - (startY - dy + 1));
      }
    }
    return maxScan;
  }

  /**
   * 20-TPS offensive burst handler.
   * Returns true if BurstModule handled this tick.
   */
  tick(target) {
    this._updateFallDistance();

    if (!this.bot || !this.bot.entity) {
      this._resetOffensiveState(false);
      return false;
    }

    // Decrement inter-step sequential delay counter once per tick
    if (this.stepDelayTicks > 0) {
      this.stepDelayTicks--;
    }

    // Active lethal-fall clutch always completes regardless of HP or target
    if (this.state === 'WIND_CLUTCH') {
      return this._tickWindClutch();
    }

    // High-priority anti-explosive defense supersedes offensive ticks
    if (this.defenseState !== 'IDLE') {
      return false;
    }

    const minBurstHealth = this._getEffectiveMinBurstHealth();
    if (target && target.id !== undefined) {
      this.lastTargetId = target.id;
    }

    // Continue an active offensive sequence
    if (this.state !== 'IDLE') {
      if (!target || !target.isValid || this.bot.health <= minBurstHealth) {
        this.cancel();
        return this.state === 'WIND_CLUTCH';
      }

      if (this.state === 'CPVP_CITY_MINE') {
        return this._tickCpvpCityMine(target);
      }
      if (this.state.startsWith('CPVP_')) {
        return this._tickCpvpMobility(target);
      }
      if (this.state.startsWith('CRYSTAL_')) {
        return this._tickCrystalState(target);
      }
      if (this.state.startsWith('ANCHOR_')) {
        return this._tickAnchorState(target);
      }
      if (this.state.startsWith('WIND_')) {
        return this._tickWindChargeState(target);
      }
    }

    // IDLE: check preconditions to initiate a new offensive burst
    if (!target || !target.isValid) return false;
    if (this.bot.health <= minBurstHealth) return false;

    const predictedFeet = this._getPredictedTargetFeet(target, 2);
    const targetDist = this.bot.entity.position.distanceTo(target.position);

    // 0. Instant CPvP pop on any existing End Crystal that favors us (with feet blast-shield if needed)
    if (this.burstCfg.crystalEnabled !== false) {
      const popPlan = this._findExistingPoppableCrystal(target, predictedFeet);
      if (popPlan) {
        this.activePlan = {
          kind: 'crystal',
          detonateOnly: true,
          spawnedCrystal: popPlan.entity,
          basePos: popPlan.entity.position.floored().offset(0, -1, 0),
          blastPos: popPlan.entity.position.clone(),
          coverSpot: popPlan.coverSpot,
          chainCount: 0
        };
        this.state = popPlan.coverSpot ? 'CRYSTAL_COVER' : 'CRYSTAL_DETONATE';
        this.stateTicks = 0;
        this.stepDelayTicks = 0;
        return this._tickCrystalState(target);
      }
    }

    // 1. Evaluate BOTH Anchor & Crystal candidates and pick the highest HT1 DPS-per-tick option!
    let bestAnchor = null;
    if (
      this._canUseRespawnAnchor() &&
      this._findItem('respawn_anchor') &&
      this._findItem('glowstone') &&
      targetDist <= (this.burstCfg.anchorMaxRange || 4.0)
    ) {
      bestAnchor = this._findBestAnchorPlacement(target, predictedFeet);
    }

    let bestCrystal = null;
    let wantHitCrystal = false;
    const targetSurrounded = this.burstCfg.surroundPressureEnabled !== false && isTargetInSurround(this.bot, target);

    if (
      this.burstCfg.crystalEnabled !== false &&
      this._findItem('end_crystal') &&
      targetDist <= (this.burstCfg.crystalMaxRange || 4.5)
    ) {
      if (targetSurrounded) {
        bestCrystal = planSurroundPressurePlacement(this, target, predictedFeet);
      }
      if (!bestCrystal) {
        bestCrystal = this._findBestCrystalPlacement(target, predictedFeet);
      }
      // Hit-Crystal launch shines when opponent is grounded & no instant 2-tick existing-obsidian lethal crystal exists
      if ((!bestCrystal || bestCrystal.needsObsidian) && !targetSurrounded && this._canStartHitCrystal(target)) {
        wantHitCrystal = true;
      }
    }

    // 1b. HT1 Surround "City" Mining: if opponent is camped in a 1x1 surround and neither Anchor nor Rim Crystal
    //     deals heavy damage, mine 1 surround block open so the next crystal hits their exposed feet!
    if (
      targetSurrounded &&
      (!bestAnchor || bestAnchor.targetDmg < 7.0) &&
      (!bestCrystal || bestCrystal.targetDmg < 5.0)
    ) {
      const city = this._findSurroundCityBlock(target);
      if (city) {
        this.activePlan = { kind: 'city_mine', cityPos: city.pos.clone() };
        this.state = 'CPVP_CITY_MINE';
        this.stateTicks = 0;
        this.stepDelayTicks = 0;
        return this._tickCpvpCityMine(target);
      }
    }

    const anchorScore = bestAnchor ? this._scoreBurstPlan(bestAnchor, target) : -Infinity;
    const crystalScore = bestCrystal ? this._scoreBurstPlan(bestCrystal, target) : -Infinity;

    // Pick Anchor if it beats Crystal (and isn't outclassed by an instant 2-tick existing-obsidian crystal)
    if (bestAnchor && anchorScore >= crystalScore && !wantHitCrystal) {
      this.activePlan = bestAnchor;
      this.stateTicks = 0;
      this.stepDelayTicks = 0;
      if (bestAnchor.coverSpot) {
        this.state = 'ANCHOR_COVER';
      } else if (bestAnchor.needsPlace) {
        this.state = 'ANCHOR_PLACE';
      } else if (bestAnchor.alreadyCharged) {
        this.state = 'ANCHOR_SWITCH_SLOT';
      } else {
        this.state = 'ANCHOR_CHARGE';
      }
      return this._tickAnchorState(target);
    }

    if (wantHitCrystal && (!bestAnchor || anchorScore < 12.0)) {
      this.activePlan = { kind: 'crystal', isHitCrystal: true };
      this.state = 'CRYSTAL_HIT_LAUNCH';
      this.stateTicks = 0;
      this.stepDelayTicks = 0;
      return this._tickCrystalState(target);
    }

    if (bestCrystal) {
      this.activePlan = bestCrystal;
      this.stateTicks = 0;
      this.stepDelayTicks = 0;
      if (bestCrystal.coverSpot) {
        this.state = 'CRYSTAL_COVER';
      } else if (bestCrystal.needsObsidian) {
        this.state = 'CRYSTAL_PLACE_OBSIDIAN';
      } else {
        this.state = 'CRYSTAL_PLACE_CRYSTAL';
      }
      return this._tickCrystalState(target);
    }

    if (bestAnchor) {
      this.activePlan = bestAnchor;
      this.stateTicks = 0;
      this.stepDelayTicks = 0;
      this.state = bestAnchor.coverSpot
        ? 'ANCHOR_COVER'
        : (bestAnchor.needsPlace ? 'ANCHOR_PLACE' : (bestAnchor.alreadyCharged ? 'ANCHOR_SWITCH_SLOT' : 'ANCHOR_CHARGE'));
      return this._tickAnchorState(target);
    }

    // CPvP mobility & unstick: when stuck/stopped trying to reach opponent with Crystal/Anchor kit,
    // use Ender Pearl, Walk-Jump, or Mine through blocking wall with the appropriate tool!
    if (this._tickCpvpMobility(target)) {
      return true;
    }

    // Optional Wind Charge Mace Launch fallback (only if explicitly enabled)
    if (this.burstCfg.windChargeLaunchEnabled === true && this._canStartWindChargeLaunch(target)) {
      this.activePlan = { kind: 'wind_mace' };
      this.state = 'WIND_AIM_LAUNCH';
      this.stateTicks = 0;
      this.stepDelayTicks = 0;
      return this._tickWindChargeState(target);
    }

    return false;
  }
}

Object.assign(
  BurstModule.prototype,
  blastCalcMethods,
  burstDefenseMethods,
  cpvpFootworkMethods,
  surroundCityMethods,
  hitCrystalMethods,
  crystalSkillMethods,
  anchorSkillMethods,
  windChargeSkillMethods,
  cpvpMobilityMethods
);

module.exports = {
  BurstModule,
  CRYSTAL_POWER,
  ANCHOR_POWER
};
