'use strict';

const { Vec3 } = require('vec3');
const { clamp, DEG_TO_RAD } = require('./aim');

const TORSO_SLOT = 6;
const DEFAULT_HOTBAR_START = 36;
const DEFAULT_REACH = 3.0;

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

const CHESTPLATE_PRIORITY = [
  'netherite_chestplate',
  'diamond_chestplate',
  'iron_chestplate',
  'chainmail_chestplate',
  'golden_chestplate',
  'leather_chestplate'
];

const AERIAL_MODES = Object.freeze({
  IDLE: 'IDLE',
  STUN_SLAM: 'STUN_SLAM',
  MACE_LAUNCH: 'MACE_LAUNCH',
  SPEAR_MACE: 'SPEAR_MACE',
  ELYTRA_DIVE: 'ELYTRA_DIVE',
  CLUTCH: 'CLUTCH'
});

/**
 * Advanced aerial PvP module implementing:
 * 1. Accurate per-tick fallDistance tracking (airborne descent, reset on ground/water/cobweb).
 * 2. Stun Slam: airborne Axe shield-break -> next-tick Breach Mace smash -> Sword swap-back.
 * 3. Spear-to-Mace Chain: mid-range Spear/Trident thrust -> -90 deg Wind Charge launch ->
 *    Stun Slam or Mace Smash on descent with Water Bucket / Wind Charge clutch fallback.
 * 4. Elytra Mace Dive: sequential Chestplate/Elytra swap (slot 6) -> 1-2 tick settle ->
 *    start_fall_flying (actionId 8) -> 65-75 deg firework climb -> -75 to -85 deg predictive dive ->
 *    sequential Chestplate restore + Mace smash at <= 3.5b -> fall-damage clutch on miss.
 */
class AerialModule {
  constructor(bot, config, aimer, prediction = null, combat = null) {
    this.bot = bot;
    this.config = config || {};
    this.aerialCfg = this.config.aerial || {};
    this.combatCfg = this.config.combat || {};
    this.aimer = aimer;
    this.prediction = prediction;
    this.combat = combat;

    // Fall distance tracking
    this.fallDistance = 0;
    this.lastY = (bot && bot.entity && bot.entity.position) ? bot.entity.position.y : null;

    // Active aerial state machine
    this.mode = AERIAL_MODES.IDLE;
    this.stage = null;
    this.stageTicks = 0;

    // Inventory / async equip guards
    this.equipBusy = false;
    this.swappedThisTick = false;

    // Stun Slam state
    this.stunSlamAxeSwapped = false;

    // Spear-to-Mace & Direct Mace Launch state
    this.lastSpearMaceTime = 0;
    this.lastMaceLaunchTime = 0;
    this.spearThrustDone = false;
    this.spearLaunchTicks = 0;
    this.spearDeactivatePending = false;

    // Elytra Mace Dive state
    this.savedChestplateName = null;
    this.elytraSwappedIn = false;
    this.pendingChestplateRestore = false;
    this.elytraEquipTicks = 0;
    this.takeoffJumped = false;
    this.isGliding = false;
    this.boostPitchRad = 70 * DEG_TO_RAD;
    this.divePitchRad = -80 * DEG_TO_RAD;
    this.fireworkFired = false;
    this.fireworkDeactivatePending = false;
    this.climbTicksAfterBoost = 0;

    // Fall-damage clutch state
    this.clutchItemName = null;
    this.clutchActivated = false;
    this.clutchDeactivatePending = false;

    // Bind death/respawn cleanup safely
    this._onDeath = this._handleDeathOrRespawn.bind(this);
    if (this.bot && typeof this.bot.on === 'function') {
      this.bot.on('death', this._onDeath);
      this.bot.on('respawn', this._onDeath);
    }
  }

  /**
   * Attaches or updates the trajectory prediction module.
   */
  setPrediction(prediction) {
    this.prediction = prediction;
  }

  /**
   * Attaches or updates the combat module reference.
   */
  setCombat(combat) {
    this.combat = combat;
  }

  /**
   * Cleans up event listeners and transient aerial state cleanly.
   */
  dispose() {
    if (this.bot && typeof this.bot.removeListener === 'function') {
      this.bot.removeListener('death', this._onDeath);
      this.bot.removeListener('respawn', this._onDeath);
    }
    this.cancel();
    this.fallDistance = 0;
    this.lastY = null;
  }

  _handleDeathOrRespawn() {
    this.fallDistance = 0;
    this.lastY = (this.bot && this.bot.entity && this.bot.entity.position)
      ? this.bot.entity.position.y
      : null;
    this._resetState();
    this.elytraSwappedIn = false;
    this.pendingChestplateRestore = false;
    this.savedChestplateName = null;
  }

  /**
   * Returns true while actively executing a Stun Slam, Spear-Mace chain,
   * Elytra Mace Dive, or fall-damage clutch.
   */
  isBusy() {
    return this.mode !== AERIAL_MODES.IDLE;
  }

  /**
   * Aborts offensive aerial actions cleanly, re-equipping the chestplate
   * if mid-elytra-swap when safe to do so.
   */
  cancel() {
    const wasBusy = this.isBusy();

    if (wasBusy && this.bot) {
      if (typeof this.bot.setControlState === 'function') {
        this.bot.setControlState('jump', false);
        this.bot.setControlState('forward', false);
        this.bot.setControlState('sprint', false);
      }
      if (
        (this.fireworkDeactivatePending || this.spearDeactivatePending || this.clutchDeactivatePending) &&
        typeof this.bot.deactivateItem === 'function'
      ) {
        try {
          this.bot.deactivateItem();
        } catch (_) {}
      }
    }

    const wearingElytra = this._isWearingElytra();
    if (this.elytraSwappedIn || wearingElytra) {
      const safeToRestore = this._isSafeToRestoreChestplate();
      if (safeToRestore) {
        if (!this._restoreChestplate(true)) {
          this.pendingChestplateRestore = true;
        }
      } else {
        this.pendingChestplateRestore = true;
      }
    }

    this._resetState();
  }

  _resetState() {
    this.mode = AERIAL_MODES.IDLE;
    this.stage = null;
    this.stageTicks = 0;
    this.stunSlamAxeSwapped = false;
    this.spearThrustDone = false;
    this.spearLaunchTicks = 0;
    this.spearDeactivatePending = false;
    this.elytraEquipTicks = 0;
    this.takeoffJumped = false;
    this.isGliding = false;
    this.fireworkFired = false;
    this.fireworkDeactivatePending = false;
    this.climbTicksAfterBoost = 0;
    this.clutchItemName = null;
    this.clutchActivated = false;
    this.clutchDeactivatePending = false;
  }

