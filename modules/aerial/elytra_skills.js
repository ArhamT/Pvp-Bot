'use strict';

const { Vec3 } = require('vec3');
const { clamp, DEG_TO_RAD } = require('../aim');
const {
  TORSO_SLOT,
  HOTBAR_START: DEFAULT_HOTBAR_START,
  PEARL_SPEED,
  PEARL_GRAVITY,
  PEARL_DRAG,
  SWORD_PRIORITY,
  AXE_PRIORITY,
  CHESTPLATE_PRIORITY,
  isSpearItem,
  hasItemEnchant
} = require('../constants');
const {
  scanWeaponEnchantments,
  selectMaceForFall,
  buildTargetState,
  evaluateShieldCounter,
  hasSlowFalling,
  detectEnemyDiveBomb,
  shouldConserveElytra,
  executeAttributeSwapAttack
} = require('../mace_elytra');

const DEFAULT_REACH = 3.0;
const AERIAL_MODES = Object.freeze({
  IDLE: 'IDLE',
  STUN_SLAM: 'STUN_SLAM',
  MACE_LAUNCH: 'MACE_LAUNCH',
  PEARL_CATCH: 'PEARL_CATCH',
  SPEAR_MACE: 'SPEAR_MACE',
  ELYTRA_DIVE: 'ELYTRA_DIVE',
  ELYTRA_SPEAR: 'ELYTRA_SPEAR',
  ELYTRA_BOOST: 'ELYTRA_BOOST',
  DIVE_DODGE: 'DIVE_DODGE',
  SLOW_FALL_EVADE: 'SLOW_FALL_EVADE',
  CLUTCH: 'CLUTCH'
});

