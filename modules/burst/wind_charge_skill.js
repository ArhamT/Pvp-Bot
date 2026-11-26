'use strict';

const { Vec3 } = require('vec3');
const { clamp, normalizeAngle } = require('../aim');
const {
  HOTBAR_START,
  OFFHAND_SLOT,
  SWORD_PRIORITY,
  getItemMetadataText,
  hasItemEnchant
} = require('../constants');
const {
  BLAST_SHIELD_BLOCK_PRIORITY,
  isTargetInSurround,
  hasExistingCrystalAt,
  findFeetBlastShieldSpot,
  planHitCrystalTrajectory,
  planSurroundPressurePlacement
} = require('../cpvp_tactics');
const {
  HOTBAR_END,
  CRYSTAL_POWER,
  ANCHOR_POWER,
  COVER_BLOCK_PRIORITY,
  DEFENSE_BLOCK_PRIORITY,
  ARMOR_STATS,
  PLACEMENT_FACES,
  posKey,
  isAirLike,
  isCrystalEntity
} = require('./shared');

const windChargeSkillMethods = {
  hasClearSkyAbove(minClearBlocks = 6) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) return false;
    if (typeof this.bot.blockAt !== 'function') return true;

    const pos = this.bot.entity.position;
    const bx = Math.floor(pos.x);
    const by = Math.floor(pos.y);
    const bz = Math.floor(pos.z);

    for (let dy = 1; dy <= minClearBlocks + 1; dy++) {
      const block = this.bot.blockAt(new Vec3(bx, by + dy, bz));
      if (block && block.boundingBox === 'block') {
        return false;
      }
    }
    return true;
  },

  _findClutchItem() {
    const water = this._findItem('water_bucket');
    if (water) return water;
    return this._findItem('wind_charge');
  },

  _canStartWindChargeLaunch(target) {
    if (this.burstCfg.windChargeLaunchEnabled === false) return false;
    if (!target || !target.isValid || !this.bot || !this.bot.entity) return false;
    if (!this.bot.entity.onGround) return false;

    const now = Date.now();
    if ((now - this.lastWindChargeTime) < (this.burstCfg.windChargeCooldownMs || 3500)) return false;

    const dist = this.bot.entity.position.distanceTo(target.position);
    if (dist < 1.5 || dist > 7.5) return false;

    if (!this.hasClearSkyAbove(6)) return false;

    const windCharge = this._findItem('wind_charge', true);
    const mace = this._findBestMace(true);
    return Boolean(windCharge && mace);
  },

  _steerAirToward(targetPos) {
    if (!this.bot || !this.bot.entity || !targetPos) return;
    const dx = targetPos.x - this.bot.entity.position.x;
    const dz = targetPos.z - this.bot.entity.position.z;
    const horizDist = Math.sqrt(dx * dx + dz * dz);

    if (horizDist < 0.45) {
      this.bot.setControlState('forward', false);
      this.bot.setControlState('left', false);
      this.bot.setControlState('right', false);
      return;
    }

    const desiredYaw = Math.atan2(-dx, -dz);
    const yawDiff = normalizeAngle(desiredYaw - this.bot.entity.yaw);
    this.bot.setControlState('forward', Math.abs(yawDiff) < Math.PI * 0.65);
    this.bot.setControlState('left', yawDiff > 0.35);
    this.bot.setControlState('right', yawDiff < -0.35);
  },

  _tickWindChargeState(target) {
    this.stateTicks++;
    const pos = this.bot.entity.position;
    const minFallDist = this.burstCfg.windChargeMinFallDistance || 3.5;
    const reach = (this.config && this.config.combat && this.config.combat.reach) || 3.0;

    // Step 1: Equip wind_charge and smoothly look straight down (-90° = -PI/2)
    if (this.state === 'WIND_AIM_LAUNCH') {
      if (this.stateTicks > 20 || !this.bot.entity.onGround) {
        this._resetOffensiveState(true);
        return false;
      }

      const windCharge = this._findItem('wind_charge', true);
      if (!windCharge) {
        this._resetOffensiveState(true);
        return false;
      }

      this.bot.setControlState('sprint', false);
      const aimStatus = this.aimer.stepTowardsAngles(this.bot.entity.yaw, -Math.PI / 2, {
        speedMultiplier: 1.45,
        toleranceRad: 0.14
      });
      const equipRes = this._ensureItemHeld(windCharge);

      if (equipRes.swappedThisTick || !equipRes.held || !aimStatus.aligned) {
        return true;
      }

      this.state = 'WIND_FIRE';
      this.stateTicks = 0;
      return true;
    }

    // Step 2: Jump & fire wind_charge downward to gain > 4 blocks height
    if (this.state === 'WIND_FIRE') {
      const windCharge = this._findItem('wind_charge', true);
      if (!windCharge) {
        this._resetOffensiveState(true);
        return false;
      }

      const equipRes = this._ensureItemHeld(windCharge);
      if (equipRes.swappedThisTick || !equipRes.held) {
        return true;
      }

      this.aimer.stepTowardsAngles(this.bot.entity.yaw, -Math.PI / 2, {
        speedMultiplier: 1.45,
        toleranceRad: 0.14
      });

      this.bot.setControlState('jump', true);
      if (typeof this.bot.activateItem === 'function') {
        this.bot.activateItem(false);
      }
      this.lastWindChargeTime = Date.now();
      this.windLaunchStartY = pos.y;
      this.windPeakY = pos.y;
      this.fallDistance = 0;

      this.state = 'WIND_ASCENDING';
      this.stateTicks = 0;
      return true;
    }

    // Step 3: Ascend, release jump, track peak height & target predicted position
    if (this.state === 'WIND_ASCENDING') {
      this.bot.setControlState('jump', false);

      if (pos.y > this.windPeakY) {
        this.windPeakY = pos.y;
      }

      if (target && target.isValid) {
        const predFeet = this._getPredictedTargetFeet(target, 3);
        const predTorso = predFeet.offset(0, (target.height || 1.8) * 0.65, 0);
        this.aimer.stepTowardsPoint(predTorso, { speedMultiplier: 1.3 });
        this._steerAirToward(predFeet);
      }

      const vy = this.bot.entity.velocity ? this.bot.entity.velocity.y : 0;
      const isDescending = !this.bot.entity.onGround && (vy < -0.05 || this.fallDistance > 0.05);

      if (isDescending) {
        this.state = 'WIND_DESCENDING';
        this.stateTicks = 0;
        return true;
      }

      // Abort if launch did not gain elevation after 10 ticks
      if (this.stateTicks > 10 && this.bot.entity.onGround && (this.windPeakY - this.windLaunchStartY) < 1.0) {
        this._resetOffensiveState(true);
        return false;
      }

      return true;
    }

    // Step 4: Descend, equip Breach Mace, track target, smash if fallDistance > 3.5 & reach <= 3.0, else clutch
    if (this.state === 'WIND_DESCENDING') {
      if (this.bot.entity.onGround) {
        this._resetOffensiveState(true);
        return false;
      }

      const heightAboveGround = this._getHeightAboveGround();
      const predFeet = target && target.isValid ? this._getPredictedTargetFeet(target, 2) : null;
      const predTorso = predFeet ? predFeet.offset(0, (target.height || 1.8) * 0.65, 0) : null;
      const reachDist = target && target.isValid ? this._getReachDistanceToEntity(target) : Infinity;

      const maceRecord = this._findBestMace(false);
      const holdingMace = Boolean(this.bot.heldItem && this.bot.heldItem.name === 'mace');
      const canSmashNow = Boolean(
        target &&
        target.isValid &&
        holdingMace &&
        this.fallDistance > minFallDist &&
        reachDist <= reach
      );

      // Clutch check before lethal impact if smash missed or target escaped reach
      const lethalThreshold = Math.max(minFallDist, 3.5);
      const targetEscaped = !target || !target.isValid || reachDist > (reach + 0.8);
      const imminentImpact = heightAboveGround <= 2.4 && !canSmashNow;
      if (
        !canSmashNow &&
        this.fallDistance >= lethalThreshold &&
        ((targetEscaped && heightAboveGround <= 3.5) || imminentImpact) &&
        this._findClutchItem()
      ) {
        this.state = 'WIND_CLUTCH';
        this.stateTicks = 0;
        this.clutchFired = false;
        return this._tickWindClutch();
      }

      // Smoothly aim at target's predicted position & steer horizontally toward them
      let aimStatus = { aligned: false };
      if (predTorso) {
        aimStatus = this.aimer.stepTowardsPoint(predTorso, {
          speedMultiplier: 1.4,
          toleranceRad: 0.24
        });
        this._steerAirToward(predFeet);
      }

      // Equip Mace sequentially (prioritizing combat.getHotbarSlots().breachMaceSlot)
      if (!maceRecord) {
        if (this.fallDistance >= lethalThreshold && this._findClutchItem()) {
          this.state = 'WIND_CLUTCH';
          this.stateTicks = 0;
          this.clutchFired = false;
          return true;
        }
        this._resetOffensiveState(true);
        return false;
      }

      const equipRes = this._ensureItemHeld(maceRecord);
      if (equipRes.swappedThisTick || !equipRes.held) {
        return true;
      }

      if (
        target &&
        target.isValid &&
        this.fallDistance > minFallDist &&
        reachDist <= reach &&
        aimStatus.aligned
      ) {
        if (typeof this.bot.attack === 'function') {
          this.bot.attack(target);
        }
        this._resetOffensiveState(true);
        return true;
      }

      return true;
    }

    // Step 5: Lethal Fall Clutch (water_bucket or wind_charge at pitch = -90°)
    if (this.state === 'WIND_CLUTCH') {
      return this._tickWindClutch();
    }

    return false;
  },

  _tickWindClutch() {
    this.stateTicks++;
    const pos = this.bot.entity.position;
    const feetBlock = typeof this.bot.blockAt === 'function' ? this.bot.blockAt(pos) : null;
    const inWater = feetBlock && (feetBlock.name === 'water' || feetBlock.name === 'flowing_water');

    if (this.bot.entity.onGround || inWater || this.stateTicks > 35) {
      this.fallDistance = 0;
      this._resetOffensiveState(true);
      return false;
    }

    const clutchItem = this._findClutchItem();
    if (!clutchItem) {
      this._resetOffensiveState(true);
      return false;
    }

    this.bot.setControlState('forward', false);
    this.bot.setControlState('left', false);
    this.bot.setControlState('right', false);
    this.bot.setControlState('sprint', false);

    const aimStatus = this.aimer.stepTowardsAngles(this.bot.entity.yaw, -Math.PI / 2, {
      speedMultiplier: 1.65,
      toleranceRad: 0.18
    });

    const equipRes = this._ensureItemHeld(clutchItem);
    if (equipRes.swappedThisTick || !equipRes.held) {
      return true;
    }

    const heightAboveGround = this._getHeightAboveGround();
    if (!this.clutchFired && (aimStatus.aligned || aimStatus.pitchErrorDeg <= 14) && heightAboveGround <= 4.0) {
      if (typeof this.bot.activateItem === 'function') {
        this.bot.activateItem(false);
      }
      this.clutchFired = true;
    }

    return true;
  }
};

module.exports = { windChargeSkillMethods };
