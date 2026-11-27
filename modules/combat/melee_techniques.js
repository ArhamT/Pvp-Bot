'use strict';

const { isSpearItem } = require('../constants');
const { hasClearRaySegment } = require('../placement_los');
const { executeAttributeSwapAttack } = require('../mace_elytra');

/**
 * High-Tier (HT1) Melee Techniques (`modules/combat/melee_techniques.js`):
 * - Exact 3D DDA wall-hit LOS check (`hasClearRaySegment`)
 * - Instant Axe Shield-Break (MC 1.9+ axes disable shields at ANY cooldown after 1-tick settle!)
 * - Real Falling Crit-Chaining (returns `{ preparingCrit, wantCritJump }` so jump is never overwritten)
 * - Anti-Crit Uppercuts (disrupts jumping opponents before their falling crit connects)
 * - Smart Hit-Select (only delays when entering a grounded trade, never ruins an active combo or crit!)
 * - LOS/Reach/Cooldown-safe Breach Swap
 */
const meleeTechniquesMethods = {
  _hasMeleeLineOfSight(target) {
    if (!this.bot || !this.bot.entity || !target || !target.position) return false;
    const eye = this.aimer ? this.aimer.getEyePosition() : this.bot.entity.position.offset(0, 1.62, 0);
    const h = target.height || 1.8;
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

    // Only hit-select when grounded, trading neutrally (not mid-combo), and enemy swung just outside/at reach
    const dist = this.getReachDistance(entity);
    const inActiveCombo = (now - this.lastAttackTime) < 620;
    if (!inActiveCombo && dist >= 2.55 && dist <= 3.35 && this.bot.entity.onGround && this.hitSelectDelayTicks <= 0) {
      this.hitSelectDelayTicks = 1;
    }
  },

  _handleEntityHurt(entity) {
    if (!entity || !this.bot || !this.bot.entity) return;
    if (this.activeTarget && entity.id === this.activeTarget.id) {
      const dist = this.getReachDistance(entity);
      if (dist <= 3.4 && (Date.now() - this.lastAttackTime) <= 220 && this.wTapTicksRemaining <= 0) {
        this._triggerSprintReset(dist);
      }
    }
  },

  /**
   * Returns `{ preparingCrit, wantCritJump }` so `movement_spacing` honors crit hops & early sprint-drop cleanly.
   */
  _shouldPrepareFallingCrit(target, reachDist, cooldownProgress, weaponRole = 'sword') {
    const none = { preparingCrit: false, wantCritJump: false };
    if (this.combatCfg.critEnabled === false || !this.bot || !this.bot.entity) return none;
    const minHp = this.combatCfg.critMinHealth !== undefined ? this.combatCfg.critMinHealth : 9;
    if (this.bot.health < minHp) return none;
    if (this.bot.entity.isInWater || this.bot.entity.isInLava) return none;
    if (reachDist > 3.35) return none;
    if (weaponRole === 'axe_shield_break') return none;
    if (this.isTargetRaisingShield(target) && this.isTargetFacingBot(target)) return none;

    const vy = this.bot.entity.velocity ? this.bot.entity.velocity.y : 0;
    const critVel = this.combatCfg.critFallVelocity !== undefined ? this.combatCfg.critFallVelocity : -0.08;

    // Already airborne near apex or falling -> drop sprint EARLY so server guarantees 1.5x crit!
    if (!this.bot.entity.onGround && vy <= 0.14 && cooldownProgress >= 0.68) {
      return { preparingCrit: true, wantCritJump: false };
    }

    // Initiate HT1 crit hop when punishing shield-stun, Axe kit, opponent eating/bowing/backpedaling, or HP lead
    const advHp = this.combatCfg.critHealthAdvantageMin !== undefined ? this.combatCfg.critHealthAdvantageMin : 12;
    const targetBackpedaling = Boolean(target && target.velocity &&
      ((target.velocity.x * (target.position.x - this.bot.entity.position.x) +
        target.velocity.z * (target.position.z - this.bot.entity.position.z)) > 0.03));
    const targetUsingItem = Boolean(target && (target.usingItem || (target.metadata && (Number(target.metadata[8] || 0) & 0x01))));
    const shieldJustBroken = Date.now() < this.targetShieldDisabledUntil;
    const isAxeMain = weaponRole === 'axe';

    if (
      this.bot.entity.onGround &&
      cooldownProgress >= (isAxeMain ? 0.65 : 0.72) &&
      reachDist <= 3.0 &&
      (isAxeMain || this.bot.health >= advHp || shieldJustBroken || targetBackpedaling || targetUsingItem)
    ) {
      return { preparingCrit: true, wantCritJump: true };
    }

    if (!this.bot.entity.onGround && vy <= critVel) {
      return { preparingCrit: true, wantCritJump: false };
    }
    return none;
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

    // 1. INSTANT Axe Shield-Break: MC 1.9+ axes disable raised shields at ANY cooldown!
    // Only enforce 1-tick post-swap settle (>= 45ms since slot switch) for anti-cheat safety!
    if (weaponRole === 'axe_shield_break') {
      const heldName = (this.bot.heldItem && this.bot.heldItem.name) || '';
      if (!heldName.endsWith('_axe')) return false;
      if ((now - this.lastSwapOrAttackTime) < 45) return false;
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

    const minRatio = weaponRole === 'axe'
      ? (this.combatCfg.axeCritCooldownRatio !== undefined ? Math.min(0.96, this.combatCfg.axeCritCooldownRatio) : 0.95)
      : (this.combatCfg.minCooldownRatio !== undefined ? this.combatCfg.minCooldownRatio : 0.92);

    const vy = this.bot.entity.velocity ? this.bot.entity.velocity.y : 0;
    const critVel = this.combatCfg.critFallVelocity !== undefined ? this.combatCfg.critFallVelocity : -0.08;
    const isFallingCrit = !this.bot.entity.onGround && vy <= critVel && !this.bot.entity.isInWater && !this.bot.entity.isInLava;
    const targetJumping = Boolean(target.velocity && target.velocity.y > 0.14 && !target.onGround);

    // 2. Hit-Select delay window (never delay an anti-crit uppercut or falling crit!)
    if (this.hitSelectDelayTicks > 0 && !targetJumping && !isFallingCrit) {
      this.hitSelectDelayTicks--;
      return false;
    }

    // 3. Apex Crit Rollover: if airborne just above critVel (1-2 ticks from falling crit), hold swing 1 tick for 1.5x damage!
    if (
      !this.bot.entity.onGround &&
      vy > critVel &&
      vy <= 0.16 &&
      cooldown >= minRatio &&
      reachDist <= 2.95 &&
      !targetJumping
    ) {
      if (typeof this.bot.setControlState === 'function') {
        this.bot.setControlState('sprint', false);
      }
      return false;
    }

    if (cooldown < minRatio) return false;

    // 4. Optional Breach Swap against heavily armored opponents (respects LOS, reach, cooldown, and config)
    const slots = this.getHotbarSlots();
    if (
      this.combatCfg.enableBreachSwap !== false &&
      slots.breachMaceSlot >= 0 &&
      slots.swordSlot >= 0 &&
      weaponRole === 'sword' &&
      reachDist <= vanillaReach &&
      this.isTargetHeavilyArmored(target) &&
      !this.combatCfg.durabilityDrainMode &&
      this.combatCfg.sameTickAttributeSwap === true
    ) {
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

    // 5. High-Tier Sword / Axe / Spear / Falling-Crit Strike
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
