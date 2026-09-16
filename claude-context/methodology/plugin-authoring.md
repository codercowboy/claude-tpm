# Authoring a claude-tpm–style plugin ("plugin-ification")

**What this is.** The general, repeatable structure for giving a project — referred to here as **the
target project** — its own self-contained Claude Code plugin modeled on claude-tpm's shape: a `<cli>`
dispatcher, an installer + doctor, plugin/marketplace manifests, and skills. It is **methodology, not a
skill** — there is deliberately no `tpm-create-plugin` command; you follow this structure by hand (or
run it as a formal round, see below).

> **Trigger:** read this when plugin-ifying a target project, or when maintaining a plugin built this
> way. It shares its foundations with [`tool-conventions.md`](./tool-conventions.md) (self-location,
> copy-then-modify, no hardcoded paths) — read that too.

claude-tpm is the reference implementation of everything below; when a detail is unclear, open the real
files (`tools/tpm.js`, `.claude-plugin/{plugin,marketplace}.json`, `.claude/skills/*/SKILL.md`,
`package.json`) and mirror them.

---

## 1. Anatomy — what a plugin-ified target ships

1. **The `<cli>` dispatcher** — a *dumb top dispatcher* that routes `npx <cli> <suite> <verb>` to
   per-suite routers. **Self-locating** (finds its own bundle; never depends on `cwd` or env), **zero-env**
   (no required environment variables), and it propagates child exit codes. Build it **copy-then-modify**
   from the reference dispatcher — never edit the reference in place.
2. **Flat aliases: `install` / `doctor` (and `uninstall`)** — promoted to the top level so `npx <cli>
   install .` / `doctor .` work directly. Install is **idempotent and check-then-act** (inspect state,
   change only what's wrong) and **self-healing** (e.g. a dead-source marketplace is removed then
   re-added). **The doctor only REPORTS; install performs the repair** — keep read-only checks read-only,
   and have the doctor tell the user to re-run install. Uninstall is **scope-aware** (this-project vs
   whole-system) with a consent gate on the destructive path.
3. **`.claude-plugin/plugin.json` + `marketplace.json`** — the plugin manifest (name, version, author,
   `skills` path) and a marketplace that lists the plugin. Give the marketplace a **project-unique name**
   (see Gotchas — the marketplace registry is a machine-global singleton).
4. **Skills** under `.claude/skills/<skill>/SKILL.md` — see §2 for the two archetypes.
5. **`package.json`** — wires the `<cli>` bin so `npx <cli>` resolves, and ideally declares **zero runtime
   dependencies**. A plugin with no packaged deps says so proudly: there is no supply chain to audit.

---

## 2. Skill archetypes — name which kind you're writing

A `SKILL.md` is one of two kinds, and it should **say which** so future authors and readers aren't
guessing:

- **Action skills** — direct Claude to *do* a task: spawn a subagent, run a workflow, perform a
  scoped operation. They carry a prescriptive flow (steps, gates, tools). claude-tpm's `tpm-*` skills are
  all this kind.
- **Orientation / context-priming skills** — the skill's whole job is to make Claude **aware** of some
  context so it can then *collaborate* with the user, NOT to run a task and produce an artifact. The shape
  is: *"Before we work on X, get oriented — here's what X is for, here's each relevant doc and what it's
  for, here's the collaborative process,"* and then it hands control back. It does not command an output.
  (Example: a `<name>-voice` skill that primes Claude on a house writing style so Claude and the user can
  then draft docs together.)

The distinction matters because an orientation skill written like an action skill will make Claude charge
off and *produce* something when it was only supposed to *learn* something. State the archetype in the
skill's own text.

**Two hard requirements for an orientation skill** (learned from dogfooding, see §7 - every test round hit
both):

- **Give it a non-interactive branch.** It WILL be invoked headlessly - a subagent fan-out, a `claude -p`
  run - where there is no user to collaborate with. A skill that only says "collaborate with the user,
  produce nothing" dead-ends in exactly that case: the agent either produces nothing (useless) or overrides
  the skill silently (undocumented, and it varies run to run). Spell out the fallback: with no user, ground
  every claim in files you can actually read, write the artifact, and flag the assumptions you would
  otherwise have asked about.
- **It must resolve its own reference material from its own location.** A skill that points at docs
  "relative to the repo" breaks the moment the plugin is installed from a packaged or remote marketplace
  instead of a local checkout - the sibling files don't travel with it. Either bundle the reference docs
  inside the plugin (a `references/` dir next to the skill) or resolve them by walking up from the skill's
  own base directory. "Ask the user where the docs are" is not a resolution strategy in a headless run. (§9 details the two delivery mechanisms - bundling the
  docs inside the skill dir, or a `files` array plus a `${<CLI>_HOME}` env-expansion hook.)

