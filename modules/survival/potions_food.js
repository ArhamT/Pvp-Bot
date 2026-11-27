'use strict';

const { Vec3 } = require('vec3');
const { normalizeAngle } = require('../aim');
const {
  OFFHAND_SLOT,
  HOTBAR_START,
  SWORD_PRIORITY,
  AXE_PRIORITY,
  isSpearItem,
  clearMovementControls,
  getItemMetadataText
} = require('../constants');
const {
  parseItemEnchantments,
  validateArmorInventory,
  buildTargetState,
  detectIncomingMaceAttack
} = require('../mace_elytra');
const {
  GAPPLE_PRIORITY,
  HEAL_FOOD_PRIORITY,
  LOS_BLOCK_NAMES,
  ARMOR_SLOTS,
  ARMOR_MATERIAL_SCORE,
  ARMOR_MAX_DURABILITY,
  DEFAULT_BUFF_DURATION_MS,
  VANILLA_POTION_ID_TO_KEY,
  ZERO_BASED_EFFECT_TO_KIND,
  ZERO_BASED_EFFECT_TO_CLASS,
  ONE_BASED_EFFECT_TO_KIND
} = require('./constants');

const potionsFoodMethods = {
  /**
   * Deeply serializes item metadata including MC 1.20.5+ Map `componentMap`, `components`, `nbt`, and display names.
   */
  _extractPotionMetadata(item) {
    if (!item) return { text: '', potionId: null, effectIds: [] };
    const parts = [];
    let potionId = null;
    const effectIds = [];

    const walk = (val, depth = 0) => {
      if (val === null || val === undefined || depth > 6) return;
      if (typeof val === 'string') {
        parts.push(val.toLowerCase());
        return;
      }
      if (typeof val === 'number') return;
      if (val instanceof Map) {
        for (const [k, v] of val.entries()) {
          parts.push(String(k).toLowerCase());
          walk(v, depth + 1);
        }
        return;
      }
      if (Array.isArray(val)) {
        for (const el of val) walk(el, depth + 1);
        return;
      }
      if (typeof val === 'object') {
        if (typeof val.potionId === 'number' && potionId === null) potionId = val.potionId;
        if (typeof val.potion === 'number' && potionId === null) potionId = val.potion;
        if (
          typeof val.id === 'number' &&
          (val.amplifier !== undefined || val.duration !== undefined || val.details !== undefined)
        ) {
          effectIds.push(val.id);
        }
        for (const [k, v] of Object.entries(val)) {
          parts.push(k.toLowerCase());
          walk(v, depth + 1);
        }
      }
    };

    if (item.customName) parts.push(String(item.customName).toLowerCase());
    if (item.displayName) parts.push(String(item.displayName).toLowerCase());
    if (item.nbt) walk(item.nbt);
    if (item.components) walk(item.components);
    if (item.componentMap) walk(item.componentMap);

    return { text: parts.join(' '), potionId, effectIds };
  },

  _classifyPotionKey(key) {
    if (!key) return null;
    const k = String(key).toLowerCase();
    if (k === 'water' || k === 'mundane' || k === 'thick' || k === 'awkward' || k === 'empty') {
      return 'other';
    }
    if (
      k.includes('harming') || k.includes('instant_damage') || k.includes('poison') ||
      k.includes('weakness') || k.includes('slowness') || k.includes('wither') ||
      k.includes('oozing') || k.includes('weaving') || k.includes('infested') || k.includes('wind_charged')
    ) {
      return 'harmful';
    }
    if (k.includes('strong_healing') || k.includes('instant_health_ii') || k.includes('healing ii')) {
      return 'heal2';
    }
    if (k.includes('healing') || k.includes('instant_health') || k.includes('instant health')) {
      return 'heal1';
    }
    if (k.includes('regeneration') || k.includes('regen')) return 'regen';
    if (k.includes('strength')) return 'strength';
    if (k.includes('swiftness') || k.includes('speed')) return 'swiftness';
    if (k.includes('fire_resistance') || k.includes('fire resistance')) return 'fire_res';
    if (k.includes('turtle_master') || k.includes('resistance')) return 'turtle_master';
    return null;
  },

  /**
   * Classifies any potion or splash_potion reliably across MC 1.16–1.21.4+:
   * returns 'heal2' | 'heal1' | 'regen' | 'strength' | 'swiftness' | 'fire_res' | 'turtle_master' | 'harmful' | 'unknown_splash' | 'unknown_drink' | 'other'.
   */
  _classifyPotion(item) {
    if (!item || !item.name) return 'other';
    if (item.name !== 'splash_potion' && item.name !== 'potion' && item.name !== 'lingering_potion') {
      return 'other';
    }

    const { text, potionId, effectIds } = this._extractPotionMetadata(item);

    // 1. Explicit string matching (MC <= 1.20.4 NBT & string-named components / custom kits)
    const byText = this._classifyPotionKey(text);
    if (byText) return byText;

    // 2. Vanilla MC 1.20.5–1.21.4+ numeric `minecraft:potion` registry IDs (exact Potions1_20_5 0-based order)
    if (typeof potionId === 'number' && potionId >= 0 && potionId < VANILLA_POTION_ID_TO_KEY.length) {
      const potionKey = VANILLA_POTION_ID_TO_KEY[potionId];
      const byId = this._classifyPotionKey(potionKey);
      if (byId) return byId;
      return 'other';
    }

    // 3. Check custom effect IDs (both 0-based MC 1.20.5+ and bot.registry lookup)
    if (effectIds.length > 0) {
      const zeroBased = this._usesZeroBasedEffectIds();
      for (const eid of effectIds) {
        if (zeroBased && ZERO_BASED_EFFECT_TO_CLASS[eid]) {
          return ZERO_BASED_EFFECT_TO_CLASS[eid];
        }
        if (this.bot && this.bot.registry && this.bot.registry.effects) {
          const regEffects = this.bot.registry.effects;
          const registryStartsAtZero = Boolean(regEffects[0] && regEffects[0].name === 'Speed');
          const lookupIdx = (!zeroBased && registryStartsAtZero) ? (eid - 1) : eid;
          const eff = regEffects[lookupIdx] || regEffects[eid];
          const ename = eff && eff.name ? eff.name.toLowerCase() : '';
          if (ename.includes('instantdamage') || ename.includes('poison') || ename.includes('weakness') || ename.includes('slowness')) {
            return 'harmful';
          }
          if (ename.includes('instanthealth') || ename.includes('healing')) return 'heal2';
          if (ename.includes('regeneration')) return 'regen';
          if (ename.includes('strength')) return 'strength';
          if (ename.includes('speed') || ename.includes('swiftness')) return 'swiftness';
          if (ename.includes('fireresistance')) return 'fire_res';
          if (ename.includes('resistance')) return 'turtle_master';
        }
      }
    }

    // 4. Fallback: unidentified splash_potion in PvP kits is almost always Instant Health II
    if (item.name === 'splash_potion') {
      return 'unknown_splash';
    }
    if (item.name === 'potion') {
      const isPlainWater = text.includes('water') || text.includes('mundane') ||
        text.includes('thick') || text.includes('awkward');
      if (!isPlainWater) return 'unknown_drink';
    }

    return 'other';
  },

  /**
   * Diagnostic summary of all potions in inventory (used by !debug).
   */
  getPotionInventorySummary() {
    if (!this.bot || !this.bot.inventory) return [];
    return this.bot.inventory.items()
      .filter((i) => i && (i.name === 'splash_potion' || i.name === 'potion' || i.name === 'lingering_potion'))
      .map((i) => {
        const meta = this._extractPotionMetadata(i);
        return {
          name: i.name,
          slot: i.slot,
          cls: this._classifyPotion(i),
          potionId: meta.potionId
        };
      });
  },

  /**
   * Finds a drinkable healing or regeneration potion (`potion` item) in inventory.
   */
  findDrinkableHealPotion() {
    if (!this.bot.inventory || this.survCfg.drinkablePotionEnabled === false) return null;
    const items = this.bot.inventory.items();
    const hotbarStart = this.bot.inventory.hotbarStart || HOTBAR_START;

    const rankOf = (item) => {
      if (!item || item.name !== 'potion') return 0;
      const cls = this._classifyPotion(item);
      let base = 0;
      if (cls === 'heal2') base = 40;
      else if (cls === 'heal1') base = 30;
      else if (cls === 'regen') base = 20;
      if (base === 0) return 0;
      const inHotbar = item.slot >= hotbarStart && item.slot < hotbarStart + 9;
      return base + (inHotbar ? 5 : 0);
    };

    let best = null;
    let bestRank = 0;
    for (const item of items) {
      const r = rankOf(item);
      if (r > bestRank) {
        bestRank = r;
        best = item;
      }
    }
    return best;
  },

  /**
   * Returns durability remaining ratio in [0.0, 1.0] for an armor/tool item across
   * legacy NBT (`Damage`), `item.durabilityUsed`, and MC 1.20.5+ `damage` components.
   */
  getItemDurabilityRatio(item) {
    if (!item || !item.name) return 1.0;
    const maxDur = (typeof item.maxDurability === 'number' && item.maxDurability > 0)
      ? item.maxDurability
      : (ARMOR_MAX_DURABILITY[item.name] || 0);
    if (maxDur <= 0) return 1.0;

    let damage = 0;
    if (typeof item.durabilityUsed === 'number' && item.durabilityUsed > 0) {
      damage = item.durabilityUsed;
    } else if (item.componentMap instanceof Map) {
      const dmgComp = item.componentMap.get('damage') || item.componentMap.get('minecraft:damage');
      if (typeof dmgComp === 'number') damage = dmgComp;
      else if (dmgComp && typeof dmgComp.data === 'number') damage = dmgComp.data;
      else if (dmgComp && typeof dmgComp.value === 'number') damage = dmgComp.value;
    } else if (Array.isArray(item.components)) {
      const dmgComp = item.components.find((c) => c && (c.type === 'damage' || c.type === 'minecraft:damage'));
      if (dmgComp) {
        if (typeof dmgComp.data === 'number') damage = dmgComp.data;
        else if (typeof dmgComp.value === 'number') damage = dmgComp.value;
      }
    } else if (item.nbt && item.nbt.value && item.nbt.value.Damage) {
      const val = item.nbt.value.Damage.value !== undefined ? item.nbt.value.Damage.value : item.nbt.value.Damage;
      if (typeof val === 'number') damage = val;
    }

    return Math.max(0, Math.min(1, (maxDur - damage) / maxDur));
  },

  /**
   * Inspects worn armor slots (5=helmet, 6=chestplate, 7=leggings, 8=boots)
   * and returns the lowest durability piece `{ ratio, slot, item }` (or null if no armor worn).
   */
  getLowestWornArmorDurability() {
    if (!this.bot || !this.bot.inventory || !this.bot.inventory.slots) return null;
    let lowest = null;

    for (const spec of ARMOR_SLOTS) {
      const piece = this.bot.inventory.slots[spec.slotIndex];
      if (!piece || !piece.name) continue;
      if (!ARMOR_MAX_DURABILITY[piece.name] && typeof piece.maxDurability !== 'number') continue;

      const ratio = this.getItemDurabilityRatio(piece);
      if (!lowest || ratio < lowest.ratio) {
        lowest = { ratio, slot: spec.slotIndex, item: piece };
      }
    }
    return lowest;
  },

  /**
   * Finds an XP Bottle (`experience_bottle`) in inventory (preferring hotbar).
   */
  findXpBottle() {
    if (!this.bot || !this.bot.inventory) return null;
    const hotbarStart = this.bot.inventory.hotbarStart || HOTBAR_START;
    const items = this.bot.inventory.items();
    const hotbarXp = items.find(
      (i) => i && i.name === 'experience_bottle' && i.slot >= hotbarStart && i.slot < hotbarStart + 9
    );
    if (hotbarXp) return hotbarXp;
    return items.find((i) => i && i.name === 'experience_bottle') || null;
  },

  /**
   * Throws XP bottles smoothly downward at feet when any worn armor piece drops below
   * `xpMendDurabilityRatio` (default 45%), stopping once repaired to `xpMendStopRatio` (78%)
   * or if health drops below `xpMendMinHealth` (13).
   * Returns true while actively throwing XP bottles.
   */
  tickArmorXpMend(target) {
    if (this.survCfg.xpMendEnabled === false || !this.bot || !this.bot.entity || this.totemEquipInFlight || this.totemSwapPending) {
      this.isXpMending = false;
      return false;
    }

    const minHealth = this.survCfg.xpMendMinHealth !== undefined ? this.survCfg.xpMendMinHealth : 13;
    const startRatio = this.survCfg.xpMendDurabilityRatio !== undefined ? this.survCfg.xpMendDurabilityRatio : 0.45;
    const stopRatio = this.survCfg.xpMendStopRatio !== undefined ? this.survCfg.xpMendStopRatio : 0.78;
    const throwIntervalMs = this.survCfg.xpMendThrowIntervalMs !== undefined ? this.survCfg.xpMendThrowIntervalMs : 80;

    const lowest = this.getLowestWornArmorDurability();
    const xpBottle = this.findXpBottle();

    if (!lowest || !xpBottle || this.bot.health < minHealth) {
      this.isXpMending = false;
      return false;
    }

    const dist = (target && target.isValid && target.position)
      ? this.bot.entity.position.distanceTo(target.position)
      : Infinity;

    if (!this.isXpMending) {
      if (lowest.ratio >= startRatio) return false;
      // Don't start XP mending while getting point-blank comboed at moderate HP
      if (dist < 3.0 && this.bot.health < 16) return false;
      this.isXpMending = true;
    } else if (lowest.ratio >= stopRatio || (dist < 2.8 && this.bot.health < 14)) {
      this.isXpMending = false;
      return false;
    }

    // Smoothly pitch down to -90° (-PI/2) and throw XP bottles at feet (paced at throwIntervalMs)
    const aimStatus = this.aimer.stepTowardsAngles(this.bot.entity.yaw, -Math.PI / 2, {
      speedMultiplier: 1.85,
      toleranceRad: 0.16
    });

    this.bot.setControlState('sprint', false);
    this.bot.setControlState('forward', false);
    this.bot.setControlState('back', dist < 4.5);
    this.bot.setControlState('jump', false);

    const ready = this._equipHotbarOrSafe(xpBottle);
    const now = Date.now();
    if (ready && aimStatus.pitchErrorDeg <= 14 && (now - this.lastXpThrowTime) >= throwIntervalMs) {
      this.lastXpThrowTime = now;
      try {
        // Instant throwable item: send use_item only (no bogus block_dig/deactivateItem packet)
        this.bot.activateItem(false);
      } catch (_) {}
    }

    return true;
  },

  /**
   * Prioritizes hotbar Splash Potions of Instant Health II, then Instant Health I / Regeneration /
   * fallback splash potions, checking hotbar first then main inventory.
   */
  findHealingPotion(excludeSlots = new Set()) {
    if (!this.bot.inventory) return null;
    const hotbarStart = this.bot.inventory.hotbarStart || HOTBAR_START;
    const items = this.bot.inventory.items().filter((i) => i && !excludeSlots.has(i.slot));

    const rankOf = (item) => {
      if (item.name !== 'splash_potion') return 0;
      const cls = this._classifyPotion(item);
      let base = 0;
      if (cls === 'heal2') base = 40;
      else if (cls === 'heal1') base = 30;
      else if (cls === 'unknown_splash') base = 25;
      else if (cls === 'regen') base = 15;
      if (base === 0) return 0;
      // Prefer hotbar pots for instant zero-click throwing
      const inHotbar = item.slot >= hotbarStart && item.slot < hotbarStart + 9;
      return base + (inHotbar ? 5 : 0);
    };

    let best = null;
    let bestRank = 0;
    for (const item of items) {
      const r = rankOf(item);
      if (r > bestRank) {
        bestRank = r;
        best = item;
      }
    }
    return best;
  },

  /**
   * Determines whether the current Minecraft protocol sends 0-based effect IDs (>= 1.20.5)
   * or 1-based effect IDs (<= 1.20.4).
   */
  _usesZeroBasedEffectIds() {
    if (!this.bot) return true;
    if (typeof this.bot.version === 'string') {
      const m = this.bot.version.match(/^1\.(\d+)(?:\.(\d+))?/);
      if (m) {
        const minor = parseInt(m[1], 10);
        const patch = m[2] ? parseInt(m[2], 10) : 0;
        if (minor > 20 || (minor === 20 && patch >= 5)) return true;
        return false;
      }
    }
    // Fallback: check if minecraft-data registry itself starts at 0
    if (this.bot.registry && this.bot.registry.effects && this.bot.registry.effects[0]) {
      return true;
    }
    return false;
  },

  /**
   * Maps a protocol status effect ID to our internal buff kind ('swiftness', 'strength', 'fire_res', 'regen', 'turtle_master').
   * Fixes the off-by-1 mismatch where minecraft-data uses 0-based keys even when MC 1.20.4 sends 1-based effect IDs.
   */
  _mapEffectIdToKind(effectId) {
    if (typeof effectId !== 'number') return null;
    const zeroBased = this._usesZeroBasedEffectIds();
    const table = zeroBased ? ZERO_BASED_EFFECT_TO_KIND : ONE_BASED_EFFECT_TO_KIND;
    if (table[effectId]) return table[effectId];

    // Also try registry lookup adjusting for 1-based protocol vs 0-based minecraft-data table
    const regEffects = this.bot && this.bot.registry && this.bot.registry.effects;
    if (regEffects) {
      const registryStartsAtZero = Boolean(regEffects[0] && regEffects[0].name === 'Speed');
      const lookupIdx = (!zeroBased && registryStartsAtZero) ? (effectId - 1) : effectId;
      const reg = regEffects[lookupIdx];
      if (reg) {
        const norm = String((reg.name || '') + ' ' + (reg.displayName || '')).toLowerCase().replace(/[\s_-]+/g, '');
        if (norm.includes('fireresistance')) return 'fire_res';
        if (norm.includes('strength')) return 'strength';
        if (norm.includes('speed') || norm.includes('swiftness')) return 'swiftness';
        if (norm.includes('regeneration')) return 'regen';
        if (norm.includes('resistance')) return 'turtle_master';
      }
    }
    return null;
  },

  _handleEntityEffect(entity, effect) {
    if (!this.bot || !this.bot.entity || !entity || entity.id !== this.bot.entity.id || !effect) return;
    const kind = this._mapEffectIdToKind(effect.id);
    if (!kind) return;

    // effect.duration === -1 means infinite; otherwise duration is in ticks (50ms each)
    const expiresAt = effect.duration < 0
      ? Infinity
      : Date.now() + Math.max(0, effect.duration * 50 - 3000);
    this.activeBuffUntil.set(kind, expiresAt);
  },

  _handleEntityEffectEnd(entity, effect) {
    if (!this.bot || !this.bot.entity || !entity || entity.id !== this.bot.entity.id || !effect) return;
    const kind = this._mapEffectIdToKind(effect.id);
    if (kind) {
      this.activeBuffUntil.delete(kind);
    }
  },

  _handleClearBuffs() {
    this.activeBuffUntil.clear();
  },

  _markBuffApplied(kind) {
    if (!kind) return;
    const durationMs = DEFAULT_BUFF_DURATION_MS[kind] || 80000;
    const targetUntil = Date.now() + durationMs;
    const existing = this.activeBuffUntil.get(kind) || 0;
    if (targetUntil > existing) {
      this.activeBuffUntil.set(kind, targetUntil);
    }
  },

  /**
   * Returns true if buff `kind` ('strength', 'swiftness', 'fire_res', 'regen', 'turtle_master', 'unknown_drink')
   * is currently active with > 3 seconds remaining (checking both tracked expiry timers and `bot.entity.effects`).
   */
  isBuffActive(kind) {
    const now = Date.now();
    const until = this.activeBuffUntil.get(kind);
    if (until && until > now) {
      return true;
    }

    if (!this.bot || !this.bot.entity || !this.bot.entity.effects) return false;
    for (const eff of Object.values(this.bot.entity.effects)) {
      if (!eff) continue;
      if (this._mapEffectIdToKind(eff.id) === kind) {
        // Only treat as active if duration is infinite (-1) or > 60 ticks (> 3 seconds)
        if (eff.duration === undefined || eff.duration < 0 || eff.duration > 60) {
          return true;
        }
      }
    }
    return false;
  },

  /**
   * Finds a missing combat buff potion (Strength, Swiftness, Fire Resistance, Regeneration, Turtle Master).
   * Never re-drinks or re-splashes a buff that still has remaining duration.
   */
  findNeededBuffPotion() {
    if (!this.bot.inventory || this.survCfg.buffPotionEnabled === false) return null;
    const items = this.bot.inventory.items();
    const allowDrinkable = this.survCfg.drinkablePotionEnabled !== false;

    const wantTypes = [];
    if (!this.isBuffActive('strength')) wantTypes.push('strength');
    if (!this.isBuffActive('swiftness')) wantTypes.push('swiftness');
    if (!this.isBuffActive('fire_res')) wantTypes.push('fire_res');
    if (this.bot.health <= 16 && !this.isBuffActive('regen')) wantTypes.push('regen');
    if (this.bot.health <= 15 && !this.isBuffActive('turtle_master')) wantTypes.push('turtle_master');

    for (const want of wantTypes) {
      const splash = items.find((i) => i.name === 'splash_potion' && this._classifyPotion(i) === want);
      if (splash) return { item: splash, isSplash: true, kind: want };
      if (allowDrinkable) {
        const drink = items.find((i) => i.name === 'potion' && this._classifyPotion(i) === want);
        if (drink) return { item: drink, isSplash: false, kind: want };
      }
    }

    // Fallback: drink unidentified custom buff potion at most once per buff window
    if (allowDrinkable && !this.isBuffActive('unknown_drink')) {
      const customDrink = items.find((i) => i.name === 'potion' && this._classifyPotion(i) === 'unknown_drink');
      if (customDrink && !this.isBuffActive('strength') && !this.isBuffActive('swiftness')) {
        return { item: customDrink, isSplash: false, kind: 'unknown_drink' };
      }
    }
    return null;
  },

  /**
   * Keeps at least 2 splash healing potions buffered on hotbar slots 4–8 (refilling from main inventory
   * every 250ms) so HT1 double-potting has zero window_click latency in combat.
   */
  _tryRefillHotbarPot() {
    if (!this.bot.inventory || this.sortingInProgress || this.totemEquipInFlight || this.totemSwapPending || this.totemDelayTimer || this.equipBusy) return;
    if (typeof this.bot.moveSlotItem !== 'function') return;

    const now = Date.now();
    if ((now - this.pendingPotRefillTime) < 250) return;

    const hotbarStart = this.bot.inventory.hotbarStart || HOTBAR_START;
    const items = this.bot.inventory.items();
    let hotbarHealCount = 0;
    for (const i of items) {
      if (!i || i.slot < hotbarStart || i.slot >= hotbarStart + 9) continue;
      const cls = this._classifyPotion(i);
      if (i.name === 'splash_potion' && (cls === 'heal2' || cls === 'heal1' || cls === 'unknown_splash')) {
        hotbarHealCount++;
      }
    }
    if (hotbarHealCount >= 2) return;

    const invPot = items.find((i) => {
      if (!i || i.slot >= hotbarStart) return false;
      const cls = this._classifyPotion(i);
      return i.name === 'splash_potion' && (cls === 'heal2' || cls === 'heal1' || cls === 'unknown_splash');
    });
    if (!invPot) return;

    // Prefer an empty hotbar slot among 4–8 (or overwrite slot 8 only when 0 pots are on hotbar)
    let destSlot = -1;
    for (const idx of [8, 7, 6, 5, 4]) {
      const s = hotbarStart + idx;
      if (!this.bot.inventory.slots || !this.bot.inventory.slots[s]) {
        destSlot = s;
        break;
      }
    }
    if (destSlot === -1) {
      if (hotbarHealCount > 0) return;
      destSlot = hotbarStart + 8;
    }

    this.pendingPotRefillTime = now;
    this.equipBusy = true;
    Promise.resolve(this.bot.moveSlotItem(invPot.slot, destSlot))
      .catch(() => {})
      .finally(() => {
        this.equipBusy = false;
      });
  },

  /**
   * Immediately swaps back to the best hotbar melee weapon (Sword -> Axe) after finishing a heal/pot
   * so zero combat ticks are wasted holding an empty glass bottle or golden apple.
   */
  _restoreHotbarWeapon() {
    if (!this.bot || !this.bot.inventory || typeof this.bot.setQuickBarSlot !== 'function') return;
    const hotbarStart = this.bot.inventory.hotbarStart || HOTBAR_START;
    const slots = this.bot.inventory.slots || [];
    for (const name of [...SWORD_PRIORITY, ...AXE_PRIORITY]) {
      for (let i = 0; i < 9; i++) {
        const item = slots[hotbarStart + i];
        if (item && item.name === name) {
          if (this.bot.quickBarSlot !== i) {
            this.bot.setQuickBarSlot(i);
          }
          return;
        }
      }
    }
  },

  _queueSplashPotion(potion, isBuff = false, kind = null) {
    this.isXpMending = false;
    this.pendingSplashPotion = potion;
    this.pendingSplashIsBuff = Boolean(isBuff);
    this.pendingSplashKind = kind || null;
    this.pendingSplashCreatedAt = Date.now();
    this.pendingSplashSettleTicks = 0;
    this.pendingSplashEquipStarted = false;
  },

  /**
   * Checks whether the bot is currently holding the EXACT target item (matching slot for hotbar items,
   * and matching potion classification for potions so Strength/Speed/Heal pots never collide).
   */
  _isHoldingExactItem(item) {
    if (!item || !this.bot || !this.bot.heldItem) return false;
    if (this.bot.heldItem.type !== item.type) return false;

    const hotbarStart = (this.bot.inventory && this.bot.inventory.hotbarStart) || HOTBAR_START;
    if (typeof item.slot === 'number' && item.slot >= hotbarStart && item.slot < hotbarStart + 9) {
      return this.bot.quickBarSlot === (item.slot - hotbarStart);
    }

    if (item.name === 'potion' || item.name === 'splash_potion' || item.name === 'lingering_potion') {
      return this._classifyPotion(this.bot.heldItem) === this._classifyPotion(item);
    }
    return true;
  },

  /**
   * Inline aggressive combat healing & buffing (runs inside ENGAGING without running away!):
   * - If HP <= inlinePotHealthThreshold (13) and splash healing pot exists -> quick pitch -90° & splash while moving!
   * - If missing Strength/Swiftness/FireRes buff and splash/drinkable buff pot exists -> apply cleanly!
   * - Refills hotbar healing pots from main inventory when hotbar runs dry (only when idle).
   * Returns true ONLY while actively throwing a splash potion, drinking a potion, or XP mending.
   */
  tickInlineCombatHeal(target) {
    if (!this.bot || !this.bot.entity || this.totemEquipInFlight || this.totemSwapPending) {
      if (this._totemMovementPaused) this._pauseMovementForTotemSwap();
      return false;
    }
    const now = Date.now();

    const dist = (target && target.isValid && target.position)
      ? this.bot.entity.position.distanceTo(target.position)
      : Infinity;

    // 0. If currently drinking a drinkable potion, walk safely without sprinting (abort only if rushed at low HP)
    if (this.isConsuming && this.isDrinkingPotion) {
      if ((now - this.consumeStartTime) > (this.survCfg.eatTimeoutMs || 3500) || (dist < 2.8 && this.bot.health < 9)) {
        try { this.bot.deactivateItem(); } catch (_) {}
        this.isConsuming = false;
        this.isDrinkingPotion = false;
        return false;
      }
      this._moveAwayWalk(target);
      return true;
    }

    // Continue active quick-splash throw
    if (this.pendingSplashPotion) {
      return this._tickSplashPotionDownward(target, true);
    }

    const potionCooldown = this.survCfg.potionCooldownMs || 450;
    const rapidPotCooldown = this.survCfg.rapidPotCooldownMs || 160;
    const safeHp = this.survCfg.safeHealthThreshold || 15;
    const isGlidingAirborne = Boolean(this.bot.entity.elytraFlying && !this.bot.entity.onGround);

    // 1. HT1 Inline Instant Health II Snap-Pot & Rapid Double-Pot Chain:
    //    - Triggers at HP <= inlinePotHealthThreshold (5 HP)
    //    - Once triggered, chains a rapid 2nd splash pot (160ms cooldown) until HP >= safeHealthThreshold (15 HP)!
    const inlineThreshold = this.survCfg.inlinePotHealthThreshold !== undefined ? this.survCfg.inlinePotHealthThreshold : 5;
    const inPotChain = now <= this.activePotChainUntil && this.bot.health < safeHp;
    const shouldInlineHeal = this.bot.health <= inlineThreshold || inPotChain;
    const effectivePotCooldown = inPotChain ? rapidPotCooldown : Math.min(potionCooldown, 220);

    if (shouldInlineHeal && (now - this.lastPotionTime) >= effectivePotCooldown) {
      const healPot = !isGlidingAirborne ? this.findHealingPotion() : null;
      if (healPot) {
        this.activePotChainUntil = now + 1400;
        this._queueSplashPotion(healPot, false, null);
        return this._tickSplashPotionDownward(target, true);
      }

      const drinkHeal = this.findDrinkableHealPotion();
      if (
        drinkHeal &&
        !this.isConsuming &&
        !this.equipBusy &&
        (now - this.lastConsumeFailAt) >= 500 &&
        (dist >= 3.0 || this.bot.health <= inlineThreshold)
      ) {
        this.isXpMending = false;
        this._startDrinkingPotion(drinkHeal);
        this._moveAwayWalk(target);
        return true;
      }
    } else if (this.bot.health >= safeHp) {
      this.activePotChainUntil = 0;
    }

    // 2. XP Bottle armor mending when any worn armor piece drops below 45% durability (grounded/low only)
    if (!isGlidingAirborne && this.tickArmorXpMend(target)) {
      return true;
    }

    // 3. Combat buff potions (Splash OR Drinkable Strength / Swiftness / FireRes / Regen / Turtle Master)
    if ((now - this.lastPotionTime) >= potionCooldown && (now - this.lastBuffAttemptTime) >= 3500 && this.bot.health >= 12) {
      const buff = this.findNeededBuffPotion();
      if (buff) {
        if (buff.isSplash && !isGlidingAirborne) {
          this.lastBuffAttemptTime = now;
          this._queueSplashPotion(buff.item, true, buff.kind);
          return this._tickSplashPotionDownward(target, true);
        }

        const drinkMinDist = this.survCfg.drinkableBuffMinDist !== undefined ? this.survCfg.drinkableBuffMinDist : 3.5;
        if (
          !buff.isSplash &&
          this.survCfg.drinkablePotionEnabled !== false &&
          !this.isConsuming &&
          !this.equipBusy &&
          (now - this.lastConsumeFailAt) >= 500 &&
          (dist >= drinkMinDist || this.bot.health >= 14)
        ) {
          this.lastBuffAttemptTime = now;
          this._startDrinkingPotion(buff.item, buff.kind);
          this._moveAwayWalk(target);
          return true;
        }
      }
    }

    // 4. Passively refill empty hotbar pot slots from main inventory only when no heal/buff action ran this tick
    this._tryRefillHotbarPot();

    return false;
  },

  /**
   * Equips an item cleanly ONCE (no overlapping equip calls!) and waits 1 tick (55ms)
   * so held_item_slot / window_click settles before calling bot.consume().
   */
  async _equipSingleForConsume(item) {
    if (!item || !this.bot) return false;
    if (this._isHoldingExactItem(item)) {
      return true;
    }

    const hotbarStart = (this.bot.inventory && this.bot.inventory.hotbarStart) || HOTBAR_START;
    if (
      typeof item.slot === 'number' &&
      item.slot >= hotbarStart &&
      item.slot < hotbarStart + 9 &&
      typeof this.bot.setQuickBarSlot === 'function'
    ) {
      const targetIdx = item.slot - hotbarStart;
      if (this.bot.quickBarSlot !== targetIdx) {
        this.bot.setQuickBarSlot(targetIdx);
        await this._sleep(55); // 1-tick settle for Paper/GrimAC packet order
      }
      return true;
    }

    // Main inventory (slots 9–35): single sequential bot.equip without parallel overlap
    if (this.equipBusy) return false;
    this.equipBusy = true;
    try {
      await this.bot.equip(item, 'hand');
      await this._sleep(55);
      return true;
    } catch (_) {
      return false;
    } finally {
      this.equipBusy = false;
    }
  },

  /**
   * Drinks a regular `potion` (Strength, Swiftness, Fire Resistance, Healing, Regen, etc.)
   * cleanly via Mineflayer's `bot.consume()` with single-equip settle, timeout, & retry backoff.
   */
  async _startDrinkingPotion(potionItem, buffKind = null) {
    if (this.isConsuming || this.equipBusy || this.totemEquipInFlight || this.totemSwapPending || !potionItem) return;
    if ((Date.now() - this.lastConsumeFailAt) < 500) return;

    this.isConsuming = true;
    this.isDrinkingPotion = true;
    this.consumeStartTime = Date.now();
    this.bot.setControlState('sprint', false);

    const timeoutMs = this.survCfg.eatTimeoutMs || 3500;
    let timeoutHandle = null;

    try {
      const equipped = await this._equipSingleForConsume(potionItem);
      if (!equipped) {
        this.lastConsumeFailAt = Date.now();
        return;
      }

      await Promise.race([
        this.bot.consume(),
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error('drink_timeout')), timeoutMs);
        })
      ]);
      this.lastPotionTime = Date.now();
      if (buffKind) {
        this._markBuffApplied(buffKind);
      }
      this._restoreHotbarWeapon();
    } catch (_) {
      this.lastConsumeFailAt = Date.now();
      try { this.bot.deactivateItem(); } catch (_) {}
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      this.isConsuming = false;
      this.isDrinkingPotion = false;
    }
  },

  _equipHotbarOrSafe(item) {
    if (!item) return false;
    if (this._isHoldingExactItem(item)) return true;
    const hotbarStart = (this.bot.inventory && this.bot.inventory.hotbarStart) || HOTBAR_START;
    if (
      typeof item.slot === 'number' &&
      item.slot >= hotbarStart &&
      item.slot < hotbarStart + 9 &&
      typeof this.bot.setQuickBarSlot === 'function'
    ) {
      const targetIdx = item.slot - hotbarStart;
      if (this.bot.quickBarSlot !== targetIdx) {
        this.bot.setQuickBarSlot(targetIdx);
      }
      return true;
    }
    this._equipSafe(item, 'hand');
    return false;
  },

  /**
   * Finds Enchanted Golden Apple -> Golden Apple specifically.
   */
  findGoldenApple() {
    if (!this.bot.inventory) return null;
    const items = this.bot.inventory.items();
    for (const name of GAPPLE_PRIORITY) {
      const found = items.find((i) => i.name === name);
      if (found) return found;
    }
    return null;
  },

  /**
   * Finds highest-priority edible healing food.
   * At full hunger (food >= 20), only returns always-edible foods (Enchanted/Golden Apples),
   * because vanilla Minecraft refuses regular food at 20 food and hangs until eat timeout.
   */
  findBestHealFood() {
    if (!this.bot.inventory) return null;
    const items = this.bot.inventory.items();
    const canEatNormalFood = typeof this.bot.food !== 'number' || this.bot.food < 20;
    const list = canEatNormalFood ? HEAL_FOOD_PRIORITY : GAPPLE_PRIORITY;
    for (const name of list) {
      const found = items.find((i) => i.name === name);
      if (found) return found;
    }
    return null;
  },

  /**
   * HT1 1-tick Snap-Pot: snaps pitch downward to -85° (`force: true`), turns away from close enemies
   * (`dist < 4.5`) so 0% of the Instant Health II cloud heals the opponent, waits 1 settle tick after
   * hotbar swap, splashes, and immediately restores hotbar weapon if no follow-up pot is needed.
   */
  _tickSplashPotionDownward(target, inlineCombat = false) {
    if (!this.pendingSplashPotion) return false;

    const now = Date.now();
    if (this.pendingSplashCreatedAt && (now - this.pendingSplashCreatedAt) > 1000) {
      this.pendingSplashPotion = null;
      this.pendingSplashIsBuff = false;
      this.pendingSplashKind = null;
      this.pendingSplashEquipStarted = false;
      return false;
    }

    const potion = this.pendingSplashPotion;
    const dist = (target && target.isValid && target.position && this.bot.entity)
      ? this.bot.entity.position.distanceTo(target.position)
      : Infinity;

    // Anti-enemy-heal PotPvP technique: turn away when opponent is within 4.5b so splash never heals them!
    const turnAway = !this.pendingSplashIsBuff && target && target.isValid && (!inlineCombat || dist < 4.5);
    const desiredYaw = turnAway ? this._getAwayYaw(target) : this.bot.entity.yaw;
    const targetPitch = -85 * (Math.PI / 180); // Slight forward-down angle so moving bot catches 100% full pot

    const aimStatus = this.aimer.stepTowardsAngles(desiredYaw, targetPitch, {
      speedMultiplier: 2.0,
      toleranceRad: 0.22,
      force: true
    });

    // Keep moving into our own splash cloud (away from opponent when close)
    this.bot.setControlState('forward', true);
    this.bot.setControlState('back', false);
    this.bot.setControlState('sprint', false);
    this.bot.setControlState('jump', false);

    // Step 1: Ensure exact potion is equipped (with 1-tick settle after slot switch)
    let holdingPotion = this._isHoldingExactItem(potion);
    if (!holdingPotion) {
      const hotbarStart = (this.bot.inventory && this.bot.inventory.hotbarStart) || HOTBAR_START;
      const inHotbar = typeof potion.slot === 'number' &&
        potion.slot >= hotbarStart &&
        potion.slot < hotbarStart + 9;

      if (inHotbar && typeof this.bot.setQuickBarSlot === 'function') {
        const targetIdx = potion.slot - hotbarStart;
        if (this.bot.quickBarSlot !== targetIdx) {
          this.bot.setQuickBarSlot(targetIdx);
          this.pendingSplashSettleTicks = 0;
          return true; // Wait 1 tick for held_item_slot to settle before throwing
        }
        holdingPotion = true;
      } else if (!this.pendingSplashEquipStarted && !this.equipBusy) {
        this.pendingSplashEquipStarted = true;
        this.pendingSplashSettleTicks = 0;
        this._equipSafe(potion, 'hand');
        return true;
      } else if (this.equipBusy) {
        this.pendingSplashSettleTicks = 0;
        return true;
      } else {
        holdingPotion = Boolean(
          this.bot.heldItem &&
          this.bot.heldItem.name === 'splash_potion' &&
          this._classifyPotion(this.bot.heldItem) === this._classifyPotion(potion)
        );
        if (!holdingPotion) {
          this.pendingSplashPotion = null;
          this.pendingSplashIsBuff = false;
          this.pendingSplashKind = null;
          this.pendingSplashEquipStarted = false;
          return false;
        }
      }
    }

    this.pendingSplashSettleTicks++;

    // Step 2: Fire immediately once pitched down AND at least 1 tick has elapsed since equip
    if (holdingPotion && this.pendingSplashSettleTicks >= 1 && aimStatus.pitchErrorDeg <= 18) {
      const buffKind = this.pendingSplashIsBuff ? this.pendingSplashKind : null;
      const wasBuff = this.pendingSplashIsBuff;
      this.pendingSplashPotion = null;
      this.pendingSplashIsBuff = false;
      this.pendingSplashKind = null;
      this.pendingSplashEquipStarted = false;
      this._throwSplashPotion(potion, buffKind);

      // Swap straight back to weapon if buff or if this pot brings us into safe range
      const safeHp = this.survCfg.safeHealthThreshold || 15;
      if (wasBuff || (this.bot.health + 7) >= safeHp) {
        this._restoreHotbarWeapon();
      }
    }

    return true;
  },

  _throwSplashPotion(potion, buffKind = null) {
    if (this.totemEquipInFlight || this.totemSwapPending || !potion) return;
    try {
      // Instant throwable item: send use_item only (no extra block_dig/deactivateItem packet)
      this.bot.activateItem(false);
      this.lastPotionTime = Date.now();
      if (buffKind) {
        this._markBuffApplied(buffKind);
      }
    } catch (_) {}
  },

  async _startEatingFood(food) {
    if (this.isConsuming || this.equipBusy || this.totemEquipInFlight || this.totemSwapPending || !food) return;
    if ((Date.now() - this.lastConsumeFailAt) < 500) return;

    // Never attempt to eat normal food at full hunger (vanilla MC rejects it and hangs until timeout)
    const isAlwaysEdible = GAPPLE_PRIORITY.includes(food.name);
    if (!isAlwaysEdible && typeof this.bot.food === 'number' && this.bot.food >= 20) {
      return;
    }

    this.isConsuming = true;
    this.isDrinkingPotion = false;
    this.consumeStartTime = Date.now();
    this.bot.setControlState('sprint', false);

    const timeoutMs = this.survCfg.eatTimeoutMs || 3500;
    let timeoutHandle = null;

    try {
      const equipped = await this._equipSingleForConsume(food);
      if (!equipped) {
        this.lastConsumeFailAt = Date.now();
        return;
      }

      await Promise.race([
        this.bot.consume(),
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error('eat_timeout')), timeoutMs);
        })
      ]);

      if (food.name && food.name.includes('golden_apple')) {
        this.justAteGappleAt = Date.now();
      }
      this._restoreHotbarWeapon();
    } catch (_) {
      this.lastConsumeFailAt = Date.now();
      try { this.bot.deactivateItem(); } catch (_) {}
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      this.isConsuming = false;
    }
  }
};

module.exports = { potionsFoodMethods };
