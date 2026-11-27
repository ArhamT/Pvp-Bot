'use strict';

const { Vec3 } = require('vec3');
const { HOTBAR_START, posKey, isLiquidSource, getItemMetadataText } = require('./constants');

// Per-bot in-flight async equip lock to prevent 20Hz bot.equip() packet storms
const _equipLockByBot = new WeakMap();
const EQUIP_LOCK_TTL_MS = 1200;

function getHotbarStart(bot) {
  return (bot && bot.inventory && bot.inventory.hotbarStart) || HOTBAR_START;
}

function isSlotInHotbar(bot, slot) {
  if (typeof slot !== 'number') return false;
  const start = getHotbarStart(bot);
  return slot >= start && slot < start + 9;
}

function getHotbarIndex(bot, slot) {
  if (typeof slot !== 'number') return -1;
  const start = getHotbarStart(bot);
  return slot >= start && slot < start + 9 ? (slot - start) : -1;
}

function getInventoryItems(bot) {
  if (!bot || !bot.inventory) return [];
  if (typeof bot.inventory.items === 'function') {
    return bot.inventory.items().filter(Boolean);
  }
  if (Array.isArray(bot.inventory.slots)) {
    return bot.inventory.slots.filter(Boolean);
  }
  return [];
}

function isEquipBusy(bot) {
  if (!bot) return false;
  const entry = _equipLockByBot.get(bot);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    _equipLockByBot.delete(bot);
    return false;
  }
  return true;
}

/**
 * Finds the first matching item by name (or priority array of names),
 * checking the 9-slot hotbar first before falling back to main inventory.
 * Returns `{ item, quickBarSlot }` (`quickBarSlot === -1` when not in hotbar) or `null`.
 */
function findInventoryItem(bot, nameOrList, options = {}) {
  if (!bot || !bot.inventory || !bot.inventory.slots) return null;
  const names = Array.isArray(nameOrList) ? nameOrList : [nameOrList];
  const start = getHotbarStart(bot);
  const slots = bot.inventory.slots;
  const hotbarOnly = Boolean(options && options.hotbarOnly);

  for (const name of names) {
    for (let i = 0; i < 9; i++) {
      const item = slots[start + i];
      if (item && item.name === name) {
        return { item, quickBarSlot: i };
      }
    }
  }

  if (hotbarOnly) return null;

  const items = getInventoryItems(bot);
  for (const name of names) {
    for (let i = 0; i < items.length; i++) {
      const found = items[i];
      if (found && found.name === name) {
        return { item: found, quickBarSlot: getHotbarIndex(bot, found.slot) };
      }
    }
  }
  return null;
}

/**
 * Finds the first item matching `predicate`, searching hotbar slots first.
 * Returns `{ item, quickBarSlot }` or `null`.
 */
function findItemByPredicate(bot, predicate, options = {}) {
  if (!bot || !bot.inventory || !bot.inventory.slots || typeof predicate !== 'function') return null;
  const start = getHotbarStart(bot);
  const slots = bot.inventory.slots;
  const hotbarOnly = Boolean(options && options.hotbarOnly);

  for (let i = 0; i < 9; i++) {
    const item = slots[start + i];
    if (item && predicate(item, i)) {
      return { item, quickBarSlot: i };
    }
  }
  if (hotbarOnly) return null;

  for (let s = 0; s < slots.length; s++) {
    if (s >= start && s < start + 9) continue;
    const item = slots[s];
    if (item && predicate(item, -1)) {
      return { item, quickBarSlot: -1 };
    }
  }
  return null;
}

/**
 * Counts total stack count of an item name or list of names across inventory.
 */
function countInventoryItem(bot, nameOrList) {
  if (!bot || !bot.inventory || !Array.isArray(bot.inventory.slots)) return 0;
  const names = Array.isArray(nameOrList) ? new Set(nameOrList) : null;
  const targetName = names ? null : nameOrList;
  let total = 0;
  const slots = bot.inventory.slots;
  for (let i = 0; i < slots.length; i++) {
    const item = slots[i];
    if (!item) continue;
    if (names ? names.has(item.name) : item.name === targetName) {
      total += item.count || 1;
    }
  }
  return total;
}

/**
 * Checks whether a Crossbow item currently holds a charged arrow or firework rocket.
 */
function isCrossbowCharged(item) {
  if (!item || item.name !== 'crossbow') return false;
  const raw = getItemMetadataText(item);
  return (raw.includes('charged_projectiles') || raw.includes('charged')) &&
    (raw.includes('arrow') || raw.includes('firework'));
}

