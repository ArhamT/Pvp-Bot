'use strict';

const { inspectColumnStep } = require('../constants');
const { canMineBlock } = require('../mining');

/**
 * Box & Wall Breakout Skill (`modules/escape/box_breakout.js`):
 * Detects when the bot is trapped in an opponent-built box or obsidian hole and breaks out
 * via the fastest safe exit (including single-block roof breakout when sky is open above!).
 */
const boxBreakoutMethods = {
  _canDigBlock(block) {
    return canMineBlock(this.bot, block);
  },

  _estimateBlockBreakCost(block) {
    if (!block || block.boundingBox !== 'block') return 0;
    if (!this._canDigBlock(block)) return Infinity;
    const name = block.name || '';
    if (name === 'obsidian' || name === 'crying_obsidian' || name === 'respawn_anchor') return 25;
    if (name.includes('deepslate') || name.includes('ancient_debris') || name.includes('iron_block')) return 10;
    if (name.includes('wool') || name.includes('dirt') || name.includes('sand') || name.includes('gravel') || name.includes('leaves')) return 1.5;
    if (name.includes('planks') || name.includes('log') || name.includes('wood') || name.includes('glass')) return 2.5;
    return 4.0;
  },

  _planBoxBreakout(target) {
    if (
      this.escapeCfg.allowBlockDig === false ||
      !this.bot || !this.bot.entity || !this.bot.entity.position ||
      typeof this.bot.blockAt !== 'function' || typeof this.bot.dig !== 'function'
    ) {
      return null;
    }

    const pos = this.bot.entity.position;
    const feet = pos.floored();
    const ceiling = this.bot.blockAt(feet.offset(0, 2, 0));
    const hasCeiling = Boolean(ceiling && ceiling.boundingBox === 'block');

    const cardinals = [
      { dx: 1, dz: 0 },
      { dx: -1, dz: 0 },
      { dx: 0, dz: 1 },
      { dx: 0, dz: -1 }
    ];

    let blockedDirs = 0;
    let bestPlan = null;

    for (const dir of cardinals) {
      const col = inspectColumnStep(this.bot, pos.x + dir.dx * 0.95, pos.y, pos.z + dir.dz * 0.95);
      const exitBlocked = col.blocked || (col.needsJump && hasCeiling);
      if (!exitBlocked) {
        return null;
      }
      blockedDirs++;

      const bFeet = this.bot.blockAt(feet.offset(dir.dx, 0, dir.dz));
      const bHead = this.bot.blockAt(feet.offset(dir.dx, 1, dir.dz));
      const costFeet = this._estimateBlockBreakCost(bFeet);
      const costHead = this._estimateBlockBreakCost(bHead);
      const totalCost = costFeet + costHead;
      if (!Number.isFinite(totalCost) || totalCost <= 0) continue;

      const behind = this.bot.blockAt(feet.offset(dir.dx * 2, 0, dir.dz * 2));
      if (behind && (behind.name.includes('lava') || behind.name.includes('fire'))) continue;

      let score = -totalCost * 4;
      if (target && target.position) {
        const toTargetX = target.position.x - pos.x;
        const toTargetZ = target.position.z - pos.z;
        const len = Math.sqrt(toTargetX * toTargetX + toTargetZ * toTargetZ) || 1;
        score += ((toTargetX * dir.dx + toTargetZ * dir.dz) / len) * 3.0;
      }

      if (!bestPlan || score > bestPlan.score) {
        bestPlan = {
          kind: 'WALL',
          dir,
          originFeet: feet.clone(),
          score,
          ticks: 0
        };
      }
    }

    if (blockedDirs < 4) return null;

    // Also evaluate 1-block roof breakout when sky above y+3 is open and we have pillar blocks
    if (hasCeiling && this._canDigBlock(ceiling) && this._findEscapeBlock()) {
      const aboveRoof = this.bot.blockAt(feet.offset(0, 3, 0));
      if (!aboveRoof || aboveRoof.boundingBox !== 'block') {
        const roofCost = this._estimateBlockBreakCost(ceiling);
        const roofScore = -roofCost * 4 + 2.0; // Breaking 1 roof block is faster than 2 wall blocks
        if (!bestPlan || roofScore > bestPlan.score) {
          bestPlan = {
            kind: 'ROOF',
            dir: { dx: 0, dz: 0 },
            originFeet: feet.clone(),
            score: roofScore,
            ticks: 0
          };
        }
      }
    }

    return bestPlan;
  },

  _planForwardWallMine(target) {
    if (
      this.escapeCfg.allowBlockDig === false ||
      !this.bot || !this.bot.entity || !this.bot.entity.position ||
      typeof this.bot.blockAt !== 'function' || typeof this.bot.dig !== 'function'
    ) {
      return null;
    }

    const pos = this.bot.entity.position;
    if (target && target.isValid && target.position && pos.distanceTo(target.position) <= 4.5) {
      return null;
    }

    const yaw = (target && target.isValid && target.position)
      ? Math.atan2(-(target.position.x - pos.x), -(target.position.z - pos.z))
      : (this.bot.entity.yaw || 0);
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const dir = Math.abs(fx) >= Math.abs(fz)
      ? { dx: Math.sign(fx) || 1, dz: 0 }
      : { dx: 0, dz: Math.sign(fz) || 1 };

    const feet = pos.floored();
    const bFeet = this.bot.blockAt(feet.offset(dir.dx, 0, dir.dz));
    const bHead = this.bot.blockAt(feet.offset(dir.dx, 1, dir.dz));
    const hasWall = (bFeet && bFeet.boundingBox === 'block') || (bHead && bHead.boundingBox === 'block');
    if (!hasWall) return null;

    const costFeet = this._estimateBlockBreakCost(bFeet);
    const costHead = this._estimateBlockBreakCost(bHead);
    if (!Number.isFinite(costFeet + costHead) || (costFeet + costHead) <= 0) return null;

    const behind = this.bot.blockAt(feet.offset(dir.dx * 2, 0, dir.dz * 2));
    if (behind && (behind.name.includes('lava') || behind.name.includes('fire'))) return null;

    return {
      kind: 'WALL',
      dir,
      originFeet: feet.clone(),
      score: 0,
      ticks: 0,
      isForwardObstacle: true
    };
  },

  _tickBoxBreakout(target, context) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) return false;

    if (this.activeMode === 'BOX_MINE' && this.boxMinePlan) {
      if (
        this.boxMinePlan.isForwardObstacle &&
        target && target.isValid && target.position &&
        this.bot.entity.position.distanceTo(target.position) <= 4.0
      ) {
        if (this.miner) this.miner.cancel();
        this.diggingInProgress = false;
        this.boxMinePlan = null;
        this._setActiveMode('IDLE');
        return false;
      }

      this.boxMinePlan.ticks++;
      if (this.boxMinePlan.ticks > 360) {
        if (this.miner) this.miner.cancel();
        this.diggingInProgress = false;
        this.boxMinePlan = null;
        this._setActiveMode('IDLE');
        return false;
      }

      const { kind, dir, originFeet } = this.boxMinePlan;
      let nextToDig = null;

      if (kind === 'ROOF') {
        const roofBlock = this.bot.blockAt(originFeet.offset(0, 2, 0));
        if (roofBlock && roofBlock.boundingBox === 'block' && this._canDigBlock(roofBlock)) {
          nextToDig = roofBlock;
        }
      } else {
        const headBlock = this.bot.blockAt(originFeet.offset(dir.dx, 1, dir.dz));
        const feetBlock = this.bot.blockAt(originFeet.offset(dir.dx, 0, dir.dz));
        nextToDig = (headBlock && headBlock.boundingBox === 'block' && this._canDigBlock(headBlock))
          ? headBlock
          : ((feetBlock && feetBlock.boundingBox === 'block' && this._canDigBlock(feetBlock)) ? feetBlock : null);
      }

      if (!nextToDig) {
        if (this.miner) this.miner.cancel();
        this.diggingInProgress = false;
        this.boxMinePlan = null;

        if (kind === 'ROOF') {
          this._setActiveMode('IDLE');
          return this._tickBlockEscape(target, context);
        }

        const exitYaw = Math.atan2(-dir.dx, -dir.dz);
        if (this.aimer) {
          this.aimer.stepTowardsAngles(exitYaw, 0.0, { speedMultiplier: 1.6 });
        }
        if (typeof this.bot.setControlState === 'function') {
          this.bot.setControlState('sneak', false);
          this.bot.setControlState('forward', true);
          this.bot.setControlState('back', false);
          this.bot.setControlState('left', false);
          this.bot.setControlState('right', false);
          this.bot.setControlState('sprint', this.bot.food > 6);
          this.bot.setControlState('jump', false);
        }
        this._setActiveMode('STALL_UNSTICK');
        this.detourYaw = exitYaw;
        this.detourTicks = 6;
        return true;
      }

      const digRes = this.miner.mineBlockTick(nextToDig, { allowEmbedded: true });
      this.diggingInProgress = this.miner.digging;
      if (digRes.status === 'unreachable' || digRes.status === 'unbreakable' || digRes.status === 'failed') {
        this.miner.cancel();
        this.diggingInProgress = false;
        this.boxMinePlan = null;
        this._setActiveMode('IDLE');
        return false;
      }
      return true;
    }

    if (!context || !context.canTrackStall) {
      this.boxedTicks = 0;
      return false;
    }

    const plan = this._planBoxBreakout(target);
    if (!plan) {
      this.boxedTicks = 0;
      return false;
    }

    this.boxedTicks++;
    if (this.boxedTicks < 3) return false;

    this.boxedTicks = 0;
    this.boxMinePlan = plan;
    this._setActiveMode('BOX_MINE');
    return this._tickBoxBreakout(target, context);
  }
};

module.exports = { boxBreakoutMethods };
