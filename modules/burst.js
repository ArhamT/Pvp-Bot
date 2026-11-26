'use strict';

const { Vec3 } = require('vec3');
const { clamp, normalizeAngle } = require('./aim');
const {
  HOTBAR_START,
  OFFHAND_SLOT,
  SWORD_PRIORITY,
  getItemMetadataText,
  hasItemEnchant
} = require('./constants');
const {
  BLAST_SHIELD_BLOCK_PRIORITY,
  isTargetInSurround,
  hasExistingCrystalAt,
  findFeetBlastShieldSpot,
  planHitCrystalTrajectory,
  planSurroundPressurePlacement
} = require('./cpvp_tactics');

const HOTBAR_END = 44;

const CRYSTAL_POWER = 6.0;
const ANCHOR_POWER = 5.0;

const COVER_BLOCK_PRIORITY = BLAST_SHIELD_BLOCK_PRIORITY;

const DEFENSE_BLOCK_PRIORITY = [
  'cobweb',
  'obsidian',
  'cobbled_deepslate',
  'cobblestone',
  'stone',
  'deepslate',
  'netherrack',
  'dirt',
  'oak_planks',
  'spruce_planks',
  'birch_planks',
  'stone_bricks',
  'end_stone'
];

const ARMOR_STATS = {
  netherite_helmet: { armor: 3, toughness: 3 },
  netherite_chestplate: { armor: 8, toughness: 3 },
  netherite_leggings: { armor: 6, toughness: 3 },
  netherite_boots: { armor: 3, toughness: 3 },
  diamond_helmet: { armor: 3, toughness: 2 },
  diamond_chestplate: { armor: 8, toughness: 2 },
  diamond_leggings: { armor: 6, toughness: 2 },
  diamond_boots: { armor: 3, toughness: 2 },
  iron_helmet: { armor: 2, toughness: 0 },
  iron_chestplate: { armor: 6, toughness: 0 },
  iron_leggings: { armor: 5, toughness: 0 },
  iron_boots: { armor: 2, toughness: 0 },
  turtle_helmet: { armor: 2, toughness: 0 },
  chainmail_helmet: { armor: 2, toughness: 0 },
  chainmail_chestplate: { armor: 5, toughness: 0 },
  chainmail_leggings: { armor: 4, toughness: 0 },
  chainmail_boots: { armor: 1, toughness: 0 },
  golden_helmet: { armor: 2, toughness: 0 },
  golden_chestplate: { armor: 5, toughness: 0 },
  golden_leggings: { armor: 3, toughness: 0 },
  golden_boots: { armor: 1, toughness: 0 },
  leather_helmet: { armor: 1, toughness: 0 },
  leather_chestplate: { armor: 3, toughness: 0 },
  leather_leggings: { armor: 2, toughness: 0 },
  leather_boots: { armor: 1, toughness: 0 }
};

const PLACEMENT_FACES = [
  { offset: new Vec3(0, -1, 0), face: new Vec3(0, 1, 0) },
  { offset: new Vec3(1, 0, 0), face: new Vec3(-1, 0, 0) },
  { offset: new Vec3(-1, 0, 0), face: new Vec3(1, 0, 0) },
  { offset: new Vec3(0, 0, 1), face: new Vec3(0, 0, -1) },
  { offset: new Vec3(0, 0, -1), face: new Vec3(0, 0, 1) },
  { offset: new Vec3(0, 1, 0), face: new Vec3(0, -1, 0) }
];

function posKey(pos) {
  return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
}

function isCrystalEntity(entity) {
  if (!entity || !entity.isValid) return false;
  const name = String(entity.name || '').toLowerCase();
  const display = String(entity.displayName || '').toLowerCase();
  return name === 'end_crystal' || name === 'ender_crystal' || name === 'endercrystal' || display === 'end crystal';
}

function isAirLike(block) {
  if (!block) return false;
  return block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air';
}

/**
 * High-burst PvP module implementing:
 * 1. End Crystal & Respawn Anchor sequential multi-tick combos with raycast-occluded blast damage scoring.
 * 2. Event-driven + per-tick Anti-Crystal / Anti-Anchor defense (block-off or crouch-shield).
 * 3. Wind Charge Mace vertical launch, real fall-distance tracking, Breach Mace smash, and Water/Wind clutch fallback.
 *
 * All rotations use SmoothAimer and all hotbar swaps/placements/activations run sequentially across ticks.
 */
class BurstModule {
  constructor(bot, config, aimer, prediction = null, combat = null) {
    this.bot = bot;
    this.config = config || {};
    this.burstCfg = (config && config.burst) || {};
    this.aimer = aimer;
    this.prediction = prediction;
    this.combat = combat;

    const tickRateMs = (config && config.physics && config.physics.tickRateMs) || 50;
    const placeDelayMs = this.burstCfg.crystalPlaceDelayMs !== undefined ? this.burstCfg.crystalPlaceDelayMs : 50;
    this.placeDelayTicks = Math.max(1, Math.round(placeDelayMs / tickRateMs));

    // Offensive burst state machine
    // IDLE | CRYSTAL_COVER | CRYSTAL_PLACE_OBSIDIAN | CRYSTAL_PLACE_CRYSTAL | CRYSTAL_DETONATE
    // | ANCHOR_PLACE | ANCHOR_CHARGE | ANCHOR_SWITCH_SLOT | ANCHOR_SHIELD_COVER | ANCHOR_DETONATE
    // | WIND_AIM_LAUNCH | WIND_FIRE | WIND_ASCENDING | WIND_DESCENDING | WIND_CLUTCH
    this.state = 'IDLE';
    this.activePlan = null;
    this.stateTicks = 0;
    this.stepDelayTicks = 0;
    this.equipBusy = false;

    // Cooldowns
    this.lastCrystalTime = 0;
    this.lastHitCrystalTime = 0;
    this.hitCrystalTarget = null;
    this.lastAnchorTime = 0;
    this.lastWindChargeTime = 0;

    // Offensive shield/sneak state (used during anchor detonation)
    this.anchorShieldRaised = false;

    // Anti-explosive defensive state machine
    // IDLE | DEFENSE_BLOCK | DEFENSE_SHIELD
    this.defenseState = 'IDLE';
    this.activeThreat = null;
    this.defensePlan = null;
    this.defenseTicksRemaining = 0;
    this.defenseShieldRaised = false;

    // Track our own recent placements, failed anchors, and recently defended threats
    this.ownPlacements = new Map();
    this.failedAnchors = new Map();
    this.defendedThreats = new Map();

    // Real fall-distance tracking for Wind Charge Mace & Clutch
    this.fallDistance = 0;
    this.lastBotY = (bot && bot.entity && bot.entity.position) ? bot.entity.position.y : null;
    this.windLaunchStartY = 0;
    this.windPeakY = 0;
    this.clutchFired = false;

    // Bind world/entity event listeners
    this._onBlockUpdate = this._handleBlockUpdate.bind(this);
    this._onEntitySpawn = this._handleEntitySpawn.bind(this);
    if (this.bot && typeof this.bot.on === 'function') {
      this.bot.on('blockUpdate', this._onBlockUpdate);
      this.bot.on('entitySpawn', this._onEntitySpawn);
    }
  }

  /**
   * Unbinds all listeners and resets internal state cleanly.
   */
  dispose() {
    if (this.bot && typeof this.bot.removeListener === 'function') {
      this.bot.removeListener('blockUpdate', this._onBlockUpdate);
      this.bot.removeListener('entitySpawn', this._onEntitySpawn);
    }
    this._clearDefenseState();
    this._resetOffensiveState(true);
    this.ownPlacements.clear();
    this.failedAnchors.clear();
    this.defendedThreats.clear();
  }

  /**
   * Returns true while actively executing an anti-explosive defense, crystal/anchor burst,
   * or wind-charge launch/clutch sequence.
   */
  isBusy() {
    return this.defenseState !== 'IDLE' || this.state !== 'IDLE';
  }

  /**
   * Aborts any non-safety offensive sequence cleanly.
   * Preserves active anti-explosive defense and lethal fall clutches.
   */
  cancel() {
    if (this.state === 'IDLE' || this.state === 'WIND_CLUTCH') {
      return;
    }

    // If airborne mid-launch with lethal fall risk, transition to clutch instead of abandoning
    if (
      (this.state === 'WIND_ASCENDING' || this.state === 'WIND_DESCENDING') &&
      this.bot &&
      this.bot.entity &&
      !this.bot.entity.onGround &&
      (this.fallDistance >= 3.0 || this._getHeightAboveGround() > 3.5) &&
      this._findClutchItem()
    ) {
      this.state = 'WIND_CLUTCH';
      this.stateTicks = 0;
      this.clutchFired = false;
      return;
    }

    this._resetOffensiveState(true);
  }

  _resetOffensiveState(releaseControls = false) {
    if (this.anchorShieldRaised) {
      try { this.bot.deactivateItem(); } catch (_) {}
      this.anchorShieldRaised = false;
    }
    if (releaseControls && this.bot && typeof this.bot.setControlState === 'function') {
      if (this.defenseState === 'IDLE') {
        this.bot.setControlState('sneak', false);
      }
      this.bot.setControlState('jump', false);
      this.bot.setControlState('forward', false);
      this.bot.setControlState('left', false);
      this.bot.setControlState('right', false);
    }
    this.state = 'IDLE';
    this.activePlan = null;
    this.stateTicks = 0;
    this.stepDelayTicks = 0;
    this.clutchFired = false;
  }

  _clearDefenseState() {
    if (this.defenseShieldRaised) {
      try { this.bot.deactivateItem(); } catch (_) {}
      this.defenseShieldRaised = false;
    }
    if (this.bot && typeof this.bot.setControlState === 'function') {
      this.bot.setControlState('sneak', false);
    }
    this.defenseState = 'IDLE';
    this.activeThreat = null;
    this.defensePlan = null;
    this.defenseTicksRemaining = 0;
  }

  // =========================================================================
  // OWN-PLACEMENT TRACKING & EVENT LISTENERS
  // =========================================================================

  _markOwnPlacement(pos, ttlMs = 2500) {
    if (!pos) return;
    const now = Date.now();
    this.ownPlacements.set(posKey(pos), now + ttlMs);
    for (const [k, exp] of this.ownPlacements.entries()) {
      if (exp < now) this.ownPlacements.delete(k);
    }
  }

  _isOwnPlacement(pos) {
    if (!pos) return false;
    const key = posKey(pos);
    const exp = this.ownPlacements.get(key);
    if (!exp) return false;
    if (Date.now() > exp) {
      this.ownPlacements.delete(key);
      return false;
    }
    return true;
  }

  _handleBlockUpdate(oldBlock, newBlock) {
    if (this.burstCfg.antiExplosiveEnabled === false) return;
    if (!newBlock || !newBlock.position || !this.bot || !this.bot.entity || !this.bot.entity.position) return;

    const name = newBlock.name;
    if (name !== 'obsidian' && name !== 'respawn_anchor') return;
    if (oldBlock && oldBlock.name === name) return;
    if (this._isOwnPlacement(newBlock.position)) return;

    const radius = this.burstCfg.antiExplosiveRadius || 4.5;
    const botPos = this.bot.entity.position;
    const blockCenter = newBlock.position.offset(0.5, 0.5, 0.5);
    const dist = botPos.distanceTo(blockCenter);
    const yDiff = Math.abs(newBlock.position.y - botPos.y);

    if (dist <= radius && yDiff <= 2.5) {
      const blastOrigin = name === 'obsidian'
        ? newBlock.position.offset(0.5, 1.0, 0.5)
        : newBlock.position.offset(0.5, 0.5, 0.5);
      this._registerThreat({
        type: name,
        blockPos: newBlock.position.clone(),
        blastOrigin,
        detectedAt: Date.now()
      });
    }
  }

