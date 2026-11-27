'use strict';

const { SWORD_PRIORITY, AXE_PRIORITY } = require('../constants');
const { getHotbarStart, isSlotInHotbar, findInventoryItem, ensureItemHeld } = require('../inventory_utils');

const WEAPON_RESTORE_PRIORITY = [...SWORD_PRIORITY, ...AXE_PRIORITY];

/**
 * High-tier Splash & Drinkable Potion Skill (`modules/survival/potion_skill.js`):
 * - Velocity-lead downward splash aim (-74° to -88°) & grounded/descending throw gate
 * - Strictly anti-cheat-safe 1-tick post-swap settle AND 1-tick post-throw weapon restore
 * - Monotonic consumption token prevents stale async promises from cancelling new actions
 * - Proactive PotPvP inline health threshold when carrying >= 2 splash healing potions
 */
const potionSkillMethods = {
  _countSplashHeals() {
    if (!this.bot || !this.bot.inventory || !Array.isArray(this.bot.inventory.slots)) return 0;
    let count = 0;
    for (const item of this.bot.inventory.slots) {
      if (!item || item.name !== 'splash_potion') continue;
      const cls = this._classifyPotion(item);
      if (cls === 'heal2' || cls === 'heal1' || cls === 'unknown_splash') {
        count += item.count || 1;
      }
    }
    return count;
  },

  findHealingPotion(excludeSlots = null) {
    if (!this.bot || !this.bot.inventory || !Array.isArray(this.bot.inventory.slots)) return null;
    const start = getHotbarStart(this.bot);
    const slots = this.bot.inventory.slots;
    let best = null;
    let bestRank = -1;

    for (let s = 0; s < slots.length; s++) {
      if (excludeSlots && excludeSlots.has(s)) continue;
      const item = slots[s];
      if (!item || item.name !== 'splash_potion') continue;
      const cls = this._classifyPotion(item);
      let rank = -1;
      if (cls === 'heal2') rank = 30;
      else if (cls === 'heal1') rank = 20;
      else if (cls === 'unknown_splash') rank = 10;
      else continue;

      if (s >= start && s < start + 9) rank += 5;
      if (rank > bestRank) {
        bestRank = rank;
        best = item;
      }
    }
    return best;
  },

  findDrinkableHealPotion() {
    if (this.survCfg.drinkablePotionEnabled === false) return null;
    if (!this.bot || !this.bot.inventory || !Array.isArray(this.bot.inventory.slots)) return null;
    const start = getHotbarStart(this.bot);
    const slots = this.bot.inventory.slots;
    let best = null;
    let bestRank = -1;

    for (let s = 0; s < slots.length; s++) {
      const item = slots[s];
      if (!item || item.name !== 'potion') continue;
      const cls = this._classifyPotion(item);
      let rank = -1;
      if (cls === 'heal2') rank = 30;
      else if (cls === 'heal1') rank = 20;
      else if (cls === 'regen' && !this.isBuffActive('regen')) rank = 15;
      else continue;

      if (s >= start && s < start + 9) rank += 5;
      if (rank > bestRank) {
        bestRank = rank;
        best = item;
      }
    }
    return best;
  },

  findNeededBuffPotion() {
    if (this.survCfg.buffPotionEnabled === false) return null;
    if (!this.bot || !this.bot.inventory || !Array.isArray(this.bot.inventory.slots)) return null;
    const start = getHotbarStart(this.bot);
    const slots = this.bot.inventory.slots;
    const allowDrink = this.survCfg.drinkablePotionEnabled !== false;
    const priorityOrder = { strength: 50, swiftness: 40, fire_res: 30, regen: 20, turtle_master: 15, unknown_drink: 5 };

    let best = null;
    let bestScore = -1;

    for (let s = 0; s < slots.length; s++) {
      const item = slots[s];
      if (!item) continue;
      const isSplash = item.name === 'splash_potion';
      const isDrink = allowDrink && item.name === 'potion';
      if (!isSplash && !isDrink) continue;

      const cls = this._classifyPotion(item);
      if (!(cls in priorityOrder)) continue;
      if (cls !== 'unknown_drink' && this.isBuffActive(cls)) continue;
      // Don't burn Fire Resistance unless we're near fire/lava or pre-fight with plenty of health
      if (cls === 'fire_res' && this.bot.health < 14) continue;

      let score = priorityOrder[cls] + (isSplash ? 8 : 0) + (s >= start && s < start + 9 ? 4 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = { item, kind: cls, isSplash };
      }
    }
    return best;
  },

  _tryRefillHotbarPot() {
    if (!this.bot || !this.bot.inventory || this.equipBusy || this.sortingInProgress || this.totemEquipInFlight) return false;
    if (typeof this.bot.moveSlotItem !== 'function') return false;

    const now = Date.now();
    if ((now - this.pendingPotRefillTime) < 400) return false;

    const start = getHotbarStart(this.bot);
    const slots = this.bot.inventory.slots;
    let hotbarPots = 0;
    let emptyHotbarSlot = -1;
    for (let i = 0; i < 9; i++) {
      const it = slots[start + i];
      if (!it) {
        if (emptyHotbarSlot === -1) emptyHotbarSlot = start + i;
      } else if (it.name === 'splash_potion') {
        const cls = this._classifyPotion(it);
        if (cls === 'heal2' || cls === 'heal1' || cls === 'unknown_splash') hotbarPots++;
      }
    }
    if (hotbarPots >= 2 || emptyHotbarSlot === -1) return false;

    // Anti-InventoryMove safety: only move inventory pots when grounded and not full-speed sprinting
    const vel = this.bot.entity && this.bot.entity.velocity;
    const hSpeed = vel ? Math.sqrt(vel.x * vel.x + vel.z * vel.z) : 0;
    if (this.bot.entity && (!this.bot.entity.onGround || hSpeed > 0.22)) {
      return false;
    }

    let invPot = null;
    for (let s = 9; s < start; s++) {
      const it = slots[s];
      if (!it || it.name !== 'splash_potion') continue;
      const cls = this._classifyPotion(it);
      if (cls === 'heal2' || cls === 'heal1' || cls === 'unknown_splash') {
        invPot = it;
        if (cls === 'heal2') break;
      }
    }
    if (!invPot) return false;

    this.pendingPotRefillTime = now;
    this.equipBusy = true;
    Promise.resolve(this.bot.moveSlotItem(invPot.slot, emptyHotbarSlot))
      .catch(() => {})
      .finally(() => { this.equipBusy = false; });
    return true;
  },

  _restoreHotbarWeapon() {
    const weapon = findInventoryItem(this.bot, WEAPON_RESTORE_PRIORITY, { hotbarOnly: true });
    if (weapon && weapon.quickBarSlot >= 0 && typeof this.bot.setQuickBarSlot === 'function') {
      if (this.bot.quickBarSlot !== weapon.quickBarSlot) {
        this.bot.setQuickBarSlot(weapon.quickBarSlot);
      }
    }
  },

  _queueSplashPotion(potion, isBuff = false, kind = null) {
    this.pendingSplashPotion = potion;
    this.pendingSplashIsBuff = Boolean(isBuff);
    this.pendingSplashKind = kind;
    this.pendingSplashCreatedAt = Date.now();
    this.pendingSplashSettleTicks = 0;
    this.pendingSplashEquipStarted = false;
  },

  _isHoldingExactItem(item) {
    if (!item || !this.bot || !this.bot.heldItem) return false;
    if (this.bot.heldItem.name !== item.name) return false;
    if (isSlotInHotbar(this.bot, item.slot)) {
      const expected = item.slot - getHotbarStart(this.bot);
      if (this.bot.quickBarSlot !== expected) return false;
    }
    return true;
  },

  _equipSingleForConsume(item) {
    return new Promise((resolve) => {
      if (!item || !this.bot) {
        resolve(false);
        return;
      }
      if (this._isHoldingExactItem(item)) {
        resolve(true);
        return;
      }
      if (isSlotInHotbar(this.bot, item.slot) && typeof this.bot.setQuickBarSlot === 'function') {
        this.bot.setQuickBarSlot(item.slot - getHotbarStart(this.bot));
        // Wait 1 full physics tick (55ms) so slot change settles before consume packet
        setTimeout(() => resolve(!this._disposed && this._isHoldingExactItem(item)), 55);
        return;
      }
      this._equipSafe(item, 'hand').then((ok) => {
        if (!ok || this._disposed) {
          resolve(false);
          return;
        }
        setTimeout(() => resolve(!this._disposed), 55);
      });
    });
  },

  _startDrinkingPotion(potion, buffKind = null) {
    if (!potion || this.isConsuming || this._disposed) return false;
    if ((Date.now() - this.lastConsumeFailAt) < 400) return false;

    const token = ++this._consumeToken;
    this.isConsuming = true;
    this.isDrinkingPotion = true;
    this.consumeStartTime = Date.now();
    this.lowerShield();

    this._equipSingleForConsume(potion).then(async (ok) => {
      if (!ok || this._disposed || this._consumeToken !== token) {
        if (this._consumeToken === token) {
          this.isConsuming = false;
          this.isDrinkingPotion = false;
          this.lastConsumeFailAt = Date.now();
        }
        return;
      }
      if (typeof this.bot.setControlState === 'function') {
        this.bot.setControlState('sprint', false);
      }
      if (typeof this.bot.consume === 'function') {
        await this.bot.consume();
      }
      if (this._consumeToken === token && !this._disposed) {
        if (buffKind) this._markBuffApplied(buffKind);
        this.lastPotionTime = Date.now();
        this.isConsuming = false;
        this.isDrinkingPotion = false;
        this.pendingWeaponRestoreTicks = 1;
      }
    }).catch(() => {
      if (this._consumeToken === token) {
        try { if (typeof this.bot.deactivateItem === 'function') this.bot.deactivateItem(); } catch (_) {}
        this.isConsuming = false;
        this.isDrinkingPotion = false;
        this.lastConsumeFailAt = Date.now();
      }
    });

    return true;
  },

  _throwSplashPotion(potion, buffKind = null) {
    if (!potion || !this.bot || typeof this.bot.activateItem !== 'function') return false;
    // Instant throwable: NEVER call deactivateItem()!
    this.bot.activateItem(false);
    const now = Date.now();
    this.lastPotionTime = now;
    if (buffKind) {
      this._markBuffApplied(buffKind);
    } else if (this.bot.health <= 10) {
      this.activePotChainUntil = now + 950;
    }
    // Defer weapon restore to next tick (NEVER same-tick throw + slot swap!)
    this.pendingWeaponRestoreTicks = 1;
    return true;
  },

  _tickSplashPotionDownward(target, inlineCombat = false) {
    const now = Date.now();
    if (!this.pendingSplashPotion) return false;
    if ((now - this.pendingSplashCreatedAt) > 1200) {
      this.pendingSplashPotion = null;
      return false;
    }

    const potion = this.pendingSplashPotion;
    // Velocity-lead downward pitch: steeper when slow (-86°), slightly angled forward (-75°) when moving fast
    const vel = this.bot.entity && this.bot.entity.velocity;
    const hSpeed = vel ? Math.sqrt(vel.x * vel.x + vel.z * vel.z) : 0;
    const pitchDeg = hSpeed > 0.16 ? -76 : (hSpeed > 0.08 ? -81 : -86);
    const targetPitch = pitchDeg * (Math.PI / 180);

    const aimYaw = (target && target.position && inlineCombat)
      ? Math.atan2(-(this.bot.entity.position.x - target.position.x), -(this.bot.entity.position.z - target.position.z))
      : (this.bot.entity.yaw || 0);

    const aim = this.aimer
      ? this.aimer.stepTowardsAngles(aimYaw, targetPitch, { speedMultiplier: 2.2, toleranceRad: 0.22 })
      : { aligned: true };

    if (typeof this.bot.setControlState === 'function') {
      this.bot.setControlState('sprint', false);
      this.bot.setControlState('jump', false);
      this.bot.setControlState('forward', inlineCombat);
      this.bot.setControlState('back', false);
    }

    const eq = ensureItemHeld(this.bot, { item: potion });
    if (eq.swapped || !eq.held) {
      this.pendingSplashSettleTicks = 1;
      return true;
    }
    if (this.pendingSplashSettleTicks > 0) {
      this.pendingSplashSettleTicks--;
      return true;
    }

    // Grounded / descending gate: don't waste splash potion while rising rapidly at jump apex
    const vy = vel && typeof vel.y === 'number' ? vel.y : 0;
    if (this.bot.entity && !this.bot.entity.onGround && vy > 0.18 && (now - this.pendingSplashCreatedAt) < 400) {
      return true;
    }

    if (!aim.aligned && (now - this.pendingSplashCreatedAt) < 350) {
      return true;
    }

    this._throwSplashPotion(potion, this.pendingSplashIsBuff ? this.pendingSplashKind : null);
    this.pendingSplashPotion = null;
    this.pendingSplashIsBuff = false;
    this.pendingSplashKind = null;
    return true;
  },

  tickInlineCombatHeal(target) {
    if (!this.bot || !this.bot.entity) return false;
    const now = Date.now();

    // Deferred 1-tick post-throw weapon restore (anti-cheat safe!)
    if (this.pendingWeaponRestoreTicks > 0) {
      this.pendingWeaponRestoreTicks--;
      if (this.pendingWeaponRestoreTicks === 0 && !this.pendingSplashPotion && !this.isConsuming) {
        this._restoreHotbarWeapon();
      }
    }

    // Active drinking check
    if (this.isConsuming && this.isDrinkingPotion) {
      const dist = (target && target.position) ? this.bot.entity.position.distanceTo(target.position) : 99;
      if (dist < 2.6 || (now - this.consumeStartTime) > 2600) {
        this._consumeToken++;
        try { if (typeof this.bot.deactivateItem === 'function') this.bot.deactivateItem(); } catch (_) {}
        this.isConsuming = false;
        this.isDrinkingPotion = false;
        return false;
      }
      this._moveAwayWalk(target);
      return true;
    }

    // Continue active splash potion sequence
    if (this.pendingSplashPotion) {
      return this._tickSplashPotionDownward(target, true);
    }

    // Opportunistic hotbar pot refill when safe
    this._tryRefillHotbarPot();

    // Armor XP mending (when HP safe & Mending-enchanted armor is worn low)
    if (this.tickArmorXpMend(target)) {
      return true;
    }

    // Mid-fight spare armor hot-swap if a worn piece is critically damaged (<15%)
    this.trySwapSpareArmor();

    const potCooldownMs = this.survCfg.potionCooldownMs !== undefined ? this.survCfg.potionCooldownMs : 450;
    const cfgInlineHp = this.survCfg.inlinePotHealthThreshold !== undefined ? this.survCfg.inlinePotHealthThreshold : 5;
    // PotPvP upgrade: when carrying >= 2 splash heal pots, pot proactively at <= 9.5 HP to survive Sharp V Strength II crits!
    const splashCount = this._countSplashHeals();
    const effectiveInlineHp = splashCount >= 2 ? Math.max(cfgInlineHp, 9.5) : cfgInlineHp;
    const inPotChain = now < this.activePotChainUntil && this.bot.health <= 13.5;

    if ((this.bot.health <= effectiveInlineHp || inPotChain) && (now - this.lastPotionTime) >= potCooldownMs) {
      const healPot = this.findHealingPotion();
      if (healPot) {
        this.lowerShield();
        this._queueSplashPotion(healPot, false, null);
        return this._tickSplashPotionDownward(target, true);
      }
    }

    // Buff potions (Strength, Speed, Regen, Fire Res)
    if (this.survCfg.buffPotionEnabled !== false && (now - this.lastBuffAttemptTime) >= 1200) {
      const dist = (target && target.position) ? this.bot.entity.position.distanceTo(target.position) : 99;
      const buff = this.findNeededBuffPotion();
      if (buff) {
        if (buff.isSplash && this.bot.health >= 11 && dist >= 3.2) {
          this.lastBuffAttemptTime = now;
          this.lowerShield();
          this._queueSplashPotion(buff.item, true, buff.kind);
          return this._tickSplashPotionDownward(target, true);
        }
        const drinkMinDist = this.survCfg.drinkableBuffMinDist !== undefined ? this.survCfg.drinkableBuffMinDist : 3.5;
        if (!buff.isSplash && this.bot.health >= 12 && dist >= drinkMinDist) {
          this.lastBuffAttemptTime = now;
          return this._startDrinkingPotion(buff.item, buff.kind);
        }
      }
    }

    return false;
  }
};

module.exports = { potionSkillMethods };
