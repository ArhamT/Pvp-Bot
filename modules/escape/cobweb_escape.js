'use strict';

const { Vec3 } = require('vec3');
const { SWORD_PRIORITY, inspectColumnStep, isAirLike } = require('../constants');
const { findInventoryItem, ensureItemHeld } = require('../inventory_utils');
const {
  canThrowPearl,
  markPearlThrown,
  simulatePearlFlight,
  isSafePearlLanding
} = require('../pearl_ballistics');

const SWORD_THEN_SHEARS = [...SWORD_PRIORITY, 'shears'];
const EXIT_ANGLES = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, (3 * Math.PI) / 4, -(3 * Math.PI) / 4, Math.PI];

/**
 * Strict Priority-Ordered Cobweb Escape (`modules/escape/cobweb_escape.js`):
 * 1. Water Bucket flush directly onto floor beneath cobweb -> scoops water back cleanly
 * 2. Verified ballistic Ender Pearl escape (shared cooldown + safe landing arc)
 * 3. Chorus Fruit instant teleport escape (if carried)
 * 4. Flint & Steel burn-out (ONLY when Fire Resistance is active!)
 * 5. LAST-RESORT UNINTERRUPTED SWORD MINING:
 *    - Activates ONLY when all instant escapes above are unavailable/blocked
 *    - Targets feet-level cobweb first, then head-level
 *    - Equips highest-tier Sword (`netherite_sword > diamond_sword > ...`)
 *    - Locks combat/weapon-swapper (`cobwebDigLock = true`) and executes `await bot.dig(block, true)` with timeout
 */
