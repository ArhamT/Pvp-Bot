'use strict';

const { OFFHAND_SLOT, HOTBAR_START } = require('./constants');
const { potionClassifierMethods } = require('./survival/potion_classifier');
const { autoTotemMethods } = require('./survival/auto_totem');
const { shieldSkillMethods } = require('./survival/shield_skill');
const { potionSkillMethods } = require('./survival/potion_skill');
const { foodMendingMethods } = require('./survival/food_mending');
const { retreatHealMethods } = require('./survival/retreat_heal');
const { armorHotbarMethods } = require('./survival/armor_hotbar');

/**
 * Modular Survival Coordinator combining 7 focused high-tier skills:
 * - `survival/potion_classifier.js` — WeakMap-cached potion & effect resolver
 * - `survival/auto_totem.js`        — Deduplicated AutoTotem + Double-Hand emergency hold
 * - `survival/shield_skill.js`      — Smart Shield + Axe-stun cooldown tracking + unified `requestShield`
 * - `survival/potion_skill.js`      — Velocity-lead Splash Pots + Buffs + safe hotbar refill
 * - `survival/food_mending.js`      — Gapple/Food + Mending-verified XP repair + spare armor swap
 * - `survival/retreat_heal.js`      — Evasive Retreat/Heal + hitbox-safe LOS cover blocks
 * - `survival/armor_hotbar.js`      — Enchant/durability armor equipper + multi-kit hotbar sorter
 */
class SurvivalModule {
  constructor(bot, config, aimer) {
    this.bot = bot;
    this.config = config || {};
    this.survCfg = (config && config.survival) ? config.survival : {};
    this.aimer = aimer;

    // Priority locks & packet-rate / locked-lobby backoff state
    this.activeInCombat = true;
    this._disposed = false;
    this.totemEquipInFlight = false;
    this.totemSwapPending = false;
    this.totemPopReplenishPending = false;
    this._lastTotemPopEventAt = 0;
    this._totemMovementPaused = false;
    this.totemDelayTimer = null;
    this._totemDelayResolve = null;
    this._totemPauseTimer = null;
    this._totemPauseResolve = null;
    this.totemEquipPromise = null;
    this.lastTotemAttemptAt = 0;
    this.totemRetryBackoffMs = 0;
    this.lastOffhandAttemptAt = 0;
    this.offhandRetryBackoffMs = 0;
    this.equipBusy = false;
    this.sortingInProgress = false;

    // Shield state (with Axe-stun cooldown tracking)
    this.isShielding = false;
    this.shieldHand = 'off-hand';
    this.shieldingForMace = false;
    this.shieldingForExternal = null;
    this.prevShieldHotbarSlot = -1;
    this.pendingMainhandShieldSlot = -1;
    this.shieldTicksRemaining = 0;
    this.shieldHoldTicks = 0;
    this.lastShieldEndTime = 0;
    this.lastMaceShieldEndTime = 0;
    this.shieldDisabledUntil = 0;
    this.maceAntiStunActive = false;
    this.maceShieldThreat = null;

    // Consumption, potion & XP armor mending state
    this._consumeToken = 0;
    this.isConsuming = false;
    this.isDrinkingPotion = false;
    this.consumeStartTime = 0;
    this.lastConsumeFailAt = 0;
    this.lastPotionTime = 0;
    this.lastBuffAttemptTime = 0;
    this.pendingSplashPotion = null;
    this.pendingSplashIsBuff = false;
    this.pendingSplashKind = null;
    this.pendingSplashCreatedAt = 0;
    this.pendingSplashSettleTicks = 0;
    this.pendingSplashEquipStarted = false;
    this.pendingWeaponRestoreTicks = 0;
    this.pendingPotRefillTime = 0;
    this.activePotChainUntil = 0;
    this.justAteGappleAt = 0;
    this.activeBuffUntil = new Map();
    this.isXpMending = false;
    this.lastXpThrowTime = 0;
    this._lastSpareArmorCheckAt = 0;

    // Retreat, evasive heal-walk & LOS block placement state
    this.retreatStrafeDir = Math.random() < 0.5 ? -1 : 1;
    this.retreatStrafeTicks = 18;
    this.retreatGapTicks = 0;
    this.healStrafeDir = Math.random() < 0.5 ? -1 : 1;
    this.healStrafeTicks = 7;
    this.lastLosBlockTime = 0;
    this.pendingLosBlock = null;

    // Event bindings
    this._onUpdateSlot = this._handleUpdateSlot.bind(this);
    this._onHealth = this._handleHealth.bind(this);
    this._onEntityEffect = this._handleEntityEffect.bind(this);
    this._onEntityEffectEnd = this._handleEntityEffectEnd.bind(this);
    this._onClearBuffs = this._handleClearBuffs.bind(this);

    this._onClientEntityStatus = (packet) => {
      if (!packet || !this.bot || !this.bot.entity || packet.entityId !== this.bot.entity.id) return;
      if (packet.entityStatus === 35) {
        this._handleTotemPop();
      } else if (packet.entityStatus === 30) {
        this._handleShieldDisabledEvent(5000);
      }
    };

    this._onBotEntityStatus = (entity, status) => {
      if (!entity || !this.bot || !this.bot.entity || entity.id !== this.bot.entity.id) return;
      if (status === 35) {
        this._handleTotemPop();
      } else if (status === 30) {
        this._handleShieldDisabledEvent(5000);
      }
    };

    this._onSetCooldown = (packet) => {
      if (!packet || !this.bot) return;
      const ticks = Number(packet.cooldownTicks || 0);
      if (ticks <= 0) return;
      const shieldId = this.bot.registry && this.bot.registry.itemsByName && this.bot.registry.itemsByName.shield
        ? this.bot.registry.itemsByName.shield.id
        : null;
      const itemKey = String(packet.itemGroup || packet.cooldownGroup || '').toLowerCase();
      if (
        (shieldId !== null && packet.itemID === shieldId) ||
        itemKey.includes('shield')
      ) {
        this._handleShieldDisabledEvent(ticks * 50);
      }
    };

    if (this.bot.inventory && typeof this.bot.inventory.on === 'function') {
      this.bot.inventory.on('updateSlot', this._onUpdateSlot);
    }
    if (this.bot._client && typeof this.bot._client.on === 'function') {
      this.bot._client.on('entity_status', this._onClientEntityStatus);
      this.bot._client.on('set_cooldown', this._onSetCooldown);
    }
    if (typeof this.bot.on === 'function') {
      this.bot.on('health', this._onHealth);
      this.bot.on('entityStatus', this._onBotEntityStatus);
      this.bot.on('entityEffect', this._onEntityEffect);
      this.bot.on('entityEffectEnd', this._onEntityEffectEnd);
      this.bot.on('death', this._onClearBuffs);
      this.bot.on('respawn', this._onClearBuffs);
    }
  }

