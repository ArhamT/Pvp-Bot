'use strict';

const { Vec3 } = require('vec3');
const { HOTBAR_START, SWORD_PRIORITY, AXE_PRIORITY, getItemMetadataText, hasItemEnchant } = require('./constants');
const { canSeeBlockFace } = require('./placement_los');

const RAIL_NAMES = ['rail', 'powered_rail', 'detector_rail', 'activator_rail'];
const SHIELD_BLOCK_PRIORITY = ['obsidian', 'cobbled_deepslate', 'cobblestone', 'stone', 'deepslate'];
const ARROW_NAMES = ['arrow', 'spectral_arrow', 'tipped_arrow'];

const CART_STATES = Object.freeze({
  IDLE: 'IDLE',
  PRELOAD_CROSSBOW: 'PRELOAD_CROSSBOW',
  AXE_STUN: 'AXE_STUN',
  SHIELD_BLOCK: 'SHIELD_BLOCK',
  PLACE_RAIL: 'PLACE_RAIL',
  STACK_CARTS: 'STACK_CARTS',
  DETONATE: 'DETONATE',
  FOLLOWUP: 'FOLLOWUP'
});

/**
 * @deprecated TNT Minecart, rail, and crossbow-detonation behaviors are deprecated in favor of
 * high-cadence End Crystal and Respawn Anchor PvP (`modules/burst.js` + `modules/cpvp_tactics.js`).
 */
class CartModule {
  constructor(bot, config, aimer, prediction = null, combat = null) {
    this.bot = bot;
    this.config = config || {};
    this.cartCfg = this.config.cart || {};
    this.aimer = aimer;
    this.prediction = prediction;
    this.combat = combat;

    this.state = CART_STATES.IDLE;
    this.stateTicks = 0;
    this.swappedThisTick = false;
    this.equipBusy = false;
    this.lastComboTime = 0;
    this.lastRefillTime = 0;
    this.preferredCartHotbarIdx = -1;
    this.railPos = null;
    this.shieldPos = null;
    this.cartsPlaced = 0;
    this.targetStackCount = 2;
    this.detonateBowDrawing = false;
    this.detonateDrawTicks = 0;
    this.preloadTicks = 0;
    this.preloadActive = false;
    this.needsPostStackShield = false;
    this.stackWaitTick = false;
    this.activePreloadItem = null;
  }

  isBusy() {
    return this.state !== CART_STATES.IDLE;
  }

  cancel() {
    if ((this.detonateBowDrawing || this.preloadActive) && this.bot && typeof this.bot.deactivateItem === 'function') {
      try { this.bot.deactivateItem(); } catch (_) {}
    }
    this._resetState();
  }

  dispose() {
    this.cancel();
  }

  _resetState() {
    this.state = CART_STATES.IDLE;
    this.stateTicks = 0;
    this.railPos = null;
    this.shieldPos = null;
    this.cartsPlaced = 0;
    this.targetStackCount = 2;
    this.detonateBowDrawing = false;
    this.detonateDrawTicks = 0;
    this.preloadTicks = 0;
    this.preloadActive = false;
    this.needsPostStackShield = false;
    this.stackWaitTick = false;
    this.activePreloadItem = null;
  }

  _enterState(nextState) {
    this.state = nextState;
    this.stateTicks = 0;
  }

  _getHotbarStart() {
    return (this.bot && this.bot.inventory && this.bot.inventory.hotbarStart) || HOTBAR_START;
  }

  _getItems() {
    if (!this.bot || !this.bot.inventory || typeof this.bot.inventory.items !== 'function') return [];
    return this.bot.inventory.items().filter(Boolean);
  }

  _isInHotbar(item) {
    const start = this._getHotbarStart();
    return Boolean(item && typeof item.slot === 'number' && item.slot >= start && item.slot < start + 9);
  }

