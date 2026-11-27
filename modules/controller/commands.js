'use strict';

const readline = require('readline');
const { Vec3 } = require('vec3');

/**
 * Interactive Console & Owner Chat Command Dispatcher (`modules/controller/commands.js`).
 */
const commandMethods = {
  _clearKitSortTimer() {
    if (this.kitSortTimer) {
      clearTimeout(this.kitSortTimer);
      this.kitSortTimer = null;
    }
  },

  _isAuthorized(username) {
    if (!username || !this.bot || username === this.bot.username) return false;
    if (this._isIgnoredPlayer(username)) return false;
    const owner = this.config.bot.owner;
    if (!owner || owner === '*') return true;
    return username.toLowerCase() === owner.toLowerCase();
  },

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
  },

  executeBotCommand(command, args = [], caller = 'console', reply = (msg) => this.log(msg)) {
    if (command === 'help') {
      reply(
        'Commands: /<any server cmd> | <chat> | !duel [player] | !auto | !roam | !ads | !mine <block|x y z|stop> [count] | !stop | !kit [name] | !sort | !players | !status | !debug | !login | !quit'
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
      const nearby = this._listNearbyPlayers(true);
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
          if (!wasActive && this.state === 'IDLE') {
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
      if (!this.roamInSpawn && this.state === 'IDLE') {
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
        : {};
      const potSummary = Object.entries(pots).filter(([, v]) => v > 0).map(([k, v]) => `${k}x${v}`).join(',') || 'none';
      const aerialInfo = this.aerial ? `${this.aerial.mode}/${this.aerial.stage || '-'}` : 'off';
      const arenaFlags = this._getArenaInventoryFlags();
      const arenaMode = this._detectArenaMode();
      reply(
        `[DEBUG] State=${this.state} Arena=${arenaMode}(lobby=${arenaFlags.lobbyReason || 'none'}) Target=${this.activeTargetName || 'none'} (found=${Boolean(target)}, dist=${dist}) ` +
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
        const nearby = this._listNearbyPlayers(true);
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

    if (command === 'mine') {
      if (!this.miner) {
        reply('Mining module not initialized yet.');
        return;
      }
      if (!args[0] || args[0].toLowerCase() === 'stop') {
        this.miner.cancel(true);
        reply('Stopped manual mining.');
        return;
      }
      if (args.length >= 3 && !Number.isNaN(Number(args[0])) && !Number.isNaN(Number(args[1])) && !Number.isNaN(Number(args[2]))) {
        const pos = new Vec3(Math.floor(Number(args[0])), Math.floor(Number(args[1])), Math.floor(Number(args[2])));
        this.miner.startManualTask({ pos, count: 1 }, reply);
        reply(`Mining block at (${pos.x}, ${pos.y}, ${pos.z})...`);
        return;
      }
      const blockName = String(args[0]).toLowerCase();
      const count = Math.max(1, Math.min(64, parseInt(args[1], 10) || 1));
      this.miner.startManualTask({ blockName, count }, reply);
      reply(`Mining up to ${count}x ${blockName}...`);
      return;
    }

    if (command === 'stop') {
      if (this.miner) this.miner.cancel(true);
      this._clearTargetState(true);
      this.autoFight = false;
      this.transitionState('IDLE', '!stop command');
      reply('Stopped combat/mining, disabled !auto, and returned to IDLE.');
      return;
    }

    if (command === 'kit') {
      const customKit = args[0];
      const kitCmd = customKit ? `/kit ${customKit}` : (this.config.bot.kitCommand || '/kit pvp');
      this.bot.chat(kitCmd);
      this.log(`Requested kit via "${kitCmd}".`);

      this._clearKitSortTimer();
      this.kitSortTimer = setTimeout(async () => {
        this.kitSortTimer = null;
        if (!this.bot || !this.survival || this.shuttingDown) return;
        const wasActive = this.survival.activeInCombat;
        this.survival.setCombatActive(true);
        try {
          await this.survival.autoEquipAndSort();
          if (this.combat) this.combat.scanHotbarSlots();
          this.log('Kit armor equipped, hotbar sorted, and offhand secured.');
        } catch (err) {
          this.log(`Kit equip warning: ${err.message}`);
        } finally {
          if (!wasActive && this.state === 'IDLE') {
            this.survival.setCombatActive(false);
          }
        }
      }, 750);
      return;
    }

    reply(`Unknown bot command "!${command}". Type !help for available commands.`);
  },

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

    const duelCmdMatch = line.match(/^\/duel\s+(?:accept\s+)?([a-zA-Z0-9_]{2,20})\b/i);
    if (duelCmdMatch) {
      const candidate = duelCmdMatch[1];
      if (!['accept', 'deny', 'decline', 'toggle', 'stats', 'top', 'queue', 'spectate'].includes(candidate.toLowerCase())) {
        this.pendingDuelTarget = candidate;
        this.pendingDuelReady = false;
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
  },

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
};

module.exports = { commandMethods };
