# Tool conventions

How tools in this project are **structured**, the **conventions** they follow, and how workers/verifiers
**use, copy, modify, build, and give feedback on** them. One canonical doc — read Part I when authoring
or restructuring project-level tools; read Part II every time you touch a tool inside a `dev/<task>/`.

> **When this applies.** Part II: every round, every worker/verifier that reads or writes any script
> under `tools/**` or `dev/*/tools/**` (and the orchestrator when building task-folder tools). Part I:
> whenever a project-level tool is created or restructured.

> **Related docs:** [`./project-workspace.md`](./project-workspace.md) (write-boundary table — WHERE a
> task-folder tool goes) · [`./shared-conventions.md`](./shared-conventions.md) (shared workflow
> conventions) · [`./verification.md`](./verification.md) (verification depends on the tools you build)
> · [`./orchestrator/handbook.md`](./orchestrator/handbook.md) (orchestrator-only promotion criteria) ·
> [`../../tools/README.md`](../../tools/README.md) (canonical index of every project-level tool — check
> before writing anything).

---

# Part I — Tool structure (authoring project-level tools)

## 1. Portable per-suite folders

Project-level tools live in **portable per-suite folders**:

```
tools/
  README.md                      # THE canonical ledger: every tool + a tests ledger, one bullet each (SSOT — §4)
  <suite>/                       # e.g. task, spawn, session, workflow — a self-contained suite
    <tool>.js (or .sh)           # the executable
    <tool>.md                    # its reference doc  (tool + its .md at the suite ROOT)
    lib/                         # the suite's OWN library code (or flat helpers beside the tool)
    tests/
      <tool>/test.js             # human-readable tests for that tool
      lib/                       # shared test helpers WITHIN this suite
```

There is **one** ledger (`tools/README.md`) — suites do **not** each keep their own README.

At the suite root: only the tool executables + their `.md`s + `README.md` + `lib/` + `tests/`. Anything
a tool needs beyond a single file goes in `lib/`. `<tool>.md` sits beside `<tool>.js`. A suite name may
be skill-branded (`task`, `spawn`) or functional (`workflow` for scaffold/lint/cost) — either way it's a
portable folder.

## 2. Portability — the load-bearing rule

**Copy a whole `tools/<suite>/` folder (with its `lib/` and `tests/`) elsewhere and it must just work** —
NO dependency on any shared project-level lib, no `require('../../shared/…')`, no cross-suite imports. A
suite is self-contained.

- **Tradeoff, accepted deliberately:** if two suites need the same helper, **each carries its own copy**
  in its `lib/`. Copy-portability wins over DRY-shared-lib.
- **Zero runtime dependencies:** tools use only Node built-ins (or POSIX for `.sh`). No third-party npm
  deps. A tool stays runnable with a bare `node tools/<suite>/<tool>.js`.

## 3. Running tools — `npm run` and/or a `tpm`-style bin

Root **`package.json`** is a convenience wrapper (a script registry + `bin`), NOT a dependency manifest. A
project wires its tools to be run in one or both of two ways:

- **npm scripts** — one `scripts` entry per tool, run as `npm run <name>` (args after `--`, e.g.
  `npm run task -- list`):
  ```jsonc
  { "scripts": { "task": "node tools/task/tpm-task.js" } }
  ```
- **A `bin` dispatcher** — a single git-style front-door command declared as the package `bin`, run as
  `npx <bin> <suite> <verb>`. claude-tpm ships `"bin": { "tpm": "tools/tpm.js" }`, so its tools run as
  `npx tpm session export`, `npx tpm task list`, etc. (claude-tpm exposes only this bin — no per-tool
  `npm run` scripts beyond `npm test`; another project may prefer npm scripts, or both.)

Either style is fine, and a tool wired **neither** way (an internal helper, a hook script the harness
invokes, a one-off utility) simply has **no** run command. Every tool also stays runnable by a bare
`node tools/<suite>/<tool>.js` regardless (§2). The `tools/README.md` ledger records a tool's run command
**only when it's actually wired** (§4).

## 4. Docs — the canonical ledger + per-tool references

