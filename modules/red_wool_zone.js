'use strict';

const { Vec3 } = require('vec3');
const { ROAM_HAZARD_BLOCKS, clearMovementControls, inspectColumnStep } = require('./constants');
const { normalizeAngle } = require('./aim');

const DEFAULT_RED_WOOL_NAMES = ['red_wool'];

const EIGHT_DIRS = [
  { dx: 0, dz: -1, cardinal: true },
  { dx: Math.SQRT1_2, dz: -Math.SQRT1_2, cardinal: false },
  { dx: 1, dz: 0, cardinal: true },
  { dx: Math.SQRT1_2, dz: Math.SQRT1_2, cardinal: false },
  { dx: 0, dz: 1, cardinal: true },
  { dx: -Math.SQRT1_2, dz: Math.SQRT1_2, cardinal: false },
  { dx: -1, dz: 0, cardinal: true },
  { dx: -Math.SQRT1_2, dz: -Math.SQRT1_2, cardinal: false }
];

function isRedWoolBlock(block, blockNames = DEFAULT_RED_WOOL_NAMES) {
  if (!block || !block.name) return false;
  if (blockNames instanceof Set) return blockNames.has(block.name);
  return Array.isArray(blockNames) ? blockNames.includes(block.name) : block.name === 'red_wool';
}

function isAirLike(block) {
  return !block || block.boundingBox === 'empty' ||
    block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air';
}

/**
 * Red Wool Radius Exit skill:
 * Detects when the bot is standing on a `red_wool` pad OR enclosed inside a
 * `red_wool` safezone ring/border, and navigates cleanly out past the border
 * (preferring the direction toward the target if the target is outside) before
 * handing control back to combat.
 */
class RedWoolZoneModule {
  constructor(bot, config, aimer) {
    this.bot = bot;
    this.config = config || {};
    this.cfg = (config && config.redWoolZone) || {};
    this.aimer = aimer;

    const names = Array.isArray(this.cfg.blockNames) && this.cfg.blockNames.length > 0
      ? this.cfg.blockNames
      : DEFAULT_RED_WOOL_NAMES;
    this.blockNames = new Set(names);

    this.activeExitGoal = null;
    this.exitTicks = 0;
    this.lastExitCompletedAt = 0;
    this.lastSeenZoneAt = 0;
    this.lastCheckedAt = 0;
  }

  /**
   * Returns true if `pos` (bot or enemy player) lies on `red_wool` or inside a `red_wool` perimeter ring.
   */
  isPositionInSafeZone(pos) {
    if (!pos) return false;
    return Boolean(this.inspectPosition(pos).inZone);
  }

  /**
   * Returns true if the bot recently stood inside or exited a `red_wool` zone within `windowMs`.
   */
  wasRecentlyInZone(windowMs = 120000) {
    const ref = Math.max(this.lastExitCompletedAt || 0, this.lastSeenZoneAt || 0);
    return ref > 0 && (Date.now() - ref) <= windowMs;
  }

  resetHistory() {
    this.lastExitCompletedAt = 0;
    this.lastSeenZoneAt = 0;
  }

  isBusy() {
    return Boolean(this.activeExitGoal);
  }

  cancel() {
    if (this.activeExitGoal) {
      this.activeExitGoal = null;
      this.exitTicks = 0;
      clearMovementControls(this.bot);
    } else {
      this.exitTicks = 0;
    }
  }

  dispose() {
    this.cancel();
  }