const cobwebEscapeMethods = {
  /**
   * Returns feet-level cobweb first, then head-level cobweb, then any hitbox corner cobweb.
   */
  _findPrioritizedCobwebBlock(fallbackBlock = null) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position || typeof this.bot.blockAt !== 'function') {
      return fallbackBlock || null;
    }
    const pos = this.bot.entity.position;
    const feetBlock = this.bot.blockAt(pos.floored());
    if (feetBlock && feetBlock.name === 'cobweb') return feetBlock;
    const headBlock = this.bot.blockAt(pos.floored().offset(0, 1, 0));
    if (headBlock && headBlock.name === 'cobweb') return headBlock;
    return fallbackBlock || null;
  },

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

  _startUninterruptedCobwebDig(cobwebBlock) {
    if (!cobwebBlock || !this.bot || typeof this.bot.dig !== 'function') return false;
    const token = ++this._cobwebDigToken;
    this.cobwebDigLock = true;
    this.cobwebDigPos = cobwebBlock.position.clone();
    const timeoutMs = this.escapeCfg.cobwebDigTimeoutMs !== undefined ? this.escapeCfg.cobwebDigTimeoutMs : 2200;

    let timer = null;
    const digPromise = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('cobweb_dig_timeout')), timeoutMs);
      Promise.resolve(this.bot.dig(cobwebBlock, true)).then(resolve, reject);
    });

    digPromise
      .catch(() => {
        try { if (typeof this.bot.stopDigging === 'function') this.bot.stopDigging(); } catch (_) {}
      })
      .finally(() => {
        if (timer) clearTimeout(timer);
        if (token === this._cobwebDigToken) {
          this.cobwebDigLock = false;
          this.cobwebDigPos = null;
        }
      });

    return true;
  },

  _tickCobwebEscape(cobwebBlock, target, context = {}) {
    const now = Date.now();
    this._setActiveMode('COBWEB_ESCAPE');
    this.modeTicks++;

    const targetWeb = this._findPrioritizedCobwebBlock(cobwebBlock);
    const exitInfo = this._findNearestNonCobwebExitYaw(targetWeb, target);

    // If an uninterrupted sword dig is already running, hold the lock until block becomes air!
    if (this.cobwebDigLock) {
      const liveBlock = this.cobwebDigPos && typeof this.bot.blockAt === 'function'
        ? this.bot.blockAt(this.cobwebDigPos)
        : null;
      if (!liveBlock || isAirLike(liveBlock) || liveBlock.name !== 'cobweb') {
        this._cobwebDigToken++;
        this.cobwebDigLock = false;
        this.cobwebDigPos = null;
        try { if (typeof this.bot.stopDigging === 'function') this.bot.stopDigging(); } catch (_) {}
      } else {
        this._applyCobwebWalkOut(exitInfo, false);
        return true;
      }
    }

    // Continue active cobweb water place/pickup
    if (this.waterCtrl.isActive('cobweb')) {
      this._applyCobwebWalkOut(exitInfo, false);
      const busy = this.waterCtrl.tick({
        kind: 'cobweb',
        targetPos: (targetWeb && targetWeb.position) || this.waterCtrl.targetPos,
        aimPoint: ((targetWeb && targetWeb.position) || this.waterCtrl.targetPos || this.bot.entity.position).offset(0.5, -0.02, 0.5),
        pickupTicks: 5,
        checkStillNeeded: () => Boolean(this.findOverlappingCobweb())
      });
      if (!busy) {
        this._setActiveMode('IDLE');
      }
      return busy;
    }

    if (!targetWeb) {
      if (this.miner && this.miner.digging) this.miner.cancel();
      this._setActiveMode('IDLE');
      return false;
    }

    // Tier 1: Water Bucket flush onto cobweb floor (fastest & cleanest — breaks web in 1 tick!)
    if (this.waterCtrl.canStart('cobweb', 500, now)) {
      if (this.miner && this.miner.digging) this.miner.cancel();
      this._applyCobwebWalkOut(exitInfo, false);
      const pos = targetWeb.position.floored();
      return this.waterCtrl.tick({
        kind: 'cobweb',
        targetPos: pos,
        aimPoint: pos.offset(0.5, -0.02, 0.5),
        pickupTicks: 5,
        checkStillNeeded: () => Boolean(this.findOverlappingCobweb())
      });
    }

    // Tier 2: Verified safe Ender Pearl escape
    const pearl = canThrowPearl(this.bot, { emergency: true, cooldownMs: 1800, now })
      ? findInventoryItem(this.bot, 'ender_pearl')
      : null;
    if (pearl) {
      const arc = this._findSafeCobwebPearlArc(target);
      if (arc) {
        if (this.miner && this.miner.digging) this.miner.cancel();
        this._applyCobwebWalkOut(exitInfo, false);
        const aim = this.aimer
          ? this.aimer.stepTowardsAngles(arc.yaw, arc.pitch, { speedMultiplier: 2.1, toleranceRad: 0.2, force: true })
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

    // Tier 3: Chorus Fruit instant teleport escape (if available)
    const chorus = findInventoryItem(this.bot, 'chorus_fruit');
    if (chorus && typeof this.bot.consume === 'function' && !this._chorusInFlight) {
      const eq = ensureItemHeld(this.bot, chorus);
      if (eq.swapped || !eq.held) return true;
      this._chorusInFlight = true;
      Promise.resolve(this.bot.consume())
        .catch(() => {})
        .finally(() => { this._chorusInFlight = false; });
      return true;
    }

    // Tier 4: Flint & Steel (ONLY if Fire Resistance is active!)
    const fns = this.hasFireResistance(context) ? findInventoryItem(this.bot, 'flint_and_steel') : null;
    if (fns && targetWeb.position && typeof this.bot.activateBlock === 'function') {
      const below = this.bot.blockAt(targetWeb.position.offset(0, -1, 0));
      if (below && below.boundingBox === 'block') {
        const aim = this.aimer
          ? this.aimer.stepTowardsPoint(below.position.offset(0.5, 1.0, 0.5), { speedMultiplier: 2.0, force: true })
          : { aligned: true };
        const eq = ensureItemHeld(this.bot, fns);
        if (eq.swapped || !eq.held || !aim.aligned) return true;
        Promise.resolve(this.bot.activateBlock(below, new Vec3(0, 1, 0))).catch(() => {});
        return true;
      }
    }

    // Tier 5 (LAST RESORT): Uninterrupted Highest-Tier Sword Mining (`await bot.dig(cobwebBlock, true)`)
    const swordRec = findInventoryItem(this.bot, SWORD_THEN_SHEARS);
    if (swordRec) {
      const eq = ensureItemHeld(this.bot, swordRec);
      if (eq.swapped || !eq.held) {
        this._applyCobwebWalkOut(exitInfo, false);
        return true;
      }
    }

    if (this.aimer && targetWeb.position) {
      this.aimer.stepTowardsPoint(targetWeb.position.offset(0.5, 0.5, 0.5), { speedMultiplier: 2.2, force: true });
    }
    this._applyCobwebWalkOut(exitInfo, false);
    this._startUninterruptedCobwebDig(targetWeb);
    return true;
  }
};

module.exports = { cobwebEscapeMethods };
