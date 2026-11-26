'use strict';

const { Vec3 } = require('vec3');
const { clamp, DEG_TO_RAD } = require('./aim');
const {
  HAZARD_BLOCKS,
  PEARL_SPEED,
  PEARL_GRAVITY,
  PEARL_DRAG,
  findOverlappingBlock,
  inspectColumnStep
} = require('./constants');

const ARROW_SPEED = 3.0;
const CROSSBOW_SPEED = 3.15;
const ARROW_GRAVITY = 0.05;
const ARROW_DRAG = 0.99;

/**
 * Ranged pressure, tactical Ender Pearl, and Arena/Hazard awareness module:
 * 1. Predictive Bow/Crossbow aiming with discrete Minecraft drag (0.99) + gravity (0.05) + velocity lead solver.
 * 2. Necessary-Only Ender Pearl system with reserve conservation (chase fleeing targets, combo-break agro-cancel,
 *    critical defensive escape with 3-yaw safe arc selection, and 1-tick packet-safe equip settle).
 * 3. Arena & hazard raycasting (lava, fire, void edges/cliffs, cobwebs) + 1-tick Water Bucket cobweb escape.
 */
class RangedModule {
  constructor(bot, config, aimer, prediction = null) {
    this.bot = bot;
    this.config = config || {};
    this.rangedCfg = (config && config.ranged) || {};
    this.aimer = aimer;
    this.prediction = prediction;

    this.equipBusy = false;

    // Bow / Crossbow state
    this.isDrawing = false;
    this.startingDraw = false;
    this.drawWeaponType = null; // 'bow' | 'crossbow'
    this.drawTicks = 0;

    // Cooldowns
    this.lastBowShotTime = 0;
    this.lastPearlTime = 0;
    this.lastCobwebTime = 0;
    this.lastLavaTime = 0;

    // Queued smooth-aim utility actions (pearl, cobweb, lava)
    this.pendingAction = null;

    // Placed offensive lava tracking
    this.activeLavaPos = null;
    this.activeLavaPlacedAt = 0;

    // Cobweb water-bucket auto-clear state (place -> pick up after 1 tick)
    this.cobwebEscapeState = 'IDLE'; // 'IDLE' | 'AIMING_PLACE' | 'WAITING_PICKUP'
    this.cobwebWaterPos = null;
    this.waterPickupTicksRemaining = 0;

    // Combo detection telemetry (tracks recent incoming hits on the bot)
    this.lastKnownHealth = typeof bot.health === 'number' ? bot.health : 20;
    this.recentHitTimestamps = [];
    this._onHealth = this._handleHealth.bind(this);
    if (typeof this.bot.on === 'function') {
      this.bot.on('health', this._onHealth);
    }
  }

  /**
   * Unbinds listeners cleanly on disconnect.
   */
  dispose() {
    if (this.bot && typeof this.bot.removeListener === 'function') {
      this.bot.removeListener('health', this._onHealth);
    }
    this.cancel();
  }

  /**
   * Attaches or replaces the multi-tick trajectory predictor (PredictionModule).
   */
  setPrediction(prediction) {
    this.prediction = prediction;
  }

  _handleHealth() {
    if (typeof this.bot.health !== 'number') return;
    if (this.bot.health < this.lastKnownHealth) {
      const now = Date.now();
      this.recentHitTimestamps.push(now);
      // Keep only hits within the last 1.6s combo window
      this.recentHitTimestamps = this.recentHitTimestamps.filter((ts) => (now - ts) <= 1600);
    }
    this.lastKnownHealth = this.bot.health;
  }

  /**
   * Returns true if the ranged module currently controls aim/item usage.
   */
  isBusy() {
    return this.isDrawing || Boolean(this.pendingAction) || this.cobwebEscapeState !== 'IDLE';
  }

  /**
   * Cancels active bow draw or queued utility actions cleanly.
   */
  cancel() {
    if (this._crossbowReleaseTimer) {
      clearTimeout(this._crossbowReleaseTimer);
      this._crossbowReleaseTimer = null;
    }
    if (this.isDrawing) {
      this.bot.deactivateItem();
      this.isDrawing = false;
      this.drawWeaponType = null;
      this.drawTicks = 0;
    }
    this.pendingAction = null;
  }

  _findItem(name) {
    if (!this.bot.inventory) return null;
    return this.bot.inventory.items().find((i) => i.name === name) || null;
  }

  _hasArrows() {
    if (!this.bot.inventory) return false;
    return this.bot.inventory.items().some((i) =>
      i.name === 'arrow' || i.name === 'spectral_arrow' || i.name === 'tipped_arrow'
    );
  }

  async _equipSafe(item) {
    if (!item) return false;
    if (this.bot.heldItem && this.bot.heldItem.type === item.type) return true;

    // Instant hotbar select if item is in slots 36..44
    const hotbarStart = (this.bot.inventory && this.bot.inventory.hotbarStart) || 36;
    if (
      item.slot >= hotbarStart &&
      item.slot < hotbarStart + 9 &&
      typeof this.bot.setQuickBarSlot === 'function'
    ) {
      this.bot.setQuickBarSlot(item.slot - hotbarStart);
      return true;
    }

    if (this.equipBusy) return false;
    this.equipBusy = true;
    try {
      await this.bot.equip(item, 'hand');
      return true;
    } catch (_) {
      return false;
    } finally {
      this.equipBusy = false;
    }
  }

  // =========================================================================
  // 1. PREDICTIVE BOW & PROJECTILE BALLISTICS (Exact MC Drag + Gravity + Lead)
  // =========================================================================

  /**
   * Simulates a discrete Minecraft projectile tick-by-tick to find vertical error
   * and exact flight time at horizontal distance `horizDist`.
   */
  _simulateProjectile(horizDist, dy, speed, gravity, drag, pitchRad) {
    let vx = speed * Math.cos(pitchRad);
    let vy = speed * Math.sin(pitchRad);
    let x = 0;
    let y = 0;

    for (let tick = 1; tick <= 80; tick++) {
      const prevX = x;
      const prevY = y;
      x += vx;
      y += vy;
      vx *= drag;
      vy = vy * drag - gravity;

      if (x >= horizDist) {
        const span = x - prevX;
        const frac = span > 1e-6 ? (horizDist - prevX) / span : 0;
        const yAtDist = prevY + (y - prevY) * frac;
        const flightTicks = (tick - 1) + frac;
        return { reached: true, yError: yAtDist - dy, flightTicks };
      }

      if (vx < 0.02) break;
    }

    return { reached: false, yError: -Infinity, flightTicks: 80 };
  }

