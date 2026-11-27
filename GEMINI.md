# PvPBot Workspace Rules (`e:\server\plugin\pvpbot`)

CommonJS Mineflayer PvP bot (`node >= 18`, Windows PowerShell: use `npm.cmd test` and `;`, not `npm` or `&&`).

---

## 1. Project Map

### Layout & Entry Points
- `start.bat` — Windows interactive launcher (prompts host/user/version/password into `PVPBOT_*` env vars; do **not** enable `EnableDelayedExpansion` around password prompts).
- `package.json` — Dependencies & `npm.cmd test` smoke check (loads all 64 modules including `./index`).
- `config.json` — All runtime tunables (`server`, `bot`, `physics`, `prediction`, `combat`, `burst`, `cart`, `aerial`, `survival`, `ranged`, `looting`).
- `index.js` — Main 20-TPS `physicsTick` FSM coordinator (`IDLE`, `ENGAGING`, `RETREATING`, `HEALING`, `LOOTING`) composing `modules/controller/*` (`packet_sanitizer`, `arena_detector`, `spawn_roam`, `auth_proxy`, `duel_chat`, `commands`, `target_tracker`).
- **Shared Core Utilities**:
  - `modules/constants.js` — Shared slots/physics/priorities, `EFFECT_IDS`, version-safe `hasStatusEffect`/`getStatusEffectAmplifier`, single-pass `sampleBodyHazards`, `inspectColumnStep`, `isPositionSafe`/`isDirectionSafe`, WeakMap-cached metadata helpers.
  - `modules/enchant_utils.js` — WeakMap-cached MC 1.20.4–1.21.11+ `parseItemEnchantments`, `getEnchantmentLevel`, `getItemDurabilityInfo`, `getArmorBlastEPF`.
  - `modules/inventory_utils.js` — Per-bot WeakMap async equip lock, hotbar/inventory search, `isCrossbowCharged`, 1-tick-settled `ensureItemHeld`, `findNearestLiquidSource`.
  - `modules/pearl_ballistics.js` — Shared per-bot Ender Pearl cooldown/reserve, high-angle (+85°) & zero-G projectile trajectory solver, swept sub-step flight/entity landing predictor.
  - `modules/aim.js`, `modules/prediction.js`, `modules/placement_los.js`, `modules/mining.js`, `modules/mace_elytra.js`, `modules/liquid_deny.js`, `modules/red_wool_zone.js`.
- **Modular Skill & Kit Subsystems**:
  - `modules/combat.js` + `modules/combat/` (`weapon_tracker`, `movement_spacing`, `melee_techniques`) — Reactive strafe, cross-strafe-through, pre-emptive W/S-tap, knockback-verified Jump-Reset, early sprint-drop Crits, Anti-Crit Uppercut, DDA wall-LOS melee, facing-aware Shield-Break & Breach Swap.
  - `modules/survival.js` + `modules/survival/` (`constants`, `potion_classifier`, `auto_totem`, `shield_skill`, `potion_skill`, `food_mending`, `retreat_heal`, `armor_hotbar`) — Delayed AutoTotem + Double-Hand emergency totem, Axe-stun-aware Shield + `requestShield()`, velocity-lead splash pots, XP mending + spare armor swap, multi-kit armor/hotbar sorter.
  - `modules/ranged.js` + `modules/ranged/` (`bow_crossbow`, `ender_pearl_skill`, `close_utility`) — Predictive Bow/Crossbow/Zero-G Firework Rockets, shared-cooldown Pearls, 1-tick-settled predictive Cobweb & Lava traps.
  - `modules/escape.js` + `modules/escape/` (`water_bucket_helper`, `cobweb_escape`, `liquid_escape`, `block_escape`, `box_breakout`, `rail_stall_escape`, `hazard_unstick`) — Unified WaterBucketController, cobweb/fire/lava/obsidian-box/rail/TNT-cart escape.
  - `modules/burst.js` + `modules/burst/` (`shared`, `blast_calc`, `defense`, `cpvp_footwork`, `surround_city`, `hit_crystal`, `crystal_skill`, `anchor_skill`, `cpvp_mobility`) — Raycast + Resistance-aware blast calc, End Crystal, Respawn Anchor -> Crystal chain, Hit-Crystal, Surround/City, Anti-Blast defense.
  - `modules/cart.js` — Tournament Cart PvP (0 CPU when disabled).
  - `modules/aerial.js` + `modules/aerial/` (`constants`, `elytra_flight`, `mace_combos`, `spear_mace`, `elytra_mace`, `elytra_spear`, `pearl_catch`, `defense_clutch`) — Shared torso/takeoff flight engine, Stun Slam, Mace Launch, Spear-Mace, Elytra Mace Dive, Elytra Rocket Spear, Wind Burst Pearl Catch, multi-fallback fall clutch & Dive Dodge.

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
