# claude-admin

**A project-agnostic Claude Code setup for running Claude as a disciplined
multi-agent system** — refactored from methodology that's been running real
projects for months.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

---

## Install

> ⚠️ **Work in progress** — these steps are a skeleton and will be fleshed out.

1. **Get the repo.** Download it from GitHub — **_TODO: repo URL / releases link_** —
   or clone it once the repo is public:
   ```bash
   # TODO: replace with the real repo URL
   git clone https://github.com/<owner>/claude-admin.git
   # or download the ZIP from the Releases page and unzip it
   ```
2. **Unzip / place it somewhere.** Put the folder wherever you keep your
   projects (e.g. `~/projects/claude-admin`). This directory *is* the setup —
   Claude Code reads its `CLAUDE.md` and `claude-context/` on boot.
3. **Install the Claude Code CLI.** Requires Node.js (**_TODO: confirm minimum
   version_**):
   ```bash
   npm install -g @anthropic-ai/claude-code
   ```
4. **Connect it to your account / API key.** On first run, `claude` walks you
   through authentication:
   ```bash
   cd path/to/claude-admin
   claude
   ```
   Sign in with your Anthropic account when prompted, **or** provide an API key
   via the `ANTHROPIC_API_KEY` environment variable. **_TODO: document the
   recommended auth path (subscription login vs. API key) and any billing
   notes._**

---

## Resources

**Start here → [The Creator of Claude Code Teaches You How to Actually Use It](https://www.youtube.com/watch?v=jsoKH4Pvld0)** (Boris Cherny, 2026).
If you watch one thing, watch this. The disarming TLDR is basically: **just talk
to it.** That sounds too simple, but it's the single most under-appreciated
thing about Claude Code — a lot of the friction people hit comes from
over-engineering prompts and process instead of just having a conversation with
the tool and letting it work. Everything in this repository is scaffolding
*around* that core idea, not a replacement for it.

More from the same source:

- [Mastering Claude Code in 30 Minutes](https://www.youtube.com/watch?v=B_KAEqiC-0Q) —
  official Anthropic workshop with Boris; a fast, practical tour.
- [How Boris Uses Claude Code](https://howborisusesclaudecode.com/) — a
  collected set of his tips and habits (running multiple instances, notifications,
  etc.).

Official docs:

- [Claude Code documentation](https://docs.anthropic.com/en/docs/claude-code) —
  **_TODO: confirm canonical URL._**

---

## What this is

`claude-tpm` is a drop-in **operating setup for Claude Code** — the standing
context, conventions, and process that turn a Claude Code session into a
disciplined **multi-agent system**: a single **orchestrator** session that
delegates focused work to **subagents** specialized, at spawn time, into
**researcher**, **worker**, and **verifier** roles.

It isn't a fresh idea on paper. It's the **refactor of a working methodology** —
a set of processes that have run the author's real projects for several months —
lifted out of their original domain and generalized so any project can adopt
them. It packages the operating discipline that makes the multi-agent
arrangement reliable:

- **Role separation** — the orchestrator talks to the user, plans, and
  reconciles; subagents do the legwork in isolated contexts and report back.
- **Charters** — a per-round posture (ship a working artifact vs. produce
  durable knowledge) that keeps a round from quietly ending in a write-up when
  it was supposed to build something.
- **Reading lists as a single source of truth** — what each role reads is
  defined once, in manifests a linter parses, so documentation and enforcement
  can't drift.
- **A verification gate** — independent verifiers that inspect only on-disk
  artifacts and can't mutate what they check, with a bounded verify-and-loop.
- **A durable/disposable workspace split** — every round's work is cleanly
  divided into artifacts worth keeping and scratch that's safe to delete.

It is **project-agnostic**: nothing here assumes what you're building. Child
projects adopt the library and add their own domain-specific supplements.

## Why

The methodology was proven in a domain-specific setting and repeatedly earned
its keep there. This project lifts the **generic** core out of that setting so
any Claude Code project can use it — and so the original toolkit can eventually
depend on this library rather than carrying its own copy.

## Status

Being ported and generalized in phases:

1. **Faithful port + strip** *(in progress)* — copy the generic methodology in,
   remove all domain-specific content, apply consistent terminology and layout.
2. **Refinements** *(planned)* — improvements on top of the ported baseline
   (workspace discipline, config overrides for child projects, session-notes
   automation, hygiene routines, and an adoption path for child projects).

Provenance of every ported file (source, original hash, what was stripped) is
tracked so the port stays auditable.

## Repository layout

```
claude-admin/
├── CLAUDE.md                     ← read on boot: session + methodology entry point
├── LICENSE                       ← MIT
├── README.md                     ← you are here
├── claude-context/
│   ├── methodology/              ← the methodology docs (the library)
│   ├── sessions/                 ← per-session notes (session-NNN/)
│   └── dev/                      ← this project's own working notes, tasks, ledgers
└── tmp/                          ← scratch + staging (git-ignored)
```

## Credits

- **Author** — all prose and tooling in this repository is written by **Claude**
  (Anthropic's Claude Code, Opus). This includes the methodology docs (as ported
  and generalized here) and any scripts.
- **Direction** — **Jason Baker** (jason@onejasonforsale.com,
  [onejasonforsale.com](https://onejasonforsale.com)) directed the project:
  goals, structure, decisions, and review.

## License

[MIT](./LICENSE) © 2026 Jason Baker
