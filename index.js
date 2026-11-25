'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const mineflayer = require('mineflayer');
const { Vec3 } = require('vec3');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { loader: autoEatLoader } = require('mineflayer-auto-eat');
const armorManager = require('mineflayer-armor-manager');

const { SmoothAimer, normalizeAngle } = require('./modules/aim');
const { PredictionModule } = require('./modules/prediction');
const { CombatModule } = require('./modules/combat');
const { SurvivalModule } = require('./modules/survival');
const { RangedModule } = require('./modules/ranged');
const { BurstModule } = require('./modules/burst');
const { AerialModule } = require('./modules/aerial');

const STATES = Object.freeze({
  IDLE: 'IDLE',
  ENGAGING: 'ENGAGING',
  RETREATING: 'RETREATING',
  HEALING: 'HEALING',
  LOOTING: 'LOOTING'
});

const DUEL_REQUEST_REGEX = /(?:^|[\s•|:\]>»-])([A-Za-z0-9_]{3,16})\s+(?:has\s+sent(?:\s+you)?\s+a\s+duel\s+request|sent(?:\s+you)?\s+a\s+duel\s+request|challenged\s+you\s+to\s+a\s+duel)/i;
const DUEL_START_CUE_REGEX = /(?:^|[\s•|:\]>»-])(?:go!+|fight!+)(?:$|[\s!.,])/i;

/**
 * Strips legacy Minecraft color/formatting codes (§x / &x) and trims whitespace.
 */
function stripColorCodes(text) {
  if (!text) return '';
  return String(text).replace(/§.|&[0-9a-fk-orx]/gi, '').trim();
}

const CONFIG_PATH = path.join(__dirname, 'config.json');
const baseConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

/**
 * Builds runtime configuration by layering environment variables (set by start.bat or shell)
 * over config.json without modifying config.json on disk.
 */
function loadRuntimeConfig(baseCfg, env = process.env) {
  const cfg = JSON.parse(JSON.stringify(baseCfg));

  if (env.PVPBOT_USERNAME && env.PVPBOT_USERNAME.trim()) {
    cfg.bot.username = env.PVPBOT_USERNAME.trim();
  }

  if (env.PVPBOT_OWNER && env.PVPBOT_OWNER.trim()) {
    cfg.bot.owner = env.PVPBOT_OWNER.trim();
  }

  if (env.PVPBOT_HOST && env.PVPBOT_HOST.trim()) {
    const rawHost = env.PVPBOT_HOST.trim();
    const colonIdx = rawHost.lastIndexOf(':');
    if (colonIdx > 0 && rawHost.indexOf(':') === colonIdx) {
      const hostPart = rawHost.slice(0, colonIdx).trim();
      const portPart = parseInt(rawHost.slice(colonIdx + 1).trim(), 10);
      if (hostPart) cfg.server.host = hostPart;
      if (!Number.isNaN(portPart) && portPart > 0 && portPart <= 65535) {
        cfg.server.port = portPart;
      }
    } else {
      cfg.server.host = rawHost;
    }
  }

  if (env.PVPBOT_PORT && env.PVPBOT_PORT.trim()) {
    const parsedPort = parseInt(env.PVPBOT_PORT.trim(), 10);
    if (!Number.isNaN(parsedPort) && parsedPort > 0 && parsedPort <= 65535) {
      cfg.server.port = parsedPort;
    }
  }

  if (env.PVPBOT_AUTH && env.PVPBOT_AUTH.trim()) {
    cfg.server.auth = env.PVPBOT_AUTH.trim();
  }

  if (env.PVPBOT_VERSION !== undefined && env.PVPBOT_VERSION.trim() !== '') {
    const ver = env.PVPBOT_VERSION.trim().toLowerCase();
    cfg.server.version = (ver === 'auto' || ver === 'false') ? false : env.PVPBOT_VERSION.trim();
  }

  return cfg;
}

const config = loadRuntimeConfig(baseConfig);

class PvPBotController {
  constructor(cfg, options = {}) {
    this.config = cfg;
    this.loginPassword = options.loginPassword !== undefined
      ? options.loginPassword
      : (process.env.PVPBOT_PASSWORD || '');

    this.bot = null;
    this.aimer = null;
    this.prediction = null;
    this.combat = null;
    this.survival = null;
    this.ranged = null;
    this.burst = null;
    this.aerial = null;

    this.state = STATES.IDLE;
    this.activeTargetName = null;
    this.activeTargetEntityId = null;
    this.targetLastSeenPos = null;
    this.targetLostAt = 0;
    this.pendingDuelTarget = null;
    this.pendingDuelReady = false;
    this.autoStartDuelUntil = 0;
    this.duelEndedAt = 0;
    this.inDuelArena = false;
    this.autoFight = false;
    this.lastKnownHealth = 20;
    this.lootStartedAt = 0;

    // Gentle casual spawn roaming state while IDLE in spawn/lobby
    this.roamInSpawn = cfg.bot ? cfg.bot.roamInSpawn !== false : true;
    this.spawnAnchorPos = null;
    this.roamPhase = 'PAUSED'; // 'PAUSED' | 'WALKING'
    this.roamPhaseUntil = 0;
    this.roamTargetPos = null;
    this.roamLastLookAt = 0;
    this.roamNextGlanceAt = 0;
    this.roamGlanceYaw = 0;
    this.roamGlancePitch = 0;

    // Random "duel me, I'm a bot" spawn advertisement state
    const advCfg = (cfg.bot && cfg.bot.advertise) || {};
    this.advertiseEnabled = advCfg.enabled !== false;
    this.advertiseTimer = null;
    this.lastAdvertiseIndex = -1;
    this.initializedOnSpawn = false;
    this.loginAttempted = false;
    this.loginSentAt = 0;
    this.loginFallbackTimer = null;
    this.duelsLoginJoinTimer = null;
    this.duelsLoginJoinDone = false;
    this.duelsRejoinTimer = null;
    this.lastDuelsRejoinSentAt = 0;
    this.duelAcceptTimer = null;
    this._recentDuelAccepts = new Map();
    this._physicsTickHandler = null;
    this._packetTimestamps = [];

    this.rl = null;
    this.tickTimer = null;
    this.reconnectTimer = null;
    this.reconnectDelayMs = cfg.bot.reconnect.initialDelayMs || 5000;
    this.shuttingDown = false;
  }

  log(message) {
    const ts = new Date().toISOString().split('T')[1].slice(0, 8);
    const line = `[${ts}] [${this.state}] ${message}`;
    if (this.rl && process.stdout.isTTY) {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      console.log(line);
      this.rl.prompt(true);
    } else {
      console.log(line);
    }
  }

  start() {
    if (this.shuttingDown) return;
    this._clearTimers();

    const serverCfg = this.config.server;
    const botCfg = this.config.bot;

    this.log(`Connecting to ${serverCfg.host}:${serverCfg.port} as ${botCfg.username}...`);

    const botOptions = {
      host: serverCfg.host,
      port: serverCfg.port,
      username: botCfg.username,
      auth: serverCfg.auth || 'offline'
    };
    if (serverCfg.version) {
      botOptions.version = serverCfg.version;
    }

    this.bot = mineflayer.createBot(botOptions);
    this._attachPacketMonitor(this.bot);

    // Load Mineflayer plugins (mineflayer-pvp's static getAttackSpeed is used directly in combat.js)
    this.bot.loadPlugin(pathfinder);
    this.bot.loadPlugin(autoEatLoader);
    this.bot.loadPlugin(armorManager);

    this._bindEvents();
  }

  _attachPacketMonitor(bot) {
    if (!bot || !bot._client || typeof bot._client.write !== 'function') return;
    const origWrite = bot._client.write.bind(bot._client);
    bot._client.write = (...args) => {
      const now = Date.now();
      this._packetTimestamps.push(now);
      if (this._packetTimestamps.length > 200) {
        this._packetTimestamps = this._packetTimestamps.filter((t) => (now - t) <= 1000);
      }
      return origWrite(...args);
    };
  }

  getOutgoingPacketRate() {
    const now = Date.now();
    this._packetTimestamps = this._packetTimestamps.filter((t) => (now - t) <= 1000);
    return this._packetTimestamps.length;
  }

