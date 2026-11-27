'use strict';

const { Vec3 } = require('vec3');
const { OFFHAND_SLOT, isAirLike, inspectColumnStep } = require('../constants');
const { canSeeBlockFace, findVisibleBlockFace } = require('../placement_los');
const { canMineBlock } = require('../mining');
const { CRYSTAL_POWER, CARDINAL_OFFSETS, isTargetInSurround, hasExistingCrystalAt } = require('../cpvp_tactics');

const CITY_BREAKABLE_BLOCKS = new Set([
  'obsidian',
  'crying_obsidian',
  'cobblestone',
  'cobbled_deepslate',
  'stone',
  'deepslate',
  'end_stone',
  'respawn_anchor',
  'oak_planks',
  'spruce_planks'
]);

/**
 * HT1 Crystal / Anchor PvP Tactics Mixin (`modules/burst/ht1_tactics.js`):
 * 1. Totem-Pop Punish detection (`entityStatus` === 35 on target) -> ultra-aggressive Double-Pop / Anchor finish.
 * 2. Active HT1 CPvP Footwork during burst ticks (maintains 2.6–3.8b spacing, steps behind feet blast-shield,
 *    never walks on top of our own crystal/anchor).
 * 3. Instant Double-Pop / Triple-Pop chaining on existing obsidian blocks without re-scanning latency.
 * 4. Surround "City" Mining (`CPVP_CITY_MINE`) -> mines 1 feet-level surround block of a camped opponent
 *    using BlockMiner and immediately drops a Crystal/Anchor into the exposed hole.
 * 5. Smart DPS-per-tick scoring between Crystal, Hit-Crystal, Surround Pressure, and Respawn Anchor.
 */
