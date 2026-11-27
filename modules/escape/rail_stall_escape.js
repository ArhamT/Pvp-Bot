'use strict';

const { Vec3 } = require('vec3');
const { inspectColumnStep } = require('../constants');
const { findInventoryItem, ensureItemHeld } = require('../inventory_utils');
const { canThrowPearl, markPearlThrown } = require('../pearl_ballistics');
const { UNBREAKABLE_BLOCKS } = require('../mining');

const RAIL_BLOCK_NAMES = new Set(['rail', 'powered_rail', 'detector_rail', 'activator_rail']);

function isTntCartEntity(entity) {
  if (!entity || !entity.isValid) return false;
  const n = String(entity.name || '').toLowerCase();
  const d = String(entity.displayName || '').toLowerCase();
  return n.includes('tnt_minecart') || n.includes('minecart_tnt') || d.includes('tnt');
}

/**
 * Rail/TNT-Cart evasion, Safe Escape Yaw search (per-step floor-verified!),
 * Embedded-Block digging, and Stall Unstick mixin (`modules/escape/rail_stall_escape.js`).
 */
const railStallEscapeMethods = {
  findNearbyRailOrCartThreat(target) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) return null;
    const now = Date.now();

    // Per-tick cache: eliminates redundant 726-block scans when called twice in one tick
    if (this._railScanTickAt && (now - this._railScanTickAt) < 40) {
      return this._railScanResult;
    }
    this._railScanTickAt = now;

    for (const [k, exp] of this.evadedRails.entries()) {
      if (exp <= now) this.evadedRails.delete(k);
    }

    const botPos = this.bot.entity.position;
    let hasNearbyCart = false;
    if (this.bot.entities) {
      for (const ent of Object.values(this.bot.entities)) {
        if (!isTntCartEntity(ent) || !ent.position) continue;
        if (botPos.distanceSquared(ent.position) <= 4.8 * 4.8) {
          hasNearbyCart = true;
          const key = `cart:${ent.id}`;
          const exp = this.evadedRails.get(key);
          if (!exp || now >= exp) {
            this._railScanResult = { type: 'tnt_minecart', entityId: ent.id, key, pos: ent.position.clone() };
            return this._railScanResult;
          }
        }
      }
    }

    if (this.railBlockThreat) {
      const exp = this.evadedRails.get(this.railBlockThreat.key);
      if ((now - this.railBlockThreat.detectedAt) <= 1500 && (!exp || now >= exp)) {
        const radius = (this.escapeCfg.railEvadeRadius || 4.2) + 0.6;
        if (this.railBlockThreat.type === 'tnt_minecart') {
          const liveEnt = this.bot.entities && this.railBlockThreat.entityId !== undefined
            ? this.bot.entities[this.railBlockThreat.entityId]
            : null;
          if (liveEnt && isTntCartEntity(liveEnt) && botPos.distanceSquared(liveEnt.position) <= radius * radius) {
            this.railBlockThreat.pos = liveEnt.position.clone();
            this._railScanResult = this.railBlockThreat;
            return this._railScanResult;
          }
        } else if (typeof this.bot.blockAt === 'function' && this.railBlockThreat.blockPos) {
          const b = this.bot.blockAt(this.railBlockThreat.blockPos);
          if (b && RAIL_BLOCK_NAMES.has(b.name) && botPos.distanceSquared(this.railBlockThreat.pos) <= radius * radius) {
            this._railScanResult = this.railBlockThreat;
            return this._railScanResult;
          }
        }
      }
      this.railBlockThreat = null;
    }

    if (typeof this.bot.blockAt !== 'function') {
      this._railScanResult = null;
      return null;
    }

    // Throttle expensive 3D rail fallback scan to 200ms (blockUpdate catches fresh rails instantly)
    if (this._lastFullRailScanAt && (now - this._lastFullRailScanAt) < 200) {
      this._railScanResult = null;
      return null;
    }

    let enemyCartThreat = hasNearbyCart;
    if (!enemyCartThreat && target && target.isValid && target.position && botPos.distanceSquared(target.position) <= 81.0) {
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
    if (!enemyCartThreat) {
      this._railScanResult = null;
      return null;
    }

    this._lastFullRailScanAt = now;
    const radius = this.escapeCfg.railEvadeRadius || 4.2;
    const radiusSq = radius * radius;
    const rInt = Math.ceil(radius);
    const bx = Math.floor(botPos.x);
    const by = Math.floor(botPos.y);
    const bz = Math.floor(botPos.z);
    const probe = new Vec3(0, 0, 0);

    let closest = null;
    let closestDistSq = Infinity;
    for (let dx = -rInt; dx <= rInt; dx++) {
      const x = bx + dx;
      const ddx = (x + 0.5) - botPos.x;
      for (let dy = -1; dy <= 1; dy++) {
        const y = by + dy;
        const ddy = (y + 0.2) - botPos.y;
        for (let dz = -rInt; dz <= rInt; dz++) {
          const z = bz + dz;
          const ddz = (z + 0.5) - botPos.z;
          const distSq = ddx * ddx + ddy * ddy + ddz * ddz;
          if (distSq > radiusSq || distSq >= closestDistSq) continue;

          const key = `${x},${y},${z}`;
          const exp = this.evadedRails.get(key);
          if (exp && now < exp) continue;

          probe.x = x;
          probe.y = y;
          probe.z = z;
          const b = this.bot.blockAt(probe);
          if (!b || !RAIL_BLOCK_NAMES.has(b.name)) continue;

          closestDistSq = distSq;
          closest = { type: 'rail', key, pos: new Vec3(x + 0.5, y + 0.2, z + 0.5), blockPos: new Vec3(x, y, z) };
        }
      }
    }

    this._railScanResult = closest;
    return closest;
  },

  hasNearbyRailOrHazard(target) {
    if (this.escapeCfg.enabled === false) return false;
    return this.activeMode !== 'IDLE' ||
      this.isInLava() ||
      Boolean(this.isEmbeddedInSolidBlock()) ||
      Boolean(this.findNearbyRailOrCartThreat(target));
  },

  /**
   * Evaluates 8 escape directions, verifying solid floor AT EVERY STEP (fixes cliff/void-walk bug!).
   */
  _findBestEscapeYaw(avoidPos = null, allowStepUp = true) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position || typeof this.bot.blockAt !== 'function') {
      return null;
    }
    const base = this.bot.entity.position;
    const probe = new Vec3(0, 0, 0);
    let best = null;

    for (let i = 0; i < 8; i++) {
      const yaw = (i * Math.PI) / 4;
      const dx = -Math.sin(yaw);
      const dz = -Math.cos(yaw);

      let blocked = false;
      let needsJump = false;
      let hasLava = false;
      let allStepsHaveFloor = true;

      if (Math.abs(dx) > 0.25 && Math.abs(dz) > 0.25) {
        const cxCol = inspectColumnStep(this.bot, base.x + Math.sign(dx) * 0.9, base.y, base.z);
        const czCol = inspectColumnStep(this.bot, base.x, base.y, base.z + Math.sign(dz) * 0.9);
        if ((cxCol.blocked || cxCol.needsJump) && (czCol.blocked || czCol.needsJump)) {
          continue;
        }
      }

      for (const dist of [0.6, 1.2, 2.2]) {
        const sx = base.x + dx * dist;
        const sz = base.z + dz * dist;
        const bx = Math.floor(sx);
        const by = Math.floor(base.y);
        const bz = Math.floor(sz);

        const col = inspectColumnStep(this.bot, sx, base.y, sz);
        if (col.blocked || (col.needsJump && !allowStepUp)) {
          blocked = true;
          break;
        }
        if (col.hasHazard) {
          probe.x = bx; probe.y = by; probe.z = bz;
          const fb = this.bot.blockAt(probe);
          if (fb && fb.name === 'cobweb') {
            blocked = true;
            break;
          }
          hasLava = true;
        }
        if (col.needsJump) needsJump = true;

        // Per-step floor check (prevents walking off cliffs when dist=0.6 has floor and dist=1.2/2.2 is void)
        let stepHasFloor = col.hasFloor;
        if (!stepHasFloor) {
          for (let down = 2; down <= 3; down++) {
            probe.x = bx; probe.y = by - down; probe.z = bz;
            const below = this.bot.blockAt(probe);
            if (below && (below.name.includes('lava') || below.name.includes('fire'))) {
              hasLava = true;
              break;
            }
            if (below && below.boundingBox === 'block') {
              stepHasFloor = true;
              break;
            }
          }
        }
        if (!stepHasFloor) {
          allStepsHaveFloor = false;
          break;
        }
      }

      if (blocked || !allStepsHaveFloor) continue;

      let score = (hasLava ? -50 : 20) - (needsJump ? 1.5 : 0);
      if (avoidPos) {
        const ex = base.x + dx * 2.2 - avoidPos.x;
        const ez = base.z + dz * 2.2 - avoidPos.z;
        score += Math.sqrt(ex * ex + ez * ez) * 4.0;
      }
      if (!best || score > best.score) {
        best = { yaw, needsJump, score, hasLava };
      }
    }

    return best;
  },

  _tickBlockStuckEscape(obstructingBlock, isCobweb) {
    this._setActiveMode('BLOCK_STUCK');
    this.modeTicks++;

    if (!isCobweb && !this.miner.digging && this.modeTicks <= 3) {
      const openExit = this._findBestEscapeYaw(null, true);
      if (openExit && !openExit.hasLava) {
        if (this.aimer) {
          this.aimer.stepTowardsAngles(openExit.yaw, 0.0, { speedMultiplier: 1.4 });
        }
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
      const digRes = this.miner.mineBlockTick(obstructingBlock, { allowEmbedded: true });
      this.diggingInProgress = this.miner.digging;
      if (digRes.status === 'preparing' || digRes.status === 'digging' || digRes.status === 'done') {
        return true;
      }
    }

    const now = Date.now();
    const pearl = canThrowPearl(this.bot, { emergency: true, cooldownMs: 2000, now })
      ? findInventoryItem(this.bot, 'ender_pearl')
      : null;
    if (pearl) {
      const openExit = this._findBestEscapeYaw(null, true);
      const yaw = openExit ? openExit.yaw : this.bot.entity.yaw;
      const aim = this.aimer
        ? this.aimer.stepTowardsAngles(yaw, 28 * (Math.PI / 180), { speedMultiplier: 1.7, toleranceRad: 0.25 })
        : { aligned: true };
      const eq = ensureItemHeld(this.bot, pearl);
      if (!eq.swapped && eq.held && aim.aligned && typeof this.bot.activateItem === 'function') {
        this.bot.activateItem(false);
        markPearlThrown(this.bot, 'block_stuck_escape', now);
      }
      return true;
    }

    return false;
  },

  _tickRailCartEvade(threat) {
    this._setActiveMode('RAIL_EVADE');
    this.modeTicks++;
    if (threat && threat.pos) {
      this.evadeTargetPos = threat.pos;
    }

    const threatPos = this.evadeTargetPos || (threat && threat.pos);
    if (!threatPos) {
      this._setActiveMode('IDLE');
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
      this._setActiveMode('IDLE');
      return false;
    }

    const best = this._findBestEscapeYaw(threatPos, true);
    const awayYaw = best
      ? best.yaw
      : Math.atan2(-(botPos.x - threatPos.x), -(botPos.z - threatPos.z));

    if (this.aimer) {
      this.aimer.stepTowardsAngles(awayYaw, 0.0, { speedMultiplier: 1.6, toleranceRad: 0.25 });
    }
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
        this._setActiveMode('IDLE');
        this.detourYaw = null;
        return false;
      }
      if (this.detourYaw !== null && this.aimer) {
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

    const threshold = this.escapeCfg.stallTicksThreshold || 10;
    if (this.stallTicks < threshold || (now - this.lastStallRecoveryAt) < 1800) {
      return false;
    }

    this.stallTicks = 0;
    this.lastStallRecoveryAt = now;

    const exit = this._findBestEscapeYaw(null, true);
    if (exit && !exit.hasLava) {
      this._setActiveMode('STALL_UNSTICK');
      this.detourYaw = exit.yaw;
      this.detourTicks = 8;
      return this._tickStallUnstick(target, context);
    }

    const wallMinePlan = this._planForwardWallMine(target);
    if (wallMinePlan) {
      this.boxMinePlan = wallMinePlan;
      this._setActiveMode('BOX_MINE');
      return this._tickBoxBreakout(target, context);
    }

    if (this._tickPillarOut()) {
      this._setActiveMode('STALL_UNSTICK');
      return true;
    }

    if (typeof this.bot.blockAt === 'function' && typeof this.bot.dig === 'function') {
      const feet = pos.floored();
      for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const adj = this.bot.blockAt(feet.offset(ox, 0, oz));
        if (adj && adj.boundingBox === 'block' && this._canDigBlock(adj)) {
          return this._tickBlockStuckEscape(adj, false);
        }
      }
    }

    const pearl = canThrowPearl(this.bot, { emergency: true, cooldownMs: 2200, now })
      ? findInventoryItem(this.bot, 'ender_pearl')
      : null;
    if (pearl) {
      const aim = this.aimer
        ? this.aimer.stepTowardsAngles(this.bot.entity.yaw, 38 * (Math.PI / 180), { speedMultiplier: 1.7, toleranceRad: 0.25 })
        : { aligned: true };
      const eq = ensureItemHeld(this.bot, pearl);
      if (!eq.swapped && eq.held && aim.aligned && typeof this.bot.activateItem === 'function') {
        this.bot.activateItem(false);
        markPearlThrown(this.bot, 'stall_unstick', now);
      }
      return true;
    }

    return false;
  }
};

module.exports = {
  railStallEscapeMethods,
  RAIL_BLOCK_NAMES,
  UNBREAKABLE_BLOCKS,
  isTntCartEntity
};
