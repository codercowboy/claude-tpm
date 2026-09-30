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
installer registers. That is fine for one project. If a second project later tries to share it, you get the
warning described under [Warnings when a row already exists](#warnings-when-a-row-already-exists).

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
reuses it. Each project gets its own dependency, config file and project-scope enable.

Because the central folder is the live code for every project, keep it where it is. Don't put it in a
project's `node_modules` or a temp folder.

---

## What the installer does

It checks the current state and only does what is missing, so re-running it is safe. By default it prints
each command, explains it in a sentence, and asks before changing anything. Declining a step stops the
install without further changes.

1. **Preflight.** Confirms `npm` and `claude` actually run, and that `package.json` is valid. Writes
   nothing. It also creates `.claude/claude-tpm/config.json` with the default task and session folders, if
   that file isn't there yet. It never overwrites one.
2. **Dependency.** Adds `@codercowboy/claude-tpm` to the project's `devDependencies` as a `file:` path to the
   claude-tpm folder (relative, so it survives a move of the whole workspace) and runs `npm install`.
   Interactive runs ask whether to add it, and whether to record it as a regular or dev dependency (dev is
   the default). Skipped when it is already declared and installed.
3. **Marketplace.** Runs `claude plugin marketplace add <the claude-tpm folder>` at user scope. The path is
   the real folder, never a link through a project's `node_modules`.
4. **Plugin install.** Runs `claude plugin install claude-tpm@claude-tpm-market-<version> --scope project`.
5. **Enable.** Enables the plugin for the project only if step 4 left it disabled.

Then it runs the doctor as a final check.

A fresh install looks like this (long paths shortened):

```
Step 1/5 · Preflight — ✓ npm, package.json and claude are all available.
✓ Config · wrote .claude/claude-tpm/config.json (default task and session folders).

Step 2/5 · Add the claude-tpm dependency
  $ npm install file:../../claude-tpm-0.2.0-dev --save-dev
  Records @codercowboy/claude-tpm in devDependencies of …/projA/package.json and installs it into node_modules.
  ✓ done.

Step 3/5 · Register the marketplace
  $ claude plugin marketplace add '…/claude-tpm-0.2.0-dev'
  Makes this bundle folder installable as marketplace "claude-tpm-market-0.2.0-dev".
  (changes: this machine's Claude Code marketplace registry, user scope)
  ✓ done.

Step 4/5 · Install the plugin
  $ claude plugin install claude-tpm@claude-tpm-market-0.2.0-dev --scope project
  Installs claude-tpm@claude-tpm-market-0.2.0-dev for this project; this usually enables it too.
  ✓ done.
✓ Step 5/5 · Enable the plugin for this project — already done, skipped.
```

A step that is already done prints one `✓ … already done, skipped.` line instead.

### What lands in the project

| Where | What |
|---|---|
| `package.json` | `"devDependencies": { "@codercowboy/claude-tpm": "file:<relative path>" }`. With a central folder this is a link to it. With a tarball or GitHub install it is whatever spec you gave npm. |
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

---

## Warnings when a row already exists

If the marketplace for this version is already registered, the installer compares the registered folder with
its own folder (both resolved) and acts on the result.

| Registry state | What the installer does |
|---|---|
| Not registered | Registers it from this folder. |
| Registered, same folder | Leaves the row alone and runs only the per-project steps. |
| Registered, folder gone | Re-points it: removes the row and adds it from this folder. It says the folder was moved or deleted. |
| Registered, folder alive, different | Never re-points silently. See below. |

**Another folder.** The row points at a different folder that still exists. Re-pointing makes every project on
this machine that uses this version run this installer's folder, and it deletes every project's install
record and plugin data for the marketplace. (Loading resumes once the row is re-added, but those projects
need reinstalling.) Interactive runs ask one question naming both folders; a yes covers the whole re-point,
including re-installing the plugin here. With `--quiet` the installer stops unless you pass `--repoint`.

**Another project's copy.** The row points at a real copy inside another project's `node_modules`. If you
keep it, this project runs that other project's copy, not its own. The installer names the folder, compares
the two copies file by file ("identical" or "files differ (N files)"), and offers:

1. One shared folder for several projects (recommended). The installer stops and prints the commands.
2. Uninstall from the other project first, with `npx tpm uninstall --system` there.
3. Proceed and share that copy. This needs a yes, and a typed phrase if the copies differ.

With `--quiet` it stops unless you pass `--force`, which shares the other copy and never re-points the row.
The doctor shows this case as a warning row.

---

## Check it with the doctor

```bash
npx tpm doctor .
```

The doctor is read-only. It prints one line per check and ends with a count. `npx tpm install . --check`
does the same thing. It exits non-zero only when a check has a problem (✗), so warnings alone exit 0.

A healthy project:

```
  ✓ package.json
  ✓ claude-tpm dependency       @codercowboy/claude-tpm
  ✓ marketplace                 "claude-tpm-market-0.2.0-dev" is registered
  ✓ marketplace source          this bundle's folder
  ✓ plugin install record       claude-tpm@claude-tpm-market-0.2.0-dev
  ✓ plugin enablement           enabled for this project
  ✓ enabled claude-tpm plugins  claude-tpm@claude-tpm-market-0.2.0-dev
  ✓ project folder              .claude/claude-tpm/ present
  · install-record path         present (informational — the cache is not what runs)
  ✓ plugin hooks                session-start + gate-spawn
  ✓ bundle version              0.2.0-dev, plugin and node_modules copy agree
  ✓ config.json                 valid JSON
  · tpm on PATH                 skipped — only checked inside a Claude Code Bash call (TPM_PROJECT_ROOT / TPM_HOME not set here)
  Summary: 12 ok · 0 warnings · 0 problems · 1 skipped
```

How to read a row:

| Mark | Meaning |
|---|---|
| ✓ | Fine. |
| ⚠ | Works, but look at it. Adds a `fix:` line. |
| ✗ | Broken. Adds a `fix:` line. The doctor exits non-zero. |
| · | Skipped or informational. Counts as fine. |

What each label checks:

- **package.json**: exists and parses.
- **claude-tpm dependency**: `@codercowboy/claude-tpm` is declared in `package.json`.
- **marketplace**: the `claude-tpm-market-<version>` row is registered.
- **marketplace source**: the registered folder is this claude-tpm folder and exists. ⚠ if it is stored as a
  symlink (works, but breaks if the link is removed) or points at a different live folder. ✗ if the folder
  is gone.
- **plugin install record** and **plugin enablement**: the plugin is installed and enabled for this project.
  A missing install record is only a ⚠ when the plugin is enabled and the marketplace is registered,
  because it still loads.
- **enabled claude-tpm plugins**: ⚠ if more than one `claude-tpm@*` is enabled in the project. Claude Code
  silently uses the first.
- **project folder**: ✗ if the plugin is enabled but `.claude/claude-tpm/` doesn't exist. Run
  `npx tpm install .`.
- **install-record path**: informational.
- **plugin hooks**: the plugin delivers its SessionStart hook and its spawn gate.
- **bundle version**: the plugin and the project's `node_modules` copy are the same version.
- **config.json**: parses as JSON.
- **real copy in another project**: ⚠ when the row points at another project's copy (see above).
- **tpm on PATH** and **TPM_HOME**: only checked inside a Claude Bash call. `tpm` should resolve into the
  plugin's `bin/`. `TPM_HOME` is informational, and you get a ⚠ only if it names a different folder than
  the one the doctor runs from.

---

## If you move the folder

Moving the claude-tpm folder breaks every project that uses it. The doctor shows:

```
  ✗ marketplace source          the folder was moved or deleted (Claude Code reports this as 'cache-miss'): /old/path
      fix: run `npx tpm install .` from the folder claude-tpm now lives in — it re-points the marketplace at the live folder
```

Either move it back, or run the installer from the new location, once per project:

```bash
cd /new/path/claude-tpm-0.2.0
npx tpm install ../projA
```

Run it from the folder, not from the project. The project's `npx tpm` is broken until you do, because its
dependency link points at the old path. The installer removes the dead row, adds one from the new folder,
and rewrites the project's `file:` dependency to the new relative path. Moving from a one-project install to
a shared folder is the same procedure: put the folder somewhere central, then install from it.

---

## Options

| Flag | What it does |
|---|---|
| `[dir]` | Target project folder, the first non-flag argument. Default: the current folder. |
| `--dir <path>` | The target folder as a flag. |
| `--from <spec>` | The npm spec for the dependency, such as `file:../claude-tpm`. Default: this claude-tpm folder, as a relative `file:` path. |
| `--check` | Read-only doctor. Changes nothing. |
| `--quiet` | Non-interactive: assume yes to every step. For scripts and CI. Still exits non-zero on errors. |
| `--repoint` | Allow re-pointing a live row that points at a different folder. |
| `--force` | Re-run every step. With `--quiet` it also lets the install share another project's copy. |
| `--debug` | Print a trace of every command the installer runs (or set `TPM_DEBUG=1`). Changes nothing. |

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
`--check` is a read-only "is it cleanly removed?" check. Uninstall never deletes your files. It leaves
`.claude/claude-tpm/` (your session notes and tasks) in place.

After the dependency is removed, `npx tpm` in that project no longer finds a local `tpm`. Run it only from a
project that still has claude-tpm installed.

---

## Troubleshooting

- **`npx tpm` printed something unfamiliar.** You ran it where there is no local `tpm`, so npx fetched an
  unrelated registry package, or it ran a `tpm` from a parent folder's `node_modules/.bin`. Run the `npm install` from the quick start first, check that
  `node_modules/.bin/tpm` exists, then run `npx tpm install .`.
- **"No package.json found".** Run `npm init -y` in the project folder, then install.
- **Skills look out of date or a command is missing.** See the "Something looks stale?" section of the
  [user guide](user-guide.md#something-looks-stale).
- **Anything else.** Run `npx tpm doctor .`. It names what is wrong and how to fix each row.
