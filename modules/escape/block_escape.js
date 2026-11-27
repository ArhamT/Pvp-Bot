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
    item.name.endsWith('_log') ||
    item.name === 'glowstone' ||
    item.name === 'end_stone' ||
    item.name === 'sandstone';
}

/**
 * Tactical Block-Placement Mobility & Escape Skill (`modules/escape/block_escape.js`):
 * 1. PILLAR_OUT      — Continuous jump-pillaring out of 1x1 pits, wide ditches, trenches, & craters
 *                      (zero 1.1s pause between pillar blocks; steps onto rim once top is reached!).
 * 2. BRIDGE_STEP     — Continuous edge-sneak bridging across void gaps, lava pits, & deep ditches
 *                      (places against the edge face under feet & walks forward smoothly).
 * 3. ANTI_COMBO_WALL — Drops a blocking block between the bot and a rushing opponent when cornered at low HP.
 */
const blockEscapeMethods = {
  _findEscapeBlock() {
    const cfgBlocks = this.escapeCfg && Array.isArray(this.escapeCfg.buildableBlocks) && this.escapeCfg.buildableBlocks.length > 0
      ? this.escapeCfg.buildableBlocks
      : ESCAPE_BLOCK_PRIORITY;
    const preferred = findInventoryItem(this.bot, cfgBlocks);
    if (preferred) return preferred;
    const fallback = findInventoryItem(this.bot, ESCAPE_BLOCK_PRIORITY);
    if (fallback) return fallback;
    return findItemByPredicate(this.bot, isPlaceableEscapeBlock);
  },

  /**
   * Returns true if the bot has clear sky above (+2 and +3) so it can safely jump-pillar upward.
   */
  _hasPillarHeadroom() {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position || typeof this.bot.blockAt !== 'function') {
      return false;
    }
    const feet = this.bot.entity.position.floored();
    for (const dy of [2, 3]) {
      const above = this.bot.blockAt(feet.offset(0, dy, 0));
      if (above && above.boundingBox === 'block') return false;
    }
    return true;
  },

  /**
   * Detects BOTH:
   * - A 1x1 open pit (all 4 cardinal directions blocked 2-high)
   * - A wider ditch/trench/crater where >= 3 sides are 2-high walls OR target is >= 1.8b higher
   *   and the direct forward path toward target is blocked by a 2+ high cliff/wall!
   */
  _isTrappedInOpenPit(target = null) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position || typeof this.bot.blockAt !== 'function') {
      return false;
    }
    if (!this._hasPillarHeadroom()) return false;

    const pos = this.bot.entity.position;
    let blockedSides = 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const col = inspectColumnStep(this.bot, pos.x + dx * 0.95, pos.y, pos.z + dz * 0.95);
      if (col.blocked) blockedSides++;
    }
    if (blockedSides === 4) return true;

    // Ditch / crater detection: surrounded on 3+ sides OR target is significantly higher behind a 2+ high ledge
    if (target && target.isValid && target.position) {
      const dyAbove = target.position.y - pos.y;
      if (dyAbove >= 1.8) {
        const dx = target.position.x - pos.x;
        const dz = target.position.z - pos.z;
        const len = Math.hypot(dx, dz);
        if (len > 0.5 && len <= 14.0) {
          const fwdCol = inspectColumnStep(this.bot, pos.x + (dx / len) * 1.0, pos.y, pos.z + (dz / len) * 1.0);
          if (fwdCol.blocked) return true;
        }
      }
    }

    // Deep ditch even without target above: 3 sides blocked AND standing in a sunken hole below surrounding rim
    if (blockedSides >= 3 && this.bot.entity.isCollidedHorizontally) {
      return true;
    }

    return false;
  },

  /**
   * Finds a walkable rim step direction at our current Y (or Y+1) to exit a pillar once we reach the top!
   */
  _findRimExitDirection(target = null) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) return null;
    const pos = this.bot.entity.position;
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let best = null;
    for (const [dx, dz] of dirs) {
      const col = inspectColumnStep(this.bot, pos.x + dx * 0.95, pos.y, pos.z + dz * 0.95);
      if (col.blocked || col.hasHazard || !col.hasFloor) continue;
      let score = 10 - (col.needsJump ? 2 : 0);
      if (target && target.isValid && target.position) {
        const ex = pos.x + dx - target.position.x;
        const ez = pos.z + dz - target.position.z;
        score -= Math.hypot(ex, ez);
      }
      if (!best || score > best.score) {
        best = { yaw: Math.atan2(-dx, -dz), needsJump: col.needsJump, score };
      }
    }
    return best;
  },

  /**
   * Executes one tick of continuous jump-pillaring (jump -> look straight down -> place block under feet).
   * Returns `true` while pillaring, `false` if blocked or out of blocks.
   */
  _tickPillarOut(target = null) {
    if (typeof this.bot.placeBlock !== 'function' || typeof this.bot.blockAt !== 'function') return false;
    const pos = this.bot.entity.position;
    if (!this._hasPillarHeadroom()) {
      this.pillarActive = false;
      return false;
    }

    const blockRec = this._findEscapeBlock();
    if (!blockRec) {
      this.pillarActive = false;
      return false;
    }

    const aim = this.aimer
      ? this.aimer.stepTowardsAngles(this.bot.entity.yaw, -Math.PI / 2, { speedMultiplier: 2.2, toleranceRad: 0.25 })
      : { aligned: true };
    const eq = ensureItemHeld(this.bot, blockRec);
    if (typeof this.bot.setControlState === 'function') {
      this.bot.setControlState('forward', false);
      this.bot.setControlState('back', false);
      this.bot.setControlState('left', false);
      this.bot.setControlState('right', false);
      this.bot.setControlState('sprint', false);
      this.bot.setControlState('sneak', false);
      this.bot.setControlState('jump', true);
    }

    this.pillarActive = true;
    // ensureItemHeld already enforces 1-tick post-swap settle!
    if (eq.swapped || !eq.held || !aim.aligned) {
      return true;
    }

    // Place underneath feet as soon as airborne clearance >= 0.22b above the block below
    const feetPos = pos.floored();
    const clearance = pos.y - feetPos.y;
    const targetAirPos = clearance >= 0.22 ? feetPos.offset(0, -1, 0) : null;
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
      if (this.blockEscapePlan && this.blockEscapePlan.kind === 'PILLAR_OUT') {
        this.blockEscapePlan.placedCount = (this.blockEscapePlan.placedCount || 0) + 1;
      }
      this.pillarActive = false;
    }
    return true;
  },

  /**
   * Plans a safe bridge block directly ahead over a void gap, deep ditch (>= 3b drop), or lava/fire pit.
   */
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
    const aheadHead = this.bot.blockAt(feet.offset(dir.dx, 1, dir.dz));
    if ((aheadFeet && aheadFeet.boundingBox === 'block') || (aheadHead && aheadHead.boundingBox === 'block')) {
      return null;
    }

    const isLavaAhead = Boolean(bridgeExisting && (bridgeExisting.name.includes('lava') || bridgeExisting.name.includes('fire')));
    const isAirGap = isAirLike(bridgeExisting);
    if (!isLavaAhead && !isAirGap) return null;

    if (isAirGap) {
      let solidWithin2 = false;
      for (let d = 1; d <= 2; d++) {
        const below = this.bot.blockAt(bridgePos.offset(0, -d, 0));
        if (below && (below.name.includes('lava') || below.name.includes('fire'))) {
          // Lava at bottom of 1–2 deep ditch -> DO bridge over it!
          solidWithin2 = false;
          break;
        }
        if (below && below.boundingBox === 'block') {
          solidWithin2 = true;
          break;
        }
      }
      if (solidWithin2) return null;
    }

    // Prefer the side face of `underFeet` (exact Minecraft speed-bridge face!).
    // Note: from the center of `underFeet`, the side face is behind the eye until the bot sneak-walks to the edge,
    // so allow planning it directly and let BRIDGE_STEP sneak to the edge until visible!
    const sideFace = new Vec3(dir.dx, 0, dir.dz);
    const directVis = canSeeBlockFace(this.bot, underFeet, sideFace, { aimer: this.aimer, maxReach: 4.5 });
    const altVis = directVis ? null : findVisiblePlacementRef(this.bot, bridgePos, { aimer: this.aimer, maxReach: 4.5 });
    const visRef = directVis
      ? { refPos: underFeet, face: sideFace, aimPos: directVis.aimPos }
      : (altVis || {
          refPos: underFeet,
          face: sideFace,
          aimPos: underFeet.offset(0.5 + dir.dx * 0.5, 0.5, 0.5 + dir.dz * 0.5)
        });

    return {
      kind: 'BRIDGE_STEP',
      refPos: visRef.refPos,
      face: visRef.face,
      placePos: bridgePos,
      aimPos: visRef.aimPos,
      dir,
      walkYaw: Math.atan2(-dir.dx, -dir.dz),
      placedCount: 0
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
    if (this.activeMode === 'BOX_MINE' && this.boxMinePlan) return false;

    const now = Date.now();

    if (this.activeMode === 'BLOCK_ESCAPE' && this.blockEscapePlan) {
      const plan = this.blockEscapePlan;
      plan.ticks = (plan.ticks || 0) + 1;
      const maxTicks = plan.kind === 'PILLAR_OUT' ? 50 : (plan.kind === 'BRIDGE_STEP' ? 60 : 14);
      if (plan.ticks > maxTicks) {
        if (typeof this.bot.setControlState === 'function') {
          this.bot.setControlState('sneak', false);
          this.bot.setControlState('jump', false);
        }
        this.blockEscapePlan = null;
        this.pillarActive = false;
        this._setActiveMode('IDLE');
        this.lastBlockEscapeAt = now;
        return false;
      }

      const blockRec = this._findEscapeBlock();
      if (!blockRec) {
        if (typeof this.bot.setControlState === 'function') {
          this.bot.setControlState('sneak', false);
          this.bot.setControlState('jump', false);
        }
        this.blockEscapePlan = null;
        this.pillarActive = false;
        this._setActiveMode('IDLE');
        return false;
      }

      // --- Continuous Pillar-Out (climbs 1..6 blocks out of ditches/pits, then steps onto rim!) ---
      if (plan.kind === 'PILLAR_OUT') {
        // Only check exit condition when grounded (never abort mid-jump before placing the block under feet!)
        const onGroundNow = Boolean(this.bot.entity.onGround);
        const stillInPit = !onGroundNow || this._isTrappedInOpenPit(target);
        if (!stillInPit || (plan.placedCount || 0) >= 6) {
          // Step cleanly onto the top rim before releasing control
          const rim = this._findRimExitDirection(target);
          if (rim && (plan.rimStepTicks || 0) < 5) {
            plan.rimStepTicks = (plan.rimStepTicks || 0) + 1;
            if (this.aimer) {
              this.aimer.stepTowardsAngles(rim.yaw, 0.0, { speedMultiplier: 2.0 });
            }
            if (typeof this.bot.setControlState === 'function') {
              this.bot.setControlState('forward', true);
              this.bot.setControlState('back', false);
              this.bot.setControlState('left', false);
              this.bot.setControlState('right', false);
              this.bot.setControlState('sneak', false);
              this.bot.setControlState('sprint', this.bot.food > 6);
              this.bot.setControlState('jump', Boolean(rim.needsJump && this.bot.entity.onGround));
            }
            return true;
          }
          if (typeof this.bot.setControlState === 'function') {
            this.bot.setControlState('jump', false);
          }
          this.blockEscapePlan = null;
          this.pillarActive = false;
          this._setActiveMode('IDLE');
          this.lastBlockEscapeAt = now;
          return false;
        }

        const res = this._tickPillarOut(target);
        if (!res) {
          this.blockEscapePlan = null;
          this.pillarActive = false;
          this._setActiveMode('IDLE');
          this.lastBlockEscapeAt = now;
          return false;
        }
        return true;
      }

      // --- Continuous Safe Bridging (sneak-edge place -> step forward -> repeat across gap!) ---
      if (plan.kind === 'BRIDGE_STEP') {
        if (plan.steppingTicks > 0) {
          plan.steppingTicks--;
          if (this.aimer && typeof plan.walkYaw === 'number') {
            this.aimer.stepTowardsAngles(plan.walkYaw, 0.25, { speedMultiplier: 1.9 });
          }
          if (typeof this.bot.setControlState === 'function') {
            this.bot.setControlState('sneak', true);
            this.bot.setControlState('sprint', false);
            this.bot.setControlState('forward', true);
            this.bot.setControlState('back', false);
            this.bot.setControlState('left', false);
            this.bot.setControlState('right', false);
            this.bot.setControlState('jump', false);
          }
          if (plan.steppingTicks === 0) {
            // Re-check if another bridge block is needed to finish crossing the gap (up to 8 blocks)
            const nextStep = (plan.placedCount || 0) < 8 ? this._planBridgeStep(target) : null;
            if (nextStep) {
              nextStep.placedCount = plan.placedCount || 0;
              nextStep.ticks = plan.ticks;
              this.blockEscapePlan = nextStep;
              return true;
            }
            if (typeof this.bot.setControlState === 'function') {
              this.bot.setControlState('sneak', false);
            }
            this.blockEscapePlan = null;
            this._setActiveMode('IDLE');
            this.lastBlockEscapeAt = now;
            return false;
          }
          return true;
        }

        const refBlock = this.bot.blockAt(plan.refPos);
        const faceVisible = Boolean(
          refBlock &&
          refBlock.boundingBox === 'block' &&
          canSeeBlockFace(this.bot, refBlock.position, plan.face, { aimer: this.aimer, maxReach: 4.5 })
        );

        // If standing in the middle of the block, sneak-walk toward the ledge edge until the side face is visible!
        if (!faceVisible && refBlock && refBlock.boundingBox === 'block') {
          if (this.aimer && typeof plan.walkYaw === 'number') {
            this.aimer.stepTowardsAngles(plan.walkYaw, 0.65, { speedMultiplier: 2.0 });
          }
          if (typeof this.bot.setControlState === 'function') {
            this.bot.setControlState('sneak', true);
            this.bot.setControlState('sprint', false);
            this.bot.setControlState('forward', true);
            this.bot.setControlState('back', false);
            this.bot.setControlState('left', false);
            this.bot.setControlState('right', false);
            this.bot.setControlState('jump', false);
          }
          return true;
        }

        const aim = this.aimer
          ? this.aimer.stepTowardsPoint(plan.aimPos, { speedMultiplier: 2.1, toleranceRad: 0.25 })
          : { aligned: true };
        const eq = ensureItemHeld(this.bot, blockRec);
        if (typeof this.bot.setControlState === 'function') {
          this.bot.setControlState('sprint', false);
          this.bot.setControlState('forward', false);
          this.bot.setControlState('sneak', true);
        }
        if (eq.swapped || !eq.held || !aim.aligned) {
          return true;
        }

        if (faceVisible) {
          Promise.resolve(this.bot.placeBlock(refBlock, plan.face)).catch(() => {});
          plan.placedCount = (plan.placedCount || 0) + 1;
          plan.steppingTicks = 5;
          return true;
        }

        if (typeof this.bot.setControlState === 'function') {
          this.bot.setControlState('sneak', false);
        }
        this.blockEscapePlan = null;
        this._setActiveMode('IDLE');
        this.lastBlockEscapeAt = now;
        return false;
      }

      // --- Anti-Combo Wall placement ---
      const aim = this.aimer
        ? this.aimer.stepTowardsPoint(plan.aimPos, { speedMultiplier: 2.1, toleranceRad: 0.25 })
        : { aligned: true };
      const eq = ensureItemHeld(this.bot, blockRec);
      if (typeof this.bot.setControlState === 'function') {
        this.bot.setControlState('sprint', false);
        this.bot.setControlState('forward', false);
      }
      if (eq.swapped || !eq.held || !aim.aligned) {
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
      this.lastBlockEscapeAt = now;
      this.blockEscapePlan = null;
      this._setActiveMode('IDLE');
      return true;
    }

    if ((now - (this.lastBlockEscapeAt || 0)) < 650) return false;
    if (!this._findEscapeBlock()) return false;

    if (this._isTrappedInOpenPit(target)) {
      if (this.miner && this.miner.digging) this.miner.cancel();
      this.blockEscapePlan = { kind: 'PILLAR_OUT', ticks: 0, placedCount: 0, rimStepTicks: 0 };
      this._setActiveMode('BLOCK_ESCAPE');
      return this._tickBlockEscape(target, context);
    }

    const antiCombo = this._planAntiComboBlock(target);
    if (antiCombo) {
      if (this.miner && this.miner.digging) this.miner.cancel();
      this.blockEscapePlan = { ...antiCombo, ticks: 0 };
      this._setActiveMode('BLOCK_ESCAPE');
      return this._tickBlockEscape(target, context);
    }

    if (context && context.canTrackStall) {
      const bridge = this._planBridgeStep(target);
      if (bridge) {
        if (this.miner && this.miner.digging) this.miner.cancel();
        this.blockEscapePlan = { ...bridge, ticks: 0, steppingTicks: 0 };
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
