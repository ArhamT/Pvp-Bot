'use strict';

const { Vec3 } = require('vec3');
const {
  SWORD_PRIORITY,
  AXE_PRIORITY,
  clearMovementControls,
  getItemMetadataText,
  isAirLike,
  inspectColumnStep
} = require('./constants');
const { ensureItemHeld } = require('./inventory_utils');
const { findVisibleBlockFace } = require('./placement_los');

const UNBREAKABLE_BLOCKS = new Set([
  'bedrock',
  'barrier',
  'command_block',
  'chain_command_block',
  'repeating_command_block',
  'end_portal_frame',
  'end_portal',
  'end_gateway',
  'nether_portal',
  'reinforced_deepslate',
  'structure_block',
  'jigsaw',
  'light'
]);

const PICKAXE_PRIORITY = [
  'netherite_pickaxe',
  'diamond_pickaxe',
  'iron_pickaxe',
  'stone_pickaxe',
  'wooden_pickaxe',
  'golden_pickaxe'
];

const SHOVEL_PRIORITY = [
  'netherite_shovel',
  'diamond_shovel',
  'iron_shovel',
  'stone_shovel',
  'wooden_shovel',
  'golden_shovel'
];

const HOE_PRIORITY = [
  'netherite_hoe',
  'diamond_hoe',
  'iron_hoe',
  'stone_hoe',
  'wooden_hoe',
  'golden_hoe'
];

const DIAMOND_TIER_BLOCKS = new Set([
  'obsidian',
  'crying_obsidian',
  'respawn_anchor',
  'ancient_debris',
  'netherite_block'
]);

const IRON_TIER_BLOCKS = new Set([
  'diamond_ore',
  'deepslate_diamond_ore',
  'emerald_ore',
  'deepslate_emerald_ore',
  'gold_ore',
  'deepslate_gold_ore',
  'redstone_ore',
  'deepslate_redstone_ore',
  'diamond_block',
  'emerald_block',
  'gold_block',
  'raw_gold_block'
]);

const STONE_TIER_BLOCKS = new Set([
  'iron_ore',
  'deepslate_iron_ore',
  'lapis_ore',
  'deepslate_lapis_ore',
  'copper_ore',
  'deepslate_copper_ore',
  'iron_block',
  'raw_iron_block',
  'lapis_block',
  'copper_block',
  'raw_copper_block'
]);

const TOOL_BASE_SPEED = {
  wooden: 2,
  stone: 4,
  iron: 6,
  diamond: 8,
  netherite: 9,
  golden: 12
};

