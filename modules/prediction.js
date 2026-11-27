'use strict';

const { Vec3 } = require('vec3');
const { clamp } = require('./aim');

/**
 * High-Tier Adaptive Minecraft Trajectory Predictor (`modules/prediction.js`):
 * - Uses position-delta velocity estimation with EMA smoothing (accurate even when Paper/Spigot
 *   doesn't stream `entity.velocity` for other players!)
 * - Models active ground player speed persistence (0.94x while moving vs 0.6x coasting)
 * - Detects strafe reversals (`dot(vel, accel) < 0`) and damps lead so aim NEVER whips off-body
 * - Range-adaptive `predictIntersection`: tight hitbox-clamped lead in melee (<= 3.8b), full
 *   multi-tick physics projection for ranged, pearls, and aerial intercepts
 */
class PredictionModule {
  constructor(bot, config) {
    this.bot = bot;
    this.config = config;
    this.predCfg = (config && config.prediction) || {};

    this.historyTicks = Math.max(4, this.predCfg.historyTicks || 6);
    this.minLeadTicks = this.predCfg.minLeadTicks || 2;
    this.maxLeadTicks = this.predCfg.maxLeadTicks || 5;
    this.defaultLeadTicks = this.predCfg.defaultLeadTicks || 3;
    this.airDrag = this.predCfg.airDrag !== undefined ? this.predCfg.airDrag : 0.91;
    this.groundDrag = this.predCfg.groundDrag !== undefined ? this.predCfg.groundDrag : 0.6;
    this.gravity = this.predCfg.gravity !== undefined ? this.predCfg.gravity : -0.08;

    // Map<entityId, { samples: Array<{pos, vel, onGround, ts}>, emaVel: Vec3, lastTs: number }>
    this.histories = new Map();
  }

  clear() {
    this.histories.clear();
  }

  tick(target) {
    if (!target || !target.isValid || !target.position) return;

    const now = Date.now();
    const id = target.id !== undefined ? target.id : target.username;
    let record = this.histories.get(id);
    if (!record) {
      record = { samples: [], emaVel: new Vec3(0, 0, 0), lastTs: now };
      this.histories.set(id, record);
    }

    const pos = target.position.clone();
    const rawVel = target.velocity ? target.velocity.clone() : new Vec3(0, 0, 0);
    let instVel = rawVel;

    if (record.samples.length > 0) {
      const prev = record.samples[record.samples.length - 1];
      const dtMs = Math.max(25, now - prev.ts);
      const dtTicks = dtMs / 50;
      if (dtTicks <= 6) {
        const deltaPos = pos.minus(prev.pos);
        // Reject teleport spikes (> 3.5 blocks in a single tick)
        if (deltaPos.norm() > 3.5 * Math.max(1, dtTicks)) {
          record.samples.length = 0;
          record.emaVel = new Vec3(0, 0, 0);
          instVel = new Vec3(0, 0, 0);
        } else {
          const derived = deltaPos.scaled(1 / Math.max(0.5, dtTicks));
          // Position delta is authoritative for other players on Paper/Spigot; blend rawVel if present
          instVel = rawVel.norm() > 0.02
            ? derived.scaled(0.7).plus(rawVel.scaled(0.3))
            : derived;
        }
      } else {
        record.samples.length = 0;
        record.emaVel = rawVel.clone();
      }
    }

    // Clamp unrealistic horizontal velocity spikes (max ~0.85 b/t unless elytra/pearl)
    const maxHoriz = target.elytraFlying ? 2.2 : 0.85;
    const hNorm = Math.hypot(instVel.x, instVel.z);
    if (hNorm > maxHoriz) {
      const scale = maxHoriz / hNorm;
      instVel.x *= scale;
      instVel.z *= scale;
    }

    // Responsive EMA smoothing (alpha = 0.62) filters single-tick packet bunching cleanly
    if (record.samples.length === 0) {
      record.emaVel = instVel.clone();
    } else {
      const alpha = 0.62;
      record.emaVel = new Vec3(
        record.emaVel.x * (1 - alpha) + instVel.x * alpha,
        record.emaVel.y * (1 - alpha) + instVel.y * alpha,
        record.emaVel.z * (1 - alpha) + instVel.z * alpha
      );
    }

    let onGround = typeof target.onGround === 'boolean' ? target.onGround : false;
    if (typeof target.onGround !== 'boolean' && this.bot && typeof this.bot.blockAt === 'function') {
      const below = this.bot.blockAt(pos.offset(0, -0.08, 0));
      onGround = Boolean(below && below.boundingBox === 'block' && Math.abs(record.emaVel.y) < 0.06);
    }

    record.samples.push({ pos, vel: record.emaVel.clone(), onGround, ts: now });
    record.lastTs = now;
    while (record.samples.length > this.historyTicks) {
      record.samples.shift();
    }

    // Periodically prune stale entity entries
    if (this.histories.size > 24) {
      for (const [k, rec] of this.histories.entries()) {
        if ((now - rec.lastTs) > 20000) this.histories.delete(k);
      }
    }
  }

