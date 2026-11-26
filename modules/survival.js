'use strict';

const { OFFHAND_SLOT, HOTBAR_START, clearMovementControls } = require('./constants');
const {
  GAPPLE_PRIORITY,
  HEAL_FOOD_PRIORITY,
  LOS_BLOCK_NAMES,
  ARMOR_SLOTS,
  ARMOR_MATERIAL_SCORE,
  ARMOR_MAX_DURABILITY,
  DEFAULT_BUFF_DURATION_MS,
  VANILLA_POTION_ID_TO_KEY,
  ZERO_BASED_EFFECT_TO_KIND,
  ZERO_BASED_EFFECT_TO_CLASS,
  ONE_BASED_EFFECT_TO_KIND
} = require('./survival/constants');
const { totemShieldMethods } = require('./survival/totem_shield');
const { potionsFoodMethods } = require('./survival/potions_food');
const { kitManagerMethods } = require('./survival/kit_manager');

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
    this.totemPoppedAt = 0;
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

    // Shield state
    this.isShielding = false;
    this.shieldHand = 'off-hand'; // 'off-hand' | 'main-hand'
    this.shieldingForMace = false;
    this.prevShieldHotbarSlot = -1;
    this.pendingMainhandShieldSlot = -1;
    this.shieldTicksRemaining = 0;
    this.shieldHoldTicks = 0;
    this.lastShieldEndTime = 0;
    this.lastMaceShieldEndTime = 0;
    this.maceAntiStunActive = false;
    this.maceShieldThreat = null;

    // Consumption, potion & XP armor mending state
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
    this.pendingPotRefillTime = 0;
    this.justAteGappleAt = 0;
    this.activeBuffUntil = new Map();
    this.isXpMending = false;
    this.lastXpThrowTime = 0;

    // Retreat & LOS block placement state
    this.retreatStrafeDir = Math.random() < 0.5 ? -1 : 1;
    this.retreatStrafeTicks = 18;
    this.lastLosBlockTime = 0;
    this.pendingLosBlock = null;

    // Bind event listeners for human-paced Totem of Undying re-equip & accurate buff tracking
    this._onUpdateSlot = this._handleUpdateSlot.bind(this);
    this._onHealth = this._handleHealth.bind(this);
    this._onEntityEffect = this._handleEntityEffect.bind(this);
    this._onEntityEffectEnd = this._handleEntityEffectEnd.bind(this);
    this._onClearBuffs = this._handleClearBuffs.bind(this);
    this._onClientEntityStatus = (packet) => {
      if (
        packet &&
        packet.entityStatus === 35 &&
        this.bot &&
        this.bot.entity &&
        packet.entityId === this.bot.entity.id
      ) {
        this._handleTotemPop();
      }
    };
    this._onBotEntityStatus = (entity, status) => {
      if (
        status === 35 &&
        entity &&
        this.bot &&
        this.bot.entity &&
        entity.id === this.bot.entity.id
      ) {
        this._handleTotemPop();
      }
    };

    if (this.bot.inventory && typeof this.bot.inventory.on === 'function') {
      this.bot.inventory.on('updateSlot', this._onUpdateSlot);
    }
    if (this.bot._client && typeof this.bot._client.on === 'function') {
      this.bot._client.on('entity_status', this._onClientEntityStatus);
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

  /**
   * Unbinds inventory, health, and effect listeners and cancels pending timers cleanly on disconnect.
   */
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

  /**
   * Enables or disables automatic inventory/offhand management.
   * Disabled in IDLE lobbies so locked lobby selector items never trigger click-packet storms.
   */
  setCombatActive(active) {
    this.activeInCombat = Boolean(active);
    if (active) {
      this.totemRetryBackoffMs = 0;
      this.offhandRetryBackoffMs = 0;
    } else {
      this._cancelPendingTotemTimers();
    }
  }

  /**
   * Configures mineflayer-auto-eat v5 according to config.json.
   */
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

  /**
   * Enables/disables background auto-eat (disabled during active combat to prevent NoSlow flags).
   */
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

  /**
   * Critical HP Reset trigger (Priority 2): returns true at <= retreatHealthThreshold (default 5 HP)
   * ONLY when the bot still has healing supplies left; if out of healing, stay in ENGAGING and fight to the death.
   */
  needsRetreat() {
    if (!this.bot.entity) return false;
    if (!this.hasHealingSupplies()) return false;
    const retreatHp = this.survCfg.retreatHealthThreshold !== undefined ? this.survCfg.retreatHealthThreshold : 5;
    return this.bot.health <= retreatHp;
  }

  /**
   * Returns true when bot needs a brief Golden Apple / food heal (no instant splash pots available).
   * When splash healing potions ARE available, tickInlineCombatHeal() splashes them in-fight without running away.
   */
  needsHealing() {
    if (!this.bot.entity) return false;
    // Don't re-enter HEALING right after finishing a gapple (let absorption/regen work while fighting!)
    if ((Date.now() - this.justAteGappleAt) < 2500 && this.bot.health > 5) return false;

    // Intelligent Golden Apple healing: wait until active Regeneration runs out unless HP is critical
    const criticalHp = this.survCfg.criticalHealthThreshold !== undefined ? this.survCfg.criticalHealthThreshold : 5;
    if (this.isBuffActive('regen') && this.bot.health > criticalHp) {
      return false;
    }

    // If we have a splash healing potion ready, stay in ENGAGING and quick-pot inline!
    const retreatHp = this.survCfg.retreatHealthThreshold !== undefined ? this.survCfg.retreatHealthThreshold : 5;
    if (this.findHealingPotion() && this.bot.health > retreatHp) {
      return false;
    }

    const healHp = this.survCfg.healHealthThreshold !== undefined ? this.survCfg.healHealthThreshold : 5;
    const lowHealth = this.bot.health <= healHp;
    const lowFood = this.bot.food <= Math.min(10, this.survCfg.hungerThreshold || 16);
    return (lowHealth || lowFood) && Boolean(this.findBestHealFood());
  }

  /**
   * Returns true when health and hunger are safely restored to re-engage combat.
   */
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
    if (this.isConsuming) {
      try { this.bot.deactivateItem(); } catch (_) {}
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
    this.pendingLosBlock = null;
    this.lowerShield();
  }
}

Object.assign(
  SurvivalModule.prototype,
  totemShieldMethods,
  potionsFoodMethods,
  kitManagerMethods
);

module.exports = { SurvivalModule, OFFHAND_SLOT, HOTBAR_START };