function getEfficiencyLevel(item) {
  if (!item) return 0;
  const meta = getItemMetadataText(item);
  const m = meta.match(/efficiency["':\s,=\]]*(\d)/);
  return m ? Math.min(5, Number(m[1]) || 0) : 0;
}

function getToolSpeedScore(item, priorityList) {
  if (!item || !item.name) return -1;
  const idx = priorityList.indexOf(item.name);
  if (idx < 0) return -1;

  // Shears break wool/leaves/vines/cobweb far faster than swords or hoes in vanilla MC
  if (item.name === 'shears') {
    const eff = getEfficiencyLevel(item);
    const speed = (idx === 0 ? 15 : 8) + (eff > 0 ? eff * eff + 1 : 0);
    return speed * 10 + (priorityList.length - idx);
  }

  // Swords only act as a fallback when shears are prioritized first (wool/vines)
  if (item.name.endsWith('_sword') && priorityList[0] === 'shears') {
    return 10 + (priorityList.length - idx);
  }

  const prefix = item.name.split('_')[0];
  let speed = TOOL_BASE_SPEED[prefix] || 3;
  // Slightly penalize golden tools for stone/ores unless needed (very low durability / wood-tier harvest)
  if (prefix === 'golden') speed = 4;

  const eff = getEfficiencyLevel(item);
  if (eff > 0) {
    speed += eff * eff + 1;
  }
  // Small tiebreaker favoring higher durability tier (netherite > diamond > iron...)
  return speed * 10 + (priorityList.length - idx);
}

function getCategoryPriority(blockName) {
  const name = String(blockName || '').toLowerCase();
  if (name === 'cobweb') {
    return [...SWORD_PRIORITY, 'shears'];
  }
  if (name.includes('wool') || name === 'vine' || name === 'glow_lichen') {
    return ['shears', ...SWORD_PRIORITY];
  }
  if (name.includes('leaves')) {
    return ['shears', ...HOE_PRIORITY];
  }
  if (
    name.includes('hay_block') || name.includes('sponge') ||
    name.includes('sculk') || name.includes('wart_block') || name === 'shroomlight' ||
    name === 'target' || name.includes('moss_block') || name.includes('moss_carpet') ||
    name === 'dried_kelp_block'
  ) {
    return HOE_PRIORITY;
  }
  if (
    name.includes('dirt') || name.includes('sand') || name.includes('gravel') ||
    name.includes('soul_') || name.includes('snow') || name.includes('clay') ||
    name.includes('mud') || name.includes('grass_block') || name.includes('mycelium') ||
    name.includes('podzol') || name.includes('concrete_powder') || name === 'farmland'
  ) {
    return SHOVEL_PRIORITY;
  }
  if (
    name.includes('planks') || name.includes('log') || name.includes('wood') ||
    name.includes('stem') || name.includes('hyphae') || name.includes('bamboo') ||
    name.includes('fence') || name.includes('gate') || name.includes('door') ||
    name.includes('chest') || name.includes('barrel') || name.includes('bookshelf') ||
    name.includes('sign') || name === 'crafting_table' || name === 'melon' ||
    name === 'pumpkin' || name === 'jack_o_lantern' || name === 'scaffolding' ||
    name === 'ladder' || name === 'composter' || name === 'lectern' || name === 'beehive'
  ) {
    return AXE_PRIORITY;
  }
  return PICKAXE_PRIORITY;
}

function getInventoryItems(bot) {
  if (!bot || !bot.inventory || typeof bot.inventory.items !== 'function') return [];
  return bot.inventory.items() || [];
}

function hasAnyItem(bot, names) {
  const wanted = new Set(names);
  return getInventoryItems(bot).some((i) => i && wanted.has(i.name));
}

/**
 * Returns true iff `block` is breakable and the bot carries a tool capable of harvesting it
 * within a reasonable timeframe (prevents futilely punching obsidian/bedrock).
 */
function canMineBlock(bot, block) {
  if (!block || !block.name || isAirLike(block)) return false;
  if (block.name.includes('water') || block.name.includes('lava') || block.name === 'fire' || block.name === 'soul_fire') {
    return false;
  }
  if (UNBREAKABLE_BLOCKS.has(block.name)) return false;
  if (DIAMOND_TIER_BLOCKS.has(block.name)) {
    return hasAnyItem(bot, ['netherite_pickaxe', 'diamond_pickaxe']);
  }
  if (IRON_TIER_BLOCKS.has(block.name)) {
    return hasAnyItem(bot, ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe']);
  }
  if (STONE_TIER_BLOCKS.has(block.name)) {
    return hasAnyItem(bot, ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe']);
  }
  return true;
}

/**
 * Selects the fastest legal tool in the bot's inventory for `block`, factoring in tool category,
 * harvest tier, and Efficiency enchantment level (e.g., Eff V Diamond > unenchanted Netherite).
 * Returns `{ item, slot, inHotbar }` or `null`.
 */
function pickBestToolForBlock(bot, block) {
  if (!bot || !block || !block.name) return null;
  const items = getInventoryItems(bot);
  if (items.length === 0) return null;

  let priorityList = getCategoryPriority(block.name);
  if (DIAMOND_TIER_BLOCKS.has(block.name)) {
    priorityList = ['netherite_pickaxe', 'diamond_pickaxe'];
  } else if (IRON_TIER_BLOCKS.has(block.name)) {
    priorityList = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe'];
  } else if (STONE_TIER_BLOCKS.has(block.name)) {
    priorityList = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe'];
  }

  const hotbarStart = (bot.inventory && bot.inventory.hotbarStart) || 36;
  let best = null;
  let bestScore = -1;

  for (const item of items) {
    if (!item || !item.name) continue;
    const score = getToolSpeedScore(item, priorityList);
    if (score < 0) continue;
    const inHotbar = typeof item.slot === 'number' && item.slot >= hotbarStart && item.slot < hotbarStart + 9;
    // Tiny tiebreak favoring already-hotbar tools when speed is identical
    const totalScore = score + (inHotbar ? 0.5 : 0);
    if (totalScore > bestScore) {
      bestScore = totalScore;
      best = {
        item,
        slot: item.slot,
        quickBarSlot: inHotbar ? (item.slot - hotbarStart) : -1,
        inHotbar
      };
    }
  }

  return best;
}

function estimateDigTimeoutMs(bot, block) {
  if (bot && typeof bot.digTime === 'function' && block) {
    try {
      const ms = Number(bot.digTime(block));
      if (Number.isFinite(ms) && ms > 0 && ms < 60000) {
        return Math.max(3500, Math.ceil(ms * 1.65 + 1500));
      }
    } catch (_) {}
  }
  const name = block && block.name ? block.name : '';
  if (DIAMOND_TIER_BLOCKS.has(name)) return 13500;
  if (name.includes('deepslate') || name.includes('iron_block') || name.includes('end_stone')) return 6500;
  return 4500;
}

/**
 * Anti-cheat-safe, 3D-LOS-verified block mining controller (`BlockMiner`):
 * - Selects fastest legal tool (category + tier + Efficiency enchant).
 * - Waits 1 tick after hotbar swap before starting dig.
 * - Aims smoothly at a 3D-DDA-verified visible block face via `SmoothAimer`.
 * - Calls `bot.dig(block, 'ignore', face)` so Mineflayer never snaps look or digs behind walls.
 * - Continuously tracks face aim, reach, tool integrity, and dynamic dig timeout.
 * - Also supports autonomous manual `!mine <block|x y z> [count]` tasks.
 */
class BlockMiner {
  constructor(bot, aimer) {
    this.bot = bot;
    this.aimer = aimer;

    this.digging = false;
    this.digPos = null;
    this.digFace = null;
    this.digToolName = null;
    this.digStartedAt = 0;
    this.digTimeoutMs = 4500;
    this.settleTicks = 0;

    // Optional manual `!mine` job state
    this.manualTask = null;
  }

  isBusy() {
    return this.digging || Boolean(this.manualTask);
  }

  cancel(clearManual = true) {
    if (this.digging && this.bot && typeof this.bot.stopDigging === 'function') {
      try { this.bot.stopDigging(); } catch (_) {}
    }
    this.digging = false;
    this.digPos = null;
    this.digFace = null;
    this.digToolName = null;
    this.digStartedAt = 0;
    this.settleTicks = 0;
    if (clearManual) {
      this.manualTask = null;
    }
  }

  _samePos(a, b) {
    return Boolean(a && b && a.x === b.x && a.y === b.y && a.z === b.z);
  }

  _resolveVisibleFace(block, allowEmbedded = false) {
    const vis = findVisibleBlockFace(this.bot, block.position, {
      aimer: this.aimer,
      maxReach: 4.5
    });
    if (vis) return vis;

    // Embedded self-escape (e.g., stuck inside cobweb or suffocating block overlapping bot body)
    if (allowEmbedded && this.bot && this.bot.entity && this.bot.entity.position) {
      const center = block.position.offset(0.5, 0.5, 0.5);
      if (this.bot.entity.position.offset(0, 0.9, 0).distanceTo(center) <= 1.35) {
        return {
          face: new Vec3(0, 1, 0),
          aimPos: center,
          distance: this.bot.entity.position.distanceTo(center),
          embeddedSelf: true
        };
      }
    }
    return null;
  }

  /**
   * Advances mining `block` by 1 physics tick.
   * Returns `{ status: 'done' | 'preparing' | 'digging' | 'unreachable' | 'unbreakable' | 'failed', tool? }`.
   */
  mineBlockTick(block, opts = {}) {
    if (!this.bot || !this.bot.entity || typeof this.bot.blockAt !== 'function' || typeof this.bot.dig !== 'function') {
      return { status: 'failed' };
    }
    if (!block || !block.position) {
      this.cancel(false);
      return { status: 'done' };
    }

    const pos = block.position.floored();
    const liveBlock = this.bot.blockAt(pos);
    if (!liveBlock || isAirLike(liveBlock) || (liveBlock.boundingBox !== 'block' && liveBlock.name !== 'cobweb')) {
      if (this._samePos(this.digPos, pos)) {
        this.cancel(false);
      }
      return { status: 'done' };
    }

    if (!canMineBlock(this.bot, liveBlock)) {
      if (this._samePos(this.digPos, pos)) this.cancel(false);
      return { status: 'unbreakable' };
    }

    const vis = this._resolveVisibleFace(liveBlock, Boolean(opts.allowEmbedded));
    if (!vis) {
      if (this._samePos(this.digPos, pos)) this.cancel(false);
      return { status: 'unreachable' };
    }

    const now = Date.now();
    const bestTool = pickBestToolForBlock(this.bot, liveBlock);

    // If currently digging a different block, stop cleanly first
    if (this.digging && !this._samePos(this.digPos, pos)) {
      this.cancel(false);
    }

    // Active dig monitoring: keep movement stopped, face aimed, tool intact, and timeout enforced
    if (this.digging && this._samePos(this.digPos, pos)) {
      if (opts.stopMovement !== false) {
        clearMovementControls(this.bot);
      }
      if (this.aimer) {
        this.aimer.stepTowardsPoint(vis.aimPos, { speedMultiplier: 1.5, toleranceRad: 0.2, force: true });
      }
      const heldName = this.bot.heldItem ? this.bot.heldItem.name : null;
      if (this.digToolName && heldName !== this.digToolName) {
        // Another subsystem swapped our hotbar slot mid-dig -> cancel & re-equip cleanly
        this.cancel(false);
        return { status: 'preparing' };
      }
      if ((now - this.digStartedAt) > this.digTimeoutMs) {
        this.cancel(false);
        return { status: 'failed' };
      }
      return { status: 'digging', tool: heldName };
    }

    // Prepare to mine: stop movement, equip best tool, enforce 1-tick post-swap settle
    if (opts.stopMovement !== false) {
      clearMovementControls(this.bot);
    }

    // Scale aim tolerance to the block face's apparent angular size (tight at 3-4b, responsive at 1b)
    const faceTolRad = Math.min(0.45, Math.max(0.20, Math.atan2(0.35, Math.max(0.5, vis.distance || 1.0))));

    if (bestTool) {
      const eq = ensureItemHeld(this.bot, bestTool);
      if (eq.swapped || !eq.held) {
        // Returning here enforces a strict 1-tick post-swap settle before starting dig
        if (this.aimer) {
          this.aimer.stepTowardsPoint(vis.aimPos, { speedMultiplier: 2.0, toleranceRad: faceTolRad, force: true });
        }
        return { status: 'preparing', tool: bestTool.item.name };
      }
    }

    // Smoothly align aim onto the 3D-DDA-verified visible block face before sending dig packet
    if (this.aimer) {
      const aim = this.aimer.stepTowardsPoint(vis.aimPos, {
        speedMultiplier: 2.0,
        toleranceRad: faceTolRad,
        force: true
      });
      if (!aim.aligned && !vis.embeddedSelf) {
        return { status: 'preparing' };
      }
    }

    this.digging = true;
    this.digPos = pos.clone();
    this.digFace = vis.face.clone();
    this.digToolName = this.bot.heldItem ? this.bot.heldItem.name : null;
    this.digStartedAt = now;
    this.digTimeoutMs = estimateDigTimeoutMs(this.bot, liveBlock);

    // Use forceLook='ignore' (SmoothAimer already aligned!) + exact visible digFace (GrimAC-safe!)
    Promise.resolve(this.bot.dig(liveBlock, 'ignore', vis.face))
      .catch(() => {})
      .finally(() => {
        if (this._samePos(this.digPos, pos)) {
          this.digging = false;
          this.digPos = null;
          this.digFace = null;
          this.digToolName = null;
        }
      });

    return { status: 'digging', tool: this.digToolName };
  }

  /**
   * Starts a manual `!mine` task either by exact coordinates `{ pos }` or by block name `{ blockName, count }`.
   */
  startManualTask(task, reply = () => {}) {
    this.cancel(true);
    this.manualTask = {
      blockName: task.blockName ? String(task.blockName).toLowerCase() : null,
      targetPos: task.pos ? task.pos.floored() : null,
      remaining: Math.max(1, Number(task.count) || 1),
      mined: 0,
      ticks: 0,
      activePos: task.pos ? task.pos.floored() : null,
      reply
    };
  }

  _findNearestMatchingBlock(blockName, maxRadius = 14) {
    if (!this.bot || !this.bot.entity || typeof this.bot.blockAt !== 'function') return null;
    const pos = this.bot.entity.position;
    const bx = Math.floor(pos.x);
    const by = Math.floor(pos.y);
    const bz = Math.floor(pos.z);

    let bestVisible = null;
    let bestVisibleDist = Infinity;
    let bestAny = null;
    let bestAnyDist = Infinity;

    for (let dx = -maxRadius; dx <= maxRadius; dx++) {
      for (let dy = -3; dy <= 4; dy++) {
        for (let dz = -maxRadius; dz <= maxRadius; dz++) {
          const p = new Vec3(bx + dx, by + dy, bz + dz);
          const d = pos.distanceTo(p.offset(0.5, 0.5, 0.5));
          if (d > maxRadius || d >= bestAnyDist) continue;
          const b = this.bot.blockAt(p);
          if (!b || !b.name) continue;
          const matches = b.name === blockName || b.name.includes(blockName);
          if (!matches || !canMineBlock(this.bot, b)) continue;

          if (d <= 4.4 && findVisibleBlockFace(this.bot, p, { aimer: this.aimer, maxReach: 4.5 })) {
            if (d < bestVisibleDist) {
              bestVisibleDist = d;
              bestVisible = b;
            }
          }
          if (d < bestAnyDist) {
            bestAnyDist = d;
            bestAny = b;
          }
        }
      }
    }

    return bestVisible || bestAny;
  }

  /**
   * 20-TPS tick handler for manual `!mine` tasks (walks within reach if needed, then mines cleanly).
   */
  tickManualTask() {
    if (!this.manualTask || !this.bot || !this.bot.entity) return false;
    const task = this.manualTask;
    task.ticks++;
    if (task.ticks > 1200) {
      task.reply(`Mining stopped (timeout after mining ${task.mined} block(s)).`);
      this.cancel(true);
      return false;
    }

    if (!task.activePos && task.blockName) {
      const found = this._findNearestMatchingBlock(task.blockName, 14);
      if (!found) {
        task.reply(
          task.mined > 0
            ? `Finished mining ${task.mined}x ${task.blockName} (no more nearby).`
            : `No breakable '${task.blockName}' found within 14 blocks (check tool tier or range).`
        );
        this.cancel(true);
        return false;
      }
      task.activePos = found.position.floored();
    }

    const block = this.bot.blockAt(task.activePos);
    if (!block || isAirLike(block)) {
      task.mined++;
      task.remaining--;
      task.activePos = null;
      if (task.remaining <= 0 || task.targetPos) {
        task.reply(`Mined ${task.mined} block(s) successfully.`);
        this.cancel(true);
        return false;
      }
      return true;
    }

    const res = this.mineBlockTick(block);
    if (res.status === 'done') {
      task.mined++;
      task.remaining--;
      task.activePos = null;
      if (task.remaining <= 0 || task.targetPos) {
        task.reply(`Mined ${task.mined} block(s) successfully.`);
        this.cancel(true);
        return false;
      }
      return true;
    }

    if (res.status === 'unbreakable') {
      task.reply(`Cannot mine ${block.name}: missing required tool tier or unbreakable.`);
      this.cancel(true);
      return false;
    }

    if (res.status === 'unreachable') {
      // Walk smoothly closer to the block until within 4.2b and visible
      const pos = this.bot.entity.position;
      const targetCenter = block.position.offset(0.5, 0.5, 0.5);
      const dist = pos.distanceTo(targetCenter);
      if (dist > 18) {
        task.reply(`Target block ${block.name} is too far (${dist.toFixed(1)}b).`);
        this.cancel(true);
        return false;
      }
      const yaw = Math.atan2(-(targetCenter.x - pos.x), -(targetCenter.z - pos.z));
      if (this.aimer) {
        this.aimer.stepTowardsAngles(yaw, 0.0, { speedMultiplier: 1.2, force: false });
      }
      const stepX = pos.x - Math.sin(yaw) * 0.9;
      const stepZ = pos.z - Math.cos(yaw) * 0.9;
      const col = inspectColumnStep(this.bot, stepX, pos.y, stepZ);
      if (typeof this.bot.setControlState === 'function') {
        this.bot.setControlState('forward', true);
        this.bot.setControlState('back', false);
        this.bot.setControlState('left', false);
        this.bot.setControlState('right', false);
        this.bot.setControlState('sprint', false);
        this.bot.setControlState('jump', Boolean(col.needsJump && this.bot.entity.onGround));
      }
      return true;
    }

    return true;
  }
}

module.exports = {
  BlockMiner,
  UNBREAKABLE_BLOCKS,
  PICKAXE_PRIORITY,
  SHOVEL_PRIORITY,
  HOE_PRIORITY,
  getEfficiencyLevel,
  canMineBlock,
  pickBestToolForBlock,
  estimateDigTimeoutMs
};
