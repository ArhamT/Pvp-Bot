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

    const resolveShiftedEntityAction = () => {
      const ver = bot.version || (bot._client && bot._client.version);
      if (!ver || ver === cachedVersion) return isShiftedEntityAction;
      cachedVersion = ver;
      isShiftedEntityAction = false;
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
      } catch (_) {
        isShiftedEntityAction = false;
      }
      return isShiftedEntityAction;
    };

    bot._client.write = (name, params, ...rest) => {
      let outParams = params;

      if (name === 'teleport_confirm' && params && typeof params === 'object') {
        outParams = { teleportId: Math.trunc(Number(params.teleportId) || 0) };
      } else if (name === 'entity_action' && params && typeof params === 'object') {
        if (params.actionId === 'start_elytra_flying') {
          outParams = { ...params, actionId: 'start_fall_flying' };
        } else if (resolveShiftedEntityAction() && typeof params.actionId === 'number') {
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
