# Installing claude-tpm

claude-tpm grafts a disciplined multi-agent workflow - the session ritual, a task ledger, and formal
review rounds - onto a project you already have. After install, a plain `claude` in your project has
real `/tpm-session`, `/tpm-task`, `/tpm-workflow`, … slash commands **live from message #1** of every
session.

This guide covers installing into an **existing** project. claude-tpm does not create a project for
you - it only adds itself to one you already have.

You install it **from GitHub**, one of two ways - as a dependency of your project (the usual path), or
from a local clone you point at your projects. There is **no npm-registry package** (`npm install
@codercowboy/claude-tpm` from the public registry won't work); both routes below go through GitHub.

---

## Prerequisites

- **Node.js + npm** on your PATH — `node -v`, `npm -v`.
- **The Claude Code CLI** (`claude`) on your PATH — `claude --version`.
- **An existing project with a `package.json`.** claude-tpm grafts onto it. If you don't have one yet,
  create it first (the installer will stop and tell you to):
  - `npm init` — the interactive wizard (asks for name, version, entry point, …), or
  - `npm init -y` — accept all defaults, no questions.

---

## Quick start

From your project directory, add claude-tpm as a dependency, **then** run the installer:

```bash
cd my-project
npm install --save-optional github:codercowboy/claude-tpm
npx tpm install .
```

The installer walks through each step. **prints the exact command it's about to run, and asks before it changes anything** - decline and it stops without touching your project. When it finishes, you launch `claude` in the project and the `/tpm-*` commands are there.

Once claude-tpm is wired into a project, use the following commands to manage the installation:

```bash
npx tpm install .           # re-run / repair
npx tpm install . --check   # doctor (read-only)
npx tpm uninstall .         # remove it again
```

---

## What the installer does

The installer is **check-then-act and idempotent**: it inspects current state and only does what's
missing. It's a 5-step flow; in the default (interactive) mode it prints each command and asks consent
before running it. Declining any step exits without further changes.

1. **Preflight.** Verifies `npm` and the `claude` CLI actually **run** (a harmless `--version` that
   exits 0 — not merely that a same-named file is on `PATH`), and that a valid `package.json` exists.
   Fails fast with a specific reason: a missing `package.json` → run `npm init -y` first; a tool that's
   `not found (ENOENT)` → install it; a tool that's `found on PATH but not executable (EACCES)` → e.g. a
   directory or non-exec file is shadowing the real bin, or the binary lives in a VM and you're on the
   host. Never writes anything, in any mode.
2. **Dependency.** Records `@codercowboy/claude-tpm` in your `package.json` and runs `npm install`,
   populating `node_modules/@codercowboy/claude-tpm` (from the GitHub repo on Route B; already present
   and so **skipped** on Route A, where you installed it yourself). In interactive mode this is
   **consent-gated**: it asks (a) whether to add the dependency at all — declining skips only this step,
   the marketplace + plugin steps still run; (b) whether to record it as a **regular** (`--save`) or
   **optional** (`--save-optional`, the default) dependency; then (c) confirms the exact `npm install`
   command before running it. `--quiet` keeps the old silent default (optional, no prompts). Skipped
   when the dep is already declared **and** present in `node_modules` (unless `--force`).
3. **Marketplace.** Registers the vendored bundle as a plugin marketplace for this project:
   `claude plugin marketplace add ./node_modules/@codercowboy/claude-tpm --scope project`.
4. **Plugin install.** Installs the plugin at project scope:
   `claude plugin install claude-tpm@claude-tpm-market --scope project` - this usually **enables** it in
   the same step.
5. **Enable.** Enables the plugin for the project only if step 4 left it installed-but-disabled. An
   already-enabled plugin is a **skip, not an error**.

Everything is scoped to **this project** (`--scope project`), so claude-tpm turns on only in projects
that adopt it, never globally on every project.

What the installer **does not** do: it never authors project files (`package.json`,
`README`, `LICENSE`, `.gitignore`) and never edits your `settings.json`. The plugin carries its own
hooks, so there's nothing to wire by hand.

---

## Verify

Deterministic checks (don't rely on a chat self-report):

```bash
claude plugin list                                   # → claude-tpm@claude-tpm-market  ✔ enabled
claude plugin details claude-tpm@claude-tpm-market   # → Skills (N): tpm-session, tpm-task, …
```

Or run the built-in doctor:

```bash
npx tpm install . --check
```

`--check` is read-only: it prints a PASS/FAIL checklist — `package.json` valid · tpm dep declared ·
marketplace registered · marketplace source resolves · plugin installed · plugin enabled for the
project · plugin cache present (loads) · the plugin delivers its two hooks · any `config.json` parses —
and changes nothing (non-zero exit if anything's missing).

After this, a plain `claude` in the project has `/tpm-session`, `/tpm-task`, `/tpm-workflow`, … from
message #1 (with `/claude-tpm:tpm-*` as the namespaced form).

---

## Options

| Flag | What it does |
|---|---|
| `[dir]` | Target project dir — positional, first non-flag arg (default: current dir). |
| `--check` | Read-only **doctor** — PASS/FAIL checklist, changes nothing, non-zero exit if anything's missing. |
| `--quiet` | **Non-interactive** — assume yes to every step; for scripts/CI. Still exits non-zero on real errors. |
| `--force` | Skip the "already done" checks and re-run/repair every step. "Just fix my setup." |
| `--debug` | Operation trace to stdout (a `set -x`-style log, also via `TPM_DEBUG=1`) — narrates every child spawn (command, cwd, exit status/signal/errno) and step decision. Diagnostic only; changes nothing. Use it when a step fails opaquely. |
| `--dir <path>` | The target dir as a flag instead of the positional. |

---

## Customizing defaults (optional)

Every claude-tpm module is **on by default with sensible built-ins** - you need no config to start, and
the installer does not create one.

To change a default, hand-create `.claude/claude-tpm/config.json` in your project. Add only the keys you
want to change; anything absent uses the default, and an absent file means "all defaults."

```jsonc
{
  "version": 1,
  "session": {
    "notes": {
      "sessionsDir": ".claude/claude-tpm/sessions"   // where session notes live (this is the default)
    }
  },
  "tasks":    { "enabled": true },   // set false to turn the task ledger off
  "workflow": { "enabled": true },
  "hygiene":  { "enabled": true }
}
```

Common overrides:

- **Where session notes live** — `session.notes.sessionsDir` (default `.claude/claude-tpm/sessions`).
- **Turn a module off** — `<module>.enabled: false` (`session` / `workflow` / `tasks` / `hygiene`).
- **Boot / close messages** — `session.showTPMOpenMessage`, or `session.additionalOpenMessage` (a path
  to your own `.md` shown after TPM's open message).

The full schema is in `claude-context/config-guide.md` in the bundle.

---

## Uninstalling

```bash
npx tpm uninstall .
```

Uninstall is **scope-aware**, because the plugin and the `claude-tpm-market` marketplace are
machine-global singletons shared by every project that adopts claude-tpm. So it first asks what you
mean - *this project only* or *the whole system* - and forks:

- **This project only (the default).** Two steps: `claude plugin disable claude-tpm@claude-tpm-market
  --scope project` (turns it off here only) + `npm uninstall @codercowboy/claude-tpm` (drops this
  project's dependency). It **leaves the shared marketplace registered** so other projects keep working,
  and does not run `plugin uninstall`.
- **The whole system.** Three steps: `claude plugin uninstall claude-tpm@claude-tpm-market` + `claude
  plugin marketplace remove claude-tpm-market` (no `--scope` → machine-global) + `npm uninstall
  @codercowboy/claude-tpm`. Every project loses claude-tpm; it asks a secondary consent first.

Set the scope non-interactively with `--project` or `--system` (a bare `--quiet` defaults to the safer
project-only). The same `--quiet` / `--force` / `--check` modes apply. It never deletes your
`package.json`, source, or docs; it removes only what the installer added.

---

## Troubleshooting

- **`npx tpm` printed something unfamiliar (a different tool).** On Route A you ran `npx tpm` before
  `npm install` finished, so npx grabbed an unrelated registry package of the same name. Run `npm
  install --save-optional github:codercowboy/claude-tpm` first, confirm `node_modules/.bin/tpm` exists,
  then re-run `npx tpm install .`.
- **"package.json not found"** — run `npm init -y` in the project first, then re-run the installer.
- **Preflight fails on `claude`** — install the Claude Code CLI and confirm `claude --version` works.
- **Commands don't show up in `claude`** — run `npx tpm install . --check`; if the plugin isn't
  enabled, `npx tpm install . --force`, then restart `claude`.
- **"already enabled at project scope"** — harmless; the installer treats an already-enabled plugin as
  a skip.
- **Reset a broken setup** — `npx tpm install . --force` re-runs every step from scratch.
