'use strict';

const { Vec3 } = require('vec3');
const { COVER_BLOCK_PRIORITY, isAirLike, inspectColumnStep } = require('../constants');
const { findInventoryItem, findItemByPredicate, ensureItemHeld } = require('../inventory_utils');
const { canSeeBlockFace, findVisiblePlacementRef } = require('../placement_los');

const ESCAPE_BLOCK_PRIORITY = COVER_BLOCK_PRIORITY;

function isPlaceableEscapeBlock(item) {
  if (!item || !item.name) return false;
  if (ESCAPE_BLOCK_PRIORITY.includes(item.name)) return true;
  return item.name.endsWith('_planks') ||
    item.name.endsWith('_wool') ||
    item.name.endsWith('_concrete') ||
    item.name.endsWith('_terracotta') ||
    item.name.endsWith('_bricks') ||
    item.name === 'glowstone';
}

/**
 * Tactical Block-Placement Escape Skill (`modules/escape/block_escape.js`):
 * 1. PILLAR_OUT      — Jump-pillar out of 2+ deep craters/holes/obsidian pits when sky is clear.
 *                      Checks vertical jump clearance so block placement doesn't collide with bot's feet.
 * 2. BRIDGE_STEP     — Places a stepping bridge block across a lava pit or deep void/crater gap ahead.
 * 3. ANTI_COMBO_WALL — Drops a blocking block between the bot and a rushing opponent when cornered at low HP.
 */
