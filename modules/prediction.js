'use strict';

const { Vec3 } = require('vec3');
const { clamp } = require('./aim');

/**
 * Multi-tick Minecraft trajectory predictor.
 * Tracks each target's position, velocity, acceleration, and ground state over a rolling
 * 5-tick window, then projects their hitbox 3–5 ticks (150–250ms) ahead using Minecraft's
 * horizontal drag (0.91x in air, 0.6x on ground) and vertical gravity (-0.08 blocks/tick^2).
 */
class PredictionModule {
  constructor(bot, config) {
    this.bot = bot;
    this.config = config;
    this.predCfg = (config && config.prediction) || {};

    this.historyTicks = this.predCfg.historyTicks || 5;
    this.minLeadTicks = this.predCfg.minLeadTicks || 3;
    this.maxLeadTicks = this.predCfg.maxLeadTicks || 5;
    this.defaultLeadTicks = this.predCfg.defaultLeadTicks || 4;
    this.airDrag = this.predCfg.airDrag !== undefined ? this.predCfg.airDrag : 0.91;
    this.groundDrag = this.predCfg.groundDrag !== undefined ? this.predCfg.groundDrag : 0.6;
    this.gravity = this.predCfg.gravity !== undefined ? this.predCfg.gravity : -0.08;

    // Map<entityId, Array<{ pos: Vec3, vel: Vec3, onGround: boolean, ts: number }>>
    this.histories = new Map();
  }

  /**
   * Clears all stored entity histories.
   */
  clear() {
    this.histories.clear();
  }

  /**
   * Records one 20-TPS tick sample for `target` into its rolling 5-tick window.
   */
  tick(target) {
    if (!target || !target.isValid || !target.position) return;

    const id = target.id !== undefined ? target.id : target.username;
    let window = this.histories.get(id);
    if (!window) {
      window = [];
      this.histories.set(id, window);
    }

    const pos = target.position.clone();
    const rawVel = target.velocity ? target.velocity.clone() : new Vec3(0, 0, 0);

    // Derive fallback velocity from position delta if server doesn't stream entity velocity updates
    let vel = rawVel;
    if (window.length > 0 && rawVel.norm() < 1e-4) {
      const prev = window[window.length - 1];
      const dtTicks = Math.max(1, Math.round((Date.now() - prev.ts) / 50));
      if (dtTicks <= 4) {
        vel = pos.minus(prev.pos).scaled(1 / dtTicks);
      }
    }

    // Infer ground state from entity flag or block directly underneath
    let onGround = typeof target.onGround === 'boolean' ? target.onGround : false;
    if (typeof target.onGround !== 'boolean' && this.bot && typeof this.bot.blockAt === 'function') {
      const below = this.bot.blockAt(pos.offset(0, -0.08, 0));
      onGround = Boolean(below && below.boundingBox === 'block' && Math.abs(vel.y) < 0.05);
    }

    window.push({ pos, vel, onGround, ts: Date.now() });
    while (window.length > this.historyTicks) {
      window.shift();
    }
  }

  /**
   * Computes smoothed velocity, acceleration, horizontal speed, and ground state over
   * the target's rolling 5-tick history window.
   */
  getTargetKinematics(target) {
    if (!target || !target.position) {
      return {
        position: new Vec3(0, 0, 0),
        velocity: new Vec3(0, 0, 0),
        acceleration: new Vec3(0, 0, 0),
        onGround: true,
        horizontalSpeed: 0,
        samples: 0
      };
    }

    const id = target.id !== undefined ? target.id : target.username;
    const window = this.histories.get(id);

    if (!window || window.length === 0) {
      const vel = target.velocity ? target.velocity.clone() : new Vec3(0, 0, 0);
      return {
        position: target.position.clone(),
        velocity: vel,
        acceleration: new Vec3(0, 0, 0),
        onGround: typeof target.onGround === 'boolean' ? target.onGround : true,
        horizontalSpeed: Math.sqrt(vel.x * vel.x + vel.z * vel.z),
        samples: 0
      };
    }

    const latest = window[window.length - 1];
    let ax = 0;
    let ay = 0;
    let az = 0;

    if (window.length >= 2) {
      let weightSum = 0;
      for (let i = 1; i < window.length; i++) {
        // Weight more recent ticks slightly higher
        const w = i;
        ax += (window[i].vel.x - window[i - 1].vel.x) * w;
        ay += (window[i].vel.y - window[i - 1].vel.y) * w;
        az += (window[i].vel.z - window[i - 1].vel.z) * w;
        weightSum += w;
      }
      ax /= weightSum;
      ay /= weightSum;
      az /= weightSum;
    }

    // Clamp acceleration to realistic player steering bounds so knockback spikes don't overshoot
    const acceleration = new Vec3(
      clamp(ax, -0.1, 0.1),
      clamp(ay, -0.12, 0.12),
      clamp(az, -0.1, 0.1)
    );

    return {
      position: latest.pos.clone(),
      velocity: latest.vel.clone(),
      acceleration,
      onGround: latest.onGround,
      horizontalSpeed: Math.sqrt(latest.vel.x * latest.vel.x + latest.vel.z * latest.vel.z),
      samples: window.length
    };
  }

