'use strict';

const { posKey, findOverlappingBlock, isPlayerEmbeddedInBlock } = require('./constants');
const { findInventoryItem, ensureItemHeld } = require('./inventory_utils');
const { cobwebEscapeMethods } = require('./escape/cobweb_escape');
const { liquidEscapeMethods } = require('./escape/liquid_escape');
const {
  hazardUnstickMethods,
  RAIL_BLOCK_NAMES,
  UNBREAKABLE_BLOCKS,
  isTntCartEntity
} = require('./escape/hazard_unstick');

/**
 * Modular escape coordinator combining:
 * - Lava & water shore escape (`modules/escape/liquid_escape.js`)
 * - 3-tier cobweb escape (`modules/escape/cobweb_escape.js`)
 * - Rail/TNT-cart evasion, embedded-block digging, & stall unstick (`modules/escape/hazard_unstick.js`)
 */
class EscapeModule {
  constructor(bot, config, aimer) {
    this.bot = bot;
    this.config = config || {};
    this.escapeCfg = (config && config.escape) || {};
    this.aimer = aimer;

    this.activeMode = 'IDLE'; // 'IDLE' | 'LAVA_ESCAPE' | 'COBWEB_ESCAPE' | 'WATER_ESCAPE' | 'BLOCK_STUCK' | 'RAIL_EVADE' | 'STALL_UNSTICK'
    this.modeTicks = 0;

    this.diggingInProgress = false;
    this.digStartedAt = 0;
    this.digSettleTicks = 0;

    this.lavaWaterState = 'IDLE';
    this.lastLavaWaterAt = 0;
    this.lavaWaterTicks = 0;
    this.fireWaterState = 'IDLE';
    this.lastFireWaterAt = 0;
    this.fireWaterTicks = 0;
    this.fireWaterPos = null;
    this.pearlSettleTicks = 0;

    this.cobwebWaterState = 'IDLE';
    this.cobwebWaterPos = null;
    this.cobwebWaterTicks = 0;
    this.cobwebWaterFailedUntil = 0;
    this.cobwebPearlSettleTicks = 0;
    this.lastCobwebPearlAt = 0;

    this.waterStuckTicks = 0;
    this.lastWaterCheckPos = null;

    this.evadeTargetPos = null;
    this.evadedRails = new Map();
    this.railBlockThreat = null;

    this.stallTicks = 0;
    this.lastCheckPos = null;
    this.detourYaw = null;
    this.detourTicks = 0;
    this.lastStallRecoveryAt = 0;

    this.pillarSettleTicks = 0;
    this.pillarActive = false;
    this.boxMinePlan = null;
    this.boxedTicks = 0;

    this._onBlockUpdate = this._handleBlockUpdate.bind(this);
    this._onEntitySpawn = this._handleEntitySpawn.bind(this);
    if (this.bot && typeof this.bot.on === 'function') {
      this.bot.on('blockUpdate', this._onBlockUpdate);
      this.bot.on('entitySpawn', this._onEntitySpawn);
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
    this.digSettleTicks = 0;
    this.lavaWaterState = 'IDLE';
    this.lavaWaterTicks = 0;
    this.fireWaterState = 'IDLE';
    this.fireWaterTicks = 0;
    this.fireWaterPos = null;
    this.pearlSettleTicks = 0;
    this.cobwebWaterState = 'IDLE';
    this.cobwebWaterPos = null;
    this.cobwebWaterTicks = 0;
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
    this.boxMinePlan = null;
    this.boxedTicks = 0;
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
    }
  }

  _handleEntitySpawn(entity) {
    if (this.escapeCfg.enabled === false || !isTntCartEntity(entity) || !entity.position || !this.bot || !this.bot.entity) return;
    if (this.bot.entity.position.distanceTo(entity.position) <= 4.8) {
      this.railBlockThreat = { type: 'tnt_minecart', key: `cart:${entity.id}`, pos: entity.position.clone(), detectedAt: Date.now() };
    }
  }

  _findItem(nameOrList) {
    return findInventoryItem(this.bot, nameOrList);
  }

  _ensureItemHeld(found) {
    return ensureItemHeld(this.bot, found);
  }

  isManagingOwnLiquid() {
    return Boolean(this.lavaWaterState !== 'IDLE' || this.cobwebWaterState !== 'IDLE' || this.fireWaterState !== 'IDLE');
  }

  hasFireResistance() {
    if (!this.bot || !this.bot.entity || !this.bot.entity.effects) return false;
    const effects = this.bot.entity.effects;
    if (effects[12] || effects['12']) return true;
    for (const eff of Object.values(effects)) {
      if (eff && (eff.id === 12 || String(eff.name || '').toLowerCase().includes('fire_resistance'))) {
        return true;
      }
    }
    return false;
  }

  isOnFire() {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) return false;
    if (this.bot.entity.onFire || this.bot.entity.isOnFire) return true;
    if (this.bot.entity.metadata && (Number(this.bot.entity.metadata[0]) & 0x01)) return true;
    return Boolean(findOverlappingBlock(this.bot, (b) => b.name === 'fire' || b.name === 'soul_fire'));
  }

  isInLava() {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) return false;
    if (this.bot.entity.isInLava) return true;
    return Boolean(findOverlappingBlock(this.bot, (b) => b.name === 'lava' || b.name === 'flowing_lava'));
  }

  isInWater() {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) return false;
    if (this.bot.entity.isInWater) return true;
    return Boolean(findOverlappingBlock(this.bot, (b) => b.name === 'water' || b.name === 'flowing_water'));
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

  findOverlappingCobweb() {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) return null;
    return findOverlappingBlock(this.bot, (b) => b.name === 'cobweb');
  }

  isInCobwebWithoutWater() {
    if (this._findItem('water_bucket')) return null;
    return this.findOverlappingCobweb();
  }

  tick(target, context = {}) {
    if (this.escapeCfg.enabled === false || !this.bot || !this.bot.entity || !this.bot.entity.position) {
      return false;
    }

    if (this.isInLava() || this.lavaWaterState !== 'IDLE') {
      return this._tickLavaEscape(target);
    }

    if (this.fireWaterState !== 'IDLE' || (this.isOnFire() && !this.hasFireResistance())) {
      if (this._tickFireExtinguish()) {
        return true;
      }
    }

    const overlappingCobweb = this.findOverlappingCobweb();
    if (overlappingCobweb || this.cobwebWaterState !== 'IDLE') {
      return this._tickCobwebEscape(overlappingCobweb, target);
    }

    const embedded = this.isEmbeddedInSolidBlock();
    if (embedded || this.diggingInProgress) {
      return this._tickBlockStuckEscape(embedded, false);
    }

    const railThreat = this.findNearbyRailOrCartThreat(target);
    if (this.activeMode === 'RAIL_EVADE' || railThreat) {
      return this._tickRailCartEvade(railThreat);
    }

    if (this._tickWaterEscape(target)) {
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
  hazardUnstickMethods
);

module.exports = {
  EscapeModule,
  RAIL_BLOCK_NAMES,
  UNBREAKABLE_BLOCKS
};
