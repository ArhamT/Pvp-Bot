'use strict';

const { Vec3 } = require('vec3');
const { normalizeAngle } = require('../aim');
const {
  HOTBAR_START,
  SWORD_PRIORITY,
  AXE_PRIORITY,
  isSpearItem,
  clearMovementControls,
  inspectColumnStep
} = require('../constants');
const { canSeeBlockFace } = require('../placement_los');
const {
  parseItemEnchantments,
  validateArmorInventory
} = require('../mace_elytra');
const {
  GAPPLE_PRIORITY,
  LOS_BLOCK_NAMES,
  ARMOR_SLOTS,
  ARMOR_MATERIAL_SCORE
} = require('./constants');

const kitManagerMethods = {
  /**
   * Finds a suitable solid building block for breaking line-of-sight during retreat.
   * Strictly prefers `obsidian` (then `glowstone`) for blast-resistant cover.
   */
  findLosBuildingBlock() {
    if (!this.bot.inventory) return null;
    const items = this.bot.inventory.items();
    const obsHotbar = items.find((i) => i.name === 'obsidian' && this._isHotbarSlot(i.slot));
    if (obsHotbar) return obsHotbar;
    const obsAny = items.find((i) => i.name === 'obsidian');
    if (obsAny) return obsAny;
    const glow = items.find((i) => i.name === 'glowstone');
    if (glow) return glow;
    return items.find((i) => LOS_BLOCK_NAMES.has(i.name)) || null;
  },

  async _equipSafe(item, destination) {
    if (this.totemEquipInFlight || this.totemSwapPending || this.equipBusy || !item) return false;
    this.equipBusy = true;
    try {
      await this.bot.equip(item, destination);
      return true;
    } catch (_) {
      return false;
    } finally {
      this.equipBusy = false;
    }
  },

  _getAwayYaw(target) {
    if (!target || !target.isValid || !this.bot.entity) {
      return this.bot.entity ? this.bot.entity.yaw : 0;
    }
    const awayVec = this.bot.entity.position.minus(target.position);
    return Math.atan2(-awayVec.x, -awayVec.z);
  },

  /**
   * Returns true if a solid block already stands at feet or torso height between bot and target.
   */
  _hasCoverBetween(target) {
    if (!target || !target.isValid || !this.bot.entity || typeof this.bot.blockAt !== 'function') return false;
    const botPos = this.bot.entity.position;
    const toTarget = target.position.minus(botPos);
    const len = Math.sqrt(toTarget.x * toTarget.x + toTarget.z * toTarget.z);
    if (len < 0.2) return false;

    const ux = toTarget.x / len;
    const uz = toTarget.z / len;
    for (const d of [1.0, 1.5]) {
      const feetCheck = botPos.offset(ux * d, 0, uz * d).floored();
      const b0 = this.bot.blockAt(feetCheck);
      const b1 = this.bot.blockAt(feetCheck.offset(0, 1, 0));
      if ((b0 && b0.boundingBox === 'block') || (b1 && b1.boundingBox === 'block')) {
        return true;
      }
    }
    return false;
  },

  /**
   * Queues an Obsidian / solid cover block placement directly between the bot and opponent
   * before stepping back to eat a Golden Apple at <= 9 HP.
   */
  _tryQueueLosBlock(target) {
    if (!target || !target.isValid || !this.bot.entity) return false;
    if (this.pendingLosBlock || this.pendingSplashPotion || this.isConsuming) return false;

    const now = Date.now();
    if ((now - this.lastLosBlockTime) < (this.survCfg.losBlockCooldownMs || 950)) return false;

    const dist = this.bot.entity.position.distanceTo(target.position);
    if (dist < 1.8 || dist > 7.5) return false;
    if (this._hasCoverBetween(target)) return false;

    const blockItem = this.findLosBuildingBlock();
    if (!blockItem) return false;

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
    const vis = canSeeBlockFace(this.bot, refBlock.position, new Vec3(0, 1, 0), { aimer: this.aimer });
    if (!vis) {
      return false;
    }

    let swappedThisTick = false;
    if (this._isHotbarSlot(blockItem.slot) && typeof this.bot.setQuickBarSlot === 'function') {
      const hotbarStart = (this.bot.inventory && this.bot.inventory.hotbarStart) || HOTBAR_START;
      const qb = blockItem.slot - hotbarStart;
      if (this.bot.quickBarSlot !== qb) {
        this.bot.setQuickBarSlot(qb);
        swappedThisTick = true;
      }
    } else {
      this._equipSafe(blockItem, 'hand');
      swappedThisTick = true;
    }

    this.pendingLosBlock = {
      item: blockItem,
      refPos: refBlock.position,
      aimPos: refBlock.position.offset(0.5, 1.0, 0.5),
      settleTicks: swappedThisTick ? 1 : 0,
      createdAt: now
    };
    return true;
  },

  _tickPendingLosBlock() {
    if (!this.pendingLosBlock) return false;

    const action = this.pendingLosBlock;
    if ((Date.now() - action.createdAt) > 900) {
      this.pendingLosBlock = null;
      return false;
    }

    this.bot.setControlState('sprint', false);
    const aimStatus = this.aimer.stepTowardsPoint(action.aimPos, {
      speedMultiplier: 1.35,
      toleranceRad: 0.18
    });

    if (action.settleTicks > 0) {
      action.settleTicks--;
      return true;
    }

    const held = this.bot.heldItem;
    if (!held || held.name !== action.item.name) {
      if (this._isHotbarSlot(action.item.slot) && typeof this.bot.setQuickBarSlot === 'function') {
        const hotbarStart = (this.bot.inventory && this.bot.inventory.hotbarStart) || HOTBAR_START;
        this.bot.setQuickBarSlot(action.item.slot - hotbarStart);
        action.settleTicks = 1;
      } else {
        this._equipSafe(action.item, 'hand');
        action.settleTicks = 1;
      }
      return true;
    }

    if (aimStatus.aligned) {
      this.pendingLosBlock = null;
      this._placeLosBlock(action);
    }
    return true;
  },

  async _placeLosBlock(action) {
    if (this.totemEquipInFlight || this.totemSwapPending) return;
    try {
      const held = this.bot.heldItem;
      if (!held || held.name !== action.item.name) return;
      const refBlock = this.bot.blockAt(action.refPos);
      if (
        refBlock &&
        refBlock.boundingBox === 'block' &&
        canSeeBlockFace(this.bot, refBlock.position, new Vec3(0, 1, 0), { aimer: this.aimer })
      ) {
        await this.bot.placeBlock(refBlock, new Vec3(0, 1, 0));
        this.lastLosBlockTime = Date.now();
      }
    } catch (_) {
      // Placement blocked by entity
    }
  },

  /**
   * 20-TPS tick handler for RETREATING state (triggered at <= 9 HP):
   * 1. Highest-priority Totem check
   * 2. Place Obsidian cover between bot and opponent before eating
   * 3. Step back behind Obsidian cover and consume Enchanted Golden Apple / Golden Apple
   * 4. Smoothly retreat away from enemy if no gapples/cover remain
   */
  tickRetreating(target) {
    if (this.totemSwapPending || this.ensureOffhandSafety()) {
      if (this._totemMovementPaused) this._pauseMovementForTotemSwap();
      return;
    }
    this.lowerShield();

    if (!this.bot.entity) return;

    const now = Date.now();

    // 1. Complete any active downward splash healing potion throw while moving forward
    if (this._tickSplashPotionDownward(target)) return;

    // 2. Complete any active Obsidian cover placement between bot and opponent
    if (this._tickPendingLosBlock()) {
      this.bot.setControlState('forward', false);
      this.bot.setControlState('back', true);
      this.bot.setControlState('sprint', false);
      return;
    }

    // 3. If currently eating a Golden Apple, keep stepping back behind cover (no sprint -> no NoSlow)
    if (this.isConsuming) {
      this._moveAwayWalk(target);
      if ((now - this.consumeStartTime) > (this.survCfg.eatTimeoutMs || 3500)) {
        try { this.bot.deactivateItem(); } catch (_) {}
        this.isConsuming = false;
        this.isDrinkingPotion = false;
      }
      return;
    }

    const safeHp = this.survCfg.safeHealthThreshold || 15;
    const rapidPotCooldown = this.survCfg.rapidPotCooldownMs || 160;
    const dist = (target && target.isValid && target.position)
      ? this.bot.entity.position.distanceTo(target.position)
      : Infinity;

    // 4. HT1 Priority #1: Instant Health II splash potion ALWAYS fires BEFORE slow 1.6s gapple eating!
    const healPotion = this.findHealingPotion();
    if (
      healPotion &&
      this.bot.health < safeHp &&
      (now - this.lastPotionTime) >= rapidPotCooldown
    ) {
      this.activePotChainUntil = now + 1400;
      this._queueSplashPotion(healPotion, false, null);
      this._tickSplashPotionDownward(target, false);
      return;
    }

    // 5. Priority Obsidian / Solid cover FIRST before starting gapple consumption when target is close
    if (target && target.isValid) {
      if (dist < 6.5 && !this._hasCoverBetween(target) && this._tryQueueLosBlock(target)) {
        this.bot.setControlState('forward', false);
        this.bot.setControlState('back', true);
        this.bot.setControlState('sprint', false);
        return;
      }
    }

    // 6. If no splash pots and no cover block, create a quick sprint-jump gap when opponent is in melee range (<4.5b)
    //    so we don't eat a slow 1.6s Golden Apple while taking 3-4 free hits!
    const gapple = this.findGoldenApple() || this.findBestHealFood();
    const drinkHeal = this.findDrinkableHealPotion();
    const hasCover = target && target.isValid && this._hasCoverBetween(target);
    if (
      (gapple || drinkHeal) &&
      !hasCover &&
      dist < 4.5 &&
      this.retreatGapTicks < 10 &&
      this._isYawWalkable(this._getAwayYaw(target))
    ) {
      this.retreatGapTicks++;
      const awayYaw = this._getAwayYaw(target);
      const aimStatus = this.aimer.stepTowardsAngles(awayYaw, 0.0, { speedMultiplier: 1.6, force: true });
      this.bot.setControlState('forward', aimStatus.yawErrorDeg < 55);
      this.bot.setControlState('back', aimStatus.yawErrorDeg >= 55);
      this.bot.setControlState('sprint', aimStatus.yawErrorDeg < 55 && this.bot.food > 6);
      this.bot.setControlState('jump', aimStatus.yawErrorDeg < 55 && Boolean(this.bot.entity.onGround));
      this.bot.setControlState('left', false);
      this.bot.setControlState('right', false);
      return;
    }

    // 7. Consume Enchanted Golden Apple / Golden Apple / Drinkable Heal behind cover or after opening gap
    if (gapple && this.bot.health < safeHp) {
      this.retreatGapTicks = 0;
      this._startEatingFood(gapple);
      this._moveAwayWalk(target);
      return;
    }
    if (drinkHeal && this.bot.health < safeHp) {
      this.retreatGapTicks = 0;
      this._startDrinkingPotion(drinkHeal);
      this._moveAwayWalk(target);
      return;
    }

    // 7. Smooth 180-degree turn away from target & sprint-jump escape
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
  },

  /**
   * 20-TPS tick handler for HEALING state (used when safe distance is achieved or topping up).
   */
  tickHealing(target) {
    if (this.totemSwapPending || this.ensureOffhandSafety()) {
      if (this._totemMovementPaused) this._pauseMovementForTotemSwap();
      return;
    }
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

    const safeHp = this.survCfg.safeHealthThreshold || 15;
    const rapidPotCooldown = this.survCfg.rapidPotCooldownMs || 160;
    const healPotion = this.findHealingPotion();
    if (
      healPotion &&
      this.bot.health < safeHp &&
      (now - this.lastPotionTime) >= rapidPotCooldown
    ) {
      this.activePotChainUntil = now + 1400;
      this._queueSplashPotion(healPotion, false, null);
      this._tickSplashPotionDownward(target, false);
      return;
    }

    const drinkHeal = this.findDrinkableHealPotion();
    if (
      drinkHeal &&
      this.bot.health < safeHp &&
      (now - this.lastPotionTime) >= (this.survCfg.potionCooldownMs || 450)
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
  },

  _isYawWalkable(yaw) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position || typeof this.bot.blockAt !== 'function') {
      return true;
    }
    const pos = this.bot.entity.position;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const sx = pos.x + fx * 1.1;
    const sz = pos.z + fz * 1.1;
    const col = inspectColumnStep(this.bot, sx, pos.y, sz);
    if (col.blocked || col.needsJump) return false;
    const fBlock = this.bot.blockAt(new Vec3(Math.floor(sx), Math.floor(pos.y), Math.floor(sz)));
    if (fBlock && (fBlock.name.includes('lava') || fBlock.name.includes('fire') || fBlock.name === 'cobweb')) {
      return false;
    }
    if (!col.hasFloor) {
      const below1 = this.bot.blockAt(new Vec3(Math.floor(sx), Math.floor(pos.y) - 1, Math.floor(sz)));
      const below2 = this.bot.blockAt(new Vec3(Math.floor(sx), Math.floor(pos.y) - 2, Math.floor(sz)));
      if ((!below1 || below1.boundingBox !== 'block') && (!below2 || below2.boundingBox !== 'block')) {
        return false;
      }
    }
    return true;
  },

  /**
   * Obstacle-aware serpentine evasive walk while eating or drinking (sprint=false for 100% NoSlow safety).
   * Automatically routes around walls, cliffs, and lava instead of walking straight into a corner.
   */
  _moveAwayWalk(target) {
    if (!target || !target.isValid || !this.bot.entity) {
      clearMovementControls(this.bot);
      return;
    }

    const baseAwayYaw = this._getAwayYaw(target);
    let chosenYaw = baseAwayYaw;
    const offsets = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, (3 * Math.PI) / 4, -(3 * Math.PI) / 4];
    for (const off of offsets) {
      const cand = baseAwayYaw + off;
      if (this._isYawWalkable(cand)) {
        chosenYaw = cand;
        break;
      }
    }

    this.aimer.stepTowardsAngles(chosenYaw, 0.05, { speedMultiplier: 1.5, force: true });
    const yawDiff = Math.abs(normalizeAngle(chosenYaw - this.bot.entity.yaw));

    this.healStrafeTicks = (this.healStrafeTicks || 0) - 1;
    if (this.healStrafeTicks <= 0) {
      this.healStrafeDir = -(this.healStrafeDir || 1);
      this.healStrafeTicks = 6 + Math.floor(Math.random() * 5);
    }

    const canStrafe = this._isYawWalkable(chosenYaw - (this.healStrafeDir * Math.PI) / 2);

    this.bot.setControlState('sprint', false);
    this.bot.setControlState('jump', false);
    this.bot.setControlState('back', false);
    this.bot.setControlState('forward', yawDiff < Math.PI / 2.2);
    this.bot.setControlState('left', canStrafe && this.healStrafeDir < 0);
    this.bot.setControlState('right', canStrafe && this.healStrafeDir > 0);
  },

  /**
   * Validates worn and carried armor against full Protection IV and Blast Protection rejection.
   */
  validateArmor() {
    return validateArmorInventory(this.bot);
  },

  /**
   * Scores an armor item by material tier + Protection IV enchantments.
   * Rejects Blast Protection pieces (-1) because Wind Charges / Wind Burst lose launch height.
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

    const ench = parseItemEnchantments(item);
    if (ench.blast_protection > 0 && this.survCfg.rejectBlastProtection !== false) {
      return -1;
    }

    if (ench.protection > 0) {
      score += Math.min(5, ench.protection) * 10;
      if (ench.protection >= 4) score += 15;
    }
    if (ench.unbreaking > 0) score += 2;
    if (ench.mending > 0) score += 2;

    return score;
  },

  /**
   * Equips the highest-protection armor piece for each slot (head, torso, legs, feet).
   * Always yields immediately if a Totem swap is required.
   */
  async equipBestArmor() {
    if (!this.bot || !this.bot.inventory) return;
    if (this.ensureTotemPriority() || this.totemDelayTimer || this.totemSwapPending || this.totemEquipInFlight) return;

    const clickDelayMs = this.survCfg.inventoryClickDelayMs !== undefined ? this.survCfg.inventoryClickDelayMs : 120;
    const allItems = this.bot.inventory.items();
    let consecutiveFailures = 0;

    for (const spec of ARMOR_SLOTS) {
      if (this.needsTotemSwap() || this.totemEquipInFlight || this.totemSwapPending || this.totemDelayTimer) {
        this.ensureTotemPriority();
        return;
      }
      if (consecutiveFailures >= 2) return; // Inventory likely locked (e.g. lobby)

      const worn = this.bot.inventory.slots ? this.bot.inventory.slots[spec.slotIndex] : null;
      // Preserve worn Elytra in Elytra Spear kits (Elytra + Firework Rocket + Spear/Trident, no Mace)
      if (spec.dest === 'torso' && worn && worn.name === 'elytra') {
        const hasRocket = allItems.some((i) => i && i.name === 'firework_rocket');
        const hasSpear = allItems.some(isSpearItem);
        const hasMace = allItems.some((i) => i && i.name === 'mace');
        if (hasRocket && hasSpear && !hasMace) {
          continue;
        }
      }
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
  },

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
    if (this.sortingInProgress || this.totemEquipInFlight || this.totemSwapPending || this.totemDelayTimer) return;
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

    const allInv = this.bot.inventory.items();
    const isMaceElytraKit = allInv.some((i) =>
      i && (i.name === 'mace' || i.name === 'wind_charge' || (i.name === 'elytra' && allInv.some((r) => r && r.name === 'firework_rocket')))
    );

    const findMaceByEnchant = (preferKey) => {
      const candidates = this.bot.inventory.items().filter((i) => i && i.name === 'mace' && !claimedSlots.has(i.slot));
      if (candidates.length === 0) return null;
      candidates.sort((a, b) => {
        const ea = parseItemEnchantments(a);
        const eb = parseItemEnchantments(b);
        return (eb[preferKey] - ea[preferKey]) || (eb.wind_burst - ea.wind_burst);
      });
      return candidates[0];
    };

    const findChestOrElytra = () => {
      const wornTorso = this.bot.inventory.slots ? this.bot.inventory.slots[6] : null;
      const items = this.bot.inventory.items().filter((i) => !claimedSlots.has(i.slot));
      if (wornTorso && wornTorso.name === 'elytra') {
        return items.find((i) => i && i.name.endsWith('_chestplate')) || items.find((i) => i && i.name === 'elytra') || null;
      }
      return items.find((i) => i && i.name === 'elytra') || items.find((i) => i && i.name.endsWith('_chestplate')) || null;
    };

    const layoutPlan = isMaceElytraKit
      ? [
          { quickbarIndex: 0, picker: () => findByPriority(SWORD_PRIORITY) },
          { quickbarIndex: 1, picker: () => findMaceByEnchant('density') },
          { quickbarIndex: 2, picker: () => findMaceByEnchant('breach') || findByPriority(GAPPLE_PRIORITY) },
          // Enforce Axe strictly at a higher hotbar index (right of) Maces for stun-slam attribute swapping
          { quickbarIndex: 3, picker: () => findByPriority(AXE_PRIORITY) },
          { quickbarIndex: 4, picker: () => findByPriority(['wind_charge']) || findByPriority(GAPPLE_PRIORITY) },
          { quickbarIndex: 5, picker: () => findByPriority(['firework_rocket']) || findByPriority(GAPPLE_PRIORITY) },
          { quickbarIndex: 6, picker: () => findByPriority(['ender_pearl']) || this.findHealingPotion(claimedSlots) },
          { quickbarIndex: 7, picker: () => findChestOrElytra() || findByPriority(GAPPLE_PRIORITY) },
          { quickbarIndex: 8, picker: () => findByPriority(['totem_of_undying']) || findByPriority(GAPPLE_PRIORITY) || findByPriority(['water_bucket']) || this.findHealingPotion(claimedSlots) }
        ]
      : [
          { quickbarIndex: 0, picker: () => findByPriority(SWORD_PRIORITY) },
          { quickbarIndex: 1, picker: () => findByPriority(['obsidian']) || findByPriority(AXE_PRIORITY) },
          { quickbarIndex: 2, picker: () => findByPriority(['end_crystal']) || findByPriority(GAPPLE_PRIORITY) },
          { quickbarIndex: 3, picker: () => findByPriority(['respawn_anchor']) || findByPriority(['ender_pearl']) },
          { quickbarIndex: 4, picker: () => findByPriority(['glowstone', 'water_bucket', 'cobweb']) },
          { quickbarIndex: 5, picker: () => findByPriority(GAPPLE_PRIORITY) || this.findHealingPotion(claimedSlots) },
          { quickbarIndex: 6, picker: () => findByPriority(['ender_pearl']) || this.findHealingPotion(claimedSlots) },
          { quickbarIndex: 7, picker: () => findByPriority(AXE_PRIORITY) || this.findHealingPotion(claimedSlots) },
          { quickbarIndex: 8, picker: () => findByPriority(['totem_of_undying']) || this.findHealingPotion(claimedSlots) || findByPriority(['water_bucket']) }
        ];

    const clickDelayMs = this.survCfg.inventoryClickDelayMs !== undefined ? this.survCfg.inventoryClickDelayMs : 120;
    let consecutiveFailures = 0;

    try {
      for (const rule of layoutPlan) {
        // Totem priority always preempts hotbar sorting
        if (this.needsTotemSwap() || this.totemEquipInFlight || this.totemSwapPending || this.totemDelayTimer) {
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
  },

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
};

module.exports = { kitManagerMethods };
