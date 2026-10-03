# tpm-consumer-install — how the installer, the doctor and the session-start health note work

**Subject:** `tools/consumer/tpm-consumer-install.js` (`tpm install`), `tpm-consumer-doctor.js` (`tpm doctor`),
`tpm-consumer-observe.js` (the shared observer), `tpm-consumer-voice.js` (every user-facing string), and the light
health check in `tools/hooks/tpm-hooks-session-start.js`. Uninstall (`tpm-consumer-uninstall.js`) reads the same
observer.

**Audience:** someone who maintains these files. The user-facing walkthrough is `docs/INSTALL.md`. Design rationale,
the probe evidence behind it and the decisions log are in the claude-tpm-dev workspace
(`dev/20261001-installer-updates/installer-design.md`, `installer-repl-voice.md`); this doc describes what the
shipped code does and points there for why. Code is cited by function name. Every behaviour listed in the scenario
table (§7) is pinned by a test named `row N` in `tools/consumer/tests/tpm-consumer-install/test.js`.

---

## 0. The mental model

`tpm install` makes a project look the way it should. It does not run a fixed list of steps. It **looks** at the
machine and the project, works out the difference from the target, shows that difference as a plan, asks once, and
applies it. Because it always looks first and every action is idempotent, a re-run on a half-finished install plans
exactly what is left, and a healthy project plans nothing.

Two facts about Claude Code shape everything (probe evidence in the dev workspace):

- A plugin registered from a local folder **runs in place from that folder**. The copy Claude Code makes in its
  plugin cache is never what runs. If the registered folder moves or is deleted, the plugin is dead in every project
  on that version, with a misleading `cache-miss` error. So *which folder gets registered* is the most consequential
  thing the installer decides.
- The marketplace row is **machine-wide**, one per version (`claude-tpm-market-<version>`); the plugin install
  record and enablement are **per project**. Re-pointing a row, or removing it, affects every project on that version.

Words the code and messages use:

| Word | Meaning |
|---|---|
| **canonical** | The one folder every layer must agree on: what is registered, what the dependency links to. |
| **layer** | One of the five things observed (§2). |
| **row** | The marketplace registration for this version. Printed to users as "registered". |
| **stamp** | The rule that the marketplace name equals `claude-tpm-market-<package version>`. A mismatch is a packaging bug in claude-tpm, reported as such, never blamed on the project. |
| **standalone / this-project-copy / other-project-copy** | Where a claude-tpm folder lives: on its own, inside this project's `node_modules`, or inside another project's. |

---

## 1. The ways in

| You type | Reaches |
|---|---|
| `npx tpm install [dir] …` / `tpm install …` | `tools/tpm.js` alias → `tpm-consumer-install.js` |
| `npx tpm plugin install …` | `tools/plugin/tpm-plugin-router.js` → the same script |
| `npx tpm doctor [dir] [--verbose]` / `tpm plugin doctor` | alias / router → `tpm-consumer-doctor.js` |
| `npx tpm install [dir] --check` | `install`'s `main()` delegates to the doctor's `runDoctor` (compatibility alias; install and doctor `require` each other, so `main()` yields one tick first) |
| `npx tpm uninstall [dir] …` | `tpm-consumer-uninstall.js` |
| a Claude session starting | `hooks/hooks.json` → `tools/tpm.js hooks session-start` → the light health check (§9) |

The scripts are runnable as `node tools/consumer/tpm-consumer-install.js …` and are modules (`module.exports`) so
tests drive `diagnose` / `plan` / `apply` directly. Zero runtime dependencies.

---

## 2. Observe — the five layers (`tpm-consumer-observe.js`)

`observe(targetDir, self, env, opts) → State` is pure: it reads files, runs at most four memoised probes (`claude
--version`, `claude plugin marketplace list --json`, `claude plugin list --json`, `npm --version`), and writes
nothing. It never throws; a missing or malformed input is recorded in `state.invalid[]`. `reobserveLayer(state,
layer)` re-reads one layer after an action touched it, running only that layer's probe.

