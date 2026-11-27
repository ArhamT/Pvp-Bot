'use strict';

const {
  clearMovementControls,
  inspectColumnStep,
  isDirectionSafe
} = require('../constants');
const { normalizeAngle } = require('../aim');

/**
 * High-Tier (HT1) Melee Spacing, Crosshair-Reactive Circle Strafing, W/S-Tap,
 * Obstacle-Aware Chase, Crit-Hop Timing, & Jump-Reset (`modules/combat/movement_spacing.js`):
 * - NEVER overwrites crit jumps or freezes in dead-zones at 2.0–2.65b
 * - Axe-cooldown micro-kiting (steps to 2.9–3.3b while 1.0s Axe recharges, steps in at >=0.78)
 * - Crosshair-reactive circle-strafing around opponent's blind side
 * - Smart pillar/wall edge-sliding during chases
 * - Exposes `resetTransientState()` so higher-priority modules never have their controls wiped!
 */
const movementSpacingMethods = {
  _isDirectionYawSafe(yaw, dist = 1.2) {
    const dx = -Math.sin(yaw);
    const dz = -Math.cos(yaw);
    return isDirectionSafe(this.bot, dx, dz, dist, 3);
  },

  _isStrafeDirectionSafe(targetYaw, dir) {
    const sideYaw = targetYaw + (dir > 0 ? Math.PI / 2 : -Math.PI / 2);
    return this._isDirectionYawSafe(sideYaw, 1.25);
  },

  _isBackpedalSafe(targetYaw) {
    return this._isDirectionYawSafe(targetYaw + Math.PI, 1.15);
  },

  _scheduleNextStrafeSwitch() {
    const minMs = this.combatCfg.strafeSwitchMinMs || 420;
    const maxMs = this.combatCfg.strafeSwitchMaxMs || 900;
    this.nextStrafeSwitchAt = Date.now() + minMs + Math.floor(Math.random() * Math.max(80, maxMs - minMs));
  },

  _updateReactiveStrafeDirection(target, targetYaw) {
    const now = Date.now();
    // React to opponent crosshair sweep velocity to dodge into their blind side
    if (target && typeof target.yaw === 'number') {
      if (this._enemyPrevYaw !== null) {
        const yawDelta = normalizeAngle(target.yaw - this._enemyPrevYaw);
        if (Math.abs(yawDelta) > 0.16 && (now - this._lastReactiveFlipAt) > 260) {
          const desired = yawDelta > 0 ? -1 : 1;
          if (this._isStrafeDirectionSafe(targetYaw, desired)) {
            this.strafeDirection = desired;
            this._lastReactiveFlipAt = now;
            this._scheduleNextStrafeSwitch();
          }
        }
      }
      this._enemyPrevYaw = target.yaw;
    }

    if (now >= this.nextStrafeSwitchAt) {
      const flipped = -this.strafeDirection;
      if (this._isStrafeDirectionSafe(targetYaw, flipped)) {
        this.strafeDirection = flipped;
      }
      this._scheduleNextStrafeSwitch();
    } else if (!this._isStrafeDirectionSafe(targetYaw, this.strafeDirection)) {
      const alt = -this.strafeDirection;
      if (this._isStrafeDirectionSafe(targetYaw, alt)) {
        this.strafeDirection = alt;
        this._scheduleNextStrafeSwitch();
      }
    }
  },

  _triggerSprintReset(dist) {
    if (this.combatCfg.wTapEnabled === false) return;
    const minT = this.combatCfg.wTapMinTicks || 1;
    const maxT = this.combatCfg.wTapMaxTicks || 2;
    const sTapMax = this.combatCfg.sTapMaxDistance || 2.35;
    this.wTapTicksRemaining = minT + (maxT > minT ? Math.floor(Math.random() * (maxT - minT + 1)) : 0);
    this.useSTap = dist < sTapMax;
  },

  _handleKnockbackVelocity(vx, vy, vz) {
    if (this.combatCfg.jumpResetEnabled === false || !this.bot || !this.bot.entity) return;
    if (!this.bot.entity.onGround) return;
    const horizKb = Math.sqrt(vx * vx + vz * vz);
    if (horizKb >= 0.15 && vy >= 0.11) {
      this.jumpResetTicksRemaining = 1;
    }
  },

  _updateDynamicSpacingAndStrafe(target, reachDist, horizDist, targetYaw, critPlan = null, cooldown = 1.0, weaponRole = 'sword') {
    if (!this.bot || !this.bot.entity || typeof this.bot.setControlState !== 'function') return;

    this._updateReactiveStrafeDirection(target, targetYaw);

    const preparingCrit = Boolean(critPlan && (critPlan === true || critPlan.preparingCrit));
    const wantCritJump = Boolean(critPlan && critPlan.wantCritJump);
    const onGround = Boolean(this.bot.entity.onGround);

    const optMin = this.combatCfg.optimalReachMin || 2.55;
    const optMax = this.combatCfg.optimalReachMax || 2.95;
    const tooClose = this.combatCfg.tooCloseDistance || 1.85;
    const chaseDist = this.combatCfg.chaseDistance || 3.15;

    // 1. Knockback-verified Jump-Reset (protected for this tick!)
    if (this.jumpResetTicksRemaining > 0) {
      this.jumpResetTicksRemaining--;
      this.bot.setControlState('forward', true);
      this.bot.setControlState('back', false);
      this.bot.setControlState('sprint', !preparingCrit && this.bot.food > 6);
      this.bot.setControlState('jump', onGround);
      this.bot.setControlState('left', this.strafeDirection < 0);
      this.bot.setControlState('right', this.strafeDirection > 0);
      return;
    }

    // 2. Crisp 1–2 tick W-Tap / S-Tap Sprint Reset window right after landing a hit
    if (this.wTapTicksRemaining > 0 && !wantCritJump) {
      this.wTapTicksRemaining--;
      const safeBack = this.useSTap && this._isBackpedalSafe(targetYaw);
      this.bot.setControlState('forward', false);
      this.bot.setControlState('back', safeBack);
      this.bot.setControlState('sprint', false);
      this.bot.setControlState('jump', false);
      this.bot.setControlState('left', this.strafeDirection < 0);
      this.bot.setControlState('right', this.strafeDirection > 0);
      return;
    }

    // 3. Obstacle / step-up inspection ahead during chase or close engagement
    const pos = this.bot.entity.position;
    let stepUpJump = false;
    let wallBlocked = false;
    if (reachDist > optMax) {
      const col = inspectColumnStep(this.bot, pos.x - Math.sin(targetYaw) * 0.95, pos.y, pos.z - Math.cos(targetYaw) * 0.95);
      stepUpJump = Boolean(col.needsJump && !col.blocked && !col.hasHazard);
      wallBlocked = Boolean(col.blocked || col.hasHazard);
    }

    let forward = false;
    let back = false;
    let sprint = false;
    let jump = wantCritJump && onGround;

    // Axe-only cooldown kiting: step slightly out to 2.9–3.3b while 1.0s Axe recharges, then burst back in!
    const axeCooldownKite = weaponRole === 'axe' && cooldown < 0.72 && reachDist < 2.95 && !preparingCrit;

    if (reachDist > chaseDist) {
      forward = true;
      sprint = !preparingCrit && this.bot.food > 6;
      if (stepUpJump || (horizDist > 4.8 && onGround && !preparingCrit && !wallBlocked)) {
        jump = true;
      }
      if (wallBlocked) {
        if (this._edgeSlideHoldTicks <= 0) {
          // Pick whichever side around the pillar/wall is actually open
          const rightOpen = this._isStrafeDirectionSafe(targetYaw, 1);
          const leftOpen = this._isStrafeDirectionSafe(targetYaw, -1);
          if (rightOpen && !leftOpen) this._edgeSlideDir = 1;
          else if (leftOpen && !rightOpen) this._edgeSlideDir = -1;
          else this._edgeSlideDir = this.strafeDirection;
          this._edgeSlideHoldTicks = 8;
        }
        this._edgeSlideHoldTicks--;
      } else {
        this._edgeSlideHoldTicks = 0;
      }
    } else if (reachDist > optMax) {
      forward = true;
      sprint = !preparingCrit && this.bot.food > 6;
      jump = jump || stepUpJump;
    } else if (axeCooldownKite) {
      // Micro-kite while Axe recharges so enemy can't get free sword hits on us
      back = this._isBackpedalSafe(targetYaw);
      forward = !back;
      sprint = false;
    } else if (reachDist < tooClose) {
      // Cross-strafe / brief S-spacing to stay at edge of reach
      back = this._isBackpedalSafe(targetYaw);
      forward = !back;
      sprint = false;
    } else if (reachDist < optMin) {
      // NEVER stand dead still! Keep forward pressure when swing is ready, or fluid circle-strafe otherwise
      if (cooldown >= 0.78 || wantCritJump) {
        forward = true;
        sprint = !preparingCrit && this.bot.food > 6;
      } else {
        // Brief micro-space while circling so opponent misses their counter-swing
        back = reachDist < 2.25 && this._isBackpedalSafe(targetYaw);
        forward = !back && reachDist >= 2.35;
        sprint = false;
      }
    } else {
      // Sweet spot (2.55–2.95b): crisp forward sprint-pressure (or sprint-dropped falling crit!)
      forward = true;
      sprint = !preparingCrit && this.bot.food > 6;
    }

    // Smooth circle-strafe around opponent (or wall-slide override when blocked)
    let left = false;
    let right = false;
    const effectiveDir = this._edgeSlideHoldTicks > 0 ? this._edgeSlideDir : this.strafeDirection;
    if (horizDist <= 6.2 || this._edgeSlideHoldTicks > 0) {
      if (this._isStrafeDirectionSafe(targetYaw, effectiveDir)) {
        left = effectiveDir < 0;
        right = effectiveDir > 0;
      }
    }

    // Never sprint during a falling crit (MC cancels crit if sprinting on hit!)
    if (preparingCrit) {
      sprint = false;
    }

    this.bot.setControlState('forward', forward);
    this.bot.setControlState('back', back);
    this.bot.setControlState('left', left);
    this.bot.setControlState('right', right);
    this.bot.setControlState('sprint', sprint);
    this.bot.setControlState('jump', jump);
  },

  /**
   * Clears transient combat timers/pathfinder WITHOUT wiping movement controls.
   * Call this when another subsystem (`aerial`, `survival`, `burst`, `ranged`, `cart`) owns the tick!
   */
  resetTransientState() {
    if (this.usingPathfinder && this.bot && this.bot.pathfinder) {
      try { this.bot.pathfinder.setGoal(null); } catch (_) {}
      this.usingPathfinder = false;
    }
    this.wTapTicksRemaining = 0;
    this.jumpResetTicksRemaining = 0;
    this.hitSelectDelayTicks = 0;
    this.pendingBreachSwap = false;
    this._edgeSlideHoldTicks = 0;
    this.strafePauseTicks = 0;
  },

  stopMovement() {
    clearMovementControls(this.bot);
    if (this.usingPathfinder && this.bot && this.bot.pathfinder) {
      try { this.bot.pathfinder.setGoal(null); } catch (_) {}
      this.usingPathfinder = false;
    }
  },

  releaseControl() {
    this.stopMovement();
    this.resetTransientState();
    this._edgeSlideDir = 1;
    this.lastBotCheckPos = null;
    this._enemyPrevYaw = null;
  }
};

module.exports = { movementSpacingMethods };
