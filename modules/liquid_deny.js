'use strict';

const { Vec3 } = require('vec3');
const { posKey, isLiquidSource } = require('./constants');
const { findInventoryItem, ensureItemHeld, findNearestLiquidSource } = require('./inventory_utils');

const SOLID_DENY_BLOCKS = [
  'cobblestone',
  'cobbled_deepslate',
  'netherrack',
  'dirt',
  'stone',
  'oak_planks',
  'spruce_planks',
  'birch_planks',
  'end_stone',
  'deepslate',
  'obsidian'
];

const PLACEMENT_OFFSETS = [
  { offset: new Vec3(0, -1, 0), face: new Vec3(0, 1, 0) },
  { offset: new Vec3(1, 0, 0), face: new Vec3(-1, 0, 0) },
  { offset: new Vec3(-1, 0, 0), face: new Vec3(1, 0, 0) },
  { offset: new Vec3(0, 0, 1), face: new Vec3(0, 0, -1) },
  { offset: new Vec3(0, 0, -1), face: new Vec3(0, 0, 1) },
  { offset: new Vec3(0, 1, 0), face: new Vec3(0, -1, 0) }
];

/**
 * Liquid Denial skill:
 * When an opponent places a water or lava source within reach:
 * 1. If the bot has an empty `bucket`, aim at the source and scoop it up (`activateItem(false)`).
 * 2. Otherwise, place a solid block onto the liquid source to destroy/cover it.
 */
class LiquidDenyModule {
  constructor(bot, config, aimer) {
    this.bot = bot;
    this.config = config || {};
    this.cfg = (config && config.liquidDeny) || {};
    this.aimer = aimer;

    this.activeInCombat = false;
    this.activeThreat = null;
    this.handledSources = new Map();
    this.inFlight = false;
    this.lastActionAt = 0;
    this.lastOwnBucketHeldAt = 0;
    this.lastScanAt = 0;

    this._onBlockUpdate = this._handleBlockUpdate.bind(this);
    if (this.bot && typeof this.bot.on === 'function') {
      this.bot.on('blockUpdate', this._onBlockUpdate);
    }
  }

  setCombatActive(active) {
    this.activeInCombat = Boolean(active);
    if (!this.activeInCombat) {
      this.cancel();
    }
  }

  isBusy() {
    return Boolean(this.activeThreat || this.inFlight);
  }

  cancel() {
    this.activeThreat = null;
  }

  dispose() {
    if (this.bot && typeof this.bot.removeListener === 'function') {
      this.bot.removeListener('blockUpdate', this._onBlockUpdate);
    }
    this.cancel();
    this.handledSources.clear();
  }

  _getEyePos() {
    if (this.aimer && typeof this.aimer.getEyePosition === 'function') {
      return this.aimer.getEyePosition();
    }
    const pos = this.bot.entity.position;
    return pos.offset(0, 1.62, 0);
  }

  _handleBlockUpdate(oldBlock, newBlock) {
    if (this.cfg.enabled === false || !this.activeInCombat) return;
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) return;
    if (!newBlock || !newBlock.position || !isLiquidSource(newBlock)) return;

    // Ignore updates where an identical source block was already there
    if (oldBlock && oldBlock.name === newBlock.name && isLiquidSource(oldBlock)) return;

    // Suppress reactions immediately after holding/using our own water_bucket or lava_bucket
    const now = Date.now();
    const heldName = this.bot.heldItem && this.bot.heldItem.name;
    if (heldName === 'water_bucket' || heldName === 'lava_bucket' || (now - this.lastOwnBucketHeldAt) < 450) {
      return;
    }

    const maxRange = this.cfg.maxRange !== undefined ? this.cfg.maxRange : 4.5;
    const center = newBlock.position.offset(0.5, 0.5, 0.5);
    if (this._getEyePos().distanceTo(center) > maxRange) return;

    const key = posKey(newBlock.position);
    const expiry = this.handledSources.get(key);
    if (expiry && now < expiry) return;

