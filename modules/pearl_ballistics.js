'use strict';

const { Vec3 } = require('vec3');
const { PEARL_SPEED, PEARL_GRAVITY, PEARL_DRAG, HAZARD_BLOCKS } = require('./constants');
const { countInventoryItem } = require('./inventory_utils');
const { clamp } = require('./aim');

/**
 * Shared per-bot Ender Pearl cooldown & reserve coordinator so `ranged`, `aerial`,
 * `burst`, and `escape` never double-pearl on consecutive ticks or drain below reserve.
 */
const _pearlStateByBot = new WeakMap();

function _getPearlState(bot) {
  let st = _pearlStateByBot.get(bot);
  if (!st) {
    st = { lastThrownAt: 0, lastReason: null };
    _pearlStateByBot.set(bot, st);
  }
  return st;
}

function getLastPearlThrowTime(bot) {
  if (!bot) return 0;
  return _getPearlState(bot).lastThrownAt;
}

function markPearlThrown(bot, reason = 'generic', now = Date.now()) {
  if (!bot) return;
  const st = _getPearlState(bot);
  st.lastThrownAt = now;
  st.lastReason = reason;
}

function canThrowPearl(bot, options = {}) {
  if (!bot) return false;
  const count = countInventoryItem(bot, 'ender_pearl');
  const minRequired = options.emergency ? 1 : ((options.reserveCount !== undefined ? options.reserveCount : 2) + 1);
  if (count < minRequired) return false;

  const cooldownMs = options.cooldownMs !== undefined ? options.cooldownMs : 1200;
  const now = options.now || Date.now();
  const st = _getPearlState(bot);
  return (now - st.lastThrownAt) >= cooldownMs;
}

/**
 * Discrete ballistic solver for Minecraft projectiles:
 * - Arrows / Crossbow arrows: speed ~3.0–3.15, gravity 0.05, drag 0.99
 * - Firework rockets: zero gravity (`gravity: 0, drag: 1.0`) straight-line velocity lead
 * - Ender Pearls: speed 1.5, gravity 0.03, drag 0.99
 *
 * Supports elevated targets up to +85° (fixes legacy +45° cap) and uses fast 12-step bisection.
 */
function solveProjectileTrajectory(startPos, targetPos, targetVel = null, options = {}) {
  if (!startPos || !targetPos) return null;

  const speed = options.speed !== undefined ? options.speed : 3.0;
  const gravity = options.gravity !== undefined ? options.gravity : 0.05;
  const drag = options.drag !== undefined ? options.drag : 0.99;
  const maxTicks = options.maxTicks !== undefined ? options.maxTicks : 80;
  const targetHeightOffset = options.targetHeightOffset !== undefined ? options.targetHeightOffset : 0;

  const vxT = targetVel ? (targetVel.x || 0) : 0;
  const vyT = targetVel ? (targetVel.y || 0) : 0;
  const vzT = targetVel ? (targetVel.z || 0) : 0;

  // Fast path for zero-gravity projectiles (e.g., Crossbow Firework Rockets)
  if (gravity === 0 && drag === 1.0) {
    let t = Math.max(1, startPos.distanceTo(targetPos) / Math.max(0.1, speed));
    for (let i = 0; i < 3; i++) {
      const px = targetPos.x + vxT * t;
      const py = targetPos.y + targetHeightOffset + vyT * t * 0.5;
      const pz = targetPos.z + vzT * t;
      const dx = px - startPos.x;
      const dy = py - startPos.y;
      const dz = pz - startPos.z;
      t = Math.min(maxTicks, Math.sqrt(dx * dx + dy * dy + dz * dz) / Math.max(0.1, speed));
    }
    const px = targetPos.x + vxT * t;
    const py = targetPos.y + targetHeightOffset + vyT * t * 0.5;
    const pz = targetPos.z + vzT * t;
    const dx = px - startPos.x;
    const dy = py - startPos.y;
    const dz = pz - startPos.z;
    const hDist = Math.sqrt(dx * dx + dz * dz);
    return {
      yaw: Math.atan2(-dx, -dz),
      pitch: clamp(Math.atan2(dy, hDist), -Math.PI / 2, Math.PI / 2),
      flightTicks: t,
      aimPoint: new Vec3(px, py, pz)
    };
  }

  const evalHeightAtHoriz = (pitch, hDist, dyTarget) => {
    let x = 0;
    let y = 0;
    let vx = Math.cos(pitch) * speed;
    let vy = Math.sin(pitch) * speed;

    for (let tick = 1; tick <= maxTicks; tick++) {
      const prevX = x;
      const prevY = y;
      x += vx;
      y += vy;
      vx *= drag;
      vy = vy * drag - gravity;

      if (x >= hDist) {
        const frac = (x - prevX) > 1e-6 ? (hDist - prevX) / (x - prevX) : 1;
        return { hit: true, y: prevY + (y - prevY) * frac, ticks: tick - 1 + frac };
      }
      if (vy < 0 && y < dyTarget - 4.0) {
        return { hit: false, y, ticks: tick };
      }
    }
    return { hit: false, y, ticks: maxTicks };
  };

  let estTicks = Math.min(maxTicks, Math.max(1, startPos.distanceTo(targetPos) / Math.max(0.3, speed)));
  let bestYaw = 0;
  let bestPitch = 0;
  let bestAimPoint = targetPos.clone();

  for (let iter = 0; iter < 3; iter++) {
    const leadX = targetPos.x + vxT * estTicks;
    const leadY = targetPos.y + targetHeightOffset + vyT * estTicks * 0.45;
    const leadZ = targetPos.z + vzT * estTicks;

    const dx = leadX - startPos.x;
    const dy = leadY - startPos.y;
    const dz = leadZ - startPos.z;
    const hDist = Math.sqrt(dx * dx + dz * dz);

    bestYaw = Math.atan2(-dx, -dz);
    bestAimPoint = new Vec3(leadX, leadY, leadZ);

    if (hDist < 0.25) {
      bestPitch = dy >= 0 ? Math.PI * 0.48 : -Math.PI * 0.48;
      break;
    }

    const directPitch = Math.atan2(dy, hDist);
    let low = Math.max(-1.45, directPitch - 0.12);
    let high = Math.min(1.48, Math.max(directPitch + 0.72, 0.88)); // Up to +85 deg

    // Verify bracket covers target; if direct+0.72 isn't high enough, widen to +85 deg
    const highProbe = evalHeightAtHoriz(high, hDist, dy);
    if (!highProbe.hit || highProbe.y < dy) {
      high = 1.48;
    }

    let resolvedTicks = estTicks;
    for (let step = 0; step < 12; step++) {
      const mid = (low + high) * 0.5;
      const res = evalHeightAtHoriz(mid, hDist, dy);
      if (res.hit && res.y >= dy) {
        high = mid;
        resolvedTicks = res.ticks;
      } else {
        low = mid;
      }
    }
    bestPitch = (low + high) * 0.5;
    estTicks = clamp(resolvedTicks, 1, maxTicks);
  }

  return {
    yaw: bestYaw,
    pitch: clamp(bestPitch, -Math.PI / 2, Math.PI / 2),
    flightTicks: estTicks,
    aimPoint: bestAimPoint
  };
}

