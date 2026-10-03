# Installing claude-tpm

claude-tpm adds a session ritual, a task ledger and formal multi-agent review rounds to a project you
already have. After install, a plain `claude` in that project has `/tpm-session`, `/tpm-task`,
`/tpm-workflow` and the other `tpm-*` commands from the first message of every session.

claude-tpm does not create a project. It adds itself to one that already has a `package.json`. It is
distributed from GitHub and from local folders, not from the public npm registry.

---

## Prerequisites

- Node.js and npm on your PATH (`node -v`, `npm -v`).
- The Claude Code CLI on your PATH (`claude --version`).
- A project with a `package.json`. If you don't have one, run `npm init -y` in the project folder first.
  The installer stops and says so if the file is missing.

---

## How it fits together

Three things happen when you install:

1. **A marketplace is registered, once per machine per version.** Claude Code needs a "marketplace" to know
   where a plugin lives. The installer registers one named `claude-tpm-market-<version>` (for example
   `claude-tpm-market-0.2.0-dev`) at user scope, pointing at the claude-tpm folder you installed from.
2. **The plugin is enabled per project.** The installer installs `claude-tpm@claude-tpm-market-<version>` at
   project scope, so only the projects you install into turn it on.
3. **The project gets a dependency so `npx tpm` works.** `npx tpm …` is what you type in a project shell.

The registered folder is the code that runs. Claude Code does not copy the plugin somewhere and run the
copy: it runs the skills, hooks and `bin/tpm` straight from that folder. So:

- **Edits to that folder are live.** Change a script and the next run uses it.
- **That folder must not move.** If you move or delete it, the plugin stops loading in every project that
  uses that version. Claude Code reports this as `cache-miss`, which is a misleading name: nothing is wrong
  with a cache, the folder is just gone. The doctor says "the folder was moved or deleted" instead. The fix
  is in [If you move the folder](#if-you-move-the-folder).

---

## Quick start: one project

Use this when one project uses claude-tpm. claude-tpm lives inside that project as a dependency.

```bash
cd my-project
npm install --save-dev github:codercowboy/claude-tpm
npx tpm install .
```

Run the `npm install` first. It puts a real `tpm` in `node_modules/.bin/`, so `npx tpm` runs this tool. If
you run `npx tpm` before the dependency exists, npx can download an unrelated package named `tpm` from the
npm registry and run that instead. It also walks UP the folder tree first and runs the first
`node_modules/.bin/tpm` it finds in a parent folder, which may be a different claude-tpm version. Either way it is
a silent wrong tool, not an error. Check with `npx tpm home` that the printed folder is this project's copy (or the
central folder you installed from).

The same shape works with a local copy or a packed tarball in place of the GitHub address:

```bash
npm install --save-dev ../path/to/claude-tpm      # a folder: npm links it
npm install --save-dev ./claude-tpm-0.2.0.tgz     # a tarball from `npm pack`: npm copies it
```

