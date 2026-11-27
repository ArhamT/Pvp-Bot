'use strict';

const { stripColorCodes } = require('./arena_detector');

/**
 * Auth (/login, /register) & Proxy /server Auto-Join / Kick-Rejoin mixin (`modules/controller/auth_proxy.js`).
 * All timers are tracked and cleared cleanly on disconnect/shutdown.
 */
const authProxyMethods = {
  _clearLoginFallbackTimer() {
    if (this.loginFallbackTimer) {
      clearTimeout(this.loginFallbackTimer);
      this.loginFallbackTimer = null;
    }
    if (this.authPromptTimer) {
      clearTimeout(this.authPromptTimer);
      this.authPromptTimer = null;
    }
  },

  _clearDuelsLoginJoinTimer(reason = '') {
    if (this.duelsLoginJoinTimer) {
      clearTimeout(this.duelsLoginJoinTimer);
      this.duelsLoginJoinTimer = null;
      if (reason) {
        this.log(`[DUELS] Cancelled auto-join /server timer (${reason}).`);
      }
    }
  },

  _clearDuelsRejoinTimer(reason = '') {
    if (this.duelsRejoinTimer) {
      clearTimeout(this.duelsRejoinTimer);
      this.duelsRejoinTimer = null;
      if (reason) {
        this.log(`[DUELS] Cancelled pending /server rejoin (${reason}).`);
      }
    }
  },

  _scheduleDuelsLoginJoin(reason = 'login') {
    const botCfg = this.config.bot || {};
    if (botCfg.autoJoinDuelsOnLogin === false) return false;
    if (this.shuttingDown || !this.bot || this.duelsLoginJoinDone || this.duelsLoginJoinTimer) {
      return false;
    }

    const duelsServer = (botCfg.duelsServerName || 'duels').trim() || 'duels';
    const configuredDelay = Number(botCfg.duelsLoginJoinDelayMs);
    const delayMs = Number.isFinite(configuredDelay) && configuredDelay >= 0 ? configuredDelay : 15000;

    this.log(`[DUELS] Auto-joining /server ${duelsServer} in ${(delayMs / 1000).toFixed(1)}s (${reason}).`);
    this.duelsLoginJoinTimer = setTimeout(() => {
      this.duelsLoginJoinTimer = null;
      if (this.shuttingDown || !this.bot || this.duelsLoginJoinDone) return;

      this.duelsLoginJoinDone = true;
      const cmd = `/server ${duelsServer}`;
      this.lastDuelsRejoinSentAt = Date.now();
      this.bot.chat(cmd);
      this.log(`[DUELS] Auto-joined ${cmd} after proxy login.`);
    }, delayMs);
    return true;
  },

  _sendLoginCommand(mode = 'login', reason = '') {
    if (!this.bot || !this.loginPassword) return false;
    this._clearLoginFallbackTimer();
    this.loginAttempted = true;
    this.loginSentAt = Date.now();

    if (mode === 'register') {
      this.bot.chat(`/register ${this.loginPassword} ${this.loginPassword}`);
      this.log(`[AUTH] Sent /register ******** ********${reason ? ` (${reason})` : ''}`);
    } else {
      this.bot.chat(`/login ${this.loginPassword}`);
      this.log(`[AUTH] Sent /login ********${reason ? ` (${reason})` : ''}`);
    }
    this._scheduleDuelsLoginJoin(mode);
    return true;
  },

  _handleServerAuthPrompt(text) {
    const lower = text.toLowerCase();

    if (
      lower.includes('successfully logged') ||
      lower.includes('logged in') ||
      lower.includes('successfully authenticated') ||
      lower.includes('already logged in')
    ) {
      this.loginAttempted = true;
      this._clearLoginFallbackTimer();
      this._scheduleDuelsLoginJoin('authenticated');
      return;
    }

    if (!this.loginPassword || this.loginAttempted) return;

    if (lower.includes('/register') || lower.includes('please register')) {
      this._clearLoginFallbackTimer();
      this.loginAttempted = true;
      this.authPromptTimer = setTimeout(() => {
        this.authPromptTimer = null;
        if (this.bot && !this.shuttingDown) this._sendLoginCommand('register', 'server prompt');
      }, 900);
    } else if (
      lower.includes('/login') ||
      lower.includes('please login') ||
      lower.includes('log in with')
    ) {
      this._clearLoginFallbackTimer();
      this.loginAttempted = true;
      this.authPromptTimer = setTimeout(() => {
        this.authPromptTimer = null;
        if (this.bot && !this.shuttingDown) this._sendLoginCommand('login', 'server prompt');
      }, 900);
    }
  },

  _handleDuelsRejoinTrigger(rawText) {
    const text = stripColorCodes(rawText);
    if (!text) return false;

    const botCfg = this.config.bot || {};
    if (botCfg.autoRejoinDuels === false) return false;

    const duelsServer = (botCfg.duelsServerName || 'duels').trim() || 'duels';
    const duelsLower = duelsServer.toLowerCase();
    const lower = text.toLowerCase();

    if (
      !lower.includes('disconnected') &&
      !lower.includes('unable to') &&
      !lower.includes('kicked') &&
      (
        lower.includes(`already connected to ${duelsLower}`) ||
        lower.includes('already connected to this server') ||
        lower.includes(`connected to ${duelsLower}`) ||
        lower.includes(`welcome to ${duelsLower}`)
      )
    ) {
      this._clearDuelsRejoinTimer(`already on ${duelsServer}`);
      this.duelsLoginJoinDone = true;
      this._clearDuelsLoginJoinTimer(`already on ${duelsServer}`);
      return false;
    }

    const escapedServer = duelsLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const mentionsDuels = new RegExp(`\\b${escapedServer}\\b`, 'i').test(text);
    const hasReason = /\breason\s*:|kicked\s+(?:from|for|by)|too many packets|disconnected\s+from|connection\s+lost|timed\s+out/i.test(text);

    const isDirectDuelsKick =
      lower.includes(`disconnected from ${duelsLower}`) ||
      lower.includes(`kicked from ${duelsLower}`) ||
      lower.includes(`unable to connect to ${duelsLower}`);

    const isGenericKickOrLobby =
      lower.includes('you were kicked from') ||
      ((lower.includes('sent to lobby') || lower.includes('moved to lobby') || lower.includes('connected to hub')) &&
        (mentionsDuels || hasReason));

    if (!isDirectDuelsKick && !isGenericKickOrLobby) return false;

    this._clearTargetState(true);
    this.duelEndedAt = Date.now();
    this._clearDuelAcceptTimer();
    this.transitionState('IDLE', 'kicked from duels');

    const configuredDelay = Number(botCfg.duelsRejoinDelayMs);
    const delayMs = Number.isFinite(configuredDelay) && configuredDelay >= 0 ? configuredDelay : 15000;

    const now = Date.now();
    const sinceLast = this.lastDuelsRejoinSentAt > 0 ? (now - this.lastDuelsRejoinSentAt) : Infinity;
    const waitMs = sinceLast < delayMs ? Math.max(1000, delayMs - sinceLast) : delayMs;

    this._clearDuelsRejoinTimer();
    this.log(`[DUELS] Detected kick/disconnect from ${duelsServer} — scheduling /server ${duelsServer} in ${(waitMs / 1000).toFixed(1)}s.`);
    this.duelsRejoinTimer = setTimeout(() => {
      this.duelsRejoinTimer = null;
      if (this.shuttingDown || !this.bot || this.state !== 'IDLE') return;

      const elapsed = this.lastDuelsRejoinSentAt > 0 ? (Date.now() - this.lastDuelsRejoinSentAt) : Infinity;
      if (elapsed < Math.max(0, delayMs - 20)) return;

      this.lastDuelsRejoinSentAt = Date.now();
      const cmd = `/server ${duelsServer}`;
      this.bot.chat(cmd);
      this.log(`[DUELS] Rejoining ${cmd}...`);
    }, waitMs);

    return true;
  }
};

module.exports = { authProxyMethods };
