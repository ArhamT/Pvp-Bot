'use strict';

const {
  posKey,
  hasStatusEffect,
  sampleBodyHazards,
  isPlayerEmbeddedInBlock
} = require('./constants');
const { findInventoryItem, ensureItemHeld } = require('./inventory_utils');
const { BlockMiner } = require('./mining');
const { WaterBucketController } = require('./escape/water_bucket_helper');
const { cobwebEscapeMethods } = require('./escape/cobweb_escape');
const { liquidEscapeMethods } = require('./escape/liquid_escape');
const { blockEscapeMethods } = require('./escape/block_escape');
const { boxBreakoutMethods } = require('./escape/box_breakout');
const {
  railStallEscapeMethods,
  RAIL_BLOCK_NAMES,
  UNBREAKABLE_BLOCKS,
  isTntCartEntity
} = require('./escape/rail_stall_escape');

/**
 * Modular escape coordinator combining:
 * - Unified Water Bucket FSM (`modules/escape/water_bucket_helper.js`)
 * - 3-tier Cobweb Escape (`modules/escape/cobweb_escape.js`)
 * - Lava, Fire & Water Shore Escape (`modules/escape/liquid_escape.js`)
 * - Pillar-Out, Bridge-Step & Anti-Combo Wall (`modules/escape/block_escape.js`)
 * - Box & Roof Breakout (`modules/escape/box_breakout.js`)
 * - Rail/TNT-Cart Evasion & Stall Unstick (`modules/escape/rail_stall_escape.js`)
 */
class EscapeModule {
  constructor(bot, config, aimer) {
    this.bot = bot;
    this.config = config || {};
    this.escapeCfg = (config && config.escape) || {};
    this.aimer = aimer;

    this.activeMode = 'IDLE';
    this.modeTicks = 0;

    this.diggingInProgress = false;
    this.miner = new BlockMiner(bot, aimer);
    this.waterCtrl = new WaterBucketController(bot, aimer);

    this.pearlSettleTicks = 0;
    this.cobwebPearlSettleTicks = 0;
    this.lastCobwebPearlAt = 0;

    this.waterStuckTicks = 0;
    this.lastWaterCheckPos = null;

    this.evadeTargetPos = null;
    this.evadedRails = new Map();
    this.railBlockThreat = null;
    this._railScanTickAt = 0;
    this._railScanResult = null;
    this._lastFullRailScanAt = 0;

    this.stallTicks = 0;
    this.lastCheckPos = null;
    this.detourYaw = null;
    this.detourTicks = 0;
    this.lastStallRecoveryAt = 0;

    this.pillarSettleTicks = 0;
    this.pillarActive = false;
    this.blockEscapePlan = null;
    this.lastBlockEscapeAt = 0;
    this.boxMinePlan = null;
    this.boxedTicks = 0;

    this._bodyHazardCache = null;
    this._bodyHazardCacheAt = 0;

    this._onBlockUpdate = this._handleBlockUpdate.bind(this);
    this._onEntitySpawn = this._handleEntitySpawn.bind(this);
    if (this.bot && typeof this.bot.on === 'function') {
      this.bot.on('blockUpdate', this._onBlockUpdate);
      this.bot.on('entitySpawn', this._onEntitySpawn);
    }
  }

  _setActiveMode(nextMode) {
    if (this.activeMode !== nextMode) {
      this.activeMode = nextMode;
      this.modeTicks = 0;
    }
  }

  dispose() {
    if (this.bot && typeof this.bot.removeListener === 'function') {
      this.bot.removeListener('blockUpdate', this._onBlockUpdate);
      this.bot.removeListener('entitySpawn', this._onEntitySpawn);
    }
    this.cancel();
    this.evadedRails.clear();
  }

  cancel() {
    this.activeMode = 'IDLE';
    this.modeTicks = 0;
    this.diggingInProgress = false;
    if (this.miner) this.miner.cancel();
    if (this.waterCtrl) this.waterCtrl.cancel();
    this.pearlSettleTicks = 0;
    this.cobwebPearlSettleTicks = 0;
    this.waterStuckTicks = 0;
    this.lastWaterCheckPos = null;
    this.evadeTargetPos = null;
    this.railBlockThreat = null;
    this.stallTicks = 0;
    this.detourYaw = null;
    this.detourTicks = 0;
    this.pillarActive = false;
    this.pillarSettleTicks = 0;
    this.blockEscapePlan = null;
    this.boxMinePlan = null;
    this.boxedTicks = 0;
    this._bodyHazardCache = null;
  }