| Layer | Written by | Read from | Notable fields |
|---|---|---|---|
| 1 `dep` | npm | `package.json` buckets, `node_modules/@codercowboy/claude-tpm` | `declared`, `onDisk` (absent / link / dangling / copy), `linksTo`, `version`, `mode` |
| 2 `reg` | `claude plugin marketplace` | `marketplace list --json` | `state` (absent / same / same-via-link / elsewhere / github / dead / unknown), `where` (standalone / this-project-copy / other-project-copy / github), `realPath`, `version`, `complete`, `live` |
| 3 `en` | `claude plugin install/enable/disable` | `plugin list --json` + both settings files | `record` (present / enabled / installPath), `enabledHere`, `otherIds`, `loadsWithoutRecord` |
| 4 `marker` | the installer | `.claude/claude-tpm/` | `dir`, `config` (absent / valid / invalid) |
| 5 `self` | — | the installer's own folder | `root`, `shape`, `version`, `name`, `stampOk`, `complete` (has `hooks/hooks.json` with both hooks) |

Plus `env` (claude / npm on PATH, in-session flag, `tpm` on PATH, `TPM_HOME`), `canonical`, and `projectVersion`.
`observe(…, {probes:false})` is the file-only **light** mode used by the hook: no process is spawned; layer 2 and the
plugin record are `unknown` (layer 2 is filled from `CLAUDE_PLUGIN_ROOT` when set).

`preconditions(state, {quiet, stdinIsTTY})` returns the first refusal that applies, in this order: `npm` or
`claude` will not run · no or invalid `package.json` · stamp mismatch · `other-project-copy` (or no `self`) ·
incomplete folder · stdin is not a terminal and no `--quiet`. The words come from the voice module; each ends with
`Nothing was changed.` and exits 1. The tool checks are skipped in light mode.

---

## 3. Diagnose and decide

`diagnose(state)` picks one label, first match wins, and lists the ⚠/✗ findings that justify it:

