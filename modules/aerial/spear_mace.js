'use strict';

const { DEG_TO_RAD } = require('../aim');
const { selectMaceForFall, evaluateShieldCounter } = require('../mace_elytra');
const { DEFAULT_REACH, AERIAL_MODES } = require('./constants');

/**
 * Dedicated HT1 Unbeatable Spear-Mace PvP Skill (`modules/aerial/spear_mace.js`):
 *
 * Full 5-stage tactical chain:
 * 1. SPEAR_OPEN         — Out-ranges opponents at 2.4–6.2b with extended-reach Spear pokes / Lunge
 *                         gap-closing (skips straight to aerial launch if enemy is already holding shield).
 * 2. WIND_LAUNCH        — Instant angled Wind Charge launch (-87°/-81°/-75° with `force: true` + sprint-jump)
 *                         propelling the bot up AND forward directly over the opponent's predicted XZ.
 * 3. AIRBORNE_INTERCEPT — Full 360° WASD+sprint air-steering (`_steerAirborneToward`), 7-Block Enchantment
 *                         Rule (Density >7b vs Breach <=7b), 3-branch Shield Countering (STUN_SLAM/BACKSTAB),
 *                         Pearl Catch if opponent runs/pearls, Elytra Glide intercept if far, & lethal Mace Smash.
 * 4. POST_SMASH_CHAIN   — Detects Wind Burst upward bounce (`velY > 0.32`) to chain infinite airborne smashes,
 *                         OR swaps to Spear Finisher when KB pushes enemy into the 3.05–4.5b Spear sweet spot.
 * 5. SPEAR_FINISHER     — 1-tick-settled 4.2b extended-reach Spear follow-up strike before Sword restore.
 */
