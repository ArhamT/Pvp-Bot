'use strict';

const { Vec3 } = require('vec3');
const {
  OFFHAND_SLOT,
  BLAST_SHIELD_BLOCK_PRIORITY,
  isNonNullAir,
  sameBlockPos,
  inspectColumnStep
} = require('../constants');

/**
 * Evaluates and plans Feet Blast-Shielding before detonating an explosive within <= 3.5b on the same Y-level.
 */
function findFeetBlastShieldSpot(burst, blastPos, excludedPos = null) {
  if (!burst || !burst.bot || !burst.bot.entity || typeof burst.bot.blockAt !== 'function' || !blastPos) {
    return { needed: false, alreadyOccluded: false, spot: null };
  }

  const botPos = burst.bot.entity.position;
  const shieldRange = (burst.burstCfg && burst.burstCfg.feetBlastShieldRange) || 3.5;
  const dist = botPos.distanceTo(blastPos);
  const sameYLevel = Math.abs(Math.floor(botPos.y) - Math.floor(blastPos.y)) <= 1 && botPos.y >= blastPos.y - 0.5;

  if (dist > shieldRange || !sameYLevel) {
    return { needed: false, alreadyOccluded: false, spot: null };
  }

  if (burst._isRayOccluded(blastPos, botPos.offset(0, 0.15, 0))) {
    return { needed: false, alreadyOccluded: true, spot: null };
  }

  const blockRecord = burst._findItem(BLAST_SHIELD_BLOCK_PRIORITY);
  if (!blockRecord) {
    return { needed: true, alreadyOccluded: false, spot: null };
  }

  const dx = blastPos.x - botPos.x;
  const dz = blastPos.z - botPos.z;
  const horizLen = Math.sqrt(dx * dx + dz * dz);
  if (horizLen < 0.8) {
    return { needed: true, alreadyOccluded: false, spot: null };
  }

  const ux = dx / horizLen;
  const uz = dz / horizLen;
  const botFloorY = Math.floor(botPos.y);

  const primaryPos = new Vec3(
    Math.floor(botPos.x + ux * 1.0),
    botFloorY,
    Math.floor(botPos.z + uz * 1.0)
  );
  const cardinalPos = Math.abs(ux) >= Math.abs(uz)
    ? new Vec3(Math.floor(botPos.x) + Math.sign(ux), botFloorY, Math.floor(botPos.z))
    : new Vec3(Math.floor(botPos.x), botFloorY, Math.floor(botPos.z) + Math.sign(uz));

  const candidates = [primaryPos];
  if (!sameBlockPos(cardinalPos, primaryPos)) {
    candidates.push(cardinalPos);
  }

  const eyePos = burst.aimer ? burst.aimer.getEyePosition() : botPos.offset(0, 1.62, 0);

  for (const placePos of candidates) {
    if (excludedPos && sameBlockPos(placePos, excludedPos)) continue;
    if (burst._intersectsEntityHitbox(placePos, botPos)) continue;
    const targetBlock = burst.bot.blockAt(placePos);
    if (!isNonNullAir(targetBlock)) continue;
    if (eyePos.distanceTo(placePos.offset(0.5, 0.5, 0.5)) > 4.5) continue;

    const ref = burst._findPlacementRef(placePos);
    if (!ref) continue;

    return {
      needed: true,
      alreadyOccluded: false,
      spot: {
        blockRecord,
        placePos,
        refPos: ref.refPos,
        face: ref.face,
        aimPos: ref.aimPos
      }
    };
  }

  return { needed: true, alreadyOccluded: false, spot: null };
}

/**
 * HT1 CPvP Footwork, Totem-Pop Punish, & DPS-Weighted Selection (`modules/burst/cpvp_footwork.js`):
 * - Detects enemy Totem pops (`entityStatus === 35`) for aggressive punish windows.
 * - Maintains dynamic 2.6–3.8b CPvP spacing & hazard-safe cover footwork.
 * - Scores Crystal vs Anchor candidates by net damage per tick.
 */
