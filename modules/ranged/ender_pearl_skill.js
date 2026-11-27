'use strict';

const { findInventoryItem, ensureItemHeld } = require('../inventory_utils');
const {
  canThrowPearl,
  markPearlThrown,
  solvePearlBallistics,
  simulatePearlFlight,
  isSafePearlLanding
} = require('../pearl_ballistics');

/**
 * High-Tier (HT1) Ender Pearl Skill (`modules/ranged/ender_pearl_skill.js`):
 * - Single clean ballistic lead (fixes double-leading bug that threw pearls past fleeing enemies!)
 * - Aggressive chase pearls (10.5b+ when opponent runs/heals), smart agro-cancel pearls when combo-locked,
 *   and 7-angle × 3-pitch defensive escape pearl scanner (never fails near walls/corners!)
 * - Strictly 1-tick post-swap settle with zero wasted extra ticks
 */
const enderPearlSkillMethods = {
  _getTargetVelocity(target) {
    if (this.prediction && typeof this.prediction.getTargetKinematics === 'function') {
      const kin = this.prediction.getTargetKinematics(target);
      if (kin && kin.velocity) return kin.velocity;
    }
    return (target && target.velocity) ? target.velocity : { x: 0, y: 0, z: 0 };
  },

  tryEnderPearl(target, mode = 'chase') {
    if (this.rangedCfg.enabled === false || !this.bot || !this.bot.entity || !target || !target.isValid || !target.position) {
      return false;
    }
    if (this.pendingAction) return false;

    const now = Date.now();
    const reserve = this.rangedCfg.enderPearlReserveCount !== undefined ? this.rangedCfg.enderPearlReserveCount : 2;

    if (mode === 'chase') {
      const chaseCd = this.rangedCfg.enderPearlChaseCooldownMs !== undefined ? this.rangedCfg.enderPearlChaseCooldownMs : 3200;
      if (!canThrowPearl(this.bot, { emergency: false, reserveCount: reserve, cooldownMs: chaseCd, now })) {
        return false;
      }

      const maxTargetHp = this.rangedCfg.enderPearlChaseMaxTargetHp;
      if (
        typeof maxTargetHp === 'number' &&
        maxTargetHp < 20 &&
        typeof target.health === 'number' &&
        target.health > maxTargetHp
      ) {
        return false;
      }

      const botPos = this.bot.entity.position;
      const dist = botPos.distanceTo(target.position);
      const chaseRange = this.rangedCfg.enderPearlChaseRange !== undefined ? this.rangedCfg.enderPearlChaseRange : 10.5;
      if (dist < chaseRange || dist > 56.0) return false;

      const vel = this._getTargetVelocity(target);
      // At mid-range (10.5–15b), only chase-pearl if opponent is actually running away or healing/using item
      if (dist < 15.0) {
        const dx = target.position.x - botPos.x;
        const dz = target.position.z - botPos.z;
        const len = Math.hypot(dx, dz) || 1;
        const runningAway = ((vel.x * (dx / len) + vel.z * (dz / len)) > 0.08);
        const targetUsing = Boolean(target.usingItem || (target.metadata && (Number(target.metadata[8] || 0) & 0x01)));
        if (!runningAway && !targetUsing) return false;
      }

      const pearl = findInventoryItem(this.bot, 'ender_pearl');
      if (!pearl) return false;

      const eyePos = this.aimer ? this.aimer.getEyePosition() : botPos.offset(0, 1.62, 0);
      // Single clean ballistic solve (no double-leading!): aim at feet+0.35 with true velocity
      const aimBase = target.position.offset(0, 0.35, 0);
      const sol = solvePearlBallistics(eyePos, aimBase, vel, 75);
      if (!sol) return false;

      const sim = simulatePearlFlight(this.bot, eyePos, sol.yaw, sol.pitch, 75);
      if (!sim.hit || !isSafePearlLanding(this.bot, sim.pos, { maxDrop: 4 })) return false;
      // Ensure pearl meaningfully closes the gap toward the target's predicted landing spot
      const predLanding = target.position.offset(vel.x * Math.min(sol.flightTicks, 14), 0, vel.z * Math.min(sol.flightTicks, 14));
      if (sim.pos.distanceTo(predLanding) >= dist * 0.68) return false;

      this.pendingAction = {
        type: 'pearl',
        mode: 'chase',
        item: pearl.item,
        yaw: sol.yaw,
        pitch: sol.pitch,
        preserveSprint: true,
        ticks: 0
      };
      return true;
    }

    if (mode === 'agro_cancel') {
      const agroHp = this.rangedCfg.enderPearlAgroCancelHp !== undefined ? this.rangedCfg.enderPearlAgroCancelHp : 12;
      const escapeHp = this.rangedCfg.enderPearlEscapeHealth !== undefined ? this.rangedCfg.enderPearlEscapeHealth : 7;
      if (this.bot.health > agroHp || this.bot.health <= escapeHp) return false;
      const cd = this.rangedCfg.enderPearlCooldownMs !== undefined ? this.rangedCfg.enderPearlCooldownMs : 2800;
      if (!canThrowPearl(this.bot, { emergency: false, reserveCount: Math.max(1, reserve - 1), cooldownMs: cd, now })) {
        return false;
      }
      if (this.recentComboHits < 3) return false;

      const pearl = findInventoryItem(this.bot, 'ender_pearl');
      if (!pearl) return false;

      const botPos = this.bot.entity.position;
      const eyePos = this.aimer ? this.aimer.getEyePosition() : botPos.offset(0, 1.62, 0);
      // Aim just behind the enemy to break their combo and take back-angle first hit!
      const dx = target.position.x - botPos.x;
      const dz = target.position.z - botPos.z;
      const len = Math.hypot(dx, dz) || 1;
      const behindPos = target.position.offset((dx / len) * 1.6, 0.35, (dz / len) * 1.6);
      const sol = solvePearlBallistics(eyePos, behindPos, this._getTargetVelocity(target), 45);
      if (!sol) return false;
      const sim = simulatePearlFlight(this.bot, eyePos, sol.yaw, sol.pitch, 45);
      if (!sim.hit || !isSafePearlLanding(this.bot, sim.pos, { maxDrop: 3 })) return false;

      this.recentComboHits = 0;
      this.pendingAction = {
        type: 'pearl',
        mode: 'agro_cancel',
        item: pearl.item,
        yaw: sol.yaw,
        pitch: sol.pitch,
        preserveSprint: true,
        ticks: 0
      };
      return true;
    }

    return false;
  },

  tryDefensivePearl(target) {
    if (this.rangedCfg.enabled === false || !this.bot || !this.bot.entity) return false;
    if (this.pendingAction) return false;

    const now = Date.now();
    const escapeHp = this.rangedCfg.enderPearlEscapeHealth !== undefined ? this.rangedCfg.enderPearlEscapeHealth : 7;
    if (this.bot.health > escapeHp) return false;

    const cd = this.rangedCfg.enderPearlCooldownMs !== undefined ? this.rangedCfg.enderPearlCooldownMs : 2800;
    if (!canThrowPearl(this.bot, { emergency: true, cooldownMs: cd, now })) return false;

    const pearl = findInventoryItem(this.bot, 'ender_pearl');
    if (!pearl) return false;

    const botPos = this.bot.entity.position;
    const eyePos = this.aimer ? this.aimer.getEyePosition() : botPos.offset(0, 1.62, 0);
    const awayYaw = (target && target.position)
      ? Math.atan2(-(botPos.x - target.position.x), -(botPos.z - target.position.z))
      : (this.bot.entity.yaw || 0);

    const minDeg = this.rangedCfg.enderPearlEscapePitchMinDeg !== undefined ? this.rangedCfg.enderPearlEscapePitchMinDeg : 24;
    const maxDeg = this.rangedCfg.enderPearlEscapePitchMaxDeg !== undefined ? this.rangedCfg.enderPearlEscapePitchMaxDeg : 48;
    const midDeg = (minDeg + maxDeg) * 0.5;
    const pitches = [midDeg, minDeg, maxDeg].map((d) => d * (Math.PI / 180));
    const yawOffsets = [0, 0.45, -0.45, 0.95, -0.95, 1.45, -1.45];

    let bestArc = null;
    let bestScore = -Infinity;
    for (const yawOff of yawOffsets) {
      const yaw = awayYaw + yawOff;
      for (const pitchRad of pitches) {
        const sim = simulatePearlFlight(this.bot, eyePos, yaw, pitchRad, 75);
        if (!sim.hit || !isSafePearlLanding(this.bot, sim.pos, { maxDrop: 4 })) continue;
        const travel = sim.pos.distanceTo(botPos);
        if (travel < 6.0) continue;
        const gain = target && target.position ? sim.pos.distanceTo(target.position) : travel;
        const score = gain + (sim.hitSide ? -3.0 : 2.0) - Math.abs(yawOff) * 2.0;
        if (score > bestScore) {
          bestScore = score;
          bestArc = { yaw, pitch: pitchRad };
        }
      }
    }

    if (!bestArc) return false;

    this.pendingAction = {
      type: 'pearl',
      mode: 'defensive',
      item: pearl.item,
      yaw: bestArc.yaw,
      pitch: bestArc.pitch,
      preserveSprint: false,
      ticks: 0
    };
    return true;
  },

  _tickPendingPearl(act) {
    const aim = this.aimer
      ? this.aimer.stepTowardsAngles(act.yaw, act.pitch, { speedMultiplier: 2.3, toleranceRad: 0.14 })
      : { aligned: true };

    if (typeof this.bot.setControlState === 'function') {
      if (act.preserveSprint) {
        this.bot.setControlState('forward', true);
        this.bot.setControlState('back', false);
        this.bot.setControlState('sprint', this.bot.food > 6);
      } else {
        this.bot.setControlState('sprint', false);
      }
    }

    // ensureItemHeld already enforces 1-tick post-swap settle (`swapped: true, held: false`)!
    const eq = ensureItemHeld(this.bot, { item: act.item });
    if (eq.swapped || !eq.held || !aim.aligned) {
      return true;
    }

    if (typeof this.bot.activateItem === 'function') {
      // Instant throwable: NEVER call deactivateItem()!
      this.bot.activateItem(false);
      markPearlThrown(this.bot, act.mode || 'pearl', Date.now());
    }
    this.pendingAction = null;
    return true;
  }
};

module.exports = { enderPearlSkillMethods };