  /**
   * Iteratively solves projectile pitch, yaw, and flight time for a moving target
   * accounting for Minecraft air drag, gravity drop, velocity lead, and optional
   * damped acceleration lead from PredictionModule kinematics.
   */
  solveProjectileTrajectory(targetPos, targetVel, speed = ARROW_SPEED, gravity = ARROW_GRAVITY, drag = ARROW_DRAG, targetAccel = null) {
    const eye = this.aimer.getEyePosition();
    const vel = targetVel || new Vec3(0, 0, 0);
    const accel = targetAccel || new Vec3(0, 0, 0);

    let flightTicks = clamp(eye.distanceTo(targetPos) / speed, 1, 60);
    let bestPitch = 0;
    let bestYaw = 0;
    let predictedPos = targetPos.clone();
    let reachable = false;

    // 3 fixed-point iterations converge travel time and target velocity/acceleration lead accurately
    for (let iter = 0; iter < 3; iter++) {
      // Damped quadratic acceleration contribution (capped so long-range shots never overshoot)
      const effAccelTicks = Math.min(flightTicks, 8);
      const accelTerm = 0.5 * effAccelTicks * effAccelTicks * 0.4;
      // Dampen vertical lead slightly so jumping targets aren't overshot into the air
      const leadY = Math.abs(vel.y) > 0.05
        ? (vel.y * flightTicks * 0.45 + accel.y * accelTerm * 0.25)
        : 0;
      predictedPos = new Vec3(
        targetPos.x + vel.x * flightTicks + accel.x * accelTerm,
        targetPos.y + leadY,
        targetPos.z + vel.z * flightTicks + accel.z * accelTerm
      );

      const dx = predictedPos.x - eye.x;
      const dy = predictedPos.y - eye.y;
      const dz = predictedPos.z - eye.z;
      const horizDist = Math.sqrt(dx * dx + dz * dz);

      bestYaw = Math.atan2(-dx, -dz);

      if (horizDist < 0.35) {
        bestPitch = clamp(Math.atan2(dy, Math.max(0.1, horizDist)), -Math.PI / 2 + 0.05, Math.PI / 2 - 0.05);
        reachable = true;
        break;
      }

      // Binary search pitch in [-82°, +45°] (monotonically increasing height at horizDist)
      let low = -82 * DEG_TO_RAD;
      let high = 45 * DEG_TO_RAD;
      let lastSim = null;

      for (let step = 0; step < 16; step++) {
        const mid = (low + high) * 0.5;
        const sim = this._simulateProjectile(horizDist, dy, speed, gravity, drag, mid);
        lastSim = sim;

        if (!sim.reached || sim.yError < 0) {
          low = mid;
        } else {
          high = mid;
        }
      }

      bestPitch = (low + high) * 0.5;
      const verify = this._simulateProjectile(horizDist, dy, speed, gravity, drag, bestPitch);
      reachable = verify.reached && Math.abs(verify.yError) < 1.25;
      if (verify.reached) {
        flightTicks = verify.flightTicks;
      } else if (lastSim) {
        flightTicks = lastSim.flightTicks;
      }
    }

    return {
      yaw: bestYaw,
      pitch: clamp(bestPitch, -Math.PI / 2 + 0.05, Math.PI / 2 - 0.05),
      flightTicks,
      predictedPos,
      reachable
    };
  }

