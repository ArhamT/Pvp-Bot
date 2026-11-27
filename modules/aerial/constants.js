'use strict';

const DEFAULT_REACH = 3.0;

const AERIAL_MODES = Object.freeze({
  IDLE: 'IDLE',
  STUN_SLAM: 'STUN_SLAM',
  MACE_LAUNCH: 'MACE_LAUNCH',
  PEARL_CATCH: 'PEARL_CATCH',
  SPEAR_MACE: 'SPEAR_MACE',
  ELYTRA_DIVE: 'ELYTRA_DIVE',
  ELYTRA_SPEAR: 'ELYTRA_SPEAR',
  ELYTRA_BOOST: 'ELYTRA_BOOST',
  DIVE_DODGE: 'DIVE_DODGE',
  SLOW_FALL_EVADE: 'SLOW_FALL_EVADE',
  CLUTCH: 'CLUTCH'
});

const _fallFlyingActionCache = new Map();

/**
 * Resolves (and caches per version) the protocol-safe `entity_action` actionId for starting Elytra flight.
 * MC 1.21.6+ shifted `start_fall_flying` from 8 to 6 (removing sneaking actions),
 * and `'start_elytra_flying'` is not a valid minecraft-data mapper key on any version.
 */
function resolveStartFallFlyingActionId(bot) {
  const version = bot && bot.version;
  if (version && _fallFlyingActionCache.has(version)) {
    return _fallFlyingActionCache.get(version);
  }
  if (version) {
    try {
      const mcData = require('minecraft-data')(version);
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
      if (mappings && Object.values(mappings).includes('start_fall_flying')) {
        _fallFlyingActionCache.set(version, 'start_fall_flying');
        return 'start_fall_flying';
      }
    } catch (_) {}
  }

  const useString = bot &&
    typeof bot.supportFeature === 'function' &&
    bot.supportFeature('entityActionUsesStringMapper');
  const resolved = useString ? 'start_fall_flying' : 8;
  if (version) _fallFlyingActionCache.set(version, resolved);
  return resolved;
}

/**
 * Version-safe Elytra glide activation across MC 1.20.4–1.21.5 (8 / start_fall_flying)
 * and MC 1.21.6–1.21.11+ (6 / start_fall_flying).
 */
function sendStartElytraFlying(bot) {
  if (!bot || !bot._client || typeof bot._client.write !== 'function' || !bot.entity) {
    return false;
  }
  bot._client.write('entity_action', {
    entityId: bot.entity.id,
    actionId: resolveStartFallFlyingActionId(bot),
    jumpBoost: 0
  });
  return true;
}

module.exports = {
  DEFAULT_REACH,
  AERIAL_MODES,
  resolveStartFallFlyingActionId,
  sendStartElytraFlying
};
