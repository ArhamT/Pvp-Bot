'use strict';

const { Vec3 } = require('vec3');
const { clamp, DEG_TO_RAD } = require('./aim');

const HAZARD_BLOCKS = new Set([
  'lava',
  'flowing_lava',
  'fire',
  'soul_fire',
  'campfire',
  'soul_campfire',
  'magma_block',
  'cobweb',
  'sweet_berry_bush',
  'wither_rose',
  'cactus'
]);

const ARROW_SPEED = 3.0;
const CROSSBOW_SPEED = 3.15;
const ARROW_GRAVITY = 0.05;
const ARROW_DRAG = 0.99;

const PEARL_SPEED = 1.5;
const PEARL_GRAVITY = 0.03;
const PEARL_DRAG = 0.99;

/**
 * Ranged pressure, tactical Ender Pearl, and Arena/Hazard awareness module:
 * 1. Predictive Bow/Crossbow aiming with discrete Minecraft drag (0.99) + gravity (0.05) + velocity lead solver.
 * 2. Aggressive Chase Ender Pearls (target > 14b away & < 10 HP, aimed 2 blocks ahead of their path)
 *    and Defensive Escape Ender Pearls (bot < 6 HP & trapped in combo/cobweb, 35–45° upward away from enemy).
 * 3. Arena & hazard raycasting (lava, fire, void edges/cliffs, cobwebs) + 1-tick Water Bucket cobweb escape.
 */