- **`tools/README.md` — the one canonical ledger (SSOT).** Suites do NOT each keep their own README; this
  single file is the exhaustive index. Its contract:
  - **Exhaustive + honest** — every tool that exists is listed; nothing that no longer exists is.
  - **Categorized by suite**, each category opening with a one-line description of what the suite is for.
  - **One bullet per tool** = the `` `path` `` + one sentence on what it does; a **Run:** command **only if
    the tool is wired** (`npm run …` / `npx <bin> …` per §3) — otherwise no run line; and a **Doc:** pointer
    to its `<tool>.md` or "header". Internal helpers and routers are listed but **tagged** (e.g. "internal
    helper — imported, not a CLI") so the ledger is complete without implying they're runnable.
  - **A tests ledger** below the tools ledger — how to run everything (`npm test`) and each suite's runner.
  - **Kept in sync in the same change** that adds, removes, or renames a tool.
- **`<tool>.md`** — the tool's own reference (flags, subcommands, examples), beside `<tool>.js`.
- Test files carry a header docstring (purpose / guards / how-to-run).

## 5. CLI conventions (uniform across project-level tools)

- **Standard flag vocabulary:** `--in`, `--out`, `--force`, `--help`.
- **No silent defaults for REQUIRED inputs** — a required flag with no value fails loudly with usage
  (e.g. `tpm-workflow-audit.js --out`). No guessing a path/target. (Full rationale in Part II §"No hardcoded paths.")
- **Every tool supports `--help`** and carries a header docstring (purpose, usage, flags, what it guards).
- **Run-wired where applicable** — via `npm run` and/or the project's `bin` (`npx …`) per §3; not every
  tool is wired, and unwired tools carry no run command in the ledger.
- **Genericity:** tools stay project-agnostic; project-specific data comes via flags/env, never
  hardcoded.

## 6. Migration status + a rejected pattern

**Migration (largely done):** the workflow tools (`scaffold-subagent`, `audit`, `lint-*`, `cost-ledger`,
…) were moved from the old `tools/workflow/` category layout + `tools/test/workflow/` into this per-suite
shape, with `package.json` + the `tpm` bin dispatcher wiring them (`npx tpm <suite> <verb>`).

**⚠️ Deliberate DIVERGENCE from ggaitk — no shared tool lib.** ggaitk used a shared `tools/lib/`
(`GGAITKPaths.js`, `#paths` subpath imports) every tool `require()`d. **We reject that** for the §2
portability rule: each suite carries its own `lib/`, duplication accepted. Do NOT port a shared
`#paths`/subpath-imports module. Any paths/root-finding helper a suite needs lives in that suite's `lib/`
(copied, not shared).

---

# Part II — Using & building tools inside a task (worker/verifier-facing)

## Core rule — read this first

**You do NOT edit any tool under the project-root `tools/` folder.** Those are canonical / shared /
cross-task; editing them in-place forks the tool silently and breaks every other task that uses it.

**You ARE encouraged to USE them as much as possible.** Read-first list:
1. **[`../../tools/README.md`](../../tools/README.md)** — the index. Grep it for your domain; every tool
   has a description, CLI flags, and its npm alias.
2. **Sibling `dev/*/tools/`** — someone may have built a task-folder tool close to what you need
   (read-only reference; you may copy into YOUR task tools folder, attributing in your docstring).
3. **Your own task's existing tools** — a resumption may already have tools in `dev/<your-task>/tools/`.

If a root-level tool does exactly what you need — call it. If ~80% — use copy-then-modify below.

## The copy-then-modify pattern

When you need a modified version of a project-level tool:
1. **Copy the file into your task's `tools/` subfolder** (`dev/<your-task>/tools/<name>.js`); create the
   folder on demand per [`./project-workspace.md`](./project-workspace.md).
2. **Modify the copy.** Run the copy. The canonical version stays byte-exact for everyone else.
3. **Aim for generalizations, not special cases.** A change that satisfies both the original use case AND
   yours (via a new flag/option) can be promoted back later; one that only works for you (and breaks the
   original) is a fork that rots.
4. **Document it in `findings/tool-updates.md`** (format below), one entry per modified tool.
5. **The `findings/README.md` index** gets a one-line hook pointing at `tool-updates.md`.

At task close the orchestrator reviews `tool-updates.md` for promotion candidates (generalized
modifications get pulled back to the project-level tool; special-cased ones stay).

### `findings/tool-updates.md` format

Append-only, one entry per forked tool:
```markdown
## tools/<suite>/<tool>.js → dev/<task>/tools/<tool>.js
**Why:** <what forced the fork>
**Original use cases preserved:** <YES — all flags unchanged / NO — hardcoded to this task>
**New use case added:** <the flag/codepath you added>
**Promotion candidate:** <YES — general-purpose, opt-in, no task-specific assumptions / NO — task-specific>
```
The "Promotion candidate" line is the key audit signal.

## Ship your deliverables AS re-runnable tools

Any generated artifact (transformed data, extracted asset, decoded dump, diff, JSON export) **MUST have
a script in your task's `tools/` folder that regenerates it from documented inputs** — no manual steps.
Generators, verifiers, extractors, analyzers all ship as scripts (the verifier reads the on-disk
artifact, checks criteria, exits 0/nonzero with a clear PASS/FAIL). **The tool IS the reproducibility
contract** — an artifact without its regeneration script is a black box. Bar is low: a 30-line Node
script with a header docstring, flag parsing, and an example invocation. Anything you'd paste into a Bash
heredoc more than twice → script.

## No hardcoded paths or defaults

> No tool anywhere (project-level `tools/**` OR task-level `dev/**/tools/**`) has a default input path or
> any project-structure-hardcoded default baked into CLI parsing. All path inputs are explicit flags with
> no default.

**Rationale:** portability for distribution outside this repo's layout, plus the "which input produced
which artifact?" audit trail. Concretely: `--in`/`--out`/`--config` REQUIRED, no defaults, fail with a
clear error if omitted; output paths for generated artifacts taken as a flag (`--out-dir`); data files
that ship WITH the tool (`require('./data/table.json')`) are fine (module-local, not project-structure).
When a data source must live somewhere, name it in the docstring + task README — don't bake the path in.

## Resolving project-internal paths — never hardcode absolutes (suite-local helper)

The no-defaults rule above is about **user inputs**. This is the flip side: when a tool must resolve a
**project-internal location** (the repo root, the tools dir, the work dir), **never hardcode an absolute
path** (`/Volumes/…`, `/Users/<user>/…`) and never do `__dirname`-relative `../../../` gymnastics — both
rot the moment the tool moves or the same tree is viewed from a different filesystem mount.

**The principle survives; the mechanism is per-suite (not a shared module).** Per Part I §2 there is NO
shared project paths module. Instead, a suite that needs root resolution keeps a **small `lib/paths.js`
of its own** — typically a `findRoot({ startDir, marker })` that walks upward for a repo marker — and the
tool resolves through that. Copied across suites, per the portability rule.

```js
// PREFERRED — resolve the root via the SUITE'S OWN helper, then path.join the tail
const { findRoot } = require('./lib/paths');   // suite-local, NOT a shared '#paths'
const path = require('path');
const OUT = path.join(findRoot({ startDir: __dirname, marker: 'package.json' }), 'dev/<task>/findings/out.json');
```
```js
// ❌ absolute path — rots on any move / other filesystem view
const DATA = '/Volumes/share/project/data';
// ❌ dirname gymnastics — breaks when the tool moves
const data = path.resolve(__dirname, '../../../../data');
```

**One-shots use the idiom too — no exemption.** A one-shot's forensic value lives in its FROZEN INPUT
DATASET (the exact file/offset/bytes the finding claims about) — keep those coordinates hardcoded, they
ARE the evidence. Only the ROOT resolution goes through the suite helper, so a layout migration doesn't
silently break a re-run. (A past migration created path drift across hundreds of files and cost a full
session to fix — every hit avoidable had the root resolved through a helper.)

Task-folder tools (`dev/<task>/tools/`) follow the same rule: resolve the root via a small copied helper,
not a hardcoded absolute. If you need a resolution helper that doesn't exist, don't invent a shared one —
copy a minimal `findRoot` into your task tools and log the gap to `findings/tool-feedback.md`.

## Building reusable tools by default

For anything that touches a binary blob, scans/extracts/transforms data, or could need re-running to
verify — write a small Node script, not an inline Bash one-liner. Plain `grep`/`Read`/`ls` inline is
fine. Every script in a task's `tools/` folder has: a top-of-file docstring (purpose, inputs, outputs,
example invocation), CLI flag parsing (no hardcoded paths), and a working example in the docstring.
Project-level tools follow the stricter Part I conventions; task-folder tools aim for the same shape but
may deviate when the task calls for it (the no-defaults rule is not optional). What a task-folder tool
must DELIVER once it is meant to ship is the next section.

