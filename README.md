# claude-tpm

`claude-tpm` turns a [Claude Code](https://claude.com/claude-code) session into a disciplined multi-agent end-to-end SDLC system. The system keeps Claude on track from session to session via formalized structured session notes and handoff documents, and it mechanically ensures subagent workflows deliver completed, accurate work along with accompanying unit test coverage and documentation. 

## Who can use claude-tpm?

`claude-tpm` is intended as a SDLC (software development lifecycle) management framework, but it is task-agnostic. You can use `claude-tpm` in any project that requires claude to understand the project's direction from session to session and deliver work reliably.

**Who it's not for:** anyone who wants a GUI or a one-click app, and anyone looking to *replace* talking to Claude. This is scaffolding *around* the "just talk to it" core (see [Resources](#resources)), not a substitute for it. If it doesn't sound like your fit, the [Alternatives](#alternatives) doc might point you somewhere better.

## How is it different?

`claude-tpm` is a light-weight opt-in SDLC framework that runs Claude Code like a small engineering team. The claude agent you talk to, the orchestrator, is the **Technical Program Manager** (aka 'TPM') or lead engineer. The orchestrator takes intent from you (the product owner), breaks the work down, delegates pieces to subagents running in isolated contexts, checks their output, integrates it, and reports back.

Many alternatives to `claude-tpm` exist, with various popular options to consider documented in this project's [Alternatives](docs/alternatives.md) document. `claude-tpm` differs from many popular approaches in several ways:

- Workflows (invoked with `/tpm-workflow`) ensure subagents remain focused and reliably deliver their work via independent per-agent charters. For example, a `builder` subagent might build a software tool or fix a bug for you, and it can be followed by an adversarial `verifier` subagent coupled with `fixing` agents to ensure the delivered result matches your intentions.
- `claude-tpm's` session skill (`/tpm-session`) provides session management, which allows claude to seamlessly pick up where it left off in a previous session via formalized session notes ledgers, task punchlists, and handoff documents. 
- `claude-tpm` also provides a lightweight task management skill (`/tpm-task`) that allows you and claude to easily track and manage long-term progress. 

If you're curious about how any of this works, follow the install instructions below, boot a claude session, type `/tpm-session open`, and ask claude how `claude-tpm` works. 

Alternatively, if you're the rtfm type, consult the [`docs/user-guide.md`](docs/user-guide.md).

## History

`claude-tpm` is a framework that was organically developed and lifted out of months of real use and troubleshooting issues with claude's consistency while working on a variety of personal software projects. It was developed during the summer of 2026, when claude's [`opus`](https://www.anthropic.com/claude/opus) model 4.6/4.8 were the frontier models to work with. Though the framework is designed to specifically keep an `opus` 4.x orchestrator and accompanying subagents on task, the system has proven to work well for both [`fable`](https://www.anthropic.com/claude/fable) and [`sonnet`](https://www.anthropic.com/claude/sonnet) 5.x-era models in both orchestrator and subagent capacities as well. 

## Install

**Note:** `claude-tpm` is cross-platform, but installation instructions below have been tested and proven on `MacOS`. 

If the quick instructions below seem foreign to you, a detailed installation walkthrough - flags, verification, uninstall, and troubleshooting are detailed in [`docs/INSTALL.md`](docs/INSTALL.md).

Before you install, you'll need the following tools installed:

- [Node.js](https://nodejs.org)
- [npm](https://www.npmjs.com/)
- the [Claude Code](https://claude.com/claude-code) CLI (`claude`), and an existing project with a `package.json` (run `npm init -y` first if you don't have one).

After the tools above are installed, open the `terminal` MacOs app and install `claude-tpm` in your project with the following:

```
# ensure your terminal is running bash rather than another shell

> bash

# change the working folder to your project

> cd my-project

# if your project is not yet initialized to be a Node.js project, run this:
# note: this simply makes a file called 'package.json' that allows your project
# to automatically download and install claude-tpm, it does not REQUIRE your 
# project to be a Node.js product at all

> npm init -y

# add claude-tpm code as a dependency into your Node.js package.json file, 
# and install it in node_modules with this:

> npm install --save-optional github:codercowboy/claude-tpm

# execute this to install claude-tpm's claude plugin and skills in your project 

> npx tpm install .
```

The installer is interactive: it prints the exact command it's about to run and asks before it changes anything. Once claude-tpm is wired into a project, the `npx tpm …` can be used to manage your project's claude-tpm installtion:

```
npx tpm doctor .            # doctor — read-only, changes nothing
npx tpm install .           # re-run / repair
npx tpm uninstall .         # remove it
```

After installation, claude will be ready to use `claude-tpm` any time you want, but you don't have to use it every single session if you don't want to. Simply skip invoking the `/tpm-session open` skill.

## Using claude-tpm for the first time

In your terminal, ensure you're in the bash shell as you did during installation, `cd` into your project's directory, and start claude and run `/tpm-session open`:

```
claude

# inside claude's session, open claude-tpm session

/tpm-session open
```

When you invoke the session open skill, claude will show you what it's doing:

> I'll boot the session. First, let me load the open mode body and confirm the config/wiring in parallel.
> 
> Read modes-open.md, ran a command
> 
> Config confirms session.enabled and notes.enabled. Proceeding with the boot sequence — allocate/confirm session and read the module map.
> 
> Ran 2 commands
> 
> Session 019 is open (new). All four modules enabled. Now walking the core reading list fresh and loading prior state.
> 
> Read reading-list.md, ran a command
> 
> Now the Tier-1 core docs, the previous session notes, and tools index.
> 
> Read 4 files
> 
> Session 019 open — TPM engine booted. Reading chain walked (project-workspace · handbook · shared-conventions · prior notes · task queue).
> 
> Prior state (session 018, sealed): claude-tpm SHIPPED and verified — pushed to github.com/codercowboy/claude-tpm, 0.1.0 published, both install routes 9/9 doctor-clean. No open items; arc complete. Only optional leftovers: clear stale 0.2.0/tpm-baseball local plugin cache, and rm the gitignored tmp/dogfood-20260915 throwaways.
> 
> Available skills:
> 
> tpm-session → open / save / close / info session notes
> tpm-task → task ledger management
> tpm-workflow → run a formal multi-agent round/epic
> 
> Task queue: ~40 open, newest #1090 (GitHub-ready publish prep, 3/6) and #1088 (node xyz.js → npx docs).
> 
> You are in session 019 — claude-context/sessions/session-019/ (no session-notes.md yet; written on first save). SessionId 296ac893. 19 sessions total.
> 
> What are we working on?

Once claude is finished loading the `claude-tpm` framework, just talk to claude casually about it:

> hey claude, pretend i'm a brand new user who's never used claude-tpm before, can you tell me why I'd use it? what does it do?

Claude will respond hapilly and help you understand how to use `claude-tpm`, here's a typical response:

> Happy to. Here's the newcomer pitch for claude-tpm (TPM = Technical Program Manager).
> 
> It turns your main Claude Code session into an orchestrator — a project manager that holds state across sessions and coordinates fleets of subagents — instead of a single assistant that forgets everything when the window closes and spawns helpers ad-hoc. It ships as a Claude Code plugin delivering a handful of tpm-* skills.
> 
> The problems it solves:
> 
> If you do sustained, multi-session work with Claude Code, you hit these:
> 
> Context evaporates between sessions. You close the terminal and the next session starts cold — what you decided, what's half-done, what's next is all gone.
> 
> Multi-agent work is chaotic. Spawning subagents by hand means no consistent plan, no verification step, and strays left running.
> 
> Subagents drift. Point a worker at too much process context and it "reasons its way" into writing an elegant essay about why the task is hard instead of just doing it.
> 
> What it gives you:
> 
> Session lifecycle & memory (tpm-session) — open boots and loads prior state; save checkpoints durable notes; close wraps up. Your "where we are / what's next" survives across sessions in session-notes.md. This is the backbone.
> 
> A task ledger (tpm-task) — a lightweight, hand-editable shared to-do list you and Claude both read (add, list, start, finish, subtasks). Not a heavyweight issue tracker — just skimmable shared memory of work.
> 
> Structured multi-agent rounds (tpm-workflow, tpm-spawn, tpm-spawn-team) — plan a round, spawn workers verifiers/researchers with a real plan and defined roles, then reconcile their results. Repeatable instead of improvised.
> 
> Charters — a key trick: workers get a "shipping" charter (produce the artifact) and never learn a "research" charter exists, which keeps them building instead of philosophizing.
> 
> Cleanup (tpm-reap) — safely enumerate and kill stray subagents/scripts after a round, always with explicit confirmation.
> 
> Would you use it?
> 
> Yes, if you run long-lived, multi-step projects in Claude Code, want continuity across sessions, and coordinate several subagents at once.
> 
> Probably not yet, if you're doing quick one-off edits or single-shot questions — the ceremony isn't worth it there.
> 
> The mental model: Claude stops being a chat assistant and becomes a program manager for your project — one that remembers, tracks, delegates, verifies, and cleans up.
> 
> Want me to show a concrete example — e.g. boot a session, add a task, and run a small workflow — so you can see the loop in action?

## Use — the short version

Open a `claude` session in your installed project and you've got the `tpm-*` skills live. The minimal loop:

1. **`/tpm-session`** - initialize claude's awareness of the previous session's work and handoff.
2. **`/tpm-task`** - jot and track work in a plain, hand-editable markdown to-do list you and Claude both read.
3. **`/tpm-workflow`** - kick off a formal multi-agent round.

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

Under the skills sits the `tpm` CLI: `tpm <suite> <verb> [args…]`, where `tools/tpm.js` is a simple top-level dispatcher that forwards to a per-suite router. The four suites are `session` · `task` · `workflow` · `hooks`, plus the flat consumer aliases `install` · `uninstall` · `doctor`. A taste of the real verbs:

```bash
npx tpm session config --modules   # dump which modules are ON/OFF (JSON)
npx tpm task list                  # show open tasks
npx tpm workflow doctor            # workflow-side health check
```

When a workflow is run, you pick from six built-in teams. The array order is the run order:

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

- **`claude-tpm` rides entirely on the Claude Code CLI.** claude-tpm *is* a Claude Code plugin. No `claude` on your PATH, nothing to plug into.
- **It grafts onto an existing project - it won't create one.** You need a repo with a `package.json` first.
- **v0.1.0, Mac-first, works-on-my-machine.** No pinned minimum Node version and no cross-platform test pass has been performed yet, lmk if it works for you on windows!

## Why it works

- **Module opacity** - a *disabled* module (session / task / workflow) costs zero context tokens. Its concept leaves no residual awareness in the orchestrator at all, because awareness is behavior: an orchestrator that knows charters exist reaches for them, one that's never heard of them just operates.
- **Reading lists as the single source of truth** - what each role reads is defined once, in a manifest the linter parses directly, so docs and enforcement literally can't drift.
- **Charter secrecy** - every round runs under exactly one posture (ship a working artifact *or* produce durable knowledge), and subagents remain focused.
- **The verify↔bug-fixer loop** and **asymmetric trust** - the orchestrator is user-facing and self-correcting so it's trusted lightly; subagents are user-invisible so their output gets a critical eye. Verification exists because the work happened where you couldn't see it.

The full deep-dive is in **[Technical details](docs/technical.md)**: architecture, the CLI dispatcher, the module model, plugin/marketplace mechanics, the two PreToolUse hooks, plus the **dependency breakdown (zero npm dependencies) and the build toolkit**.

## Alternatives

`claude-tpm` is one way to make Claude Code behave, but there are many alternative options. The closest cousin is **[Superpowers](https://github.com/obra/superpowers)** (Jesse Vincent's agentic-skills + TDD methodology). If you want the most established, most opinionated skills-plus-methodology framework with the biggest community, start there. 

Beyond `Superpowers` there's a whole map: heavyweight swarm orchestrators, cross-vendor agent frameworks, parallel-session runners, and the honest option that you may not need a framework at all (Claude Code's built-in subagents might be enough).

The [Alternatives](docs/alternatives.md) doc lists many alternatives in the Claude SDLC space with a "when to pick it" for each option.

## Resources

**[The Creator of Claude Code Teaches You How to Actually Use It](https://www.youtube.com/watch?v=jsoKH4Pvld0)** (Boris Cherny, 2026). If you watch one thing, watch this. The disarming TLDR: **just talk to it.** That sounds too simple, but it's the single most under-appreciated thing about Claude Code. A lot of the friction people hit comes from over-engineering prompts and process instead of having a conversation with the tool and letting it work. Everything in claude-tpm is scaffolding *around* that idea, not a replacement for it.

More from Anthropic:

- [Mastering Claude Code in 30 Minutes](https://www.youtube.com/watch?v=B_KAEqiC-0Q) - official Anthropic workshop with Boris; a fast, practical tour.
- [How Boris Uses Claude Code](https://howborisusesclaudecode.com/) - a collected set of his tips and habits (running multiple instances, notifications, and the like).
- [Claude Code documentation](https://code.claude.com/docs/en/overview) - the official docs.

## Credit

- **Code & docs - [Claude](https://claude.com/claude-code)** (Anthropic). Full transparency: Claude wrote nearly all of the code, the tools, and this documentation.
- **Concept & direction - [Jason Baker](https://github.com/codercowboy)**, the ideas guy. I decided what it should do and why, argued with Claude about the design, and drove the rounds.

## License

[MIT](LICENSE) - it's a great license because it gets out of your way: use it however you want, commercial or not, just keep the notice. **MY CODE SHOULD WORK, BUT I'M NOT LIABLE IF IT GOES SIDEWAYS ON YOU.**

Questions, comments, kudos, criticisms are all welcome.