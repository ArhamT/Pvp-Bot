'use strict';

/**
 * Protocol sanitizer, teleport settle tracker, & O(1) outgoing packet-rate monitor.
 * Normalizes 1.21.6+ shifted `entity_action` IDs (including `2: leave_bed`),
 * fixes MC 1.21.9+ `lpVec3` knockback velocity scaling, and strips invalid `teleport_confirm` fields.
 */
const packetSanitizerMethods = {
  _attachPacketMonitor(bot) {
    if (!bot || !bot._client || typeof bot._client.write !== 'function') return;
    const origWrite = bot._client.write.bind(bot._client);
    let cachedVersion = null;
    let isShiftedEntityAction = false;
    let usesLpVec3Velocity = false;
    this._loggedLpVec3Fix = false;
    this._packetHead = 0;

    const resolveProtocolQuirks = () => {
      const ver = bot.version || (bot._client && bot._client.version);
      if (!ver || ver === cachedVersion) return;
      cachedVersion = ver;
      isShiftedEntityAction = false;
      usesLpVec3Velocity = false;
      try {
        const mcData = require('minecraft-data')(ver);
        const eaSchema = mcData &&
          mcData.protocol &&
          mcData.protocol.play &&
          mcData.protocol.play.toServer &&
          mcData.protocol.play.toServer.types &&
          mcData.protocol.play.toServer.types.packet_entity_action;
        const actionField = Array.isArray(eaSchema) && Array.isArray(eaSchema[1])
          ? eaSchema[1].find((f) => f && f.name === 'actionId')
          : null;
        const mappings = actionField && Array.isArray(actionField.type) && actionField.type[1]
          ? actionField.type[1].mappings
          : null;
        isShiftedEntityAction = Boolean(mappings && mappings['6'] === 'start_fall_flying');

        const velSchema = mcData &&
          mcData.protocol &&
          mcData.protocol.play &&
          mcData.protocol.play.toClient &&
          mcData.protocol.play.toClient.types &&
          mcData.protocol.play.toClient.types.packet_entity_velocity;
        const velField = Array.isArray(velSchema) && Array.isArray(velSchema[1])
          ? velSchema[1].find((f) => f && f.name === 'velocity')
          : null;
        usesLpVec3Velocity = Boolean(velField && velField.type === 'lpVec3');
      } catch (_) {
        isShiftedEntityAction = false;
        usesLpVec3Velocity = false;
      }
    };

    const legacyShiftMap = {
      2: 'leave_bed',
      3: 'start_sprinting',
      4: 'stop_sprinting',
      5: 'start_riding_jump',
      6: 'stop_riding_jump',
      7: 'open_inventory',
      8: 'start_fall_flying'
    };

    bot._client.write = (name, params, ...rest) => {
      let outParams = params;

      if (name === 'teleport_confirm' && params && typeof params === 'object') {
        outParams = { teleportId: Math.trunc(Number(params.teleportId) || 0) };
      } else if (name === 'entity_action' && params && typeof params === 'object') {
        if (params.actionId === 'start_elytra_flying') {
          outParams = { ...params, actionId: 'start_fall_flying' };
        } else if ((resolveProtocolQuirks(), isShiftedEntityAction) && typeof params.actionId === 'number') {
          if (params.actionId === 0 || params.actionId === 1) {
            return false;
          }
          if (legacyShiftMap[params.actionId]) {
            outParams = { ...params, actionId: legacyShiftMap[params.actionId] };
          }
        }
      }

      const now = Date.now();
      this._packetTimestamps.push(now);
      if (this._packetTimestamps.length - this._packetHead > 256) {
        this._prunePacketTimestamps(now);
      }
      return origWrite(name, outParams, ...rest);
    };

    if (typeof bot._client.on === 'function') {
      const onEntityVelocity = (packet) => {
        resolveProtocolQuirks();
        if (!usesLpVec3Velocity || !packet || !packet.velocity || typeof packet.velocity !== 'object') return;
        const v = packet.velocity;
        if (typeof v.x !== 'number' || typeof v.y !== 'number' || typeof v.z !== 'number') return;

        const entity = (bot.entities && bot.entities[packet.entityId]) ||
          (bot.entity && bot.entity.id === packet.entityId ? bot.entity : null);
        if (!entity || !entity.velocity) return;

        if (typeof entity.velocity.set === 'function') {
          entity.velocity.set(v.x, v.y, v.z);
        } else {
          entity.velocity.x = v.x;
          entity.velocity.y = v.y;
          entity.velocity.z = v.z;
        }
      };

      const ensureVelocityFixLast = () => {
        if (typeof bot._client.removeListener === 'function') {
          bot._client.removeListener('entity_velocity', onEntityVelocity);
        }
        bot._client.on('entity_velocity', onEntityVelocity);
      };

      ensureVelocityFixLast();
      if (typeof bot.on === 'function') {
        bot.on('inject_allowed', () => setImmediate(ensureVelocityFixLast));
        bot.on('login', ensureVelocityFixLast);
        bot.on('spawn', () => {
          ensureVelocityFixLast();
          resolveProtocolQuirks();
          if (usesLpVec3Velocity && typeof this.log === 'function' && !this._loggedLpVec3Fix) {
            this._loggedLpVec3Fix = true;
            this.log('Applied MC 1.21.9+ lpVec3 entity_velocity knockback fix (post-plugin order).');
          }
        });
      }

      bot._client.on('position', () => {
        this.lastTeleportAt = Date.now();
        if (this.aerial && typeof this.aerial.notifyTeleport === 'function') {
          this.aerial.notifyTeleport(4);
        }
        if (this.ranged && typeof this.ranged.notifyTeleport === 'function') {
          this.ranged.notifyTeleport();
        }
        if (this.burst && typeof this.burst.notifyTeleport === 'function') {
          this.burst.notifyTeleport();
        }
        if (this.escape && typeof this.escape.cancel === 'function') {
          this.escape.cancel();
        }
      });
    }
  },

  _prunePacketTimestamps(now) {
    const cutoff = now - 1000;
    const arr = this._packetTimestamps;
    let head = this._packetHead || 0;
    while (head < arr.length && arr[head] < cutoff) {
      head++;
    }
    if (head > 128) {
      this._packetTimestamps = arr.slice(head);
      this._packetHead = 0;
    } else {
      this._packetHead = head;
    }
  },

  getOutgoingPacketRate() {
    this._prunePacketTimestamps(Date.now());
    return Math.max(0, this._packetTimestamps.length - (this._packetHead || 0));
  }
};

module.exports = { packetSanitizerMethods };
