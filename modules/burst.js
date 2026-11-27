'use strict';

const { Vec3 } = require('vec3');
const { clamp } = require('./aim');
const {
  OFFHAND_SLOT,
  SWORD_PRIORITY,
  clearMovementControls,
  hasItemEnchant
} = require('./constants');
const {
  getHotbarStart,
  findInventoryItem,
  findItemByPredicate,
  ensureItemHeld
} = require('./inventory_utils');
const {
  findVisiblePlacementRef,
  findVisibleBlockFace
} = require('./placement_los');
const { BlockMiner } = require('./mining');
const { CRYSTAL_POWER, ANCHOR_POWER } = require('./burst/shared');
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
const { cpvpMobilityMethods } = require('./burst/cpvp_mobility');

/**
 * Modular HT1 CPvP Coordinator (Crystal PvP, Hit-Crystal, Respawn Anchor, Surround/City Mining,
 * Anti-Explosive Defense, and CPvP Mobility).
 * Wind Charge Mace & Fall Clutch live exclusively in `modules/aerial/` (zero overlap).
 */
class BurstModule {
  constructor(bot, config, aimer, prediction = null, combat = null, survival = null) {
    this.bot = bot;
    this.config = config || {};
    this.burstCfg = (config && config.burst) || {};
    this.aimer = aimer;
    this.prediction = prediction;
    this.combat = combat;
    this.survival = survival;
    this.miner = new BlockMiner(bot, aimer);

    const tickRateMs = (config && config.physics && config.physics.tickRateMs) || 50;
    const placeDelayMs = this.burstCfg.crystalPlaceDelayMs !== undefined ? this.burstCfg.crystalPlaceDelayMs : 50;
    this.placeDelayTicks = Math.max(1, Math.round(placeDelayMs / tickRateMs));

    // Offensive burst state machine
    this.state = 'IDLE';
    this.activePlan = null;
    this.stateTicks = 0;
    this.stepDelayTicks = 0;

    // Cooldowns & CPvP unstick mobility state
    this.lastCrystalTime = 0;
    this.lastHitCrystalTime = 0;
    this.lastAnchorTime = 0;
    this.lastCpvpPearlAt = 0;
    this.cpvpStuckTicks = 0;
    this.lastCpvpPos = null;
    this.lastTargetId = null;
    this.totemPopPunishUntil = 0;
    this.targetTotemPopCount = 0;

    // Anti-explosive defensive state machine
    this.defenseState = 'IDLE';
    this.activeThreat = null;
    this.defensePlan = null;
    this.defenseTicksRemaining = 0;
    this.defenseShieldRaised = false;
    this._lastThreatBlockScanAt = 0;

    // Track our own recent placements, failed anchors, and recently defended threats
    this.ownPlacements = new Map();
    this.failedAnchors = new Map();
    this.defendedThreats = new Map();

    // Bind world/entity event listeners
    this._onBlockUpdate = this._handleBlockUpdate.bind(this);
    this._onEntitySpawn = this._handleEntitySpawn.bind(this);
    this._onEntityStatus = this._handleEntityStatus.bind(this);
    if (this.bot && typeof this.bot.on === 'function') {
      this.bot.on('blockUpdate', this._onBlockUpdate);
      this.bot.on('entitySpawn', this._onEntitySpawn);
      this.bot.on('entityStatus', this._onEntityStatus);
    }
  }

  _enterState(nextState) {
    this.state = nextState;
    this.stateTicks = 0;
  }

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

  notifyTeleport() {
    this.cancel();
  }

  isBusy() {
    return this.defenseState !== 'IDLE' || this.state !== 'IDLE';
  }

  cancel() {
    if (this.miner) this.miner.cancel();
    if (this.state === 'IDLE') return;
    this._resetOffensiveState(true);
  }

  _resetOffensiveState(releaseControls = false) {
    if (releaseControls && this.bot && typeof this.bot.setControlState === 'function') {
      clearMovementControls(this.bot);
      if (this.defenseState === 'IDLE') {
        this.bot.setControlState('sneak', false);
      }
    }
    this.state = 'IDLE';
    this.activePlan = null;
    this.stateTicks = 0;
    this.stepDelayTicks = 0;
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
    return getHotbarStart(this.bot);
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
    return findItemByPredicate(this.bot, predicate, { hotbarOnly: true });
  }

