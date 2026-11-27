'use strict';

const { DEG_TO_RAD } = require('../aim');
const { findNearestLiquidSource } = require('../inventory_utils');
const { canThrowPearl, markPearlThrown } = require('../pearl_ballistics');
const { DEFAULT_REACH, AERIAL_MODES } = require('./constants');

const CLUTCH_ITEM_PRIORITY = [
  'water_bucket',
  'wind_charge',
  'cobweb',
  'powder_snow_bucket',
  'slime_block',
  'hay_block',
  'ender_pearl'
];

/**
 * High-tier Aerial Defense & Multi-Tool Fall Clutch (`modules/aerial/defense_clutch.js`):
 * - Fixes missing `DEFAULT_REACH` import crash
 * - Supports Water Bucket (with post-landing MLG pickup!), Wind Charge, Cobweb, Powder Snow, Slime, Hay, & Pearl fallbacks
 * - Aim-aligned Dive Bomb Dodge with shared `pearl_ballistics` cooldown
 */
const defenseClutchMethods = {
  _findClutchTool() {
    for (let i = 0; i < CLUTCH_ITEM_PRIORITY.length; i++) {
      const name = CLUTCH_ITEM_PRIORITY[i];
      if (name === 'ender_pearl' && !canThrowPearl(this.bot, { emergency: true, cooldownMs: 800 })) {
        continue;
      }
      const sel = this._findItemByName(name);
      if (sel) return sel;
    }
    return null;
  },

  _shouldTriggerClutch(target, allowNearTargetMiss = false) {
    const { onGround, inWater, inLava, inCobweb } = this._getEnvironmentFlags();
    if (onGround || inWater || inLava || inCobweb) return false;

    const velY = this.bot.entity.velocity ? this.bot.entity.velocity.y : 0;
    if (velY >= -0.05) return false;

    const minFall = this.aerialCfg.clutchMinFallDistance !== undefined
      ? this.aerialCfg.clutchMinFallDistance
      : 4.0;
    if (this.fallDistance < minFall) return false;

    const heightAboveGround = this._getHeightAboveGround();
    if (heightAboveGround > 3.8) return false;

    if (!this._findClutchTool()) return false;

    if (!allowNearTargetMiss && target && target.isValid) {
      const reach = this.combatCfg.reach || DEFAULT_REACH;
      if (this._getReachDistance(target) <= reach && this._findMace()) {
        return false;
      }
    }

    return true;
  },

  _enterClutch() {
    this.mode = AERIAL_MODES.CLUTCH;
    this.stage = 'CLUTCH_EXECUTE';
    this.stageTicks = 0;
    this._clutchUsedWater = false;
  },

  _tickClutch() {
    this.stageTicks++;

    const { onGround, inWater, inCobweb } = this._getEnvironmentFlags();

    // Post-landing MLG water pickup (1–3 ticks after touching water)
    if (this.stage === 'CLUTCH_PICKUP') {
      const emptyBucket = this._findItemByName('bucket');
      const waterSrc = findNearestLiquidSource(this.bot, this.aimer, this.bot.entity.position, 4.2, {
        liquidName: 'water',
        maxRadius: 3
      });
      if (emptyBucket && waterSrc && this.stageTicks <= 5) {
        const aim = this.aimer.stepTowardsPoint(waterSrc.pos.offset(0.5, 0.35, 0.5), {
          speedMultiplier: 2.0,
          toleranceRad: 0.25
        });
        const eq = this._equipHand(emptyBucket);
        if (eq.ready && !eq.swapped && aim.aligned && typeof this.bot.activateItem === 'function') {
          this.bot.activateItem(false);
          if (this.elytraSwappedIn || this.pendingChestplateRestore) this._restoreChestplate();
          this._resetState();
          return true;
        }
        return true;
      }
      if (this.elytraSwappedIn || this.pendingChestplateRestore) this._restoreChestplate();
      this._resetState();
      return true;
    }

    if (onGround || inWater || inCobweb) {
      if (this._clutchUsedWater && (inWater || this._findItemByName('bucket'))) {
        this.stage = 'CLUTCH_PICKUP';
        this.stageTicks = 0;
        return true;
      }
      if (this.elytraSwappedIn || this.pendingChestplateRestore) {
        this._restoreChestplate();
      }
      const swordSel = this._findSword();
      if (swordSel && !this.swappedThisTick) {
        this._equipHand(swordSel);
      }
      this._resetState();
      return true;
    }

    if (this.stage === 'CLUTCH_RECOVER' || this.stageTicks > 25) {
      if (this.elytraSwappedIn || this.pendingChestplateRestore) {
        this._restoreChestplate();
      }
      this._resetState();
      return true;
    }

    const clutchSel = this._findClutchTool();
    if (!clutchSel) {
      this._resetState();
      return false;
    }

    const eq = this._equipHand(clutchSel);
    const aimStatus = this.aimer.stepTowardsAngles(this.bot.entity.yaw, -Math.PI / 2, {
      speedMultiplier: 2.0,
      toleranceRad: 0.16
    });

    const heightAboveGround = this._getHeightAboveGround();

    if (eq.ready && !eq.swapped && aimStatus.pitchErrorDeg <= 14 && heightAboveGround <= 3.8) {
      const name = clutchSel.item.name;
      if (name === 'cobweb' || name === 'slime_block' || name === 'hay_block') {
        // Block-place clutch on top face of ground block below
        const pos = this.bot.entity.position;
        const groundY = Math.floor(pos.y - heightAboveGround);
        const refBlock = typeof this.bot.blockAt === 'function'
          ? this.bot.blockAt(pos.floored().set(Math.floor(pos.x), groundY, Math.floor(pos.z)))
          : null;
        if (refBlock && refBlock.boundingBox === 'block' && typeof this.bot.placeBlock === 'function') {
          const { Vec3 } = require('vec3');
          Promise.resolve(this.bot.placeBlock(refBlock, new Vec3(0, 1, 0))).catch(() => {});
        }
      } else if (typeof this.bot.activateItem === 'function') {
        this.bot.activateItem(false);
        if (name === 'water_bucket') this._clutchUsedWater = true;
        if (name === 'ender_pearl') markPearlThrown(this.bot, 'fall_clutch');
      }
      this.stage = 'CLUTCH_RECOVER';
      return true;
    }

    return true;
  },

  _tickSlowFallEvade(target) {
    const { onGround, inWater } = this._getEnvironmentFlags();
    if (onGround || inWater) {
      this._resetState();
      return false;
    }

    this.mode = AERIAL_MODES.SLOW_FALL_EVADE;
    this.stage = 'EVADE_AIR';
    this.stageTicks++;

    const awayYaw = (target && target.position)
      ? Math.atan2(-(this.bot.entity.position.x - target.position.x), -(this.bot.entity.position.z - target.position.z))
      : this.bot.entity.yaw;
    const weaveYaw = awayYaw + ((this.stageTicks % 12 < 6) ? 0.55 : -0.55);
    this.aimer.stepTowardsAngles(weaveYaw, 10 * DEG_TO_RAD, { speedMultiplier: 1.7 });

    if (typeof this.bot.setControlState === 'function') {
      this.bot.setControlState('forward', true);
      this.bot.setControlState('sprint', true);
      this.bot.setControlState('left', this.stageTicks % 10 < 5);
      this.bot.setControlState('right', this.stageTicks % 10 >= 5);
    }
    return true;
  },

  /**
   * Enemy Dive Bomb dodge: breaks melee reach using aim-aligned Ender Pearl or Wind Charge.
   */
  _tickDiveDodge(target) {
    this.stageTicks++;
    const canPearl = canThrowPearl(this.bot, { emergency: true, cooldownMs: 1200 });
    const pearlSel = canPearl ? this._findItemByName('ender_pearl') : null;
    const windSel = this._findItemByName('wind_charge');
    const escapeSel = pearlSel || windSel;
    if (!escapeSel || this.stageTicks > 8) {
      this._resetState();
      return false;
    }

    const eq = this._equipHand(escapeSel);
    const awayYaw = (target && target.position)
      ? Math.atan2(-(this.bot.entity.position.x - target.position.x), -(this.bot.entity.position.z - target.position.z))
      : this.bot.entity.yaw;
    const pitch = pearlSel ? 36 * DEG_TO_RAD : -Math.PI / 2;
    const aimStatus = this.aimer.stepTowardsAngles(awayYaw, pitch, { speedMultiplier: 2.2, toleranceRad: 0.22 });

    if (eq.ready && !eq.swapped && aimStatus.aligned) {
      if (typeof this.bot.activateItem === 'function') {
        this.bot.activateItem(false);
        if (pearlSel) markPearlThrown(this.bot, 'dive_dodge');
      }
      this.lastDiveDodgeTime = Date.now();
      this._resetState();
      return true;
    }
    return true;
  }
};

module.exports = { defenseClutchMethods };