    this.activeThreat = {
      pos: newBlock.position.floored(),
      key,
      liquid: newBlock.name,
      detectedAt: now,
      scoopAttempts: 0,
      fromScan: false
    };
  }

  _findNearestLiquidSource(maxRange, now) {
    return findNearestLiquidSource(this.bot, this.aimer, this.bot.entity && this.bot.entity.position, maxRange, {
      handledSources: this.handledSources,
      now,
      maxRadius: 4
    });
  }

  _findItem(nameOrList) {
    return findInventoryItem(this.bot, nameOrList);
  }

  _ensureItemHeld(found) {
    return ensureItemHeld(this.bot, found);
  }

  _overlapsBotBody(blockPos) {
    const pos = this.bot.entity.position;
    const bx = Math.floor(pos.x);
    const by = Math.floor(pos.y);
    const bz = Math.floor(pos.z);
    return blockPos.x === bx && blockPos.z === bz && (blockPos.y === by || blockPos.y === by + 1);
  }

  _findPlacementRef(targetPos) {
    if (typeof this.bot.blockAt !== 'function') return null;
    for (const { offset, face } of PLACEMENT_OFFSETS) {
      const refPos = targetPos.plus(offset);
      const refBlock = this.bot.blockAt(refPos);
      if (refBlock && refBlock.boundingBox === 'block') {
        return { refBlock, faceVec: face.clone() };
      }
    }
    return null;
  }

  tick(target = null, options = {}) {
    if (this.cfg.enabled === false || !this.activeInCombat) return false;
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) return false;

    const now = Date.now();
    const heldName = this.bot.heldItem && this.bot.heldItem.name;
    if (heldName === 'water_bucket' || heldName === 'lava_bucket' || options.suppressOwnLiquid) {
      this.lastOwnBucketHeldAt = now;
      if (options.suppressOwnLiquid) {
        this.activeThreat = null;
        return false;
      }
    }

    if (this.inFlight) return true;

    const maxRange = this.cfg.maxRange !== undefined ? this.cfg.maxRange : 4.5;
    const preferEmptyBucket = this.cfg.preferEmptyBucket !== false;
    const emptyBucket = preferEmptyBucket ? this._findItem(['bucket']) : null;

    // Active water/lava pickup scan when carrying an empty bucket (handles missed blockUpdates / pre-existing water)
    if (!this.activeThreat && emptyBucket && (now - this.lastOwnBucketHeldAt) >= 450 && (now - this.lastScanAt) >= 150) {
      this.lastScanAt = now;
      const nearbySource = this._findNearestLiquidSource(Math.min(maxRange, 4.3), now);
      if (nearbySource) {
        this.activeThreat = {
          pos: nearbySource.pos,
          key: nearbySource.key,
          liquid: nearbySource.liquid,
          detectedAt: now,
          scoopAttempts: 0,
          fromScan: true
        };
      }
    }

    if (!this.activeThreat) return false;

    const ttlMs = this.cfg.threatTtlMs !== undefined ? this.cfg.threatTtlMs : 1800;
    if ((now - this.activeThreat.detectedAt) > ttlMs) {
      this.activeThreat = null;
      return false;
    }

    const pos = this.activeThreat.pos;
    const currentBlock = typeof this.bot.blockAt === 'function' ? this.bot.blockAt(pos) : null;
    if (!isLiquidSource(currentBlock)) {
      this.activeThreat = null;
      return false;
    }

    const center = pos.offset(0.5, 0.5, 0.5);
    if (this._getEyePos().distanceTo(center) > maxRange) {
      this.activeThreat = null;
      return false;
    }

    const cooldownMs = this.cfg.cooldownMs !== undefined ? this.cfg.cooldownMs : 300;
    if (!this.activeThreat.scoopAttempts && (now - this.lastActionAt) < cooldownMs) {
      return false;
    }

    // Priority 1: Empty bucket -> scoop the water/lava source cleanly (with 1-tick settle + 1 retry if server didn't register)
    if (emptyBucket) {
      const aimTarget = this.activeThreat.scoopAttempts > 0 ? pos.offset(0.5, 0.25, 0.5) : center;
      if (this.aimer) {
        this.aimer.stepTowardsPoint(aimTarget, { force: true });
      }
      const eq = this._ensureItemHeld(emptyBucket);
      if (eq.swapped || !eq.held) {
        return true; // Wait 1 tick after hotbar swap before activating bucket
      }
      if (typeof this.bot.activateItem === 'function') {
        this.bot.activateItem(false);
      }
      this.activeThreat.scoopAttempts = (this.activeThreat.scoopAttempts || 0) + 1;
      this.lastActionAt = now;

      // If still a liquid source on next tick, allow 1 quick retry; after 2 attempts blacklist briefly
      if (this.activeThreat.scoopAttempts >= 2) {
        this.handledSources.set(this.activeThreat.key, now + 2500);
        this.activeThreat = null;
      }
      return true;
    }

    // Proximity-scanned sources are only for empty-bucket refilling, never unsolicited block placement
    if (this.activeThreat.fromScan) {
      this.activeThreat = null;
      return false;
    }

    // Priority 2: No empty bucket -> place a solid block directly onto the source block
    if (this._overlapsBotBody(pos)) {
      this.handledSources.set(this.activeThreat.key, now + 1000);
      this.activeThreat = null;
      return false;
    }

    const blockSel = this._findItem(SOLID_DENY_BLOCKS);
    const ref = blockSel ? this._findPlacementRef(pos) : null;
    if (!blockSel || !ref) {
      this.handledSources.set(this.activeThreat.key, now + 1500);
      this.activeThreat = null;
      return false;
    }

    const faceCenter = ref.refBlock.position.offset(
      0.5 + ref.faceVec.x * 0.5,
      0.5 + ref.faceVec.y * 0.5,
      0.5 + ref.faceVec.z * 0.5
    );
    if (this.aimer) {
      this.aimer.stepTowardsPoint(faceCenter, { force: true });
    }

    const eq = this._ensureItemHeld(blockSel);
    if (eq.swapped || !eq.held) {
      return true; // Wait 1 tick after slot swap before placing block
    }

    if (typeof this.bot.setControlState === 'function') {
      this.bot.setControlState('sneak', false);
    }

    if (typeof this.bot.placeBlock === 'function') {
      this.inFlight = true;
      const doneKey = this.activeThreat.key;
      this.handledSources.set(doneKey, now + 2500);
      this.lastActionAt = now;
      this.activeThreat = null;
      Promise.resolve(this.bot.placeBlock(ref.refBlock, ref.faceVec))
        .catch(() => {})
        .finally(() => {
          this.inFlight = false;
        });
      return true;
    }

    this.activeThreat = null;
    return false;
  }
}

module.exports = {
  LiquidDenyModule,
  isLiquidSource,
  SOLID_DENY_BLOCKS
};