## Ship-intended tools owe tests + a `<tool>.md`; scratch tools don't

Draw the line by **intent**, not size or cleverness:

- A **ship-intended tool** — one you expect to promote to a project-level `tools/<suite>/`, OR a durable
  deliverable a later round is meant to re-run — owes, **delivered alongside the executable**:
  1. **tests** (`tests/<tool>/test.js`, per Part I §1) that exercise its real behaviour and exit non-zero
     on failure, and
  2. a **`<tool>.md`** reference doc beside the executable (flags, subcommands, one worked example).

  These are not optional polish — they are **hard Definition-of-Done rows**. A ship-intended tool with no
  tests or no `<tool>.md` is **unfinished**, exactly like a tool that doesn't run; the round's DoD must
  carry a row for each and the verifier FAILS the round if either is missing. The plan's Deliverables must
  name both files, and the DoD must close them.

- A **scratch / probe / one-shot debugging tool** — written to answer one question this round and not
  meant to outlive it — owes **neither** a test suite nor a `.md`. It still carries its **header docstring**
  (purpose / inputs / example) and obeys **no-hardcoded-paths** — that baseline never lapses. If a scratch
  tool proves worth keeping, it **graduates to ship-intended** and then owes the tests + doc before it can
  be promoted.

**When unsure which a tool is, treat it as ship-intended.** An extra test file and a short `.md` are cheap;
a promoted tool with no tests is a latent breakage for every future task that inherits it.

