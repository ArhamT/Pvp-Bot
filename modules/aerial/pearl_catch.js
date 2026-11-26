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
   * Evaluates whether to execute a Wind Burst Pearl Catch:
   * - Case 1 (Enemy Pearl Catch): enemy threw an Ender Pearl while we are airborne -> pearl to their predicted landing!
   * - Case 2 (Wind Burst Self-Pearl Catch): we are high airborne (>= 3.5b above target OR fallDistance >= 3.5 OR Wind Burst bounce velY > 0.35)
   *   and enemy dodged/ran horizontally >= 4.2b out from underneath us -> pearl directly onto their predicted path & smash!
   */
  _evaluatePearlCatchTrigger(target) {
    if (this.aerialCfg.pearlCatchEnabled === false) return null;
    if (!target || !target.isValid || !this.bot || !this.bot.entity) return null;

    const now = Date.now();
    const cooldownMs = this.aerialCfg.pearlCatchCooldownMs !== undefined ? this.aerialCfg.pearlCatchCooldownMs : 2200;
    if ((now - this.lastPearlCatchTime) < cooldownMs) return null;

    const { onGround, inWater, inLava } = this._getEnvironmentFlags();
    if (onGround || inWater || inLava) return null;

    if (!this._findItemByName('ender_pearl') || !this._findMace(true)) return null;

    const pos = this.bot.entity.position;
    const velY = this.bot.entity.velocity ? this.bot.entity.velocity.y : 0;
    const heightAboveTarget = pos.y - target.position.y;
    const dx = target.position.x - pos.x;
    const dz = target.position.z - pos.z;
    const horizDist = Math.sqrt(dx * dx + dz * dz);

    const minHeight = this.aerialCfg.pearlCatchMinHeight !== undefined ? this.aerialCfg.pearlCatchMinHeight : 3.5;
    const minHoriz = this.aerialCfg.pearlCatchMinHorizDist !== undefined ? this.aerialCfg.pearlCatchMinHorizDist : 4.2;
    const maxDist = this.aerialCfg.pearlCatchMaxDist !== undefined ? this.aerialCfg.pearlCatchMaxDist : 45.0;

    // Case 1: Intercept an enemy-thrown Ender Pearl while airborne!
    if (
      this.trackedEnemyPearl &&
      now <= this.trackedEnemyPearl.expiresAt &&
      (heightAboveTarget >= 2.2 || this.fallDistance >= 2.0 || velY > 0.3)
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

    // Case 2: Wind Burst / high-altitude self-pearl catch when enemy strafes/runs out from under our smash!
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
  },

  _enterPearlCatch(plan) {
    this.mode = AERIAL_MODES.PEARL_CATCH;
    this.stage = 'PEARL_AIM_THROW';
    this.stageTicks = 0;
    this.pearlCatchTicks = 0;
    this.pearlCatchLandingTarget = plan;
  },

  /**
   * Executes Wind Burst Pearl Catching:
   * 1. PEARL_AIM_THROW: Smoothly solves ballistic pearl arc to catch spot (enemy pearl landing or target path) and throws pearl.
   * 2. PEARL_WAIT_TP: Pre-equips Wind Burst / Breach / Density Mace mid-flight, tracks target, and on teleport/arrival
   *    executes Stun Slam (if shielded) or immediate Mace Smash -> transitions into WIND_BURST_BOUNCE!
   */
  _tickPearlCatch(target) {
    this.stageTicks++;
    this.pearlCatchTicks++;

    if (this.stage === 'SWORD_RESTORE') {
      return this._tickSwordRestore();
    }

    const { onGround, inWater } = this._getEnvironmentFlags();
    const reach = this.combatCfg.reach || DEFAULT_REACH;

    // Stage 1: Aim straight up (+90° pitch) when throwing Pearl + Wind Charge intercept,
    // or solve ballistic arc toward target only when wind charges are unavailable.
    if (this.stage === 'PEARL_AIM_THROW') {
      if (this.stageTicks > 18 || !this.pearlCatchLandingTarget) {
        this.mode = AERIAL_MODES.MACE_LAUNCH;
        this.stage = 'AIRBORNE_DESCENT';
        return true;
      }

      const pearlSel = this._findItemByName('ender_pearl');
      if (!pearlSel) {
        this.mode = AERIAL_MODES.MACE_LAUNCH;
        this.stage = 'AIRBORNE_DESCENT';
        return true;
      }

      const eq = this._equipHand(pearlSel);
      const hasWindCharge = Boolean(
        this.aerialCfg.pearlWindInterceptEnabled !== false &&
        this._findItemByName('wind_charge')
      );
      const useVerticalCatch = hasWindCharge ||
        (this.pearlCatchLandingTarget && this.pearlCatchLandingTarget.reason === 'windburst_self_pearl_catch');

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
        toleranceRad: 0.08,
        force: true
      });

      if (eq.ready && !eq.swapped && aimStatus.aligned) {
        if (typeof this.bot.activateItem === 'function') {
          this.bot.activateItem(false);
        }
        this.lastPearlCatchTime = Date.now();
        this.trackedEnemyPearl = null;
        if (hasWindCharge) {
          this.stage = 'PEARL_WIND_INTERCEPT';
        } else {
          this.stage = 'PEARL_WAIT_TP';
        }
        this.stageTicks = 0;
        return true;
      }
      return true;
    }

    // Stage 1b: Next-tick Wind Charge interception straight up (+90° pitch) for high-speed Pearl Catch
    if (this.stage === 'PEARL_WIND_INTERCEPT') {
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
      return true;
    }

    // Stage 2: Pre-equip Mace (7-Block Rule) while pearl flies -> instant smash on teleport/arrival!
    if (this.stage === 'PEARL_WAIT_TP') {
      if (!target || !target.isValid) {
        if (this._shouldTriggerClutch(null, true)) {
          this._enterClutch();
          return this._tickClutch();
        }
        this.stage = 'SWORD_RESTORE';
        return this._tickSwordRestore();
      }

      const reachDist = this._getReachDistance(target);
      const { aimStatus } = this._steerAirborneToward(target, 1);

      // Shield countering branch (BACKSTAB / STUN_SLAM / SHIELD_DRAIN)
      const counter = evaluateShieldCounter(this.bot, this.targetState, {
        hasAxe: Boolean(this._findAxe()),
        hasMace: Boolean(this._findMace(true)),
        isAirborne: !onGround,
        isGliding: Boolean(this.bot.entity && this.bot.entity.elytraFlying)
      });
      if (counter.strategy === 'STUN_SLAM' && reachDist <= 3.6) {
        this.mode = AERIAL_MODES.STUN_SLAM;
        this.stage = 'AXE_BREAK';
        this.stageTicks = 0;
        this.stunSlamAxeSwapped = false;
        return this._tickStunSlam(target);
      }

      const maceSel = this._findMace(true);
      if (maceSel) {
        const eq = this._equipHand(maceSel);
        const arrivedInReach = reachDist <= reach + 0.25 && (this.teleportedThisTick || aimStatus.aligned || aimStatus.yawErrorDeg < 35);
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

      // Timeout or landed away from target -> recover cleanly
      if (this.stageTicks > 35 || ((onGround || inWater) && this.stageTicks > 6 && !this.teleportedThisTick)) {
        this.stage = 'SWORD_RESTORE';
        return this._tickSwordRestore();
      }

      if (this._shouldTriggerClutch(target, true)) {
        this._enterClutch();
        return this._tickClutch();
      }

      return true;
    }

    return false;
  }
};

module.exports = { pearlCatchMethods };