  _handleEntitySpawn(entity) {
    if (!isCrystalEntity(entity) || !entity.position || !this.bot || !this.bot.entity) return;

    // Immediate spawn-tick crystal registration for our own offensive crystal sequence
    if (
      this.activePlan &&
      this.activePlan.kind === 'crystal' &&
      this.activePlan.blastPos &&
      (this.state === 'CRYSTAL_DETONATE' || this.state === 'CRYSTAL_PLACE_CRYSTAL') &&
      entity.position.distanceTo(this.activePlan.blastPos) <= 2.5
    ) {
      this.activePlan.spawnedCrystal = entity;
      this.stepDelayTicks = 0;
      return;
    }

    if (this.burstCfg.antiExplosiveEnabled === false) return;

    const crystalFloor = entity.position.floored();
    if (this._isOwnPlacement(crystalFloor) || this._isOwnPlacement(crystalFloor.offset(0, -1, 0))) {
      return;
    }

    const radius = this.burstCfg.antiExplosiveRadius || 4.5;
    const dist = this.bot.entity.position.distanceTo(entity.position);
    if (dist <= radius) {
      this._registerThreat({
        type: 'end_crystal',
        entityId: entity.id,
        blockPos: crystalFloor.offset(0, -1, 0),
        blastOrigin: entity.position.clone(),
        detectedAt: Date.now()
      });
    }
  }

  _registerThreat(threat) {
    // Prioritize live crystal / respawn_anchor over raw obsidian
    const priority = (t) => {
      if (!t) return 0;
      if (t.type === 'end_crystal') return 3;
      if (t.type === 'respawn_anchor') return 2;
      return 1;
    };

    if (!this.activeThreat || priority(threat) >= priority(this.activeThreat)) {
      this.activeThreat = threat;
      if (this.defenseState === 'IDLE') {
        this.defensePlan = null;
      }
    }
  }

  // =========================================================================
  // BLAST DAMAGE ESTIMATION (DISTANCE + RAYCAST OCCLUSION + BLAST PROT + LOWER Y)
  // =========================================================================

  _getArmorItems(entity) {
    const items = [];
    if (!entity) return items;

    const isBotEntity = this.bot && this.bot.entity && (
      entity === this.bot.entity ||
      (entity.id !== undefined && entity.id === this.bot.entity.id)
    );

    if (isBotEntity && this.bot.inventory && this.bot.inventory.slots) {
      for (const slot of [5, 6, 7, 8]) {
        const piece = this.bot.inventory.slots[slot];
        if (piece && piece.name && ARMOR_STATS[piece.name]) {
          items.push(piece);
        }
      }
      if (items.length > 0) return items;
    }

    if (Array.isArray(entity.equipment)) {
      for (const piece of entity.equipment) {
        if (piece && piece.name && ARMOR_STATS[piece.name]) {
          items.push(piece);
        }
      }
    }

    return items;
  }

  _extractArmorBlastEPF(item) {
    if (!item) return 0;
    let blastProt = 0;
    let genericProt = 0;

    const inspectEntry = (nameRaw, lvlRaw) => {
      const name = String(nameRaw || '').toLowerCase();
      const lvl = Math.max(0, Math.min(5, Number(lvlRaw) || 0));
      if (!lvl) return;
      if (name.includes('blast_protection')) {
        blastProt = Math.max(blastProt, lvl);
      } else if (
        name === 'protection' ||
        name === 'minecraft:protection' ||
        (name.endsWith(':protection') && !name.includes('blast') && !name.includes('fire') && !name.includes('projectile'))
      ) {
        genericProt = Math.max(genericProt, lvl);
      }
    };

    // 1. Structured item.enchants array
    if (Array.isArray(item.enchants)) {
      for (const e of item.enchants) {
        if (e) inspectEntry(e.name || e.id, e.lvl !== undefined ? e.lvl : e.level);
      }
    }

    // 2. 1.20.5+ item.components
    if (Array.isArray(item.components)) {
      for (const comp of item.components) {
        if (!comp) continue;
        const type = String(comp.type || '').toLowerCase();
        if (type.includes('enchantment')) {
          const data = comp.data || comp.value || comp;
          const list = data && (data.enchantments || data.levels || data);
          if (Array.isArray(list)) {
            for (const e of list) {
              if (e) inspectEntry(e.name || e.id, e.lvl !== undefined ? e.lvl : e.level);
            }
          } else if (list && typeof list === 'object') {
            for (const [k, v] of Object.entries(list)) {
              inspectEntry(k, v);
            }
          }
        }
      }
    } else if (item.components && typeof item.components === 'object') {
      const enchObj = item.components.enchantments || item.components['minecraft:enchantments'];
      const levels = enchObj && (enchObj.levels || enchObj);
      if (levels && typeof levels === 'object') {
        for (const [k, v] of Object.entries(levels)) {
          inspectEntry(k, v);
        }
      }
    }

    // 3. Legacy NBT fallback via cached metadata inspection (avoiding double-counting blast_protection)
    if (blastProt === 0 && genericProt === 0 && (item.nbt || item.components)) {
      const raw = getItemMetadataText(item);
      const blastMatch = raw.match(/blast_protection[^0-9]{0,24}(\d+)/);
      if (blastMatch) {
        blastProt = Math.min(5, parseInt(blastMatch[1], 10));
      }
      const stripped = raw.replace(/blast_protection/g, '').replace(/fire_protection/g, '').replace(/projectile_protection/g, '');
      const protMatch = stripped.match(/protection[^0-9]{0,24}(\d+)/);
      if (protMatch) {
        genericProt = Math.min(5, parseInt(protMatch[1], 10));
      }
    }

    return blastProt * 2 + genericProt;
  }

  _isRayOccluded(fromPos, toPos, virtualSolidKeys = null) {
    if (!this.bot || typeof this.bot.blockAt !== 'function') return false;

    const delta = toPos.minus(fromPos);
    const length = delta.norm();
    if (length < 0.2) return false;

    const stepSize = 0.25;
    const steps = Math.floor(length / stepSize);
    const originVoxel = posKey(fromPos);
    const destVoxel = posKey(toPos);

    for (let i = 1; i < steps; i++) {
      const t = (i * stepSize) / length;
      const sample = new Vec3(
        fromPos.x + delta.x * t,
        fromPos.y + delta.y * t,
        fromPos.z + delta.z * t
      );
      const key = posKey(sample);
      if (key === originVoxel || key === destVoxel) continue;
      if (virtualSolidKeys) {
        if (typeof virtualSolidKeys === 'string' && key === virtualSolidKeys) return true;
        if (typeof virtualSolidKeys.has === 'function' && virtualSolidKeys.has(key)) return true;
      }

      const block = this.bot.blockAt(sample);
      if (block && block.boundingBox === 'block') {
        return true;
      }
    }
    return false;
  }

  /**
   * Estimates Minecraft explosion damage from `blastPos` to an entity at `entityPos`, factoring:
   * - Euclidean distance vs explosion diameter (`power * 2`)
   * - Multi-point raycast block occlusion between blast center and entity feet/torso/head
   * - Lower Y-level blast reduction (feet below blast plane take substantially less damage)
   * - Worn armor defense points, armor toughness, and Blast Protection / Protection EPF
   */
  estimateBlastDamage(blastPos, entityPos, entity = null, power = CRYSTAL_POWER, virtualSolidPos = null) {
    if (!blastPos || !entityPos) return 0;

    const doubleRadius = power * 2.0;
    const dist = blastPos.distanceTo(entityPos);
    if (dist >= doubleRadius) return 0;

    const height = (entity && entity.height) || 1.8;
    const halfW = 0.25;
    let virtualSolidKeys = null;
    if (Array.isArray(virtualSolidPos)) {
      const set = new Set();
      for (const v of virtualSolidPos) {
        if (v) set.add(posKey(v));
      }
      if (set.size > 0) virtualSolidKeys = set;
    } else if (virtualSolidPos) {
      virtualSolidKeys = posKey(virtualSolidPos);
    }

    // Sample points across feet, lower torso, upper torso, and head
    const samplePoints = [
      entityPos.offset(0, 0.1, 0),
      entityPos.offset(halfW, 0.15, 0),
      entityPos.offset(-halfW, 0.15, 0),
      entityPos.offset(0, 0.15, halfW),
      entityPos.offset(0, 0.15, -halfW),
      entityPos.offset(0, height * 0.45, 0),
      entityPos.offset(0, height * 0.72, 0),
      entityPos.offset(0, height * 0.92, 0)
    ];

    let visibleCount = 0;
    for (const pt of samplePoints) {
      if (!this._isRayOccluded(blastPos, pt, virtualSolidKeys)) {
        visibleCount++;
      }
    }

    const exposure = visibleCount / samplePoints.length;
    if (exposure <= 0) return 0;

    const impact = (1.0 - dist / doubleRadius) * exposure;
    let damage = ((impact * impact + impact) / 2.0) * 7.0 * doubleRadius + 1.0;

    // Lower Y-level comparison: feet situated below the blast origin receive strong vertical blast reduction
    const yDelta = blastPos.y - entityPos.y;
    if (yDelta > 0.25) {
      const lowerYMultiplier = clamp(1.0 - yDelta * 0.35, 0.35, 0.85);
      damage *= lowerYMultiplier;
    }

    // Apply armor defense, toughness, and Blast Protection / Protection EPF
    const armorItems = this._getArmorItems(entity);
    let armorPoints = 0;
    let armorToughness = 0;
    let totalEPF = 0;

    for (const piece of armorItems) {
      const stats = ARMOR_STATS[piece.name];
      if (stats) {
        armorPoints += stats.armor;
        armorToughness += stats.toughness;
      }
      totalEPF += this._extractArmorBlastEPF(piece);
    }

    if (armorPoints > 0) {
      const effectiveArmor = clamp(
        armorPoints - damage / (2.0 + armorToughness / 4.0),
        armorPoints / 5.0,
        20.0
      );
      damage *= 1.0 - effectiveArmor / 25.0;
    }

    if (totalEPF > 0) {
      const clampedEPF = Math.min(20, totalEPF);
      damage *= 1.0 - clampedEPF * 0.04;
    }

    return Math.max(0, damage);
  }

  // =========================================================================
  // INVENTORY & SEQUENTIAL HOTBAR HELPERS
  // =========================================================================

  _getHotbarStart() {
    return (this.bot && this.bot.inventory && this.bot.inventory.hotbarStart) || HOTBAR_START;
  }

  _getOffhandSlotIndex() {
    if (this.bot && typeof this.bot.getEquipmentDestSlot === 'function') {
      return this.bot.getEquipmentDestSlot('off-hand');
    }
    return OFFHAND_SLOT;
  }

  _getOffhandItem() {
    if (!this.bot || !this.bot.inventory || !this.bot.inventory.slots) return null;
    return this.bot.inventory.slots[this._getOffhandSlotIndex()] || null;
  }

  _findItemInHotbar(predicate) {
    if (!this.bot || !this.bot.inventory || !this.bot.inventory.slots) return null;
    const start = this._getHotbarStart();
    for (let i = 0; i < 9; i++) {
      const item = this.bot.inventory.slots[start + i];
      if (item && predicate(item)) {
        return { item, quickBarSlot: i };
      }
    }
    return null;
  }

  _findItem(nameOrList, hotbarOnly = false) {
    if (!this.bot || !this.bot.inventory) return null;
    const names = Array.isArray(nameOrList) ? nameOrList : [nameOrList];

    for (const name of names) {
      const inHotbar = this._findItemInHotbar((item) => item.name === name);
      if (inHotbar) return inHotbar;
    }

    if (hotbarOnly) return null;

    const allItems = typeof this.bot.inventory.items === 'function' ? this.bot.inventory.items() : [];
    for (const name of names) {
      const found = allItems.find((i) => i && i.name === name);
      if (found) return { item: found, quickBarSlot: -1 };
    }
    return null;
  }

