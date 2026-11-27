'use strict';

const { Vec3 } = require('vec3');
const { SWORD_PRIORITY, AXE_PRIORITY, clearMovementControls, posKey, inspectColumnStep } = require('../constants');

const RAIL_BLOCK_NAMES = new Set(['rail', 'powered_rail', 'detector_rail', 'activator_rail']);
const UNBREAKABLE_BLOCKS = new Set(['bedrock', 'barrier', 'command_block', 'end_portal_frame', 'reinforced_deepslate']);
const PICKAXE_PRIORITY = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe', 'golden_pickaxe'];
const SHOVEL_PRIORITY = ['netherite_shovel', 'diamond_shovel', 'iron_shovel', 'stone_shovel', 'wooden_shovel', 'golden_shovel'];

function isTntCartEntity(entity) {
  if (!entity || !entity.isValid) return false;
  const n = String(entity.name || '').toLowerCase();
  const d = String(entity.displayName || '').toLowerCase();
  return n.includes('tnt_minecart') || n.includes('minecart_tnt') || d.includes('tnt');
}

/**
 * Rail/TNT-cart evasion, embedded-block digging, safe escape yaw search, and stall unstick mixin.
 */
const hazardUnstickMethods = {
  findNearbyRailOrCartThreat(target) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) return null;
    const now = Date.now();
    for (const [k, exp] of this.evadedRails.entries()) {
      if (exp <= now) this.evadedRails.delete(k);
    }

    const botPos = this.bot.entity.position;
    let hasNearbyCart = false;
    if (this.bot.entities) {
      for (const ent of Object.values(this.bot.entities)) {
        if (!isTntCartEntity(ent) || !ent.position) continue;
        const d = botPos.distanceTo(ent.position);
        if (d <= 4.8) {
          hasNearbyCart = true;
          const key = `cart:${ent.id}`;
          const exp = this.evadedRails.get(key);
          if (!exp || now >= exp) {
            return { type: 'tnt_minecart', key, pos: ent.position.clone() };
          }
        }
      }
    }

    if (this.railBlockThreat) {
      const exp = this.evadedRails.get(this.railBlockThreat.key);
      if ((now - this.railBlockThreat.detectedAt) <= 1500 && (!exp || now >= exp)) {
        const b = typeof this.bot.blockAt === 'function' && this.railBlockThreat.blockPos
          ? this.bot.blockAt(this.railBlockThreat.blockPos)
          : null;
        if (this.railBlockThreat.type === 'tnt_minecart' || (b && RAIL_BLOCK_NAMES.has(b.name))) {
          if (botPos.distanceTo(this.railBlockThreat.pos) <= (this.escapeCfg.railEvadeRadius || 4.2) + 0.6) {
            return this.railBlockThreat;
          }
        }
      }
      this.railBlockThreat = null;
    }

    if (typeof this.bot.blockAt !== 'function') return null;

    let enemyCartThreat = hasNearbyCart;
    if (!enemyCartThreat && target && target.isValid && target.position && botPos.distanceTo(target.position) <= 9.0) {
      const eq = Array.isArray(target.equipment) ? target.equipment : [];
      enemyCartThreat = eq.some((item) => item && item.name && (
        RAIL_BLOCK_NAMES.has(item.name) ||
        item.name === 'tnt_minecart' ||
        item.name === 'bow' ||
        item.name === 'crossbow' ||
        item.name === 'flint_and_steel' ||
        item.name === 'fire_charge'
      ));
    }
    if (!enemyCartThreat) return null;

    const radius = this.escapeCfg.railEvadeRadius || 4.2;
    const rInt = Math.ceil(radius);
    const bx = Math.floor(botPos.x);
    const by = Math.floor(botPos.y);
    const bz = Math.floor(botPos.z);

    let closest = null;
    let closestDist = Infinity;
    for (let dx = -rInt; dx <= rInt; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -rInt; dz <= rInt; dz++) {
          const bp = new Vec3(bx + dx, by + dy, bz + dz);
          const key = posKey(bp);
          const exp = this.evadedRails.get(key);
          if (exp && now < exp) continue;

          const b = this.bot.blockAt(bp);
          if (!b || !RAIL_BLOCK_NAMES.has(b.name)) continue;
          const center = bp.offset(0.5, 0.2, 0.5);
          const d = botPos.distanceTo(center);
          if (d <= radius && d < closestDist) {
            closestDist = d;
            closest = { type: 'rail', key, pos: center, blockPos: bp };
          }
        }
      }
    }
    return closest;
  },

  hasNearbyRailOrHazard(target) {
    if (this.escapeCfg.enabled === false) return false;
    return this.activeMode !== 'IDLE' ||
      this.isInLava() ||
      Boolean(this.isEmbeddedInSolidBlock()) ||
      Boolean(this.findNearbyRailOrCartThreat(target));
  },

  _findBestEscapeYaw(avoidPos = null, allowStepUp = true) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position || typeof this.bot.blockAt !== 'function') {
      return null;
    }
    const base = this.bot.entity.position;
    let best = null;

    for (let i = 0; i < 8; i++) {
      const yaw = (i * Math.PI) / 4;
      const dx = -Math.sin(yaw);
      const dz = -Math.cos(yaw);

      let blocked = false;
      let needsJump = false;
      let hasLava = false;
      let hasFloor = false;

      if (Math.abs(dx) > 0.25 && Math.abs(dz) > 0.25) {
        const cxCol = inspectColumnStep(this.bot, base.x + Math.sign(dx) * 0.9, base.y, base.z);
        const czCol = inspectColumnStep(this.bot, base.x, base.y, base.z + Math.sign(dz) * 0.9);
        if ((cxCol.blocked || cxCol.needsJump) && (czCol.blocked || czCol.needsJump)) {
          continue;
        }
      }

      for (const dist of [1.2, 2.2]) {
        const sample = base.offset(dx * dist, 0, dz * dist);
        const f = this.bot.blockAt(sample);
        const h = this.bot.blockAt(sample.offset(0, 1, 0));

        const fLava = f && (f.name.includes('lava') || f.name.includes('fire'));
        const hLava = h && (h.name.includes('lava') || h.name.includes('fire'));
        if (fLava || hLava) hasLava = true;

        if (f && f.name === 'cobweb') {
          blocked = true;
          break;
        }

        const col = inspectColumnStep(this.bot, sample.x, base.y, sample.z);
        if (col.blocked || (col.needsJump && !allowStepUp)) {
          blocked = true;
          break;
        }
        if (col.needsJump) {
          needsJump = true;
        }
        if (col.hasFloor) {
          hasFloor = true;
        }

        for (let down = 1; down <= 3; down++) {
          const below = this.bot.blockAt(sample.offset(0, -down, 0));
          if (below && (below.name.includes('lava') || below.name.includes('fire'))) {
            hasLava = true;
            break;
          }
          if (below && below.boundingBox === 'block') {
            hasFloor = true;
            break;
          }
        }
      }

      if (blocked || !hasFloor) continue;

      let score = (hasLava ? -50 : 20) - (needsJump ? 1.5 : 0);
      if (avoidPos) {
        const stepEnd = base.offset(dx * 2.2, 0, dz * 2.2);
        score += stepEnd.distanceTo(avoidPos) * 4.0;
      }
      if (!best || score > best.score) {
        best = { yaw, needsJump, score, hasLava };
      }
    }

    return best;
  },

  _pickToolForBlock(block) {
    if (!block || !block.name) return null;
    const name = block.name;
    if (name === 'cobweb') {
      return this._findItem([...SWORD_PRIORITY, 'shears']);
    }
    if (name.includes('wool') || name.includes('leaves') || name === 'vine' || name === 'glow_lichen') {
      return this._findItem(['shears', ...SWORD_PRIORITY]);
    }
    if (
      name.includes('dirt') || name.includes('sand') || name.includes('gravel') ||
      name.includes('soul_') || name.includes('snow') || name.includes('clay') ||
      name.includes('mud') || name.includes('grass_block') || name.includes('mycelium') ||
      name.includes('podzol') || name.includes('concrete_powder') || name === 'farmland'
    ) {
      return this._findItem(SHOVEL_PRIORITY);
    }
    if (
      name.includes('planks') || name.includes('log') || name.includes('wood') ||
      name.includes('stem') || name.includes('hyphae') || name.includes('bamboo') ||
      name.includes('fence') || name.includes('gate') || name.includes('door') ||
      name.includes('chest') || name.includes('barrel') || name.includes('bookshelf') ||
      name.includes('sign') || name === 'crafting_table' || name === 'melon' ||
      name === 'pumpkin' || name === 'scaffolding' || name === 'ladder'
    ) {
      return this._findItem(AXE_PRIORITY);
    }
    return this._findItem(PICKAXE_PRIORITY);
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

  /**
   * Detects when the bot is trapped inside an opponent-built box (all 4 cardinal exits blocked
   * or unjumpable due to ceiling) and plans a 2-block-tall doorway breakout using the fastest
   * breakable wall and exact appropriate tool (pickaxe / axe / shovel / shears / sword).
   */
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
        return null; // At least one open / jumpable cardinal exit exists -> not boxed in
      }
      blockedDirs++;

      const bFeet = this.bot.blockAt(feet.offset(dir.dx, 0, dir.dz));
      const bHead = this.bot.blockAt(feet.offset(dir.dx, 1, dir.dz));
      const costFeet = this._estimateBlockBreakCost(bFeet);
      const costHead = this._estimateBlockBreakCost(bHead);
      const totalCost = costFeet + costHead;
      if (!Number.isFinite(totalCost) || totalCost <= 0) continue;

      // Avoid mining directly into lava behind the wall
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
          dir,
          originFeet: feet.clone(),
          score,
          ticks: 0
        };
      }
    }

    return blockedDirs === 4 ? bestPlan : null;
  },

  _tickBoxBreakout(target, context) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) return false;
    const now = Date.now();

    // Continue active 2-block-tall doorway mining until both head & feet blocks are cleared
    if (this.activeMode === 'BOX_MINE' && this.boxMinePlan) {
      this.boxMinePlan.ticks++;
      if (this.boxMinePlan.ticks > 140) {
        this.boxMinePlan = null;
        this.activeMode = 'IDLE';
        return false;
      }

      if (this.diggingInProgress) {
        if ((now - this.digStartedAt) > 6000) {
          this.diggingInProgress = false;
        }
        return true;
      }

      const { dir, originFeet } = this.boxMinePlan;
      const headBlock = this.bot.blockAt(originFeet.offset(dir.dx, 1, dir.dz));
      const feetBlock = this.bot.blockAt(originFeet.offset(dir.dx, 0, dir.dz));
      const nextToDig = (headBlock && headBlock.boundingBox === 'block' && this._canDigBlock(headBlock))
        ? headBlock
        : ((feetBlock && feetBlock.boundingBox === 'block' && this._canDigBlock(feetBlock)) ? feetBlock : null);

      if (!nextToDig) {
        // Doorway is open! Walk cleanly out through the mined exit
        const exitYaw = Math.atan2(-dir.dx, -dir.dz);
        this.aimer.stepTowardsAngles(exitYaw, 0.0, { speedMultiplier: 1.6, force: true });
        if (typeof this.bot.setControlState === 'function') {
          this.bot.setControlState('sneak', false);
          this.bot.setControlState('forward', true);
          this.bot.setControlState('back', false);
          this.bot.setControlState('left', false);
          this.bot.setControlState('right', false);
          this.bot.setControlState('sprint', this.bot.food > 6);
          this.bot.setControlState('jump', false);
        }
        this.activeMode = 'STALL_UNSTICK';
        this.detourYaw = exitYaw;
        this.detourTicks = 6;
        this.boxMinePlan = null;
        return true;
      }

      clearMovementControls(this.bot);
      const tool = this._pickToolForBlock(nextToDig);
      if (tool) {
        const eq = this._ensureItemHeld(tool);
        if (eq.swapped) {
          this.digSettleTicks = 1;
          return true;
        }
      }
      if (this.digSettleTicks > 0) {
        this.digSettleTicks--;
        return true;
      }
      this.aimer.stepTowardsPoint(nextToDig.position.offset(0.5, 0.5, 0.5), {
        speedMultiplier: 1.6,
        force: true
      });
      this.diggingInProgress = true;
      this.digStartedAt = now;
      Promise.resolve(this.bot.dig(nextToDig, true))
        .catch(() => {})
        .finally(() => {
          this.diggingInProgress = false;
        });
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
    // Wait 3 ticks (~150ms) to confirm we're genuinely boxed in (not passing a doorway)
    if (this.boxedTicks < 3) {
      return false;
    }

    this.boxedTicks = 0;
    this.boxMinePlan = plan;
    this.activeMode = 'BOX_MINE';
    return this._tickBoxBreakout(target, context);
  },

  _canDigBlock(block) {
    if (!block || !block.name || UNBREAKABLE_BLOCKS.has(block.name)) return false;
    if (block.name === 'obsidian' || block.name === 'crying_obsidian' || block.name === 'respawn_anchor') {
      return Boolean(this._findItem(['netherite_pickaxe', 'diamond_pickaxe']));
    }
    return true;
  },

  _tickBlockStuckEscape(obstructingBlock, isCobweb) {
    const now = Date.now();
    this.activeMode = 'BLOCK_STUCK';
    this.modeTicks++;

    if (this.diggingInProgress) {
      if ((now - this.digStartedAt) > 4000) {
        this.diggingInProgress = false;
      }
      return true;
    }

    if (!isCobweb && this.modeTicks <= 3) {
      const openExit = this._findBestEscapeYaw(null, true);
      if (openExit && !openExit.hasLava) {
        this.aimer.stepTowardsAngles(openExit.yaw, 0.0, { speedMultiplier: 1.4 });
        if (typeof this.bot.setControlState === 'function') {
          this.bot.setControlState('sneak', false);
          this.bot.setControlState('forward', true);
          this.bot.setControlState('jump', true);
        }
        return true;
      }
    }

    if (
      this.escapeCfg.allowBlockDig !== false &&
      obstructingBlock &&
      this._canDigBlock(obstructingBlock) &&
      typeof this.bot.dig === 'function'
    ) {
      clearMovementControls(this.bot);
      const tool = this._pickToolForBlock(obstructingBlock);
      if (tool) {
        const eq = this._ensureItemHeld(tool);
        if (eq.swapped) {
          this.digSettleTicks = 1;
          return true;
        }
      }
      if (this.digSettleTicks > 0) {
        this.digSettleTicks--;
        return true;
      }
      this.aimer.stepTowardsPoint(obstructingBlock.position.offset(0.5, 0.5, 0.5), {
        speedMultiplier: 1.5,
        force: true
      });
      this.diggingInProgress = true;
      this.digStartedAt = now;
      Promise.resolve(this.bot.dig(obstructingBlock, true))
        .catch(() => {})
        .finally(() => {
          this.diggingInProgress = false;
        });
      return true;
    }

    const pearl = this._findItem('ender_pearl');
    if (pearl) {
      const eq = this._ensureItemHeld(pearl);
      this.aimer.stepTowardsAngles(this.bot.entity.yaw, 25 * (Math.PI / 180), { force: true });
      if (!eq.swapped && typeof this.bot.activateItem === 'function') {
        this.bot.activateItem(false);
      }
      return true;
    }

    return false;
  },

  _tickRailCartEvade(threat) {
    this.activeMode = 'RAIL_EVADE';
    this.modeTicks++;
    if (threat && threat.pos) {
      this.evadeTargetPos = threat.pos;
    }

    const threatPos = this.evadeTargetPos || (threat && threat.pos);
    if (!threatPos) {
      this.activeMode = 'IDLE';
      this.modeTicks = 0;
      return false;
    }

    const botPos = this.bot.entity.position;
    const dist = botPos.distanceTo(threatPos);
    const maxTicks = this.escapeCfg.railEvadeTicks || 12;

    if (dist >= 4.8 || this.modeTicks >= maxTicks) {
      if (threat && threat.key) {
        this.evadedRails.set(threat.key, Date.now() + 2500);
      }
      this.railBlockThreat = null;
      this.evadeTargetPos = null;
      this.activeMode = 'IDLE';
      this.modeTicks = 0;
      return false;
    }

    const best = this._findBestEscapeYaw(threatPos, true);
    const awayYaw = best
      ? best.yaw
      : Math.atan2(-(botPos.x - threatPos.x), -(botPos.z - threatPos.z));

    this.aimer.stepTowardsAngles(awayYaw, 0.0, { speedMultiplier: 1.6, toleranceRad: 0.25 });
    if (typeof this.bot.setControlState === 'function') {
      this.bot.setControlState('sneak', false);
      this.bot.setControlState('forward', true);
      this.bot.setControlState('back', false);
      this.bot.setControlState('left', false);
      this.bot.setControlState('right', false);
      this.bot.setControlState('sprint', this.bot.food > 6);
      this.bot.setControlState('jump', Boolean(this.bot.entity.onGround));
    }
    return true;
  },

  _tickStallUnstick(target, context) {
    const now = Date.now();
    if (this.activeMode === 'STALL_UNSTICK') {
      if (this.pillarActive) {
        return this._tickPillarOut();
      }
      this.detourTicks--;
      if (this.detourTicks <= 0) {
        this.activeMode = 'IDLE';
        this.detourYaw = null;
        return false;
      }
      if (this.detourYaw !== null) {
        this.aimer.stepTowardsAngles(this.detourYaw, 0.0, { speedMultiplier: 1.5 });
      }
      if (typeof this.bot.setControlState === 'function') {
        this.bot.setControlState('sneak', false);
        this.bot.setControlState('forward', true);
        this.bot.setControlState('back', false);
        this.bot.setControlState('left', false);
        this.bot.setControlState('right', false);
        this.bot.setControlState('sprint', this.bot.food > 6 && !this.isInWater());
        this.bot.setControlState('jump', Boolean(this.bot.entity.onGround || this.isInWater()));
      }
      return true;
    }

    if (!context || !context.canTrackStall) {
      this.stallTicks = 0;
      this.lastCheckPos = this.bot.entity.position.clone();
      return false;
    }

    const ctrl = this.bot.controlState || this.bot.controlStates || {};
    const movingIntent = Boolean(ctrl.forward || ctrl.back || ctrl.left || ctrl.right);
    if (!movingIntent) {
      this.stallTicks = 0;
      this.lastCheckPos = this.bot.entity.position.clone();
      return false;
    }

    const pos = this.bot.entity.position;
    if (this.lastCheckPos) {
      const dx = pos.x - this.lastCheckPos.x;
      const dz = pos.z - this.lastCheckPos.z;
      if (Math.sqrt(dx * dx + dz * dz) < 0.04) {
        this.stallTicks += 1;
      } else {
        this.stallTicks = 0;
      }
    }
    this.lastCheckPos = pos.clone();

    const threshold = this.escapeCfg.stallTicksThreshold || 14;
    if (this.stallTicks < threshold || (now - this.lastStallRecoveryAt) < 2200) {
      return false;
    }

    this.stallTicks = 0;
    this.lastStallRecoveryAt = now;

    const exit = this._findBestEscapeYaw(null, true);
    if (exit && !exit.hasLava) {
      this.activeMode = 'STALL_UNSTICK';
      this.detourYaw = exit.yaw;
      this.detourTicks = 8;
      return this._tickStallUnstick(target, context);
    }

    if (this._tickPillarOut()) {
      this.activeMode = 'STALL_UNSTICK';
      return true;
    }

    if (typeof this.bot.blockAt === 'function' && typeof this.bot.dig === 'function') {
      const feet = pos.floored();
      for (const off of [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]) {
        const adj = this.bot.blockAt(feet.plus(off));
        if (adj && adj.boundingBox === 'block' && this._canDigBlock(adj)) {
          return this._tickBlockStuckEscape(adj, false);
        }
      }
    }

    const pearl = this._findItem('ender_pearl');
    if (pearl) {
      const eq = this._ensureItemHeld(pearl);
      this.aimer.stepTowardsAngles(this.bot.entity.yaw, 38 * (Math.PI / 180), { force: true });
      if (!eq.swapped && typeof this.bot.activateItem === 'function') {
        this.bot.activateItem(false);
      }
      return true;
    }

    return false;
  }
};

module.exports = {
  hazardUnstickMethods,
  RAIL_BLOCK_NAMES,
  UNBREAKABLE_BLOCKS,
  isTntCartEntity
};
