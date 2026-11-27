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
  hasItemEnchant,
  clearMovementControls
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

const pearlCatchMethods = {
  /**
   * Tracks enemy-thrown Ender Pearl projectiles in mid-air and simulates their exact landing point
   * so the bot can pearl-catch the enemy on landing with a Wind Burst Mace smash.
   */
  _handleEntitySpawn(entity) {
    if (this.aerialCfg.pearlCatchEnabled === false) return;
    if (!entity || !entity.position || !this.bot || !this.bot.entity || !this.bot.entity.position) return;

    const name = String(entity.name || entity.displayName || '').toLowerCase();
    if (!name.includes('ender_pearl') && !name.includes('thrownenderpearl')) return;

    // Ignore pearls spawned directly at our own eyes (our own thrown pearls)
    const eyePos = this.aimer ? this.aimer.getEyePosition() : this.bot.entity.position.offset(0, 1.62, 0);
    if (eyePos.distanceTo(entity.position) < 1.8) return;

    const landingPos = this._predictProjectileLanding(entity.position, entity.velocity);
    this.trackedEnemyPearl = {
      entity,
      landingPos,
      expiresAt: Date.now() + 3500
    };
  },

  /**
   * Simulates an Ender Pearl's discrete Minecraft flight (drag 0.99, gravity 0.03)
   * until hitting a solid block or reaching 60 ticks, returning predicted landing Vec3.
   */
  _predictProjectileLanding(startPos, startVel) {
    let x = startPos.x;
    let y = startPos.y;
    let z = startPos.z;
    const vel = startVel || new Vec3(0, 0, 0);
    let vx = vel.x;
    let vy = vel.y;
    let vz = vel.z;

    for (let t = 0; t < 60; t++) {
      const nextX = x + vx;
      const nextY = y + vy;
      const nextZ = z + vz;

      if (this.bot && typeof this.bot.blockAt === 'function') {
        const block = this.bot.blockAt(new Vec3(nextX, nextY, nextZ));
        if (block && block.boundingBox === 'block') {
          return new Vec3(x, Math.floor(nextY) + 1, z);
        }
      }

      x = nextX;
      y = nextY;
      z = nextZ;
      vx *= PEARL_DRAG;
      vy = vy * PEARL_DRAG - PEARL_GRAVITY;
      vz *= PEARL_DRAG;

      if (y < -64) break;
    }

    return new Vec3(x, y, z);
  },

  /**
   * Solves ballistic (yaw, pitch) for throwing an Ender Pearl to land directly at `targetPos`.
   */
  _solvePearlBallistics(targetPos, targetVel = null) {
    const eye = this.aimer ? this.aimer.getEyePosition() : this.bot.entity.position.offset(0, 1.62, 0);
    const vel = targetVel || new Vec3(0, 0, 0);

    let flightTicks = clamp(eye.distanceTo(targetPos) / PEARL_SPEED, 1, 45);
    let bestYaw = 0;
    let bestPitch = 0;

    for (let iter = 0; iter < 3; iter++) {
      const predX = targetPos.x + vel.x * flightTicks;
      const predY = targetPos.y + (Math.abs(vel.y) > 0.05 ? vel.y * flightTicks * 0.35 : 0);
      const predZ = targetPos.z + vel.z * flightTicks;

      const dx = predX - eye.x;
      const dy = predY - eye.y;
      const dz = predZ - eye.z;
      const horizDist = Math.sqrt(dx * dx + dz * dz);
      bestYaw = Math.atan2(-dx, -dz);

      if (horizDist < 0.5) {
        bestPitch = clamp(Math.atan2(dy, Math.max(0.1, horizDist)), -Math.PI / 2 + 0.05, Math.PI / 2 - 0.05);
        break;
      }

      // Binary search pitch in [-82°, +45°] using exact discrete pearl drag/gravity
      let low = -82 * DEG_TO_RAD;
      let high = 45 * DEG_TO_RAD;
      let lastTicks = flightTicks;

      for (let step = 0; step < 14; step++) {
        const mid = (low + high) * 0.5;
        let vx = PEARL_SPEED * Math.cos(mid);
        let vy = PEARL_SPEED * Math.sin(mid);
        let x = 0;
        let y = 0;
        let reached = false;
        let yAtDist = -Infinity;
        let ticks = 60;

        for (let t = 1; t <= 60; t++) {
          const px = x;
          const py = y;
          x += vx;
          y += vy;
          vx *= PEARL_DRAG;
          vy = vy * PEARL_DRAG - PEARL_GRAVITY;
          if (x >= horizDist) {
            const frac = (x - px) > 1e-6 ? (horizDist - px) / (x - px) : 0;
            yAtDist = py + (y - py) * frac;
            ticks = (t - 1) + frac;
            reached = true;
            break;
          }
        }

        if (!reached || yAtDist < dy) {
          low = mid;
        } else {
          high = mid;
          lastTicks = ticks;
        }
      }

      bestPitch = (low + high) * 0.5;
      flightTicks = lastTicks;
    }

    return {
      yaw: bestYaw,
      pitch: clamp(bestPitch, -Math.PI / 2 + 0.05, Math.PI / 2 - 0.05),
      flightTicks
    };
  },

  /**
   * Evaluates HT1 Pearl Catch triggers:
   * - Case 1 (Enemy Pearl Intercept): enemy threw an Ender Pearl -> ballistic pearl onto their exact landing spot!
   * - Case 2 (Airborne Wind-Burst Vertical Pearl Catch): airborne high above target (>= 3.5b / Wind Burst bounce)
   *   and enemy dodged horizontally >= 4.2b -> stationary straight-up (+90°) ender_pearl + wind_charge catch!
   * - Case 3 (Grounded HT1 Sky-Pearl Catch): grounded with clear sky, ender_pearl + wind_charge + Mace
   *   (especially with Elytra!) and target at 5.0–24.0b -> dead-stop straight-up (+90°) Pearl+WindCharge sky launch
   *   into Elytra Glide -> Chestplate Swap -> Density Mace Smash!
   */
  _evaluatePearlCatchTrigger(target) {
    if (this.aerialCfg.pearlCatchEnabled === false) return null;
    if (!target || !target.isValid || !this.bot || !this.bot.entity) return null;

    const now = Date.now();
    const cooldownMs = this.aerialCfg.pearlCatchCooldownMs !== undefined ? this.aerialCfg.pearlCatchCooldownMs : 2200;
    if ((now - this.lastPearlCatchTime) < cooldownMs) return null;

    const { onGround, inWater, inLava, inCobweb } = this._getEnvironmentFlags();
    if (inWater || inLava || inCobweb) return null;

    if (!this._findItemByName('ender_pearl') || !this._findMace(true)) return null;

    const pos = this.bot.entity.position;
    const velY = this.bot.entity.velocity ? this.bot.entity.velocity.y : 0;
    const heightAboveTarget = pos.y - target.position.y;
    const dx = target.position.x - pos.x;
    const dz = target.position.z - pos.z;
    const horizDist = Math.sqrt(dx * dx + dz * dz);

    const minHeight = this.aerialCfg.pearlCatchMinHeight !== undefined ? this.aerialCfg.pearlCatchMinHeight : 3.5;
    const minHoriz = this.aerialCfg.pearlCatchMinHorizDist !== undefined ? this.aerialCfg.pearlCatchMinHorizDist : 4.2;
    const maxDist = this.aerialCfg.pearlCatchMaxDist !== undefined ? this.aerialCfg.pearlCatchMaxDist : 64.0;

    // Case 1: Intercept an enemy-thrown Ender Pearl (ballistic arc directly to their landing spot!)
    if (
      this.trackedEnemyPearl &&
      now <= this.trackedEnemyPearl.expiresAt &&
      (!onGround || heightAboveTarget >= 2.0 || this.fallDistance >= 2.0 || velY > 0.3)
    ) {
      const catchDist = pos.distanceTo(this.trackedEnemyPearl.landingPos);
      if (catchDist >= 3.5 && catchDist <= maxDist) {
        return {
          reason: 'enemy_pearl_intercept',
          catchPos: this.trackedEnemyPearl.landingPos.clone(),
          useTargetVel: false
        };
      }
    }

    // Case 2: Airborne Wind-Burst / high-altitude vertical Pearl Catch when enemy dodges out from under us
    if (!onGround) {
      const hasWindBurstAltitude = heightAboveTarget >= minHeight || this.fallDistance >= minHeight || velY > 0.35;
      if (hasWindBurstAltitude && horizDist >= minHoriz && horizDist <= maxDist) {
        const pred = this._getPredictedPosition(target, 3);
        return {
          reason: 'windburst_self_pearl_catch',
          catchPos: pred.offset(0, 0.3, 0),
          useTargetVel: true
        };
      }
      return null;
    }

    // Case 3: Grounded HT1 Vertical Sky-Pearl Catch (ender_pearl + wind_charge + Mace + clear sky above)
    // Used when we have no rockets for Elytra Dive (or in pure Mace+Pearl+WindCharge kits) to sky-launch 20+ blocks!
    const hasWindCharge = Boolean(
      this.aerialCfg.pearlWindInterceptEnabled !== false &&
      this._findItemByName('wind_charge')
    );
    const hasFireworks = Boolean(this._findItemByName('firework_rocket'));
    const hasElytra = this._hasElytraAvailable() && this._hasChestplateAvailable();
    if (
      hasWindCharge &&
      (!hasElytra || !hasFireworks) &&
      horizDist >= 5.0 &&
      horizDist <= 24.0 &&
      this._hasClearSkyAbove(12)
    ) {
      const pred = this._getPredictedPosition(target, 3);
      return {
        reason: 'ground_pearl_catch',
        catchPos: pred.offset(0, 0.3, 0),
        useTargetVel: true
      };
    }

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
      const useVerticalCatch = !isEnemyPearl && (hasWindCharge || reason === 'windburst_self_pearl_catch' || reason === 'ground_pearl_catch');

      // CRITICAL: Zero all WASD/sprint/jump controls for vertical catch so horizontal drift NEVER breaks alignment!
      if (useVerticalCatch) {
        clearMovementControls(this.bot);
      }

      const pearlSel = this._findItemByName('ender_pearl');
      if (!pearlSel) {
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

    // Stage 1b: Next-tick Wind Charge interception straight up (+90° pitch) while movement stays dead-stopped
    if (this.stage === 'PEARL_WIND_INTERCEPT') {
      clearMovementControls(this.bot);

      const windSel = this._findItemByName('wind_charge');
      if (!windSel || !this.pearlInterceptVec) {
        this.stage = 'PEARL_WAIT_TP';
        this.stageTicks = 0;
        return true;
      }

      if (typeof windSel.hotbarIndex === 'number' && windSel.hotbarIndex >= 0 && typeof this.bot.setQuickBarSlot === 'function') {
        this.bot.setQuickBarSlot(windSel.hotbarIndex);
      } else {
        this._equipHand(windSel);
      }

      const windPitch = this.pearlInterceptVec.vertical ? Math.PI / 2 : this.pearlInterceptVec.pitch;
      this.aimer.stepTowardsAngles(this.pearlInterceptVec.yaw, windPitch, { force: true });
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

      // Full 360° WASD+sprint airborne steering directly onto opponent's predicted hitbox!
      const { aimStatus } = this._steerAirborneToward(target, 1);

      // Shield countering branch (BACKSTAB / STUN_SLAM / SHIELD_DRAIN)
      const counter = evaluateShieldCounter(this.bot, this.targetState, {
        hasAxe: Boolean(this._findAxe()),
        hasMace: Boolean(this._findDensityMace()),
        isAirborne: !onGround,
        isGliding: Boolean(this.bot.entity && this.bot.entity.elytraFlying)
      });
      if (counter.strategy === 'STUN_SLAM' && reachDist <= 3.8) {
        this.mode = AERIAL_MODES.STUN_SLAM;
        this.stage = 'AXE_BREAK';
        this.stageTicks = 0;
        this.stunSlamAxeSwapped = false;
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

      // If opponent raises shield frontally, stun-slam with Axe -> Density Mace!
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