/**
 * Convenience wrapper for solving an Ender Pearl throw from `startPos` to `targetPos`.
 */
function solvePearlBallistics(startPos, targetPos, targetVel = null, maxTicks = 75) {
  return solveProjectileTrajectory(startPos, targetPos, targetVel, {
    speed: PEARL_SPEED,
    gravity: PEARL_GRAVITY,
    drag: PEARL_DRAG,
    maxTicks
  });
}

/**
 * Swept sub-step Ender Pearl flight simulator (prevents 1.5 b/tick wall tunneling).
 * Skips redundant `bot.blockAt()` calls when integer voxel hasn't changed.
 * Returns `{ hit: boolean, pos: Vec3, hitSide: boolean, ticks: number }`.
 */
function simulatePearlFlight(bot, startPos, yaw, pitch, maxTicks = 85) {
  if (!bot || typeof bot.blockAt !== 'function' || !startPos) {
    return { hit: false, pos: startPos ? startPos.clone() : new Vec3(0, 0, 0), hitSide: false, ticks: 0 };
  }

  let x = startPos.x;
  let y = startPos.y;
  let z = startPos.z;
  let vx = -Math.sin(yaw) * Math.cos(pitch) * PEARL_SPEED;
  let vy = Math.sin(pitch) * PEARL_SPEED;
  let vz = -Math.cos(yaw) * Math.cos(pitch) * PEARL_SPEED;

  const probe = new Vec3(0, 0, 0);
  let lastBx = NaN;
  let lastBy = NaN;
  let lastBz = NaN;

  for (let t = 1; t <= maxTicks; t++) {
    const subSteps = 3; // <= 0.5b per substep -> never tunnels through 1-block walls
    const svx = vx / subSteps;
    const svy = vy / subSteps;
    const svz = vz / subSteps;

    for (let s = 0; s < subSteps; s++) {
      const prevX = x;
      const prevY = y;
      const prevZ = z;
      x += svx;
      y += svy;
      z += svz;

      const bx = Math.floor(x);
      const by = Math.floor(y);
      const bz = Math.floor(z);

      if (bx !== lastBx || by !== lastBy || bz !== lastBz) {
        lastBx = bx;
        lastBy = by;
        lastBz = bz;
        probe.x = bx;
        probe.y = by;
        probe.z = bz;
        const b = bot.blockAt(probe);
        if (b && b.boundingBox === 'block') {
          const hitTop = Math.floor(prevY) > by && svy <= 0;
          const landPos = hitTop
            ? new Vec3(prevX, by + 1, prevZ)
            : new Vec3(prevX, prevY, prevZ);
          return { hit: true, pos: landPos, hitSide: !hitTop, ticks: t };
        }
      }
    }

    vx *= PEARL_DRAG;
    vy = vy * PEARL_DRAG - PEARL_GRAVITY;
    vz *= PEARL_DRAG;

    if (y < -64) {
      return { hit: false, pos: new Vec3(x, y, z), hitSide: false, ticks: t };
    }
  }

  return { hit: false, pos: new Vec3(x, y, z), hitSide: false, ticks: maxTicks };
}

