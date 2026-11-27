'use strict';

const { Vec3 } = require('vec3');
const { isAirLike, inspectColumnStep } = require('../constants');
const { normalizeAngle } = require('../aim');
const { findItemByPredicate, ensureItemHeld } = require('../inventory_utils');
const { canSeeBlockFace } = require('../placement_los');
const { LOS_BLOCK_NAMES } = require('./constants');

const FULL_FAN_OFFSETS = [
  0,
  0.42, -0.42,
  0.85, -0.85,
  1.28, -1.28,
  1.72, -1.72,
  2.20, -2.20,
  Math.PI
];

/**
 * High-Tier Retreat, Obstacle-Routing Heal-Walk, & LOS Cover Block Skill (`modules/survival/retreat_heal.js`):
 * - 12-direction 2-step lookahead navigation around walls, pillars, fences, and arena corners
 * - Real-time stuck detection (`_updateRetreatObstacleSteering`): automatically changes direction and
 *   locks a clean detour yaw for 16–24 ticks when blocked or cornered
 * - Hitbox-verified LOS cover block placement + seamless splash/drink/gapple coordination
 */
const retreatHealMethods = {
  findLosBuildingBlock() {
    const found = findItemByPredicate(this.bot, (item) => item && LOS_BLOCK_NAMES.has(item.name));
    return found ? found.item : null;
  },

  _getAwayYaw(target) {
    if (!target || !target.position || !this.bot.entity) return this.bot.entity ? this.bot.entity.yaw : 0;
    const dx = this.bot.entity.position.x - target.position.x;
    const dz = this.bot.entity.position.z - target.position.z;
    return Math.atan2(-dx, -dz);
  },

  _hasCoverBetween(target) {
    if (!target || !target.position || !this.bot.entity || typeof this.bot.blockAt !== 'function') return false;
    const botPos = this.bot.entity.position;
    const dx = target.position.x - botPos.x;
    const dz = target.position.z - botPos.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1.5) return false;
    const nx = dx / len;
    const nz = dz / len;
    for (const step of [1.0, 1.8]) {
      const b0 = this.bot.blockAt(new Vec3(Math.floor(botPos.x + nx * step), Math.floor(botPos.y), Math.floor(botPos.z + nz * step)));
      const b1 = this.bot.blockAt(new Vec3(Math.floor(botPos.x + nx * step), Math.floor(botPos.y + 1), Math.floor(botPos.z + nz * step)));
      if ((b0 && b0.boundingBox === 'block') || (b1 && b1.boundingBox === 'block')) {
        return true;
      }
    }
    return false;
  },

  _tryQueueLosBlock(target) {
    if (!target || !target.position || !this.bot.entity || !this.bot.entity.onGround) return false;
    if (typeof this.bot.placeBlock !== 'function' || typeof this.bot.blockAt !== 'function') return false;
    const now = Date.now();
    const cd = this.survCfg.losBlockCooldownMs !== undefined ? this.survCfg.losBlockCooldownMs : 950;
    if ((now - this.lastLosBlockTime) < cd || this.pendingLosBlock) return false;
    if (this._hasCoverBetween(target)) return false;

    const blockItem = this.findLosBuildingBlock();
    if (!blockItem) return false;

    const botPos = this.bot.entity.position;
    const dist = botPos.distanceTo(target.position);
    if (dist < 2.2 || dist > 6.5) return false;

    const dx = target.position.x - botPos.x;
    const dz = target.position.z - botPos.z;
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    const placePos = new Vec3(
      Math.floor(botPos.x + (dx / len) * 1.4),
      Math.floor(botPos.y),
      Math.floor(botPos.z + (dz / len) * 1.4)
    );

    const botFeet = botPos.floored();
    if (placePos.x === botFeet.x && placePos.z === botFeet.z) return false;
    const center = placePos.offset(0.5, 0.5, 0.5);
    if (center.distanceTo(target.position.offset(0, 0.5, 0)) < 0.9) return false;
    if (!isAirLike(this.bot.blockAt(placePos))) return false;

    const refPos = placePos.offset(0, -1, 0);
    const refBlock = this.bot.blockAt(refPos);
    if (!refBlock || refBlock.boundingBox !== 'block') return false;

    const vis = canSeeBlockFace(this.bot, refPos, new Vec3(0, 1, 0), { aimer: this.aimer, maxReach: 4.5 });
    if (!vis) return false;

    this.pendingLosBlock = {
      item: blockItem,
      refPos,
      face: new Vec3(0, 1, 0),
      aimPos: vis.aimPos,
      ticks: 0
    };
    return true;
  },

  _tickPendingLosBlock() {
    const plan = this.pendingLosBlock;
    if (!plan) return false;
    plan.ticks++;
    if (plan.ticks > 10) {
      this.pendingLosBlock = null;
      return false;
    }

    const aim = this.aimer
      ? this.aimer.stepTowardsPoint(plan.aimPos, { speedMultiplier: 2.0, toleranceRad: 0.25 })
      : { aligned: true };
    const eq = ensureItemHeld(this.bot, { item: plan.item });
    if (eq.swapped || !eq.held || !aim.aligned) {
      return true;
    }

    const refBlock = this.bot.blockAt(plan.refPos);
    if (
      refBlock &&
      refBlock.boundingBox === 'block' &&
      canSeeBlockFace(this.bot, plan.refPos, plan.face, { aimer: this.aimer, maxReach: 4.5 })
    ) {
      Promise.resolve(this.bot.placeBlock(refBlock, plan.face)).catch(() => {});
      this.lastLosBlockTime = Date.now();
    }
    this.pendingLosBlock = null;
    return true;
  },

  /**
   * Evaluates a yaw direction over 2 lookahead steps (`0.9b` and `1.9b`) for walls, hazards, and drops.
   * Returns `{ ok, clearFar, needsJump }`.
   */
  _inspectYawClearance(yaw) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position || typeof this.bot.blockAt !== 'function') {
      return { ok: true, clearFar: true, needsJump: false };
    }
    const pos = this.bot.entity.position;
    const dx = -Math.sin(yaw);
    const dz = -Math.cos(yaw);

    const checkStep = (dist, baseY) => {
      const col = inspectColumnStep(this.bot, pos.x + dx * dist, baseY, pos.z + dz * dist);
      if (col.blocked || col.hasHazard) return { ok: false, needsJump: false, nextY: baseY };
      if (!col.hasFloor) {
        const bx = Math.floor(pos.x + dx * dist);
        const by = Math.floor(baseY);
        const bz = Math.floor(pos.z + dz * dist);
        let solid = false;
        for (let d = 2; d <= 3; d++) {
          const b = this.bot.blockAt(new Vec3(bx, by - d, bz));
          if (b && b.boundingBox === 'block') { solid = true; break; }
        }
        if (!solid) return { ok: false, needsJump: false, nextY: baseY };
      }
      return { ok: true, needsJump: col.needsJump, nextY: col.targetFeetY };
    };

    const near = checkStep(0.95, pos.y);
    if (!near.ok) return { ok: false, clearFar: false, needsJump: false };

    const far = checkStep(1.95, near.nextY);
    return {
      ok: true,
      clearFar: far.ok,
      needsJump: Boolean(near.needsJump)
    };
  },

  _isYawWalkable(yaw) {
    return this._inspectYawClearance(yaw);
  },

  /**
   * Obstacle-aware, stuck-detecting retreat steering:
   * - Detects when horizontal progress stalls (< 0.08b/tick for 4+ ticks) on pillars/walls/corners
   * - Scans all 12 compass directions over 2-block lookahead to route AROUND blocks cleanly
   * - Locks a detour yaw for 16–22 ticks whenever stuck or blocked so the bot commits to clearing the obstacle
   */
  _chooseObstacleAwareRetreatYaw(target) {
    const pos = this.bot.entity.position;
    const awayYaw = this._getAwayYaw(target);

    // Track horizontal stuck detection
    if (this._retreatLastPos) {
      const moved = Math.hypot(pos.x - this._retreatLastPos.x, pos.z - this._retreatLastPos.z);
      if (moved < 0.075) {
        this._retreatStuckTicks = (this._retreatStuckTicks || 0) + 1;
      } else {
        this._retreatStuckTicks = Math.max(0, (this._retreatStuckTicks || 0) - 1);
      }
    } else {
      this._retreatStuckTicks = 0;
    }
    this._retreatLastPos = pos.clone();

    const isStuck = (this._retreatStuckTicks || 0) >= 4;

    // Keep locked detour yaw while it stays clear and we aren't newly stuck
    if (!isStuck && this._retreatDetourTicks > 0 && typeof this._retreatDetourYaw === 'number') {
      this._retreatDetourTicks--;
      const check = this._inspectYawClearance(this._retreatDetourYaw);
      if (check.ok) {
        return { yaw: this._retreatDetourYaw, needsJump: check.needsJump, detouring: true };
      }
      this._retreatDetourTicks = 0;
    }

    // Check direct away direction first if not stuck
    const directCheck = this._inspectYawClearance(awayYaw);
    if (!isStuck && directCheck.ok && directCheck.clearFar) {
      this._retreatDetourYaw = null;
      return { yaw: awayYaw, needsJump: directCheck.needsJump, detouring: false };
    }

    // Score all 12 compass directions around obstacles, preferring directions that clear the block AND gain distance
    const prevBadYaw = isStuck ? (this._retreatDetourYaw !== null && this._retreatDetourYaw !== undefined ? this._retreatDetourYaw : awayYaw) : null;
    const sidePref = this.retreatStrafeDir || 1;
    let best = null;

    for (let i = 0; i < FULL_FAN_OFFSETS.length; i++) {
      const off = FULL_FAN_OFFSETS[i] * sidePref;
      const candYaw = normalizeAngle(awayYaw + off);
      const check = this._inspectYawClearance(candYaw);
      if (!check.ok) continue;

      let score = 0;
      // Reward full 2-block clearance heavily so we don't turn into a dead-end niche
      score += check.clearFar ? 30 : 8;
      // Reward moving away from opponent (cos(off) = +1 straight away, 0 perpendicular, -1 toward)
      score += Math.cos(off) * 18;
      // Mild penalty for jumping over ledges vs smooth flat corridor
      if (check.needsJump) score -= 2.5;
      // When stuck, strongly penalize the direction we were just stuck running into!
      if (prevBadYaw !== null) {
        const diffFromBad = Math.abs(normalizeAngle(candYaw - prevBadYaw));
        if (diffFromBad < 0.75) score -= 40;
        else score += diffFromBad * 6;
      }
      // Reward continuity with previous detour direction if still valid
      if (!isStuck && typeof this._retreatDetourYaw === 'number') {
        const diffPrev = Math.abs(normalizeAngle(candYaw - this._retreatDetourYaw));
        score -= diffPrev * 4;
      }

      if (!best || score > best.score) {
        best = { yaw: candYaw, needsJump: check.needsJump, score };
      }
    }

    if (best) {
      // Flip default side preference on stuck so we explore the opposite side if we hit another wall
      if (isStuck) {
        this.retreatStrafeDir = -(this.retreatStrafeDir || 1);
        this._retreatStuckTicks = 0;
      }
      const offFromAway = Math.abs(normalizeAngle(best.yaw - awayYaw));
      if (isStuck || offFromAway > 0.35) {
        this._retreatDetourYaw = best.yaw;
        this._retreatDetourTicks = isStuck ? 20 : 14;
        return { yaw: best.yaw, needsJump: best.needsJump, detouring: true };
      }
      return { yaw: best.yaw, needsJump: best.needsJump, detouring: false };
    }

    // Complete cornered fallback: turn perpendicular/away from wall
    const fallbackYaw = normalizeAngle(awayYaw + (this.retreatStrafeDir || 1) * (Math.PI * 0.75));
    this.retreatStrafeDir = -(this.retreatStrafeDir || 1);
    this._retreatStuckTicks = 0;
    this._retreatDetourYaw = fallbackYaw;
    this._retreatDetourTicks = 14;
    return { yaw: fallbackYaw, needsJump: true, detouring: true };
  },

  _moveAwayWalk(target) {
    if (!this.bot || !this.bot.entity) return;
    const nav = this._chooseObstacleAwareRetreatYaw(target);

    if (this.aimer) {
      this.aimer.stepTowardsAngles(nav.yaw, 0.0, { speedMultiplier: 1.75, toleranceRad: 0.25 });
    }
    if (typeof this.bot.setControlState === 'function') {
      // Only add slight weaving strafe when NOT routing around an obstacle (never push into walls!)
      let left = false;
      let right = false;
      if (!nav.detouring) {
        this.healStrafeTicks--;
        if (this.healStrafeTicks <= 0) {
          this.healStrafeDir = -this.healStrafeDir;
          this.healStrafeTicks = 9 + Math.floor(Math.random() * 8);
        }
        const sideYaw = nav.yaw + (this.healStrafeDir > 0 ? Math.PI / 2 : -Math.PI / 2);
        if (this._inspectYawClearance(sideYaw).ok) {
          left = this.healStrafeDir < 0;
          right = this.healStrafeDir > 0;
        }
      }
      this.bot.setControlState('forward', true);
      this.bot.setControlState('back', false);
      this.bot.setControlState('left', left);
      this.bot.setControlState('right', right);
      this.bot.setControlState('sprint', false);
      this.bot.setControlState('jump', Boolean(nav.needsJump && this.bot.entity.onGround));
    }
  },

  tickRetreating(target) {
    if (!this.bot || !this.bot.entity) return;
    const now = Date.now();

    if (this.pendingSplashPotion) {
      this._tickSplashPotionDownward(target, false);
      return;
    }

    if (this.pendingLosBlock) {
      this._tickPendingLosBlock();
      return;
    }

    if (this.isConsuming) {
      const eatTimeout = this.survCfg.eatTimeoutMs || 3500;
      if ((now - this.consumeStartTime) > eatTimeout) {
        this._consumeToken++;
        try { if (typeof this.bot.deactivateItem === 'function') this.bot.deactivateItem(); } catch (_) {}
        this.isConsuming = false;
        this.isDrinkingPotion = false;
      } else {
        this._moveAwayWalk(target);
        return;
      }
    }

    // Fast splash heal during retreat (280ms chain cooldown when low!)
    const potCooldownMs = this.bot.health <= 9
      ? Math.min(280, this.survCfg.potionCooldownMs || 350)
      : (this.survCfg.potionCooldownMs !== undefined ? this.survCfg.potionCooldownMs : 350);
    const healPot = (now - this.lastPotionTime) >= potCooldownMs ? this.findHealingPotion() : null;
    if (healPot) {
      this._queueSplashPotion(healPot, false, null);
      this._tickSplashPotionDownward(target, false);
      return;
    }

    const dist = (target && target.position) ? this.bot.entity.position.distanceTo(target.position) : 99;
    const retreatDist = this.survCfg.retreatDistance || 7.5;

    if (dist < 4.8 && this._tryQueueLosBlock(target)) {
      this._tickPendingLosBlock();
      return;
    }

    // Start eating/drinking once we have cover OR sufficient gap (>= 4.5b)
    if (dist >= Math.min(4.5, retreatDist * 0.6) || this._hasCoverBetween(target)) {
      const drinkHeal = this.findDrinkableHealPotion();
      if (drinkHeal && this._startDrinkingPotion(drinkHeal, null)) {
        this._moveAwayWalk(target);
        return;
      }
      const food = this.findGoldenApple() || this.findBestHealFood();
      if (food && this._startEatingFood(food)) {
        this._moveAwayWalk(target);
        return;
      }
    }

    // Obstacle-aware sprint-jump away to create safe healing gap
    const nav = this._chooseObstacleAwareRetreatYaw(target);
    if (this.aimer) {
      this.aimer.stepTowardsAngles(nav.yaw, 0.0, { speedMultiplier: 1.9, toleranceRad: 0.25 });
    }
    if (typeof this.bot.setControlState === 'function') {
      const canSprint = this.bot.food > 6;
      this.bot.setControlState('forward', true);
      this.bot.setControlState('back', false);
      this.bot.setControlState('left', false);
      this.bot.setControlState('right', false);
      this.bot.setControlState('sprint', canSprint);
      // Jump over ledges OR sprint-jump on flat open ground (not into low ceilings/walls)
      this.bot.setControlState('jump', Boolean(this.bot.entity.onGround && (nav.needsJump || !nav.detouring)));
    }
  },

  tickHealing(target) {
    if (!this.bot || !this.bot.entity) return;
    const now = Date.now();

    if (this.pendingSplashPotion) {
      this._tickSplashPotionDownward(target, false);
      return;
    }

    if (this.isConsuming) {
      const eatTimeout = this.survCfg.eatTimeoutMs || 3500;
      if ((now - this.consumeStartTime) > eatTimeout) {
        this._consumeToken++;
        try { if (typeof this.bot.deactivateItem === 'function') this.bot.deactivateItem(); } catch (_) {}
        this.isConsuming = false;
        this.isDrinkingPotion = false;
      } else {
        this._moveAwayWalk(target);
        return;
      }
    }

    const potCooldownMs = this.bot.health <= 9
      ? Math.min(280, this.survCfg.potionCooldownMs || 350)
      : (this.survCfg.potionCooldownMs !== undefined ? this.survCfg.potionCooldownMs : 350);
    const healPot = (now - this.lastPotionTime) >= potCooldownMs ? this.findHealingPotion() : null;
    if (healPot) {
      this._queueSplashPotion(healPot, false, null);
      this._tickSplashPotionDownward(target, false);
      return;
    }

    const drinkHeal = this.findDrinkableHealPotion();
    if (drinkHeal && this._startDrinkingPotion(drinkHeal, null)) {
      this._moveAwayWalk(target);
      return;
    }

    const food = this.findGoldenApple() || this.findBestHealFood();
    if (food && this._startEatingFood(food)) {
      this._moveAwayWalk(target);
      return;
    }

    this._moveAwayWalk(target);
  }
};

module.exports = { retreatHealMethods };