  /**
   * Returns currently tracked airborne fall distance in blocks.
   */
  getFallDistance() {
    return this.fallDistance;
  }

  // =========================================================================
  // 1. ACCURATE FALL DISTANCE TRACKING & ENVIRONMENT HELPERS
  // =========================================================================

  _isInBlockNames(pos, names) {
    if (!this.bot || typeof this.bot.blockAt !== 'function' || !pos) return false;
    const feetBlock = this.bot.blockAt(pos);
    if (feetBlock && names.includes(feetBlock.name)) return true;
    const bodyBlock = this.bot.blockAt(pos.offset(0, 0.5, 0));
    if (bodyBlock && names.includes(bodyBlock.name)) return true;
    return false;
  }

  _getEnvironmentFlags() {
    const entity = this.bot && this.bot.entity;
    if (!entity || !entity.position) {
      return { onGround: true, inWater: false, inLava: false, inCobweb: false };
    }
    const pos = entity.position;
    const onGround = Boolean(entity.onGround);
    const inWater = Boolean(entity.isInWater) || this._isInBlockNames(pos, ['water', 'flowing_water']);
    const inLava = Boolean(entity.isInLava) || this._isInBlockNames(pos, ['lava', 'flowing_lava']);
    const inCobweb = Boolean(entity.isInWeb) || this._isInBlockNames(pos, ['cobweb']);
    return { onGround, inWater, inLava, inCobweb };
  }

  _updateFallDistance() {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) return;

    const pos = this.bot.entity.position;
    const { onGround, inWater, inLava, inCobweb } = this._getEnvironmentFlags();

    if (onGround || inWater || inCobweb) {
      this.fallDistance = 0;
      this.lastY = pos.y;
      return;
    }

    if (inLava) {
      this.lastY = pos.y;
      return;
    }

    if (this.lastY !== null) {
      const dy = this.lastY - pos.y;
      if (dy > 0) {
        this.fallDistance += dy;
      } else if (dy < -0.05) {
        // Ascending (e.g. jump, wind charge launch, firework boost) resets accumulated descent
        this.fallDistance = 0;
      }
    }

