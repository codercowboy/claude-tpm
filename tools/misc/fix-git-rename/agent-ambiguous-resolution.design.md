# Agent-driven resolution of ambiguous references — process design

> **Status:** design, revised after a 3-round opus review. This is the "3rd mechanism" referenced in
> `tpm-fix-git-rename-refs.design.md` §15: the tool fixes what is *provable*; this process uses **Claude
> agents** to resolve what the tool deliberately leaves **Ambiguous**, using reading-comprehension a
> regex tool can't and shouldn't attempt. Guiding value, inherited from the tool: **never silently
> corrupt a valid reference.** Companion eval/test spec: `agent-ambiguous-resolution.eval-design.md`.

---

## 1. Purpose & division of labor

`tpm-fix-git-rename-refs` rewrites only references it can *prove* point at a renamed file. It refuses
the rest — bare basenames, variable-prefixed paths, extensionless specifiers, bare dir-move mentions —
because a blind swap could corrupt a valid reference. That refusal is correct, but a *reader* can often
resolve those from context.

**Motivating example (real).** A `tpm-session` skill file says on one line `run path/to/somescript.js
--flag`, then a few lines later, in prose, `…then somescript.js writes the notes.` The tool flags the
bare `somescript.js` as Ambiguous and won't touch it. A human — or a Claude — reads the two lines,
sees they're the same file, and knows the bare one must be updated too. **That contextual inference is
this process's entire job.** We will not teach the tool this; we route it to agents.

**DONE is worklist-scoped, not repo-clean.** This process only ever addresses items the tool put in its
Ambiguous worklist. That worklist is bounded by the tool's own blind spots (non-JS extensionless refs,
refs inside binary/vendored/generated files, path-like strings the tool never detected as references).
So "done" means **the tool's residue is dispositioned**, never "the repo is reference-clean." The
uncovered classes are recorded as a known residual (§8), not silently implied away.

---

## 2. Preconditions & the go/no-go gate

Before any agent is spawned:
1. **Provable pass applied first.** Run the tool's `fix` (no `--force`) so agents work only on the
   residue and can use already-corrected sibling references as corroborating evidence.
2. **`--force` is forbidden on this set.** The blind basename swap and this careful process target the
   *same* Ambiguous items; running both double-edits/corrupts. Never `--force` items routed here.
3. **Freeze the working tree for the run** — a dedicated branch / advisory lock. The worklist is
   generated once; a long fleet run must not race concurrent commits. If the tree changed since the
   worklist was generated, abort and regenerate.
4. **Record the exact tool invocation** (verb, flags, `--scan-root`, status file) that produced the
   worklist; the end-of-run confirmation (§8) must re-run with the *identical* scope or counts won't
   reconcile.
