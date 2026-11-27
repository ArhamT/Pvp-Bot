'use strict';

const { Vec3 } = require('vec3');
const { clamp, DEG_TO_RAD } = require('../aim');
const {
  PEARL_SPEED,
  PEARL_GRAVITY,
  PEARL_DRAG,
  inspectColumnStep
} = require('../constants');
const { canMineBlock, pickBestToolForBlock } = require('../mining');

/**
 * CPvP Mobility & Unstick Mixin (`modules/burst/cpvp_mobility.js`):
 * Keeps Crystal/Anchor PvP relentless whenever the bot is stuck, stopped, or blocked
 * from reaching its opponent:
 * 1. Ender Pearl closing (`CPVP_PEARL_CLOSE`) — ballistic pearl arc onto opponent when >= 5.5b away or blocked by wall/crater.
 * 2. Walk-Jump closing (`CPVP_WALK_JUMP`) — sprint/walk + jump over 1-high obsidian blocks/craters toward opponent.
 * 3. Appropriate-tool mining (`CPVP_MINE_THROUGH`) — mines a 2-block-tall opening through obsidian/cobble/wood/dirt walls
 *    using the exact right tool (diamond/netherite pickaxe, axe, shovel, shears, or sword) and pushes through.
 */
const cpvpMobilityMethods = {
  _hasCpvpKit() {
    return Boolean(this._findItem('end_crystal') || this._findItem('respawn_anchor'));
  },

  _canMineCpvpBlock(block) {
    return Boolean(block && block.boundingBox === 'block' && canMineBlock(this.bot, block));
  },

  _pickCpvpMiningTool(block) {
    return pickBestToolForBlock(this.bot, block);
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

  _solveCpvpPearlPitch(targetPos) {
    const eye = this.aimer ? this.aimer.getEyePosition() : this.bot.entity.position.offset(0, 1.62, 0);
    const dx = targetPos.x - eye.x;
    const dy = (targetPos.y + 0.5) - eye.y;
    const dz = targetPos.z - eye.z;
    const horizDist = Math.hypot(dx, dz);
    const yaw = Math.atan2(-dx, -dz);

    if (horizDist < 1.0) return { yaw, pitch: clamp(Math.atan2(dy, 1.0), -65 * DEG_TO_RAD, 45 * DEG_TO_RAD) };

    let low = -45 * DEG_TO_RAD;
    let high = 45 * DEG_TO_RAD;
    for (let i = 0; i < 12; i++) {
      const mid = (low + high) * 0.5;
      let vx = PEARL_SPEED * Math.cos(mid);
      let vy = PEARL_SPEED * Math.sin(mid);
      let x = 0;
      let y = 0;
      let yAtDist = -Infinity;
      let reached = false;
      for (let t = 1; t <= 45; t++) {
        const px = x;
        const py = y;
        x += vx;
        y += vy;
        vx *= PEARL_DRAG;
        vy = vy * PEARL_DRAG - PEARL_GRAVITY;
        if (x >= horizDist) {
          const frac = (x - px) > 1e-6 ? (horizDist - px) / (x - px) : 0;
          yAtDist = py + (y - py) * frac;
          reached = true;
          break;
        }
      }
      if (!reached || yAtDist < dy) low = mid;
      else high = mid;
    }
    return { yaw, pitch: clamp((low + high) * 0.5, -55 * DEG_TO_RAD, 45 * DEG_TO_RAD) };
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
      if (this.stateTicks > 12) {
        this._resetOffensiveState(true);
        return false;
      }
      const pearl = this._findItem('ender_pearl');
      if (!pearl) {
        this._resetOffensiveState(true);
        return false;
      }
      const sol = this._solveCpvpPearlPitch(target.position);
      const aimStatus = this.aimer.stepTowardsAngles(sol.yaw, sol.pitch, {
        speedMultiplier: 1.9,
        toleranceRad: 0.14,
        force: true
      });
      const equipRes = this._ensureItemHeld(pearl);
      if (this.stepDelayTicks > 0 || equipRes.swappedThisTick || !equipRes.held || !aimStatus.aligned) {
        return true;
      }
      if (typeof this.bot.activateItem === 'function') {
        this.bot.activateItem(false);
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
        this.cpvpDigging = false;
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
        this.cpvpDigging = false;
        // Wall cleared -> immediately walk-jump through toward opponent!
        const walkYaw = Math.atan2(-plan.dir.dx, -plan.dir.dz);
        this.aimer.stepTowardsAngles(walkYaw, 0, { speedMultiplier: 1.7, force: true });
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
      this.cpvpDigging = this.miner.digging;
      if (digRes.status === 'unreachable' || digRes.status === 'unbreakable' || digRes.status === 'failed') {
        this.miner.cancel();
        this.cpvpDigging = false;
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
          // Hit a 2-high wall while walk-jumping -> escalate to Pearl or Mine!
          this.cpvpStuckTicks = 6;
        }
        return false;
      }
      this.aimer.stepTowardsAngles(pathCheck.yaw, 0.0, { speedMultiplier: 1.6, force: true });
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

    // Only trigger idle CPvP unstick/approach when carrying Crystal or Anchor kit & outside immediate burst placement
    if (!this._hasCpvpKit() || targetDist <= 3.5) {
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

    const pathCheck = this._inspectPathTowardTarget(target);
    const isStuckOrStopped = this.cpvpStuckTicks >= 5 || (pathCheck.blocked2High && this.cpvpStuckTicks >= 2);
    if (!isStuckOrStopped) {
      return false;
    }

    // Priority 1: Ender Pearl straight onto opponent when >= 5.5b away or blocked by wall/crater!
    const pearl = this._findItem('ender_pearl');
    if (pearl && (now - (this.lastCpvpPearlAt || 0)) >= 2200 && (targetDist >= 5.5 || pathCheck.blocked2High)) {
      this.state = 'CPVP_PEARL_CLOSE';
      this.activePlan = { kind: 'cpvp_pearl' };
      this.stateTicks = 0;
      this.stepDelayTicks = 0;
      return this._tickCpvpMobility(target);
    }

    // Priority 2: Walk-Jump over 1-high obsidian blocks/craters if not blocked by a 2-high wall
    if (!pathCheck.blocked2High) {
      this.state = 'CPVP_WALK_JUMP';
      this.activePlan = { kind: 'cpvp_walk_jump' };
      this.stateTicks = 0;
      this.cpvpStuckTicks = 0;
      return this._tickCpvpMobility(target);
    }

    // Priority 3: Mine straight through the 2-high blocking wall using the appropriate tool!
    const minePlan = this._planCpvpMineToward(target);
    if (minePlan) {
      this.state = 'CPVP_MINE_THROUGH';
      this.activePlan = minePlan;
      this.stateTicks = 0;
      this.stepDelayTicks = 0;
      this.cpvpDigging = false;
      this.cpvpStuckTicks = 0;
      return this._tickCpvpMobility(target);
    }

    return false;
  }
};

module.exports = { cpvpMobilityMethods };