  /**
   * Projects target position `ticksAhead` ticks into the future using Minecraft drag
   * (0.91x air, 0.6x ground), vertical gravity (-0.08 blocks/tick^2), and block collisions.
   */
  predictPosition(target, ticksAhead = this.defaultLeadTicks) {
    if (!target || !target.position) {
      return { position: new Vec3(0, 0, 0), velocity: new Vec3(0, 0, 0), onGround: true, ticksAhead: 0 };
    }

    const steps = clamp(Math.round(ticksAhead), 1, Math.max(this.maxLeadTicks, 10));
    const kin = this.getTargetKinematics(target);

    let x = target.position.x;
    let y = target.position.y;
    let z = target.position.z;
    let vx = kin.velocity.x;
    let vy = kin.velocity.y;
    let vz = kin.velocity.z;
    let onGround = kin.onGround;

    const ax = kin.acceleration.x;
    const az = kin.acceleration.z;

    for (let t = 0; t < steps; t++) {
      // Apply subtle decaying horizontal steering acceleration
      const accelDecay = Math.pow(0.75, t);
      const drag = onGround ? this.groundDrag : this.airDrag;

      // Advance position
      const nextX = x + vx;
      const nextZ = z + vz;
      let nextY = y + vy;

      // Check horizontal wall collision if world blocks are accessible
      if (this.bot && typeof this.bot.blockAt === 'function') {
        const feetBlock = this.bot.blockAt(new Vec3(nextX, y + 0.1, nextZ));
        const headBlock = this.bot.blockAt(new Vec3(nextX, y + 1.1, nextZ));
        if (
          (feetBlock && feetBlock.boundingBox === 'block') ||
          (headBlock && headBlock.boundingBox === 'block')
        ) {
          vx = 0;
          vz = 0;
        } else {
          x = nextX;
          z = nextZ;
        }

        // Check landing on solid floor block
        const belowBlock = this.bot.blockAt(new Vec3(x, nextY - 0.05, z));
        if (vy <= 0 && belowBlock && belowBlock.boundingBox === 'block') {
          const floorY = Math.floor(nextY - 0.05) + 1;
          nextY = Math.max(nextY, floorY);
          vy = 0;
          onGround = true;
        } else {
          onGround = false;
        }
      } else {
        x = nextX;
        z = nextZ;
      }

      y = nextY;

      // Apply Minecraft horizontal drag & vertical gravity (-0.08 blocks/tick^2)
      vx = (vx + ax * accelDecay) * drag;
      vz = (vz + az * accelDecay) * drag;

      if (!onGround) {
        vy = (vy + this.gravity) * 0.98;
      } else {
        vy = 0;
      }
    }

    return {
      position: new Vec3(x, y, z),
      velocity: new Vec3(vx, vy, vz),
      onGround,
      ticksAhead: steps
    };
  }

  /**
   * Projects the target's full axis-aligned bounding box `ticksAhead` ticks ahead.
   */
  predictHitbox(target, ticksAhead = this.defaultLeadTicks) {
    const pred = this.predictPosition(target, ticksAhead);
    const halfWidth = 0.3;
    const height = (target && target.height) || 1.8;

    return {
      feet: pred.position.clone(),
      center: pred.position.offset(0, height * 0.5, 0),
      torso: pred.position.offset(0, height * 0.72, 0),
      min: pred.position.offset(-halfWidth, 0, -halfWidth),
      max: pred.position.offset(halfWidth, height, halfWidth),
      velocity: pred.velocity,
      onGround: pred.onGround,
      ticksAhead: pred.ticksAhead
    };
  }

  /**
   * Computes an adaptive 3–5 tick (150–250ms) predicted intersection point for melee/strafe/ranged targeting.
   */
  predictIntersection(target, customLeadTicks = null) {
    let lead = customLeadTicks;
    if (lead === null || lead === undefined) {
      const dist = (this.bot && this.bot.entity && target && target.position)
        ? this.bot.entity.position.distanceTo(target.position)
        : 3.0;
      // Close melee: 3 ticks (150ms); mid-range/chasing: 4–5 ticks (200–250ms)
      lead = dist <= 3.5 ? this.minLeadTicks : (dist <= 6.5 ? this.defaultLeadTicks : this.maxLeadTicks);
    }
    return this.predictHitbox(target, clamp(lead, this.minLeadTicks, this.maxLeadTicks));
  }
}

module.exports = { PredictionModule };
