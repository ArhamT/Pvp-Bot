'use strict';

const { Vec3 } = require('vec3');
const { weaponTrackerMethods } = require('./combat/weapon_tracker');
const { movementSpacingMethods } = require('./combat/movement_spacing');
const { meleeTechniquesMethods } = require('./combat/melee_techniques');

/**
 * Modular Melee Combat Coordinator combining:
 * - `combat/weapon_tracker.js`   — cached enchant/hotbar scanner, 1.9+ cooldowns, shield/facing checks
 * - `combat/movement_spacing.js` — crosshair-reactive strafing, cross-strafe, W/S-tap, KB-verified Jump-Reset
 * - `combat/melee_techniques.js` — DDA wall-LOS, early-sprint-drop Crits, Anti-Crit Uppercuts, Hit-Select, Breach Swap
 */
class CombatModule {
  constructor(bot, config, aimer, hazardChecker = null, prediction = null) {
    this.bot = bot;
    this.config = config || {};
    this.combatCfg = (config && config.combat) ? config.combat : {};
    this.aimer = aimer;
    this.hazardChecker = hazardChecker;
    this.prediction = prediction;

    this.activeTarget = null;
    this.hotbarSlots = null;
    this.weaponEnchantMap = null;
    this._equipInFlight = false;
    this._lastFallbackWeaponCheckAt = 0;

    // Attack cooldown & shield state
    this.lastAttackTime = 0;
    this.lastSwapOrAttackTime = 0;
    this.lastHeldSlot = -1;
    this.lastHeldType = -1;
    this.targetShieldDisabledUntil = 0;

    // Strafe, W/S-tap, Jump-Reset, Hit-Select state
    this.strafeDirection = Math.random() < 0.5 ? -1 : 1;
    this.nextStrafeSwitchAt = 0;
    this._enemyPrevYaw = null;
    this._lastReactiveFlipAt = 0;
    this._edgeSlideDir = 1;
    this._edgeSlideHoldTicks = 0;
    this.strafePauseTicks = 0;
    this.wTapTicksRemaining = 0;
    this.useSTap = false;
    this.jumpResetTicksRemaining = 0;
    this.hitSelectDelayTicks = 0;
    this.pendingBreachSwap = false;
    this.usingPathfinder = false;
    this.lastBotCheckPos = null;
    this.lastSwingByEntityId = new Map();

    // Event listeners
    this._onUpdateSlot = () => { this.hotbarSlots = null; };
    this._onSwingArm = this._handleEntitySwingArm.bind(this);
    this._onEntityHurt = this._handleEntityHurt.bind(this);
    this._onEntityVelocity = (packet) => {
      if (!packet || !this.bot || !this.bot.entity || packet.entityId !== this.bot.entity.id) return;
      const vx = (packet.velocityX || 0) / 8000;
      const vy = (packet.velocityY || 0) / 8000;
      const vz = (packet.velocityZ || 0) / 8000;
      this._handleKnockbackVelocity(vx, vy, vz);
    };

    if (this.bot && this.bot.inventory && typeof this.bot.inventory.on === 'function') {
      this.bot.inventory.on('updateSlot', this._onUpdateSlot);
    }
    if (this.bot && typeof this.bot.on === 'function') {
      this.bot.on('entitySwingArm', this._onSwingArm);
      this.bot.on('entityHurt', this._onEntityHurt);
    }
    if (this.bot && this.bot._client && typeof this.bot._client.on === 'function') {
      this.bot._client.on('entity_velocity', this._onEntityVelocity);
    }
  }

  dispose() {
    this.releaseControl();
    this.activeTarget = null;
    this.lastSwingByEntityId.clear();

    if (this.bot && this.bot.inventory && typeof this.bot.inventory.removeListener === 'function') {
      this.bot.inventory.removeListener('updateSlot', this._onUpdateSlot);
    }
    if (this.bot && typeof this.bot.removeListener === 'function') {
      this.bot.removeListener('entitySwingArm', this._onSwingArm);
      this.bot.removeListener('entityHurt', this._onEntityHurt);
    }
    if (this.bot && this.bot._client && typeof this.bot._client.removeListener === 'function') {
      this.bot._client.removeListener('entity_velocity', this._onEntityVelocity);
    }
  }

  tick(target) {
    if (!this.bot || !this.bot.entity || !target || !target.isValid || !target.position) {
      this.releaseControl();
      this.activeTarget = null;
      return;
    }

    if (!this.activeTarget || this.activeTarget.id !== target.id) {
      this.activeTarget = target;
      this._enemyPrevYaw = null;
      this.hitSelectDelayTicks = 0;
    }

    const botPos = this.bot.entity.position;
    const reachDist = this.getReachDistance(target);
    const dx = target.position.x - botPos.x;
    const dz = target.position.z - botPos.z;
    const horizDist = Math.sqrt(dx * dx + dz * dz);
    const targetYaw = Math.atan2(-dx, -dz);

    // 1. Select best weapon for target state & reach
    const weaponRole = this._updateWeaponForTarget(target, reachDist, true);
    const cooldown = this.getCooldownProgress();

    // 2. Aim directly at closest reachable point on target's 3D hitbox (tight clamped lead in melee!)
    let aimStatus = { aligned: true, yawErrorDeg: 0, pitchErrorDeg: 0 };
    if (this.aimer) {
      if (reachDist <= 4.2) {
        aimStatus = this.aimer.stepTowardsEntity(target, {
          leadTicks: reachDist <= 2.6 ? 0.55 : 0.9,
          maxLeadBlocks: 0.28,
          speedMultiplier: 1.7,
          toleranceRad: 0.26
        });
      } else {
        let aimPoint = target.position.offset(0, (target.height || 1.8) * 0.68, 0);
        if (this.prediction && typeof this.prediction.predictIntersection === 'function') {
          const pred = this.prediction.predictIntersection(target);
          if (pred && pred.torso) aimPoint = pred.torso;
        }
        aimStatus = this.aimer.stepTowardsPoint(aimPoint, { speedMultiplier: 1.55, toleranceRad: 0.28 });
      }
    }

    // 3. Determine whether we are setting up a falling critical hit (drops sprint 1 tick early)
    const critPlan = this._shouldPrepareFallingCrit(target, reachDist, cooldown, weaponRole);

    // 4. Execute HT1 dynamic spacing, reactive circle-strafing, W/S-tap, crit-hop, and jump-reset
    this._updateDynamicSpacingAndStrafe(target, reachDist, horizDist, targetYaw, critPlan, cooldown, weaponRole);

    // 5. Strike when aligned, in reach, LOS-clear, and cooldown-ready
    this._updateAttackAndCrits(target, reachDist, weaponRole, aimStatus.aligned || aimStatus.yawErrorDeg <= 18);
  }
}

Object.assign(
  CombatModule.prototype,
  weaponTrackerMethods,
  movementSpacingMethods,
  meleeTechniquesMethods
);

module.exports = { CombatModule };
