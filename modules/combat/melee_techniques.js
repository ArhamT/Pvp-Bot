'use strict';

const { isSpearItem } = require('../constants');
const { hasClearRaySegment } = require('../placement_los');
const { executeAttributeSwapAttack } = require('../mace_elytra');

/**
 * High-tier Melee Techniques (`modules/combat/melee_techniques.js`):
 * - Exact 3D DDA wall-hit LOS check (`hasClearRaySegment`, fixing broken `this.ranged` ref!)
 * - Early sprint-drop Falling Crits (drops sprint 1 tick before apex so server registers real crit!)
 * - Anti-Crit Uppercuts (disrupts jumping opponents before their falling crit connects)
 * - Proactive Hit-Selecting (tracks opponent swings + prunes Map to eliminate memory leak)
 * - Facing-aware Axe Shield-Break & Cooldown/LOS-safe Breach Swap
 */
const meleeTechniquesMethods = {
  _hasMeleeLineOfSight(target) {
    if (!this.bot || !this.bot.entity || !target || !target.position) return false;
    const eye = this.aimer ? this.aimer.getEyePosition() : this.bot.entity.position.offset(0, 1.62, 0);
    const h = target.height || 1.8;
    // Check torso and upper chest points so partial cover (slabs/fences) doesn't false-block
    return hasClearRaySegment(this.bot, eye, target.position.offset(0, h * 0.68, 0)) ||
      hasClearRaySegment(this.bot, eye, target.position.offset(0, h * 0.35, 0));
  },

  _pruneSwingHistory(now = Date.now()) {
    if (this.lastSwingByEntityId.size <= 32) return;
    for (const [id, ts] of this.lastSwingByEntityId.entries()) {
      if ((now - ts) > 15000) this.lastSwingByEntityId.delete(id);
    }
  },

  _handleEntitySwingArm(entity) {
    if (!entity || !this.bot || !this.bot.entity || entity.id === this.bot.entity.id) return;
    const now = Date.now();
    this.lastSwingByEntityId.set(entity.id, now);
    this._pruneSwingHistory(now);

    if (this.combatCfg.enableHitSelect === false) return;
    if (!this.activeTarget || entity.id !== this.activeTarget.id) return;

    const dist = this.getReachDistance(entity);
    if (dist <= 3.6 && this.bot.entity.onGround && this.hitSelectDelayTicks <= 0) {
      const minT = this.combatCfg.hitSelectDelayMinTicks || 1;
      const maxT = this.combatCfg.hitSelectDelayMaxTicks || 2;
      this.hitSelectDelayTicks = minT + (maxT > minT ? Math.floor(Math.random() * (maxT - minT + 1)) : 0);
    }
  },

  _handleEntityHurt(entity) {
    if (!entity || !this.bot || !this.bot.entity) return;
    // When our target takes hurt ticks while close, reinforce sprint-reset timing
    if (this.activeTarget && entity.id === this.activeTarget.id) {
      const dist = this.getReachDistance(entity);
      if (dist <= 3.4 && (Date.now() - this.lastAttackTime) <= 220 && this.wTapTicksRemaining <= 0) {
        this._triggerSprintReset(dist);
      }
    }
  },

  _shouldPrepareFallingCrit(target, reachDist, cooldownProgress) {
    if (this.combatCfg.critEnabled === false || !this.bot || !this.bot.entity) return false;
    const minHp = this.combatCfg.critMinHealth !== undefined ? this.combatCfg.critMinHealth : 9;
    if (this.bot.health < minHp) return false;
    if (this.bot.entity.isInWater || this.bot.entity.isInLava) return false;
    if (reachDist > 3.25) return false;
    if (this.isTargetRaisingShield(target) && this.isTargetFacingBot(target)) return false;

    const vy = this.bot.entity.velocity ? this.bot.entity.velocity.y : 0;
    const critVel = this.combatCfg.critFallVelocity !== undefined ? this.combatCfg.critFallVelocity : -0.08;
    // Already airborne near apex or falling -> drop sprint EARLY (1 tick before swing!)
    if (!this.bot.entity.onGround && vy <= 0.10 && cooldownProgress >= 0.72) {
      return true;
    }
    // Initiate crit hop when opponent is stunned/slow or we have healthy HP advantage
    const advHp = this.combatCfg.critHealthAdvantageMin !== undefined ? this.combatCfg.critHealthAdvantageMin : 13;
    const targetBackpedaling = target && target.velocity &&
      ((target.velocity.x * (target.position.x - this.bot.entity.position.x) +
        target.velocity.z * (target.position.z - this.bot.entity.position.z)) > 0.04);
    const shieldJustBroken = Date.now() < this.targetShieldDisabledUntil;
    if (
      this.bot.entity.onGround &&
      cooldownProgress >= 0.78 &&
      reachDist <= 2.95 &&
      (this.bot.health >= advHp || shieldJustBroken || targetBackpedaling)
    ) {
      if (typeof this.bot.setControlState === 'function') {
        this.bot.setControlState('sprint', false);
        this.bot.setControlState('jump', true);
      }
      return true;
    }
    return !this.bot.entity.onGround && vy <= critVel;
  },

  _updateAttackAndCrits(target, reachDist, weaponRole, aimAligned) {
    if (!this.bot || !this.bot.entity || !target || !target.isValid) return false;
    if (!aimAligned) return false;

    const now = Date.now();
    const vanillaReach = this.combatCfg.reach || 3.0;
    const spearReach = this.combatCfg.spearReach || 4.1;
    const holdingSpear = isSpearItem(this.bot.heldItem);
    const effectiveReach = holdingSpear ? spearReach : vanillaReach;

    if (reachDist > effectiveReach) return false;
    if (!this._hasMeleeLineOfSight(target)) return false;

    const cooldown = this.getCooldownProgress();
    const minRatio = weaponRole === 'axe_shield_break'
      ? (this.combatCfg.axeCritCooldownRatio || 1.0)
      : (this.combatCfg.minCooldownRatio !== undefined ? this.combatCfg.minCooldownRatio : 0.93);

    // 1. Hit-Select delay window (skip if opponent is jumping — deliver instant anti-crit uppercut instead!)
    const targetJumping = target.velocity && target.velocity.y > 0.16 && !target.onGround;
    if (this.hitSelectDelayTicks > 0 && !targetJumping && weaponRole !== 'axe_shield_break') {
      this.hitSelectDelayTicks--;
      return false;
    }

    // 2. If airborne and falling into a crit, wait until vy <= critFallVelocity if we're right at apex
    const vy = this.bot.entity.velocity ? this.bot.entity.velocity.y : 0;
    const critVel = this.combatCfg.critFallVelocity !== undefined ? this.combatCfg.critFallVelocity : -0.08;
    const isFallingCrit = !this.bot.entity.onGround && vy <= critVel && !this.bot.entity.isInWater && !this.bot.entity.isInLava;
    if (
      !this.bot.entity.onGround &&
      vy > critVel &&
      vy <= 0.14 &&
      cooldown >= minRatio &&
      reachDist <= 2.9 &&
      weaponRole !== 'axe_shield_break' &&
      !targetJumping
    ) {
      // Wait 1–2 ticks for apex rollover so our swing lands as a 1.5x Critical Hit
      if (typeof this.bot.setControlState === 'function') {
        this.bot.setControlState('sprint', false);
      }
      return false;
    }

    if (cooldown < minRatio) return false;

    // 3. Axe Shield-Break swing
    if (weaponRole === 'axe_shield_break') {
      if (typeof this.bot.attack === 'function') {
        this.bot.attack(target);
        this._recordAttackSwing(now);
        const disableMs = this.combatCfg.shieldDisableDurationMs || 5000;
        this.targetShieldDisabledUntil = now + disableMs;
        this._triggerSprintReset(reachDist);
        return true;
      }
      return false;
    }

    // 4. Optional Breach Swap against heavily armored opponents (strictly respects LOS, reach, cooldown, and config)
    const slots = this.getHotbarSlots();
    if (
      this.combatCfg.enableBreachSwap !== false &&
      slots.breachMaceSlot >= 0 &&
      slots.swordSlot >= 0 &&
      weaponRole === 'sword' &&
      reachDist <= vanillaReach &&
      this.isTargetHeavilyArmored(target) &&
      !this.combatCfg.durabilityDrainMode
    ) {
      if (this.combatCfg.sameTickAttributeSwap === true) {
        const swordSel = { hotbarIndex: slots.swordSlot };
        const breachSel = { hotbarIndex: slots.breachMaceSlot };
        executeAttributeSwapAttack(this.bot, target, swordSel, breachSel, {
          durabilityDrainMode: false,
          sameTickAttributeSwap: true
        });
        this._recordAttackSwing(now);
        this._triggerSprintReset(reachDist);
        return true;
      }
    }

    // 5. Standard high-tier Sword / Axe / Spear / Crit strike
    if (isFallingCrit && typeof this.bot.setControlState === 'function') {
      this.bot.setControlState('sprint', false);
    }
    if (typeof this.bot.attack === 'function') {
      this.bot.attack(target);
      this._recordAttackSwing(now);
      if (!isFallingCrit) {
        this._triggerSprintReset(reachDist);
      }
      return true;
    }
    return false;
  }
};

module.exports = { meleeTechniquesMethods };
