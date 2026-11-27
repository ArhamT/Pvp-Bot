'use strict';

const { Vec3 } = require('vec3');
const { ROAM_HAZARD_BLOCKS, clearMovementControls, inspectColumnStep } = require('../constants');
const { normalizeAngle } = require('../aim');

/**
 * Packet-quiet IDLE spawn roaming & randomized duel chat advertisement mixin for PvPBotController.
 * Always keeps IDLE sprint off and roam looks throttled <= 10 Hz (`force: false`).
 */
const spawnRoamMethods = {
  _clearAdvertiseTimer() {
    if (this.advertiseTimer) {
      clearTimeout(this.advertiseTimer);
      this.advertiseTimer = null;
    }
  },

  _countOtherOnlinePlayers() {
    if (!this.bot || !this.bot.players) return 0;
    const selfName = (this.bot.username || '').toLowerCase();
    return Object.keys(this.bot.players).filter((name) => name && name.toLowerCase() !== selfName).length;
  },

  _scheduleAdvertise() {
    this._clearAdvertiseTimer();
    if (!this.advertiseEnabled || this.shuttingDown) return;

    const advCfg = (this.config.bot && this.config.bot.advertise) || {};
    const minDelay = Number.isFinite(advCfg.minDelayMs) ? advCfg.minDelayMs : 60000;
    const maxDelay = Number.isFinite(advCfg.maxDelayMs) ? Math.max(minDelay, advCfg.maxDelayMs) : 180000;
    const delayMs = Math.round(this._randRange(minDelay, maxDelay));

    this.advertiseTimer = setTimeout(() => {
      this.advertiseTimer = null;
      this._sendAdvertise();
      this._scheduleAdvertise();
    }, delayMs);
  },

  _sendAdvertise() {
    if (!this.advertiseEnabled || this.shuttingDown || !this.bot || !this.bot.entity) return false;
    if (this.state !== 'IDLE' || this.inDuelArena) return false;
    if (this.loginPassword && !this.loginAttempted) return false;
    if (this._countOtherOnlinePlayers() === 0) return false;

    const advCfg = (this.config.bot && this.config.bot.advertise) || {};
    const messages = Array.isArray(advCfg.messages) ? advCfg.messages.filter((m) => typeof m === 'string' && m.trim()) : [];
    if (messages.length === 0) return false;

    let idx = Math.floor(Math.random() * messages.length);
    if (messages.length > 1 && idx === this.lastAdvertiseIndex) {
      idx = (idx + 1 + Math.floor(Math.random() * (messages.length - 1))) % messages.length;
    }
    this.lastAdvertiseIndex = idx;

    let text = messages[idx].replace(/\{name\}/g, this.bot.username || 'me').trim();
    const colorPrefix = typeof advCfg.colorPrefix === 'string' ? advCfg.colorPrefix : '&b';
    if (colorPrefix && !/^&[0-9a-fk-orx]/i.test(text)) {
      text = `${colorPrefix}${text}`;
    }
    this.bot.chat(text);
    this.log(`[ADS] ${text}`);
    return true;
  },

  _randRange(minVal, maxVal) {
    return minVal + Math.random() * Math.max(0, maxVal - minVal);
  },

  _stopSpawnRoam() {
    clearMovementControls(this.bot);
    this.roamTargetPos = null;
  },

  _resetSpawnRoam() {
    const botCfg = this.config.bot || {};
    const pauseMin = botCfg.roamPauseMinMs !== undefined ? botCfg.roamPauseMinMs : 2200;
    const pauseMax = botCfg.roamPauseMaxMs !== undefined ? botCfg.roamPauseMaxMs : 4800;
    const now = Date.now();
    this._stopSpawnRoam();
    this.roamPhase = 'PAUSED';
    this.roamPhaseUntil = now + this._randRange(Math.min(1200, pauseMin), pauseMax);
    this.roamNextGlanceAt = now + this._randRange(1800, 3200);
    if (this.bot && this.bot.entity) {
      this.roamGlanceYaw = this.bot.entity.yaw || 0;
      this.roamGlancePitch = 0;
    }
  },

  _isRoamStepSafe(yaw) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) {
      return { safe: false, shouldStepUp: false };
    }
    if (typeof this.bot.blockAt !== 'function') {
      return { safe: true, shouldStepUp: false };
    }

    const pos = this.bot.entity.position;
    const baseY = Math.floor(pos.y);

    const feetBlock = this.bot.blockAt(new Vec3(pos.x, baseY, pos.z));
    if (feetBlock && ROAM_HAZARD_BLOCKS.has(feetBlock.name)) {
      return { safe: false, shouldStepUp: false };
    }

    // Sample both near (0.55b — catches walls the bot is currently touching!) and far (1.1b)
    let shouldStepUp = false;
    for (const dist of [0.55, 1.1]) {
      const stepX = pos.x - Math.sin(yaw) * dist;
      const stepZ = pos.z - Math.cos(yaw) * dist;

      const aheadFeet = this.bot.blockAt(new Vec3(stepX, baseY, stepZ));
      const aheadHead = this.bot.blockAt(new Vec3(stepX, baseY + 1, stepZ));
      const aheadFloor0 = this.bot.blockAt(new Vec3(stepX, baseY - 1, stepZ));
      const aheadFloor1 = this.bot.blockAt(new Vec3(stepX, baseY - 2, stepZ));

      if (
        (aheadFeet && ROAM_HAZARD_BLOCKS.has(aheadFeet.name)) ||
        (aheadHead && ROAM_HAZARD_BLOCKS.has(aheadHead.name)) ||
        (aheadFloor0 && ROAM_HAZARD_BLOCKS.has(aheadFloor0.name))
      ) {
        return { safe: false, shouldStepUp: false };
      }

      const col = inspectColumnStep(this.bot, stepX, pos.y, stepZ);
      if (col.blocked) {
        return { safe: false, shouldStepUp: false };
      }

      const hasSupport =
        col.hasFloor ||
        Boolean(aheadFloor0 && aheadFloor0.boundingBox === 'block') ||
        Boolean(aheadFloor1 && aheadFloor1.boundingBox === 'block');
      if (!hasSupport) {
        return { safe: false, shouldStepUp: false };
      }

      if (col.needsJump) {
        shouldStepUp = true;
      }
    }

    return {
      safe: true,
      shouldStepUp: shouldStepUp && Boolean(this.bot.entity.onGround)
    };
  },

  _getRoamAnchor() {
    const pos = this.bot && this.bot.entity && this.bot.entity.position;
    const botCfg = this.config.bot || {};
    const cfgCenter = botCfg.roamCenter;
    if (
      cfgCenter &&
      typeof cfgCenter.x === 'number' &&
      typeof cfgCenter.y === 'number' &&
      typeof cfgCenter.z === 'number'
    ) {
      const configured = new Vec3(cfgCenter.x, cfgCenter.y, cfgCenter.z);
      // Use configured spawn center whenever in the same spawn region (within 80 blocks)
      if (!pos || Math.hypot(pos.x - configured.x, pos.z - configured.z) <= 80) {
        return configured;
      }
    }
    if (!this.spawnAnchorPos && pos) {
      this.spawnAnchorPos = pos.clone();
    }
    return this.spawnAnchorPos || pos;
  },

  _pickRoamTarget() {
    const pos = this.bot.entity.position;
    const anchor = this._getRoamAnchor() || pos;
    const botCfg = this.config.bot || {};
    const radius = botCfg.roamRadius !== undefined ? botCfg.roamRadius : 10;

    const dxFromAnchor = pos.x - anchor.x;
    const dzFromAnchor = pos.z - anchor.z;
    const distFromAnchor = Math.sqrt(dxFromAnchor * dxFromAnchor + dzFromAnchor * dzFromAnchor);

    if (distFromAnchor > radius * 0.85) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const backYaw = Math.atan2(-(anchor.x - pos.x), -(anchor.z - pos.z)) + (attempt * 0.45 * (attempt % 2 === 0 ? 1 : -1));
        if (this._isRoamStepSafe(backYaw).safe) {
          const dist = Math.min(radius * 0.7, Math.max(2.5, distFromAnchor));
          return new Vec3(
            pos.x - Math.sin(backYaw) * dist,
            pos.y,
            pos.z - Math.cos(backYaw) * dist
          );
        }
      }
    }

    for (let attempt = 0; attempt < 6; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const r = this._randRange(1.5, Math.max(2.5, radius - 0.5));
      const candidate = new Vec3(
        anchor.x + Math.cos(angle) * r,
        pos.y,
        anchor.z + Math.sin(angle) * r
      );
      const yaw = Math.atan2(-(candidate.x - pos.x), -(candidate.z - pos.z));
      if (this._isRoamStepSafe(yaw).safe) {
        return candidate;
      }
    }

    return null;
  },

  _tickSpawnRoam() {
    if (!this.roamInSpawn || this.state !== 'IDLE' || this.inDuelArena) return;
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) return;

    const botCfg = this.config.bot || {};
    const walkMin = botCfg.roamWalkMinMs !== undefined ? botCfg.roamWalkMinMs : 1400;
    const walkMax = botCfg.roamWalkMaxMs !== undefined ? botCfg.roamWalkMaxMs : 3200;
    const pauseMin = botCfg.roamPauseMinMs !== undefined ? botCfg.roamPauseMinMs : 2200;
    const pauseMax = botCfg.roamPauseMaxMs !== undefined ? botCfg.roamPauseMaxMs : 4800;

    const now = Date.now();
    const pos = this.bot.entity.position;
    if (!this.spawnAnchorPos) {
      this.spawnAnchorPos = pos.clone();
    }

    if (this.roamPhase === 'PAUSED') {
      if (now >= this.roamNextGlanceAt) {
        this.roamNextGlanceAt = now + this._randRange(1800, 3200);
        const curYaw = this.bot.entity.yaw || 0;
        this.roamGlanceYaw = normalizeAngle(curYaw + this._randRange(-0.6, 0.6));
        this.roamGlancePitch = this._randRange(-0.14, 0.14);
      }

      if (this.aimer && (now - this.roamLastLookAt) >= 100) {
        const yawDiff = Math.abs(normalizeAngle(this.roamGlanceYaw - (this.bot.entity.yaw || 0)));
        const pitchDiff = Math.abs(this.roamGlancePitch - (this.bot.entity.pitch || 0));
        if (yawDiff > 0.04 || pitchDiff > 0.04) {
          this.roamLastLookAt = now;
          this.aimer.stepTowardsAngles(this.roamGlanceYaw, this.roamGlancePitch, { speedMultiplier: 0.35, force: false });
        }
      }

      if (now >= this.roamPhaseUntil) {
        const nextDest = this._pickRoamTarget();
        if (nextDest) {
          this.roamTargetPos = nextDest;
          this.roamPhase = 'WALKING';
          this.roamPhaseUntil = now + this._randRange(walkMin, walkMax);
        } else {
          this.roamPhaseUntil = now + this._randRange(600, 1400);
        }
      }
      return;
    }

    const dest = this.roamTargetPos;
    if (!dest || now >= this.roamPhaseUntil) {
      this._stopSpawnRoam();
      this.roamPhase = 'PAUSED';
      this.roamPhaseUntil = now + this._randRange(pauseMin, pauseMax);
      return;
    }

    const dx = dest.x - pos.x;
    const dz = dest.z - pos.z;
    const horizDist = Math.sqrt(dx * dx + dz * dz);
    if (horizDist < 1.1) {
      this._stopSpawnRoam();
      this.roamPhase = 'PAUSED';
      this.roamPhaseUntil = now + this._randRange(pauseMin, pauseMax);
      return;
    }

    const yawToDest = Math.atan2(-dx, -dz);
    const anchor = this._getRoamAnchor();
    const radius = botCfg.roamRadius !== undefined ? botCfg.roamRadius : 10;
    if (anchor) {
      const curDist = Math.hypot(pos.x - anchor.x, pos.z - anchor.z);
      const nextDist = Math.hypot((pos.x - Math.sin(yawToDest)) - anchor.x, (pos.z - Math.cos(yawToDest)) - anchor.z);
      if (nextDist > radius && nextDist > curDist) {
        this._stopSpawnRoam();
        this.roamPhase = 'PAUSED';
        this.roamPhaseUntil = now + this._randRange(400, 900);
        return;
      }
    }

    const stepCheck = this._isRoamStepSafe(yawToDest);
    if (this.bot.entity.isCollidedHorizontally && !stepCheck.shouldStepUp) {
      this._roamCollideTicks = (this._roamCollideTicks || 0) + 1;
    } else {
      this._roamCollideTicks = 0;
    }

    if (!stepCheck.safe || this._roamCollideTicks >= 3) {
      this._roamCollideTicks = 0;
      this._stopSpawnRoam();
      this.roamPhase = 'PAUSED';
      this.roamPhaseUntil = now + this._randRange(400, 900);
      return;
    }

    let yawErrorDeg = Math.abs(normalizeAngle(yawToDest - (this.bot.entity.yaw || 0))) * (180 / Math.PI);
    if (this.aimer && (now - this.roamLastLookAt) >= 100) {
      this.roamLastLookAt = now;
      const aimStatus = this.aimer.stepTowardsAngles(yawToDest, 0, {
        speedMultiplier: 0.5,
        toleranceRad: 0.25,
        force: false
      });
      yawErrorDeg = aimStatus.yawErrorDeg;
    }

    if (typeof this.bot.setControlState === 'function') {
      this.bot.setControlState('forward', yawErrorDeg < 45);
      this.bot.setControlState('back', false);
      this.bot.setControlState('left', false);
      this.bot.setControlState('right', false);
      this.bot.setControlState('sprint', false);
      this.bot.setControlState('jump', stepCheck.shouldStepUp);
    }
  }
};

module.exports = { spawnRoamMethods };
