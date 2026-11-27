'use strict';

const { Vec3 } = require('vec3');
const {
  OFFHAND_SLOT,
  SWORD_PRIORITY,
  BLAST_SHIELD_BLOCK_PRIORITY,
  hasItemEnchant,
  isAirLike
} = require('./constants');
const {
  getHotbarStart,
  isSlotInHotbar,
  getInventoryItems,
  findInventoryItem,
  countInventoryItem,
  isCrossbowCharged,
  ensureItemHeld
} = require('./inventory_utils');
const { canSeeBlockFace, hasClearRaySegment } = require('./placement_los');

// Interchangeable rail pool: `rail` primary, `powered_rail` purely as backup stack (NEVER power with redstone!)
const RAIL_POOL = ['rail', 'powered_rail'];
const ARROW_NAMES = ['arrow', 'spectral_arrow', 'tipped_arrow'];
const PROTECTED_HOTBAR_NAMES = new Set([
  ...SWORD_PRIORITY,
  'totem_of_undying',
  'ender_pearl',
  'golden_apple',
  'enchanted_golden_apple',
  'shield',
  'water_bucket'
]);

const TNTCART_STATES = Object.freeze({
  IDLE: 'IDLE',
  SHIELD_BLOCK: 'SHIELD_BLOCK',
  PLACE_RAIL: 'PLACE_RAIL',
  STACK_CARTS: 'STACK_CARTS',
  IGNITE: 'IGNITE',
  FOLLOWUP: 'FOLLOWUP'
});

/**
 * Dedicated Upgraded TNT Minecart PvP Skill (`modules/tntcart.js`):
 * - Interchangeable `rail` + `powered_rail` pool (backup rail stack only; never places redstone)
 * - Protected-slot hotbar cycling for rail, `tnt_minecart`, and `flint_and_steel` / Flame `bow`
 * - Predictive target placement within 1–3b blast radius (<= 4.5b reach)
 * - Rapid 1..N `tnt_minecart` stacking + instant `flint_and_steel` or quick-charge Flame bow ignition
 * - Self-blast safety: raycast exposure check, offhand totem & min-HP guard, feet blast-shield / step-back
 */
class TntCartSkill {
  constructor(bot, config, aimer, prediction = null, combat = null, logFn = null) {
    this.bot = bot;
    this.config = config || {};
    this.cfg = (this.config.tntCart || this.config.cart) || {};
    this.aimer = aimer;
    this.prediction = prediction;
    this.combat = combat;
    this._logFn = typeof logFn === 'function' ? logFn : null;

    this.state = TNTCART_STATES.IDLE;
    this.stateTicks = 0;
    this.lastComboTime = 0;
    this.lastRefillTime = 0;
    this.equipBusy = false;

    this.railPos = null;
    this.supportPos = null;
    this.shieldPos = null;
    this.cartsPlaced = 0;
    this.targetStackCount = 2;
    this.bowDrawing = false;
    this.bowDrawTicks = 0;
    this.needsPostStackShield = false;
  }

  _log(msg) {
    if (this.cfg.debug === false) return;
    const text = `[TNTCART] ${msg}`;
    if (this._logFn) this._logFn(text);
  }

  isBusy() {
    return this.state !== TNTCART_STATES.IDLE;
  }

  _enterState(nextState) {
    if (this.state !== nextState) {
      this._log(`${this.state} -> ${nextState}`);
      this.state = nextState;
      this.stateTicks = 0;
    }
  }

  cancel() {
    if (this.bowDrawing && this.bot && typeof this.bot.deactivateItem === 'function') {
      try { this.bot.deactivateItem(); } catch (_) {}
    }
    this._resetState();
  }

  dispose() {
    this.cancel();
  }

  _resetState() {
    this.state = TNTCART_STATES.IDLE;
    this.stateTicks = 0;
    this.railPos = null;
    this.supportPos = null;
    this.shieldPos = null;
    this.cartsPlaced = 0;
    this.targetStackCount = 2;
    this.bowDrawing = false;
    this.bowDrawTicks = 0;
    this.needsPostStackShield = false;
  }

  countTntCarts() {
    return countInventoryItem(this.bot, 'tnt_minecart');
  }

