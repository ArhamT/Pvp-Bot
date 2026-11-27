'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { loader: autoEatLoader } = require('mineflayer-auto-eat');

const { SmoothAimer } = require('./modules/aim');
const { PredictionModule } = require('./modules/prediction');
const { CombatModule } = require('./modules/combat');
const { SurvivalModule } = require('./modules/survival');
const { RangedModule } = require('./modules/ranged');
const { BurstModule } = require('./modules/burst');
const { AerialModule } = require('./modules/aerial');
const { EscapeModule } = require('./modules/escape');
const { LiquidDenyModule } = require('./modules/liquid_deny');
const { RedWoolZoneModule } = require('./modules/red_wool_zone');
const { packetSanitizerMethods } = require('./modules/controller/packet_sanitizer');
const { arenaDetectorMethods, stripColorCodes } = require('./modules/controller/arena_detector');
const { spawnRoamMethods } = require('./modules/controller/spawn_roam');

const STATES = Object.freeze({
  IDLE: 'IDLE',
  ENGAGING: 'ENGAGING',
  RETREATING: 'RETREATING',
  HEALING: 'HEALING',
  LOOTING: 'LOOTING'
});

const DUEL_REQUEST_REGEX = /(?:^|[\s•|:\]>»-])([A-Za-z0-9_]{3,16})\s+(?:has\s+sent(?:\s+you)?\s+a\s+duel\s+request|sent(?:\s+you)?\s+a\s+duel\s+request|challenged\s+you\s+to\s+a\s+duel)/i;
const DUEL_START_CUE_REGEX = /(?:^|[\s•|:\]>»-])(?:go!+|fight!+)(?:$|[\s!.,])/i;

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
    this.escape = null;
    this.liquidDeny = null;
    this.redWoolZone = null;

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
    this.inFfaArena = false;
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
    this.lastTeleportAt = 0;

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

    this._bindEvents();
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
        const protoNum = bot._client && bot._client.protocolVersion ? bot._client.protocolVersion : 'unknown';
        this.log(`Connected protocol: ${bot.version || 'unknown'} (protocol ${protoNum}).`);
        this.log(`Spawned in world at ${bot.entity.position.floored()}.`);

        // Instantiate modular subsystems once per connection
        this.aimer = new SmoothAimer(bot, this.config.physics);
        this.prediction = new PredictionModule(bot, this.config);
        this.ranged = new RangedModule(bot, this.config, this.aimer, this.prediction);
        this.combat = new CombatModule(bot, this.config, this.aimer, this.ranged, this.prediction);
        this.survival = new SurvivalModule(bot, this.config, this.aimer);
        this.burst = new BurstModule(bot, this.config, this.aimer, this.prediction, this.combat);
        this.aerial = new AerialModule(bot, this.config, this.aimer, this.prediction, this.combat);
        this.escape = new EscapeModule(bot, this.config, this.aimer);
        this.liquidDeny = new LiquidDenyModule(bot, this.config, this.aimer);
        this.redWoolZone = new RedWoolZoneModule(bot, this.config, this.aimer);

        this.survival.configureAutoEat();
        // Stay completely quiet in IDLE lobbies (no locked-inventory clicks or auto-eat spam)
        this.survival.setCombatActive(false);
        this.survival.setAutoEatEnabled(false);
        this.liquidDeny.setCombatActive(false);

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
        this._clearTargetState();
        this.inFfaArena = false;
        this.spawnAnchorPos = bot.entity.position.clone();
        this._resetSpawnRoam();

        const recentlyEndedDuel = (Date.now() - this.duelEndedAt) < 10000;
        const nearbyCount = this._listNearbyPlayers().length;
        const hasCombatKit = this._hasCombatKit();
        const inRedWoolSafeZone = Boolean(
          this.redWoolZone &&
          this.redWoolZone.isPositionInSafeZone(bot.entity.position)
        );

        if (recentlyEndedDuel) {
          this.pendingDuelTarget = null;
          this.pendingDuelReady = false;
          this.autoStartDuelUntil = 0;
          this.inDuelArena = false;
        } else if (hasCombatKit && (inRedWoolSafeZone || nearbyCount >= 3)) {
          this.pendingDuelTarget = null;
          this.pendingDuelReady = false;
          this.autoStartDuelUntil = 0;
          this.inDuelArena = false;
          this.inFfaArena = true;
        } else if (nearbyCount >= 4) {
          this.pendingDuelTarget = null;
          this.pendingDuelReady = false;
          this.autoStartDuelUntil = 0;
          this.inDuelArena = false;
        } else {
          if (this.pendingDuelTarget && (hasCombatKit || (nearbyCount >= 1 && nearbyCount <= 2))) {
            this.pendingDuelReady = true;
            this.inDuelArena = true;
          } else {
            this.pendingDuelReady = false;
          }
          if (this.config.bot.autoStartDuel !== false && hasCombatKit && nearbyCount <= 3) {
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
      this._clearTargetState(true);
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
      if (this.liquidDeny) this.liquidDeny.setCombatActive(false);
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
      if (this.escape) this.escape.dispose();
      if (this.liquidDeny) this.liquidDeny.dispose();
      if (this.redWoolZone) this.redWoolZone.dispose();
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
    this._clearTargetState(true);
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
    if (!text) return;
    const lower = text.toLowerCase();

    // Detect FFA arena entry / hub return chat triggers
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
      this._clearTargetState(true);
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
      this._clearTargetState(true);
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

    if (/^\/(?:ffa|kitpvp|warp\s+ffa|arena)\b/i.test(line)) {
      this.inFfaArena = true;
      this.inDuelArena = false;
      this.duelEndedAt = 0;
    } else if (/^\/(?:lobby|hub|spawn)\b/i.test(line)) {
      this.inFfaArena = false;
      this.inDuelArena = false;
      if (this.redWoolZone) this.redWoolZone.resetHistory();
    }

    this.bot.chat(line);
    const masked = /^\/(login|l|register|reg)\s+/i.test(line)
      ? line.replace(/^(\/\S+)\s+.*$/i, '$1 ********')
      : line;
    this.log(`[SENT] ${masked}`);
  }

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
      if (pending && this.bot.entity.position.distanceTo(pending.position) <= (this.config.combat.engageRange || 96.0)) {
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
    if (this.escape) this.escape.cancel();
    if (this.liquidDeny) this.liquidDeny.cancel();
    if (this.redWoolZone) this.redWoolZone.cancel();
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
    const inCombatOrLoot = nextState !== STATES.IDLE;
    if (this.survival) {
      this.survival.setCombatActive(inCombatOrLoot);
      // Only allow background auto-eat during LOOTING (never in locked IDLE lobbies or active swings)
      this.survival.setAutoEatEnabled(nextState === STATES.LOOTING);
    }
    if (this.liquidDeny) {
      this.liquidDeny.setCombatActive(inCombatOrLoot);
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

    if (!this.autoFight && this._hasLobbyMenuItems()) {
      this._clearTargetState(true);
      this.inFfaArena = false;
      this.transitionState(STATES.IDLE, 'spawn/lobby menu items detected');
      return;
    }

    const target = this._resolveActiveTarget();

    // 1. HIGHEST PRIORITY: Offhand Totem of Undying (slot 45) / Shield safety
    const totemSwapActive = this.survival.ensureOffhandSafety(target);
    if (totemSwapActive) {
      if (this.burst && this.burst.state !== 'IDLE' && this.burst.state !== 'WIND_CLUTCH') {
        this.burst.cancel();
      }
      if (this.combat && this.state === STATES.ENGAGING) {
        this.combat.stopMovement();
      }
      if (this.state === STATES.ENGAGING) {
        return;
      }
    }

    // Maintain rolling 5-tick trajectory prediction whenever tracking a valid target
    if (this.prediction && target && target.isValid) {
      this.prediction.tick(target);
    }

    // 1b. Lava escape, 3-tier cobweb escape (water -> pearl -> sword dig), water shore climb,
    //     stuck-in-block digging, rail/TNT-cart sprint evasion, and fast edge/stall recovery
    const isStationaryAction = Boolean(
      this.survival.isConsuming ||
      this.survival.isShielding ||
      this.survival.pendingLosBlock ||
      (this.burst && this.burst.isBusy()) ||
      (this.aerial && this.aerial.isBusy()) ||
      (this.liquidDeny && this.liquidDeny.isBusy()) ||
      (this.redWoolZone && this.redWoolZone.isBusy())
    );
    if (
      !totemSwapActive &&
      this.escape &&
      this.escape.tick(target, {
        canTrackStall: (this.state === STATES.ENGAGING || this.state === STATES.RETREATING) && !isStationaryAction
      })
    ) {
      if (this.burst && this.burst.state !== 'IDLE' && this.burst.state !== 'WIND_CLUTCH') {
        this.burst.cancel();
      }
      if (this.survival) this.survival.lowerShield();
      return;
    }

    // 1b3. Liquid Denial: scoop water/lava sources into empty buckets, or cover enemy liquid with a solid block
    const suppressOwnLiquid = Boolean(
      (this.escape && typeof this.escape.isManagingOwnLiquid === 'function' && this.escape.isManagingOwnLiquid()) ||
      (this.aerial && this.aerial.mode === 'CLUTCH')
    );
    if (!totemSwapActive && this.liquidDeny && this.liquidDeny.tick(target, { suppressOwnLiquid })) {
      if (this.survival) this.survival.lowerShield();
      if (this.combat) this.combat.stopMovement();
      return;
    }

    // 1c. High-priority Anti-Crystal / Anti-Anchor defense against nearby enemy explosives
    if (!totemSwapActive && this.burst && this.burst.tickDefense(target)) {
      if (this.combat) this.combat.releaseControl();
      return;
    }

    // 2. Global emergency retreat override (bot.health <= 9 during active engagement)
    if (
      target &&
      target.isValid &&
      this.state === STATES.ENGAGING &&
      this.survival.needsRetreat()
    ) {
      if (this.burst && this.burst.state !== 'IDLE' && this.burst.state !== 'WIND_CLUTCH') {
        this.burst.cancel();
      }
      this.transitionState(STATES.RETREATING, `critical HP (${this.bot.health.toFixed(1)} <= ${this.config.survival.retreatHealthThreshold})`);
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
    // Stay calm in safe LOBBY hubs, but always engage in DUELS/FFA arenas (respecting red_wool safe zone in FFA).
    const engageRange = this.config.combat.engageRange || 96.0;
    const arenaMode = this._detectArenaMode();
    if (arenaMode === 'LOBBY' && this._hasLobbyMenuItems()) {
      this.inDuelArena = false;
      this.inFfaArena = false;
      this.pendingDuelReady = false;
      this.autoStartDuelUntil = 0;
      if (!this.autoFight) {
        this._tickSpawnRoam();
        return;
      }
    }
    const canEngagePending = arenaMode === 'DUELS' || this._hasCombatKit();

    if (this.pendingDuelTarget && this.pendingDuelReady && canEngagePending) {
      const pending = this._findPlayerEntity(this.pendingDuelTarget);
      if (pending && this.bot.entity.position.distanceTo(pending.position) <= engageRange) {
        this._engageTarget(pending, `duel start (${this.pendingDuelTarget})`);
        return;
      }
    }

    const now = Date.now();
    if (arenaMode === 'FFA') {
      if (this.redWoolZone && this.redWoolZone.tick(null, { allowSprint: this._hasCombatKit(), forceLook: false })) {
        return;
      }
      const ffaTarget = this._pickEngageableTarget('FFA', engageRange);
      if (ffaTarget) {
        this._engageTarget(ffaTarget.entity, 'FFA arena auto-engage');
        return;
      }
    } else if (arenaMode === 'DUELS') {
      const duelTarget = this._pickEngageableTarget('DUELS', engageRange);
      if (duelTarget) {
        this._engageTarget(duelTarget.entity, 'Duels arena auto-engage');
        return;
      }
    } else if (this.autoFight || now < this.autoStartDuelUntil) {
      if (this.redWoolZone && this.redWoolZone.tick(null, { allowSprint: false, forceLook: false })) {
        return;
      }
      const autoTarget = this._pickEngageableTarget(arenaMode, engageRange);
      if (autoTarget && (this.autoFight || this._listNearbyPlayers().length <= 2)) {
        this._engageTarget(autoTarget.entity, this.autoFight ? '!auto nearest target' : 'arena auto-start');
        return;
      }
    }

    this._tickSpawnRoam();
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
        this._clearTargetState();
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

      // Hunt timed out — if in FFA/Duels or !auto is ON, switch to next eligible opponent outside red_wool
      const arenaMode = this._detectArenaMode();
      if (this.autoFight || arenaMode === 'FFA' || arenaMode === 'DUELS') {
        const nextTarget = this._pickEngageableTarget(arenaMode, this.config.combat.disengageRange || 96.0);
        if (nextTarget) {
          this._engageTarget(nextTarget.entity, `${arenaMode.toLowerCase()} re-acquire`);
          return;
        }
      }

      this._clearTargetState();
      if (nearLoot) {
        this.transitionState(STATES.LOOTING, 'collecting nearby drops');
      } else {
        this.transitionState(STATES.IDLE, 'target lost after hunt timeout');
      }
      return;
    }

    const arenaMode = this._detectArenaMode();
    if (
      (arenaMode === 'FFA' || this.inFfaArena) &&
      this.redWoolZone &&
      this.redWoolZone.isPositionInSafeZone(target.position)
    ) {
      // Opponent retreated inside the FFA red_wool safe zone -> switch to an outside target or disengage
      const alt = this._pickEngageableTarget('FFA', this.config.combat.engageRange || 96.0);
      if (alt && alt.entity.id !== target.id) {
        this._engageTarget(alt.entity, 'target entered red_wool safe zone, switching');
        return;
      }
      this._clearTargetState();
      this.transitionState(STATES.IDLE, 'target entered FFA red_wool safe zone');
      return;
    }

    // Target is visible -> update hunt tracking position
    this.targetLastSeenPos = target.position.clone();
    this.targetLostAt = 0;

    const dist = this.bot.entity.position.distanceTo(target.position);
    if (dist > (this.config.combat.disengageRange || 96.0)) {
      if (this.autoFight || arenaMode === 'FFA' || arenaMode === 'DUELS') {
        const alt = this._pickEngageableTarget(arenaMode, this.config.combat.disengageRange || 96.0);
        if (alt && alt.entity.id !== target.id) {
          this._engageTarget(alt.entity, `${arenaMode.toLowerCase()} closer target`);
          return;
        }
      }
      this._clearTargetState();
      this.transitionState(STATES.IDLE, 'target out of disengage range');
      return;
    }

    // Survival priority transitions (Priority 2: <= 9 HP triggers Obsidian cover + Gapple / Pearl reset)
    if (this.survival.needsRetreat()) {
      this.transitionState(STATES.RETREATING, `critical health (${this.bot.health.toFixed(1)})`);
      return;
    }
    if (this.survival.needsHealing()) {
      this.transitionState(STATES.HEALING, `gapple heal (${this.bot.health.toFixed(1)} HP)`);
      return;
    }

    // Let server teleport synchronization settle briefly before forced combat/elytra packets
    // (Allow active PEARL_CATCH to continue immediately after our own pearl-catch teleport!)
    const activeOwnPearlCatch = Boolean(this.aerial && this.aerial.mode === 'PEARL_CATCH');
    if (!activeOwnPearlCatch && this.lastTeleportAt && (Date.now() - this.lastTeleportAt) < 200) {
      this.combat.stopMovement();
      return;
    }

    // 0. Inline quick-potting (Instant Health II double-pot) & combat buffs (Strength/Swiftness/FireRes)
    //    Use releaseControl() so tickInlineCombatHeal's anti-enemy-heal splash/walk controls are preserved!
    if (this.survival.tickInlineCombatHeal(target)) {
      if (this.combat) this.combat.releaseControl();
      return;
    }

    // 1. Smart shield blocking (off-hand shield OR main-hand hotbar shield vs incoming Mace smashes)
    const weaponCooldownProgress = this.combat.getCooldownProgress();
    const skipShieldForHazard = Boolean(this.escape && this.escape.hasNearbyRailOrHazard(target));
    if (!skipShieldForHazard && this.survival.tickShield(target, weaponCooldownProgress)) {
      if (this.survival.shieldingForMace) {
        if (this.combat && this.combat.usingPathfinder && this.bot.pathfinder) {
          this.bot.pathfinder.setGoal(null);
          this.combat.usingPathfinder = false;
        }
        this.bot.setControlState('forward', false);
        this.bot.setControlState('left', false);
        this.bot.setControlState('right', false);
        this.bot.setControlState('sprint', false);
        this.bot.setControlState('jump', false);
        this.aimer.stepTowardsEntity(target, { force: true, heightOffset: 0.9 });
      } else {
        this.combat.stopMovement();
        this.aimer.stepTowardsEntity(target);
      }
      return;
    }

    // 1b. Anti-Stun-Slam sidestep: dodge diving Axe stun so we can snap shield back on Mace swap
    if (!skipShieldForHazard && this.survival.maceAntiStunActive) {
      this.aimer.stepTowardsEntity(target, { force: true, heightOffset: 0.9 });
      this.bot.setControlState('forward', false);
      this.bot.setControlState('back', true);
      this.bot.setControlState('left', this.combat ? this.combat.strafeDirection < 0 : true);
      this.bot.setControlState('right', this.combat ? this.combat.strafeDirection >= 0 : false);
      this.bot.setControlState('sprint', false);
      this.bot.setControlState('jump', false);
      return;
    }

    // 1c. Red Wool Radius Exit: step/sprint out past red_wool safezone ring before fighting
    if (this.redWoolZone && this.redWoolZone.tick(target, { allowSprint: true, forceLook: true })) {
      if (this.burst && this.burst.state !== 'IDLE') {
        this.burst.cancel();
      }
      return;
    }

    // 2. Primary Offense: Aerial Mace / Elytra-Rocket / Pearl-Catch / Spear-Mace PvP
    //    CRITICAL: Use releaseControl() — NOT stopMovement() — so airborne WASD+sprint steering & jumps are NEVER wiped out!
    if (this.config.aerial && this.config.aerial.enabled !== false && this.aerial && this.aerial.tick(target)) {
      this.combat.releaseControl();
      return;
    }

    // 3. End Crystal & Respawn Anchor PvP
    if (this.burst && this.burst.tick(target)) {
      this.combat.releaseControl();
      return;
    }

    // 3. Gap-closing Ender Pearls & cobweb escape (crossbow/bow disabled in CPvP mode)
    if (!this.ranged.isBusy()) {
      this.ranged.tryEnderPearl(target, 'chase') || this.ranged.tryCloseUtility(target);
    }

    if (this.ranged.tick(target)) {
      this.combat.releaseControl();
      return;
    }

    // 4. Priority 5 Fallback: sprint-strafe spacing and Sword/Axe shield-break pressure
    this.combat.tick(target);
  }

  _tickRetreating(target) {
    if (!target || !target.isValid) {
      if (this.survival.needsHealing()) {
        this.transitionState(STATES.HEALING, 'safe to heal after retreat');
      } else {
        this._clearTargetState();
        this.transitionState(STATES.IDLE, 'threat gone during retreat');
      }
      return;
    }

    const dist = this.bot.entity.position.distanceTo(target.position);
    const retreatDist = this.config.survival.retreatDistance || 12.0;

    // Re-engage immediately once health & hunger are safely restored OR if out of healing (fight to the death!)
    if (this.survival.isRecovered()) {
      this.transitionState(STATES.ENGAGING, 'recovered during retreat');
      return;
    }
    if (!this.survival.isConsuming && !this.survival.hasHealingSupplies()) {
      this.transitionState(STATES.ENGAGING, 'no healing supplies left — fighting to the death');
      return;
    }

    // Once sufficient separation is achieved (and not mid-gapple bite), finish healing cleanly in HEALING state
    if (dist >= retreatDist && !this.survival.isConsuming && this.survival.needsHealing()) {
      this.transitionState(STATES.HEALING, `created ${dist.toFixed(1)}b separation`);
      return;
    }

    // Defensive escape Ender Pearl at <= 9 HP when rushed or out of gapples (never interrupt active gapple bite or cover block)
    if (
      !this.ranged.isBusy() &&
      !this.survival.isConsuming &&
      !this.survival.pendingSplashPotion &&
      !this.survival.pendingLosBlock &&
      (!this.survival.findGoldenApple() || dist < 5.5)
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
        this._clearTargetState();
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

Object.assign(
  PvPBotController.prototype,
  packetSanitizerMethods,
  arenaDetectorMethods,
  spawnRoamMethods
);

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
