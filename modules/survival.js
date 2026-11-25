'use strict';

const { Vec3 } = require('vec3');
const { normalizeAngle } = require('./aim');

const OFFHAND_SLOT = 45;
const HOTBAR_START = 36;

const SWORD_PRIORITY = [
  'netherite_sword',
  'diamond_sword',
  'iron_sword',
  'stone_sword',
  'golden_sword',
  'wooden_sword'
];

const AXE_PRIORITY = [
  'netherite_axe',
  'diamond_axe',
  'iron_axe',
  'stone_axe',
  'golden_axe',
  'wooden_axe'
];

const GAPPLE_PRIORITY = [
  'enchanted_golden_apple',
  'golden_apple'
];

const HEAL_FOOD_PRIORITY = [
  'enchanted_golden_apple',
  'golden_apple',
  'golden_carrot',
  'cooked_beef',
  'cooked_porkchop',
  'cooked_mutton',
  'cooked_salmon',
  'cooked_chicken',
  'bread'
];

const LOS_BLOCK_NAMES = new Set([
  'cobblestone',
  'cobbled_deepslate',
  'stone',
  'deepslate',
  'dirt',
  'coarse_dirt',
  'netherrack',
  'obsidian',
  'oak_planks',
  'spruce_planks',
  'birch_planks',
  'jungle_planks',
  'acacia_planks',
  'dark_oak_planks',
  'mangrove_planks',
  'cherry_planks',
  'bamboo_planks',
  'sandstone',
  'bricks',
  'stone_bricks',
  'end_stone',
  'white_wool',
  'red_wool',
  'blue_wool'
]);

const ARMOR_SLOTS = [
  { dest: 'head', slotIndex: 5, suffix: '_helmet', extra: ['turtle_helmet'] },
  { dest: 'torso', slotIndex: 6, suffix: '_chestplate', extra: [] },
  { dest: 'legs', slotIndex: 7, suffix: '_leggings', extra: [] },
  { dest: 'feet', slotIndex: 8, suffix: '_boots', extra: [] }
];

const ARMOR_MATERIAL_SCORE = {
  netherite: 60,
  diamond: 50,
  iron: 35,
  turtle: 32,
  chainmail: 28,
  golden: 22,
  leather: 15
};

const ARMOR_MAX_DURABILITY = {
  leather_helmet: 55, leather_chestplate: 80, leather_leggings: 75, leather_boots: 65,
  golden_helmet: 77, golden_chestplate: 112, golden_leggings: 105, golden_boots: 91,
  chainmail_helmet: 165, chainmail_chestplate: 240, chainmail_leggings: 225, chainmail_boots: 195,
  iron_helmet: 165, iron_chestplate: 240, iron_leggings: 225, iron_boots: 195,
  turtle_helmet: 275,
  diamond_helmet: 363, diamond_chestplate: 528, diamond_leggings: 495, diamond_boots: 429,
  netherite_helmet: 407, netherite_chestplate: 592, netherite_leggings: 555, netherite_boots: 481
};

// Default fallback durations (ms) applied immediately when bot uses a buff potion
// (overridden with exact server tick duration when `entityEffect` packet arrives)
const DEFAULT_BUFF_DURATION_MS = {
  strength: 80000,      // Strength II = 1:30 (90s)
  swiftness: 80000,     // Speed II = 1:30 (90s)
  fire_res: 165000,     // Fire Res = 3:00–8:00 (180s+)
  regen: 20000,         // Regen II = 0:22
  turtle_master: 18000, // Turtle Master = 0:20
  unknown_drink: 85000
};

// Standard MC Java status effect IDs (0-based in >= 1.20.5, 1-based in <= 1.20.4)
const ZERO_BASED_EFFECT_TO_KIND = {
  0: 'swiftness',
  4: 'strength',
  9: 'regen',
  10: 'turtle_master',
  11: 'fire_res'
};

const ONE_BASED_EFFECT_TO_KIND = {
  1: 'swiftness',
  5: 'strength',
  10: 'regen',
  11: 'turtle_master',
  12: 'fire_res'
};

/**
 * Highest-priority survival module handling:
 * 1. Event-driven + per-tick Totem of Undying management (slot 45, <100ms, preempts all inventory actions).
 * 2. Smart Retreating (<= 11 HP): smooth 180° turn, sprint-jump escape, line-of-sight block placement behind,
 *    Golden Apple / Enchanted Golden Apple eating, and downward (-90° pitch) Splash Instant Health II throws while moving forward.
 * 3. Smart Shielding: raises offhand shield against bow draws within 12 blocks or sword/axe rushes during weapon cooldown.
 * 4. Protection-scored Armor auto-equip & PvP Hotbar auto-sorting (Slots 0–8).
 */
class SurvivalModule {
  constructor(bot, config, aimer) {
    this.bot = bot;
    this.config = config;
    this.survCfg = config.survival;
    this.aimer = aimer;

    // Priority locks & packet-rate / locked-lobby backoff state
    this.activeInCombat = true;
    this.totemEquipInFlight = false;
    this.totemEquipPromise = null;
    this.lastTotemAttemptAt = 0;
    this.totemRetryBackoffMs = 0;
    this.lastOffhandAttemptAt = 0;
    this.offhandRetryBackoffMs = 0;
    this.equipBusy = false;
    this.sortingInProgress = false;

    // Shield state
    this.isShielding = false;
    this.shieldTicksRemaining = 0;
    this.lastShieldEndTime = 0;

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

    // Bind immediate event listeners for <100ms Totem of Undying re-equip & accurate buff tracking
    this._onUpdateSlot = this._handleUpdateSlot.bind(this);
    this._onHealth = this._handleHealth.bind(this);
    this._onEntityEffect = this._handleEntityEffect.bind(this);
    this._onEntityEffectEnd = this._handleEntityEffectEnd.bind(this);
    this._onClearBuffs = this._handleClearBuffs.bind(this);

    if (this.bot.inventory && typeof this.bot.inventory.on === 'function') {
      this.bot.inventory.on('updateSlot', this._onUpdateSlot);
    }
    if (typeof this.bot.on === 'function') {
      this.bot.on('health', this._onHealth);
      this.bot.on('entityEffect', this._onEntityEffect);
      this.bot.on('entityEffectEnd', this._onEntityEffectEnd);
      this.bot.on('death', this._onClearBuffs);
      this.bot.on('respawn', this._onClearBuffs);
    }
  }

