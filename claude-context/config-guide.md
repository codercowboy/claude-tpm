# claude-tpm — Config Guide

How to configure claude-tpm for a project via `.claude/claude-tpm/config.json`. Every module is **ON by
default with sensible built-ins** — you only add config to *change* something. An absent config file, or an
absent section, means "use the defaults." The file is versioned (`"version": 1`).

Each module's config is read by a **per-suite resolver tool** (see `dev/framework-config-design.md`
§"Config reading") — you never hand-edit anything the orchestrator can't re-derive, and a config that points
at a missing file fails loudly (friendly error + exit 1) rather than silently at spawn time.

```jsonc
{
  "version": 1,
  "session":  { /* §1 */ },
  "workflow": { /* §2 */ },
  "tasks":    { /* §3 */ },
  "hygiene":  { /* §4 */ }
}
```

---

## 1. Session config

Controls the session lifecycle (`tpm-session open`/`close`/`save`/`info`) and — when the `notes`
behavior is on — where notes live and what the boot/close messages say.

```jsonc
"session": {
  "enabled": true,
  "notes": {
    "enabled": true,                                // gates ONLY the notes-writing behavior
    "sessionsDir": ".claude/claude-tpm/sessions"      // where session-NNN/ notes + the current-session pointer live.
                                                       // (This library overrides to "claude-context/sessions".)
  },
  "showTPMOpenMessage":  true,      // show TPM's built-in open MOTD = the menu of ENABLED tpm-* commands
  "showTPMCloseMessage": true,      // show TPM's built-in close sign-off (what happened + notes-saved pointer)
  "additionalOpenMessage":  "",     // path to a consumer .md/.txt shown AFTER TPM's open message ("" = none)
  "additionalCloseMessage": ""      // path to a consumer .md/.txt shown AFTER TPM's close message ("" = none)
}
```
- The **open** message invites work (a command menu); the **close** message is a sign-off, never a menu.
- **Two independently gateable flags, not one overloaded boolean:**
  - `session.enabled` gates the WHOLE `tpm-session` skill (rare to disable — you'd have no session
    ritual at all: no boot reading chain, no wrap-up, no notes).
  - `session.notes.enabled` gates ONLY the notes-writing behavior, independent of the outer flag —
    "bootstrap TPM's session lifecycle but keep my own notes system." `open`/`close`/`save` still run
    their non-notes steps (reading chain, reap, MOTD, sign-off) when this is `false`; they just skip
    every write to `session-NNN/session-notes.md`.
  - Both default `true`; setting neither changes nothing for an existing project. (This is the fix for
    a self-contradictory single flag whose own prose used to claim "keep the lifecycle, disable the
    notes" — a boolean cannot express that; nesting `notes.enabled` can.)
- Full design: `tmp/sessions-redesign/` (source design docs) and
  `claude-context/methodology/session-notes-format.md` (the note format itself).

---

## 2. Workflow config

The formal multi-agent round engine. This is the richest section: it lets a child project shape charters,
subagent models, and team shapes **without forking TPM**.

```jsonc
"workflow": {
  "enabled": true,
  "planTemplateFile": "",           // child's own plan-template (relative to project root); "" = TPM default

  // Per subagent TYPE: its default model + its charter. The 7 TPM-shipped types ship with defaults pointing at
  // their promoted charter homes (workflow-setup/charters/); listing one here OVERRIDES it. A new name APPENDS a type.
  "subagentConfigs": [
    { "name": "planning",      "defaultModel": "opus", "charterFile": "", "retryCount": 1 },  // "" = TPM default charter home
    { "name": "builder",       "defaultModel": "opus", "charterFile": "", "retryCount": 5 },  // builder/bug-fixer often need a few tries
    { "name": "test-writer",   "defaultModel": "opus", "charterFile": "", "retryCount": 1 },
    { "name": "documentarian", "defaultModel": "opus", "charterFile": "", "retryCount": 1 },
    { "name": "verifier",      "defaultModel": "opus", "charterFile": "", "retryCount": 1 },
    { "name": "bug-fixer",     "defaultModel": "opus", "charterFile": "", "retryCount": 5 },
    { "name": "researcher",    "defaultModel": "opus", "charterFile": "", "retryCount": 1 }
    // e.g. add: { "name": "designer", "defaultModel": "opus", "charterFile": "charters/design.md", "retryCount": 1 }
  ],

  // Named team shapes (ARRAY ORDER = RUN ORDER; delivery agents run once, then verify↔bug-fixer loops). TPM ships
  // the six below; a child may override or add. bug-fixer is in NO roster — it's the loop's fixer (verifier.loopFixer).
  "teams": [
    { "name": "full",     "subagents": [ { "name": "planning" }, { "name": "builder" }, { "name": "test-writer" }, { "name": "documentarian" }, { "name": "verifier" } ] },
    { "name": "ship",     "subagents": [ { "name": "builder" }, { "name": "verifier" } ] },
    { "name": "build",    "subagents": [ { "name": "builder" } ] },
    { "name": "test",     "subagents": [ { "name": "test-writer" }, { "name": "verifier" } ] },
    { "name": "docs",     "subagents": [ { "name": "documentarian" }, { "name": "verifier" } ] },
    { "name": "research", "subagents": [ { "name": "researcher" } ] }
  ],

  "defaultParallelism": "serial",   // serial | user-dictated | orchestrator-optimized
  "verifyLoopCap": 5,               // max build→verify kickback cycles on a FAIL (per phase)

  "deliverables": {                 // standing-output gates — all default true (generated)
    "tldr":         true,           // findings/TLDR.md — narrative for the user
    "toolFeedback": true,           // findings/tool-feedback.md — friction log
    "wiki":         true            // findings/wiki.md — long-form writeup (research charter only)
  },

  // --- added from the design-review fold-in (2026-08-28) ---
  "charterVariants": {}, // {} by default — TPM ships no alternates (a lower bar is an ad-hoc edit to the round's
                         // copied charter, not a shipped variant). A consumer adds a role's opt-down/addenda here,
                         // e.g.: "builder": { "alternates": ["charters/quick.md"], "addenda": [] }
  "verifier": {
    "requireAllPass": true,         // AND-semantics: EVERY verifier must PASS, else kickback
    "multiCountMode": "blind-pair", // blind-pair (redundant, catches flakiness) | scoped-lenses (different focuses)
    "loopFixer": "bug-fixer"        // the persona the verify↔bug-fixer loop spawns on a FAIL
  },
  "costLedger": { "epicPath": "00-epic-plan/cost-ledger.md" },  // epic-level ledger, outside swept tmp/
  "blockedFilenamePatterns": ["report", "summary", "analysis", "findings"]  // subagent .md names to reject (server-side block)
}
```

### Charters (via `subagentConfigs[].charterFile`)
A charter is a subagent role's **singular definition of "done."** Charters attach to subagent *types*:
- **Well-known types** — `builder` (ships the *shipping* charter), `researcher` (the *research* charter),
  `verifier` (the *verifier* charter), `planning` (the *planning* charter — formalize the ask, surface
  risks/questions → a plan proposal; don't build). Leaving `charterFile: ""` uses the TPM default for the role.
- **Override** — set `charterFile` on a well-known type to replace its default with your own file.
- **Additional** — add a new subagent type with its own `charterFile`; it **appends to the end** of the
  resolved charter list.

Each role has exactly ONE shipped charter, so there is **no pre-task charter question** — the roster simply
displays each role's charter. (A lower bar for a round is an ad-hoc edit to that round's copied
`charter-<role>.md` in the work folder; the canonical stays pristine.) Charter secrecy still holds: a worker sees
exactly one charter, and the registry is orchestrator-side knowledge.

### Subagent refs (inside a team's `subagents`)
Each entry is a **subagent ref**: `{ name, count, model }`.
- `name` — maps to a shipped type (`planning`/`builder`/`test-writer`/`documentarian`/`verifier`/`bug-fixer`/`researcher`) or a consumer-added type.
- `count` — how many of that role; **default 1**.
- `model` — override the model for this team slot; **default = that subagent type's `defaultModel`** (from
  `subagentConfigs`), falling back to the TPM default model if the type isn't consumer-configured.