  _findItem(names, hotbarOnly = false) {
    const items = this._getItems();
    for (const name of names) {
      const hb = items.find((i) => i.name === name && this._isInHotbar(i));
      if (hb) return hb;
    }
    if (hotbarOnly) return null;
    for (const name of names) {
      const inv = items.find((i) => i.name === name);
      if (inv) return inv;
    }
    return null;
  }

  countTntCarts() {
    return this._getItems().reduce((sum, i) => (i.name === 'tnt_minecart' ? sum + (i.count || 1) : sum), 0);
  }

  isCrossbowCharged(item) {
    if (!item || item.name !== 'crossbow') return false;
    const raw = getItemMetadataText(item);
    return (raw.includes('charged_projectiles') || raw.includes('charged')) &&
      (raw.includes('arrow') || raw.includes('firework'));
  }

  _hasArrows() {
    return Boolean(this._findItem(ARROW_NAMES));
  }

  _findChargedCrossbow() {
    const xbows = this._getItems().filter((i) => this.isCrossbowCharged(i));
    if (xbows.length === 0) return null;
    const hbFlame = xbows.find((i) => this._isInHotbar(i) && hasItemEnchant(i, 'flame'));
    if (hbFlame) return hbFlame;
    const anyFlame = xbows.find((i) => hasItemEnchant(i, 'flame'));
    if (anyFlame) return anyFlame;
    return xbows.find((i) => this._isInHotbar(i)) || xbows[0];
  }

  _findUnchargedCrossbow() {
    if (!this._hasArrows()) return null;
    const xbows = this._getItems().filter((i) => i.name === 'crossbow' && !this.isCrossbowCharged(i));
    return xbows.find((i) => this._isInHotbar(i)) || xbows[0] || null;
  }

  _findFlameBow() {
    if (!this._hasArrows()) return null;
    const bows = this._getItems().filter((i) => i.name === 'bow');
    if (bows.length === 0) return null;
    const hbFlame = bows.find((i) => this._isInHotbar(i) && hasItemEnchant(i, 'flame'));
    if (hbFlame) return hbFlame;
    const anyFlame = bows.find((i) => hasItemEnchant(i, 'flame'));
    if (anyFlame) return anyFlame;
    return bows.find((i) => this._isInHotbar(i)) || bows[0];
  }

  _findDetonator() {
    const charged = this._findChargedCrossbow();
    if (charged) return { item: charged, kind: 'charged_crossbow' };
    const bow = this._findFlameBow();
    if (bow) return { item: bow, kind: 'bow' };
    const uncharged = this._findUnchargedCrossbow();
    if (uncharged) return { item: uncharged, kind: 'uncharged_crossbow' };
    return null;
  }

  _hasCartKit() {
    return Boolean(this._findItem(['tnt_minecart']) && this._findItem(RAIL_NAMES) && this._findDetonator());
  }

  _isHoldingExact(item) {
    if (!item || !this.bot) return false;
    const start = this._getHotbarStart();
    if (this._isInHotbar(item) && typeof this.bot.quickBarSlot === 'number') {
      if (this.bot.quickBarSlot !== (item.slot - start)) return false;
    }
    const held = this.bot.heldItem;
    if (!held || held.name !== item.name) return false;
    if (item.name === 'crossbow') {
      return this.isCrossbowCharged(held) === this.isCrossbowCharged(item);
    }
    return true;
  }

  /**
   * Anti-cheat safe sequential equip: returns `{ ready: true, swapped: false }` only after
   * a full settled tick on the target item (never swaps + activates/attacks on the same tick).
   */
  _equipSequential(item) {
    if (!item || !this.bot) return { ready: false, swapped: false };
    if (this._isHoldingExact(item)) return { ready: true, swapped: false };
    if (this.swappedThisTick) return { ready: false, swapped: false };

    const start = this._getHotbarStart();
    if (this._isInHotbar(item) && typeof this.bot.setQuickBarSlot === 'function') {
      this.bot.setQuickBarSlot(item.slot - start);
      this.swappedThisTick = true;
      return { ready: false, swapped: true };
    }

    if (!this.equipBusy && typeof this.bot.equip === 'function') {
      this.equipBusy = true;
      this.swappedThisTick = true;
      Promise.resolve(this.bot.equip(item, 'hand'))
        .catch(() => {})
        .finally(() => { this.equipBusy = false; });
    }
    return { ready: false, swapped: true };
  }

