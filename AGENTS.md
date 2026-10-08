# Working on hunk-guided-review

A [Hunk](https://hunk.dev) extension that generates a sectioned review
guide for a changeset with a coding-agent CLI (`claude -p`, `codex exec`, or
`pi -p`) and renders it as a docked pane, inline notes, and a section-ordered
review stream. Read `README.md` first for what it does; this file is about
how to change it safely.

## Layout

| Path                   | Role                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `index.tsx`            | The extension entry: settings, pane/command/highlighter registration, events, transform. |
| `src/guide.ts`         | Guide types, the JSON Schema sent to the model, `normalizeGuide`, ordering helpers.       |
| `src/prompt.ts`        | Turns Hunk's file/hunk views into the prompt; owns `SYSTEM_PROMPT` and `PROMPT_VERSION`. |
| `src/harness.ts`       | Runs claude, codex, or pi non-interactively and returns the structured answer.           |
| `src/claude.ts`        | The `claude -p` runner and envelope parser (the default harness).                        |
| `src/spawn.ts`         | Shared subprocess runner: prompt on stdin, timeout, cancel, output capture.              |
| `src/cache.ts`         | Content-keyed guide cache; `changesetKey` must agree between Hunk and `git diff`.        |
| `src/session.ts`       | Bridge to `hunk session comment …` for inline notes.                                     |
| `src/store.ts`         | Module-level state, reviewed toggles with auto-advance, and the pane's React bridge.     |
| `src/pane.tsx`         | The pane: pure `buildRows` plus a thin React/OpenTUI renderer.                           |
| `src/wrap.ts`          | Text wrapping and justification for terminal rows.                                       |
| `scripts/generate.ts`  | The `hunk-guide` CLI: pre-generate a guide from `git diff` into the cache.               |
| `test/*.test.ts`       | Unit tests (`bun test`).                                                                 |
| `test/pty/`            | PTY integration test driven by Hunk's own harness (needs `HUNK_CHECKOUT`).               |

Keep logic in `src/` pure and unit-tested; `index.tsx` should stay wiring.

## Commands

```bash
bun install
bun run typecheck                         # tsc --noEmit
bun test                                  # unit tests; PTY tests skip without HUNK_CHECKOUT
HUNK_CHECKOUT=~/src/hunk bun test test/pty  # PTY tests via Hunk's harness
HUNK_TEST_EXECUTABLE=~/.hunk/bin/hunk HUNK_CHECKOUT=~/src/hunk bun test test/pty  # against an installed binary
hunk diff --extension .                   # hand-test in a real terminal (the user runs this, not an agent)
bun scripts/generate.ts --no-save         # exercise a harness end to end on the current diff
```

The PTY test needs a checkout of `modem-dev/hunk` with `bun install` and
`bun add -d tuistory` run inside it.

## Rules that matter here

- **Never launch `hunk diff`/`hunk show` from an agent to test.** The TUI
  takes over the terminal and hangs. Use the PTY harness or hand the command
  to the user. `hunk session …` commands against a live session are fine.
- **Target the installed extension API, not git main.** `package.json`
  declares `hunk.apiVersion = 8`. Newer surfaces (`registerCliCommand` 10,
  `dim` tone 11, fractional pane width 12) are gated on `hunk.apiVersion` in
  `index.tsx`; keep that pattern when using anything newer than the types in
  `node_modules/hunkdiff`.
- **Treat `hunk.config` as untrusted.** Repo config can set it. Model and
  provider names are validated as plain tokens; binaries are always resolved
  from PATH (or `process.execPath` for Hunk itself). Never take a path or a
  shell command from config.
- **Treat the reviewed repo as untrusted too.** Harnesses run with the repo as
  their cwd, and `claude -p` skips workspace trust, so a repo's own agent
  config would otherwise run its hooks or MCP servers. Keep `--setting-sources
  user --strict-mcp-config` for claude and `--no-approve` for pi; don't add a
  flag that loads project-local agent config.
- **Never import React or OpenTUI at runtime beyond what Hunk serves.** They
  are `devDependencies` for types only. Bundling a second React breaks the
  pane.
- **Cache key parity.** `changesetKey` hashes only hunk headers and hunk
  lines, sorted by path, so Hunk's per-file patch and `git diff` output agree.
  If you change what goes into the prompt or schema, bump `PROMPT_VERSION` so
  stale cached guides are ignored.
- **Every hunk ends up in exactly one section.** `normalizeGuide` enforces
  it; keep that invariant when touching the schema or the prompt.
- **Pane rows are one box per clickable segment**, kept two columns short of
  the pane width (`rowWidth`) with `flexShrink: 0` on trailing buttons.
  Otherwise the host clips their hit area. Rows are addressed by stable ids
  for `scrollChildIntoView`.
- **Theme tokens have fixed roles.** Text uses `text`, `muted`, `accent`,
  `noteBorder` (the note accent, readable as text in every theme),
  `badgeAdded`/`badgeRemoved` (stat colors), and `fileModified` for warnings;
  `panel` and `selectedHunk` are backgrounds. `accentMuted` is a hover and
  resize background in Hunk itself and is unreadable as text in some themes,
  so never use it as a foreground.
- **Reloads renumber file ids.** Durable state is keyed by `path`
  (`viewed`, `reviewedFiles`), never by `file.id`.
- **Nothing writes to stdout inside the extension.** Use `ctx.notify` for the
  user and `hunk.log` for diagnostics. `scripts/generate.ts` is a CLI and may
  print.

## Testing conventions

- Put parsing, normalization, and formatting in `src/` and cover it with
  `bun test`; PTY tests are for wiring and rendering only.
- In the PTY test, snapshots begin with a blank line, so click at
  `lineIndex - 1`, and space clicks by about 600 ms or the second is dropped.
- Real harness runs cost money; keep end-to-end checks to tiny fixture repos
  and `--no-save`.

## Style

TypeScript, strict mode, no build step (Hunk imports the source). Prefer small
pure functions with a one-line doc comment saying why they exist. Match the
existing formatting (two-space indent, double quotes, trailing commas).
