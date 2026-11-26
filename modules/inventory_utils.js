'use strict';

const { Vec3 } = require('vec3');
const { HOTBAR_START, posKey, isLiquidSource } = require('./constants');

/**
 * Finds the first matching item by name (or priority array of names),
 * checking the 9-slot hotbar first before falling back to main inventory.
 * Returns `{ item, quickBarSlot }` (`quickBarSlot === -1` when not in hotbar) or `null`.
 */
function findInventoryItem(bot, nameOrList) {
  if (!bot || !bot.inventory || !bot.inventory.slots) return null;
  const names = Array.isArray(nameOrList) ? nameOrList : [nameOrList];
  const start = bot.inventory.hotbarStart || HOTBAR_START;

  for (const name of names) {
    for (let i = 0; i < 9; i++) {
      const item = bot.inventory.slots[start + i];
      if (item && item.name === name) {
        return { item, quickBarSlot: i };
      }
    }
  }

  const items = typeof bot.inventory.items === 'function' ? bot.inventory.items() : [];
  for (const name of names) {
    const found = items.find((i) => i && i.name === name);
    if (found) {
      return { item: found, quickBarSlot: -1 };
    }
  }
  return null;
}

/**
 * Sequential anti-cheat-safe item hold helper.
 * Returns `{ held: true, swapped: false }` only when the item is already settled in hand;
 * returns `{ held: false, swapped: true }` when a hotbar/equip switch was just initiated
 * so callers wait at least 1 tick before attacking or activating the item.
 */
function ensureItemHeld(bot, found) {
  if (!bot || !found || !found.item) return { held: false, swapped: false };
  if (bot.heldItem && bot.heldItem.name === found.item.name) {
    if (found.quickBarSlot < 0 || bot.quickBarSlot === found.quickBarSlot) {
      return { held: true, swapped: false };
    }
  }
  if (found.quickBarSlot >= 0 && typeof bot.setQuickBarSlot === 'function') {
    bot.setQuickBarSlot(found.quickBarSlot);
    return { held: false, swapped: true };
  }
  if (typeof bot.equip === 'function') {
    Promise.resolve(bot.equip(found.item, 'hand')).catch(() => {});
    return { held: false, swapped: true };
  }
  return { held: false, swapped: false };
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

  let best = null;
  let bestDist = Infinity;
  for (let dx = -rInt; dx <= rInt; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dz = -rInt; dz <= rInt; dz++) {
        const bp = new Vec3(base.x + dx, base.y + dy, base.z + dz);
        const key = posKey(bp);
        if (handledMap) {
          const expiry = handledMap.get(key);
          if (expiry && now < expiry) continue;
        }
        const b = bot.blockAt(bp);
        if (!isLiquidSource(b)) continue;
        if (liquidFilter && b.name !== liquidFilter) continue;

        const dist = eye.distanceTo(bp.offset(0.5, 0.5, 0.5));
        if (dist <= maxRange && dist < bestDist) {
          bestDist = dist;
          best = { pos: bp, key, liquid: b.name, dist };
        }
      }
    }
  }
  return best;
}

module.exports = {
  findInventoryItem,
  ensureItemHeld,
  findNearestLiquidSource
};