  _findBestMace(hotbarOnly = false) {
    const start = this._getHotbarStart();
    if (this.combat && typeof this.combat.getHotbarSlots === 'function' && this.bot.inventory && this.bot.inventory.slots) {
      const slots = this.combat.getHotbarSlots();
      if (slots && typeof slots.breachMaceSlot === 'number' && slots.breachMaceSlot >= 0) {
        const item = this.bot.inventory.slots[start + slots.breachMaceSlot];
        if (item && item.name === 'mace') {
          return { item, quickBarSlot: slots.breachMaceSlot };
        }
      }
      if (slots && typeof slots.maceSlot === 'number' && slots.maceSlot >= 0) {
        const item = this.bot.inventory.slots[start + slots.maceSlot];
        if (item && item.name === 'mace') {
          return { item, quickBarSlot: slots.maceSlot };
        }
      }
    }

    // Prefer a mace with breach enchantment if present in hotbar
    const breachHotbar = this._findItemInHotbar((item) => item.name === 'mace' && hasItemEnchant(item, 'breach'));
    if (breachHotbar) return breachHotbar;

    return this._findItem('mace', hotbarOnly);
  }

  _findBestSword() {
    if (!this.bot || !this.bot.inventory || !this.bot.inventory.slots) return null;
    const start = this._getHotbarStart();
    if (this.combat && typeof this.combat.getHotbarSlots === 'function') {
      const slots = this.combat.getHotbarSlots();
      if (slots && typeof slots.swordSlot === 'number' && slots.swordSlot >= 0) {
        const item = this.bot.inventory.slots[start + slots.swordSlot];
        if (item && item.name.endsWith('_sword')) {
          return { item, quickBarSlot: slots.swordSlot };
        }
      }
    }
    const kbSword = this._findItemInHotbar((item) => item.name.endsWith('_sword') && hasItemEnchant(item, 'knockback'));
    if (kbSword) return kbSword;
    return this._findItem(SWORD_PRIORITY, false);
  }

  _getAnchorCharges(block) {
    if (!block) return 0;
    if (typeof block.getProperties === 'function') {
      try {
        const props = block.getProperties();
        if (props && props.charges !== undefined) {
          const val = Number(props.charges);
          if (Number.isFinite(val)) return val;
        }
      } catch (_) {}
    }
    if (block._properties && block._properties.charges !== undefined) {
      const val = Number(block._properties.charges);
      if (Number.isFinite(val)) return val;
    }
    const meta = Number(block.metadata);
    return Number.isFinite(meta) && meta > 0 ? meta : 0;
  }

  _markFailedAnchor(pos, ttlMs = 5000) {
    if (!pos) return;
    const now = Date.now();
    this.failedAnchors.set(posKey(pos), now + ttlMs);
    for (const [k, exp] of this.failedAnchors.entries()) {
      if (exp <= now) this.failedAnchors.delete(k);
    }
  }

  _isFailedAnchor(pos) {
    if (!pos) return false;
    const key = posKey(pos);
    const exp = this.failedAnchors.get(key);
    if (!exp) return false;
    if (Date.now() > exp) {
      this.failedAnchors.delete(key);
      return false;
    }
    return true;
  }

  _threatKey(threat) {
    if (!threat) return '';
    const ref = threat.blockPos || threat.blastOrigin;
    return ref ? `${threat.type}:${posKey(ref)}` : `${threat.type}`;
  }

  _markDefendedThreat(threat, ttlMs = 2500) {
    const key = this._threatKey(threat);
    if (!key) return;
    const now = Date.now();
    this.defendedThreats.set(key, now + ttlMs);
    for (const [k, exp] of this.defendedThreats.entries()) {
      if (exp <= now) this.defendedThreats.delete(k);
    }
  }

  _isDefendedThreat(threat) {
    const key = this._threatKey(threat);
    if (!key) return false;
    const exp = this.defendedThreats.get(key);
    if (!exp) return false;
    if (Date.now() > exp) {
      this.defendedThreats.delete(key);
      return false;
    }
    return true;
  }

  _findVisibleBlockFace(blockPos) {
    if (!this.bot || !this.bot.entity || typeof this.bot.blockAt !== 'function' || !blockPos) {
      return new Vec3(0, 1, 0);
    }
    const eyePos = this.aimer ? this.aimer.getEyePosition() : this.bot.entity.position.offset(0, 1.62, 0);
    const center = blockPos.offset(0.5, 0.5, 0.5);
    const toEye = eyePos.minus(center);

    const above = this.bot.blockAt(blockPos.offset(0, 1, 0));
    if (isAirLike(above) && eyePos.y > blockPos.y + 0.5) {
      return new Vec3(0, 1, 0);
    }

    const candidates = [
      new Vec3(0, 1, 0),
      new Vec3(1, 0, 0),
      new Vec3(-1, 0, 0),
      new Vec3(0, 0, 1),
      new Vec3(0, 0, -1),
      new Vec3(0, -1, 0)
    ];

    let bestFace = null;
    let bestDot = -Infinity;
    for (const face of candidates) {
      const neighbor = this.bot.blockAt(blockPos.plus(face));
      if (!isAirLike(neighbor)) continue;
      const dot = face.x * toEye.x + face.y * toEye.y + face.z * toEye.z;
      if (dot > bestDot) {
        bestDot = dot;
        bestFace = face;
      }
    }
    return bestFace || new Vec3(0, 1, 0);
  }

  /**
   * Mandatory non-glowstone hotbar swap selector:
   * Strictly prioritizes non-placeable slots (Totem -> Sword -> Axe -> Empty) before blocks.
   */
  _findNonGlowstoneHotbarSlot() {
    if (!this.bot || !this.bot.inventory || !this.bot.inventory.slots) return -1;
    const start = this._getHotbarStart();

    // 1. Totem of Undying in hotbar (non-placeable)
    for (let i = 0; i < 9; i++) {
      const item = this.bot.inventory.slots[start + i];
      if (item && item.name === 'totem_of_undying') return i;
    }

    // 2. Sword slot (combat-tracked or any hotbar sword)
    if (this.combat && typeof this.combat.getHotbarSlots === 'function') {
      const slots = this.combat.getHotbarSlots();
      if (slots && typeof slots.swordSlot === 'number' && slots.swordSlot >= 0) {
        const item = this.bot.inventory.slots[start + slots.swordSlot];
        if (!item || (item.name !== 'glowstone' && item.name !== 'respawn_anchor')) {
          return slots.swordSlot;
        }
      }
    }
    for (let i = 0; i < 9; i++) {
      const item = this.bot.inventory.slots[start + i];
      if (item && item.name.endsWith('_sword')) return i;
    }

    // 3. Axe in hotbar (non-placeable)
    for (let i = 0; i < 9; i++) {
      const item = this.bot.inventory.slots[start + i];
      if (item && item.name.endsWith('_axe')) return i;
    }

    // 4. Empty hotbar slot (non-placeable)
    for (let i = 0; i < 9; i++) {
      const item = this.bot.inventory.slots[start + i];
      if (!item) return i;
    }

    // 5. Obsidian or any other non-glowstone, non-anchor hotbar slot
    for (let i = 0; i < 9; i++) {
      const item = this.bot.inventory.slots[start + i];
      if (item && item.name === 'obsidian') return i;
    }
    for (let i = 0; i < 9; i++) {
      const item = this.bot.inventory.slots[start + i];
      if (!item || (item.name !== 'glowstone' && item.name !== 'respawn_anchor')) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Ensures an item is held in main hand sequentially across ticks.
   * Returns { held: boolean, swappedThisTick: boolean, found: boolean }.
   * Never performs swap + action in the same tick.
   */
  _ensureItemHeld(foundRecord) {
    if (!foundRecord || !foundRecord.item) {
      return { held: false, swappedThisTick: false, found: false };
    }

    const current = this.bot.heldItem;
    if (
      current &&
      current.name === foundRecord.item.name &&
      (foundRecord.quickBarSlot < 0 || this.bot.quickBarSlot === foundRecord.quickBarSlot)
    ) {
      return { held: true, swappedThisTick: false, found: true };
    }

    if (foundRecord.quickBarSlot >= 0 && typeof this.bot.setQuickBarSlot === 'function') {
      this.bot.setQuickBarSlot(foundRecord.quickBarSlot);
      return { held: false, swappedThisTick: true, found: true };
    }

    if (!this.equipBusy && typeof this.bot.equip === 'function') {
      this.equipBusy = true;
      Promise.resolve(this.bot.equip(foundRecord.item, 'hand'))
        .catch(() => {})
        .finally(() => {
          this.equipBusy = false;
        });
      return { held: false, swappedThisTick: true, found: true };
    }

    return { held: false, swappedThisTick: true, found: true };
  }

  _findPlacementRef(airPos) {
    if (!this.bot || typeof this.bot.blockAt !== 'function') return null;
    for (const candidate of PLACEMENT_FACES) {
      const refPos = airPos.plus(candidate.offset);
      const refBlock = this.bot.blockAt(refPos);
      if (refBlock && refBlock.boundingBox === 'block') {
        const aimPos = refPos.offset(
          0.5 + candidate.face.x * 0.5,
          0.5 + candidate.face.y * 0.5,
          0.5 + candidate.face.z * 0.5
        );
        return { refPos, refBlock, face: candidate.face, aimPos };
      }
    }
    return null;
  }

  _intersectsEntityHitbox(blockPos, entityPos, height = 1.8) {
    if (!blockPos || !entityPos) return false;
    const minX = entityPos.x - 0.35;
    const maxX = entityPos.x + 0.35;
    const minY = entityPos.y;
    const maxY = entityPos.y + height;
    const minZ = entityPos.z - 0.35;
    const maxZ = entityPos.z + 0.35;

    return (
      blockPos.x < maxX && (blockPos.x + 1) > minX &&
      blockPos.y < maxY && (blockPos.y + 1) > minY &&
      blockPos.z < maxZ && (blockPos.z + 1) > minZ
    );
  }

  _getPredictedTargetFeet(target, leadTicks = 3) {
    if (!target || !target.position) return new Vec3(0, 0, 0);
    if (this.prediction && typeof this.prediction.predictPosition === 'function') {
      const pred = this.prediction.predictPosition(target, leadTicks);
      if (pred && pred.position) return pred.position.clone();
      if (pred && typeof pred.x === 'number') return pred.clone();
    }
    return target.position.clone();
  }

  _getReachDistanceToEntity(entity) {
    if (!this.bot || !this.bot.entity || !entity || !entity.position) return Infinity;
    const eye = this.aimer ? this.aimer.getEyePosition() : this.bot.entity.position.offset(0, 1.62, 0);
    const halfW = 0.3;
    const height = entity.height || 1.8;
    const cx = clamp(eye.x, entity.position.x - halfW, entity.position.x + halfW);
    const cy = clamp(eye.y, entity.position.y, entity.position.y + height);
    const cz = clamp(eye.z, entity.position.z - halfW, entity.position.z + halfW);
    return eye.distanceTo(new Vec3(cx, cy, cz));
  }

  _updateFallDistance() {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) return;
    const pos = this.bot.entity.position;
    const feetBlock = typeof this.bot.blockAt === 'function' ? this.bot.blockAt(pos) : null;
    const inLiquidOrWeb = feetBlock && (
      feetBlock.name === 'water' ||
      feetBlock.name === 'flowing_water' ||
      feetBlock.name === 'lava' ||
      feetBlock.name === 'flowing_lava' ||
      feetBlock.name === 'cobweb'
    );

    if (this.bot.entity.onGround || inLiquidOrWeb) {
      this.fallDistance = 0;
    } else if (this.lastBotY !== null && pos.y < this.lastBotY) {
      this.fallDistance += (this.lastBotY - pos.y);
    }
    this.lastBotY = pos.y;
  }

  _getHeightAboveGround(maxScan = 16) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) return 0;
    if (this.bot.entity.onGround) return 0;
    if (typeof this.bot.blockAt !== 'function') return maxScan;

