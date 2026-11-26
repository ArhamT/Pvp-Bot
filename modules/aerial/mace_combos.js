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

const maceComboMethods = {
  _canStartOpportunisticMaceSmash(target) {
    if (!target || !target.isValid || !this.bot.entity) return false;
    const { onGround, inWater, inLava } = this._getEnvironmentFlags();
    if (onGround || inWater || inLava) return false;
    const velY = this.bot.entity.velocity ? this.bot.entity.velocity.y : 0;
    const minFall = this.aerialCfg.stunSlamMinFallDistance !== undefined
      ? this.aerialCfg.stunSlamMinFallDistance
      : 1.8;
    if (velY >= -0.05 || this.fallDistance < minFall) return false;
    if (!this._findMace(true)) return false;
    return this.bot.entity.position.distanceTo(target.position) <= 6.5;
  },

  _canStartMaceLaunch(target) {
    if (this.aerialCfg.maceLaunchEnabled === false) return false;
    if (!target || !target.isValid || !this.bot.entity) return false;
    const { onGround, inWater, inLava } = this._getEnvironmentFlags();
    if (!onGround || inWater || inLava) return false;

    const now = Date.now();
    const cooldown = this.aerialCfg.maceLaunchCooldownMs || 1800;
    if ((now - this.lastMaceLaunchTime) < cooldown) return false;

    const dist = this.bot.entity.position.distanceTo(target.position);
    if (dist < 2.2 || dist > 13.0) return false;

    if (!this._findMace(true) || !this._findItemByName('wind_charge')) return false;
    if (!this._hasClearSkyAbove(5)) return false;

    return true;
  },

  /**
   * High-tier Mace Launch + 3D Air Steering + Wind Burst Chaining + Pearl Catching:
   * 1. JUMP_INIT: Face target, sprint-jump off ground first while equipping wind_charge & pitching down.
   * 2. WIND_CHARGE_LAUNCH: Fire angled wind_charge 1–2 ticks AFTER leaving ground (full 7–10b launch up + toward enemy!).
   * 3. AIRBORNE_DESCENT: 3D air-steer onto predicted target, check Pearl Catch if enemy dodges/pearls,
   *    Stun Slam if shielded, or pre-equip Wind Burst/Breach/Density Mace and SMASH!
   * 4. WIND_BURST_BOUNCE: Detects upward Wind Burst bounce (`velY > 0.35`) after smash and immediately chains!
   */
  _tickMaceLaunch(target) {
    this.stageTicks++;
    if (this.stage === 'SWORD_RESTORE') {
      return this._tickSwordRestore();
    }

    if (!target || !target.isValid) {
      if (this._shouldTriggerClutch(null, true)) {
        this._enterClutch();
        return this._tickClutch();
      }
      this.cancel();
      return false;
    }

    const { onGround, inWater } = this._getEnvironmentFlags();
    const reach = this.combatCfg.reach || DEFAULT_REACH;
    const reachDist = this._getReachDistance(target);
    const velY = this.bot.entity.velocity ? this.bot.entity.velocity.y : 0;
    const pos = this.bot.entity.position;
    const predPos = this._getPredictedPosition(target, 3);
    const dx = predPos.x - pos.x;
    const dz = predPos.z - pos.z;
    const horizDist = Math.sqrt(dx * dx + dz * dz);
    const yawToTarget = Math.atan2(-dx, -dz);

    // Compute angled downward pitch so Wind Charge propels us UP AND FORWARD toward target!
    // Close (<3.5b): -86° (high vertical); Mid (3.5-7b): -80°; Far (>7b): -75° (forward arc)
    const launchPitchDeg = horizDist < 3.5 ? -86 : (horizDist < 7.0 ? -80 : -75);
    const launchPitchRad = launchPitchDeg * DEG_TO_RAD;

    // Stage 1: Same-tick Grounded Wind Charge Launch (jump + pitch -Math.PI/2 + activateItem)
    if (this.stage === 'JUMP_INIT') {
      this.maceJumpTicks++;
      const windSel = this._findItemByName('wind_charge');
      if (!windSel || this.maceJumpTicks > 12) {
        this.cancel();
        return false;
      }

      if (typeof windSel.hotbarIndex === 'number' && windSel.hotbarIndex >= 0 && typeof this.bot.setQuickBarSlot === 'function') {
        if (this.bot.quickBarSlot !== windSel.hotbarIndex) {
          this.bot.setQuickBarSlot(windSel.hotbarIndex);
        }
      } else {
        const eq = this._equipHand(windSel);
        if (!eq.ready) return true;
      }

      this.aimer.stepTowardsAngles(yawToTarget, -Math.PI / 2, {
        speedMultiplier: 2.0,
        toleranceRad: 0.2,
        force: true
      });

      if (typeof this.bot.setControlState === 'function') {
        this.bot.setControlState('forward', true);
        this.bot.setControlState('sprint', true);
        this.bot.setControlState('jump', onGround);
      }

      if (typeof this.bot.activateItem === 'function') {
        this.bot.activateItem(false);
      }
      this.lastMaceLaunchTime = Date.now();
      this.stage = 'AIRBORNE_DESCENT';
      this.stageTicks = 0;
      this.spearLaunchTicks = 0;
      return true;
    }

    // Stage 2: Fire angled Wind Charge while airborne right after jump
    if (this.stage === 'WIND_CHARGE_LAUNCH') {
      if (this.stageTicks > 15) {
        this.cancel();
        return false;
      }
      const windSel = this._findItemByName('wind_charge');
      if (!windSel) {
        this.cancel();
        return false;
      }

      const eq = this._equipHand(windSel);
      const aimStatus = this.aimer.stepTowardsAngles(yawToTarget, launchPitchRad, {
        speedMultiplier: 2.0,
        toleranceRad: 0.2
      });

      if (typeof this.bot.setControlState === 'function') {
        this.bot.setControlState('jump', false);
        this.bot.setControlState('forward', true);
      }

      if (eq.ready && !eq.swapped && aimStatus.pitchErrorDeg <= 14) {
        if (typeof this.bot.activateItem === 'function') {
          this.bot.activateItem(false);
        }
        this.lastMaceLaunchTime = Date.now();
        this.stage = 'AIRBORNE_DESCENT';
        this.stageTicks = 0;
        this.spearLaunchTicks = 0;
        return true;
      }
      return true;
    }

    // Stage 3: Post-Smash Wind Burst Bounce Detection -> Chains straight into next aerial smash / Pearl Catch!
    if (this.stage === 'WIND_BURST_BOUNCE') {
      this.windBurstBounceTicks++;
      this._steerAirborneToward(target, 2);

      // Check immediately if opponent dodged/pearled during our Wind Burst bounce -> Pearl Catch!
      const pearlPlan = this._evaluatePearlCatchTrigger(target);
      if (pearlPlan) {
        this._enterPearlCatch(pearlPlan);
        return this._tickPearlCatch(target);
      }

      // Detected Wind Burst sky-bounce (upward velocity spike or sustained height) -> chain next descent!
      if (!onGround && velY > 0.35 && this.aerialCfg.windBurstChainEnabled !== false) {
        this.fallDistance = 0;
        this.stage = 'AIRBORNE_DESCENT';
        this.stageTicks = 0;
        this.spearLaunchTicks = 2;
        return true;
      }

      if (onGround || inWater || this.windBurstBounceTicks >= 6) {
        this.windBurstChainCount = 0;
        this.stage = 'SWORD_RESTORE';
        return this._tickSwordRestore();
      }
      return true;
    }

    // Stage 4: Airborne Ascent + Descent (3D Air-Steering, Pearl Catching, Stun Slam, Wind Burst Smash)
    if (this.stage === 'AIRBORNE_DESCENT') {
      this.spearLaunchTicks++;
      if (this.spearLaunchTicks === 1 && typeof this.bot.setControlState === 'function') {
        this.bot.setControlState('jump', false);
      }

      if ((onGround || inWater) && this.spearLaunchTicks > 3) {
        this.windBurstChainCount = 0;
        this.stage = 'SWORD_RESTORE';
        return this._tickSwordRestore();
      }
      if (this.spearLaunchTicks > 85) {
        this.windBurstChainCount = 0;
        this.stage = 'SWORD_RESTORE';
        return this._tickSwordRestore();
      }

      // Full 3D air-steering directly onto target's predicted hitbox
      const { aimStatus } = this._steerAirborneToward(target, 2);

      // Wind Burst Pearl Catch check if enemy ran/dodged out from under us OR threw an escape pearl!
      const pearlPlan = this._evaluatePearlCatchTrigger(target);
      if (pearlPlan) {
        this._enterPearlCatch(pearlPlan);
        return this._tickPearlCatch(target);
      }

      const minFall = this.aerialCfg.stunSlamMinFallDistance !== undefined
        ? this.aerialCfg.stunSlamMinFallDistance
        : 1.8;

      if (velY < -0.05) {
        // Branch A: 3-Branch Shield Countering (BACKSTAB / STUN_SLAM / SHIELD_DRAIN)
        const counter = evaluateShieldCounter(this.bot, this.targetState, {
          hasAxe: Boolean(this._findAxe()),
          hasMace: Boolean(this._findMace(true)),
          isAirborne: !onGround,
          isGliding: Boolean(this.bot.entity && this.bot.entity.elytraFlying)
        });
        if (
          this.aerialCfg.stunSlamEnabled !== false &&
          this.fallDistance >= minFall &&
          counter.strategy === 'STUN_SLAM'
        ) {
          this.mode = AERIAL_MODES.STUN_SLAM;
          this.stage = 'AXE_BREAK';
          this.stageTicks = 0;
          this.stunSlamAxeSwapped = false;
          return this._tickStunSlam(target);
        }

        // Branch B: 7-Block Mace Rule (Density > 7b, Breach <= 7b) & SMASH on impact (incl. BACKSTAB bypass)
        const preferWb = this.aerialCfg.windBurstChainEnabled !== false;
        const maceSel = this._findMace(preferWb);
        if (maceSel) {
          const eq = this._equipHand(maceSel);
          if (
            eq.ready &&
            !eq.swapped &&
            this.fallDistance >= minFall &&
            reachDist <= reach + 0.15 &&
            (aimStatus.aligned || aimStatus.yawErrorDeg < 30)
          ) {
            if (typeof this.bot.setControlState === 'function') {
              this.bot.setControlState('sprint', false);
            }
            this.bot.attack(target);
            this._resetFallAfterSmash();
            this.windBurstChainCount++;
            this.stage = 'WIND_BURST_BOUNCE';
            this.stageTicks = 0;
            this.windBurstBounceTicks = 0;
            return true;
          }
        }

        if (this._shouldTriggerClutch(target, true)) {
          this._enterClutch();
          return this._tickClutch();
        }
      }

      return true;
    }

    return false;
  },

  _canStartStunSlam(target) {
    if (this.aerialCfg.stunSlamEnabled === false) return false;
    if (!target || !target.isValid) return false;

    const { onGround, inWater, inLava } = this._getEnvironmentFlags();
    if (onGround || inWater || inLava) return false;

    const minFall = this.aerialCfg.stunSlamMinFallDistance !== undefined
      ? this.aerialCfg.stunSlamMinFallDistance
      : 2.0;
    const maxRange = this.aerialCfg.stunSlamRange !== undefined
      ? this.aerialCfg.stunSlamRange
      : 4.5;

    const velY = this.bot.entity.velocity ? this.bot.entity.velocity.y : 0;
    if (this.fallDistance <= minFall || velY >= -0.05) return false;

    const dist = this.bot.entity.position.distanceTo(target.position);
    const reachDist = this._getReachDistance(target);
    if (Math.min(dist, reachDist) > maxRange) return false;

    if (!this._isTargetRaisingShield(target)) return false;
    if (!this._findAxe() || !this._findMace()) return false;

    return true;
  },

  _tickStunSlam(target) {
    this.stageTicks++;

    if (!target || !target.isValid || !target.position) {
      this._finishToSwordRestore();
      return this._tickSwordRestore();
    }

    const { onGround, inWater } = this._getEnvironmentFlags();
    const reach = this.combatCfg.reach || DEFAULT_REACH;
    const reachDist = this._getReachDistance(target);
    const velY = this.bot.entity.velocity ? this.bot.entity.velocity.y : 0;

    if (this.stage === 'SWORD_RESTORE') {
      return this._tickSwordRestore();
    }

    // If we already landed before completing smash, swap back to sword cleanly
    if (onGround || inWater) {
      this.stage = 'SWORD_RESTORE';
      return this._tickSwordRestore();
    }

    // Timeout guard
    if (this.stageTicks > 40) {
      this.stage = 'SWORD_RESTORE';
      return this._tickSwordRestore();
    }

    const aimStatus = this._aimAtTarget(target, 1, {
      speedMultiplier: 1.5,
      toleranceRad: 0.28,
      force: true
    });
    this._setAirborneMove(aimStatus.yawErrorDeg < 45, false);

    // 3-Branch Shield Countering: BACKSTAB (preferred airborne) bypasses shield without Axe swap
    const shieldCounter = evaluateShieldCounter(this.bot, this.targetState, {
      hasAxe: Boolean(this._findAxe()),
      hasMace: Boolean(this._findMace(true)),
      isAirborne: !onGround,
      isGliding: Boolean(this.bot.entity && this.bot.entity.elytraFlying)
    });
    if (shieldCounter.strategy === 'BACKSTAB') {
      this.stage = 'MACE_SMASH';
    }

    // --- Stage 1: Equip hotbar Axe & break target's shield (STUN_SLAM / SHIELD_DRAIN) ---
    if (this.stage === 'AXE_BREAK') {
      const axeSel = this._findAxe();
      if (!axeSel) {
        this.stage = 'MACE_SMASH';
        return true;
      }

      const projectedReach = reachDist - Math.abs(velY);
      const readyToEquipAxe = reachDist <= 3.2 || projectedReach <= reach;

      if (readyToEquipAxe) {
        const eq = this._equipHand(axeSel);
        if (eq.ready && reachDist <= reach && aimStatus.aligned) {
          if (
            this.aerialCfg.sameTickAttributeSwap !== false &&
            shieldCounter.strategy === 'STUN_SLAM'
          ) {
            const maceSel = this._findMace(true);
            this.bot.attack(target);
            this._markShieldDisabled();
            if (maceSel) {
              executeAttributeSwapAttack(this.bot, target, axeSel, maceSel, {
                durabilityDrainMode: Boolean(this.combatCfg.durabilityDrainMode)
              });
              this._resetFallAfterSmash();
              if (this.aerialCfg.windBurstChainEnabled !== false && maceSel.isWindBurst) {
                this.windBurstChainCount++;
                this.mode = AERIAL_MODES.MACE_LAUNCH;
                this.stage = 'WIND_BURST_BOUNCE';
                this.stageTicks = 0;
                this.windBurstBounceTicks = 0;
              } else {
                this.stage = 'SWORD_RESTORE';
              }
              return true;
            }
          }
          this.bot.attack(target);
          this._markShieldDisabled();
          this.stage = shieldCounter.strategy === 'SHIELD_DRAIN' ? 'AXE_BREAK' : 'MACE_SMASH';
          return true;
        }
      }
      return true;
    }

    // --- Stage 2: Swap to 7-Block Mace & land smash before ground ---
    if (this.stage === 'MACE_SMASH') {
      const maceSel = this._findMace(this.aerialCfg.windBurstChainEnabled !== false);
      if (!maceSel) {
        this.stage = 'SWORD_RESTORE';
        return this._tickSwordRestore();
      }

      const eq = this._equipHand(maceSel);
      if (eq.ready && reachDist <= reach + 0.15 && (aimStatus.aligned || aimStatus.yawErrorDeg < 30)) {
        if (typeof this.bot.setControlState === 'function') {
          this.bot.setControlState('sprint', false);
        }
        this.bot.attack(target);
        this._resetFallAfterSmash();
        if (this.aerialCfg.windBurstChainEnabled !== false && maceSel.isWindBurst) {
          this.windBurstChainCount++;
          this.mode = AERIAL_MODES.MACE_LAUNCH;
          this.stage = 'WIND_BURST_BOUNCE';
          this.stageTicks = 0;
          this.windBurstBounceTicks = 0;
        } else {
          this.stage = 'SWORD_RESTORE';
        }
        return true;
      }

      // Clutch fallback if smash misses and lethal ground impact is imminent
      if (this._shouldTriggerClutch(target, true)) {
        this._enterClutch();
        return this._tickClutch();
      }

      return true;
    }

    return false;
  },

  _finishToSwordRestore() {
    this.stage = 'SWORD_RESTORE';
  },

  _tickSwordRestore() {
    const swordSel = this._findSword();
    if (swordSel) {
      this._equipHand(swordSel);
    }
    if (this.bot && typeof this.bot.setControlState === 'function') {
      this.bot.setControlState('jump', false);
    }
    this._resetState();
    return true;
  },

  _canStartSpearMace(target) {
    if (this.aerialCfg.spearMaceEnabled === false) return false;
    if (!target || !target.isValid) return false;

    const cooldownMs = this.aerialCfg.spearMaceCooldownMs !== undefined
      ? this.aerialCfg.spearMaceCooldownMs
      : 4000;
    if ((Date.now() - this.lastSpearMaceTime) < cooldownMs) return false;

    const { onGround, inWater, inLava } = this._getEnvironmentFlags();
    if (!onGround || inWater || inLava) return false;

    const minRange = this.aerialCfg.spearMinRange !== undefined ? this.aerialCfg.spearMinRange : 3.2;
    const maxRange = this.aerialCfg.spearMaxRange !== undefined ? this.aerialCfg.spearMaxRange : 4.5;
    const dist = this.bot.entity.position.distanceTo(target.position);
    if (dist < minRange || dist > maxRange) return false;

    if (!this._findSpear() || !this._findItemByName('wind_charge') || !this._findMace()) {
      return false;
    }

    return true;
  },

  _tickSpearMace(target) {
    this.stageTicks++;

    if (this.stage === 'SWORD_RESTORE') {
      return this._tickSwordRestore();
    }

    if (!target || !target.isValid || !target.position) {
      if (this._shouldTriggerClutch(null, true)) {
        this._enterClutch();
        return this._tickClutch();
      }
      this.cancel();
      return false;
    }

    const { onGround, inWater } = this._getEnvironmentFlags();
    const reach = this.combatCfg.reach || DEFAULT_REACH;
    const reachDist = this._getReachDistance(target);
    const dist = this.bot.entity.position.distanceTo(target.position);
    const velY = this.bot.entity.velocity ? this.bot.entity.velocity.y : 0;

    // --- Step 1: Equip Spear/Trident, aim at predicted target, execute thrust/charge ---
    if (this.stage === 'SPEAR_THRUST') {
      if (this.stageTicks > 25 || dist > (this.aerialCfg.spearMaxRange || 4.5) + 1.5) {
        this.cancel();
        return false;
      }

      const spearSel = this._findSpear();
      if (!spearSel) {
        this.cancel();
        return false;
      }

      const eq = this._equipHand(spearSel);
      const aimStatus = this._aimAtTarget(target, 3, {
        speedMultiplier: 1.4,
        toleranceRad: 0.24
      });

      this._setAirborneMove(aimStatus.yawErrorDeg < 40, true);

      // Execute thrust/charge once holding Spear/Trident (sequential after swap) and smoothly aligned
      if (eq.ready && !eq.swapped && aimStatus.aligned && dist <= (this.aerialCfg.spearMaxRange || 4.5) + 0.5) {
        this.bot.attack(target);
        this.spearThrustDone = true;
        this.stage = 'WIND_CHARGE_LAUNCH';
        this.stageTicks = 0;
        return true;
      }
      return true;
    }

    // --- Step 2: Smoothly pitch to -90 deg (-PI/2), jump + fire wind_charge ---
    if (this.stage === 'WIND_CHARGE_LAUNCH') {
      if (this.stageTicks > 25) {
        this.cancel();
        return false;
      }

      const windSel = this._findItemByName('wind_charge');
      if (!windSel) {
        this.stage = 'SWORD_RESTORE';
        return this._tickSwordRestore();
      }

      const eq = this._equipHand(windSel);
      const aimStatus = this.aimer.stepTowardsAngles(this.bot.entity.yaw, -Math.PI / 2, {
        speedMultiplier: 1.65,
        toleranceRad: 0.16
      });

      // Keep subtle forward drift toward target while launching
      this._setAirborneMove(false, false);

      if (eq.ready && !eq.swapped && aimStatus.pitchErrorDeg <= 8) {
        if (typeof this.bot.setControlState === 'function') {
          this.bot.setControlState('jump', true);
        }
        if (typeof this.bot.activateItem === 'function') {
          this.bot.activateItem(false);
        }
        this.lastSpearMaceTime = Date.now();
        this.stage = 'AIRBORNE_DESCENT';
        this.stageTicks = 0;
        this.spearLaunchTicks = 0;
        return true;
      }
      return true;
    }

    // --- Step 3: Transition seamlessly into Stun Slam or Mace Smash on descent ---
    if (this.stage === 'AIRBORNE_DESCENT') {
      this.spearLaunchTicks++;

      // Release jump after initial launch tick
      if (this.spearLaunchTicks === 1 && typeof this.bot.setControlState === 'function') {
        this.bot.setControlState('jump', false);
      }

      // Landed cleanly after launch window
      if ((onGround || inWater) && this.spearLaunchTicks > 2) {
        this.stage = 'SWORD_RESTORE';
        return this._tickSwordRestore();
      }

      if (this.spearLaunchTicks > 80) {
        this.stage = 'SWORD_RESTORE';
        return this._tickSwordRestore();
      }

      const aimStatus = this._aimAtTarget(target, 2, {
        speedMultiplier: 1.45,
        toleranceRad: 0.26
      });
      this._setAirborneMove(aimStatus.yawErrorDeg < 45, false);

      const minFall = this.aerialCfg.stunSlamMinFallDistance !== undefined
        ? this.aerialCfg.stunSlamMinFallDistance
        : 2.0;

      // Descending phase
      if (velY < -0.05) {
        // Branch A: Target raised shield -> seamlessly transition to Stun Slam!
        if (
          this.aerialCfg.stunSlamEnabled !== false &&
          this.fallDistance > minFall &&
          this._isTargetRaisingShield(target) &&
          this._findAxe() &&
          this._findMace()
        ) {
          this.mode = AERIAL_MODES.STUN_SLAM;
          this.stage = 'AXE_BREAK';
          this.stageTicks = 0;
          return this._tickStunSlam(target);
        }

        // Branch B: Pre-equip Mace on descent (sequentially ahead of impact tick)
        const maceSel = this._findMace();
        if (maceSel) {
          const eq = this._equipHand(maceSel);
          if (
            eq.ready &&
            !eq.swapped &&
            this.fallDistance > minFall &&
            reachDist <= reach &&
            aimStatus.aligned
          ) {
            this.bot.attack(target);
            this.stage = 'SWORD_RESTORE';
            return true;
          }
        }

        // Branch C: Clutch fallback if smash misses near lethal ground impact
        if (this._shouldTriggerClutch(target, true)) {
          this._enterClutch();
          return this._tickClutch();
        }
      }

      return true;
    }

    return false;
  }
};

module.exports = { maceComboMethods };