5. **Go/no-go ROI gate.** Agent resolution costs ≥2 model calls/item plus verification. Run agents only
   when the pile is large enough and the expected-resolvable fraction high enough; otherwise
   **bulk-escalate the whole pile to humans**. (Thresholds are tuning knobs; the gate itself is
   mandatory — don't spin up a fleet to resolve a handful of mostly-dir-move items.)

---

## 3. The worklist contract

The process consumes the tool's `--json` ambiguous worklist. Each item carries:
- `itemId` — a **content-anchored** key: `file` + normalized matched token + a hash of a surrounding
  context window. **Stable across line-number shifts** (edits move lines), so it survives resume, dedup,
  suppression (tool §18.1), and audit. **Not** `{file, line}` alone.
- `file`, and **occurrence-level addressing**: `{ line, col }` or `{ line, occurrence-index }` — a bare
  basename recurs many times per line/file, so `{file,line}` is not enough to edit safely.
- `matchedText`, and a `contextWindow` (inlined bytes the resolver starts from — treated as DATA, §7).
- `category` — ambiguous-bare / variable / extensionless / dir-move.
- `candidates[]` — the one-or-more `OLD -> NEW` rename entries whose basename matches (plural for
  collisions). Provable and Ignored items are **excluded** from this list by construction.

The tool emits `itemId` from `identify` in Phase 1 so ids are stable from day one.

---

## 4. Roles & the loop

A **resolver → verifier** loop, orchestrated, with a human backstop.

### 4.1 Orchestrator
Generates the worklist; runs the go/no-go gate; **partitions per file** (context is local) with
on-demand named-neighbor reads; spawns resolvers, collects proposals; spawns verifiers; **applies only
verified-ACCEPTED edits via the tool's `apply-plan` mode** (§6), one commit per batch; maintains the
run-state ledger (§10); emits the disposition report + scorecard (§9); runs the end-of-run confirmation.

### 4.2 Resolver (proposes only; never edits)
For each item, read the referencing file (and *bounded, explicit-path* neighbors — never repo-wide
grep) and choose:
- **RESOLVE →** it refers to renamed file `X` (for a collision, **which** of the N candidates), with an
  edit `{itemId, anchor, oldText, newText}` and **cited local evidence**.
- **LEAVE →** it does not refer to a renamed file (e.g. a same-named third-party file), with reason.
- **ESCALATE →** insufficient context to decide safely, with the escalation-quality record (§5).

### 4.3 Verifier (independent — enforced, not asserted)
- **Re-derives the target from raw context first**, then ACCEPTs only if it reaches the *same* target —
  it does not merely grade the resolver's citation (that rubber-stamps plausible-but-wrong).
- Runs with tier **≥** the resolver; the resolver's evidence narrative is withheld on first pass.
- Rejects overreach; audits LEAVE for false-negatives; verdict **ACCEPT / REJECT / ESCALATE**.
- Only ACCEPT is applied. REJECT → one bounded re-work, then auto-ESCALATE (§10).

---

## 5. Decision rules

**Evidence bar — an enumerated checklist, not adjectives.**
*Counts as evidence:* an adjacent explicit path in the same command/section that the provable pass
already rewrote; an import/require of the same stem in the same file; an unambiguous nearby heading or
usage binding the mention to a specific file.
*Does NOT count:* basename equality anywhere else in the repo; **the rename map's mere existence** (a
name was renamed *somewhere* is NOT evidence — this is the exact corruption the tool refused); plausible
but uncited inference.

**Multi-candidate (collision).** When `candidates[]` has >1 entry, the resolver must pick **which** and
cite evidence that disambiguates *among the candidates*, not just that it's a renamed file. If the
chosen candidate is a **dir-move (basename unchanged)**, a bare mention is unfixable by definition →
LEAVE/ESCALATE.

**Dir-move bare mentions** are usually LEAVE/ESCALATE (fixing means inventing a whole path, which we
forbid); only a mention sitting inside a resolvable rooted/relative path is fixable.

**Rigor scales on two axes:** *difficulty* (single-file same-instruction is near-mechanical; cross-file
/ collision / dir-move gets full loop) **and** *blast-radius of the target file* (a wrong edit in prose
is low-harm and human-visible; a wrong edit in executable config / a machine-consumed manifest can
silently break a build → higher evidence bar, deeper verification, or force-ESCALATE).

**Escalation quality bar.** Every ESCALATE must state *what specific evidence was sought, why it's
missing, and what input would resolve it*. The verifier rejects content-free escalations; per-resolver
escalation rate is a tracked metric (§9). This stops ESCALATE from being a lazy resolver's free pass.

---

## 6. Apply mechanism

Applied **only** through the tool's **`apply-plan` mode** (tool §18), whose assertion is against the
resolver's **explicit expected text**, not the rename map — the only safe way to express a bare-basename
edit. Each applied edit therefore gets: expected-text match at the addressed occurrence, **`if_version`
staleness pin** (`expectHash`), byte-exact preservation (line-endings / final newline / BOM), the
`.tmp` snapshot + cleanup-only-ours, never-follow-symlinks, new-target-exists lint, and **single-writer**
application (serialize edits even when resolve/verify ran in parallel — two batches touching one file is
a lost-update hazard).

- **One git commit per apply-batch** (per file), with the disposition ids in the message → a bad batch
  is one `git revert`. This makes "git is the backstop" (tool Decision H) actionable.
