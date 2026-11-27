'use strict';

const { Vec3 } = require('vec3');
const { clamp, DEG_TO_RAD } = require('./aim');
const {
  TORSO_SLOT,
  HOTBAR_START: DEFAULT_HOTBAR_START,
  SWORD_PRIORITY,
  AXE_PRIORITY,
  CHESTPLATE_PRIORITY,
  isSpearItem,
  hasItemEnchant
} = require('./constants');
const {
  scanWeaponEnchantments,
  selectMaceForFall,
  buildTargetState,
  hasSlowFalling,
  detectEnemyDiveBomb
} = require('./mace_elytra');
const { AERIAL_MODES } = require('./aerial/constants');

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
const { pearlCatchMethods } = require('./aerial/pearl_catch');
const { maceComboMethods } = require('./aerial/mace_combos');
const { spearMaceMethods } = require('./aerial/spear_mace');
const { elytraSkillMethods } = require('./aerial/elytra_skills');
const { defenseClutchMethods } = require('./aerial/defense_clutch');

class AerialModule {
  constructor(bot, config, aimer, prediction = null, combat = null) {
    this.bot = bot;
    this.config = config || {};
    this.aerialCfg = this.config.aerial || {};
    this.combatCfg = this.config.combat || {};
    this.aimer = aimer;
    this.prediction = prediction;
    this.combat = combat;

    // Fall distance & teleport detection tracking
    this.fallDistance = 0;
    this.lastY = (bot && bot.entity && bot.entity.position) ? bot.entity.position.y : null;
    this.lastBotPos = (bot && bot.entity && bot.entity.position) ? bot.entity.position.clone() : null;
    this.teleportedThisTick = false;
    this.postTeleportWaitTicks = 0;

    // Active aerial state machine
    this.mode = AERIAL_MODES.IDLE;
    this.stage = null;
    this.stageTicks = 0;

    // Inventory / async equip guards
    this.equipBusy = false;
    this.swappedThisTick = false;

    // Stun Slam state
    this.stunSlamAxeSwapped = false;

    // Spear-to-Mace, Wind Burst Chain & Direct Mace Launch state
    this.lastSpearMaceTime = 0;
    this.lastMaceLaunchTime = 0;
    this.spearThrustDone = false;
    this.spearLaunchTicks = 0;
    this.windBurstBounceTicks = 0;
    this.windBurstChainCount = 0;
    this.maceJumpTicks = 0;

    // Wind Burst Pearl Catching state (both self-pearl catch & enemy-pearl interception)
    this.lastPearlCatchTime = 0;
    this.pearlCatchLandingTarget = null;
    this.pearlCatchTicks = 0;
    this.trackedEnemyPearl = null; // { entity, landingPos, expiresAt }

    // Elytra Mace Dive & Elytra Spear state
    this.savedChestplateName = null;
    this.elytraSwappedIn = false;
    this.pendingChestplateRestore = false;
    this.elytraEquipTicks = 0;
    this.takeoffJumped = false;
    this.isGliding = false;
    this.boostPitchRad = 70 * DEG_TO_RAD;
    this.fireworkFired = false;
    this.climbTicksAfterBoost = 0;
    this.lastElytraTakeoffTime = 0;
    this.lastRocketTime = 0;
    this.elytraAirborneTicks = 0;
    this.elytraFlightTicks = 0;
    this.elytraGlideRetrySent = false;
    this.elytraSpearCharging = false;
    this.elytraSpearChargeTicks = 0;
    this.elytraSpearHitTarget = false;
    this.elytraSpearTargetId = null;
    this.elytraSpearAttackNextTick = false;
    this.elytraPullUpYaw = 0;

    // Fall-damage clutch state
    this.clutchItemName = null;
    this.clutchActivated = false;

    // 1.21+ Mace & Elytra-Rocket state tracking
    this.targetState = null;
    this.weaponEnchantments = scanWeaponEnchantments(bot);
    this.pearlInterceptVec = null;
    this.elytraConserveTicks = 0;
    this.bHopTicks = 0;
    this.lastDiveDodgeTime = 0;

    // Bind death/respawn cleanup, inventory enchant rescan, target hurt confirmation, & enemy Ender Pearl tracking
    this._onDeath = this._handleDeathOrRespawn.bind(this);
    this._onEntitySpawn = this._handleEntitySpawn.bind(this);
    this._onEntityHurt = (entity) => {
      if (
        this.mode === AERIAL_MODES.ELYTRA_SPEAR &&
        entity &&
        this.elytraSpearTargetId !== null &&
        entity.id === this.elytraSpearTargetId
      ) {
        this.elytraSpearHitTarget = true;
      }
    };
    this._onUpdateSlot = () => {
      this.weaponEnchantments = scanWeaponEnchantments(this.bot);
    };
    if (this.bot && this.bot.inventory && typeof this.bot.inventory.on === 'function') {
      this.bot.inventory.on('updateSlot', this._onUpdateSlot);
    }
    if (this.bot && typeof this.bot.on === 'function') {
      this.bot.on('death', this._onDeath);
      this.bot.on('respawn', this._onDeath);
      this.bot.on('entitySpawn', this._onEntitySpawn);
      this.bot.on('entityHurt', this._onEntityHurt);
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
    if (this.bot && this.bot.inventory && typeof this.bot.inventory.removeListener === 'function') {
      this.bot.inventory.removeListener('updateSlot', this._onUpdateSlot);
    }
    if (this.bot && typeof this.bot.removeListener === 'function') {
      this.bot.removeListener('death', this._onDeath);
      this.bot.removeListener('respawn', this._onDeath);
      this.bot.removeListener('entitySpawn', this._onEntitySpawn);
      this.bot.removeListener('entityHurt', this._onEntityHurt);
    }
    this.cancel();
    this.fallDistance = 0;
    this.lastY = null;
    this.lastBotPos = null;
    this.trackedEnemyPearl = null;
    this.targetState = null;
  }

  _handleDeathOrRespawn() {
    this.fallDistance = 0;
    this.lastY = (this.bot && this.bot.entity && this.bot.entity.position)
      ? this.bot.entity.position.y
      : null;
    this.lastBotPos = (this.bot && this.bot.entity && this.bot.entity.position)
      ? this.bot.entity.position.clone()
      : null;
    this.trackedEnemyPearl = null;
    this.windBurstChainCount = 0;
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
        this.elytraSpearCharging &&
        typeof this.bot.deactivateItem === 'function'
      ) {
        try {
          this.bot.deactivateItem();
        } catch (_) {}
      }
    }

