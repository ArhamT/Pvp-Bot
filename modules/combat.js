'use strict';

const { Vec3 } = require('vec3');
const { getAttackSpeed } = require('mineflayer-pvp');
const { goals } = require('mineflayer-pathfinder');
const { normalizeAngle } = require('./aim');
const {
  SWORD_PRIORITY,
  AXE_PRIORITY,
  isSpearItem,
  getItemMetadataText,
  findOverlappingBlock,
  inspectColumnStep
} = require('./constants');
const { executeAttributeSwapAttack } = require('./mace_elytra');

const ATTACK_SPEED_OVERRIDES = {
  mace: 0.6,
  trident: 1.1
};

/**
 * High-tier 1.9+ PvP melee combat module:
 * 1. Dynamic spacing (2.7–2.95b optimal reach, >3.2b sprint-jump chase, <2.2b strafe-backpedal)
 *    with unpredictable A/D circle-strafing (micro-direction changes every 400–900ms)
 *    and multi-tick predictive intersection aiming/spacing via PredictionModule.
 * 2. Event-driven sprint-resetting (W-Tap / S-Tap) on target `entityHurt` (1–2 ticks / 50–100ms)
 *    and 1-tick Jump-Resetting on bot `entityHurt` to cancel grounded melee knockback.
 * 3. Hit-Selecting via `entitySwingArm` tracking to delay 1–2 ticks on neutral simultaneous trades,
 *    absorb the hit (with jump-reset), and counter-swing during opponent cooldown.
 * 4. Accurate 1.9+ weapon cooldown tracking (>=95% general, 100% axe crits) and
 *    smart falling critical hits (strictly when velocity.y < -0.08).
 * 5. Hotbar enchantment scanning (1.20.5+ components & legacy NBT) for Breach Maces (I–IV)
 *    and sequential 3-tick Ground Breach Swapping against Diamond/Netherite opponents.
 * 6. Shield detection & hotbar Axe shield-breaking with immediate next-tick Sword swap-back.
 */
class CombatModule {
  constructor(bot, config, aimer, hazardChecker = null, prediction = null) {
    this.bot = bot;
    this.config = config;
    this.combatCfg = config.combat;
    this.aimer = aimer;
    this.hazardChecker = hazardChecker;
    this.prediction = prediction;

    this.activeTarget = null;

    // 1.9+ attack cooldown state (resets on swing AND held item change)
    this.cooldownResetTime = 0;
    this.lastSwingTime = 0;
    this.lastHeldSlot = bot.quickBarSlot;
    this.lastHeldType = bot.heldItem ? bot.heldItem.type : null;

    // Sprint-reset (W-Tap / S-Tap) state
    this.sprintResetTicksRemaining = 0;
    this.sprintResetMode = 'w-tap'; // 'w-tap' | 's-tap'
    this.reengageSprintNextTick = false;

    // Jump-reset state (1-tick micro-jump synchronized with forward sprint on bot melee hurt)
    this.jumpResetActive = false;
    this.jumpResetReleaseNextTick = false;
    this.jumpResetTriggeredAt = 0;

    // Hit-selecting state (delay 1–2 ticks on neutral exchange when opponent swings first)
    this.targetLastSwingTime = 0;
    this.lastSwingByEntityId = new Map();
    this.hitSelectState = 'IDLE'; // 'IDLE' | 'DELAYING' | 'COUNTER_READY'
    this.hitSelectDelayTicks = 0;
    this.hitSelectCounterWindowUntil = 0;
    this.lastHitSelectTriggerTime = 0;

    // Hotbar weapon & Mace enchantment slots (0–8, or -1 if absent)
    this.breachMaceSlot = -1;
    this.breachLevel = 0;
    this.windBurstMaceSlot = -1;
    this.windBurstLevel = 0;
    this.densityMaceSlot = -1;
    this.densityLevel = 0;
    this.maceSlot = -1;
    this.swordSlot = -1;
    this.axeSlot = -1;

    // Sequential 3-tick Ground Breach Swap state machine
    // IDLE -> (Tick N: swap to breachMaceSlot) SWAPPED_TO_MACE
    //      -> (Tick N+1: bot.attack) SWAP_BACK_PENDING
    //      -> (Tick N+2: swap back to swordSlot) IDLE
    this.breachSwapState = 'IDLE';
    this.breachSwapTicksRemaining = 0;
    this.breachSwappedAt = 0;
    this.spearSlot = -1;
    this.lastSpearLungeTime = 0;
    this.spearLungeTimer = null;

    // Target telemetry for smart crits & W-tap confirmation
    this.targetLastHurtTime = 0;
    this.botLastDamagedTime = 0;
    this.botLastHurtTime = 0;
    this.lastKnownBotHealth = typeof bot.health === 'number' ? bot.health : 20;

    // Dynamic circle-strafe state (400–900ms randomized direction flips)
    this.strafeDirection = Math.random() < 0.5 ? -1 : 1; // -1 = left (A), 1 = right (D)
    this.nextStrafeSwitchAt = this._scheduleNextStrafeSwitch();
    this.strafePauseTicks = 0;

    // Critical hit jump state
    this.critInProgress = false;

    // Shield-break & hotbar swap-back state
    this.shieldBreakActive = false;
    this.swapBackToSwordNextTick = false;
    this.targetShieldDisabledUntil = 0;
    this.equipBusy = false;

    // Pathfinder state tracking (only used when tall obstacles block direct approach)
    this.usingPathfinder = false;
    this.lastPathGoalPos = null;
    this.pathfinderStuckTicks = 0;
    this.lastBotCheckPos = null;
    this.pathfinderDisabledUntil = 0;

    // Bind event listeners for hit registration, damage tracking, opponent swings, & hotbar updates
    this._onEntityHurt = this._handleEntityHurt.bind(this);
    this._onHealthChange = this._handleHealthChange.bind(this);
    this._onEntitySwingArm = this._handleEntitySwingArm.bind(this);
    this._onInventoryUpdateSlot = this._handleInventoryUpdateSlot.bind(this);

    if (typeof this.bot.on === 'function') {
      this.bot.on('entityHurt', this._onEntityHurt);
      this.bot.on('health', this._onHealthChange);
      this.bot.on('entitySwingArm', this._onEntitySwingArm);
    }
    if (this.bot.inventory && typeof this.bot.inventory.on === 'function') {
      this.bot.inventory.on('updateSlot', this._onInventoryUpdateSlot);
    }

    // Initial hotbar scan for swords, axes, maces, and Breach enchantment levels
    this.scanHotbarSlots();
  }

  /**
   * Unbinds bot and inventory event listeners cleanly (called on disconnect / teardown).
   */
  dispose() {
    if (this.bot && typeof this.bot.removeListener === 'function') {
      this.bot.removeListener('entityHurt', this._onEntityHurt);
      this.bot.removeListener('health', this._onHealthChange);
      this.bot.removeListener('entitySwingArm', this._onEntitySwingArm);
    }
    if (this.bot && this.bot.inventory && typeof this.bot.inventory.removeListener === 'function') {
      this.bot.inventory.removeListener('updateSlot', this._onInventoryUpdateSlot);
    }
    this.cancelSpearLunge();
    this.stopMovement();
  }

  /**
   * Cancels any queued delayed Spear deactivateItem() timer safely.
   */
  cancelSpearLunge() {
    if (this.spearLungeTimer) {
      clearTimeout(this.spearLungeTimer);
      this.spearLungeTimer = null;
    }
  }

  /**
   * Attaches or replaces the multi-tick trajectory predictor (PredictionModule).
   */
  setPrediction(prediction) {
    this.prediction = prediction;
  }

  /**
   * Returns currently detected hotbar weapon indices (0–8, or -1 if absent) and Breach level.
   */
  getHotbarSlots() {
    return {
      breachMaceSlot: this.breachMaceSlot,
      breachLevel: this.breachLevel,
      windBurstMaceSlot: this.windBurstMaceSlot,
      windBurstLevel: this.windBurstLevel,
      densityMaceSlot: this.densityMaceSlot,
      densityLevel: this.densityLevel,
      maceSlot: this.maceSlot,
      swordSlot: this.swordSlot,
      axeSlot: this.axeSlot,
      spearSlot: this.spearSlot
    };
  }

  _isSpearItem(item) {
    return isSpearItem(item);
  }