const elytraSkillMethods = {
  /**
   * Resolves the protocol-safe `entity_action` actionId for starting Elytra flight.
   * MC 1.21.6+ shifted `start_fall_flying` from 8 to 6 (removing sneaking actions),
   * and `'start_elytra_flying'` is not a valid minecraft-data mapper key on any version.
   */
  _resolveStartFallFlyingActionId() {
    const version = this.bot && this.bot.version;
    if (version) {
      try {
        const mcData = require('minecraft-data')(version);
        const eaSchema = mcData &&
          mcData.protocol &&
          mcData.protocol.play &&
          mcData.protocol.play.toServer &&
          mcData.protocol.play.toServer.types &&
          mcData.protocol.play.toServer.types.packet_entity_action;
        const actionField = Array.isArray(eaSchema) && Array.isArray(eaSchema[1])
          ? eaSchema[1].find((f) => f && f.name === 'actionId')
          : null;
        const mappings = actionField && Array.isArray(actionField.type) && actionField.type[1]
          ? actionField.type[1].mappings
          : null;
        if (mappings && Object.values(mappings).includes('start_fall_flying')) {
          return 'start_fall_flying';
        }
      } catch (_) {}
    }

    const useString = this.bot &&
      typeof this.bot.supportFeature === 'function' &&
      this.bot.supportFeature('entityActionUsesStringMapper');
    return useString ? 'start_fall_flying' : 8;
  },

  /**
   * Version-safe Elytra glide activation across MC 1.20.4–1.21.5 (8 / start_fall_flying)
   * and MC 1.21.6–1.21.11+ (6 / start_fall_flying).
   */
  _sendStartElytraFlying() {
    if (!this.bot || !this.bot._client || typeof this.bot._client.write !== 'function') {
      return false;
    }
    this.bot._client.write('entity_action', {
      entityId: this.bot.entity.id,
      actionId: this._resolveStartFallFlyingActionId(),
      jumpBoost: 0
    });
    return true;
  },

  _canStartElytraDive(target) {
    if (!this.aerialCfg.enableElytraMace) return false;
    if (this.postTeleportWaitTicks > 0) return false;
    if (!target || !target.isValid || !target.position) return false;

    const { inWater, inLava } = this._getEnvironmentFlags();
    if (inWater || inLava) return false;

    // Must carry elytra, chestplate (or already wearing elytra), and mace
    if (!this._hasElytraAvailable()) return false;
    if (!this._hasChestplateAvailable()) return false;
    if (!this._findMace()) return false;

    const minDist = this.aerialCfg.elytraMinDistance !== undefined
      ? this.aerialCfg.elytraMinDistance
      : 20.0;
    const pos = this.bot.entity.position;
    const dist = pos.distanceTo(target.position);
    const horizDist = Math.hypot(target.position.x - pos.x, target.position.z - pos.z);
    const heightAboveTarget = pos.y - target.position.y;
    const velY = this.bot.entity.velocity ? this.bot.entity.velocity.y : 0;

    // Pro High-Tier Airborne Descent Dive: coming down from any high fall (> 4.5b above target) -> glide onto opponent even without rockets!
    const highDescentGlide = !this.bot.entity.onGround &&
      velY < -0.08 &&
      heightAboveTarget >= 4.5 &&
      horizDist >= 4.0;
    if (highDescentGlide) {
      return true;
    }

    if (!this._findItemByName('firework_rocket')) return false;

    const heightAboveGround = this._getHeightAboveGround();
    const afterVerticalLaunch = !this.bot.entity.onGround &&
      dist >= 6.0 &&
      (velY >= 0.55 || (velY > 0.05 && heightAboveGround >= 2.2));

    return dist > minDist || afterVerticalLaunch;
  },

  _enterElytraDive() {
    const boostMin = this.aerialCfg.elytraBoostPitchMinDeg !== undefined
      ? this.aerialCfg.elytraBoostPitchMinDeg
      : 65;
    const boostMax = this.aerialCfg.elytraBoostPitchMaxDeg !== undefined
      ? this.aerialCfg.elytraBoostPitchMaxDeg
      : 75;

    this.mode = AERIAL_MODES.ELYTRA_DIVE;
    this.stage = 'EQUIP_ELYTRA';
    this.stageTicks = 0;
    this.elytraEquipTicks = 0;
    this.takeoffJumped = false;
    this.isGliding = false;
    this.fireworkFired = false;
    this.climbTicksAfterBoost = 0;
    this.boostPitchRad = ((boostMin + boostMax) * 0.5) * DEG_TO_RAD;
  },

  _tickElytraDive(target) {
    this.stageTicks++;

    if (this.stage === 'SWORD_RESTORE') {
      return this._tickSwordRestore();
    }

    if (!target || !target.isValid || !target.position) {
      if (this._shouldTriggerClutch(null, true)) {
        this._enterClutch();
        return this._tickClutch();
      }
      this.cancel();
      return false;
    }

    const pos = this.bot.entity.position;
    const velY = this.bot.entity.velocity ? this.bot.entity.velocity.y : 0;
    const { onGround, inWater } = this._getEnvironmentFlags();
    const reach = this.combatCfg.reach || DEFAULT_REACH;
    const reachDist = this._getReachDistance(target);

    // -----------------------------------------------------------------------
    // Stage 1: EQUIP_ELYTRA — Swap Chestplate (slot 6) with elytra, pre-equip rocket & pitch up
    // -----------------------------------------------------------------------
    if (this.stage === 'EQUIP_ELYTRA') {
      const equipDelay = this.aerialCfg.elytraEquipDelayTicks !== undefined
        ? this.aerialCfg.elytraEquipDelayTicks
        : 2;

      // Aim upward toward target during preparation so rocket fires immediately after jump!
      const dx = target.position.x - pos.x;
      const dz = target.position.z - pos.z;
      const yawToTarget = Math.atan2(-dx, -dz);
      this.aimer.stepTowardsAngles(yawToTarget, 38 * DEG_TO_RAD, { speedMultiplier: 1.5 });

      if (!this.elytraSwappedIn) {
        const torso = this._getTorsoItem();
        if (torso && torso.name && torso.name.endsWith('_chestplate')) {
          this.savedChestplateName = torso.name;
        }

        if (this._isWearingElytra()) {
          this.elytraSwappedIn = true;
          this.elytraEquipTicks = 0;
        } else {
          const elytraSel = this._findItemByName('elytra');
          if (!elytraSel) {
            this.cancel();
            return false;
          }
          if (this._equipTorso(elytraSel.item)) {
            this.elytraSwappedIn = true;
            this.elytraEquipTicks = 0;
          }
          return true;
        }
      }

      // Pre-equip firework_rocket while grounded so zero swap delay happens mid-jump!
      const rocketSel = this._findItemByName('firework_rocket');
      if (rocketSel && !this.swappedThisTick) {
        this._equipHand(rocketSel);
      }

      this.elytraEquipTicks++;
      if (this.elytraEquipTicks >= equipDelay) {
        this.stage = 'TAKEOFF';
        this.stageTicks = 0;
        this.elytraAirborneTicks = 0;
        this.elytraGlideRetrySent = false;
        // Execute takeoff check on this tick (exactly `equipDelay` ticks after swap)
        return this._tickElytraTakeoff(target, onGround);
      }

      return true;
    }

    // -----------------------------------------------------------------------
    // Stage 2: TAKEOFF — Jump if grounded, wait 2 ticks airborne, then send start_elytra_flying
    // -----------------------------------------------------------------------
    if (this.stage === 'TAKEOFF') {
      return this._tickElytraTakeoff(target, onGround);
    }

    // -----------------------------------------------------------------------
    // Stage 3: BOOST_CLIMB — Fire firework_rocket, or Elytra Wind-Boost / B-Hop to conserve rockets
    // -----------------------------------------------------------------------
    if (this.stage === 'BOOST_CLIMB') {
      if (onGround && this.fireworkFired && this.climbTicksAfterBoost > 3) {
        this._restoreChestplate();
        this._resetState();
        return true;
      }
      if (onGround && !this.fireworkFired && this.stageTicks > 4) {
        this._restoreChestplate();
        this._resetState();
        return true;
      }

      const predPos = this._getPredictedPosition(target, 4);
      const dx = predPos.x - pos.x;
      const dz = predPos.z - pos.z;
      const horizDist = Math.sqrt(dx * dx + dz * dz);
      const yawToTarget = Math.atan2(-dx, -dz);

      // Retry start_elytra_flying once if server hasn't acknowledged glide state yet while airborne
      if (!onGround && this.bot.entity.elytraFlying === false && !this.elytraGlideRetrySent && this.stageTicks === 3) {
        this._sendStartElytraFlying();
        this.elytraGlideRetrySent = true;
      }

      // Elytra Wind-Charge Boost (snap down -> fire wind_charge -> snap up on next tick)
      if (
        !onGround &&
        this.aerialCfg.elytraWindBoostEnabled !== false &&
        this.stageTicks === 2 &&
        this._findItemByName('wind_charge')
      ) {
        const windSel = this._findItemByName('wind_charge');
        if (windSel && typeof windSel.hotbarIndex === 'number' && windSel.hotbarIndex >= 0 && typeof this.bot.setQuickBarSlot === 'function') {
          this.bot.setQuickBarSlot(windSel.hotbarIndex);
        }
        this.aimer.stepTowardsAngles(yawToTarget, -Math.PI / 2, { force: true });
        if (typeof this.bot.activateItem === 'function') {
          this.bot.activateItem(false);
        }
        this.fireworkFired = true;
        this.climbTicksAfterBoost = 0;
        return true;
      }

      const aimStatus = this.aimer.stepTowardsAngles(yawToTarget, this.boostPitchRad, {
        speedMultiplier: 1.75,
        toleranceRad: 0.16,
        force: true
      });

      if (!this.fireworkFired) {
        const rocketSel = this._findItemByName('firework_rocket');
        if (!rocketSel) {
          this.stage = 'DIVE';
          this.stageTicks = 0;
          return true;
        }

        const eq = this._equipHand(rocketSel);
        const currentPitchDeg = this.bot.entity.pitch / DEG_TO_RAD;
        if (eq.ready && !eq.swapped && (currentPitchDeg >= 22 || aimStatus.pitchErrorDeg <= 10 || this.stageTicks >= 3)) {
          if (typeof this.bot.activateItem === 'function') {
            this.bot.activateItem(false);
          }
          this.fireworkFired = true;
          this.lastRocketTime = Date.now();
          this.climbTicksAfterBoost = 0;
        }
        return true;
      }

      // B-Hopping height preservation (pitch oscillation without spending extra rockets/wind charges)
      if (this.aerialCfg.bHopEnabled !== false && this.climbTicksAfterBoost > 0 && this.climbTicksAfterBoost % 5 === 0) {
        const oscPitch = (this.climbTicksAfterBoost % 10 === 0) ? -25 * DEG_TO_RAD : this.boostPitchRad;
        this.aimer.stepTowardsAngles(yawToTarget, oscPitch, { force: true });
      }

      this.climbTicksAfterBoost++;
      const heightAboveTarget = pos.y - predPos.y;
      const readyToDive =
        heightAboveTarget >= 10.0 ||
        (heightAboveTarget >= 5.0 && horizDist <= 10.0) ||
        this.climbTicksAfterBoost >= 14;

      if (readyToDive) {
        this.stage = 'DIVE';
        this.stageTicks = 0;
      }
      return true;
    }

    // -----------------------------------------------------------------------
    // Stage 4: DIVE — Steer above predicted XZ, conserve low-durability Elytra, pitch -75 to -85 deg
    // -----------------------------------------------------------------------
    if (this.stage === 'DIVE') {
      if (onGround || inWater) {
        this._restoreChestplate();
        this.stage = 'SWORD_RESTORE';
        return true;
      }

      const predPos = this._getPredictedPosition(target, 4);
      const dx = predPos.x - pos.x;
      const dz = predPos.z - pos.z;
      const horizDist = Math.sqrt(dx * dx + dz * dz);
      const heightAboveTarget = pos.y - predPos.y;
      const strikeHeight = this.aerialCfg.elytraStrikeHeight !== undefined
        ? this.aerialCfg.elytraStrikeHeight
        : 3.5;

      // Elytra durability conservation: alternate Chestplate / Elytra mid-flight when remaining < threshold
      const conserveInfo = shouldConserveElytra(this.bot, this.aerialCfg.elytraConserveThreshold || 50);
      if (conserveInfo.low && this._hasChestplateAvailable()) {
        this.elytraConserveTicks++;
        const mod = this.elytraConserveTicks % 5;
        if (mod === 1 && this._isWearingElytra()) {
          this._restoreChestplate(true);
        } else if (mod === 4 && !this._isWearingElytra()) {
          const elySel = this._findItemByName('elytra');
          if (elySel) {
            this._equipTorso(elySel.item, true);
            this._sendStartElytraFlying();
          }
        }
      }

      // Transition to Stage 5 (STRIKE) once <= 3.5 blocks above target
      if (heightAboveTarget <= strikeHeight && (horizDist <= 6.0 || reachDist <= 5.0)) {
        this.stage = 'STRIKE_CHESTPLATE';
        this.stageTicks = 0;
        return this._tickElytraStrikeChestplate(target);
      }

      if (heightAboveTarget <= strikeHeight && horizDist > 6.0 && this._shouldTriggerClutch(target, true)) {
        this._enterClutch();
        return this._tickClutch();
      }

      const yawToPred = Math.atan2(-dx, -dz);
      const diveMinRad = (this.aerialCfg.elytraDivePitchMinDeg !== undefined
        ? this.aerialCfg.elytraDivePitchMinDeg
        : -85) * DEG_TO_RAD;
      const diveMaxRad = (this.aerialCfg.elytraDivePitchMaxDeg !== undefined
        ? this.aerialCfg.elytraDivePitchMaxDeg
        : -75) * DEG_TO_RAD;

      let targetPitchRad;
      if (horizDist > Math.max(12.0, heightAboveTarget * 1.15)) {
        const directPitch = Math.atan2((predPos.y + 4.0) - pos.y, Math.max(0.1, horizDist));
        targetPitchRad = clamp(directPitch, diveMaxRad, -15 * DEG_TO_RAD);
      } else {
        const steepPitch = Math.atan2(predPos.y - pos.y, Math.max(0.1, horizDist));
        targetPitchRad = clamp(steepPitch, diveMinRad, diveMaxRad);
      }

      this.aimer.stepTowardsAngles(yawToPred, targetPitchRad, {
        speedMultiplier: 1.65,
        toleranceRad: 0.16,
        force: true
      });

      return true;
    }

    // -----------------------------------------------------------------------
    // Stage 5a: STRIKE_CHESTPLATE — Swap Chestplate back into slot 6
    // -----------------------------------------------------------------------
    if (this.stage === 'STRIKE_CHESTPLATE') {
      return this._tickElytraStrikeChestplate(target);
    }

    // -----------------------------------------------------------------------
    // Stage 5b: STRIKE_EQUIP_MACE — Equip Density Mace on next tick
    // -----------------------------------------------------------------------
    if (this.stage === 'STRIKE_EQUIP_MACE') {
      this._aimAtTarget(target, 1, { speedMultiplier: 1.5, toleranceRad: 0.28, force: true });
      const maceSel = this._findDensityMace();
      if (maceSel) {
        this._equipHand(maceSel);
      }
      this.stage = 'STRIKE_SMASH';
      return true;
    }

    // -----------------------------------------------------------------------
    // Stage 5c: STRIKE_SMASH — Flight Crit Density Mace Smash (<= 3.0b) + Shield Stun-Slam + Loop
    // -----------------------------------------------------------------------
    if (this.stage === 'STRIKE_SMASH') {
      if (onGround || inWater) {
        this.stage = 'SWORD_RESTORE';
        return this._tickSwordRestore();
      }

      const aimStatus = this._aimAtTarget(target, 1, {
        speedMultiplier: 1.6,
        toleranceRad: 0.28,
        force: true
      });

      // Shield counter: stun-slam with Axe -> Density Mace if opponent shields frontally
      const counter = evaluateShieldCounter(this.bot, this.targetState, {
        hasAxe: Boolean(this._findAxe()),
        hasMace: Boolean(this._findDensityMace()),
        isAirborne: !onGround,
        isGliding: false
      });
      if (counter.strategy === 'STUN_SLAM' && reachDist <= 3.8) {
        this.mode = AERIAL_MODES.STUN_SLAM;
        this.stage = 'AXE_BREAK';
        this.stageTicks = 0;
        this.stunSlamAxeSwapped = false;
        return this._tickStunSlam(target);
      }

      const maceSel = this._findDensityMace();
      let holdingMace = maceSel ? this._isHoldingSelection(maceSel) : false;
      if (!holdingMace && maceSel) {
        const eq = this._equipHand(maceSel);
        holdingMace = eq.ready && !eq.swapped;
      }

      if (holdingMace && reachDist <= reach + 0.25 && aimStatus.aligned) {
        if (typeof this.bot.setControlState === 'function') {
          this.bot.setControlState('sprint', false);
        }
        this.bot.attack(target);
        this._resetFallAfterSmash();
        // Loop back into Launch/Glide immediately to lock down non-elytra targets
        if (
          this.aerialCfg.loopDiveOnGrounded !== false &&
          this.targetState &&
          !this.targetState.isGliding &&
          this._hasElytraAvailable() &&
          this._findItemByName('firework_rocket')
        ) {
          this._enterElytraDive();
          return true;
        }
        this.stage = 'SWORD_RESTORE';
        return true;
      }

      // Stage 6 (CLUTCH): Missed smash while descending with lethal fallDistance near ground
      if (velY < -0.05 && this._shouldTriggerClutch(target, true)) {
        this._enterClutch();
        return this._tickClutch();
      }

      // Safety timeout
      if (this.stageTicks > 30) {
        this.stage = 'SWORD_RESTORE';
        return this._tickSwordRestore();
      }

      return true;
    }

    return false;
  },

  _tickElytraTakeoff(target, onGround) {
    const pos = this.bot.entity.position;
    const dx = target.position.x - pos.x;
    const dz = target.position.z - pos.z;
    const yawToTarget = Math.atan2(-dx, -dz);
    const velY = this.bot.entity.velocity ? this.bot.entity.velocity.y : 0;

    this.aimer.stepTowardsAngles(yawToTarget, 38 * DEG_TO_RAD, { speedMultiplier: 1.55, force: true });

    // Pre-equip rocket if not already held so BOOST_CLIMB ignites without delay
    const rocketSel = this._findItemByName('firework_rocket');
    if (rocketSel && !this.swappedThisTick) {
      this._equipHand(rocketSel);
    }

    if (this.bot.entity.elytraFlying) {
      this.isGliding = true;
      this.stage = 'BOOST_CLIMB';
      this.stageTicks = 0;
      return true;
    }

    if (onGround) {
      this.elytraAirborneTicks = 0;
      if (this.stageTicks > 15) {
        this._restoreChestplate();
        this._resetState();
        return false;
      }
      if (typeof this.bot.setControlState === 'function') {
        this.bot.setControlState('forward', true);
        this.bot.setControlState('jump', true);
      }
      this.takeoffJumped = true;
      return true;
    }

    if (typeof this.bot.setControlState === 'function') {
      this.bot.setControlState('jump', false);
    }

    // Wait 2 airborne ticks (or velY <= 0.25) so Paper/GrimAC confirms airborne state before start_elytra_flying
    this.elytraAirborneTicks++;
    if (this.takeoffJumped && this.elytraAirborneTicks < 2 && velY > 0.25) {
      return true;
    }

    this._sendStartElytraFlying();
    this.lastElytraTakeoffTime = Date.now();
    this.isGliding = true;
    this.stage = 'BOOST_CLIMB';
    this.stageTicks = 0;
    return true;
  },

  _tickElytraStrikeChestplate(target) {
    this._aimAtTarget(target, 1, { speedMultiplier: 1.5, toleranceRad: 0.28, force: true });
    this.isGliding = false;
    this._restoreChestplate();
    this.stage = 'STRIKE_EQUIP_MACE';
    return true;
  },

  _canStartElytraSpear(target) {
    if (this.aerialCfg.enableElytraSpear === false) return false;
    if (this.postTeleportWaitTicks > 0) return false;
    if (!target || !target.isValid || !target.position) return false;

    const { onGround, inWater, inLava, inCobweb } = this._getEnvironmentFlags();
    if (inWater || inLava || inCobweb) return false;

    // Must have Elytra (worn or inventory) AND a Spear/Trident — NO Mace or Chestplate required!
    if (!this._hasElytraAvailable()) return false;
    if (!this._findSpear()) return false;

    const alreadyFlying = Boolean(this.bot.entity.elytraFlying);
    if (alreadyFlying) return true;

    const hasRockets = Boolean(this._findItemByName('firework_rocket'));
    const heightAboveGround = this._getHeightAboveGround();
    if (!hasRockets && (onGround || heightAboveGround < 3.0)) {
      return false;
    }

    const now = Date.now();
    const takeoffCooldown = this.aerialCfg.elytraTakeoffCooldownMs !== undefined
      ? this.aerialCfg.elytraTakeoffCooldownMs
      : 1200;
    if (onGround && (now - this.lastElytraTakeoffTime) < takeoffCooldown) {
      return false;
    }

    if (onGround && !this._hasClearSkyAbove(4)) {
      return false;
    }

    const dist = this.bot.entity.position.distanceTo(target.position);
    const hasMace = Boolean(this._findMace());
    // In dedicated Elytra Spear kits (no Mace), take off aggressively even at close range (>= 2.5b)!
    const minDist = hasMace
      ? (this.aerialCfg.elytraSpearMinDistance !== undefined ? this.aerialCfg.elytraSpearMinDistance : 6.0)
      : (this.aerialCfg.elytraSpearMinDistance !== undefined ? Math.min(3.5, this.aerialCfg.elytraSpearMinDistance) : 2.5);

    return dist >= minDist || !onGround;
  },

  _enterElytraSpear() {
    this.mode = AERIAL_MODES.ELYTRA_SPEAR;
    this.stage = this.bot.entity.elytraFlying ? 'FLY_APPROACH' : 'EQUIP_PREP';
    this.stageTicks = 0;
    this.elytraEquipTicks = 0;
    this.takeoffJumped = false;
    this.isGliding = Boolean(this.bot.entity.elytraFlying);
    this.fireworkFired = false;
    this.elytraAirborneTicks = 0;
    this.elytraFlightTicks = 0;
    this.elytraGlideRetrySent = false;
    this.elytraSpearCharging = false;
    this.elytraSpearAttackNextTick = false;
  },

  _releaseSpearChargeIfActive() {
    if (this.elytraSpearCharging) {
      this.elytraSpearCharging = false;
      if (this.bot && typeof this.bot.deactivateItem === 'function') {
        try {
          this.bot.deactivateItem();
        } catch (_) {}
      }
    }
  },

  _tickElytraSpear(target) {
    this.stageTicks++;

    if (!target || !target.isValid || !target.position) {
      this._releaseSpearChargeIfActive();
      this._resetState();
      return false;
    }

    const pos = this.bot.entity.position;
    const vel = this.bot.entity.velocity || new Vec3(0, 0, 0);
    const velY = vel.y;
    const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
    const { onGround, inWater, inLava, inCobweb } = this._getEnvironmentFlags();

    if (inWater || inLava || inCobweb) {
      this._releaseSpearChargeIfActive();
      this._resetState();
      return false;
    }

    const now = Date.now();
    const rocketCooldownMs = this.aerialCfg.elytraRocketCooldownMs !== undefined
      ? this.aerialCfg.elytraRocketCooldownMs
      : 1600;
    const spearReach = this.combatCfg.spearReach || 4.2;
    const reachDist = this._getReachDistance(target);

    // -----------------------------------------------------------------------
    // Stage 1: EQUIP_PREP — Equip Elytra to torso, pre-equip firework_rocket, pitch up to +32°
    // -----------------------------------------------------------------------
    if (this.stage === 'EQUIP_PREP') {
      const equipDelay = this.aerialCfg.elytraEquipDelayTicks !== undefined
        ? this.aerialCfg.elytraEquipDelayTicks
        : 2;

      const dx = target.position.x - pos.x;
      const dz = target.position.z - pos.z;
      const horizDist = Math.sqrt(dx * dx + dz * dz);
      // If very close on ground, angle slightly away while pitching up so we gain clean takeoff space
      const desiredYaw = horizDist < 4.5
        ? Math.atan2(dx, dz)
        : Math.atan2(-dx, -dz);

      const aimStatus = this.aimer.stepTowardsAngles(desiredYaw, 32 * DEG_TO_RAD, {
        speedMultiplier: 1.65,
        toleranceRad: 0.2
      });

      if (!this._isWearingElytra()) {
        const elytraSel = this._findItemByName('elytra');
        if (!elytraSel) {
          this._resetState();
          return false;
        }
        if (this._equipTorso(elytraSel.item)) {
          this.elytraEquipTicks = 0;
        }
        return true;
      }

      // Pre-equip rocket while still grounded so ignition happens on tick 1 after glide starts
      const rocketSel = this._findItemByName('firework_rocket');
      let rocketReady = true;
      if (rocketSel && !this.swappedThisTick) {
        const eq = this._equipHand(rocketSel);
        rocketReady = eq.ready && !eq.swapped;
      }

      this.elytraEquipTicks++;
      const currentPitchDeg = this.bot.entity.pitch / DEG_TO_RAD;
      if (
        this.elytraEquipTicks >= equipDelay &&
        rocketReady &&
        (currentPitchDeg >= 15 || aimStatus.pitchErrorDeg <= 15 || this.stageTicks >= 6)
      ) {
        this.stage = this.bot.entity.elytraFlying ? 'FLY_APPROACH' : 'TAKEOFF';
        this.stageTicks = 0;
        this.elytraAirborneTicks = 0;
        this.elytraGlideRetrySent = false;
        return true;
      }

      if (this.stageTicks > 18) {
        this._resetState();
        return false;
      }
      return true;
    }

    // -----------------------------------------------------------------------
    // Stage 2: TAKEOFF — Jump off ground, wait 2 airborne ticks, send version-safe start_elytra_flying
    // -----------------------------------------------------------------------
    if (this.stage === 'TAKEOFF') {
      const dx = target.position.x - pos.x;
      const dz = target.position.z - pos.z;
      const horizDist = Math.sqrt(dx * dx + dz * dz);
      const desiredYaw = horizDist < 4.5 ? Math.atan2(dx, dz) : Math.atan2(-dx, -dz);

      this.aimer.stepTowardsAngles(desiredYaw, 32 * DEG_TO_RAD, { speedMultiplier: 1.65 });

      const rocketSel = this._findItemByName('firework_rocket');
      if (rocketSel && !this.swappedThisTick) {
        this._equipHand(rocketSel);
      }

      if (this.bot.entity.elytraFlying) {
        this.isGliding = true;
        this.stage = rocketSel ? 'BOOST_IGNITE' : 'FLY_APPROACH';
        this.stageTicks = 0;
        return true;
      }

      if (onGround) {
        this.elytraAirborneTicks = 0;
        if (this.stageTicks > 15) {
          this.lastElytraTakeoffTime = now;
          this._resetState();
          return false;
        }
        if (typeof this.bot.setControlState === 'function') {
          this.bot.setControlState('forward', true);
          this.bot.setControlState('sprint', false);
          this.bot.setControlState('jump', true);
        }
        this.takeoffJumped = true;
        return true;
      }

      if (typeof this.bot.setControlState === 'function') {
        this.bot.setControlState('jump', false);
        this.bot.setControlState('forward', true);
      }

      this.elytraAirborneTicks++;
      if (this.takeoffJumped && this.elytraAirborneTicks < 2 && velY > 0.25) {
        return true;
      }

      this._sendStartElytraFlying();
      this.lastElytraTakeoffTime = now;
      this.isGliding = true;
      this.elytraFlightTicks = 0;
      this.stage = 'BOOST_IGNITE';
      this.stageTicks = 0;
      return true;
    }

    // -----------------------------------------------------------------------
    // Stage 3: BOOST_IGNITE — Fire initial takeoff firework_rocket immediately while airborne
    // -----------------------------------------------------------------------
    if (this.stage === 'BOOST_IGNITE') {
      if (onGround && this.stageTicks > 2) {
        this.lastElytraTakeoffTime = now;
        this._resetState();
        return false;
      }

      const dx = target.position.x - pos.x;
      const dz = target.position.z - pos.z;
      const yawToTarget = Math.atan2(-dx, -dz);
      this.aimer.stepTowardsAngles(yawToTarget, 28 * DEG_TO_RAD, { speedMultiplier: 1.7 });

      // Retry start_elytra_flying once if server hasn't marked elytraFlying yet
      if (!onGround && this.bot.entity.elytraFlying === false && !this.elytraGlideRetrySent && this.stageTicks === 3) {
        this._sendStartElytraFlying();
        this.elytraGlideRetrySent = true;
      }

      const rocketSel = this._findItemByName('firework_rocket');
      if (!rocketSel) {
        this.stage = 'FLY_APPROACH';
        this.stageTicks = 0;
        return true;
      }

      const eq = this._equipHand(rocketSel);
      if (eq.ready && !eq.swapped) {
        if (typeof this.bot.activateItem === 'function') {
          this.bot.activateItem(false);
        }
        this.fireworkFired = true;
        this.lastRocketTime = now;
        this.stage = 'FLY_APPROACH';
        this.stageTicks = 0;
        return true;
      }

      if (this.stageTicks > 10) {
        this.stage = 'FLY_APPROACH';
        this.stageTicks = 0;
      }
      return true;
    }

    // -----------------------------------------------------------------------
    // Stage 4: FLY_APPROACH — Steer smoothly onto predicted target, boost with rockets, & Spear joust!
    // -----------------------------------------------------------------------
    if (this.stage === 'FLY_APPROACH') {
      this.elytraFlightTicks++;

      if (!this._isWearingElytra()) {
        this._releaseSpearChargeIfActive();
        this._resetState();
        return false;
      }

      // Landed after a flight pass -> reset cleanly so survival/ground combat or fresh takeoff can run
      if (onGround && this.elytraFlightTicks > 5) {
        this._releaseSpearChargeIfActive();
        this._resetState();
        return true;
      }

      const rawDist = pos.distanceTo(target.position);
      const leadTicks = clamp(Math.round(rawDist / 6), 2, 5);
      const predPos = this._getPredictedPosition(target, leadTicks);
      const eyePos = this.aimer ? this.aimer.getEyePosition() : pos.offset(0, 1.2, 0);
      const aimPoint = predPos.offset(0, (target.height || 1.8) * 0.6, 0);

      const dx = aimPoint.x - eyePos.x;
      const dy = aimPoint.y - eyePos.y;
      const dz = aimPoint.z - eyePos.z;
      const horizDist = Math.sqrt(dx * dx + dz * dz);
      const dist3D = Math.sqrt(dx * dx + dy * dy + dz * dz);

      const yawToPred = Math.atan2(-dx, -dz);
      let desiredPitch = Math.atan2(dy, Math.max(0.1, horizDist));

      // Terrain clearance protection: never nosedive into the floor when closing from > 7.5b away
      const heightAboveGround = this._getHeightAboveGround();
      if (heightAboveGround < 2.2 && dist3D > 7.5 && desiredPitch < 8 * DEG_TO_RAD) {
        desiredPitch = 14 * DEG_TO_RAD;
      }
      desiredPitch = clamp(desiredPitch, -55 * DEG_TO_RAD, 55 * DEG_TO_RAD);

      const aimStatus = this.aimer.stepTowardsAngles(yawToPred, desiredPitch, {
        speedMultiplier: 1.85,
        toleranceRad: 0.24
      });

      if (typeof this.bot.setControlState === 'function') {
        this.bot.setControlState('forward', true);
        this.bot.setControlState('back', false);
        this.bot.setControlState('sprint', false);
        this.bot.setControlState('jump', false);
      }

      // 4a. Execute deferred Spear jab on the tick immediately after releasing Spear couch/charge
      const spearSel = this._findSpear();
      if (this.elytraSpearAttackNextTick) {
        this.elytraSpearAttackNextTick = false;
        if (spearSel && this._isHoldingSelection(spearSel) && reachDist <= spearReach + 0.6 && aimStatus.yawErrorDeg < 45) {
          this.bot.attack(target);
        }
        this.elytraPullUpYaw = this.bot.entity.yaw;
        this.stage = 'PULL_UP';
        this.stageTicks = 0;
        return true;
      }

      // 4b. Mid-flight Rocket Boost when distant, slow, or below target (paced by elytraRocketCooldownMs!)
      const rocketSel = this._findItemByName('firework_rocket');
      const wantsBoost = Boolean(
        rocketSel &&
        dist3D > 7.5 &&
        (now - this.lastRocketTime) >= rocketCooldownMs &&
        (speed < 0.78 || pos.y < target.position.y + 1.0 || dist3D > 15.0)
      );

      if (wantsBoost) {
        this._releaseSpearChargeIfActive();
        const eq = this._equipHand(rocketSel);
        if (eq.ready && !eq.swapped) {
          if (typeof this.bot.activateItem === 'function') {
            this.bot.activateItem(false);
          }
          this.lastRocketTime = now;
        }
        return true;
      }

      // 4c. Spear equip, kinetic couch/charge (for *_spear items), & high-speed fly-by strike!
      if (spearSel) {
        const eq = this._equipHand(spearSel);
        const holdingSpear = eq.ready && !eq.swapped;
        const spearName = String(spearSel.item.name || '').toLowerCase();
        const isNativeSpear = spearName.includes('spear') && !spearName.includes('trident');

        if (holdingSpear) {
          // Optional kinetic Spear couch/charge when closing at high velocity (1.21 Spear mechanic)
          if (
            isNativeSpear &&
            this.aerialCfg.elytraSpearChargeEnabled !== false &&
            !this.elytraSpearCharging &&
            dist3D <= 8.5 &&
            dist3D > spearReach + 0.2 &&
            speed >= 0.55 &&
            aimStatus.yawErrorDeg < 26
          ) {
            if (typeof this.bot.activateItem === 'function') {
              this.bot.activateItem(false);
              this.elytraSpearCharging = true;
            }
            return true;
          }

          // Strike window: inside spear reach & aligned
          if (reachDist <= spearReach && aimStatus.yawErrorDeg < 38) {
            if (this.elytraSpearCharging) {
              // Release charge this tick and land melee jab next tick (prevents UseItem+Attack flag!)
              this._releaseSpearChargeIfActive();
              this.elytraSpearAttackNextTick = true;
              return true;
            }
            this.bot.attack(target);
            this.elytraPullUpYaw = this.bot.entity.yaw;
            this.stage = 'PULL_UP';
            this.stageTicks = 0;
            return true;
          }
        }
      }

      // If we flew right past the target and are now moving away at close range, pull up cleanly!
      if (dist3D < 3.0) {
        const radial = (vel.x * dx + vel.z * dz) / Math.max(0.1, horizDist);
        if (radial < -0.1) {
          this._releaseSpearChargeIfActive();
          this.elytraPullUpYaw = this.bot.entity.yaw;
          this.stage = 'PULL_UP';
          this.stageTicks = 0;
          return true;
        }
      }

      return true;
    }

    // -----------------------------------------------------------------------
    // Stage 5: PULL_UP — Climb smoothly to +32°, boost if slow/low, then loop back to FLY_APPROACH
    // -----------------------------------------------------------------------
    if (this.stage === 'PULL_UP') {
      this._releaseSpearChargeIfActive();

      if (onGround && this.stageTicks > 2) {
        this._resetState();
        return true;
      }

      const heightAboveGround = this._getHeightAboveGround();
      const dx = target.position.x - pos.x;
      const dz = target.position.z - pos.z;
      const horizDist = Math.sqrt(dx * dx + dz * dz);

      this.aimer.stepTowardsAngles(this.elytraPullUpYaw, 32 * DEG_TO_RAD, {
        speedMultiplier: 1.65,
        toleranceRad: 0.22
      });

      if (typeof this.bot.setControlState === 'function') {
        this.bot.setControlState('forward', true);
        this.bot.setControlState('sprint', false);
        this.bot.setControlState('jump', false);
      }

      // Boost during pull-up if losing speed or near terrain so we stay aloft smoothly
      const rocketSel = this._findItemByName('firework_rocket');
      if (
        rocketSel &&
        (now - this.lastRocketTime) >= rocketCooldownMs &&
        (speed < 0.65 || heightAboveGround < 4.5)
      ) {
        const eq = this._equipHand(rocketSel);
        if (eq.ready && !eq.swapped) {
          if (typeof this.bot.activateItem === 'function') {
            this.bot.activateItem(false);
          }
          this.lastRocketTime = now;
        }
      }

      // Loop back onto the opponent for the next high-speed Spear fly-by!
      if (this.stageTicks >= 12 || (this.stageTicks >= 7 && horizDist >= 11.0 && heightAboveGround >= 4.5)) {
        this.stage = 'FLY_APPROACH';
        this.stageTicks = 0;
      }
      return true;
    }

    return false;
  },

  /**
   * Elytra Wind-Charge Boost & B-Hopping height preservation loop.
   */
  _tickElytraBoost(target) {
    this.stageTicks++;
    const { onGround, inWater } = this._getEnvironmentFlags();
    if (onGround || inWater || this.stageTicks > 20) {
      this._resetState();
      return false;
    }

    const yaw = (target && target.position)
      ? Math.atan2(-(target.position.x - this.bot.entity.position.x), -(target.position.z - this.bot.entity.position.z))
      : this.bot.entity.yaw;

    if (this.stage === 'BOOST_SNAP_DOWN') {
      const windSel = this._findItemByName('wind_charge');
      if (windSel) {
        const eq = this._equipHand(windSel);
        this.aimer.stepTowardsAngles(yaw, -Math.PI / 2, { force: true });
        if (eq.ready && !eq.swapped) {
          if (typeof this.bot.activateItem === 'function') {
            this.bot.activateItem(false);
          }
          this.stage = 'BOOST_SNAP_UP';
        }
        return true;
      }
      this.stage = 'BOOST_SNAP_UP';
    }

    this.aimer.stepTowardsAngles(yaw, 65 * DEG_TO_RAD, { force: true });
    this.bHopTicks++;
    if (this.bHopTicks >= 4) {
      this._resetState();
    }
    return true;
  }
};

module.exports = { elytraSkillMethods };