class RangedModule {
  constructor(bot, config, aimer, prediction = null) {
    this.bot = bot;
    this.config = config;
    this.rangedCfg = config.ranged;
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
   * Backward-compatible wrapper returning { yaw, pitch }.
   */
  computeBallisticAngles(targetPos, targetVel, speed = ARROW_SPEED, gravity = ARROW_GRAVITY) {
    const sol = this.solveProjectileTrajectory(targetPos, targetVel, speed, gravity, ARROW_DRAG);
    return { yaw: sol.yaw, pitch: sol.pitch };
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
    const dist = this.bot.entity.position.distanceTo(target.position);
    const minRange = this.rangedCfg.bowMinRange || 8.0;
    const maxRange = this.rangedCfg.bowMaxRange || 28.0;

    if (dist < minRange || dist > maxRange) return false;
    if (!this.isDrawing && (Date.now() - this.lastBowShotTime) < (this.rangedCfg.bowShotCooldownMs || 2800)) {
      return false;
    }
    if (!this._hasArrows()) return false;
    if (!this._findItem('bow') && !this._findItem('crossbow')) return false;

    const aimTarget = target.position.offset(0, (target.height || 1.8) * 0.65, 0);
    if (!this.isDrawing && !this.hasClearLineOfSight(aimTarget)) return false;
    return true;
  }

  // =========================================================================
  // 2. AGGRESSIVE CHASE & DEFENSIVE ESCAPE ENDER PEARLS
  // =========================================================================

  /**
   * Extracts target HP if exposed via entity.health or living-entity metadata[9].
   */
  _getTargetHealth(target) {
    if (!target) return null;
    if (typeof target.health === 'number' && !Number.isNaN(target.health)) {
      return target.health;
    }
    if (target.metadata && typeof target.metadata[9] === 'number' && target.metadata[9] > 0) {
      return target.metadata[9];
    }
    return null;
  }

  /**
   * Returns true if the bot is trapped in a cobweb OR caught in a rapid melee combo.
   */
  isTrappedInComboOrCobweb(target) {
    if (this.isInCobweb()) return true;

    const now = Date.now();
    this.recentHitTimestamps = this.recentHitTimestamps.filter((ts) => (now - ts) <= 1600);
    const recentHits = this.recentHitTimestamps.length;

    const enemyNear = target && target.isValid && this.bot.entity
      ? this.bot.entity.position.distanceTo(target.position) <= 5.5
      : false;

    const knockedAirborne = this.bot.entity && !this.bot.entity.onGround && recentHits >= 1 && enemyNear;
    return (recentHits >= 2 && enemyNear) || knockedAirborne;
  }

  /**
   * Aggressive Chase & Agro-Cancel Ender Pearl:
   * - Chase: Target is > enderPearlChaseRange (11b) away and bot is healthy (works even when servers hide enemy HP!).
   * - Agro Cancel: Target is > 7.5b away and actively eating/drinking (gapple/pot) while bot is healthy (>= 14 HP).
   * Calculates a ballistic pearl trajectory landing 2–3 blocks ahead of their predicted path and verifies landing safety.
   */
  tryAggressivePearl(target) {
    if (!this.rangedCfg.enabled || this.pendingAction || this.isDrawing) return false;
    if (!target || !target.isValid || !this.bot.entity) return false;

    const now = Date.now();
    if ((now - this.lastPearlTime) < (this.rangedCfg.enderPearlCooldownMs || 3200)) return false;

    const pearl = this._findItem('ender_pearl');
    if (!pearl) return false;

    const dist = this.bot.entity.position.distanceTo(target.position);
    const chaseRange = this.rangedCfg.enderPearlChaseRange || 11.0;

    // Check if target is retreating to eat a gapple/drink a potion (>7.5b away)
    const handFlags = target.metadata && target.metadata[8];
    const targetUsingItem = (typeof handFlags === 'number' && (handFlags & 0x01) !== 0) ||
      Boolean(target.usingHeldItem || target.isUsingItem);
    const mainHand = target.equipment && target.equipment[0];
    const targetHealing = targetUsingItem && mainHand && mainHand.name && (
      mainHand.name.includes('apple') ||
      mainHand.name.includes('potion') ||
      mainHand.name.includes('carrot') ||
      mainHand.name.includes('beef')
    );

    const targetHp = this._getTargetHealth(target);
    const maxTargetHp = this.rangedCfg.enderPearlChaseMaxTargetHp || 20;
    const hpAllowsChase = targetHp === null ? (this.bot.health >= 12) : (targetHp < maxTargetHp);

    const shouldChase = dist > chaseRange && hpAllowsChase;
    const shouldAgroCancel = targetHealing && dist >= 7.5 && dist <= 24.0 && this.bot.health >= 14;

    if (!shouldChase && !shouldAgroCancel) return false;

    // Determine target's normalized horizontal travel direction (preferring PredictionModule kinematics)
    let vel = target.velocity || new Vec3(0, 0, 0);
    let accel = null;
    if (this.prediction && typeof this.prediction.getTargetKinematics === 'function') {
      const kin = this.prediction.getTargetKinematics(target);
      if (kin) {
        vel = kin.velocity || vel;
        accel = kin.acceleration || null;
      }
    }
    const horizSpeed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
    let dirX;
    let dirZ;
    if (horizSpeed > 0.02) {
      dirX = vel.x / horizSpeed;
      dirZ = vel.z / horizSpeed;
    } else {
      const away = target.position.minus(this.bot.entity.position);
      const len = Math.max(0.01, Math.sqrt(away.x * away.x + away.z * away.z));
      dirX = away.x / len;
      dirZ = away.z / len;
    }

    // Aim 2.5 blocks ahead of their movement path + ballistic flight-time lead
    const leadBlocks = this.rangedCfg.enderPearlChaseLeadBlocks || 2.5;
    const baseTargetPos = target.position.offset(dirX * leadBlocks, 0.2, dirZ * leadBlocks);
    const solution = this.solveProjectileTrajectory(
      baseTargetPos,
      vel,
      PEARL_SPEED,
      PEARL_GRAVITY,
      PEARL_DRAG,
      accel
    );

    // Avoid pearling directly into lava or void if chunk around landing point is loaded
    if (this.bot.blockAt(solution.predictedPos) && !this.isPositionSafe(solution.predictedPos)) {
      // Fall back to target's current feet if 2.5b ahead is hazardous
      if (!this.isPositionSafe(target.position)) return false;
      const safeSol = this.solveProjectileTrajectory(target.position.offset(0, 0.2, 0), new Vec3(0, 0, 0), PEARL_SPEED, PEARL_GRAVITY, PEARL_DRAG);
      solution.yaw = safeSol.yaw;
      solution.pitch = safeSol.pitch;
      solution.predictedPos = target.position.clone();
    }

    this.pendingAction = {
      type: 'pearl',
      mode: shouldAgroCancel ? 'agro_cancel' : 'chase',
      item: pearl,
      aimAngles: { yaw: solution.yaw, pitch: solution.pitch },
      landingTarget: solution.predictedPos,
      createdAt: now
    };
    this._equipSafe(pearl);
    return true;
  }

  /**
   * Defensive Escape Pearl:
   * If bot is < 6 HP and trapped in a combo or cobweb, pearls upward at a 35–45° angle
   * away from the enemy.
   */
  tryDefensivePearl(target) {
    if (!this.rangedCfg.enabled || this.pendingAction || this.isDrawing) return false;
    if (!this.bot.entity) return false;

    const now = Date.now();
    if ((now - this.lastPearlTime) < (this.rangedCfg.enderPearlCooldownMs || 5000)) return false;

    const escapeHp = this.rangedCfg.enderPearlEscapeHealth || 6;
    if (this.bot.health >= escapeHp) return false;
    if (!this.isTrappedInComboOrCobweb(target)) return false;

    const pearl = this._findItem('ender_pearl');
    if (!pearl) return false;

    const awayYaw = (target && target.isValid)
      ? Math.atan2(-(this.bot.entity.position.x - target.position.x), -(this.bot.entity.position.z - target.position.z))
      : this.bot.entity.yaw;

    const minDeg = this.rangedCfg.enderPearlEscapePitchMinDeg || 35;
    const maxDeg = this.rangedCfg.enderPearlEscapePitchMaxDeg || 45;
    const pitchDeg = minDeg + Math.random() * (maxDeg - minDeg);
    const pitchRad = pitchDeg * DEG_TO_RAD;

    // Check if the chosen upward escape vector is blocked immediately ahead; shift yaw slightly if needed
    let chosenYaw = awayYaw;
    const candidateOffsets = [0, 25 * DEG_TO_RAD, -25 * DEG_TO_RAD, 50 * DEG_TO_RAD, -50 * DEG_TO_RAD];
    const eye = this.aimer.getEyePosition();
    for (const offset of candidateOffsets) {
      const testYaw = awayYaw + offset;
      const probe = eye.offset(
        -Math.sin(testYaw) * Math.cos(pitchRad) * 4.0,
        Math.sin(pitchRad) * 4.0,
        -Math.cos(testYaw) * Math.cos(pitchRad) * 4.0
      );
      if (this.hasClearLineOfSight(probe)) {
        chosenYaw = testYaw;
        break;
      }
    }

    this.pendingAction = {
      type: 'pearl',
      mode: 'escape',
      item: pearl,
      aimAngles: { yaw: chosenYaw, pitch: pitchRad },
      pitchDeg,
      createdAt: now
    };
    this._equipSafe(pearl);
    return true;
  }

  /**
   * Unified entry point for chase or retreat Ender Pearls.
   */
  tryEnderPearl(target, mode = 'chase') {
    if (mode === 'retreat' || mode === 'escape') {
      return this.tryDefensivePearl(target);
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

    // Check immediate body collisions & hazardous blocks
    if (feetBlock && (feetBlock.boundingBox === 'block' || this.isHazardBlock(feetBlock))) {
      return false;
    }
    if (headBlock && (headBlock.boundingBox === 'block' || this.isHazardBlock(headBlock))) {
      return false;
    }

    // Column check below feet for lava/fire/cobweb floor and void edges / dangerous cliffs
    const maxDrop = this.rangedCfg.maxSafeDropBlocks || 3;
    let foundSolidFloor = false;

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
   * Returns true if the bot's feet or head are currently trapped inside a cobweb.
   */
  isInCobweb() {
    if (!this.bot || !this.bot.entity) return false;
    const pos = this.bot.entity.position;
    const feet = this.bot.blockAt(pos);
    const head = this.bot.blockAt(pos.offset(0, 1, 0));
    return Boolean(
      (feet && feet.name === 'cobweb') ||
      (head && head.name === 'cobweb')
    );
  }

  /**
   * 20-TPS handler for instant Water Bucket cobweb escape:
   * If stuck in a cobweb, smoothly looks down at feet, places a water bucket to break the web,
   * and picks the water back up after 1 tick (50ms).
   * Returns true while actively clearing/picking up water.
   */
  tickCobwebEscape() {
    if (!this.bot || !this.bot.entity) return false;

    // Phase 2: Pick water back up after 1 tick (50ms)
    if (this.cobwebEscapeState === 'WAITING_PICKUP') {
      if (this.waterPickupTicksRemaining > 0) {
        this.waterPickupTicksRemaining--;
      }
      if (this.waterPickupTicksRemaining <= 0) {
        this._pickupCobwebWater();
        this.cobwebEscapeState = 'IDLE';
        this.cobwebWaterPos = null;
      }
      return true;
    }

    // Phase 1: Currently aiming down to place water bucket
    if (this.cobwebEscapeState === 'AIMING_PLACE') {
      if (!this.isInCobweb()) {
        this.cobwebEscapeState = 'IDLE';
        return false;
      }

      const waterBucket = this._findItem('water_bucket');
      if (!waterBucket) {
        this.cobwebEscapeState = 'IDLE';
        return false;
      }

      this.bot.setControlState('sprint', false);
      const aimStatus = this.aimer.stepTowardsAngles(this.bot.entity.yaw, -Math.PI / 2, {
        speedMultiplier: 1.5,
        toleranceRad: 0.18
      });

      if (aimStatus.pitchErrorDeg <= 10) {
        this.cobwebEscapeState = 'WAITING_PICKUP';
        this.waterPickupTicksRemaining = this.rangedCfg.cobwebWaterPickupTicks || 1;
        this._placeCobwebWater(waterBucket);
      }
      return true;
    }

    // Trigger check: stuck in a cobweb with a water bucket available
    if (this.isInCobweb()) {
      const waterBucket = this._findItem('water_bucket');
      if (waterBucket) {
        this.cancel(); // Cancel bow draw if any
        this._equipSafe(waterBucket);
        this.cobwebEscapeState = 'AIMING_PLACE';
        return this.tickCobwebEscape();
      }
    }

    return false;
  }

  _equipHotbarImmediate(item) {
    if (!item) return false;
    if (this.bot.heldItem && this.bot.heldItem.type === item.type) return true;
    const hotbarStart = (this.bot.inventory && this.bot.inventory.hotbarStart) || 36;
    if (
      item.slot >= hotbarStart &&
      item.slot < hotbarStart + 9 &&
      typeof this.bot.setQuickBarSlot === 'function'
    ) {
      this.bot.setQuickBarSlot(item.slot - hotbarStart);
      return true;
    }
    return false;
  }

  _placeCobwebWater(waterBucket) {
    if (this._equipHotbarImmediate(waterBucket)) {
      this.cobwebWaterPos = this.bot.entity.position.floored();
      this.bot.activateItem(false);
      return;
    }
    this._equipSafe(waterBucket)
      .then((ok) => {
        if (!ok || !this.bot.entity) return;
        this.cobwebWaterPos = this.bot.entity.position.floored();
        this.bot.activateItem(false);
      })
      .catch(() => {});
  }

  _pickupCobwebWater() {
    const emptyBucket = this._findItem('bucket');
    if (!emptyBucket || this._equipHotbarImmediate(emptyBucket)) {
      this.bot.activateItem(false);
      setTimeout(() => {
        try { this.bot.deactivateItem(); } catch (_) {}
      }, 40);
      return;
    }
    this._equipSafe(emptyBucket)
      .then(() => {
        this.bot.activateItem(false);
        setTimeout(() => {
          try { this.bot.deactivateItem(); } catch (_) {}
        }, 40);
      })
      .catch(() => {});
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
      const equipped = await this._equipSafe(action.item);
      if (!equipped) return;

      if (action.type === 'pearl') {
        // Instant throwable item: send use_item only (no extra block_dig/deactivateItem packet)
        this.bot.activateItem(false);
        this.lastPearlTime = now;
      } else if (action.type === 'cobweb') {
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
    const bow = this._findItem('bow');
    const crossbow = this._findItem('crossbow');
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
        setTimeout(() => {
          try {
            this.bot.activateItem(false);
            setTimeout(() => {
              try { this.bot.deactivateItem(); } catch (_) {}
            }, 60);
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
