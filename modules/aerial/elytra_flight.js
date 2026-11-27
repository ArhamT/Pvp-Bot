'use strict';

const { Vec3 } = require('vec3');
const { CHESTPLATE_PRIORITY } = require('../constants');
const { sendStartElytraFlying } = require('./constants');

/**
 * Shared Elytra Flight & Torso-Swap Controller (`modules/aerial/elytra_flight.js`):
 * Shared by `elytra_mace.js`, `elytra_spear.js`, and `pearl_catch.js`.
 * Handles torso Elytra/Chestplate checks, anti-cheat-safe swaps, version-safe takeoff packets,
 * and 3D forward obstacle raycasting.
 */
const elytraFlightMethods = {
  _getTorsoItem() {
    return this._getSlotItem(this._getTorsoSlotIndex());
  },

  _isWearingElytra() {
    const torso = this._getTorsoItem();
    return Boolean(torso && torso.name === 'elytra');
  },

  _isSafeToRestoreChestplate() {
    if (!this.bot || !this.bot.entity) return true;
    const { onGround, inWater } = this._getEnvironmentFlags();
    const clutchMin = this.aerialCfg.clutchMinFallDistance !== undefined
      ? this.aerialCfg.clutchMinFallDistance
      : 4.0;
    return onGround || inWater || !this.isGliding || this.fallDistance < clutchMin;
  },

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

    return items.find((i) => i.name && i.name.endsWith('_chestplate') && i.slot !== torsoSlot) || null;
  },

  _hasChestplateAvailable() {
    const torso = this._getTorsoItem();
    if (torso && torso.name && torso.name.endsWith('_chestplate')) return true;
    return Boolean(this._findChestplate(this.savedChestplateName));
  },

  _hasElytraAvailable() {
    if (this._isWearingElytra()) return true;
    return Boolean(this._findItemByName('elytra'));
  },

  _sendStartElytraFlying() {
    return sendStartElytraFlying(this.bot);
  },

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
  },

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
  },

  /**
   * 3D forward obstacle raycast along `(yaw, pitch)` to prevent Elytra wall/ceiling crashes.
   */
  _hasFlightObstacleAhead(yaw, pitch, maxDist = 4.5) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position || typeof this.bot.blockAt !== 'function') {
      return false;
    }
    const origin = this.bot.entity.position.offset(0, 0.5, 0);
    const cosP = Math.cos(pitch);
    const dx = -Math.sin(yaw) * cosP;
    const dy = Math.sin(pitch);
    const dz = -Math.cos(yaw) * cosP;

    for (const d of [1.2, 2.2, 3.4, maxDist]) {
      const sample = origin.offset(dx * d, dy * d, dz * d);
      const b0 = this.bot.blockAt(sample);
      const b1 = this.bot.blockAt(sample.offset(0, 0.6, 0));
      if ((b0 && b0.boundingBox === 'block') || (b1 && b1.boundingBox === 'block')) {
        return true;
      }
    }
    return false;
  }
};

module.exports = { elytraFlightMethods };
