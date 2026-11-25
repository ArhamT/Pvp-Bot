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
 * Smooth head-rotation controller designed to run once per 20-TPS (50ms) tick.
 * Uses exponential smoothing + per-tick angular velocity clamping + subtle human-like micro-jitter
 * so the bot never produces instant 180-degree head snaps.
 */
class SmoothAimer {
  constructor(bot, physicsConfig) {
    this.bot = bot;
    this.maxYawStep = (physicsConfig.maxYawStepDeg || 16) * DEG_TO_RAD;
    this.maxPitchStep = (physicsConfig.maxPitchStepDeg || 12) * DEG_TO_RAD;
    this.smoothing = clamp(physicsConfig.aimSmoothing || 0.35, 0.05, 0.9);
    this.jitterRad = (physicsConfig.aimJitterDeg || 0.35) * DEG_TO_RAD;
    this.toleranceRad = (physicsConfig.aimToleranceDeg || 6) * DEG_TO_RAD;
  }

  /**
   * Returns the bot's eye position as a Vec3.
   */
  getEyePosition() {
    const pos = this.bot.entity.position;
    const eyeHeight = this.bot.entity.height ? this.bot.entity.height * 0.9 : 1.62;
    return pos.offset(0, eyeHeight, 0);
  }

  /**
   * Performs one smooth interpolation step toward target yaw/pitch (in radians).
   * Returns { aligned: boolean, yawErrorDeg: number, pitchErrorDeg: number }.
   */
  stepTowardsAngles(targetYaw, targetPitch, options = {}) {
    if (!this.bot.entity) {
      return { aligned: false, yawErrorDeg: 180, pitchErrorDeg: 90 };
    }

    const currentYaw = this.bot.entity.yaw;
    const currentPitch = this.bot.entity.pitch;

    const yawDiff = normalizeAngle(targetYaw - currentYaw);
    const pitchDiff = clamp(targetPitch, -Math.PI / 2, Math.PI / 2) - currentPitch;

    const speedMultiplier = options.speedMultiplier || 1.0;
    const maxYaw = this.maxYawStep * speedMultiplier;
    const maxPitch = this.maxPitchStep * speedMultiplier;

    // Exponentially ease toward the target, clamped by per-tick angular velocity limits
    let yawStep = clamp(yawDiff * this.smoothing, -maxYaw, maxYaw);
    let pitchStep = clamp(pitchDiff * this.smoothing, -maxPitch, maxPitch);

    // Ensure steady progress when far away so smoothing doesn't crawl on the final few degrees
    if (Math.abs(yawDiff) > 0.01 && Math.abs(yawStep) < 0.008) {
      yawStep = Math.sign(yawDiff) * Math.min(Math.abs(yawDiff), 0.012);
    }
    if (Math.abs(pitchDiff) > 0.01 && Math.abs(pitchStep) < 0.008) {
      pitchStep = Math.sign(pitchDiff) * Math.min(Math.abs(pitchDiff), 0.012);
    }

    // Subtle micro-jitter when actively tracking (avoids robotic zero-variance rotation packets)
    const addJitter = options.jitter !== false && (Math.abs(yawDiff) > 0.015 || Math.abs(pitchDiff) > 0.015);
    const jitterYaw = addJitter ? (Math.random() - 0.5) * this.jitterRad : 0;
    const jitterPitch = addJitter ? (Math.random() - 0.5) * this.jitterRad * 0.6 : 0;

    const nextYaw = normalizeAngle(currentYaw + yawStep + jitterYaw);
    const nextPitch = clamp(currentPitch + pitchStep + jitterPitch, -Math.PI / 2, Math.PI / 2);

    // Skip redundant look updates when already aligned within ~0.45 deg (prevents unnecessary look packets)
    if (Math.abs(normalizeAngle(nextYaw - currentYaw)) >= 0.008 || Math.abs(nextPitch - currentPitch) >= 0.008) {
      this.bot.look(nextYaw, nextPitch, false).catch(() => {});
    }

    const remainingYaw = Math.abs(normalizeAngle(targetYaw - nextYaw));
    const remainingPitch = Math.abs(targetPitch - nextPitch);
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
    if (!this.bot.entity || !targetPos) {
      return { aligned: false, yawErrorDeg: 180, pitchErrorDeg: 90 };
    }
    const eyePos = this.getEyePosition();
    const { yaw, pitch } = calculateLookAngles(eyePos, targetPos);
    return this.stepTowardsAngles(yaw, pitch, options);
  }

  /**
   * Smoothly rotates one tick toward an entity's center/upper torso, with optional velocity lead.
   */
  stepTowardsEntity(entity, options = {}) {
    if (!this.bot.entity || !entity || !entity.position) {
      return { aligned: false, yawErrorDeg: 180, pitchErrorDeg: 90 };
    }

    const heightOffset = options.heightOffset !== undefined
      ? options.heightOffset
      : (entity.height ? entity.height * 0.72 : 1.3);

    const leadTicks = options.leadTicks || 0;
    const vel = entity.velocity || new Vec3(0, 0, 0);

    const aimPoint = new Vec3(
      entity.position.x + vel.x * leadTicks,
      entity.position.y + heightOffset + vel.y * leadTicks * 0.5,
      entity.position.z + vel.z * leadTicks
    );

    return this.stepTowardsPoint(aimPoint, options);
  }

  /**
   * Returns angular error (in degrees) from the bot's current facing to a target point.
   */
  getAngleErrorToPoint(targetPos) {
    if (!this.bot.entity || !targetPos) return 180;
    const eyePos = this.getEyePosition();
    const { yaw, pitch } = calculateLookAngles(eyePos, targetPos);
    const dy = Math.abs(normalizeAngle(yaw - this.bot.entity.yaw));
    const dp = Math.abs(pitch - this.bot.entity.pitch);
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