  /**
   * Cycles unstackable `tnt_minecart` items from main inventory into a hotbar slot
   * whenever the hotbar has no `tnt_minecart` left.
   */
  _tryRefillHotbarCart() {
    if (!this.bot || !this.bot.inventory || this.equipBusy || this.swappedThisTick) return false;
    if (typeof this.bot.moveSlotItem !== 'function') return false;
    if (this._findItem(['tnt_minecart'], true)) return false;

    const invCart = this._findItem(['tnt_minecart'], false);
    if (!invCart) return false;

    const now = Date.now();
    const delayMs = this.cartCfg.refillClickDelayMs !== undefined ? this.cartCfg.refillClickDelayMs : 120;
    if ((now - this.lastRefillTime) < delayMs) return false;

    const start = this._getHotbarStart();
    const slots = this.bot.inventory.slots || [];
    let destSlot = -1;
    if (this.preferredCartHotbarIdx >= 0 && this.preferredCartHotbarIdx <= 8) {
      const prefSlot = start + this.preferredCartHotbarIdx;
      const occ = slots[prefSlot];
      if (!occ || occ.name === 'tnt_minecart') destSlot = prefSlot;
    }
    if (destSlot === -1) {
      for (let i = 0; i < 9; i++) {
        if (!slots[start + i]) { destSlot = start + i; break; }
      }
    }
    if (destSlot === -1) destSlot = start + (this.preferredCartHotbarIdx >= 0 ? this.preferredCartHotbarIdx : 7);

    this.lastRefillTime = now;
    this.equipBusy = true;
    this.swappedThisTick = true;
    Promise.resolve(this.bot.moveSlotItem(invCart.slot, destSlot))
      .catch(() => {})
      .finally(() => { this.equipBusy = false; });
    return true;
  }

  _isSolid(pos) {
    if (!this.bot || typeof this.bot.blockAt !== 'function' || !pos) return false;
    const b = this.bot.blockAt(pos);
    return Boolean(b && b.boundingBox === 'block');
  }

