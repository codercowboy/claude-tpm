# claude-tpm

**claude-tpm turns a [Claude Code](https://claude.com/claude-code) session into a disciplined multi-agent system: one orchestrator, a "TPM", that decomposes what you want, hands the legwork to researcher / builder / verifier subagents in their own contexts, and verifies what comes back before it reports up.**

## What?

It's a modular, opt-in SDLC orchestration framework that runs Claude Code like a small engineering org. The session you talk to plays **Technical Program Manager**: it takes intent from you (the product owner), breaks the work down, delegates pieces to subagents running in isolated contexts, checks their output, integrates it, and reports back. The name is the role on purpose: a TPM.

A few things worth knowing up front:

- It **grafts onto a project you already have.** It does *not* scaffold a new repo. After install, a plain `claude` in your project gets `/tpm-session`, `/tpm-task`, `/tpm-workflow` and friends as live slash commands from message #1.
- It's **project-agnostic**: nothing here assumes what you're building. Child projects adopt the library and add their own domain-specific supplements.
- It ships as a **Claude Code plugin** with a small, dependency-free **`tpm` command-line tool** that does the plumbing the skills lean on.

**Who it's for:** people already living in the Claude Code CLI on real projects who want more structure than one improvising chat: repeatable rounds, independent verification, a shared task ledger. **Who it's not for:** anyone who wants a GUI or a one-click app, and anyone looking to *replace* talking to Claude. This is scaffolding *around* the "just talk to it" core (see [Resources](#resources)), not a substitute for it. If it doesn't sound like your fit, the [Alternatives](#alternatives) doc points you somewhere better.

> **Status / maturity.** v0.1.0. This is a personal methodology I lifted out of months of real use. **Mac-first, works-on-my-machine energy, not a product with a support line.** I haven't run it across a matrix of operating systems, so on Linux or Windows you're further out on the frontier than I am. And **distribution is local for now.** You install from a copy of the bundle on your disk; a published npm/GitHub form is coming soon but isn't the working path yet. Full transparency: **Claude wrote nearly all of the code and docs.** I'm the ideas guy. That's not something I'm hiding - it's kind of the whole point of a tool that turns Claude into a disciplined engineering team.

## Install

The 60-second version, using the real local-bundle path. (The full walkthrough - flags, verification, uninstall, troubleshooting - lives in [`docs/INSTALL.md`](docs/INSTALL.md).)

**You'll need:** [Node.js](https://nodejs.org) + [npm](https://www.npmjs.com/) on your PATH, the [Claude Code](https://claude.com/claude-code) CLI (`claude`) on your PATH, an existing project with a `package.json` (run `npm init -y` first if you don't have one), and a local copy of the claude-tpm bundle placed somewhere reachable. A sibling `../claude-tpm` checkout is the easy default.

```bash
cd my-project
node ../claude-tpm/tools/tpm.js install .
```

The installer is interactive: it prints the exact command it's about to run and asks before it changes anything. After that first install, the `npx tpm …` porcelain works from inside your project:

```bash
npx tpm install . --check   # doctor — read-only, changes nothing
npx tpm doctor .            # same thing, spelled friendlier
npx tpm install .           # re-run / repair
npx tpm uninstall .         # remove it again
```

> **Coming soon (not working yet):** a public `git clone` and `npm install @codercowboy/claude-tpm` from the registry. Don't reach for those today - the local-bundle path above is the one that actually works.

## Use — the short version

Open a `claude` session in your installed project and you've got the `tpm-*` skills live. The minimal loop:

1. **`/tpm-session`** - boot the session (and later, checkpoint or wrap up).
2. **`/tpm-task`** - jot and track work in a plain, hand-editable markdown to-do list you and Claude both read.
3. **`/tpm-workflow`** - *when* a task earns it, kick off a formal multi-agent round.

That last "when" is what matters. There are two gears:

- **Just operating (low ceremony).** A quick question or a one-line edit doesn't spin up any machinery, the orchestrator just does it. You don't pay a ceremony tax for small work.
- **Running a workflow (high ceremony).** The round engine (spawning workers, independent verification, the whole discipline) is *triggered, not boot-default.* It fires only when a piece of work is worth it.

The six skills at a glance:

| Skill | What it does |
|---|---|
| **`tpm-session`** | Session lifecycle: boot/open, mid-session checkpoint (save), close/wrap-up, `info` status. The orchestrator's boot; a bare call is state-aware (not open → open, open → save). |
| **`tpm-task`** | A lightweight, hand-editable markdown **task ledger** shared by you and Claude. Modes: `add` · `import` · `export` · `list` · `show` · `edit` · `check` · `add-subtask` · `start` · `finish` · `drop` · `remove` · `reopen`. Not a real issue tracker - keep it skimmable. |
| **`tpm-workflow`** | The front door over the **formal multi-agent round/epic lifecycle** - plan a round, spawn workers/verifiers, verify an artifact, reconcile and close an epic. A thin router that delegates spawning to the two below. |
| **`tpm-spawn`** | Spawn a **single** subagent - builder, researcher, verifier, planner, test-writer, documentarian, or bug-fixer. |
| **`tpm-spawn-team`** | Spawn a **team** (2+) - a named team (`full` / `ship` / `build` / `test` / `docs` / `research`) or a freeform ordered roster with counts and a serial/parallel run mode. |
| **`tpm-reap`** | Safe cleanup of stray subagents / subshells / runaway scripts left after a round or an abort. Enumerate → explicit choice → double-confirm for "all". **Never auto-kills.** |

Slash commands work as both the short `/tpm-*` form and the namespaced `/claude-tpm:tpm-*`.

## More detail

Under the skills sits the `tpm` CLI: `tpm <suite> <verb> [args…]`, where `tools/tpm.js` is a dumb top dispatcher that forwards to a per-suite router. The four suites are `session` · `task` · `workflow` · `hooks`, plus the flat consumer aliases `install` · `uninstall` · `doctor`. A taste of the real verbs:

```bash
npx tpm session config --modules   # dump which modules are ON/OFF (JSON)
npx tpm task list                  # show the open tasks
npx tpm workflow doctor            # workflow-side health check
```

When a task *does* earn a formal round, you pick from six built-in teams. The array order is the run order:

| Team | Shape | When |
|---|---|---|
| `full` *(default)* | planning → builder → test-writer → documentarian → verifier | the complete separated-concerns round |
| `ship` | builder → verifier | builder wears all hats, then verify |
| `build` | builder | a quick, unverified build |
| `test` | test-writer → verifier | add tests to delivered code |
| `docs` | documentarian → verifier | add docs to delivered code |
| `research` | researcher | a one-off info-gathering pass |

Any team with a verifier runs a bounded verify↔bug-fixer loop on a FAIL (capped, default 5 rounds). Configuration lives in one file, `.claude/claude-tpm/config.json`. Every module is on by default with sensible built-ins, so you only add config to *change* something. The exhaustive CLI verb tables and every config knob are in the [Technical details](docs/technical.md) doc; a fully worked config example lives in the [config guide](claude-context/config-guide.md).

## Caveats & gotchas

- **It rides entirely on the Claude Code CLI.** claude-tpm *is* a Claude Code plugin. No `claude` on your PATH, nothing to plug into.
- **It grafts onto an existing project - it won't create one.** You need a repo with a `package.json` first.
- **Distribution is local-bundle only right now.** No working `git clone` / `npm install @codercowboy/claude-tpm` from the registry yet (coming soon). You install from a copy of the bundle on disk.
- **`hygiene` and `motd` are planned, not shipped.** Both modules are named in the design, but `hygiene`'s config is still being finalized and there's no shipped implementation for `motd` yet. Don't count on either working today.
- **v0.1.0, Mac-first, works-on-my-machine.** No pinned minimum Node version and no cross-platform test pass. <!-- TODO: confirm minimum Node version and OS support -->

## Why it works

A few design ideas do the heavy lifting, and they're worth a paragraph each in the deep-dive:

- **Module opacity** - a *disabled* module costs zero context. Its concept leaves no residual awareness in the orchestrator at all, because awareness is behavior: an orchestrator that knows charters exist reaches for them, one that's never heard of them just operates.
- **Reading lists as the single source of truth** - what each role reads is defined once, in a manifest the linter parses directly, so docs and enforcement literally can't drift.
- **Charter secrecy** - every round runs under exactly one posture (ship a working artifact *or* produce durable knowledge), and a worker must never learn the other exists.
- **The verify↔bug-fixer loop** and **asymmetric trust** - the orchestrator is user-facing and self-correcting so it's trusted lightly; subagents are user-invisible so their output gets a critical eye. Verification exists because the work happened where you couldn't see it.

The full deep-dive is in **[Technical details](docs/technical.md)**: architecture, the CLI dispatcher, the module model, plugin/marketplace mechanics, the two PreToolUse hooks, plus the **dependency breakdown (zero npm dependencies) and the build toolkit**.

## Alternatives

claude-tpm is one way to make Claude Code behave like an organized program office, and for a lot of people it isn't the right way. The closest cousin is **[Superpowers](https://github.com/obra/superpowers)** (Jesse Vincent's agentic-skills + TDD methodology). If you want the most established, most opinionated skills-plus-methodology framework with the biggest community, start there. Beyond it there's a whole map: heavyweight swarm orchestrators, cross-vendor agent frameworks, parallel-session runners, and the honest option that you may not need a framework at all (Claude Code's built-in subagents might be enough).