---

## 3. Shared standards (hold for both the reference plugin and every target)

- **Self-location / no hardcoded paths.** Tools locate their own bundle; nothing assumes an absolute
  install path or a particular `cwd`.
- **Externalized, gated config.** Behavior is config-driven with a clear precedence (**arg > env > local
  project config > framework default**). Where the plugin has modules, honor **module opacity**: a disabled
  module contributes *zero* context (it doesn't just go quiet — its docs never load).
- **Idempotent, check-then-act install; doctor reports, install repairs; scope-aware uninstall.**
- **Zero runtime deps by default** — and if there genuinely are hard platform/engine requirements
  (a runtime, a CLI, an OS), list them explicitly since they appear in no package manifest.
- **One canonical tool ledger**, not per-suite copies (see `tool-conventions.md`).

---

## 4. The build → verify → promote process

**Build + test where Bash is unrestricted.** A real build writes files, runs the CLI, and runs a test
suite — so it must happen in a project/host where execution is *not* sandbox-restricted. **The target
project itself may be write-able but Bash/execution-restricted** (a common sandbox reality). Do **not**
try to build there. Instead:

1. **Stage** a complete, self-contained `<cli>/` tree in the writable/executable host (e.g. the dev
   workspace, under a round's `out/` or a scratch dir). Because the dispatcher is self-locating, the tree
   runs identically wherever it ends up.
2. **Verify against a definition of done**, e.g.: `npx <cli> install .` registers the marketplace + enables
   the plugin (check on a scratch consumer → `npx <cli> doctor .` all PASS); `<cli> --help` lists suites;
   each skill is invocable and matches its intended archetype; `package.json` declares no deps.
3. **Dogfood into a real test bed.** Install the finished plugin into an actual project — the dev/host
   project itself is ideal — *alongside* any existing plugin, and exercise it live. It's reversible via
   `uninstall`. (Remember: a plugin (re)install only takes effect on the next Claude launch.)
4. **Promote** the verified tree into the target repo. **Reconcile, never clobber** — if the target already
   has a `package.json` / `README.md`, merge into them rather than overwriting. If the target is
   Bash-restricted, promotion is **file-writes only** (the file tools still work where Bash doesn't).

---

## 5. Doing it as a formal round

This whole process maps cleanly onto a **full-team workflow round** (planner → builder → test-writer →
documentarian → verifier, with the verify↔bug-fixer loop): the planner designs the `<cli>` by studying the
reference plugin, the builder copy-then-modifies it into the staging tree, tests + docs follow, the verifier
runs the DoD checks on a scratch consumer, and the orchestrator promotes on green. See the workflow module
for the round machinery. Building it as a round also dogfoods the workflow itself.

---

## 6. Gotchas

- **Plugin (re)install activates on the next Claude launch** — not the current session. Verify with
  `npx <cli> doctor .` after relaunch.
- **The marketplace registry is a machine-global singleton.** Per-project-unique marketplace names avoid
  cross-project skew where uninstalling one project's plugin breaks another's.
- **Never edit the reference plugin in place** when modeling from it — copy-then-modify into the target.
- **Sandbox asymmetry is normal:** a target may allow file reads/writes while denying Bash/execution.
  Choose the build location accordingly (build in the executable host, promote by file-write).
- **Zero-deps is a feature, not an accident** — resist pulling in packages; the whole appeal is a plugin a
  security-minded reader can audit at a glance.
- **"exit null" is a spawn-level failure, not a signal.** `spawnSync` returns `status: null` when the child
  never ran — `r.error` is set (`ENOENT`/`EACCES`), NOT when it ran and was killed (that sets `signal`).
  Inspect `r.error` and report the errno; a bare "exited null" or a guessed "killed by signal" sends you
  hunting the wrong bug. (See §10.)
- **A bin check must prove the bin RUNS — not just that it "isn't ENOENT".** A directory or a non-executable
  file named like the bin on `PATH` makes `spawnSync` fail with `EACCES`, which `which` hides and an
  ENOENT-only check waves straight through. Probe with a harmless `<bin> --version` and require it to
  actually run and exit 0. (See §10.)

---

## 7. Dogfood-testing — the staged subagent protocol

The doctor's structural checks are necessary but not sufficient: they prove the plugin is *installed*,
not that its skill actually *fires* in a live session, and not that the skill is any *good*. Verify
end-to-end with three escalating stages. Each can be driven by subagents; stages 1-2 are bash-only,
stage 3 is a serial train.

**Stage 1 - mechanics (bash, no session).** On a *fresh, throwaway consumer* (a scratch dir with a
minimal `package.json`), exercise the whole install lifecycle and assert the END STATE, not the happy
path:

- `install <proj>` - marketplace registers (as the intended source type), plugin installs + enables,
  final doctor all-PASS.
- re-run `install` - idempotent (every step skips).
- `doctor <proj>` on a never-installed dir - reports cleanly, mutates nothing.
- `uninstall <proj>` (project scope, then `--system`) - reverses cleanly; `uninstall --check` confirms.
- **Snapshot the machine-global marketplace registry before and after and confirm it's restored
  bit-for-bit** (no residue), and that the plugin's own source tree wasn't mutated. The registry is a
  shared singleton; a test that leaves junk in it pollutes every other project on the machine.

**Stage 2 - the live smoke test (does the skill even load?).** The doctor can't prove the skill is
*invocable*, because a plugin only activates on a fresh Claude launch. So launch one:

- Install into a fresh consumer, then start a headless session in that dir:
  `claude --dangerously-skip-permissions -p "<prompt>"`. The `--dangerously-skip-permissions` flag is
  what gets past the interactive "trust this directory?" prompt that would otherwise block an automated
  launch.
- Run it **detached** (a `screen` session or a backgrounded process), output captured to a file with a
  done-marker appended on exit, so it doesn't block the orchestrator; poll the file for the marker.
- The prompt asks the model to list/invoke the plugin's skill. Success = the skill shows up (e.g.
  `plugin:skill`) and invokes. This is the runtime proof the doctor cannot give.

**Stage 3 - behavioral rounds with handoff feedback (is the skill any good?).** Run *several* rounds
serially, each in a *completely fresh* consumer, so each is an independent cold read of the skill with
no memory of the last:

- Each round: fresh dir - install - headless Claude invokes the skill and does the *real task the skill
  is meant to enable* (write the artifact, run the flow, whatever it's for), AND writes a **handoff doc**
  back to the orchestrator: what confused it, what was ambiguous, what it had to guess, what could be
  better.
- Drive all rounds from one detached orchestrator script (serial - each round waits for the prior to
  finish); it exits when they're all done.
- **The orchestrator then judges the artifacts** (did the skill produce good output?) **and synthesizes
  the handoffs.** Findings that recur across independent rounds are high-signal: one round's gripe might
  be that model's quirk, but three rounds flagging the same gap is a real defect. This is usually where
  the sharpest design feedback comes from - more than from the artifacts themselves.

**Interactive prompts — smoke-test against a real TTY, not just piped stdin.** If the installer (or any
CLI step) prompts the user, piped-stdin tests are necessary but NOT sufficient — they can pass while the
interactive path is broken. Real case from this project: a `readline` interface created without an
`output` stream reads piped lines fine but echoes nothing in a terminal, so a human "can't even press y."
Exercise the prompts through a pty (`script`, `expect`, or node-pty) or a manual interactive run before
calling the install verified.

**Teardown.** `uninstall --system` to restore the global registry, and move the scratch consumers +
captured output to a disposable location (don't hard-delete if deletion is restricted - relocate them).
Leave the machine as you found it.

---

## 8. Lessons from dogfooding

Building and testing a real plugin (`jbc`, an orientation-skill plugin, 2026-09-15) surfaced these, most
reusable first. Most are doc/skill-design, not tooling:

- **Orientation skills need a headless branch, and must carry/resolve their own docs.** Promoted into §2 -
  these were the two findings every independent test round hit.
- **Keep a skill's doc map complete and in sync.** The skill listed four reference docs when five existed,
  and the missing one was the highest-leverage doc for the model. A "read these" list drifts the moment you
  add a doc; treat it like code that needs updating.
- **A reusable doc set must be internally consistent.** If a doc says "reuse this line verbatim," it must
  appear in ONE form everywhere, and names / disclaimers / closers must not contradict across sibling docs.
  Every contradiction forces the reader into a coin-flip. Watch especially for a "verbatim" string rendered
  differently in two docs, and for a mandated closer that violates a sibling rule.
- **Scope doc-convention checklists by project size.** A "every project ships alternatives.md / technical.md
  / a LICENSE / config docs" rule collides with a no-fabrication rule on a thin project. State the
  precedence outright - no-fabrication and don't-pad outrank the ships-with checklist - and say when a small
  project's README is the whole deliverable.
- **Name discipline.** A plugin, its skill, its marketplace, and the doc set it points at accrete
  near-synonyms fast. One glossary line at the top of the skill ("X is the plugin; the doc set it loads is
  Y, in repo Z") saves every reader the disambiguation.
- **Test on real source, not just an empty fixture.** A voice or doc skill can only be shallow-tested
  against a two-file fixture: the lived-experience moves (build gotchas, hard-won caveats) have nothing to
  attach to. Point at least one test at a repo with real content.
- **Have test subagents leave a handoff.** The most useful output of a dogfood test was each agent's candid
  "what confused me" note, not the artifact it produced. Ask for it explicitly.

---

## 9. Distribution & delivery — making the CLI and docs travel

The anatomy in §1 isn't enough on its own: two mechanics decide whether the plugin actually *works from a
consumer project*, not just from its own repo. Both are learned the hard way - a plugin looks fine in its
home repo and silently half-works everywhere else.

**Make the CLI resolve in the consumer.** The install step should add the plugin to the consumer as a
dependency (`npm install --save-optional <pkg>`, or a `file:` reference when the package isn't published
yet), right alongside registering the marketplace and enabling the plugin. That's what puts the `<cli>` bin
in the consumer's `node_modules` so `npx <cli> …` resolves *there*. Skip it and `npx <cli>` works only from
the plugin's own repo, and consumers have to call the script by absolute path - a confusing gap that reads
like a bug.

**Regular vs optional dependency — make it a choice, not a default buried in code.** `--save-optional`
records the plugin under the consumer's `optionalDependencies`: npm still installs it on the happy path,
but if the bundle can't be resolved (a missing `file:` path, a wrong platform) npm SKIPS it and continues
instead of aborting the consumer's whole `npm install`. A *regular* dependency (`--save`) hard-fails the
install if it's absent. Optional is the safer default — a consumer cloned somewhere the bundle isn't still
installs; the plugin just isn't there. Because this materially edits the consumer's `package.json`, the
installer should ASK rather than decide silently: (1) add the dep at all? (2) regular or optional? (3)
confirm the exact command before running it. Keep a non-interactive default (optional) under `--quiet`/`-y`
so automated installs don't block. Mind the progression, too: an unpublished plugin uses a `file:` spec
(which *symlinks the whole tree*, so `files[]` exclusions only bite on `npm publish`, not on a local
`file:` install) — switch to a version spec once it's published.

**Make the reference docs travel and resolve** - a skill's docs, a style guide, a methodology library,
anything the skill points at that lives outside the skill's own directory. Three parts, and you need all
three:

1. **Ship them** - a `files` array in `package.json` that includes the doc paths, so they land in the
   consumer's `node_modules` alongside the code. Exclude provenance and heavy dirs (archives, dev notes);
   ship only what the skill actually reads.
2. **Reference them through a placeholder** - skills and prompts point at `${<CLI>_HOME}/path/to/doc`,
   never a relative or absolute repo path.
3. **Deliver an env-expansion hook** - a `PreToolUse` hook on the read tools (`Read|Glob|Grep|NotebookRead`)
   that rewrites `${<CLI>_HOME}` to the installed bundle root at read time. The plugin declares it in
   `hooks/hooks.json`. It's the one env-var-shaped thing in the system, and it exists precisely so
   everything else stays env-var-free and path-portable.
4. **Verify it** - a doctor row that the reference docs resolve and the hook is delivered, so a broken
   install fails loud instead of silently degrading.

The simpler alternative for a *single* skill: put the docs INSIDE the skill dir (a `references/` folder) so
they travel automatically with the packaged skill, referenced relative to the skill's base directory. Use
that when the docs belong to one skill; use the `files` + `${<CLI>_HOME}` + hook pattern when a whole doc
library is shared across skills.

**Two distribution shapes, and the seam between them.** The above is the **local / npm directory-source**
shape: the plugin is installed as an npm dependency (or a `file:` bundle) and the marketplace is a
*directory source* pointing at that installed bundle, so the `files` array + the home-hook carry the docs.
A **GitHub plugin-source** distribution behaves differently: the marketplace clones the repo and may
package only the plugin-manifest-declared files (the skills), so docs living outside the skill dir may not
travel. Before moving a plugin to a GitHub source, confirm what its packaging actually includes; if it
drops the external docs, switch that plugin to bundling its docs inside the skill dir. Keep the two
patterns straight - which one a plugin uses dictates how its reference material must be packaged.

---

## 10. Diagnosing install / spawn failures — child-process reality

A consumer installer is mostly a sequence of `spawnSync` calls to `claude`, `npm`, and friends. Nearly
every hard-to-diagnose install bug lives in the seam between the tool and those children: how a child
failure is *detected*, *reported*, and *reproduced*. These lessons come from a real "exit null" hunt
(jbc/tpm installers, 2026-09-15) that burned hours because the tool lied about what actually happened.
Build these in from the start.

### 10.1 "exit null" and the `r.error` vs `status`/`signal` truth table

`spawnSync(bin, argv, opts)` returns an object with THREE outcome fields, and they mean different things:

- **`r.error` set** — the child **never ran**. The OS refused to exec it. `r.status` and `r.signal` are
  both `null`. `r.error.code` tells you WHY: `ENOENT` (nothing on `PATH` by that name), `EACCES`
  (something's there but not executable — a non-exec file, or a *directory* named like the bin), `E2BIG`,
  etc. **This is the case people misread as a signal-kill.**
- **`r.signal` set** (and `status: null`, no `error`) — the child ran and was **killed by a signal**
  (`SIGKILL`, `SIGTTIN`, …). Only here is "killed by signal X" the right story.
- **`r.status` a number** — the child ran to completion and exited with that code (0 = success).

The trap: a tool that only looks at `status` sees `null` for BOTH "never ran" and "signal-killed", and a
formatter that assumes `status===null ⇒ signal` prints **"killed by signal unknown"** for what is really a
permission error. Correct handling classifies the result once and reports the real cause:

```
function classifySpawn(r) {                       // pure, unit-testable
  if (r.error) return { ran: false, code: r.error.code };        // EACCES / ENOENT / …
  if (r.status === null) return { ran: true, signal: r.signal }; // genuinely signal-killed
  return { ran: true, status: r.status };                        // exited N (0 = ok)
}
```

Render `{ran:false, code:'EACCES'}` as `could not run '<bin>': EACCES (permission denied)` — never as a
signal. Historically the installers special-cased ONLY `ENOENT` in `runChild` and let every other
`r.error` fall through as `status:null` → a bogus "exited null". Handle the whole `r.error` family.

### 10.2 Availability checks — prove the bin RUNS, don't just rule out ENOENT

A preflight that asks "is `claude` installed?" must answer "does a harmless invocation actually run and
succeed?" — not "did the exec avoid ENOENT?". Define availability as **`!r.error && r.status === 0`** from
a **harmless, side-effect-free probe**: `<bin> --version` (node, npm, claude, git — every CLI worth
depending on supports it, and it neither prompts nor mutates). Anything else — an `r.error` of any code, or
a non-zero exit — means "not usable", and you distinguish the reason in the message:

- `ENOENT` → `'<bin>' not found on PATH — install it first.`
- `EACCES` → `'<bin>' is on PATH but not executable (a directory or non-exec file may be shadowing the real
  bin) — is it installed on THIS host?`
- other → the errno verbatim.

Why "ran and exited 0" beats "not ENOENT", concretely:

- **A directory named like the bin on `PATH`.** `spawnSync` tries to exec the directory → `EACCES`. An
  ENOENT-only check declares the bin present; every later call then dies with the same `EACCES`.
- **`which` doesn't see it.** `which <bin>` reports only *executable* matches, so a shadowing directory or
  a non-exec file shows as **blank** — the human swears the bin "isn't there", while Node's `execvp`-style
  `PATH` walk trips on it. `which` and `spawnSync` do NOT resolve the same way; trust the probe, not `which`.
- **Host vs VM.** The real bin can live inside a VM/container while a stray same-named `PATH` entry sits on
  the host. On the host, preflight must fail fast with the EACCES message above instead of limping to the
  first real `claude` call and emitting "exit null" three steps later.

This is a small, pure function to unit-test: feed it fake `spawnSync` result shapes
(`{error:{code:'EACCES'}}`, `{error:{code:'ENOENT'}}`, `{status:0}`, `{status:1}`) and assert the verdict +
message — no dependence on whatever bin happens to be on the test machine.

### 10.3 Build a `--debug` operation-trace flag — the highest-leverage diagnostic

Every consumer CLI in this methodology should ship a `--debug` flag (also honored via a `<CLI>_DEBUG=1`
env var): a `set -x`-style operation log, **to stdout**, prefixed `[<cli>-debug]`. It is instrumentation
only — it changes no behavior — and it is the single fastest way to turn an opaque failure into a named
one. In the real hunt, one `--debug` run converted a silent "exit null" into
`probe: claude … → status=null signal=none error=EACCES` — the entire diagnosis, in one line. Trace, at
minimum:

- **The resolved run** — parsed options, the computed dependency spec, the self-located bundle root, and
  the TTY state (`stdin.isTTY` / `stdout.isTTY`).
- **Every child spawn** — before: `→ spawn: <bin> <argv> (cwd=…)`; after: `← status=… signal=… error=…
  (Nms) <formatted-result>`. Include the **errno on `r.error`**, not just status/signal (that's the field
  that named EACCES).
- **Every read-only state probe** (`claude … --json`, etc.) and its parsed result.
- **Every step decision** — the boolean each `already` / `marketplaceReady` / `needsEnable` resolved to
  AND the inputs behind it. This is what explains "why did step 3 run for them but skip for me?".

Route the trace through STDOUT deliberately (see 10.4) and keep the writer a no-op unless enabled, so
`--quiet`/non-interactive paths stay silent.

### 10.4 Reproduce the REAL path, and capture BOTH streams

Install bugs are exquisitely sensitive to *how* the tool was invoked. These are not interchangeable, and a
green run on one proves nothing about another:

- **`node tool.js` vs `npx <cli> …` vs a dispatcher.** A `jbc`/`tpm`-style bin dispatches to the installer
  via `spawnSync('node', [installer], { stdio:'inherit' })`, and `npx` adds yet another node layer. The
  installer then runs as a *child* that inherits the terminal — a different process/TTY topology than
  running the script directly. Reproduce the invocation the user actually typed.
- **`--quiet` / piped stdin vs a real TTY.** `--quiet` (and any piped-stdin test) never opens the
  interactive `readline`, so it can't reproduce a prompt/TTY bug at all — it's necessary but never
  sufficient. Drive the interactive path through a pty (`expect`, `script`, node-pty) or by hand. (An open
  `readline` holds stdin in raw mode; releasing it around a synchronous child spawn matters on a real TTY —
  see §7.)
- **Capture stderr, not just stdout.** The failure line (`✗ exited …`) is written to **stderr**; a
  stdout-only `… | tee log.txt` silently drops it, so the log ends mid-run with no error — exactly what
  hid the cause for a full round-trip here. Always `<cmd> 2>&1 | tee log.txt`, and prefer the `--debug`
  trace (10.3), which goes to stdout so it's captured either way.

### 10.5 Machine-global state makes "works for me / breaks for you" a state bug

The marketplace registry is a machine-global singleton (§6), and plugin enablement is project-scoped.
Whether an install step *runs or skips* depends on that shared state, not just the code — so the same
command genuinely diverges between two people (or two runs) on state alone. In the real hunt, step 3
(`marketplace add`) *ran* on the host (registry didn't have it) but *skipped* on the other mount (already
registered), which is why the crash "reproduced for one and not the other" despite identical code. Before
concluding a code difference, **snapshot the relevant global/project state** (`claude plugin marketplace
list --json`, `claude plugin list --json`, the target's `package.json` + `node_modules`) from the SAME cwd
the tool uses, and remember `--scope project` reads are cwd-relative. Restore any global state you perturb
while reproducing (§7 teardown).

### 10.6 Fix the whole family — every spawn-calling sibling, not just the one you debugged

The install and uninstall tools (and any doctor/repair tool) are a **family** that each shell out to the
same children, and in a zero-dep house style each carries its OWN copy of the spawn helpers rather than
sharing a module. So a spawn-handling bug is almost never in just one file — the exact `ENOENT`-only
`claudeCliAvailable`/`runChild` that produced "exit null" in the *installer* sat, byte-identical, in the
*uninstaller* too. When you fix one, immediately grep the siblings for the same shape
(`grep -rn "code === 'ENOENT'"`, the same availability check, the same `--debug` gap) and bring them ALL
to parity in the same pass, with the same unit tests. Two rules that make this sane: keep the fix a small
PURE helper (`classifySpawn`, `formatChildExit`, the availability probe) so "port it" is a copy, not a
rewrite; and accept the deliberate duplication — a shared import between install and uninstall would
undercut the "each tool is a self-contained, auditable script" property that is the whole point (§6). Ship
`--debug` into every tool in the family for the same reason: the next opaque failure is as likely on
uninstall as on install.
