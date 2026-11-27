'use strict';

const { normalizeAngle } = require('../aim');
const {
  OFFHAND_SLOT,
  HOTBAR_START,
  clearMovementControls,
  getItemMetadataText
} = require('../constants');
const {
  buildTargetState,
  detectIncomingMaceAttack
} = require('../mace_elytra');

const totemShieldMethods = {
  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },

  _sleepTotemPause(ms) {
    return new Promise((resolve) => {
      if (ms <= 0) {
        resolve();
        return;
      }
      this._totemPauseResolve = resolve;
      this._totemPauseTimer = setTimeout(() => {
        this._totemPauseTimer = null;
        const done = this._totemPauseResolve;
        this._totemPauseResolve = null;
        if (done) done();
      }, ms);
    });
  },

  _cancelPendingTotemTimers() {
    if (this.totemDelayTimer) {
      clearTimeout(this.totemDelayTimer);
      this.totemDelayTimer = null;
    }
    if (this._totemDelayResolve) {
      const resolve = this._totemDelayResolve;
      this._totemDelayResolve = null;
      resolve();
    }
    if (this._totemPauseTimer) {
      clearTimeout(this._totemPauseTimer);
      this._totemPauseTimer = null;
    }
    if (this._totemPauseResolve) {
      const resolve = this._totemPauseResolve;
      this._totemPauseResolve = null;
      resolve();
    }
    this.totemSwapPending = false;
    this._totemMovementPaused = false;
    if (!this.totemEquipInFlight) {
      this.totemEquipPromise = null;
    }
  },

  _pauseMovementForTotemSwap() {
    clearMovementControls(this.bot);
  },

  _isHotbarSlot(slot) {
    if (typeof slot !== 'number') return false;
    const hotbarStart = (this.bot && this.bot.inventory && this.bot.inventory.hotbarStart) || HOTBAR_START;
    return slot >= hotbarStart && slot < hotbarStart + 9;
  },

  /**
   * Inventory slot listener: if offhand slot 45 loses its Totem during combat,
   * schedule a human-paced replacement swap (never 0ms instant click).
   */
  _handleUpdateSlot(slot, _oldItem, newItem) {
    if (!this.activeInCombat || this._disposed) return;
    const offhandSlot = this._getOffhandSlotIndex();
    if (slot === offhandSlot && (!newItem || newItem.name !== 'totem_of_undying')) {
      this.ensureTotemPriority();
    }
  },

  /**
   * Health change hook: schedule a human-paced offhand Totem check on damage/pop during combat.
   */
  _handleHealth() {
    if (!this.activeInCombat || this._disposed) return;
    this.ensureTotemPriority();
  },

  /**
   * Totem pop hook (entityStatus === 35): immediately trigger priority off-hand replenish
   * before any crystal or anchor placement is allowed to proceed.
   */
  _handleTotemPop() {
    if (!this.activeInCombat || this._disposed) return;
    this.totemPopReplenishPending = true;
    this.totemPoppedAt = Date.now();
    this.totemRetryBackoffMs = 0;
    if (this.totemDelayTimer) {
      this._cancelPendingTotemTimers();
    }
    this.ensureTotemPriority({ immediate: true });
  },

  _getOffhandSlotIndex() {
    if (this.bot && typeof this.bot.getEquipmentDestSlot === 'function') {
      return this.bot.getEquipmentDestSlot('off-hand');
    }
    return OFFHAND_SLOT;
  },

  /**
   * Returns the item currently in offhand (slot 45).
   */
  getOffhandItem() {
    if (!this.bot || !this.bot.inventory || !this.bot.inventory.slots) return null;
    return this.bot.inventory.slots[this._getOffhandSlotIndex()] || null;
  },

  /**
   * Finds a Totem of Undying anywhere in inventory outside the offhand slot (preferring hotbar).
   */
  findTotemInInventory() {
    if (!this.bot || !this.bot.inventory) return null;
    const offhandSlot = this._getOffhandSlotIndex();
    const items = this.bot.inventory.items();
    const hotbarTotem = items.find(
      (item) => item && item.name === 'totem_of_undying' && item.slot !== offhandSlot && this._isHotbarSlot(item.slot)
    );
    if (hotbarTotem) return hotbarTotem;
    return items.find(
      (item) => item && item.name === 'totem_of_undying' && item.slot !== offhandSlot
    ) || null;
  },

  /**
   * Returns true if offhand (slot 45) lacks a Totem AND one is available in inventory.
   */
  needsTotemSwap() {
    if (!this.survCfg.totemAutoEquip) return false;
    const offhand = this.getOffhandItem();
    if (offhand && offhand.name === 'totem_of_undying') return false;
    return Boolean(this.findTotemInInventory());
  },

  /**
   * Executes the actual offhand Totem swap after the human-like reaction delay expires.
   * For main-inventory totems (slots 9–35), pauses movement controls briefly (`totemPauseMovementMs`)
   * before sending the `window_click` packet to prevent InventoryMove / AutoTotemA flags.
   */
  async _executeTotemSwap() {
    if (this._disposed || !this.activeInCombat || !this.survCfg.totemAutoEquip || !this.bot || !this.bot.inventory) {
      return;
    }
    if (this.totemEquipInFlight) return;

    const offhand = this.getOffhandItem();
    if (offhand && offhand.name === 'totem_of_undying') {
      this.totemRetryBackoffMs = 0;
      return;
    }

    const initialTotem = this.findTotemInInventory();
    if (!initialTotem) return;

    this.totemSwapPending = true;
    this.totemEquipInFlight = true;
    this.lastTotemAttemptAt = Date.now();

    try {
      const isMainInventory = !this._isHotbarSlot(initialTotem.slot);
      if (isMainInventory) {
        const pauseMs = (typeof this.survCfg.totemPauseMovementMs === 'number' && this.survCfg.totemPauseMovementMs >= 0)
          ? this.survCfg.totemPauseMovementMs
          : 70;
        this._totemMovementPaused = true;
        this._pauseMovementForTotemSwap();
        if (pauseMs > 0) {
          await this._sleepTotemPause(pauseMs);
        }
        if (this._disposed || !this.activeInCombat || !this.bot || !this.bot.inventory) {
          return;
        }
      }

      const offhandNow = this.getOffhandItem();
      if (offhandNow && offhandNow.name === 'totem_of_undying') {
        this.totemRetryBackoffMs = 0;
        return;
      }

      const freshTotem = this.findTotemInInventory();
      if (!freshTotem) return;

      // If the fresh totem is now in main inventory (e.g. hotbar changed during delay) and we haven't paused yet
      if (!this._isHotbarSlot(freshTotem.slot) && !this._totemMovementPaused) {
        const pauseMs = (typeof this.survCfg.totemPauseMovementMs === 'number' && this.survCfg.totemPauseMovementMs >= 0)
          ? this.survCfg.totemPauseMovementMs
          : 70;
        this._totemMovementPaused = true;
        this._pauseMovementForTotemSwap();
        if (pauseMs > 0) {
          await this._sleepTotemPause(pauseMs);
        }
        if (this._disposed || !this.activeInCombat || !this.bot || !this.bot.inventory) {
          return;
        }
      }

      if (this._totemMovementPaused) {
        this._pauseMovementForTotemSwap();
      }

      const targetTotem = this.findTotemInInventory();
      if (!targetTotem) return;

      await Promise.resolve(this.bot.equip(targetTotem, 'off-hand'));

      const after = this.getOffhandItem();
      if (after && after.name === 'totem_of_undying') {
        this.totemPopReplenishPending = false;
        this.totemRetryBackoffMs = 0;
      } else {
        // Server reverted or rejected the click (e.g. locked inventory) -> back off to prevent packet kicks
        this.lastTotemAttemptAt = Date.now();
        this.totemRetryBackoffMs = Math.min(2500, Math.max(300, (this.totemRetryBackoffMs || 150) * 2));
      }
    } catch (_) {
      this.lastTotemAttemptAt = Date.now();
      this.totemRetryBackoffMs = Math.min(2500, Math.max(300, (this.totemRetryBackoffMs || 150) * 2));
    } finally {
      this.totemEquipInFlight = false;
      this.totemSwapPending = false;
      this._totemMovementPaused = false;
    }
  },

  /**
   * HIGHEST PRIORITY: Schedules a human-paced Totem of Undying re-equip to offhand (slot 45).
   * Non-blocking and strictly deduplicated (never queues duplicate timers or 0ms instant clicks unless totemPopDelayMs === 0).
   * Returns true whenever off-hand lacks a totem and a replenish swap is pending or in-flight, blocking offensive actions.
   */
  ensureTotemPriority(opts = {}) {
    if (this._disposed || !this.activeInCombat || !this.survCfg.totemAutoEquip || !this.bot || !this.bot.inventory) {
      return false;
    }

    const offhand = this.getOffhandItem();
    if (offhand && offhand.name === 'totem_of_undying') {
      this.totemPopReplenishPending = false;
      this.totemRetryBackoffMs = 0;
      this._cancelPendingTotemTimers();
      return false;
    }

    if (this.totemSwapPending || this.totemEquipInFlight) {
      if (this._totemMovementPaused) {
        this._pauseMovementForTotemSwap();
      }
      return true;
    }

    const totem = this.findTotemInInventory();
    if (!totem) {
      this.totemPopReplenishPending = false;
      this._cancelPendingTotemTimers();
      return false;
    }

    // Already waiting on the reaction delay timer — block offensive placements until slot 45 is replenished
    if (this.totemDelayTimer) {
      return true;
    }

    const now = Date.now();
    if (!opts.immediate && !this.totemPopReplenishPending && this.totemRetryBackoffMs > 0 && (now - this.lastTotemAttemptAt) < this.totemRetryBackoffMs) {
      return false;
    }

    let delayMs;
    if (opts.immediate || this.totemPopReplenishPending) {
      delayMs = (typeof this.survCfg.totemPopDelayMs === 'number' && this.survCfg.totemPopDelayMs >= 0)
        ? this.survCfg.totemPopDelayMs
        : 50;
    } else {
      const minDelayMs = (typeof this.survCfg.totemEquipDelayMinMs === 'number' && this.survCfg.totemEquipDelayMinMs >= 0)
        ? this.survCfg.totemEquipDelayMinMs
        : 50;
      const maxDelayRaw = (typeof this.survCfg.totemEquipDelayMaxMs === 'number' && this.survCfg.totemEquipDelayMaxMs >= 0)
        ? this.survCfg.totemEquipDelayMaxMs
        : 100;
      const maxDelayMs = Math.max(minDelayMs, maxDelayRaw);
      delayMs = minDelayMs + Math.floor(Math.random() * (maxDelayMs - minDelayMs + 1));
    }

    if (delayMs === 0) {
      this.totemEquipPromise = this._executeTotemSwap()
        .catch(() => {})
        .finally(() => {
          if (!this.totemDelayTimer && !this.totemEquipInFlight) {
            this.totemEquipPromise = null;
          }
        });
      return true;
    }

    this.totemEquipPromise = new Promise((resolve) => {
      this._totemDelayResolve = resolve;
      this.totemDelayTimer = setTimeout(() => {
        this.totemDelayTimer = null;
        const finish = this._totemDelayResolve;
        this._totemDelayResolve = null;

        this._executeTotemSwap()
          .catch(() => {})
          .finally(() => {
            if (!this.totemDelayTimer && !this.totemEquipInFlight) {
              this.totemEquipPromise = null;
            }
            if (finish) finish();
          });
      }, delayMs);
    });

    return true;
  },

  /**
   * Ensures offhand safety every tick during active combat:
   * - Priority 1: Totem of Undying in slot 45 (human-paced reaction + anti-InventoryMove pause)
   * - Priority 2: Shield in slot 45 ONLY when grounded or opponent is out of totems
   * Returns true while an emergency totem movement-pause/equip swap is actively in progress.
   */
  ensureOffhandSafety(target = null) {
    if (!this.activeInCombat || this._disposed) return false;
    if (this.ensureTotemPriority()) return true;

    // Do not fall through to shield equip if a totem swap is already scheduled or in locked-inventory backoff
    if (this.totemDelayTimer || this.totemSwapPending || this.totemEquipInFlight) {
      return Boolean(this.totemSwapPending || this.totemEquipInFlight);
    }
    if (this.totemRetryBackoffMs > 0 && this.findTotemInInventory()) {
      return false;
    }

    if (this.equipBusy || this.sortingInProgress || !this.bot || !this.bot.inventory) {
      return false;
    }

    const offhand = this.getOffhandItem();
    if (offhand && offhand.name === 'totem_of_undying') return false;

    if (this.survCfg.shieldEnabled) {
      const isGrounded = Boolean(this.bot.entity && this.bot.entity.onGround && !this.bot.entity.elytraFlying);
      const targetHasTotem = Boolean(
        target &&
        Array.isArray(target.equipment) &&
        target.equipment.some((e) => e && e.name === 'totem_of_undying')
      );
      const hasInventoryTotem = Boolean(this.findTotemInInventory());
      const incomingMaceDive = Boolean(
        !hasInventoryTotem &&
        target &&
        target.isValid &&
        detectIncomingMaceAttack(this.bot, target).shouldShield
      );
      if (!isGrounded && targetHasTotem && !incomingMaceDive) {
        return false;
      }

      if (offhand && offhand.name === 'shield') {
        this.offhandRetryBackoffMs = 0;
        return false;
      }
      const now = Date.now();
      if (this.offhandRetryBackoffMs > 0 && (now - this.lastOffhandAttemptAt) < this.offhandRetryBackoffMs) {
        return false;
      }
      const shield = this.bot.inventory.items().find((i) => i.name === 'shield');
      if (shield) {
        this.lastOffhandAttemptAt = now;
        this._equipSafe(shield, 'off-hand').then((ok) => {
          const after = this.getOffhandItem();
          if (ok && after && after.name === 'shield') {
            this.offhandRetryBackoffMs = 0;
          } else {
            this.offhandRetryBackoffMs = Math.min(3000, Math.max(400, (this.offhandRetryBackoffMs || 200) * 2));
          }
        });
      }
    }
    return false;
  },

  /**
   * Detects whether an enemy is actively drawing a bow or aiming a crossbow within 12 blocks.
   */
  isEnemyDrawingBow(target) {
    if (!target || !target.isValid || !this.bot.entity) return false;
    const dist = this.bot.entity.position.distanceTo(target.position);
    if (dist > (this.survCfg.shieldBowDetectRange || 12.0)) return false;

    const equipment = target.equipment || [];
    const mainHand = equipment[0] || null;
    const offHand = equipment[1] || null;

    const holdingBow = (mainHand && (mainHand.name === 'bow' || mainHand.name === 'crossbow')) ||
      (offHand && (offHand.name === 'bow' || offHand.name === 'crossbow'));
    if (!holdingBow) return false;

    const handFlags = target.metadata && target.metadata[8];
    const isDrawing = (typeof handFlags === 'number' && (handFlags & 0x01) !== 0) ||
      Boolean(target.usingHeldItem || target.isUsingItem);

    // Also treat a charged crossbow aimed at us (facing within ~40 deg) as an immediate ranged threat
    const toBot = this.bot.entity.position.minus(target.position);
    const horizLen = Math.sqrt(toBot.x * toBot.x + toBot.z * toBot.z);
    let aimingAtBot = true;
    if (typeof target.yaw === 'number' && horizLen > 0.1) {
      const yawToBot = Math.atan2(-toBot.x, -toBot.z);
      aimingAtBot = Math.abs(normalizeAngle(target.yaw - yawToBot)) <= 0.7;
    }

    const chargedCrossbow = aimingAtBot && [mainHand, offHand].some((item) => {
      if (!item || item.name !== 'crossbow') return false;
      const raw = getItemMetadataText(item);
      return raw.includes('charged') && (raw.includes('arrow') || raw.includes('firework'));
    });

    return isDrawing || chargedCrossbow;
  },

  /**
   * Detects whether an enemy is rushing with a sword or axe within close melee range.
   */
  isEnemyRushingMelee(target) {
    if (!target || !target.isValid || !this.bot.entity) return false;
    const dist = this.bot.entity.position.distanceTo(target.position);
    if (dist > (this.survCfg.shieldRushDetectRange || 4.5)) return false;

    const mainHand = target.equipment && target.equipment[0];
    if (!mainHand || !mainHand.name) return false;

    const isMeleeWeapon = mainHand.name.endsWith('_sword') || mainHand.name.endsWith('_axe');
    if (!isMeleeWeapon) return false;

    // Check if enemy is facing toward us or moving toward us
    const toBot = this.bot.entity.position.minus(target.position);
    const horizLen = Math.sqrt(toBot.x * toBot.x + toBot.z * toBot.z);
    let closingIn = false;
    if (horizLen > 0.1 && target.velocity) {
      const radial = (target.velocity.x * toBot.x + target.velocity.z * toBot.z) / horizLen;
      closingIn = radial > 0.02;
    }

    let facingBot = true;
    if (typeof target.yaw === 'number' && horizLen > 0.1) {
      const yawToBot = Math.atan2(-toBot.x, -toBot.z);
      facingBot = Math.abs(normalizeAngle(target.yaw - yawToBot)) < (Math.PI * 0.45);
    }

    return closingIn || facingBot;
  },

  /**
   * Smart shield controller:
   * Raises offhand shield (`bot.activateItem(true)`) if:
   * - Enemy draws a bow within 12 blocks, OR
   * - Enemy rushes with an axe/sword while our weapon is on cooldown (`weaponCooldownProgress < 0.88`).
   * Returns true while actively blocking so melee combat does not swing concurrently.
   */
  _findHotbarShield() {
    if (!this.bot || !this.bot.inventory || !Array.isArray(this.bot.inventory.slots)) return null;
    const hotbarStart = this.bot.inventory.hotbarStart || HOTBAR_START;
    for (let idx = 0; idx < 9; idx++) {
      const item = this.bot.inventory.slots[hotbarStart + idx];
      if (item && item.name === 'shield') {
        return { item, hotbarIndex: idx };
      }
    }
    return null;
  },

  /**
   * Smart shield controller:
   * - Raises offhand shield (`activateItem(true)`) OR main-hand hotbar shield (`activateItem(false)`)
   *   without ever dropping offhand Totem of Undying on incoming Mace smashes!
   * - Pre-raises shield for Mace dive smashes, Wind Burst bounces, & grounded Breach swaps.
   * - Drops & sidesteps Axe Stun-Slam dive baits, and instantly drops post-impact for counter-punish.
   * - Raises offhand shield against drawn bows (<12b) or melee rushes while on cooldown.
   */
  tickShield(target, weaponCooldownProgress = 1.0) {
    if (!this.survCfg.shieldEnabled || this.totemEquipInFlight || this.totemSwapPending) {
      this.maceAntiStunActive = false;
      this.maceShieldThreat = null;
      this.lowerShield();
      return false;
    }

    if (!target || !target.isValid || this.isConsuming || (this.bot.entity && this.bot.entity.elytraFlying)) {
      this.maceAntiStunActive = false;
      this.maceShieldThreat = null;
      this.lowerShield();
      return false;
    }

    const maceThreat = detectIncomingMaceAttack(
      this.bot,
      target,
      buildTargetState(target),
      weaponCooldownProgress
    );
    this.maceShieldThreat = maceThreat;
    this.maceAntiStunActive = Boolean(maceThreat.antiStunBait);

    const offhand = this.getOffhandItem();
    const hasOffhandShield = Boolean(offhand && offhand.name === 'shield');
    const hotbarShield = !hasOffhandShield && (maceThreat.shouldShield || (this.isShielding && this.shieldHand === 'main-hand'))
      ? this._findHotbarShield()
      : null;

    if (!hasOffhandShield && !hotbarShield) {
      this.lowerShield();
      return false;
    }

    const bowThreat = hasOffhandShield ? this.isEnemyDrawingBow(target) : false;
    const weaponOnCooldown = weaponCooldownProgress < 0.88;
    const rushThreat = hasOffhandShield ? (weaponOnCooldown && this.isEnemyRushingMelee(target)) : false;
    const shouldRaise = Boolean(maceThreat.shouldShield || bowThreat || rushThreat);

    const now = Date.now();

    if (this.isShielding) {
      this.shieldTicksRemaining--;
      this.shieldHoldTicks++;
      // Never sprint while shielding (prevents NoSlow flags)
      this.bot.setControlState('sprint', false);

      // Axe Stun-Slam bait -> release block immediately without cooldown or slot swap so we can snap block in 1 tick on Mace swap
      if (maceThreat.antiStunBait) {
        if (this.shieldHand === 'main-hand') {
          try { this.bot.deactivateItem(); } catch (_) {}
          this.isShielding = false;
          this.shieldTicksRemaining = 0;
          this.shieldHoldTicks = 0;
          if (this.bot && typeof this.bot.setControlState === 'function') {
            this.bot.setControlState('back', false);
          }
        } else {
          this.lowerShield();
        }
        return false;
      }

      if (this.shieldingForMace) {
        // Step back slightly if diving opponent tries to pass overhead (prevents backstab)
        if (maceThreat.horizDist < 2.2) {
          this.bot.setControlState('back', true);
        } else {
          this.bot.setControlState('back', false);
        }

        if (maceThreat.shouldShield && this.shieldHoldTicks < 28) {
          this.shieldTicksRemaining = Math.max(this.shieldTicksRemaining, 6);
          return true;
        }

        // Drop immediately once smash completes / enemy lands for zero-delay counter-punish
        if (maceThreat.postImpactWindow || this.shieldHoldTicks >= 28 || (!shouldRaise && this.shieldTicksRemaining <= 8) || this.shieldTicksRemaining <= 0) {
          this.lowerShield();
          this.lastMaceShieldEndTime = now;
          this.lastShieldEndTime = now;
          return false;
        }
        return true;
      }

      // Drop shield once standard threat ends, our weapon is ready (for melee rush), or timer elapses
      const rushFinished = !bowThreat && weaponCooldownProgress >= 0.90;
      if ((!shouldRaise && this.shieldTicksRemaining <= 6) || rushFinished || this.shieldTicksRemaining <= 0) {
        this.lowerShield();
        this.lastShieldEndTime = now;
        return false;
      }
      return true;
    }

    if (maceThreat.antiStunBait) {
      this.pendingMainhandShieldSlot = -1;
      return false;
    }

    if (maceThreat.shouldShield) {
      const maceCooldownMs = this.survCfg.maceShieldCooldownMs !== undefined ? this.survCfg.maceShieldCooldownMs : 150;
      if ((now - this.lastMaceShieldEndTime) < maceCooldownMs) {
        return false;
      }

      this.bot.setControlState('sprint', false);
      if (hasOffhandShield) {
        this.pendingMainhandShieldSlot = -1;
        this.shieldHand = 'off-hand';
        this.bot.activateItem(true); // Offhand shield raise
      } else if (hotbarShield) {
        // 1-tick anti-cheat safe hotbar switch into mainhand shield (preserves offhand Totem!)
        if (this.bot.quickBarSlot !== hotbarShield.hotbarIndex && typeof this.bot.setQuickBarSlot === 'function') {
          if (this.prevShieldHotbarSlot < 0) {
            this.prevShieldHotbarSlot = typeof this.bot.quickBarSlot === 'number' ? this.bot.quickBarSlot : 0;
          }
          this.pendingMainhandShieldSlot = hotbarShield.hotbarIndex;
          this.bot.setQuickBarSlot(hotbarShield.hotbarIndex);
          return true;
        }
        this.pendingMainhandShieldSlot = -1;
        this.shieldHand = 'main-hand';
        this.bot.activateItem(false); // Mainhand shield raise
      }

      this.isShielding = true;
      this.shieldingForMace = true;
      this.shieldHoldTicks = 0;
      this.shieldTicksRemaining = this.survCfg.maceShieldDurationTicks || 18;
      if (maceThreat.horizDist < 2.2) {
        this.bot.setControlState('back', true);
      }
      return true;
    }

    this.pendingMainhandShieldSlot = -1;
    const cooldownMs = this.survCfg.shieldCooldownMs || 1200;
    const bowCooldownMs = Math.min(cooldownMs, 650);
    if (shouldRaise && (now - this.lastShieldEndTime) >= (bowThreat ? bowCooldownMs : cooldownMs)) {
      this.bot.setControlState('sprint', false);
      this.shieldHand = 'off-hand';
      this.shieldingForMace = false;
      this.shieldHoldTicks = 0;
      this.bot.activateItem(true); // Offhand shield raise
      this.isShielding = true;
      this.shieldTicksRemaining = this.survCfg.shieldBlockDurationTicks || 12;
      return true;
    }

    return false;
  },

  lowerShield() {
    if (this.isShielding) {
      try { this.bot.deactivateItem(); } catch (_) {}
      this.isShielding = false;
      this.shieldTicksRemaining = 0;
      this.shieldHoldTicks = 0;
    }
    if (this.shieldHand === 'main-hand' && this.prevShieldHotbarSlot >= 0 && typeof this.bot.setQuickBarSlot === 'function') {
      if (this.bot.quickBarSlot !== this.prevShieldHotbarSlot) {
        this.bot.setQuickBarSlot(this.prevShieldHotbarSlot);
      }
    } else if (this.pendingMainhandShieldSlot >= 0 && this.prevShieldHotbarSlot >= 0 && typeof this.bot.setQuickBarSlot === 'function') {
      if (this.bot.quickBarSlot !== this.prevShieldHotbarSlot) {
        this.bot.setQuickBarSlot(this.prevShieldHotbarSlot);
      }
    }
    this.shieldHand = 'off-hand';
    this.shieldingForMace = false;
    this.prevShieldHotbarSlot = -1;
    this.pendingMainhandShieldSlot = -1;
    if (this.bot && typeof this.bot.setControlState === 'function') {
      this.bot.setControlState('back', false);
    }
  }
};

module.exports = { totemShieldMethods };