  _hasOffhandTotem() {
    if (!this.bot || !this.bot.inventory || !this.bot.inventory.slots) return false;
    const off = this.bot.inventory.slots[OFFHAND_SLOT];
    return Boolean(off && off.name === 'totem_of_undying');
  }

  _findRail(hotbarOnly = false) {
    return findInventoryItem(this.bot, RAIL_POOL, { hotbarOnly });
  }

  _findTntCart(hotbarOnly = false) {
    return findInventoryItem(this.bot, 'tnt_minecart', { hotbarOnly });
  }

  _findIgniter() {
    // Primary: flint_and_steel (instant ignition on rail/adjacent block face)
    const fns = findInventoryItem(this.bot, 'flint_and_steel');
    if (fns) return { record: fns, kind: 'flint_and_steel' };

    // Secondary: Flame-enchanted bow (or charged Flame crossbow) with arrows
    const hasArrow = Boolean(findInventoryItem(this.bot, ARROW_NAMES));
    if (hasArrow) {
      const items = getInventoryItems(this.bot);
      const flameBow = items.find((i) => i && i.name === 'bow' && hasItemEnchant(i, 'flame'));
      if (flameBow) {
        return {
          record: { item: flameBow, quickBarSlot: isSlotInHotbar(this.bot, flameBow.slot) ? (flameBow.slot - getHotbarStart(this.bot)) : -1 },
          kind: 'flame_bow'
        };
      }
      const chargedXbow = items.find((i) => i && i.name === 'crossbow' && isCrossbowCharged(i));
      if (chargedXbow) {
        return {
          record: { item: chargedXbow, quickBarSlot: isSlotInHotbar(this.bot, chargedXbow.slot) ? (chargedXbow.slot - getHotbarStart(this.bot)) : -1 },
          kind: 'charged_crossbow'
        };
      }
    }
    return null;
  }

  hasCartKit() {
    return Boolean(this._findTntCart() && this._findRail() && this._findIgniter());
  }

  /**
   * Finds an expendable hotbar slot (never overwriting sword, totem, pearls, gapples, shield, or water bucket).
   */
  _findExpendableHotbarSlot(excludeNames = new Set()) {
    if (!this.bot || !this.bot.inventory || !this.bot.inventory.slots) return -1;
    const start = getHotbarStart(this.bot);
    const slots = this.bot.inventory.slots;
    for (let i = 0; i < 9; i++) {
      if (!slots[start + i]) return start + i;
    }
    for (let i = 8; i >= 0; i--) {
      const it = slots[start + i];
      if (!it) return start + i;
      if (!PROTECTED_HOTBAR_NAMES.has(it.name) && !excludeNames.has(it.name)) {
        return start + i;
      }
    }
    return -1;
  }

  /**
   * Pulls missing cart-combo items (`rail`/`powered_rail`, `tnt_minecart`, igniter) from main inventory
   * into expendable hotbar slots without touching protected slots.
   */
  _tryCycleHotbarItem(itemRec, keepSet) {
    if (!itemRec || !itemRec.item || isSlotInHotbar(this.bot, itemRec.item.slot)) return false;
    if (this.equipBusy || typeof this.bot.moveSlotItem !== 'function') return false;
    const now = Date.now();
    if ((now - this.lastRefillTime) < (this.cfg.refillClickDelayMs || 120)) return false;

    const dest = this._findExpendableHotbarSlot(keepSet);
    if (dest < 0) return false;

    this.lastRefillTime = now;
    this.equipBusy = true;
    Promise.resolve(this.bot.moveSlotItem(itemRec.item.slot, dest))
      .catch(() => {})
      .finally(() => { this.equipBusy = false; });
    return true;
  }

  _getPredictedTargetPos(target) {
    const leadTicks = this.cfg.leadTicks !== undefined ? this.cfg.leadTicks : 4;
    if (this.prediction && typeof this.prediction.predictPosition === 'function') {
      const pred = this.prediction.predictPosition(target, leadTicks);
      if (pred && pred.position) return pred.position.clone();
    }
    const vel = (target && target.velocity) ? target.velocity : { x: 0, y: 0, z: 0 };
    return target.position.offset(vel.x * leadTicks, 0, vel.z * leadTicks);
  }

