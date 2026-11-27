'use strict';

const { Vec3 } = require('vec3');

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const TWO_PI = Math.PI * 2;

/**
 * Normalizes an angle in radians to the range [-PI, PI].
 * Prevents 360-degree wrap-around glitches when interpolating yaw.
 */
function normalizeAngle(rad) {
  let angle = rad % TWO_PI;
  if (angle > Math.PI) angle -= TWO_PI;
  if (angle < -Math.PI) angle += TWO_PI;
  return angle;
}

/**
 * Clamps a numeric value between min and max.
 */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Computes Mineflayer yaw and pitch (in radians) from an origin point to a target point.
 * Mineflayer coordinate convention:
 *   yaw = atan2(-dx, -dz)
 *   pitch = atan2(dy, sqrt(dx*dx + dz*dz))
 */
function calculateLookAngles(fromPos, toPos) {
  const dx = toPos.x - fromPos.x;
  const dy = toPos.y - fromPos.y;
  const dz = toPos.z - fromPos.z;
  const horizontalDist = Math.sqrt(dx * dx + dz * dz);

  const yaw = Math.atan2(-dx, -dz);
  const pitch = clamp(Math.atan2(dy, horizontalDist), -Math.PI / 2, Math.PI / 2);

  return { yaw, pitch };
}

/**
 * High-Tier Smooth Head-Rotation & AABB Hitbox Targeting Controller (20-TPS):
 * - Computes optimal closest-point-on-hitbox aim points so melee tracking stays glued to strafing players
 * - Uses adaptive responsive easing with per-tick angular caps (no sluggish lag behind fast strafers)
 * - Routes all normal rotations cleanly via `bot.look(yaw, pitch, false)` (anti-cheat safe)
 * - Eliminates micro-jitter once locked within 4° of target
 */
class SmoothAimer {
  constructor(bot, physicsConfig) {
    const cfg = physicsConfig || {};
    this.bot = bot;
    this.maxYawStep = Math.max(36, cfg.maxYawStepDeg || 44) * DEG_TO_RAD;
    this.maxPitchStep = Math.max(28, cfg.maxPitchStepDeg || 34) * DEG_TO_RAD;
    this.smoothing = clamp(cfg.aimSmoothing !== undefined ? Math.max(0.62, cfg.aimSmoothing) : 0.72, 0.1, 0.92);
    this.jitterRad = (cfg.aimJitterDeg !== undefined ? Math.min(0.25, cfg.aimJitterDeg) : 0.2) * DEG_TO_RAD;
    this.toleranceRad = (cfg.aimToleranceDeg || 8) * DEG_TO_RAD;
    // Instant combat aim snap when enabled (zero lag on 20-TPS strafers; pass { force: false } for slow roam)
    this.combatForceLook = cfg.combatForceLook !== undefined ? Boolean(cfg.combatForceLook) : true;
  }

  /**
   * Returns the bot's exact eye position as a Vec3 (handles elytra, sneaking, standing).
   */
  getEyePosition() {
    const pos = this.bot.entity.position;
    if (this.bot.entity.elytraFlying || this.bot.entity.pose === 1) {
      return pos.offset(0, 0.4, 0);
    }
    if (this.bot.entity.isSneaking) {
      return pos.offset(0, 1.27, 0);
    }
    const eyeHeight = this.bot.entity.height ? this.bot.entity.height * 0.9 : 1.62;
    return pos.offset(0, eyeHeight, 0);
  }