- **Framework-critical / self-modifying paths are force-ESCALATED**, never auto-applied (§7).
- Apply is **single-writer and ordered** (longest-OLD-path-first within a file; never re-match a
  freshly written token — inherited from the tool).

---

## 7. Safety & threat model

- **Prompt injection (the biggest risk).** The resolver's primary input is *untrusted repo text*; a
  file (or a worklist snippet, which is repo-derived) may contain instruction-shaped text or fabricated
  "evidence." **All file content and worklist snippets are DATA, never instructions.** The verifier
  re-derives evidence from source rather than trusting the resolver's quoted snippet. Spawn prompts say
  this explicitly.
- **Secrets / PII.** Resolvers read whole files + neighbors, and the disposition report quotes snippets
  as evidence — which then get committed and sent to a model provider. Quote the **minimum** token +
  line ref, scrub obvious secrets, and acknowledge that context reads expose sensitive content.
- **Self-modification / live framework.** Editing skills / `boot.md` / methodology / reading-lists
  *mid-run* can break the running orchestrator and its own subagents. Framework-critical paths →
  force-ESCALATE, or operate on a frozen branch and reload the framework only after.

---

## 8. Definition of DONE

DONE when **every worklist item has a final disposition** and the repo is provably un-corrupted for the
resolvable classes:
1. Every item is `FIXED` (applied + verifier-ACCEPTED), `LEFT` (reason recorded), or `ESCALATED`
   (reason + quality record). Zero undecided.
2. Every FIXED edit is minimal + byte-exact, ACCEPTED by an independent verifier, and rewrites to a
   target that exists.
3. **Re-run `identify` with the recorded scope**: FIXED *resolvable* items gone, and **no new broken
   *resolvable* references** introduced. ⚠ **The tool cannot detect a bare ref as broken** (nothing to
   resolve against), so it can neither confirm a correct bare-ref fix nor catch a wrong one. **All
   assurance for bare-ref RESOLVEs rests on the independent verifier + the gold set** (§12), not the
   tool. Say this plainly; don't let DoD imply the tool validated the core output.
4. Audit trail exists (§9, §11).
5. Nothing guessed — each FIXED rests on cited, checkable evidence; anything short is LEFT/ESCALATED.

DONE does **not** require zero ESCALATED items — a clean, well-justified hand-off to a human IS success.
**Known residual (not covered):** references the tool never surfaced (non-JS extensionless, binary/
vendored/generated files, undetected path-like strings). Recorded, not implied away.

---

## 9. Outputs

- **Disposition report** (human + `--json`): per item — `itemId`, file, category, disposition, chosen
  `OLD->NEW`, **content-anchored evidence** (quote the anchoring text, not a line number that will go
  stale), verifier verdict, model + process version (§11).
- **Run-level scorecard** (reported to the user): resolve rate, escalation rate, verifier-reject rate,
  sampled human-agreement, cost per resolved item, and residue delta vs. pre-run. Answers "did this
  help?"