const ht1TacticsMethods = {
  _isHoldingOffhandTotem() {
    if (!this.bot || !this.bot.inventory || !this.bot.inventory.slots) return false;
    const offhand = this.bot.inventory.slots[OFFHAND_SLOT];
    return Boolean(offhand && offhand.name === 'totem_of_undying');
  },

  _isInTotemPunishWindow() {
    return Boolean(this.totemPopPunishUntil && Date.now() < this.totemPopPunishUntil);
  },

  _getEffectiveMinBurstHealth() {
    const base = this.burstCfg.minBurstHealth !== undefined ? this.burstCfg.minBurstHealth : 9;
    if (this._isHoldingOffhandTotem()) {
      return this._isInTotemPunishWindow() ? Math.min(base, 5) : Math.min(base, 6);
    }
    return base;
  },

  _handleEntityStatus(entity, status) {
    // Vanilla Minecraft entity status 35 = Totem of Undying activation!
    if (status !== 35 || !entity || !this.bot || !this.bot.entity) return;
    if (entity.id === this.bot.entity.id) return;
    if (this.lastTargetId !== null && entity.id === this.lastTargetId) {
      this.totemPopPunishUntil = Date.now() + 1800;
      this.targetTotemPopCount = (this.targetTotemPopCount || 0) + 1;
    }
  },

  /**
   * Active HT1 CPvP footwork during Crystal / Anchor sequences:
   * - Never stands still like a turret; keeps optimal 2.6–3.8b spacing from the blast/target.
   * - Steps slightly away when too close to our own crystal/anchor (< 2.5b on same Y) so self-damage drops sharply.
   * - Strafes subtly behind our feet blast-shield when safe, avoiding lava/void edges.
   */
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

    // Never sprint during block/crystal placement (prevents NoSlow / BadPackets)
    this.bot.setControlState('sprint', false);
    this.bot.setControlState('jump', false);
    this.bot.setControlState('sneak', false);

    // If too close to the blast point on the same Y-level, step back behind cover/low-ground!
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

    // If opponent is drifting toward max crystal reach (> 3.9b), inch closer while placing!
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

    // Otherwise hold a crisp low-amplitude CPvP strafe (alternates every 10 ticks)
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

  /**
   * Evaluates whether the bot should IMMEDIATELY Double-Pop / Triple-Pop another End Crystal
   * onto `basePos` on the very next tick after detonation (HT1 rapid crystal chain!).
   */
  _canContinueDoublePop(target, basePos, currentChainCount = 0) {
    if (this.burstCfg.doublePopEnabled === false) return false;
    if (!target || !target.isValid || !target.position || !basePos || !this.bot || !this.bot.entity) {
      return false;
    }

    const maxChain = this._isInTotemPunishWindow() ? 4 : 3;
    if (currentChainCount >= maxChain) return false;
    if (!this._findItem('end_crystal')) return false;

    const baseBlock = typeof this.bot.blockAt === 'function' ? this.bot.blockAt(basePos) : null;
    if (!baseBlock || (baseBlock.name !== 'obsidian' && baseBlock.name !== 'bedrock')) return false;

    const crystalSpace = basePos.offset(0, 1, 0);
    if (!isAirLike(this.bot.blockAt(crystalSpace))) return false;
    if (hasExistingCrystalAt(this.bot, crystalSpace)) return false;

    const botPos = this.bot.entity.position;
    if (this._intersectsEntityHitbox(crystalSpace, botPos)) return false;
    if (this._intersectsEntityHitbox(crystalSpace, target.position, target.height || 1.8)) return false;

    // Must have strict 3D LOS to top face of obsidian
    if (!canSeeBlockFace(this.bot, basePos, new Vec3(0, 1, 0), { aimer: this.aimer, maxReach: 4.5 })) {
      return false;
    }

    const blastPos = basePos.offset(0.5, 1.0, 0.5);
    const predictedFeet = this._getPredictedTargetFeet(target, 2);
    if (blastPos.distanceTo(predictedFeet) > 4.6) return false;

    const targetDmg = this.estimateBlastDamage(blastPos, predictedFeet, target, CRYSTAL_POWER);
    const selfDmg = this.estimateBlastDamage(blastPos, botPos, this.bot.entity, CRYSTAL_POWER);
    const minSafeHp = this._isHoldingOffhandTotem() ? 4 : 6;

    if (targetDmg < 4.0) return false;
    if (targetDmg <= selfDmg && !this._isInTotemPunishWindow()) return false;
    if ((this.bot.health - selfDmg) <= minSafeHp) return false;

    return true;
  },

  /**
   * HT1 Surround "City" Finder:
   * When the opponent is camped inside a 1x1 obsidian/cobble surround and we carry a Diamond/Netherite
   * Pickaxe + End Crystals, finds the best visible feet-level surround block to mine open!
   */
  _findSurroundCityBlock(target) {
    if (this.burstCfg.cityMineEnabled === false) return null;
    if (!target || !target.isValid || !target.position || !this.bot || !this.bot.entity) return null;
    if (typeof this.bot.blockAt !== 'function' || typeof this.bot.dig !== 'function') return null;
    if (!this._findItem('end_crystal') && !this._findItem('respawn_anchor')) return null;
    if (!isTargetInSurround(this.bot, target)) return null;

    const botPos = this.bot.entity.position;
    if (botPos.distanceTo(target.position) > 4.5) return null;

    const feet = target.position.floored();
    let best = null;
    let bestScore = -Infinity;

    for (const offset of CARDINAL_OFFSETS) {
      const pos = feet.plus(offset);
      const block = this.bot.blockAt(pos);
      if (!block || !CITY_BREAKABLE_BLOCKS.has(block.name)) continue;
      if (!canMineBlock(this.bot, block)) continue;

      const vis = findVisibleBlockFace(this.bot, pos, { aimer: this.aimer, maxReach: 4.5 });
      if (!vis) continue;

      // Prefer blocks adjacent to an obsidian/bedrock floor so breaking it immediately opens a crystal spot!
      const below = this.bot.blockAt(pos.offset(0, -1, 0));
      const crystalReadyFloor = below && (below.name === 'obsidian' || below.name === 'bedrock');
      const outerFloor = this.bot.blockAt(pos.plus(offset).offset(0, -1, 0));
      const outerCrystalReady = outerFloor && (outerFloor.name === 'obsidian' || outerFloor.name === 'bedrock');

      // Prefer faster-to-mine surround blocks (cobble/planks > obsidian) & closer faces
      const speedBonus = block.name === 'obsidian' || block.name === 'crying_obsidian' ? 0 : 3.5;
      const score = speedBonus + (crystalReadyFloor ? 2.5 : 0) + (outerCrystalReady ? 1.5 : 0) - vis.distance * 0.5;
      if (score > bestScore) {
        bestScore = score;
        best = { block, pos, offset, vis };
      }
    }

    return best;
  },

  /**
   * Executes HT1 Surround "City" Mining (`CPVP_CITY_MINE`):
   * Mines 1 feet-level surround block cleanly with BlockMiner, and immediately drops a Crystal/Anchor
   * the instant the surround opens!
   */
  _tickCpvpCityMine(target) {
    const plan = this.activePlan;
    this.stateTicks++;
    if (
      !plan ||
      !plan.cityPos ||
      !target ||
      !target.isValid ||
      this.stateTicks > 260 ||
      this.bot.entity.position.distanceTo(target.position) > 5.2
    ) {
      if (this.miner) this.miner.cancel();
      this._resetOffensiveState(true);
      return false;
    }

    const block = this.bot.blockAt(plan.cityPos);
    if (!block || isAirLike(block) || block.boundingBox !== 'block') {
      // Surround block BROKEN! Immediately chain into Crystal/Anchor inside the exposed surround!
      if (this.miner) this.miner.cancel();
      const predictedFeet = this._getPredictedTargetFeet(target, 1);
      const crystalPlan = this._findBestCrystalPlacement(target, predictedFeet);
      if (crystalPlan) {
        this.activePlan = crystalPlan;
        this.stateTicks = 0;
        this.stepDelayTicks = 0;
        this.state = crystalPlan.coverSpot
          ? 'CRYSTAL_COVER'
          : (crystalPlan.needsObsidian ? 'CRYSTAL_PLACE_OBSIDIAN' : 'CRYSTAL_PLACE_CRYSTAL');
        return this._tickCrystalState(target);
      }
      this._resetOffensiveState(false);
      return false;
    }

    const res = this.miner.mineBlockTick(block);
    if (res.status === 'unreachable' || res.status === 'unbreakable' || res.status === 'failed') {
      if (this.miner) this.miner.cancel();
      this._resetOffensiveState(true);
      return false;
    }
    return true;
  },

  /**
   * Computes HT1 DPS-weighted priority score for comparing Crystal vs Anchor plans.
   * Existing-obsidian Crystals (2 ticks!) and airborne/unshielded targets score highest.
   */
  _scoreBurstPlan(plan, target) {
    if (!plan) return -Infinity;
    const dmg = plan.targetDmg || 0;
    const selfDmg = plan.selfDmg || 0;
    const punishBonus = this._isInTotemPunishWindow() ? 2.5 : 0;

    if (plan.kind === 'crystal') {
      // 2 ticks if obsidian already exists, 3 ticks if placing obsidian (+1 if cover needed)
      const estTicks = (plan.needsObsidian ? 3 : 2) + (plan.coverSpot ? 1 : 0);
      const airborneBonus = (target && target.onGround === false) ? 3.5 : 0;
      return ((dmg * 1.45 - selfDmg * 1.15) / estTicks) * 3.0 + airborneBonus + punishBonus;
    }

    if (plan.kind === 'anchor') {
      // 3 ticks if already placed+charged, 4 if placed, 5 if placing fresh (+1 if cover)
      const estTicks = (plan.needsPlace ? 5 : (plan.alreadyCharged ? 2 : 4)) + (plan.coverSpot ? 1 : 0);
      return ((dmg * 1.35 - selfDmg * 1.15) / estTicks) * 3.0 + punishBonus;
    }

    return dmg - selfDmg;
  }
};

module.exports = {
  ht1TacticsMethods,
  CITY_BREAKABLE_BLOCKS
};
