'use strict';

/**
 * Per-tick cached Target Tracker, Auto-Retaliate (deduplicated), & Loot Scanner
 * (`modules/controller/target_tracker.js`).
 */
const targetTrackerMethods = {
  _clearTargetState(clearDuel = false) {
    this.activeTargetName = null;
    this.activeTargetEntityId = null;
    this.targetLastSeenPos = null;
    this.targetLostAt = 0;
    if (clearDuel) {
      this.pendingDuelTarget = null;
      this.pendingDuelReady = false;
      this.autoStartDuelUntil = 0;
      this.inDuelArena = false;
    }
  },

  _engageTarget(target, reason = 'engage', reply = null) {
    if (!target || !target.isValid) return false;
    if (this.miner) this.miner.cancel(true);
    this.activeTargetName = target.username || `entity#${target.id}`;
    this.activeTargetEntityId = target.id !== undefined ? target.id : null;
    this.targetLastSeenPos = target.position ? target.position.clone() : null;
    this.targetLostAt = 0;
    this.pendingDuelTarget = null;
    this.pendingDuelReady = false;
    this.autoStartDuelUntil = 0;

    if (reply) {
      reply(`Engaging ${this.activeTargetName} in a duel!`);
    } else {
      this.log(`Engaging ${this.activeTargetName} (${reason})!`);
    }

    this.transitionState('ENGAGING', reason);
    if (this.combat) this.combat.scanHotbarSlots();
    return true;
  },

  _tryAutoRetaliate(reason = 'damage') {
    if (this.config.bot.autoRetaliate === false) return false;
    if (!this.bot || !this.bot.entity || this.state !== 'IDLE') return false;

    const now = Date.now();
    // Deduplicate dual `entityHurt` + `health` callbacks firing on the exact same hit
    if ((now - (this._lastAutoRetaliateAt || 0)) < 150) return false;
    this._lastAutoRetaliateAt = now;

    const nearby = this._listNearbyPlayers(true);
    const recentlyEnded = (now - this.duelEndedAt) < 8000;
    if (!this.inDuelArena && !this._isWearingCombatArmor() && (nearby.length >= 3 || recentlyEnded)) {
      return false;
    }

    if (this.pendingDuelTarget && this.pendingDuelReady) {
      const pending = this._findPlayerEntity(this.pendingDuelTarget);
      if (pending && this.bot.entity.position.distanceTo(pending.position) <= (this.config.combat.engageRange || 96.0)) {
        return this._engageTarget(pending, `auto-retaliate (${reason})`);
      }
    }

    const arenaMode = this._detectArenaMode();
    for (let i = 0; i < nearby.length; i++) {
      const cand = nearby[i];
      if (cand.dist > 14.0) break;
      if (this._isPlayerInFfaSafeZone(cand.entity, arenaMode)) continue;
      return this._engageTarget(cand.entity, `auto-retaliate (${reason})`);
    }
    return false;
  },

  _resolveActiveTarget() {
    if (!this.bot) return null;
    if (this.activeTargetEntityId !== null && this.bot.entities) {
      const byId = this.bot.entities[this.activeTargetEntityId];
      if (byId && byId.isValid && byId.position) return byId;
    }
    if (this.activeTargetName) {
      const found = this._findPlayerEntity(this.activeTargetName);
      if (found) {
        this.activeTargetEntityId = found.id !== undefined ? found.id : null;
        return found;
      }
    }
    return null;
  },

  /**
   * Lists visible nearby players sorted by distance. Cached for 40ms (~1 physics tick)
   * unless `forceRefresh` is true, eliminating 2–4 redundant entity sweeps & sorts per tick!
   */
  _listNearbyPlayers(forceRefresh = false) {
    if (!this.bot || !this.bot.entity) return [];
    const now = Date.now();
    if (!forceRefresh && this._nearbyPlayersCache && (now - (this._nearbyPlayersCacheAt || 0)) < 40) {
      return this._nearbyPlayersCache;
    }

    const seenIds = new Set();
    const results = [];
    const selfId = this.bot.entity.id;
    const selfName = (this.bot.username || '').toLowerCase();
    const botPos = this.bot.entity.position;

    const addCandidate = (entity, fallbackName) => {
      if (!entity || !entity.isValid || !entity.position) return;
      if (entity.id !== undefined && (entity.id === selfId || seenIds.has(entity.id))) return;
      const username = entity.username || fallbackName || `player_${entity.id}`;
      if (username.toLowerCase() === selfName) return;
      if (entity.id !== undefined) seenIds.add(entity.id);
      const dist = botPos.distanceTo(entity.position);
      results.push({ username, entity, dist });
    };

    if (this.bot.players) {
      for (const player of Object.values(this.bot.players)) {
        if (player && player.entity) addCandidate(player.entity, player.username);
      }
    }

    if (this.bot.entities) {
      for (const entity of Object.values(this.bot.entities)) {
        if (entity && entity.type === 'player') addCandidate(entity, entity.username);
      }
    }

    results.sort((a, b) => a.dist - b.dist);
    this._nearbyPlayersCache = results;
    this._nearbyPlayersCacheAt = now;
    return results;
  },

  _findPlayerEntity(name) {
    if (!this.bot || !name) return null;
    const lower = name.toLowerCase();
    const all = this._listNearbyPlayers();

    for (let i = 0; i < all.length; i++) {
      if (all[i].username.toLowerCase() === lower) return all[i].entity;
    }
    for (let i = 0; i < all.length; i++) {
      if (all[i].username.toLowerCase().startsWith(lower)) return all[i].entity;
    }
    return null;
  },

  _findNearestLoot() {
    if (!this.bot || !this.bot.entity || !this.bot.entities) return null;
    const radius = this.config.looting.radius || 12.0;
    const botPos = this.bot.entity.position;
    let nearest = null;
    let bestDistSq = radius * radius;

    for (const entity of Object.values(this.bot.entities)) {
      if (!entity || !entity.isValid || !entity.position) continue;
      if (entity.name !== 'item' && entity.displayName !== 'Item') continue;

      const distSq = botPos.distanceSquared(entity.position);
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        nearest = entity;
      }
    }
    return nearest;
  }
};

module.exports = { targetTrackerMethods };