const cpvpFootworkMethods = {
  _isHoldingOffhandTotem() {
    if (!this.bot || !this.bot.inventory || !this.bot.inventory.slots) return false;
    const offhand = this.bot.inventory.slots[OFFHAND_SLOT];
    return Boolean(offhand && offhand.name === 'totem_of_undying');
  },

  _isInTotemPunishWindow() {
    return Boolean(this.totemPopPunishUntil && Date.now() < this.totemPopPunishUntil);
  },

  _getEffectiveMinBurstHealth() {
    // Strictly enforce Critical HP Reset (<= 9 HP -> retreat behind Obsidian cover & Gapple / Pearl out)
    return this.burstCfg.minBurstHealth !== undefined ? this.burstCfg.minBurstHealth : 9;
  },

  _handleEntityStatus(entity, status) {
    if (status !== 35 || !entity || !this.bot || !this.bot.entity) return;
    if (entity.id === this.bot.entity.id) return;
    if (this.lastTargetId !== null && entity.id === this.lastTargetId) {
      this.totemPopPunishUntil = Date.now() + 1800;
      this.targetTotemPopCount = (this.targetTotemPopCount || 0) + 1;
    }
  },

  _applyCpvpFootwork(target, blastPos, coverPos = null) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position || typeof this.bot.setControlState !== 'function') {
      return;
    }
    const pos = this.bot.entity.position;
    const refPos = blastPos || (target && target.position);
    if (!refPos) return;

    const dx = refPos.x - pos.x;
    const dz = refPos.z - pos.z;
    const horizDist = Math.hypot(dx, dz);
    const sameY = Math.abs(pos.y - refPos.y) <= 1.25;

    this.bot.setControlState('sprint', false);
    this.bot.setControlState('jump', false);
    this.bot.setControlState('sneak', false);

    const yaw = this.bot.entity.yaw || 0;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);

    if (horizDist > 0.25 && horizDist < 2.65 && sameY) {
      const awayX = -dx / horizDist;
      const awayZ = -dz / horizDist;
      const backStep = inspectColumnStep(this.bot, pos.x + awayX * 0.85, pos.y, pos.z + awayZ * 0.85);
      if (!backStep.blocked && !backStep.hasHazard && backStep.hasFloor) {
        const fwdDot = awayX * fx + awayZ * fz;
        const rightDot = awayX * rx + awayZ * rz;
        this.bot.setControlState('forward', fwdDot > 0.35);
        this.bot.setControlState('back', fwdDot < -0.35);
        this.bot.setControlState('right', rightDot > 0.35);
        this.bot.setControlState('left', rightDot < -0.35);
        return;
      }
    }

    if (target && target.isValid && target.position && !coverPos) {
      const tdx = target.position.x - pos.x;
      const tdz = target.position.z - pos.z;
      const tDist = Math.hypot(tdx, tdz);
      if (tDist > 3.85 && tDist < 5.5) {
        const ux = tdx / tDist;
        const uz = tdz / tDist;
        const fwdStep = inspectColumnStep(this.bot, pos.x + ux * 0.85, pos.y, pos.z + uz * 0.85);
        if (!fwdStep.blocked && !fwdStep.hasHazard && fwdStep.hasFloor) {
          const fwdDot = ux * fx + uz * fz;
          const rightDot = ux * rx + uz * rz;
          this.bot.setControlState('forward', fwdDot > 0.35);
          this.bot.setControlState('back', fwdDot < -0.35);
          this.bot.setControlState('right', rightDot > 0.35);
          this.bot.setControlState('left', rightDot < -0.35);
          return;
        }
      }
    }

    const strafeRight = ((this.stateTicks || 0) % 20) < 10;
    const sx = strafeRight ? rx : -rx;
    const sz = strafeRight ? rz : -rz;
    const sideStep = inspectColumnStep(this.bot, pos.x + sx * 0.8, pos.y, pos.z + sz * 0.8);
    this.bot.setControlState('forward', false);
    this.bot.setControlState('back', false);
    if (!sideStep.blocked && !sideStep.hasHazard && sideStep.hasFloor) {
      this.bot.setControlState('right', strafeRight);
      this.bot.setControlState('left', !strafeRight);
    } else {
      this.bot.setControlState('right', false);
      this.bot.setControlState('left', false);
    }
  },

  _scoreBurstPlan(plan, target) {
    if (!plan) return -Infinity;
    const dmg = plan.targetDmg || 0;
    const selfDmg = plan.selfDmg || 0;
    const punishBonus = this._isInTotemPunishWindow() ? 2.5 : 0;

    if (plan.kind === 'crystal') {
      const estTicks = (plan.needsObsidian ? 3 : 2) + (plan.coverSpot ? 1 : 0);
      const airborneBonus = (target && target.onGround === false) ? 3.5 : 0;
      return ((dmg * 1.45 - selfDmg * 1.15) / estTicks) * 3.0 + airborneBonus + punishBonus;
    }

    if (plan.kind === 'anchor') {
      const estTicks = (plan.needsPlace ? 5 : (plan.alreadyCharged ? 2 : 4)) + (plan.coverSpot ? 1 : 0);
      return ((dmg * 1.35 - selfDmg * 1.15) / estTicks) * 3.0 + punishBonus;
    }

    return dmg - selfDmg;
  }
};

module.exports = {
  BLAST_SHIELD_BLOCK_PRIORITY,
  findFeetBlastShieldSpot,
  cpvpFootworkMethods
};