If npm made a real copy (the tarball and GitHub cases), that copy inside `node_modules` is the folder the
installer registers, and the plan has no `npm install` line because the dependency is what you just
installed. It also carries a warning: deleting `node_modules` (or reinstalling) breaks claude-tpm for the
project until you run `npx tpm install .` again. That is fine for one project. A second project cannot share
that copy; see [When claude-tpm is already registered](#when-claude-tpm-is-already-registered).

---

## Quick start: several projects

Use this when several projects share one claude-tpm version. Keep one copy of claude-tpm in a central
folder outside any project, such as `~/claude-tpm/claude-tpm-0.2.0`, and install into each project from it:

```bash
cd ~/claude-tpm/claude-tpm-0.2.0
npx tpm install ../projA
npx tpm install ../projB
```

`npx tpm` works inside the central folder because that folder is itself the `@codercowboy/claude-tpm`
package. The first install registers the marketplace from the central folder. The second finds the row and
leaves it alone (its plan says `… is already registered — nothing to do there`). Each project gets its own
dependency, config file and project-scope enable.

Because the central folder is the live code for every project, keep it where it is. Don't put it in a
project's `node_modules` or a temp folder. Installing from a copy that lives inside a *different* project's
`node_modules` is refused.

---

## What the installer does

The installer looks first, then shows a plan, then asks once. Nothing is written before you answer.

1. **Look.** It reads the project and the machine: `package.json`, `node_modules`, the Claude Code
   marketplace list and plugin list, the project's settings files and `.claude/claude-tpm/`. It writes
   nothing while it looks. It stops with an `error: not installing — …` line (and `Nothing was changed.`)
   if `npm` or `claude` won't run, if `package.json` is missing or invalid, if you are running a copy that
   lives in another project's `node_modules`, if this claude-tpm folder is incomplete, or if stdin is not
   a terminal and you didn't pass `--quiet`.
2. **Diagnose.** One sentence says where the project stands: not installed, an upgrade from an older
   version, broken, partly installed, or healthy. A healthy project prints one line and exits 0.
3. **Plan.** It lists only what is missing, in this order, each with the exact command it will run:

   | Plan line | Command |
   |---|---|
   | Register the claude-tpm folder (once for this machine) | `claude plugin marketplace add <folder>` |
   | Add claude-tpm to `package.json` (dev dependency by default) | `npm install file:<relative path> --save-dev --no-fund --no-audit` |
   | Turn the plugin on for this project | `claude plugin install claude-tpm@claude-tpm-market-<version> --scope project` |
   | Turn an older claude-tpm version off for this project (upgrades only) | `claude plugin disable <old id> --scope project` |
   | Write `.claude/claude-tpm/config.json` with the default task and session folders | (file write; never overwrites) |

   A re-point (see below) comes first and replaces the register line. Registration comes before the
   dependency so the project is never left with the plugin on and `npx tpm` broken if a run stops halfway.
4. **Confirm.** One `Proceed? [y/N]`. The default is no; any answer except `y` or `yes` prints
   `Nothing was changed.` and exits 1.
5. **Apply.** The steps run in order. After each one the installer re-reads what that step should have
   changed and checks it. If a command fails, or the check fails, it prints the command's own error under a
   `✗` line and stops with `Stopped after N of M. Re-running `tpm install .` picks up where this left off.`
   Re-running plans exactly the remainder.
6. **Close.** It re-reads everything, prints any ⚠ or ✗ rows, one closing line and one `Next:` line. It exits
   0 unless a ✗ remains.

A fresh install into a project (long paths shortened):

```
claude-tpm 0.2.0-dev → ~/proj (from ~/claude-tpm/claude-tpm-0.2.0-dev)

Checking ~/proj … claude-tpm is not installed here.

I will:
  1. Register ~/claude-tpm/claude-tpm-0.2.0-dev with Claude Code, once for this machine
       $ claude plugin marketplace add ~/claude-tpm/claude-tpm-0.2.0-dev
  2. Add claude-tpm to package.json as a dev dependency, so `npx tpm` works in this project
       $ npm install file:../claude-tpm/claude-tpm-0.2.0-dev --save-dev --no-fund --no-audit
  3. Turn the plugin on for this project (writes one line to .claude/settings.json)
       $ claude plugin install claude-tpm@claude-tpm-market-0.2.0-dev --scope project
  4. Write .claude/claude-tpm/config.json with the default task and session folders
  (recorded as a dev dependency; pass --save for a regular one)
Proceed? [y/N] y

  ✓ registered     ~/claude-tpm/claude-tpm-0.2.0-dev
  ✓ package.json   node_modules/@codercowboy/claude-tpm links to ~/claude-tpm/claude-tpm-0.2.0-dev
  ✓ turned on      for ~/proj
  ✓ config.json    written

✓ claude-tpm 0.2.0-dev is installed in ~/proj — 6 checks ok.
  Next: open `claude` in ~/proj; the /tpm-* commands are there from the first message.
      `npx tpm doctor .` re-checks later.
```

To see the plan without installing anything, add `--plan`. It prints the diagnosis and the plan, never
asks, and exits 0. Running the installer again on a healthy project prints one line and changes nothing:

```
✓ claude-tpm 0.2.0-dev is already installed in ~/proj and healthy — 6 checks ok, nothing to do.
```

### Upgrading a project from an older version

If the project has an older claude-tpm turned on (for example 0.1.0), the diagnosis says so and the plan adds a
step that turns the old version off for this project, because with both on Claude Code keeps using the first
one. The plan ends with `Not touched: the 0.1.0 folder, its registration and other projects that use it.`
The older version's folder and its registry row stay as they are; other projects may still be using them.

### What lands in the project

| Where | What |
|---|---|
| `package.json` | `"devDependencies": { "@codercowboy/claude-tpm": "file:<relative path>" }` (`dependencies` with `--save`). With a central folder this is a link to it. With a tarball or GitHub install it is whatever spec you gave npm. |
| `node_modules/` | `@codercowboy/claude-tpm` (a link to the central folder, or a real copy) and `.bin/tpm`. |
| `.claude/claude-tpm/config.json` | The default task and session folders. Edit it to change settings (see [config-guide.md](config-guide.md)). |
| `.claude/settings.json` | One line, written by Claude Code: `"enabledPlugins": { "claude-tpm@claude-tpm-market-<version>": true }`. |

On the machine, not in the project, there is one registry row for the marketplace. The installer never
authors your `README`, `LICENSE` or `.gitignore`, and never edits `settings.json` itself.

### Commands: where to type what

- In a project shell, you type `npx tpm …` (`npx tpm install .`, `npx tpm doctor .`).
- Inside a Claude session, the skills and tools run bare `tpm …`. Claude Code puts the plugin's `bin/` on
  PATH for every Bash call in a project where the plugin is enabled. You can type `tpm …` in a Claude Bash
  call too.
- Pre-install steps are always `npx tpm`, because the plugin's `bin/` isn't on PATH yet.
- The installer needs a terminal to ask its question. Inside a Claude session (no terminal) it refuses
  unless you pass `--quiet`.

---

## When claude-tpm is already registered

The marketplace row is machine-wide: one per version. If this version is already registered, the installer
compares the registered folder with the one it is running from.

| Registry state | What the installer does |
|---|---|
| Not registered | Registers this folder (plan line 1). |
| Registered, same folder | Leaves the row alone and runs only the per-project steps. |
| Registered, folder gone | Re-points it to this folder: removes the row and adds it again. The plan says so and names the machine-wide effect. One `Proceed?` covers it. |
| Registered, folder alive, different | Asks which folder to use. See below. |
| Registered through a link | Healthy. The doctor shows a ⚠ with the manual recipe; the installer does not touch it. |

**A different folder.** The row points at another folder that still exists: another standalone folder, a
copy inside another project's `node_modules`, this project's own copy, or a GitHub source. In a terminal
the installer prints that folder, how it compares with this one ("same version, identical files" or "N
files differ"), and a menu:

```
  1. use       <project> links to and runs that folder; this folder is unused.
  2. re-point  Register this folder instead (re-point). Every project on 0.2.0-dev switches to this
               folder; each should re-run `tpm install .` once to restore its own settings.
  3. quit      Nothing was changed.
Choose [1/2/3]:
```

After your choice it prints the plan for it, then the single `Proceed?`. Pre-answer the menu with
`--share` (use that folder) or `--repoint` (register this one). With `--quiet` and neither flag the
installer stops and tells you to pick one. Passing both is an error. If you choose *use* on another
project's copy, the plan carries a warning: this project then depends on the other project keeping its
`node_modules`.

**Another project's copy as the installer.** If the claude-tpm you are running lives inside another
project's `node_modules`, the installer refuses (`Run the install from a standalone folder, or from inside
<project> after npm-installing it there`). A project's `node_modules` is not a place to install other
projects from. To free a row that points at another project's copy, run `npx tpm uninstall --system` in
that project first, or choose `--repoint`.

---

## Check it with the doctor

```bash
npx tpm doctor .
```

The doctor is read-only: it never runs a command that changes anything and never asks a question. By
default it prints the header, only the rows that need attention (⚠ or ✗, each with a `fix:` line), and one
summary line. A healthy project prints just the summary:

```
✓ 6 checks ok.
```

Add `--verbose` to see every row:

```
  ✓ package.json      claude-tpm 0.2.0-dev, links to ~/claude-tpm/claude-tpm-0.2.0-dev
  ✓ registered        claude-tpm 0.2.0-dev from ~/claude-tpm/claude-tpm-0.2.0-dev
  ✓ turned on         for ~/proj
  ✓ project folder    .claude/claude-tpm/ present, config.json valid
  ✓ claude-tpm folder complete (0.2.0-dev)
  ✓ claude            found

✓ 6 checks ok.
```

A project with a warning prints only that row (this one is the project that uses a registration made from
another folder, so it runs fine but would switch if someone re-points):

```
  ⚠ registered        registered from ~/other/claude-tpm-folder (a standalone folder), not from this folder
      fix: run `tpm install . --repoint` to register this folder instead

⚠ 5 checks ok, 1 warning.
```

A project that never had claude-tpm prints one row, not a wall of ✗:

```
  ✗ registered        claude-tpm is not installed here
      fix: run `tpm install .`

✗ 0 checks ok, 1 problem.
```

The doctor exits 1 if any row is ✗. ⚠ alone exits 0. `npx tpm install . --check` is kept as an alias for
`npx tpm doctor .`.

How to read a row:

| Mark | Meaning |
|---|---|
| ✓ | Fine. |
| ⚠ | Works, but look at it. Adds a `fix:` line. |
| ✗ | Broken. Adds a `fix:` line. The doctor exits 1. |

What each row checks:

- **package.json**: it exists, parses, and lists `@codercowboy/claude-tpm` (✗ if not; ⚠ if it points at a
  different claude-tpm version, because `npx tpm` would run the old one; ✗ if the link in `node_modules`
  is dangling).
- **registered**: this version is registered with Claude Code. ✗ if not, or if it was registered from a
  folder that is gone. ⚠ if it is registered from a different folder, from a copy inside another project,
  or through a link.
- **turned on**: the plugin is installed and enabled for this project. ⚠ if two claude-tpm versions are
  turned on here (Claude Code uses the first and ignores the other).
- **project folder**: `.claude/claude-tpm/` exists and `config.json` parses. ✗ if the folder is missing or
  the config is invalid JSON; the task and session tools refuse to run in either case.
- **claude-tpm folder**: the folder that runs is complete (it has `hooks/hooks.json` with both hooks) and its
  version matches its registration name. ✗ if incomplete or mislabelled. When another folder is the
  registered one, this row judges that folder.
- **claude**: the `claude` command runs.
- **tpm on PATH** and **TPM_HOME** (only inside a Claude Code Bash call): `tpm` should resolve into the
  plugin's `bin/`, and `TPM_HOME` should name the folder the doctor runs from. ⚠ otherwise.

The doctor refuses to run on the claude-tpm folder itself (`error: not checking — this is the claude-tpm
folder, not a project.`). Run it in a project.

### The session-start health note

Every Claude session in an installed project starts with a light check of the same layers. It reads files
only and never runs `claude`, so it cannot see a plugin that failed to load (the doctor from a terminal can).
When everything is fine it prints nothing. When it finds a problem it adds one line to Claude's context,
tagged `[claude-tpm]`, naming up to three problems, telling Claude to tell you, to suggest
`npx tpm install .` from a terminal, and not to edit files to fix it. It catches: `package.json` pointing at a
different claude-tpm version than the running plugin, another claude-tpm version also turned on, a missing
`.claude/claude-tpm/` folder, and an invalid `config.json`. To turn it off, set
`hygiene.healthCheck.enabled` to `false` in `.claude/claude-tpm/config.json`
(see [config-guide.md](config-guide.md#4-hygiene-config)).

---

## If you move the folder

Moving the claude-tpm folder breaks every project that uses it. The doctor shows:

```
  ✗ registered        registered from ~/old-place/claude-tpm-0.2.0-dev, and that folder is gone (moved or deleted)
      fix: run `tpm install .` from the folder claude-tpm now lives in
```

Either move it back, or run the installer from the new location, once per project:

```bash
cd /new/path/claude-tpm-0.2.0
npx tpm install ../projA
```

Run it from the folder, not from the project. The project's `npx tpm` is broken until you do, because its
dependency link points at the old path. The installer sees the dead row, plans a re-point (remove the row,
add it from the new folder) plus the re-linked dependency and the plugin record, and asks once. Other
projects on that version start working again as soon as the row is re-added; each should re-run
`npx tpm install .` once to restore its own settings. Moving from a one-project install to a shared folder is
the same procedure: put the folder somewhere central, then install from it.

---

## Options

| Flag | What it does |
|---|---|
| `[dir]` | Target project folder, the first non-flag argument. Default: the current folder. |
| `--dir <path>` | The target folder as a flag. |
| `--plan` | Show the diagnosis and the plan, then exit 0. Changes nothing and never asks. |
| `--quiet` | Answer yes to `Proceed?`. For scripts and CI, and required when stdin is not a terminal. A would-be menu becomes a refusal unless `--share` or `--repoint` answers it. |
| `--save` | Record claude-tpm as a regular dependency instead of a dev dependency. |
| `--from <spec>` | Use this npm spec for the dependency, such as `file:../claude-tpm`, instead of this claude-tpm folder. |
| `--repoint` | If this version is registered from another folder, register this one instead. |
| `--share` | If this version is registered from another folder, use that one. |
| `--debug` | Print a trace of every command the installer runs (or set `TPM_DEBUG=1`). Changes nothing. |
| `--check` | Alias for `tpm doctor`. |

`--force` and `-y` no longer exist. An unknown flag exits 2. There is nothing for `--force` to do: a step only
runs when it is needed, and a failed step stops the run with the command's own error. After fixing the cause,
re-run; the plan is whatever is left.

---

## Customizing defaults

Every module is on by default. To change something, edit `.claude/claude-tpm/config.json` in the project
(the installer creates it with the default folders). Keys you leave out use the defaults. The full schema
and the `TPM_PROJECT_ROOT` override are in [config-guide.md](config-guide.md).

---

## Uninstalling

```bash
npx tpm uninstall .
```

The marketplace row is shared by every project on this version, so uninstall asks what you mean:

- **This project only (the default).** Uninstalls the plugin here, then removes the project's dependency. It
  removes the shared marketplace row only if no other project still has the plugin installed. Otherwise it
  leaves the row and names the projects that still use it:

  ```
  ✓ Marketplace row "claude-tpm-market-0.2.0-dev" left in place — 1 other project still uses it:
        - …/projB
    Removing the row would uninstall it for them (it deletes every project's install record + plugin data).
  ```

- **The whole system.** Also removes the marketplace row, so every project on this version loses claude-tpm.
  It names those projects and asks first.

`--project` and `--system` choose the scope without asking. `--quiet` assumes yes and defaults to project.
To see what is still set up in a project, run `npx tpm doctor .`; `uninstall --check` is retired. Uninstall
never deletes your files. It leaves `.claude/claude-tpm/` (your session notes and tasks) in place.

After the dependency is removed, `npx tpm` in that project no longer finds a local `tpm`. Run it only from a
project that still has claude-tpm installed.

---

## Troubleshooting

- **`npx tpm` printed something unfamiliar.** You ran it where there is no local `tpm`, so npx fetched an
  unrelated registry package, or it ran a `tpm` from a parent folder's `node_modules/.bin`. Run the `npm install` from the quick start first, check that
  `node_modules/.bin/tpm` exists, then run `npx tpm install .`.
- **"has no package.json".** Run `npm init -y` in the project folder, then install.
- **"stdin is not a terminal".** The installer asks one question and has no terminal to ask it on. Run it in
  a terminal, or pass `--quiet`.
- **"Stopped after N of M".** A command failed; its own error is printed under the `✗` line. Fix that, then
  re-run `npx tpm install .`.
- **Skills look out of date or a command is missing.** See the "Something looks stale?" section of the
  [user guide](user-guide.md#something-looks-stale).
- **Anything else.** Run `npx tpm doctor .`. It names what is wrong and how to fix each row.