  _itemHasAnyEnchants(item) {
    if (!item) return false;
    if (Array.isArray(item.enchants) && item.enchants.length > 0) return true;
    if (item.nbt && getItemMetadataText(item).includes('enchant')) return true;
    if (item.componentMap instanceof Map) {
      if (item.componentMap.has('enchantments') || item.componentMap.has('minecraft:enchantments')) return true;
    }
    if (Array.isArray(item.components)) {
      if (item.components.some((c) => c && String(c.type || c.name || '').toLowerCase().includes('enchant'))) return true;
    }
    return false;
  }

  _handleInventoryUpdateSlot(slot) {
    const hotbarStart = (this.bot.inventory && this.bot.inventory.hotbarStart) || 36;
    if (slot === undefined || (slot >= hotbarStart && slot < hotbarStart + 9)) {
      this.scanHotbarSlots();
    }
  }

  _getInventorySlotItem(slotIndex) {
    if (!this.bot.inventory) return null;
    if (Array.isArray(this.bot.inventory.slots) && this.bot.inventory.slots[slotIndex]) {
      return this.bot.inventory.slots[slotIndex];
    }
    if (typeof this.bot.inventory.items === 'function') {
      return this.bot.inventory.items().find((i) => i && i.slot === slotIndex) || null;
    }
    return null;
  }

  /**
   * Extracts an enchantment level (e.g. 'breach' levels 1–4) from an item across:
   * - prismarine-item `item.enchants`
   * - MC 1.20.5+ `item.components` (Array, Map, or plain object) & `item.componentMap`
   * - Legacy `item.nbt` (`Enchantments` / `ench` compound lists)
   */
  _getEnchantmentLevel(item, enchantName) {
    if (!item) return 0;
    const target = String(enchantName).toLowerCase();
    const targetNs = `minecraft:${target}`;
    let bestLevel = 0;

    const matchesName = (raw) => {
      if (typeof raw !== 'string') return false;
      const lower = raw.toLowerCase();
      return lower === target || lower === targetNs;
    };

    const unwrapNbt = (val) => {
      let cur = val;
      while (cur && typeof cur === 'object' && 'value' in cur && !Array.isArray(cur)) {
        cur = cur.value;
      }
      return cur;
    };

    const inspectEnchantContainer = (container) => {
      if (!container) return;
      const unwrapped = unwrapNbt(container);
      if (!unwrapped) return;

      if (Array.isArray(unwrapped)) {
        for (const entry of unwrapped) {
          if (!entry || typeof entry !== 'object') continue;
          const id = unwrapNbt(entry.id !== undefined ? entry.id : entry.name);
          if (matchesName(id)) {
            const lvl = Number(unwrapNbt(entry.level !== undefined ? entry.level : entry.lvl) || 0);
            if (lvl > bestLevel) bestLevel = lvl;
          }
        }
        return;
      }

      if (unwrapped instanceof Map) {
        for (const [key, val] of unwrapped.entries()) {
          if (matchesName(key)) {
            const lvl = Number(unwrapNbt(val) || 0);
            if (lvl > bestLevel) bestLevel = lvl;
          }
        }
        return;
      }

      if (typeof unwrapped === 'object') {
        if (unwrapped.levels) inspectEnchantContainer(unwrapped.levels);
        if (unwrapped.enchantments) inspectEnchantContainer(unwrapped.enchantments);
        for (const [key, val] of Object.entries(unwrapped)) {
          if (matchesName(key)) {
            const lvl = Number(unwrapNbt(val) || 0);
            if (lvl > bestLevel) bestLevel = lvl;
          }
        }
      }
    };

    // 1. prismarine-item normalized `item.enchants`
    if (Array.isArray(item.enchants)) {
      inspectEnchantContainer(item.enchants);
    }

    // 2. MC 1.20.5+ `item.components` & `item.componentMap`
    const inspectComponents = (comps) => {
      if (!comps) return;
      if (Array.isArray(comps)) {
        for (const comp of comps) {
          if (!comp || typeof comp !== 'object') continue;
          const type = String(comp.type || comp.name || '').toLowerCase();
          if (
            type === 'enchantments' ||
            type === 'minecraft:enchantments' ||
            type === 'stored_enchantments' ||
            type === 'minecraft:stored_enchantments'
          ) {
            inspectEnchantContainer(comp.data !== undefined ? comp.data : comp.value);
          }
        }
      } else if (comps instanceof Map) {
        for (const key of ['enchantments', 'minecraft:enchantments', 'stored_enchantments', 'minecraft:stored_enchantments']) {
          const entry = comps.get(key);
          if (entry) inspectEnchantContainer(entry.data !== undefined ? entry.data : entry);
        }
      } else if (typeof comps === 'object') {
        for (const key of ['enchantments', 'minecraft:enchantments', 'stored_enchantments', 'minecraft:stored_enchantments']) {
          if (comps[key]) {
            const entry = comps[key];
            inspectEnchantContainer(entry.data !== undefined ? entry.data : entry);
          }
        }
      }
    };

    if (item.components) inspectComponents(item.components);
    if (item.componentMap) inspectComponents(item.componentMap);

    // 3. Legacy MC <= 1.20.4 `item.nbt`
    if (item.nbt) {
      const nbtRoot = unwrapNbt(item.nbt);
      if (nbtRoot && typeof nbtRoot === 'object') {
        if (nbtRoot.Enchantments) inspectEnchantContainer(nbtRoot.Enchantments);
        if (nbtRoot.ench) inspectEnchantContainer(nbtRoot.ench);
        if (nbtRoot.StoredEnchantments) inspectEnchantContainer(nbtRoot.StoredEnchantments);
      }
    }

    return bestLevel;
  }

  /**
   * Scans hotbar slots 36..44 for Swords, Axes, Maces, and Breach-enchanted Maces (levels I–IV).
   */
  scanHotbarSlots() {
    this.breachMaceSlot = -1;
    this.breachLevel = 0;
    this.windBurstMaceSlot = -1;
    this.windBurstLevel = 0;
    this.densityMaceSlot = -1;
    this.densityLevel = 0;
    this.maceSlot = -1;
    this.swordSlot = -1;
    this.axeSlot = -1;
    this.spearSlot = -1;

    if (!this.bot || !this.bot.inventory) {
      return this.getHotbarSlots();
    }

    const hotbarStart = this.bot.inventory.hotbarStart || 36;
    const hotbarEntries = [];
    const seenSlots = new Set();

    if (Array.isArray(this.bot.inventory.slots)) {
      for (let slot = hotbarStart; slot < hotbarStart + 9; slot++) {
        const item = this.bot.inventory.slots[slot];
        if (item) {
          hotbarEntries.push({ item, hotbarIndex: slot - hotbarStart });
          seenSlots.add(slot);
        }
      }
    }

    if (typeof this.bot.inventory.items === 'function') {
      for (const item of this.bot.inventory.items()) {
        if (item && item.slot >= hotbarStart && item.slot < hotbarStart + 9 && !seenSlots.has(item.slot)) {
          hotbarEntries.push({ item, hotbarIndex: item.slot - hotbarStart });
          seenSlots.add(item.slot);
        }
      }
    }

    let bestSwordRank = Infinity;
    let bestAxeRank = Infinity;
    let enchantedMaceFallback = -1;

    for (const { item, hotbarIndex } of hotbarEntries) {
      if (!item || !item.name) continue;
      const name = item.name;

      const swordRank = SWORD_PRIORITY.indexOf(name);
      if (swordRank !== -1 && swordRank < bestSwordRank) {
        bestSwordRank = swordRank;
        this.swordSlot = hotbarIndex;
      }

      const axeRank = AXE_PRIORITY.indexOf(name);
      if (axeRank !== -1 && axeRank < bestAxeRank) {
        bestAxeRank = axeRank;
        this.axeSlot = hotbarIndex;
      }

      if (this._isSpearItem(item) && this.spearSlot === -1) {
        this.spearSlot = hotbarIndex;
      }

      if (name === 'mace') {
        if (this.maceSlot === -1) {
          this.maceSlot = hotbarIndex;
        }
        const breachLvl = this._getEnchantmentLevel(item, 'breach');
        if (breachLvl >= 1 && breachLvl > this.breachLevel) {
          this.breachLevel = Math.min(4, breachLvl);
          this.breachMaceSlot = hotbarIndex;
          this.maceSlot = hotbarIndex;
        }
        const windBurstLvl = this._getEnchantmentLevel(item, 'wind_burst');
        if (windBurstLvl >= 1 && windBurstLvl > this.windBurstLevel) {
          this.windBurstLevel = Math.min(3, windBurstLvl);
          this.windBurstMaceSlot = hotbarIndex;
          if (this.maceSlot === -1) this.maceSlot = hotbarIndex;
        }
        const densityLvl = this._getEnchantmentLevel(item, 'density');
        if (densityLvl >= 1 && densityLvl > this.densityLevel) {
          this.densityLevel = Math.min(5, densityLvl);
          this.densityMaceSlot = hotbarIndex;
          if (this.maceSlot === -1) this.maceSlot = hotbarIndex;
        }
        if (enchantedMaceFallback === -1 && this._itemHasAnyEnchants(item)) {
          enchantedMaceFallback = hotbarIndex;
        }
      }
    }

    // MC 1.21+ fallback: if enchantments are encoded as numeric registry IDs, still allow breach/wind-burst mace use
    if (this.breachMaceSlot === -1 && enchantedMaceFallback !== -1) {
      this.breachMaceSlot = enchantedMaceFallback;
      this.breachLevel = 1;
    }

    return this.getHotbarSlots();
  }