  _findItem(nameOrList, hotbarOnly = false) {
    return findInventoryItem(this.bot, nameOrList, { hotbarOnly });
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

  _ensureItemHeld(foundRecord) {
    if (!foundRecord || !foundRecord.item) {
      return { held: false, swappedThisTick: false, found: false };
    }
    const eq = ensureItemHeld(this.bot, foundRecord);
    return {
      held: eq.held,
      swappedThisTick: eq.swapped || eq.busy,
      found: true
    };
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

  tick(target) {
    if (!this.bot || !this.bot.entity) {
      this._resetOffensiveState(false);
      return false;
    }

    if (this.stepDelayTicks > 0) {
      this.stepDelayTicks--;
    }

    if (this.defenseState !== 'IDLE') {
      return false;
    }

    const minBurstHealth = this._getEffectiveMinBurstHealth();
    if (target && target.id !== undefined) {
      this.lastTargetId = target.id;
    }

    if (this.state !== 'IDLE') {
      if (!target || !target.isValid || this.bot.health <= minBurstHealth) {
        this.cancel();
        return false;
      }

      if (this.state === 'CPVP_CITY_MINE') return this._tickCpvpCityMine(target);
      if (this.state.startsWith('CPVP_')) return this._tickCpvpMobility(target);
      if (this.state.startsWith('CRYSTAL_')) return this._tickCrystalState(target);
      if (this.state.startsWith('ANCHOR_')) return this._tickAnchorState(target);
    }

    if (!target || !target.isValid) return false;
    if (this.bot.health <= minBurstHealth) return false;

    const predictedFeet = this._getPredictedTargetFeet(target, 2);
    const targetDist = this.bot.entity.position.distanceTo(target.position);

    // 0. Instant CPvP pop on any existing End Crystal that favors us
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
        this._enterState(popPlan.coverSpot ? 'CRYSTAL_COVER' : 'CRYSTAL_DETONATE');
        this.stepDelayTicks = 0;
        return this._tickCrystalState(target);
      }
    }

    // 1. Evaluate BOTH Anchor (including already-placed charged anchors on the field!) & Crystal candidates
    let bestAnchor = null;
    if (
      this._canUseRespawnAnchor() &&
      targetDist <= (this.burstCfg.anchorMaxRange || 4.0)
    ) {
      bestAnchor = this._findBestAnchorPlacement(target, predictedFeet);
    }

    let bestCrystal = null;
    let hitCrystalPlan = null;
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
      if ((!bestCrystal || bestCrystal.needsObsidian) && !targetSurrounded) {
        hitCrystalPlan = this._planHitCrystalIfReady(target);
      }
    }

    // 1b. HT1 Surround "City" Mining
    if (
      targetSurrounded &&
      (!bestAnchor || bestAnchor.targetDmg < 7.0) &&
      (!bestCrystal || bestCrystal.targetDmg < 5.0)
    ) {
      const city = this._findSurroundCityBlock(target);
      if (city) {
        this.activePlan = { kind: 'city_mine', cityPos: city.pos.clone() };
        this._enterState('CPVP_CITY_MINE');
        this.stepDelayTicks = 0;
        return this._tickCpvpCityMine(target);
      }
    }

    const anchorScore = bestAnchor ? this._scoreBurstPlan(bestAnchor, target) : -Infinity;
    const crystalScore = bestCrystal ? this._scoreBurstPlan(bestCrystal, target) : -Infinity;

    if (bestAnchor && anchorScore >= crystalScore && !hitCrystalPlan) {
      this.activePlan = bestAnchor;
      this.stepDelayTicks = 0;
      this._enterState(
        bestAnchor.coverSpot
          ? 'ANCHOR_COVER'
          : (bestAnchor.needsPlace ? 'ANCHOR_PLACE' : (bestAnchor.alreadyCharged ? 'ANCHOR_SWITCH_SLOT' : 'ANCHOR_CHARGE'))
      );
      return this._tickAnchorState(target);
    }

    if (hitCrystalPlan && (!bestAnchor || anchorScore < 12.0)) {
      this.activePlan = { kind: 'crystal', isHitCrystal: true, cachedTrajectory: hitCrystalPlan };
      this._enterState('CRYSTAL_HIT_LAUNCH');
      this.stepDelayTicks = 0;
      return this._tickCrystalState(target);
    }

    if (bestCrystal) {
      this.activePlan = bestCrystal;
      this.stepDelayTicks = 0;
      this._enterState(
        bestCrystal.coverSpot
          ? 'CRYSTAL_COVER'
          : (bestCrystal.needsObsidian ? 'CRYSTAL_PLACE_OBSIDIAN' : 'CRYSTAL_PLACE_CRYSTAL')
      );
      return this._tickCrystalState(target);
    }

    if (bestAnchor) {
      this.activePlan = bestAnchor;
      this.stepDelayTicks = 0;
      this._enterState(
        bestAnchor.coverSpot
          ? 'ANCHOR_COVER'
          : (bestAnchor.needsPlace ? 'ANCHOR_PLACE' : (bestAnchor.alreadyCharged ? 'ANCHOR_SWITCH_SLOT' : 'ANCHOR_CHARGE'))
      );
      return this._tickAnchorState(target);
    }

    if (this._tickCpvpMobility(target)) {
      return true;
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
  cpvpMobilityMethods
);

module.exports = {
  BurstModule,
  CRYSTAL_POWER,
  ANCHOR_POWER
};