| Label | When |
|---|---|
| `registered-elsewhere` | the row is live and resolves somewhere other than this folder (and the project is not already set up to use it) |
| `not-installed` | no registration of ours and nothing in the project |
| `upgrade` | another `claude-tpm@*` id is on, or the project's dependency is a different version |
| `broken` | a ✗ in layers 1–4 for our version |
| `partial` | some layers at target, none ✗ |
| `healthy` | every layer at target, no ⚠: prints one line, exit 0 |
| `healthy-with-warnings` | at target, ⚠ only (a row stored through a link, or a project set up to use another folder's registration) |

`decide` runs **only** for `registered-elsewhere`, and is the only question the installer ever asks besides
`Proceed?`:

| `reg.where` | `use` means | `re-point` means |
|---|---|---|
| `standalone` | this project links to and runs that folder | every project on this version switches to this folder |
| `other-project-copy` | this project runs the other project's copy (fragile; says so) | as above; the other project must re-run install |
| `this-project-copy` | keep running its own copy; no dependency action | re-point to the standalone folder, re-link the dependency |
| `github` | use that source (no compare line) | re-point to this folder |

`--share` answers 1, `--repoint` answers 2, `--quiet` with neither is a refusal on stderr, both together exit 2.
Local folders get a `comparing the two copies …` line (a content hash, `hashTree`/`compareCopies`) shown as
information only; it gates nothing. A dead row (folder gone) is not a question: re-pointing is the one sane fix,
so it is a plan line.

---

## 4. Plan — the action catalogue

`plan(state, opts)` is pure and is what `--plan` prints. It walks the actions in this fixed order and includes each
whose `needed` condition holds:

| Action | Needed when | Command (cwd = project) |
|---|---|---|
| `repoint` | row `dead`, or the user chose re-point | `claude plugin marketplace remove <name>` then `… add <canonical>` |
| `register` | row `absent` | `claude plugin marketplace add <canonical>` |
| `dep` | linked mode and the dependency is not a link to canonical, or is undeclared | `npm install file:<relative path> --save-dev --no-fund --no-audit` (`--save` for a regular one; `--from <spec>` replaces the spec) |
| `plugin-install` | no record, or the record's install path is gone | `claude plugin install <id> --scope project` (`-y` with `--quiet`) |
| `plugin-enable` | record present but disabled | `claude plugin enable <id> --scope project` |
| `disable-old` | one per other `claude-tpm@*` id that is on | `claude plugin disable <id> --scope project` |
| `config-seed` | no marker folder or no config | write `.claude/claude-tpm/config.json` (atomic tmp + rename; never overwrites) |

Why this order: registration must exist before `plugin install`; the dependency should exist before the plugin is
on, so a run that stops midway never leaves "plugin on, `npx tpm` broken"; `disable-old` comes after the new id is
on so the project is never without a working version; `config-seed` is last because it is the only write the
installer owns and the cheapest to redo.

Notes: `dep` never exists in vendored mode (the folder that runs is already the dependency) and never generates a
spec that points inside a `node_modules`. A `config.json` that exists but is invalid JSON is **not** an action (the
installer never overwrites a user's file): it is a ✗ finding, the rest of the install still runs, and the closing
line names the file. After the actions the plan prints an `(… is already registered — nothing to do there)` line
when relevant, a `Not touched:` line for upgrades and `use` choices, and ⚠ paragraphs (the `node_modules`
fragility warning; the two-trees warning).

Which folder is canonical: from a standalone folder the project links to it (**linked** mode); from a copy in the
project's own `node_modules` that copy is registered and there is no `dep` action (**vendored**, with the
fragility ⚠); from another project's copy the installer refuses. The `decide` phase can override canonical.

---

## 5. Confirm, apply, close

- **Confirm.** One `Proceed? [y/N] `, default no. `--quiet` answers yes. `--plan` exits 0 before the prompt. Any
  answer other than `y` / `yes` prints `Nothing was changed.` and exits 1. Nothing has been written at this
  point: `observe` is pure and `decide` only hashes.
- **Apply.** Sequential. Each action runs its command(s) with an argv array (no shell); a child's output is
  captured and discarded on success, and printed verbatim under a `✗` line on failure. Then the **one layer the
  action touched is re-observed** (`reobserveLayer`) and the action's postcondition is checked. A non-zero exit or
  a failed check stops the run: `Stopped after N of M. Re-running \`tpm install .\` picks up where this left off.`
  Exit 1. There is no `--force`: an action only runs when it was needed, so an "already exists" from a child
  command is a real disagreement.
- **Close.** A full re-observe, the ⚠/✗ rows if any, one of three closing lines (`installed … N checks ok`,
  `… N checks ok, 1 warning (see ⚠ above)`, `The steps ran, but N checks still fail (see ✗ above)`), and one
  `Next:` line. Exit 0 iff no ✗.

The prompter (`makePrompter`) is a single readline interface per run that buffers `line` events, so piped answers
flow across prompts, and is closed before any child spawns (an open readline holds the TTY in raw mode and gets a
spawned child signal-killed).

---

## 6. Flags and exit codes

| Flag | Meaning |
|---|---|
| `[dir]` / `--dir <path>` | target project; default cwd |
| `--plan` | print diagnosis and plan, exit 0; never prompts, needs no terminal |
| `--quiet` | answer yes; pass `-y` to `plugin install`; a would-be menu is a refusal unless pre-answered |
| `--save` | regular dependency instead of dev |
| `--from <spec>` | use this spec verbatim for the dependency |
| `--repoint` / `--share` | pre-answer the menu (mutually exclusive) |
| `--debug` / `TPM_DEBUG=1` | trace every probe and spawn on stdout, prefixed `[tpm-debug]` |
| `--check` | compatibility alias of `tpm doctor`; `--verbose` applies to it |
| `-h`, `--help` | the human help block from the voice module |

Precedence: `--help` > `--check` > everything else. `--force` and `-y` do not exist; an unknown token or a flag
missing its value exits 2. Exit codes: **0** installed / healthy / `--plan` / help; **1** refused, declined, a step
failed, or a ✗ remains; **2** bad arguments.

Inside a Claude session there is no terminal, so a bare `tpm install` is refused with the `--quiet` hint; pass
`--quiet` (and `--share` or `--repoint` if the row is elsewhere).

---

## 7. The scenario matrix

L = installer runs from a standalone folder (linked mode); V = it runs from the project's own `node_modules` copy
(vendored mode). Plans list actions in §4 order. Each row is a test in `tests/tpm-consumer-install/test.js`.

| # | Observed | Diagnosis | Plan |
|---|---|---|---|
| 1 | L, nothing anywhere | not-installed | register · dep · plugin-install · config-seed |
| 2 | L, row same, nothing in the project | not-installed | dep · plugin-install · config-seed (+ already registered) |
| 3 | V, nothing yet | not-installed | register (own copy) · plugin-install · config-seed + fragility ⚠; no npm |
| 4 | L, all at target | healthy | none; one line, exit 0 |
| 5 | L, at target, row stored through a link | healthy-with-warnings | none; ⚠ + fix |
| 6 | L, 0.1.0 project (old dep, old id on) | upgrade | register · dep · plugin-install · disable-old · config-seed + `Not touched:` |
| 7 | L, a `…-market-0.2.0` project | upgrade | as 6 |
| 8 | L, row dead, dependency dangling, record present | broken | repoint · dep · plugin-install; one confirmation |
| 9 | L, row elsewhere (standalone) | registered-elsewhere → menu | use: dep → that folder · plugin-install … / re-point: repoint · dep · plugin-install … |
| 10 | L, row in another project's copy | registered-elsewhere → menu | use: dep + two-trees ⚠ … / re-point: as 9 |
| 11 | L, row in this project's own copy | registered-elsewhere → menu (own-copy wording) | use: no dep · plugin-install … / re-point: repoint · dep … |
| 12 | L, row is a GitHub source | registered-elsewhere → menu (no compare line) | as 9 |
| 13 | L, record present but disabled | partial | plugin-enable |
| 14 | L, no record, enabled in settings, row live | partial | plugin-install (restores the record) |
| 15 | L, no record, enabled, row dead | broken | repoint · plugin-install |
| 16 | L, enabled, marker folder missing | broken | config-seed |
| 17 | L, `config.json` invalid | broken (✗ finding, no action) | whatever else is needed; closing ✗ names the file; exit 1 |
| 18 | L, two `claude-tpm@*` ids on | upgrade-shaped | disable-old for each extra |
| 19 | V, row points at a standalone folder | registered-elsewhere → menu | use: no dep … / re-point: register own copy + fragility ⚠ |
| 20 | any, installer is another project's copy | refused | none |
| 21 | any, stamp mismatch | refused (blames claude-tpm) | none |
| 22 | any, no terminal and no `--quiet` | refused with the `--quiet` hint | none |
| 23 | any, `--plan` | diagnosis + plan | none, exit 0 |
| 24 | any, `Proceed?` answered n | `Nothing was changed.` exit 1 | none; no writes, no mutating `claude` call |

Failure rows (also pinned): a failed action stops with `Stopped after N of M` and a re-run plans the remainder; a
command that exits 0 but changes nothing fails its post-check; a `claude` that will not report its state is a
refusal (no guessed plan).

---

## 8. What gets written, and by whom

| Where | Written by | What |
|---|---|---|
| machine marketplace registry (user scope) | `claude plugin marketplace add/remove` | one `claude-tpm-market-<version>` row, path = canonical folder |
| `package.json`, `node_modules/` | `npm install file:…` | the dependency (a link to canonical) and `.bin/tpm` |
| `.claude/settings.json` (`enabledPlugins`) and the plugin record | `claude plugin install/enable/disable` | the project-scope enablement |
| `.claude/claude-tpm/config.json` | the installer (`ensureConsumerConfig`) | the default `tasksDir` / `sessionsDir`; atomic, never overwrites |

The installer never edits `settings.json` itself and never touches `README`, `LICENSE`, `.gitignore`, the old
version's folder, its registry row, its cache, or `extraKnownMarketplaces` (those are the `Not touched:` line).

---

## 9. The doctor and the session-start health note

**`tpm doctor [dir] [--verbose]`** = `observe` (full probes) + a renderer. Rows (from the voice module's
`doctorRows`, no detection re-implemented): `package.json` · `registered` · `turned on` · `project folder` ·
`claude-tpm folder` · `claude`, plus `tpm on PATH` and `TPM_HOME` only inside a Claude session. A project with
nothing of claude-tpm collapses to one ✗ row. Default output is the header, only the ⚠/✗ rows (each with `fix:`)
and one summary line; `--verbose` prints every row. Exit 1 iff any ✗; ⚠ alone exits 0. The `claude-tpm folder`
row is the only one the doctor authors a variant of: it applies the stamp guard to the running folder, and when a
*different* folder is registered it judges `complete` against the registered one (the folder that actually runs).
The doctor is report-only: it never prompts and never runs a mutating command. It refuses on a claude-tpm folder
itself (this installer's own folder, or any folder whose `package.json` is `@codercowboy/claude-tpm`).

**The health note** (`healthMessage` in `tpm-hooks-session-start.js`) runs after the hook's env exports, isolated in
its own try/catch. If `hygiene.healthCheck.enabled` is not explicitly `false` in `.claude/claude-tpm/config.json`,
it calls `observe(project, null, env, {probes:false})` and `V.hookMessage(state)`. Healthy → no output. Otherwise
one `[claude-tpm]` line, at most three problems, from `lightProblems`: version skew (dependency vs running
plugin), another claude-tpm id on, `.claude/claude-tpm/` missing, `config.json` invalid. The text tells Claude to
tell the user, to suggest `npx tpm install .` from a terminal, and not to edit files. Exit 0 always, every
`source`, no `claude` spawn, silent for a folder with no `package.json`.

---

## 10. Uninstall

`tpm-consumer-uninstall.js` takes its detection from the observer: one `observe()` per run (probes traced through
`--debug` as `[tpm-debug] probe: …`), and `reobserveLayer` after a step to verify it. The machine-wide
`plugin list` it needs for the mirror rule is the observer's memoised probe result plus `installed_plugins.json`.
Its decision flow is unchanged: asks project vs whole system (`--project` / `--system` / `--quiet`), uninstalls
the plugin at project scope, removes the row only if no other project has a record (or for `--system`), then drops
the dependency; a guard asks a second consent when the surviving row points inside this project's `node_modules`.
`--check` is retired (it exits 2 and points at `tpm doctor`).

---

## 11. Where the behaviour is pinned

| Behaviour | Test |
|---|---|
| observer layers, probes, memoisation, light mode, preconditions | `tests/tpm-consumer-observe/test.js` |
| every user-facing string, never-print vocabulary | `tests/tpm-consumer-voice/test.js`, and the strict check in the install test |
| diagnose / decide / plan / apply, the scenario matrix, flags | `tests/tpm-consumer-install/test.js` |
| retained helpers (flag guard, debug trace, compare/hash, config seed) and the retired-helper guard | `tests/tpm-consumer-install/test-legacy-helpers.js` |
| doctor rows, `--verbose`, refusal, report-only, routers | `tests/tpm-consumer-doctor/test.js` |
| uninstall mirror rule, scopes, landmine, `--check` retirement | `tests/tpm-consumer-uninstall/test.js` |
| the health note | `tools/hooks/tests/tpm-hooks-session-start.test.js` |

All worlds are hermetic: a stateful fake `claude` (`tests/fake-claude-stateful.js`) and a fake `npm` first on PATH,
with `HOME` and `CLAUDE_CONFIG_DIR` in scratch.