    // Only restore a Chestplate if we explicitly swapped one off (e.g. Elytra Mace Dive),
    // never strip an Elytra worn natively in an Elytra Spear kit!
    if (this.elytraSwappedIn && this.savedChestplateName) {
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
    this.elytraEquipTicks = 0;
    this.takeoffJumped = false;
    this.isGliding = false;
    this.fireworkFired = false;
    this.climbTicksAfterBoost = 0;
    this.elytraAirborneTicks = 0;
    this.elytraFlightTicks = 0;
    this.elytraGlideRetrySent = false;
    this.elytraSpearCharging = false;
    this.elytraSpearChargeTicks = 0;
    this.elytraSpearHitTarget = false;
    this.elytraSpearTargetId = null;
    this.elytraSpearAttackNextTick = false;
    this.clutchItemName = null;
    this.clutchActivated = false;
  }

  /**
   * Returns currently tracked airborne fall distance in blocks.
   */
  getFallDistance() {
    return this.fallDistance;
  }

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
      const velY = this.bot.entity.velocity ? this.bot.entity.velocity.y : 0;
      const dy = this.lastY - pos.y;
      if (dy > 0 && velY <= 0) {
        this.fallDistance += dy;
      } else if (dy < -0.05) {
        // Ascending (e.g. jump, wind charge launch, firework boost) resets accumulated descent
        this.fallDistance = 0;
      }
    }

    this.lastY = pos.y;
  }

  _resetFallAfterSmash() {
    this.fallDistance = 0;
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

  _hasClearSkyAbove(minClearBlocks = 4) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) return true;
    if (typeof this.bot.blockAt !== 'function') return true;
    const pos = this.bot.entity.position;
    const bx = Math.floor(pos.x);
    const bz = Math.floor(pos.z);
    const startY = Math.floor(pos.y) + 2;
    for (let dy = 0; dy < minClearBlocks; dy++) {
      const b = this.bot.blockAt(new Vec3(bx, startY + dy, bz));
      if (b && b.boundingBox === 'block') return false;
    }
    return true;
  }

  /**
   * Notifies the aerial controller that a server teleport packet just arrived.
   * Suppresses Elytra takeoff/packets briefly so teleport confirmation settles cleanly.
   */
  notifyTeleport(waitTicks = 4) {
    this.teleportedThisTick = true;
    this.postTeleportWaitTicks = Math.max(this.postTeleportWaitTicks, waitTicks);
    if (this.mode === AERIAL_MODES.ELYTRA_SPEAR || this.mode === AERIAL_MODES.ELYTRA_DIVE) {
      this._releaseSpearChargeIfActive();
      this._resetState();
    }
  }

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
    return Boolean(item && item.name === 'mace' && hasItemEnchant(item, 'breach'));
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

  _hasWindBurstEnchant(item) {
    if (!item || item.name !== 'mace') return false;
    if (this.combat && typeof this.combat._getEnchantmentLevel === 'function') {
      return this.combat._getEnchantmentLevel(item, 'wind_burst') >= 1;
    }
    return hasItemEnchant(item, 'wind_burst');
  }

  /**
   * Selects the optimal Mace using the 7-Block Enchantment Rule:
   * - `fallDistance > 7` -> Density Mace (per-block scaling damage)
   * - `fallDistance <= 7` -> Breach Mace (armor bypass)
   */
  _findMace(preferWindBurst = true) {
    this.weaponEnchantments = scanWeaponEnchantments(this.bot);
    return selectMaceForFall(this.fallDistance, this.weaponEnchantments, {
      preferWindBurst: preferWindBurst && this.aerialCfg.windBurstChainEnabled !== false
    });
  }

  /**
   * Explicitly prefers the highest-Density Mace for high-altitude Elytra / Pearl-Catch dive smashes,
   * falling back to `_findMace()` when no Density Mace is carried.
   */
  _findDensityMace() {
    this.weaponEnchantments = scanWeaponEnchantments(this.bot);
    if (
      this.weaponEnchantments &&
      this.weaponEnchantments.densityMace &&
      this.weaponEnchantments.densityMace.density > 0
    ) {
      return {
        item: this.weaponEnchantments.densityMace.item,
        hotbarIndex: this.weaponEnchantments.densityMace.hotbarIndex,
        slot: this.weaponEnchantments.densityMace.slot,
        isDensity: true
      };
    }
    return this._findMace(true);
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

    const hotbarSpear = items.find(
      (i) => isSpearItem(i) &&
        typeof i.slot === 'number' &&
        i.slot >= hotbarStart &&
        i.slot < hotbarStart + 9
    );
    if (hotbarSpear) return this._makeSelection(hotbarSpear);

    const invSpear = items.find(isSpearItem);
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

  _getReachDistance(target) {
    if (this.combat && typeof this.combat.getReachDistance === 'function') {
      return this.combat.getReachDistance(target);
    }
    if (!this.bot || !this.bot.entity || !target || !target.position) return Infinity;
    const eye = this.aimer
      ? this.aimer.getEyePosition()
      : this.bot.entity.position.offset(0, 1.62, 0);
    const halfWidth = 0.3;
    const tState = buildTargetState(target);
    const height = (tState && tState.height) || target.height || 1.8;

    const cx = clamp(eye.x, target.position.x - halfWidth, target.position.x + halfWidth);
    const cy = clamp(eye.y, target.position.y, target.position.y + height);
    const cz = clamp(eye.z, target.position.z - halfWidth, target.position.z + halfWidth);
    return eye.distanceTo(new Vec3(cx, cy, cz));
  }

  _isTargetRaisingShield(target) {
    const tState = buildTargetState(target);
    if (tState && tState.isBlocking) return true;
    if (this.combat && typeof this.combat.isTargetRaisingShield === 'function') {
      return this.combat.isTargetRaisingShield(target);
    }
    return false;
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
    const tState = buildTargetState(target);
    const tHeight = (tState && tState.height) || target.height || 1.8;
    const heightOffset = options.heightOffset !== undefined
      ? options.heightOffset
      : tHeight * 0.65;
    return this.aimer.stepTowardsPoint(predPos.offset(0, heightOffset, 0), {
      speedMultiplier: options.speedMultiplier || 1.35,
      toleranceRad: options.toleranceRad !== undefined ? options.toleranceRad : 0.25,
      force: options.force !== undefined ? options.force : true
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

    // 1. Always track accurate fall distance, targetState & teleport jumps every tick
    this._updateFallDistance();
    const curPos = this.bot.entity.position;
    this.teleportedThisTick = Boolean(this.lastBotPos && curPos.distanceTo(this.lastBotPos) > 2.5);
    if (this.teleportedThisTick) {
      this.notifyTeleport(4);
    } else if (this.postTeleportWaitTicks > 0) {
      this.postTeleportWaitTicks--;
    }
    this.lastBotPos = curPos.clone();
    this.targetState = (target && target.isValid) ? buildTargetState(target) : null;

    if (this.trackedEnemyPearl && Date.now() > this.trackedEnemyPearl.expiresAt) {
      this.trackedEnemyPearl = null;
    }

    // Complete deferred safe chestplate restore if we cancelled mid-air earlier
    if (this.mode === AERIAL_MODES.IDLE && this.pendingChestplateRestore && this._isSafeToRestoreChestplate()) {
      this._restoreChestplate();
      return true;
    }

    // 1b. HARD ABORT (Threat Matrix): Slow Falling (effect id 28) disables all Mace dives & stays evasive
    if (hasSlowFalling(this.bot)) {
      if (
        this.mode !== AERIAL_MODES.IDLE &&
        this.mode !== AERIAL_MODES.SLOW_FALL_EVADE &&
        this.mode !== AERIAL_MODES.CLUTCH
      ) {
        this.cancel();
      }
      if (this.mode !== AERIAL_MODES.CLUTCH) {
        return this._tickSlowFallEvade(target);
      }
    } else if (this.mode === AERIAL_MODES.SLOW_FALL_EVADE) {
      this._resetState();
    }

    // 1c. HARD THREAT CHECK: Dodge incoming Enemy Dive Bombs (dy > 5 && vy < -0.6) via Pearl / Wind Charge
    if (
      this.aerialCfg.diveBombDodgeEnabled !== false &&
      this.mode !== AERIAL_MODES.CLUTCH &&
      this.mode !== AERIAL_MODES.DIVE_DODGE &&
      this.targetState
    ) {
      const diveThreat = detectEnemyDiveBomb(this.bot, this.targetState);
      if (diveThreat.threat && (Date.now() - this.lastDiveDodgeTime) >= 1200) {
        if (this._findItemByName('ender_pearl') || this._findItemByName('wind_charge')) {
          this.mode = AERIAL_MODES.DIVE_DODGE;
          this.stage = 'DODGE_EXEC';
          this.stageTicks = 0;
          return this._tickDiveDodge(target);
        }
      }
    }

    // 2. Continue active aerial state machine if already engaged
    if (this.mode === AERIAL_MODES.CLUTCH) {
      return this._tickClutch();
    }
    if (this.mode === AERIAL_MODES.DIVE_DODGE) {
      return this._tickDiveDodge(target);
    }
    if (this.mode === AERIAL_MODES.ELYTRA_BOOST) {
      return this._tickElytraBoost(target);
    }
    if (this.mode === AERIAL_MODES.PEARL_CATCH) {
      return this._tickPearlCatch(target);
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
    if (this.mode === AERIAL_MODES.ELYTRA_SPEAR) {
      return this._tickElytraSpear(target);
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
    //    (a) Shield Countering (BACKSTAB / STUN_SLAM / SHIELD_DRAIN) when airborne descending onto shielded enemy
    if (this._canStartStunSlam(target)) {
      this.mode = AERIAL_MODES.STUN_SLAM;
      this.stage = 'AXE_BREAK';
      this.stageTicks = 0;
      this.stunSlamAxeSwapped = false;
      return this._tickStunSlam(target);
    }

    //    (a1) Wind Burst Pearl Catch (high airborne + enemy dodged horizontally OR threw escape pearl!)
    const pearlCatchPlan = this._evaluatePearlCatchTrigger(target);
    if (pearlCatchPlan) {
      this._enterPearlCatch(pearlCatchPlan);
      return this._tickPearlCatch(target);
    }

    //    (a2) Opportunistic Aerial Mace Smash (already falling >1.8b near unshielded enemy with Mace!)
    if (this._canStartOpportunisticMaceSmash(target)) {
      this.mode = AERIAL_MODES.MACE_LAUNCH;
      this.stage = 'AIRBORNE_DESCENT';
      this.stageTicks = 0;
      this.spearLaunchTicks = 3;
      return this._tickMaceLaunch(target);
    }

    //    (b) Elytra Mace Dive (> 18b away or after vertical launch, when carrying Mace + Chestplate)
    if (this._canStartElytraDive(target)) {
      this._enterElytraDive();
      return this._tickElytraDive(target);
    }

    //    (b2) Elytra Rocket Spear Mode (Elytra + Firework Rocket + Spear/Trident — no Mace or Chestplate required!)
    if (this._canStartElytraSpear(target)) {
      this._enterElytraSpear();
      return this._tickElytraSpear(target);
    }

    //    (c) HT1 Spear-to-Mace Chain (2.4-6.2b with Spear/Trident + Wind Charge + Mace)
    if (this._canStartSpearMace(target)) {
      this._enterSpearMace();
      return this._tickSpearMace(target);
    }

    //    (d) Direct Jump -> Airborne Angled Wind Charge Mace Launch -> Wind Burst Chain / Pearl Catch
    if (this._canStartMaceLaunch(target)) {
      this.mode = AERIAL_MODES.MACE_LAUNCH;
      this.stage = 'JUMP_INIT';
      this.stageTicks = 0;
      this.maceJumpTicks = 0;
      this.spearLaunchTicks = 0;
      this.windBurstBounceTicks = 0;
      return this._tickMaceLaunch(target);
    }

    return false;
  }

  /**
   * Full 360-degree 3D airborne steering: snaps smoothly toward target's predicted hitbox
   * (`force: true`) and projects the horizontal vector onto the bot's local forward/right axes
   * so WASD + sprint air-control drifts directly onto the opponent on every airborne tick
   * (during Wind Burst jumps, Pearl Catches, and post-Elytra Mace smashes).
   */
  _steerAirborneToward(target, leadTicks = 2) {
    const aimStatus = this._aimAtTarget(target, leadTicks, {
      speedMultiplier: 2.0,
      toleranceRad: 0.36,
      force: true
    });

    const pos = this.bot.entity.position;
    const predPos = this._getPredictedPosition(target, leadTicks);
    const dx = predPos.x - pos.x;
    const dz = predPos.z - pos.z;
    const horizDist = Math.sqrt(dx * dx + dz * dz);

    if (typeof this.bot.setControlState === 'function') {
      if (horizDist > 0.65) {
        const nx = dx / horizDist;
        const nz = dz / horizDist;
        const yaw = this.bot.entity.yaw || 0;
        const fx = -Math.sin(yaw);
        const fz = -Math.cos(yaw);
        const rx = Math.cos(yaw);
        const rz = -Math.sin(yaw);

        const fwdDot = nx * fx + nz * fz;
        const rightDot = nx * rx + nz * rz;

        const moveFwd = fwdDot > 0.25;
        const moveBack = fwdDot < -0.35;
        const moveRight = rightDot > 0.25;
        const moveLeft = rightDot < -0.25;

        this.bot.setControlState('forward', moveFwd);
        this.bot.setControlState('back', moveBack);
        this.bot.setControlState('right', moveRight);
        this.bot.setControlState('left', moveLeft);
        this.bot.setControlState('sprint', moveFwd && horizDist > 1.35);
      } else {
        this.bot.setControlState('forward', false);
        this.bot.setControlState('back', horizDist < 0.35);
        this.bot.setControlState('left', false);
        this.bot.setControlState('right', false);
        this.bot.setControlState('sprint', false);
      }
    }

    return { aimStatus, horizDist };
  }
}

Object.assign(
  AerialModule.prototype,
  pearlCatchMethods,
  maceComboMethods,
  spearMaceMethods,
  elytraSkillMethods,
  defenseClutchMethods
);

module.exports = {
  AerialModule,
  AERIAL_MODES
};
