'use strict';

const { Vec3 } = require('vec3');
const { getBlockCollisionBounds } = require('./constants');

const CARDINAL_FACES = [
  { offset: new Vec3(0, -1, 0), face: new Vec3(0, 1, 0) },  // top face of block below
  { offset: new Vec3(1, 0, 0), face: new Vec3(-1, 0, 0) },  // west face of east block
  { offset: new Vec3(-1, 0, 0), face: new Vec3(1, 0, 0) },  // east face of west block
  { offset: new Vec3(0, 0, 1), face: new Vec3(0, 0, -1) },  // north face of south block
  { offset: new Vec3(0, 0, -1), face: new Vec3(0, 0, 1) },  // south face of north block
  { offset: new Vec3(0, 1, 0), face: new Vec3(0, -1, 0) }   // bottom face of block above
];

const BLOCK_FACE_NORMALS = [
  new Vec3(0, 1, 0),
  new Vec3(1, 0, 0),
  new Vec3(-1, 0, 0),
  new Vec3(0, 0, 1),
  new Vec3(0, 0, -1),
  new Vec3(0, -1, 0)
];

const FACE_SAMPLE_OFFSETS = [
  [0.5, 0.5],
  [0.2, 0.2],
  [0.8, 0.2],
  [0.2, 0.8],
  [0.8, 0.8]
];

function getEyePosition(bot, aimer = null) {
  if (aimer && typeof aimer.getEyePosition === 'function') {
    const eye = aimer.getEyePosition();
    if (eye) return eye;
  }
  if (!bot || !bot.entity || !bot.entity.position) return null;
  const sneaking = Boolean(bot.entity.isSneaking || (bot.controlState && bot.controlState.sneak));
  return bot.entity.position.offset(0, sneaking ? 1.27 : 1.62, 0);
}

function getFaceSamplePoints(refPos, face) {
  const bx = Math.floor(refPos.x);
  const by = Math.floor(refPos.y);
  const bz = Math.floor(refPos.z);
  const points = [];

  for (const [u, v] of FACE_SAMPLE_OFFSETS) {
    if (face.y !== 0) {
      points.push(new Vec3(bx + u, by + (face.y > 0 ? 1 : 0), bz + v));
    } else if (face.x !== 0) {
      points.push(new Vec3(bx + (face.x > 0 ? 1 : 0), by + u, bz + v));
    } else {
      points.push(new Vec3(bx + u, by + v, bz + (face.z > 0 ? 1 : 0)));
    }
  }
  return points;
}

/**
 * Exact 3D Amanatides & Woo DDA voxel raycast from `start` to `end`.
 * Returns true iff no solid block (`boundingBox === 'block'`) intersects the segment
 * before reaching `end` (excluding `ignorePos` if provided).
 */
function hasClearRaySegment(bot, start, end, ignorePos = null) {
  if (!bot || typeof bot.blockAt !== 'function' || !start || !end) return false;

  let x = Math.floor(start.x);
  let y = Math.floor(start.y);
  let z = Math.floor(start.z);

  const endX = Math.floor(end.x);
  const endY = Math.floor(end.y);
  const endZ = Math.floor(end.z);

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dz = end.z - start.z;

  const stepX = dx > 0 ? 1 : (dx < 0 ? -1 : 0);
  const stepY = dy > 0 ? 1 : (dy < 0 ? -1 : 0);
  const stepZ = dz > 0 ? 1 : (dz < 0 ? -1 : 0);

  const tDeltaX = stepX !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = stepY !== 0 ? Math.abs(1 / dy) : Infinity;
  const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dz) : Infinity;

  let tMaxX = stepX > 0 ? (x + 1 - start.x) * tDeltaX : (stepX < 0 ? (start.x - x) * tDeltaX : Infinity);
  let tMaxY = stepY > 0 ? (y + 1 - start.y) * tDeltaY : (stepY < 0 ? (start.y - y) * tDeltaY : Infinity);
  let tMaxZ = stepZ > 0 ? (z + 1 - start.z) * tDeltaZ : (stepZ < 0 ? (start.z - z) * tDeltaZ : Infinity);

  const ignoreX = ignorePos ? Math.floor(ignorePos.x) : null;
  const ignoreY = ignorePos ? Math.floor(ignorePos.y) : null;
  const ignoreZ = ignorePos ? Math.floor(ignorePos.z) : null;

  let tPrev = 0;
  for (let steps = 0; steps < 48; steps++) {
    const tNext = Math.min(1, tMaxX, tMaxY, tMaxZ);
    const isIgnored = ignorePos !== null && x === ignoreX && y === ignoreY && z === ignoreZ;

    if (!isIgnored) {
      const block = bot.blockAt(new Vec3(x, y, z));
      if (block && block.boundingBox === 'block') {
        const bounds = getBlockCollisionBounds(block);
        if (bounds) {
          const y0 = start.y + dy * tPrev;
          const y1 = start.y + dy * tNext;
          const segMinY = Math.min(y0, y1);
          const segMaxY = Math.max(y0, y1);
          if (segMaxY > bounds.minY + 0.001 && segMinY < bounds.maxY - 0.001) {
            return false;
          }
        }
      }
    }

    if (x === endX && y === endY && z === endZ) return true;
    if (tNext >= 1) return true;

    tPrev = tNext;
    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
      x += stepX;
      tMaxX += tDeltaX;
    } else if (tMaxY <= tMaxZ) {
      y += stepY;
      tMaxY += tDeltaY;
    } else {
      z += stepZ;
      tMaxZ += tDeltaZ;
    }
  }

  return false;
}

