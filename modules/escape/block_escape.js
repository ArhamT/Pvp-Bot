'use strict';

const { Vec3 } = require('vec3');
const { isAirLike, inspectColumnStep } = require('../constants');
const { canSeeBlockFace, findVisiblePlacementRef } = require('../placement_los');

const ESCAPE_BLOCK_PRIORITY = [
  'cobblestone', 'cobbled_deepslate', 'obsidian', 'stone', 'deepslate',
  'netherrack', 'dirt', 'oak_planks', 'spruce_planks', 'birch_planks',
  'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'end_stone',
  'glowstone', 'sandstone', 'stone_bricks', 'bricks', 'white_wool', 'red_wool'
];

function isPlaceableEscapeBlock(item) {
  if (!item || !item.name) return false;
  if (ESCAPE_BLOCK_PRIORITY.includes(item.name)) return true;
  return item.name.endsWith('_planks') ||
    item.name.endsWith('_wool') ||
    item.name.endsWith('_concrete') ||
    item.name.endsWith('_terracotta') ||
    item.name.endsWith('_bricks');
}

/**
 * Tactical Block-Placement Escape Skill (`modules/escape/block_escape.js`):
 * Uses solid building blocks to escape tricky PvP situations:
 * 1. PILLAR_OUT      — Multi-block jump-pillar out of 2+ deep craters/holes/obsidian pits when sky is clear.
 * 2. BRIDGE_STEP     — Places a stepping bridge block across a lava pit or deep void/crater gap ahead.
 * 3. ANTI_COMBO_WALL — Drops a blocking block between the bot and a rushing opponent when cornered at low HP.
 */
const blockEscapeMethods = {
  _findEscapeBlock() {
    const preferred = this._findItem(ESCAPE_BLOCK_PRIORITY);
    if (preferred) return preferred;
    if (!this.bot || !this.bot.inventory || typeof this.bot.inventory.items !== 'function') return null;
    const hotbarStart = this.bot.inventory.hotbarStart || 36;
    const items = this.bot.inventory.items();
    const hotbar = items.find((i) => i && i.slot >= hotbarStart && i.slot < hotbarStart + 9 && isPlaceableEscapeBlock(i));
    if (hotbar) return { item: hotbar, inHotbar: true, hotbarIndex: hotbar.slot - hotbarStart };
    const inv = items.find(isPlaceableEscapeBlock);
    return inv ? { item: inv, inHotbar: false, hotbarIndex: -1 } : null;
  },

  _isTrappedInOpenPit() {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position || typeof this.bot.blockAt !== 'function') {
      return false;
    }
    const pos = this.bot.entity.position;
    const feet = pos.floored();
    // Need open sky above head (y+2 and y+3 clear) to pillar out safely
    for (const dy of [2, 3]) {
      const above = this.bot.blockAt(feet.offset(0, dy, 0));
      if (above && above.boundingBox === 'block') return false;
    }
    // Check if all 4 cardinal exits are blocked (2-high walls / deep pit)
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

    // Check if the block immediately ahead at floor level (y-1) is air/lava with a dangerous drop (>2b) or lava pit
    const bridgePos = underFeet.offset(dir.dx, 0, dir.dz);
    const bridgeExisting = this.bot.blockAt(bridgePos);
    const aheadFeet = this.bot.blockAt(feet.offset(dir.dx, 0, dir.dz));
    if (aheadFeet && aheadFeet.boundingBox === 'block') return null;

    const isLavaAhead = Boolean(bridgeExisting && (bridgeExisting.name.includes('lava') || bridgeExisting.name.includes('fire')));
    const isAirGap = isAirLike(bridgeExisting);
    if (!isLavaAhead && !isAirGap) return null;

    if (isAirGap) {
      // Only bridge genuine drops >= 3 blocks deep (not normal 1-2b steps)
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

    // Only place onto a face with strict line-of-sight (e.g., top of floor under lava,
    // visible neighbor face, or edge side face once eye has crossed the ledge). Never click behind blocks!
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
    const now = Date.now();

    // Continue active block-placement escape
    if (this.activeMode === 'BLOCK_ESCAPE' && this.blockEscapePlan) {
      const plan = this.blockEscapePlan;
      plan.ticks = (plan.ticks || 0) + 1;
      if (plan.ticks > 16) {
        this.blockEscapePlan = null;
        this.activeMode = 'IDLE';
        return false;
      }

      const blockRec = this._findEscapeBlock();
      if (!blockRec) {
        this.blockEscapePlan = null;
        this.activeMode = 'IDLE';
        return false;
      }

      if (plan.kind === 'PILLAR_OUT') {
        const res = this._tickPillarOut();
        if (!this._isTrappedInOpenPit() || !res) {
          this.blockEscapePlan = null;
          this.activeMode = 'IDLE';
          this.lastBlockEscapeAt = now;
        }
        return true;
      }

      const eq = this._ensureItemHeld(blockRec);
      this.aimer.stepTowardsPoint(plan.aimPos, { speedMultiplier: 1.8, toleranceRad: 0.22, force: true });
      if (typeof this.bot.setControlState === 'function') {
        this.bot.setControlState('sprint', false);
        this.bot.setControlState('forward', false);
        this.bot.setControlState('sneak', plan.kind === 'BRIDGE_STEP');
      }

      if (eq.swapped || !eq.held) {
        plan.settleTicks = 1;
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
      this.activeMode = 'IDLE';
      return true;
    }

    if ((now - (this.lastBlockEscapeAt || 0)) < 1100) return false;
    if (!this._findEscapeBlock()) return false;

    // 1. Open-sky deep hole / crater -> pillar straight out!
    if (this._isTrappedInOpenPit()) {
      this.blockEscapePlan = { kind: 'PILLAR_OUT', ticks: 0, settleTicks: 0 };
      this.activeMode = 'BLOCK_ESCAPE';
      return this._tickBlockEscape(target, context);
    }

    // 2. Cornered at low HP (<=8 HP) -> drop anti-combo block between bot and rushing opponent!
    const antiCombo = this._planAntiComboBlock(target);
    if (antiCombo) {
      this.blockEscapePlan = { ...antiCombo, ticks: 0, settleTicks: 0 };
      this.activeMode = 'BLOCK_ESCAPE';
      return this._tickBlockEscape(target, context);
    }

    // 3. Deep gap or lava pit directly ahead toward opponent -> bridge a stepping block!
    if (context && context.canTrackStall) {
      const bridge = this._planBridgeStep(target);
      if (bridge) {
        this.blockEscapePlan = { ...bridge, ticks: 0, settleTicks: 0 };
        this.activeMode = 'BLOCK_ESCAPE';
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
