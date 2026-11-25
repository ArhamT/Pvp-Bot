# PvPBot Workspace Rules (`e:\server\plugin\pvpbot`)

CommonJS Mineflayer PvP bot (`node >= 18`, Windows PowerShell: use `npm.cmd test` and `;`, not `npm` or `&&`).

---

## 1. Project Map

### Layout & Entry Points
- `start.bat` — Windows interactive launcher (prompts host/user/version/password into `PVPBOT_*` env vars; do **not** enable `EnableDelayedExpansion` around password prompts).
- `package.json` — Dependencies & `npm.cmd test` smoke check (loads all 7 modules).
- `config.json` — All runtime tunables (`server`, `bot`, `physics`, `prediction`, `combat`, `burst`, `aerial`, `survival`, `ranged`, `looting`).
- `index.js` (~1,973 lines) — Main entry point & 20-TPS `physicsTick` FSM (`IDLE`, `ENGAGING`, `RETREATING`, `HEALING`, `LOOTING`), auth, proxy auto-join/rejoin, duel auto-accept, ads, spawn roam, console commands.
- `modules/aim.js` (181 lines) — `SmoothAimer` clamped exponential look smoothing & `normalizeAngle`.
- `modules/prediction.js` (265 lines) — 5-tick rolling trajectory predictor (MC air/ground drag & gravity).
- `modules/combat.js` (~1,546 lines) — Melee spacing, strafing, W/S-tap, jump-reset, hit-select, breach swap, standalone spear.
- `modules/survival.js` (~2,311 lines) — Delayed AutoTotem, smart shield, splash/drinkable potions (MC 1.20.4–1.21.4+), XP mending, gapples, armor/hotbar sort.
- `modules/ranged.js` (~1,542 lines) — Predictive bow/crossbow, necessary-only Ender Pearls, hazard raycasting, cobweb water clutch.
- `modules/burst.js` (~2,124 lines) — End Crystal, Respawn Anchor, blast-damage estimator, anti-explosive defense, Wind Charge.
- `modules/aerial.js` (~2,873 lines) — Fall tracking, Stun Slam, Mace Launch, Wind Burst Pearl Catch, Spear-Mace, Elytra Mace Dive, Elytra Rocket Spear, fall clutch.

### Key Section Ranges (Files > 300 Lines)
- **`index.js`**
  - `L1–L165`: Imports, regexes (`DUEL_REQUEST_REGEX`, `DUEL_START_CUE_REGEX`), `loadRuntimeConfig`, `PvPBotController` constructor.
  - `L170–L395`: `start()`, packet monitor, `_bindEvents()` (`spawn`, `entityHurt`, `health`, `messagestr`, `death`, `respawn`, `end`).
  - `L400–L775`: Auth (`/login`, `/register`), proxy `/server duels` auto-join & kick rejoin, duel auto-accept, duel start/end chat triggers.
  - `L775–L1200`: Chat/console commands (`executeBotCommand`, `handleConsoleInput`), target resolution, `_tryAutoRetaliate`.
  - `L1200–L1445`: `transitionState`, tick loop, `_clearTimers`, duel ads (`_scheduleAdvertise`, `_sendAdvertise`), reconnect, `_tick()`.
  - `L1450–L1705`: `_tickIdle()` & casual spawn roaming (`_tickSpawnRoam`, `_isRoamStepSafe`, `_pickRoamTarget`).
  - `L1708–L1973`: `_tickEngaging`, `_tickRetreating`, `_tickHealing`, `_tickLooting`, `shutdown`.
- **`modules/combat.js`**
  - `L45–L170`: Constructor & event listeners.
  - `L173–L480`: Hotbar/enchant scanner (`scanHotbarSlots`, `getHotbarSlots`, `isTargetHeavilyArmored`).
  - `L482–L635`: Strafe timers, Hit-Select (`_handleEntitySwingArm`), W-tap/Jump-Reset (`_handleEntityHurt`).
  - `L638–L1005`: Weapon selection, cooldowns, reach geometry, hazard/wall checks, `stopMovement`.
  - `L1008–L1546`: `tick()`, `_updateWeaponForTarget`, spacing/strafe, `_updateAttackAndCrits`.