/**
 * Swept projectile landing predictor for an in-flight entity (e.g., enemy Ender Pearl).
 * Fixes 1-block wall tunneling and prevents snapping wall impacts to top of wall.
 */
function predictEntityProjectileLanding(bot, entity, maxTicks = 60) {
  if (!bot || !entity || !entity.position || typeof bot.blockAt !== 'function') return null;

  let x = entity.position.x;
  let y = entity.position.y;
  let z = entity.position.z;
  let vx = entity.velocity ? (entity.velocity.x || 0) : 0;
  let vy = entity.velocity ? (entity.velocity.y || 0) : 0;
  let vz = entity.velocity ? (entity.velocity.z || 0) : 0;

  if (Math.abs(vx) < 0.01 && Math.abs(vy) < 0.01 && Math.abs(vz) < 0.01) {
    return { pos: entity.position.clone(), ticks: 0, hitSide: false };
  }

  const probe = new Vec3(0, 0, 0);
  let lastBx = NaN;
  let lastBy = NaN;
  let lastBz = NaN;

  for (let t = 1; t <= maxTicks; t++) {
    const subSteps = 3;
    const svx = vx / subSteps;
    const svy = vy / subSteps;
    const svz = vz / subSteps;

    for (let s = 0; s < subSteps; s++) {
      const prevX = x;
      const prevY = y;
      const prevZ = z;
      x += svx;
      y += svy;
      z += svz;

      const bx = Math.floor(x);
      const by = Math.floor(y);
      const bz = Math.floor(z);

      if (bx !== lastBx || by !== lastBy || bz !== lastBz) {
        lastBx = bx;
        lastBy = by;
        lastBz = bz;
        probe.x = bx;
        probe.y = by;
        probe.z = bz;
        const b = bot.blockAt(probe);
        if (b && b.boundingBox === 'block') {
          const hitTop = Math.floor(prevY) > by && svy <= 0;
          if (hitTop) {
            return { pos: new Vec3(prevX, by + 1, prevZ), ticks: t, hitSide: false };
          }
          // Hit wall side: drop down to find actual floor below impact point
          let floorY = Math.floor(prevY);
          for (let d = 0; d <= 6; d++) {
            const fb = bot.blockAt(new Vec3(Math.floor(prevX), floorY - d, Math.floor(prevZ)));
            if (fb && fb.boundingBox === 'block') {
              return { pos: new Vec3(prevX, floorY - d + 1, prevZ), ticks: t, hitSide: true };
            }
          }
          return { pos: new Vec3(prevX, prevY, prevZ), ticks: t, hitSide: true };
        }
      }
    }

    vx *= PEARL_DRAG;
    vy = vy * PEARL_DRAG - PEARL_GRAVITY;
    vz *= PEARL_DRAG;

    if (y < -64) return null;
  }

  return { pos: new Vec3(x, y, z), ticks: maxTicks, hitSide: false };
}

/**
 * Verifies a pearl landing spot is safe (no lava/fire/cobweb, no suffocation, solid floor within `maxDrop`).
 */
function isSafePearlLanding(bot, landingPos, options = {}) {
  if (!bot || typeof bot.blockAt !== 'function' || !landingPos) return false;
  if (landingPos.y < -60) return false;

  const maxDrop = options.maxDrop !== undefined ? options.maxDrop : 4;
  const bx = Math.floor(landingPos.x);
  const by = Math.floor(landingPos.y);
  const bz = Math.floor(landingPos.z);

  const feet = bot.blockAt(new Vec3(bx, by, bz));
  const head = bot.blockAt(new Vec3(bx, by + 1, bz));
  if ((feet && feet.boundingBox === 'block') || (head && head.boundingBox === 'block')) return false;
  if ((feet && HAZARD_BLOCKS.has(feet.name)) || (head && HAZARD_BLOCKS.has(head.name))) return false;

  for (let d = 1; d <= maxDrop; d++) {
    const below = bot.blockAt(new Vec3(bx, by - d, bz));
    if (below && HAZARD_BLOCKS.has(below.name)) return false;
    if (below && (below.boundingBox === 'block' || below.name === 'water' || below.name === 'flowing_water')) {
      return true;
    }
  }
  return false;
}

module.exports = {
  getLastPearlThrowTime,
  markPearlThrown,
  canThrowPearl,
  solveProjectileTrajectory,
  solvePearlBallistics,
  simulatePearlFlight,
  predictEntityProjectileLanding,
  isSafePearlLanding
};