  dispose() {
    this._disposed = true;
    this.activeInCombat = false;
    this.totemPopReplenishPending = false;
    this._cancelPendingTotemTimers();
    this.totemEquipInFlight = false;
    this.totemEquipPromise = null;

    if (this.bot && this.bot.inventory && typeof this.bot.inventory.removeListener === 'function') {
      this.bot.inventory.removeListener('updateSlot', this._onUpdateSlot);
    }
    if (this.bot && this.bot._client && typeof this.bot._client.removeListener === 'function') {
      this.bot._client.removeListener('entity_status', this._onClientEntityStatus);
      this.bot._client.removeListener('set_cooldown', this._onSetCooldown);
    }
    if (this.bot && typeof this.bot.removeListener === 'function') {
      this.bot.removeListener('health', this._onHealth);
      this.bot.removeListener('entityStatus', this._onBotEntityStatus);
      this.bot.removeListener('entityEffect', this._onEntityEffect);
      this.bot.removeListener('entityEffectEnd', this._onEntityEffectEnd);
      this.bot.removeListener('death', this._onClearBuffs);
      this.bot.removeListener('respawn', this._onClearBuffs);
    }
    this.activeBuffUntil.clear();
    this.stopConsumption();
  }

  setCombatActive(active) {
    this.activeInCombat = Boolean(active);
    if (active) {
      this.totemRetryBackoffMs = 0;
      this.offhandRetryBackoffMs = 0;
    } else {
      this._cancelPendingTotemTimers();
    }
  }