  _hasSolidBarrierBetweenFeet(railPos) {
    if (!this.bot || !this.bot.entity || !railPos) return false;
    const pos = this.bot.entity.position;
    const dx = (railPos.x + 0.5) - pos.x;
    const dz = (railPos.z + 0.5) - pos.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.8) return false;
    const mid = new Vec3(Math.floor(pos.x + (dx / len) * 1.0), Math.floor(pos.y), Math.floor(pos.z + (dz / len) * 1.0));
    if (mid.x === railPos.x && mid.y === railPos.y && mid.z === railPos.z) return false;
    return this._isSolid(mid);
  }

  _isEnclosedPitWithoutBarrier(railPos) {
    if (!this.bot || !this.bot.entity || !railPos) return false;
    const pos = this.bot.entity.position;
    if (Math.abs(pos.y - railPos.y) >= 0.8) return false;
    if (this._hasSolidBarrierBetweenFeet(railPos)) return false;
    const bx = Math.floor(pos.x);
    const by = Math.floor(pos.y);
    const bz = Math.floor(pos.z);
    let wallSides = 0;
    for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (this._isSolid(new Vec3(bx + ox, by, bz + oz)) && this._isSolid(new Vec3(bx + ox, by + 1, bz + oz))) {
        wallSides++;
      }
    }
    return wallSides >= 3;
  }

  _isSelfSafeToDetonate(railPos) {
    if (!this.bot || !this.bot.entity || !railPos) return false;
    const pos = this.bot.entity.position;
    const selfDist = this.cartCfg.shieldSelfDistance !== undefined ? this.cartCfg.shieldSelfDistance : 4.5;
    if (pos.distanceTo(railPos.offset(0.5, 0.35, 0.5)) > selfDist) return true;
    if (pos.y >= railPos.y + 0.9) return true;
    return this._hasSolidBarrierBetweenFeet(railPos);
  }

  _findShieldBlockSpot(railPos) {
    if (!this.bot || !this.bot.entity || !railPos || typeof this.bot.blockAt !== 'function') return null;
    const pos = this.bot.entity.position;
    const dx = (railPos.x + 0.5) - pos.x;
    const dz = (railPos.z + 0.5) - pos.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1.2) return null;

    const step = len < 2.2 ? 0.95 : 1.15;
    const cand = new Vec3(Math.floor(pos.x + (dx / len) * step), Math.floor(pos.y), Math.floor(pos.z + (dz / len) * step));
    const botFeet = pos.floored();
    if (cand.x === botFeet.x && cand.z === botFeet.z) return null;
    if (cand.x === railPos.x && cand.y === railPos.y && cand.z === railPos.z) return null;

    const block = this.bot.blockAt(cand);
    if (!block || block.name !== 'air') return null;
    if (!this._isSolid(cand.offset(0, -1, 0))) return null;
    if (!canSeeBlockFace(this.bot, cand.offset(0, -1, 0), new Vec3(0, 1, 0), { aimer: this.aimer })) return null;
    return cand;
  }

  _findBestRailSpot(target) {
    if (!this.bot || !this.bot.entity || !target || !target.position || typeof this.bot.blockAt !== 'function') return null;
    const leadTicks = this.cartCfg.leadTicks !== undefined ? this.cartCfg.leadTicks : 5;
    const pred = (this.prediction && typeof this.prediction.predictPosition === 'function')
      ? this.prediction.predictPosition(target, leadTicks).position
      : target.position.offset(
        (target.velocity ? target.velocity.x : 0) * leadTicks,
        0,
        (target.velocity ? target.velocity.z : 0) * leadTicks
      );

    const eye = this.aimer ? this.aimer.getEyePosition() : this.bot.entity.position.offset(0, 1.62, 0);
    const botFeet = this.bot.entity.position.floored();
    const px = Math.floor(pred.x);
    const py = Math.floor(pred.y);
    const pz = Math.floor(pred.z);

    let best = null;
    let bestScore = Infinity;
    for (const dy of [0, -1]) {
      for (const [ox, oz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const cand = new Vec3(px + ox, py + dy, pz + oz);
        const center = cand.offset(0.5, 0.1, 0.5);
        if (eye.distanceTo(center) > 4.5) continue;
        if (cand.x === botFeet.x && cand.y === botFeet.y && cand.z === botFeet.z) continue;

        const b = this.bot.blockAt(cand);
        const isExistingRail = b && RAIL_NAMES.includes(b.name);
        if (!b || (b.name !== 'air' && !isExistingRail)) continue;
        if (!this._isSolid(cand.offset(0, -1, 0))) continue;
        const losTargetPos = isExistingRail ? cand : cand.offset(0, -1, 0);
        if (!canSeeBlockFace(this.bot, losTargetPos, new Vec3(0, 1, 0), { aimer: this.aimer })) continue;

        const score = center.distanceTo(pred) - (isExistingRail ? 0.6 : 0);
        if (score < bestScore) {
          bestScore = score;
          best = cand;
        }
      }
    }
    return best;
  }

  _findCartEntityNear(railPos) {
    if (!this.bot || !this.bot.entities || !railPos) return null;
    const center = railPos.offset(0.5, 0.35, 0.5);
    let best = null;
    let bestDist = 1.8;
    for (const ent of Object.values(this.bot.entities)) {
      if (!ent || !ent.isValid || !ent.position) continue;
      const name = String(ent.name || ent.displayName || '').toLowerCase();
      if (!name.includes('tnt_minecart') && !name.includes('minecart_tnt')) continue;
      const d = ent.position.distanceTo(center);
      if (d < bestDist) {
        bestDist = d;
        best = ent;
      }
    }
    return best;
  }

  tick(target) {
    this.swappedThisTick = false;
    this.cancel();
    return false;
  }

  _legacyTick(target) {
    this.swappedThisTick = false;
    if (this.cartCfg.enabled === false || !this.bot || !this.bot.entity || !target || !target.isValid) {
      this.cancel();
      return false;
    }

    const minHp = this.cartCfg.minHealth !== undefined ? this.cartCfg.minHealth : 10;
    if (this.bot.health <= minHp) {
      this.cancel();
      return false;
    }

    if (this.state === CART_STATES.IDLE || this.state === CART_STATES.STACK_CARTS) {
      this._tryRefillHotbarCart();
    }

    if (this.state !== CART_STATES.IDLE) {
      this.stateTicks++;
      const maxTicks = this.state === CART_STATES.PRELOAD_CROSSBOW ? 40 : 35;
      if (this.stateTicks > maxTicks) {
        this.cancel();
        return false;
      }
      if (this.state === CART_STATES.PRELOAD_CROSSBOW) return this._tickPreloadCrossbow(target);
      if (this.state === CART_STATES.AXE_STUN) return this._tickAxeStun(target);
      if (this.state === CART_STATES.SHIELD_BLOCK) return this._tickShieldBlock(target);
      if (this.state === CART_STATES.PLACE_RAIL) return this._tickPlaceRail(target);
      if (this.state === CART_STATES.STACK_CARTS) return this._tickStackCarts(target);
      if (this.state === CART_STATES.DETONATE) return this._tickDetonate(target);
      if (this.state === CART_STATES.FOLLOWUP) return this._tickFollowup(target);
      this._resetState();
      return false;
    }

    const dist = this.bot.entity.position.distanceTo(target.position);
    const preloadMin = this.cartCfg.preloadMinRange !== undefined ? this.cartCfg.preloadMinRange : 5.0;
    const preloadMax = this.cartCfg.preloadMaxRange !== undefined ? this.cartCfg.preloadMaxRange : 16.0;

    // Decision Priority 4 (> 5b): Pre-load uncharged crossbows so detonation is zero-draw later
    if (dist > preloadMin && dist <= preloadMax && this.countTntCarts() > 0 && this._findUnchargedCrossbow()) {
      this._enterState(CART_STATES.PRELOAD_CROSSBOW);
      return this._tickPreloadCrossbow(target);
    }

    // Decision Priority 3 (<= 4.5b): Execute Cart PvP combo
    const engageRange = this.cartCfg.engageRange !== undefined ? this.cartCfg.engageRange : 4.5;
    const cooldownMs = this.cartCfg.comboCooldownMs !== undefined ? this.cartCfg.comboCooldownMs : 900;
    if (dist > engageRange || (Date.now() - this.lastComboTime) < cooldownMs || !this._hasCartKit()) {
      return false;
    }

    const targetShielded = Boolean(
      this.combat && typeof this.combat.isTargetRaisingShield === 'function' && this.combat.isTargetRaisingShield(target)
    );
    if (dist < 3.0 && targetShielded && this._findItem(AXE_PRIORITY)) {
      this._enterState(CART_STATES.AXE_STUN);
      return this._tickAxeStun(target);
    }

    const railPos = this._findBestRailSpot(target);
    if (!railPos) return false;
    if (this._isEnclosedPitWithoutBarrier(railPos) && !this._findShieldBlockSpot(railPos)) return false;

    this._beginComboAt(railPos);
    return true;
  }

  _beginComboAt(railPos) {
    const desired = this.cartCfg.stackCount !== undefined ? this.cartCfg.stackCount : 3;
    this.railPos = railPos;
    this.cartsPlaced = 0;
    this.targetStackCount = Math.min(desired, Math.max(1, this.countTntCarts()));
    this.needsPostStackShield = false;
    this.shieldPos = null;

    if (!this._isSelfSafeToDetonate(railPos)) {
      const shieldBlock = this._findItem(SHIELD_BLOCK_PRIORITY);
      const shieldSpot = this._findShieldBlockSpot(railPos);
      if (shieldBlock && shieldSpot) {
        this.shieldPos = shieldSpot;
        this._enterState(CART_STATES.SHIELD_BLOCK);
        return;
      }
      if (this.bot.entity.position.distanceTo(railPos.offset(0.5, 0.35, 0.5)) <= 4.5 && !this._isSelfSafeToDetonate(railPos)) {
        this._resetState();
        return;
      }
    }

    const curBlock = typeof this.bot.blockAt === 'function' ? this.bot.blockAt(railPos) : null;
    if (curBlock && RAIL_NAMES.includes(curBlock.name)) {
      this._enterState(CART_STATES.STACK_CARTS);
    } else {
      this._enterState(CART_STATES.PLACE_RAIL);
    }
  }

  _tickPreloadCrossbow(target) {
    const dist = this.bot.entity.position.distanceTo(target.position);
    if (dist <= 4.8) {
      this.cancel();
      return false;
    }

    const xbow = this.preloadActive && this.activePreloadItem ? this.activePreloadItem : this._findUnchargedCrossbow();
    if (!xbow || !this._hasArrows()) {
      this.cancel();
      return false;
    }

    this.aimer.stepTowardsEntity(target, { speedMultiplier: 1.25 });
    const eq = this._equipSequential(xbow);
    if (!eq.ready) return true;

    if (!this.preloadActive) {
      if (typeof this.bot.activateItem === 'function') this.bot.activateItem(false);
      this.preloadActive = true;
      this.activePreloadItem = xbow;
      this.preloadTicks = 0;
      return true;
    }

    this.preloadTicks++;
    const chargeTicks = this.cartCfg.crossbowChargeTicks !== undefined ? this.cartCfg.crossbowChargeTicks : 26;
    if (this.preloadTicks >= chargeTicks) {
      if (typeof this.bot.deactivateItem === 'function') this.bot.deactivateItem();
      this.preloadActive = false;
      this.activePreloadItem = null;
      this._resetState();
      return false;
    }
    return true;
  }

  _tickAxeStun(target) {
    const axe = this._findItem(AXE_PRIORITY);
    if (!axe) {
      this._resetState();
      return false;
    }

    const aim = this.aimer.stepTowardsEntity(target, { speedMultiplier: 1.75, toleranceRad: 0.25 });
    const eq = this._equipSequential(axe);
    if (eq.ready && aim.aligned) {
      if (typeof this.bot.setControlState === 'function') this.bot.setControlState('sprint', true);
      if (typeof this.bot.attack === 'function') this.bot.attack(target);
      if (this.combat) this.combat.targetShieldDisabledUntil = Date.now() + 5000;
      const nextRail = this._findBestRailSpot(target);
      if (nextRail) {
        this._beginComboAt(nextRail);
        return this.isBusy();
      }
      this._resetState();
      return false;
    }
    return true;
  }

  _tickShieldBlock() {
    if (!this.shieldPos || !this.railPos) {
      this._resetState();
      return false;
    }
    const blockItem = this._findItem(SHIELD_BLOCK_PRIORITY);
    if (!blockItem) {
      if (this._isSelfSafeToDetonate(this.railPos)) {
        this._enterState(this.needsPostStackShield ? CART_STATES.DETONATE : CART_STATES.PLACE_RAIL);
        return true;
      }
      this._resetState();
      return false;
    }

    const refPos = this.shieldPos.offset(0, -1, 0);
    const refBlock = typeof this.bot.blockAt === 'function' ? this.bot.blockAt(refPos) : null;
    const vis = refBlock ? canSeeBlockFace(this.bot, refPos, new Vec3(0, 1, 0), { aimer: this.aimer }) : null;
    if (!refBlock || refBlock.boundingBox !== 'block' || !vis) {
      this._resetState();
      return false;
    }

    const aim = this.aimer.stepTowardsPoint(vis.aimPos, { speedMultiplier: 1.85, toleranceRad: 0.25 });
    const eq = this._equipSequential(blockItem);
    if (eq.ready && aim.aligned && typeof this.bot.placeBlock === 'function') {
      Promise.resolve(this.bot.placeBlock(refBlock, new Vec3(0, 1, 0))).catch(() => {});
      this.shieldPos = null;
      if (this.needsPostStackShield) {
        this.needsPostStackShield = false;
        this._enterState(CART_STATES.DETONATE);
      } else {
        this._enterState(CART_STATES.PLACE_RAIL);
      }
    }
    return true;
  }

  _tickPlaceRail() {
    if (!this.railPos) { this._resetState(); return false; }
    const existing = typeof this.bot.blockAt === 'function' ? this.bot.blockAt(this.railPos) : null;
    if (existing && RAIL_NAMES.includes(existing.name)) {
      this._enterState(CART_STATES.STACK_CARTS);
      return true;
    }

    const railItem = this._findItem(RAIL_NAMES);
    const supportPos = this.railPos.offset(0, -1, 0);
    const supportBlock = typeof this.bot.blockAt === 'function' ? this.bot.blockAt(supportPos) : null;
    const vis = supportBlock ? canSeeBlockFace(this.bot, supportPos, new Vec3(0, 1, 0), { aimer: this.aimer }) : null;
    if (!railItem || !supportBlock || supportBlock.boundingBox !== 'block' || !vis) {
      this._resetState();
      return false;
    }

    const aim = this.aimer.stepTowardsPoint(vis.aimPos, { speedMultiplier: 1.85, toleranceRad: 0.25 });
    const eq = this._equipSequential(railItem);
    if (eq.ready && aim.aligned && typeof this.bot.placeBlock === 'function') {
      Promise.resolve(this.bot.placeBlock(supportBlock, new Vec3(0, 1, 0))).catch(() => {});
      this._enterState(CART_STATES.STACK_CARTS);
    }
    return true;
  }

  _tickStackCarts() {
    if (!this.railPos) { this._resetState(); return false; }
    if (this.cartsPlaced >= this.targetStackCount) {
      if (!this._isSelfSafeToDetonate(this.railPos)) {
        const shieldSpot = this._findShieldBlockSpot(this.railPos);
        if (shieldSpot && this._findItem(SHIELD_BLOCK_PRIORITY)) {
          this.shieldPos = shieldSpot;
          this.needsPostStackShield = true;
          this._enterState(CART_STATES.SHIELD_BLOCK);
          return true;
        }
        this._resetState();
        return false;
      }
      this._enterState(CART_STATES.DETONATE);
      return true;
    }

    const railBlock = typeof this.bot.blockAt === 'function' ? this.bot.blockAt(this.railPos) : null;
    if (!railBlock || !RAIL_NAMES.includes(railBlock.name)) {
      this._enterState(CART_STATES.PLACE_RAIL);
      return true;
    }

    const hbCart = this._findItem(['tnt_minecart'], true);
    if (hbCart) {
      this.preferredCartHotbarIdx = hbCart.slot - this._getHotbarStart();
    }
    const cartItem = hbCart || this._findItem(['tnt_minecart'], false);
    if (!cartItem) {
      if (this.cartsPlaced > 0) {
        this._enterState(CART_STATES.DETONATE);
        return true;
      }
      this._resetState();
      return false;
    }

    const railVis = canSeeBlockFace(this.bot, this.railPos, new Vec3(0, 1, 0), { aimer: this.aimer });
    if (!railVis) {
      this._resetState();
      return false;
    }

    const aim = this.aimer.stepTowardsPoint(this.railPos.offset(0.5, 0.15, 0.5), { speedMultiplier: 1.9, toleranceRad: 0.25 });
    const eq = this._equipSequential(cartItem);
    if (this.stackWaitTick) {
      this.stackWaitTick = false;
      return true;
    }
    if (eq.ready && aim.aligned && typeof this.bot.activateBlock === 'function') {
      Promise.resolve(this.bot.activateBlock(railBlock, new Vec3(0, 1, 0))).catch(() => {});
      this.cartsPlaced++;
      this.stackWaitTick = true;
      if (this.cartsPlaced >= this.targetStackCount) {
        this._enterState(CART_STATES.DETONATE);
      }
    }
    return true;
  }

  _tickDetonate() {
    if (!this.railPos) { this.cancel(); return false; }
    if (this._isEnclosedPitWithoutBarrier(this.railPos)) {
      this.cancel();
      return false;
    }
    if (!this._isSelfSafeToDetonate(this.railPos)) {
      const spot = !this.needsPostStackShield ? this._findShieldBlockSpot(this.railPos) : null;
      if (spot && this._findItem(SHIELD_BLOCK_PRIORITY)) {
        this.shieldPos = spot;
        this.needsPostStackShield = true;
        this._enterState(CART_STATES.SHIELD_BLOCK);
        return true;
      }
      this.cancel();
      return false;
    }

    const det = this._findDetonator();
    if (!det) { this.cancel(); return false; }

    const cartEnt = this._findCartEntityNear(this.railPos);
    const aimPoint = cartEnt ? cartEnt.position.offset(0, 0.35, 0) : this.railPos.offset(0.5, 0.35, 0.5);
    const aim = this.aimer.stepTowardsPoint(aimPoint, { speedMultiplier: 1.95, toleranceRad: 0.21 });
    const eq = this._equipSequential(det.item);
    if (!eq.ready) return true;

    const aligned = aim.yawErrorDeg <= 12 && aim.pitchErrorDeg <= 12;
    if (det.kind === 'charged_crossbow') {
      if (aligned && typeof this.bot.activateItem === 'function') {
        this.bot.activateItem(false);
        this.lastComboTime = Date.now();
        this._enterState(CART_STATES.FOLLOWUP);
      }
      return true;
    }

    if (!this.detonateBowDrawing) {
      if (typeof this.bot.activateItem === 'function') this.bot.activateItem(false);
      this.detonateBowDrawing = true;
      this.detonateDrawTicks = 0;
      return true;
    }

    this.detonateDrawTicks++;
    const reqTicks = det.kind === 'bow'
      ? (this.cartCfg.bowDetonateTicks !== undefined ? this.cartCfg.bowDetonateTicks : 12)
      : (this.cartCfg.crossbowChargeTicks !== undefined ? this.cartCfg.crossbowChargeTicks : 26);
    if (this.detonateDrawTicks >= reqTicks && aligned) {
      if (typeof this.bot.deactivateItem === 'function') this.bot.deactivateItem();
      this.detonateBowDrawing = false;
      this.lastComboTime = Date.now();
      this._enterState(CART_STATES.FOLLOWUP);
    }
    return true;
  }

  _tickFollowup(target) {
    const shielded = Boolean(
      this.combat && typeof this.combat.isTargetRaisingShield === 'function' && this.combat.isTargetRaisingShield(target)
    );
    const weapon = shielded
      ? (this._findItem(AXE_PRIORITY) || this._findItem(SWORD_PRIORITY))
      : (this._findItem(SWORD_PRIORITY) || this._findItem(AXE_PRIORITY));
    if (weapon) {
      const eq = this._equipSequential(weapon);
      if (!eq.ready) return true;
    }
    this._resetState();
    return false;
  }
}

module.exports = { CartModule, CART_STATES };