  /**
   * Returns true if the target is wearing heavy/medium armor (Diamond/Netherite/Iron),
   * or if equipment packets haven't synced yet in an armored duel kit.
   */
  isTargetHeavilyArmored(target) {
    if (!target) return false;
    if (!Array.isArray(target.equipment) || target.equipment.length === 0) return true;

    let anyEquipmentKnown = false;
    let armorPieces = 0;
    let hasHeavyCore = false;

    for (const item of target.equipment) {
      if (!item || typeof item.name !== 'string') continue;
      anyEquipmentKnown = true;
      const name = item.name.toLowerCase();
      const isArmoredMaterial = name.startsWith('diamond_') ||
        name.startsWith('netherite_') ||
        name.startsWith('iron_');
      const isArmorPiece = name.endsWith('_helmet') ||
        name.endsWith('_chestplate') ||
        name.endsWith('_leggings') ||
        name.endsWith('_boots');

      if (isArmoredMaterial && isArmorPiece) {
        armorPieces++;
        if (name.endsWith('_chestplate') || name.endsWith('_leggings')) {
          hasHeavyCore = true;
        }
      }
    }

    if (!anyEquipmentKnown) return true;
    return armorPieces >= 1 || hasHeavyCore;
  }

  _scheduleNextStrafeSwitch() {
    const minMs = this.combatCfg.strafeSwitchMinMs || 400;
    const maxMs = this.combatCfg.strafeSwitchMaxMs || 900;
    return Date.now() + minMs + Math.random() * (maxMs - minMs);
  }

  /**
   * Tracks when the bot takes damage (used to determine health-advantage crits).
   */
  _handleHealthChange() {
    if (typeof this.bot.health !== 'number') return;
    if (this.bot.health < this.lastKnownBotHealth) {
      this.botLastDamagedTime = Date.now();
    }
    this.lastKnownBotHealth = this.bot.health;
  }

  /**
   * Checks whether bot and opponent are entering 3.0-block reach simultaneously at neutral
   * velocity (both grounded, neither combo-locked) for Hit-Selecting.
   */
  _isNeutralSimultaneousExchange(target, now = Date.now()) {
    if (!this.bot.entity || !target || !target.isValid || !target.position) return false;

    const reach = this.combatCfg.reach || 3.0;
    const reachDist = this.getReachDistance(target);
    if (reachDist > reach) return false;

    // Both bot and opponent must be grounded
    if (!this.bot.entity.onGround) return false;
    let targetGrounded = true;
    if (typeof target.onGround === 'boolean') {
      targetGrounded = target.onGround;
    } else if (this.prediction && typeof this.prediction.getTargetKinematics === 'function') {
      const kin = this.prediction.getTargetKinematics(target);
      targetGrounded = kin ? Boolean(kin.onGround) : true;
    } else if (target.velocity) {
      targetGrounded = Math.abs(target.velocity.y) < 0.08;
    }
    if (!targetGrounded) return false;

    // Neutral vertical velocity (neither launched into a combo arc)
    const botVy = this.bot.entity.velocity ? this.bot.entity.velocity.y : 0;
    const targetVy = target.velocity ? target.velocity.y : 0;
    if (Math.abs(botVy) > 0.12 || Math.abs(targetVy) > 0.12) return false;

    // Neither player currently combo-locked, and bot did not swing first
    if ((now - this.targetLastHurtTime) <= 550) return false;
    if ((now - this.botLastDamagedTime) <= 550) return false;
    if ((now - this.botLastHurtTime) <= 550) return false;
    if ((now - this.lastSwingTime) <= 250) return false;

    return true;
  }

  /**
   * Tracks opponent arm swings for Hit-Selecting.
   */
  _handleEntitySwingArm(entity) {
    if (!entity || entity.id === undefined) return;
    if (this.bot.entity && entity.id === this.bot.entity.id) return;

    const now = Date.now();
    this.lastSwingByEntityId.set(entity.id, now);

    if (!this.activeTarget || entity.id !== this.activeTarget.id) return;
    this.targetLastSwingTime = now;

    if (!this.combatCfg.enableHitSelect) return;
    if (this.hitSelectState !== 'IDLE' || this.shieldBreakActive) return;
    if ((now - this.lastHitSelectTriggerTime) < 600) return;

    if (this._isNeutralSimultaneousExchange(this.activeTarget, now)) {
      const minTicks = this.combatCfg.hitSelectDelayMinTicks || 1;
      const maxTicks = this.combatCfg.hitSelectDelayMaxTicks || 2;
      this.hitSelectDelayTicks = minTicks + Math.floor(Math.random() * (maxTicks - minTicks + 1));
      this.hitSelectState = 'DELAYING';
      this.lastHitSelectTriggerTime = now;
    }
  }

  /**
   * Handles `entityHurt`:
   * 1. When the bot itself takes grounded melee knockback within 5.0 blocks of target,
   *    executes a 1-tick Jump-Reset synchronized with forward sprint to cancel horizontal KB.
   * 2. When the target takes a registered hit from our melee swing, triggers W-Tap / S-Tap.
   */
  _handleEntityHurt(entity) {
    if (!entity || !this.bot.entity) return;

    const now = Date.now();

    // --- Bot took damage/knockback: 1-tick Jump-Reset ---
    if (entity.id === this.bot.entity.id) {
      this.botLastDamagedTime = now;
      this.botLastHurtTime = now;

      if (
        this.combatCfg.jumpResetEnabled &&
        this.bot.entity.onGround &&
        this.activeTarget &&
        this.activeTarget.isValid &&
        this.activeTarget.position
      ) {
        const dist = this.bot.entity.position.distanceTo(this.activeTarget.position);
        if (dist <= 5.0) {
          this.jumpResetActive = true;
          this.jumpResetTriggeredAt = now;
          this.jumpResetReleaseNextTick = true;

          // Cancel any active sprint-reset backpedal so forward momentum counters knockback
          this.sprintResetTicksRemaining = 0;
          this.reengageSprintNextTick = false;

          this.bot.setControlState('back', false);
          this.bot.setControlState('forward', true);
          this.bot.setControlState('sprint', true);
          this.bot.setControlState('jump', true);
        }
      }
      return;
    }

    if (!this.activeTarget || entity.id !== this.activeTarget.id) return;

    this.targetLastHurtTime = now;

    // Confirm this hurt event corresponds to our recent melee hit
    if (!this.combatCfg.wTapEnabled) return;
    if ((now - this.lastSwingTime) > 400) return;
    if (!this.bot.entity.onGround) return;
    if (this.shieldBreakActive) return;

    const minTicks = this.combatCfg.wTapMinTicks || 1;
    const maxTicks = this.combatCfg.wTapMaxTicks || 2;
    const resetTicks = minTicks + Math.floor(Math.random() * (maxTicks - minTicks + 1));

    const reachDist = this.getReachDistance(this.activeTarget);
    const sTapThreshold = this.combatCfg.sTapMaxDistance || 2.65;

    this.sprintResetMode = reachDist <= sTapThreshold ? 's-tap' : 'w-tap';
    this.sprintResetTicksRemaining = resetTicks;
    this.reengageSprintNextTick = true;

    // Immediately drop sprint on hit registration
    this.bot.setControlState('sprint', false);
    this.bot.setControlState('forward', false);
    if (this.sprintResetMode === 's-tap') {
      this.bot.setControlState('back', true);
    }
  }

