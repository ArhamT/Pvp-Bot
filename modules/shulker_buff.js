'use strict';

const { Vec3 } = require('vec3');
const {
  SWORD_PRIORITY,
  getStatusEffect,
  isAirLike,
  clearMovementControls
} = require('./constants');
const {
  getHotbarStart,
  getInventoryItems,
  findInventoryItem,
  findItemByPredicate,
  ensureItemHeld
} = require('./inventory_utils');
const { canSeeBlockFace } = require('./placement_los');

const SHULKER_STATES = Object.freeze({
  IDLE: 'IDLE',
  PLACE: 'PLACE',
  OPEN_LOOT: 'OPEN_LOOT',
  SPLASH: 'SPLASH',
  RESTORE: 'RESTORE'
});

// Vanilla MC 1.20.5+ potion numeric IDs for Strength (strength=32, long_strength=33, strong_strength=34)
const STRENGTH_POTION_IDS = new Set([32, 33, 34]);

/**
 * Detects whether a `splash_potion` item contains the Strength effect across both legacy NBT
 * (`Potion: "minecraft:strength"` / `"minecraft:strong_strength"`) and MC 1.20.5–1.21.11+ components.
 */
function isSplashStrengthPotion(item) {
  if (!item || item.name !== 'splash_potion') return false;

  const chunks = [];
  let foundStrengthId = false;

  const walk = (val, depth = 0) => {
    if (val === null || val === undefined || depth > 7) return;
    if (typeof val === 'string') {
      chunks.push(val.toLowerCase());
      return;
    }
    if (typeof val === 'number') return;
    if (val instanceof Map) {
      for (const [k, v] of val.entries()) {
        chunks.push(String(k).toLowerCase());
        walk(v, depth + 1);
      }
      return;
    }
    if (Array.isArray(val)) {
      for (const el of val) walk(el, depth + 1);
      return;
    }
    if (typeof val === 'object') {
      if (typeof val.potionId === 'number' && STRENGTH_POTION_IDS.has(val.potionId)) foundStrengthId = true;
      if (typeof val.potion === 'number' && STRENGTH_POTION_IDS.has(val.potion)) foundStrengthId = true;
      if (typeof val.id === 'number' && (val.id === 4 || val.id === 5) && (val.amplifier !== undefined || val.duration !== undefined)) {
        foundStrengthId = true;
      }
      for (const [k, v] of Object.entries(val)) {
        chunks.push(k.toLowerCase());
        walk(v, depth + 1);
      }
    }
  };

  if (item.customName) chunks.push(String(item.customName).toLowerCase());
  if (item.displayName) chunks.push(String(item.displayName).toLowerCase());
  if (item.nbt) walk(item.nbt);
  if (item.components) walk(item.components);
  if (item.componentMap) walk(item.componentMap);

  if (foundStrengthId) return true;
  const text = chunks.join(' ');
  return text.includes('strength');
}

function isShulkerBoxItem(item) {
  return Boolean(item && item.name && (item.name === 'shulker_box' || item.name.endsWith('_shulker_box')));
}

/**
 * Mid-Fight Shulker Box Restock & Splash Potion of Strength Skill (`modules/shulker_buff.js`):
 * - Triggers when Strength effect is missing or < 5s remaining, no Strength splash pot is in inventory,
 *   and any `*_shulker_box` item is available.
 * - Places shulker on a safe flat solid block with lid clearance, opens via `bot.openContainer` (with timeout),
 *   withdraws 1–2 Splash Potions of Strength, closes container immediately, and splashes self (angled away if enemy close).
 */
class ShulkerBuffSkill {
  constructor(bot, config, aimer, survival = null, logFn = null) {
    this.bot = bot;
    this.config = config || {};
    this.cfg = this.config.shulkerBuff || {};
    this.aimer = aimer;
    this.survival = survival;
    this._logFn = typeof logFn === 'function' ? logFn : null;

    this.state = SHULKER_STATES.IDLE;
    this.stateTicks = 0;
    this.lastRunAt = 0;
    this.shulkerPos = null;
    this.refPos = null;
    this.aimPos = null;
    this.openInFlight = false;
    this.openToken = 0;
    this.activeWindow = null;
  }