  getTargetKinematics(target) {
    if (!target || !target.position) {
      return {
        position: new Vec3(0, 0, 0),
        velocity: new Vec3(0, 0, 0),
        acceleration: new Vec3(0, 0, 0),
        onGround: true,
        horizontalSpeed: 0,
        reversing: false,
        samples: 0
      };
    }

    const id = target.id !== undefined ? target.id : target.username;
    const record = this.histories.get(id);

    if (!record || record.samples.length === 0) {
      const vel = target.velocity ? target.velocity.clone() : new Vec3(0, 0, 0);
      return {
        position: target.position.clone(),
        velocity: vel,
        acceleration: new Vec3(0, 0, 0),
        onGround: typeof target.onGround === 'boolean' ? target.onGround : true,
        horizontalSpeed: Math.hypot(vel.x, vel.z),
        reversing: false,
        samples: 0
      };
    }

    const window = record.samples;
    const latest = window[window.length - 1];
    let ax = 0;
    let ay = 0;
    let az = 0;

    if (window.length >= 2) {
      let weightSum = 0;
      for (let i = 1; i < window.length; i++) {
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

    // Strafe-reversal detection: if acceleration opposes current velocity, player is changing direction!
    const hSpeed = Math.hypot(latest.vel.x, latest.vel.z);
    const dot = latest.vel.x * ax + latest.vel.z * az;
    const reversing = hSpeed > 0.05 && dot < -0.002;

    const acceleration = reversing
      ? new Vec3(0, clamp(ay, -0.08, 0.08), 0)
      : new Vec3(clamp(ax, -0.05, 0.05), clamp(ay, -0.1, 0.1), clamp(az, -0.05, 0.05));

    return {
      position: latest.pos.clone(),
      velocity: latest.vel.clone(),
      acceleration,
      onGround: latest.onGround,
      horizontalSpeed: hSpeed,
      reversing,
      samples: window.length
    };
  }

  /**
   * Projects target position `ticksAhead` ticks into the future using realistic active-player
   * Minecraft physics, strafe-reversal damping, gravity (-0.08 b/t^2), and solid block collision.
   */
  predictPosition(target, ticksAhead = this.defaultLeadTicks) {
    if (!target || !target.position) {
      return { position: new Vec3(0, 0, 0), velocity: new Vec3(0, 0, 0), onGround: true, ticksAhead: 0 };
    }

    const kin = this.getTargetKinematics(target);
    // Damp projection horizon during active strafe reversal to avoid overshooting to the wrong side
    const effTicks = kin.reversing ? Math.min(ticksAhead, 1.5) : ticksAhead;
    const wholeSteps = Math.max(0, Math.floor(clamp(effTicks, 0, Math.max(this.maxLeadTicks, 12))));
    const fracStep = clamp(effTicks - wholeSteps, 0, 1);

    let x = target.position.x;
    let y = target.position.y;
    let z = target.position.z;
    let vx = kin.velocity.x;
    let vy = kin.velocity.y;
    let vz = kin.velocity.z;
    let onGround = kin.onGround;

    const ax = kin.acceleration.x;
    const az = kin.acceleration.z;
    const activelyMovingOnGround = onGround && kin.horizontalSpeed > 0.08 && !kin.reversing;
    const probe = new Vec3(0, 0, 0);

    const advanceStep = (dt, stepIndex) => {
      const nextX = x + vx * dt;
      const nextZ = z + vz * dt;
      let nextY = y + vy * dt;

      if (this.bot && typeof this.bot.blockAt === 'function') {
        // Check X and Z independently so players sliding along walls keep their parallel velocity!
        probe.x = Math.floor(nextX);
        probe.y = Math.floor(y + 0.2);
        probe.z = Math.floor(z);
        const fx0 = this.bot.blockAt(probe);
        probe.y = Math.floor(y + 1.2);
        const fx1 = this.bot.blockAt(probe);
        if ((fx0 && fx0.boundingBox === 'block') || (fx1 && fx1.boundingBox === 'block')) {
          vx = 0;
        } else {
          x = nextX;
        }

        probe.x = Math.floor(x);
        probe.y = Math.floor(y + 0.2);
        probe.z = Math.floor(nextZ);
        const fz0 = this.bot.blockAt(probe);
        probe.y = Math.floor(y + 1.2);
        const fz1 = this.bot.blockAt(probe);
        if ((fz0 && fz0.boundingBox === 'block') || (fz1 && fz1.boundingBox === 'block')) {
          vz = 0;
        } else {
          z = nextZ;
        }

        probe.x = Math.floor(x);
        probe.y = Math.floor(nextY - 0.05);
        probe.z = Math.floor(z);
        const below = this.bot.blockAt(probe);
        if (vy <= 0 && below && below.boundingBox === 'block') {
          nextY = Math.max(nextY, Math.floor(nextY - 0.05) + 1);
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

      const accelDecay = Math.pow(0.65, stepIndex);
      // Active ground player maintains speed (0.94 persistence) vs coasting (0.6 drag)
      const drag = onGround
        ? (activelyMovingOnGround ? 0.94 : this.groundDrag)
        : this.airDrag;

      vx = (vx + ax * accelDecay * dt) * Math.pow(drag, dt);
      vz = (vz + az * accelDecay * dt) * Math.pow(drag, dt);

      if (!onGround) {
        vy = (vy + this.gravity * dt) * Math.pow(0.98, dt);
      } else {
        vy = 0;
      }
    };

    for (let t = 0; t < wholeSteps; t++) {
      advanceStep(1.0, t);
    }
    if (fracStep > 0.05) {
      advanceStep(fracStep, wholeSteps);
    }

    return {
      position: new Vec3(x, y, z),
      velocity: new Vec3(vx, vy, vz),
      onGround,
      ticksAhead: effTicks
    };
  }

  predictHitbox(target, ticksAhead = this.defaultLeadTicks) {
    const pred = this.predictPosition(target, ticksAhead);
    const halfWidth = 0.3;
    const height = (target && target.height) || 1.8;

    return {
      feet: pred.position.clone(),
      center: pred.position.offset(0, height * 0.5, 0),
      torso: pred.position.offset(0, height * 0.68, 0),
      min: pred.position.offset(-halfWidth, 0, -halfWidth),
      max: pred.position.offset(halfWidth, height, halfWidth),
      velocity: pred.velocity,
      onGround: pred.onGround,
      ticksAhead: pred.ticksAhead
    };
  }

  /**
   * Range-adaptive predicted intersection:
   * - Melee (`<= 3.8b`): tight 0.8–1.2 tick lead clamped inside live hitbox envelope (NEVER aims off-body!)
   * - Mid-range (`3.8–7.5b`): 2–3 ticks
   * - Long-range (`> 7.5b`): 3–5 ticks
   */
  predictIntersection(target, customLeadTicks = null) {
    if (!target || !target.position) {
      return this.predictHitbox(target, 1);
    }
    const dist = (this.bot && this.bot.entity)
      ? this.bot.entity.position.distanceTo(target.position)
      : 3.0;

    if (customLeadTicks !== null && customLeadTicks !== undefined) {
      return this.predictHitbox(target, clamp(customLeadTicks, 0.5, Math.max(this.maxLeadTicks, 10)));
    }

    if (dist <= 3.8) {
      const hb = this.predictHitbox(target, dist <= 2.6 ? 0.6 : 1.0);
      // Clamp horizontal lead strictly within ±0.32b of live position so melee never misses a strafing player
      const dx = clamp(hb.feet.x - target.position.x, -0.32, 0.32);
      const dz = clamp(hb.feet.z - target.position.z, -0.32, 0.32);
      const dy = clamp(hb.feet.y - target.position.y, -0.45, 0.45);
      const clampedFeet = target.position.offset(dx, dy, dz);
      const h = target.height || 1.8;
      return {
        feet: clampedFeet,
        center: clampedFeet.offset(0, h * 0.5, 0),
        torso: clampedFeet.offset(0, h * 0.68, 0),
        min: clampedFeet.offset(-0.3, 0, -0.3),
        max: clampedFeet.offset(0.3, h, 0.3),
        velocity: hb.velocity,
        onGround: hb.onGround,
        ticksAhead: hb.ticksAhead
      };
    }

    const lead = dist <= 7.5 ? 2.5 : clamp(dist / 3.5, 3, this.maxLeadTicks);
    return this.predictHitbox(target, lead);
  }
}

module.exports = { PredictionModule };