    this.lastY = pos.y;
  }

  _getHeightAboveGround(maxScan = 16) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) return 0;
    if (this.bot.entity.onGround) return 0;
    if (typeof this.bot.blockAt !== 'function') return Infinity;

    const pos = this.bot.entity.position;
    const bx = Math.floor(pos.x);
    const bz = Math.floor(pos.z);
    const startY = Math.floor(pos.y);

    for (let dy = 0; dy <= maxScan; dy++) {
      const y = startY - dy;
      const block = this.bot.blockAt(new Vec3(bx, y, bz));
      if (block && block.boundingBox === 'block') {
        return Math.max(0, pos.y - (y + 1));
      }
    }
    return Infinity;
  }

  // =========================================================================
  // INVENTORY, HOTBAR & ARMOR HELPERS (SEQUENTIAL / ANTICHEAT-SAFE)
  // =========================================================================

  _getHotbarStart() {
    return (this.bot && this.bot.inventory && this.bot.inventory.hotbarStart) || DEFAULT_HOTBAR_START;
  }

  _getTorsoSlotIndex() {
    if (this.bot && typeof this.bot.getEquipmentDestSlot === 'function') {
      return this.bot.getEquipmentDestSlot('torso');
    }
    return TORSO_SLOT;
  }

  _getInventoryItems() {
    if (!this.bot || !this.bot.inventory) return [];
    if (typeof this.bot.inventory.items === 'function') {
      return this.bot.inventory.items().filter(Boolean);
    }
    if (Array.isArray(this.bot.inventory.slots)) {
      return this.bot.inventory.slots.filter(Boolean);
    }
    return [];
  }

  _getSlotItem(slotIndex) {
    if (!this.bot || !this.bot.inventory) return null;
    if (Array.isArray(this.bot.inventory.slots) && this.bot.inventory.slots[slotIndex]) {
      return this.bot.inventory.slots[slotIndex];
    }
    return this._getInventoryItems().find((i) => i.slot === slotIndex) || null;
  }

  _getTorsoItem() {
    return this._getSlotItem(this._getTorsoSlotIndex());
  }

  _isWearingElytra() {
    const torso = this._getTorsoItem();
    return Boolean(torso && torso.name === 'elytra');
  }

  _isSafeToRestoreChestplate() {
    if (!this.bot || !this.bot.entity) return true;
    const { onGround, inWater } = this._getEnvironmentFlags();
    const clutchMin = this.aerialCfg.clutchMinFallDistance !== undefined
      ? this.aerialCfg.clutchMinFallDistance
      : 4.0;
    return onGround || inWater || !this.isGliding || this.fallDistance < clutchMin;
  }

  _getCombatHotbarSlots() {
    if (this.combat && typeof this.combat.getHotbarSlots === 'function') {
      return this.combat.getHotbarSlots() || null;
    }
    return null;
  }

  _hasBreachEnchant(item) {
    if (!item || item.name !== 'mace') return false;
    try {
      const serialized = JSON.stringify({
        nbt: item.nbt || null,
        components: item.components || null,
        enchants: item.enchants || null
      }).toLowerCase();
      return serialized.includes('breach');
    } catch (_) {
      return false;
    }
  }

  _makeSelection(item) {
    if (!item) return null;
    const hotbarStart = this._getHotbarStart();
    const inHotbar = typeof item.slot === 'number' &&
      item.slot >= hotbarStart &&
      item.slot < hotbarStart + 9;
    return {
      item,
      hotbarIndex: inHotbar ? item.slot - hotbarStart : -1
    };
  }

  _findItemByName(name) {
    const items = this._getInventoryItems();
    const hotbarStart = this._getHotbarStart();

    const hotbarItem = items.find(
      (i) => i.name === name && typeof i.slot === 'number' && i.slot >= hotbarStart && i.slot < hotbarStart + 9
    );
    if (hotbarItem) return this._makeSelection(hotbarItem);

    const invItem = items.find((i) => i.name === name);
    return invItem ? this._makeSelection(invItem) : null;
  }

  _findBestByPriority(priorityList, preferredHotbarSlot = -1) {
    const hotbarStart = this._getHotbarStart();

    if (typeof preferredHotbarSlot === 'number' && preferredHotbarSlot >= 0 && preferredHotbarSlot <= 8) {
      const slotItem = this._getSlotItem(hotbarStart + preferredHotbarSlot);
      if (slotItem && priorityList.includes(slotItem.name)) {
        return { item: slotItem, hotbarIndex: preferredHotbarSlot };
      }
    }

    const items = this._getInventoryItems();
    for (const name of priorityList) {
      const hotbarItem = items.find(
        (i) => i.name === name && typeof i.slot === 'number' && i.slot >= hotbarStart && i.slot < hotbarStart + 9
      );
      if (hotbarItem) return this._makeSelection(hotbarItem);
    }

    for (const name of priorityList) {
      const invItem = items.find((i) => i.name === name);
      if (invItem) return this._makeSelection(invItem);
    }
    return null;
  }

  _findMace() {
    const hotbarStart = this._getHotbarStart();
    const slots = this._getCombatHotbarSlots();

    // Priority 1: CombatModule-detected Breach Mace hotbar slot
    if (slots && typeof slots.breachMaceSlot === 'number' && slots.breachMaceSlot >= 0) {
      const slotItem = this._getSlotItem(hotbarStart + slots.breachMaceSlot);
      if (slotItem && slotItem.name === 'mace') {
        return { item: slotItem, hotbarIndex: slots.breachMaceSlot, isBreach: true };
      }
    }

    // Priority 2: Direct scan for a Breach-enchanted Mace (hotbar first)
    const items = this._getInventoryItems();
    const breachHotbar = items.find(
      (i) => i.name === 'mace' &&
        typeof i.slot === 'number' &&
        i.slot >= hotbarStart &&
        i.slot < hotbarStart + 9 &&
        this._hasBreachEnchant(i)
    );
    if (breachHotbar) return { ...this._makeSelection(breachHotbar), isBreach: true };

    const breachInv = items.find((i) => i.name === 'mace' && this._hasBreachEnchant(i));
    if (breachInv) return { ...this._makeSelection(breachInv), isBreach: true };

    // Priority 3: CombatModule-detected standard Mace hotbar slot
    if (slots && typeof slots.maceSlot === 'number' && slots.maceSlot >= 0) {
      const slotItem = this._getSlotItem(hotbarStart + slots.maceSlot);
      if (slotItem && slotItem.name === 'mace') {
        return { item: slotItem, hotbarIndex: slots.maceSlot, isBreach: false };
      }
    }

    // Priority 4: Any Mace in hotbar or inventory
    const anyMace = this._findItemByName('mace');
    return anyMace ? { ...anyMace, isBreach: false } : null;
  }

  _findAxe() {
    const slots = this._getCombatHotbarSlots();
    const preferred = slots && typeof slots.axeSlot === 'number' ? slots.axeSlot : -1;
    return this._findBestByPriority(AXE_PRIORITY, preferred);
  }

  _findSword() {
    const slots = this._getCombatHotbarSlots();
    const preferred = slots && typeof slots.swordSlot === 'number' ? slots.swordSlot : -1;
    return this._findBestByPriority(SWORD_PRIORITY, preferred);
  }

  _findSpear() {
    const items = this._getInventoryItems();
    const hotbarStart = this._getHotbarStart();
    const isSpearOrTrident = (i) => {
      if (!i) return false;
      const name = String(i.name || '').toLowerCase();
      const custom = String(i.customName || i.displayName || '').toLowerCase();
      return name.includes('spear') || name.includes('trident') || custom.includes('spear');
    };

    const hotbarSpear = items.find(
      (i) => isSpearOrTrident(i) &&
        typeof i.slot === 'number' &&
        i.slot >= hotbarStart &&
        i.slot < hotbarStart + 9
    );
    if (hotbarSpear) return this._makeSelection(hotbarSpear);

    const invSpear = items.find(isSpearOrTrident);
    return invSpear ? this._makeSelection(invSpear) : null;
  }

  _findChestplate(preferredName = null) {
    const items = this._getInventoryItems();
    const torsoSlot = this._getTorsoSlotIndex();

    if (preferredName) {
      const exact = items.find((i) => i.name === preferredName && i.slot !== torsoSlot);
      if (exact) return exact;
    }

    for (const name of CHESTPLATE_PRIORITY) {
      const found = items.find((i) => i.name === name && i.slot !== torsoSlot);
      if (found) return found;
    }

    const fallback = items.find((i) => i.name && i.name.endsWith('_chestplate') && i.slot !== torsoSlot);
    return fallback || null;
  }

  _hasChestplateAvailable() {
    const torso = this._getTorsoItem();
    if (torso && torso.name && torso.name.endsWith('_chestplate')) return true;
    return Boolean(this._findChestplate(this.savedChestplateName));
  }

  _hasElytraAvailable() {
    if (this._isWearingElytra()) return true;
    return Boolean(this._findItemByName('elytra'));
  }

  _isHoldingSelection(selection) {
    if (!selection || !selection.item) return false;
    if (selection.hotbarIndex >= 0 && typeof this.bot.quickBarSlot === 'number') {
      if (this.bot.quickBarSlot === selection.hotbarIndex) {
        if (!this.bot.heldItem || this.bot.heldItem.name === selection.item.name) {
          return true;
        }
      }
      return false;
    }
    return Boolean(this.bot.heldItem && this.bot.heldItem.name === selection.item.name);
  }

  /**
   * Anticheat-safe hand equip: at most one swap per tick.
   * Returns { ready: boolean, swapped: boolean }.
   */
  _equipHand(selection) {
    if (!selection || !selection.item) return { ready: false, swapped: false };
    if (this._isHoldingSelection(selection)) return { ready: true, swapped: false };
    if (this.swappedThisTick) return { ready: false, swapped: false };

    if (selection.hotbarIndex >= 0 && typeof this.bot.setQuickBarSlot === 'function') {
      this.bot.setQuickBarSlot(selection.hotbarIndex);
      this.swappedThisTick = true;
      return { ready: true, swapped: true };
    }

    if (!this.equipBusy && typeof this.bot.equip === 'function') {
      this.equipBusy = true;
      this.swappedThisTick = true;
      Promise.resolve(this.bot.equip(selection.item, 'hand'))
        .catch(() => {})
        .finally(() => {
          this.equipBusy = false;
        });
    }
    return { ready: false, swapped: true };
  }

  /**
   * Anticheat-safe torso (slot 6) equip.
   */
  _equipTorso(item, ignoreTickGuard = false) {
    if (!item || this.equipBusy || (!ignoreTickGuard && this.swappedThisTick)) return false;
    const torso = this._getTorsoItem();
    if (torso && torso.name === item.name) return true;
    if (typeof this.bot.equip !== 'function') return false;

    this.equipBusy = true;
    this.swappedThisTick = true;
    Promise.resolve(this.bot.equip(item, 'torso'))
      .catch(() => {})
      .finally(() => {
        this.equipBusy = false;
      });
    return true;
  }

  _restoreChestplate(ignoreTickGuard = false) {
    const torso = this._getTorsoItem();
    if (torso && torso.name && torso.name.endsWith('_chestplate')) {
      this.elytraSwappedIn = false;
      this.pendingChestplateRestore = false;
      return true;
    }

    const chestplate = this._findChestplate(this.savedChestplateName);
    if (!chestplate) {
      this.elytraSwappedIn = false;
      this.pendingChestplateRestore = false;
      return false;
    }

    const initiated = this._equipTorso(chestplate, ignoreTickGuard);
    if (initiated) {
      this.elytraSwappedIn = false;
      this.pendingChestplateRestore = false;
    }
    return initiated;
  }

  // =========================================================================
  // TARGET GEOMETRY, SHIELD DETECTION & PREDICTION HELPERS
  // =========================================================================

  _getReachDistance(target) {
    if (this.combat && typeof this.combat.getReachDistance === 'function') {
      return this.combat.getReachDistance(target);
    }
    if (!this.bot || !this.bot.entity || !target || !target.position) return Infinity;
    const eye = this.aimer
      ? this.aimer.getEyePosition()
      : this.bot.entity.position.offset(0, 1.62, 0);
    const halfWidth = 0.3;
    const height = target.height || 1.8;

    const cx = clamp(eye.x, target.position.x - halfWidth, target.position.x + halfWidth);
    const cy = clamp(eye.y, target.position.y, target.position.y + height);
    const cz = clamp(eye.z, target.position.z - halfWidth, target.position.z + halfWidth);
    return eye.distanceTo(new Vec3(cx, cy, cz));
  }

  _isTargetRaisingShield(target) {
    if (this.combat && typeof this.combat.isTargetRaisingShield === 'function') {
      return this.combat.isTargetRaisingShield(target);
    }
    if (!target || !target.isValid) return false;
    const equipment = target.equipment || [];
    const hasShield = equipment.some((item) => item && item.name === 'shield');
    if (!hasShield) return false;

    const handFlags = target.metadata && target.metadata[8];
    if (typeof handFlags === 'number') {
      return (handFlags & 0x01) !== 0;
    }
    return Boolean(target.usingHeldItem || target.isUsingItem);
  }

  _getPredictedPosition(target, leadTicks = 3) {
    if (!target || !target.position) return new Vec3(0, 0, 0);
    if (this.prediction && typeof this.prediction.predictPosition === 'function') {
      const pred = this.prediction.predictPosition(target, leadTicks);
      if (pred && pred.position) return pred.position.clone();
    }
    const vel = target.velocity || new Vec3(0, 0, 0);
    return new Vec3(
      target.position.x + vel.x * leadTicks,
      target.position.y + vel.y * leadTicks * 0.4,
      target.position.z + vel.z * leadTicks
    );
  }

  _aimAtTarget(target, leadTicks = 2, options = {}) {
    if (!this.aimer || !target || !target.position) {
      return { aligned: false, yawErrorDeg: 180, pitchErrorDeg: 90 };
    }
    const predPos = this._getPredictedPosition(target, leadTicks);
    const heightOffset = options.heightOffset !== undefined
      ? options.heightOffset
      : (target.height ? target.height * 0.65 : 1.15);
    return this.aimer.stepTowardsPoint(predPos.offset(0, heightOffset, 0), {
      speedMultiplier: options.speedMultiplier || 1.35,
      toleranceRad: options.toleranceRad !== undefined ? options.toleranceRad : 0.25
    });
  }

  _markShieldDisabled() {
    if (this.combat) {
      const duration = this.combatCfg.shieldDisableDurationMs || 5000;
      this.combat.targetShieldDisabledUntil = Date.now() + duration;
    }
  }

  _setAirborneMove(forward, sprint = false) {
    if (!this.bot || typeof this.bot.setControlState !== 'function') return;
    this.bot.setControlState('forward', forward);
    this.bot.setControlState('back', false);
    this.bot.setControlState('sprint', sprint);
  }

  // =========================================================================
  // MAIN 20-TPS TICK LOOP
  // =========================================================================

  /**
   * 20-TPS aerial handler.
   * Always updates `fallDistance` every tick.
   * Returns `true` if `AerialModule` took control this tick.
   */
  tick(target) {
    this.swappedThisTick = false;

    if (!this.bot || !this.bot.entity || !this.bot.entity.position) {
      return false;
    }

    // 1. Always track accurate fall distance every tick
    this._updateFallDistance();

    // Release any pending item activation from the previous tick
    if (this.fireworkDeactivatePending) {
      this.fireworkDeactivatePending = false;
      if (typeof this.bot.deactivateItem === 'function') {
        try { this.bot.deactivateItem(); } catch (_) {}
      }
    }
    if (this.spearDeactivatePending) {
      this.spearDeactivatePending = false;
      if (typeof this.bot.deactivateItem === 'function') {
        try { this.bot.deactivateItem(); } catch (_) {}
      }
    }
    if (this.clutchDeactivatePending) {
      this.clutchDeactivatePending = false;
      if (typeof this.bot.deactivateItem === 'function') {
        try { this.bot.deactivateItem(); } catch (_) {}
      }
    }

    // Complete deferred safe chestplate restore if we cancelled mid-air earlier
    if (this.mode === AERIAL_MODES.IDLE && this.pendingChestplateRestore && this._isSafeToRestoreChestplate()) {
      this._restoreChestplate();
      return true;
    }

    // 2. Continue active aerial state machine if already engaged
    if (this.mode === AERIAL_MODES.CLUTCH) {
      return this._tickClutch();
    }
    if (this.mode === AERIAL_MODES.STUN_SLAM) {
      return this._tickStunSlam(target);
    }
    if (this.mode === AERIAL_MODES.MACE_LAUNCH) {
      return this._tickMaceLaunch(target);
    }
    if (this.mode === AERIAL_MODES.SPEAR_MACE) {
      return this._tickSpearMace(target);
    }
    if (this.mode === AERIAL_MODES.ELYTRA_DIVE) {
      return this._tickElytraDive(target);
    }

    // 3. Standalone lethal fall-damage clutch safety check when idle
    if (this._shouldTriggerClutch(target)) {
      this._enterClutch();
      return this._tickClutch();
    }

    if (!target || !target.isValid || !target.position) {
      return false;
    }

    // 4. Evaluate offensive aerial triggers in tactical priority order:
    //    (a) Stun Slam (airborne descending onto shielded enemy)
    if (this._canStartStunSlam(target)) {
      this.mode = AERIAL_MODES.STUN_SLAM;
      this.stage = 'AXE_BREAK';
      this.stageTicks = 0;
      this.stunSlamAxeSwapped = false;
      return this._tickStunSlam(target);
    }

    //    (a2) Opportunistic Aerial Mace Smash (already falling >1.8b near unshielded enemy with Mace!)
    if (this._canStartOpportunisticMaceSmash(target)) {
      this.mode = AERIAL_MODES.MACE_LAUNCH;
      this.stage = 'AIRBORNE_DESCENT';
      this.stageTicks = 0;
      this.spearLaunchTicks = 3;
      return this._tickMaceLaunch(target);
    }

    //    (b) Elytra Mace Dive (> 18b away or after vertical launch)
    if (this._canStartElytraDive(target)) {
      this._enterElytraDive();
      return this._tickElytraDive(target);
    }

    //    (c) Spear-to-Mace Chain (3.1-4.6b mid-range with Spear/Trident + Wind Charge + Mace)
    if (this._canStartSpearMace(target)) {
      this.mode = AERIAL_MODES.SPEAR_MACE;
      this.stage = 'SPEAR_THRUST';
      this.stageTicks = 0;
      this.spearThrustDone = false;
      this.spearLaunchTicks = 0;
      return this._tickSpearMace(target);
    }

    //    (d) Direct Wind Charge Mace Launch -> Stun Slam / Breach Mace Smash (open sky, 3–12b)
    if (this._canStartMaceLaunch(target)) {
      this.mode = AERIAL_MODES.MACE_LAUNCH;
      this.stage = 'WIND_CHARGE_LAUNCH';
      this.stageTicks = 0;
      this.spearLaunchTicks = 0;
      return this._tickMaceLaunch(target);
    }

    return false;
  }

  _hasClearSkyAbove(blocks = 5) {
    if (!this.bot || !this.bot.entity || typeof this.bot.blockAt !== 'function') return true;
    const pos = this.bot.entity.position;
    for (let dy = 2; dy <= blocks + 1; dy++) {
      const b = this.bot.blockAt(pos.offset(0, dy, 0));
      if (b && b.boundingBox === 'block') return false;
    }
    return true;
  }

  _canStartOpportunisticMaceSmash(target) {
    if (!target || !target.isValid || !this.bot.entity) return false;
    const { onGround, inWater, inLava } = this._getEnvironmentFlags();
    if (onGround || inWater || inLava) return false;
    const velY = this.bot.entity.velocity ? this.bot.entity.velocity.y : 0;
    const minFall = this.aerialCfg.stunSlamMinFallDistance !== undefined
      ? this.aerialCfg.stunSlamMinFallDistance
      : 1.8;
    if (velY >= -0.05 || this.fallDistance < minFall) return false;
    if (!this._findMace()) return false;
    return this.bot.entity.position.distanceTo(target.position) <= 5.5;
  }

  _canStartMaceLaunch(target) {
    if (this.aerialCfg.maceLaunchEnabled === false) return false;
    if (!target || !target.isValid || !this.bot.entity) return false;
    const { onGround, inWater, inLava } = this._getEnvironmentFlags();
    if (!onGround || inWater || inLava) return false;

    const now = Date.now();
    const cooldown = this.aerialCfg.maceLaunchCooldownMs || 2800;
    if ((now - this.lastMaceLaunchTime) < cooldown) return false;

    const dist = this.bot.entity.position.distanceTo(target.position);
    if (dist < 2.5 || dist > 12.0) return false;

    if (!this._findMace() || !this._findItemByName('wind_charge')) return false;
    if (!this._hasClearSkyAbove(5)) return false;

    return true;
  }

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

    if (this.stage === 'WIND_CHARGE_LAUNCH') {
      if (this.stageTicks > 20) {
        this.cancel();
        return false;
      }
      const windSel = this._findItemByName('wind_charge');
      if (!windSel) {
        this.cancel();
        return false;
      }

      const eq = this._equipHand(windSel);
      const aimStatus = this.aimer.stepTowardsAngles(this.bot.entity.yaw, -Math.PI / 2, {
        speedMultiplier: 1.9,
        toleranceRad: 0.18
      });

      if (eq.ready && !eq.swapped && aimStatus.pitchErrorDeg <= 12) {
        if (typeof this.bot.setControlState === 'function') {
          this.bot.setControlState('jump', true);
          this.bot.setControlState('forward', true);
        }
        if (typeof this.bot.activateItem === 'function') {
          this.bot.activateItem(false);
        }
        this.spearDeactivatePending = true;
        this.lastMaceLaunchTime = Date.now();
        this.stage = 'AIRBORNE_DESCENT';
        this.stageTicks = 0;
        this.spearLaunchTicks = 0;
        return true;
      }
      return true;
    }

    if (this.stage === 'AIRBORNE_DESCENT') {
      this.spearLaunchTicks++;
      if (this.spearLaunchTicks === 1 && typeof this.bot.setControlState === 'function') {
        this.bot.setControlState('jump', false);
      }

      if ((onGround || inWater) && this.spearLaunchTicks > 2) {
        this.stage = 'SWORD_RESTORE';
        return this._tickSwordRestore();
      }
      if (this.spearLaunchTicks > 75) {
        this.stage = 'SWORD_RESTORE';
        return this._tickSwordRestore();
      }

      // Actively steer horizontally toward predicted target so smash lands cleanly on target
      const aimStatus = this._aimAtTarget(target, 2, {
        speedMultiplier: 1.6,
        toleranceRad: 0.34
      });
      this._setAirborneMove(aimStatus.yawErrorDeg < 50 && reachDist > 1.8, false);

      const minFall = this.aerialCfg.stunSlamMinFallDistance !== undefined
        ? this.aerialCfg.stunSlamMinFallDistance
        : 1.8;

      if (velY < -0.05) {
        // If target raised shield while we descend -> Stun Slam (Axe break -> next-tick Breach Mace smash!)
        if (
          this.aerialCfg.stunSlamEnabled !== false &&
          this.fallDistance >= minFall &&
          this._isTargetRaisingShield(target) &&
          this._findAxe() &&
          this._findMace()
        ) {
          this.mode = AERIAL_MODES.STUN_SLAM;
          this.stage = 'AXE_BREAK';
          this.stageTicks = 0;
          this.stunSlamAxeSwapped = false;
          return this._tickStunSlam(target);
        }

        // Pre-equip Breach Mace / Mace on descent and smash on impact!
        const maceSel = this._findMace();
        if (maceSel) {
          const eq = this._equipHand(maceSel);
          if (
            eq.ready &&
            !eq.swapped &&
            this.fallDistance >= minFall &&
            reachDist <= reach + 0.15 &&
            (aimStatus.aligned || aimStatus.yawErrorDeg < 28)
          ) {
            this.bot.attack(target);
            this.stage = 'SWORD_RESTORE';
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
  }

  // =========================================================================
  // 2. STUN SLAM (Axe Shield-Break -> Next-Tick Breach Mace Smash -> Sword)
  // =========================================================================

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
  }

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
      toleranceRad: 0.28
    });
    this._setAirborneMove(aimStatus.yawErrorDeg < 45, false);

    // --- Stage 1: Equip hotbar Axe & break target's shield ---
    if (this.stage === 'AXE_BREAK') {
      const axeSel = this._findAxe();
      if (!axeSel) {
        this.stage = 'MACE_SMASH';
        return true;
      }

      // Predict next-tick reach so Axe is swapped 1 tick before entering 3.0b reach (or <= 3.2b)
      const projectedReach = reachDist - Math.abs(velY);
      const readyToEquipAxe = reachDist <= 3.2 || projectedReach <= reach;

      if (readyToEquipAxe) {
        const eq = this._equipHand(axeSel);
        // Break shield when within 3.0b reach and smoothly aligned
        if (eq.ready && reachDist <= reach && aimStatus.aligned) {
          this.bot.attack(target);
          this._markShieldDisabled();
          this.stage = 'MACE_SMASH';
          return true;
        }
      }
      return true;
    }

    // --- Stage 2 (Very next tick): Swap to Breach Mace & land smash before ground ---
    if (this.stage === 'MACE_SMASH') {
      const maceSel = this._findMace();
      if (!maceSel) {
        this.stage = 'SWORD_RESTORE';
        return this._tickSwordRestore();
      }

      const eq = this._equipHand(maceSel);
      if (eq.ready && reachDist <= reach && aimStatus.aligned) {
        this.bot.attack(target);
        this.stage = 'SWORD_RESTORE';
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
  }

  _finishToSwordRestore() {
    this.stage = 'SWORD_RESTORE';
  }

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
  }

  // =========================================================================
  // 3. SPEAR-TO-MACE CHAIN (Spear Thrust -> -90 deg Wind Charge -> Smash/Clutch)
  // =========================================================================

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
  }

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
        this.spearDeactivatePending = true;
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

  // =========================================================================
  // 4. ELYTRA MACE DIVE (6-Stage Sequential Pipeline)
  // =========================================================================

  _canStartElytraDive(target) {
    if (!this.aerialCfg.enableElytraMace) return false;
    if (!target || !target.isValid || !target.position) return false;

    const { inWater, inLava } = this._getEnvironmentFlags();
    if (inWater || inLava) return false;

    // Must carry elytra, firework_rocket, chestplate (torso or inventory), and mace
    if (!this._hasElytraAvailable()) return false;
    if (!this._findItemByName('firework_rocket')) return false;
    if (!this._hasChestplateAvailable()) return false;
    if (!this._findMace()) return false;

    const minDist = this.aerialCfg.elytraMinDistance !== undefined
      ? this.aerialCfg.elytraMinDistance
      : 20.0;
    const dist = this.bot.entity.position.distanceTo(target.position);

    const velY = this.bot.entity.velocity ? this.bot.entity.velocity.y : 0;
    const heightAboveGround = this._getHeightAboveGround();
    const afterVerticalLaunch = !this.bot.entity.onGround &&
      dist >= 6.0 &&
      (velY >= 0.55 || (velY > 0.05 && heightAboveGround >= 2.2));

    return dist > minDist || afterVerticalLaunch;
  }

  _enterElytraDive() {
    const boostMin = this.aerialCfg.elytraBoostPitchMinDeg !== undefined
      ? this.aerialCfg.elytraBoostPitchMinDeg
      : 65;
    const boostMax = this.aerialCfg.elytraBoostPitchMaxDeg !== undefined
      ? this.aerialCfg.elytraBoostPitchMaxDeg
      : 75;
    const diveMin = this.aerialCfg.elytraDivePitchMinDeg !== undefined
      ? this.aerialCfg.elytraDivePitchMinDeg
      : -85;
    const diveMax = this.aerialCfg.elytraDivePitchMaxDeg !== undefined
      ? this.aerialCfg.elytraDivePitchMaxDeg
      : -75;

    this.mode = AERIAL_MODES.ELYTRA_DIVE;
    this.stage = 'EQUIP_ELYTRA';
    this.stageTicks = 0;
    this.elytraEquipTicks = 0;
    this.takeoffJumped = false;
    this.isGliding = false;
    this.fireworkFired = false;
    this.climbTicksAfterBoost = 0;
    this.boostPitchRad = ((boostMin + boostMax) * 0.5) * DEG_TO_RAD;
    this.divePitchRad = ((diveMin + diveMax) * 0.5) * DEG_TO_RAD;
  }

  _tickElytraDive(target) {
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
    const { onGround, inWater } = this._getEnvironmentFlags();
    const reach = this.combatCfg.reach || DEFAULT_REACH;
    const reachDist = this._getReachDistance(target);

    // -----------------------------------------------------------------------
    // Stage 1: EQUIP_ELYTRA — Swap Chestplate (slot 6) with elytra, wait 1-2 ticks
    // -----------------------------------------------------------------------
    if (this.stage === 'EQUIP_ELYTRA') {
      const equipDelay = this.aerialCfg.elytraEquipDelayTicks !== undefined
        ? this.aerialCfg.elytraEquipDelayTicks
        : 2;

      // Aim horizontally toward target during preparation
      const dx = target.position.x - pos.x;
      const dz = target.position.z - pos.z;
      const yawToTarget = Math.atan2(-dx, -dz);
      this.aimer.stepTowardsAngles(yawToTarget, 15 * DEG_TO_RAD, { speedMultiplier: 1.3 });

      if (!this.elytraSwappedIn) {
        const torso = this._getTorsoItem();
        if (torso && torso.name && torso.name.endsWith('_chestplate')) {
          this.savedChestplateName = torso.name;
        }

        if (this._isWearingElytra()) {
          this.elytraSwappedIn = true;
          this.elytraEquipTicks = 0;
        } else {
          const elytraSel = this._findItemByName('elytra');
          if (!elytraSel) {
            this.cancel();
            return false;
          }
          if (this._equipTorso(elytraSel.item)) {
            this.elytraSwappedIn = true;
            this.elytraEquipTicks = 0;
          }
          return true;
        }
      }

      this.elytraEquipTicks++;
      if (this.elytraEquipTicks >= equipDelay) {
        this.stage = 'TAKEOFF';
        this.stageTicks = 0;
        // Execute takeoff check on this tick (exactly `equipDelay` ticks after swap)
        return this._tickElytraTakeoff(target, onGround);
      }

      return true;
    }

    // -----------------------------------------------------------------------
    // Stage 2: TAKEOFF — Jump if grounded, then send start_fall_flying (actionId: 8)
    // -----------------------------------------------------------------------
    if (this.stage === 'TAKEOFF') {
      return this._tickElytraTakeoff(target, onGround);
    }

    // -----------------------------------------------------------------------
    // Stage 3: BOOST_CLIMB — Pitch smoothly to 65-75 deg, equip & fire firework_rocket
    // -----------------------------------------------------------------------
    if (this.stage === 'BOOST_CLIMB') {
      if (onGround && this.fireworkFired && this.climbTicksAfterBoost > 3) {
        this._restoreChestplate();
        this._resetState();
        return true;
      }

      const predPos = this._getPredictedPosition(target, 4);
      const dx = predPos.x - pos.x;
      const dz = predPos.z - pos.z;
      const horizDist = Math.sqrt(dx * dx + dz * dz);
      const yawToTarget = Math.atan2(-dx, -dz);

      const aimStatus = this.aimer.stepTowardsAngles(yawToTarget, this.boostPitchRad, {
        speedMultiplier: 1.65,
        toleranceRad: 0.14
      });

      if (!this.fireworkFired) {
        const rocketSel = this._findItemByName('firework_rocket');
        if (!rocketSel) {
          this.stage = 'DIVE';
          this.stageTicks = 0;
          return true;
        }

        const eq = this._equipHand(rocketSel);
        const currentPitchDeg = this.bot.entity.pitch / DEG_TO_RAD;
        const boostMinDeg = this.aerialCfg.elytraBoostPitchMinDeg !== undefined
          ? this.aerialCfg.elytraBoostPitchMinDeg
          : 65;
        const boostMaxDeg = this.aerialCfg.elytraBoostPitchMaxDeg !== undefined
          ? this.aerialCfg.elytraBoostPitchMaxDeg
          : 75;
        const inBoostBand = currentPitchDeg >= boostMinDeg && currentPitchDeg <= boostMaxDeg;
        if (eq.ready && !eq.swapped && (inBoostBand || aimStatus.pitchErrorDeg <= 5)) {
          if (typeof this.bot.activateItem === 'function') {
            this.bot.activateItem(false);
          }
          this.fireworkFired = true;
          this.fireworkDeactivatePending = true;
          this.climbTicksAfterBoost = 0;
        }
        return true;
      }

      this.climbTicksAfterBoost++;
      const heightAboveTarget = pos.y - predPos.y;
      const readyToDive =
        heightAboveTarget >= 10.0 ||
        (heightAboveTarget >= 5.0 && horizDist <= 10.0) ||
        this.climbTicksAfterBoost >= 14;

      if (readyToDive) {
        this.stage = 'DIVE';
        this.stageTicks = 0;
      }
      return true;
    }

    // -----------------------------------------------------------------------
    // Stage 4: DIVE — Steer above predicted XZ (4 ticks), pitch -75 to -85 deg
    // -----------------------------------------------------------------------
    if (this.stage === 'DIVE') {
      if (onGround || inWater) {
        this._restoreChestplate();
        this.stage = 'SWORD_RESTORE';
        return true;
      }

      const predPos = this._getPredictedPosition(target, 4);
      const dx = predPos.x - pos.x;
      const dz = predPos.z - pos.z;
      const horizDist = Math.sqrt(dx * dx + dz * dz);
      const heightAboveTarget = pos.y - predPos.y;
      const strikeHeight = this.aerialCfg.elytraStrikeHeight !== undefined
        ? this.aerialCfg.elytraStrikeHeight
        : 3.5;

      // Transition to Stage 5 (STRIKE) once <= 3.5 blocks above target
      if (heightAboveTarget <= strikeHeight && (horizDist <= 6.0 || reachDist <= 5.0)) {
        this.stage = 'STRIKE_CHESTPLATE';
        this.stageTicks = 0;
        return this._tickElytraStrikeChestplate(target);
      }

      // If far horizontally from target while low and about to hit ground, clutch!
      if (heightAboveTarget <= strikeHeight && horizDist > 6.0 && this._shouldTriggerClutch(target, true)) {
        this._enterClutch();
        return this._tickClutch();
      }

      const yawToPred = Math.atan2(-dx, -dz);
      const diveMinRad = (this.aerialCfg.elytraDivePitchMinDeg !== undefined
        ? this.aerialCfg.elytraDivePitchMinDeg
        : -85) * DEG_TO_RAD;
      const diveMaxRad = (this.aerialCfg.elytraDivePitchMaxDeg !== undefined
        ? this.aerialCfg.elytraDivePitchMaxDeg
        : -75) * DEG_TO_RAD;

      // Glide toward predicted XZ when far out; lock steep -75..-85 deg dive once closing above target
      let targetPitchRad;
      if (horizDist > Math.max(12.0, heightAboveTarget * 1.15)) {
        const directPitch = Math.atan2((predPos.y + 4.0) - pos.y, Math.max(0.1, horizDist));
        targetPitchRad = clamp(directPitch, diveMaxRad, -15 * DEG_TO_RAD);
      } else {
        const steepPitch = Math.atan2(predPos.y - pos.y, Math.max(0.1, horizDist));
        targetPitchRad = clamp(steepPitch, diveMinRad, diveMaxRad);
      }

      this.aimer.stepTowardsAngles(yawToPred, targetPitchRad, {
        speedMultiplier: 1.65,
        toleranceRad: 0.16
      });

      return true;
    }

    // -----------------------------------------------------------------------
    // Stage 5a: STRIKE_CHESTPLATE — Swap Chestplate back into slot 6
    // -----------------------------------------------------------------------
    if (this.stage === 'STRIKE_CHESTPLATE') {
      return this._tickElytraStrikeChestplate(target);
    }

    // -----------------------------------------------------------------------
    // Stage 5b: STRIKE_EQUIP_MACE — Equip Breach Mace (or best Mace) on next tick
    // -----------------------------------------------------------------------
    if (this.stage === 'STRIKE_EQUIP_MACE') {
      this._aimAtTarget(target, 1, { speedMultiplier: 1.5, toleranceRad: 0.28 });
      const maceSel = this._findMace();
      if (maceSel) {
        this._equipHand(maceSel);
      }
      this.stage = 'STRIKE_SMASH';
      return true;
    }

    // -----------------------------------------------------------------------
    // Stage 5c: STRIKE_SMASH — Execute Mace smash on next tick; Stage 6 CLUTCH on miss
    // -----------------------------------------------------------------------
    if (this.stage === 'STRIKE_SMASH') {
      if (onGround || inWater) {
        this.stage = 'SWORD_RESTORE';
        return this._tickSwordRestore();
      }

      const aimStatus = this._aimAtTarget(target, 1, {
        speedMultiplier: 1.6,
        toleranceRad: 0.28
      });

      const maceSel = this._findMace();
      let holdingMace = maceSel ? this._isHoldingSelection(maceSel) : false;
      if (!holdingMace && maceSel) {
        const eq = this._equipHand(maceSel);
        holdingMace = eq.ready && !eq.swapped;
      }

      if (holdingMace && reachDist <= reach && aimStatus.aligned) {
        this.bot.attack(target);
        this.stage = 'SWORD_RESTORE';
        return true;
      }

      // Stage 6 (CLUTCH): Missed smash while descending with lethal fallDistance near ground
      if (velY < -0.05 && this._shouldTriggerClutch(target, true)) {
        this._enterClutch();
        return this._tickClutch();
      }

      // Safety timeout
      if (this.stageTicks > 30) {
        this.stage = 'SWORD_RESTORE';
        return this._tickSwordRestore();
      }

      return true;
    }

    return false;
  }

  _tickElytraTakeoff(target, onGround) {
    const pos = this.bot.entity.position;
    const dx = target.position.x - pos.x;
    const dz = target.position.z - pos.z;
    const yawToTarget = Math.atan2(-dx, -dz);

    this.aimer.stepTowardsAngles(yawToTarget, 25 * DEG_TO_RAD, { speedMultiplier: 1.4 });

    if (onGround) {
      if (typeof this.bot.setControlState === 'function') {
        this.bot.setControlState('jump', true);
      }
      this.takeoffJumped = true;
      return true;
    }

    if (typeof this.bot.setControlState === 'function') {
      this.bot.setControlState('jump', false);
    }

    // Send start_fall_flying packet (actionId: 8) with safe client guard
    if (this.bot._client && typeof this.bot._client.write === 'function') {
      this.bot._client.write('entity_action', {
        entityId: this.bot.entity.id,
        actionId: 8,
        jumpBoost: 0
      });
    }

    this.isGliding = true;
    this.stage = 'BOOST_CLIMB';
    this.stageTicks = 0;
    return true;
  }

  _tickElytraStrikeChestplate(target) {
    this._aimAtTarget(target, 1, { speedMultiplier: 1.5, toleranceRad: 0.28 });
    this.isGliding = false;
    this._restoreChestplate();
    this.stage = 'STRIKE_EQUIP_MACE';
    return true;
  }

  // =========================================================================
  // 5. FALL-DAMAGE CLUTCH (Stage 6 / Standalone Water Bucket & Wind Charge)
  // =========================================================================

  _shouldTriggerClutch(target, allowNearTargetMiss = false) {
    const { onGround, inWater, inLava, inCobweb } = this._getEnvironmentFlags();
    if (onGround || inWater || inLava || inCobweb) return false;

    const velY = this.bot.entity.velocity ? this.bot.entity.velocity.y : 0;
    if (velY >= -0.05) return false;

    const minFall = this.aerialCfg.clutchMinFallDistance !== undefined
      ? this.aerialCfg.clutchMinFallDistance
      : 4.0;
    if (this.fallDistance < minFall) return false;

    const heightAboveGround = this._getHeightAboveGround();
    if (heightAboveGround > 3.5) return false;

    const hasClutchTool = Boolean(
      this._findItemByName('water_bucket') || this._findItemByName('wind_charge')
    );
    if (!hasClutchTool) return false;

    // If a smash is still cleanly in reach and we weren't explicitly invoked for a miss, let smash land
    if (!allowNearTargetMiss && target && target.isValid) {
      const reach = this.combatCfg.reach || DEFAULT_REACH;
      if (this._getReachDistance(target) <= reach && this._findMace()) {
        return false;
      }
    }

    return true;
  }

  _enterClutch() {
    this.mode = AERIAL_MODES.CLUTCH;
    this.stage = 'CLUTCH_EXECUTE';
    this.stageTicks = 0;
    this.clutchActivated = false;
    this.clutchItemName = null;
  }

  _tickClutch() {
    this.stageTicks++;

    const { onGround, inWater, inCobweb } = this._getEnvironmentFlags();
    if (onGround || inWater || inCobweb) {
      if (this.elytraSwappedIn || this.pendingChestplateRestore) {
        this._restoreChestplate();
      }
      const swordSel = this._findSword();
      if (swordSel && !this.swappedThisTick) {
        this._equipHand(swordSel);
      }
      this._resetState();
      return true;
    }

    if (this.stage === 'CLUTCH_RECOVER' || this.stageTicks > 25) {
      if (this.elytraSwappedIn || this.pendingChestplateRestore) {
        this._restoreChestplate();
      }
      this._resetState();
      return true;
    }

    const clutchSel = this._findItemByName('water_bucket') || this._findItemByName('wind_charge');
    if (!clutchSel) {
      this._resetState();
      return false;
    }

    this.clutchItemName = clutchSel.item.name;
    const eq = this._equipHand(clutchSel);

    // Smoothly pitch straight down (-90 deg = -PI/2)
    const aimStatus = this.aimer.stepTowardsAngles(this.bot.entity.yaw, -Math.PI / 2, {
      speedMultiplier: 1.85,
      toleranceRad: 0.16
    });

    const heightAboveGround = this._getHeightAboveGround();

    // Activate clutch item sequentially after equip once pitched down near ground
    if (eq.ready && !eq.swapped && aimStatus.pitchErrorDeg <= 14 && heightAboveGround <= 3.5) {
      if (typeof this.bot.activateItem === 'function') {
        this.bot.activateItem(false);
      }
      this.clutchActivated = true;
      this.clutchDeactivatePending = true;
      this.stage = 'CLUTCH_RECOVER';
      return true;
    }

    return true;
  }
}

module.exports = {
  AerialModule,
  AERIAL_MODES
};