  /**
   * Finds the highest-tier item matching `priorityList`, strongly preferring hotbar slots (36–44)
   * for instant, zero-window-click swaps.
   */
  _findBestWeaponItem(priorityList) {
    if (!this.bot.inventory) return null;
    const hotbarStart = this.bot.inventory.hotbarStart || 36;
    const items = this.bot.inventory.items();

    // Pass 1: Hotbar slots first
    for (const name of priorityList) {
      const hotbarItem = items.find(
        (item) => item.name === name && item.slot >= hotbarStart && item.slot < hotbarStart + 9
      );
      if (hotbarItem) return { item: hotbarItem, hotbarIndex: hotbarItem.slot - hotbarStart };
    }

    // Pass 2: Main inventory fallback
    for (const name of priorityList) {
      const invItem = items.find((item) => item.name === name);
      if (invItem) return { item: invItem, hotbarIndex: -1 };
    }

    return null;
  }

  /**
   * Fast weapon swap: uses `setQuickBarSlot` directly when item is in the hotbar,
   * otherwise falls back to async `bot.equip(item, 'hand')`.
   */
  _equipFast(selection) {
    if (!selection || !selection.item) return false;
    const { item, hotbarIndex } = selection;

    if (this.bot.heldItem && this.bot.heldItem.type === item.type) {
      return true;
    }

    if (hotbarIndex >= 0 && typeof this.bot.setQuickBarSlot === 'function') {
      this.bot.setQuickBarSlot(hotbarIndex);
      // Reflect held item immediately for same-tick cooldown/state checks
      this.cooldownResetTime = Date.now();
      this.lastHeldSlot = hotbarIndex;
      this.lastHeldType = item.type;
      return true;
    }

    if (!this.equipBusy) {
      this.equipBusy = true;
      this.bot.equip(item, 'hand')
        .then(() => {
          this.cooldownResetTime = Date.now();
          this.lastHeldSlot = this.bot.quickBarSlot;
          this.lastHeldType = item.type;
        })
        .catch(() => {})
        .finally(() => {
          this.equipBusy = false;
        });
    }
    return false;
  }

  /**
   * Detects whether the target is actively raising a shield using entity metadata and equipment.
   */
  isTargetRaisingShield(target) {
    if (!target || !target.isValid) return false;
    if (Date.now() < this.targetShieldDisabledUntil) return false;

    const equipment = target.equipment || [];
    const mainHand = equipment[0] || null;
    const offHand = equipment[1] || null;

    const hasMainShield = mainHand && mainHand.name === 'shield';
    const hasOffShield = offHand && offHand.name === 'shield';
    const hasAnyShield = hasMainShield || hasOffShield ||
      equipment.some((item) => item && item.name === 'shield');

    if (!hasAnyShield) return false;

    // Modern MC living-entity metadata index 8: bit 0x01 = hand active, bit 0x02 = offhand active
    const handFlags = target.metadata && target.metadata[8];
    if (typeof handFlags === 'number') {
      const isUsingHand = (handFlags & 0x01) !== 0;
      if (!isUsingHand) return false;

      const usingOffhand = (handFlags & 0x02) !== 0;
      if (hasMainShield && !hasOffShield && usingOffhand) return false;
      if (hasOffShield && !hasMainShield && !usingOffhand) return false;
      return true;
    }

    return Boolean(target.usingHeldItem || target.isUsingItem);
  }

  /**
   * Detects held-item switches and resets the 1.9+ attack cooldown timer accurately.
   */
  _syncHeldItemCooldown() {
    const currentSlot = this.bot.quickBarSlot;
    const currentType = this.bot.heldItem ? this.bot.heldItem.type : null;

    if (currentSlot !== this.lastHeldSlot || currentType !== this.lastHeldType) {
      this.lastHeldSlot = currentSlot;
      this.lastHeldType = currentType;
      this.cooldownResetTime = Date.now();
    }
  }

  /**
   * Returns exact 1.9+ attack speed (attacks per second) for the currently held weapon.
   */
  getHeldAttackSpeed() {
    const heldName = this.bot.heldItem ? this.bot.heldItem.name : null;
    if (!heldName) return 4.0; // Unarmed

    if (Object.prototype.hasOwnProperty.call(ATTACK_SPEED_OVERRIDES, heldName)) {
      return ATTACK_SPEED_OVERRIDES[heldName];
    }

    try {
      const speed = getAttackSpeed(heldName);
      if (typeof speed === 'number' && speed > 0) return speed;
    } catch (_) {
      // Fallback below
    }

    return 1000 / (this.combatCfg.defaultAttackCooldownMs || 625);
  }

  /**
   * Returns exact 1.9+ attack cooldown duration in milliseconds.
   */
  getWeaponCooldownMs() {
    return 1000 / this.getHeldAttackSpeed();
  }

  /**
   * Returns current 1.9+ attack charge progress in [0.0, 1.0].
   */
  getCooldownProgress() {
    const cooldownMs = this.getWeaponCooldownMs();
    const elapsed = Date.now() - this.cooldownResetTime;
    return Math.max(0, Math.min(1, elapsed / cooldownMs));
  }

  /**
   * Returns true if the currently held weapon is an axe.
   */
  isHoldingAxe() {
    const heldName = this.bot.heldItem ? this.bot.heldItem.name : '';
    return heldName.endsWith('_axe');
  }

  /**
   * Computes exact distance from bot eyes to the nearest point on the target's hitbox.
   */
  getReachDistance(target) {
    if (!this.bot.entity || !target || !target.position) return Infinity;
    const eye = this.aimer.getEyePosition();
    const halfWidth = 0.3;
    const height = target.height || 1.8;

    const clampedX = Math.max(target.position.x - halfWidth, Math.min(eye.x, target.position.x + halfWidth));
    const clampedY = Math.max(target.position.y, Math.min(eye.y, target.position.y + height));
    const clampedZ = Math.max(target.position.z - halfWidth, Math.min(eye.z, target.position.z + halfWidth));

    return eye.distanceTo(new Vec3(clampedX, clampedY, clampedZ));
  }

  /**
   * Computes distance from bot eyes to the nearest point on a predicted hitbox AABB
   * (used for predictive strafe spacing while actual attacks strictly validate `getReachDistance`).
   */
  getPredictedReachDistance(predictedHitbox) {
    if (!this.bot.entity || !predictedHitbox || !predictedHitbox.min || !predictedHitbox.max) {
      return Infinity;
    }
    const eye = this.aimer.getEyePosition();
    const clampedX = Math.max(predictedHitbox.min.x, Math.min(eye.x, predictedHitbox.max.x));
    const clampedY = Math.max(predictedHitbox.min.y, Math.min(eye.y, predictedHitbox.max.y));
    const clampedZ = Math.max(predictedHitbox.min.z, Math.min(eye.z, predictedHitbox.max.z));
    return eye.distanceTo(new Vec3(clampedX, clampedY, clampedZ));
  }

  /**
   * Selects a hotbar slot (0–8) directly and updates cooldown/held-item tracking.
   */
  _selectHotbarSlot(hotbarIndex) {
    if (hotbarIndex < 0 || hotbarIndex > 8) return false;
    if (this.bot.quickBarSlot === hotbarIndex) return true;
    if (typeof this.bot.setQuickBarSlot !== 'function') return false;

    this.bot.setQuickBarSlot(hotbarIndex);
    const hotbarStart = (this.bot.inventory && this.bot.inventory.hotbarStart) || 36;
    const slotItem = (this.bot.heldItem && this.bot.quickBarSlot === hotbarIndex)
      ? this.bot.heldItem
      : this._getInventorySlotItem(hotbarStart + hotbarIndex);

    this.cooldownResetTime = Date.now();
    this.lastHeldSlot = hotbarIndex;
    this.lastHeldType = slotItem ? slotItem.type : null;
    return true;
  }

