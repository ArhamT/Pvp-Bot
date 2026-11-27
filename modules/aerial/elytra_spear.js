'use strict';

const { Vec3 } = require('vec3');
const { clamp, DEG_TO_RAD } = require('../aim');
const { AERIAL_MODES } = require('./constants');

/**
 * Dedicated Elytra Rocket Spear skill (`modules/aerial/elytra_spear.js`):
 * 1. Equip Elytra & pre-equip Firework Rocket -> version-safe start_fall_flying takeoff
 * 2. Rocket boost + 3D forward obstacle avoidance + wall-snag instant abort
 * 3. Early 1.21.11 Kinetic Spear Charge held THROUGH impact (confirmed via `entityHurt`)
 *    with steep -82° dive pitch, 0.4 gliding eye height, & zero-lead close hitbox lock
 * 4. Guaranteed left-click Spear Jab fallback for short-range passes, Tridents, or non-kinetic servers
 * 5. Smooth PULL_UP & continuous re-engagement loop
 */
const elytraSpearMethods = {
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
    this.elytraSpearStuckTicks = 0;
    this.elytraGlideRetrySent = false;
    this.elytraSpearCharging = false;
    this.elytraSpearChargeTicks = 0;
    this.elytraSpearHitTarget = false;
    this.elytraSpearTargetId = null;
    this.elytraSpearAttackNextTick = false;
  },

  _releaseSpearChargeIfActive() {
    if (this.elytraSpearCharging) {
      this.elytraSpearCharging = false;
      this.elytraSpearChargeTicks = 0;
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
      this.elytraTakeoffYaw = desiredYaw;

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
        this._resetState(true);
        return false;
      }

      const dx = target.position.x - pos.x;
      const dz = target.position.z - pos.z;
      const horizDist = Math.sqrt(dx * dx + dz * dz);
      // Preserve runway yaw when launching close so we gain kinetic run-up instead of slamming into enemy shield!
      const boostYaw = horizDist < 5.0 ? this.elytraTakeoffYaw : Math.atan2(-dx, -dz);
      this.aimer.stepTowardsAngles(boostYaw, 28 * DEG_TO_RAD, { speedMultiplier: 1.7 });

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
    // Stage 4: FLY_APPROACH — Steer smoothly onto target, boost with rockets, & Spear joust!
    // -----------------------------------------------------------------------
    if (this.stage === 'FLY_APPROACH') {
      this.elytraFlightTicks++;

      if (!this._isWearingElytra()) {
        this._releaseSpearChargeIfActive();
        this._resetState();
        return false;
      }

      if (onGround && this.elytraFlightTicks > 5) {
        this._releaseSpearChargeIfActive();
        this._resetState(true);
        return true;
      }

      // Wall-crash / block-snag detector: if stuck colliding horizontally or stalled mid-air, abort cleanly!
      if (this.elytraFlightTicks > 3 && (this.bot.entity.isCollidedHorizontally || speed < 0.08)) {
        this.elytraSpearStuckTicks = (this.elytraSpearStuckTicks || 0) + (this.bot.entity.isCollidedHorizontally ? 2 : 1);
      } else {
        this.elytraSpearStuckTicks = 0;
      }
      if (this.elytraSpearStuckTicks >= 4) {
        this._releaseSpearChargeIfActive();
        this.lastElytraTakeoffTime = now;
        this._resetState(true);
        return false;
      }

      this.elytraSpearTargetId = target.id !== undefined ? target.id : null;

      const rawDist = pos.distanceTo(target.position);
      // Zero-lead live hitbox lock inside 5.5b so high-speed strikes hit dead-center (never lead off hitbox!)
      const leadTicks = rawDist <= 5.5
        ? 0
        : (rawDist <= 10.0 ? 1 : clamp(Math.round(rawDist / 7), 2, 4));
      const predPos = leadTicks === 0 ? target.position : this._getPredictedPosition(target, leadTicks);
      const eyePos = this.aimer ? this.aimer.getEyePosition() : pos.offset(0, 0.4, 0);
      const aimPoint = predPos.offset(0, (target.height || 1.8) * 0.55, 0);

      const dx = aimPoint.x - eyePos.x;
      const dy = aimPoint.y - eyePos.y;
      const dz = aimPoint.z - eyePos.z;
      const horizDist = Math.sqrt(dx * dx + dz * dz);
      const dist3D = Math.sqrt(dx * dx + dy * dy + dz * dz);

      let yawToPred = Math.atan2(-dx, -dz);
      let desiredPitch = Math.atan2(dy, Math.max(0.1, horizDist));

      // Terrain clearance protection: only pull level when skimming floor far from opponent
      const heightAboveGround = this._getHeightAboveGround();
      if (heightAboveGround < 1.6 && dist3D > 8.5 && desiredPitch < 6 * DEG_TO_RAD) {
        desiredPitch = 14 * DEG_TO_RAD;
      }
      // Allow steep dive pitch down to -82° so bot dives INTO grounded opponents instead of flying over them
      desiredPitch = clamp(desiredPitch, -82 * DEG_TO_RAD, 60 * DEG_TO_RAD);

      // 3D obstacle avoidance: if a solid block/wall is ahead on flight path, climb & bank around it!
      const obstacleAhead = this._hasFlightObstacleAhead(yawToPred, desiredPitch, Math.min(4.5, Math.max(2.0, dist3D - 1.0)));
      if (obstacleAhead) {
        const leftClear = !this._hasFlightObstacleAhead(yawToPred + 0.95, 25 * DEG_TO_RAD, 3.8);
        const rightClear = !this._hasFlightObstacleAhead(yawToPred - 0.95, 25 * DEG_TO_RAD, 3.8);
        if (leftClear && !rightClear) {
          yawToPred += 0.95;
        } else if (rightClear && !leftClear) {
          yawToPred -= 0.95;
        }
        desiredPitch = 38 * DEG_TO_RAD;
      }

      // Crisp 20-TPS tracking (force: true inside 18b) so crosshair stays locked on target at 1.5+ b/tick!
      const aimStatus = this.aimer.stepTowardsAngles(yawToPred, desiredPitch, {
        speedMultiplier: 2.0,
        toleranceRad: 0.24,
        force: obstacleAhead || dist3D <= 18.0
      });

      if (typeof this.bot.setControlState === 'function') {
        this.bot.setControlState('forward', true);
        this.bot.setControlState('back', false);
        this.bot.setControlState('sprint', false);
        this.bot.setControlState('jump', false);
      }

      // Radial closing velocity (> 0 means closing in on opponent, < 0 means flying past them)
      const radial = (vel.x * dx + vel.z * dz) / Math.max(0.1, horizDist);

      // 4a. Execute deferred Spear jab on the tick immediately after releasing a non-connecting charge
      const spearSel = this._findSpear();
      if (this.elytraSpearAttackNextTick) {
        this.elytraSpearAttackNextTick = false;
        if (
          spearSel &&
          this._isHoldingSelection(spearSel) &&
          reachDist <= spearReach + 0.45 &&
          typeof this.bot.attack === 'function'
        ) {
          this._aimAtTarget(target, 0, {
            speedMultiplier: 2.0,
            toleranceRad: 0.35,
            force: true,
            heightOffset: (target.height || 1.8) * 0.55
          });
          this.bot.attack(target);
        }
        this.elytraPullUpYaw = this.bot.entity.yaw;
        this.stage = 'PULL_UP';
        this.stageTicks = 0;
        return true;
      }

      // 4b. Mid-flight Rocket Boost when distant or stalling (keep Spear in hand inside 11.5b!)
      const rocketSel = this._findItemByName('firework_rocket');
      const wantsBoost = Boolean(
        !obstacleAhead &&
        rocketSel &&
        !this.elytraSpearCharging &&
        (now - this.lastRocketTime) >= rocketCooldownMs &&
        (dist3D > 11.5 && (speed < 0.82 || pos.y < target.position.y + 1.0 || dist3D > 16.0) || (dist3D > 8.5 && speed < 0.52))
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

      // 4c. Spear equip, 1.21.11 Kinetic Spear Charge (held THROUGH impact!), & guaranteed Left-Click Jab!
      if (spearSel) {
        const eq = this._equipHand(spearSel);
        const holdingSpear = eq.ready && !eq.swapped;
        const spearName = String(spearSel.item.name || '').toLowerCase();
        const isNativeSpear = spearName.includes('spear') && !spearName.includes('trident');

        if (holdingSpear) {
          if (this.elytraSpearCharging) {
            this.elytraSpearChargeTicks = (this.elytraSpearChargeTicks || 0) + 1;

            // Confirmed kinetic charge hit via entityHurt -> release cleanly and pull up for next pass!
            if (this.elytraSpearHitTarget) {
              this._releaseSpearChargeIfActive();
              this.elytraSpearHitTarget = false;
              this.elytraPullUpYaw = this.bot.entity.yaw;
              this.stage = 'PULL_UP';
              this.stageTicks = 0;
              return true;
            }

            // Refresh exhausted spear charge if still far from target (> 6b) after ~2.4s holding
            if (this.elytraSpearChargeTicks > 48 && dist3D > 6.0) {
              this._releaseSpearChargeIfActive();
              return true;
            }

            // While still closing into the opponent with a charge that is armed (or arming before pass-through),
            // KEEP HOLDING right-click through impact so vanilla 1.21.11 velocity-scaled kinetic joust lands!
            const chargeWillArm = this.elytraSpearChargeTicks >= 5;
            if (reachDist <= spearReach + 0.15) {
              if (chargeWillArm && radial > 0.15 && reachDist > 1.8) {
                return true;
              }
              this._releaseSpearChargeIfActive();
              this.elytraSpearAttackNextTick = true;
              return true;
            }
            return true;
          }

          // Start 1.21.11 Kinetic Spear Charge EARLY (6.5b–18b) so 10-tick engage delay finishes BEFORE impact!
          if (
            isNativeSpear &&
            this.aerialCfg.elytraSpearChargeEnabled !== false &&
            !obstacleAhead &&
            dist3D <= 18.0 &&
            dist3D >= 6.5 &&
            speed >= 0.40 &&
            aimStatus.yawErrorDeg < 40
          ) {
            if (typeof this.bot.activateItem === 'function') {
              this.bot.activateItem(false);
              this.elytraSpearCharging = true;
              this.elytraSpearChargeTicks = 0;
              this.elytraSpearHitTarget = false;
            }
            return true;
          }

          // Direct Left-Click Spear Jab (Trident, short-range dive < 6.5b, or charge disabled)
          if (reachDist <= spearReach + 0.2 && aimStatus.yawErrorDeg < 48) {
            if (typeof this.bot.attack === 'function') {
              this.bot.attack(target);
            }
            this.elytraPullUpYaw = this.bot.entity.yaw;
            this.stage = 'PULL_UP';
            this.stageTicks = 0;
            return true;
          }
        }
      }

      // If we flew right past the target and are now moving away at close range, pull up cleanly!
      if (dist3D < 2.8 && radial < -0.15) {
        if (
          !this.elytraSpearCharging &&
          spearSel &&
          this._isHoldingSelection(spearSel) &&
          reachDist <= spearReach + 0.2 &&
          typeof this.bot.attack === 'function'
        ) {
          this.bot.attack(target);
        }
        this._releaseSpearChargeIfActive();
        this.elytraPullUpYaw = this.bot.entity.yaw;
        this.stage = 'PULL_UP';
        this.stageTicks = 0;
        return true;
      }

      return true;
    }

    // -----------------------------------------------------------------------
    // Stage 5: PULL_UP — Climb smoothly to +32°, boost if slow/low, then loop back to FLY_APPROACH
    // -----------------------------------------------------------------------
    if (this.stage === 'PULL_UP') {
      this._releaseSpearChargeIfActive();

      if (onGround && this.stageTicks > 2) {
        this._resetState(true);
        return true;
      }

      if (this.bot.entity.isCollidedHorizontally || (this.stageTicks > 3 && speed < 0.08)) {
        this.elytraSpearStuckTicks = (this.elytraSpearStuckTicks || 0) + (this.bot.entity.isCollidedHorizontally ? 2 : 1);
      } else {
        this.elytraSpearStuckTicks = 0;
      }
      if (this.elytraSpearStuckTicks >= 4) {
        this.lastElytraTakeoffTime = now;
        this._resetState(true);
        return false;
      }

      const heightAboveGround = this._getHeightAboveGround();
      const dx = target.position.x - pos.x;
      const dz = target.position.z - pos.z;
      const horizDist = Math.sqrt(dx * dx + dz * dz);

      let pullYaw = this.elytraPullUpYaw;
      let pullPitch = 32 * DEG_TO_RAD;
      const pullBlocked = this._hasFlightObstacleAhead(pullYaw, pullPitch, 4.0);
      if (pullBlocked) {
        if (!this._hasFlightObstacleAhead(pullYaw + 1.0, 38 * DEG_TO_RAD, 3.8)) {
          pullYaw += 1.0;
        } else if (!this._hasFlightObstacleAhead(pullYaw - 1.0, 38 * DEG_TO_RAD, 3.8)) {
          pullYaw -= 1.0;
        }
        pullPitch = 45 * DEG_TO_RAD;
      }

      this.aimer.stepTowardsAngles(pullYaw, pullPitch, {
        speedMultiplier: 1.65,
        toleranceRad: 0.22,
        force: pullBlocked
      });

      if (typeof this.bot.setControlState === 'function') {
        this.bot.setControlState('forward', true);
        this.bot.setControlState('sprint', false);
        this.bot.setControlState('jump', false);
      }

      const rocketSel = this._findItemByName('firework_rocket');
      if (
        !pullBlocked &&
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

      // Build >= 12.5b separation so kinetic joust re-entry reaches lethal velocity
      if (this.stageTicks >= 14 || (this.stageTicks >= 8 && horizDist >= 12.5 && heightAboveGround >= 4.5)) {
        this.stage = 'FLY_APPROACH';
        this.stageTicks = 0;
      }
      return true;
    }

    return false;
  }
};

module.exports = { elytraSpearMethods };