## Log your tool feedback

Any friction with a project-level tool (awkward CLI, a hardcoded path that forced a fork, a missing
export, a bug, a wished-for helper, a spotted duplicate) → log it in `findings/tool-feedback.md` (skip
entirely if zero friction). Append-only:
```markdown
## 2026-MM-DD — Tool: `tools/<suite>/foo.js`
**Category:** complaint | wish | bug | workaround | dupe-spotted | generalized-tool-idea
**Observation:** what you hit, what you wanted, what you did.
**Cross-ref:** finding doc / HANDOFF section / code file with the detail.
```
Bias toward logging — friction observations aggregate into tool-refactor rounds.

### `tool-updates.md` vs `tool-feedback.md`

| File | When | What |
|------|------|------|
| `findings/tool-updates.md` | Whenever you fork a project-level tool (copy-then-modify) | Required. One entry per fork, promotion candidate YES/NO. |
| `findings/tool-feedback.md` | Whenever you hit friction with a tool | Optional (skip if none). One short entry per observation. |

If you fork AND have feedback about the original, log both and cross-reference.

---

## Cross-references

- [`../../tools/README.md`](../../tools/README.md) — canonical index of every project-level tool. Read-first.
- [`./project-workspace.md`](./project-workspace.md) — write boundaries + canonical `dev/<task>/` layout.
- [`./shared-conventions.md`](./shared-conventions.md) — shared workflow conventions.
- [`./verification.md`](./verification.md) — verification deliverables depend on the tools you build here.
- [`./orchestrator/handbook.md`](./orchestrator/handbook.md) — orchestrator-only promotion criteria.
- [`./workflow-setup/plan-template.md`](./workflow-setup/plan-template.md) — standing deliverables (repro
  from documented inputs, build missing tools, log tool feedback) that Part II consolidates.
