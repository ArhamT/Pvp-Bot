'use strict';

const { Vec3 } = require('vec3');
const { clamp, DEG_TO_RAD } = require('../aim');
const { clearMovementControls } = require('../constants');
const {
  canThrowPearl,
  markPearlThrown,
  getLastPearlThrowTime,
  solvePearlBallistics,
  simulatePearlFlight,
  isSafePearlLanding,
  predictEntityProjectileLanding
} = require('../pearl_ballistics');
const { DEFAULT_REACH, AERIAL_MODES } = require('./constants');

const pearlCatchMethods = {
  _handleEntitySpawn(entity) {
    if (this.aerialCfg.pearlCatchEnabled === false) return;
    if (!entity || !entity.position || !this.bot || !this.bot.entity || !this.bot.entity.position) return;

    const name = String(entity.name || entity.displayName || '').toLowerCase();
    if (!name.includes('ender_pearl') && !name.includes('thrownenderpearl')) return;

    const eyePos = this.aimer ? this.aimer.getEyePosition() : this.bot.entity.position.offset(0, 1.62, 0);
    // Ignore our own recently thrown Ender Pearl (even while sprinting/elytra gliding!)
    if (eyePos.distanceTo(entity.position) < 3.2 || (Date.now() - getLastPearlThrowTime(this.bot)) < 450) return;

    const vel = entity.velocity;
    const hasVel = Boolean(vel && Math.hypot(vel.x || 0, vel.y || 0, vel.z || 0) > 0.08);
    const pred = hasVel ? predictEntityProjectileLanding(this.bot, entity, 65) : null;
    this.trackedEnemyPearl = {
      entity,
      spawnPos: entity.position.clone(),
      lastPos: entity.position.clone(),
      landingPos: (pred && pred.pos) ? pred.pos : null,
      resolved: Boolean(pred && pred.pos),
      expiresAt: Date.now() + 3500
    };
  },

  /**
   * Resolves enemy pearl velocity on tick 2 if `entitySpawn` fired before the `entity_velocity` packet
   * (fixes MC 1.20.4–1.21+ Paper/Spigot pearl tracking!).
   */
  _updateTrackedEnemyPearl() {
    const tp = this.trackedEnemyPearl;
    if (!tp) return;
    if (Date.now() > tp.expiresAt || !tp.entity || !tp.entity.isValid || !tp.entity.position) {
      if (Date.now() > (tp.expiresAt || 0)) this.trackedEnemyPearl = null;
      return;
    }
    if (tp.resolved && tp.landingPos) return;

    const vel = tp.entity.velocity;
    const hasVel = Boolean(vel && Math.hypot(vel.x || 0, vel.y || 0, vel.z || 0) > 0.08);
    if (hasVel) {
      const pred = predictEntityProjectileLanding(this.bot, tp.entity, 65);
      if (pred && pred.pos) {
        tp.landingPos = pred.pos;
        tp.resolved = true;
      }
      return;
    }

    // Fallback: derive velocity from 1-tick position delta
    const delta = tp.entity.position.minus(tp.lastPos);
    tp.lastPos = tp.entity.position.clone();
    if (delta.norm() > 0.08) {
      const pred = predictEntityProjectileLanding(this.bot, {
        position: tp.entity.position.clone(),
        velocity: delta
      }, 65);
      if (pred && pred.pos) {
        tp.landingPos = pred.pos;
        tp.resolved = true;
      }
    }
  },

  _predictProjectileLanding(startPos, startVel) {
    const res = predictEntityProjectileLanding(this.bot, { position: startPos, velocity: startVel }, 60);
    return res ? res.pos : startPos.clone();
  },

  _solvePearlBallistics(targetPos, targetVel = null) {
    const eye = this.aimer ? this.aimer.getEyePosition() : this.bot.entity.position.offset(0, 1.62, 0);
    return solvePearlBallistics(eye, targetPos, targetVel, 60) || { yaw: 0, pitch: 0, flightTicks: 10 };
  },

  /**
   * Evaluates disciplined HT1 Mace Pearl Catch triggers (NEVER spams pearls on normal jumps or short ground distances!):
   * - Case 1 (Enemy Pearl Intercept): enemy threw an Ender Pearl landing >= 8b away -> verified safe ballistic pearl
   *   onto their exact landing spot to punish with a Mace/Sword!
   * - Case 2 (High-Altitude Mace Dodge Catch): genuinely high airborne (`heightAboveTarget >= 5.5` — NEVER triggered
   *   by a normal 0.42 jump!) AND enemy dodged far out of air-steering range (`horizDist >= 6.5b`) -> verified safe
   *   ballistic intercept pearl directly onto opponent's predicted position for a lethal Density/Breach Mace Smash!
   */
  _evaluatePearlCatchTrigger(target) {
    if (this.aerialCfg.pearlCatchEnabled === false) return null;
    if (!target || !target.isValid || !this.bot || !this.bot.entity) return null;
    // Never aggressively pearl-catch at low HP (conserve pearls for defensive escape)
    if (this.bot.health < 10) return null;

    const now = Date.now();
    const cooldownMs = this.aerialCfg.pearlCatchCooldownMs !== undefined ? this.aerialCfg.pearlCatchCooldownMs : 5500;
    if ((now - this.lastPearlCatchTime) < cooldownMs) return null;
    if (!canThrowPearl(this.bot, { emergency: false, reserveCount: 2, cooldownMs: Math.min(3000, cooldownMs), now })) {
      return null;
    }

    const { onGround, inWater, inLava, inCobweb } = this._getEnvironmentFlags();
    if (inWater || inLava || inCobweb) return null;

    if (!this._findItemByName('ender_pearl') || !this._findMace(true)) return null;

    const pos = this.bot.entity.position;
    const eyePos = this.aimer ? this.aimer.getEyePosition() : pos.offset(0, 1.62, 0);
    const heightAboveTarget = pos.y - target.position.y;
    const dx = target.position.x - pos.x;
    const dz = target.position.z - pos.z;
    const horizDist = Math.sqrt(dx * dx + dz * dz);

    const minHeight = Math.max(5.5, this.aerialCfg.pearlCatchMinHeight !== undefined ? this.aerialCfg.pearlCatchMinHeight : 5.5);
    const minHoriz = Math.max(6.5, this.aerialCfg.pearlCatchMinHorizDist !== undefined ? this.aerialCfg.pearlCatchMinHorizDist : 6.5);
    const maxDist = this.aerialCfg.pearlCatchMaxDist !== undefined ? this.aerialCfg.pearlCatchMaxDist : 48.0;

    // Case 1: Intercept a genuine enemy-thrown Ender Pearl landing far away (>= 8.0b) with verified safe flight arc
    if (
      this.trackedEnemyPearl &&
      this.trackedEnemyPearl.resolved &&
      this.trackedEnemyPearl.landingPos &&
      now <= this.trackedEnemyPearl.expiresAt
    ) {
      const catchPos = this.trackedEnemyPearl.landingPos;
      const catchDist = pos.distanceTo(catchPos);
      if (catchDist >= 8.0 && catchDist <= maxDist && isSafePearlLanding(this.bot, catchPos, { maxDrop: 4 })) {
        const sol = solvePearlBallistics(eyePos, catchPos, null, 65);
        if (sol) {
          const sim = simulatePearlFlight(this.bot, eyePos, sol.yaw, sol.pitch, 65);
          if (sim.hit && isSafePearlLanding(this.bot, sim.pos, { maxDrop: 4 }) && sim.pos.distanceTo(catchPos) <= 5.0) {
            return {
              reason: 'enemy_pearl_intercept',
              catchPos: catchPos.clone(),
              useTargetVel: false
            };
          }
        }
      }
    }

    // Case 2: High-Altitude Mace Dodge Catch (ONLY when genuinely high above target — NEVER on a normal jump!)
    if (!onGround) {
      const genuinelyHigh = heightAboveTarget >= minHeight && (this.fallDistance >= 2.5 || heightAboveTarget >= 6.5);
      if (genuinelyHigh && horizDist >= minHoriz && horizDist <= maxDist) {
        const pred = this._getPredictedPosition(target, 3);
        const aimPos = pred.offset(0, 1.0, 0);
        const sol = solvePearlBallistics(eyePos, aimPos, target.velocity || null, 65);
        if (sol) {
          const sim = simulatePearlFlight(this.bot, eyePos, sol.yaw, sol.pitch, 65);
          if (sim.hit && isSafePearlLanding(this.bot, sim.pos, { maxDrop: 4 }) && sim.pos.distanceTo(pred) < horizDist * 0.6) {
            return {
              reason: 'windburst_self_pearl_catch',
              catchPos: aimPos,
              useTargetVel: true
            };
          }
        }
      }
      return null;
    }

    // On ground: use Wind Charge Mace Launch / Elytra Dive instead of wasting Ender Pearls!
    return null;
  },

  _enterPearlCatch(plan) {
    this.mode = AERIAL_MODES.PEARL_CATCH;
    this.stage = 'PEARL_AIM_THROW';
    this.stageTicks = 0;
    this.pearlCatchTicks = 0;
    this.pearlCatchLandingTarget = plan;
    this.pearlLaunchY = (this.bot && this.bot.entity && this.bot.entity.position)
      ? this.bot.entity.position.y
      : 0;
    this.pearlTeleportArrived = false;
  },

  /**
   * HT1 Pearl Catching State Machine:
   * 1. PEARL_AIM_THROW: Dead-stop horizontal momentum (`horizSpeed <= 0.04` grounded / `<= 0.10` airborne),
   *    snap straight up (`+90°`, `force: true`) for vertical Wind-Charge Pearl Catch OR solve ballistic arc for
   *    enemy pearl intercept, then release `ender_pearl`.
   * 2. PEARL_WIND_INTERCEPT: Keep movement dead-stopped, snap `+90°`, swap & fire `wind_charge` straight up so it
   *    overtakes and detonates on the pearl ~12–24 blocks up.
   * 3. PEARL_WAIT_TP: Wait cleanly for the sky-teleport (never aborting prematurely on ground!), pre-equipping
   *    Density Mace. On teleport arrival -> transition to `PEARL_ELYTRA_GLIDE` (if Elytra available & offset)
   *    OR full 360° WASD+sprint air-steering -> Density Mace Smash -> Wind Burst Bounce Chain!
   */
  _tickPearlCatch(target) {
    this.stageTicks++;
    this.pearlCatchTicks++;

    if (this.stage === 'SWORD_RESTORE') {
      return this._tickSwordRestore();
    }

    const { onGround, inWater } = this._getEnvironmentFlags();
    const reach = this.combatCfg.reach || DEFAULT_REACH;

    // Stage 1: Dead-stop horizontal velocity, aim straight up (+90°) for vertical catch OR ballistic arc for enemy pearl
    if (this.stage === 'PEARL_AIM_THROW') {
      if (this.stageTicks > 18 || !this.pearlCatchLandingTarget) {
        if (onGround) {
          this.stage = 'SWORD_RESTORE';
          return this._tickSwordRestore();
        }
        this.mode = AERIAL_MODES.MACE_LAUNCH;
        this.stage = 'AIRBORNE_DESCENT';
        return true;
      }

      const reason = this.pearlCatchLandingTarget.reason;
      const hasWindCharge = Boolean(
        this.aerialCfg.pearlWindInterceptEnabled !== false &&
        this._findItemByName('wind_charge')
      );
      const isEnemyPearl = reason === 'enemy_pearl_intercept';
      const isAirborneIntercept = reason === 'windburst_self_pearl_catch';
      // Vertical +90° Wind-Charge sky-pearl ONLY for grounded sky launch; airborne dodge & enemy pearls use exact ballistic intercept!
      const useVerticalCatch = !isEnemyPearl && !isAirborneIntercept && hasWindCharge && reason === 'ground_pearl_catch';

      if (useVerticalCatch) {
        clearMovementControls(this.bot);
      }

      const pearlSel = this._findItemByName('ender_pearl');
      if (!pearlSel) {
        if (onGround) {
          this.stage = 'SWORD_RESTORE';
          return this._tickSwordRestore();
        }
        this.mode = AERIAL_MODES.MACE_LAUNCH;
        this.stage = 'AIRBORNE_DESCENT';
        return true;
      }

      const eq = this._equipHand(pearlSel);
      let aimYaw = this.bot.entity.yaw || 0;
      let aimPitch = Math.PI / 2; // Exact +90 deg straight up for Wind Charge Pearl Catch

      if (!useVerticalCatch) {
        const targetPos = (this.pearlCatchLandingTarget.useTargetVel && target && target.isValid)
          ? target.position.offset(0, 0.3, 0)
          : this.pearlCatchLandingTarget.catchPos;
        const targetVel = (this.pearlCatchLandingTarget.useTargetVel && target && target.velocity)
          ? target.velocity
          : null;
        const sol = this._solvePearlBallistics(targetPos, targetVel);
        aimYaw = sol.yaw;
        aimPitch = sol.pitch;
      }

      this.pearlInterceptVec = { yaw: aimYaw, pitch: aimPitch, vertical: useVerticalCatch };
      const aimStatus = this.aimer.stepTowardsAngles(aimYaw, aimPitch, {
        speedMultiplier: 2.0,
        toleranceRad: 0.06,
        force: true
      });

      const vel = this.bot.entity.velocity || new Vec3(0, 0, 0);
      const horizSpeed = Math.hypot(vel.x || 0, vel.z || 0);
      // Grounded vertical pearl catch requires near-zero horizontal speed (<=0.04) so pearl & wind charge share exact XZ!
      const speedLimit = onGround ? 0.04 : 0.12;
      const maxBrakeTicks = onGround ? 5 : 3;
      const horizontalSettled = !useVerticalCatch || horizSpeed <= speedLimit || this.stageTicks >= maxBrakeTicks;

      if (eq.ready && !eq.swapped && aimStatus.aligned && horizontalSettled) {
        this.pearlLaunchY = this.bot.entity.position.y;
        this.pearlTeleportArrived = false;
        if (typeof this.bot.activateItem === 'function') {
          this.bot.activateItem(false);
          markPearlThrown(this.bot, 'pearl_catch');
        }
        this.lastPearlCatchTime = Date.now();
        this.trackedEnemyPearl = null;
        if (useVerticalCatch && hasWindCharge) {
          this.stage = 'PEARL_WIND_INTERCEPT';
        } else {
          this.stage = 'PEARL_WAIT_TP';
        }
        this.stageTicks = 0;
        return true;
      }
      return true;
    }

    // Stage 1b: Strictly 1-tick-settled Wind Charge interception straight up (+90° pitch)
    if (this.stage === 'PEARL_WIND_INTERCEPT') {
      clearMovementControls(this.bot);

      const windSel = this._findItemByName('wind_charge');
      if (!windSel || !this.pearlInterceptVec || this.stageTicks > 5) {
        this.stage = 'PEARL_WAIT_TP';
        this.stageTicks = 0;
        return true;
      }

      const windPitch = this.pearlInterceptVec.vertical ? Math.PI / 2 : this.pearlInterceptVec.pitch;
      const aimStatus = this.aimer.stepTowardsAngles(this.pearlInterceptVec.yaw, windPitch, {
        speedMultiplier: 2.2,
        toleranceRad: 0.14
      });
      const eq = this._equipHand(windSel);
      if (!eq.ready || eq.swapped || !aimStatus.aligned) {
        return true;
      }
      if (typeof this.bot.activateItem === 'function') {
        this.bot.activateItem(false);
      }
      this.stage = 'PEARL_WAIT_TP';
      this.stageTicks = 0;
      this.elytraGlideRetrySent = false;
      return true;
    }

    // Stage 2: Wait for sky-teleport, then Elytra Glide OR 360° Air-Steer -> Density Mace Smash!
    if (this.stage === 'PEARL_WAIT_TP') {
      if (!target || !target.isValid) {
        if (this._shouldTriggerClutch(null, true)) {
          this._enterClutch();
          return this._tickClutch();
        }
        this.stage = 'SWORD_RESTORE';
        return this._tickSwordRestore();
      }

      const pos = this.bot.entity.position;
      const velY = this.bot.entity.velocity ? this.bot.entity.velocity.y : 0;
      const heightAboveTarget = pos.y - target.position.y;
      const reachDist = this._getReachDistance(target);
      const isVerticalWait = Boolean(this.pearlInterceptVec && this.pearlInterceptVec.vertical);

      if (this.teleportedThisTick || (isVerticalWait && (pos.y - this.pearlLaunchY) >= 4.5)) {
        this.pearlTeleportArrived = true;
      }

      // While grounded waiting for the vertical pearl+wind_charge collision (~9–15 ticks), pre-equip Density Mace & track target
      if (onGround && isVerticalWait && !this.pearlTeleportArrived && this.stageTicks <= 24) {
        const densitySel = this._findDensityMace();
        if (densitySel && !this.swappedThisTick) {
          this._equipHand(densitySel);
        }
        this._aimAtTarget(target, 1, { speedMultiplier: 1.8, toleranceRad: 0.3, force: true });
        return true;
      }

      // Pro Mace-Elytra transition: airborne above opponent after Pearl Catch -> equip Elytra & glide onto them!
      if (
        !onGround &&
        !inWater &&
        this._hasElytraAvailable() &&
        reachDist > reach + 0.45 &&
        (this.pearlTeleportArrived || velY < -0.04 || heightAboveTarget >= 3.5)
      ) {
        const torso = this._getTorsoItem();
        if (torso && torso.name && torso.name.endsWith('_chestplate')) {
          this.savedChestplateName = torso.name;
        }
        if (!this._isWearingElytra()) {
          const elytraSel = this._findItemByName('elytra');
          if (elytraSel) {
            this._equipTorso(elytraSel.item, true);
            this.elytraSwappedIn = true;
          }
        }
        this.stage = 'PEARL_ELYTRA_GLIDE';
        this.stageTicks = 0;
        this.elytraGlideRetrySent = false;
        return this._tickPearlCatch(target);
      }

      const { aimStatus } = this._steerAirborneToward(target, 1);

      if (reachDist <= 3.8 && this._tryEnterStunSlam(target, 1.8)) {
        return this._tickStunSlam(target);
      }

      const maceSel = this._findDensityMace();
      if (maceSel) {
        const eq = this._equipHand(maceSel);
        const arrivedInReach = reachDist <= reach + 0.30 && (this.teleportedThisTick || aimStatus.aligned || aimStatus.yawErrorDeg < 35);
        if (eq.ready && !eq.swapped && arrivedInReach) {
          if (typeof this.bot.setControlState === 'function') {
            this.bot.setControlState('sprint', false);
          }
          this.bot.attack(target);
          this._resetFallAfterSmash();
          this.windBurstChainCount++;
          this.mode = AERIAL_MODES.MACE_LAUNCH;
          this.stage = 'WIND_BURST_BOUNCE';
          this.stageTicks = 0;
          this.windBurstBounceTicks = 0;
          return true;
        }
      }

      if (this.stageTicks > 40 || ((onGround || inWater) && (this.pearlTeleportArrived || this.stageTicks > 24))) {
        this.stage = 'SWORD_RESTORE';
        return this._tickSwordRestore();
      }

      if (this._shouldTriggerClutch(target, true)) {
        this._enterClutch();
        return this._tickClutch();
      }

      return true;
    }

    // Stage 2b: PEARL_ELYTRA_GLIDE — Glide down with Elytra aimed directly onto opponent's predicted hitbox
    if (this.stage === 'PEARL_ELYTRA_GLIDE') {
      if (!target || !target.isValid || onGround || inWater) {
        this._restoreChestplate(true);
        this.isGliding = false;
        this.stage = 'SWORD_RESTORE';
        return this._tickSwordRestore();
      }

      if (!this._isWearingElytra()) {
        const elytraSel = this._findItemByName('elytra');
        if (elytraSel) {
          this._equipTorso(elytraSel.item, true);
          this.elytraSwappedIn = true;
          return true;
        }
      }

      if (!this.bot.entity.elytraFlying && !this.elytraGlideRetrySent && !this.teleportedThisTick) {
        this._sendStartElytraFlying();
        this.isGliding = true;
        this.elytraGlideRetrySent = true;
      }

      const pos = this.bot.entity.position;
      const velY = this.bot.entity.velocity ? this.bot.entity.velocity.y : 0;
      const predPos = this._getPredictedPosition(target, 2);
      const dx = predPos.x - pos.x;
      const dy = (predPos.y + ((target.height || 1.8) * 0.55)) - (pos.y + 1.2);
      const dz = predPos.z - pos.z;
      const horizDist = Math.hypot(dx, dz);
      const heightAboveTarget = pos.y - predPos.y;
      const reachDist = this._getReachDistance(target);

      const yawToTarget = Math.atan2(-dx, -dz);
      const glidePitch = clamp(Math.atan2(dy, Math.max(0.1, horizDist)), -84 * DEG_TO_RAD, -10 * DEG_TO_RAD);
      this.aimer.stepTowardsAngles(yawToTarget, glidePitch, { speedMultiplier: 2.0, force: true });

      if (typeof this.bot.setControlState === 'function') {
        this.bot.setControlState('forward', true);
        this.bot.setControlState('back', false);
        this.bot.setControlState('sprint', false);
        this.bot.setControlState('jump', false);
      }

      // Pre-equip Density Mace while still gliding so smash fires with zero delay right after chestplate swap
      const densitySel = this._findDensityMace();
      if (densitySel && !this.swappedThisTick) {
        this._equipHand(densitySel);
      }

      // Speed-scaled Chestplate swap window right before impact
      const speedMargin = clamp(Math.abs(velY) * 2.0, 0, 2.8);
      if (reachDist <= 5.4 + speedMargin * 0.5 || (heightAboveTarget <= 4.4 + speedMargin && horizDist <= 5.6 + speedMargin * 0.4)) {
        this._restoreChestplate(true);
        this.isGliding = false;
        this.stage = 'PEARL_ELYTRA_SWAP_SMASH';
        this.stageTicks = 0;
        return true;
      }

      if (this.stageTicks > 55) {
        this._restoreChestplate(true);
        this.isGliding = false;
        this.stage = 'SWORD_RESTORE';
        return this._tickSwordRestore();
      }

      return true;
    }

    // Stage 2c: PEARL_ELYTRA_SWAP_SMASH — Chestplate restored, lock onto opponent and deliver Density Mace Smash!
    if (this.stage === 'PEARL_ELYTRA_SWAP_SMASH') {
      if (!target || !target.isValid || onGround || inWater) {
        this._restoreChestplate(true);
        this.stage = 'SWORD_RESTORE';
        return this._tickSwordRestore();
      }

      const reachDist = this._getReachDistance(target);
      const { aimStatus } = this._steerAirborneToward(target, 1);

      if (reachDist <= 3.8 && this._tryEnterStunSlam(target, 1.8)) {
        return this._tickStunSlam(target);
      }

      const densitySel = this._findDensityMace();
      let holdingMace = densitySel ? this._isHoldingSelection(densitySel) : false;
      if (!holdingMace && densitySel) {
        const eq = this._equipHand(densitySel);
        holdingMace = eq.ready && !eq.swapped;
      }

      if (holdingMace && reachDist <= reach + 0.35 && (aimStatus.aligned || aimStatus.yawErrorDeg < 35)) {
        if (typeof this.bot.setControlState === 'function') {
          this.bot.setControlState('sprint', false);
        }
        this.bot.attack(target);
        this._resetFallAfterSmash();
        this.windBurstChainCount++;
        this.mode = AERIAL_MODES.MACE_LAUNCH;
        this.stage = 'WIND_BURST_BOUNCE';
        this.stageTicks = 0;
        this.windBurstBounceTicks = 0;
        return true;
      }

      if (this._shouldTriggerClutch(target, true)) {
        this._enterClutch();
        return this._tickClutch();
      }

      if (this.stageTicks > 25) {
        this.stage = 'SWORD_RESTORE';
        return this._tickSwordRestore();
      }

      return true;
    }

    return false;
  }
};

module.exports = { pearlCatchMethods };