const spearMaceMethods = {
  _canStartSpearMace(target) {
    if (this.aerialCfg.spearMaceEnabled === false) return false;
    if (this.postTeleportWaitTicks > 0) return false;
    if (!target || !target.isValid || !target.position) return false;

    const cooldownMs = this.aerialCfg.spearMaceCooldownMs !== undefined
      ? this.aerialCfg.spearMaceCooldownMs
      : 1600;
    if ((Date.now() - this.lastSpearMaceTime) < cooldownMs) return false;

    const { onGround, inWater, inLava, inCobweb } = this._getEnvironmentFlags();
    if (!onGround || inWater || inLava || inCobweb) return false;

    const minRange = this.aerialCfg.spearMinRange !== undefined ? this.aerialCfg.spearMinRange : 2.4;
    const maxRange = this.aerialCfg.spearMaxRange !== undefined ? this.aerialCfg.spearMaxRange : 6.2;
    const dist = this.bot.entity.position.distanceTo(target.position);
    if (dist < minRange || dist > maxRange) return false;

    if (!this._findSpear() || !this._findItemByName('wind_charge') || !this._findMace(true)) {
      return false;
    }

    if (!this._hasClearSkyAbove(5)) return false;

    return true;
  },

  _enterSpearMace() {
    this.mode = AERIAL_MODES.SPEAR_MACE;
    this.stage = 'SPEAR_OPEN';
    this.stageTicks = 0;
    this.spearThrustDone = false;
    this.spearLaunchTicks = 0;
    this.windBurstBounceTicks = 0;
  },

  _selectBestSpearMaceWeapon(target) {
    const heightAbove = (target && target.position && this.bot && this.bot.entity && this.bot.entity.position)
      ? Math.max(0, this.bot.entity.position.y - target.position.y)
      : 0;
    const effectiveFall = Math.max(this.fallDistance || 0, heightAbove);
    if (this.weaponEnchantments) {
      const rule = selectMaceForFall(effectiveFall, this.weaponEnchantments);
      if (rule && rule.item) {
        return this._makeSelection(rule.item);
      }
    }
    return effectiveFall > 7.0 ? this._findDensityMace() : this._findMace(true);
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

    const pos = this.bot.entity.position;
    const velY = this.bot.entity.velocity ? this.bot.entity.velocity.y : 0;
    const { onGround, inWater, inLava, inCobweb } = this._getEnvironmentFlags();
    if (inWater || inLava || inCobweb) {
      this.cancel();
      return false;
    }

    const reach = this.combatCfg.reach || DEFAULT_REACH;
    const spearReach = this.combatCfg.spearReach || 4.2;
    const reachDist = this._getReachDistance(target);
    const dist = pos.distanceTo(target.position);

    // -----------------------------------------------------------------------
    // Stage 1: SPEAR_OPEN — Extended-reach Spear poke / Lunge gap-close
    // -----------------------------------------------------------------------
    if (this.stage === 'SPEAR_OPEN') {
      const maxRange = this.aerialCfg.spearMaxRange !== undefined ? this.aerialCfg.spearMaxRange : 6.2;
      if (this.stageTicks > 18 || dist > maxRange + 2.0) {
        this.cancel();
        return false;
      }

      // If opponent is already holding shield frontally at close range, skip ground poke and launch straight over!
      if (this._isTargetRaisingShield(target) && reachDist <= 4.2) {
        this.stage = 'WIND_LAUNCH';
        this.stageTicks = 0;
        return this._tickSpearMace(target);
      }

      const spearSel = this._findSpear();
      if (!spearSel) {
        this.stage = 'WIND_LAUNCH';
        this.stageTicks = 0;
        return true;
      }

      const eq = this._equipHand(spearSel);
      const aimStatus = this._aimAtTarget(target, 2, {
        speedMultiplier: 2.0,
        toleranceRad: 0.30,
        force: true
      });

      if (typeof this.bot.setControlState === 'function') {
        this.bot.setControlState('forward', reachDist > 2.6);
        this.bot.setControlState('back', false);
        this.bot.setControlState('sprint', reachDist > 2.8 && (this.bot.food === undefined || this.bot.food > 6));
        this.bot.setControlState('jump', false);
      }

      // Execute extended-reach Spear poke once holding Spear sequentially after swap
      if (eq.ready && !eq.swapped && reachDist <= spearReach + 0.15 && (aimStatus.aligned || aimStatus.yawErrorDeg < 28)) {
        this.bot.attack(target);
        this.spearThrustDone = true;
        this.stage = 'WIND_LAUNCH';
        this.stageTicks = 0;
        return true;
      }
      return true;
    }

    // -----------------------------------------------------------------------
    // Stage 2: WIND_LAUNCH — Instant angled Wind Charge launch (`force: true` + sprint-jump)
    // -----------------------------------------------------------------------
    if (this.stage === 'WIND_LAUNCH') {
      if (this.stageTicks > 12) {
        this.cancel();
        return false;
      }

      const windSel = this._findItemByName('wind_charge');
      if (!windSel) {
        this.stage = 'SWORD_RESTORE';
        return this._tickSwordRestore();
      }

      const predPos = this._getPredictedPosition(target, 3);
      const dx = predPos.x - pos.x;
      const dz = predPos.z - pos.z;
      const horizDist = Math.hypot(dx, dz);
      const yawToTarget = Math.atan2(-dx, -dz);

      // Angled launch pitch propels bot UP AND FORWARD onto predicted target XZ
      const launchPitchDeg = horizDist < 3.2 ? -87 : (horizDist < 6.0 ? -81 : -75);
      const eq = this._equipHand(windSel);

      this.aimer.stepTowardsAngles(yawToTarget, launchPitchDeg * DEG_TO_RAD, {
        speedMultiplier: 2.0,
        toleranceRad: 0.18,
        force: true
      });

      if (typeof this.bot.setControlState === 'function') {
        this.bot.setControlState('forward', true);
        this.bot.setControlState('back', false);
        this.bot.setControlState('sprint', this.bot.food === undefined || this.bot.food > 6);
        this.bot.setControlState('jump', onGround);
      }

      // Wait 1 settle tick after swapping to wind_charge, then launch immediately
      if (eq.ready && !eq.swapped) {
        if (typeof this.bot.activateItem === 'function') {
          this.bot.activateItem(false);
        }
        this.lastSpearMaceTime = Date.now();
        this.stage = 'AIRBORNE_INTERCEPT';
        this.stageTicks = 0;
        this.spearLaunchTicks = 0;
        return true;
      }
      return true;
    }

    // -----------------------------------------------------------------------
    // Stage 3: AIRBORNE_INTERCEPT — 360° air-steer, Pearl Catch, Elytra Glide, Shield Counter, & Mace Smash
    // -----------------------------------------------------------------------
    if (this.stage === 'AIRBORNE_INTERCEPT') {
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

      // Full 360-degree WASD + sprint air-steering directly onto opponent's predicted hitbox
      const { aimStatus, horizDist } = this._steerAirborneToward(target, 2);

      // Dynamic Pearl Catch if opponent ran/pearled away from under our descent
      const pearlPlan = this._evaluatePearlCatchTrigger(target);
      if (pearlPlan) {
        this._enterPearlCatch(pearlPlan);
        return this._tickPearlCatch(target);
      }

      // Dynamic Elytra Glide transition if high above and target escaped horizontally
      const heightAboveTarget = pos.y - target.position.y;
      if (
        !onGround &&
        velY < -0.08 &&
        heightAboveTarget >= 4.5 &&
        horizDist >= 5.5 &&
        this._hasElytraAvailable() &&
        this._hasChestplateAvailable()
      ) {
        this._enterElytraDive();
        return this._tickElytraDive(target);
      }

      const minFall = this.aerialCfg.stunSlamMinFallDistance !== undefined
        ? this.aerialCfg.stunSlamMinFallDistance
        : 1.8;

      // Pre-equip the exact 7-Block Rule Mace (Density > 7b, Breach <= 7b) based on actual & projected drop height
      const maceSel = this._selectBestSpearMaceWeapon(target);

      if (velY < -0.05) {
        // Branch A: 3-Branch Shield Countering (STUN_SLAM / BACKSTAB / SHIELD_DRAIN)
        const counter = evaluateShieldCounter(this.bot, this.targetState, {
          hasAxe: Boolean(this._findAxe()),
          hasMace: Boolean(maceSel),
          isAirborne: !onGround,
          isGliding: Boolean(this.bot.entity && this.bot.entity.elytraFlying)
        });
        if (
          this.aerialCfg.stunSlamEnabled !== false &&
          counter.strategy === 'STUN_SLAM' &&
          this.fallDistance > minFall &&
          reachDist <= 4.2
        ) {
          this.mode = AERIAL_MODES.STUN_SLAM;
          this.stage = 'AXE_BREAK';
          this.stageTicks = 0;
          this.stunSlamAxeSwapped = false;
          return this._tickStunSlam(target);
        }

        // Branch B: Pre-equip optimal Mace & execute lethal aerial Mace Smash!
        if (maceSel) {
          const eq = this._equipHand(maceSel);
          if (
            eq.ready &&
            !eq.swapped &&
            this.fallDistance > minFall &&
            reachDist <= reach + 0.3 &&
            (aimStatus.aligned || aimStatus.yawErrorDeg < 35)
          ) {
            if (typeof this.bot.setControlState === 'function') {
              this.bot.setControlState('sprint', false);
            }
            this.bot.attack(target);
            this._resetFallAfterSmash();
            this.lastSpearMaceTime = Date.now();
            this.windBurstChainCount++;
            this.stage = 'POST_SMASH_CHAIN';
            this.stageTicks = 0;
            this.windBurstBounceTicks = 0;
            return true;
          }
        }

        // Branch C: Lethal fall-damage clutch safety if smash misses near ground
        if (this._shouldTriggerClutch(target, true)) {
          this._enterClutch();
          return this._tickClutch();
        }
      } else if (maceSel && this.spearLaunchTicks >= 2 && !this.swappedThisTick) {
        // Pre-equip Mace on the way up so zero swap ticks are spent during descent!
        this._equipHand(maceSel);
      }

      return true;
    }

    // -----------------------------------------------------------------------
    // Stage 4: POST_SMASH_CHAIN — Infinite Wind Burst Bounce OR Extended-Reach Spear Finisher!
    // -----------------------------------------------------------------------
    if (this.stage === 'POST_SMASH_CHAIN') {
      this.windBurstBounceTicks++;
      this._steerAirborneToward(target, 1);

      // Priority 1: Pearl Catch if opponent immediately pearled/sprinted out after smash
      const pearlPlan = this._evaluatePearlCatchTrigger(target);
      if (pearlPlan) {
        this._enterPearlCatch(pearlPlan);
        return this._tickPearlCatch(target);
      }

      // Priority 2: Wind Burst upward sky-bounce -> loop infinitely back into AIRBORNE_INTERCEPT!
      if (!onGround && velY > 0.32 && this.aerialCfg.windBurstChainEnabled !== false) {
        this.fallDistance = 0;
        this.stage = 'AIRBORNE_INTERCEPT';
        this.stageTicks = 0;
        this.spearLaunchTicks = 2;
        return true;
      }

      // Priority 3: Opponent knocked into extended Spear sweet spot (3.05–4.5b) -> Spear Finisher!
      const spearSel = this._findSpear();
      if (
        spearSel &&
        this.windBurstBounceTicks >= 2 &&
        reachDist > reach &&
        reachDist <= spearReach + 0.35
      ) {
        this._equipHand(spearSel);
        this.stage = 'SPEAR_FINISHER';
        this.stageTicks = 0;
        return true;
      }

      if (onGround || this.windBurstBounceTicks >= 6) {
        this.windBurstChainCount = 0;
        this.stage = 'SWORD_RESTORE';
        return this._tickSwordRestore();
      }
      return true;
    }

    // -----------------------------------------------------------------------
    // Stage 5: SPEAR_FINISHER — 1-tick-settled 4.2b Spear reach punish after Mace knockback
    // -----------------------------------------------------------------------
    if (this.stage === 'SPEAR_FINISHER') {
      if (this.stageTicks > 8 || reachDist > spearReach + 1.2) {
        this.stage = 'SWORD_RESTORE';
        return this._tickSwordRestore();
      }

      const spearSel = this._findSpear();
      if (!spearSel) {
        this.stage = 'SWORD_RESTORE';
        return this._tickSwordRestore();
      }

      const eq = this._equipHand(spearSel);
      const aimStatus = this._aimAtTarget(target, 1, {
        speedMultiplier: 2.0,
        toleranceRad: 0.32,
        force: true
      });

      if (typeof this.bot.setControlState === 'function') {
        this.bot.setControlState('forward', reachDist > 2.8);
        this.bot.setControlState('back', false);
        this.bot.setControlState('sprint', reachDist > 3.0 && (this.bot.food === undefined || this.bot.food > 6));
        this.bot.setControlState('jump', false);
      }

      if (eq.ready && !eq.swapped && reachDist <= spearReach + 0.25 && (aimStatus.aligned || aimStatus.yawErrorDeg < 30)) {
        this.bot.attack(target);
        this.windBurstChainCount = 0;
        this.stage = 'SWORD_RESTORE';
        return true;
      }

      return true;
    }

    return false;
  }
};

module.exports = { spearMaceMethods };