  _log(msg) {
    if (this.cfg.debug === false) return;
    const text = `[SHULKER_BUFF] ${msg}`;
    if (this._logFn) this._logFn(text);
  }

  isBusy() {
    return this.state !== SHULKER_STATES.IDLE;
  }

  /**
   * Returns true while a shulker container window is open or being opened (blocks background inventory clicks!).
   */
  isContainerLocked() {
    return this.state === SHULKER_STATES.OPEN_LOOT || this.openInFlight || Boolean(this.activeWindow);
  }

  _enterState(nextState) {
    if (this.state !== nextState) {
      this._log(`${this.state} -> ${nextState}`);
      this.state = nextState;
      this.stateTicks = 0;
    }
  }

  cancel() {
    this.openToken++;
    this.openInFlight = false;
    if (this.activeWindow) {
      try {
        if (typeof this.activeWindow.close === 'function') this.activeWindow.close();
      } catch (_) {}
      this.activeWindow = null;
    }
    this.state = SHULKER_STATES.IDLE;
    this.stateTicks = 0;
    this.shulkerPos = null;
    this.refPos = null;
    this.aimPos = null;
  }

  dispose() {
    this.cancel();
  }

  /**
   * Returns remaining Strength effect time in milliseconds (0 if missing).
   */
  getStrengthRemainingMs() {
    const eff = getStatusEffect(this.bot, 'strength');
    if (eff && typeof eff.duration === 'number' && eff.duration > 0) {
      return eff.duration * 50;
    }
    if (this.survival && this.survival.activeBuffUntil instanceof Map) {
      const exp = this.survival.activeBuffUntil.get('strength') || 0;
      return Math.max(0, exp - Date.now());
    }
    return 0;
  }

  hasInventoryStrengthSplash() {
    return getInventoryItems(this.bot).some(isSplashStrengthPotion);
  }

  findShulkerItem() {
    return findItemByPredicate(this.bot, isShulkerBoxItem);
  }

  shouldTrigger(target) {
    if (this.cfg.enabled === false || !this.bot || !this.bot.entity) return false;
    if (this.isBusy()) return true;

    const now = Date.now();
    const cd = this.cfg.cooldownMs !== undefined ? this.cfg.cooldownMs : 6000;
    if ((now - this.lastRunAt) < cd) return false;

    const minHp = this.cfg.minHealth !== undefined ? this.cfg.minHealth : 11;
    if (this.bot.health < minHp) return false;

    const thresholdMs = (this.cfg.strengthThresholdSec !== undefined ? this.cfg.strengthThresholdSec : 5) * 1000;
    if (this.getStrengthRemainingMs() >= thresholdMs) return false;

    if (this.hasInventoryStrengthSplash()) return false;
    if (!this.findShulkerItem()) return false;

    return true;
  }