If claude-tpm isn't your fit, I'd rather you ship than be loyal. The **[Alternatives](docs/alternatives.md)** doc is my honest, linked map of the space with a "when to pick it instead" for each option.

## Resources

**Start here → [The Creator of Claude Code Teaches You How to Actually Use It](https://www.youtube.com/watch?v=jsoKH4Pvld0)** (Boris Cherny, 2026). If you watch one thing, watch this. The disarming TLDR: **just talk to it.** That sounds too simple, but it's the single most under-appreciated thing about Claude Code. A lot of the friction people hit comes from over-engineering prompts and process instead of having a conversation with the tool and letting it work. Everything in claude-tpm is scaffolding *around* that idea, not a replacement for it.

More from the same source:

- [Mastering Claude Code in 30 Minutes](https://www.youtube.com/watch?v=B_KAEqiC-0Q) - official Anthropic workshop with Boris; a fast, practical tour.
- [How Boris Uses Claude Code](https://howborisusesclaudecode.com/) - a collected set of his tips and habits (running multiple instances, notifications, and the like).
- [Claude Code documentation](https://code.claude.com/docs/en/overview) - the official docs.

## Credit

- **Code & docs - [Claude](https://claude.com/claude-code)** (Anthropic). Full transparency: Claude wrote nearly all of the code, the tools, and this documentation.
- **Concept & direction - [Jason Baker](https://github.com/codercowboy)**, the ideas guy. I decided what it should do and why, argued with Claude about the design, and drove the rounds.

## License

[MIT](LICENSE) - it's a great license because it gets out of your way: use it however you want, commercial or not, just keep the notice. **MY CODE SHOULD WORK, BUT I'M NOT LIABLE IF IT GOES SIDEWAYS ON YOU.**

Questions, comments, kudos, criticisms — all welcome.
— Coder Cowboy