  configureAutoEat() {
    if (!this.bot.autoEat) return;
    this.bot.autoEat.setOpts({
      priority: 'saturation',
      minHunger: this.survCfg.hungerThreshold || 16,
      minHealth: this.survCfg.healHealthThreshold || 13,
      bannedFood: [
        'rotten_flesh',
        'spider_eye',
        'poisonous_potato',
        'pufferfish',
        'chorus_fruit',
        'suspicious_stew'
      ],
      offhand: false,
      returnToLastItem: true,
      eatingTimeout: this.survCfg.eatTimeoutMs || 3500,
      strictErrors: true
    });
  }

  setAutoEatEnabled(enabled) {
    if (!this.bot.autoEat) return;
    if (enabled && !this.bot.autoEat.enabled) {
      this.bot.autoEat.enableAuto();
    } else if (!enabled && this.bot.autoEat.enabled) {
      if (this.bot.autoEat.isEating) {
        this.bot.autoEat.cancelEat();
      }
      this.bot.autoEat.disableAuto();
    }
  }

  needsRetreat() {
    if (!this.bot.entity) return false;
    if (!this.hasHealingSupplies()) return false;
    const retreatHp = this.survCfg.retreatHealthThreshold !== undefined ? this.survCfg.retreatHealthThreshold : 5;
    return this.bot.health <= retreatHp;
  }

  needsHealing() {
    if (!this.bot.entity) return false;
    if ((Date.now() - this.justAteGappleAt) < 2500 && this.bot.health > 5) return false;

    const criticalHp = this.survCfg.criticalHealthThreshold !== undefined ? this.survCfg.criticalHealthThreshold : 5;
    if (this.isBuffActive('regen') && this.bot.health > criticalHp) {
      return false;
    }

    const retreatHp = this.survCfg.retreatHealthThreshold !== undefined ? this.survCfg.retreatHealthThreshold : 5;
    if (this.findHealingPotion() && this.bot.health > retreatHp) {
      return false;
    }

    const healHp = this.survCfg.healHealthThreshold !== undefined ? this.survCfg.healHealthThreshold : 5;
    const lowHealth = this.bot.health <= healHp;
    const lowFood = this.bot.food <= Math.min(10, this.survCfg.hungerThreshold || 16);
    return (lowHealth || lowFood) && Boolean(this.findBestHealFood());
  }

  isRecovered() {
    if (!this.bot.entity) return true;
    const safeHp = this.survCfg.safeHealthThreshold || 15;
    if ((Date.now() - this.justAteGappleAt) < 2200 && this.bot.health >= Math.min(12, safeHp - 2)) {
      return true;
    }
    const healthOk = this.bot.health >= safeHp;
    const foodOk = this.bot.food >= Math.min(14, this.survCfg.hungerThreshold || 16);
    return healthOk && foodOk;
  }

  hasHealingSupplies() {
    return Boolean(this.findHealingPotion() || this.findDrinkableHealPotion() || this.findBestHealFood());
  }

  stopConsumption() {
    this._consumeToken++;
    if (this.isConsuming) {
      try { if (typeof this.bot.deactivateItem === 'function') this.bot.deactivateItem(); } catch (_) {}
      this.isConsuming = false;
      this.isDrinkingPotion = false;
    }
    this.isXpMending = false;
    this.pendingSplashPotion = null;
    this.pendingSplashIsBuff = false;
    this.pendingSplashKind = null;
    this.pendingSplashCreatedAt = 0;
    this.pendingSplashSettleTicks = 0;
    this.pendingSplashEquipStarted = false;
    this.pendingWeaponRestoreTicks = 0;
    this.activePotChainUntil = 0;
    this.retreatGapTicks = 0;
    this.pendingLosBlock = null;
    this.lowerShield();
  }
}

Object.assign(
  SurvivalModule.prototype,
  potionClassifierMethods,
  autoTotemMethods,
  shieldSkillMethods,
  potionSkillMethods,
  foodMendingMethods,
  retreatHealMethods,
  armorHotbarMethods
);

module.exports = { SurvivalModule, OFFHAND_SLOT, HOTBAR_START };