  /**
   * Simple block-step raycast to check if line of sight to a point is unobstructed.
   */
  hasClearLineOfSight(toPos) {
    if (!this.bot.entity || !toPos) return false;
    const eye = this.aimer.getEyePosition();
    const diff = toPos.minus(eye);
    const dist = diff.norm();
    if (dist < 0.5) return true;

    const steps = Math.min(32, Math.ceil(dist * 1.5));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const sample = eye.offset(diff.x * t, diff.y * t, diff.z * t);
      const block = this.bot.blockAt(sample);
      if (block && block.boundingBox === 'block') {
        return false;
      }
    }
    return true;
  }

  shouldUseRangedWeapon(target) {
    if (!this.rangedCfg.enabled || !target || !target.isValid || !this.bot.entity) return false;
    const allowBow = this.rangedCfg.bowEnabled !== false;
    const allowCrossbow = this.rangedCfg.crossbowEnabled === true;
    if (!allowBow && !allowCrossbow) return false;

    const dist = this.bot.entity.position.distanceTo(target.position);
    const minRange = this.rangedCfg.bowMinRange || 8.0;
    const maxRange = this.rangedCfg.bowMaxRange || 28.0;

    if (dist < minRange || dist > maxRange) return false;
    if (!this.isDrawing && (Date.now() - this.lastBowShotTime) < (this.rangedCfg.bowShotCooldownMs || 2800)) {
      return false;
    }
    if (!this._hasArrows()) return false;
    const hasBow = allowBow && Boolean(this._findItem('bow'));
    const hasCrossbow = allowCrossbow && Boolean(this._findItem('crossbow'));
    if (!hasBow && !hasCrossbow) return false;

    const aimTarget = target.position.offset(0, (target.height || 1.8) * 0.65, 0);
    if (!this.isDrawing && !this.hasClearLineOfSight(aimTarget)) return false;
    return true;
  }

  // =========================================================================
  // 2. NECESSARY-ONLY ENDER PEARL SYSTEM (CONSERVATION + SAFETY + 1-TICK SETTLE)
  // =========================================================================

  /**
   * Counts total ender_pearl items across the bot's entire inventory.
   */
  getPearlCount() {
    if (!this.bot || !this.bot.inventory || typeof this.bot.inventory.items !== 'function') {
      return 0;
    }
    let total = 0;
    for (const item of this.bot.inventory.items()) {
      if (item && item.name === 'ender_pearl') {
        total += typeof item.count === 'number' ? item.count : 1;
      }
    }
    return total;
  }

  /**
   * Returns true if the bot is currently holding an ender_pearl in its main hand.
   */
  _isHoldingPearl() {
    if (!this.bot) return false;
    if (this.bot.heldItem && this.bot.heldItem.name === 'ender_pearl') return true;
    if (
      this.bot.inventory &&
      Array.isArray(this.bot.inventory.slots) &&
      typeof this.bot.quickBarSlot === 'number'
    ) {
      const hotbarStart = this.bot.inventory.hotbarStart || 36;
      const slotItem = this.bot.inventory.slots[hotbarStart + this.bot.quickBarSlot];
      if (slotItem && slotItem.name === 'ender_pearl') return true;
    }
    return false;
  }

  /**
   * Returns the configured pearl reserve count (last N pearls kept strictly for critical escapes).
   */
  _getPearlReserveCount() {
    return typeof this.rangedCfg.enderPearlReserveCount === 'number'
      ? this.rangedCfg.enderPearlReserveCount
      : 2;
  }

  /**
   * Returns the number of incoming hits taken by the bot within the given millisecond window.
   */
  getRecentHitCount(windowMs = 1400) {
    const now = Date.now();
    this.recentHitTimestamps = this.recentHitTimestamps.filter((ts) => (now - ts) <= 1600);
    if (windowMs >= 1600) return this.recentHitTimestamps.length;
    let count = 0;
    for (const ts of this.recentHitTimestamps) {
      if ((now - ts) <= windowMs) count++;
    }
    return count;
  }

  /**
   * Returns true if the bot's feet or head are currently inside lava.
   */
  isInLava() {
    if (!this.bot || !this.bot.entity) return false;
    const pos = this.bot.entity.position;
    const feet = this.bot.blockAt(pos);
    const head = this.bot.blockAt(pos.offset(0, 1, 0));
    return Boolean(
      (feet && feet.name && feet.name.includes('lava')) ||
      (head && head.name && head.name.includes('lava'))
    );
  }

  /**
   * Simulates a discrete Minecraft Ender Pearl trajectory (drag 0.99, gravity 0.03)
   * with 3 substeps/tick to accurately detect nearby walls, ground impacts, and void falls.
   */
  _simulatePearlFlight(startPos, yawRad, pitchRad, maxTicks = 100) {
    let x = startPos.x;
    let y = startPos.y;
    let z = startPos.z;
    let vx = -Math.sin(yawRad) * Math.cos(pitchRad) * PEARL_SPEED;
    let vy = Math.sin(pitchRad) * PEARL_SPEED;
    let vz = -Math.cos(yawRad) * Math.cos(pitchRad) * PEARL_SPEED;

    const substeps = 3;
    let prevPos = new Vec3(x, y, z);

    for (let tick = 1; tick <= maxTicks; tick++) {
      for (let s = 1; s <= substeps; s++) {
        const nx = x + (vx * s) / substeps;
        const ny = y + (vy * s) / substeps;
        const nz = z + (vz * s) / substeps;
        const sample = new Vec3(nx, ny, nz);
        const block = this.bot.blockAt(sample);
        if (block && block.boundingBox === 'block') {
          return {
            hit: true,
            hitTick: tick,
            hitDist: startPos.distanceTo(sample),
            hitPos: sample,
            landingPos: prevPos,
            hitBlock: block
          };
        }
        prevPos = sample;
      }

      x += vx;
      y += vy;
      z += vz;
      vx *= PEARL_DRAG;
      vy = vy * PEARL_DRAG - PEARL_GRAVITY;
      vz *= PEARL_DRAG;
    }

    const endPos = new Vec3(x, y, z);
    return {
      hit: false,
      hitTick: maxTicks,
      hitDist: startPos.distanceTo(endPos),
      hitPos: endPos,
      landingPos: endPos,
      hitBlock: null
    };
  }

  /**
   * Verifies a pearl landing spot has solid ground beneath and no lava/fire/cobweb/void.
   */
  isPearlLandingSafe(pos) {
    if (!this.bot || !pos) return false;
    return this.isPositionSafe(pos);
  }

  /**
   * Verifies that a pearl trajectory toward `landingPos` does not slam into a nearby wall
   * (< 4b ahead) or obstruction well short of the target, and has clear line of sight.
   */
  _isTargetedPearlPathClear(yawRad, pitchRad, landingPos, targetDist) {
    if (!this.bot || !this.bot.entity || !landingPos) return false;
    const eye = this.aimer.getEyePosition();

    // Direct LOS check to landing clearance (prevents throwing straight into a wall 2b ahead)
    if (!this.hasClearLineOfSight(landingPos.offset(0, 1.0, 0))) {
      return false;
    }

    const sim = this._simulatePearlFlight(eye, yawRad, pitchRad, 100);
    const minClearDist = Math.min(Math.max(4.0, targetDist * 0.55), targetDist - 1.5);
    if (sim.hit && sim.hitDist < minClearDist) {
      return false;
    }

    // If the simulated impact lands far short of target, ensure we didn't hit a blocking pillar
    if (sim.hit && sim.hitDist < targetDist * 0.7 && sim.landingPos.distanceTo(landingPos) > 5.0) {
      return false;
    }

    return true;
  }

  /**
   * Checks whether an escape pearl landing position has solid ground below (up to 6 blocks)
   * and no lava, fire, cobweb, or other hazard blocks at or beneath it.
   */
  _isEscapeLandingSafe(landingPos) {
    if (!this.bot || !landingPos) return false;
    const feet = this.bot.blockAt(landingPos);
    const head = this.bot.blockAt(landingPos.offset(0, 1, 0));
    if (feet && this.isHazardBlock(feet)) return false;
    if (head && this.isHazardBlock(head)) return false;

    let foundSolidGround = false;
    for (let depth = 1; depth <= 6; depth++) {
      const below = this.bot.blockAt(landingPos.offset(0, -depth, 0));
      if (!below) continue;
      if (this.isHazardBlock(below)) return false;
      if (below.boundingBox === 'block') {
        foundSolidGround = true;
        break;
      }
    }
    return foundSolidGround;
  }

  /**
   * Evaluates an upward escape pearl arc for wall clearance (>= 4b), void safety, and lava avoidance.
   */
  _evaluateEscapeArc(eye, yawRad, pitchRad, angleOffsetRad) {
    const probe4 = eye.offset(
      -Math.sin(yawRad) * Math.cos(pitchRad) * 4.0,
      Math.sin(pitchRad) * 4.0,
      -Math.cos(yawRad) * Math.cos(pitchRad) * 4.0
    );
    if (!this.hasClearLineOfSight(probe4)) {
      return { safe: false, score: -Infinity, sim: null };
    }

    const sim = this._simulatePearlFlight(eye, yawRad, pitchRad, 100);
    if (sim.hit && sim.hitDist < 4.0) {
      return { safe: false, score: -Infinity, sim };
    }

    let safeLanding = false;
    if (sim.hit) {
      safeLanding = this._isEscapeLandingSafe(sim.landingPos);
    } else {
      // Did not hit a solid block within 100 ticks: reject if loaded chunks show void or lava
      const endBlock = this.bot.blockAt(sim.landingPos);
      if (endBlock) {
        // Chunk is loaded and pearl fell through open air into void/lava
        safeLanding = this._isEscapeLandingSafe(sim.landingPos);
      } else {
        // Distant chunk unloaded: verify loaded terrain along escape corridor (4..12b) has solid floor and no lava
        const basePos = this.bot.entity.position;
        const dirX = -Math.sin(yawRad);
        const dirZ = -Math.cos(yawRad);
        let corridorHasGround = false;
        let corridorHazard = false;

        for (const d of [4, 8, 12]) {
          const sample = basePos.offset(dirX * d, 0, dirZ * d);
          if (!this.bot.blockAt(sample)) continue;
          let solidHere = false;
          for (let depth = 0; depth <= 6; depth++) {
            const b = this.bot.blockAt(sample.offset(0, -depth, 0));
            if (!b) continue;
            if (this.isHazardBlock(b)) {
              corridorHazard = true;
              break;
            }
            if (b.boundingBox === 'block') {
              solidHere = true;
              break;
            }
          }
          if (corridorHazard) break;
          if (solidHere) corridorHasGround = true;
        }
        safeLanding = !corridorHazard && corridorHasGround;
      }
    }

    if (!safeLanding) {
      return { safe: false, score: -Infinity, sim };
    }

    const anglePenalty = Math.abs(angleOffsetRad) > 1e-3 ? 1.5 : 0;
    const distanceScore = Math.min(sim.hitDist, 24.0);
    const confirmedBonus = sim.hit ? 5.0 : 0.0;
    return {
      safe: true,
      score: distanceScore + confirmedBonus - anglePenalty,
      sim
    };
  }

  /**
   * Starts equipping an action's item while enforcing a strict 1-tick settle period
   * so setQuickBarSlot / bot.equip NEVER fires on the same tick as activateItem(false).
   */
  _startActionEquip(action) {
    if (!action || !action.item) return false;

    if (action.type === 'pearl' && this._isHoldingPearl()) {
      action.equipping = false;
      action.equipSettleTicks = 0;
      return true;
    }

    const item = action.item;
    const hotbarStart = (this.bot.inventory && this.bot.inventory.hotbarStart) || 36;
    if (
      item.slot >= hotbarStart &&
      item.slot < hotbarStart + 9 &&
      typeof this.bot.setQuickBarSlot === 'function'
    ) {
      this.bot.setQuickBarSlot(item.slot - hotbarStart);
      action.equipping = false;
      action.equipSettleTicks = 1; // Wait 1 full tick after hotbar swap before throwing
      return true;
    }

    if (this.equipBusy) {
      action.equipping = true;
      action.equipSettleTicks = 1;
      return false;
    }

    action.equipping = true;
    action.equipSettleTicks = 1;
    this._equipSafe(item)
      .then((ok) => {
        action.equipping = false;
        action.equipSettleTicks = 1; // Wait 1 full tick after async equip completes
        if (!ok && this.pendingAction === action) {
          this.pendingAction = null;
        }
      })
      .catch(() => {
        action.equipping = false;
        if (this.pendingAction === action) {
          this.pendingAction = null;
        }
      });
    return true;
  }

  /**
   * Queues an Ender Pearl throw with smooth aiming and packet-safe 1-tick equip settle.
   */
  _queuePearl(pearl, mode, aimAngles, extra = {}) {
    const action = {
      type: 'pearl',
      mode,
      item: pearl,
      aimAngles,
      equipping: false,
      equipSettleTicks: 0,
      createdAt: Date.now(),
      ...extra
    };
    this.pendingAction = action;
    this._startActionEquip(action);
    return true;
  }

  /**
   * Strictly-Necessary Chase Ender Pearl:
   * - Respects pearl reserve count (never uses last N reserved pearls).
   * - Requires dist >= enderPearlChaseRange (default 16.0b) & bot.health >= 13 & cooldown >= 5500ms.
   * - Requires enemy is genuinely fleeing (radial away vel > 0.08) OR dist >= 22.0 OR elevated (dy >= 4.0),
   *   and refuses to pearl if enemy is actively running toward us.
   * - Validates landing spot safety (solid ground, no lava/fire/cobweb/void) and clear line of sight / arc.
   */
  tryChasePearl(target) {
    if (!this.rangedCfg.enabled || this.pendingAction || this.isDrawing) return false;
    if (!target || !target.isValid || !this.bot.entity) return false;

    // 1. Pearl conservation: keep reserved pearls strictly for critical escapes
    const reserveCount = this._getPearlReserveCount();
    if (this.getPearlCount() <= reserveCount) return false;

    const now = Date.now();
    const chaseCooldownMs = this.rangedCfg.enderPearlChaseCooldownMs || 5500;
    if ((now - this.lastPearlTime) < chaseCooldownMs) return false;

    // Don't aggressively pearl into a fight while weak
    if (this.bot.health < 13) return false;

    const pearl = this._findItem('ender_pearl');
    if (!pearl) return false;

    const dist = this.bot.entity.position.distanceTo(target.position);
    const chaseRange = this.rangedCfg.enderPearlChaseRange || 16.0;
    if (dist < chaseRange) return false;

    // Determine target kinematics (preferring PredictionModule velocity/acceleration)
    let vel = target.velocity || new Vec3(0, 0, 0);
    let accel = null;
    if (this.prediction && typeof this.prediction.getTargetKinematics === 'function') {
      const kin = this.prediction.getTargetKinematics(target);
      if (kin) {
        vel = kin.velocity || vel;
        accel = kin.acceleration || null;
      }
    }

    const dx = target.position.x - this.bot.entity.position.x;
    const dy = target.position.y - this.bot.entity.position.y;
    const dz = target.position.z - this.bot.entity.position.z;
    const horizDist = Math.sqrt(dx * dx + dz * dz);
    const radialAwayVel = horizDist > 1e-4
      ? ((vel.x * dx + vel.z * dz) / horizDist)
      : 0;

    // Do NOT pearl if enemy is actively running toward us (unless significantly elevated above us)
    const enemyRunningToward = radialAwayVel < -0.05;
    const enemyElevated = dy >= 4.0;
    if (enemyRunningToward && !enemyElevated) return false;

    // Require genuine flee velocity, very long range, or significant height advantage
    const enemyFleeing = radialAwayVel > 0.08;
    const veryFar = dist >= 22.0;
    if (!enemyFleeing && !veryFar && !enemyElevated) return false;

    // Compute horizontal lead direction
    const horizSpeed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
    let dirX;
    let dirZ;
    if (horizSpeed > 0.02) {
      dirX = vel.x / horizSpeed;
      dirZ = vel.z / horizSpeed;
    } else {
      const len = Math.max(0.01, horizDist);
      dirX = dx / len;
      dirZ = dz / len;
    }

    // Aim slightly ahead of target's path + ballistic flight-time lead
    const leadBlocks = this.rangedCfg.enderPearlChaseLeadBlocks || 2.5;
    const baseTargetPos = target.position.offset(dirX * leadBlocks, 0.2, dirZ * leadBlocks);
    let solution = this.solveProjectileTrajectory(
      baseTargetPos,
      vel,
      PEARL_SPEED,
      PEARL_GRAVITY,
      PEARL_DRAG,
      accel
    );

    let chosenLanding = solution.predictedPos;
    let pathSafe = solution.reachable &&
      this.isPearlLandingSafe(chosenLanding) &&
      this._isTargetedPearlPathClear(solution.yaw, solution.pitch, chosenLanding, dist);

    // Fallback to target's current feet if lead spot is hazardous/blocked
    if (!pathSafe) {
      const fallbackPos = target.position.offset(0, 0.2, 0);
      if (!this.isPearlLandingSafe(target.position)) return false;
      const fallbackSol = this.solveProjectileTrajectory(
        fallbackPos,
        new Vec3(0, 0, 0),
        PEARL_SPEED,
        PEARL_GRAVITY,
        PEARL_DRAG
      );
      if (
        !fallbackSol.reachable ||
        !this._isTargetedPearlPathClear(fallbackSol.yaw, fallbackSol.pitch, target.position, dist)
      ) {
        return false;
      }
      solution = fallbackSol;
      chosenLanding = target.position.clone();
    }

    return this._queuePearl(
      pearl,
      'chase',
      { yaw: solution.yaw, pitch: solution.pitch },
      { landingTarget: chosenLanding }
    );
  }

  /**
   * Agro-Cancel / Combo-Break Ender Pearl:
   * - Respects pearl reserve count (never uses last N reserved pearls).
   * - Only triggers during a real sustained combo (>= 3 hits in 1.4s),
   *   bot.health <= enderPearlAgroCancelHp (default 11) AND bot.health > 6,
   *   target at close-mid range (3.2 <= dist <= 7.0), and cooldown >= 5000ms.
   */
  tryAgroCancelPearl(target) {
    if (!this.rangedCfg.enabled || this.pendingAction || this.isDrawing) return false;
    if (!target || !target.isValid || !this.bot.entity) return false;

    // 1. Pearl conservation: keep reserved pearls strictly for critical escapes
    const reserveCount = this._getPearlReserveCount();
    if (this.getPearlCount() <= reserveCount) return false;

    const now = Date.now();
    const agroCancelCooldownMs = this.rangedCfg.enderPearlAgroCancelCooldownMs || 5000;
    if ((now - this.lastPearlTime) < agroCancelCooldownMs) return false;

    const agroCancelHp = this.rangedCfg.enderPearlAgroCancelHp || 11;
    if (this.bot.health > agroCancelHp || this.bot.health <= 6) return false;

    // Require real sustained combo (>= 3 hits within 1.4s)
    if (this.getRecentHitCount(1400) < 3) return false;

    const dist = this.bot.entity.position.distanceTo(target.position);
    if (dist < 3.2 || dist > 7.0) return false;

    const pearl = this._findItem('ender_pearl');
    if (!pearl) return false;

    const landingPos = target.position.clone();
    if (!this.isPearlLandingSafe(landingPos)) return false;

    const solution = this.solveProjectileTrajectory(
      target.position.offset(0, 0.2, 0),
      new Vec3(0, 0, 0),
      PEARL_SPEED,
      PEARL_GRAVITY,
      PEARL_DRAG
    );

    if (
      !solution.reachable ||
      !this._isTargetedPearlPathClear(solution.yaw, solution.pitch, landingPos, dist)
    ) {
      return false;
    }

    return this._queuePearl(
      pearl,
      'agro_cancel',
      { yaw: solution.yaw, pitch: solution.pitch },
      { landingTarget: landingPos }
    );
  }

  /**
   * Evaluates non-escape Ender Pearl triggers (combo-break agro-cancel or necessary chase).
   */
  tryAggressivePearl(target) {
    return this.tryAgroCancelPearl(target) || this.tryChasePearl(target);
  }

  /**
   * Critical Defensive Escape Pearl:
   * - Allowed even when pearl count <= enderPearlReserveCount (uses reserved pearls to save life).
   * - Only triggers when bot.health <= enderPearlEscapeHealth (default 6) AND
   *   (in cobweb/lava OR trapped in combo >= 2 hits OR enemy < 5.5b away) AND cooldown >= 3200ms.
   * - Tests 3 yaw offsets (0°, +35°, -35°) around awayYaw to pick the safest open escape arc
   *   that avoids walls < 4b ahead, void, and lava.
   */
  tryDefensivePearl(target) {
    if (!this.rangedCfg.enabled || this.pendingAction || this.isDrawing) return false;
    if (!this.bot.entity) return false;

    const now = Date.now();
    const escapeCooldownMs = this.rangedCfg.enderPearlEscapeCooldownMs ||
      this.rangedCfg.enderPearlCooldownMs ||
      3200;
    if ((now - this.lastPearlTime) < escapeCooldownMs) return false;

    const escapeHp = typeof this.rangedCfg.enderPearlEscapeHealth === 'number'
      ? this.rangedCfg.enderPearlEscapeHealth
      : 9;
    if (this.bot.health > escapeHp) return false;

    const inHazard = this.isInCobweb() || this.isInLava();
    const trappedInCombo = this.getRecentHitCount(1600) >= 2;
    const enemyClose = Boolean(
      target &&
      target.isValid &&
      this.bot.entity.position.distanceTo(target.position) < 5.5
    );
    if (!inHazard && !trappedInCombo && !enemyClose) return false;

    const pearl = this._findItem('ender_pearl');
    if (!pearl) return false;

    const awayYaw = (target && target.isValid)
      ? Math.atan2(-(this.bot.entity.position.x - target.position.x), -(this.bot.entity.position.z - target.position.z))
      : this.bot.entity.yaw;

    const minDeg = this.rangedCfg.enderPearlEscapePitchMinDeg || 35;
    const maxDeg = this.rangedCfg.enderPearlEscapePitchMaxDeg || 45;
    const pitchDeg = minDeg + Math.random() * (maxDeg - minDeg);
    const pitchRad = pitchDeg * DEG_TO_RAD;

    // Test 3 yaw offsets (0°, +35°, -35°) around awayYaw and pick the safest open escape arc
    const candidateOffsets = [0, 35 * DEG_TO_RAD, -35 * DEG_TO_RAD];
    const eye = this.aimer.getEyePosition();
    let bestChoice = null;

    for (const offset of candidateOffsets) {
      const testYaw = awayYaw + offset;
      const evaluation = this._evaluateEscapeArc(eye, testYaw, pitchRad, offset);
      if (evaluation.safe && (!bestChoice || evaluation.score > bestChoice.score)) {
        bestChoice = {
          yaw: testYaw,
          offset,
          score: evaluation.score,
          landingTarget: evaluation.sim ? evaluation.sim.landingPos : null
        };
      }
    }

    if (!bestChoice) {
      return false;
    }

    return this._queuePearl(
      pearl,
      'escape',
      { yaw: bestChoice.yaw, pitch: pitchRad },
      { pitchDeg, landingTarget: bestChoice.landingTarget }
    );
  }

  /**
   * Unified entry point for chase, agro-cancel, or defensive escape Ender Pearls.
   */
  tryEnderPearl(target, mode = 'chase') {
    if (mode === 'retreat' || mode === 'escape') {
      return this.tryDefensivePearl(target);
    }
    if (mode === 'agro_cancel' || mode === 'combo_break') {
      return this.tryAgroCancelPearl(target);
    }
    return this.tryAggressivePearl(target);
  }

  // =========================================================================
  // 3. ARENA & HAZARD AWARENESS + 1-TICK WATER BUCKET COBWEB ESCAPE
  // =========================================================================

  /**
   * Returns true if a block name is an immediate PvP arena hazard (lava, fire, cobweb, etc.).
   */
  isHazardBlock(block) {
    if (!block || !block.name) return false;
    return HAZARD_BLOCKS.has(block.name) ||
      block.name.includes('lava') ||
      block.name.includes('fire');
  }

  /**
   * Raycasts/inspects a world coordinate around the bot's feet to ensure it is free of
   * solid walls, lava, fire, cobwebs, and void edges / steep drops (> maxSafeDropBlocks).
   */
  isPositionSafe(pos) {
    if (!this.bot || !pos) return false;

    const feetBlock = this.bot.blockAt(pos);
    const headBlock = this.bot.blockAt(pos.offset(0, 1, 0));

    // Check immediate hazardous blocks (lava, fire, cobweb)
    if (feetBlock && this.isHazardBlock(feetBlock)) {
      return false;
    }
    if (headBlock && this.isHazardBlock(headBlock)) {
      return false;
    }

    // Use true collision height so walking across slabs, trapdoors, stairs, carpets, and paths
    // (auto-step <= 0.6b) is walkable and floating slab bridges count as solid floor support.
    const col = inspectColumnStep(this.bot, pos.x, pos.y, pos.z);
    if (col.blocked || col.needsJump) {
      return false;
    }

    // Column check below feet for lava/fire/cobweb floor and void edges / dangerous cliffs
    const maxDrop = this.rangedCfg.maxSafeDropBlocks || 3;
    let foundSolidFloor = col.hasFloor;

    for (let depth = 1; depth <= maxDrop + 1; depth++) {
      const below = this.bot.blockAt(pos.offset(0, -depth, 0));
      if (!below) continue;

      if (this.isHazardBlock(below)) {
        return false; // Stepping over lava, fire, magma, or cobweb pit
      }
      if (below.boundingBox === 'block') {
        if (depth <= maxDrop) {
          foundSolidFloor = true;
        }
        break;
      }
    }

    return foundSolidFloor;
  }

  /**
   * Raycasts along a horizontal yaw direction from the bot's feet (sampling near + far steps)
   * to prevent strafing or backpedaling into lava, fire, void edges, or cobwebs.
   */
  isDirectionSafe(yawRad, stepDist = 1.15) {
    if (!this.bot || !this.bot.entity) return false;
    const base = this.bot.entity.position;
    const dx = -Math.sin(yawRad);
    const dz = -Math.cos(yawRad);

    const nearPos = base.offset(dx * (stepDist * 0.55), 0, dz * (stepDist * 0.55));
    const farPos = base.offset(dx * stepDist, 0, dz * stepDist);

    return this.isPositionSafe(nearPos) && this.isPositionSafe(farPos);
  }

  /**
   * Scans the 4 cardinal directions relative to the bot's facing for arena hazards.
   */
  scanHazardsAroundFeet() {
    if (!this.bot || !this.bot.entity) {
      return { forwardSafe: false, backSafe: false, leftSafe: false, rightSafe: false, inCobweb: false };
    }
    const yaw = this.bot.entity.yaw;
    return {
      forwardSafe: this.isDirectionSafe(yaw, 1.1),
      backSafe: this.isDirectionSafe(yaw + Math.PI, 1.05),
      leftSafe: this.isDirectionSafe(yaw - Math.PI / 2, 1.1),
      rightSafe: this.isDirectionSafe(yaw + Math.PI / 2, 1.1),
      inCobweb: this.isInCobweb()
    };
  }

  /**
   * Returns true if any corner of the bot's 0.6-wide hitbox (feet or head) overlaps a cobweb.
   */
  isInCobweb() {
    if (!this.bot || !this.bot.entity) return false;
    return Boolean(
      this.bot.entity.isInWeb ||
      findOverlappingBlock(this.bot, (b) => b.name === 'cobweb')
    );
  }

  /**
   * Cobweb escape (water bucket -> ender pearl -> sword dig) is owned by EscapeModule.
   * Retained as a clean no-op stub for backward compatibility.
   */
  tickCobwebEscape() {
    this.cobwebEscapeState = 'IDLE';
    return false;
  }

  // =========================================================================
  // OFFENSIVE CLOSE UTILITY (COBWEB / LAVA BUCKET) & RANGED TICK LOOP
  // =========================================================================

  /**
   * Evaluates tactical cobweb or lava bucket utility when in close-mid range.
   */
  tryCloseUtility(target) {
    if (!this.rangedCfg.enabled || !target || !target.isValid || !this.bot.entity) return false;
    const now = Date.now();

    // 1. Scoop back previously placed offensive lava
    if (
      this.activeLavaPos &&
      (now - this.activeLavaPlacedAt) >= (this.rangedCfg.lavaPickupDelayMs || 1400)
    ) {
      const bucket = this._findItem('bucket');
      const lavaDist = this.bot.entity.position.distanceTo(this.activeLavaPos);
      if (bucket && lavaDist <= 4.3) {
        this.pendingAction = {
          type: 'lava_pickup',
          item: bucket,
          targetPos: this.activeLavaPos.offset(0.5, 0.3, 0.5),
          createdAt: now
        };
        this._equipSafe(bucket);
        return true;
      } else if (lavaDist > 6 || (now - this.activeLavaPlacedAt) > 6000) {
        this.activeLavaPos = null;
      }
    }

    if (this.pendingAction || this.isDrawing) return Boolean(this.pendingAction);

    const dist = this.bot.entity.position.distanceTo(target.position);

    // 2. Cobweb placement at opponent's feet
    if (
      this.rangedCfg.cobwebEnabled &&
      dist >= (this.rangedCfg.cobwebMinRange || 2.2) &&
      dist <= (this.rangedCfg.cobwebMaxRange || 4.0) &&
      (now - this.lastCobwebTime) >= (this.rangedCfg.cobwebCooldownMs || 6000)
    ) {
      const cobweb = this._findItem('cobweb');
      const feetPos = target.position.floored();
      const belowBlock = this.bot.blockAt(feetPos.offset(0, -1, 0));
      const feetBlock = this.bot.blockAt(feetPos);

      if (cobweb && belowBlock && belowBlock.boundingBox === 'block' && feetBlock && feetBlock.name === 'air') {
        this.pendingAction = {
          type: 'cobweb',
          item: cobweb,
          refBlockPos: belowBlock.position,
          targetPos: belowBlock.position.offset(0.5, 1.0, 0.5),
          createdAt: now
        };
        this._equipSafe(cobweb);
        return true;
      }
    }

    // 3. Lava bucket placement at opponent's feet
    if (
      this.rangedCfg.lavaEnabled &&
      !this.activeLavaPos &&
      dist >= (this.rangedCfg.lavaMinRange || 2.5) &&
      dist <= (this.rangedCfg.lavaMaxRange || 4.0) &&
      (now - this.lastLavaTime) >= (this.rangedCfg.lavaCooldownMs || 8000)
    ) {
      const lavaBucket = this._findItem('lava_bucket');
      const feetPos = target.position.floored();
      const belowBlock = this.bot.blockAt(feetPos.offset(0, -1, 0));
      const feetBlock = this.bot.blockAt(feetPos);

      if (lavaBucket && belowBlock && belowBlock.boundingBox === 'block' && feetBlock && feetBlock.name === 'air') {
        this.pendingAction = {
          type: 'lava_place',
          item: lavaBucket,
          placePos: feetPos,
          targetPos: belowBlock.position.offset(0.5, 1.0, 0.5),
          createdAt: now
        };
        this._equipSafe(lavaBucket);
        return true;
      }
    }

    return false;
  }

  /**
   * 20-TPS tick handler for cobweb escape, queued utility actions, and predictive bow/crossbow shots.
   * Returns true if the ranged module handled this tick.
   */
  tick(target) {
    if (!this.bot.entity) {
      this.cancel();
      return false;
    }

    // 1. Immediate cobweb water-bucket escape
    if (this.tickCobwebEscape()) {
      return true;
    }

    // 2. Finish any queued smooth-aim utility action (pearl, cobweb, lava)
    if (this.pendingAction) {
      return this._tickPendingAction();
    }

    // 3. Continue active predictive bow/crossbow draw
    if (this.isDrawing) {
      if (!target || !target.isValid || !this.shouldUseRangedWeapon(target)) {
        this.cancel();
        return false;
      }
      this._tickBowOrCrossbow(target);
      return true;
    }

    // 4. Start a new bow/crossbow shot in mid-range pressure band
    if (this.startingDraw) {
      return true;
    }
    if (target && target.isValid && this.shouldUseRangedWeapon(target)) {
      return this._startRangedShot(target);
    }

    return false;
  }

  _tickPendingAction() {
    const action = this.pendingAction;
    const now = Date.now();

    if ((now - action.createdAt) > 1500) {
      this.pendingAction = null;
      return false;
    }

    this.bot.setControlState('sprint', false);

    let aimStatus;
    if (action.aimAngles) {
      aimStatus = this.aimer.stepTowardsAngles(action.aimAngles.yaw, action.aimAngles.pitch, {
        speedMultiplier: action.mode === 'escape' ? 1.35 : 1.15,
        toleranceRad: 0.1
      });
    } else if (action.targetPos) {
      aimStatus = this.aimer.stepTowardsPoint(action.targetPos, {
        speedMultiplier: 1.15,
        toleranceRad: 0.12
      });
    } else {
      this.pendingAction = null;
      return false;
    }

    if (action.type === 'pearl') {
      // Wait for any async bot.equip to finish before settling/throwing
      if (action.equipping) {
        return true;
      }

      // Enforce packet-safe 1-tick settle after setQuickBarSlot / bot.equip
      if (action.equipSettleTicks > 0) {
        action.equipSettleTicks--;
        return true;
      }

      if (!aimStatus.aligned) {
        return true;
      }

      // If another module swapped our held item away, re-equip now and wait 1 tick (never swap+throw same tick)
      if (!this._isHoldingPearl()) {
        const freshPearl = this._findItem('ender_pearl');
        if (!freshPearl) {
          this.pendingAction = null;
          return false;
        }
        action.item = freshPearl;
        this._startActionEquip(action);
        return true;
      }

      this.pendingAction = null;
      this._executePendingAction(action);
      return true;
    }

    if (!aimStatus.aligned) {
      return true;
    }

    this.pendingAction = null;
    this._executePendingAction(action);
    return true;
  }

  async _executePendingAction(action) {
    const now = Date.now();
    try {
      if (action.type === 'pearl') {
        // Defensive guard: never call setQuickBarSlot/bot.equip on the same tick as activateItem(false)
        if (!this._isHoldingPearl()) {
          const freshPearl = this._findItem('ender_pearl');
          if (!freshPearl) return;
          action.item = freshPearl;
          action.createdAt = now;
          this.pendingAction = action;
          this._startActionEquip(action);
          return;
        }
        // Instant throwable item: send use_item only (NEVER call deactivateItem on instant throwables)
        this.bot.activateItem(false);
        this.lastPearlTime = now;
        return;
      }

      const equipped = await this._equipSafe(action.item);
      if (!equipped) return;

      if (action.type === 'cobweb') {
        const refBlock = this.bot.blockAt(action.refBlockPos);
        if (refBlock && refBlock.boundingBox === 'block') {
          await this.bot.placeBlock(refBlock, new Vec3(0, 1, 0));
          this.lastCobwebTime = now;
        }
      } else if (action.type === 'lava_place') {
        this.bot.activateItem(false);
        this.lastLavaTime = now;
        this.activeLavaPos = action.placePos;
        this.activeLavaPlacedAt = now;
      } else if (action.type === 'lava_pickup') {
        this.bot.activateItem(false);
        this.activeLavaPos = null;
      }
    } catch (_) {
      // Action interrupted
    }
  }

  _startRangedShot(target) {
    if (this.startingDraw || this.isDrawing) return true;
    const allowBow = this.rangedCfg.bowEnabled !== false;
    const allowCrossbow = this.rangedCfg.crossbowEnabled === true;
    const bow = allowBow ? this._findItem('bow') : null;
    const crossbow = allowCrossbow ? this._findItem('crossbow') : null;
    const weapon = bow || crossbow;
    if (!weapon) return false;

    const beginDraw = () => {
      this.bot.setControlState('sprint', false);
      this.bot.activateItem(false);
      this.isDrawing = true;
      this.drawWeaponType = weapon.name === 'crossbow' ? 'crossbow' : 'bow';
      this.drawTicks = 0;
    };

    // Fast synchronous hotbar select when bow/crossbow is already on hotbar
    if (this._equipHotbarImmediate(weapon)) {
      beginDraw();
      return true;
    }

    // Async equip fallback if bow is in main inventory (guarded so it never re-enters)
    this.startingDraw = true;
    this._equipSafe(weapon)
      .then((equipped) => {
        if (equipped && this.bot && this.bot.entity) {
          beginDraw();
        }
      })
      .catch(() => {})
      .finally(() => {
        this.startingDraw = false;
      });
    return true;
  }

  _tickBowOrCrossbow(target) {
    this.drawTicks++;

    // Never sprint while drawing a bow/crossbow (prevents NoSlow flags)
    this.bot.setControlState('sprint', false);
    this.bot.setControlState('forward', false);
    this.bot.setControlState('back', false);

    // Hazard-aware lateral strafing while drawing
    const hazards = this.scanHazardsAroundFeet();
    const wantLeft = (this.drawTicks % 30) < 15;
    if (wantLeft && hazards.leftSafe) {
      this.bot.setControlState('left', true);
      this.bot.setControlState('right', false);
    } else if (!wantLeft && hazards.rightSafe) {
      this.bot.setControlState('left', false);
      this.bot.setControlState('right', true);
    } else {
      this.bot.setControlState('left', false);
      this.bot.setControlState('right', false);
    }

    const isCrossbow = this.drawWeaponType === 'crossbow';
    const speed = isCrossbow ? CROSSBOW_SPEED : ARROW_SPEED;
    const requiredTicks = isCrossbow
      ? (this.rangedCfg.crossbowChargeTicks || 26)
      : (this.rangedCfg.bowChargeTicks || 21);

    let targetVel = target.velocity || new Vec3(0, 0, 0);
    let targetAccel = null;
    if (this.prediction && typeof this.prediction.getTargetKinematics === 'function') {
      const kin = this.prediction.getTargetKinematics(target);
      if (kin) {
        targetVel = kin.velocity || targetVel;
        targetAccel = kin.acceleration || null;
      }
    }

    const aimTarget = target.position.offset(0, (target.height || 1.8) * 0.65, 0);
    const solution = this.solveProjectileTrajectory(
      aimTarget,
      targetVel,
      speed,
      ARROW_GRAVITY,
      ARROW_DRAG,
      targetAccel
    );

    const aimStatus = this.aimer.stepTowardsAngles(solution.yaw, solution.pitch, {
      toleranceRad: 0.065 // Tight ~3.7° accuracy for predictive shots
    });

    // Timeout safeguard so bot never freezes holding a bow if LOS gets blocked mid-draw
    if (this.drawTicks > requiredTicks + 25) {
      this.cancel();
      this.lastBowShotTime = Date.now();
      return;
    }

    if (
      this.drawTicks >= requiredTicks &&
      aimStatus.aligned &&
      this.hasClearLineOfSight(solution.predictedPos)
    ) {
      this.bot.deactivateItem();
      this.lastBowShotTime = Date.now();
      if (isCrossbow) {
        if (this._crossbowReleaseTimer) {
          clearTimeout(this._crossbowReleaseTimer);
        }
        this._crossbowReleaseTimer = setTimeout(() => {
          this._crossbowReleaseTimer = null;
          if (!this.bot || !this.bot.entity) return;
          try {
            this.bot.activateItem(false);
          } catch (_) {}
        }, 100);
      }
      this.isDrawing = false;
      this.drawWeaponType = null;
      this.drawTicks = 0;
    }
  }
}

module.exports = {
  RangedModule,
  ARROW_SPEED,
  ARROW_GRAVITY,
  ARROW_DRAG,
  PEARL_SPEED,
  PEARL_GRAVITY,
  PEARL_DRAG
};