/**
 * Verifies that `bot` has legal vanilla/anti-cheat line of sight to the specified `face`
 * of block `refPos`:
 *  1. Front neighbor (`refPos + face`) is not a full solid block hiding the face.
 *  2. Eye is strictly on the visible (front) side of the face plane (backface culling).
 *  3. Within `maxReach` (default 4.5 blocks).
 *  4. Unobstructed 3D DDA raycast from eye to a point on that face (no solid blocks in between).
 *
 * Returns `{ aimPos, distance, dot }` on success, or `null` if occluded / out of reach / backface.
 */
function canSeeBlockFace(bot, refPos, face, opts = {}) {
  if (!bot || !bot.entity || typeof bot.blockAt !== 'function' || !refPos || !face) return null;
  const eye = opts.eyePos || getEyePosition(bot, opts.aimer || null);
  if (!eye) return null;

  const maxReach = opts.maxReach !== undefined ? opts.maxReach : 4.5;
  const rx = Math.floor(refPos.x);
  const ry = Math.floor(refPos.y);
  const rz = Math.floor(refPos.z);
  const basePos = new Vec3(rx, ry, rz);

  // A full solid block flush against this face completely hides it
  const frontBlock = bot.blockAt(basePos.plus(face));
  if (frontBlock && frontBlock.boundingBox === 'block') {
    const bounds = getBlockCollisionBounds(frontBlock);
    if (bounds && (bounds.maxY - bounds.minY) >= 0.99) {
      return null;
    }
  }

  // Strict half-space backface check: eye must be strictly in front of the face plane
  const planeCenter = new Vec3(
    rx + 0.5 + face.x * 0.5,
    ry + 0.5 + face.y * 0.5,
    rz + 0.5 + face.z * 0.5
  );
  const planeDot =
    (eye.x - planeCenter.x) * face.x +
    (eye.y - planeCenter.y) * face.y +
    (eye.z - planeCenter.z) * face.z;
  if (planeDot <= 0.002) return null;

  const samples = getFaceSamplePoints(basePos, face);
  for (const pt of samples) {
    const dist = eye.distanceTo(pt);
    if (dist > maxReach) continue;

    // Stop ray 0.015 blocks in front of the face (strictly inside the empty front cell)
    const endPos = pt.offset(face.x * 0.015, face.y * 0.015, face.z * 0.015);
    if (hasClearRaySegment(bot, eye, endPos, basePos)) {
      return { aimPos: pt, distance: dist, dot: planeDot };
    }
  }

  return null;
}

/**
 * Finds the best solid neighbor + visible face around `placePos` that has genuine
 * line-of-sight from the bot's eyes so `bot.placeBlock(refBlock, face)` never places behind blocks.
 * Returns `{ refPos, refBlock, face, aimPos, distance }` or `null`.
 */
function findVisiblePlacementRef(bot, placePos, opts = {}) {
  if (!bot || !bot.entity || typeof bot.blockAt !== 'function' || !placePos) return null;
  const px = Math.floor(placePos.x);
  const py = Math.floor(placePos.y);
  const pz = Math.floor(placePos.z);
  const targetAir = new Vec3(px, py, pz);

  let best = null;
  let bestScore = -Infinity;

  for (const candidate of CARDINAL_FACES) {
    const refPos = targetAir.plus(candidate.offset);
    const refBlock = bot.blockAt(refPos);
    if (!refBlock || refBlock.boundingBox !== 'block') continue;

    const vis = canSeeBlockFace(bot, refPos, candidate.face, opts);
    if (!vis) continue;

    // Prefer top faces slightly, then closer & more directly facing faces
    const topBonus = candidate.face.y > 0 ? 0.45 : 0;
    const score = topBonus + vis.dot * 0.35 - vis.distance * 0.25;
    if (score > bestScore) {
      bestScore = score;
      best = {
        refPos,
        refBlock,
        face: candidate.face.clone(),
        aimPos: vis.aimPos,
        distance: vis.distance
      };
    }
  }

  return best;
}

/**
 * Finds the best visible face on an existing block `blockPos` (e.g. Respawn Anchor, Obsidian, Rail)
 * with genuine line-of-sight from the bot's eyes.
 * Returns `{ face, aimPos, distance }` or `null` if the block is occluded behind other blocks.
 */
function findVisibleBlockFace(bot, blockPos, opts = {}) {
  if (!bot || !bot.entity || typeof bot.blockAt !== 'function' || !blockPos) return null;
  const bx = Math.floor(blockPos.x);
  const by = Math.floor(blockPos.y);
  const bz = Math.floor(blockPos.z);
  const pos = new Vec3(bx, by, bz);

  let best = null;
  let bestScore = -Infinity;

  for (const face of BLOCK_FACE_NORMALS) {
    const vis = canSeeBlockFace(bot, pos, face, opts);
    if (!vis) continue;

    const topBonus = face.y > 0 ? 0.35 : 0;
    const score = topBonus + vis.dot * 0.5 - vis.distance * 0.2;
    if (score > bestScore) {
      bestScore = score;
      best = {
        face: face.clone(),
        aimPos: vis.aimPos,
        distance: vis.distance
      };
    }
  }

  return best;
}

module.exports = {
  getEyePosition,
  hasClearRaySegment,
  canSeeBlockFace,
  findVisiblePlacementRef,
  findVisibleBlockFace
};