  _handleBlockUpdate(oldBlock, newBlock) {
    if (this.escapeCfg.enabled === false || !newBlock || !newBlock.position || !this.bot || !this.bot.entity) return;
    if (!RAIL_BLOCK_NAMES.has(newBlock.name)) return;
    if (oldBlock && oldBlock.name === newBlock.name) return;

    const radius = this.escapeCfg.railEvadeRadius || 4.2;
    const center = newBlock.position.offset(0.5, 0.2, 0.5);
    if (this.bot.entity.position.distanceTo(center) <= radius) {
      const key = posKey(newBlock.position);
      const exp = this.evadedRails.get(key);
      if (exp && Date.now() < exp) return;
      this.railBlockThreat = { type: 'rail', key, pos: center, blockPos: newBlock.position.clone(), detectedAt: Date.now() };
      this._railScanTickAt = 0;
    }
  }

  _handleEntitySpawn(entity) {
    if (this.escapeCfg.enabled === false || !isTntCartEntity(entity) || !entity.position || !this.bot || !this.bot.entity) return;
    if (this.bot.entity.position.distanceTo(entity.position) <= 4.8) {
      this.railBlockThreat = {
        type: 'tnt_minecart',
        entityId: entity.id,
        key: `cart:${entity.id}`,
        pos: entity.position.clone(),
        detectedAt: Date.now()
      };
      this._railScanTickAt = 0;
    }
  }

  _findItem(nameOrList) {
    return findInventoryItem(this.bot, nameOrList);
  }

  _ensureItemHeld(found) {
    return ensureItemHeld(this.bot, found);
  }

  _getBodyHazards() {
    const now = Date.now();
    if (this._bodyHazardCache && (now - this._bodyHazardCacheAt) < 40) {
      return this._bodyHazardCache;
    }
    this._bodyHazardCache = sampleBodyHazards(this.bot);
    this._bodyHazardCacheAt = now;
    return this._bodyHazardCache;
  }

  isManagingOwnLiquid() {
    return Boolean(this.waterCtrl && this.waterCtrl.isActive());
  }

  hasFireResistance(context = {}) {
    if (context && context.hasFireRes) return true;
    return hasStatusEffect(this.bot, 'fire_resistance');
  }

  isOnFire() {
    return this._getBodyHazards().inFire;
  }

  isInLava() {
    return this._getBodyHazards().inLava;
  }

  isInWater() {
    return this._getBodyHazards().inWater;
  }

  findOverlappingCobweb() {
    return this._getBodyHazards().cobweb;
  }

  isEmbeddedInSolidBlock() {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position || typeof this.bot.blockAt !== 'function') return null;
    const pos = this.bot.entity.position;
    const head = this.bot.blockAt(pos.offset(0, 1, 0));
    if (isPlayerEmbeddedInBlock(pos, head)) return head;
    const headTop = this.bot.blockAt(pos.offset(0, 1.6, 0));
    if (headTop && headTop !== head && isPlayerEmbeddedInBlock(pos, headTop)) return headTop;
    const feet = this.bot.blockAt(pos);
    if (isPlayerEmbeddedInBlock(pos, feet)) return feet;
    return null;
  }

  tick(target, context = {}) {
    if (this.escapeCfg.enabled === false || !this.bot || !this.bot.entity || !this.bot.entity.position) {
      return false;
    }

    // Fresh single-pass hitbox hazard sample once per tick
    this._bodyHazardCache = sampleBodyHazards(this.bot);
    this._bodyHazardCacheAt = Date.now();

    if (this._bodyHazardCache.inLava || this.waterCtrl.isActive('lava')) {
      return this._tickLavaEscape(target);
    }

    if (this.waterCtrl.isActive('fire') || (this._bodyHazardCache.inFire && !this.hasFireResistance(context))) {
      if (this._tickFireExtinguish(context)) {
        return true;
      }
    }

    const overlappingCobweb = this._bodyHazardCache.cobweb;
    if (overlappingCobweb || this.waterCtrl.isActive('cobweb')) {
      return this._tickCobwebEscape(overlappingCobweb, target);
    }

    const embedded = this.isEmbeddedInSolidBlock();
    if (embedded || (this.activeMode === 'BLOCK_STUCK' && this.diggingInProgress)) {
      return this._tickBlockStuckEscape(embedded, false);
    }

    const railThreat = this.findNearbyRailOrCartThreat(target);
    if (this.activeMode === 'RAIL_EVADE' || railThreat) {
      return this._tickRailCartEvade(railThreat);
    }

    if (this._tickWaterEscape(target)) {
      return true;
    }

    if (this._tickBlockEscape(target, context)) {
      return true;
    }

    if (this._tickBoxBreakout(target, context)) {
      return true;
    }

    if (this._tickStallUnstick(target, context)) {
      return true;
    }

    return false;
  }
}

Object.assign(
  EscapeModule.prototype,
  cobwebEscapeMethods,
  liquidEscapeMethods,
  blockEscapeMethods,
  boxBreakoutMethods,
  railStallEscapeMethods
);

module.exports = {
  EscapeModule,
  RAIL_BLOCK_NAMES,
  UNBREAKABLE_BLOCKS
};