  _bindEvents() {
    const bot = this.bot;
    this.initializedOnSpawn = false;
    this.loginAttempted = false;
    this.loginSentAt = 0;
    this.duelsLoginJoinDone = false;

    bot.on('spawn', () => {
      this.reconnectDelayMs = this.config.bot.reconnect.initialDelayMs || 5000;

      // Configure anticheat-safe pathfinder movements (re-applied on backend server transfers)
      const movements = new Movements(bot);
      movements.canDig = false;
      movements.allow1by1towers = false;
      movements.allowParkour = false;
      movements.allowSprinting = true;
      bot.pathfinder.setMovements(movements);

      if (!this.initializedOnSpawn) {
        this.initializedOnSpawn = true;
        this.log(`Spawned in world at ${bot.entity.position.floored()}.`);

        // Instantiate modular subsystems once per connection
        this.aimer = new SmoothAimer(bot, this.config.physics);
        this.prediction = new PredictionModule(bot, this.config);
        this.ranged = new RangedModule(bot, this.config, this.aimer, this.prediction);
        this.combat = new CombatModule(bot, this.config, this.aimer, this.ranged, this.prediction);
        this.survival = new SurvivalModule(bot, this.config, this.aimer);
        this.burst = new BurstModule(bot, this.config, this.aimer, this.prediction, this.combat);
        this.aerial = new AerialModule(bot, this.config, this.aimer, this.prediction, this.combat);

        this.survival.configureAutoEat();
        // Stay completely quiet in IDLE lobbies (no locked-inventory clicks or auto-eat spam)
        this.survival.setCombatActive(false);
        this.survival.setAutoEatEnabled(false);

        // Passive read-only hotbar scan (sends zero packets)
        this.combat.scanHotbarSlots();

        this.spawnAnchorPos = bot.entity.position.clone();
        this._resetSpawnRoam();
        this.transitionState(STATES.IDLE, 'initial spawn');
        this._startTickLoop();
        this._scheduleAdvertise();

        // Fallback cracked-server /login if server prompts via Title/ActionBar instead of chat
        if (this.loginPassword) {
          this._clearLoginFallbackTimer();
          this.loginFallbackTimer = setTimeout(() => {
            if (this.bot && !this.loginAttempted) {
              this._sendLoginCommand('login', 'spawn fallback');
            }
          }, 3000);
        } else {
          // Proxy / auto-login hub with no password prompt: auto-join /server duels after proxy settle delay
          this._scheduleDuelsLoginJoin('initial spawn');
        }
      } else {
        // Backend server transfer (e.g. /server duels) or arena teleport:
        // Stay quiet in IDLE so locked lobby GUI items never trigger packet-rate kicks,
        // and never attack players in spawn after a duel ends.
        this.duelsLoginJoinDone = true;
        this._clearDuelsLoginJoinTimer('server/world switch');
        this.log(`Switched world/server — spawned at ${bot.entity.position.floored()}.`);
        this.activeTargetName = null;
        this.activeTargetEntityId = null;
        this.targetLastSeenPos = null;
        this.targetLostAt = 0;
        this.spawnAnchorPos = bot.entity.position.clone();
        this._resetSpawnRoam();

        const recentlyEndedDuel = (Date.now() - this.duelEndedAt) < 10000;
        const nearbyCount = this._listNearbyPlayers().length;
        const wearingArmor = this._isWearingCombatArmor();

        if (recentlyEndedDuel || nearbyCount >= 4) {
          this.pendingDuelTarget = null;
          this.pendingDuelReady = false;
          this.autoStartDuelUntil = 0;
          this.inDuelArena = false;
        } else {
          if (this.pendingDuelTarget && (wearingArmor || (nearbyCount >= 1 && nearbyCount <= 2))) {
            this.pendingDuelReady = true;
            this.inDuelArena = true;
          } else {
            this.pendingDuelReady = false;
          }
          if (this.config.bot.autoStartDuel !== false && wearingArmor && nearbyCount <= 3) {
            this.autoStartDuelUntil = Date.now() + 15000;
            this.inDuelArena = true;
          }
        }
        this.lastKnownHealth = typeof bot.health === 'number' ? bot.health : 20;
        if (this.prediction) this.prediction.clear();
        if (this.survival) {
          this.survival.setCombatActive(false);
          this.survival.setAutoEatEnabled(false);
        }
        this.transitionState(STATES.IDLE, 'world/server switch');
        if (this.combat) this.combat.scanHotbarSlots();
      }
    });

    // Auto-retaliate when taking damage in a PvP arena while IDLE (safe lobbies never deal damage)
    bot.on('entityHurt', (entity) => {
      if (!this.bot || !this.bot.entity || !entity) return;
      if (entity.id === this.bot.entity.id && this.state === STATES.IDLE) {
        this._tryAutoRetaliate('entityHurt');
      }
    });

    bot.on('health', () => {
      if (!this.bot || typeof this.bot.health !== 'number') return;
      const tookDamage = this.bot.health < this.lastKnownHealth;
      this.lastKnownHealth = this.bot.health;
      if (tookDamage && this.state === STATES.IDLE) {
        this._tryAutoRetaliate('damage taken');
      }
    });

    bot.on('messagestr', (message) => {
      const text = stripColorCodes(message);
      if (!text) return;
      this.log(`[CHAT] ${text}`);
      this._handleServerAuthPrompt(text);
      this._handleDuelsRejoinTrigger(text);
      this._handleDuelRequestTrigger(text);
      this._handleDuelChatTriggers(text);
    });

    bot.on('chat', (username, message) => {
      this._handleChat(username, message);
    });

    bot.on('death', () => {
      this.log('Bot died. Resetting state to IDLE.');
      this.activeTargetName = null;
      this.activeTargetEntityId = null;
      this.pendingDuelTarget = null;
      this.pendingDuelReady = false;
      this.autoStartDuelUntil = 0;
      this.inDuelArena = false;
      this.duelEndedAt = Date.now();
      this.transitionState(STATES.IDLE, 'death');
    });

    bot.on('respawn', () => {
      this.log('Respawned. Ready in IDLE (use !kit, !sort, or !duel when in arena).');
      this.inDuelArena = false;
      this.autoStartDuelUntil = 0;
      this.pendingDuelReady = false;
      if (this.bot && this.bot.entity && this.bot.entity.position) {
        this.spawnAnchorPos = this.bot.entity.position.clone();
        this._resetSpawnRoam();
      }
      if (this.survival) this.survival.setCombatActive(false);
      if (this.combat) this.combat.scanHotbarSlots();
    });

    bot.on('kicked', (reason) => {
      this.log(`Kicked from server: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`);
    });

    bot.on('error', (err) => {
      this.log(`Bot error: ${err.message}`);
    });

    bot.on('end', (reason) => {
      this.log(`Disconnected (${reason || 'unknown'}).`);
      this._stopTickLoop();
      this._clearLoginFallbackTimer();
      this._clearDuelsLoginJoinTimer('disconnected');
      this._clearDuelsRejoinTimer('disconnected');
      this._clearDuelAcceptTimer();
      this._clearAdvertiseTimer();
      if (this.combat) this.combat.dispose();
      if (this.survival) this.survival.dispose();
      if (this.ranged) this.ranged.dispose();
      if (this.burst) this.burst.dispose();
      if (this.aerial) this.aerial.dispose();
      if (this.prediction) this.prediction.clear();
      this.bot = null;
      this._scheduleReconnect();
    });
  }

  _clearLoginFallbackTimer() {
    if (this.loginFallbackTimer) {
      clearTimeout(this.loginFallbackTimer);
      this.loginFallbackTimer = null;
    }
  }

  _clearDuelsLoginJoinTimer(reason = '') {
    if (this.duelsLoginJoinTimer) {
      clearTimeout(this.duelsLoginJoinTimer);
      this.duelsLoginJoinTimer = null;
      if (reason) {
        this.log(`[DUELS] Cancelled auto-join /server timer (${reason}).`);
      }
    }
  }

  /**
   * Automatically transfers from the proxy hub to /server duels after logging in
   * (waiting duelsLoginJoinDelayMs, default 15s, so chunk loading & handshake complete cleanly).
   */
  _scheduleDuelsLoginJoin(reason = 'login') {
    const botCfg = this.config.bot || {};
    if (botCfg.autoJoinDuelsOnLogin === false) return false;
    if (this.shuttingDown || !this.bot || this.duelsLoginJoinDone || this.duelsLoginJoinTimer) {
      return false;
    }

    const duelsServer = (botCfg.duelsServerName || 'duels').trim() || 'duels';
    const configuredDelay = Number(botCfg.duelsLoginJoinDelayMs);
    const delayMs = Number.isFinite(configuredDelay) && configuredDelay >= 0
      ? configuredDelay
      : 15000;

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
  }