  /**
   * Determines whether the bot has a tactical window to execute a jump-crit:
   * - Health advantage, OR
   * - Enemy is stunned (recent hurt / shield broken), OR
   * - Enemy is retreating (moving or facing away).
   */
  _shouldAttemptCrit(target) {
    if (!this.combatCfg.critEnabled || !this.bot.entity || !target) return false;
    if (this.bot.entity.isInWater || this.bot.entity.isInLava) return false;
    if (this.bot.health < (this.combatCfg.critMinHealth || 10)) return false;

    const now = Date.now();

    // 1. Target stunned (recently took knockback or shield just disabled)
    const targetStunned = (now - this.targetLastHurtTime) <= 650 ||
      now < this.targetShieldDisabledUntil;
    if (targetStunned) return true;

    // 2. Health advantage
    const targetHealth = typeof target.health === 'number' ? target.health : null;
    const hasExplicitHpAdvantage = targetHealth !== null && (this.bot.health - targetHealth) >= 2;
    const hasImplicitHpAdvantage = this.bot.health >= (this.combatCfg.critHealthAdvantageMin || 14) &&
      (now - this.botLastDamagedTime) > 1200;
    if (hasExplicitHpAdvantage || hasImplicitHpAdvantage) return true;

    // 3. Target retreating (velocity moving away OR facing away from bot)
    const toTarget = target.position.minus(this.bot.entity.position);
    const horizLen = Math.sqrt(toTarget.x * toTarget.x + toTarget.z * toTarget.z);
    if (horizLen > 0.1 && target.velocity) {
      const nx = toTarget.x / horizLen;
      const nz = toTarget.z / horizLen;
      const radialSpeed = target.velocity.x * nx + target.velocity.z * nz;
      if (radialSpeed > 0.045) return true;
    }

    if (typeof target.yaw === 'number') {
      const yawFromTargetToBot = Math.atan2(toTarget.x, toTarget.z);
      const facingDiff = Math.abs(normalizeAngle(target.yaw - yawFromTargetToBot));
      if (facingDiff > (Math.PI * 0.55)) return true; // Facing > ~100 deg away
    }

    return false;
  }

  /**
   * Attaches the arena/hazard checker (RangedModule) to guard strafing & backpedaling.
   */
  setHazardChecker(checker) {
    this.hazardChecker = checker;
  }

  /**
   * Checks whether stepping laterally in `dir` (-1 left, 1 right) is free of walls, cliffs, void edges, lava, fire, and cobwebs.
   */
  _isStrafeDirectionSafe(dir) {
    if (!this.bot.entity) return false;
    const sideYaw = this.bot.entity.yaw + (dir * Math.PI) / 2;
    if (this.hazardChecker && typeof this.hazardChecker.isDirectionSafe === 'function') {
      return this.hazardChecker.isDirectionSafe(sideYaw, 1.15);
    }

    const stepX = -Math.sin(sideYaw) * 1.1;
    const stepZ = -Math.cos(sideYaw) * 1.1;

    const pos = this.bot.entity.position;
    const targetPos = pos.offset(stepX, 0, stepZ);
    const feetBlock = this.bot.blockAt(targetPos);
    const headBlock = this.bot.blockAt(targetPos.offset(0, 1, 0));
    const below1 = this.bot.blockAt(targetPos.offset(0, -1, 0));
    const below2 = this.bot.blockAt(targetPos.offset(0, -2, 0));

    const col = inspectColumnStep(this.bot, targetPos.x, pos.y, targetPos.z);
    const blocked = col.blocked || col.needsJump ||
      (feetBlock && feetBlock.name === 'cobweb') ||
      (headBlock && headBlock.name === 'cobweb');
    const dangerousDrop = !col.hasFloor &&
      (!below1 || below1.boundingBox !== 'block') &&
      (!below2 || below2.boundingBox !== 'block');
    const hazard = (feetBlock && (feetBlock.name.includes('lava') || feetBlock.name.includes('fire'))) ||
      (below1 && (below1.name.includes('lava') || below1.name.includes('fire')));

    return !blocked && !dangerousDrop && !hazard;
  }

  /**
   * Checks whether stepping backward is safe (avoids walls, void edges, lava, fire, and cobwebs).
   */
  _isBackpedalSafe() {
    if (!this.bot.entity) return false;
    const backYaw = this.bot.entity.yaw + Math.PI;
    if (this.hazardChecker && typeof this.hazardChecker.isDirectionSafe === 'function') {
      return this.hazardChecker.isDirectionSafe(backYaw, 1.05);
    }

    const yaw = this.bot.entity.yaw;
    const backX = Math.sin(yaw) * 1.0;
    const backZ = Math.cos(yaw) * 1.0;

    const pos = this.bot.entity.position;
    const targetPos = pos.offset(backX, 0, backZ);
    const feetBlock = this.bot.blockAt(targetPos);
    const below1 = this.bot.blockAt(targetPos.offset(0, -1, 0));
    const below2 = this.bot.blockAt(targetPos.offset(0, -2, 0));

    const col = inspectColumnStep(this.bot, targetPos.x, pos.y, targetPos.z);
    const blocked = col.blocked || col.needsJump || (feetBlock && feetBlock.name === 'cobweb');
    const dangerousDrop = !col.hasFloor &&
      (!below1 || below1.boundingBox !== 'block') &&
      (!below2 || below2.boundingBox !== 'block');
    const hazard = (feetBlock && (feetBlock.name.includes('lava') || feetBlock.name.includes('fire'))) ||
      (below1 && (below1.name.includes('lava') || below1.name.includes('fire')));

    return !blocked && !dangerousDrop && !hazard;
  }

  /**
   * Returns true if a 2-block-tall solid wall directly obstructs straight-line approach to `target`.
   * Avoids invoking pathfinder on open/flat duel arenas where direct sprint-jump chasing is faster and never stalls.
   */
  _isDirectApproachBlockedByWall(target) {
    if (!this.bot.entity || !target || !target.position || typeof this.bot.blockAt !== 'function') {
      return false;
    }
    const pos = this.bot.entity.position;
    const dx = target.position.x - pos.x;
    const dz = target.position.z - pos.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1.5) return false;

