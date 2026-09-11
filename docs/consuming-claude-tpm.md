# Consuming claude-tpm in a downstream project — quickstart

> **Status: WORKING (2026-09-01).** Adoption is automated by the scaffolder and validated end-to-end
> (fresh projects AND existing ones). The former relocatable-paths blocker is **solved** — a
> `${TPM_HOME}` placeholder + a PreToolUse hook + a relative env var resolve every bundle ref
> automatically. Design + rationale: `claude-context/dev/consumer-adoption-design.md` +
> `child-project-path-resolution.md`.

## What you get

The `tpm-*` skills (`/tpm-session`, `/tpm-workflow`, `/tpm-task`, `/tpm-spawn`, `/tpm-spawn-team`,
`/tpm-reap`) plus claude-tpm's methodology + tools, usable from *your* project — without dumping any of it
into your project's own `.claude/skills/`.

## Prerequisites

1. **Node / npm.**
2. claude-tpm (this repo) is reachable on disk (e.g. a sibling folder) with its `package.json`
   (`@codercowboy/claude-tpm`).

## The one-command way (recommended)

The scaffolder wires everything and **auto-detects** whether your target is a fresh folder or an existing
project:

```
node ../claude-admin/tools/consumer/scaffold-consumer.js ./my-project
cd my-project && npm i          # or: add --smoke to install + run the smoke tests in one shot
```

- **Fresh folder** → full starter scaffold: `package.json` (with the `file:` dep), `CLAUDE.md` (boots
  claude-tpm), `README` / `LICENSE` / `.gitignore`, `.claude/claude-tpm/config.json`, `.claude/settings.json`.
- **Existing project** (already has a `package.json`) → **surgical merge**, nothing clobbered: it adds the
  claude-tpm dep to your `package.json`, appends a delimited boot block to your `CLAUDE.md`, merges its
  env + hooks into your `.claude/settings.json` (your other settings preserved), and creates
  `.claude/claude-tpm/config.json`. Your `README` / `LICENSE` / `.gitignore` are left untouched.

Then open a Claude Code session in the project — it reads `CLAUDE.md` → `boot.md`, the vendored
`.claude/skills/` light up (lazy nested-skill discovery), and every `${TPM_HOME}/…` bundle ref resolves.

## How resolution works (why it "just works")

`.claude/settings.json` (written by the scaffolder) carries two things:

1. **`env.TPM_HOME`** — a relative path to the vendored bundle (`node_modules/@codercowboy/claude-tpm`).
   Bash tool-invocations in the skills (`node ${TPM_HOME}/tools/…`) resolve via this shell var.
2. **A PreToolUse hook** — `expand-tpm-home.js` rewrites `${TPM_HOME}/…` in **Read** paths to the real
   bundle location (the hook self-locates the bundle from its own directory). Plus the spawn-gate hook.

So the skills reference the shared library as `${TPM_HOME}/claude-context/methodology/…` and
`${TPM_HOME}/tools/…`, and those resolve whether claude-tpm sits at your project root or in `node_modules`.

## Manual wiring (if you prefer not to use the scaffolder)

1. `npm i file:../claude-admin` (installs to `node_modules/@codercowboy/claude-tpm/`).
2. In your root `CLAUDE.md`: “Before anything else, read
   `node_modules/@codercowboy/claude-tpm/boot.md` and follow its instructions.”
3. Add to `.claude/settings.json`: `env.TPM_HOME` = `node_modules/@codercowboy/claude-tpm`, plus the
   `expand-tpm-home.js` (matcher `Read|Glob|Grep|NotebookRead`) and `gate-spawn.js` (matcher `Agent|Task`)
   PreToolUse hooks, commands pathed under `${CLAUDE_PROJECT_DIR}/node_modules/@codercowboy/claude-tpm/…`.
   (The scaffolder just does all of this for you.)

## Notes

1. **Updating:** re-run `npm i` after claude-tpm changes. `file:` resolves to a **symlink** (live dev loop);
   for a pruned vendored copy use `npm pack` + install the tarball, or publish to a registry.
2. **Config:** claude-tpm modules are ON by default; configure via `.claude/claude-tpm/config.json`
   (see `claude-context/config-guide.md`) — disable a module, point a store dir, override a charter.
3. **Docker:** the bundle lives in your repo/`node_modules`, so it survives container rebuilds — no
   `~/.claude` to re-provision. (Symlinks from a `file:` dep don't survive a `COPY`-only build; publish or
   `npm pack` for that case.)
