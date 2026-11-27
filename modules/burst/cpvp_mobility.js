'use strict';

const { inspectColumnStep } = require('../constants');
const { canMineBlock } = require('../mining');
const {
  canThrowPearl,
  markPearlThrown,
  solvePearlBallistics,
  simulatePearlFlight,
  isSafePearlLanding
} = require('../pearl_ballistics');

/**
 * CPvP Mobility & Unstick Mixin (`modules/burst/cpvp_mobility.js`):
 * 1. Safe Ballistic Ender Pearl closing (`CPVP_PEARL_CLOSE`) — shared cooldown/reserve + landing safety check!
 * 2. Walk-Jump closing (`CPVP_WALK_JUMP`) — sprint/walk + jump over 1-high obsidian blocks/craters.
 * 3. Appropriate-tool mining (`CPVP_MINE_THROUGH`) — mines through 2-high blocking walls even at close range.
 */
const cpvpMobilityMethods = {
  _hasCpvpKit() {
    return Boolean(this._findItem('end_crystal') || this._findItem('respawn_anchor'));
  },

  _canMineCpvpBlock(block) {
    return Boolean(block && block.boundingBox === 'block' && canMineBlock(this.bot, block));
  },

  _inspectPathTowardTarget(target) {
    const pos = this.bot.entity.position;
    const dx = target.position.x - pos.x;
    const dz = target.position.z - pos.z;
    const horizDist = Math.hypot(dx, dz);
    if (horizDist < 0.2) return { blocked2High: false, needsJump: false, yaw: this.bot.entity.yaw || 0 };

    const yaw = Math.atan2(-dx, -dz);
    const fx = dx / horizDist;
    const fz = dz / horizDist;
    let blocked2High = false;
    let needsJump = false;

    for (const d of [0.55, 1.05]) {
      const col = inspectColumnStep(this.bot, pos.x + fx * d, pos.y, pos.z + fz * d);
      if (col.blocked) blocked2High = true;
      else if (col.needsJump) needsJump = true;
    }
    return { blocked2High, needsJump, yaw };
  },

  _planCpvpMineToward(target) {
    if (typeof this.bot.blockAt !== 'function' || typeof this.bot.dig !== 'function') return null;
    const pos = this.bot.entity.position;
    const dx = target.position.x - pos.x;
    const dz = target.position.z - pos.z;
    const dir = Math.abs(dx) >= Math.abs(dz)
      ? { dx: Math.sign(dx) || 1, dz: 0 }
      : { dx: 0, dz: Math.sign(dz) || 1 };

    const feet = pos.floored();
    const bFeet = this.bot.blockAt(feet.offset(dir.dx, 0, dir.dz));
    const bHead = this.bot.blockAt(feet.offset(dir.dx, 1, dir.dz));
    const canFeet = bFeet && bFeet.boundingBox === 'block' ? this._canMineCpvpBlock(bFeet) : true;
    const canHead = bHead && bHead.boundingBox === 'block' ? this._canMineCpvpBlock(bHead) : true;
    const hasSolid = (bFeet && bFeet.boundingBox === 'block') || (bHead && bHead.boundingBox === 'block');
    if (!hasSolid || !canFeet || !canHead) return null;

    return { kind: 'cpvp_mine', dir, originFeet: feet.clone(), ticks: 0 };
  },

  _tickCpvpMobility(target) {
    if (!target || !target.isValid || !this.bot || !this.bot.entity || !this.bot.entity.position) {
      return false;
    }

    const now = Date.now();
    const pos = this.bot.entity.position;
    const targetDist = pos.distanceTo(target.position);

    // 1. Continue active Ender Pearl gap-close
    if (this.state === 'CPVP_PEARL_CLOSE') {
      this.stateTicks++;
      if (this.stateTicks > 12 || this.bot.health <= 5) {
        this._resetOffensiveState(true);
        return false;
      }
      const pearl = this._findItem('ender_pearl');
      if (!pearl) {
        this._resetOffensiveState(true);
        return false;
      }
      const eye = this.aimer ? this.aimer.getEyePosition() : pos.offset(0, 1.62, 0);
      const sol = solvePearlBallistics(eye, target.position.offset(0, 0.5, 0), target.velocity, 50);
      if (!sol) {
        this._resetOffensiveState(true);
        return false;
      }
      const sim = simulatePearlFlight(this.bot, eye, sol.yaw, sol.pitch, 50);
      if (!sim.hit || !isSafePearlLanding(this.bot, sim.pos, { maxDrop: 4 })) {
        this._resetOffensiveState(true);
        return false;
      }

      const aimStatus = this.aimer.stepTowardsAngles(sol.yaw, sol.pitch, {
        speedMultiplier: 1.9,
        toleranceRad: 0.14
      });
      const equipRes = this._ensureItemHeld(pearl);
      if (this.stepDelayTicks > 0 || equipRes.swappedThisTick || !equipRes.held || !aimStatus.aligned) {
        return true;
      }
      if (typeof this.bot.activateItem === 'function') {
        this.bot.activateItem(false);
        markPearlThrown(this.bot, 'cpvp_close', now);
      }
      this.lastCpvpPearlAt = now;
      this.cpvpStuckTicks = 0;
      this._resetOffensiveState(true);
      return true;
    }

    // 2. Continue active 2-block-tall mining through blocking wall toward opponent
    if (this.state === 'CPVP_MINE_THROUGH') {
      const plan = this.activePlan;
      this.stateTicks++;
      if (!plan || this.stateTicks > 360) {
        if (this.miner) this.miner.cancel();
        this._resetOffensiveState(true);
        return false;
      }

      const headBlock = this.bot.blockAt(plan.originFeet.offset(plan.dir.dx, 1, plan.dir.dz));
      const feetBlock = this.bot.blockAt(plan.originFeet.offset(plan.dir.dx, 0, plan.dir.dz));
      const nextToDig = (headBlock && headBlock.boundingBox === 'block' && this._canMineCpvpBlock(headBlock))
        ? headBlock
        : ((feetBlock && feetBlock.boundingBox === 'block' && this._canMineCpvpBlock(feetBlock)) ? feetBlock : null);

      if (!nextToDig) {
        if (this.miner) this.miner.cancel();
        const walkYaw = Math.atan2(-plan.dir.dx, -plan.dir.dz);
        this.aimer.stepTowardsAngles(walkYaw, 0, { speedMultiplier: 1.7 });
        if (typeof this.bot.setControlState === 'function') {
          this.bot.setControlState('forward', true);
          this.bot.setControlState('back', false);
          this.bot.setControlState('sprint', this.bot.food > 6);
          this.bot.setControlState('jump', Boolean(this.bot.entity.onGround));
        }
        this.cpvpStuckTicks = 0;
        this._resetOffensiveState(false);
        return true;
      }

      const digRes = this.miner.mineBlockTick(nextToDig);
      if (digRes.status === 'unreachable' || digRes.status === 'unbreakable' || digRes.status === 'failed') {
        this.miner.cancel();
        this._resetOffensiveState(true);
        return false;
      }
      return true;
    }

    // 3. Continue active walk-jump push toward opponent over obsidian/craters
    if (this.state === 'CPVP_WALK_JUMP') {
      this.stateTicks++;
      const pathCheck = this._inspectPathTowardTarget(target);
      if (targetDist <= 3.6 || this.stateTicks > 14 || pathCheck.blocked2High) {
        this._resetOffensiveState(false);
        if (pathCheck.blocked2High) {
          this.cpvpStuckTicks = 6;
        }
        return false;
      }
      this.aimer.stepTowardsAngles(pathCheck.yaw, 0.0, { speedMultiplier: 1.6 });
      if (typeof this.bot.setControlState === 'function') {
        this.bot.setControlState('forward', true);
        this.bot.setControlState('back', false);
        this.bot.setControlState('left', false);
        this.bot.setControlState('right', false);
        this.bot.setControlState('sprint', this.bot.food > 6);
        this.bot.setControlState('jump', Boolean(this.bot.entity.onGround));
      }
      return true;
    }

    if (!this._hasCpvpKit()) {
      this.cpvpStuckTicks = 0;
      this.lastCpvpPos = pos.clone();
      return false;
    }

    const pathCheck = this._inspectPathTowardTarget(target);
    // Allow wall-mining unstick even at <= 3.5b if a 2-high wall separates us from target!
    if (targetDist <= 3.5 && !pathCheck.blocked2High) {
      this.cpvpStuckTicks = 0;
      this.lastCpvpPos = pos.clone();
      return false;
    }

    if (this.lastCpvpPos) {
      const moved = Math.hypot(pos.x - this.lastCpvpPos.x, pos.z - this.lastCpvpPos.z);
      if (moved < 0.05 || this.bot.entity.isCollidedHorizontally) {
        this.cpvpStuckTicks++;
      } else {
        this.cpvpStuckTicks = Math.max(0, this.cpvpStuckTicks - 1);
      }
    }
    this.lastCpvpPos = pos.clone();

    const isStuckOrStopped = this.cpvpStuckTicks >= 5 || (pathCheck.blocked2High && this.cpvpStuckTicks >= 2);
    if (!isStuckOrStopped) {
      return false;
    }

    // Priority 1: Safe Ender Pearl gap-close (uses shared cooldown & HP >= 7 safety check!)
    const pearl = (
      this.bot.health >= 7 &&
      (targetDist >= 5.5 || pathCheck.blocked2High) &&
      canThrowPearl(this.bot, { emergency: false, reserveCount: 1, cooldownMs: 2200, now })
    ) ? this._findItem('ender_pearl') : null;
    if (pearl) {
      this.activePlan = { kind: 'cpvp_pearl' };
      this._enterState('CPVP_PEARL_CLOSE');
      return this._tickCpvpMobility(target);
    }

    // Priority 2: Walk-Jump over 1-high obsidian blocks/craters
    if (!pathCheck.blocked2High) {
      this.activePlan = { kind: 'cpvp_walk_jump' };
      this._enterState('CPVP_WALK_JUMP');
      this.cpvpStuckTicks = 0;
      return this._tickCpvpMobility(target);
    }

    // Priority 3: Mine straight through the 2-high blocking wall using the appropriate tool
    const minePlan = this._planCpvpMineToward(target);
    if (minePlan) {
      this.activePlan = minePlan;
      this._enterState('CPVP_MINE_THROUGH');
      this.cpvpStuckTicks = 0;
      return this._tickCpvpMobility(target);
    }

    return false;
  }
};

module.exports = { cpvpMobilityMethods };
