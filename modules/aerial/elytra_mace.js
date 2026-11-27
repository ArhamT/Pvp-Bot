'use strict';

const { Vec3 } = require('vec3');
const { clamp, DEG_TO_RAD } = require('../aim');
const { hasItemEnchant } = require('../constants');
const { shouldConserveElytra } = require('../mace_elytra');
const { DEFAULT_REACH, AERIAL_MODES } = require('./constants');

/**
 * Dedicated Elytra Mace Dive & Elytra Wind-Boost skill (`modules/aerial/elytra_mace.js`):
 * 1. Sequential Chestplate -> Elytra torso swap + rocket pre-equip
 * 2. Version-safe start_fall_flying takeoff -> steep HT1 rocket climb (+66..+76°)
 * 3. Guided 3D intercept dive + mid-glide Density Mace pre-equip + Elytra durability conservation
 * 4. Sequential Chestplate restore -> Density Mace Smash (with Shield Stun-Slam & Wind Burst chain)
 * 5. Instant re-dive loop on grounded targets & fall-damage clutch on miss
 */
const elytraMaceMethods = {
  _canStartElytraDive(target) {
    if (!this.aerialCfg.enableElytraMace) return false;
    if (this.postTeleportWaitTicks > 0) return false;
    if (!target || !target.isValid || !target.position) return false;

    const { inWater, inLava } = this._getEnvironmentFlags();
    if (inWater || inLava) return false;

    // Must carry healthy elytra, chestplate (or already wearing elytra), and mace
    if (!this._hasElytraAvailable()) return false;
    const conserveInfo = shouldConserveElytra(this.bot, Math.min(12, this.aerialCfg.elytraConserveThreshold || 50));
    if (conserveInfo.low && conserveInfo.remaining <= 8) return false;
    if (!this._hasChestplateAvailable()) return false;
    if (!this._findMace()) return false;

    const minDist = this.aerialCfg.elytraMinDistance !== undefined
      ? this.aerialCfg.elytraMinDistance
      : 6.0;
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

    const now = Date.now();
    const takeoffCooldown = this.aerialCfg.elytraTakeoffCooldownMs !== undefined
      ? this.aerialCfg.elytraTakeoffCooldownMs
      : 900;
    if (this.bot.entity.onGround && (now - this.lastElytraTakeoffTime) < takeoffCooldown) {
      return false;
    }

    // Never rocket-takeoff under a low ceiling
    if (this.bot.entity.onGround && !this._hasClearSkyAbove(5)) {
      return false;
    }

    const heightAboveGround = this._getHeightAboveGround();
    const afterVerticalLaunch = !this.bot.entity.onGround &&
      dist >= 4.0 &&
      (velY >= 0.45 || (velY > 0.05 && heightAboveGround >= 2.0));

    return dist >= minDist || afterVerticalLaunch;
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
    // Stage 3: BOOST_CLIMB — HT1 Rocket Climb (+66..+76 deg) to lethal Density altitude
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
      const rocketSel = this._findItemByName('firework_rocket');

      // Retry start_elytra_flying once if server hasn't acknowledged glide state yet while airborne
      if (!onGround && this.bot.entity.elytraFlying === false && !this.elytraGlideRetrySent && this.stageTicks === 3) {
        this._sendStartElytraFlying();
        this.elytraGlideRetrySent = true;
      }

      // Wind-Charge boost fallback when NO firework_rocket is available (packet-safe 1-tick equip settle)
      if (
        !onGround &&
        !rocketSel &&
        !this.fireworkFired &&
        this.aerialCfg.elytraWindBoostEnabled !== false &&
        this.stageTicks >= 1 &&
        this.stageTicks <= 4 &&
        this._findItemByName('wind_charge')
      ) {
        const windSel = this._findItemByName('wind_charge');
        const eq = this._equipHand(windSel);
        this.aimer.stepTowardsAngles(yawToTarget, -Math.PI / 2, { force: true });
        if (eq.ready && !eq.swapped && typeof this.bot.activateItem === 'function') {
          this.bot.activateItem(false);
          this.fireworkFired = true;
          this.climbTicksAfterBoost = 0;
        }
        return true;
      }

      // Steep HT1 rocket climb pitch (+66..+76 deg) facing target XZ so we rise fast right over them
      const climbPitchRad = horizDist > 16.0 ? 48 * DEG_TO_RAD : this.boostPitchRad;
      const aimStatus = this.aimer.stepTowardsAngles(yawToTarget, climbPitchRad, {
        speedMultiplier: 2.0,
        toleranceRad: 0.16,
        force: true
      });

      if (!this.fireworkFired) {
        if (!rocketSel) {
          this.stage = 'DIVE';
          this.stageTicks = 0;
          return true;
        }

        const eq = this._equipHand(rocketSel);
        const currentPitchDeg = this.bot.entity.pitch / DEG_TO_RAD;
        if (eq.ready && !eq.swapped && (currentPitchDeg >= 30 || aimStatus.pitchErrorDeg <= 12 || this.stageTicks >= 2)) {
          if (typeof this.bot.activateItem === 'function') {
            this.bot.activateItem(false);
          }
          this.fireworkFired = true;
          this.lastRocketTime = Date.now();
          this.climbTicksAfterBoost = 0;
        }
        return true;
      }

      this.climbTicksAfterBoost++;
      const heightAboveTarget = pos.y - predPos.y;

      // HT1 2nd-rocket boost if first rocket burn faded before reaching lethal altitude (>11b)
      const rocketCooldown = this.aerialCfg.elytraRocketCooldownMs !== undefined ? this.aerialCfg.elytraRocketCooldownMs : 1000;
      if (
        rocketSel &&
        heightAboveTarget < 11.0 &&
        velY < 0.28 &&
        this.climbTicksAfterBoost >= 10 &&
        (Date.now() - this.lastRocketTime) >= rocketCooldown
      ) {
        const eq = this._equipHand(rocketSel);
        if (eq.ready && !eq.swapped && typeof this.bot.activateItem === 'function') {
          this.bot.activateItem(false);
          this.lastRocketTime = Date.now();
          this.climbTicksAfterBoost = 0;
          return true;
        }
      }

      const readyToDive =
        heightAboveTarget >= 13.0 ||
        (heightAboveTarget >= 8.0 && horizDist <= 9.0 && this.climbTicksAfterBoost >= 6) ||
        this.climbTicksAfterBoost >= 16;

      if (readyToDive) {
        this.stage = 'DIVE';
        this.stageTicks = 0;
      }
      return true;
    }

    // -----------------------------------------------------------------------
    // Stage 4: DIVE — HT1 Guided 3D Intercept + Mid-Glide Density Mace Pre-Equip
    // -----------------------------------------------------------------------
    if (this.stage === 'DIVE') {
      if (onGround || inWater) {
        this._restoreChestplate();
        this.stage = 'SWORD_RESTORE';
        return true;
      }

      const vel = this.bot.entity.velocity || new Vec3(0, 0, 0);
      const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
      const rawDist = pos.distanceTo(target.position);
      const leadTicks = clamp(Math.round(rawDist / Math.max(0.85, speed)), 1, 5);
      const predPos = this._getPredictedPosition(target, leadTicks);

      const dx = predPos.x - pos.x;
      const dz = predPos.z - pos.z;
      const horizDist = Math.sqrt(dx * dx + dz * dz);
      const heightAboveTarget = pos.y - predPos.y;
      const strikeHeight = this.aerialCfg.elytraStrikeHeight !== undefined
        ? this.aerialCfg.elytraStrikeHeight
        : 4.8;

      // Speed-scaled swap window so high-speed HT1 dives swap Chestplate BEFORE hitting ground
      const speedMargin = clamp(Math.abs(velY) * 2.2, 0, 3.2);
      const dynamicStrikeHeight = strikeHeight + speedMargin;
      const dynamicSwapReach = 5.5 + speedMargin * 0.6;

      // HT1 mid-dive rocket acceleration if target sprinted far away (>15b) and we're losing speed
      const rocketSel = this._findItemByName('firework_rocket');
      const rocketCooldown = this.aerialCfg.elytraRocketCooldownMs !== undefined ? this.aerialCfg.elytraRocketCooldownMs : 1000;
      const needDiveRocket = Boolean(
        rocketSel &&
        horizDist > 15.0 &&
        heightAboveTarget > 6.0 &&
        speed < 0.95 &&
        (Date.now() - this.lastRocketTime) >= rocketCooldown
      );

      if (needDiveRocket) {
        const eq = this._equipHand(rocketSel);
        if (eq.ready && !eq.swapped && typeof this.bot.activateItem === 'function') {
          this.bot.activateItem(false);
          this.lastRocketTime = Date.now();
        }
      } else {
        // Pre-equip Sword (for 625ms Attribute Swap) or Density Mace DURING glide so it is 100% charged at impact!
        const densityMace = this._findDensityMace();
        if (densityMace && !this.swappedThisTick) {
          this._prepareMaceWeapon(densityMace);
        }
      }

      // Transition to Chestplate swap -> instant Density Mace smash when entering impact window
      if (
        reachDist <= dynamicSwapReach ||
        (heightAboveTarget <= dynamicStrikeHeight && horizDist <= 5.8 + speedMargin * 0.5)
      ) {
        this.stage = 'STRIKE_CHESTPLATE';
        this.stageTicks = 0;
        return this._tickElytraStrikeChestplate(target);
      }

      if (heightAboveTarget <= strikeHeight && horizDist > 7.5 && this._shouldTriggerClutch(target, true)) {
        this._enterClutch();
        return this._tickClutch();
      }

      // True 3D intercept pitch directly into predicted opponent torso
      const yawToPred = Math.atan2(-dx, -dz);
      const diveMinRad = (this.aerialCfg.elytraDivePitchMinDeg !== undefined
        ? this.aerialCfg.elytraDivePitchMinDeg
        : -86) * DEG_TO_RAD;
      const diveMaxRad = (this.aerialCfg.elytraDivePitchMaxDeg !== undefined
        ? this.aerialCfg.elytraDivePitchMaxDeg
        : -15) * DEG_TO_RAD;

      const aimY = (horizDist > 10.0) ? (predPos.y + 1.6) : (predPos.y + 0.9);
      const directPitch = Math.atan2(aimY - pos.y, Math.max(0.1, horizDist));
      const targetPitchRad = clamp(directPitch, diveMinRad, diveMaxRad);

      this.aimer.stepTowardsAngles(yawToPred, targetPitchRad, {
        speedMultiplier: 1.9,
        toleranceRad: 0.14,
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
    // Stage 5b: STRIKE_EQUIP_MACE — Equip Density Mace on next tick (skipped if already held!)
    // -----------------------------------------------------------------------
    if (this.stage === 'STRIKE_EQUIP_MACE') {
      this._aimAtTarget(target, 1, { speedMultiplier: 1.8, toleranceRad: 0.34, force: true });
      const maceSel = this._findDensityMace();
      if (maceSel) {
        this._prepareMaceWeapon(maceSel);
      }
      this.stage = 'STRIKE_SMASH';
      return true;
    }

    // -----------------------------------------------------------------------
    // Stage 5c: STRIKE_SMASH — HT1 Density Mace Smash (<= 3.35b) + Full Charge / Attribute Swap + Instant Re-Loop
    // -----------------------------------------------------------------------
    if (this.stage === 'STRIKE_SMASH') {
      if (onGround || inWater) {
        this.stage = 'SWORD_RESTORE';
        return this._tickSwordRestore();
      }

      const { aimStatus } = this._steerAirborneToward(target, 1);

      if (reachDist <= 4.0 && this._tryEnterStunSlam(target, 1.8)) {
        return this._tickStunSlam(target);
      }

      const maceSel = this._findDensityMace();
      const prep = maceSel ? this._prepareMaceWeapon(maceSel) : { ready: false, swapped: false };

      if (
        prep.ready &&
        !prep.swapped &&
        reachDist <= reach + 0.35 &&
        aimStatus.aligned &&
        this._isMaceChargeReady(target)
      ) {
        this._executeMaceSmash(target, maceSel);

        if (this.aerialCfg.windBurstChainEnabled !== false && maceSel && hasItemEnchant(maceSel.item, 'wind_burst')) {
          this.mode = AERIAL_MODES.MACE_LAUNCH;
          this.stage = 'WIND_BURST_BOUNCE';
          this.stageTicks = 0;
          return true;
        }

        // Only re-loop Elytra Dive when outside immediate melee range (>= 5.5b) so we never strip Chestplate in-face!
        if (
          this.aerialCfg.loopDiveOnGrounded !== false &&
          pos.distanceTo(target.position) >= 5.5 &&
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
    this._aimAtTarget(target, 1, { speedMultiplier: 1.85, toleranceRad: 0.36, force: true });
    this.isGliding = false;
    this._restoreChestplate(true);
    // If Density Mace was already pre-equipped during DIVE, go straight to STRIKE_SMASH with zero extra tick latency!
    const densityMace = this._findDensityMace();
    this.stage = (densityMace && this._isHoldingSelection(densityMace))
      ? 'STRIKE_SMASH'
      : 'STRIKE_EQUIP_MACE';
    return true;
  }
};

module.exports = { elytraMaceMethods };