    const nx = dx / len;
    const nz = dz / len;
    for (const step of [1.2, 2.2, 3.2]) {
      const col = inspectColumnStep(this.bot, pos.x + nx * step, pos.y, pos.z + nz * step);
      if (col.blocked) {
        return true;
      }
    }
    return false;
  }

  /**
   * Releases CombatModule's pathfinder & transient melee timers WITHOUT clearing
   * active WASD/sprint/jump controls owned by AerialModule, BurstModule, RangedModule, or SurvivalModule.
   */
  releaseControl() {
    if (this.usingPathfinder && this.bot.pathfinder) {
      this.bot.pathfinder.setGoal(null);
      this.usingPathfinder = false;
      this.lastPathGoalPos = null;
    }
    this.sprintResetTicksRemaining = 0;
    this.reengageSprintNextTick = false;
    this.jumpResetActive = false;
    this.jumpResetReleaseNextTick = false;
    this.hitSelectState = 'IDLE';
    this.hitSelectDelayTicks = 0;
    this.hitSelectCounterWindowUntil = 0;
    this.breachSwapState = 'IDLE';
    this.breachSwapTicksRemaining = 0;
    this.critInProgress = false;
    this.shieldBreakActive = false;
    this.swapBackToSwordNextTick = false;
    this.cancelSpearLunge();
  }

  /**
   * Stops all movement controls, pathfinder goals, and transient combat states cleanly.
   */
  stopMovement() {
    this.releaseControl();
    this.bot.setControlState('forward', false);
    this.bot.setControlState('back', false);
    this.bot.setControlState('left', false);
    this.bot.setControlState('right', false);
    this.bot.setControlState('sprint', false);
    this.bot.setControlState('jump', false);
  }

  /**
   * Main 20-TPS (50ms) combat tick.
   */
  tick(target) {
    if (!this.bot.entity || !target || !target.isValid) {
      this.activeTarget = null;
      this.stopMovement();
      return;
    }

    this.activeTarget = target;
    this._syncHeldItemCooldown();

    // Release 1-tick jump-reset jump control on the next tick
    if (this.jumpResetReleaseNextTick) {
      this.jumpResetReleaseNextTick = false;
      this.jumpResetActive = false;
      this.bot.setControlState('jump', false);
    }

    // Sync any swing timestamp recorded for this target before it became activeTarget
    const recordedSwing = this.lastSwingByEntityId.get(target.id);
    if (recordedSwing && recordedSwing > this.targetLastSwingTime) {
      this.targetLastSwingTime = recordedSwing;
    }

    const pos = this.bot.entity.position;
    const rawDist = pos.distanceTo(target.position);
    const reachDist = this.getReachDistance(target);

    // Compute predicted intersection hitbox when PredictionModule is attached
    const predictedHitbox = (this.prediction && typeof this.prediction.predictIntersection === 'function')
      ? this.prediction.predictIntersection(target)
      : null;
    const spacingDist = predictedHitbox ? this.getPredictedReachDistance(predictedHitbox) : reachDist;

    // 1. Weapon management: handle sequential Ground Breach swap-back / hold,
    //    axe shield-break swap / swap-back, or default hotbar Sword.
    this._updateWeaponForTarget(target);

    // 2. Only hand off to pathfinder when target is far (>10b) AND a 2+ block wall actually blocks direct approach,
    //    with a stuck fallback back to direct smooth-aim sprint-jumping so custom duel arena blocks never freeze the bot.
    const pathfinderRange = 10.0;
    const nowMs = Date.now();
    const blockedByTallWall = this._isDirectApproachBlockedByWall(target);

    if (
      rawDist > pathfinderRange &&
      blockedByTallWall &&
      nowMs >= this.pathfinderDisabledUntil &&
      this.bot.pathfinder
    ) {
      // Stuck detector: if pathfinder fails to move the bot for 15 ticks (~0.75s), fall back to direct chase
      if (this.lastBotCheckPos && pos.distanceTo(this.lastBotCheckPos) < 0.08) {
        this.pathfinderStuckTicks++;
      } else {
        this.pathfinderStuckTicks = 0;
      }
      this.lastBotCheckPos = pos.clone();

      if (this.pathfinderStuckTicks >= 15) {
        this.bot.pathfinder.setGoal(null);
        this.usingPathfinder = false;
        this.lastPathGoalPos = null;
        this.pathfinderStuckTicks = 0;
        this.pathfinderDisabledUntil = nowMs + 4000;
      } else {
        this.bot.setControlState('left', false);
        this.bot.setControlState('right', false);
        this.bot.setControlState('back', false);

        const movedSignificantly = !this.lastPathGoalPos ||
          this.lastPathGoalPos.distanceTo(target.position) > 2.0;

        if (!this.usingPathfinder || movedSignificantly) {
          this.bot.pathfinder.setGoal(new goals.GoalNear(
            target.position.x,
            target.position.y,
            target.position.z,
            2
          ), true);
          this.usingPathfinder = true;
          this.lastPathGoalPos = target.position.clone();
        }
        return;
      }
    }

    // Release pathfinder so SmoothAimer and WASD sprint-jump/strafe controls own movement directly
    if (this.usingPathfinder && this.bot.pathfinder) {
      this.bot.pathfinder.setGoal(null);
      this.usingPathfinder = false;
      this.lastPathGoalPos = null;
    }
    this.pathfinderStuckTicks = 0;

    // 3. Smoothly track predicted intersection torso with crisp melee aim cone (~19.5 deg)
    const aimStatus = (predictedHitbox && predictedHitbox.torso)
      ? this.aimer.stepTowardsPoint(predictedHitbox.torso, {
          speedMultiplier: 1.25,
          toleranceRad: 0.34
        })
      : this.aimer.stepTowardsEntity(target, {
          leadTicks: 1.5,
          speedMultiplier: 1.25,
          toleranceRad: 0.34
        });

    // 4. Execute W-Tap / S-Tap sprint-reset ticks OR normal predictive dynamic spacing + circle-strafing
    if (this.sprintResetTicksRemaining > 0) {
      this.sprintResetTicksRemaining--;
      this.bot.setControlState('sprint', false);
      this.bot.setControlState('forward', false);
      this.bot.setControlState('back', this.sprintResetMode === 's-tap' && this._isBackpedalSafe());
      this._updateCircleStrafe(spacingDist);
    } else {
      this._updateDynamicSpacingAndStrafe(spacingDist, aimStatus);
      // Immediately re-engage sprint after W-Tap / S-Tap completes to maximize knockback
      if (this.reengageSprintNextTick) {
        this.reengageSprintNextTick = false;
        if (aimStatus.yawErrorDeg < 35 && spacingDist >= (this.combatCfg.tooCloseDistance || 2.2)) {
          this.bot.setControlState('back', false);
          this.bot.setControlState('forward', true);
          this.bot.setControlState('sprint', true);
        }
      }
    }

    // 5. Execute shield-break, Ground Breach Swap, Hit-Selecting, or 1.9+ cooldown & falling-crit melee attack
    //    Strictly validates actual hitbox distance (`reachDist`) so GrimAC/Vulcan never flag reach.
    this._updateAttackAndCrits(target, reachDist, aimStatus);
  }

  /**
   * Handles sequential Ground Breach Swap-back, shield-break Axe swaps, and Sword weapon selection.
   */
  _updateWeaponForTarget(target) {
    // Tick N+2 of Ground Breach Swap: swap cleanly back to Sword on the tick after attacking
    if (this.breachSwapState === 'SWAP_BACK_PENDING') {
      this.breachSwapState = 'IDLE';
      this.breachSwapTicksRemaining = 0;
      if (this.swordSlot >= 0 && this._selectHotbarSlot(this.swordSlot)) {
        return;
      }
      const bestSword = this._findBestWeaponItem(SWORD_PRIORITY);
      if (bestSword) this._equipFast(bestSword);
      return;
    }

    // Tick N+1 of Ground Breach Swap: keep Breach Mace equipped until the attack tick executes
    if (this.breachSwapState === 'SWAPPED_TO_MACE') {
      if (this.combatCfg.shieldBreakWithAxe && this.isTargetRaisingShield(target)) {
        // Target raised shield mid-swap: abort breach swap and let axe break shield
        this.breachSwapState = 'IDLE';
        this.breachSwapTicksRemaining = 0;
      } else {
        return;
      }
    }

    // Immediate next-tick swap back to Sword after landing an axe shield-break
    if (this.swapBackToSwordNextTick) {
      this.swapBackToSwordNextTick = false;
      this.shieldBreakActive = false;
      if (this.swordSlot >= 0 && this._selectHotbarSlot(this.swordSlot)) {
        return;
      }
      const bestSword = this._findBestWeaponItem(SWORD_PRIORITY);
      if (bestSword) this._equipFast(bestSword);
      return;
    }

    // Detect raised shield -> immediately pull hotbar Axe
    if (this.combatCfg.shieldBreakWithAxe && this.isTargetRaisingShield(target)) {
      if (this.axeSlot >= 0 && this._selectHotbarSlot(this.axeSlot)) {
        this.shieldBreakActive = true;
        return;
      }
      const bestAxe = this._findBestWeaponItem(AXE_PRIORITY);
      if (bestAxe) {
        this.shieldBreakActive = true;
        this._equipFast(bestAxe);
        return;
      }
    }

    // Default weapon selection:
    // - Use Spear in extended mid-range (3.05..spearReach) OR when no sword exists
    // - Otherwise use best hotbar Sword (falling back to Axe / Mace)
    this.shieldBreakActive = false;
    const reachDist = this.getReachDistance(target);
    const spearReach = this.combatCfg.spearReach || 4.2;

    if (
      this.spearSlot >= 0 &&
      ((reachDist > (this.combatCfg.reach || 3.0) && reachDist <= spearReach) || this.swordSlot === -1)
    ) {
      if (this._selectHotbarSlot(this.spearSlot)) {
        return;
      }
    }

    if (this.swordSlot >= 0) {
      const hotbarStart = (this.bot.inventory && this.bot.inventory.hotbarStart) || 36;
      const slotItem = this._getInventorySlotItem(hotbarStart + this.swordSlot);
      if (slotItem && SWORD_PRIORITY.includes(slotItem.name)) {
        this._selectHotbarSlot(this.swordSlot);
        return;
      }
    }
    const preferred = this._findBestWeaponItem(SWORD_PRIORITY) || this._findBestWeaponItem(AXE_PRIORITY);
    if (preferred) {
      this._equipFast(preferred);
    }
  }

  /**
   * Dynamic spacing controller:
   * - > 3.2 blocks: sprint-jump chase toward target
   * - 2.95–3.2 blocks: forward sprint pressure into sweet spot
   * - 2.7–2.95 blocks: optimal combat reach band (circle-strafe with gentle radius hold)
   * - 2.2–2.7 blocks: hold/ease spacing while circle-strafing
   * - < 2.2 blocks: backpedal slightly while strafing
   */
  /**
   * Samples center + left/right 0.32b shoulder rays ahead at 0.55b and 0.95b to detect
   * jumpable 1-block ledges AND 2-high block-edge snags while moving/strafing.
   */
  _inspectForwardAndShoulders(yaw) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position || typeof this.bot.blockAt !== 'function') {
      return { needLedgeJump: false, leftBlocked2High: false, rightBlocked2High: false, overheadCobweb: false };
    }
    const pos = this.bot.entity.position;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    // Right perpendicular vector in Mineflayer coordinates
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);

    let needLedgeJump = false;
    let leftBlocked2High = false;
    let rightBlocked2High = false;
    let overheadCobweb = false;

    const lanes = [
      { side: 0, lateral: 0 },
      { side: -1, lateral: -0.35 },
      { side: 1, lateral: 0.35 }
    ];

    for (const lane of lanes) {
      for (const dist of [0.42, 0.85]) {
        const sx = pos.x + fx * dist + rx * lane.lateral;
        const sz = pos.z + fz * dist + rz * lane.lateral;
        const col = inspectColumnStep(this.bot, sx, pos.y, sz);

        if (col.needsJump) {
          needLedgeJump = true;
        } else if (col.blocked) {
          if (lane.side < 0) leftBlocked2High = true;
          if (lane.side > 0) rightBlocked2High = true;
        }
      }
    }

    // Detect 3-block-high cobweb directly above the bot's footprint so we don't jump into it repeatedly
    const aboveY = Math.floor(pos.y) + 2;
    for (const ox of [0, -0.29, 0.29]) {
      for (const oz of [0, -0.29, 0.29]) {
        const above = this.bot.blockAt(new Vec3(Math.floor(pos.x + ox), aboveY, Math.floor(pos.z + oz)));
        if (above && above.name === 'cobweb') {
          overheadCobweb = true;
          break;
        }
      }
      if (overheadCobweb) break;
    }

    if (!needLedgeJump && this.bot.entity.isCollidedHorizontally) {
      const centerCol = inspectColumnStep(this.bot, pos.x + fx * 0.7, pos.y, pos.z + fz * 0.7);
      if (!centerCol.blocked) {
        needLedgeJump = true;
      }
    }

    return { needLedgeJump, leftBlocked2High, rightBlocked2High, overheadCobweb };
  }

  _updateDynamicSpacingAndStrafe(reachDist, aimStatus) {
    const chaseDist = this.combatCfg.chaseDistance || 3.2;
    const optimalMax = this.combatCfg.optimalReachMax || 2.95;
    const optimalMin = this.combatCfg.optimalReachMin || 2.7;
    const tooCloseDist = this.combatCfg.tooCloseDistance || 2.2;

    const facingTarget = aimStatus.yawErrorDeg < 35;
    const onGround = this.bot.entity.onGround;
    const inWater = Boolean(
      this.bot.entity.isInWater ||
      findOverlappingBlock(this.bot, (b) => b.name === 'water' || b.name === 'flowing_water')
    );
    const canSprint = facingTarget && this.bot.food > 6;

    // 3-ray shoulder & ledge check (prevents getting caught on 1-block lips, 2-high block corners, or 3-high cobwebs)
    const yaw = this.bot.entity.yaw;
    const { needLedgeJump, leftBlocked2High, rightBlocked2High, overheadCobweb } = this._inspectForwardAndShoulders(yaw);

    // Slide cleanly away from a snagged 2-high corner edge (even when chasing from >4.5b away)
    let edgeSlideDir = 0;
    if (leftBlocked2High && !rightBlocked2High) {
      this.strafeDirection = 1;
      edgeSlideDir = 1;
    } else if (rightBlocked2High && !leftBlocked2High) {
      this.strafeDirection = -1;
      edgeSlideDir = -1;
    }

    const allowJump = !overheadCobweb || inWater;
    const shouldClimbOrSwim = inWater || (allowJump && onGround && needLedgeJump);

    if (reachDist > chaseDist) {
      // > 3.2 blocks: Sprint-jump chase toward target (always swim up in water; suppress jump under 3-high cobweb)
      this.bot.setControlState('forward', true);
      this.bot.setControlState('back', false);
      this.bot.setControlState('sprint', canSprint && !(inWater && needLedgeJump));
      this.bot.setControlState('jump', inWater || (allowJump && onGround && (facingTarget || needLedgeJump)));
    } else if (reachDist > optimalMax || this.shieldBreakActive) {
      // 2.95–3.2 blocks (or rushing in for a sprint-hit shield break)
      this.bot.setControlState('forward', true);
      this.bot.setControlState('back', false);
      this.bot.setControlState('sprint', canSprint && !(inWater && needLedgeJump));
      if (!this.critInProgress) {
        this.bot.setControlState('jump', shouldClimbOrSwim);
      }
    } else if (reachDist >= optimalMin) {
      // 2.65–2.95 blocks: Optimal combat reach — aggressive forward-diagonal strafe pressure
      this.bot.setControlState('forward', true);
      this.bot.setControlState('back', false);
      this.bot.setControlState('sprint', canSprint && !this.critInProgress && !(inWater && needLedgeJump));
      if (!this.critInProgress) {
        this.bot.setControlState('jump', shouldClimbOrSwim);
      }
    } else if (reachDist >= tooCloseDist) {
      // 2.0–2.65 blocks: Keep diagonal pressure and climb edges / swim in water cleanly
      this.bot.setControlState('forward', reachDist > 2.35 || needLedgeJump);
      this.bot.setControlState('back', false);
      this.bot.setControlState('sprint', canSprint && reachDist > 2.4 && !this.critInProgress && !inWater);
      if (!this.critInProgress) {
        this.bot.setControlState('jump', shouldClimbOrSwim);
      }
    } else {
      // < 2.2 blocks: Backpedal slightly while strafing; if cornered, step forward-jump instead of stalling
      const safeBack = this._isBackpedalSafe();
      const canStrafeLeft = this._isStrafeDirectionSafe(-1);
      const canStrafeRight = this._isStrafeDirectionSafe(1);
      const cornered = !safeBack && !canStrafeLeft && !canStrafeRight;
      this.bot.setControlState('forward', cornered);
      this.bot.setControlState('back', safeBack);
      this.bot.setControlState('sprint', false);
      if (!this.critInProgress) {
        this.bot.setControlState('jump', inWater || (allowJump && (cornered || needLedgeJump) && onGround));
      }
    }

    // Randomized A/D circle-strafing (or forced edge-slide when shoulder clips a block edge)
    if (edgeSlideDir !== 0) {
      this.bot.setControlState('left', edgeSlideDir < 0);
      this.bot.setControlState('right', edgeSlideDir > 0);
    } else {
      this._updateCircleStrafe(reachDist);
    }
  }

  /**
   * Drives unpredictable A/D circle-strafing with micro-direction changes every 400–900ms.
   */
  _updateCircleStrafe(reachDist) {
    const now = Date.now();
    const withinStrafeBand = reachDist <= 4.5;

    if (!withinStrafeBand) {
      this.bot.setControlState('left', false);
      this.bot.setControlState('right', false);
      return;
    }

    // Micro-direction change timer (400–900ms) or obstacle avoidance flip
    const currentSafe = this._isStrafeDirectionSafe(this.strafeDirection);
    if (now >= this.nextStrafeSwitchAt || !currentSafe) {
      const oppositeSafe = this._isStrafeDirectionSafe(-this.strafeDirection);
      if (oppositeSafe) {
        this.strafeDirection = -this.strafeDirection;
        // Occasional 1-tick micro-hesitation on flip makes trajectory harder to predict
        this.strafePauseTicks = Math.random() < 0.25 ? 1 : 0;
      }
      this.nextStrafeSwitchAt = this._scheduleNextStrafeSwitch();
    }

    if (this.strafePauseTicks > 0) {
      this.strafePauseTicks--;
      this.bot.setControlState('left', false);
      this.bot.setControlState('right', false);
      return;
    }

    if (this._isStrafeDirectionSafe(this.strafeDirection)) {
      this.bot.setControlState('left', this.strafeDirection < 0);
      this.bot.setControlState('right', this.strafeDirection > 0);
    } else {
      this.bot.setControlState('left', false);
      this.bot.setControlState('right', false);
    }
  }

  /**
   * Handles 1.9+ attack cooldown gating (>=95%, or 100% for axe crits),
   * strict falling critical hits (velocity.y < -0.08), axe shield-breaking,
   * Hit-Selecting counter-swing timing, and sequential 3-tick Ground Breach Swapping.
   */
  _updateAttackAndCrits(target, reachDist, aimStatus) {
    const reach = this.combatCfg.reach || 3.0;
    const now = Date.now();
    const cooldownRatio = this.getCooldownProgress();
    const holdingAxe = this.isHoldingAxe();

    const onGround = this.bot.entity.onGround;
    const velY = this.bot.entity.velocity ? this.bot.entity.velocity.y : 0;
    const fallThreshold = this.combatCfg.critFallVelocity !== undefined
      ? this.combatCfg.critFallVelocity
      : -0.08;
    const isFalling = !onGround && !this.bot.entity.isInWater && !this.bot.entity.isInLava && velY < fallThreshold;

    // --- Path A: Priority Axe Shield-Break Sprint-Hit ---
    if (this.shieldBreakActive && holdingAxe) {
      // Sprint-hit as soon as within reach and facing target (150ms swap settle guard)
      if (reachDist <= reach && aimStatus.aligned && (now - this.cooldownResetTime) >= 150) {
        this.bot.setControlState('sprint', true);
        this.bot.attack(target);
        this.lastSwingTime = now;
        this.cooldownResetTime = now;
        this.targetShieldDisabledUntil = now + (this.combatCfg.shieldDisableDurationMs || 5000);
        this.swapBackToSwordNextTick = true;
        this.shieldBreakActive = false;
      }
      return;
    }

    // --- Path A2: Ground Breach Swap Tick N+1 (Attack with Breach Mace, queue Tick N+2 Sword swap-back) ---
    if (this.breachSwapState === 'SWAPPED_TO_MACE') {
      if (this.breachSwapTicksRemaining > 0) {
        this.breachSwapTicksRemaining--;
      }
      if (this.breachSwapTicksRemaining > 0) {
        return; // Wait remaining delay ticks before attacking
      }

      // Validate hitbox reach & facing before attacking (allow slight 0.15b grace during 1-tick swap)
      if (reachDist <= reach + 0.15 && (aimStatus.aligned || aimStatus.yawErrorDeg < 28)) {
        if (isFalling) {
          this.bot.setControlState('sprint', false);
        }
        this.bot.attack(target);
        this.lastSwingTime = now;
        this.cooldownResetTime = now;
        this.critInProgress = false;
        this.bot.setControlState('jump', false);
        if (this.hitSelectState === 'COUNTER_READY') {
          this.hitSelectState = 'IDLE';
        }
      }

      // Queue sequential swap-back to Sword on Tick N+2 (never swap + attack + swap-back in one tick)
      this.breachSwapState = 'SWAP_BACK_PENDING';
      return;
    }

    // --- Path A2b: Standalone Spear Combat (extended 4.2b mid-range thrust; no same-tick UseItem+Attack) ---
    const holdingSpear = this._isSpearItem(this.bot.heldItem);
    const spearReach = this.combatCfg.spearReach || 4.2;
    if (holdingSpear && reachDist <= spearReach && (aimStatus.aligned || aimStatus.yawErrorDeg < 26)) {
      if (cooldownRatio >= (this.combatCfg.minCooldownRatio || 0.93)) {
        this.bot.setControlState('sprint', true);
        this.bot.attack(target);
        this.lastSwingTime = now;
        this.cooldownResetTime = now;
        return;
      }
    }

    // --- Path A3: Hit-Selecting (delay 1–2 ticks on neutral exchange when opponent swings first) ---
    if (this.hitSelectState === 'DELAYING') {
      this.hitSelectDelayTicks--;
      if (this.hitSelectDelayTicks <= 0) {
        this.hitSelectState = 'COUNTER_READY';
        this.hitSelectCounterWindowUntil = now + 450;
      }
      return;
    }

    if (this.hitSelectState === 'COUNTER_READY' && now > this.hitSelectCounterWindowUntil) {
      this.hitSelectState = 'IDLE';
    }

    if (
      this.combatCfg.enableHitSelect &&
      this.hitSelectState === 'IDLE' &&
      this.targetLastSwingTime > this.lastSwingTime &&
      (now - this.targetLastSwingTime) <= 180 &&
      (now - this.lastHitSelectTriggerTime) >= 600 &&
      this._isNeutralSimultaneousExchange(target, now)
    ) {
      const minTicks = this.combatCfg.hitSelectDelayMinTicks || 1;
      const maxTicks = this.combatCfg.hitSelectDelayMaxTicks || 2;
      const delayTicks = minTicks + Math.floor(Math.random() * (maxTicks - minTicks + 1));
      this.lastHitSelectTriggerTime = now;
      if (delayTicks - 1 <= 0) {
        this.hitSelectState = 'COUNTER_READY';
        this.hitSelectCounterWindowUntil = now + 450;
      } else {
        this.hitSelectState = 'DELAYING';
        this.hitSelectDelayTicks = delayTicks - 1;
      }
      return;
    }

    // --- Path B: Smart Critical Hit Jump Initiation ---
    const wantCrit = this._shouldAttemptCrit(target);
    if (
      wantCrit &&
      this.hitSelectState === 'IDLE' &&
      onGround &&
      !this.critInProgress &&
      reachDist <= reach + 0.55 &&
      aimStatus.yawErrorDeg < 30 &&
      cooldownRatio >= 0.55
    ) {
      this.bot.setControlState('jump', true);
      this.critInProgress = true;
    } else if (this.critInProgress && !onGround) {
      // Release jump key immediately once airborne
      this.bot.setControlState('jump', false);
    } else if (this.critInProgress && onGround && velY <= 0 && (now - this.lastSwingTime) > 150) {
      // Landed without getting a hit window; reset crit flag
      this.critInProgress = false;
      this.bot.setControlState('jump', false);
    }

    // --- Path C: Cooldown & Aim Verification ---
    const requiredCooldown = (holdingAxe && (isFalling || this.critInProgress))
      ? (this.combatCfg.axeCritCooldownRatio || 1.0)
      : (this.combatCfg.minCooldownRatio || 0.95);

    if (reachDist > reach || !aimStatus.aligned) {
      return;
    }

    // --- Path C2: Ground Breach Attribute Swap (or multi-tick swap fallback) ---
    const breachReady = (cooldownRatio >= requiredCooldown && (!this.critInProgress || isFalling)) ||
      (isFalling && cooldownRatio >= 0.85);
    if (
      this.combatCfg.enableBreachSwap &&
      !this.combatCfg.durabilityDrainMode &&
      this.breachSwapState === 'IDLE' &&
      this.breachMaceSlot >= 0 &&
      this.swordSlot >= 0 &&
      this.breachMaceSlot !== this.swordSlot &&
      this.hitSelectState === 'IDLE' &&
      breachReady &&
      this.isTargetHeavilyArmored(target)
    ) {
      if (this.combatCfg.sameTickAttributeSwap !== false) {
        if (isFalling) {
          this.bot.setControlState('sprint', false);
        }
        executeAttributeSwapAttack(
          this.bot,
          target,
          { hotbarIndex: this.swordSlot },
          { hotbarIndex: this.breachMaceSlot },
          { durabilityDrainMode: false }
        );
        this.lastSwingTime = now;
        this.cooldownResetTime = now;
        this.critInProgress = false;
        this.bot.setControlState('jump', false);
        this.breachSwapState = 'SWAP_BACK_PENDING';
        return;
      }

      const tickRateMs = (this.config && this.config.physics && this.config.physics.tickRateMs) || 50;
      const delayMs = this.combatCfg.breachSwapDelayMs !== undefined ? this.combatCfg.breachSwapDelayMs : 50;
      const requiredDelayTicks = Math.max(1, Math.round(delayMs / tickRateMs));

      if (this._selectHotbarSlot(this.breachMaceSlot)) {
        this.breachSwapState = 'SWAPPED_TO_MACE';
        this.breachSwapTicksRemaining = requiredDelayTicks;
        this.breachSwappedAt = now;
        return; // Strictly wait for Tick N+1 to execute bot.attack(target)
      }
    }

    if (cooldownRatio < requiredCooldown) {
      return;
    }

    // If airborne for a critical hit, strictly hold swing until falling (velocity.y < -0.08)
    if (this.critInProgress && !isFalling) {
      return;
    }

    // Counter-swing during opponent cooldown to initiate combo lock
    if (this.hitSelectState === 'COUNTER_READY') {
      this.hitSelectState = 'IDLE';
      if (!isFalling) {
        this.bot.setControlState('sprint', true);
      }
    }

    // In 1.9+ Java PvP, sprinting cancels critical hits — drop sprint on the exact crit tick
    if (isFalling) {
      this.bot.setControlState('sprint', false);
    }

    // Prevent hitting through solid blocks
    if (
      this.ranged &&
      typeof this.ranged.hasClearLineOfSight === 'function' &&
      target.position &&
      !this.ranged.hasClearLineOfSight(target.position.offset(0, 1.0, 0))
    ) {
      return;
    }

    // Execute melee strike
    this.bot.attack(target);
    this.lastSwingTime = now;
    this.cooldownResetTime = now;
    this.critInProgress = false;
    this.bot.setControlState('jump', false);
  }
}

module.exports = { CombatModule };