  /**
   * Computes the optimal reachable aim point on an entity's 3D AABB hitbox.
   * Clamps eye coordinates into the inner hitbox volume `[±0.24, +0.25..height-0.14]`
   * and optionally blends a tiny clamped velocity lead so melee crosshair NEVER drifts off-body.
   */
  getBestHitboxAimPoint(entity, options = {}) {
    const pos = entity.position;
    const height = entity.height || 1.8;

    if (options.heightOffset !== undefined) {
      const lead = options.leadTicks || 0;
      const vel = entity.velocity || { x: 0, y: 0, z: 0 };
      const maxLead = options.maxLeadBlocks !== undefined ? options.maxLeadBlocks : 0.35;
      const lx = clamp((vel.x || 0) * lead, -maxLead, maxLead);
      const ly = clamp((vel.y || 0) * lead * 0.5, -0.35, 0.35);
      const lz = clamp((vel.z || 0) * lead, -maxLead, maxLead);
      return new Vec3(pos.x + lx, pos.y + options.heightOffset + ly, pos.z + lz);
    }

    const eye = this.getEyePosition();
    const lead = options.leadTicks !== undefined ? options.leadTicks : 0.65;
    const maxLead = options.maxLeadBlocks !== undefined ? options.maxLeadBlocks : 0.28;
    const vel = entity.velocity || { x: 0, y: 0, z: 0 };
    const lx = clamp((vel.x || 0) * lead, -maxLead, maxLead);
    const ly = clamp((vel.y || 0) * lead * 0.4, -0.25, 0.25);
    const lz = clamp((vel.z || 0) * lead, -maxLead, maxLead);

    const cx = pos.x + lx;
    const cy = pos.y + ly;
    const cz = pos.z + lz;

    // Closest point inside inner hitbox (slightly biased toward upper chest for optimal reach & headshots)
    const halfW = 0.22;
    const minY = cy + 0.30;
    const maxY = cy + Math.max(0.5, height - 0.16);
    const preferredY = clamp(eye.y, minY, maxY);
    const chestY = cy + height * 0.68;

    const aimX = clamp(eye.x, cx - halfW, cx + halfW);
    const aimY = preferredY * 0.65 + chestY * 0.35;
    const aimZ = clamp(eye.z, cz - halfW, cz + halfW);
    return new Vec3(aimX, aimY, aimZ);
  }

  /**
   * Performs one responsive smooth rotation step toward target yaw/pitch (in radians).
   * Returns `{ aligned, yawErrorDeg, pitchErrorDeg }`.
   */
  stepTowardsAngles(targetYaw, targetPitch, options = {}) {
    if (!this.bot || !this.bot.entity) {
      return { aligned: false, yawErrorDeg: 180, pitchErrorDeg: 90 };
    }

    const clampedPitch = clamp(targetPitch, -Math.PI / 2, Math.PI / 2);
    const useForce = options.force !== undefined ? Boolean(options.force) : this.combatForceLook;
    if (useForce) {
      const nextYaw = normalizeAngle(targetYaw);
      if (typeof this.bot.look === 'function') {
        Promise.resolve(this.bot.look(nextYaw, clampedPitch, true)).catch(() => {});
      }
      return { aligned: true, yawErrorDeg: 0, pitchErrorDeg: 0 };
    }

    const currentYaw = this.bot.entity.yaw || 0;
    const currentPitch = this.bot.entity.pitch || 0;

    const yawDiff = normalizeAngle(targetYaw - currentYaw);
    const pitchDiff = clampedPitch - currentPitch;

    const speedMultiplier = options.speedMultiplier || 1.0;
    const maxYaw = this.maxYawStep * speedMultiplier;
    const maxPitch = this.maxPitchStep * speedMultiplier;
    const gain = clamp(this.smoothing * Math.min(1.25, 0.85 + speedMultiplier * 0.2), 0.2, 0.92);

    let yawStep = clamp(yawDiff * gain, -maxYaw, maxYaw);
    let pitchStep = clamp(pitchDiff * gain, -maxPitch, maxPitch);

    // Snap cleanly across tiny final deadzone (< 2.5°) so crosshair never crawls behind moving targets
    if (Math.abs(yawDiff) <= 0.045) {
      yawStep = yawDiff;
    } else if (Math.abs(yawStep) < 0.018) {
      yawStep = Math.sign(yawDiff) * Math.min(Math.abs(yawDiff), 0.024);
    }

    if (Math.abs(pitchDiff) <= 0.045) {
      pitchStep = pitchDiff;
    } else if (Math.abs(pitchStep) < 0.015) {
      pitchStep = Math.sign(pitchDiff) * Math.min(Math.abs(pitchDiff), 0.02);
    }

    // Subtle micro-jitter ONLY during larger sweeps (> 4°), zero jitter when locked on target
    const addJitter = options.jitter !== false && (Math.abs(yawDiff) > 0.07 || Math.abs(pitchDiff) > 0.07);
    const jitterYaw = addJitter ? (Math.random() - 0.5) * this.jitterRad : 0;
    const jitterPitch = addJitter ? (Math.random() - 0.5) * this.jitterRad * 0.5 : 0;

    const nextYaw = normalizeAngle(currentYaw + yawStep + jitterYaw);
    const nextPitch = clamp(currentPitch + pitchStep + jitterPitch, -Math.PI / 2, Math.PI / 2);

    if (
      typeof this.bot.look === 'function' &&
      (Math.abs(normalizeAngle(nextYaw - currentYaw)) >= 0.004 || Math.abs(nextPitch - currentPitch) >= 0.004)
    ) {
      Promise.resolve(this.bot.look(nextYaw, nextPitch, false)).catch(() => {});
    }

    const remainingYaw = Math.abs(normalizeAngle(targetYaw - nextYaw));
    const remainingPitch = Math.abs(clampedPitch - nextPitch);
    const tolerance = options.toleranceRad !== undefined ? options.toleranceRad : this.toleranceRad;

    return {
      aligned: remainingYaw <= tolerance && remainingPitch <= tolerance,
      yawErrorDeg: remainingYaw * RAD_TO_DEG,
      pitchErrorDeg: remainingPitch * RAD_TO_DEG
    };
  }