  /**
   * Unbinds inventory, health, and effect listeners cleanly on disconnect.
   */
  dispose() {
    if (this.bot && this.bot.inventory && typeof this.bot.inventory.removeListener === 'function') {
      this.bot.inventory.removeListener('updateSlot', this._onUpdateSlot);
    }
    if (this.bot && typeof this.bot.removeListener === 'function') {
      this.bot.removeListener('health', this._onHealth);
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
    }
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Immediate inventory slot listener: if offhand slot 45 loses its Totem during combat, re-equip in <100ms.
   */
  _handleUpdateSlot(slot, _oldItem, newItem) {
    if (!this.activeInCombat) return;
    const offhandSlot = this._getOffhandSlotIndex();
    if (slot === offhandSlot && (!newItem || newItem.name !== 'totem_of_undying')) {
      this.ensureTotemPriority();
    }
  }

  /**
   * Health change hook: immediately double-check offhand Totem on damage/pop during combat.
   */
  _handleHealth() {
    if (!this.activeInCombat) return;
    this.ensureTotemPriority();
  }

  _getOffhandSlotIndex() {
    if (this.bot && typeof this.bot.getEquipmentDestSlot === 'function') {
      return this.bot.getEquipmentDestSlot('off-hand');
    }
    return OFFHAND_SLOT;
  }

  /**
   * Returns the item currently in offhand (slot 45).
   */
  getOffhandItem() {
    if (!this.bot || !this.bot.inventory || !this.bot.inventory.slots) return null;
    return this.bot.inventory.slots[this._getOffhandSlotIndex()] || null;
  }

  /**
   * Finds a Totem of Undying anywhere in inventory outside the offhand slot.
   */
  findTotemInInventory() {
    if (!this.bot || !this.bot.inventory) return null;
    const offhandSlot = this._getOffhandSlotIndex();
    return this.bot.inventory.items().find(
      (item) => item && item.name === 'totem_of_undying' && item.slot !== offhandSlot
    ) || null;
  }

  /**
   * Returns true if offhand (slot 45) lacks a Totem AND one is available in inventory.
   */
  needsTotemSwap() {
    if (!this.survCfg.totemAutoEquip) return false;
    const offhand = this.getOffhandItem();
    if (offhand && offhand.name === 'totem_of_undying') return false;
    return Boolean(this.findTotemInInventory());
  }

  /**
   * HIGHEST PRIORITY: Immediately equips a Totem of Undying to offhand (slot 45).
   * Preempts all other inventory operations (sorting, armor, weapon equips) and executes in <100ms.
   * Returns true if a totem swap was triggered or is currently in flight.
   */
  ensureTotemPriority() {
    if (!this.activeInCombat || !this.survCfg.totemAutoEquip || !this.bot || !this.bot.inventory) return false;

    const offhand = this.getOffhandItem();
    if (offhand && offhand.name === 'totem_of_undying') {
      this.totemRetryBackoffMs = 0;
      return false;
    }

    const totem = this.findTotemInInventory();
    if (!totem) return false;

    if (this.totemEquipInFlight) return true;

    const now = Date.now();
    if (this.totemRetryBackoffMs > 0 && (now - this.lastTotemAttemptAt) < this.totemRetryBackoffMs) {
      return false;
    }

    this.totemEquipInFlight = true;
    this.lastTotemAttemptAt = now;
    // Direct immediate dispatch — bypasses equipBusy / sorting locks for <100ms reaction
    this.totemEquipPromise = Promise.resolve(this.bot.equip(totem, 'off-hand'))
      .then(() => {
        const after = this.getOffhandItem();
        if (after && after.name === 'totem_of_undying') {
          this.totemRetryBackoffMs = 0;
        } else {
          // Server reverted or rejected the click (e.g. locked inventory) -> back off to prevent packet kicks
          this.totemRetryBackoffMs = Math.min(2500, Math.max(300, (this.totemRetryBackoffMs || 150) * 2));
        }
      })
      .catch(() => {
        this.totemRetryBackoffMs = Math.min(2500, Math.max(300, (this.totemRetryBackoffMs || 150) * 2));
      })
      .finally(() => {
        this.totemEquipInFlight = false;
        this.totemEquipPromise = null;
      });

    return true;
  }

  /**
   * Ensures offhand safety every tick during active combat:
   * - Priority 1: Totem of Undying in slot 45 (preempts everything)
   * - Priority 2: Shield in slot 45 if no totems remain in inventory (with failure backoff)
   * Returns true if an emergency totem swap is currently in progress.
   */
  ensureOffhandSafety() {
    if (!this.activeInCombat) return false;
    if (this.ensureTotemPriority()) return true;

    // Do not fall through to shield equip if totem equip is currently in locked-inventory backoff
    if (this.totemRetryBackoffMs > 0 && this.findTotemInInventory()) {
      return false;
    }

    if (this.equipBusy || this.sortingInProgress || !this.bot || !this.bot.inventory) {
      return false;
    }

    const offhand = this.getOffhandItem();
    if (offhand && offhand.name === 'totem_of_undying') return false;

    if (this.survCfg.shieldEnabled) {
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
   * Returns true ONLY when critically low (<= 6 HP / 3 hearts) with NO offhand Totem
   * and NO instant splash healing potion ready — prevents cowardly running away at 5+ hearts!
   */
  needsRetreat() {
    if (!this.bot.entity) return false;
    const retreatHp = this.survCfg.retreatHealthThreshold !== undefined ? this.survCfg.retreatHealthThreshold : 6;
    if (this.bot.health > retreatHp) return false;

    // If holding a Totem in offhand and we still have splash healing pots, quick-pot inline instead of fleeing!
    const offhand = this.getOffhandItem();
    const hasTotemEquipped = Boolean(offhand && offhand.name === 'totem_of_undying');
    if (hasTotemEquipped && this.findHealingPotion()) return false;

    return true;
  }

  /**
   * Returns true when bot needs a brief Golden Apple / food heal (no instant splash pots available).
   * When splash healing potions ARE available, tickInlineCombatHeal() splashes them in-fight without running away.
   */
  needsHealing() {
    if (!this.bot.entity) return false;
    // Don't re-enter HEALING right after finishing a gapple (let absorption/regen work while fighting!)
    if ((Date.now() - this.justAteGappleAt) < 2500 && this.bot.health > 7) return false;

    // If we have a splash healing potion ready, stay in ENGAGING and quick-pot inline!
    if (this.findHealingPotion() && this.bot.health > (this.survCfg.retreatHealthThreshold || 6)) {
      return false;
    }

    const lowHealth = this.bot.health <= (this.survCfg.healHealthThreshold || 11);
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

  /**
   * Deeply serializes item metadata including MC 1.20.5+ Map `componentMap`, `components`, `nbt`, and display names.
   */
  _extractPotionMetadata(item) {
    if (!item) return { text: '', potionId: null, effectIds: [] };
    const parts = [];
    let potionId = null;
    const effectIds = [];

    const walk = (val, depth = 0) => {
      if (val === null || val === undefined || depth > 6) return;
      if (typeof val === 'string') {
        parts.push(val.toLowerCase());
        return;
      }
      if (typeof val === 'number') return;
      if (val instanceof Map) {
        for (const [k, v] of val.entries()) {
          parts.push(String(k).toLowerCase());
          walk(v, depth + 1);
        }
        return;
      }
      if (Array.isArray(val)) {
        for (const el of val) walk(el, depth + 1);
        return;
      }
      if (typeof val === 'object') {
        if (typeof val.potionId === 'number' && potionId === null) potionId = val.potionId;
        if (typeof val.potion === 'number' && potionId === null) potionId = val.potion;
        if (typeof val.id === 'number' && (val.amplifier !== undefined || val.duration !== undefined)) {
          effectIds.push(val.id);
        }
        for (const [k, v] of Object.entries(val)) {
          parts.push(k.toLowerCase());
          walk(v, depth + 1);
        }
      }
    };

    if (item.customName) parts.push(String(item.customName).toLowerCase());
    if (item.displayName) parts.push(String(item.displayName).toLowerCase());
    if (item.nbt) walk(item.nbt);
    if (item.components) walk(item.components);
    if (item.componentMap) walk(item.componentMap);

    return { text: parts.join(' '), potionId, effectIds };
  }

  /**
   * Classifies any potion or splash_potion reliably across MC 1.16–1.21.4+:
   * returns 'heal2' | 'heal1' | 'regen' | 'strength' | 'swiftness' | 'fire_res' | 'harmful' | 'unknown_splash' | 'other'.
   */
  _classifyPotion(item) {
    if (!item || !item.name) return 'other';
    if (item.name !== 'splash_potion' && item.name !== 'potion' && item.name !== 'lingering_potion') {
      return 'other';
    }

    const { text, potionId, effectIds } = this._extractPotionMetadata(item);

    // 1. Explicit string matching (MC <= 1.20.4 NBT & string-named components / custom kits)
    const harmfulKeywords = [
      'harming', 'instant_damage', 'poison', 'weakness', 'slowness',
      'wither', 'oozing', 'weaving', 'infested', 'wind_charged'
    ];
    if (harmfulKeywords.some((kw) => text.includes(kw))) return 'harmful';

    if (text.includes('strong_healing') || text.includes('instant_health_ii') || text.includes('healing ii')) {
      return 'heal2';
    }
    if (text.includes('healing') || text.includes('instant_health') || text.includes('instant health')) {
      return 'heal1';
    }
    if (text.includes('regeneration') || text.includes('regen')) {
      return 'regen';
    }
    if (text.includes('strength')) return 'strength';
    if (text.includes('swiftness') || text.includes('speed')) return 'swiftness';
    if (text.includes('fire_resistance') || text.includes('fire resistance')) return 'fire_res';
    if (text.includes('turtle_master') || text.includes('resistance')) return 'turtle_master';

    // 2. Check custom effect IDs against bot.registry (handles 0-based 1.21+ & 1-based 1.20.4)
    if (effectIds.length > 0 && this.bot && this.bot.registry && this.bot.registry.effects) {
      for (const eid of effectIds) {
        const eff = this.bot.registry.effects[eid];
        const ename = eff && eff.name ? eff.name.toLowerCase() : '';
        if (ename.includes('instantdamage') || ename.includes('poison') || ename.includes('weakness') || ename.includes('slowness')) {
          return 'harmful';
        }
        if (ename.includes('instanthealth') || ename.includes('healing')) return 'heal2';
        if (ename.includes('regeneration')) return 'regen';
        if (ename.includes('strength')) return 'strength';
        if (ename.includes('speed') || ename.includes('swiftness')) return 'swiftness';
        if (ename.includes('fireresistance')) return 'fire_res';
      }
    }

    // 3. Vanilla MC 1.20.5–1.21+ numeric `minecraft:potion` registry IDs
    // (0=water,1=mundane,2=thick,3=awkward, 12-13=fire_res, 14-16=swiftness, 17-19=slowness,
    //  22-23=healing/strong_healing [or 23-24 in 1.21], 24-25=harming, 26-28=poison, 29-31=regen, 32-34=strength)
    if (typeof potionId === 'number') {
      if (potionId <= 3) return 'other';
      if (potionId === 12 || potionId === 13) return 'fire_res';
      if (potionId >= 14 && potionId <= 16) return 'swiftness';
      if (potionId >= 17 && potionId <= 19) return 'harmful';
      if (potionId === 23) return 'heal2';
      if (potionId === 22) return 'heal1';
      if (potionId >= 24 && potionId <= 28) return 'harmful';
      if (potionId >= 29 && potionId <= 31) return 'regen';
      if (potionId >= 32 && potionId <= 34) return 'strength';
      if (potionId >= 35) return 'harmful';
    }

    // 4. Fallback: unidentified splash_potion in PvP kits is almost always Instant Health II
    if (item.name === 'splash_potion') {
      return 'unknown_splash';
    }
    if (item.name === 'potion') {
      const isPlainWater = text.includes('water') || text.includes('mundane') ||
        text.includes('thick') || text.includes('awkward');
      if (!isPlainWater) return 'unknown_drink';
    }

    return 'other';
  }

  /**
   * Finds a drinkable healing or regeneration potion (`potion` item) in inventory.
   */
  findDrinkableHealPotion() {
    if (!this.bot.inventory || this.survCfg.drinkablePotionEnabled === false) return null;
    const items = this.bot.inventory.items();
    const hotbarStart = this.bot.inventory.hotbarStart || HOTBAR_START;

    const rankOf = (item) => {
      if (!item || item.name !== 'potion') return 0;
      const cls = this._classifyPotion(item);
      let base = 0;
      if (cls === 'heal2') base = 40;
      else if (cls === 'heal1') base = 30;
      else if (cls === 'regen') base = 20;
      if (base === 0) return 0;
      const inHotbar = item.slot >= hotbarStart && item.slot < hotbarStart + 9;
      return base + (inHotbar ? 5 : 0);
    };

    let best = null;
    let bestRank = 0;
    for (const item of items) {
      const r = rankOf(item);
      if (r > bestRank) {
        bestRank = r;
        best = item;
      }
    }
    return best;
  }

  /**
   * Returns durability remaining ratio in [0.0, 1.0] for an armor/tool item across
   * legacy NBT (`Damage`), `item.durabilityUsed`, and MC 1.20.5+ `damage` components.
   */
  getItemDurabilityRatio(item) {
    if (!item || !item.name) return 1.0;
    const maxDur = (typeof item.maxDurability === 'number' && item.maxDurability > 0)
      ? item.maxDurability
      : (ARMOR_MAX_DURABILITY[item.name] || 0);
    if (maxDur <= 0) return 1.0;

    let damage = 0;
    if (typeof item.durabilityUsed === 'number' && item.durabilityUsed > 0) {
      damage = item.durabilityUsed;
    } else if (item.componentMap instanceof Map) {
      const dmgComp = item.componentMap.get('damage') || item.componentMap.get('minecraft:damage');
      if (typeof dmgComp === 'number') damage = dmgComp;
      else if (dmgComp && typeof dmgComp.data === 'number') damage = dmgComp.data;
      else if (dmgComp && typeof dmgComp.value === 'number') damage = dmgComp.value;
    } else if (Array.isArray(item.components)) {
      const dmgComp = item.components.find((c) => c && (c.type === 'damage' || c.type === 'minecraft:damage'));
      if (dmgComp) {
        if (typeof dmgComp.data === 'number') damage = dmgComp.data;
        else if (typeof dmgComp.value === 'number') damage = dmgComp.value;
      }
    } else if (item.nbt && item.nbt.value && item.nbt.value.Damage) {
      const val = item.nbt.value.Damage.value !== undefined ? item.nbt.value.Damage.value : item.nbt.value.Damage;
      if (typeof val === 'number') damage = val;
    }

    return Math.max(0, Math.min(1, (maxDur - damage) / maxDur));
  }

  /**
   * Inspects worn armor slots (5=helmet, 6=chestplate, 7=leggings, 8=boots)
   * and returns the lowest durability piece `{ ratio, slot, item }` (or null if no armor worn).
   */
  getLowestWornArmorDurability() {
    if (!this.bot || !this.bot.inventory || !this.bot.inventory.slots) return null;
    let lowest = null;

    for (const spec of ARMOR_SLOTS) {
      const piece = this.bot.inventory.slots[spec.slotIndex];
      if (!piece || !piece.name) continue;
      if (!ARMOR_MAX_DURABILITY[piece.name] && typeof piece.maxDurability !== 'number') continue;

      const ratio = this.getItemDurabilityRatio(piece);
      if (!lowest || ratio < lowest.ratio) {
        lowest = { ratio, slot: spec.slotIndex, item: piece };
      }
    }
    return lowest;
  }

  /**
   * Finds an XP Bottle (`experience_bottle`) in inventory (preferring hotbar).
   */
  findXpBottle() {
    if (!this.bot || !this.bot.inventory) return null;
    const hotbarStart = this.bot.inventory.hotbarStart || HOTBAR_START;
    const items = this.bot.inventory.items();
    const hotbarXp = items.find(
      (i) => i && i.name === 'experience_bottle' && i.slot >= hotbarStart && i.slot < hotbarStart + 9
    );
    if (hotbarXp) return hotbarXp;
    return items.find((i) => i && i.name === 'experience_bottle') || null;
  }

  /**
   * Throws XP bottles smoothly downward at feet when any worn armor piece drops below
   * `xpMendDurabilityRatio` (default 45%), stopping once repaired to `xpMendStopRatio` (78%)
   * or if health drops below `xpMendMinHealth` (13).
   * Returns true while actively throwing XP bottles.
   */
  tickArmorXpMend(target) {
    if (this.survCfg.xpMendEnabled === false || !this.bot || !this.bot.entity || this.totemEquipInFlight) {
      this.isXpMending = false;
      return false;
    }

    const minHealth = this.survCfg.xpMendMinHealth !== undefined ? this.survCfg.xpMendMinHealth : 13;
    const startRatio = this.survCfg.xpMendDurabilityRatio !== undefined ? this.survCfg.xpMendDurabilityRatio : 0.45;
    const stopRatio = this.survCfg.xpMendStopRatio !== undefined ? this.survCfg.xpMendStopRatio : 0.78;
    const throwIntervalMs = this.survCfg.xpMendThrowIntervalMs !== undefined ? this.survCfg.xpMendThrowIntervalMs : 100;

    const lowest = this.getLowestWornArmorDurability();
    const xpBottle = this.findXpBottle();

    if (!lowest || !xpBottle || this.bot.health < minHealth) {
      this.isXpMending = false;
      return false;
    }

    const dist = (target && target.isValid && target.position)
      ? this.bot.entity.position.distanceTo(target.position)
      : Infinity;

    if (!this.isXpMending) {
      if (lowest.ratio >= startRatio) return false;
      // Don't start XP mending while getting point-blank comboed at moderate HP
      if (dist < 3.0 && this.bot.health < 16) return false;
      this.isXpMending = true;
    } else if (lowest.ratio >= stopRatio || (dist < 2.8 && this.bot.health < 14)) {
      this.isXpMending = false;
      return false;
    }

    // Smoothly pitch down to -90° (-PI/2) and throw XP bottles at feet (paced at throwIntervalMs)
    const aimStatus = this.aimer.stepTowardsAngles(this.bot.entity.yaw, -Math.PI / 2, {
      speedMultiplier: 1.85,
      toleranceRad: 0.16
    });

    this.bot.setControlState('sprint', false);
    this.bot.setControlState('forward', false);
    this.bot.setControlState('back', dist < 4.5);
    this.bot.setControlState('jump', false);

    const ready = this._equipHotbarOrSafe(xpBottle);
    const now = Date.now();
    if (ready && aimStatus.pitchErrorDeg <= 14 && (now - this.lastXpThrowTime) >= throwIntervalMs) {
      this.lastXpThrowTime = now;
      try {
        // Instant throwable item: send use_item only (no bogus block_dig/deactivateItem packet)
        this.bot.activateItem(false);
      } catch (_) {}
    }

    return true;
  }

  /**
   * Prioritizes hotbar Splash Potions of Instant Health II, then Instant Health I / Regeneration /
   * fallback splash potions, checking hotbar first then main inventory.
   */
  findHealingPotion(excludeSlots = new Set()) {
    if (!this.bot.inventory) return null;
    const hotbarStart = this.bot.inventory.hotbarStart || HOTBAR_START;
    const items = this.bot.inventory.items().filter((i) => i && !excludeSlots.has(i.slot));

    const rankOf = (item) => {
      if (item.name !== 'splash_potion') return 0;
      const cls = this._classifyPotion(item);
      let base = 0;
      if (cls === 'heal2') base = 40;
      else if (cls === 'heal1') base = 30;
      else if (cls === 'unknown_splash') base = 25;
      else if (cls === 'regen') base = 15;
      if (base === 0) return 0;
      // Prefer hotbar pots for instant zero-click throwing
      const inHotbar = item.slot >= hotbarStart && item.slot < hotbarStart + 9;
      return base + (inHotbar ? 5 : 0);
    };

    let best = null;
    let bestRank = 0;
    for (const item of items) {
      const r = rankOf(item);
      if (r > bestRank) {
        bestRank = r;
        best = item;
      }
    }
    return best;
  }

  /**
   * Determines whether the current Minecraft protocol sends 0-based effect IDs (>= 1.20.5)
   * or 1-based effect IDs (<= 1.20.4).
   */
  _usesZeroBasedEffectIds() {
    if (!this.bot) return true;
    if (typeof this.bot.version === 'string') {
      const m = this.bot.version.match(/^1\.(\d+)(?:\.(\d+))?/);
      if (m) {
        const minor = parseInt(m[1], 10);
        const patch = m[2] ? parseInt(m[2], 10) : 0;
        if (minor > 20 || (minor === 20 && patch >= 5)) return true;
        return false;
      }
    }
    // Fallback: check if minecraft-data registry itself starts at 0
    if (this.bot.registry && this.bot.registry.effects && this.bot.registry.effects[0]) {
      return true;
    }
    return false;
  }

  /**
   * Maps a protocol status effect ID to our internal buff kind ('swiftness', 'strength', 'fire_res', 'regen', 'turtle_master').
   * Fixes the off-by-1 mismatch where minecraft-data uses 0-based keys even when MC 1.20.4 sends 1-based effect IDs.
   */
  _mapEffectIdToKind(effectId) {
    if (typeof effectId !== 'number') return null;
    const zeroBased = this._usesZeroBasedEffectIds();
    const table = zeroBased ? ZERO_BASED_EFFECT_TO_KIND : ONE_BASED_EFFECT_TO_KIND;
    if (table[effectId]) return table[effectId];

    // Also try registry lookup adjusting for 1-based protocol vs 0-based minecraft-data table
    const regEffects = this.bot && this.bot.registry && this.bot.registry.effects;
    if (regEffects) {
      const registryStartsAtZero = Boolean(regEffects[0] && regEffects[0].name === 'Speed');
      const lookupIdx = (!zeroBased && registryStartsAtZero) ? (effectId - 1) : effectId;
      const reg = regEffects[lookupIdx];
      if (reg) {
        const norm = String((reg.name || '') + ' ' + (reg.displayName || '')).toLowerCase().replace(/[\s_-]+/g, '');
        if (norm.includes('fireresistance')) return 'fire_res';
        if (norm.includes('strength')) return 'strength';
        if (norm.includes('speed') || norm.includes('swiftness')) return 'swiftness';
        if (norm.includes('regeneration')) return 'regen';
        if (norm.includes('resistance')) return 'turtle_master';
      }
    }
    return null;
  }

  _handleEntityEffect(entity, effect) {
    if (!this.bot || !this.bot.entity || !entity || entity.id !== this.bot.entity.id || !effect) return;
    const kind = this._mapEffectIdToKind(effect.id);
    if (!kind) return;

    // effect.duration === -1 means infinite; otherwise duration is in ticks (50ms each)
    const expiresAt = effect.duration < 0
      ? Infinity
      : Date.now() + Math.max(0, effect.duration * 50 - 3000);
    this.activeBuffUntil.set(kind, expiresAt);
  }

  _handleEntityEffectEnd(entity, effect) {
    if (!this.bot || !this.bot.entity || !entity || entity.id !== this.bot.entity.id || !effect) return;
    const kind = this._mapEffectIdToKind(effect.id);
    if (kind) {
      this.activeBuffUntil.delete(kind);
    }
  }

  _handleClearBuffs() {
    this.activeBuffUntil.clear();
  }

  _markBuffApplied(kind) {
    if (!kind) return;
    const durationMs = DEFAULT_BUFF_DURATION_MS[kind] || 80000;
    const targetUntil = Date.now() + durationMs;
    const existing = this.activeBuffUntil.get(kind) || 0;
    if (targetUntil > existing) {
      this.activeBuffUntil.set(kind, targetUntil);
    }
  }

  /**
   * Returns true if buff `kind` ('strength', 'swiftness', 'fire_res', 'regen', 'turtle_master', 'unknown_drink')
   * is currently active with > 3 seconds remaining (checking both tracked expiry timers and `bot.entity.effects`).
   */
  isBuffActive(kind) {
    const now = Date.now();
    const until = this.activeBuffUntil.get(kind);
    if (until && until > now) {
      return true;
    }

    if (!this.bot || !this.bot.entity || !this.bot.entity.effects) return false;
    for (const eff of Object.values(this.bot.entity.effects)) {
      if (!eff) continue;
      if (this._mapEffectIdToKind(eff.id) === kind) {
        // Only treat as active if duration is infinite (-1) or > 60 ticks (> 3 seconds)
        if (eff.duration === undefined || eff.duration < 0 || eff.duration > 60) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Finds a missing combat buff potion (Strength, Swiftness, Fire Resistance, Regeneration, Turtle Master).
   * Never re-drinks or re-splashes a buff that still has remaining duration.
   */
  findNeededBuffPotion() {
    if (!this.bot.inventory || this.survCfg.buffPotionEnabled === false) return null;
    const items = this.bot.inventory.items();
    const allowDrinkable = this.survCfg.drinkablePotionEnabled !== false;

    const wantTypes = [];
    if (!this.isBuffActive('strength')) wantTypes.push('strength');
    if (!this.isBuffActive('swiftness')) wantTypes.push('swiftness');
    if (!this.isBuffActive('fire_res')) wantTypes.push('fire_res');
    if (this.bot.health <= 16 && !this.isBuffActive('regen')) wantTypes.push('regen');
    if (this.bot.health <= 15 && !this.isBuffActive('turtle_master')) wantTypes.push('turtle_master');

    for (const want of wantTypes) {
      const splash = items.find((i) => i.name === 'splash_potion' && this._classifyPotion(i) === want);
      if (splash) return { item: splash, isSplash: true, kind: want };
      if (allowDrinkable) {
        const drink = items.find((i) => i.name === 'potion' && this._classifyPotion(i) === want);
        if (drink) return { item: drink, isSplash: false, kind: want };
      }
    }

    // Fallback: drink unidentified custom buff potion at most once per buff window
    if (allowDrinkable && !this.isBuffActive('unknown_drink')) {
      const customDrink = items.find((i) => i.name === 'potion' && this._classifyPotion(i) === 'unknown_drink');
      if (customDrink && !this.isBuffActive('strength') && !this.isBuffActive('swiftness')) {
        return { item: customDrink, isSplash: false, kind: 'unknown_drink' };
      }
    }
    return null;
  }

  /**
   * Pulls a spare healing splash potion from main inventory (9–35) into hotbar slots 6–8 if hotbar has no healing pots.
   */
  _tryRefillHotbarPot() {
    if (!this.bot.inventory || this.sortingInProgress || this.totemEquipInFlight || this.equipBusy) return;
    if (typeof this.bot.moveSlotItem !== 'function') return;

    const now = Date.now();
    if ((now - this.pendingPotRefillTime) < 600) return;

    const hotbarStart = this.bot.inventory.hotbarStart || HOTBAR_START;
    const items = this.bot.inventory.items();
    const hasHotbarHeal = items.some((i) => {
      if (!i || i.slot < hotbarStart || i.slot >= hotbarStart + 9) return false;
      const cls = this._classifyPotion(i);
      return i.name === 'splash_potion' && (cls === 'heal2' || cls === 'heal1' || cls === 'unknown_splash');
    });
    if (hasHotbarHeal) return;

    const invPot = items.find((i) => {
      if (!i || i.slot >= hotbarStart) return false;
      const cls = this._classifyPotion(i);
      return i.name === 'splash_potion' && (cls === 'heal2' || cls === 'heal1' || cls === 'unknown_splash');
    });
    if (!invPot) return;

    // Pick first empty slot among hotbar 6–8, else slot 8
    let destSlot = hotbarStart + 8;
    for (const idx of [6, 7, 8]) {
      const s = hotbarStart + idx;
      if (!this.bot.inventory.slots || !this.bot.inventory.slots[s]) {
        destSlot = s;
        break;
      }
    }

    this.pendingPotRefillTime = now;
    this.equipBusy = true;
    Promise.resolve(this.bot.moveSlotItem(invPot.slot, destSlot))
      .catch(() => {})
      .finally(() => {
        this.equipBusy = false;
      });
  }

  /**
   * Inline aggressive combat healing & buffing (runs inside ENGAGING without running away!):
   * - If HP <= inlinePotHealthThreshold (13) and splash healing pot exists -> quick pitch -90° & splash while moving!
   * - If missing Strength/Swiftness/FireRes buff and splash buff pot exists -> quick splash at feet!
   * - Refills hotbar healing pots from main inventory when hotbar runs dry.
   * Returns true ONLY for the 2–4 ticks actively throwing a splash potion.
   */
  tickInlineCombatHeal(target) {
    if (!this.bot || !this.bot.entity || this.totemEquipInFlight) return false;
    const now = Date.now();

    const dist = (target && target.isValid && target.position)
      ? this.bot.entity.position.distanceTo(target.position)
      : Infinity;

    // 0. If currently drinking a drinkable potion, walk safely without sprinting (abort only if rushed at low HP)
    if (this.isConsuming && this.isDrinkingPotion) {
      if ((now - this.consumeStartTime) > (this.survCfg.eatTimeoutMs || 3500) || (dist < 3.0 && this.bot.health < 10)) {
        try { this.bot.deactivateItem(); } catch (_) {}
        this.isConsuming = false;
        this.isDrinkingPotion = false;
        return false;
      }
      this._moveAwayWalk(target);
      return true;
    }

    // Continue active quick-splash throw
    if (this.pendingSplashPotion) {
      return this._tickSplashPotionDownward(target, true);
    }

    // Refill empty hotbar pot slots from main inventory passively
    this._tryRefillHotbarPot();

    const potionCooldown = this.survCfg.potionCooldownMs || 450;

    // 1. Inline Instant Health splash (or drinkable heal potion fallback) when HP <= 13
    const inlineThreshold = this.survCfg.inlinePotHealthThreshold || 13;
    if (this.bot.health <= inlineThreshold && (now - this.lastPotionTime) >= potionCooldown) {
      const healPot = this.findHealingPotion();
      if (healPot) {
        this.isXpMending = false;
        this.pendingSplashPotion = healPot;
        this.pendingSplashIsBuff = false;
        this._equipHotbarOrSafe(healPot);
        return this._tickSplashPotionDownward(target, true);
      }

      const drinkHeal = this.findDrinkableHealPotion();
      if (drinkHeal && (dist >= 3.5 || this.bot.health <= 9)) {
        this.isXpMending = false;
        this._startDrinkingPotion(drinkHeal);
        this._moveAwayWalk(target);
        return true;
      }
    }

    // 2. XP Bottle armor mending when any worn armor piece drops below 45% durability
    if (this.tickArmorXpMend(target)) {
      return true;
    }

    // 3. Combat buff potions (Splash OR Drinkable Strength / Swiftness / FireRes / Regen / Turtle Master)
    if ((now - this.lastPotionTime) >= potionCooldown && (now - this.lastBuffAttemptTime) >= 4000 && this.bot.health >= 12) {
      const buff = this.findNeededBuffPotion();
      if (buff) {
        if (buff.isSplash) {
          this.lastBuffAttemptTime = now;
          this.pendingSplashPotion = buff.item;
          this.pendingSplashIsBuff = true;
          this.pendingSplashKind = buff.kind;
          this._equipHotbarOrSafe(buff.item);
          return this._tickSplashPotionDownward(target, true);
        }

        const drinkMinDist = this.survCfg.drinkableBuffMinDist !== undefined ? this.survCfg.drinkableBuffMinDist : 4.2;
        if (this.survCfg.drinkablePotionEnabled !== false && (dist >= drinkMinDist || this.bot.health >= 16)) {
          this.lastBuffAttemptTime = now;
          this._startDrinkingPotion(buff.item, buff.kind);
          this._moveAwayWalk(target);
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Equips an item cleanly ONCE (no overlapping equip calls!) and waits 1 tick (55ms)
   * so held_item_slot / window_click settles before calling bot.consume().
   */
  async _equipSingleForConsume(item) {
    if (!item || !this.bot) return false;
    if (this.bot.heldItem && this.bot.heldItem.type === item.type) {
      return true;
    }

    const hotbarStart = (this.bot.inventory && this.bot.inventory.hotbarStart) || HOTBAR_START;
    if (
      typeof item.slot === 'number' &&
      item.slot >= hotbarStart &&
      item.slot < hotbarStart + 9 &&
      typeof this.bot.setQuickBarSlot === 'function'
    ) {
      const targetIdx = item.slot - hotbarStart;
      if (this.bot.quickBarSlot !== targetIdx) {
        this.bot.setQuickBarSlot(targetIdx);
        await this._sleep(55); // 1-tick settle for Paper/GrimAC packet order
      }
      return true;
    }

    // Main inventory (slots 9–35): single sequential bot.equip without parallel overlap
    if (this.equipBusy) return false;
    this.equipBusy = true;
    try {
      await this.bot.equip(item, 'hand');
      await this._sleep(55);
      return true;
    } catch (_) {
      return false;
    } finally {
      this.equipBusy = false;
    }
  }

  /**
   * Drinks a regular `potion` (Strength, Swiftness, Fire Resistance, Healing, Regen, etc.)
   * cleanly via Mineflayer's `bot.consume()` with single-equip settle, timeout, & retry backoff.
   */
  async _startDrinkingPotion(potionItem, buffKind = null) {
    if (this.isConsuming || this.equipBusy || this.totemEquipInFlight || !potionItem) return;
    if ((Date.now() - this.lastConsumeFailAt) < 500) return;

    this.isConsuming = true;
    this.isDrinkingPotion = true;
    this.consumeStartTime = Date.now();
    this.bot.setControlState('sprint', false);

    const timeoutMs = this.survCfg.eatTimeoutMs || 3500;
    let timeoutHandle = null;

    try {
      const equipped = await this._equipSingleForConsume(potionItem);
      if (!equipped) {
        this.lastConsumeFailAt = Date.now();
        return;
      }

      await Promise.race([
        this.bot.consume(),
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error('drink_timeout')), timeoutMs);
        })
      ]);
      this.lastPotionTime = Date.now();
      if (buffKind) {
        this._markBuffApplied(buffKind);
      }
    } catch (_) {
      this.lastConsumeFailAt = Date.now();
      try { this.bot.deactivateItem(); } catch (_) {}
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      this.isConsuming = false;
      this.isDrinkingPotion = false;
    }
  }

  _equipHotbarOrSafe(item) {
    if (!item) return false;
    if (this.bot.heldItem && this.bot.heldItem.type === item.type) return true;
    const hotbarStart = (this.bot.inventory && this.bot.inventory.hotbarStart) || HOTBAR_START;
    if (
      item.slot >= hotbarStart &&
      item.slot < hotbarStart + 9 &&
      typeof this.bot.setQuickBarSlot === 'function'
    ) {
      const targetIdx = item.slot - hotbarStart;
      if (this.bot.quickBarSlot !== targetIdx) {
        this.bot.setQuickBarSlot(targetIdx);
      }
      return true;
    }
    this._equipSafe(item, 'hand');
    return false;
  }

  /**
   * Finds Enchanted Golden Apple -> Golden Apple specifically.
   */
  findGoldenApple() {
    if (!this.bot.inventory) return null;
    const items = this.bot.inventory.items();
    for (const name of GAPPLE_PRIORITY) {
      const found = items.find((i) => i.name === name);
      if (found) return found;
    }
    return null;
  }

  /**
   * Finds highest-priority edible healing food.
   * At full hunger (food >= 20), only returns always-edible foods (Enchanted/Golden Apples),
   * because vanilla Minecraft refuses regular food at 20 food and hangs until eat timeout.
   */
  findBestHealFood() {
    if (!this.bot.inventory) return null;
    const items = this.bot.inventory.items();
    const canEatNormalFood = typeof this.bot.food !== 'number' || this.bot.food < 20;
    const list = canEatNormalFood ? HEAL_FOOD_PRIORITY : GAPPLE_PRIORITY;
    for (const name of list) {
      const found = items.find((i) => i.name === name);
      if (found) return found;
    }
    return null;
  }

  /**
   * Finds a suitable solid building block for breaking line-of-sight during retreat.
   */
  findLosBuildingBlock() {
    if (!this.bot.inventory) return null;
    return this.bot.inventory.items().find((i) => LOS_BLOCK_NAMES.has(i.name)) || null;
  }

  async _equipSafe(item, destination) {
    if (this.totemEquipInFlight || this.equipBusy || !item) return false;
    this.equipBusy = true;
    try {
      await this.bot.equip(item, destination);
      return true;
    } catch (_) {
      return false;
    } finally {
      this.equipBusy = false;
    }
  }

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

    // Also treat a charged crossbow aimed at us as an immediate ranged threat
    const chargedCrossbow = [mainHand, offHand].some((item) => {
      if (!item || item.name !== 'crossbow') return false;
      const raw = JSON.stringify({ nbt: item.nbt || null, components: item.components || null }).toLowerCase();
      return raw.includes('charged') && (raw.includes('arrow') || raw.includes('firework'));
    });

    return isDrawing || chargedCrossbow;
  }

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
  }

  /**
   * Smart shield controller:
   * Raises offhand shield (`bot.activateItem(true)`) if:
   * - Enemy draws a bow within 12 blocks, OR
   * - Enemy rushes with an axe/sword while our weapon is on cooldown (`weaponCooldownProgress < 0.88`).
   * Returns true while actively blocking so melee combat does not swing concurrently.
   */
  tickShield(target, weaponCooldownProgress = 1.0) {
    if (!this.survCfg.shieldEnabled || this.totemEquipInFlight) {
      this.lowerShield();
      return false;
    }

    const offhand = this.getOffhandItem();
    const hasShield = offhand && offhand.name === 'shield';
    if (!hasShield || !target || !target.isValid || this.isConsuming) {
      this.lowerShield();
      return false;
    }

    const bowThreat = this.isEnemyDrawingBow(target);
    const weaponOnCooldown = weaponCooldownProgress < 0.88;
    const rushThreat = weaponOnCooldown && this.isEnemyRushingMelee(target);
    const shouldRaise = bowThreat || rushThreat;

    const now = Date.now();

    if (this.isShielding) {
      this.shieldTicksRemaining--;
      // Never sprint while shielding (prevents NoSlow flags)
      this.bot.setControlState('sprint', false);

      // Drop shield once threat ends, our weapon is ready (for melee rush), or timer elapses
      const rushFinished = !bowThreat && weaponCooldownProgress >= 0.90;
      if ((!shouldRaise && this.shieldTicksRemaining <= 6) || rushFinished || this.shieldTicksRemaining <= 0) {
        this.lowerShield();
        this.lastShieldEndTime = now;
        return false;
      }
      return true;
    }

    const cooldownMs = this.survCfg.shieldCooldownMs || 1200;
    if (shouldRaise && (bowThreat || (now - this.lastShieldEndTime) >= cooldownMs)) {
      this.bot.setControlState('sprint', false);
      this.bot.activateItem(true); // Offhand shield raise
      this.isShielding = true;
      this.shieldTicksRemaining = this.survCfg.shieldBlockDurationTicks || 12;
      return true;
    }

    return false;
  }

  lowerShield() {
    if (this.isShielding) {
      this.bot.deactivateItem();
      this.isShielding = false;
      this.shieldTicksRemaining = 0;
    }
  }

  stopConsumption() {
    if (this.isConsuming) {
      try { this.bot.deactivateItem(); } catch (_) {}
      this.isConsuming = false;
      this.isDrinkingPotion = false;
    }
    this.isXpMending = false;
    this.pendingSplashPotion = null;
    this.pendingLosBlock = null;
    this.lowerShield();
  }

  /**
   * Smoothly pitches downward to -90° (-PI/2) while moving forward, then throws the queued
   * Splash Potion of Instant Health II so the bot runs straight into its own healing cloud.
   * Returns true while handling the splash sequence.
   */
  _tickSplashPotionDownward(target, inlineCombat = false) {
    if (!this.pendingSplashPotion) return false;

    const desiredYaw = inlineCombat ? this.bot.entity.yaw : this._getAwayYaw(target);
    const targetPitch = -Math.PI / 2; // Exact -90° straight down

    const aimStatus = this.aimer.stepTowardsAngles(desiredYaw, targetPitch, {
      speedMultiplier: 1.8,
      toleranceRad: 0.16
    });

    // Keep moving forward slightly so the bot runs cleanly into its own splash cloud
    this.bot.setControlState('forward', true);
    this.bot.setControlState('back', false);
    this.bot.setControlState('sprint', false);
    this.bot.setControlState('jump', false);

    if (aimStatus.pitchErrorDeg <= 14) {
      const potion = this.pendingSplashPotion;
      const buffKind = this.pendingSplashIsBuff ? this.pendingSplashKind : null;
      this.pendingSplashPotion = null;
      this.pendingSplashIsBuff = false;
      this.pendingSplashKind = null;
      this._throwSplashPotion(potion, buffKind);
    }

    return true;
  }

  _throwSplashPotion(potion, buffKind = null) {
    if (this.totemEquipInFlight || !potion) return;
    const fire = () => {
      try {
        // Instant throwable item: send use_item only (no extra block_dig/deactivateItem packet)
        this.bot.activateItem(false);
        this.lastPotionTime = Date.now();
        if (buffKind) {
          this._markBuffApplied(buffKind);
        }
      } catch (_) {}
    };

    if (this._equipHotbarOrSafe(potion)) {
      fire();
      return;
    }

    this._equipSafe(potion, 'hand')
      .then((ok) => {
        if (ok) fire();
      })
      .catch(() => {});
  }

  async _startEatingFood(food) {
    if (this.isConsuming || this.equipBusy || this.totemEquipInFlight || !food) return;
    if ((Date.now() - this.lastConsumeFailAt) < 500) return;

    // Never attempt to eat normal food at full hunger (vanilla MC rejects it and hangs until timeout)
    const isAlwaysEdible = GAPPLE_PRIORITY.includes(food.name);
    if (!isAlwaysEdible && typeof this.bot.food === 'number' && this.bot.food >= 20) {
      return;
    }

    this.isConsuming = true;
    this.isDrinkingPotion = false;
    this.consumeStartTime = Date.now();
    this.bot.setControlState('sprint', false);

    const timeoutMs = this.survCfg.eatTimeoutMs || 3500;
    let timeoutHandle = null;

    try {
      const equipped = await this._equipSingleForConsume(food);
      if (!equipped) {
        this.lastConsumeFailAt = Date.now();
        return;
      }

      await Promise.race([
        this.bot.consume(),
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error('eat_timeout')), timeoutMs);
        })
      ]);

      if (food.name && food.name.includes('golden_apple')) {
        this.justAteGappleAt = Date.now();
      }
    } catch (_) {
      this.lastConsumeFailAt = Date.now();
      try { this.bot.deactivateItem(); } catch (_) {}
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      this.isConsuming = false;
    }
  }

  _getAwayYaw(target) {
    if (!target || !target.isValid || !this.bot.entity) {
      return this.bot.entity ? this.bot.entity.yaw : 0;
    }
    const awayVec = this.bot.entity.position.minus(target.position);
    return Math.atan2(-awayVec.x, -awayVec.z);
  }

  /**
   * Queues a building block placement directly behind the bot (between bot and pursuer)
   * to break line of sight during retreat.
   */
  _tryQueueLosBlock(target) {
    if (!target || !target.isValid || !this.bot.entity) return false;
    if (this.pendingLosBlock || this.pendingSplashPotion || this.isConsuming) return false;

    const now = Date.now();
    if ((now - this.lastLosBlockTime) < (this.survCfg.losBlockCooldownMs || 950)) return false;

    const dist = this.bot.entity.position.distanceTo(target.position);
    if (dist < 2.5 || dist > 9.0) return false;

    const blockItem = this.findLosBuildingBlock();
    if (!blockItem) return false;

    // Pick a spot ~1.4 blocks behind the bot toward the enemy
    const toTarget = target.position.minus(this.bot.entity.position);
    const len = Math.sqrt(toTarget.x * toTarget.x + toTarget.z * toTarget.z);
    if (len < 0.1) return false;

    const placePos = this.bot.entity.position
      .offset((toTarget.x / len) * 1.4, 0, (toTarget.z / len) * 1.4)
      .floored();
    const refBlock = this.bot.blockAt(placePos.offset(0, -1, 0));
    const targetAir = this.bot.blockAt(placePos);

    if (!refBlock || refBlock.boundingBox !== 'block' || !targetAir || targetAir.name !== 'air') {
      return false;
    }

    this.pendingLosBlock = {
      item: blockItem,
      refPos: refBlock.position,
      aimPos: refBlock.position.offset(0.5, 1.0, 0.5),
      createdAt: now
    };
    this._equipSafe(blockItem, 'hand');
    return true;
  }

  _tickPendingLosBlock() {
    if (!this.pendingLosBlock) return false;

    const action = this.pendingLosBlock;
    if ((Date.now() - action.createdAt) > 900) {
      this.pendingLosBlock = null;
      return false;
    }

    this.bot.setControlState('sprint', false);
    const aimStatus = this.aimer.stepTowardsPoint(action.aimPos, {
      speedMultiplier: 1.25,
      toleranceRad: 0.16
    });

    if (aimStatus.aligned) {
      this.pendingLosBlock = null;
      this._placeLosBlock(action);
    }
    return true;
  }

  async _placeLosBlock(action) {
    if (this.totemEquipInFlight) return;
    try {
      await this.bot.equip(action.item, 'hand');
      const refBlock = this.bot.blockAt(action.refPos);
      if (refBlock && refBlock.boundingBox === 'block') {
        await this.bot.placeBlock(refBlock, new Vec3(0, 1, 0));
        this.lastLosBlockTime = Date.now();
      }
    } catch (_) {
      // Placement blocked by entity
    }
  }

  /**
   * 20-TPS tick handler for RETREATING state (entered when bot.health <= 11):
   * 1. Highest-priority Totem check
   * 2. Throw Splash Potions of Instant Health II downward (pitch = -90°) while moving forward
   * 3. Eat Golden Apple / Enchanted Golden Apple while retreating safely
   * 4. Place blocks behind to break line of sight
   * 5. Smoothly turn 180° away from enemy and sprint-jump with serpentine strafing
   */
  tickRetreating(target) {
    if (this.ensureOffhandSafety()) return;
    this.lowerShield();

    if (!this.bot.entity) return;

    const now = Date.now();

    // 1. Complete any active downward splash healing potion throw while moving forward
    if (this._tickSplashPotionDownward(target)) return;

    // 2. Complete any active line-of-sight block placement behind us
    if (this._tickPendingLosBlock()) return;

    // 3. If currently eating a Golden Apple, keep walking away smoothly (no sprint -> no NoSlow)
    if (this.isConsuming) {
      this._moveAwayWalk(target);
      if ((now - this.consumeStartTime) > (this.survCfg.eatTimeoutMs || 3500)) {
        try { this.bot.deactivateItem(); } catch (_) {}
        this.isConsuming = false;
        this.isDrinkingPotion = false;
      }
      return;
    }

    // 4. Priority Instant Health II splash potion while moving forward
    const potionCooldown = this.survCfg.potionCooldownMs || 450;
    const healPotion = this.findHealingPotion();
    if (
      healPotion &&
      this.bot.health <= (this.survCfg.retreatHealthThreshold || 6) &&
      (now - this.lastPotionTime) >= potionCooldown
    ) {
      this.pendingSplashPotion = healPotion;
      this._equipHotbarOrSafe(healPotion);
      this._tickSplashPotionDownward(target);
      return;
    }

    // 5. Immediately eat a Golden Apple if available (don't wait to run 5.5b away without eating!)
    const gapple = this.findGoldenApple() || this.findBestHealFood();
    if (gapple && !healPotion && this.bot.health < (this.survCfg.safeHealthThreshold || 15)) {
      this._startEatingFood(gapple);
      this._moveAwayWalk(target);
      return;
    }

    // 6. Smooth 180-degree turn away from target & sprint-jump escape
    const awayYaw = this._getAwayYaw(target);
    const aimStatus = this.aimer.stepTowardsAngles(awayYaw, 0.0, { speedMultiplier: 1.25 });

    // 7. Place a block behind to break line of sight when pursued closely
    if (aimStatus.yawErrorDeg < 50 && this._tryQueueLosBlock(target)) {
      return;
    }

    // Serpentine sprint-jump retreat
    this.retreatStrafeTicks--;
    if (this.retreatStrafeTicks <= 0) {
      this.retreatStrafeDir = -this.retreatStrafeDir;
      this.retreatStrafeTicks = 14 + Math.floor(Math.random() * 18);
    }

    if (aimStatus.yawErrorDeg < 50) {
      this.bot.setControlState('forward', true);
      this.bot.setControlState('back', false);
      this.bot.setControlState('sprint', this.bot.food > 6);
      this.bot.setControlState('jump', this.bot.entity.onGround);
      this.bot.setControlState('left', this.retreatStrafeDir < 0);
      this.bot.setControlState('right', this.retreatStrafeDir > 0);
    } else {
      // While completing smooth 180° turn, backpedal briefly without sprinting
      this.bot.setControlState('forward', false);
      this.bot.setControlState('back', true);
      this.bot.setControlState('sprint', false);
      this.bot.setControlState('jump', false);
      this.bot.setControlState('left', false);
      this.bot.setControlState('right', false);
    }
  }

  /**
   * 20-TPS tick handler for HEALING state (used when safe distance is achieved or topping up).
   */
  tickHealing(target) {
    if (this.ensureOffhandSafety()) return;
    this.lowerShield();

    const now = Date.now();

    if (this._tickSplashPotionDownward(target)) return;

    if (this.isConsuming) {
      this._moveAwayWalk(target);
      if ((now - this.consumeStartTime) > (this.survCfg.eatTimeoutMs || 3500)) {
        try { this.bot.deactivateItem(); } catch (_) {}
        this.isConsuming = false;
        this.isDrinkingPotion = false;
      }
      return;
    }

    const potionCooldown = this.survCfg.potionCooldownMs || 450;
    const healPotion = this.findHealingPotion();
    if (
      healPotion &&
      this.bot.health <= (this.survCfg.healHealthThreshold || 11) &&
      (now - this.lastPotionTime) >= potionCooldown
    ) {
      this.pendingSplashPotion = healPotion;
      this._equipHotbarOrSafe(healPotion);
      this._tickSplashPotionDownward(target);
      return;
    }

    const drinkHeal = this.findDrinkableHealPotion();
    if (
      drinkHeal &&
      this.bot.health <= (this.survCfg.healHealthThreshold || 11) &&
      (now - this.lastPotionTime) >= potionCooldown
    ) {
      this._startDrinkingPotion(drinkHeal);
      this._moveAwayWalk(target);
      return;
    }

    const food = this.findGoldenApple() || this.findBestHealFood();
    if (food) {
      this._startEatingFood(food);
      this._moveAwayWalk(target);
      return;
    }

    this._moveAwayWalk(target);
  }

  _moveAwayWalk(target) {
    if (!target || !target.isValid || !this.bot.entity) {
      this.bot.setControlState('forward', false);
      this.bot.setControlState('back', false);
      this.bot.setControlState('left', false);
      this.bot.setControlState('right', false);
      this.bot.setControlState('sprint', false);
      this.bot.setControlState('jump', false);
      return;
    }

    const awayYaw = this._getAwayYaw(target);
    this.aimer.stepTowardsAngles(awayYaw, 0.05);
    const yawDiff = Math.abs(normalizeAngle(awayYaw - this.bot.entity.yaw));

    this.bot.setControlState('sprint', false);
    this.bot.setControlState('jump', false);
    this.bot.setControlState('back', false);
    this.bot.setControlState('forward', yawDiff < Math.PI / 2.2);
    this.bot.setControlState('left', false);
    this.bot.setControlState('right', false);
  }

  /**
   * Scores an armor item by material tier + protection enchantments.
   */
  scoreArmorItem(item) {
    if (!item || !item.name) return -1;
    let score = 0;

    for (const [material, base] of Object.entries(ARMOR_MATERIAL_SCORE)) {
      if (item.name.startsWith(material + '_')) {
        score = base;
        break;
      }
    }
    if (score === 0) return -1;

    // Inspect enchantments across legacy NBT and 1.20.5+ item components
    const raw = JSON.stringify({ nbt: item.nbt || null, components: item.components || null }).toLowerCase();
    const protMatch = raw.match(/protection[^0-9]{0,20}(\d+)/);
    if (protMatch) {
      score += Math.min(5, parseInt(protMatch[1], 10)) * 6;
    } else if (raw.includes('protection')) {
      score += 8;
    }
    if (raw.includes('unbreaking')) score += 2;
    if (raw.includes('thorns')) score += 1;

    return score;
  }

  /**
   * Equips the highest-protection armor piece for each slot (head, torso, legs, feet).
   * Always yields immediately if a Totem swap is required.
   */
  async equipBestArmor() {
    if (!this.bot || !this.bot.inventory) return;
    if (this.ensureTotemPriority()) return;

    const clickDelayMs = this.survCfg.inventoryClickDelayMs !== undefined ? this.survCfg.inventoryClickDelayMs : 120;
    const allItems = this.bot.inventory.items();
    let consecutiveFailures = 0;

    for (const spec of ARMOR_SLOTS) {
      if (this.needsTotemSwap() || this.totemEquipInFlight) {
        this.ensureTotemPriority();
        return;
      }
      if (consecutiveFailures >= 2) return; // Inventory likely locked (e.g. lobby)

      const worn = this.bot.inventory.slots ? this.bot.inventory.slots[spec.slotIndex] : null;
      let bestItem = worn;
      let bestScore = worn ? this.scoreArmorItem(worn) : -1;

      for (const item of allItems) {
        if (!item || !item.name) continue;
        const matchesSlot = item.name.endsWith(spec.suffix) || spec.extra.includes(item.name);
        if (!matchesSlot) continue;

        const score = this.scoreArmorItem(item);
        if (score > bestScore) {
          bestScore = score;
          bestItem = item;
        }
      }

      if (bestItem && bestItem !== worn) {
        try {
          await this.bot.equip(bestItem, spec.dest);
          const after = this.bot.inventory.slots ? this.bot.inventory.slots[spec.slotIndex] : null;
          if (after && after.name === bestItem.name) {
            consecutiveFailures = 0;
          } else {
            consecutiveFailures++;
          }
        } catch (_) {
          consecutiveFailures++;
        }
        if (clickDelayMs > 0) await this._sleep(clickDelayMs);
      }
    }
  }

  /**
   * Organizes hotbar slots 0–8 (inventory slots 36–44) on spawn / kit pickup:
   * - Slot 0 (36): Sword
   * - Slot 1 (37): Axe
   * - Slot 2 (38): Golden Apples
   * - Slot 3 (39): Ender Pearls
   * - Slot 4 (40): Bow / Crossbow
   * - Slot 5 (41): Cobwebs / Water Bucket
   * - Slots 6–8 (42–44): Healing Potions
   * Yields immediately if a Totem swap is needed.
   */
  async sortHotbar() {
    if (!this.survCfg.autoSortHotbar || !this.bot || !this.bot.inventory) return;
    if (this.sortingInProgress || this.totemEquipInFlight) return;
    if (typeof this.bot.moveSlotItem !== 'function') return;

    this.sortingInProgress = true;
    const hotbarStart = this.bot.inventory.hotbarStart || HOTBAR_START;
    const offhandSlot = this._getOffhandSlotIndex();
    const claimedSlots = new Set([offhandSlot]);

    const findByPriority = (names) => {
      const items = this.bot.inventory.items().filter((i) => !claimedSlots.has(i.slot));
      for (const name of names) {
        const match = items.find((i) => i.name === name);
        if (match) return match;
      }
      return null;
    };

    const layoutPlan = [
      { quickbarIndex: 0, picker: () => findByPriority(SWORD_PRIORITY) },
      { quickbarIndex: 1, picker: () => findByPriority(AXE_PRIORITY) },
      { quickbarIndex: 2, picker: () => findByPriority(GAPPLE_PRIORITY) },
      { quickbarIndex: 3, picker: () => findByPriority(['ender_pearl']) },
      { quickbarIndex: 4, picker: () => findByPriority(['bow', 'crossbow']) },
      { quickbarIndex: 5, picker: () => findByPriority(['cobweb', 'water_bucket']) },
      { quickbarIndex: 6, picker: () => this.findHealingPotion(claimedSlots) },
      { quickbarIndex: 7, picker: () => this.findHealingPotion(claimedSlots) },
      { quickbarIndex: 8, picker: () => this.findHealingPotion(claimedSlots) }
    ];

    const clickDelayMs = this.survCfg.inventoryClickDelayMs !== undefined ? this.survCfg.inventoryClickDelayMs : 120;
    let consecutiveFailures = 0;

    try {
      for (const rule of layoutPlan) {
        // Totem priority always preempts hotbar sorting
        if (this.needsTotemSwap() || this.totemEquipInFlight) {
          this.ensureTotemPriority();
          return;
        }
        if (consecutiveFailures >= 2) {
          // Abort sorting if server rejects/reverts clicks (locked lobby inventory)
          return;
        }

        const destSlot = hotbarStart + rule.quickbarIndex;
        const chosen = rule.picker();
        if (!chosen) continue;

        if (chosen.slot !== destSlot) {
          try {
            await this.bot.moveSlotItem(chosen.slot, destSlot);
            const placed = this.bot.inventory.slots ? this.bot.inventory.slots[destSlot] : null;
            if (placed && placed.name === chosen.name) {
              consecutiveFailures = 0;
            } else {
              consecutiveFailures++;
            }
          } catch (_) {
            consecutiveFailures++;
          }
          if (clickDelayMs > 0) await this._sleep(clickDelayMs);
        }
        claimedSlots.add(destSlot);
      }
    } finally {
      this.sortingInProgress = false;
    }
  }

  /**
   * Full gear-up sequence for spawn, respawn, and !kit pickup:
   * 1. Totem / Offhand safety
   * 2. Highest-protection Armor equip
   * 3. Hotbar auto-sort (Slots 0–8)
   */
  async autoEquipAndSort() {
    this.ensureOffhandSafety();
    if (this.totemEquipPromise) {
      await this.totemEquipPromise;
    }
    await this.equipBestArmor();
    await this.sortHotbar();
    this.ensureOffhandSafety();
    if (this.totemEquipPromise) {
      await this.totemEquipPromise;
    }
  }
}

module.exports = { SurvivalModule, OFFHAND_SLOT, HOTBAR_START };
