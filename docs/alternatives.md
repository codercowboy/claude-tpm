# Alternatives & the wider world

[claude-tpm](https://github.com/codercowboy/claude-tpm) was built to help Claude Code
behave like a disciplined agentic engineer with the main session acting as the TPM (technical
program manager) that takes what I want, breaks it down, and hands the legwork to
researcher / worker / verifier subagents running in their own contexts. 

It's a **project-agnostic Claude Code plugin**: it grafts onto a repo you already have, 
it's lighter than the big swarm frameworks, and its task ledger is a plain markdown file that 
you and Claude can both hand-edit.

But it is very much *not* the only way to use claude, and for a lot of people it isn't the
right way. If something below fits your problem better, go use it. 

> **A note on honesty:** Claude compiled and verified this list with me (researched and verified
> 2026-09-15). I've dropped anything I couldn't confirm actually exists, caveated the shaky
> claims, and left out every "XXk stars" number: those figures in the wild almost
> all come from SEO blogs and summarizers, not real repo pages, so I don't trust them and neither
> should you. The method note and the full source list are at the bottom.

---

## 1. The closest analogs — Claude Code-native orchestration & methodology

These are the tools doing very nearly the same job as claude-tpm: making Claude Code work as an
organized, multi-step, sometimes multi-agent system rather than one improvising session.

- **[Superpowers](https://github.com/obra/superpowers)** - the headline analog, and the one I'll
  be most generous to. Jesse Vincent's agentic-skills framework plus a real software-development
  methodology for Claude Code, heavy on test-driven development and systematic planning. Its
  community skills live in a separate repo,
  **[obra/superpowers-skills](https://github.com/obra/superpowers-skills)**, which is now
  **archived / read-only (as of Oct 2025)** - worth knowing before you build on it. Install via
  `/plugin install superpowers@claude-plugins-official`.
  **Pick it instead when:** you want the most established, most opinionated skills-plus-TDD
  methodology with the biggest community, and you're happy adopting its whole workflow rather than
  claude-tpm's lighter orchestrator + session/task model.

- **[Claude Flow / ruflo](https://github.com/ruvnet/ruflo)** (Reuven Cohen / ruvnet) - heads up
  on churn: this was `ruvnet/claude-flow` and got **renamed to `ruflo`** (the npm package and CLI
  are still `claude-flow`). It's a heavyweight "hive-mind" swarm orchestrator: a Queen agent over
  worker agents, SQLite shared memory, an MCP tool suite, the SPARC method.
  **Pick it instead when:** you need large-scale parallel swarms with persistent, auditable shared
  memory and enterprise-scale coordination. claude-tpm is intentionally lighter than this.

- **[BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD)** - the "Breakthrough Method for
  Agile AI-Driven Development." Role agents (Analyst, PM, Architect, Scrum Master, Dev) that
  produce PRDs, architecture docs, and context-rich story files.
  **Pick it instead when:** you want a full agile SDLC ceremony with document artifacts across
  tools, not just an orchestration harness living inside Claude Code.

- **[Task Master](https://github.com/eyaltoledano/claude-task-master)** (`claude-task-master`,
  Eyal Toledano) - AI task management that parses a PRD into tracked, dependency-aware tasks and
  subtasks, with MCP integration for Cursor, Windsurf, Roo, and friends, across multiple model
  providers. It's the closest analog to claude-tpm's own `tpm-task` ledger.
  **Pick it instead when:** your core need is durable PRD-to-task tracking across many editors.
  claude-tpm's `tpm-task` is lightweight and hand-editable: a skimmable to-do list,
  not a real tracker.

- **[SuperClaude Framework](https://github.com/SuperClaude-Org/SuperClaude_Framework)** - a
  configuration framework that adds ~30 slash commands, cognitive personas/agents, behavioral
  modes, and optional MCP servers (installs via pipx / PyPI).
  **Pick it instead when:** you want a broad menu of prebuilt commands and personas out of the
  box, rather than claude-tpm's tighter orchestrator + subagent role model.

- **[Agent OS](https://github.com/buildermethods/agent-os)** (Builder Methods / Brian Casel;
  [homepage](https://buildermethods.com/agent-os)) - a spec-driven development system that injects
  your codebase standards and shapes specs so any AI coding agent (Claude Code, Cursor,
  Antigravity) writes to-spec code.
  **Pick it instead when:** your pain is spec quality and consistent codebase standards *across*
  tools, not multi-agent orchestration inside Claude Code specifically.

---

## 2. The broader ecosystem — not Claude-specific

Zoom out and there's a whole lane of language-level, cross-vendor agent frameworks. These aren't
Claude Code plugins. They're libraries you build *with*, in your own codebase, against whatever
model you like.

- **[CrewAI](https://github.com/crewAIInc/crewAI)** - a Python framework for role-playing
  autonomous multi-agent "Crews" plus event-driven "Flows." Production-oriented and
  model-agnostic.
  **Pick it instead when:** you're building a standalone multi-agent app in code (any LLM), not
  augmenting Claude Code sessions.

- **[Microsoft AutoGen](https://github.com/microsoft/autogen) / [AG2](https://github.com/ag2ai/ag2)**
  - a programming framework for multi-agent conversation and orchestration with tool use and
  human-in-the-loop. More churn to flag: Microsoft's AutoGen is now in **maintenance mode**
  (merging with Semantic Kernel into the "Microsoft Agent Framework"), and **AG2** is the active
  community fork.
  **Pick it instead when:** you want a research-grade / enterprise Python multi-agent conversation
  framework independent of Claude Code. Just go in eyes-open about the maintenance-mode and rename
  situation.

- **[LangGraph](https://github.com/langchain-ai/langgraph)** (LangChain;
  [docs](https://docs.langchain.com/oss/python/langgraph/overview)) - a low-level, graph-based
  orchestration library (Python/TS, MIT) for stateful, long-running agents with persistence and
  human oversight.
  **Pick it instead when:** you need fine-grained, resumable, stateful control flow in your own
  codebase. This is far lower-level than claude-tpm: you're wiring the graph yourself.

---

## 3. Adjacent — parallel-session runners

Different niche, near neighbor: these run *several* coding agents in parallel, each isolated in
its own git worktree. They're session multiplexers, not methodologies. They answer "how do I
supervise five agents at once," where claude-tpm answers "how does one session stay disciplined."
Plenty of people pair the two.

- **[Claude Squad](https://github.com/smtg-ai/claude-squad)**
  ([homepage](https://smtg-ai.github.io/claude-squad/)) - a terminal (TUI) app managing multiple
  AI terminal agents (Claude Code, Codex, Aider, …) in isolated tmux sessions and git worktrees.
  **Pick it instead when:** you just want to run several agents in parallel from the terminal.

- **[Conductor](https://www.conductor.build/)** (Melty Labs) - a free macOS app that runs
  parallel Claude Code / Codex agents, each in an isolated git worktree, with chat, live diff, and
  terminal panels.
  **Pick it instead when:** you want a polished Mac GUI for supervising parallel agents and their
  diffs, rather than an in-CLI harness.

- **[Crystal](https://github.com/stravu/crystal)** (Stravu) - same idea as Conductor: a desktop
  app running multiple Claude Code / Codex sessions in parallel worktrees to compare approaches.
  **But it's deprecated.** As of Feb 2026 it's been renamed/replaced by **Nimbalyst**, so if this
  niche is your fit, chase down Nimbalyst for active support rather than starting on Crystal.
  **Pick it instead when:** same as Conductor, just don't build on the deprecated one.

---

## 4. Maybe you don't need a framework at all

The honest anchor. If your needs are simple, you may not need claude-tpm or any of the above.
Claude Code and the SDK already give you the primitives. claude-tpm exists because I wanted
*discipline and repeatable structure* on top of these, but for a lot of work the built-ins are
enough. Start here before you reach for a framework.

- **[Claude Code built-in subagents](https://code.claude.com/docs/en/sub-agents)** - native
  subagents defined as markdown files in `.claude/agents/` (with frontmatter), each with its own
  context and tools, plus built-in types like Explore. **This is the vanilla capability
  claude-tpm formalizes.** If you only need to hand off the occasional isolated task, you can do
  it right here with nothing installed.

- **[Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/subagents)** -
  [subagents docs](https://platform.claude.com/docs/en/agent-sdk/subagents),
  [Python SDK](https://github.com/anthropics/claude-agent-sdk-python), npm
  [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
  (renamed from the Claude Code SDK in late 2025).
  **Pick it instead when:** you want to roll your own thin orchestration or build a custom agent
  app. No plugin needed if your discipline is simple and you'd rather own the code.

---

## 5. The vanilla / official Anthropic resources

claude-tpm rides *on* this platform, so you should know the first-party ground it stands on.
These are the canonical, official sources. Bookmark them.

- **[Claude Code docs](https://code.claude.com/docs/en/overview)** - the official documentation
  ([product page](https://claude.com/product/claude-code); CLI repo
  [anthropics/claude-code](https://github.com/anthropics/claude-code)). Note the docs moved to
  `code.claude.com`; older `docs.anthropic.com/claude-code` links redirect here.

- **The official plugin + marketplace system** - how to
  [discover and install plugins](https://code.claude.com/docs/en/discover-plugins), how to
  [create and distribute a marketplace](https://code.claude.com/docs/en/plugin-marketplaces), and
  the official marketplace repo
  [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official)
  (`claude-plugins-official`, added automatically on your first interactive start). This is the
  platform claude-tpm is built on.

- **[anthropics/skills](https://github.com/anthropics/skills)** - Anthropic's official,
  source-available skills repo (Apache-2.0). Includes the document skills (docx / pdf / pptx /
  xlsx) and the Agent Skills spec and templates.

---

## 6. Community skill & plugin libraries / directories

Where to go browsing when you want *more* skills and plugins than anyone ships by default. These
are community-curated: quality varies, so bring a critical eye.

- **[ComposioHQ/awesome-claude-skills](https://github.com/ComposioHQ/awesome-claude-skills)** - a
  curated list of Claude Skills and plugins (plus a Composio connect-apps plugin).
- **[ComposioHQ/awesome-claude-plugins](https://github.com/ComposioHQ/awesome-claude-plugins)** -
  a curated Claude Code plugins list.
- **[travisvn/awesome-claude-skills](https://github.com/travisvn/awesome-claude-skills)** - an
  independent curated Claude Skills list.
- **[jimmc414/claude-code-plugin-marketplace](https://github.com/jimmc414/claude-code-plugin-marketplace)**
  - a community-maintained marketplace of plugins, skills, agents, and hooks, with import/export.
- **[ClaudeMarketplaces.com](https://claudemarketplaces.com/)**
  ([repo](https://github.com/mertbuilds/claudemarketplaces.com)) - a directory that auto-crawls
  GitHub for `.claude-plugin/marketplace.json` files, plus MCP servers.
- **[agentskills.io](https://github.com/agentskills/agentskills)** - the Agent Skills standard /
  spec and `SKILL.md` format. **Caveat:** the spec and format do exist, but I couldn't
  verify the breadth-and-adoption claims floating around ("20+ platforms," "OpenAI added it"):
  those are blog-sourced, so treat them as unconfirmed. I'm only vouching for the spec's
  existence.

<!-- Deliberately omitted: "Antigravity Awesome Skills" — no clear canonical owner; many
near-identical repos under that name with wildly different contents and inflated star claims, so
I can't point you at a trustworthy one. And affaan-m/everything-claude-code exists
(https://github.com/affaan-m/everything-claude-code, redirects to affaan-m/ECC), but the "82k
stars / hackathon winner / most-starred" claims are blog-sourced and unverified, so I've left it
out of the featured list rather than repeat numbers I can't stand behind. -->

---

## 7. Communities — where people go deeper

If you want to argue methodology, get unstuck, or just watch the space move, these are the
gathering spots.

- **[r/ClaudeAI](https://www.reddit.com/r/ClaudeAI/)** - the primary Claude subreddit.
- **[r/AI_Agents](https://www.reddit.com/r/AI_Agents/)** - multi-agent systems and agent
  frameworks.
- **[r/LLMDevs](https://www.reddit.com/r/LLMDevs/)** - building with LLMs, developer-focused.
- **[r/LocalLLaMA](https://www.reddit.com/r/LocalLLaMA/)** - the local-model crowd (adjacent, but
  a great community).
- **[r/ChatGPTCoding](https://www.reddit.com/r/ChatGPTCoding/)** - AI-assisted coding across
  tools.
- **[r/vibecoding](https://www.reddit.com/r/vibecoding/)** - the vibe-coding scene.
- **The official Anthropic / Claude Developers Discord** - reachable via
  **[claude.com/community](https://claude.com/community)**. (I'm *not* pasting a
  direct invite link: invite URLs rot, and I'd rather send you to the official front door that
  stays current.)
- **[Hacker News](https://news.ycombinator.com/)** - where a lot of these tools get their first
  serious kicking-of-the-tires.

<!-- r/ClaudeCode is referenced in community roundups but I couldn't load the sub to confirm it,
so I've left it off rather than feature an unverified community. -->

---

## How this list was compiled / Sources

Claude and I researched and verified this list on **2026-09-15**. Method, in short: every
alternative, library, community, and link was confirmed to actually exist by loading its real page
where possible; each entry carries a canonical link (repo or official homepage) and an honest
"when to pick it instead." **GitHub star counts are omitted** as unreliable: the
figures in the wild come from SEO blogs and fetch summarizers, not trusted repo pages. Anything I
couldn't confirm was **dropped or clearly caveated** (see the omission notes above), and renamed /
archived / deprecated projects are flagged with their successors. Reddit blocks direct fetching in
our research environment, so subreddit existence was confirmed via secondary roundups rather than
by loading each sub page.

**Pages consulted**

Actually loaded / fetched:
- https://github.com/obra/superpowers
- https://github.com/obra/superpowers-skills
- https://github.com/eyaltoledano/claude-task-master
- https://github.com/anthropics/skills
- https://github.com/travisvn/awesome-claude-skills
- https://github.com/jimmc414/claude-code-plugin-marketplace
- https://github.com/ruvnet/claude-flow (redirect → ruvnet/ruflo)
- (Reddit fetches attempted and blocked: r/ClaudeCode, r/vibecoding, r/ClaudeAI)

Search-derived / surfaced (canonical URL captured; verify again if you quote them):
- https://github.com/bmad-code-org/BMAD-METHOD
- https://github.com/SuperClaude-Org/SuperClaude_Framework
- https://github.com/buildermethods/agent-os · https://buildermethods.com/agent-os
- https://github.com/crewAIInc/crewAI
- https://github.com/microsoft/autogen · https://github.com/ag2ai/ag2
- https://github.com/langchain-ai/langgraph · https://docs.langchain.com/oss/python/langgraph/overview
- https://github.com/smtg-ai/claude-squad · https://www.conductor.build/ · https://github.com/stravu/crystal
- https://code.claude.com/docs/en/sub-agents · https://code.claude.com/docs/en/overview · https://code.claude.com/docs/en/discover-plugins · https://code.claude.com/docs/en/plugin-marketplaces
- https://platform.claude.com/docs/en/agent-sdk/subagents · https://github.com/anthropics/claude-agent-sdk-python · https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk
- https://github.com/anthropics/claude-plugins-official
- https://github.com/ComposioHQ/awesome-claude-skills · https://github.com/ComposioHQ/awesome-claude-plugins
- https://claudemarketplaces.com/ · https://github.com/mertbuilds/claudemarketplaces.com
- https://github.com/agentskills/agentskills
- https://github.com/affaan-m/everything-claude-code (→ affaan-m/ECC)
- https://claude.com/community · https://news.ycombinator.com/

Questions, comments, kudos, criticisms — all welcome, and if I've mischaracterized your tool, tell
me and I'll fix it.
— Coder Cowboy
