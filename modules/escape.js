'use strict';

const { Vec3 } = require('vec3');
const { HOTBAR_START, SWORD_PRIORITY, clearMovementControls } = require('./constants');

const RAIL_BLOCK_NAMES = new Set(['rail', 'powered_rail', 'detector_rail', 'activator_rail']);
const UNBREAKABLE_BLOCKS = new Set(['bedrock', 'barrier', 'command_block', 'end_portal_frame', 'reinforced_deepslate']);
const PILLAR_BLOCK_PRIORITY = [
  'obsidian', 'cobbled_deepslate', 'cobblestone', 'stone', 'deepslate',
  'netherrack', 'dirt', 'oak_planks', 'spruce_planks', 'end_stone'
];
const PICKAXE_PRIORITY = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe', 'golden_pickaxe'];
const SHOVEL_PRIORITY = ['netherite_shovel', 'diamond_shovel', 'iron_shovel', 'stone_shovel', 'wooden_shovel', 'golden_shovel'];
const AXE_PRIORITY = ['netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe', 'golden_axe'];

function posKey(pos) {
  return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
}

function isAirLike(b) {
  return Boolean(b && (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air'));
}

function isTntCartEntity(entity) {
  if (!entity || !entity.isValid) return false;
  const n = String(entity.name || '').toLowerCase();
  const d = String(entity.displayName || '').toLowerCase();
  return n.includes('tnt_minecart') || n.includes('minecart_tnt') || d.includes('tnt');
}

/**
 * Handles lava escape, embedded/stuck block digging & cobweb escape,
 * rail/TNT-minecart blast-radius sprint-jump evasion, and movement-stall unsticking.
 */
class EscapeModule {
  constructor(bot, config, aimer) {
    this.bot = bot;
    this.config = config || {};
    this.escapeCfg = (config && config.escape) || {};
    this.aimer = aimer;

    this.activeMode = 'IDLE'; // 'IDLE' | 'LAVA_ESCAPE' | 'BLOCK_STUCK' | 'RAIL_EVADE' | 'STALL_UNSTICK'
    this.modeTicks = 0;

    this.diggingInProgress = false;
    this.digStartedAt = 0;
    this.digSettleTicks = 0;

    this.lavaWaterState = 'IDLE'; // 'IDLE' | 'EQUIP_WAIT' | 'PICKUP_WAIT'
    this.lastLavaWaterAt = 0;
    this.lavaWaterTicks = 0;
    this.pearlSettleTicks = 0;

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
    this.pearlSettleTicks = 0;
    this.evadeTargetPos = null;
    this.railBlockThreat = null;
    this.stallTicks = 0;
    this.detourYaw = null;
    this.detourTicks = 0;
    this.pillarActive = false;
    this.pillarSettleTicks = 0;
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
    if (!this.bot || !this.bot.inventory || !this.bot.inventory.slots) return null;
    const names = Array.isArray(nameOrList) ? nameOrList : [nameOrList];
    const start = this.bot.inventory.hotbarStart || HOTBAR_START;
    for (const name of names) {
      for (let i = 0; i < 9; i++) {
        const item = this.bot.inventory.slots[start + i];
        if (item && item.name === name) return { item, quickBarSlot: i };
      }
    }
    const items = typeof this.bot.inventory.items === 'function' ? this.bot.inventory.items() : [];
    for (const name of names) {
      const found = items.find((i) => i && i.name === name);
      if (found) return { item: found, quickBarSlot: -1 };
    }
    return null;
  }

  _ensureItemHeld(found) {
    if (!found || !found.item) return { held: false, swapped: false };
    if (this.bot.heldItem && this.bot.heldItem.name === found.item.name) {
      if (found.quickBarSlot < 0 || this.bot.quickBarSlot === found.quickBarSlot) {
        return { held: true, swapped: false };
      }
    }
    if (found.quickBarSlot >= 0 && typeof this.bot.setQuickBarSlot === 'function') {
      this.bot.setQuickBarSlot(found.quickBarSlot);
      return { held: false, swapped: true };
    }
    if (typeof this.bot.equip === 'function') {
      Promise.resolve(this.bot.equip(found.item, 'hand')).catch(() => {});
      return { held: false, swapped: true };
    }
    return { held: false, swapped: false };
  }

  isInLava() {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) return false;
    if (this.bot.entity.isInLava) return true;
    if (typeof this.bot.blockAt !== 'function') return false;
    const pos = this.bot.entity.position;
    const feet = this.bot.blockAt(pos);
    const head = this.bot.blockAt(pos.offset(0, 1, 0));
    return Boolean(
      (feet && (feet.name === 'lava' || feet.name === 'flowing_lava')) ||
      (head && (head.name === 'lava' || head.name === 'flowing_lava'))
    );
  }

  isEmbeddedInSolidBlock() {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position || typeof this.bot.blockAt !== 'function') return null;
    const pos = this.bot.entity.position;
    const head = this.bot.blockAt(pos.offset(0, 1, 0));
    if (head && head.boundingBox === 'block') return head;
    const feet = this.bot.blockAt(pos);
    if (feet && feet.boundingBox === 'block') return feet;
    return null;
  }

  isInCobwebWithoutWater() {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position || typeof this.bot.blockAt !== 'function') return null;
    if (this._findItem('water_bucket')) return null;
    const pos = this.bot.entity.position;
    const feet = this.bot.blockAt(pos);
    if (feet && feet.name === 'cobweb') return feet;
    const head = this.bot.blockAt(pos.offset(0, 1, 0));
    if (head && head.name === 'cobweb') return head;
    return null;
  }

  findNearbyRailOrCartThreat(target) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) return null;
    const now = Date.now();
    for (const [k, exp] of this.evadedRails.entries()) {
      if (exp <= now) this.evadedRails.delete(k);
    }

    const botPos = this.bot.entity.position;
    let hasNearbyCart = false;
    if (this.bot.entities) {
      for (const ent of Object.values(this.bot.entities)) {
        if (!isTntCartEntity(ent) || !ent.position) continue;
        const d = botPos.distanceTo(ent.position);
        if (d <= 4.8) {
          hasNearbyCart = true;
          const key = `cart:${ent.id}`;
          const exp = this.evadedRails.get(key);
          if (!exp || now >= exp) {
            return { type: 'tnt_minecart', key, pos: ent.position.clone() };
          }
        }
      }
    }

    if (this.railBlockThreat) {
      const exp = this.evadedRails.get(this.railBlockThreat.key);
      if ((now - this.railBlockThreat.detectedAt) <= 1500 && (!exp || now >= exp)) {
        const b = typeof this.bot.blockAt === 'function' && this.railBlockThreat.blockPos
          ? this.bot.blockAt(this.railBlockThreat.blockPos)
          : null;
        if (this.railBlockThreat.type === 'tnt_minecart' || (b && RAIL_BLOCK_NAMES.has(b.name))) {
          if (botPos.distanceTo(this.railBlockThreat.pos) <= (this.escapeCfg.railEvadeRadius || 4.2) + 0.6) {
            return this.railBlockThreat;
          }
        }
      }
      this.railBlockThreat = null;
    }

    if (typeof this.bot.blockAt !== 'function') return null;

    // Check if an opponent is close and equipped to detonate rails/carts
    let enemyCartThreat = hasNearbyCart;
    if (!enemyCartThreat && target && target.isValid && target.position && botPos.distanceTo(target.position) <= 9.0) {
      const eq = Array.isArray(target.equipment) ? target.equipment : [];
      enemyCartThreat = eq.some((item) => item && item.name && (
        RAIL_BLOCK_NAMES.has(item.name) ||
        item.name === 'tnt_minecart' ||
        item.name === 'bow' ||
        item.name === 'crossbow' ||
        item.name === 'flint_and_steel' ||
        item.name === 'fire_charge'
      ));
    }
    if (!enemyCartThreat) return null;

    const radius = this.escapeCfg.railEvadeRadius || 4.2;
    const rInt = Math.ceil(radius);
    const bx = Math.floor(botPos.x);
    const by = Math.floor(botPos.y);
    const bz = Math.floor(botPos.z);

    let closest = null;
    let closestDist = Infinity;
    for (let dx = -rInt; dx <= rInt; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -rInt; dz <= rInt; dz++) {
          const bp = new Vec3(bx + dx, by + dy, bz + dz);
          const key = posKey(bp);
          const exp = this.evadedRails.get(key);
          if (exp && now < exp) continue;

          const b = this.bot.blockAt(bp);
          if (!b || !RAIL_BLOCK_NAMES.has(b.name)) continue;
          const center = bp.offset(0.5, 0.2, 0.5);
          const d = botPos.distanceTo(center);
          if (d <= radius && d < closestDist) {
            closestDist = d;
            closest = { type: 'rail', key, pos: center, blockPos: bp };
          }
        }
      }
    }
    return closest;
  }

  hasNearbyRailOrHazard(target) {
    if (this.escapeCfg.enabled === false) return false;
    return this.activeMode !== 'IDLE' ||
      this.isInLava() ||
      Boolean(this.isEmbeddedInSolidBlock()) ||
      Boolean(this.findNearbyRailOrCartThreat(target));
  }

  _findBestEscapeYaw(avoidPos = null, allowStepUp = true) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position || typeof this.bot.blockAt !== 'function') {
      return null;
    }
    const base = this.bot.entity.position;
    let best = null;

    for (let i = 0; i < 8; i++) {
      const yaw = (i * Math.PI) / 4;
      const dx = -Math.sin(yaw);
      const dz = -Math.cos(yaw);

      let blocked = false;
      let needsJump = false;
      let hasLava = false;
      let hasFloor = false;

      // Prevent diagonal corner-clipping through touching cardinal walls (e.g., 1x1 obsidian pit)
      if (Math.abs(dx) > 0.25 && Math.abs(dz) > 0.25) {
        const cx = this.bot.blockAt(base.offset(Math.sign(dx) * 0.9, 0, 0));
        const cz = this.bot.blockAt(base.offset(0, 0, Math.sign(dz) * 0.9));
        const cxH = this.bot.blockAt(base.offset(Math.sign(dx) * 0.9, 1, 0));
        const czH = this.bot.blockAt(base.offset(0, 0, Math.sign(dz) * 0.9));
        if (((cx && cx.boundingBox === 'block') || (cxH && cxH.boundingBox === 'block')) &&
            ((cz && cz.boundingBox === 'block') || (czH && czH.boundingBox === 'block'))) {
          continue;
        }
      }

      for (const dist of [1.2, 2.2]) {
        const sample = base.offset(dx * dist, 0, dz * dist);
        const f = this.bot.blockAt(sample);
        const h = this.bot.blockAt(sample.offset(0, 1, 0));
        const a = this.bot.blockAt(sample.offset(0, 2, 0));

        const fLava = f && (f.name.includes('lava') || f.name.includes('fire'));
        const hLava = h && (h.name.includes('lava') || h.name.includes('fire'));
        if (fLava || hLava) hasLava = true;

        if (h && h.boundingBox === 'block') {
          if (allowStepUp && (!a || a.boundingBox !== 'block') && (!f || f.boundingBox !== 'block')) {
            needsJump = true;
          } else {
            blocked = true;
            break;
          }
        }
        if (f && f.boundingBox === 'block') {
          if (allowStepUp && (!h || h.boundingBox !== 'block') && (!a || a.boundingBox !== 'block')) {
            needsJump = true;
          } else {
            blocked = true;
            break;
          }
        }
        if (f && f.name === 'cobweb') {
          blocked = true;
          break;
        }

        for (let down = 1; down <= 3; down++) {
          const below = this.bot.blockAt(sample.offset(0, -down, 0));
          if (below && (below.name.includes('lava') || below.name.includes('fire'))) {
            hasLava = true;
            break;
          }
          if (below && below.boundingBox === 'block') {
            hasFloor = true;
            break;
          }
        }
      }

      if (blocked || !hasFloor) continue;

      let score = (hasLava ? -50 : 20) - (needsJump ? 1.5 : 0);
      if (avoidPos) {
        const stepEnd = base.offset(dx * 2.2, 0, dz * 2.2);
        score += stepEnd.distanceTo(avoidPos) * 4.0;
      }
      if (!best || score > best.score) {
        best = { yaw, needsJump, score, hasLava };
      }
    }

    return best;
  }

  _pickToolForBlock(block) {
    if (!block || !block.name) return null;
    const name = block.name;
    if (name === 'cobweb') {
      return this._findItem(['shears', ...SWORD_PRIORITY]);
    }
    if (name.includes('dirt') || name.includes('sand') || name.includes('gravel') || name.includes('soul_')) {
      return this._findItem(SHOVEL_PRIORITY);
    }
    if (name.includes('planks') || name.includes('log') || name.includes('wood')) {
      return this._findItem(AXE_PRIORITY);
    }
    return this._findItem(PICKAXE_PRIORITY);
  }

  _canDigBlock(block) {
    if (!block || !block.name || UNBREAKABLE_BLOCKS.has(block.name)) return false;
    if (block.name === 'obsidian' || block.name === 'crying_obsidian' || block.name === 'respawn_anchor') {
      return Boolean(this._findItem(['netherite_pickaxe', 'diamond_pickaxe']));
    }
    return true;
  }

  _tickLavaEscape(target) {
    const now = Date.now();
    this.activeMode = 'LAVA_ESCAPE';
    this.modeTicks++;

    if (typeof this.bot.setControlState === 'function') {
      this.bot.setControlState('sneak', false);
      this.bot.setControlState('jump', true);
    }

    // 1. Water bucket extinguish / obsidian bridge when available
    if (this.lavaWaterState === 'EQUIP_WAIT') {
      this.lavaWaterTicks--;
      this.aimer.stepTowardsAngles(this.bot.entity.yaw, -Math.PI / 2, { speedMultiplier: 1.6, force: true });
      if (this.lavaWaterTicks <= 0 && this.bot.heldItem && this.bot.heldItem.name === 'water_bucket') {
        if (typeof this.bot.activateItem === 'function') this.bot.activateItem(false);
        this.lastLavaWaterAt = now;
        this.lavaWaterState = 'PICKUP_WAIT';
        this.lavaWaterTicks = 2;
      }
      return true;
    }

    if (this.lavaWaterState === 'PICKUP_WAIT') {
      this.lavaWaterTicks--;
      if (this.lavaWaterTicks <= 0) {
        const emptyBucket = this._findItem('bucket');
        if (emptyBucket) {
          const eq = this._ensureItemHeld(emptyBucket);
          if (!eq.swapped) {
            this.aimer.stepTowardsAngles(this.bot.entity.yaw, -Math.PI / 2, { speedMultiplier: 1.6, force: true });
            if (typeof this.bot.activateItem === 'function') this.bot.activateItem(false);
            this.lavaWaterState = 'IDLE';
          }
          return true;
        }
        this.lavaWaterState = 'IDLE';
      }
      return true;
    }

    if (!this.isInLava()) {
      this.activeMode = 'IDLE';
      this.modeTicks = 0;
      return false;
    }

    const waterCooldown = this.escapeCfg.lavaWaterCooldownMs || 2500;
    const waterBucket = (now - this.lastLavaWaterAt) >= waterCooldown ? this._findItem('water_bucket') : null;
    if (waterBucket) {
      const eq = this._ensureItemHeld(waterBucket);
      this.aimer.stepTowardsAngles(this.bot.entity.yaw, -Math.PI / 2, { speedMultiplier: 1.6, force: true });
      if (eq.swapped) {
        this.lavaWaterState = 'EQUIP_WAIT';
        this.lavaWaterTicks = 1;
      } else {
        if (typeof this.bot.activateItem === 'function') this.bot.activateItem(false);
        this.lastLavaWaterAt = now;
        this.lavaWaterState = 'PICKUP_WAIT';
        this.lavaWaterTicks = 2;
      }
      return true;
    }

    // 2. Steer toward nearest dry land
    const awayPos = (target && target.position) ? target.position : null;
    const dryExit = this._findBestEscapeYaw(awayPos, true);
    if (dryExit && !dryExit.hasLava) {
      this.pearlSettleTicks = 0;
      this.aimer.stepTowardsAngles(dryExit.yaw, 0.05, { speedMultiplier: 1.4, toleranceRad: 0.25 });
      if (typeof this.bot.setControlState === 'function') {
        this.bot.setControlState('forward', true);
        this.bot.setControlState('back', false);
        this.bot.setControlState('left', false);
        this.bot.setControlState('right', false);
        this.bot.setControlState('sprint', false);
        this.bot.setControlState('jump', true);
      }
      return true;
    }

    // 3. Boxed in lava pit: Ender Pearl out upward toward sky
    const pearl = this._findItem('ender_pearl');
    if (pearl) {
      const eq = this._ensureItemHeld(pearl);
      const escapeYaw = awayPos
        ? Math.atan2(-(this.bot.entity.position.x - awayPos.x), -(this.bot.entity.position.z - awayPos.z))
        : this.bot.entity.yaw;
      this.aimer.stepTowardsAngles(escapeYaw, 40 * (Math.PI / 180), { speedMultiplier: 1.6, force: true });
      if (eq.swapped) {
        this.pearlSettleTicks = 1;
        return true;
      }
      if (this.pearlSettleTicks > 0) {
        this.pearlSettleTicks--;
        return true;
      }
      if (typeof this.bot.activateItem === 'function') {
        this.bot.activateItem(false);
      }
      return true;
    }

    // 4. Fallback: pillar out using solid block under feet
    return this._tickPillarOut() || true;
  }

  _tickPillarOut() {
    if (typeof this.bot.placeBlock !== 'function' || typeof this.bot.blockAt !== 'function') return false;
    const pos = this.bot.entity.position;
    const aboveHead = this.bot.blockAt(pos.offset(0, 2, 0));
    if (aboveHead && aboveHead.boundingBox === 'block') return false;

    const blockRec = this._findItem(PILLAR_BLOCK_PRIORITY);
    if (!blockRec) return false;

    const eq = this._ensureItemHeld(blockRec);
    this.aimer.stepTowardsAngles(this.bot.entity.yaw, -Math.PI / 2, { speedMultiplier: 1.6, force: true });
    if (typeof this.bot.setControlState === 'function') {
      this.bot.setControlState('jump', true);
    }

    if (eq.swapped) {
      this.pillarSettleTicks = 1;
      this.pillarActive = true;
      return true;
    }
    if (this.pillarSettleTicks > 0) {
      this.pillarSettleTicks--;
      return true;
    }

    const belowPos = pos.floored().offset(0, -1, 0);
    const refBlock = this.bot.blockAt(belowPos);
    const feetPos = pos.floored();
    if (refBlock && refBlock.boundingBox === 'block' && isAirLike(this.bot.blockAt(feetPos))) {
      Promise.resolve(this.bot.placeBlock(refBlock, new Vec3(0, 1, 0))).catch(() => {});
    }
    this.pillarActive = false;
    return true;
  }

  _tickBlockStuckEscape(obstructingBlock, isCobweb) {
    const now = Date.now();
    this.activeMode = 'BLOCK_STUCK';
    this.modeTicks++;

    if (this.diggingInProgress) {
      if ((now - this.digStartedAt) > 4000) {
        this.diggingInProgress = false;
      }
      return true;
    }

    if (!isCobweb && this.modeTicks <= 3) {
      const openExit = this._findBestEscapeYaw(null, true);
      if (openExit && !openExit.hasLava) {
        this.aimer.stepTowardsAngles(openExit.yaw, 0.0, { speedMultiplier: 1.4 });
        if (typeof this.bot.setControlState === 'function') {
          this.bot.setControlState('sneak', false);
          this.bot.setControlState('forward', true);
          this.bot.setControlState('jump', true);
        }
        return true;
      }
    }

    if (
      this.escapeCfg.allowBlockDig !== false &&
      obstructingBlock &&
      this._canDigBlock(obstructingBlock) &&
      typeof this.bot.dig === 'function'
    ) {
      clearMovementControls(this.bot);
      const tool = this._pickToolForBlock(obstructingBlock);
      if (tool) {
        const eq = this._ensureItemHeld(tool);
        if (eq.swapped) {
          this.digSettleTicks = 1;
          return true;
        }
      }
      if (this.digSettleTicks > 0) {
        this.digSettleTicks--;
        return true;
      }
      this.aimer.stepTowardsPoint(obstructingBlock.position.offset(0.5, 0.5, 0.5), {
        speedMultiplier: 1.5,
        force: true
      });
      this.diggingInProgress = true;
      this.digStartedAt = now;
      Promise.resolve(this.bot.dig(obstructingBlock, true))
        .catch(() => {})
        .finally(() => {
          this.diggingInProgress = false;
        });
      return true;
    }

    const pearl = this._findItem('ender_pearl');
    if (pearl) {
      const eq = this._ensureItemHeld(pearl);
      this.aimer.stepTowardsAngles(this.bot.entity.yaw, 25 * (Math.PI / 180), { force: true });
      if (!eq.swapped && typeof this.bot.activateItem === 'function') {
        this.bot.activateItem(false);
      }
      return true;
    }

    return false;
  }

  _tickRailCartEvade(threat) {
    this.activeMode = 'RAIL_EVADE';
    this.modeTicks++;
    if (threat && threat.pos) {
      this.evadeTargetPos = threat.pos;
    }

    const threatPos = this.evadeTargetPos || (threat && threat.pos);
    if (!threatPos) {
      this.activeMode = 'IDLE';
      this.modeTicks = 0;
      return false;
    }

    const botPos = this.bot.entity.position;
    const dist = botPos.distanceTo(threatPos);
    const maxTicks = this.escapeCfg.railEvadeTicks || 12;

    if (dist >= 4.8 || this.modeTicks >= maxTicks) {
      if (threat && threat.key) {
        this.evadedRails.set(threat.key, Date.now() + 2500);
      }
      this.railBlockThreat = null;
      this.evadeTargetPos = null;
      this.activeMode = 'IDLE';
      this.modeTicks = 0;
      return false;
    }

    const best = this._findBestEscapeYaw(threatPos, true);
    const awayYaw = best
      ? best.yaw
      : Math.atan2(-(botPos.x - threatPos.x), -(botPos.z - threatPos.z));

    this.aimer.stepTowardsAngles(awayYaw, 0.0, { speedMultiplier: 1.6, toleranceRad: 0.25 });
    if (typeof this.bot.setControlState === 'function') {
      this.bot.setControlState('sneak', false);
      this.bot.setControlState('forward', true);
      this.bot.setControlState('back', false);
      this.bot.setControlState('left', false);
      this.bot.setControlState('right', false);
      this.bot.setControlState('sprint', this.bot.food > 6);
      this.bot.setControlState('jump', Boolean(this.bot.entity.onGround));
    }
    return true;
  }

  _tickStallUnstick(target, context) {
    const now = Date.now();
    if (this.activeMode === 'STALL_UNSTICK') {
      if (this.pillarActive) {
        return this._tickPillarOut();
      }
      this.detourTicks--;
      if (this.detourTicks <= 0) {
        this.activeMode = 'IDLE';
        this.detourYaw = null;
        return false;
      }
      if (this.detourYaw !== null) {
        this.aimer.stepTowardsAngles(this.detourYaw, 0.0, { speedMultiplier: 1.5 });
      }
      if (typeof this.bot.setControlState === 'function') {
        this.bot.setControlState('sneak', false);
        this.bot.setControlState('forward', true);
        this.bot.setControlState('back', false);
        this.bot.setControlState('left', false);
        this.bot.setControlState('right', false);
        this.bot.setControlState('sprint', this.bot.food > 6);
        this.bot.setControlState('jump', Boolean(this.bot.entity.onGround));
      }
      return true;
    }

    if (!context || !context.canTrackStall) {
      this.stallTicks = 0;
      this.lastCheckPos = this.bot.entity.position.clone();
      return false;
    }

    const ctrl = this.bot.controlState || this.bot.controlStates || {};
    const movingIntent = Boolean(ctrl.forward || ctrl.back || ctrl.left || ctrl.right);
    if (!movingIntent) {
      this.stallTicks = 0;
      this.lastCheckPos = this.bot.entity.position.clone();
      return false;
    }

    const pos = this.bot.entity.position;
    if (this.lastCheckPos) {
      const dx = pos.x - this.lastCheckPos.x;
      const dz = pos.z - this.lastCheckPos.z;
      if (Math.sqrt(dx * dx + dz * dz) < 0.035) {
        this.stallTicks++;
      } else {
        this.stallTicks = 0;
      }
    }
    this.lastCheckPos = pos.clone();

    const threshold = this.escapeCfg.stallTicksThreshold || 16;
    if (this.stallTicks < threshold || (now - this.lastStallRecoveryAt) < 1200) {
      return false;
    }

    this.stallTicks = 0;
    this.lastStallRecoveryAt = now;

    const exit = this._findBestEscapeYaw(null, true);
    if (exit && !exit.hasLava) {
      this.activeMode = 'STALL_UNSTICK';
      this.detourYaw = exit.yaw;
      this.detourTicks = 8;
      return this._tickStallUnstick(target, context);
    }

    // Completely boxed in: try pillaring up first, else dig an adjacent block, else pearl
    if (this._tickPillarOut()) {
      this.activeMode = 'STALL_UNSTICK';
      return true;
    }

    if (typeof this.bot.blockAt === 'function' && typeof this.bot.dig === 'function') {
      const feet = pos.floored();
      for (const off of [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]) {
        const adj = this.bot.blockAt(feet.plus(off));
        if (adj && adj.boundingBox === 'block' && this._canDigBlock(adj)) {
          return this._tickBlockStuckEscape(adj, false);
        }
      }
    }

    const pearl = this._findItem('ender_pearl');
    if (pearl) {
      const eq = this._ensureItemHeld(pearl);
      this.aimer.stepTowardsAngles(this.bot.entity.yaw, 38 * (Math.PI / 180), { force: true });
      if (!eq.swapped && typeof this.bot.activateItem === 'function') {
        this.bot.activateItem(false);
      }
      return true;
    }

    return false;
  }

  tick(target, context = {}) {
    if (this.escapeCfg.enabled === false || !this.bot || !this.bot.entity || !this.bot.entity.position) {
      return false;
    }

    if (this.isInLava() || this.lavaWaterState !== 'IDLE') {
      return this._tickLavaEscape(target);
    }

    const embedded = this.isEmbeddedInSolidBlock();
    const cobwebNoWater = this.isInCobwebWithoutWater();
    if (embedded || cobwebNoWater || this.diggingInProgress) {
      return this._tickBlockStuckEscape(embedded || cobwebNoWater, Boolean(cobwebNoWater));
    }

    const railThreat = this.findNearbyRailOrCartThreat(target);
    if (this.activeMode === 'RAIL_EVADE' || railThreat) {
      return this._tickRailCartEvade(railThreat);
    }

    if (this._tickStallUnstick(target, context)) {
      return true;
    }

    return false;
  }
}

module.exports = {
  EscapeModule,
  RAIL_BLOCK_NAMES,
  UNBREAKABLE_BLOCKS
};
