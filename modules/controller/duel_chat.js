'use strict';

const { stripColorCodes } = require('./arena_detector');

const DUEL_REQUEST_REGEX = /(?:^|[\s•|:\]>»-])([A-Za-z0-9_]{3,16})\s+(?:has\s+sent(?:\s+you)?\s+a\s+duel\s+request|sent(?:\s+you)?\s+a\s+duel\s+request|challenged\s+you\s+to\s+a\s+duel)/i;
const DUEL_START_CUE_REGEX = /(?:^|[\s•|:\]>»-])(?:go!+|fight!+)(?:$|[\s!.,])/i;

/**
 * Duel Auto-Accept, Match Start/End/FFA Chat Triggers, & Duel Chat Ads (`modules/controller/duel_chat.js`).
 */
const duelChatMethods = {
  _clearDuelAcceptTimer() {
    if (this.duelAcceptTimer) {
      clearTimeout(this.duelAcceptTimer);
      this.duelAcceptTimer = null;
    }
  },

  _clearAdvertiseTimer() {
    if (this.advertiseTimer) {
      clearTimeout(this.advertiseTimer);
      this.advertiseTimer = null;
    }
  },

  _countOtherOnlinePlayers() {
    if (!this.bot || !this.bot.players) return 0;
    const selfName = (this.bot.username || '').toLowerCase();
    let count = 0;
    for (const name of Object.keys(this.bot.players)) {
      if (name && name.toLowerCase() !== selfName) count++;
    }
    return count;
  },

  _scheduleAdvertise() {
    this._clearAdvertiseTimer();
    if (!this.advertiseEnabled || this.shuttingDown) return;

    const advCfg = (this.config.bot && this.config.bot.advertise) || {};
    const minDelay = Number.isFinite(advCfg.minDelayMs) ? advCfg.minDelayMs : 60000;
    const maxDelay = Number.isFinite(advCfg.maxDelayMs) ? Math.max(minDelay, advCfg.maxDelayMs) : 180000;
    const delayMs = Math.round(this._randRange(minDelay, maxDelay));

    this.advertiseTimer = setTimeout(() => {
      this.advertiseTimer = null;
      this._sendAdvertise();
      this._scheduleAdvertise();
    }, delayMs);
  },

  _sendAdvertise() {
    if (!this.advertiseEnabled || this.shuttingDown || !this.bot || !this.bot.entity) return false;
    if (this.state !== 'IDLE' || this.inDuelArena) return false;
    if (this.loginPassword && !this.loginAttempted) return false;
    if (this._countOtherOnlinePlayers() === 0) return false;

    const advCfg = (this.config.bot && this.config.bot.advertise) || {};
    const messages = Array.isArray(advCfg.messages) ? advCfg.messages.filter((m) => typeof m === 'string' && m.trim()) : [];
    if (messages.length === 0) return false;

    let idx = Math.floor(Math.random() * messages.length);
    if (messages.length > 1 && idx === this.lastAdvertiseIndex) {
      idx = (idx + 1 + Math.floor(Math.random() * (messages.length - 1))) % messages.length;
    }
    this.lastAdvertiseIndex = idx;

    let text = messages[idx].replace(/\{name\}/g, this.bot.username || 'me').trim();
    const colorPrefix = typeof advCfg.colorPrefix === 'string' ? advCfg.colorPrefix : '&b';
    if (colorPrefix && !/^&[0-9a-fk-orx]/i.test(text)) {
      text = `${colorPrefix}${text}`;
    }
    this.bot.chat(text);
    this.log(`[ADS] ${text}`);
    return true;
  },

  _handleDuelRequestTrigger(rawText) {
    const text = stripColorCodes(rawText);
    if (!text) return false;

    const botCfg = this.config.bot || {};
    if (botCfg.autoAcceptDuels === false || this.state !== 'IDLE') return false;

    const match = text.match(DUEL_REQUEST_REGEX);
    if (!match || !match[1]) return false;

    const sender = match[1].trim();
    const senderLower = sender.toLowerCase();
    const selfName = ((this.bot && this.bot.username) || botCfg.username || '').toLowerCase();
    if (!sender || senderLower === 'you' || (selfName && senderLower === selfName)) return false;
    if (this._isIgnoredPlayer(sender)) return false;

    const now = Date.now();
    const lastAcceptedAt = this._recentDuelAccepts.get(senderLower) || 0;
    if (now - lastAcceptedAt < 5000) return false;

    if (this._recentDuelAccepts.size > 32) {
      for (const [key, ts] of this._recentDuelAccepts.entries()) {
        if (now - ts >= 5000) this._recentDuelAccepts.delete(key);
      }
    }
    this._recentDuelAccepts.set(senderLower, now);

    const configuredDelay = Number(botCfg.duelAcceptDelayMs);
    const delayMs = Number.isFinite(configuredDelay) && configuredDelay >= 0 ? configuredDelay : 750;

    this._clearDuelAcceptTimer();
    this.duelAcceptTimer = setTimeout(() => {
      this.duelAcceptTimer = null;
      if (this.shuttingDown || !this.bot || this.state !== 'IDLE') return;

      const cmd = `/duel accept ${senderLower}`;
      this.bot.chat(cmd);
      this.pendingDuelTarget = sender;
      this.pendingDuelReady = false;
      this.log(`[DUELS] Accepted duel request from ${sender} -> ${cmd}`);
    }, delayMs);

    return true;
  },

  _handleDuelChatTriggers(rawText) {
    const text = stripColorCodes(rawText);
    if (!text) return;
    const lower = text.toLowerCase();

    if (
      lower.includes('joined ffa') ||
      lower.includes('entered ffa') ||
      lower.includes('warped to ffa') ||
      lower.includes('teleporting to ffa') ||
      lower.includes('welcome to ffa') ||
      lower.includes('ffa arena')
    ) {
      this.inFfaArena = true;
      this.inDuelArena = false;
      this.duelEndedAt = 0;
      return;
    }
    if (
      lower.includes('sent to lobby') ||
      lower.includes('connected to hub') ||
      lower.includes('returned to spawn') ||
      lower.includes('returning to lobby')
    ) {
      this.inFfaArena = false;
      this.inDuelArena = false;
      if (this.redWoolZone) this.redWoolZone.resetHistory();
      return;
    }

    if (this.config.bot.autoStartDuel === false) return;

    if (
      lower.includes('won the duel') ||
      lower.includes('won the match') ||
      lower.includes('won the fight') ||
      lower.includes('lost the fight') ||
      lower.includes('you won the fight') ||
      lower.includes('you lost the fight') ||
      lower.includes('click here to replay') ||
      lower.includes('match ended') ||
      lower.includes('duel ended') ||
      lower.includes('you won!') ||
      lower.includes('you lost!')
    ) {
      this._clearTargetState(true);
      this.duelEndedAt = Date.now();
      if (this.state !== 'IDLE') {
        this.transitionState('IDLE', 'duel ended');
      }
      return;
    }

    if (
      lower.includes('duel has started') ||
      lower.includes('match has started') ||
      lower.includes('the duel begins') ||
      lower.includes('match started') ||
      lower.includes('starting duel') ||
      DUEL_START_CUE_REGEX.test(text)
    ) {
      const now = Date.now();
      if ((now - this.duelEndedAt) < 2000) return;
      if (this._hasLobbyMenuItems()) return;

      this._clearDuelsRejoinTimer('duel started');
      const preferred = this.pendingDuelTarget ? this._findPlayerEntity(this.pendingDuelTarget) : null;
      const nearby = this._listNearbyPlayers();
      const validArena = Boolean(preferred) ||
        this._isWearingCombatArmor() ||
        (nearby.length >= 1 && nearby.length <= 3);
      if (!validArena) return;

      this.inDuelArena = true;
      this.autoStartDuelUntil = now + 12000;
      if (this.pendingDuelTarget) this.pendingDuelReady = true;

      if (this.state === 'IDLE' && this.bot && this.bot.entity) {
        const engageRange = this.config.combat.engageRange || 96.0;
        if (preferred && this.bot.entity.position.distanceTo(preferred.position) <= engageRange) {
          this._engageTarget(preferred, 'duel start cue');
          return;
        }
        if (nearby.length > 0 && nearby[0].dist <= engageRange) {
          this._engageTarget(nearby[0].entity, 'duel start cue');
        }
      }
    }
  }
};

module.exports = {
  duelChatMethods,
  DUEL_REQUEST_REGEX,
  DUEL_START_CUE_REGEX
};