  /**
   * Selects the best solid support block within reach (<= 4.5b) that places the rail within
   * 1–3 blocks of the target's predicted position.
   */
  _findBestRailSpot(target) {
    if (!this.bot || !this.bot.entity || typeof this.bot.blockAt !== 'function') return null;
    const botPos = this.bot.entity.position;
    const eyePos = this.aimer ? this.aimer.getEyePosition() : botPos.offset(0, 1.62, 0);
    const predPos = this._getPredictedTargetPos(target);
    const base = predPos.floored();

    let best = null;
    let bestScore = -Infinity;

    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -2; dz <= 2; dz++) {
          const railPos = base.offset(dx, dy, dz);
          const supportPos = railPos.offset(0, -1, 0);
          const supportBlock = this.bot.blockAt(supportPos);
          const railSpace = this.bot.blockAt(railPos);
          if (!supportBlock || supportBlock.boundingBox !== 'block') continue;
          if (!isAirLike(railSpace) && !(railSpace && RAIL_POOL.includes(railSpace.name))) continue;

          const railCenter = railPos.offset(0.5, 0.2, 0.5);
          const reachDist = eyePos.distanceTo(supportPos.offset(0.5, 1.0, 0.5));
          if (reachDist > 4.5) continue;

          const distToTarget = railCenter.distanceTo(predPos);
          if (distToTarget > 3.2) continue;

          const distToBot = railCenter.distanceTo(botPos);
          if (distToBot < 1.1) continue;

          if (!canSeeBlockFace(this.bot, supportPos, new Vec3(0, 1, 0), { aimer: this.aimer, maxReach: 4.5 })) {
            continue;
          }

          // Prefer 1–2.4b from predicted target & safer separation from bot
          const score = (3.5 - distToTarget) * 10 + Math.min(distToBot, 4.2) * 3.0;
          if (score > bestScore) {
            bestScore = score;
            best = { railPos, supportPos };
          }
        }
      }
    }
    return best;
  }

  /**
   * Evaluates whether detonating a cart stack at `railPos` poses lethal/unacceptable self-blast exposure.
   */
  _evaluateSelfBlastSafety(railPos) {
    if (!railPos || !this.bot || !this.bot.entity) return { safe: false, needsShield: false, needsStepBack: false };
    const botPos = this.bot.entity.position;
    const blastPos = railPos.offset(0.5, 0.5, 0.5);
    const dist = botPos.distanceTo(blastPos);
    const maxCloseDist = this.cfg.maxSelfBlastDist !== undefined ? this.cfg.maxSelfBlastDist : 4.2;

    if (dist > maxCloseDist) {
      return { safe: true, needsShield: false, needsStepBack: false };
    }

    // Check if a solid block already occludes lower-hitbox blast ray between rail and bot feet
    const feetOccluded = !hasClearRaySegment(this.bot, blastPos, botPos.offset(0, 0.25, 0));
    if (feetOccluded) {
      return { safe: true, needsShield: false, needsStepBack: false };
    }

    const hasTotem = this._hasOffhandTotem();
    const minSafeHp = this.cfg.minHealth !== undefined ? this.cfg.minHealth : 10;
    const requireTotem = this.cfg.requireTotemForCloseBlast !== false;

    if (dist <= 2.4 && (!hasTotem || this.bot.health < minSafeHp + 2)) {
      return { safe: false, needsShield: true, needsStepBack: true };
    }
    if (requireTotem && !hasTotem && dist <= maxCloseDist) {
      return { safe: false, needsShield: true, needsStepBack: true };
    }
    return {
      safe: this.bot.health >= minSafeHp && (hasTotem || dist >= 3.3),
      needsShield: dist <= 3.6,
      needsStepBack: dist <= 2.8
    };
  }

  _findFeetShieldSpot(railPos) {
    if (!railPos || !this.bot || !this.bot.entity || typeof this.bot.blockAt !== 'function') return null;
    const blockRec = findInventoryItem(this.bot, BLAST_SHIELD_BLOCK_PRIORITY);
    if (!blockRec) return null;

    const botPos = this.bot.entity.position;
    const dx = (railPos.x + 0.5) - botPos.x;
    const dz = (railPos.z + 0.5) - botPos.z;
    const len = Math.hypot(dx, dz) || 1;
    const placePos = new Vec3(
      Math.floor(botPos.x + (dx / len) * 1.0),
      Math.floor(botPos.y),
      Math.floor(botPos.z + (dz / len) * 1.0)
    );
    if (placePos.equals(railPos) || placePos.equals(botPos.floored())) return null;
    if (!isAirLike(this.bot.blockAt(placePos))) return null;

    const refPos = placePos.offset(0, -1, 0);
    const refBlock = this.bot.blockAt(refPos);
    if (!refBlock || refBlock.boundingBox !== 'block') return null;
    const vis = canSeeBlockFace(this.bot, refPos, new Vec3(0, 1, 0), { aimer: this.aimer, maxReach: 4.5 });
    if (!vis) return null;

    return { blockRec, placePos, refPos, face: new Vec3(0, 1, 0), aimPos: vis.aimPos };
  }

  tick(target) {
    if (this.cfg.enabled !== true || !this.bot || !this.bot.entity || !target || !target.isValid) {
      if (this.isBusy()) this.cancel();
      return false;
    }

    const now = Date.now();

    // Continue active TNT cart state machine
    if (this.state !== TNTCART_STATES.IDLE) {
      this.stateTicks++;
      if (this.stateTicks > 35) {
        this._log('Timeout — aborting combo');
        this.cancel();
        return false;
      }
      return this._tickActiveState(target);
    }

    // Start conditions
    const minHp = this.cfg.minHealth !== undefined ? this.cfg.minHealth : 10;
    if (this.bot.health < minHp) return false;
    const cd = this.cfg.comboCooldownMs !== undefined ? this.cfg.comboCooldownMs : 900;
    if ((now - this.lastComboTime) < cd) return false;
    if (!this.hasCartKit()) return false;

    const dist = this.bot.entity.position.distanceTo(target.position);
    const minRange = this.cfg.engageMinRange !== undefined ? this.cfg.engageMinRange : 1.5;
    const maxRange = this.cfg.engageMaxRange !== undefined ? this.cfg.engageMaxRange : 5.0;
    if (dist < minRange || dist > maxRange) return false;

    // Pre-cycle rail & cart into hotbar without overwriting protected slots
    const keepSet = new Set(['rail', 'powered_rail', 'tnt_minecart', 'flint_and_steel', 'bow', 'crossbow']);
    const railRec = this._findRail();
    const cartRec = this._findTntCart();
    this._tryCycleHotbarItem(railRec, keepSet);
    this._tryCycleHotbarItem(cartRec, keepSet);

    const spot = this._findBestRailSpot(target);
    if (!spot) return false;

    const safety = this._evaluateSelfBlastSafety(spot.railPos);
    if (!safety.safe && !safety.needsShield) return false;

    this.railPos = spot.railPos;
    this.supportPos = spot.supportPos;
    this.cartsPlaced = 0;
    const maxStack = Math.max(1, this.cfg.maxStackCount !== undefined ? this.cfg.maxStackCount : (this.cfg.stackCount || 3));
    this.targetStackCount = Math.min(maxStack, Math.max(1, this.countTntCarts()));
    this.needsPostStackShield = Boolean(safety.needsShield);

    const existing = this.bot.blockAt(this.railPos);
    if (existing && RAIL_POOL.includes(existing.name)) {
      this._enterState(TNTCART_STATES.STACK_CARTS);
    } else {
      this._enterState(TNTCART_STATES.PLACE_RAIL);
    }
    return this._tickActiveState(target);
  }

  _tickActiveState(target) {
    // --- Stage 1: Place `rail` (primary) or `powered_rail` (backup stack) ---
    if (this.state === TNTCART_STATES.PLACE_RAIL) {
      const existing = this.bot.blockAt(this.railPos);
      if (existing && RAIL_POOL.includes(existing.name)) {
        this._enterState(TNTCART_STATES.STACK_CARTS);
        return true;
      }

      const railRec = this._findRail();
      if (!railRec) {
        this.cancel();
        return false;
      }

      const aim = this.aimer
        ? this.aimer.stepTowardsPoint(this.supportPos.offset(0.5, 1.0, 0.5), { speedMultiplier: 2.2, force: true })
        : { aligned: true };
      const eq = ensureItemHeld(this.bot, railRec);
      if (eq.swapped || !eq.held || !aim.aligned) return true;

      const supportBlock = this.bot.blockAt(this.supportPos);
      if (!supportBlock || supportBlock.boundingBox !== 'block') {
        this.cancel();
        return false;
      }

      if (typeof this.bot.placeBlock === 'function') {
        Promise.resolve(this.bot.placeBlock(supportBlock, new Vec3(0, 1, 0))).catch(() => {});
      }
      this._enterState(TNTCART_STATES.STACK_CARTS);
      return true;
    }

    // --- Stage 2: Rapidly stack 1..N `tnt_minecart` entities onto the placed rail ---
    if (this.state === TNTCART_STATES.STACK_CARTS) {
      if (this.cartsPlaced >= this.targetStackCount) {
        this._enterState(this.needsPostStackShield ? TNTCART_STATES.SHIELD_BLOCK : TNTCART_STATES.IGNITE);
        return true;
      }

      const railBlock = this.bot.blockAt(this.railPos);
      if (!railBlock || !RAIL_POOL.includes(railBlock.name)) {
        if (this.stateTicks <= 4) return true;
        this.cancel();
        return false;
      }

      const cartRec = this._findTntCart(true) || this._findTntCart(false);
      if (!cartRec) {
        if (this.cartsPlaced > 0) {
          this._enterState(this.needsPostStackShield ? TNTCART_STATES.SHIELD_BLOCK : TNTCART_STATES.IGNITE);
          return true;
        }
        this.cancel();
        return false;
      }

      const aim = this.aimer
        ? this.aimer.stepTowardsPoint(this.railPos.offset(0.5, 0.15, 0.5), { speedMultiplier: 2.2, force: true })
        : { aligned: true };
      const eq = ensureItemHeld(this.bot, cartRec);
      if (eq.swapped || !eq.held || !aim.aligned) return true;

      if (typeof this.bot.placeEntity === 'function') {
        Promise.resolve(this.bot.placeEntity(railBlock, new Vec3(0, 1, 0))).catch(() => {});
      } else if (typeof this.bot.activateBlock === 'function') {
        Promise.resolve(this.bot.activateBlock(railBlock, new Vec3(0, 1, 0))).catch(() => {});
      } else if (typeof this.bot.placeBlock === 'function') {
        Promise.resolve(this.bot.placeBlock(railBlock, new Vec3(0, 1, 0))).catch(() => {});
      }

      this.cartsPlaced++;
      // Immediately cycle next cart from inventory if needed for multi-stacking
      if (this.cartsPlaced < this.targetStackCount) {
        const nextCart = this._findTntCart(false);
        if (nextCart && !isSlotInHotbar(this.bot, nextCart.item.slot)) {
          this._tryCycleHotbarItem(nextCart, new Set(['rail', 'powered_rail', 'flint_and_steel', 'bow', 'crossbow']));
        }
      } else {
        this._enterState(this.needsPostStackShield ? TNTCART_STATES.SHIELD_BLOCK : TNTCART_STATES.IGNITE);
      }
      return true;
    }

    // --- Stage 3: Feet Blast-Shield block (or step-back) before igniting ---
    if (this.state === TNTCART_STATES.SHIELD_BLOCK) {
      const shieldPlan = this._findFeetShieldSpot(this.railPos);
      if (!shieldPlan || this.stateTicks > 6) {
        this._enterState(TNTCART_STATES.IGNITE);
        return true;
      }

      const aim = this.aimer
        ? this.aimer.stepTowardsPoint(shieldPlan.aimPos, { speedMultiplier: 2.2, force: true })
        : { aligned: true };
      const eq = ensureItemHeld(this.bot, shieldPlan.blockRec);
      if (eq.swapped || !eq.held || !aim.aligned) return true;

      const refBlock = this.bot.blockAt(shieldPlan.refPos);
      if (refBlock && refBlock.boundingBox === 'block' && typeof this.bot.placeBlock === 'function') {
        Promise.resolve(this.bot.placeBlock(refBlock, shieldPlan.face)).catch(() => {});
      }
      this._enterState(TNTCART_STATES.IGNITE);
      return true;
    }

    // --- Stage 4: Self-safety check + Instant Ignition (`flint_and_steel` or Flame `bow`) ---
    if (this.state === TNTCART_STATES.IGNITE) {
      const safety = this._evaluateSelfBlastSafety(this.railPos);
      if (!safety.safe && safety.needsStepBack && this.stateTicks < 8) {
        // Step back away from rail before detonating!
        const botPos = this.bot.entity.position;
        const awayYaw = Math.atan2(-(botPos.x - (this.railPos.x + 0.5)), -(botPos.z - (this.railPos.z + 0.5)));
        if (this.aimer) this.aimer.stepTowardsAngles(awayYaw, 0.0, { speedMultiplier: 2.0, force: true });
        if (typeof this.bot.setControlState === 'function') {
          this.bot.setControlState('forward', true);
          this.bot.setControlState('back', false);
          this.bot.setControlState('sprint', this.bot.food > 6);
        }
        return true;
      }

      if (!safety.safe) {
        this._log('Aborted ignition — unsafe self-blast exposure');
        this.cancel();
        return false;
      }

      const igniter = this._findIgniter();
      if (!igniter) {
        this.cancel();
        return false;
      }

      const aimPt = this.railPos.offset(0.5, 0.35, 0.5);
      const aim = this.aimer
        ? this.aimer.stepTowardsPoint(aimPt, { speedMultiplier: 2.2, force: true })
        : { aligned: true };
      const eq = ensureItemHeld(this.bot, igniter.record);
      if (eq.swapped || !eq.held || !aim.aligned) return true;

      if (igniter.kind === 'flint_and_steel') {
        const supportBlock = this.bot.blockAt(this.supportPos);
        const railBlock = this.bot.blockAt(this.railPos);
        const targetBlock = railBlock || supportBlock;
        if (targetBlock && typeof this.bot.activateBlock === 'function') {
          Promise.resolve(this.bot.activateBlock(targetBlock, new Vec3(0, 1, 0))).catch(() => {});
        } else if (supportBlock && typeof this.bot.placeBlock === 'function') {
          Promise.resolve(this.bot.placeBlock(supportBlock, new Vec3(0, 1, 0))).catch(() => {});
        }
        this.lastComboTime = Date.now();
        this._enterState(TNTCART_STATES.FOLLOWUP);
        return true;
      }

      if (igniter.kind === 'charged_crossbow') {
        if (typeof this.bot.activateItem === 'function') {
          this.bot.activateItem(false);
        }
        this.lastComboTime = Date.now();
        this._enterState(TNTCART_STATES.FOLLOWUP);
        return true;
      }

      // Quick-charge Flame Bow (6–8 ticks is plenty at <= 4.5b)
      if (!this.bowDrawing) {
        if (typeof this.bot.activateItem === 'function') this.bot.activateItem(false);
        this.bowDrawing = true;
        this.bowDrawTicks = 0;
        return true;
      }
      this.bowDrawTicks++;
      const neededTicks = this.cfg.bowDetonateTicks !== undefined ? Math.min(10, this.cfg.bowDetonateTicks) : 7;
      if (this.bowDrawTicks >= neededTicks) {
        if (typeof this.bot.deactivateItem === 'function') this.bot.deactivateItem();
        this.bowDrawing = false;
        this.lastComboTime = Date.now();
        this._enterState(TNTCART_STATES.FOLLOWUP);
      }
      return true;
    }

    // --- Stage 5: Restore primary sword cleanly ---
    if (this.state === TNTCART_STATES.FOLLOWUP) {
      const sword = findInventoryItem(this.bot, SWORD_PRIORITY, { hotbarOnly: true });
      if (sword && sword.quickBarSlot >= 0 && typeof this.bot.setQuickBarSlot === 'function') {
        this.bot.setQuickBarSlot(sword.quickBarSlot);
      }
      this._resetState();
      return false;
    }

    return false;
  }
}

module.exports = {
  TntCartSkill,
  CartModule: TntCartSkill,
  TNTCART_STATES,
  CART_STATES: TNTCART_STATES,
  RAIL_POOL
};
