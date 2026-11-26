'use strict';

const { Vec3 } = require('vec3');
const { ROAM_HAZARD_BLOCKS, clearMovementControls } = require('../constants');
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
    const stepX = pos.x - Math.sin(yaw) * 1.1;
    const stepZ = pos.z - Math.cos(yaw) * 1.1;
    const baseY = Math.floor(pos.y);

    const feetBlock = this.bot.blockAt(new Vec3(pos.x, baseY, pos.z));
    if (feetBlock && ROAM_HAZARD_BLOCKS.has(feetBlock.name)) {
      return { safe: false, shouldStepUp: false };
    }

    const aheadFeet = this.bot.blockAt(new Vec3(stepX, baseY, stepZ));
    const aheadHead = this.bot.blockAt(new Vec3(stepX, baseY + 1, stepZ));
    const aheadAbove = this.bot.blockAt(new Vec3(stepX, baseY + 2, stepZ));
    const aheadFloor0 = this.bot.blockAt(new Vec3(stepX, baseY - 1, stepZ));
    const aheadFloor1 = this.bot.blockAt(new Vec3(stepX, baseY - 2, stepZ));

    if (
      (aheadFeet && ROAM_HAZARD_BLOCKS.has(aheadFeet.name)) ||
      (aheadHead && ROAM_HAZARD_BLOCKS.has(aheadHead.name)) ||
      (aheadFloor0 && ROAM_HAZARD_BLOCKS.has(aheadFloor0.name))
    ) {
      return { safe: false, shouldStepUp: false };
    }

    const solidFeet = Boolean(aheadFeet && aheadFeet.boundingBox === 'block');
    const solidHead = Boolean(aheadHead && aheadHead.boundingBox === 'block');
    const solidAbove = Boolean(aheadAbove && aheadAbove.boundingBox === 'block');

    if (solidHead || (solidFeet && solidAbove)) {
      return { safe: false, shouldStepUp: false };
    }

    const hasSupport =
      solidFeet ||
      Boolean(aheadFloor0 && aheadFloor0.boundingBox === 'block') ||
      Boolean(aheadFloor1 && aheadFloor1.boundingBox === 'block');
    if (!hasSupport) {
      return { safe: false, shouldStepUp: false };
    }

    return {
      safe: true,
      shouldStepUp: solidFeet && !solidHead && !solidAbove && Boolean(this.bot.entity.onGround)
    };
  },

  _pickRoamTarget() {
    const pos = this.bot.entity.position;
    const anchor = this.spawnAnchorPos || pos;
    const botCfg = this.config.bot || {};
    const radius = botCfg.roamRadius !== undefined ? botCfg.roamRadius : 10;

    const dxFromAnchor = pos.x - anchor.x;
    const dzFromAnchor = pos.z - anchor.z;
    const distFromAnchor = Math.sqrt(dxFromAnchor * dxFromAnchor + dzFromAnchor * dzFromAnchor);

    if (distFromAnchor > radius * 0.8) {
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
      const r = this._randRange(2.5, Math.max(3.5, radius));
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
    const stepCheck = this._isRoamStepSafe(yawToDest);
    if (!stepCheck.safe) {
      this._stopSpawnRoam();
      this.roamPhase = 'PAUSED';
      this.roamPhaseUntil = now + this._randRange(500, 1200);
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
