'use strict';

const { Vec3 } = require('vec3');
const { clamp, DEG_TO_RAD } = require('./aim');
const {
  TORSO_SLOT,
  SWORD_PRIORITY,
  AXE_PRIORITY,
  isSpearItem,
  clearMovementControls
} = require('./constants');
const {
  getHotbarStart,
  getInventoryItems,
  findInventoryItem,
  findItemByPredicate,
  ensureItemHeld
} = require('./inventory_utils');
const {
  scanWeaponEnchantments,
  selectMaceForFall,
  buildTargetState,
  hasSlowFalling,
  detectEnemyDiveBomb,
  executeAttributeSwapAttack
} = require('./mace_elytra');
const { AERIAL_MODES } = require('./aerial/constants');
const { elytraFlightMethods } = require('./aerial/elytra_flight');
const { pearlCatchMethods } = require('./aerial/pearl_catch');
const { maceComboMethods } = require('./aerial/mace_combos');
const { spearMaceMethods } = require('./aerial/spear_mace');
const { elytraMaceMethods } = require('./aerial/elytra_mace');
const { elytraSpearMethods } = require('./aerial/elytra_spear');
const { defenseClutchMethods } = require('./aerial/defense_clutch');

/**
 * Modular HT1 Aerial PvP Coordinator combining:
 * - `aerial/elytra_flight.js` — shared torso swap, chestplate restore, takeoff & obstacle raycast
 * - `aerial/mace_combos.js`   — Wind Charge Mace Launch, 3-Branch Shield Stun-Slam, Wind Burst chains
 * - `aerial/spear_mace.js`    — Spear-to-Mace 5-stage chain
 * - `aerial/elytra_mace.js`   — Elytra Mace Dive (7-Block Density/Breach rule)
 * - `aerial/elytra_spear.js`  — Elytra Rocket Spear jousting
 * - `aerial/pearl_catch.js`   — Enemy-pearl intercept & Sky-Pearl Wind Catch
 * - `aerial/defense_clutch.js`— Multi-tool Fall Clutch (with MLG water pickup) & Dive-Bomb Dodge
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

    // Inventory / async equip guards (cached weapon enchantments with dirty flag!)
    this.equipBusy = false;
    this.swappedThisTick = false;
    this.lastAerialCooldownResetTime = 0;
    this._weaponEnchantDirty = true;
    this.weaponEnchantments = scanWeaponEnchantments(bot);

    // Spear-to-Mace, Wind Burst Chain & Direct Mace Launch state
    this.lastSpearMaceTime = 0;
    this.lastMaceLaunchTime = 0;
    this.spearLaunchTicks = 0;
    this.windBurstBounceTicks = 0;
    this.windBurstChainCount = 0;
    this.maceJumpTicks = 0;

    // Pearl Catching state
    this.lastPearlCatchTime = 0;
    this.pearlCatchLandingTarget = null;
    this.trackedEnemyPearl = null;
    this.pearlInterceptVec = null;

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
    this.elytraTakeoffYaw = 0;
    this.elytraPullUpYaw = 0;

    // Defense / clutch state
    this._clutchUsedWater = false;
    this.targetState = null;
    this.lastDiveDodgeTime = 0;

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
      this._weaponEnchantDirty = true;
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

  setPrediction(prediction) {
    this.prediction = prediction;
  }

  setCombat(combat) {
    this.combat = combat;
  }

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
    this._weaponEnchantDirty = true;
    this._resetState(true);
    this.elytraSwappedIn = false;
    this.pendingChestplateRestore = false;
    this.savedChestplateName = null;
  }

  isBusy() {
    return this.mode !== AERIAL_MODES.IDLE;
  }

  cancel() {
    const wasBusy = this.isBusy();

    if (wasBusy && this.bot) {
      clearMovementControls(this.bot);
      if (this.elytraSpearCharging && typeof this.bot.deactivateItem === 'function') {
        try { this.bot.deactivateItem(); } catch (_) {}
      }
    }

    if (this.elytraSwappedIn && this.savedChestplateName) {
      if (this._isSafeToRestoreChestplate()) {
        if (!this._restoreChestplate(true)) {
          this.pendingChestplateRestore = true;
        }
      } else {
        this.pendingChestplateRestore = true;
      }
    }

    this._resetState(false);
  }

  _resetState(releaseControls = false) {
    if (releaseControls && this.bot) {
      clearMovementControls(this.bot);
    }
    this.mode = AERIAL_MODES.IDLE;
    this.stage = null;
    this.stageTicks = 0;
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
    this._clutchUsedWater = false;
  }

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

  notifyTeleport(waitTicks = 4) {
    this.teleportedThisTick = true;
    this.postTeleportWaitTicks = Math.max(this.postTeleportWaitTicks, waitTicks);
    if (this.mode === AERIAL_MODES.ELYTRA_SPEAR || this.mode === AERIAL_MODES.ELYTRA_DIVE) {
      // Use cancel() so chestplate is safely restored / flagged for restore instead of lost!
      this.cancel();
    }
  }

  _getHotbarStart() {
    return getHotbarStart(this.bot);
  }

  _getTorsoSlotIndex() {
    if (this.bot && typeof this.bot.getEquipmentDestSlot === 'function') {
      return this.bot.getEquipmentDestSlot('torso');
    }
    return TORSO_SLOT;
  }

  _getInventoryItems() {
    return getInventoryItems(this.bot);
  }

  _getSlotItem(slotIndex) {
    if (!this.bot || !this.bot.inventory) return null;
    if (Array.isArray(this.bot.inventory.slots) && this.bot.inventory.slots[slotIndex]) {
      return this.bot.inventory.slots[slotIndex];
    }
    return this._getInventoryItems().find((i) => i.slot === slotIndex) || null;
  }

  _getCombatHotbarSlots() {
    if (this.combat && typeof this.combat.getHotbarSlots === 'function') {
      return this.combat.getHotbarSlots() || null;
    }
    return null;
  }

  _getWeaponEnchantments() {
    if (this._weaponEnchantDirty || !this.weaponEnchantments) {
      this.weaponEnchantments = scanWeaponEnchantments(this.bot);
      this._weaponEnchantDirty = false;
    }
    return this.weaponEnchantments;
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
    const found = findInventoryItem(this.bot, name);
    return found ? { item: found.item, hotbarIndex: found.quickBarSlot } : null;
  }

  _findBestByPriority(priorityList, preferredHotbarSlot = -1) {
    const hotbarStart = this._getHotbarStart();
    if (typeof preferredHotbarSlot === 'number' && preferredHotbarSlot >= 0 && preferredHotbarSlot <= 8) {
      const slotItem = this._getSlotItem(hotbarStart + preferredHotbarSlot);
      if (slotItem && priorityList.includes(slotItem.name)) {
        return { item: slotItem, hotbarIndex: preferredHotbarSlot };
      }
    }
    const found = findInventoryItem(this.bot, priorityList);
    return found ? { item: found.item, hotbarIndex: found.quickBarSlot } : null;
  }

  _findMace(preferWindBurst = true) {
    const map = this._getWeaponEnchantments();
    const minDensityFall = this.aerialCfg.densityMinFallDistance !== undefined
      ? this.aerialCfg.densityMinFallDistance
      : 5.0;
    return selectMaceForFall(this.fallDistance, map, {
      preferWindBurst: preferWindBurst && this.aerialCfg.windBurstChainEnabled !== false,
      densityMinFallDistance: minDensityFall
    });
  }

  _findDensityMace() {
    const map = this._getWeaponEnchantments();
    if (map && map.densityMace && map.densityMace.density > 0) {
      return {
        item: map.densityMace.item,
        hotbarIndex: map.densityMace.hotbarIndex,
        slot: map.densityMace.slot,
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
    const found = findItemByPredicate(this.bot, isSpearItem);
    return found ? { item: found.item, hotbarIndex: found.quickBarSlot } : null;
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
   * Strictly anti-cheat-safe hand equip: at most one swap per tick.
   * NEVER returns `ready: true` when `swapped: true` (enforces 1-tick post-swap settle everywhere).
   */
  _equipHand(selection) {
    if (!selection || !selection.item) return { ready: false, swapped: false };
    if (this._isHoldingSelection(selection)) return { ready: true, swapped: false };
    if (this.swappedThisTick) return { ready: false, swapped: false };

    const eq = ensureItemHeld(this.bot, { item: selection.item, quickBarSlot: selection.hotbarIndex });
    if (eq.swapped) {
      this.swappedThisTick = true;
      const now = Date.now();
      this.lastAerialCooldownResetTime = now;
      if (this.combat) {
        this.combat.cooldownResetTime = now;
      }
    }
    return { ready: eq.held, swapped: eq.swapped };
  }

  /**
   * Returns current 1.9+ attack cooldown progress in [0.0, 1.0].
   * Uses `combat.getCooldownProgress()` when attached, with exact per-weapon fallback.
   */
  _getAttackChargeProgress() {
    if (this.combat && typeof this.combat.getCooldownProgress === 'function') {
      return this.combat.getCooldownProgress();
    }
    const heldName = (this.bot && this.bot.heldItem && this.bot.heldItem.name) || '';
    let cooldownMs = 625;
    if (heldName === 'mace') cooldownMs = 1000 / 0.6;
    else if (heldName.endsWith('_axe')) cooldownMs = 1000;
    else if (heldName.endsWith('_sword')) cooldownMs = 625;
    const elapsed = Date.now() - (this.lastAerialCooldownResetTime || 0);
    return clamp(elapsed / cooldownMs, 0, 1);
  }

  /**
   * Determines whether HT1 Same-Tick Attribute Swap (charged Sword -> Mace -> attack)
   * should be used for an aerial Mace smash.
   */
  _shouldUseMaceAttributeSwap(maceSel) {
    if (
      !maceSel ||
      typeof maceSel.hotbarIndex !== 'number' ||
      maceSel.hotbarIndex < 0 ||
      this.aerialCfg.maceAttributeSwap === false ||
      this.combatCfg.sameTickAttributeSwap === false ||
      this.combatCfg.durabilityDrainMode === true
    ) {
      return { enabled: false, swordSel: null };
    }
    const swordSel = this._findSword();
    if (!swordSel || typeof swordSel.hotbarIndex !== 'number' || swordSel.hotbarIndex < 0) {
      return { enabled: false, swordSel: null };
    }
    if (swordSel.hotbarIndex === maceSel.hotbarIndex) {
      return { enabled: false, swordSel: null };
    }
    return { enabled: true, swordSel };
  }

  /**
   * Pre-equips the optimal weapon during aerial ascent/glide/descent so attack cooldown
   * reaches >=88–100% BEFORE impact:
   * - With Attribute Swap enabled: holds Sword (625ms full charge — 2.7x faster than Mace!)
   *   unless Mace is already held and fully charged.
   * - Without Attribute Swap: pre-equips the target Mace early during ascent.
   */
  _prepareMaceWeapon(maceSel) {
    if (!maceSel || !maceSel.item) {
      return { ready: false, swapped: false, useAttributeSwap: false, swordSel: null };
    }
    const minCharge = this.aerialCfg.maceMinChargeRatio !== undefined
      ? this.aerialCfg.maceMinChargeRatio
      : 0.88;
    const swapInfo = this._shouldUseMaceAttributeSwap(maceSel);

    if (swapInfo.enabled) {
      // If we are already holding the exact Mace and it is already fully charged, keep it!
      if (this._isHoldingSelection(maceSel) && this._getAttackChargeProgress() >= minCharge) {
        return { ready: true, swapped: false, useAttributeSwap: false, swordSel: swapInfo.swordSel };
      }
      const eq = this._equipHand(swapInfo.swordSel);
      return {
        ready: eq.ready,
        swapped: eq.swapped,
        useAttributeSwap: true,
        swordSel: swapInfo.swordSel
      };
    }

    const eq = this._equipHand(maceSel);
    return {
      ready: eq.ready,
      swapped: eq.swapped,
      useAttributeSwap: false,
      swordSel: null
    };
  }

  /**
   * Gates aerial Mace smashes until attack cooldown is charged (>= maceMinChargeRatio),
   * while allowing immediate urgent smashes right before ground impact so we NEVER miss a hit!
   */
  _isMaceChargeReady(target, options = {}) {
    if (options.urgent) return true;
    const minCharge = this.aerialCfg.maceMinChargeRatio !== undefined
      ? this.aerialCfg.maceMinChargeRatio
      : 0.88;
    const charge = this._getAttackChargeProgress();
    if (charge >= minCharge) return true;

    // Ground-proximity urgency override: never land on the ground without delivering the smash!
    const heightAboveGround = this._getHeightAboveGround(8);
    const velY = (this.bot && this.bot.entity && this.bot.entity.velocity)
      ? this.bot.entity.velocity.y
      : 0;
    const reachDist = target ? this._getReachDistance(target) : Infinity;

    if (heightAboveGround <= 2.3) return true;
    if (velY < -0.45 && heightAboveGround <= 3.1) return true;
    if (velY < -0.35 && reachDist <= 2.45) return true;

    return false;
  }

  /**
   * Executes an aerial Mace smash: drops sprint, performs either same-tick Attribute Swap
   * (charged Sword -> Density/Breach Mace -> attack) or direct charged Mace attack,
   * synchronizes combat cooldown timers, and resets tracked fallDistance.
   */
  _executeMaceSmash(target, maceSel, options = {}) {
    if (!this.bot || !target) return false;
    if (typeof this.bot.setControlState === 'function') {
      this.bot.setControlState('sprint', false);
    }

    const swapInfo = options.allowAttributeSwap === false
      ? { enabled: false, swordSel: null }
      : this._shouldUseMaceAttributeSwap(maceSel);

    if (swapInfo.enabled && maceSel && !this._isHoldingSelection(maceSel)) {
      executeAttributeSwapAttack(this.bot, target, swapInfo.swordSel, maceSel, {
        durabilityDrainMode: Boolean(this.combatCfg.durabilityDrainMode)
      });
    } else if (typeof this.bot.attack === 'function') {
      this.bot.attack(target);
    }

    const now = Date.now();
    this.lastAerialCooldownResetTime = now;
    if (this.combat) {
      this.combat.lastSwingTime = now;
      this.combat.cooldownResetTime = now;
    }
    this._resetFallAfterSmash();
    return true;
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
    const height = (this.targetState && this.targetState.height) || target.height || 1.8;

    const cx = clamp(eye.x, target.position.x - halfWidth, target.position.x + halfWidth);
    const cy = clamp(eye.y, target.position.y, target.position.y + height);
    const cz = clamp(eye.z, target.position.z - halfWidth, target.position.z + halfWidth);
    return eye.distanceTo(new Vec3(cx, cy, cz));
  }

  _isTargetRaisingShield(target) {
    if (this.targetState && this.targetState.isBlocking) return true;
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
    const tHeight = (this.targetState && this.targetState.height) || target.height || 1.8;
    const heightOffset = options.heightOffset !== undefined
      ? options.heightOffset
      : tHeight * 0.65;
    return this.aimer.stepTowardsPoint(predPos.offset(0, heightOffset, 0), {
      speedMultiplier: options.speedMultiplier || 1.5,
      toleranceRad: options.toleranceRad !== undefined ? options.toleranceRad : 0.25,
      force: options.force
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

  tick(target) {
    this.swappedThisTick = false;

    if (!this.bot || !this.bot.entity || !this.bot.entity.position) {
      return false;
    }

    // 1. Track fall distance, single-pass targetState, & elytra-aware teleport jumps
    this._updateFallDistance();
    const curPos = this.bot.entity.position;
    const glidingNow = Boolean(this.isGliding || this.bot.entity.elytraFlying);
    const tpThreshold = glidingNow ? 6.5 : 2.5;
    this.teleportedThisTick = Boolean(this.lastBotPos && curPos.distanceTo(this.lastBotPos) > tpThreshold);
    if (this.teleportedThisTick) {
      this.notifyTeleport(4);
    } else if (this.postTeleportWaitTicks > 0) {
      this.postTeleportWaitTicks--;
    }
    this.lastBotPos = curPos.clone();
    this.targetState = (target && target.isValid) ? buildTargetState(target) : null;

    if (this.trackedEnemyPearl) {
      if (Date.now() > this.trackedEnemyPearl.expiresAt) {
        this.trackedEnemyPearl = null;
      } else if (typeof this._updateTrackedEnemyPearl === 'function') {
        this._updateTrackedEnemyPearl();
      }
    }

    if (this.mode === AERIAL_MODES.IDLE && this.pendingChestplateRestore && this._isSafeToRestoreChestplate()) {
      this._restoreChestplate();
      return true;
    }

    // 1b. Slow Falling Threat Matrix: disable Mace dives & weave evasively
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
      this._resetState(true);
    }

    // 1c. Incoming Enemy Dive Bomb Dodge
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

    // 2. Continue active aerial state machine
    if (this.mode === AERIAL_MODES.CLUTCH) return this._tickClutch();
    if (this.mode === AERIAL_MODES.DIVE_DODGE) return this._tickDiveDodge(target);
    if (this.mode === AERIAL_MODES.PEARL_CATCH) return this._tickPearlCatch(target);
    if (this.mode === AERIAL_MODES.STUN_SLAM) return this._tickStunSlam(target);
    if (this.mode === AERIAL_MODES.MACE_LAUNCH) return this._tickMaceLaunch(target);
    if (this.mode === AERIAL_MODES.SPEAR_MACE) return this._tickSpearMace(target);
    if (this.mode === AERIAL_MODES.ELYTRA_DIVE) return this._tickElytraDive(target);
    if (this.mode === AERIAL_MODES.ELYTRA_SPEAR) return this._tickElytraSpear(target);

    // 3. Standalone lethal fall-damage clutch safety check when idle
    if (this._shouldTriggerClutch(target)) {
      this._enterClutch();
      return this._tickClutch();
    }

    if (!target || !target.isValid || !target.position) {
      return false;
    }

    // 4. Evaluate offensive aerial triggers in tactical priority order
    if (this._canStartStunSlam(target)) {
      this.mode = AERIAL_MODES.STUN_SLAM;
      this.stage = 'AXE_BREAK';
      this.stageTicks = 0;
      return this._tickStunSlam(target);
    }

    const pearlCatchPlan = this._evaluatePearlCatchTrigger(target);
    if (pearlCatchPlan) {
      this._enterPearlCatch(pearlCatchPlan);
      return this._tickPearlCatch(target);
    }

    if (this._canStartOpportunisticMaceSmash(target)) {
      this.mode = AERIAL_MODES.MACE_LAUNCH;
      this.stage = 'AIRBORNE_DESCENT';
      this.stageTicks = 0;
      this.spearLaunchTicks = 3;
      return this._tickMaceLaunch(target);
    }

    if (this._canStartElytraDive(target)) {
      this._enterElytraDive();
      return this._tickElytraDive(target);
    }

    if (this._canStartElytraSpear(target)) {
      this._enterElytraSpear();
      return this._tickElytraSpear(target);
    }

    if (this._canStartSpearMace(target)) {
      this._enterSpearMace();
      return this._tickSpearMace(target);
    }

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
   * High-Tier PD Velocity-Compensated 360° Air-Steering:
   * Actively steers W/A/S/D + sprint in mid-air to intercept moving targets cleanly on Mace descent,
   * and applies air-braking when horizontal momentum would overshoot past the enemy's head!
   */
  _steerAirborneToward(target, leadTicks = 2) {
    const aimStatus = this._aimAtTarget(target, leadTicks, {
      speedMultiplier: 2.1,
      toleranceRad: 0.36
    });

    const pos = this.bot.entity.position;
    const vel = this.bot.entity.velocity || new Vec3(0, 0, 0);
    const predPos = this._getPredictedPosition(target, leadTicks);

    // Estimate remaining fall ticks to target height for velocity-damped interception (prevents air overshoot!)
    const dyAbove = Math.max(0, pos.y - predPos.y);
    const estFallTicks = clamp(dyAbove / Math.max(0.35, Math.abs(vel.y || 0) + 0.25), 0.5, 6.0);
    const driftScale = Math.min(estFallTicks, 3.2) * 0.42;

    const rawDx = predPos.x - pos.x;
    const rawDz = predPos.z - pos.z;
    const horizDist = Math.hypot(rawDx, rawDz);

    // Velocity-compensated desired horizontal correction vector
    const errX = predPos.x - (pos.x + (vel.x || 0) * driftScale);
    const errZ = predPos.z - (pos.z + (vel.z || 0) * driftScale);
    const errDist = Math.hypot(errX, errZ);

    if (typeof this.bot.setControlState === 'function') {
      if (errDist > 0.22) {
        const nx = errX / errDist;
        const nz = errZ / errDist;
        const yaw = this.bot.entity.yaw || 0;
        const fx = -Math.sin(yaw);
        const fz = -Math.cos(yaw);
        const rx = Math.cos(yaw);
        const rz = -Math.sin(yaw);

        const fwdDot = nx * fx + nz * fz;
        const rightDot = nx * rx + nz * rz;

        const moveFwd = fwdDot > 0.16;
        const moveBack = fwdDot < -0.20;
        this.bot.setControlState('forward', moveFwd);
        this.bot.setControlState('back', moveBack);
        this.bot.setControlState('right', rightDot > 0.18);
        this.bot.setControlState('left', rightDot < -0.18);
        // Sprint in mid-air for stronger horizontal air acceleration when > 1.2b offset (mace_combos drops sprint on hit)
        this.bot.setControlState('sprint', moveFwd && horizDist > 1.2 && !moveBack);
        this.bot.setControlState('jump', false);
      } else {
        this.bot.setControlState('forward', false);
        this.bot.setControlState('back', false);
        this.bot.setControlState('left', false);
        this.bot.setControlState('right', false);
        this.bot.setControlState('sprint', false);
        this.bot.setControlState('jump', false);
      }
    }

    return { aimStatus, horizDist };
  }
}

Object.assign(
  AerialModule.prototype,
  elytraFlightMethods,
  pearlCatchMethods,
  maceComboMethods,
  spearMaceMethods,
  elytraMaceMethods,
  elytraSpearMethods,
  defenseClutchMethods
);

module.exports = {
  AerialModule,
  AERIAL_MODES
};