### The six built-in teams
| Team | Shape (run order) | Use |
|---|---|---|
| **`full`** *(default)* | planning → builder → test-writer → documentarian → verifier | the complete separated-concerns round |
| **`ship`** | builder → verifier | builder wears all hats (build + tests + docs) → verify |
| **`build`** | builder | quick, unverified build |
| **`test`** | test-writer → verifier | add tests to already-delivered code |
| **`docs`** | documentarian → verifier | add docs to already-delivered code |
| **`research`** | researcher | a one-off subagent pulling info together (hygiene sweep, recon, fact-finding) |

Every team with a verifier gets the **verify↔bug-fixer loop** on a FAIL (the fixer is `verifier.loopFixer`, default `bug-fixer`).

*(Default is `full`, so a typical round gets up-front planning + verification. `research` is a standalone
one-off — deliberately NOT a planner-for-a-builder: a **planner structures work**, a **researcher pulls
info**. A child project may override any team or add its own named teams.)*

### Parallelism (`defaultParallelism`)
The orchestrator asks how a multi-team round runs; the default is **`serial`**.
- **`serial`** *(default)* — one team completes before the next starts.
- **`user-dictated`** — the user lays out the ordering/parallelism explicitly in the plan discussion.
- **`orchestrator-optimized`** — the orchestrator schedules for throughput within the dependency graph.

