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
 * Unified Ender Pearl Skill (`modules/ranged/ender_pearl_skill.js`):
 * - Uses shared `pearl_ballistics` cooldown & reserve tracker (coordinated with `aerial`, `burst`, `escape`)
 * - Supports `chase`, `agro_cancel`, and `defensive` pearls with swept sub-step flight verification
 * - Preserves sprint during chase pearls and enforces 1-tick post-swap settle + aim alignment
 */
const enderPearlSkillMethods = {
  tryEnderPearl(target, mode = 'chase') {
    if (this.rangedCfg.enabled === false || !this.bot || !this.bot.entity || !target || !target.isValid || !target.position) {
      return false;
    }
    if (this.pendingAction) return false;

    const now = Date.now();
    const reserve = this.rangedCfg.enderPearlReserveCount !== undefined ? this.rangedCfg.enderPearlReserveCount : 2;

    if (mode === 'chase') {
      const chaseCd = this.rangedCfg.enderPearlChaseCooldownMs !== undefined ? this.rangedCfg.enderPearlChaseCooldownMs : 5500;
      if (!canThrowPearl(this.bot, { emergency: false, reserveCount: reserve, cooldownMs: chaseCd, now })) {
        return false;
      }

      const maxTargetHp = this.rangedCfg.enderPearlChaseMaxTargetHp;
      if (typeof maxTargetHp === 'number' && typeof target.health === 'number' && target.health > maxTargetHp) {
        return false;
      }

      const botPos = this.bot.entity.position;
      const dist = botPos.distanceTo(target.position);
      const chaseRange = this.rangedCfg.enderPearlChaseRange !== undefined ? this.rangedCfg.enderPearlChaseRange : 16.0;
      if (dist < chaseRange || dist > 56.0) return false;

      const pearl = findInventoryItem(this.bot, 'ender_pearl');
      if (!pearl) return false;

      const eyePos = this.aimer ? this.aimer.getEyePosition() : botPos.offset(0, 1.62, 0);
      const leadBlocks = this.rangedCfg.enderPearlChaseLeadBlocks !== undefined ? this.rangedCfg.enderPearlChaseLeadBlocks : 2.5;
      const vel = target.velocity || { x: 0, y: 0, z: 0 };
      const vLen = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
      const aimTarget = vLen > 0.05
        ? target.position.offset((vel.x / vLen) * leadBlocks, 0.4, (vel.z / vLen) * leadBlocks)
        : target.position.offset(0, 0.4, 0);

      const sol = solvePearlBallistics(eyePos, aimTarget, vel, 75);
      if (!sol) return false;

      const sim = simulatePearlFlight(this.bot, eyePos, sol.yaw, sol.pitch, 75);
      if (!sim.hit || !isSafePearlLanding(this.bot, sim.pos, { maxDrop: 4 })) return false;
      if (sim.pos.distanceTo(target.position) >= dist * 0.72) return false;

      this.pendingAction = {
        type: 'pearl',
        mode: 'chase',
        item: pearl.item,
        yaw: sol.yaw,
        pitch: sol.pitch,
        preserveSprint: true,
        ticks: 0,
        settleTicks: 0
      };
      return true;
    }

    if (mode === 'agro_cancel') {
      const agroHp = this.rangedCfg.enderPearlAgroCancelHp !== undefined ? this.rangedCfg.enderPearlAgroCancelHp : 11;
      const escapeHp = this.rangedCfg.enderPearlEscapeHealth !== undefined ? this.rangedCfg.enderPearlEscapeHealth : 5;
      if (this.bot.health > agroHp || this.bot.health <= escapeHp) return false;
      const cd = this.rangedCfg.enderPearlCooldownMs !== undefined ? this.rangedCfg.enderPearlCooldownMs : 3200;
      if (!canThrowPearl(this.bot, { emergency: false, reserveCount: Math.max(1, reserve - 1), cooldownMs: cd, now })) {
        return false;
      }
      if (this.recentComboHits < 3) return false;

      const pearl = findInventoryItem(this.bot, 'ender_pearl');
      if (!pearl) return false;

      const eyePos = this.aimer ? this.aimer.getEyePosition() : this.bot.entity.position.offset(0, 1.62, 0);
      const sol = solvePearlBallistics(eyePos, target.position.offset(0, 0.5, 0), target.velocity, 45);
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
        preserveSprint: false,
        ticks: 0,
        settleTicks: 0
      };
      return true;
    }

    return false;
  },

  tryDefensivePearl(target) {
    if (this.rangedCfg.enabled === false || !this.bot || !this.bot.entity) return false;
    if (this.pendingAction) return false;

    const now = Date.now();
    const escapeHp = this.rangedCfg.enderPearlEscapeHealth !== undefined ? this.rangedCfg.enderPearlEscapeHealth : 5;
    if (this.bot.health > escapeHp) return false;

    const cd = this.rangedCfg.enderPearlCooldownMs !== undefined ? this.rangedCfg.enderPearlCooldownMs : 3200;
    if (!canThrowPearl(this.bot, { emergency: true, cooldownMs: cd, now })) return false;

    const pearl = findInventoryItem(this.bot, 'ender_pearl');
    if (!pearl) return false;

    const botPos = this.bot.entity.position;
    const eyePos = this.aimer ? this.aimer.getEyePosition() : botPos.offset(0, 1.62, 0);
    const awayYaw = (target && target.position)
      ? Math.atan2(-(botPos.x - target.position.x), -(botPos.z - target.position.z))
      : (this.bot.entity.yaw || 0);

    const minDeg = this.rangedCfg.enderPearlEscapePitchMinDeg !== undefined ? this.rangedCfg.enderPearlEscapePitchMinDeg : 32;
    const maxDeg = this.rangedCfg.enderPearlEscapePitchMaxDeg !== undefined ? this.rangedCfg.enderPearlEscapePitchMaxDeg : 44;
    const pitchRad = ((minDeg + maxDeg) * 0.5) * (Math.PI / 180);

    let bestArc = null;
    let bestScore = -Infinity;
    for (const yawOff of [0, 0.45, -0.45]) {
      const yaw = awayYaw + yawOff;
      const sim = simulatePearlFlight(this.bot, eyePos, yaw, pitchRad, 75);
      if (!sim.hit || !isSafePearlLanding(this.bot, sim.pos, { maxDrop: 4 })) continue;
      const gain = target && target.position ? sim.pos.distanceTo(target.position) : sim.pos.distanceTo(botPos);
      if (gain > bestScore) {
        bestScore = gain;
        bestArc = { yaw, pitch: pitchRad };
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
      ticks: 0,
      settleTicks: 0
    };
    return true;
  },

  _tickPendingPearl(act) {
    const aim = this.aimer
      ? this.aimer.stepTowardsAngles(act.yaw, act.pitch, { speedMultiplier: 2.0, toleranceRad: 0.16 })
      : { aligned: true };

    if (!act.preserveSprint && typeof this.bot.setControlState === 'function') {
      this.bot.setControlState('sprint', false);
    }

    const eq = ensureItemHeld(this.bot, { item: act.item });
    if (eq.swapped || !eq.held || !aim.aligned) {
      act.settleTicks = eq.swapped ? 1 : act.settleTicks;
      return true;
    }
    if (act.settleTicks > 0) {
      act.settleTicks--;
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
