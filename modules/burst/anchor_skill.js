'use strict';

const { Vec3 } = require('vec3');
const { findFeetBlastShieldSpot } = require('../cpvp_tactics');
const {
  ANCHOR_POWER,
  COVER_BLOCK_PRIORITY,
  isAirLike
} = require('./shared');

const anchorSkillMethods = {
  _canUseRespawnAnchor() {
    if (this.burstCfg.anchorEnabled === false) return false;
    if (!this.bot || !this.bot.game || !this.bot.game.dimension) return false;
    const dim = String(this.bot.game.dimension).toLowerCase();
    return !dim.includes('nether');
  },

  _findOptionalCoverSpot(blastPos) {
    if (!this.bot || !this.bot.entity || typeof this.bot.blockAt !== 'function') return null;
    const botPos = this.bot.entity.position;
    // Only need a cover block if bot is NOT at lower Y than blast
    if (botPos.y < blastPos.y - 0.25) return null;

    const coverRecord = this._findItem(COVER_BLOCK_PRIORITY);
    if (!coverRecord) return null;

    const toBlast = blastPos.minus(botPos);
    const horizLen = Math.sqrt(toBlast.x * toBlast.x + toBlast.z * toBlast.z);
    if (horizLen < 1.2) return null;

    const coverPos = new Vec3(
      Math.floor(botPos.x + (toBlast.x / horizLen) * 1.0),
      Math.floor(botPos.y),
      Math.floor(botPos.z + (toBlast.z / horizLen) * 1.0)
    );

    if (this._intersectsEntityHitbox(coverPos, botPos)) return null;
    if (!isAirLike(this.bot.blockAt(coverPos))) return null;

    const eyePos = this.aimer ? this.aimer.getEyePosition() : botPos.offset(0, 1.62, 0);
    if (eyePos.distanceTo(coverPos.offset(0.5, 0.5, 0.5)) > 4.5) return null;

    const ref = this._findPlacementRef(coverPos);
    if (!ref) return null;

    return {
      blockRecord: coverRecord,
      placePos: coverPos,
      refPos: ref.refPos,
      face: ref.face,
      aimPos: ref.aimPos
    };
  },

  _findBestAnchorPlacement(target, predictedFeet) {
    if (!this._canUseRespawnAnchor()) return null;
    const now = Date.now();
    if ((now - this.lastAnchorTime) < (this.burstCfg.anchorCooldownMs || 250)) return null;

    const anchorItem = this._findItem('respawn_anchor');
    const glowstoneItem = this._findItem('glowstone');
    if (!anchorItem || !glowstoneItem) return null;
    if (!this.bot || typeof this.bot.blockAt !== 'function') return null;

    const botPos = this.bot.entity.position;
    const maxAnchorRange = this.burstCfg.anchorMaxRange || 3.6;
    if (botPos.distanceTo(target.position) > maxAnchorRange) return null;

    const scanRadius = this.burstCfg.scanRadius || 4.5;
    const rInt = Math.ceil(scanRadius);
    const eyePos = this.aimer ? this.aimer.getEyePosition() : botPos.offset(0, 1.62, 0);
    const minSafeHp = 6;

    const cx = Math.floor(predictedFeet.x);
    const cy = Math.floor(predictedFeet.y);
    const cz = Math.floor(predictedFeet.z);

    let best = null;

    for (let dx = -rInt; dx <= rInt; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -rInt; dz <= rInt; dz++) {
          const anchorPos = new Vec3(cx + dx, cy + dy, cz + dz);
          const blastPos = anchorPos.offset(0.5, 0.5, 0.5);

          if (blastPos.distanceTo(predictedFeet) > scanRadius) continue;
          if (eyePos.distanceTo(blastPos) > 4.5) continue;
          if (this._isFailedAnchor(anchorPos)) continue;

          const existing = this.bot.blockAt(anchorPos);
          if (!existing) continue;

          let needsPlace = false;
          let anchorRef = null;
          let alreadyCharged = false;

          if (existing.name === 'respawn_anchor') {
            needsPlace = false;
            alreadyCharged = this._getAnchorCharges(existing) >= 1;
          } else if (isAirLike(existing)) {
            if (this._intersectsEntityHitbox(anchorPos, botPos)) continue;
            if (this._intersectsEntityHitbox(anchorPos, target.position, target.height || 1.8)) continue;
            anchorRef = this._findPlacementRef(anchorPos);
            if (!anchorRef) continue;
            needsPlace = true;
          } else {
            continue;
          }

          const targetDmg = this.estimateBlastDamage(blastPos, predictedFeet, target, ANCHOR_POWER);
          if (targetDmg < 4.0) continue;

          const rawSelfDmg = this.estimateBlastDamage(blastPos, botPos, this.bot.entity, ANCHOR_POWER);
          const feetShield = findFeetBlastShieldSpot(this, blastPos, anchorPos);
          const coverSpot = feetShield.spot;
          if (feetShield.needed && !coverSpot && rawSelfDmg > 4.0) continue;

          const effectiveSelfDmg = coverSpot
            ? this.estimateBlastDamage(blastPos, botPos, this.bot.entity, ANCHOR_POWER, coverSpot.placePos)
            : rawSelfDmg;

          if (targetDmg <= effectiveSelfDmg) continue;
          if ((this.bot.health - effectiveSelfDmg) <= minSafeHp) continue;

          const score = targetDmg - effectiveSelfDmg * 1.35 - (needsPlace ? 0.5 : 0);
          if (!best || score > best.score) {
            best = {
              kind: 'anchor',
              score,
              targetDmg,
              selfDmg: effectiveSelfDmg,
              anchorPos,
              blastPos,
              needsPlace,
              alreadyCharged,
              anchorRef,
              coverSpot
            };
          }
        }
      }
    }

    return best;
  },

  _tickAnchorState() {
    if (!this._canUseRespawnAnchor()) {
      this._resetOffensiveState(true);
      return false;
    }

    const plan = this.activePlan;
    if (!plan) {
      this._resetOffensiveState(true);
      return false;
    }

    this.stateTicks++;
    if (this.stateTicks > 40) {
      this._resetOffensiveState(true);
      return false;
    }

    this.bot.setControlState('sprint', false);
    if (typeof this.bot.setControlState === 'function') {
      this.bot.setControlState('sneak', false);
    }
    const anchorAim = plan.anchorPos.offset(0.5, 0.5, 0.5);

    // Step 0: Feet Blast-Shield Cover Placement before Anchor combo
    if (this.state === 'ANCHOR_COVER') {
      const nextState = plan.needsPlace
        ? 'ANCHOR_PLACE'
        : (plan.alreadyCharged ? 'ANCHOR_SWITCH_SLOT' : 'ANCHOR_CHARGE');
      const cover = plan.coverSpot;
      if (!cover || plan.coverPlaced) {
        this.state = nextState;
        return true;
      }

      const aimStatus = this.aimer.stepTowardsPoint(cover.aimPos, {
        speedMultiplier: 1.35,
        toleranceRad: 0.18
      });
      const equipRes = this._ensureItemHeld(cover.blockRecord);
      if (!equipRes.found) {
        this.state = nextState;
        return true;
      }
      if (this.stepDelayTicks > 0 || equipRes.swappedThisTick || !equipRes.held || !aimStatus.aligned) {
        return true;
      }

      const refBlock = this.bot.blockAt(cover.refPos);
      if (refBlock && refBlock.boundingBox === 'block' && isAirLike(this.bot.blockAt(cover.placePos))) {
        this._markOwnPlacement(cover.placePos);
        if (typeof this.bot.placeBlock === 'function') {
          Promise.resolve(this.bot.placeBlock(refBlock, cover.face)).catch(() => {});
        }
      }
      plan.coverPlaced = true;
      this.stepDelayTicks = this.placeDelayTicks;
      this.state = nextState;
      return true;
    }

    // Step 1: Place Respawn Anchor
    if (this.state === 'ANCHOR_PLACE') {
      const existing = this.bot.blockAt(plan.anchorPos);
      if (existing && existing.name === 'respawn_anchor') {
        this.state = this._getAnchorCharges(existing) >= 1 ? 'ANCHOR_SWITCH_SLOT' : 'ANCHOR_CHARGE';
        return true;
      }

      const anchorItem = this._findItem('respawn_anchor');
      if (!anchorItem || !plan.anchorRef) {
        this._resetOffensiveState(true);
        return false;
      }

      const aimStatus = this.aimer.stepTowardsPoint(plan.anchorRef.aimPos, {
        speedMultiplier: 1.35,
        toleranceRad: 0.16
      });
      const equipRes = this._ensureItemHeld(anchorItem);
      if (this.stepDelayTicks > 0 || equipRes.swappedThisTick || !equipRes.held || !aimStatus.aligned) {
        return true;
      }

      const refBlock = this.bot.blockAt(plan.anchorRef.refPos);
      if (!refBlock || refBlock.boundingBox !== 'block') {
        this._resetOffensiveState(true);
        return false;
      }

      this._markOwnPlacement(plan.anchorPos);
      if (typeof this.bot.placeBlock === 'function') {
        Promise.resolve(this.bot.placeBlock(refBlock, plan.anchorRef.face)).catch(() => {});
      }

      this.stepDelayTicks = this.placeDelayTicks;
      this.state = 'ANCHOR_CHARGE';
      return true;
    }

    // Step 2: Single-Charge Efficiency — Charge Respawn Anchor with exactly 1 Glowstone block
    if (this.state === 'ANCHOR_CHARGE') {
      const anchorBlock = this.bot.blockAt(plan.anchorPos);
      if (!anchorBlock || anchorBlock.name !== 'respawn_anchor') {
        if (this.stateTicks < 10) return true;
        this._resetOffensiveState(true);
        return false;
      }

      if (this._getAnchorCharges(anchorBlock) >= 1) {
        plan.chargeInFlight = false;
        plan.charged = true;
        this.stepDelayTicks = this.placeDelayTicks;
        this.state = 'ANCHOR_SWITCH_SLOT';
        return true;
      }

      if (plan.chargeInFlight) {
        return true;
      }

      if (plan.chargeAttempted) {
        plan.chargeWaitTicks = (plan.chargeWaitTicks || 0) + 1;
        if (plan.chargeWaitTicks < 3) {
          return true;
        }
        if ((plan.chargeRetries || 0) < 1) {
          plan.chargeRetries = (plan.chargeRetries || 0) + 1;
          plan.chargeAttempted = false;
          plan.charged = false;
          plan.chargeWaitTicks = 0;
        } else {
          this._markFailedAnchor(plan.anchorPos, 5000);
          this._resetOffensiveState(true);
          return false;
        }
      }

      const glowstoneItem = this._findItem('glowstone');
      if (!glowstoneItem) {
        this._resetOffensiveState(true);
        return false;
      }

      const face = this._findVisibleBlockFace(plan.anchorPos);
      const faceAim = plan.anchorPos.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5);
      const aimStatus = this.aimer.stepTowardsPoint(faceAim, {
        speedMultiplier: 1.35,
        toleranceRad: 0.16
      });
      const equipRes = this._ensureItemHeld(glowstoneItem);
      if (this.stepDelayTicks > 0 || equipRes.swappedThisTick || !equipRes.held || !aimStatus.aligned) {
        return true;
      }

      plan.chargeInFlight = true;
      plan.chargeWaitTicks = 0;
      if (typeof this.bot.activateBlock === 'function') {
        Promise.resolve(this.bot.activateBlock(anchorBlock, face))
          .catch(() => {})
          .finally(() => {
            plan.chargeInFlight = false;
            plan.chargeAttempted = true;
            plan.charged = true;
          });
      } else {
        plan.chargeInFlight = false;
        plan.chargeAttempted = true;
        plan.charged = true;
      }

      // If synchronous mock already charged the block, advance on next tick cleanly
      const updatedBlock = this.bot.blockAt(plan.anchorPos);
      if (updatedBlock && updatedBlock.name === 'respawn_anchor' && this._getAnchorCharges(updatedBlock) >= 1) {
        plan.chargeInFlight = false;
        plan.chargeAttempted = true;
        plan.charged = true;
        this.stepDelayTicks = this.placeDelayTicks;
        this.state = 'ANCHOR_SWITCH_SLOT';
      }
      return true;
    }

    // Step 3: Mandatory Hotbar Swap to non-glowstone slot (Totem, Sword, Axe, Empty) before detonating
    if (this.state === 'ANCHOR_SWITCH_SLOT') {
      const face = this._findVisibleBlockFace(plan.anchorPos);
      const faceAim = plan.anchorPos.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5);
      this.aimer.stepTowardsPoint(faceAim, { speedMultiplier: 1.35, toleranceRad: 0.16 });
      if (this.stepDelayTicks > 0) return true;

      const heldName = this.bot.heldItem ? this.bot.heldItem.name : '';
      if (heldName === 'glowstone' || heldName === 'respawn_anchor') {
        const safeSlot = this._findNonGlowstoneHotbarSlot();
        if (safeSlot < 0) {
          this._resetOffensiveState(true);
          return false;
        }
        if (typeof this.bot.setQuickBarSlot === 'function') {
          this.bot.setQuickBarSlot(safeSlot);
        }
        this.stepDelayTicks = Math.max(1, this.placeDelayTicks);
      }

      this.state = 'ANCHOR_DETONATE';
      return true;
    }

    // Step 4: Detonate Respawn Anchor on the following tick (activateBlock with non-glowstone slot)
    if (this.state === 'ANCHOR_DETONATE') {
      const anchorBlock = this.bot.blockAt(plan.anchorPos);
      if (!anchorBlock || anchorBlock.name !== 'respawn_anchor') {
        if (plan.detonateAttempted || plan.detonateInFlight) {
          this.lastAnchorTime = Date.now();
          this._resetOffensiveState(true);
          return true;
        }
        this._resetOffensiveState(true);
        return false;
      }

      if (plan.detonateInFlight) {
        return true;
      }

      if (plan.detonateAttempted) {
        plan.detonateWaitTicks = (plan.detonateWaitTicks || 0) + 1;
        if (plan.detonateWaitTicks < 3) {
          return true;
        }
        if ((plan.detonateRetries || 0) < 1) {
          plan.detonateRetries = (plan.detonateRetries || 0) + 1;
          plan.detonateAttempted = false;
          plan.detonateWaitTicks = 0;
        } else {
          this._markFailedAnchor(plan.anchorPos, 5000);
          this.lastAnchorTime = Date.now();
          this._resetOffensiveState(true);
          return false;
        }
      }

      // Safety check: ensure we are NOT holding glowstone
      if (this.bot.heldItem && this.bot.heldItem.name === 'glowstone') {
        const safeSlot = this._findNonGlowstoneHotbarSlot();
        if (safeSlot >= 0 && typeof this.bot.setQuickBarSlot === 'function') {
          this.bot.setQuickBarSlot(safeSlot);
          this.stepDelayTicks = Math.max(1, this.placeDelayTicks);
          return true;
        }
        this._resetOffensiveState(true);
        return false;
      }

      const face = this._findVisibleBlockFace(plan.anchorPos);
      const faceAim = plan.anchorPos.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5);
      const aimStatus = this.aimer.stepTowardsPoint(faceAim, {
        speedMultiplier: 1.4,
        toleranceRad: 0.18
      });

      if (this.stepDelayTicks > 0 || !aimStatus.aligned) {
        return true;
      }

      plan.detonateInFlight = true;
      plan.detonateWaitTicks = 0;
      if (typeof this.bot.activateBlock === 'function') {
        Promise.resolve(this.bot.activateBlock(anchorBlock, face))
          .catch(() => {})
          .finally(() => {
            plan.detonateInFlight = false;
            plan.detonateAttempted = true;
          });
      } else {
        plan.detonateInFlight = false;
        plan.detonateAttempted = true;
      }

      // If synchronous mock already popped the anchor, finish cleanly
      const afterBlock = this.bot.blockAt(plan.anchorPos);
      if (!afterBlock || afterBlock.name !== 'respawn_anchor') {
        this.lastAnchorTime = Date.now();
        this._resetOffensiveState(true);
      }
      return true;
    }

    return false;
  }
};

module.exports = { anchorSkillMethods };