  _hasRedWoolColumn(x, baseY, z) {
    if (!this.bot || typeof this.bot.blockAt !== 'function') return false;
    const bx = Math.floor(x);
    const by = Math.floor(baseY);
    const bz = Math.floor(z);
    for (const dy of [-2, -1, 0, 1]) {
      const b = this.bot.blockAt(new Vec3(bx, by + dy, bz));
      if (isRedWoolBlock(b, this.blockNames)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Inspects whether `pos` is directly on `red_wool` or enclosed inside a `red_wool` ring.
   */
  inspectPosition(pos) {
    if (!pos || !this.bot || typeof this.bot.blockAt !== 'function') {
      return { inZone: false, onRedWool: false, enclosedInRing: false, rays: [] };
    }

    const bx = Math.floor(pos.x);
    const by = Math.floor(pos.y);
    const bz = Math.floor(pos.z);

    let onRedWool = false;
    for (const dy of [-2, -1, 0]) {
      const b = this.bot.blockAt(new Vec3(bx, by + dy, bz));
      if (isRedWoolBlock(b, this.blockNames)) {
        onRedWool = true;
        break;
      }
    }

    const scanRadius = this.cfg.ringScanRadius !== undefined ? this.cfg.ringScanRadius : 14;
    const rays = [];
    let cardinalHits = 0;
    let totalHits = 0;

    for (const dir of EIGHT_DIRS) {
      let firstHitDist = -1;
      let lastHitDist = -1;
      for (let d = 1; d <= scanRadius; d++) {
        const sx = pos.x + dir.dx * d;
        const sz = pos.z + dir.dz * d;
        if (this._hasRedWoolColumn(sx, pos.y, sz)) {
          if (firstHitDist < 0) firstHitDist = d;
          lastHitDist = d;
        }
      }
      if (firstHitDist > 0) {
        totalHits++;
        if (dir.cardinal) cardinalHits++;
      }
      rays.push({ dx: dir.dx, dz: dir.dz, cardinal: dir.cardinal, firstHitDist, lastHitDist });
    }

    const enclosedInRing = cardinalHits >= 3 || totalHits >= 5;
    return {
      inZone: onRedWool || enclosedInRing,
      onRedWool,
      enclosedInRing,
      rays
    };
  }

  _isRayWalkable(botPos, dx, dz, exitDist) {
    if (!this.bot || typeof this.bot.blockAt !== 'function') return { walkable: true, stepUpNeeded: false };

    const by = Math.floor(botPos.y);
    let stepUpNeeded = false;
    const steps = Math.max(2, Math.ceil(exitDist));

    for (let i = 1; i <= steps; i++) {
      const dist = Math.min(exitDist, i);
      const sx = Math.floor(botPos.x + dx * dist);
      const sz = Math.floor(botPos.z + dz * dist);

      const feet = this.bot.blockAt(new Vec3(sx, by, sz));
      const head = this.bot.blockAt(new Vec3(sx, by + 1, sz));
      const aboveHead = this.bot.blockAt(new Vec3(sx, by + 2, sz));

      if (feet && ROAM_HAZARD_BLOCKS.has(feet.name)) return { walkable: false, stepUpNeeded: false };
      if (head && ROAM_HAZARD_BLOCKS.has(head.name)) return { walkable: false, stepUpNeeded: false };

      if (!isAirLike(feet)) {
        // 1-block lip is jumpable if head+aboveHead are clear
        if (!isAirLike(head) || !isAirLike(aboveHead)) {
          return { walkable: false, stepUpNeeded: false };
        }
        stepUpNeeded = true;
      } else if (!isAirLike(head)) {
        return { walkable: false, stepUpNeeded: false };
      }

      // Check floor safety at step (no lava/void drop > 3 blocks)
      let foundSolidFloor = false;
      for (let drop = 1; drop <= 3; drop++) {
        const floor = this.bot.blockAt(new Vec3(sx, by - drop, sz));
        if (floor && ROAM_HAZARD_BLOCKS.has(floor.name)) {
          return { walkable: false, stepUpNeeded: false };
        }
        if (floor && floor.boundingBox === 'block') {
          foundSolidFloor = true;
          break;
        }
      }
      if (!foundSolidFloor) {
        return { walkable: false, stepUpNeeded: false };
      }
    }

    return { walkable: true, stepUpNeeded };
  }

  _scanRayExitDist(pos, dx, dz, maxScan) {
    let lastHit = -1;
    for (let d = 1; d <= maxScan; d++) {
      if (this._hasRedWoolColumn(pos.x + dx * d, pos.y, pos.z + dz * d)) {
        lastHit = d;
      }
    }
    return lastHit;
  }

  _pickExitGoal(botPos, info, target) {
    const buffer = this.cfg.exitBufferBlocks !== undefined ? this.cfg.exitBufferBlocks : 2.5;
    const scanRadius = this.cfg.ringScanRadius !== undefined ? this.cfg.ringScanRadius : 14;

    let targetDir = null;
    let targetOutside = false;
    if (target && target.isValid && target.position) {
      const tdx = target.position.x - botPos.x;
      const tdz = target.position.z - botPos.z;
      const tLen = Math.sqrt(tdx * tdx + tdz * tdz);
      if (tLen > 0.25) {
        targetDir = { dx: tdx / tLen, dz: tdz / tLen };
        const tInfo = this.inspectPosition(target.position);
        targetOutside = !tInfo.inZone;
      }
    }

    const candidates = [];
    if (targetDir && targetOutside) {
      const lastHit = this._scanRayExitDist(botPos, targetDir.dx, targetDir.dz, scanRadius);
      candidates.push({
        dx: targetDir.dx,
        dz: targetDir.dz,
        lastHitDist: lastHit,
        isTargetRay: true
      });
    }

    for (const ray of info.rays) {
      candidates.push({
        dx: ray.dx,
        dz: ray.dz,
        lastHitDist: ray.lastHitDist,
        isTargetRay: false
      });
    }

    let best = null;
    let bestScore = -Infinity;

    for (const cand of candidates) {
      const exitDist = (cand.lastHitDist > 0 ? cand.lastHitDist : 1.0) + buffer;
      const walkCheck = this._isRayWalkable(botPos, cand.dx, cand.dz, exitDist);
      if (!walkCheck.walkable) continue;

      const exitPos = new Vec3(
        botPos.x + cand.dx * exitDist,
        botPos.y,
        botPos.z + cand.dz * exitDist
      );

      let score = -exitDist;
      if (cand.isTargetRay) {
        score += 12.0;
      } else if (targetDir && targetOutside) {
        const dot = cand.dx * targetDir.dx + cand.dz * targetDir.dz;
        score += dot * 8.0;
      }
      if (!walkCheck.stepUpNeeded) score += 0.5;

      if (score > bestScore) {
        bestScore = score;
        best = {
          exitPos,
          dx: cand.dx,
          dz: cand.dz,
          yaw: Math.atan2(-cand.dx, -cand.dz)
        };
      }
    }

    return best;
  }

  tick(target = null, options = {}) {
    if (this.cfg.enabled === false) return false;
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) return false;
    if (this.bot.entity.elytraFlying) return false;

    const now = Date.now();
    const pos = this.bot.entity.position;
    const allowSprint = options.allowSprint !== false;
    const forceLook = options.forceLook !== false;

    if (!this.activeExitGoal) {
      const recheckMs = this.cfg.recheckCooldownMs !== undefined ? this.cfg.recheckCooldownMs : 250;
      if ((now - this.lastCheckedAt) < recheckMs && (now - this.lastExitCompletedAt) < recheckMs) {
        return false;
      }
      this.lastCheckedAt = now;

      const info = this.inspectPosition(pos);
      if (!info.inZone) {
        return false;
      }
      this.lastSeenZoneAt = now;

      const goal = this._pickExitGoal(pos, info, target);
      if (!goal) {
        return false;
      }
      this.activeExitGoal = goal;
      this.exitTicks = 0;
    }

    this.exitTicks++;
    const maxExitTicks = this.cfg.maxExitTicks !== undefined ? this.cfg.maxExitTicks : 120;
    const dx = this.activeExitGoal.exitPos.x - pos.x;
    const dz = this.activeExitGoal.exitPos.z - pos.z;
    const horizDist = Math.sqrt(dx * dx + dz * dz);

    const currentInfo = this.inspectPosition(pos);
    if ((horizDist <= 1.1 && !currentInfo.inZone) || this.exitTicks > maxExitTicks) {
      this.activeExitGoal = null;
      this.exitTicks = 0;
      this.lastExitCompletedAt = now;
      clearMovementControls(this.bot);
      return false;
    }

    const yaw = Math.atan2(-dx, -dz);
    let yawErrorDeg = Math.abs(normalizeAngle(yaw - (this.bot.entity.yaw || 0))) * (180 / Math.PI);
    if (this.aimer) {
      const aimStatus = this.aimer.stepTowardsAngles(yaw, 0, {
        speedMultiplier: 1.5,
        toleranceRad: 0.25,
        force: forceLook
      });
      yawErrorDeg = aimStatus.yawErrorDeg;
    }

    // Check 1 block ahead for a jumpable step-up (> 0.6b; ignores flat slabs/trapdoors/carpets)
    let stepUp = false;
    if (typeof this.bot.blockAt === 'function' && horizDist > 0.2) {
      const nx = dx / horizDist;
      const nz = dz / horizDist;
      const col = inspectColumnStep(this.bot, pos.x + nx * 0.9, pos.y, pos.z + nz * 0.9);
      if (col.needsJump) {
        stepUp = true;
      }
    }

    if (typeof this.bot.setControlState === 'function') {
      this.bot.setControlState('forward', yawErrorDeg < 55);
      this.bot.setControlState('back', false);
      this.bot.setControlState('left', false);
      this.bot.setControlState('right', false);
      this.bot.setControlState('sneak', false);
      this.bot.setControlState('sprint', allowSprint && yawErrorDeg < 45 && (this.bot.food === undefined || this.bot.food > 6));
      this.bot.setControlState('jump', stepUp || (allowSprint && Boolean(this.bot.entity.onGround) && yawErrorDeg < 30));
    }

    return true;
  }
}

module.exports = {
  RedWoolZoneModule,
  isRedWoolBlock
};