const blockEscapeMethods = {
  _findEscapeBlock() {
    const preferred = findInventoryItem(this.bot, ESCAPE_BLOCK_PRIORITY);
    if (preferred) return preferred;
    return findItemByPredicate(this.bot, isPlaceableEscapeBlock);
  },

  _tickPillarOut() {
    if (typeof this.bot.placeBlock !== 'function' || typeof this.bot.blockAt !== 'function') return false;
    const pos = this.bot.entity.position;
    const aboveHead = this.bot.blockAt(pos.offset(0, 2, 0));
    if (aboveHead && aboveHead.boundingBox === 'block') {
      this.pillarActive = false;
      return false;
    }

    const blockRec = this._findEscapeBlock();
    if (!blockRec) {
      this.pillarActive = false;
      return false;
    }

    const aim = this.aimer
      ? this.aimer.stepTowardsAngles(this.bot.entity.yaw, -Math.PI / 2, { speedMultiplier: 1.8, toleranceRad: 0.25 })
      : { aligned: true };
    const eq = ensureItemHeld(this.bot, blockRec);
    if (typeof this.bot.setControlState === 'function') {
      this.bot.setControlState('forward', false);
      this.bot.setControlState('back', false);
      this.bot.setControlState('left', false);
      this.bot.setControlState('right', false);
      this.bot.setControlState('sprint', false);
      this.bot.setControlState('jump', true);
    }

    this.pillarActive = true;
    if (eq.swapped || !eq.held || !aim.aligned) {
      this.pillarSettleTicks = eq.swapped ? 1 : this.pillarSettleTicks;
      return true;
    }
    if (this.pillarSettleTicks > 0) {
      this.pillarSettleTicks--;
      return true;
    }

    // Wait until airborne clearance >= 0.28b above the block below so placement doesn't clip feet hitbox
    const feetPos = pos.floored();
    const clearance = pos.y - feetPos.y;
    const targetAirPos = clearance >= 0.28 ? feetPos.offset(0, -1, 0) : null;
    if (!targetAirPos) return true;

    const belowPos = targetAirPos.offset(0, -1, 0);
    const refBlock = this.bot.blockAt(belowPos);
    if (
      refBlock &&
      refBlock.boundingBox === 'block' &&
      isAirLike(this.bot.blockAt(targetAirPos)) &&
      canSeeBlockFace(this.bot, belowPos, new Vec3(0, 1, 0), { aimer: this.aimer, maxReach: 4.5 })
    ) {
      Promise.resolve(this.bot.placeBlock(refBlock, new Vec3(0, 1, 0))).catch(() => {});
      this.pillarActive = false;
    }
    return true;
  },

  _isTrappedInOpenPit() {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position || typeof this.bot.blockAt !== 'function') {
      return false;
    }
    const pos = this.bot.entity.position;
    const feet = pos.floored();
    for (const dy of [2, 3]) {
      const above = this.bot.blockAt(feet.offset(0, dy, 0));
      if (above && above.boundingBox === 'block') return false;
    }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const col = inspectColumnStep(this.bot, pos.x + dx * 0.95, pos.y, pos.z + dz * 0.95);
      if (!col.blocked) return false;
    }
    return true;
  },

  _planBridgeStep(target) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position || !this.bot.entity.onGround) return null;
    if (typeof this.bot.blockAt !== 'function' || typeof this.bot.placeBlock !== 'function') return null;

    const pos = this.bot.entity.position;
    const yaw = (target && target.isValid && target.position)
      ? Math.atan2(-(target.position.x - pos.x), -(target.position.z - pos.z))
      : (this.bot.entity.yaw || 0);
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const dir = Math.abs(fx) >= Math.abs(fz)
      ? { dx: Math.sign(fx) || 1, dz: 0 }
      : { dx: 0, dz: Math.sign(fz) || 1 };

    const feet = pos.floored();
    const underFeet = feet.offset(0, -1, 0);
    const refBlock = this.bot.blockAt(underFeet);
    if (!refBlock || refBlock.boundingBox !== 'block') return null;

    const bridgePos = underFeet.offset(dir.dx, 0, dir.dz);
    const bridgeExisting = this.bot.blockAt(bridgePos);
    const aheadFeet = this.bot.blockAt(feet.offset(dir.dx, 0, dir.dz));
    if (aheadFeet && aheadFeet.boundingBox === 'block') return null;

    const isLavaAhead = Boolean(bridgeExisting && (bridgeExisting.name.includes('lava') || bridgeExisting.name.includes('fire')));
    const isAirGap = isAirLike(bridgeExisting);
    if (!isLavaAhead && !isAirGap) return null;

    if (isAirGap) {
      let solidWithin2 = false;
      for (let d = 1; d <= 2; d++) {
        const below = this.bot.blockAt(bridgePos.offset(0, -d, 0));
        if (below && below.boundingBox === 'block') {
          solidWithin2 = true;
          break;
        }
      }
      if (solidWithin2) return null;
    }

    const visRef = findVisiblePlacementRef(this.bot, bridgePos, {
      aimer: this.aimer,
      maxReach: 4.5
    });
    if (!visRef) return null;

    return {
      kind: 'BRIDGE_STEP',
      refPos: visRef.refPos,
      face: visRef.face,
      placePos: bridgePos,
      aimPos: visRef.aimPos,
      dir
    };
  },

  _planAntiComboBlock(target) {
    if (!target || !target.isValid || !target.position) return null;
    if (!this.bot || !this.bot.entity || !this.bot.entity.position || !this.bot.entity.onGround) return null;
    if (typeof this.bot.blockAt !== 'function' || typeof this.bot.placeBlock !== 'function') return null;
    if (this.bot.health > 8) return null;

    const pos = this.bot.entity.position;
    const dist = pos.distanceTo(target.position);
    if (dist < 1.8 || dist > 4.0) return null;
    if (!this.bot.entity.isCollidedHorizontally) return null;

    const dx = target.position.x - pos.x;
    const dz = target.position.z - pos.z;
    const dir = Math.abs(dx) >= Math.abs(dz)
      ? { dx: Math.sign(dx) || 1, dz: 0 }
      : { dx: 0, dz: Math.sign(dz) || 1 };

    const placePos = pos.floored().offset(dir.dx, 0, dir.dz);
    if (!isAirLike(this.bot.blockAt(placePos))) return null;
    if (placePos.offset(0.5, 0.5, 0.5).distanceTo(target.position.offset(0, 0.5, 0)) < 0.85) return null;

    const refPos = placePos.offset(0, -1, 0);
    const refBlock = this.bot.blockAt(refPos);
    if (!refBlock || refBlock.boundingBox !== 'block') return null;
    const vis = canSeeBlockFace(this.bot, refPos, new Vec3(0, 1, 0), { aimer: this.aimer, maxReach: 4.5 });
    if (!vis) return null;

    return {
      kind: 'ANTI_COMBO_WALL',
      refPos,
      face: new Vec3(0, 1, 0),
      placePos,
      aimPos: vis.aimPos,
      dir
    };
  },

  _tickBlockEscape(target, context) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) return false;
    if (typeof this.bot.placeBlock !== 'function' || typeof this.bot.blockAt !== 'function') return false;
    // Never hijack an active BOX_MINE dig without completing or aborting cleanly
    if (this.activeMode === 'BOX_MINE' && this.boxMinePlan) return false;

    const now = Date.now();

    if (this.activeMode === 'BLOCK_ESCAPE' && this.blockEscapePlan) {
      const plan = this.blockEscapePlan;
      plan.ticks = (plan.ticks || 0) + 1;
      if (plan.ticks > 16) {
        this.blockEscapePlan = null;
        this.pillarActive = false;
        this._setActiveMode('IDLE');
        return false;
      }

      const blockRec = this._findEscapeBlock();
      if (!blockRec) {
        this.blockEscapePlan = null;
        this.pillarActive = false;
        this._setActiveMode('IDLE');
        return false;
      }

      if (plan.kind === 'PILLAR_OUT') {
        const res = this._tickPillarOut();
        if (!this._isTrappedInOpenPit() || !res) {
          this.blockEscapePlan = null;
          this.pillarActive = false;
          this._setActiveMode('IDLE');
          this.lastBlockEscapeAt = now;
        }
        return true;
      }

      const aim = this.aimer
        ? this.aimer.stepTowardsPoint(plan.aimPos, { speedMultiplier: 1.85, toleranceRad: 0.25 })
        : { aligned: true };
      const eq = ensureItemHeld(this.bot, blockRec);
      if (typeof this.bot.setControlState === 'function') {
        this.bot.setControlState('sprint', false);
        this.bot.setControlState('forward', false);
        this.bot.setControlState('sneak', plan.kind === 'BRIDGE_STEP');
      }

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
        canSeeBlockFace(this.bot, refBlock.position, plan.face, { aimer: this.aimer, maxReach: 4.5 })
      ) {
        Promise.resolve(this.bot.placeBlock(refBlock, plan.face)).catch(() => {});
      }
      if (typeof this.bot.setControlState === 'function') {
        this.bot.setControlState('sneak', false);
        if (plan.kind === 'BRIDGE_STEP') {
          this.bot.setControlState('forward', true);
        }
      }
      this.lastBlockEscapeAt = now;
      this.blockEscapePlan = null;
      this._setActiveMode('IDLE');
      return true;
    }

    if ((now - (this.lastBlockEscapeAt || 0)) < 1100) return false;
    if (!this._findEscapeBlock()) return false;

    if (this._isTrappedInOpenPit()) {
      if (this.miner && this.miner.digging) this.miner.cancel();
      this.blockEscapePlan = { kind: 'PILLAR_OUT', ticks: 0, settleTicks: 0 };
      this._setActiveMode('BLOCK_ESCAPE');
      return this._tickBlockEscape(target, context);
    }

    const antiCombo = this._planAntiComboBlock(target);
    if (antiCombo) {
      if (this.miner && this.miner.digging) this.miner.cancel();
      this.blockEscapePlan = { ...antiCombo, ticks: 0, settleTicks: 0 };
      this._setActiveMode('BLOCK_ESCAPE');
      return this._tickBlockEscape(target, context);
    }

    if (context && context.canTrackStall) {
      const bridge = this._planBridgeStep(target);
      if (bridge) {
        if (this.miner && this.miner.digging) this.miner.cancel();
        this.blockEscapePlan = { ...bridge, ticks: 0, settleTicks: 0 };
        this._setActiveMode('BLOCK_ESCAPE');
        return this._tickBlockEscape(target, context);
      }
    }

    return false;
  }
};

module.exports = {
  blockEscapeMethods,
  ESCAPE_BLOCK_PRIORITY,
  isPlaceableEscapeBlock
};