- **Escalation package**: grouped by rename-target / file / category, **batch-decidable** ("all bare
  `foo.js` under `docs/` → target X"), where the human's decision is a **structured record keyed to the
  itemId, consumed by the same `apply-plan` rails** — never a free-hand edit (that's the failure mode
  this process exists to prevent).
- **Suppression file** for the tool's `--fail-on-ambiguous` gate (tool §18.1), so LEFT/ESCALATED items
  don't re-trip CI after a clean run.

---

## 10. Failure modes & recovery

- **Malformed / crashed resolver output → ESCALATE** (never silently drop).
- **Resolver↔verifier deadlock** (propose→reject→propose) → bounded to **1 re-work**, then auto-ESCALATE.
- **Verifier-ACCEPTED edit fails the `apply-plan` assertion at apply time** (stale / oldText not unique)
  → auto-ESCALATE; never force.
- **Resumability:** a run-state ledger keyed by `itemId` records each item's disposition; a re-run is
  naturally incremental (a crash loses one batch, not the run). Line-shift-proof because the key is
  content-anchored (§3).
- **Per-batch revert:** commits are the recovery unit (§6).
- **Retry / cost budgets:** default retry = 1; batch + run token ceilings with a pre-flight estimate
  before spawning the fleet.

---

## 11. Determinism & auditability

LLM dispositions are **not reproducible** — re-running yields different answers. So the audit artifact
records, per decision: the **model id/version**, the **process/prompt version**, and the **exact inputs
seen** (context bytes / anchoring text), making each decision *attributable and re-examinable* even if
not bit-reproducible. State this limitation explicitly rather than implying determinism. Evidence in the
record is **content-anchored** (quoted text + `itemId`), so an auditor months later can still locate it
after lines have shifted. Long runs emit a **heartbeat + incremental persistence** so an operator can
see progress and a crash costs one batch.

---

## 12. Production-readiness bar, eval, and a worked trace

**Production-readiness (distinct from per-run DONE).** Before auto-apply is trusted (semi-)unattended:
a **gold-set precision/recall floor** (esp. a low false-resolution rate), a max verifier-reject-after-
human-review rate, and a human-agreement threshold on a sampled audit. Until then, run **propose-only**
(resolve + verify + report, apply nothing — the analog of `fix --dry`).

**Companion eval/test-design doc** (`agent-ambiguous-resolution.eval-design.md`): fixtured ambiguous
scenarios with known-correct dispositions, adversarial traps (bare ref to a *different* same-named file;
circular "evidence"), prompt-injection fixtures, and a decision→check matrix — the home for the gold set.

**Worked trace (one item, end to end).**
1. Worklist item: `{itemId: "sha…", file: "skills/tpm-session/SKILL.md", anchor:{line:17,occurrence:1},
   matchedText:"somescript.js", category:"ambiguous-bare", candidates:[{old:"path/to/somescript.js",
   new:"path/to/tpm-somescript.js"}]}`.
2. Resolver reads the file, sees line 12 `run path/to/somescript.js` (already rewritten by the provable
   pass to `path/to/tpm-somescript.js`), cites it → RESOLVE, edit `oldText:"somescript.js"` →
   `newText:"tpm-somescript.js"` at line 17 occ 1, `expectHash:…`.
3. Verifier re-derives from raw context, independently reaches the same target → ACCEPT.
4. Orchestrator writes a one-edit `apply-plan`; the tool asserts expected-text + hash, applies
   byte-exact, snapshots, commits the batch.
5. End-of-run `identify` (recorded scope) shows no new resolvable breakage; disposition report logs
   FIXED with the quoted line-12 evidence, model + process version.

---

## 13. Relationship to the tool & versioning

- This process **consumes** the tool's ambiguous worklist and is the home for everything the tool marks
  Ambiguous or unfixable-Dir-move. The tool stays dumb, fast, safe; judgment lives here, with a human
  backstop. Breadcrumb from the tool spec: §15; apply path: tool §18; suppression: tool §18.1.
- **Known-variable expansion belongs in the tool, not here.** A `${FOO}` with a *known, stable* value
  is deterministically resolvable — that should be a new **Provable-tier input to the tool** (a config
  expansion table), keeping the tool's guarantee and leaving agents only genuine comprehension. (Split
  the §-old "genericity" question: expansion → tool; comprehension → process.)
- **Version the process itself.** Stamp a process/prompt version on every disposition report so runs are
  comparable and behavior changes are attributable.

---

## 14. Still genuinely open (tuning, not blockers)

- Exact go/no-go thresholds (pile size, expected-resolvable %) and retry/cost ceilings.
- How much neighbor context to allow before the cost outweighs the benefit.
- Whether easy single-file same-instruction items get a lighter (resolver + audit-sample) path vs. the
  full loop — independence is the real guard, so keep full review for anything not single-file/single-
  instruction identity.
- Charter binding specifics when run inside claude-tpm orchestration (bind to the **shipping** charter —
  it produces corrected files, not a write-up; spawn via `spawn-subagent`; lint prompts; workers get
  only the worklist + scoped repo read access, nothing orchestrator-only).
