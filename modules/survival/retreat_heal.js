'use strict';

const { Vec3 } = require('vec3');
const { isAirLike, inspectColumnStep } = require('../constants');
const { findItemByPredicate, ensureItemHeld } = require('../inventory_utils');
const { canSeeBlockFace } = require('../placement_los');
const { LOS_BLOCK_NAMES } = require('./constants');

/**
 * Retreat, Evasive Heal-Walk, & LOS Cover Block Skill (`modules/survival/retreat_heal.js`):
 * - Hitbox-verified LOS cover block placement (never clips bot or target!)
 * - Smooth-aimed evasion (no hardcoded instant look snaps)
 * - Cleanly coordinates splash healing, drinkable healing, and Golden Apple eating
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

    // Hitbox collision check: never place inside bot or target!
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
      ticks: 0,
      settleTicks: 0
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
      plan.settleTicks = eq.swapped ? 1 : plan.settleTicks;
      return true;
    }
    if (plan.settleTicks > 0) {
      plan.settleTicks--;
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

  _isYawWalkable(yaw) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position || typeof this.bot.blockAt !== 'function') {
      return { ok: true, needsJump: false };
    }
    const pos = this.bot.entity.position;
    const dx = -Math.sin(yaw);
    const dz = -Math.cos(yaw);
    const col = inspectColumnStep(this.bot, pos.x + dx * 1.1, pos.y, pos.z + dz * 1.1);
    if (col.blocked || col.hasHazard) return { ok: false, needsJump: false };
    if (!col.hasFloor) {
      const bx = Math.floor(pos.x + dx * 1.1);
      const by = Math.floor(pos.y);
      const bz = Math.floor(pos.z + dz * 1.1);
      let solid = false;
      for (let d = 2; d <= 3; d++) {
        const b = this.bot.blockAt(new Vec3(bx, by - d, bz));
        if (b && b.boundingBox === 'block') { solid = true; break; }
      }
      if (!solid) return { ok: false, needsJump: false };
    }
    return { ok: true, needsJump: col.needsJump };
  },

  _moveAwayWalk(target) {
    if (!this.bot || !this.bot.entity) return;
    const awayYaw = this._getAwayYaw(target);
    this.healStrafeTicks--;
    if (this.healStrafeTicks <= 0) {
      this.healStrafeDir = -this.healStrafeDir;
      this.healStrafeTicks = 7 + Math.floor(Math.random() * 8);
    }

    let chosenYaw = awayYaw;
    let needsJump = false;
    const offsets = [0, this.healStrafeDir * 0.55, -this.healStrafeDir * 0.55, Math.PI * 0.5, -Math.PI * 0.5];
    for (const off of offsets) {
      const check = this._isYawWalkable(awayYaw + off);
      if (check.ok) {
        chosenYaw = awayYaw + off;
        needsJump = check.needsJump;
        break;
      }
    }

    if (this.aimer) {
      this.aimer.stepTowardsAngles(chosenYaw, 0.0, { speedMultiplier: 1.5, toleranceRad: 0.25 });
    }
    if (typeof this.bot.setControlState === 'function') {
      this.bot.setControlState('forward', true);
      this.bot.setControlState('back', false);
      this.bot.setControlState('left', this.healStrafeDir < 0);
      this.bot.setControlState('right', this.healStrafeDir > 0);
      this.bot.setControlState('sprint', false);
      this.bot.setControlState('jump', Boolean(needsJump && this.bot.entity.onGround));
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

    const potCooldownMs = this.survCfg.potionCooldownMs !== undefined ? this.survCfg.potionCooldownMs : 450;
    const healPot = (now - this.lastPotionTime) >= potCooldownMs ? this.findHealingPotion() : null;
    if (healPot) {
      this._queueSplashPotion(healPot, false, null);
      this._tickSplashPotionDownward(target, false);
      return;
    }

    const dist = (target && target.position) ? this.bot.entity.position.distanceTo(target.position) : 99;
    const retreatDist = this.survCfg.retreatDistance || 7.5;

    if (dist < 4.5 && this._tryQueueLosBlock(target)) {
      this._tickPendingLosBlock();
      return;
    }

    if (dist >= Math.min(4.2, retreatDist * 0.6)) {
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

    // Sprint-jump away to create safe healing gap
    const awayYaw = this._getAwayYaw(target);
    this.retreatStrafeTicks--;
    if (this.retreatStrafeTicks <= 0) {
      this.retreatStrafeDir = -this.retreatStrafeDir;
      this.retreatStrafeTicks = 12 + Math.floor(Math.random() * 14);
    }

    let chosenYaw = awayYaw;
    for (const off of [0, this.retreatStrafeDir * 0.6, -this.retreatStrafeDir * 0.6, Math.PI * 0.5, -Math.PI * 0.5]) {
      if (this._isYawWalkable(awayYaw + off).ok) {
        chosenYaw = awayYaw + off;
        break;
      }
    }

    if (this.aimer) {
      this.aimer.stepTowardsAngles(chosenYaw, 0.0, { speedMultiplier: 1.75, toleranceRad: 0.25 });
    }
    if (typeof this.bot.setControlState === 'function') {
      this.bot.setControlState('forward', true);
      this.bot.setControlState('back', false);
      this.bot.setControlState('left', false);
      this.bot.setControlState('right', false);
      this.bot.setControlState('sprint', this.bot.food > 6);
      this.bot.setControlState('jump', Boolean(this.bot.entity.onGround));
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

    const potCooldownMs = this.survCfg.potionCooldownMs !== undefined ? this.survCfg.potionCooldownMs : 450;
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
