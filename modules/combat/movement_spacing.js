'use strict';

const {
  clearMovementControls,
  inspectColumnStep,
  isDirectionSafe
} = require('../constants');
const { normalizeAngle } = require('../aim');

/**
 * High-tier Melee Spacing, Crosshair-Reactive Strafing, W/S-Tap & Jump-Reset
 * (`modules/combat/movement_spacing.js`):
 * - Opponent-crosshair-reactive strafing (strafes away from enemy's yaw sweep velocity)
 * - Cross-strafe-through instead of straight backpedaling at < tooCloseDistance
 * - Pre-emptive W-tap / distance-scaled S-tap sprint resets
 * - Knockback-verified Jump-Reset (protected from same-tick overwrite)
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
    const minMs = this.combatCfg.strafeSwitchMinMs || 320;
    const maxMs = this.combatCfg.strafeSwitchMaxMs || 750;
    this.nextStrafeSwitchAt = Date.now() + minMs + Math.floor(Math.random() * Math.max(50, maxMs - minMs));
  },

  _updateReactiveStrafeDirection(target, targetYaw) {
    const now = Date.now();
    // Track opponent crosshair angular velocity to dodge into their blind side
    if (target && typeof target.yaw === 'number') {
      if (this._enemyPrevYaw !== null) {
        const yawDelta = normalizeAngle(target.yaw - this._enemyPrevYaw);
        if (Math.abs(yawDelta) > 0.14 && (now - this._lastReactiveFlipAt) > 220) {
          // Strafe opposite to opponent's yaw sweep direction
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
    const sTapMax = this.combatCfg.sTapMaxDistance || 2.45;
    this.wTapTicksRemaining = minT + (maxT > minT ? Math.floor(Math.random() * (maxT - minT + 1)) : 0);
    this.useSTap = dist < sTapMax;
  },

  _handleKnockbackVelocity(vx, vy, vz) {
    if (this.combatCfg.jumpResetEnabled === false || !this.bot || !this.bot.entity) return;
    if (!this.bot.entity.onGround) return;
    const horizKb = Math.sqrt(vx * vx + vz * vz);
    // Real player-hit knockback has meaningful outward horizontal impulse (>0.16 b/t) + upward lift
    if (horizKb >= 0.16 && vy >= 0.12) {
      this.jumpResetTicksRemaining = 1;
    }
  },

  _updateDynamicSpacingAndStrafe(target, reachDist, horizDist, targetYaw, preparingCrit = false) {
    if (!this.bot || !this.bot.entity || typeof this.bot.setControlState !== 'function') return;

    this._updateReactiveStrafeDirection(target, targetYaw);

    const optMin = this.combatCfg.optimalReachMin || 2.65;
    const optMax = this.combatCfg.optimalReachMax || 2.95;
    const tooClose = this.combatCfg.tooCloseDistance || 2.0;
    const chaseDist = this.combatCfg.chaseDistance || 3.15;

    // 1. Knockback-verified Jump-Reset (protected for this tick!)
    if (this.jumpResetTicksRemaining > 0) {
      this.jumpResetTicksRemaining--;
      this.bot.setControlState('forward', true);
      this.bot.setControlState('back', false);
      this.bot.setControlState('sprint', !preparingCrit && this.bot.food > 6);
      this.bot.setControlState('jump', Boolean(this.bot.entity.onGround));
      this.bot.setControlState('left', this.strafeDirection < 0);
      this.bot.setControlState('right', this.strafeDirection > 0);
      return;
    }

    // 2. W-Tap / S-Tap Sprint Reset window (1-2 ticks)
    if (this.wTapTicksRemaining > 0) {
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

    // 3. Step-up / obstacle check ahead when chasing
    const pos = this.bot.entity.position;
    let stepUpJump = false;
    let wallBlocked = false;
    if (reachDist > optMax) {
      const col = inspectColumnStep(this.bot, pos.x - Math.sin(targetYaw) * 0.9, pos.y, pos.z - Math.cos(targetYaw) * 0.9);
      stepUpJump = Boolean(col.needsJump && !col.blocked);
      wallBlocked = Boolean(col.blocked);
    }

    let forward = false;
    let back = false;
    let sprint = false;
    let jump = false;

    if (reachDist > chaseDist) {
      forward = true;
      sprint = !preparingCrit && this.bot.food > 6;
      // Sprint-jump chase when far (>5b) or stepping up a 1-block ledge
      if (stepUpJump || (horizDist > 5.0 && this.bot.entity.onGround && !preparingCrit)) {
        jump = true;
      }
      if (wallBlocked) {
        if (this._edgeSlideHoldTicks <= 0) {
          this._edgeSlideDir = this._isStrafeDirectionSafe(targetYaw, this.strafeDirection)
            ? this.strafeDirection
            : -this.strafeDirection;
          this._edgeSlideHoldTicks = 6;
        }
        this._edgeSlideHoldTicks--;
      } else {
        this._edgeSlideHoldTicks = 0;
      }
    } else if (reachDist > optMax) {
      forward = true;
      sprint = !preparingCrit && this.bot.food > 6;
      jump = stepUpJump;
    } else if (reachDist < tooClose) {
      // Cross-strafe-through when backed near hazard, otherwise brief S-spacing
      back = this._isBackpedalSafe(targetYaw);
      forward = !back;
      sprint = false;
    } else if (reachDist < optMin) {
      forward = false;
      back = false;
      sprint = false;
    } else {
      // Sweet spot (2.65–2.95b): hold forward pressure for crisp sprint-hits
      forward = true;
      sprint = !preparingCrit && this.bot.food > 6;
    }

    // Strafe controls (pause briefly on micro-juke or wall-slide override)
    let left = false;
    let right = false;
    const effectiveDir = this._edgeSlideHoldTicks > 0 ? this._edgeSlideDir : this.strafeDirection;
    if (horizDist <= 5.5 || this._edgeSlideHoldTicks > 0) {
      if (this._isStrafeDirectionSafe(targetYaw, effectiveDir)) {
        left = effectiveDir < 0;
        right = effectiveDir > 0;
      }
    }

    this.bot.setControlState('forward', forward);
    this.bot.setControlState('back', back);
    this.bot.setControlState('left', left);
    this.bot.setControlState('right', right);
    this.bot.setControlState('sprint', sprint);
    this.bot.setControlState('jump', jump);
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
    this.wTapTicksRemaining = 0;
    this.jumpResetTicksRemaining = 0;
    this.hitSelectDelayTicks = 0;
    this.pendingBreachSwap = false;
    this._edgeSlideHoldTicks = 0;
    this._edgeSlideDir = 1;
    this.strafePauseTicks = 0;
    this.lastBotCheckPos = null;
    this._enemyPrevYaw = null;
  }
};

module.exports = { movementSpacingMethods };
