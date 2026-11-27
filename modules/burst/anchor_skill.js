'use strict';

const { Vec3 } = require('vec3');
const { canSeeBlockFace } = require('../placement_los');
const { findFeetBlastShieldSpot } = require('./cpvp_footwork');
const {
  ANCHOR_POWER,
  posKey,
  isAirLike
} = require('./shared');

/**
 * Dedicated Respawn Anchor PvP Skill (`modules/burst/anchor_skill.js`):
 * Dimension guard, charge reading, failed-anchor blacklisting, mandatory non-glowstone swap,
 * feet blast-shielding, single-charge detonation, and instant Anchor -> Crystal chaining.
 */
const anchorSkillMethods = {
  _getAnchorCharges(block) {
    if (!block) return 0;
    if (typeof block.getProperties === 'function') {
      try {
        const props = block.getProperties();
        if (props && props.charges !== undefined) {
          const val = Number(props.charges);
          if (Number.isFinite(val)) return val;
        }
      } catch (_) {}
    }
    if (block._properties && block._properties.charges !== undefined) {
      const val = Number(block._properties.charges);
      if (Number.isFinite(val)) return val;
    }
    const meta = Number(block.metadata);
    return Number.isFinite(meta) && meta > 0 ? meta : 0;
  },

  _markFailedAnchor(pos, ttlMs = 5000) {
    if (!pos) return;
    const now = Date.now();
    this.failedAnchors.set(posKey(pos), now + ttlMs);
    for (const [k, exp] of this.failedAnchors.entries()) {
      if (exp <= now) this.failedAnchors.delete(k);
    }
  },

  _isFailedAnchor(pos) {
    if (!pos) return false;
    const key = posKey(pos);
    const exp = this.failedAnchors.get(key);
    if (!exp) return false;
    if (Date.now() > exp) {
      this.failedAnchors.delete(key);
      return false;
    }
    return true;
  },

  _findNonGlowstoneHotbarSlot() {
    if (!this.bot || !this.bot.inventory || !this.bot.inventory.slots) return -1;
    const start = this._getHotbarStart();

    for (let i = 0; i < 9; i++) {
      const item = this.bot.inventory.slots[start + i];
      if (item && item.name === 'totem_of_undying') return i;
    }

    if (this.combat && typeof this.combat.getHotbarSlots === 'function') {
      const slots = this.combat.getHotbarSlots();
      if (slots && typeof slots.swordSlot === 'number' && slots.swordSlot >= 0) {
        const item = this.bot.inventory.slots[start + slots.swordSlot];
        if (!item || (item.name !== 'glowstone' && item.name !== 'respawn_anchor')) {
          return slots.swordSlot;
        }
      }
    }
    for (let i = 0; i < 9; i++) {
      const item = this.bot.inventory.slots[start + i];
      if (item && item.name.endsWith('_sword')) return i;
    }

    for (let i = 0; i < 9; i++) {
      const item = this.bot.inventory.slots[start + i];
      if (item && item.name.endsWith('_axe')) return i;
    }

    for (let i = 0; i < 9; i++) {
      const item = this.bot.inventory.slots[start + i];
      if (!item) return i;
    }

    for (let i = 0; i < 9; i++) {
      const item = this.bot.inventory.slots[start + i];
      if (item && item.name === 'obsidian') return i;
    }
    for (let i = 0; i < 9; i++) {
      const item = this.bot.inventory.slots[start + i];
      if (!item || (item.name !== 'glowstone' && item.name !== 'respawn_anchor')) {
        return i;
      }
    }
    return -1;
  },

  _canUseRespawnAnchor() {
    if (this.burstCfg.anchorEnabled === false) return false;
    if (!this.bot || !this.bot.game || !this.bot.game.dimension) return false;
    const dim = String(this.bot.game.dimension).toLowerCase();
    return !dim.includes('nether');
  },

  _findBestAnchorPlacement(target, predictedFeet) {
    if (!this._canUseRespawnAnchor()) return null;
    const now = Date.now();
    const anchorCd = this.burstCfg.anchorCooldownMs !== undefined ? this.burstCfg.anchorCooldownMs : 120;
    if ((now - this.lastAnchorTime) < anchorCd) return null;

    const anchorItem = this._findItem('respawn_anchor');
    const glowstoneItem = this._findItem('glowstone');
    if (!this.bot || typeof this.bot.blockAt !== 'function') return null;

    const botPos = this.bot.entity.position;
    const maxAnchorRange = this.burstCfg.anchorMaxRange || 4.0;
    if (botPos.distanceTo(target.position) > maxAnchorRange) return null;

    const scanRadius = this.burstCfg.scanRadius || 4.5;
    const rInt = Math.ceil(scanRadius);
    const eyePos = this.aimer ? this.aimer.getEyePosition() : botPos.offset(0, 1.62, 0);
    const minSafeHp = this._isHoldingOffhandTotem() ? 4 : 6;

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
            if (!this._findVisibleBlockFace(anchorPos)) continue;
            needsPlace = false;
            alreadyCharged = this._getAnchorCharges(existing) >= 1;
            // Allow detonating already-charged field anchors even without glowstone/anchors!
            if (!alreadyCharged && !glowstoneItem) continue;
          } else if (isAirLike(existing) && anchorItem && glowstoneItem) {
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

  _tryChainCrystalAfterAnchor(target) {
    this.lastAnchorTime = Date.now();
    if (this.burstCfg.crystalEnabled !== false && this._findItem('end_crystal') && target && target.isValid) {
      const followCrystal = this._findBestCrystalPlacement(target, this._getPredictedTargetFeet(target, 1));
      if (followCrystal) {
        this.activePlan = followCrystal;
        this.stepDelayTicks = this.placeDelayTicks;
        this._enterState(
          followCrystal.coverSpot
            ? 'CRYSTAL_COVER'
            : (followCrystal.needsObsidian ? 'CRYSTAL_PLACE_OBSIDIAN' : 'CRYSTAL_PLACE_CRYSTAL')
        );
        return true;
      }
    }
    this._resetOffensiveState(true);
    return true;
  },

  _tickAnchorState(target = null) {
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
    if (
      target && target.isValid && target.position &&
      this.state !== 'ANCHOR_DETONATE' &&
      this.bot.entity.position.distanceTo(target.position) > 5.5
    ) {
      this._resetOffensiveState(true);
      return false;
    }

    // Maintain HT1 CPvP spacing & cover footwork; never hold sneak while placing/charging/detonating anchors
    this._applyCpvpFootwork(target, plan.blastPos, plan.coverSpot ? plan.coverSpot.placePos : null);

    // Step 0: Feet Blast-Shield Cover Placement before Anchor combo
    if (this.state === 'ANCHOR_COVER') {
      const nextState = plan.needsPlace
        ? 'ANCHOR_PLACE'
        : (plan.alreadyCharged ? 'ANCHOR_SWITCH_SLOT' : 'ANCHOR_CHARGE');
      const cover = plan.coverSpot;
      if (!cover || plan.coverPlaced) {
        this._enterState(nextState);
        return true;
      }

      const aimStatus = this.aimer.stepTowardsPoint(cover.aimPos, {
        speedMultiplier: 2.0,
        toleranceRad: 0.2
      });
      const equipRes = this._ensureItemHeld(cover.blockRecord);
      if (!equipRes.found) {
        this._enterState(nextState);
        return true;
      }
      if (this.stepDelayTicks > 0 || equipRes.swappedThisTick || !equipRes.held || !aimStatus.aligned) {
        return true;
      }

      const refBlock = this.bot.blockAt(cover.refPos);
      if (
        refBlock &&
        refBlock.boundingBox === 'block' &&
        isAirLike(this.bot.blockAt(cover.placePos)) &&
        canSeeBlockFace(this.bot, refBlock.position, cover.face, { aimer: this.aimer })
      ) {
        this._markOwnPlacement(cover.placePos);
        if (typeof this.bot.placeBlock === 'function') {
          Promise.resolve(this.bot.placeBlock(refBlock, cover.face)).catch(() => {});
        }
      }
      plan.coverPlaced = true;
      this.stepDelayTicks = this.placeDelayTicks;
      this._enterState(nextState);
      return true;
    }

    // Step 1: Place Respawn Anchor
    if (this.state === 'ANCHOR_PLACE') {
      const existing = this.bot.blockAt(plan.anchorPos);
      if (existing && existing.name === 'respawn_anchor') {
        this._enterState(this._getAnchorCharges(existing) >= 1 ? 'ANCHOR_SWITCH_SLOT' : 'ANCHOR_CHARGE');
        return true;
      }

      const anchorItem = this._findItem('respawn_anchor');
      if (!anchorItem || !plan.anchorRef) {
        this._resetOffensiveState(true);
        return false;
      }

      const aimStatus = this.aimer.stepTowardsPoint(plan.anchorRef.aimPos, {
        speedMultiplier: 2.0,
        toleranceRad: 0.2
      });
      const equipRes = this._ensureItemHeld(anchorItem);
      if (this.stepDelayTicks > 0 || equipRes.swappedThisTick || !equipRes.held || !aimStatus.aligned) {
        return true;
      }

      const refBlock = this.bot.blockAt(plan.anchorRef.refPos);
      if (
        !refBlock ||
        refBlock.boundingBox !== 'block' ||
        !canSeeBlockFace(this.bot, refBlock.position, plan.anchorRef.face, { aimer: this.aimer })
      ) {
        this._resetOffensiveState(true);
        return false;
      }

      this._markOwnPlacement(plan.anchorPos);
      if (typeof this.bot.placeBlock === 'function') {
        Promise.resolve(this.bot.placeBlock(refBlock, plan.anchorRef.face)).catch(() => {});
      }

      this.stepDelayTicks = this.placeDelayTicks;
      this._enterState('ANCHOR_CHARGE');
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
        this.stepDelayTicks = this.placeDelayTicks;
        this._enterState('ANCHOR_SWITCH_SLOT');
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
      if (!face) {
        this._resetOffensiveState(true);
        return false;
      }
      const faceAim = plan.anchorPos.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5);
      const aimStatus = this.aimer.stepTowardsPoint(faceAim, {
        speedMultiplier: 2.0,
        toleranceRad: 0.2
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
          });
      } else {
        plan.chargeInFlight = false;
        plan.chargeAttempted = true;
      }

      const updatedBlock = this.bot.blockAt(plan.anchorPos);
      if (updatedBlock && updatedBlock.name === 'respawn_anchor' && this._getAnchorCharges(updatedBlock) >= 1) {
        plan.chargeInFlight = false;
        plan.chargeAttempted = true;
        this.stepDelayTicks = this.placeDelayTicks;
        this._enterState('ANCHOR_SWITCH_SLOT');
      }
      return true;
    }

    // Step 3: Mandatory Hotbar Swap to non-glowstone slot (Totem, Sword, Axe, Empty) before detonating
    if (this.state === 'ANCHOR_SWITCH_SLOT') {
      const face = this._findVisibleBlockFace(plan.anchorPos);
      if (!face) {
        this._resetOffensiveState(true);
        return false;
      }
      const faceAim = plan.anchorPos.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5);
      this.aimer.stepTowardsPoint(faceAim, { speedMultiplier: 1.5, toleranceRad: 0.18 });
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

      this._enterState('ANCHOR_DETONATE');
      return true;
    }

    // Step 4: Detonate Respawn Anchor on the following tick + HT1 Anchor -> Crystal Chain!
    if (this.state === 'ANCHOR_DETONATE') {
      const anchorBlock = this.bot.blockAt(plan.anchorPos);
      if (!anchorBlock || anchorBlock.name !== 'respawn_anchor') {
        if (plan.detonateAttempted || plan.detonateInFlight) {
          // Real server confirmed detonation on next tick -> chain straight into Crystal follow-up!
          return this._tryChainCrystalAfterAnchor(target);
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
      if (!face) {
        this._resetOffensiveState(true);
        return false;
      }
      const faceAim = plan.anchorPos.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5);
      const aimStatus = this.aimer.stepTowardsPoint(faceAim, {
        speedMultiplier: 2.0,
        toleranceRad: 0.22
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

      const afterBlock = this.bot.blockAt(plan.anchorPos);
      if (!afterBlock || afterBlock.name !== 'respawn_anchor') {
        return this._tryChainCrystalAfterAnchor(target);
      }
      return true;
    }

    return false;
  }
};

module.exports = { anchorSkillMethods };