  /**
   * Finds a safe flat solid block within reach (<= 4.2b) with air at placePos AND lid clearance above (+1).
   * Prefers off-angle / slightly away from opponent's direct melee line.
   */
  _findSafeShulkerSpot(target) {
    if (!this.bot || !this.bot.entity || typeof this.bot.blockAt !== 'function') return null;
    const pos = this.bot.entity.position;
    const eye = this.aimer ? this.aimer.getEyePosition() : pos.offset(0, 1.62, 0);
    const base = pos.floored();

    let best = null;
    let bestScore = -Infinity;

    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -2; dz <= 2; dz++) {
          if (dx === 0 && dz === 0) continue;
          const placePos = base.offset(dx, dy, dz);
          const refPos = placePos.offset(0, -1, 0);
          const lidSpace = placePos.offset(0, 1, 0);

          const refBlock = this.bot.blockAt(refPos);
          if (!refBlock || refBlock.boundingBox !== 'block') continue;
          if (!isAirLike(this.bot.blockAt(placePos)) || !isAirLike(this.bot.blockAt(lidSpace))) continue;

          // Don't place inside target hitbox
          if (target && target.position && placePos.offset(0.5, 0.5, 0.5).distanceTo(target.position.offset(0, 0.5, 0)) < 1.1) {
            continue;
          }

          const vis = canSeeBlockFace(this.bot, refPos, new Vec3(0, 1, 0), { aimer: this.aimer, maxReach: 4.2 });
          if (!vis) continue;

          const distBot = eye.distanceTo(vis.aimPos);
          if (distBot > 4.2) continue;

          let score = (4.5 - distBot) * 3;
          if (target && target.position) {
            score += placePos.offset(0.5, 0.5, 0.5).distanceTo(target.position) * 2.5;
          }
          if (score > bestScore) {
            bestScore = score;
            best = { shulkerPos: placePos, refPos, aimPos: vis.aimPos };
          }
        }
      }
    }
    return best;
  }

  _startOpenAndLoot(shulkerBlock) {
    const token = ++this.openToken;
    this.openInFlight = true;
    const timeoutMs = this.cfg.openTimeoutMs !== undefined ? this.cfg.openTimeoutMs : 1500;
    const maxWithdraw = Math.max(1, Math.min(2, this.cfg.withdrawCount !== undefined ? this.cfg.withdrawCount : 2));

    let timer = null;
    const openPromise = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('shulker_open_timeout')), timeoutMs);
      Promise.resolve(this.bot.openContainer(shulkerBlock)).then(resolve, reject);
    });

    openPromise.then(async (win) => {
      if (timer) clearTimeout(timer);
      if (token !== this.openToken || !win) {
        try { if (win && typeof win.close === 'function') win.close(); } catch (_) {}
        return;
      }
      this.activeWindow = win;
      let taken = 0;

      try {
        const containerEnd = typeof win.inventoryStart === 'number' ? win.inventoryStart : 27;
        const slots = Array.isArray(win.slots) ? win.slots : [];
        for (let s = 0; s < Math.min(containerEnd, slots.length) && taken < maxWithdraw; s++) {
          const item = slots[s];
          if (!isSplashStrengthPotion(item)) continue;
          if (typeof win.withdraw === 'function') {
            await win.withdraw(item.type, item.metadata, 1);
          } else if (typeof this.bot.clickWindow === 'function') {
            // Shift-click withdraw
            await this.bot.clickWindow(s, 0, 1);
          }
          taken++;
        }
      } catch (_) {}

      try {
        if (typeof win.close === 'function') win.close();
      } catch (_) {}
      this.activeWindow = null;
      this.openInFlight = false;

      if (token !== this.openToken) return;
      if (taken > 0 || this.hasInventoryStrengthSplash()) {
        this._log(`Withdrew ${taken} Strength splash potion(s)`);
        this._enterState(SHULKER_STATES.SPLASH);
      } else {
        this._log('No Strength splash potions found inside shulker');
        this.lastRunAt = Date.now();
        this.cancel();
      }
    }).catch(() => {
      if (timer) clearTimeout(timer);
      if (token !== this.openToken) return;
      this.openInFlight = false;
      this.activeWindow = null;
      this.lastRunAt = Date.now();
      this._log('Shulker open timed out or failed — aborting cleanly');
      this.cancel();
    });
  }

  tick(target) {
    if (!this.bot || !this.bot.entity) {
      if (this.isBusy()) this.cancel();
      return false;
    }

    if (this.state === SHULKER_STATES.IDLE) {
      if (!this.shouldTrigger(target)) return false;
      const spot = this._findSafeShulkerSpot(target);
      if (!spot) return false;
      this.shulkerPos = spot.shulkerPos;
      this.refPos = spot.refPos;
      this.aimPos = spot.aimPos;
      this._enterState(SHULKER_STATES.PLACE);
    }

    this.stateTicks++;
    if (this.stateTicks > 45) {
      this._log('Timeout — returning control to combat');
      this.lastRunAt = Date.now();
      this.cancel();
      return false;
    }

    // --- Stage 1: Equip & Place Shulker Box ---
    if (this.state === SHULKER_STATES.PLACE) {
      const existing = this.bot.blockAt(this.shulkerPos);
      if (existing && isShulkerBoxItem(existing)) {
        this._enterState(SHULKER_STATES.OPEN_LOOT);
        return true;
      }

      const shulkerRec = this.findShulkerItem();
      if (!shulkerRec) {
        this.cancel();
        return false;
      }

      clearMovementControls(this.bot);
      const aim = this.aimer
        ? this.aimer.stepTowardsPoint(this.aimPos, { speedMultiplier: 2.2, force: true })
        : { aligned: true };
      const eq = ensureItemHeld(this.bot, shulkerRec);
      if (eq.swapped || !eq.held || !aim.aligned) return true;

      const refBlock = this.bot.blockAt(this.refPos);
      if (!refBlock || refBlock.boundingBox !== 'block' || typeof this.bot.placeBlock !== 'function') {
        this.cancel();
        return false;
      }
      Promise.resolve(this.bot.placeBlock(refBlock, new Vec3(0, 1, 0))).catch(() => {});
      this._enterState(SHULKER_STATES.OPEN_LOOT);
      return true;
    }

    // --- Stage 2: Open Shulker Container & Withdraw Strength Splash Potion ---
    if (this.state === SHULKER_STATES.OPEN_LOOT) {
      clearMovementControls(this.bot);
      if (this.openInFlight) return true;

      const shulkerBlock = this.bot.blockAt(this.shulkerPos);
      if (!shulkerBlock || !isShulkerBoxItem(shulkerBlock)) {
        if (this.stateTicks <= 6) return true;
        this.lastRunAt = Date.now();
        this.cancel();
        return false;
      }

      if (typeof this.bot.openContainer !== 'function') {
        this.lastRunAt = Date.now();
        this.cancel();
        return false;
      }

      this._startOpenAndLoot(shulkerBlock);
      return true;
    }

    // --- Stage 3: Equip Strength Splash Potion & Splash Self (angled away if enemy close) ---
    if (this.state === SHULKER_STATES.SPLASH) {
      const potRec = findItemByPredicate(this.bot, isSplashStrengthPotion);
      if (!potRec) {
        this.lastRunAt = Date.now();
        this._enterState(SHULKER_STATES.RESTORE);
        return true;
      }

      const enemyClose = Boolean(
        target && target.isValid && target.position &&
        this.bot.entity.position.distanceTo(target.position) <= 4.2
      );
      const awayYaw = enemyClose
        ? Math.atan2(-(this.bot.entity.position.x - target.position.x), -(this.bot.entity.position.z - target.position.z))
        : (this.bot.entity.yaw || 0);
      const targetPitch = enemyClose ? (-78 * (Math.PI / 180)) : (-Math.PI / 2);

      const aim = this.aimer
        ? this.aimer.stepTowardsAngles(awayYaw, targetPitch, { speedMultiplier: 2.3, force: true })
        : { aligned: true };
      const eq = ensureItemHeld(this.bot, potRec);
      if (eq.swapped || !eq.held || !aim.aligned) return true;

      if (typeof this.bot.activateItem === 'function') {
        // Instant throwable: NEVER call deactivateItem()!
        this.bot.activateItem(false);
      }
      if (this.survival && typeof this.survival._markBuffApplied === 'function') {
        this.survival._markBuffApplied('strength');
      }
      this.lastRunAt = Date.now();
      this._enterState(SHULKER_STATES.RESTORE);
      return true;
    }

    // --- Stage 4: Restore Primary Sword on next tick & return immediately to combat ---
    if (this.state === SHULKER_STATES.RESTORE) {
      const sword = findInventoryItem(this.bot, SWORD_PRIORITY, { hotbarOnly: true });
      if (sword && sword.quickBarSlot >= 0 && typeof this.bot.setQuickBarSlot === 'function') {
        this.bot.setQuickBarSlot(sword.quickBarSlot);
      }
      this.cancel();
      return false;
    }

    return false;
  }
}

module.exports = {
  ShulkerBuffSkill,
  SHULKER_STATES,
  isSplashStrengthPotion,
  isShulkerBoxItem
};