    const pos = this.bot.entity.position;
    const startY = Math.floor(pos.y);
    for (let dy = 1; dy <= maxScan; dy++) {
      const b = this.bot.blockAt(new Vec3(Math.floor(pos.x), startY - dy, Math.floor(pos.z)));
      if (b && b.boundingBox === 'block') {
        return Math.max(0, pos.y - (startY - dy + 1));
      }
    }
    return maxScan;
  }

  // =========================================================================
  // 2. ANTI-CRYSTAL / ANTI-ANCHOR DEFENSE (`tickDefense`)
  // =========================================================================

  _scanNearbyExplosiveThreats(target) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) return null;
    const botPos = this.bot.entity.position;
    const radius = this.burstCfg.antiExplosiveRadius || 4.5;

    // 1. Live End Crystal entities near bot's feet
    if (this.bot.entities) {
      let closestCrystal = null;
      let closestDist = Infinity;
      for (const entity of Object.values(this.bot.entities)) {
        if (!isCrystalEntity(entity) || !entity.position) continue;
        const cFloor = entity.position.floored();
        if (this._isOwnPlacement(cFloor) || this._isOwnPlacement(cFloor.offset(0, -1, 0))) continue;
        const d = botPos.distanceTo(entity.position);
        if (d <= radius && d < closestDist) {
          closestDist = d;
          closestCrystal = entity;
        }
      }
      if (closestCrystal) {
        return {
          type: 'end_crystal',
          entityId: closestCrystal.id,
          blockPos: closestCrystal.position.floored().offset(0, -1, 0),
          blastOrigin: closestCrystal.position.clone(),
          detectedAt: Date.now()
        };
      }
    }

    // 2. Nearby Respawn Anchors (and enemy-held crystal obsidian traps)
    if (typeof this.bot.blockAt === 'function') {
      const bx = Math.floor(botPos.x);
      const by = Math.floor(botPos.y);
      const bz = Math.floor(botPos.z);
      const rInt = Math.ceil(radius);

      const targetHoldingCrystal = Boolean(
        target &&
        target.isValid &&
        Array.isArray(target.equipment) &&
        target.equipment.some((eq) => eq && eq.name === 'end_crystal')
      );
      const targetHoldingGlowstone = Boolean(
        target &&
        target.isValid &&
        Array.isArray(target.equipment) &&
        target.equipment.some((eq) => eq && eq.name === 'glowstone')
      );

      let anchorThreat = null;
      let anchorDist = Infinity;
      let obsThreat = null;
      let obsDist = Infinity;

      for (let dx = -rInt; dx <= rInt; dx++) {
        for (let dy = -1; dy <= 2; dy++) {
          for (let dz = -rInt; dz <= rInt; dz++) {
            const pos = new Vec3(bx + dx, by + dy, bz + dz);
            const center = pos.offset(0.5, 0.5, 0.5);
            const dist = botPos.distanceTo(center);
            if (dist > radius) continue;
            if (this._isOwnPlacement(pos)) continue;

            const block = this.bot.blockAt(pos);
            if (!block) continue;

            if (block.name === 'respawn_anchor' && dist < anchorDist) {
              const charges = this._getAnchorCharges(block);
              // Ignore uncharged abandoned anchors unless opponent is actively holding glowstone
              if (charges < 1 && !targetHoldingGlowstone) continue;
              const cand = {
                type: 'respawn_anchor',
                blockPos: pos,
                blastOrigin: center,
                detectedAt: Date.now()
              };
              if (this._isDefendedThreat(cand)) continue;
              anchorDist = dist;
              anchorThreat = cand;
            } else if (targetHoldingCrystal && block.name === 'obsidian' && dist < obsDist) {
              const above = this.bot.blockAt(pos.offset(0, 1, 0));
              if (isAirLike(above)) {
                const cand = {
                  type: 'obsidian',
                  blockPos: pos,
                  blastOrigin: pos.offset(0.5, 1.0, 0.5),
                  detectedAt: Date.now()
                };
                if (this._isDefendedThreat(cand)) continue;
                obsDist = dist;
                obsThreat = cand;
              }
            }
          }
        }
      }

      if (anchorThreat) return anchorThreat;
      if (obsThreat) return obsThreat;
    }

    return null;
  }

  _isThreatStillValid(threat) {
    if (!threat || !this.bot || !this.bot.entity) return false;
    const radius = (this.burstCfg.antiExplosiveRadius || 4.5) + 0.75;
    if (this.bot.entity.position.distanceTo(threat.blastOrigin) > radius) return false;
    if ((Date.now() - threat.detectedAt) > 1500) return false;

    if (threat.type === 'end_crystal') {
      if (this.bot.entities && threat.entityId !== undefined) {
        const ent = this.bot.entities[threat.entityId];
        return Boolean(ent && ent.isValid);
      }
      return true;
    }

    if (typeof this.bot.blockAt === 'function' && threat.blockPos) {
      const b = this.bot.blockAt(threat.blockPos);
      if (!b || b.name !== threat.type) return false;
      if (threat.type === 'obsidian') {
        const above = this.bot.blockAt(threat.blockPos.offset(0, 1, 0));
        if (above && !isAirLike(above)) return false;
      }
    }
    return true;
  }

  _planDefensiveBlock(threat) {
    if (!threat || !this.bot || !this.bot.entity || typeof this.bot.blockAt !== 'function') return null;

    const blockRecord = this._findItem(DEFENSE_BLOCK_PRIORITY);
    if (!blockRecord) return null;

    const botPos = this.bot.entity.position;
    const eyePos = this.aimer ? this.aimer.getEyePosition() : botPos.offset(0, 1.62, 0);
    const toBlast = threat.blastOrigin.minus(botPos);
    const horizLen = Math.sqrt(toBlast.x * toBlast.x + toBlast.z * toBlast.z);

    const candidatePositions = [];

    // 1. Place blocking block directly between bot's feet and explosive origin
    if (horizLen >= 0.8) {
      const stepDist = Math.min(1.2, horizLen * 0.5);
      const midPos = new Vec3(
        Math.floor(botPos.x + (toBlast.x / horizLen) * stepDist),
        Math.floor(botPos.y),
        Math.floor(botPos.z + (toBlast.z / horizLen) * stepDist)
      );
      candidatePositions.push(midPos);
    }

    // 2. If threat is enemy obsidian (no crystal yet), block directly on top of the obsidian
    if (threat.type === 'obsidian' && threat.blockPos) {
      candidatePositions.push(threat.blockPos.offset(0, 1, 0));
    }

    for (const spot of candidatePositions) {
      if (eyePos.distanceTo(spot.offset(0.5, 0.5, 0.5)) > 4.5) continue;
      if (this._intersectsEntityHitbox(spot, botPos)) continue;
      const existing = this.bot.blockAt(spot);
      if (!isAirLike(existing)) continue;

      const ref = this._findPlacementRef(spot);
      if (ref) {
        return {
          blockRecord,
          placePos: spot,
          refPos: ref.refPos,
          face: ref.face,
          aimPos: ref.aimPos
        };
      }
    }

    return null;
  }

  /**
   * High-priority anti-crystal / anti-anchor defense tick.
   * Returns true if BurstModule is actively taking defensive action against an explosive threat.
   */
  tickDefense(target) {
    this._updateFallDistance();

    if (this.burstCfg.antiExplosiveEnabled === false || !this.bot || !this.bot.entity) {
      this._clearDefenseState();
      return false;
    }

    // Scan for live threats and merge with event-detected threats
    const scanned = this._scanNearbyExplosiveThreats(target);
    if (scanned) {
      this._registerThreat(scanned);
    }

    if (this.activeThreat && (this._isDefendedThreat(this.activeThreat) || !this._isThreatStillValid(this.activeThreat))) {
      this._clearDefenseState();
      return false;
    }

    if (!this.activeThreat) {
      this._clearDefenseState();
      return false;
    }

    // Do not interrupt our own active ANCHOR_* detonation sequence for non-crystal threats
    if (this.state.startsWith('ANCHOR_') && this.activeThreat.type !== 'end_crystal') {
      return false;
    }

    // High-priority defense preempts offensive bursts (but preserves lethal fall clutch)
    if (this.state !== 'IDLE' && this.state !== 'WIND_CLUTCH') {
      this._resetOffensiveState(false);
    }

    const threat = this.activeThreat;

    // Initialize defense plan if IDLE
    if (this.defenseState === 'IDLE') {
      const blockPlan = this._planDefensiveBlock(threat);
      if (blockPlan) {
        this.defenseState = 'DEFENSE_BLOCK';
        this.defensePlan = blockPlan;
        this.defenseTicksRemaining = 10;
      } else {
        this.defenseState = 'DEFENSE_SHIELD';
        this.defensePlan = null;
        this.defenseTicksRemaining = 6;
      }
    }

    this.defenseTicksRemaining--;
    if (this.defenseTicksRemaining < 0) {
      this._markDefendedThreat(threat, 2500);
      this._clearDefenseState();
      return false;
    }

    if (this.defenseState === 'DEFENSE_BLOCK' && this.defensePlan) {
      const plan = this.defensePlan;
      this.bot.setControlState('sprint', false);

      // Step 1: Smoothly aim at placement face & ensure blocking block is held (sequential across ticks)
      const aimStatus = this.aimer.stepTowardsPoint(plan.aimPos, {
        speedMultiplier: 1.4,
        toleranceRad: 0.18
      });

      const equipRes = this._ensureItemHeld(plan.blockRecord);
      if (!equipRes.found) {
        // Block ran out; fall back to crouch-shield
        this.defenseState = 'DEFENSE_SHIELD';
        this.defensePlan = null;
        return this._tickDefenseShield(threat);
      }

      // Anticheat safety: never swap + place in the same tick
      if (equipRes.swappedThisTick || !equipRes.held || !aimStatus.aligned) {
        return true;
      }

      const refBlock = this.bot.blockAt(plan.refPos);
      const targetAir = this.bot.blockAt(plan.placePos);
      if (refBlock && refBlock.boundingBox === 'block' && isAirLike(targetAir)) {
        this._markOwnPlacement(plan.placePos);
        if (typeof this.bot.placeBlock === 'function') {
          Promise.resolve(this.bot.placeBlock(refBlock, plan.face)).catch(() => {});
        }
      }

      // If threat was a live crystal or respawn anchor, follow up with brief crouch-shield
      if (threat.type === 'end_crystal' || threat.type === 'respawn_anchor') {
        this.defenseState = 'DEFENSE_SHIELD';
        this.defensePlan = null;
        this.defenseTicksRemaining = 5;
      } else {
        this._markDefendedThreat(threat, 2500);
        this._clearDefenseState();
      }
      return true;
    }

    return this._tickDefenseShield(threat);
  }

  _tickDefenseShield(threat) {
    this.bot.setControlState('sprint', false);
    this.bot.setControlState('sneak', true);

    this.aimer.stepTowardsPoint(threat.blastOrigin, {
      speedMultiplier: 1.4,
      toleranceRad: 0.16
    });

    const offhand = this._getOffhandItem();
    const hasShield = (offhand && offhand.name === 'shield') ||
      (this.bot.heldItem && this.bot.heldItem.name === 'shield');

    if (hasShield && !this.defenseShieldRaised && typeof this.bot.activateItem === 'function') {
      const useOffhand = Boolean(offhand && offhand.name === 'shield');
      this.bot.activateItem(useOffhand);
      this.defenseShieldRaised = true;
    }

    if (this.defenseTicksRemaining <= 0) {
      this._markDefendedThreat(threat, 2500);
      this._clearDefenseState();
    }
    return true;
  }

  // =========================================================================
  // 1. END CRYSTAL & RESPAWN ANCHOR SCANNING AND SEQUENTIAL EXECUTION
  // =========================================================================

  _canUseRespawnAnchor() {
    if (this.burstCfg.anchorEnabled === false) return false;
    if (!this.bot || !this.bot.game || !this.bot.game.dimension) return false;
    const dim = String(this.bot.game.dimension).toLowerCase();
    return !dim.includes('nether');
  }

  _findOptionalCoverSpot(blastPos) {
    if (!this.bot || !this.bot.entity || typeof this.bot.blockAt !== 'function') return null;
    const botPos = this.bot.entity.position;
    // Only need a cover block if bot is NOT at lower Y than blast
    if (botPos.y < blastPos.y - 0.25) return null;

    const coverRecord = this._findItem(COVER_BLOCK_PRIORITY);
    if (!coverRecord) return null;

    const toBlast = blastPos.minus(botPos);
    const horizLen = Math.sqrt(toBlast.x * toBlast.x + toBlast.z * toBlast.z);
    if (horizLen < 1.2) return null;

    const coverPos = new Vec3(
      Math.floor(botPos.x + (toBlast.x / horizLen) * 1.0),
      Math.floor(botPos.y),
      Math.floor(botPos.z + (toBlast.z / horizLen) * 1.0)
    );

    if (this._intersectsEntityHitbox(coverPos, botPos)) return null;
    if (!isAirLike(this.bot.blockAt(coverPos))) return null;

    const eyePos = this.aimer ? this.aimer.getEyePosition() : botPos.offset(0, 1.62, 0);
    if (eyePos.distanceTo(coverPos.offset(0.5, 0.5, 0.5)) > 4.5) return null;

    const ref = this._findPlacementRef(coverPos);
    if (!ref) return null;

    return {
      blockRecord: coverRecord,
      placePos: coverPos,
      refPos: ref.refPos,
      face: ref.face,
      aimPos: ref.aimPos
    };
  }

  /**
   * Scans nearby End Crystal entities for an immediate advantageous detonation (CPvP instant pop).
   */
  _findExistingPoppableCrystal(target, predictedFeet) {
    if (!this.bot || !this.bot.entities || !this.bot.entity) return null;
    const botPos = this.bot.entity.position;
    const eyePos = this.aimer ? this.aimer.getEyePosition() : botPos.offset(0, 1.62, 0);
    const minSafeHp = 6;
    let bestPlan = null;
    let bestScore = 0;

    for (const entity of Object.values(this.bot.entities)) {
      if (!isCrystalEntity(entity) || !entity.position) continue;
      if (eyePos.distanceTo(entity.position.offset(0, 0.5, 0)) > 4.6) continue;
      if (entity.position.distanceTo(predictedFeet) > 5.5) continue;

      const targetDmg = this.estimateBlastDamage(entity.position, predictedFeet, target, CRYSTAL_POWER);
      const rawSelfDmg = this.estimateBlastDamage(entity.position, botPos, this.bot.entity, CRYSTAL_POWER);
      const feetShield = findFeetBlastShieldSpot(this, entity.position, null);
      const coverSpot = feetShield.spot;
      const effectiveSelfDmg = coverSpot
        ? this.estimateBlastDamage(entity.position, botPos, this.bot.entity, CRYSTAL_POWER, coverSpot.placePos)
        : rawSelfDmg;

      if (targetDmg < 4.0) continue;
      if (targetDmg <= effectiveSelfDmg) continue;
      if ((this.bot.health - effectiveSelfDmg) <= minSafeHp) continue;

      const score = targetDmg - effectiveSelfDmg * 1.25;
      if (score > bestScore) {
        bestScore = score;
        bestPlan = { entity, coverSpot };
      }
    }
    return bestPlan;
  }

  _findBestCrystalPlacement(target, predictedFeet) {
    if (this.burstCfg.crystalEnabled === false) return null;
    const now = Date.now();
    if ((now - this.lastCrystalTime) < (this.burstCfg.crystalCooldownMs || 100)) return null;

    const crystalItem = this._findItem('end_crystal');
    if (!crystalItem) return null;
    if (!this.bot || typeof this.bot.blockAt !== 'function') return null;

    const botPos = this.bot.entity.position;
    const maxCrystalRange = this.burstCfg.crystalMaxRange || 4.5;
    if (botPos.distanceTo(target.position) > maxCrystalRange) return null;

    const obsidianItem = this._findItem('obsidian');
    const scanRadius = this.burstCfg.scanRadius || 4.5;
    const rInt = Math.ceil(scanRadius);
    const eyePos = this.aimer ? this.aimer.getEyePosition() : botPos.offset(0, 1.62, 0);
    const minSafeHp = 6;

    const cx = Math.floor(predictedFeet.x);
    const cy = Math.floor(predictedFeet.y);
    const cz = Math.floor(predictedFeet.z);

    let best = null;

    for (let dx = -rInt; dx <= rInt; dx++) {
      for (let dy = -2; dy <= 1; dy++) {
        for (let dz = -rInt; dz <= rInt; dz++) {
          const basePos = new Vec3(cx + dx, cy + dy, cz + dz);
          const blastPos = basePos.offset(0.5, 1.0, 0.5);

          if (blastPos.distanceTo(predictedFeet) > scanRadius) continue;
          if (eyePos.distanceTo(basePos.offset(0.5, 0.8, 0.5)) > 4.5) continue;

          const baseBlock = this.bot.blockAt(basePos);
          const crystalSpace = basePos.offset(0, 1, 0);
          const aboveBlock = this.bot.blockAt(crystalSpace);
          if (!baseBlock || !isAirLike(aboveBlock)) continue;
          if (hasExistingCrystalAt(this.bot, crystalSpace)) continue;

          // Ensure crystal space does not collide with target or bot
          if (this._intersectsEntityHitbox(crystalSpace, botPos)) continue;
          if (this._intersectsEntityHitbox(crystalSpace, target.position, target.height || 1.8)) continue;

          let needsObsidian = false;
          let obsidianRef = null;

          if (baseBlock.name === 'obsidian' || baseBlock.name === 'bedrock') {
            needsObsidian = false;
          } else if (isAirLike(baseBlock) && obsidianItem) {
            if (this._intersectsEntityHitbox(basePos, botPos)) continue;
            if (this._intersectsEntityHitbox(basePos, target.position, target.height || 1.8)) continue;
            obsidianRef = this._findPlacementRef(basePos);
            if (!obsidianRef) continue;
            needsObsidian = true;
          } else {
            continue;
          }

          const targetDmg = this.estimateBlastDamage(blastPos, predictedFeet, target, CRYSTAL_POWER);
          if (targetDmg < 4.0) continue;

          const rawSelfDmg = this.estimateBlastDamage(
            blastPos,
            botPos,
            this.bot.entity,
            CRYSTAL_POWER,
            needsObsidian ? basePos : null
          );
          const feetShield = findFeetBlastShieldSpot(this, blastPos, basePos);
          const coverSpot = feetShield.spot;
          if (feetShield.needed && !coverSpot && rawSelfDmg > 4.0) continue;

          const effectiveSelfDmg = coverSpot
            ? this.estimateBlastDamage(
                blastPos,
                botPos,
                this.bot.entity,
                CRYSTAL_POWER,
                [coverSpot.placePos, needsObsidian ? basePos : null]
              )
            : rawSelfDmg;

          if (targetDmg <= effectiveSelfDmg) continue;
          if ((this.bot.health - effectiveSelfDmg) <= minSafeHp) continue;

          const score = targetDmg - effectiveSelfDmg * 1.35 - (needsObsidian ? 1.0 : 0);
          if (!best || score > best.score) {
            best = {
              kind: 'crystal',
              score,
              targetDmg,
              selfDmg: effectiveSelfDmg,
              basePos,
              blastPos,
              needsObsidian,
              obsidianRef,
              coverSpot
            };
          }
        }
      }
    }

    return best;
  }

  _findBestAnchorPlacement(target, predictedFeet) {
    if (!this._canUseRespawnAnchor()) return null;
    const now = Date.now();
    if ((now - this.lastAnchorTime) < (this.burstCfg.anchorCooldownMs || 250)) return null;

    const anchorItem = this._findItem('respawn_anchor');
    const glowstoneItem = this._findItem('glowstone');
    if (!anchorItem || !glowstoneItem) return null;
    if (!this.bot || typeof this.bot.blockAt !== 'function') return null;

    const botPos = this.bot.entity.position;
    const maxAnchorRange = this.burstCfg.anchorMaxRange || 3.6;
    if (botPos.distanceTo(target.position) > maxAnchorRange) return null;

    const scanRadius = this.burstCfg.scanRadius || 4.5;
    const rInt = Math.ceil(scanRadius);
    const eyePos = this.aimer ? this.aimer.getEyePosition() : botPos.offset(0, 1.62, 0);
    const minSafeHp = 6;

    const cx = Math.floor(predictedFeet.x);
    const cy = Math.floor(predictedFeet.y);
    const cz = Math.floor(predictedFeet.z);

    let best = null;

    for (let dx = -rInt; dx <= rInt; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -rInt; dz <= rInt; dz++) {
          const anchorPos = new Vec3(cx + dx, cy + dy, cz + dz);
          const blastPos = anchorPos.offset(0.5, 0.5, 0.5);

          if (blastPos.distanceTo(predictedFeet) > scanRadius) continue;
          if (eyePos.distanceTo(blastPos) > 4.5) continue;
          if (this._isFailedAnchor(anchorPos)) continue;

          const existing = this.bot.blockAt(anchorPos);
          if (!existing) continue;

          let needsPlace = false;
          let anchorRef = null;
          let alreadyCharged = false;

          if (existing.name === 'respawn_anchor') {
            needsPlace = false;
            alreadyCharged = this._getAnchorCharges(existing) >= 1;
          } else if (isAirLike(existing)) {
            if (this._intersectsEntityHitbox(anchorPos, botPos)) continue;
            if (this._intersectsEntityHitbox(anchorPos, target.position, target.height || 1.8)) continue;
            anchorRef = this._findPlacementRef(anchorPos);
            if (!anchorRef) continue;
            needsPlace = true;
          } else {
            continue;
          }

          const targetDmg = this.estimateBlastDamage(blastPos, predictedFeet, target, ANCHOR_POWER);
          if (targetDmg < 4.0) continue;

          const rawSelfDmg = this.estimateBlastDamage(blastPos, botPos, this.bot.entity, ANCHOR_POWER);
          const feetShield = findFeetBlastShieldSpot(this, blastPos, anchorPos);
          const coverSpot = feetShield.spot;
          if (feetShield.needed && !coverSpot && rawSelfDmg > 4.0) continue;

          const effectiveSelfDmg = coverSpot
            ? this.estimateBlastDamage(blastPos, botPos, this.bot.entity, ANCHOR_POWER, coverSpot.placePos)
            : rawSelfDmg;

          if (targetDmg <= effectiveSelfDmg) continue;
          if ((this.bot.health - effectiveSelfDmg) <= minSafeHp) continue;

          const score = targetDmg - effectiveSelfDmg * 1.35 - (needsPlace ? 0.5 : 0);
          if (!best || score > best.score) {
            best = {
              kind: 'anchor',
              score,
              targetDmg,
              selfDmg: effectiveSelfDmg,
              anchorPos,
              blastPos,
              needsPlace,
              alreadyCharged,
              anchorRef,
              coverSpot
            };
          }
        }
      }
    }

    return best;
  }

  _canStartHitCrystal(target) {
    if (this.burstCfg.hitCrystalEnabled === false || this.burstCfg.crystalEnabled === false) return false;
    if (!target || !target.isValid || !this.bot || !this.bot.entity) return false;

    const now = Date.now();
    if ((now - this.lastCrystalTime) < (this.burstCfg.crystalCooldownMs || 100)) return false;
    if ((now - this.lastHitCrystalTime) < (this.burstCfg.hitCrystalCooldownMs || 350)) return false;

    if (!this._findItem('end_crystal')) return false;
    if (!this._findBestSword()) return false;

    const maxHitRange = this.burstCfg.hitCrystalMaxRange || 3.2;
    const reachDist = this._getReachDistanceToEntity(target);
    if (reachDist > maxHitRange) return false;

    // Only initiate hit-launch when opponent is grounded/low so sprint-knockback launches them upward
    if (target.onGround === false && target.velocity && target.velocity.y > 0.15) return false;

    return Boolean(planHitCrystalTrajectory(this, target));
  }

  _findCrystalEntityNear(pos, maxDist = 2.2) {
    if (!this.bot || !this.bot.entities || !pos) return null;
    let closest = null;
    let closestDist = maxDist;
    for (const entity of Object.values(this.bot.entities)) {
      if (!isCrystalEntity(entity) || !entity.position) continue;
      const d = entity.position.distanceTo(pos);
      if (d < closestDist) {
        closestDist = d;
        closest = entity;
      }
    }
    return closest;
  }

  _tickCrystalState(target) {
    const plan = this.activePlan;
    if (!plan) {
      this._resetOffensiveState(true);
      return false;
    }

    this.stateTicks++;
    if (this.stateTicks > 35) {
      this._resetOffensiveState(true);
      return false;
    }

    // Step 0 (Hit-Crystal): Sprint-knockback melee hit -> trajectory Obsidian -> End Crystal -> Spawn-Tick Detonate
    if (this.state === 'CRYSTAL_HIT_LAUNCH') {
      if (!target || !target.isValid || this.stateTicks > 10) {
        this._resetOffensiveState(true);
        return false;
      }

      const maxHitRange = this.burstCfg.hitCrystalMaxRange || 3.2;
      const reachDist = this._getReachDistanceToEntity(target);
      if (reachDist > maxHitRange + 0.35) {
        this._resetOffensiveState(true);
        return false;
      }

      const swordRecord = this._findBestSword();
      if (!swordRecord) {
        this._resetOffensiveState(true);
        return false;
      }

      const torsoPos = target.position.offset(0, (target.height || 1.8) * 0.65, 0);
      const aimStatus = this.aimer.stepTowardsPoint(torsoPos, { speedMultiplier: 1.5, toleranceRad: 0.2 });
      const equipRes = this._ensureItemHeld(swordRecord);

      if (typeof this.bot.setControlState === 'function') {
        this.bot.setControlState('forward', true);
        this.bot.setControlState('sprint', this.bot.food > 6);
      }

      if (this.stepDelayTicks > 0 || equipRes.swappedThisTick || !equipRes.held || !aimStatus.aligned || reachDist > maxHitRange) {
        return true;
      }

      if (typeof this.bot.attack === 'function') {
        this.bot.attack(target);
      }
      this.lastHitCrystalTime = Date.now();
      if (typeof this.bot.setControlState === 'function') {
        this.bot.setControlState('sprint', false);
        this.bot.setControlState('forward', false);
      }

      const trajPlan = planHitCrystalTrajectory(this, target) ||
        this._findBestCrystalPlacement(target, this._getPredictedTargetFeet(target, 2));
      if (!trajPlan) {
        this._resetOffensiveState(true);
        return false;
      }

      this.activePlan = trajPlan;
      this.stepDelayTicks = 1;
      if (trajPlan.coverSpot) {
        this.state = 'CRYSTAL_COVER';
      } else if (trajPlan.needsObsidian) {
        this.state = 'CRYSTAL_PLACE_OBSIDIAN';
      } else {
        this.state = 'CRYSTAL_PLACE_CRYSTAL';
      }
      return true;
    }

    this.bot.setControlState('sprint', false);

    // Optional Feet Blast-Shield Cover Placement before crystal
    if (this.state === 'CRYSTAL_COVER') {
      const cover = plan.coverSpot;
      const nextState = plan.detonateOnly
        ? 'CRYSTAL_DETONATE'
        : (plan.needsObsidian ? 'CRYSTAL_PLACE_OBSIDIAN' : 'CRYSTAL_PLACE_CRYSTAL');
      if (!cover) {
        this.state = nextState;
        return true;
      }
      const aimStatus = this.aimer.stepTowardsPoint(cover.aimPos, { speedMultiplier: 1.35, toleranceRad: 0.16 });
      const equipRes = this._ensureItemHeld(cover.blockRecord);
      if (!equipRes.found) {
        this.state = nextState;
        return true;
      }
      if (this.stepDelayTicks > 0 || equipRes.swappedThisTick || !equipRes.held || !aimStatus.aligned) {
        return true;
      }

      const refBlock = this.bot.blockAt(cover.refPos);
      if (refBlock && refBlock.boundingBox === 'block' && isAirLike(this.bot.blockAt(cover.placePos))) {
        this._markOwnPlacement(cover.placePos);
        if (typeof this.bot.placeBlock === 'function') {
          Promise.resolve(this.bot.placeBlock(refBlock, cover.face)).catch(() => {});
        }
      }
      this.stepDelayTicks = this.placeDelayTicks;
      this.state = nextState;
      return true;
    }

    // Step 1: Place Obsidian if needed
    if (this.state === 'CRYSTAL_PLACE_OBSIDIAN') {
      const existingBase = this.bot.blockAt(plan.basePos);
      if (existingBase && (existingBase.name === 'obsidian' || existingBase.name === 'bedrock')) {
        this.state = 'CRYSTAL_PLACE_CRYSTAL';
        return true;
      }

      const obsItem = this._findItem('obsidian');
      if (!obsItem || !plan.obsidianRef) {
        this._resetOffensiveState(true);
        return false;
      }

      const aimStatus = this.aimer.stepTowardsPoint(plan.obsidianRef.aimPos, {
        speedMultiplier: 1.35,
        toleranceRad: 0.16
      });
      const equipRes = this._ensureItemHeld(obsItem);
      if (this.stepDelayTicks > 0 || equipRes.swappedThisTick || !equipRes.held || !aimStatus.aligned) {
        return true;
      }

      const refBlock = this.bot.blockAt(plan.obsidianRef.refPos);
      if (!refBlock || refBlock.boundingBox !== 'block') {
        this._resetOffensiveState(true);
        return false;
      }

      this._markOwnPlacement(plan.basePos);
      if (typeof this.bot.placeBlock === 'function') {
        Promise.resolve(this.bot.placeBlock(refBlock, plan.obsidianRef.face)).catch(() => {});
      }

      this.stepDelayTicks = this.placeDelayTicks;
      this.state = 'CRYSTAL_PLACE_CRYSTAL';
      return true;
    }

    // Step 2: Place End Crystal on top of Obsidian / Bedrock
    if (this.state === 'CRYSTAL_PLACE_CRYSTAL') {
      const baseBlock = this.bot.blockAt(plan.basePos);
      if (!baseBlock || (baseBlock.name !== 'obsidian' && baseBlock.name !== 'bedrock')) {
        // Wait briefly for server block update if we just placed obsidian
        if (this.stateTicks < 10) return true;
        this._resetOffensiveState(true);
        return false;
      }

      const crystalItem = this._findItem('end_crystal');
      if (!crystalItem) {
        this._resetOffensiveState(true);
        return false;
      }

      const topFaceAim = plan.basePos.offset(0.5, 1.0, 0.5);
      const aimStatus = this.aimer.stepTowardsPoint(topFaceAim, {
        speedMultiplier: 1.35,
        toleranceRad: 0.16
      });
      const equipRes = this._ensureItemHeld(crystalItem);
      if (this.stepDelayTicks > 0 || equipRes.swappedThisTick || !equipRes.held || !aimStatus.aligned) {
        return true;
      }

      this._markOwnPlacement(plan.basePos);
      this._markOwnPlacement(plan.basePos.offset(0, 1, 0));

      // In Mineflayer, End Crystals are placed on Obsidian/Bedrock via activateBlock on the top face (0, 1, 0).
      // Using placeEntity fails/throws on end_crystal in Mineflayer 4.x.
      if (typeof this.bot.activateBlock === 'function') {
        Promise.resolve(this.bot.activateBlock(baseBlock, new Vec3(0, 1, 0))).catch(() => {});
      } else if (typeof this.bot.placeBlock === 'function') {
        Promise.resolve(this.bot.placeBlock(baseBlock, new Vec3(0, 1, 0))).catch(() => {});
      } else if (typeof this.bot.placeEntity === 'function') {
        Promise.resolve(this.bot.placeEntity(baseBlock, new Vec3(0, 1, 0))).catch(() => {});
      }

      // Detonate strictly on the next tick (sequential anticheat safety)
      this.stepDelayTicks = this.placeDelayTicks;
      this.state = 'CRYSTAL_DETONATE';
      return true;
    }

    // Step 3: Spawn-Tick Crystal Detonation
    if (this.state === 'CRYSTAL_DETONATE') {
      const crystalEntity = (plan.spawnedCrystal && plan.spawnedCrystal.isValid)
        ? plan.spawnedCrystal
        : this._findCrystalEntityNear(plan.blastPos, 2.5);
      const aimPos = crystalEntity ? crystalEntity.position.offset(0, 0.5, 0) : plan.blastPos.offset(0, 0.5, 0);
      const aimStatus = this.aimer.stepTowardsPoint(aimPos, {
        speedMultiplier: 1.65,
        toleranceRad: 0.28
      });

      if (!crystalEntity || (this.stepDelayTicks > 0 && !plan.spawnedCrystal) || !aimStatus.aligned) {
        return true;
      }

      if (typeof this.bot.attack === 'function') {
        this.bot.attack(crystalEntity);
      }
      this.lastCrystalTime = Date.now();
      this._resetOffensiveState(true);
      return true;
    }

    return false;
  }

  _tickAnchorState() {
    if (!this._canUseRespawnAnchor()) {
      this._resetOffensiveState(true);
      return false;
    }

    const plan = this.activePlan;
    if (!plan) {
      this._resetOffensiveState(true);
      return false;
    }

    this.stateTicks++;
    if (this.stateTicks > 40) {
      this._resetOffensiveState(true);
      return false;
    }

    this.bot.setControlState('sprint', false);
    if (typeof this.bot.setControlState === 'function') {
      this.bot.setControlState('sneak', false);
    }
    const anchorAim = plan.anchorPos.offset(0.5, 0.5, 0.5);

    // Step 0: Feet Blast-Shield Cover Placement before Anchor combo
    if (this.state === 'ANCHOR_COVER') {
      const nextState = plan.needsPlace
        ? 'ANCHOR_PLACE'
        : (plan.alreadyCharged ? 'ANCHOR_SWITCH_SLOT' : 'ANCHOR_CHARGE');
      const cover = plan.coverSpot;
      if (!cover || plan.coverPlaced) {
        this.state = nextState;
        return true;
      }

      const aimStatus = this.aimer.stepTowardsPoint(cover.aimPos, {
        speedMultiplier: 1.35,
        toleranceRad: 0.18
      });
      const equipRes = this._ensureItemHeld(cover.blockRecord);
      if (!equipRes.found) {
        this.state = nextState;
        return true;
      }
      if (this.stepDelayTicks > 0 || equipRes.swappedThisTick || !equipRes.held || !aimStatus.aligned) {
        return true;
      }

      const refBlock = this.bot.blockAt(cover.refPos);
      if (refBlock && refBlock.boundingBox === 'block' && isAirLike(this.bot.blockAt(cover.placePos))) {
        this._markOwnPlacement(cover.placePos);
        if (typeof this.bot.placeBlock === 'function') {
          Promise.resolve(this.bot.placeBlock(refBlock, cover.face)).catch(() => {});
        }
      }
      plan.coverPlaced = true;
      this.stepDelayTicks = this.placeDelayTicks;
      this.state = nextState;
      return true;
    }

    // Step 1: Place Respawn Anchor
    if (this.state === 'ANCHOR_PLACE') {
      const existing = this.bot.blockAt(plan.anchorPos);
      if (existing && existing.name === 'respawn_anchor') {
        this.state = this._getAnchorCharges(existing) >= 1 ? 'ANCHOR_SWITCH_SLOT' : 'ANCHOR_CHARGE';
        return true;
      }

      const anchorItem = this._findItem('respawn_anchor');
      if (!anchorItem || !plan.anchorRef) {
        this._resetOffensiveState(true);
        return false;
      }

      const aimStatus = this.aimer.stepTowardsPoint(plan.anchorRef.aimPos, {
        speedMultiplier: 1.35,
        toleranceRad: 0.16
      });
      const equipRes = this._ensureItemHeld(anchorItem);
      if (this.stepDelayTicks > 0 || equipRes.swappedThisTick || !equipRes.held || !aimStatus.aligned) {
        return true;
      }

      const refBlock = this.bot.blockAt(plan.anchorRef.refPos);
      if (!refBlock || refBlock.boundingBox !== 'block') {
        this._resetOffensiveState(true);
        return false;
      }

      this._markOwnPlacement(plan.anchorPos);
      if (typeof this.bot.placeBlock === 'function') {
        Promise.resolve(this.bot.placeBlock(refBlock, plan.anchorRef.face)).catch(() => {});
      }

      this.stepDelayTicks = this.placeDelayTicks;
      this.state = 'ANCHOR_CHARGE';
      return true;
    }

    // Step 2: Single-Charge Efficiency — Charge Respawn Anchor with exactly 1 Glowstone block
    if (this.state === 'ANCHOR_CHARGE') {
      const anchorBlock = this.bot.blockAt(plan.anchorPos);
      if (!anchorBlock || anchorBlock.name !== 'respawn_anchor') {
        if (this.stateTicks < 10) return true;
        this._resetOffensiveState(true);
        return false;
      }

      if (this._getAnchorCharges(anchorBlock) >= 1) {
        plan.chargeInFlight = false;
        plan.charged = true;
        this.stepDelayTicks = this.placeDelayTicks;
        this.state = 'ANCHOR_SWITCH_SLOT';
        return true;
      }

      if (plan.chargeInFlight) {
        return true;
      }

      if (plan.chargeAttempted) {
        plan.chargeWaitTicks = (plan.chargeWaitTicks || 0) + 1;
        if (plan.chargeWaitTicks < 3) {
          return true;
        }
        if ((plan.chargeRetries || 0) < 1) {
          plan.chargeRetries = (plan.chargeRetries || 0) + 1;
          plan.chargeAttempted = false;
          plan.charged = false;
          plan.chargeWaitTicks = 0;
        } else {
          this._markFailedAnchor(plan.anchorPos, 5000);
          this._resetOffensiveState(true);
          return false;
        }
      }

      const glowstoneItem = this._findItem('glowstone');
      if (!glowstoneItem) {
        this._resetOffensiveState(true);
        return false;
      }

      const face = this._findVisibleBlockFace(plan.anchorPos);
      const faceAim = plan.anchorPos.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5);
      const aimStatus = this.aimer.stepTowardsPoint(faceAim, {
        speedMultiplier: 1.35,
        toleranceRad: 0.16
      });
      const equipRes = this._ensureItemHeld(glowstoneItem);
      if (this.stepDelayTicks > 0 || equipRes.swappedThisTick || !equipRes.held || !aimStatus.aligned) {
        return true;
      }

      plan.chargeInFlight = true;
      plan.chargeWaitTicks = 0;
      if (typeof this.bot.activateBlock === 'function') {
        Promise.resolve(this.bot.activateBlock(anchorBlock, face))
          .catch(() => {})
          .finally(() => {
            plan.chargeInFlight = false;
            plan.chargeAttempted = true;
            plan.charged = true;
          });
      } else {
        plan.chargeInFlight = false;
        plan.chargeAttempted = true;
        plan.charged = true;
      }

      // If synchronous mock already charged the block, advance on next tick cleanly
      const updatedBlock = this.bot.blockAt(plan.anchorPos);
      if (updatedBlock && updatedBlock.name === 'respawn_anchor' && this._getAnchorCharges(updatedBlock) >= 1) {
        plan.chargeInFlight = false;
        plan.chargeAttempted = true;
        plan.charged = true;
        this.stepDelayTicks = this.placeDelayTicks;
        this.state = 'ANCHOR_SWITCH_SLOT';
      }
      return true;
    }

    // Step 3: Mandatory Hotbar Swap to non-glowstone slot (Totem, Sword, Axe, Empty) before detonating
    if (this.state === 'ANCHOR_SWITCH_SLOT') {
      const face = this._findVisibleBlockFace(plan.anchorPos);
      const faceAim = plan.anchorPos.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5);
      this.aimer.stepTowardsPoint(faceAim, { speedMultiplier: 1.35, toleranceRad: 0.16 });
      if (this.stepDelayTicks > 0) return true;

      const heldName = this.bot.heldItem ? this.bot.heldItem.name : '';
      if (heldName === 'glowstone' || heldName === 'respawn_anchor') {
        const safeSlot = this._findNonGlowstoneHotbarSlot();
        if (safeSlot < 0) {
          this._resetOffensiveState(true);
          return false;
        }
        if (typeof this.bot.setQuickBarSlot === 'function') {
          this.bot.setQuickBarSlot(safeSlot);
        }
        this.stepDelayTicks = Math.max(1, this.placeDelayTicks);
      }

      this.state = 'ANCHOR_DETONATE';
      return true;
    }

    // Step 4: Detonate Respawn Anchor on the following tick (activateBlock with non-glowstone slot)
    if (this.state === 'ANCHOR_DETONATE') {
      const anchorBlock = this.bot.blockAt(plan.anchorPos);
      if (!anchorBlock || anchorBlock.name !== 'respawn_anchor') {
        if (plan.detonateAttempted || plan.detonateInFlight) {
          this.lastAnchorTime = Date.now();
          this._resetOffensiveState(true);
          return true;
        }
        this._resetOffensiveState(true);
        return false;
      }

      if (plan.detonateInFlight) {
        return true;
      }

      if (plan.detonateAttempted) {
        plan.detonateWaitTicks = (plan.detonateWaitTicks || 0) + 1;
        if (plan.detonateWaitTicks < 3) {
          return true;
        }
        if ((plan.detonateRetries || 0) < 1) {
          plan.detonateRetries = (plan.detonateRetries || 0) + 1;
          plan.detonateAttempted = false;
          plan.detonateWaitTicks = 0;
        } else {
          this._markFailedAnchor(plan.anchorPos, 5000);
          this.lastAnchorTime = Date.now();
          this._resetOffensiveState(true);
          return false;
        }
      }

      // Safety check: ensure we are NOT holding glowstone
      if (this.bot.heldItem && this.bot.heldItem.name === 'glowstone') {
        const safeSlot = this._findNonGlowstoneHotbarSlot();
        if (safeSlot >= 0 && typeof this.bot.setQuickBarSlot === 'function') {
          this.bot.setQuickBarSlot(safeSlot);
          this.stepDelayTicks = Math.max(1, this.placeDelayTicks);
          return true;
        }
        this._resetOffensiveState(true);
        return false;
      }

      const face = this._findVisibleBlockFace(plan.anchorPos);
      const faceAim = plan.anchorPos.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5);
      const aimStatus = this.aimer.stepTowardsPoint(faceAim, {
        speedMultiplier: 1.4,
        toleranceRad: 0.18
      });

      if (this.stepDelayTicks > 0 || !aimStatus.aligned) {
        return true;
      }

      plan.detonateInFlight = true;
      plan.detonateWaitTicks = 0;
      if (typeof this.bot.activateBlock === 'function') {
        Promise.resolve(this.bot.activateBlock(anchorBlock, face))
          .catch(() => {})
          .finally(() => {
            plan.detonateInFlight = false;
            plan.detonateAttempted = true;
          });
      } else {
        plan.detonateInFlight = false;
        plan.detonateAttempted = true;
      }

      // If synchronous mock already popped the anchor, finish cleanly
      const afterBlock = this.bot.blockAt(plan.anchorPos);
      if (!afterBlock || afterBlock.name !== 'respawn_anchor') {
        this.lastAnchorTime = Date.now();
        this._resetOffensiveState(true);
      }
      return true;
    }

    return false;
  }

  // =========================================================================
  // 3. WIND CHARGE MACE LAUNCH & LETHAL-FALL CLUTCH
  // =========================================================================

  hasClearSkyAbove(minClearBlocks = 6) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) return false;
    if (typeof this.bot.blockAt !== 'function') return true;

    const pos = this.bot.entity.position;
    const bx = Math.floor(pos.x);
    const by = Math.floor(pos.y);
    const bz = Math.floor(pos.z);

    for (let dy = 1; dy <= minClearBlocks + 1; dy++) {
      const block = this.bot.blockAt(new Vec3(bx, by + dy, bz));
      if (block && block.boundingBox === 'block') {
        return false;
      }
    }
    return true;
  }

  _findClutchItem() {
    const water = this._findItem('water_bucket');
    if (water) return water;
    return this._findItem('wind_charge');
  }

  _canStartWindChargeLaunch(target) {
    if (this.burstCfg.windChargeLaunchEnabled === false) return false;
    if (!target || !target.isValid || !this.bot || !this.bot.entity) return false;
    if (!this.bot.entity.onGround) return false;

    const now = Date.now();
    if ((now - this.lastWindChargeTime) < (this.burstCfg.windChargeCooldownMs || 3500)) return false;

    const dist = this.bot.entity.position.distanceTo(target.position);
    if (dist < 1.5 || dist > 7.5) return false;

    if (!this.hasClearSkyAbove(6)) return false;

    const windCharge = this._findItem('wind_charge', true);
    const mace = this._findBestMace(true);
    return Boolean(windCharge && mace);
  }

  _steerAirToward(targetPos) {
    if (!this.bot || !this.bot.entity || !targetPos) return;
    const dx = targetPos.x - this.bot.entity.position.x;
    const dz = targetPos.z - this.bot.entity.position.z;
    const horizDist = Math.sqrt(dx * dx + dz * dz);

    if (horizDist < 0.45) {
      this.bot.setControlState('forward', false);
      this.bot.setControlState('left', false);
      this.bot.setControlState('right', false);
      return;
    }

    const desiredYaw = Math.atan2(-dx, -dz);
    const yawDiff = normalizeAngle(desiredYaw - this.bot.entity.yaw);
    this.bot.setControlState('forward', Math.abs(yawDiff) < Math.PI * 0.65);
    this.bot.setControlState('left', yawDiff > 0.35);
    this.bot.setControlState('right', yawDiff < -0.35);
  }

  _tickWindChargeState(target) {
    this.stateTicks++;
    const pos = this.bot.entity.position;
    const minFallDist = this.burstCfg.windChargeMinFallDistance || 3.5;
    const reach = (this.config && this.config.combat && this.config.combat.reach) || 3.0;

    // Step 1: Equip wind_charge and smoothly look straight down (-90° = -PI/2)
    if (this.state === 'WIND_AIM_LAUNCH') {
      if (this.stateTicks > 20 || !this.bot.entity.onGround) {
        this._resetOffensiveState(true);
        return false;
      }

      const windCharge = this._findItem('wind_charge', true);
      if (!windCharge) {
        this._resetOffensiveState(true);
        return false;
      }

      this.bot.setControlState('sprint', false);
      const aimStatus = this.aimer.stepTowardsAngles(this.bot.entity.yaw, -Math.PI / 2, {
        speedMultiplier: 1.45,
        toleranceRad: 0.14
      });
      const equipRes = this._ensureItemHeld(windCharge);

      if (equipRes.swappedThisTick || !equipRes.held || !aimStatus.aligned) {
        return true;
      }

      this.state = 'WIND_FIRE';
      this.stateTicks = 0;
      return true;
    }

    // Step 2: Jump & fire wind_charge downward to gain > 4 blocks height
    if (this.state === 'WIND_FIRE') {
      const windCharge = this._findItem('wind_charge', true);
      if (!windCharge) {
        this._resetOffensiveState(true);
        return false;
      }

      const equipRes = this._ensureItemHeld(windCharge);
      if (equipRes.swappedThisTick || !equipRes.held) {
        return true;
      }

      this.aimer.stepTowardsAngles(this.bot.entity.yaw, -Math.PI / 2, {
        speedMultiplier: 1.45,
        toleranceRad: 0.14
      });

      this.bot.setControlState('jump', true);
      if (typeof this.bot.activateItem === 'function') {
        this.bot.activateItem(false);
      }
      this.lastWindChargeTime = Date.now();
      this.windLaunchStartY = pos.y;
      this.windPeakY = pos.y;
      this.fallDistance = 0;

      this.state = 'WIND_ASCENDING';
      this.stateTicks = 0;
      return true;
    }

    // Step 3: Ascend, release jump, track peak height & target predicted position
    if (this.state === 'WIND_ASCENDING') {
      this.bot.setControlState('jump', false);
      if (this.stateTicks === 1 && typeof this.bot.deactivateItem === 'function') {
        try { this.bot.deactivateItem(); } catch (_) {}
      }

      if (pos.y > this.windPeakY) {
        this.windPeakY = pos.y;
      }

      if (target && target.isValid) {
        const predFeet = this._getPredictedTargetFeet(target, 3);
        const predTorso = predFeet.offset(0, (target.height || 1.8) * 0.65, 0);
        this.aimer.stepTowardsPoint(predTorso, { speedMultiplier: 1.3 });
        this._steerAirToward(predFeet);
      }

      const vy = this.bot.entity.velocity ? this.bot.entity.velocity.y : 0;
      const isDescending = !this.bot.entity.onGround && (vy < -0.05 || this.fallDistance > 0.05);

      if (isDescending) {
        this.state = 'WIND_DESCENDING';
        this.stateTicks = 0;
        return true;
      }

      // Abort if launch did not gain elevation after 10 ticks
      if (this.stateTicks > 10 && this.bot.entity.onGround && (this.windPeakY - this.windLaunchStartY) < 1.0) {
        this._resetOffensiveState(true);
        return false;
      }

      return true;
    }

    // Step 4: Descend, equip Breach Mace, track target, smash if fallDistance > 3.5 & reach <= 3.0, else clutch
    if (this.state === 'WIND_DESCENDING') {
      if (this.bot.entity.onGround) {
        this._resetOffensiveState(true);
        return false;
      }

      const heightAboveGround = this._getHeightAboveGround();
      const predFeet = target && target.isValid ? this._getPredictedTargetFeet(target, 2) : null;
      const predTorso = predFeet ? predFeet.offset(0, (target.height || 1.8) * 0.65, 0) : null;
      const reachDist = target && target.isValid ? this._getReachDistanceToEntity(target) : Infinity;

      const maceRecord = this._findBestMace(false);
      const holdingMace = Boolean(this.bot.heldItem && this.bot.heldItem.name === 'mace');
      const canSmashNow = Boolean(
        target &&
        target.isValid &&
        holdingMace &&
        this.fallDistance > minFallDist &&
        reachDist <= reach
      );

      // Clutch check before lethal impact if smash missed or target escaped reach
      const lethalThreshold = Math.max(minFallDist, 3.5);
      const targetEscaped = !target || !target.isValid || reachDist > (reach + 0.8);
      const imminentImpact = heightAboveGround <= 2.4 && !canSmashNow;
      if (
        !canSmashNow &&
        this.fallDistance >= lethalThreshold &&
        ((targetEscaped && heightAboveGround <= 3.5) || imminentImpact) &&
        this._findClutchItem()
      ) {
        this.state = 'WIND_CLUTCH';
        this.stateTicks = 0;
        this.clutchFired = false;
        return this._tickWindClutch();
      }

      // Smoothly aim at target's predicted position & steer horizontally toward them
      let aimStatus = { aligned: false };
      if (predTorso) {
        aimStatus = this.aimer.stepTowardsPoint(predTorso, {
          speedMultiplier: 1.4,
          toleranceRad: 0.24
        });
        this._steerAirToward(predFeet);
      }

      // Equip Mace sequentially (prioritizing combat.getHotbarSlots().breachMaceSlot)
      if (!maceRecord) {
        if (this.fallDistance >= lethalThreshold && this._findClutchItem()) {
          this.state = 'WIND_CLUTCH';
          this.stateTicks = 0;
          this.clutchFired = false;
          return true;
        }
        this._resetOffensiveState(true);
        return false;
      }

      const equipRes = this._ensureItemHeld(maceRecord);
      if (equipRes.swappedThisTick || !equipRes.held) {
        return true;
      }

      if (
        target &&
        target.isValid &&
        this.fallDistance > minFallDist &&
        reachDist <= reach &&
        aimStatus.aligned
      ) {
        if (typeof this.bot.attack === 'function') {
          this.bot.attack(target);
        }
        this._resetOffensiveState(true);
        return true;
      }

      return true;
    }

    // Step 5: Lethal Fall Clutch (water_bucket or wind_charge at pitch = -90°)
    if (this.state === 'WIND_CLUTCH') {
      return this._tickWindClutch();
    }

    return false;
  }

  _tickWindClutch() {
    this.stateTicks++;
    const pos = this.bot.entity.position;
    const feetBlock = typeof this.bot.blockAt === 'function' ? this.bot.blockAt(pos) : null;
    const inWater = feetBlock && (feetBlock.name === 'water' || feetBlock.name === 'flowing_water');

    if (this.bot.entity.onGround || inWater || this.stateTicks > 35) {
      if (this.clutchFired && typeof this.bot.deactivateItem === 'function') {
        try { this.bot.deactivateItem(); } catch (_) {}
      }
      this.fallDistance = 0;
      this._resetOffensiveState(true);
      return false;
    }

    const clutchItem = this._findClutchItem();
    if (!clutchItem) {
      this._resetOffensiveState(true);
      return false;
    }

    this.bot.setControlState('forward', false);
    this.bot.setControlState('left', false);
    this.bot.setControlState('right', false);
    this.bot.setControlState('sprint', false);

    const aimStatus = this.aimer.stepTowardsAngles(this.bot.entity.yaw, -Math.PI / 2, {
      speedMultiplier: 1.65,
      toleranceRad: 0.18
    });

    const equipRes = this._ensureItemHeld(clutchItem);
    if (equipRes.swappedThisTick || !equipRes.held) {
      return true;
    }

    const heightAboveGround = this._getHeightAboveGround();
    if (!this.clutchFired && (aimStatus.aligned || aimStatus.pitchErrorDeg <= 14) && heightAboveGround <= 4.0) {
      if (typeof this.bot.activateItem === 'function') {
        this.bot.activateItem(false);
      }
      this.clutchFired = true;
    }

    return true;
  }

  // =========================================================================
  // MAIN 20-TPS OFFENSIVE TICK (`tick`)
  // =========================================================================

  /**
   * 20-TPS offensive burst handler.
   * Returns true if BurstModule handled this tick.
   */
  tick(target) {
    this._updateFallDistance();

    if (!this.bot || !this.bot.entity) {
      this._resetOffensiveState(false);
      return false;
    }

    // Decrement inter-step sequential delay counter once per tick
    if (this.stepDelayTicks > 0) {
      this.stepDelayTicks--;
    }

    // Active lethal-fall clutch always completes regardless of HP or target
    if (this.state === 'WIND_CLUTCH') {
      return this._tickWindClutch();
    }

    // High-priority anti-explosive defense supersedes offensive ticks
    if (this.defenseState !== 'IDLE') {
      return false;
    }

    const minBurstHealth = this.burstCfg.minBurstHealth !== undefined ? this.burstCfg.minBurstHealth : 9;

    // Continue an active offensive sequence
    if (this.state !== 'IDLE') {
      if (!target || !target.isValid || this.bot.health <= minBurstHealth) {
        this.cancel();
        return this.state === 'WIND_CLUTCH';
      }

      if (this.state.startsWith('CRYSTAL_')) {
        return this._tickCrystalState(target);
      }
      if (this.state.startsWith('ANCHOR_')) {
        return this._tickAnchorState();
      }
      if (this.state.startsWith('WIND_')) {
        return this._tickWindChargeState(target);
      }
    }

    // IDLE: check preconditions to initiate a new offensive burst
    if (!target || !target.isValid) return false;
    if (this.bot.health <= minBurstHealth) return false;

    const predictedFeet = this._getPredictedTargetFeet(target, 3);
    const targetDist = this.bot.entity.position.distanceTo(target.position);

    // 0. Instant CPvP pop on any existing End Crystal that favors us (with feet blast-shield if needed)
    if (this.burstCfg.crystalEnabled !== false) {
      const popPlan = this._findExistingPoppableCrystal(target, predictedFeet);
      if (popPlan) {
        this.activePlan = {
          kind: 'crystal',
          detonateOnly: true,
          spawnedCrystal: popPlan.entity,
          basePos: popPlan.entity.position.floored().offset(0, -1, 0),
          blastPos: popPlan.entity.position.clone(),
          coverSpot: popPlan.coverSpot
        };
        this.state = popPlan.coverSpot ? 'CRYSTAL_COVER' : 'CRYSTAL_DETONATE';
        this.stateTicks = 0;
        this.stepDelayTicks = 0;
        return this._tickCrystalState(target);
      }
    }

    // Priority 3: Dimension-guarded Respawn Anchor combo at <= 3.6b (Blast Shield -> Anchor -> 1x Glowstone -> Swap -> Detonate)
    if (
      this._canUseRespawnAnchor() &&
      this._findItem('respawn_anchor') &&
      this._findItem('glowstone') &&
      targetDist <= (this.burstCfg.anchorMaxRange || 3.6)
    ) {
      const bestAnchor = this._findBestAnchorPlacement(target, predictedFeet);
      if (bestAnchor) {
        this.activePlan = bestAnchor;
        this.stateTicks = 0;
        this.stepDelayTicks = 0;
        if (bestAnchor.coverSpot) {
          this.state = 'ANCHOR_COVER';
        } else if (bestAnchor.needsPlace) {
          this.state = 'ANCHOR_PLACE';
        } else if (bestAnchor.alreadyCharged) {
          this.state = 'ANCHOR_SWITCH_SLOT';
        } else {
          this.state = 'ANCHOR_CHARGE';
        }
        return this._tickAnchorState();
      }
    }

    // Priority 4: End Crystal combo at <= 4.5b (Surround Pressure -> Hit-Crystal -> Place-and-Pop)
    if (
      this.burstCfg.crystalEnabled !== false &&
      this._findItem('end_crystal') &&
      targetDist <= (this.burstCfg.crystalMaxRange || 4.5)
    ) {
      let crystalPlan = null;

      if (this.burstCfg.surroundPressureEnabled !== false && isTargetInSurround(this.bot, target)) {
        crystalPlan = planSurroundPressurePlacement(this, target, predictedFeet);
      }

      if (!crystalPlan && this._canStartHitCrystal(target)) {
        this.activePlan = { kind: 'crystal', isHitCrystal: true };
        this.state = 'CRYSTAL_HIT_LAUNCH';
        this.stateTicks = 0;
        this.stepDelayTicks = 0;
        return this._tickCrystalState(target);
      }

      if (!crystalPlan) {
        crystalPlan = this._findBestCrystalPlacement(target, predictedFeet);
      }

      if (crystalPlan) {
        this.activePlan = crystalPlan;
        this.stateTicks = 0;
        this.stepDelayTicks = 0;
        if (crystalPlan.coverSpot) {
          this.state = 'CRYSTAL_COVER';
        } else if (crystalPlan.needsObsidian) {
          this.state = 'CRYSTAL_PLACE_OBSIDIAN';
        } else {
          this.state = 'CRYSTAL_PLACE_CRYSTAL';
        }
        return this._tickCrystalState(target);
      }
    }

    // Optional Wind Charge Mace Launch fallback (only if explicitly enabled)
    if (this.burstCfg.windChargeLaunchEnabled === true && this._canStartWindChargeLaunch(target)) {
      this.activePlan = { kind: 'wind_mace' };
      this.state = 'WIND_AIM_LAUNCH';
      this.stateTicks = 0;
      this.stepDelayTicks = 0;
      return this._tickWindChargeState(target);
    }

    return false;
  }
}

module.exports = {
  BurstModule,
  CRYSTAL_POWER,
  ANCHOR_POWER
};