- **`modules/survival.js`**
  - `L1–L200`: Constants (`VANILLA_POTION_ID_TO_KEY` 0–45, effect ID tables, armor/food priorities).
  - `L202–L660`: Constructor, delayed AutoTotem (`ensureTotemPriority`, `ensureOffhandSafety`), retreat/heal thresholds.
  - `L660–L1145`: Potion metadata & `_classifyPotion`, drinkable heal lookup, armor durability & `tickArmorXpMend`.
  - `L1149–L1515`: Effect listeners (`entityEffect`), `findNeededBuffPotion`, `tickInlineCombatHeal`, `_equipSingleForConsume`, `_startDrinkingPotion`.
  - `L1520–L1945`: Food lookup, `tickShield`, `_tickSplashPotionDownward`, `_startEatingFood`, LOS block placement.
  - `L1950–L2311`: `tickRetreating`, `tickHealing`, `equipBestArmor`, `sortHotbar`, `autoEquipAndSort`.
- **`modules/ranged.js`**
  - `L36–L165`: Constructor, combo-hit tracker, `isBusy`/`cancel`.
  - `L166–L329`: Predictive bow/crossbow ballistics.
  - `L330–L957`: Necessary-only Ender Pearl system (`tryChasePearl`, `tryAgroCancelPearl`, `tryDefensivePearl`, landing/arc safety).
  - `L958–L1170`: Arena/hazard awareness & 1-tick Water Bucket `tickCobwebEscape`.
  - `L1171–L1542`: Close utility (`tryCloseUtility`), `tick()`, 1-tick settled `_tickPendingAction`, `_tickBowOrCrossbow`.
- **`modules/burst.js`**
  - `L106–L338`: Constructor & own-placement / entitySpawn tracking.
  - `L339–L790`: Raycast-occluded blast damage estimator & sequential hotbar helpers.
  - `L791–L1087`: Anti-Crystal / Anti-Anchor defense (`tickDefense`).
  - `L1088–L1692`: End Crystal (`_tickCrystalState`) & Respawn Anchor (`_tickAnchorState`).
  - `L1693–L2124`: Wind Charge launch/clutch (`_tickWindChargeState`, `_tickWindClutch`) & `tick()`.
- **`modules/aerial.js`**
  - `L62–L404`: Constructor, pearl-landing predictor, `cancel`/`_resetState`.
  - `L405–L942`: Fall distance, version-safe `_sendStartElytraFlying`, inventory/armor/aim helpers.
  - `L943–L1566`: Main `tick()`, Wind Burst Pearl Catch (`_tickPearlCatch`), Mace Launch (`_tickMaceLaunch`).
  - `L1567–L1908`: Stun Slam (`_tickStunSlam`) & Spear-to-Mace chain (`_tickSpearMace`).
  - `L1909–L2304`: Elytra Mace Dive (`_tickElytraDive`, `_tickElytraTakeoff`).
  - `L2305–L2769`: Elytra Rocket Spear mode (`_canStartElytraSpear`, `_tickElytraSpear`).
  - `L2770–L2873`: Fall-damage clutch (`_tickClutch`).

---

## 2. Token & Context Rules

- **Search first, read minimally**: Never scan large files in multiple exploratory line-range chunks. Use grep/symbol search (`Select-String` or `rg`) first to locate exact definitions, then read only the minimal ~80–120 lines needed. Check shared state/hooks only when directly referenced.
- **Right-sized reasoning**: Keep reasoning concise and direct for routine edits; reserve deep reasoning for multi-file bugs, protocol issues, or architecture changes.
- **Hard read exclusions**: Never read `node_modules/`, `package-lock.json`, build outputs, or large data/log dumps.
- **Modular growth**: Keep new files focused (~150–300 lines); place new features in separate files under `modules/` instead of growing existing monolithic files.

---

## 3. Core Bot Invariants (Quick Reference)

- **Packet & anti-cheat safety**: Route all rotations through `SmoothAimer` (`bot.look(..., false)`). Never swap hotbar slot and attack/use an item on the same tick (wait >= 1 tick). Never call `deactivateItem()` on instant throwables (`splash_potion`, `ender_pearl`, `wind_charge`, `experience_bottle`, `firework_rocket`). Keep `IDLE` lobbies packet-quiet (no inventory clicks, no sprint, roam looks <= 10 Hz).
- **Verify edits**: Run `node --check <edited files>` and `npm.cmd test` after changes.