  _clearDuelsRejoinTimer(reason = '') {
    if (this.duelsRejoinTimer) {
      clearTimeout(this.duelsRejoinTimer);
      this.duelsRejoinTimer = null;
      if (reason) {
        this.log(`[DUELS] Cancelled pending /server rejoin (${reason}).`);
      }
    }
  }

  _clearDuelAcceptTimer() {
    if (this.duelAcceptTimer) {
      clearTimeout(this.duelAcceptTimer);
      this.duelAcceptTimer = null;
    }
  }

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
  }

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
      setTimeout(() => {
        if (this.bot) this._sendLoginCommand('register', 'server prompt');
      }, 900);
    } else if (
      lower.includes('/login') ||
      lower.includes('please login') ||
      lower.includes('log in with')
    ) {
      this._clearLoginFallbackTimer();
      this.loginAttempted = true;
      setTimeout(() => {
        if (this.bot) this._sendLoginCommand('login', 'server prompt');
      }, 900);
    }
  }

  _isWearingCombatArmor() {
    if (!this.bot || !this.bot.inventory || !this.bot.inventory.slots) return false;
    for (const slot of [5, 6, 7, 8]) {
      const item = this.bot.inventory.slots[slot];
      if (item && item.name && (
        item.name.endsWith('_helmet') ||
        item.name.endsWith('_chestplate') ||
        item.name.endsWith('_leggings') ||
        item.name.endsWith('_boots') ||
        item.name === 'elytra'
      )) {
        return true;
      }
    }
    return false;
  }

  /**
   * Detects proxy/network kicks from the duels backend server (e.g. LEGOCRAFT packet-rate kicks)
   * and schedules a single debounced /server <duelsServerName> rejoin after proxy settlement delay.
   */
  _handleDuelsRejoinTrigger(rawText) {
    const text = stripColorCodes(rawText);
    if (!text) return false;

    const botCfg = this.config.bot || {};
    if (botCfg.autoRejoinDuels === false) return false;

    const duelsServer = (botCfg.duelsServerName || 'duels').trim() || 'duels';
    const duelsLower = duelsServer.toLowerCase();
    const lower = text.toLowerCase();

    // Cancel pending rejoin if chat confirms we entered or are already on the duels server
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

    // Reset combat cleanly before waiting for proxy settlement
    this.activeTargetName = null;
    this.activeTargetEntityId = null;
    this.targetLastSeenPos = null;
    this.targetLostAt = 0;
    this.pendingDuelTarget = null;
    this.pendingDuelReady = false;
    this.autoStartDuelUntil = 0;
    this.inDuelArena = false;
    this.duelEndedAt = Date.now();
    this._clearDuelAcceptTimer();
    this.transitionState(STATES.IDLE, 'kicked from duels');

    const configuredDelay = Number(botCfg.duelsRejoinDelayMs);
    const delayMs = Number.isFinite(configuredDelay) && configuredDelay >= 0
      ? configuredDelay
      : 15000;

    // Rate-limit / backoff guard: never fire more than once every duelsRejoinDelayMs
    const now = Date.now();
    const sinceLast = this.lastDuelsRejoinSentAt > 0 ? (now - this.lastDuelsRejoinSentAt) : Infinity;
    const waitMs = sinceLast < delayMs ? Math.max(delayMs, delayMs - sinceLast) : delayMs;

    // Single debounced timer
    if (this.duelsRejoinTimer) {
      clearTimeout(this.duelsRejoinTimer);
      this.duelsRejoinTimer = null;
    }

    this.log(`[DUELS] Detected kick/disconnect from ${duelsServer} — scheduling /server ${duelsServer} in ${(waitMs / 1000).toFixed(1)}s.`);
    this.duelsRejoinTimer = setTimeout(() => {
      this.duelsRejoinTimer = null;
      if (this.shuttingDown || !this.bot) return;
      if (this.state !== STATES.IDLE) return;

      const elapsed = this.lastDuelsRejoinSentAt > 0 ? (Date.now() - this.lastDuelsRejoinSentAt) : Infinity;
      const minInterval = Math.max(0, delayMs - 20);
      if (elapsed < minInterval) return;

      this.lastDuelsRejoinSentAt = Date.now();
      const cmd = `/server ${duelsServer}`;
      this.bot.chat(cmd);
      this.log(`[DUELS] Rejoining ${cmd}...`);
    }, waitMs);

    return true;
  }

  /**
   * Detects incoming duel request chat messages and automatically sends /duel accept <sender>
   * after a short human-like delay while arming pendingDuelTarget for arena auto-engage.
   */
  _handleDuelRequestTrigger(rawText) {
    const text = stripColorCodes(rawText);
    if (!text) return false;

    const botCfg = this.config.bot || {};
    if (botCfg.autoAcceptDuels === false) return false;
    if (this.state !== STATES.IDLE) return false;

    const match = text.match(DUEL_REQUEST_REGEX);
    if (!match || !match[1]) return false;

    const sender = match[1].trim();
    const senderLower = sender.toLowerCase();
    const selfName = ((this.bot && this.bot.username) || botCfg.username || '').toLowerCase();

    if (!sender || senderLower === 'you' || (selfName && senderLower === selfName)) {
      return false;
    }

    const now = Date.now();
    const lastAcceptedAt = this._recentDuelAccepts.get(senderLower) || 0;
    if (now - lastAcceptedAt < 5000) {
      return false;
    }

    if (this._recentDuelAccepts.size > 32) {
      for (const [key, ts] of this._recentDuelAccepts.entries()) {
        if (now - ts >= 5000) this._recentDuelAccepts.delete(key);
      }
    }
    this._recentDuelAccepts.set(senderLower, now);

    const configuredDelay = Number(botCfg.duelAcceptDelayMs);
    const delayMs = Number.isFinite(configuredDelay) && configuredDelay >= 0
      ? configuredDelay
      : 750;

    this._clearDuelAcceptTimer();
    this.duelAcceptTimer = setTimeout(() => {
      this.duelAcceptTimer = null;
      if (this.shuttingDown || !this.bot) return;
      if (this.state !== STATES.IDLE) return;

      const cmd = `/duel accept ${senderLower}`;
      this.bot.chat(cmd);
      this.pendingDuelTarget = sender;
      this.pendingDuelReady = false; // Wait for arena teleport or "GO!" cue — never attack challenger in spawn!
      this.log(`[DUELS] Accepted duel request from ${sender} -> ${cmd}`);
    }, delayMs);

    return true;
  }

  /**
   * Detects server duel start / match end chat announcements so the bot engages
   * immediately when a duel starts (without waiting to be hit first) and stops cleanly on win/loss.
   */
  _handleDuelChatTriggers(rawText) {
    const text = stripColorCodes(rawText);
    if (!text || this.config.bot.autoStartDuel === false) return;
    const lower = text.toLowerCase();

    // Match end -> stop fighting cleanly and clear pending duel flags so we don't fight in spawn!
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
      this.activeTargetName = null;
      this.activeTargetEntityId = null;
      this.targetLastSeenPos = null;
      this.targetLostAt = 0;
      this.pendingDuelTarget = null;
      this.pendingDuelReady = false;
      this.autoStartDuelUntil = 0;
      this.inDuelArena = false;
      this.duelEndedAt = Date.now();
      if (this.state !== STATES.IDLE) {
        this.transitionState(STATES.IDLE, 'duel ended');
      }
      return;
    }

    // Match start -> immediately arm and engage nearest opponent (never within 2s after match end or in crowded hubs)
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

      if (this.state === STATES.IDLE && this.bot && this.bot.entity) {
        const engageRange = this.config.combat.engageRange || 36.0;
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

  _isAuthorized(username) {
    if (!username || !this.bot || username === this.bot.username) return false;
    const owner = this.config.bot.owner;
    if (!owner || owner === '*') return true;
    return username.toLowerCase() === owner.toLowerCase();
  }

  _handleChat(username, rawMessage) {
    if (!this._isAuthorized(username)) return;

    const prefix = this.config.bot.commandPrefix || '!';
    const message = rawMessage.trim();
    if (!message.startsWith(prefix)) return;

    const args = message.slice(prefix.length).trim().split(/\s+/);
    const command = (args.shift() || '').toLowerCase();
    this.executeBotCommand(command, args, username, (reply) => {
      if (this.bot) this.bot.chat(reply);
    });
  }

  /**
   * Executes internal bot commands from either in-game owner chat or the interactive console.
   */
  executeBotCommand(command, args = [], caller = 'console', reply = (msg) => this.log(msg)) {
    if (command === 'help') {
      reply(
        'Commands: /<any server cmd> | <chat> | !duel [player] | !auto | !roam | !ads | !stop | !kit [name] | !sort | !players | !status | !debug | !login | !quit'
      );
      return;
    }

    if (command === 'quit' || command === 'exit') {
      reply('Shutting down bot...');
      this.shutdown();
      process.exit(0);
      return;
    }

    if (!this.bot) {
      reply('Bot is not connected yet.');
      return;
    }

    if (command === 'login') {
      if (!this.loginPassword) {
        reply('No login password configured. Type /login <password> directly.');
      } else {
        this._sendLoginCommand('login', 'manual console command');
      }
      return;
    }

    if (command === 'players') {
      const nearby = this._listNearbyPlayers();
      if (nearby.length === 0) {
        reply('No other visible players nearby.');
      } else {
        reply('Nearby players: ' + nearby.map((p) => `${p.username} (${p.dist.toFixed(1)}b)`).join(', '));
      }
      return;
    }

    if (command === 'status') {
      const pos = this.bot.entity ? this.bot.entity.position.floored() : 'N/A';
      const offhand = this.survival ? this.survival.getOffhandItem() : null;
      const slots = this.combat ? this.combat.getHotbarSlots() : null;
      reply(
        `State=${this.state} HP=${(this.bot.health || 0).toFixed(1)} Food=${this.bot.food || 0} ` +
        `Pos=${pos} Target=${this.activeTargetName || 'none'} ` +
        `Offhand=${offhand ? offhand.name : 'empty'} ` +
        `BreachSlot=${slots ? slots.breachMaceSlot : -1} Pkt/s=${this.getOutgoingPacketRate()}`
      );
      return;
    }

    if (command === 'sort') {
      if (!this.survival) {
        reply('Survival module not initialized yet.');
        return;
      }
      const wasActive = this.survival.activeInCombat;
      this.survival.setCombatActive(true);
      this.survival.autoEquipAndSort()
        .then(() => {
          if (this.combat) this.combat.scanHotbarSlots();
          if (!wasActive && this.state === STATES.IDLE) {
            this.survival.setCombatActive(false);
          }
          reply('Armor equipped, hotbar sorted, and offhand checked.');
        })
        .catch((err) => {
          reply(`Sort warning: ${err.message}`);
        });
      return;
    }

    if (command === 'auto') {
      this.autoFight = !this.autoFight;
      reply(`Auto-engage mode: ${this.autoFight ? 'ON (will automatically attack nearest player in range)' : 'OFF'}.`);
      return;
    }

    if (command === 'roam') {
      this.roamInSpawn = !this.roamInSpawn;
      if (!this.roamInSpawn && this.state === STATES.IDLE) {
        this._stopSpawnRoam();
      } else if (this.roamInSpawn && this.bot && this.bot.entity && this.bot.entity.position) {
        this.spawnAnchorPos = this.bot.entity.position.clone();
        this._resetSpawnRoam();
      }
      reply(`Spawn roaming: ${this.roamInSpawn ? 'ON' : 'OFF'}.`);
      return;
    }

    if (command === 'ads') {
      this.advertiseEnabled = !this.advertiseEnabled;
      if (this.advertiseEnabled) {
        this._scheduleAdvertise();
      } else {
        this._clearAdvertiseTimer();
      }
      reply(`Duel advertisement messages: ${this.advertiseEnabled ? 'ON (every 1-3min while players are online)' : 'OFF'}.`);
      return;
    }

    if (command === 'debug') {
      const target = this._resolveActiveTarget();
      const dist = (target && this.bot.entity)
        ? this.bot.entity.position.distanceTo(target.position).toFixed(2) + 'b'
        : 'N/A';
      const ctrlState = this.bot.controlState
        ? Object.entries(this.bot.controlState).filter(([, v]) => v).map(([k]) => k).join(',') || 'none'
        : 'N/A';
      const pots = this.survival && typeof this.survival.getPotionInventorySummary === 'function'
        ? this.survival.getPotionInventorySummary()
        : [];
      const potCounts = {};
      for (const p of pots) {
        const tag = `${p.name === 'splash_potion' ? 'sp' : 'dr'}:${p.cls}`;
        potCounts[tag] = (potCounts[tag] || 0) + 1;
      }
      const potSummary = Object.entries(potCounts).map(([k, v]) => `${k}x${v}`).join(',') || 'none';
      const aerialInfo = this.aerial ? `${this.aerial.mode}/${this.aerial.stage || '-'}` : 'off';
      reply(
        `[DEBUG] State=${this.state} Target=${this.activeTargetName || 'none'} (found=${Boolean(target)}, dist=${dist}) ` +
        `Auto=${this.autoFight} PendingDuel=${this.pendingDuelTarget || 'none'} Controls=[${ctrlState}] ` +
        `Aerial=${aerialInfo} Pots=[${potSummary}] ` +
        `Busy(aerial=${this.aerial ? this.aerial.isBusy() : false}, burst=${this.burst ? this.burst.isBusy() : false}, ranged=${this.ranged ? this.ranged.isBusy() : false}, shield=${this.survival ? this.survival.isShielding : false}) ` +
        `Pkt/s=${this.getOutgoingPacketRate()}`
      );
      return;
    }

    if (command === 'duel') {
      const requested = args[0] || (caller !== 'console' ? caller : null);
      let target = requested ? this._findPlayerEntity(requested) : null;

      if (!target && !requested) {
        const nearby = this._listNearbyPlayers();
        if (nearby.length > 0) target = nearby[0].entity;
      }

      if (!target) {
        if (requested) {
          this.pendingDuelTarget = requested;
          this.pendingDuelReady = true;
          reply(`Player "${requested}" not visible yet — armed pending duel target (will auto-engage as soon as they appear in range).`);
        } else {
          this.autoFight = true;
          reply('No nearby player visible yet — enabled !auto mode (will auto-engage nearest player once arena loads).');
        }
        return;
      }

      this._engageTarget(target, `!duel ${target.username}`, reply);
      return;
    }

    if (command === 'stop') {
      this.activeTargetName = null;
      this.activeTargetEntityId = null;
      this.pendingDuelTarget = null;
      this.pendingDuelReady = false;
      this.autoFight = false;
      this.transitionState(STATES.IDLE, '!stop command');
      reply('Stopped combat, disabled !auto, and returned to IDLE.');
      return;
    }

    if (command === 'kit') {
      const customKit = args[0];
      const kitCmd = customKit ? `/kit ${customKit}` : (this.config.bot.kitCommand || '/kit pvp');
      this.bot.chat(kitCmd);
      this.log(`Requested kit via "${kitCmd}".`);

      setTimeout(async () => {
        if (!this.bot || !this.survival) return;
        const wasActive = this.survival.activeInCombat;
        this.survival.setCombatActive(true);
        try {
          await this.survival.autoEquipAndSort();
          if (this.combat) this.combat.scanHotbarSlots();
          this.log('Kit armor equipped, hotbar sorted, and offhand secured.');
        } catch (err) {
          this.log(`Kit equip warning: ${err.message}`);
        } finally {
          if (!wasActive && this.state === STATES.IDLE) {
            this.survival.setCombatActive(false);
          }
        }
      }, 750);
      return;
    }

    reply(`Unknown bot command "!${command}". Type !help for available commands.`);
  }

  /**
   * Handles a raw line typed manually in the interactive console.
   * - Lines starting with commandPrefix ("!") execute bot commands (!duel, !stop, !kit, !players, !status, !quit).
   * - Any other line (e.g. "/server survival", "/duel Player", or chat) is sent directly to the Minecraft server.
   */
  handleConsoleInput(rawLine) {
    const line = (rawLine || '').trim();
    if (!line) return;

    const prefix = this.config.bot.commandPrefix || '!';
    if (line.startsWith(prefix)) {
      const args = line.slice(prefix.length).trim().split(/\s+/);
      const command = (args.shift() || '').toLowerCase();
      this.executeBotCommand(command, args, 'console', (msg) => this.log(msg));
      return;
    }

    if (!this.bot) {
      this.log('Not connected to server yet — wait for spawn before sending commands.');
      return;
    }

    if (/^\/server(?:\s|$)/i.test(line)) {
      this.duelsLoginJoinDone = true;
      this._clearDuelsLoginJoinTimer('manual /server command');
      this._clearDuelsRejoinTimer('manual /server command');
      if (line.toLowerCase().startsWith('/server ') && this.loginSentAt > 0) {
        const sinceLoginMs = Date.now() - this.loginSentAt;
        if (sinceLoginMs < 15000) {
          this.log(`Tip: Only ${(sinceLoginMs / 1000).toFixed(1)}s since login — some proxies prefer waiting ~15s before /server transfers.`);
        }
      }
    }

    // Track server /duel <player> or /duel accept <player> so the bot auto-engages once teleported into the arena
    const duelCmdMatch = line.match(/^\/duel\s+(?:accept\s+)?([a-zA-Z0-9_]{2,20})\b/i);
    if (duelCmdMatch) {
      const candidate = duelCmdMatch[1];
      if (!['accept', 'deny', 'decline', 'toggle', 'stats', 'top', 'queue', 'spectate'].includes(candidate.toLowerCase())) {
        this.pendingDuelTarget = candidate;
        this.pendingDuelReady = false; // Activates automatically once teleported into arena (or on damage)
        this.log(`Armed auto-engage for duel opponent "${candidate}" once match starts.`);
      }
    }

    this.bot.chat(line);
    const masked = /^\/(login|l|register|reg)\s+/i.test(line)
      ? line.replace(/^(\/\S+)\s+.*$/i, '$1 ********')
      : line;
    this.log(`[SENT] ${masked}`);
  }

  /**
   * Starts the interactive stdin console so the user can manually send /server, !duel, !kit, !stop, or chat.
   */
  startConsole() {
    if (this.rl) return;
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'PvPBot> '
    });

    this.log('Interactive console ready. Type /server <name>, !duel [player], !kit, !stop, !players, !status, !help, or !quit.');
    this.rl.prompt();

    this.rl.on('line', (line) => {
      this.handleConsoleInput(line);
      if (this.rl && !this.shuttingDown) {
        this.rl.prompt();
      }
    });

    this.rl.on('close', () => {
      if (!this.shuttingDown) {
        this.shutdown();
        process.exit(0);
      }
    });
  }

  _engageTarget(target, reason = 'engage', reply = null) {
    if (!target || !target.isValid) return false;
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

    this.transitionState(STATES.ENGAGING, reason);
    if (this.combat) this.combat.scanHotbarSlots();
    return true;
  }

  _tryAutoRetaliate(reason = 'damage') {
    if (this.config.bot.autoRetaliate === false) return false;
    if (!this.bot || !this.bot.entity || this.state !== STATES.IDLE) return false;

    const nearby = this._listNearbyPlayers();
    const recentlyEnded = (Date.now() - this.duelEndedAt) < 8000;
    if (!this.inDuelArena && !this._isWearingCombatArmor() && (nearby.length >= 3 || recentlyEnded)) {
      return false;
    }

    if (this.pendingDuelTarget && this.pendingDuelReady) {
      const pending = this._findPlayerEntity(this.pendingDuelTarget);
      if (pending && this.bot.entity.position.distanceTo(pending.position) <= (this.config.combat.engageRange || 24.0)) {
        return this._engageTarget(pending, `auto-retaliate (${reason})`);
      }
    }

    if (nearby.length > 0 && nearby[0].dist <= 14.0) {
      return this._engageTarget(nearby[0].entity, `auto-retaliate (${reason})`);
    }
    return false;
  }

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
  }

  _listNearbyPlayers() {
    if (!this.bot || !this.bot.entity) return [];
    const seenIds = new Set();
    const results = [];
    const selfId = this.bot.entity.id;
    const selfName = (this.bot.username || '').toLowerCase();

    const addCandidate = (entity, fallbackName) => {
      if (!entity || !entity.isValid || !entity.position) return;
      if (entity.id !== undefined && (entity.id === selfId || seenIds.has(entity.id))) return;
      const username = entity.username || fallbackName || `player_${entity.id}`;
      if (username.toLowerCase() === selfName) return;
      if (entity.id !== undefined) seenIds.add(entity.id);
      const dist = this.bot.entity.position.distanceTo(entity.position);
      results.push({ username, entity, dist });
    };

    if (this.bot.players) {
      for (const player of Object.values(this.bot.players)) {
        if (player && player.entity) {
          addCandidate(player.entity, player.username);
        }
      }
    }

    if (this.bot.entities) {
      for (const entity of Object.values(this.bot.entities)) {
        if (entity && entity.type === 'player') {
          addCandidate(entity, entity.username);
        }
      }
    }

    results.sort((a, b) => a.dist - b.dist);
    return results;
  }

  _findPlayerEntity(name) {
    if (!this.bot || !name) return null;
    const lower = name.toLowerCase();
    const all = this._listNearbyPlayers();

    // Exact match first, then prefix/substring match
    const exact = all.find((p) => p.username.toLowerCase() === lower);
    if (exact) return exact.entity;

    const partial = all.find((p) => p.username.toLowerCase().startsWith(lower));
    return partial ? partial.entity : null;
  }

  _findNearestLoot() {
    if (!this.bot || !this.bot.entity) return null;
    const radius = this.config.looting.radius || 12.0;
    let nearest = null;
    let bestDist = radius;

    for (const entity of Object.values(this.bot.entities)) {
      if (!entity || !entity.isValid || !entity.position) continue;
      const isItemDrop = entity.name === 'item' || entity.displayName === 'Item';
      if (!isItemDrop) continue;

      const dist = this.bot.entity.position.distanceTo(entity.position);
      if (dist < bestDist) {
        bestDist = dist;
        nearest = entity;
      }
    }
    return nearest;
  }

  /**
   * Cleanly transitions between FSM states, stopping conflicting movement/item actions.
   */
  transitionState(nextState, reason = '') {
    if (this.state === nextState) return;

    const prevState = this.state;

    // Tear down outgoing state cleanly
    if (this.combat) this.combat.stopMovement();
    if (this.ranged) this.ranged.cancel();
    if (this.survival) this.survival.stopConsumption();
    if (this.burst) this.burst.cancel();
    if (this.aerial) this.aerial.cancel();
    if (nextState === STATES.IDLE && this.prediction) {
      this.prediction.clear();
    }
    if (this.bot) {
      this.bot.clearControlStates();
      if (this.bot.pathfinder) {
        this.bot.pathfinder.setGoal(null);
      }
    }

    this.state = nextState;
    this.log(`State transition: ${prevState} -> ${nextState}${reason ? ` (${reason})` : ''}`);

    // Configure per-state background policies
    if (this.survival) {
      const inCombatOrLoot = nextState !== STATES.IDLE;
      this.survival.setCombatActive(inCombatOrLoot);
      // Only allow background auto-eat during LOOTING (never in locked IDLE lobbies or active swings)
      this.survival.setAutoEatEnabled(nextState === STATES.LOOTING);
    }

    if (nextState === STATES.LOOTING) {
      this.lootStartedAt = Date.now();
    }

    if (nextState === STATES.IDLE) {
      if (!this.spawnAnchorPos && this.bot && this.bot.entity && this.bot.entity.position) {
        this.spawnAnchorPos = this.bot.entity.position.clone();
      }
      this._resetSpawnRoam();
    } else {
      this.roamPhase = 'PAUSED';
      this.roamTargetPos = null;
    }
  }

  _startTickLoop() {
    this._stopTickLoop();
    // Synchronize directly to Mineflayer's native 20-TPS physicsTick to prevent out-of-phase packet bursts
    if (this.bot && typeof this.bot.on === 'function') {
      this._physicsTickHandler = () => {
        try {
          this._tick();
        } catch (err) {
          this.log(`Tick error: ${err.message}`);
        }
      };
      this.bot.on('physicsTick', this._physicsTickHandler);
    } else {
      const tickRateMs = this.config.physics.tickRateMs || 50;
      this.tickTimer = setInterval(() => {
        try {
          this._tick();
        } catch (err) {
          this.log(`Tick error: ${err.message}`);
        }
      }, tickRateMs);
    }
  }

  _stopTickLoop() {
    if (this._physicsTickHandler && this.bot && typeof this.bot.removeListener === 'function') {
      this.bot.removeListener('physicsTick', this._physicsTickHandler);
    }
    this._physicsTickHandler = null;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  _clearTimers() {
    this._stopTickLoop();
    this._clearLoginFallbackTimer();
    this._clearDuelsLoginJoinTimer();
    this._clearDuelsRejoinTimer();
    this._clearDuelAcceptTimer();
    this._clearAdvertiseTimer();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  _clearAdvertiseTimer() {
    if (this.advertiseTimer) {
      clearTimeout(this.advertiseTimer);
      this.advertiseTimer = null;
    }
  }

  /**
   * Counts other real players on the server tab list (excluding the bot itself).
   */
  _countOtherOnlinePlayers() {
    if (!this.bot || !this.bot.players) return 0;
    const selfName = (this.bot.username || '').toLowerCase();
    return Object.keys(this.bot.players).filter((name) => name && name.toLowerCase() !== selfName).length;
  }

  /**
   * Schedules the next random "duel me, I'm a bot" chat message after a random 1–3min delay.
   * Only speaks while IDLE (never mid-fight) and stays completely silent when nobody else is online.
   */
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
  }

  _sendAdvertise() {
    if (!this.advertiseEnabled || this.shuttingDown || !this.bot || !this.bot.entity) return false;
    if (this.state !== STATES.IDLE || this.inDuelArena) return false;
    if (this.loginPassword && !this.loginAttempted) return false;
    if (this._countOtherOnlinePlayers() === 0) return false;

    const advCfg = (this.config.bot && this.config.bot.advertise) || {};
    const messages = Array.isArray(advCfg.messages) ? advCfg.messages.filter((m) => typeof m === 'string' && m.trim()) : [];
    if (messages.length === 0) return false;

    // Pick a random message, never repeating the previous one back-to-back
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
  }

  _scheduleReconnect() {
    const rc = this.config.bot.reconnect;
    if (this.shuttingDown || !rc || !rc.enabled) return;

    const delay = Math.min(this.reconnectDelayMs, rc.maxDelayMs || 60000);
    this.log(`Reconnecting in ${(delay / 1000).toFixed(1)}s...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelayMs = Math.min(
        Math.round(delay * (rc.backoffMultiplier || 1.5)),
        rc.maxDelayMs || 60000
      );
      this.start();
    }, delay);
  }

  /**
   * 20-TPS (50ms) physics & decision state machine tick.
   * Survival holds highest priority over all attacking/inventory actions.
   */
  _tick() {
    if (!this.bot || !this.bot.entity) return;

    // In IDLE (e.g. hub / duels lobby), stay completely packet-quiet so locked lobby items
    // or decorative lobby obsidian/crystals never trigger anti-spam packet kicks.
    if (this.state === STATES.IDLE) {
      this._tickIdle();
      return;
    }

    // 1. HIGHEST PRIORITY: Offhand Totem of Undying (slot 45) / Shield safety
    const totemSwapActive = this.survival.ensureOffhandSafety();

    const target = this._resolveActiveTarget();

    // Maintain rolling 5-tick trajectory prediction whenever tracking a valid target
    if (this.prediction && target && target.isValid) {
      this.prediction.tick(target);
    }

    // 1b. Immediate Water Bucket cobweb escape (place water -> pick up after 1 tick)
    if (!totemSwapActive && this.ranged && this.ranged.tickCobwebEscape()) {
      return;
    }

    // 1c. High-priority Anti-Crystal / Anti-Anchor defense against nearby enemy explosives
    if (!totemSwapActive && this.burst && this.burst.tickDefense(target)) {
      if (this.combat) this.combat.stopMovement();
      return;
    }

    // 2. Global emergency retreat override (bot.health <= 11 during active engagement)
    if (
      target &&
      target.isValid &&
      this.state === STATES.ENGAGING &&
      this.survival.needsRetreat()
    ) {
      this.transitionState(STATES.RETREATING, `critical HP (${this.bot.health.toFixed(1)} <= ${this.config.survival.retreatHealthThreshold})`);
    }

    // Yield offensive actions during an active emergency Totem swap
    if (totemSwapActive && this.state === STATES.ENGAGING) {
      return;
    }

    switch (this.state) {
      case STATES.ENGAGING:
        this._tickEngaging(target);
        break;

      case STATES.RETREATING:
        this._tickRetreating(target);
        break;

      case STATES.HEALING:
        this._tickHealing(target);
        break;

      case STATES.LOOTING:
        this._tickLooting();
        break;

      default:
        this.transitionState(STATES.IDLE, 'unknown state recovery');
        break;
    }
  }

  _tickIdle() {
    // Stay calm and zero-spam in IDLE lobbies while optionally roaming gently around spawn.
    const engageRange = this.config.combat.engageRange || 36.0;
    const nearby = this._listNearbyPlayers();
    const canEngagePending = this.inDuelArena || this._isWearingCombatArmor() || nearby.length <= 3;

    if (this.pendingDuelTarget && this.pendingDuelReady && canEngagePending) {
      const pending = this._findPlayerEntity(this.pendingDuelTarget);
      if (pending && this.bot.entity.position.distanceTo(pending.position) <= engageRange) {
        this._engageTarget(pending, `duel start (${this.pendingDuelTarget})`);
        return;
      }
    }

    const now = Date.now();
    if (this.autoFight || now < this.autoStartDuelUntil) {
      // For arena autoStartDuel (not explicit !auto), only auto-engage when 1–2 opponents exist (prevents attacking crowded hubs!)
      const looksLikeArena = this.autoFight || (nearby.length >= 1 && nearby.length <= 2);
      if (looksLikeArena && nearby.length > 0 && nearby[0].dist <= engageRange) {
        this._engageTarget(nearby[0].entity, this.autoFight ? '!auto nearest target' : 'arena auto-start');
        return;
      }
    }

    this._tickSpawnRoam();
  }

  _randRange(minVal, maxVal) {
    return minVal + Math.random() * Math.max(0, maxVal - minVal);
  }

  _stopSpawnRoam() {
    if (this.bot && typeof this.bot.setControlState === 'function') {
      this.bot.setControlState('forward', false);
      this.bot.setControlState('back', false);
      this.bot.setControlState('left', false);
      this.bot.setControlState('right', false);
      this.bot.setControlState('sprint', false);
      this.bot.setControlState('jump', false);
    }
    this.roamTargetPos = null;
  }

  _resetSpawnRoam() {
    const botCfg = this.config.bot || {};
    const pauseMin = botCfg.roamPauseMinMs !== undefined ? botCfg.roamPauseMinMs : 2200;
    const pauseMax = botCfg.roamPauseMaxMs !== undefined ? botCfg.roamPauseMaxMs : 4800;
    const now = Date.now();
    this._stopSpawnRoam();
    this.roamPhase = 'PAUSED';
    this.roamPhaseUntil = now + this._randRange(Math.min(1200, pauseMin), pauseMax);
    this.roamNextGlanceAt = now + this._randRange(1800, 3200);
    if (this.bot && this.bot.entity) {
      this.roamGlanceYaw = this.bot.entity.yaw || 0;
      this.roamGlancePitch = 0;
    }
  }

  _isRoamStepSafe(yaw) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) {
      return { safe: false, shouldStepUp: false };
    }
    if (typeof this.bot.blockAt !== 'function') {
      return { safe: true, shouldStepUp: false };
    }

    const pos = this.bot.entity.position;
    const stepX = pos.x - Math.sin(yaw) * 1.1;
    const stepZ = pos.z - Math.cos(yaw) * 1.1;
    const baseY = Math.floor(pos.y);

    const hazardNames = new Set([
      'water', 'flowing_water', 'lava', 'flowing_lava',
      'fire', 'soul_fire', 'campfire', 'soul_campfire',
      'cobweb', 'cactus', 'magma_block', 'sweet_berry_bush', 'wither_rose'
    ]);

    const feetBlock = this.bot.blockAt(new Vec3(pos.x, baseY, pos.z));
    if (feetBlock && hazardNames.has(feetBlock.name)) {
      return { safe: false, shouldStepUp: false };
    }

    const aheadFeet = this.bot.blockAt(new Vec3(stepX, baseY, stepZ));
    const aheadHead = this.bot.blockAt(new Vec3(stepX, baseY + 1, stepZ));
    const aheadAbove = this.bot.blockAt(new Vec3(stepX, baseY + 2, stepZ));
    const aheadFloor0 = this.bot.blockAt(new Vec3(stepX, baseY - 1, stepZ));
    const aheadFloor1 = this.bot.blockAt(new Vec3(stepX, baseY - 2, stepZ));

    if (
      (aheadFeet && hazardNames.has(aheadFeet.name)) ||
      (aheadHead && hazardNames.has(aheadHead.name)) ||
      (aheadFloor0 && hazardNames.has(aheadFloor0.name))
    ) {
      return { safe: false, shouldStepUp: false };
    }

    const solidFeet = Boolean(aheadFeet && aheadFeet.boundingBox === 'block');
    const solidHead = Boolean(aheadHead && aheadHead.boundingBox === 'block');
    const solidAbove = Boolean(aheadAbove && aheadAbove.boundingBox === 'block');

    // Reject 2-block walls or tight overhangs
    if (solidHead || (solidFeet && solidAbove)) {
      return { safe: false, shouldStepUp: false };
    }

    // Require solid footing within 2 blocks down to avoid void drops / spawn ledges
    const hasSupport =
      solidFeet ||
      Boolean(aheadFloor0 && aheadFloor0.boundingBox === 'block') ||
      Boolean(aheadFloor1 && aheadFloor1.boundingBox === 'block');
    if (!hasSupport) {
      return { safe: false, shouldStepUp: false };
    }

    return {
      safe: true,
      shouldStepUp: solidFeet && !solidHead && !solidAbove && Boolean(this.bot.entity.onGround)
    };
  }

  _pickRoamTarget() {
    const pos = this.bot.entity.position;
    const anchor = this.spawnAnchorPos || pos;
    const botCfg = this.config.bot || {};
    const radius = botCfg.roamRadius !== undefined ? botCfg.roamRadius : 10;

    const dxFromAnchor = pos.x - anchor.x;
    const dzFromAnchor = pos.z - anchor.z;
    const distFromAnchor = Math.sqrt(dxFromAnchor * dxFromAnchor + dzFromAnchor * dzFromAnchor);

    // If drifted far from spawn anchor, steer gently back toward anchor center
    if (distFromAnchor > radius * 0.8) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const backYaw = Math.atan2(-(anchor.x - pos.x), -(anchor.z - pos.z)) + (attempt * 0.45 * (attempt % 2 === 0 ? 1 : -1));
        if (this._isRoamStepSafe(backYaw).safe) {
          const dist = Math.min(radius * 0.7, Math.max(2.5, distFromAnchor));
          return new Vec3(
            pos.x - Math.sin(backYaw) * dist,
            pos.y,
            pos.z - Math.cos(backYaw) * dist
          );
        }
      }
    }

    for (let attempt = 0; attempt < 6; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const r = this._randRange(2.5, Math.max(3.5, radius));
      const candidate = new Vec3(
        anchor.x + Math.cos(angle) * r,
        pos.y,
        anchor.z + Math.sin(angle) * r
      );
      const yaw = Math.atan2(-(candidate.x - pos.x), -(candidate.z - pos.z));
      if (this._isRoamStepSafe(yaw).safe) {
        return candidate;
      }
    }

    return null;
  }

  _tickSpawnRoam() {
    if (!this.roamInSpawn || this.state !== STATES.IDLE || this.inDuelArena) return;
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) return;

    const botCfg = this.config.bot || {};
    const walkMin = botCfg.roamWalkMinMs !== undefined ? botCfg.roamWalkMinMs : 1400;
    const walkMax = botCfg.roamWalkMaxMs !== undefined ? botCfg.roamWalkMaxMs : 3200;
    const pauseMin = botCfg.roamPauseMinMs !== undefined ? botCfg.roamPauseMinMs : 2200;
    const pauseMax = botCfg.roamPauseMaxMs !== undefined ? botCfg.roamPauseMaxMs : 4800;

    const now = Date.now();
    const pos = this.bot.entity.position;
    if (!this.spawnAnchorPos) {
      this.spawnAnchorPos = pos.clone();
    }

    if (this.roamPhase === 'PAUSED') {
      // Gentle occasional head glance (throttled <= 10 Hz) while standing relaxed
      if (now >= this.roamNextGlanceAt) {
        this.roamNextGlanceAt = now + this._randRange(1800, 3200);
        const curYaw = this.bot.entity.yaw || 0;
        this.roamGlanceYaw = normalizeAngle(curYaw + this._randRange(-0.6, 0.6));
        this.roamGlancePitch = this._randRange(-0.14, 0.14);
      }

      if (this.aimer && (now - this.roamLastLookAt) >= 100) {
        const yawDiff = Math.abs(normalizeAngle(this.roamGlanceYaw - (this.bot.entity.yaw || 0)));
        const pitchDiff = Math.abs(this.roamGlancePitch - (this.bot.entity.pitch || 0));
        if (yawDiff > 0.04 || pitchDiff > 0.04) {
          this.roamLastLookAt = now;
          this.aimer.stepTowardsAngles(this.roamGlanceYaw, this.roamGlancePitch, { speedMultiplier: 0.35 });
        }
      }

      if (now >= this.roamPhaseUntil) {
        const nextDest = this._pickRoamTarget();
        if (nextDest) {
          this.roamTargetPos = nextDest;
          this.roamPhase = 'WALKING';
          this.roamPhaseUntil = now + this._randRange(walkMin, walkMax);
        } else {
          this.roamPhaseUntil = now + this._randRange(600, 1400);
        }
      }
      return;
    }

    // WALKING phase
    const dest = this.roamTargetPos;
    if (!dest || now >= this.roamPhaseUntil) {
      this._stopSpawnRoam();
      this.roamPhase = 'PAUSED';
      this.roamPhaseUntil = now + this._randRange(pauseMin, pauseMax);
      return;
    }

    const dx = dest.x - pos.x;
    const dz = dest.z - pos.z;
    const horizDist = Math.sqrt(dx * dx + dz * dz);
    if (horizDist < 1.1) {
      this._stopSpawnRoam();
      this.roamPhase = 'PAUSED';
      this.roamPhaseUntil = now + this._randRange(pauseMin, pauseMax);
      return;
    }

    const yawToDest = Math.atan2(-dx, -dz);
    const stepCheck = this._isRoamStepSafe(yawToDest);
    if (!stepCheck.safe) {
      this._stopSpawnRoam();
      this.roamPhase = 'PAUSED';
      this.roamPhaseUntil = now + this._randRange(500, 1200);
      return;
    }

    let yawErrorDeg = Math.abs(normalizeAngle(yawToDest - (this.bot.entity.yaw || 0))) * (180 / Math.PI);
    if (this.aimer && (now - this.roamLastLookAt) >= 100) {
      this.roamLastLookAt = now;
      const aimStatus = this.aimer.stepTowardsAngles(yawToDest, 0, {
        speedMultiplier: 0.5,
        toleranceRad: 0.25
      });
      yawErrorDeg = aimStatus.yawErrorDeg;
    }

    if (typeof this.bot.setControlState === 'function') {
      this.bot.setControlState('forward', yawErrorDeg < 45);
      this.bot.setControlState('back', false);
      this.bot.setControlState('left', false);
      this.bot.setControlState('right', false);
      this.bot.setControlState('sprint', false);
      this.bot.setControlState('jump', stepCheck.shouldStepUp);
    }
  }

  _tickEngaging(target) {
    // Target temporarily out of entity-tracking range -> hunt last seen position instead of quitting PvP!
    if (!target || !target.isValid) {
      const now = Date.now();
      if (!this.targetLostAt) {
        this.targetLostAt = now;
      }

      // Check if another player is right here (e.g. target respawned with a new entityId)
      if (this.activeTargetName) {
        const reacquired = this._findPlayerEntity(this.activeTargetName);
        if (reacquired) {
          this.activeTargetEntityId = reacquired.id;
          this.targetLostAt = 0;
          return;
        }
      }

      // If loot appeared right where the target stood, they were defeated
      const nearLoot = this.config.looting.enabled ? this._findNearestLoot() : null;
      if (nearLoot && this.targetLastSeenPos && nearLoot.position.distanceTo(this.targetLastSeenPos) <= 5.0) {
        this.activeTargetName = null;
        this.activeTargetEntityId = null;
        this.targetLastSeenPos = null;
        this.targetLostAt = 0;
        this.transitionState(STATES.LOOTING, 'target defeated, collecting drops');
        return;
      }

      // Continue sprinting toward target's last seen position for up to targetHuntTimeoutMs (12s)
      const huntTimeout = this.config.combat.targetHuntTimeoutMs || 12000;
      if (this.targetLastSeenPos && (now - this.targetLostAt) < huntTimeout) {
        const distToLast = this.bot.entity.position.distanceTo(this.targetLastSeenPos);
        if (distToLast > 2.0) {
          const aimStatus = this.aimer.stepTowardsPoint(this.targetLastSeenPos.offset(0, 1.0, 0), {
            speedMultiplier: 1.3
          });
          this.bot.setControlState('forward', true);
          this.bot.setControlState('back', false);
          this.bot.setControlState('sprint', aimStatus.yawErrorDeg < 45 && this.bot.food > 6);
          this.bot.setControlState('jump', this.bot.entity.onGround && aimStatus.yawErrorDeg < 45);
          this.bot.setControlState('left', false);
          this.bot.setControlState('right', false);
          return;
        }
      }

      // Hunt timed out — if !auto is ON, switch to next visible opponent instead of idling
      if (this.autoFight) {
        const nearby = this._listNearbyPlayers();
        if (nearby.length > 0 && nearby[0].dist <= (this.config.combat.disengageRange || 96.0)) {
          this._engageTarget(nearby[0].entity, '!auto re-acquire');
          return;
        }
      }

      this.activeTargetName = null;
      this.activeTargetEntityId = null;
      this.targetLastSeenPos = null;
      this.targetLostAt = 0;
      if (nearLoot) {
        this.transitionState(STATES.LOOTING, 'collecting nearby drops');
      } else {
        this.transitionState(STATES.IDLE, 'target lost after hunt timeout');
      }
      return;
    }

    // Target is visible -> update hunt tracking position
    this.targetLastSeenPos = target.position.clone();
    this.targetLostAt = 0;

    const dist = this.bot.entity.position.distanceTo(target.position);
    if (dist > (this.config.combat.disengageRange || 96.0)) {
      this.activeTargetName = null;
      this.activeTargetEntityId = null;
      this.targetLastSeenPos = null;
      this.transitionState(STATES.IDLE, 'target out of disengage range');
      return;
    }

    // Survival priority transitions (only retreat at critical <=6 HP without totem/pots)
    if (this.survival.needsRetreat()) {
      this.transitionState(STATES.RETREATING, `critical health (${this.bot.health.toFixed(1)})`);
      return;
    }
    if (this.survival.needsHealing()) {
      this.transitionState(STATES.HEALING, `gapple heal (${this.bot.health.toFixed(1)} HP)`);
      return;
    }

    // 0. Inline quick-potting (Instant Health II at <=13 HP) & combat buffs (Strength/Swiftness/FireRes)
    //    Runs right inside ENGAGING so the bot heals aggressively without running away!
    if (this.survival.tickInlineCombatHeal(target)) {
      this.combat.stopMovement();
      return;
    }

    // 1. Smart shield blocking (bow draw <= 12b or sword/axe rush while weapon on cooldown)
    const weaponCooldownProgress = this.combat.getCooldownProgress();
    if (this.survival.tickShield(target, weaponCooldownProgress)) {
      this.combat.stopMovement();
      this.aimer.stepTowardsEntity(target);
      return;
    }

    // 2. Aerial combat techniques (Stun Slam, Wind-Charge Mace Launch, Spear-to-Mace chain, Elytra Mace Dive)
    if (this.aerial && this.aerial.tick(target)) {
      this.combat.stopMovement();
      return;
    }

    // 3. Burst damage combos (CPvP instant pop, End Crystal, Respawn Anchor, Wind Charge launch)
    if (this.burst && this.burst.tick(target)) {
      this.combat.stopMovement();
      return;
    }

    // 4. Ranged & utility opportunities (aggressive/agro-cancel pearl, cobweb/lava utility, predictive bow/crossbow)
    if (!this.ranged.isBusy()) {
      this.ranged.tryEnderPearl(target, 'chase') || this.ranged.tryCloseUtility(target);
    }

    if (this.ranged.tick(target)) {
      this.combat.stopMovement();
      return;
    }

    // 5. High-tier melee & standalone Spear combat (prediction, jump-reset, hit-select, breach swap, strafe, crit, W-tap)
    this.combat.tick(target);
  }

  _tickRetreating(target) {
    if (!target || !target.isValid) {
      if (this.survival.needsHealing()) {
        this.transitionState(STATES.HEALING, 'safe to heal after retreat');
      } else {
        this.activeTargetName = null;
        this.transitionState(STATES.IDLE, 'threat gone during retreat');
      }
      return;
    }

    const dist = this.bot.entity.position.distanceTo(target.position);
    const retreatDist = this.config.survival.retreatDistance || 12.0;

    // Re-engage immediately once health & hunger are safely restored
    if (this.survival.isRecovered()) {
      this.transitionState(STATES.ENGAGING, 'recovered during retreat');
      return;
    }

    // Once sufficient separation is achieved (and not mid-gapple bite), finish healing cleanly in HEALING state
    if (dist >= retreatDist && !this.survival.isConsuming && this.survival.needsHealing()) {
      this.transitionState(STATES.HEALING, `created ${dist.toFixed(1)}b separation`);
      return;
    }

    // Defensive escape Ender Pearl if < 6 HP and trapped in a combo or cobweb (never interrupt active gapple bite)
    if (
      !this.ranged.isBusy() &&
      !this.survival.isConsuming &&
      !this.survival.pendingSplashPotion &&
      !this.survival.pendingLosBlock
    ) {
      this.ranged.tryDefensivePearl(target);
    }

    if (this.ranged.isBusy()) {
      this.ranged.tick(target);
      return;
    }

    this.survival.tickRetreating(target);
  }

  _tickHealing(target) {
    // Never interrupt an active Golden Apple / potion consumption mid-bite!
    if (target && target.isValid && !this.survival.isConsuming) {
      const dist = this.bot.entity.position.distanceTo(target.position);
      if (this.survival.needsRetreat() && dist < 5.0 && !this.survival.pendingSplashPotion) {
        this.transitionState(STATES.RETREATING, 'rushed while healing at critical HP');
        return;
      }
    }

    // Resume combat once recovered or out of healing items (after finishing active bite)
    if (!this.survival.isConsuming && (this.survival.isRecovered() || !this.survival.hasHealingSupplies())) {
      if (target && target.isValid) {
        this.transitionState(STATES.ENGAGING, 'healing complete');
      } else {
        this.activeTargetName = null;
        this.transitionState(STATES.IDLE, 'healing complete, no target');
      }
      return;
    }

    this.survival.tickHealing(target);
  }

  _tickLooting() {
    const elapsed = Date.now() - this.lootStartedAt;
    const maxDuration = this.config.looting.maxDurationMs || 8000;
    const loot = this._findNearestLoot();

    if (!loot || elapsed > maxDuration) {
      this.survival.autoEquipAndSort()
        .then(() => {
          if (this.combat) this.combat.scanHotbarSlots();
        })
        .catch(() => {});
      this.transitionState(STATES.IDLE, loot ? 'looting timed out' : 'area looted');
      return;
    }

    const dist = this.bot.entity.position.distanceTo(loot.position);
    if (dist > 4.5 && this.bot.pathfinder) {
      this.bot.pathfinder.setGoal(
        new goals.GoalNear(loot.position.x, loot.position.y, loot.position.z, 1),
        true
      );
    } else {
      if (this.bot.pathfinder) this.bot.pathfinder.setGoal(null);
      const aimStatus = this.aimer.stepTowardsPoint(loot.position);
      this.bot.setControlState('forward', aimStatus.yawErrorDeg < 45);
      this.bot.setControlState('sprint', false);
    }
  }

  shutdown() {
    this.shuttingDown = true;
    this._clearTimers();
    if (this.rl) {
      try {
        this.rl.close();
      } catch (_) {}
      this.rl = null;
    }
    if (this.bot) {
      try {
        this.bot.quit('Shutting down');
      } catch (_) {}
    }
  }
}

const controller = new PvPBotController(config);

process.on('SIGINT', () => {
  console.log('\nReceived SIGINT, shutting down PvP bot...');
  controller.shutdown();
  process.exit(0);
});

process.on('SIGTERM', () => {
  controller.shutdown();
  process.exit(0);
});

if (require.main === module) {
  controller.startConsole();
  controller.start();
}

module.exports = { PvPBotController, STATES, loadRuntimeConfig, stripColorCodes };