/**
 * Sequential anti-cheat-safe item hold helper with per-bot async equip lock.
 * Returns `{ held: true, swapped: false }` ONLY when the item is already settled in hand.
 * Returns `{ held: false, swapped: true }` when a hotbar switch or async equip was initiated
 * (callers MUST wait >= 1 tick before attacking or activating the item).
 * Returns `{ held: false, swapped: false, busy: true }` while an async equip is still in flight.
 */
function ensureItemHeld(bot, found, options = {}) {
  if (!bot || !found || !found.item) return { held: false, swapped: false, busy: false };

  const item = found.item;
  const qbSlot = typeof found.quickBarSlot === 'number'
    ? found.quickBarSlot
    : getHotbarIndex(bot, item.slot);

  const held = bot.heldItem;
  if (held && held.name === item.name) {
    const slotMatch = qbSlot < 0 || bot.quickBarSlot === qbSlot;
    const exactMatch = !options.exactCrossbowCharge || item.name !== 'crossbow' ||
      isCrossbowCharged(held) === isCrossbowCharged(item);
    if (slotMatch && exactMatch) {
      return { held: true, swapped: false, busy: false };
    }
  }

  if (qbSlot >= 0 && typeof bot.setQuickBarSlot === 'function') {
    bot.setQuickBarSlot(qbSlot);
    return { held: false, swapped: true, busy: false };
  }

  if (isEquipBusy(bot)) {
    return { held: false, swapped: false, busy: true };
  }

  if (typeof bot.equip === 'function') {
    const lockObj = { expiresAt: Date.now() + EQUIP_LOCK_TTL_MS };
    _equipLockByBot.set(bot, lockObj);
    Promise.resolve(bot.equip(item, 'hand'))
      .catch(() => {})
      .finally(() => {
        if (_equipLockByBot.get(bot) === lockObj) {
          _equipLockByBot.delete(bot);
        }
      });
    return { held: false, swapped: true, busy: true };
  }

  return { held: false, swapped: false, busy: false };
}

/**
 * Finds the closest reachable liquid source block (water or lava, level === 0) around `centerPos`.
 */
function findNearestLiquidSource(bot, aimer, centerPos, maxRange = 4.3, options = {}) {
  if (!bot || !bot.entity || !bot.entity.position || typeof bot.blockAt !== 'function') {
    return null;
  }
  const base = (centerPos || bot.entity.position).floored();
  const eye = aimer && typeof aimer.getEyePosition === 'function'
    ? aimer.getEyePosition()
    : bot.entity.position.offset(0, 1.62, 0);

  const liquidFilter = options.liquidName || null;
  const handledMap = options.handledSources || null;
  const now = options.now || Date.now();
  const rInt = Math.min(options.maxRadius || 4, Math.ceil(maxRange));
  const maxRangeSq = maxRange * maxRange;

  let best = null;
  let bestDistSq = Infinity;
  const probe = new Vec3(0, 0, 0);

  for (let dx = -rInt; dx <= rInt; dx++) {
    const bx = base.x + dx;
    const ddx = (bx + 0.5) - eye.x;
    for (let dy = -2; dy <= 2; dy++) {
      const by = base.y + dy;
      const ddy = (by + 0.5) - eye.y;
      for (let dz = -rInt; dz <= rInt; dz++) {
        const bz = base.z + dz;
        const ddz = (bz + 0.5) - eye.z;
        const distSq = ddx * ddx + ddy * ddy + ddz * ddz;
        if (distSq > maxRangeSq || distSq >= bestDistSq) continue;

        probe.x = bx;
        probe.y = by;
        probe.z = bz;
        const key = `${bx},${by},${bz}`;
        if (handledMap) {
          const expiry = handledMap.get(key);
          if (expiry && now < expiry) continue;
        }
        const b = bot.blockAt(probe);
        if (!isLiquidSource(b)) continue;
        if (liquidFilter && b.name !== liquidFilter) continue;

        bestDistSq = distSq;
        best = { pos: new Vec3(bx, by, bz), key, liquid: b.name, dist: Math.sqrt(distSq) };
      }
    }
  }
  return best;
}

module.exports = {
  getHotbarStart,
  isSlotInHotbar,
  getHotbarIndex,
  getInventoryItems,
  isEquipBusy,
  findInventoryItem,
  findItemByPredicate,
  countInventoryItem,
  isCrossbowCharged,
  ensureItemHeld,
  findNearestLiquidSource
};
