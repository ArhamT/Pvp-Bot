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

    const MOVE_PACKETS = new Set(['position', 'position_look', 'look', 'flying']);
    const MAX_COORD = 2.9999e7;
    let lastGood = { x: null, y: null, z: null, yaw: 0, pitch: 0 };
    this._movePacketFixes = 0;

    /**
     * Strict Paper 26.x `handleMovePlayer` guard: the server disconnects with
     * "Invalid move player packet received" if ANY pos/rot field is NaN/Infinity (or absurdly large).
     * Sanitize every outgoing movement packet: replace bad values with last-known-good,
     * clamp pitch to [-90, 90], wrap yaw to [-180, 180), and force on-ground to a strict boolean.
     */
    const sanitizeMovePacket = (params) => {
      if (!params || typeof params !== 'object') return params;
      let fixed = false;
      const out = { ...params };
      const ent = bot.entity;

      const fixCoord = (key) => {
        if (typeof out[key] !== 'number') return;
        const v = out[key];
        if (!Number.isFinite(v) || Math.abs(v) > MAX_COORD) {
          const fb = lastGood[key] !== null
            ? lastGood[key]
            : (ent && ent.position && Number.isFinite(ent.position[key]) ? ent.position[key] : 0);
          out[key] = fb;
          fixed = true;
        } else {
          lastGood[key] = v;
        }
      };
      fixCoord('x');
      fixCoord('y');
      fixCoord('z');

      if (typeof out.yaw === 'number') {
        if (!Number.isFinite(out.yaw)) {
          out.yaw = lastGood.yaw;
          fixed = true;
        } else {
          let y = out.yaw % 360;
          if (y >= 180) y -= 360;
          else if (y < -180) y += 360;
          if (y !== out.yaw) {
            out.yaw = y;
          }
          lastGood.yaw = out.yaw;
        }
      }
      if (typeof out.pitch === 'number') {
        if (!Number.isFinite(out.pitch)) {
          out.pitch = lastGood.pitch;
          fixed = true;
        } else {
          const p = Math.max(-90, Math.min(90, out.pitch));
          if (p !== out.pitch) {
            out.pitch = p;
            fixed = true;
          }
          lastGood.pitch = out.pitch;
        }
      }
      if ('onGround' in out && typeof out.onGround !== 'boolean') {
        out.onGround = Boolean(out.onGround);
      }
      if (out.flags && typeof out.flags === 'object') {
        out.flags = {
          onGround: Boolean(out.flags.onGround),
          hasHorizontalCollision: Boolean(out.flags.hasHorizontalCollision)
        };
      }
      if (fixed) this._movePacketFixes = (this._movePacketFixes || 0) + 1;
      return out;
    };

    bot._client.write = (name, params, ...rest) => {
      let outParams = params;

      if (MOVE_PACKETS.has(name)) {
        outParams = sanitizeMovePacket(params);
      } else if (name === 'teleport_confirm' && params && typeof params === 'object') {
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
        if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) return;

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
        // NaN/Infinity physics-state guard: a poisoned velocity would propagate into outgoing move packets
        bot.on('physicsTick', () => {
          const e = bot.entity;
          if (!e || !e.velocity) return;
          const v = e.velocity;
          if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) {
            if (typeof v.set === 'function') v.set(0, 0, 0);
            else { v.x = 0; v.y = 0; v.z = 0; }
          }
          if (Number.isFinite(e.yaw) === false) e.yaw = lastGood.yaw * Math.PI / -180 || 0;
          if (Number.isFinite(e.pitch) === false) e.pitch = 0;
        });
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
