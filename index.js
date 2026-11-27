'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { loader: autoEatLoader } = require('mineflayer-auto-eat');

const { SmoothAimer } = require('./modules/aim');
const { BlockMiner } = require('./modules/mining');
const { PredictionModule } = require('./modules/prediction');
const { CombatModule } = require('./modules/combat');
const { SurvivalModule } = require('./modules/survival');
const { RangedModule } = require('./modules/ranged');
const { BurstModule } = require('./modules/burst');
const { TntCartSkill } = require('./modules/tntcart');
const { ShulkerBuffSkill } = require('./modules/shulker_buff');
const { AerialModule } = require('./modules/aerial');
const { EscapeModule } = require('./modules/escape');
const { LiquidDenyModule } = require('./modules/liquid_deny');
const { RedWoolZoneModule } = require('./modules/red_wool_zone');
const { packetSanitizerMethods } = require('./modules/controller/packet_sanitizer');
const { arenaDetectorMethods, stripColorCodes } = require('./modules/controller/arena_detector');
const { spawnRoamMethods } = require('./modules/controller/spawn_roam');
const { authProxyMethods } = require('./modules/controller/auth_proxy');
const { duelChatMethods } = require('./modules/controller/duel_chat');
const { commandMethods } = require('./modules/controller/commands');
const { targetTrackerMethods } = require('./modules/controller/target_tracker');