**Real-world shape:** work usually runs as **parallel "trains"** — each train is a feature's pipeline of
teams run *serially* (team → team → team), while multiple trains run *in parallel* with each other. The
per-round default stays serial; parallelism is opt-in via the plan discussion.

Full design: `tmp/workflow-redesign/workflow-design.md`.

---

## 3. Task config

The `tpm-task` tracking system (`/tpm-task add`/`list`/`show`/`edit`/`check`/`start`/`finish`/`drop`/
`remove`/`reopen`/`import`/`export`) — a lightweight, human-readable **and hand-editable** per-task-file
markdown ledger. Every key is optional; an absent `tasks` section (or an absent config file) means "use
the defaults," and the system is ON.

```jsonc
"tasks": {
  "enabled": true,                              // false ⇒ /tpm-task + task.js short-circuit, no store ops
  "tasksDir": ".claude/claude-tpm/tasks",        // store location; a project may repoint it (e.g. "claude-context/tasks")
  "startId": 1000,                              // first task number (monotonic, never reused)
  "bucketSize": 1000,                           // body-folder bucketing (bodies/1000-1999/, …)
  "defaultOrder": "newest",                     // list sort when --order omitted: newest|oldest|id|state
  "defaultListState": ["open", "in-progress"],  // the pool `list` shows by default
  "timezone": "local",                          // created/ended stamps + age computation
  "exportDir": "tmp",                           // default destination dir for `export` (auto-timestamped file)
  "allowHardDelete": true,                      // false ⇒ `remove` can only stash, never hard-delete
  "maxOpenWarn": 50,                            // soft stderr nudge when the open list exceeds this
  "autoConfirm": { "finish": false, "drop": false }, // may skip the confirm dialogue for these two only
  "minimalTasks": false,                        // true ⇒ quick-capture: headline+summary, context optional
  "subtaskStyle": "letters"                     // "letters" (1245.A) at launch; "numbers" deferred
}
```
- **`tasks.enabled`** is the master off-switch — both the skill and `task.js` bail with a clear message
  pointing at the key, and do no store ops. Missing config ⇒ defaults (system ON); malformed config ⇒
  defaults + a stderr warning (never a crash — the lenient philosophy the ledger is built on).
- **The store is plain markdown a human can open and hand-edit.** `tasksDir` holds three index files
  (`task-index.md` = open + in-progress and the `**Next ID:**` marker · `finished-tasks-index.md` ·
  `removed-tasks-index.md`) plus `bodies/<bucket>/task-<N>.md`. Bodies are canonical; the indexes are a
  regenerable cache — if one drifts (a hand edit, a crash), `task.js reindex` rebuilds them from the
  bodies. A hand edit is never treated as corruption.
- **`autoConfirm`** only tunes *which* of `finish`/`drop` skip the skill's confirm dialogue; the
  confirm-before-destructive *rule itself* is not configurable, and **`remove --hard` is never
  auto-confirmable** (and is blocked entirely when `allowHardDelete: false`).
- **`minimalTasks`** is a **skill drafting hint** (whether to require a context field on capture), not a
  tool gate — the tool is lenient and stores whatever it's handed.
- **Deliberately NOT configurable** (to avoid knob-explosion): mode names/aliases, the field schema, the
  index filenames, the age ladder, and the confirm-before-destructive rule. A `storageMode: flat`
  backend was considered and rejected (the index files already give a catable flat view).
- Full reference: `tools/task/task.md` (tool + all 14 subcommands), `tools/task/lib/config.md` (this
  resolver), and `tools/task/README.md` (the suite). Design rationale: `tmp/tasks-redesign/`.

---

## 4. Hygiene config

Drift sweeps + living-document upkeep (`tpm-hygiene`).

```jsonc
"hygiene": {
  "enabled": true
  // cadence + check selection — see dev/hygiene-redesign.md (being finalized)
}
```
*(Full shape lands when the hygiene module is built — see `dev/hygiene-redesign.md`.)*

---

## Turning a module OFF

Set `"enabled": false` on any module. A disabled module costs **zero context** — its docs, skills, and
reading-list entries never load, and its vocabulary never appears in what the orchestrator reads (the
module-opacity principle; see `methodology/overview.md`).