  /**
   * Smoothly rotates one tick toward a world position (Vec3).
   */
  stepTowardsPoint(targetPos, options = {}) {
    if (!this.bot || !this.bot.entity || !targetPos) {
      return { aligned: false, yawErrorDeg: 180, pitchErrorDeg: 90 };
    }
    const eyePos = this.getEyePosition();
    const { yaw, pitch } = calculateLookAngles(eyePos, targetPos);
    return this.stepTowardsAngles(yaw, pitch, options);
  }

  /**
   * Smoothly rotates one tick toward the optimal reachable point on an entity's 3D hitbox.
   */
  stepTowardsEntity(entity, options = {}) {
    if (!this.bot || !this.bot.entity || !entity || !entity.position) {
      return { aligned: false, yawErrorDeg: 180, pitchErrorDeg: 90 };
    }
    const aimPoint = this.getBestHitboxAimPoint(entity, options);
    return this.stepTowardsPoint(aimPoint, options);
  }

  /**
   * Immediately snaps head orientation using `bot.look(yaw, pitch, true)`.
   */
  lookImmediate(yaw, pitch) {
    return this.stepTowardsAngles(yaw, pitch, { force: true });
  }

  /**
   * Immediately snaps head orientation toward a world position using `force = true`.
   */
  lookAtPointImmediate(targetPos) {
    return this.stepTowardsPoint(targetPos, { force: true });
  }

  /**
   * Returns angular error (in degrees) from the bot's current facing to a target point.
   */
  getAngleErrorToPoint(targetPos) {
    if (!this.bot || !this.bot.entity || !targetPos) return 180;
    const eyePos = this.getEyePosition();
    const { yaw, pitch } = calculateLookAngles(eyePos, targetPos);
    const dy = Math.abs(normalizeAngle(yaw - (this.bot.entity.yaw || 0)));
    const dp = Math.abs(pitch - (this.bot.entity.pitch || 0));
    return Math.sqrt(dy * dy + dp * dp) * RAD_TO_DEG;
  }
}

module.exports = {
  SmoothAimer,
  normalizeAngle,
  clamp,
  calculateLookAngles,
  DEG_TO_RAD,
  RAD_TO_DEG
};