const STATES = Object.freeze({
  IDLE: 'IDLE',
  ENGAGING: 'ENGAGING',
  RETREATING: 'RETREATING',
  HEALING: 'HEALING',
  LOOTING: 'LOOTING'
});

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
    this.tntCart = null;
    this.cart = null;
    this.shulkerBuff = null;
    this.aerial = null;
    this.escape = null;
    this.miner = null;
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
    this._lootingSortPending = false;
    this._lastLootGoalKey = null;

    // Gentle casual spawn roaming state while IDLE in spawn/lobby
    this.roamInSpawn = cfg.bot ? cfg.bot.roamInSpawn !== false : true;
    this.spawnAnchorPos = null;
    this.roamPhase = 'PAUSED';
    this.roamPhaseUntil = 0;
    this.roamTargetPos = null;
    this.roamLastLookAt = 0;
    this.roamNextGlanceAt = 0;
    this.roamGlanceYaw = 0;
    this.roamGlancePitch = 0;
    this._roamCollideTicks = 0;

    // Ads, auth, proxy & duel state
    const advCfg = (cfg.bot && cfg.bot.advertise) || {};
    this.advertiseEnabled = advCfg.enabled !== false;
    this.advertiseTimer = null;
    this.lastAdvertiseIndex = -1;
    this.initializedOnSpawn = false;
    this.loginAttempted = false;
    this.loginSentAt = 0;
    this.loginFallbackTimer = null;
    this.authPromptTimer = null;
    this.kitSortTimer = null;
    this.duelsLoginJoinTimer = null;
    this.duelsLoginJoinDone = false;
    this.duelsRejoinTimer = null;
    this.lastDuelsRejoinSentAt = 0;
    this.duelAcceptTimer = null;
    this._recentDuelAccepts = new Map();
    this._physicsTickHandler = null;
    this._packetTimestamps = [];
    this._packetHead = 0;
    this.lastTeleportAt = 0;
    this._arenaInvCache = null;
    this._nearbyPlayersCache = null;
    this._nearbyPlayersCacheAt = 0;
    this._lastAutoRetaliateAt = 0;

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
      this._invalidateArenaInventoryCache();

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

        this.aimer = new SmoothAimer(bot, this.config.physics);
        this.prediction = new PredictionModule(bot, this.config);
        this.ranged = new RangedModule(bot, this.config, this.aimer, this.prediction);
        this.combat = new CombatModule(bot, this.config, this.aimer, this.ranged, this.prediction);
        this.survival = new SurvivalModule(bot, this.config, this.aimer);
        this.burst = new BurstModule(bot, this.config, this.aimer, this.prediction, this.combat, this.survival);
        this.tntCart = new TntCartSkill(bot, this.config, this.aimer, this.prediction, this.combat, (m) => this.log(m));
        this.cart = this.tntCart;
        this.shulkerBuff = new ShulkerBuffSkill(bot, this.config, this.aimer, this.survival, (m) => this.log(m));
        this.aerial = new AerialModule(bot, this.config, this.aimer, this.prediction, this.combat);
        this.escape = new EscapeModule(bot, this.config, this.aimer);
        this.miner = new BlockMiner(bot, this.aimer);
        this.liquidDeny = new LiquidDenyModule(bot, this.config, this.aimer);
        this.redWoolZone = new RedWoolZoneModule(bot, this.config, this.aimer);

        if (bot.inventory && typeof bot.inventory.on === 'function') {
          this._onArenaInvUpdate = () => this._invalidateArenaInventoryCache();
          bot.inventory.on('updateSlot', this._onArenaInvUpdate);
        }

        this.survival.configureAutoEat();
        this.survival.setCombatActive(false);
        this.survival.setAutoEatEnabled(false);
        this.liquidDeny.setCombatActive(false);
        this.combat.scanHotbarSlots();

        this.spawnAnchorPos = bot.entity.position.clone();
        this._resetSpawnRoam();
        this.transitionState(STATES.IDLE, 'initial spawn');
        this._startTickLoop();
        this._scheduleAdvertise();

        if (this.loginPassword) {
          this._clearLoginFallbackTimer();
          this.loginFallbackTimer = setTimeout(() => {
            if (this.bot && !this.loginAttempted) {
              this._sendLoginCommand('login', 'spawn fallback');
            }
          }, 3000);
        } else {
          this._scheduleDuelsLoginJoin('initial spawn');
        }
      } else {
        this.duelsLoginJoinDone = true;
        this._clearDuelsLoginJoinTimer('server/world switch');
        this.log(`Switched world/server — spawned at ${bot.entity.position.floored()}.`);
        this._clearTargetState();
        this.inFfaArena = false;
        this.spawnAnchorPos = bot.entity.position.clone();
        this._resetSpawnRoam();

        const recentlyEndedDuel = (Date.now() - this.duelEndedAt) < 10000;
        const nearbyCount = this._listNearbyPlayers(true).length;
        const hasLobbyMenu = this._hasLobbyMenuItems();
        const hasCombatKit = this._hasCombatKit();
        const inRedWoolSafeZone = Boolean(
          this.redWoolZone && this.redWoolZone.isPositionInSafeZone(bot.entity.position)
        );

        if (recentlyEndedDuel || hasLobbyMenu) {
          this.pendingDuelTarget = null;
          this.pendingDuelReady = false;
          this.autoStartDuelUntil = 0;
          this.inDuelArena = false;
          this.inFfaArena = false;
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
      this._invalidateArenaInventoryCache();
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
      this._clearTimers();
      if (bot.inventory && this._onArenaInvUpdate && typeof bot.inventory.removeListener === 'function') {
        bot.inventory.removeListener('updateSlot', this._onArenaInvUpdate);
      }
      if (this.combat) this.combat.dispose();
      if (this.survival) this.survival.dispose();
      if (this.ranged) this.ranged.dispose();
      if (this.burst) this.burst.dispose();
      if (this.tntCart) this.tntCart.dispose();
      if (this.shulkerBuff) this.shulkerBuff.dispose();
      if (this.aerial) this.aerial.dispose();
      if (this.escape) this.escape.dispose();
      if (this.miner) this.miner.cancel(true);
      if (this.liquidDeny) this.liquidDeny.dispose();
      if (this.redWoolZone) this.redWoolZone.dispose();
      if (this.prediction) this.prediction.clear();
      this.bot = null;
      this._scheduleReconnect();
    });
  }

  transitionState(nextState, reason = '') {
    if (this.state === nextState) return;
    const prevState = this.state;

    if (this.combat) this.combat.stopMovement();
    if (this.ranged) this.ranged.cancel();
    if (this.survival) this.survival.stopConsumption();
    if (this.burst) this.burst.cancel();
    if (this.cart) this.cart.cancel();
    if (this.aerial) this.aerial.cancel();
    if (this.escape) this.escape.cancel();
    if (this.miner) this.miner.cancel(false);
    if (this.liquidDeny) this.liquidDeny.cancel();
    if (this.redWoolZone) this.redWoolZone.cancel();
    if (nextState === STATES.IDLE && this.prediction) {
      this.prediction.clear();
    }
    if (this.bot) {
      this.bot.clearControlStates();
      if (this.bot.pathfinder) this.bot.pathfinder.setGoal(null);
    }

    this._lastLootGoalKey = null;
    this._lootingSortPending = false;
    this.state = nextState;
    this.log(`State transition: ${prevState} -> ${nextState}${reason ? ` (${reason})` : ''}`);

    const inCombatOrLoot = nextState !== STATES.IDLE;
    if (this.survival) {
      this.survival.setCombatActive(inCombatOrLoot);
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
    this._clearKitSortTimer();
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

  _tick() {
    if (!this.bot || !this.bot.entity) return;

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

    // Priority Lock Arbitration:
    // 1. Off-Hand Totem safety (suppressed ONLY when an open Shulker window is actively being looted)
    const shulkerLocked = Boolean(this.shulkerBuff && this.shulkerBuff.isContainerLocked());
    const totemSwapActive = !shulkerLocked && this.survival.ensureOffhandSafety(target);
    if (totemSwapActive) {
      if (this.burst && this.burst.state !== 'IDLE') this.burst.cancel();
      if (this.tntCart && this.tntCart.isBusy()) this.tntCart.cancel();
      if (this.combat && this.state === STATES.ENGAGING) this.combat.stopMovement();
      if (this.state === STATES.ENGAGING) return;
    }

    if (this.prediction && target && target.isValid) {
      this.prediction.tick(target);
    }

    // 1b. Priority #1 Lock: Escape & Last-Resort Cobweb Sword Mining (`COBWEB_ESCAPE` > `SHULKER_BUFF` > `TNTCART_COMBO` > `DEFAULT_PVP`)
    const isStationaryAction = Boolean(
      this.survival.isConsuming ||
      this.survival.isShielding ||
      this.survival.pendingLosBlock ||
      (this.shulkerBuff && this.shulkerBuff.isBusy()) ||
      (this.tntCart && this.tntCart.isBusy()) ||
      (this.burst && this.burst.isBusy()) ||
      (this.aerial && this.aerial.isBusy()) ||
      (this.liquidDeny && this.liquidDeny.isBusy()) ||
      (this.redWoolZone && this.redWoolZone.isBusy())
    );
    if (
      !totemSwapActive &&
      !shulkerLocked &&
      this.escape &&
      this.escape.tick(target, {
        canTrackStall: (this.state === STATES.ENGAGING || this.state === STATES.RETREATING) && !isStationaryAction,
        hasFireRes: Boolean(this.survival && this.survival.isBuffActive('fire_res'))
      })
    ) {
      if (this.burst && this.burst.state !== 'IDLE') this.burst.cancel();
      if (this.tntCart && this.tntCart.isBusy()) this.tntCart.cancel();
      if (this.survival) this.survival.lowerShield();
      if (this.combat) this.combat.resetTransientState();
      return;
    }

    // 1c. Liquid Denial (suppress when escape, aerial clutch, OR ranged offensive lava owns liquid!)
    const suppressOwnLiquid = Boolean(
      (this.escape && this.escape.isManagingOwnLiquid()) ||
      (this.ranged && this.ranged.isManagingOwnLava()) ||
      (this.aerial && this.aerial.mode === 'CLUTCH')
    );
    if (!totemSwapActive && this.liquidDeny && this.liquidDeny.tick(target, { suppressOwnLiquid })) {
      if (this.survival) this.survival.lowerShield();
      if (this.combat) this.combat.stopMovement();
      return;
    }

    // 1d. Anti-Crystal / Anti-Anchor Defense
    if (!totemSwapActive && this.burst && this.burst.tickDefense(target)) {
      if (this.combat) this.combat.resetTransientState();
      return;
    }

    // 2. Emergency retreat check (single authoritative check per tick)
    if (
      target &&
      target.isValid &&
      this.state === STATES.ENGAGING &&
      this.survival.needsRetreat()
    ) {
      if (this.burst && this.burst.state !== 'IDLE') this.burst.cancel();
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

    if (this.miner && this.miner.manualTask && this.miner.tickManualTask()) {
      return;
    }

    this._tickSpawnRoam();
  }

  _tickEngaging(target) {
    const disengageRange = this.config.combat.disengageRange || 160.0;
    const engageRange = this.config.combat.engageRange || 96.0;

    if (!target || !target.isValid) {
      const now = Date.now();
      if (!this.targetLostAt) this.targetLostAt = now;

      const arenaMode = this._detectArenaMode();
      const inSpawnLobby = this._hasLobbyMenuItems();

      if (this.activeTargetName) {
        const reacquired = this._findPlayerEntity(this.activeTargetName);
        if (reacquired && !this._isPlayerInFfaSafeZone(reacquired, arenaMode)) {
          this.activeTargetEntityId = reacquired.id;
          this.targetLostAt = 0;
          return;
        }
      }

      const nearLoot = this.config.looting.enabled ? this._findNearestLoot() : null;
      const lootDroppedAtTarget = Boolean(
        nearLoot && this.targetLastSeenPos && nearLoot.position.distanceTo(this.targetLastSeenPos) <= 5.0
      );
      const diedRightHere = Boolean(
        !this.targetLastSeenPos || this.bot.entity.position.distanceTo(this.targetLastSeenPos) <= 6.0
      );

      if ((lootDroppedAtTarget || diedRightHere) && !inSpawnLobby) {
        const nextTarget = this._pickEngageableTarget(arenaMode, engageRange);
        if (nextTarget) {
          this._engageTarget(nextTarget.entity, 'target defeated — engaging next nearest opponent');
          return;
        }
      }

      if (lootDroppedAtTarget) {
        this._clearTargetState();
        this.transitionState(STATES.LOOTING, 'target defeated, collecting drops');
        return;
      }

      const huntTimeout = this.config.combat.targetHuntTimeoutMs || 12000;
      if (this.targetLastSeenPos && (now - this.targetLostAt) < huntTimeout) {
        if (!inSpawnLobby) {
          const nearbyOpp = this._pickEngageableTarget(arenaMode, engageRange);
          if (nearbyOpp && (nearbyOpp.dist <= 20.0 || (now - this.targetLostAt) >= 1500)) {
            this._engageTarget(nearbyOpp.entity, 'target lost — engaging nearest opponent');
            return;
          }
        }
        const lastPosInSafeZone = Boolean(
          !this.inDuelArena &&
          !this.pendingDuelReady &&
          this.redWoolZone &&
          this.redWoolZone.isPositionInSafeZone(this.targetLastSeenPos)
        );
        if (!lastPosInSafeZone && this.bot.entity.position.distanceTo(this.targetLastSeenPos) > 2.0) {
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

      if (!inSpawnLobby) {
        const nextTarget = this._pickEngageableTarget(arenaMode, disengageRange);
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
    if (this._isPlayerInFfaSafeZone(target, arenaMode)) {
      const alt = this._pickEngageableTarget('FFA', engageRange);
      if (alt && alt.entity.id !== target.id) {
        this._engageTarget(alt.entity, 'target entered red_wool safe zone, switching');
        return;
      }
      this._clearTargetState();
      this.transitionState(STATES.IDLE, 'target entered FFA red_wool safe zone');
      return;
    }

    this.targetLastSeenPos = target.position.clone();
    this.targetLostAt = 0;

    const dist = this.bot.entity.position.distanceTo(target.position);
    if (dist > disengageRange) {
      if (this.autoFight || arenaMode === 'FFA' || arenaMode === 'DUELS') {
        const alt = this._pickEngageableTarget(arenaMode, disengageRange);
        if (alt && alt.entity.id !== target.id) {
          this._engageTarget(alt.entity, `${arenaMode.toLowerCase()} closer target`);
          return;
        }
      }
      this._clearTargetState();
      this.transitionState(STATES.IDLE, 'target out of disengage range');
      return;
    }

    if (this.survival.needsHealing()) {
      // If enemy is right in melee range (< 5.0b) and we need to eat a gapple/food, RETREAT first so we don't eat in their face!
      if (dist < 5.0 && !this.survival.findHealingPotion()) {
        this.transitionState(STATES.RETREATING, `creating gap before heal (${this.bot.health.toFixed(1)} HP)`);
      } else {
        this.transitionState(STATES.HEALING, `gapple heal (${this.bot.health.toFixed(1)} HP)`);
      }
      return;
    }

    const activeOwnPearlCatch = Boolean(this.aerial && this.aerial.mode === 'PEARL_CATCH');
    if (!activeOwnPearlCatch && this.lastTeleportAt && (Date.now() - this.lastTeleportAt) < 200) {
      this.combat.stopMovement();
      return;
    }

    // 0. Inline quick-potting, combat buffs, & armor XP mending
    if (this.survival.tickInlineCombatHeal(target)) {
      if (this.combat) this.combat.resetTransientState();
      return;
    }

    // 1. Smart shield blocking & Anti-Stun-Slam sidestep
    const weaponCooldownProgress = this.combat.getCooldownProgress();
    const skipShieldForHazard = Boolean(this.escape && this.escape.hasNearbyRailOrHazard(target));
    if (!skipShieldForHazard && this.survival.tickShield(target, weaponCooldownProgress)) {
      if (this.combat) this.combat.resetTransientState();
      if (this.survival.shieldingForMace) {
        this.bot.setControlState('forward', false);
        this.bot.setControlState('left', false);
        this.bot.setControlState('right', false);
        this.bot.setControlState('sprint', false);
        this.bot.setControlState('jump', false);
        this.aimer.stepTowardsEntity(target, { heightOffset: 0.9 });
      } else {
        // Stay mobile while shielding (defensive strafe + micro-backpedal facing opponent, never stand like a statue!)
        this.aimer.stepTowardsEntity(target, { speedMultiplier: 1.65 });
        this.bot.setControlState('forward', false);
        this.bot.setControlState('back', dist < 3.2);
        this.bot.setControlState('left', this.combat ? this.combat.strafeDirection < 0 : false);
        this.bot.setControlState('right', this.combat ? this.combat.strafeDirection >= 0 : false);
        this.bot.setControlState('sprint', false);
        this.bot.setControlState('jump', false);
      }
      return;
    }

    if (!skipShieldForHazard && this.survival.maceAntiStunActive) {
      if (this.combat) this.combat.resetTransientState();
      this.aimer.stepTowardsEntity(target, { heightOffset: 0.9 });
      this.bot.setControlState('forward', false);
      this.bot.setControlState('back', true);
      this.bot.setControlState('left', this.combat ? this.combat.strafeDirection < 0 : true);
      this.bot.setControlState('right', this.combat ? this.combat.strafeDirection >= 0 : false);
      this.bot.setControlState('sprint', false);
      this.bot.setControlState('jump', false);
      return;
    }

    // 1c. Red Wool Radius Exit
    if (this.redWoolZone && this.redWoolZone.tick(target, { allowSprint: true })) {
      if (this.burst && this.burst.state !== 'IDLE') this.burst.cancel();
      if (this.combat) this.combat.resetTransientState();
      return;
    }

    // Priority #2 Lock: Shulker Box Strength Restock & Splash Buffing (`SHULKER_BUFF` > `TNTCART_COMBO` > `DEFAULT_PVP`)
    if (this.shulkerBuff && this.shulkerBuff.tick(target)) {
      if (this.tntCart && this.tntCart.isBusy()) this.tntCart.cancel();
      if (this.burst && this.burst.state !== 'IDLE') this.burst.cancel();
      if (this.combat) this.combat.resetTransientState();
      return;
    }

    // Priority #3 Lock: Dedicated TNT Minecart Skill (`TNTCART_COMBO` > `DEFAULT_PVP`)
    if (this.tntCart && this.tntCart.tick(target)) {
      if (this.burst && this.burst.state !== 'IDLE') this.burst.cancel();
      if (this.combat) this.combat.resetTransientState();
      return;
    }

    // 2. Aerial Mace / Elytra-Rocket / Pearl-Catch / Spear-Mace PvP
    if (this.config.aerial && this.config.aerial.enabled !== false && this.aerial && this.aerial.tick(target)) {
      if (this.combat) this.combat.resetTransientState();
      return;
    }

    // 3. End Crystal & Respawn Anchor PvP (legacy TNT Minecart / rail-cart combos deprecated)
    if (this.burst && this.burst.tick(target)) {
      if (this.combat) this.combat.resetTransientState();
      return;
    }

    // 4. Ranged (Chase Pearls, Predictive Cobweb/Lava Traps, Bow/Crossbow)
    if (!this.ranged.isBusy()) {
      this.ranged.tryEnderPearl(target, 'chase') || this.ranged.tryCloseUtility(target);
    }
    if (this.ranged.tick(target)) {
      if (this.combat) this.combat.resetTransientState();
      return;
    }

    // 5. High-tier Melee Spacing, Crosshair-Reactive Strafing, Crits, Hit-Select & Shield-Break
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

    if (this.survival.isRecovered()) {
      this.transitionState(STATES.ENGAGING, 'recovered during retreat');
      return;
    }
    if (!this.survival.isConsuming && !this.survival.hasHealingSupplies()) {
      this.transitionState(STATES.ENGAGING, 'no healing supplies left — fighting to the death');
      return;
    }
    if (dist >= retreatDist && !this.survival.isConsuming && this.survival.needsHealing()) {
      this.transitionState(STATES.HEALING, `created ${dist.toFixed(1)}b separation`);
      return;
    }

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
    if (target && target.isValid && !this.survival.isConsuming) {
      const dist = this.bot.entity.position.distanceTo(target.position);
      if (this.survival.needsRetreat() && dist < 5.0 && !this.survival.pendingSplashPotion) {
        this.transitionState(STATES.RETREATING, 'rushed while healing at critical HP');
        return;
      }
    }

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
    if (!this._hasLobbyMenuItems()) {
      const arenaMode = this._detectArenaMode();
      if (this.autoFight || arenaMode === 'FFA' || arenaMode === 'DUELS') {
        const nextTarget = this._pickEngageableTarget(arenaMode, this.config.combat.engageRange || 96.0);
        if (nextTarget) {
          this._engageTarget(nextTarget.entity, 'opponent nearby during looting');
          return;
        }
      }
    }

    if (this._lootingSortPending) {
      return;
    }

    const elapsed = Date.now() - this.lootStartedAt;
    const maxDuration = this.config.looting.maxDurationMs || 8000;
    const loot = this._findNearestLoot();

    if (!loot || elapsed > maxDuration) {
      // Complete inventory equip/sort BEFORE transitioning to packet-quiet IDLE!
      this._lootingSortPending = true;
      const reason = loot ? 'looting timed out' : 'area looted';
      this.survival.autoEquipAndSort()
        .catch(() => {})
        .finally(() => {
          this._lootingSortPending = false;
          if (this.combat) this.combat.scanHotbarSlots();
          if (this.state === STATES.LOOTING) {
            this.transitionState(STATES.IDLE, reason);
          }
        });
      return;
    }

    const dist = this.bot.entity.position.distanceTo(loot.position);
    if (dist > 4.5 && this.bot.pathfinder) {
      const goalKey = `${loot.id}:${Math.floor(loot.position.x)},${Math.floor(loot.position.y)},${Math.floor(loot.position.z)}`;
      if (this._lastLootGoalKey !== goalKey) {
        this._lastLootGoalKey = goalKey;
        this.bot.pathfinder.setGoal(
          new goals.GoalNear(loot.position.x, loot.position.y, loot.position.z, 1),
          true
        );
      }
    } else {
      if (this._lastLootGoalKey !== null && this.bot.pathfinder) {
        this.bot.pathfinder.setGoal(null);
        this._lastLootGoalKey = null;
      }
      const aimStatus = this.aimer.stepTowardsPoint(loot.position);
      this.bot.setControlState('forward', aimStatus.yawErrorDeg < 45);
      this.bot.setControlState('sprint', false);
    }
  }

  shutdown() {
    this.shuttingDown = true;
    this._clearTimers();
    if (this.rl) {
      try { this.rl.close(); } catch (_) {}
      this.rl = null;
    }
    if (this.bot) {
      try { this.bot.quit('Shutting down'); } catch (_) {}
    }
  }
}

Object.assign(
  PvPBotController.prototype,
  packetSanitizerMethods,
  arenaDetectorMethods,
  spawnRoamMethods,
  authProxyMethods,
  duelChatMethods,
  commandMethods,
  targetTrackerMethods
);

if (require.main === module) {
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
  controller.startConsole();
  controller.start();
}

module.exports = { PvPBotController, STATES, loadRuntimeConfig, stripColorCodes };
