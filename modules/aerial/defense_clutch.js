'use strict';

const { Vec3 } = require('vec3');
const { clamp, DEG_TO_RAD } = require('../aim');
const {
  TORSO_SLOT,
  HOTBAR_START: DEFAULT_HOTBAR_START,
  PEARL_SPEED,
  PEARL_GRAVITY,
  PEARL_DRAG,
  SWORD_PRIORITY,
  AXE_PRIORITY,
  CHESTPLATE_PRIORITY,
  isSpearItem,
  hasItemEnchant
} = require('../constants');
const {
  scanWeaponEnchantments,
  selectMaceForFall,
  buildTargetState,
  evaluateShieldCounter,
  hasSlowFalling,
  detectEnemyDiveBomb,
  shouldConserveElytra,
  executeAttributeSwapAttack
} = require('../mace_elytra');

const DEFAULT_REACH = 3.0;
const AERIAL_MODES = Object.freeze({
  IDLE: 'IDLE',
  STUN_SLAM: 'STUN_SLAM',
  MACE_LAUNCH: 'MACE_LAUNCH',
  PEARL_CATCH: 'PEARL_CATCH',
  SPEAR_MACE: 'SPEAR_MACE',
  ELYTRA_DIVE: 'ELYTRA_DIVE',
  ELYTRA_SPEAR: 'ELYTRA_SPEAR',
  ELYTRA_BOOST: 'ELYTRA_BOOST',
  DIVE_DODGE: 'DIVE_DODGE',
  SLOW_FALL_EVADE: 'SLOW_FALL_EVADE',
  CLUTCH: 'CLUTCH'
});

const defenseClutchMethods = {
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
    if (heightAboveGround > 3.5) return false;

    const hasClutchTool = Boolean(
      this._findItemByName('water_bucket') || this._findItemByName('wind_charge')
    );
    if (!hasClutchTool) return false;

    // If a smash is still cleanly in reach and we weren't explicitly invoked for a miss, let smash land
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
    this.clutchActivated = false;
    this.clutchItemName = null;
  },

  _tickClutch() {
    this.stageTicks++;

    const { onGround, inWater, inCobweb } = this._getEnvironmentFlags();
    if (onGround || inWater || inCobweb) {
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

    const clutchSel = this._findItemByName('water_bucket') || this._findItemByName('wind_charge');
    if (!clutchSel) {
      this._resetState();
      return false;
    }

    this.clutchItemName = clutchSel.item.name;
    const eq = this._equipHand(clutchSel);

    // Smoothly pitch straight down (-90 deg = -PI/2)
    const aimStatus = this.aimer.stepTowardsAngles(this.bot.entity.yaw, -Math.PI / 2, {
      speedMultiplier: 1.85,
      toleranceRad: 0.16
    });

    const heightAboveGround = this._getHeightAboveGround();

    // Activate clutch item sequentially after equip once pitched down near ground
    if (eq.ready && !eq.swapped && aimStatus.pitchErrorDeg <= 14 && heightAboveGround <= 3.5) {
      if (typeof this.bot.activateItem === 'function') {
        this.bot.activateItem(false);
      }
      this.clutchActivated = true;
      this.stage = 'CLUTCH_RECOVER';
      return true;
    }

    return true;
  },

  /**
   * Slow Falling (effect id 28) Threat Matrix handler:
   * Disables Mace dive attempts and stays evasive in the air to dodge arrows until effect clears.
   */
  _tickSlowFallEvade(target) {
    const { onGround, inWater } = this._getEnvironmentFlags();
    if (onGround || inWater) {
      // Grounded with slow falling: keep Mace dives disabled but yield to ground survival/combat
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
    this.aimer.stepTowardsAngles(weaveYaw, 10 * DEG_TO_RAD, { force: true });

    if (typeof this.bot.setControlState === 'function') {
      this.bot.setControlState('forward', true);
      this.bot.setControlState('sprint', true);
      this.bot.setControlState('left', this.stageTicks % 10 < 5);
      this.bot.setControlState('right', this.stageTicks % 10 >= 5);
    }
    return true;
  },

  /**
   * Enemy Dive Bomb dodge: breaks melee reach immediately using Ender Pearl or Wind Charge.
   */
  _tickDiveDodge(target) {
    this.stageTicks++;
    const pearlSel = this._findItemByName('ender_pearl');
    const windSel = this._findItemByName('wind_charge');
    const escapeSel = pearlSel || windSel;
    if (!escapeSel || this.stageTicks > 6) {
      this._resetState();
      return false;
    }

    const eq = this._equipHand(escapeSel);
    const awayYaw = (target && target.position)
      ? Math.atan2(-(this.bot.entity.position.x - target.position.x), -(this.bot.entity.position.z - target.position.z))
      : this.bot.entity.yaw;
    const pitch = pearlSel ? 36 * DEG_TO_RAD : -Math.PI / 2;
    this.aimer.stepTowardsAngles(awayYaw, pitch, { force: true });

    if (eq.ready && !eq.swapped) {
      if (typeof this.bot.activateItem === 'function') {
        this.bot.activateItem(false);
      }
      this.lastDiveDodgeTime = Date.now();
      this._resetState();
      return true;
    }
    return true;
  }
};

module.exports = { defenseClutchMethods };
