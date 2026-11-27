'use strict';

const { Vec3 } = require('vec3');
const { SWORD_PRIORITY, inspectColumnStep } = require('../constants');
const { findInventoryItem, ensureItemHeld } = require('../inventory_utils');
const {
  canThrowPearl,
  markPearlThrown,
  simulatePearlFlight,
  isSafePearlLanding
} = require('../pearl_ballistics');

const COBWEB_TOOLS = ['shears', ...SWORD_PRIORITY];
const EXIT_ANGLES = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, (3 * Math.PI) / 4, -(3 * Math.PI) / 4, Math.PI];

/**
 * High-Tier 4-Layer Cobweb Escape (`modules/escape/cobweb_escape.js`):
 * 0. ALWAYS actively walks toward the nearest non-cobweb open neighbor (instantly clears edge-clips!)
 * 1. Water Bucket flush directly onto the floor beneath the cobweb -> scoops water back cleanly
 * 2. Verified ballistic Ender Pearl escape (scans clear yaw/pitch arcs via `simulatePearlFlight`!)
 * 3. Instant Shears / Sword cobweb break while continuing to step out of the cobweb
 */
const cobwebEscapeMethods = {
  _findNearestNonCobwebExitYaw(cobwebBlock, target) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position || typeof this.bot.blockAt !== 'function') {
      return null;
    }
    const pos = this.bot.entity.position;
    const baseYaw = (target && target.position)
      ? Math.atan2(-(target.position.x - pos.x), -(target.position.z - pos.z))
      : (this.bot.entity.yaw || 0);

    let best = null;
    for (let i = 0; i < EXIT_ANGLES.length; i++) {
      const yaw = baseYaw + EXIT_ANGLES[i];
      const dx = -Math.sin(yaw);
      const dz = -Math.cos(yaw);
      const nx = pos.x + dx * 0.95;
      const nz = pos.z + dz * 0.95;
      const col = inspectColumnStep(this.bot, nx, pos.y, nz);
      if (col.blocked || col.hasHazard) continue;

      const feetB = this.bot.blockAt(new Vec3(Math.floor(nx), Math.floor(pos.y), Math.floor(nz)));
      const headB = this.bot.blockAt(new Vec3(Math.floor(nx), Math.floor(pos.y + 1), Math.floor(nz)));
      if ((feetB && feetB.name === 'cobweb') || (headB && headB.name === 'cobweb')) continue;

      let score = 20;
      if (col.hasFloor) score += 10;
      if (col.needsJump) score -= 2;
      // Prefer moving away from cobweb center
      if (cobwebBlock && cobwebBlock.position) {
        const distFromWeb = Math.hypot(nx - (cobwebBlock.position.x + 0.5), nz - (cobwebBlock.position.z + 0.5));
        score += distFromWeb * 8;
      }
      if (!best || score > best.score) {
        best = { yaw, needsJump: col.needsJump, score };
      }
    }
    return best;
  },

  _applyCobwebWalkOut(exitInfo, allowAim = false) {
    if (!this.bot || typeof this.bot.setControlState !== 'function') return;
    this.bot.setControlState('sprint', false);
    this.bot.setControlState('sneak', false);
    this.bot.setControlState('jump', false);

    if (!exitInfo) {
      this.bot.setControlState('forward', true);
      this.bot.setControlState('back', false);
      this.bot.setControlState('left', false);
      this.bot.setControlState('right', false);
      return;
    }

    if (allowAim && this.aimer) {
      this.aimer.stepTowardsAngles(exitInfo.yaw, 0.0, { speedMultiplier: 1.8, toleranceRad: 0.25 });
      this.bot.setControlState('forward', true);
      this.bot.setControlState('back', false);
      this.bot.setControlState('left', false);
      this.bot.setControlState('right', false);
      return;
    }

    // Project exit direction onto current yaw so we walk OUT of the cobweb even while looking down to water/dig!
    const yaw = (this.bot.entity && this.bot.entity.yaw) || 0;
    const tx = -Math.sin(exitInfo.yaw);
    const tz = -Math.cos(exitInfo.yaw);
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);

    const fwd = tx * fx + tz * fz;
    const right = tx * rx + tz * rz;
    this.bot.setControlState('forward', fwd > 0.2);
    this.bot.setControlState('back', fwd < -0.2);
    this.bot.setControlState('right', right > 0.2);
    this.bot.setControlState('left', right < -0.2);
  },

  _findSafeCobwebPearlArc(target) {
    if (!this.bot || !this.bot.entity) return null;
    const pos = this.bot.entity.position;
    const eyePos = this.aimer ? this.aimer.getEyePosition() : pos.offset(0, 1.62, 0);
    // Low HP -> pearl away from enemy; healthy -> pearl cleanly past/toward enemy out of the web
    const awayFromEnemy = this.bot.health <= 11;
    const baseYaw = (target && target.position)
      ? (awayFromEnemy
          ? Math.atan2(-(pos.x - target.position.x), -(pos.z - target.position.z))
          : Math.atan2(-(target.position.x - pos.x), -(target.position.z - pos.z)))
      : (this.bot.entity.yaw || 0);

    const pitches = [20, 32, 12, 42].map((d) => d * (Math.PI / 180));
    const yawOffs = [0, 0.5, -0.5, 1.05, -1.05, 1.6, -1.6];

    let best = null;
    let bestScore = -Infinity;
    for (const off of yawOffs) {
      const yaw = baseYaw + off;
      for (const pitch of pitches) {
        const sim = simulatePearlFlight(this.bot, eyePos, yaw, pitch, 55);
        if (!sim.hit || !isSafePearlLanding(this.bot, sim.pos, { maxDrop: 4 })) continue;
        const travel = sim.pos.distanceTo(pos);
        if (travel < 3.5) continue;
        const score = Math.min(travel, 18) - Math.abs(off) * 3.0 + (sim.hitSide ? -2.0 : 2.0);
        if (score > bestScore) {
          bestScore = score;
          best = { yaw, pitch };
        }
      }
    }
    return best;
  },

  _tickCobwebEscape(cobwebBlock, target) {
    const now = Date.now();
    this._setActiveMode('COBWEB_ESCAPE');
    this.modeTicks++;

    const exitInfo = this._findNearestNonCobwebExitYaw(cobwebBlock, target);

    // Continue active cobweb water place/pickup
    if (this.waterCtrl.isActive('cobweb')) {
      this._applyCobwebWalkOut(exitInfo, false);
      const busy = this.waterCtrl.tick({
        kind: 'cobweb',
        targetPos: (cobwebBlock && cobwebBlock.position) || this.waterCtrl.targetPos,
        aimPoint: ((cobwebBlock && cobwebBlock.position) || this.waterCtrl.targetPos || this.bot.entity.position).offset(0.5, -0.02, 0.5),
        pickupTicks: 5,
        checkStillNeeded: () => Boolean(this.findOverlappingCobweb())
      });
      if (!busy) {
        this._setActiveMode('IDLE');
      }
      return busy;
    }

    if (!cobwebBlock) {
      if (this.miner && this.miner.digging) this.miner.cancel();
      this._setActiveMode('IDLE');
      return false;
    }

    // Tier 1: Water Bucket flush onto cobweb floor (fastest & cleanest — breaks web in 1 tick!)
    if (this.waterCtrl.canStart('cobweb', 500, now)) {
      if (this.miner && this.miner.digging) this.miner.cancel();
      this._applyCobwebWalkOut(exitInfo, false);
      const pos = cobwebBlock.position.floored();
      return this.waterCtrl.tick({
        kind: 'cobweb',
        targetPos: pos,
        aimPoint: pos.offset(0.5, -0.02, 0.5),
        pickupTicks: 5,
        checkStillNeeded: () => Boolean(this.findOverlappingCobweb())
      });
    }

    // Tier 2: Verified safe Ender Pearl escape (only if stuck > 2 ticks or low HP and clear arc exists)
    const pearl = (this.modeTicks >= 2 || this.bot.health <= 11) &&
      canThrowPearl(this.bot, { emergency: true, cooldownMs: 1800, now })
      ? findInventoryItem(this.bot, 'ender_pearl')
      : null;
    if (pearl) {
      const arc = this._findSafeCobwebPearlArc(target);
      if (arc) {
        if (this.miner && this.miner.digging) this.miner.cancel();
        this._applyCobwebWalkOut(exitInfo, false);
        const aim = this.aimer
          ? this.aimer.stepTowardsAngles(arc.yaw, arc.pitch, { speedMultiplier: 2.1, toleranceRad: 0.2 })
          : { aligned: true };
        const eq = ensureItemHeld(this.bot, pearl);
        if (eq.swapped || !eq.held || !aim.aligned) {
          return true;
        }
        if (typeof this.bot.activateItem === 'function') {
          this.bot.activateItem(false);
          markPearlThrown(this.bot, 'cobweb_escape', now);
        }
        this.lastCobwebPearlAt = now;
        this._setActiveMode('IDLE');
        return true;
      }
    }

    // Tier 3: Equip Shears / best Sword and immediately break the cobweb WHILE walking toward the open exit!
    const tool = findInventoryItem(this.bot, COBWEB_TOOLS);
    if (tool) {
      const eq = ensureItemHeld(this.bot, tool);
      if (eq.swapped) {
        this._applyCobwebWalkOut(exitInfo, false);
        return true;
      }
    }

    if (typeof this.bot.dig === 'function' && this.miner) {
      const digRes = this.miner.mineBlockTick(cobwebBlock, { allowEmbedded: true });
      this.diggingInProgress = this.miner.digging;
      // Keep stepping toward open non-cobweb edge while breaking so edge-clips free instantly!
      this._applyCobwebWalkOut(exitInfo, false);
      if (digRes.status === 'preparing' || digRes.status === 'digging' || digRes.status === 'done') {
        return true;
      }
    }

    // Final fallback: steer & walk straight out to nearest clear neighbor
    this._applyCobwebWalkOut(exitInfo, true);
    return true;
  }
};

module.exports = { cobwebEscapeMethods };
