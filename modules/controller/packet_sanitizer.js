'use strict';

/**
 * Protocol sanitizer, teleport settle tracker, & outgoing packet-rate monitor for PvPBotController.
 * Normalizes 1.21.6+ shifted `entity_action` IDs and strips unexpected `teleport_confirm` fields.
 */
const packetSanitizerMethods = {
  _attachPacketMonitor(bot) {
    if (!bot || !bot._client || typeof bot._client.write !== 'function') return;
    const origWrite = bot._client.write.bind(bot._client);
    let cachedVersion = null;
    let isShiftedEntityAction = false;
    let usesLpVec3Velocity = false;

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

        // MC 1.21.9+ switched packet_entity_velocity from scaled i16 (1/8000 b/t) to lpVec3 (already in blocks/tick).
        // Mineflayer 4.39.0 still divides packet.velocity by 8000, reducing all knockback by 8000x!
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

    bot._client.write = (name, params, ...rest) => {
      let outParams = params;

      if (name === 'teleport_confirm' && params && typeof params === 'object') {
        outParams = { teleportId: Math.trunc(Number(params.teleportId) || 0) };
      } else if (name === 'entity_action' && params && typeof params === 'object') {
        if (params.actionId === 'start_elytra_flying') {
          outParams = { ...params, actionId: 'start_fall_flying' };
        } else if ((resolveProtocolQuirks(), isShiftedEntityAction) && typeof params.actionId === 'number') {
          // 1.21.6+ removed start_sneaking (0) / stop_sneaking (1) and shifted all later IDs down by 2
          if (params.actionId === 0 || params.actionId === 1) {
            return false;
          }
          const legacyMap = {
            3: 'start_sprinting',
            4: 'stop_sprinting',
            5: 'start_riding_jump',
            6: 'stop_riding_jump',
            7: 'open_inventory',
            8: 'start_fall_flying'
          };
          if (legacyMap[params.actionId]) {
            outParams = { ...params, actionId: legacyMap[params.actionId] };
          }
        }
      }

      const now = Date.now();
      this._packetTimestamps.push(now);
      if (this._packetTimestamps.length > 200) {
        this._packetTimestamps = this._packetTimestamps.filter((t) => (now - t) <= 1000);
      }
      return origWrite(name, outParams, ...rest);
    };

    if (typeof bot._client.on === 'function') {
      // Fix MC 1.21.9–1.21.11+ lpVec3 entity_velocity knockback (Mineflayer 4.39.0 divides lpVec3 by 8000)
      bot._client.on('entity_velocity', (packet) => {
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
      });

      bot._client.on('position', () => {
        this.lastTeleportAt = Date.now();
        if (this.aerial && typeof this.aerial.notifyTeleport === 'function') {
          this.aerial.notifyTeleport(4);
        }
        if (this.combat && typeof this.combat.cancelSpearLunge === 'function') {
          this.combat.cancelSpearLunge();
        }
      });
    }
  },

  getOutgoingPacketRate() {
    const now = Date.now();
    this._packetTimestamps = this._packetTimestamps.filter((t) => (now - t) <= 1000);
    return this._packetTimestamps.length;
  }
};

module.exports = { packetSanitizerMethods };
