# Consuming claude-tpm in a downstream project — quickstart

> **Status (2026-09-12).** The `tpm-*` skills are delivered to a consumer as a Claude Code **plugin**
> (verified working). The scaffolder wires the project files; a **one-time, per-machine** trust step
> (`tpm-consumer-manage-plugin.js install`, or the two `claude plugin` commands) activates the plugin. Separately, a
> `${TPM_HOME}` placeholder + a PreToolUse hook + a relative env var resolve every bundle reference for
> the tools/methodology. Design + rationale: `claude-context/dev/consumer-adoption-design.md`,
> `child-project-path-resolution.md`, `plugin-research.md`. (Adoption details are still being refined —
> the plugin route is the direction; some specifics may tighten.)

## What you get

The `tpm-*` skills (`/tpm-session`, `/tpm-workflow`, `/tpm-task`, `/tpm-spawn`, `/tpm-spawn-team`,
`/tpm-reap`) plus claude-tpm's methodology + tools, usable from *your* project — without dumping any of
it into your project's own `.claude/skills/`.

## Prerequisites

1. **Node / npm.**
2. **The Claude Code CLI (`claude`) on `PATH`** — needed to activate the plugin.
3. claude-tpm (this repo) reachable on disk (e.g. a sibling folder) with its `package.json`
   (`@codercowboy/claude-tpm`).

## Quickstart

**1. Scaffold + install the dependency.** The scaffolder auto-detects a fresh folder vs. an existing
project:

```
node ../claude-tpm/tools/consumer/tpm-consumer-scaffold.js ./my-project
cd my-project && npm i
```

- **Fresh folder** → starter scaffold: `package.json` (with the `file:` dep), a **minimal, generic
  `CLAUDE.md`** (your project's own — it carries **no** claude-tpm content), `README` / `LICENSE` /
  `.gitignore`, `.claude/claude-tpm/config.json`, and `.claude/settings.json` (`env.TPM_HOME` + hooks).
- **Existing project** (already has a `package.json`) → **surgical merge**, nothing clobbered: it adds
  the claude-tpm dep to your `package.json`, merges its env + hooks into your `.claude/settings.json`
  (your other settings preserved), and creates `.claude/claude-tpm/config.json`. Your `CLAUDE.md` /
  `README` / `LICENSE` / `.gitignore` are **left untouched**.

**2. Activate the plugin (one-time, per machine).**

```
node node_modules/@codercowboy/claude-tpm/tools/consumer/tpm-consumer-manage-plugin.js install
```

Equivalent to running, from the project root:

```
claude plugin marketplace add ./node_modules/@codercowboy/claude-tpm --scope project
claude plugin install claude-tpm@claude-tpm-market --scope project
```

Verify with `node node_modules/@codercowboy/claude-tpm/tools/consumer/tpm-consumer-manage-plugin.js status`.

After this, open a Claude Code session in the project and the `tpm-*` skills are **live slash commands
from message #1** (bare `/tpm-session`, …; the namespaced `/claude-tpm:tpm-*` also works). Disable or
remove them anytime with `tpm-consumer-manage-plugin.js disable` / `uninstall`.

## Why a plugin (not "Claude just discovers them")

Claude Code does **not** reliably auto-discover skills nested under `node_modules/`. A **plugin**
registers the vendored skills at startup — that is what makes `/tpm-*` real, available-at-message-#1
commands. (An older approach leaned on "lazy nested-skill discovery" triggered by a `CLAUDE.md` →
`boot.md` read; that mechanism is unreliable and is no longer used — the scaffolder no longer writes
any boot stanza into a consumer's `CLAUDE.md`.)

## How `${TPM_HOME}` resolves (the tools/methodology — separate from the plugin)

`.claude/settings.json` (written by the scaffolder) carries two things that let the skills reach the
shared library wherever the bundle sits:

1. **`env.TPM_HOME`** — a relative path to the vendored bundle (`node_modules/@codercowboy/claude-tpm`).
   Bash tool-invocations in the skills (`node ${TPM_HOME}/tools/…`) resolve via this shell var (cwd =
   project root).
2. **A PreToolUse hook** — `expand-tpm-home.js` rewrites `${TPM_HOME}/…` in **Read** paths to the real
   bundle location (the hook self-locates the bundle from its own directory). Plus the spawn-gate hook.

So the skills reference the shared library as `${TPM_HOME}/claude-context/methodology/…` and
`${TPM_HOME}/tools/…`, resolving whether claude-tpm sits at your project root or in `node_modules`.

## Manual wiring (if you prefer not to use the scaffolder)

1. `npm i file:../claude-tpm` (installs to `node_modules/@codercowboy/claude-tpm/`).
2. In `.claude/settings.json`, add **(a)** the resolution plumbing — `env.TPM_HOME` =
   `node_modules/@codercowboy/claude-tpm`, plus the `expand-tpm-home.js` (matcher
   `Read|Glob|Grep|NotebookRead`) and `tpm-workflow-gate-spawn.js` (matcher `Agent|Task`) PreToolUse hooks, commands
   pathed under `${CLAUDE_PROJECT_DIR}/node_modules/@codercowboy/claude-tpm/…` — and **(b)** the plugin
   declaration:
   ```json
   {
     "extraKnownMarketplaces": {
       "claude-tpm-market": { "source": { "source": "directory", "path": "node_modules/@codercowboy/claude-tpm" } }
     },
     "enabledPlugins": { "claude-tpm@claude-tpm-market": true }
   }
   ```
3. **Activate** with the two `claude plugin` commands above. The declaration in (b) alone does **not**
   activate the plugin on a fresh machine — the `marketplace add` + `install` step is a deliberate
   trust gate (a cloned repo must not silently auto-run plugins).

(No `CLAUDE.md` boot line is needed — the plugin surfaces the skills.)

## Notes

1. **Updating:** re-run `npm i` after claude-tpm changes (`file:` resolves to a **symlink** → a live
   dev loop). But because `plugin install` caches a **snapshot** in `~/.claude/plugins/`, refresh an
   installed consumer after skill edits with `claude plugin marketplace update claude-tpm-market` (or
   `tpm-consumer-manage-plugin.js update`). For a tight dev loop, `claude --plugin-dir
   node_modules/@codercowboy/claude-tpm` loads skills **live** with zero global state (but it's a
   per-launch flag).
2. **Config:** claude-tpm modules are ON by default; configure via `.claude/claude-tpm/config.json`
   (see `claude-context/config-guide.md`) — disable a module, point a store dir, override a charter.
3. **Docker:** the bundle lives in your repo/`node_modules`, so it survives container rebuilds — but
   `plugin install` writes global `~/.claude/plugins/` state **per machine**, so re-run the activation
   in a fresh container (or use `--plugin-dir` at launch to avoid global state entirely). `file:`
   symlinks don't survive a `COPY`-only build; publish or `npm pack` for that case.

## See also

- `tools/consumer/tpm-consumer-manage-plugin.md` — the plugin install/uninstall/status tool reference.
- `claude-context/dev/plugin-research.md` — the verified plugin mechanics (manifests, trust gate,
  portability, layouts).
