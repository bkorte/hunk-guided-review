# hunk-guided-review

A [Hunk](https://hunk.dev) extension that adds a **review guide** to any
changeset: the diff is regrouped into a handful of logical sections, ordered
the way the work was reasoned through, each with a short explanation of what
the hunks do together, why, and what to check. The guide is generated locally
with a coding-agent CLI such as `claude -p`.

```
 Review guide                                           cached
 Rate-limit the public API
 Public endpoints now share a token-bucket limiter keyed by
 API key, so one noisy client can no longer starve the rest.
 Limits come from config, and over-limit requests get a 429
 with Retry-After.

 4/8 hunks seen                                 1/6 files done
 ▶ 1. Token Bucket Limiter                         ▲ high  2/2
   Core change                       [ mark section reviewed ]
   A per-key token bucket refills at a configured rate and
   decides whether each request may proceed. Start with
   take(): it defines how bursts and refills interact.
   Look for
   • Can two concurrent requests both take the last token?

   · src/ratelimit/bucket.ts #1 #2                         [ ]

   2. Middleware Wiring                             △ med  1/3
   3. Over-Limit Responses                                 0/1
 ✓ 4. Limit Configuration                                  1/1
   5. Limiter Tests                                        0/1

 J next hunk · L next section · ctrl+x section done · x file
 done · ctrl+g regenerate
```

Every hunk in the review belongs to exactly one section, and every section
is labelled with its role: core change, supporting change, tests,
configuration, documentation, generated code, or cleanup. Sections read
core → consequences → supporting → tests → config/docs/cleanup. Once a guide
exists the review stream itself is reordered to follow it, so scrolling from
the top reads section by section instead of alphabetically. The pane follows
your selection, tracks which hunks you have seen, and has click targets to
mark work done: a *mark section reviewed* button at the top of each section
and a checkbox at the right of every file row. Each section's explanation is
also pushed into the diff as an inline agent note on its first hunk, so the
"why" sits next to the code and `{` / `}` walk the guide from inside the
review stream. While the guide pane is open it stands in for the files pane,
whose per-file rows it replaces with per-section ones; closing the guide
brings the files pane back.

## Requirements

- Hunk 0.20 or newer (extension API 8+). Newer hosts get extras: `hunk guide`
  (API 10), dimmed low-signal hunks (API 11), responsive pane width (API 12).
- A coding agent CLI that works non-interactively in your terminal:
  [Claude Code](https://claude.com/claude-code) (`claude -p`, the default),
  [Codex CLI](https://github.com/openai/codex) (`codex exec`), or
  [pi](https://pi.dev) (`pi -p`). Each guide is one run billed to that account.

## Install

```bash
hunk extension install bkorte/hunk-guided-review
```

Or try it without installing:

```bash
hunk diff --extension /path/to/hunk-guided-review
```

## Use

| Key      | Command                              |
| -------- | ------------------------------------ |
| `ctrl+g` | Generate the guide (or show/regenerate it) |
| `ctrl+t` | Toggle the guide pane                |
| `J` / `K`| Next / previous hunk in guide order  |
| `L` / `H`| Next / previous section              |
| `ctrl+x` | Mark the current section reviewed    |
| `x`      | Mark the current file reviewed       |

Every command is also in the **Extensions** menu, including the unbound
ones: *Regenerate*, *Cancel generation*, *Hide/show reviewed files*, *Add
explanations as inline notes*, and *Remove inline notes*. Reviewed files are
dimmed on hosts with API 11+; *Hide reviewed files* drops them from the
review stream entirely, so a finished file no longer takes up space. Remap
any of them by id under `[keybindings]`, for example
`"hunk-guided-review.next-step" = "ctrl+n"`.

On hosts with API 10 or newer, `hunk guide [diff|show] [target]` opens the
review and generates the guide as soon as it loads:

```bash
hunk guide                # working tree
hunk guide --staged
hunk guide main...HEAD
hunk guide show HEAD~1
```

Guides are cached under `~/.cache/hunk-guided-review/` keyed by the content
of the patches, so reopening the same diff is free and a changed diff is
flagged as stale until you regenerate. Reviewed marks persist there too, per
repository and per file: a mark survives quitting Hunk and other files
changing, and clears itself when that file's own diff changes.

### Pre-generate from the shell

`hunk-guide` builds the guide for a git diff without opening Hunk and writes
it into that same cache, so the next `hunk diff` on the same changes shows it
immediately. Run it from a CI step, a git hook, or while you make coffee:

```bash
bun link                    # once, from this checkout: puts `hunk-guide` on PATH
hunk-guide                  # working tree, untracked files included (what `hunk diff` reviews)
hunk-guide --staged         # what `hunk diff --staged` reviews
hunk-guide main...HEAD      # any `git diff` arguments
hunk-guide HEAD~1 --json guide.json --quiet
```

`--no-save` skips the cache, `--no-untracked` mirrors `hunk diff
--exclude-untracked`, and `HUNK_GUIDE_HARNESS`, `HUNK_GUIDE_MODEL`,
`HUNK_GUIDE_PROVIDER`, `HUNK_GUIDE_TOOLS=none` and `HUNK_GUIDE_MAX_TURNS`
override the harness, model, tool access and turn cap for that run. Without
`bun link`, call it as `bun /path/to/hunk-guided-review/scripts/generate.ts`.

## Configure

```toml
# ~/.config/hunk/config.toml
[extension.hunk-guided-review]
auto_generate = false     # generate on every load without asking (costs an agent run each time)
inline_notes = true       # push section explanations into the diff as agent notes
dim_low_signal = true     # dim hunks in cleanup/generated sections and in reviewed files (API 11+)
cache = true              # reuse a guide for an unchanged diff
reorder_files = true      # reorder the review stream to follow the guide's sections
harness = "claude"        # "claude" (claude -p), "codex" (codex exec), or "pi" (pi -p)
model = "sonnet"          # passed to the harness's --model; omit for its default
provider = "openrouter"   # pi only: --provider
tools = "read"            # "read": the agent may read files for context; "none": diff only
max_turns = 30            # cap on agentic turns for one generation (at most 100)
timeout_seconds = 600     # at most 1800
max_prompt_chars = 400000 # larger hunks are shortened to fit (at most 1000000)
pane = "left"             # or "right"
pane_width = 75           # preferred columns; Hunk shrinks it to fit narrower terminals
replace_files_pane = true # close the files pane while the guide is open, reopen it when the guide closes
advance_on_section_reviewed = true # after marking a section reviewed, jump to the next open section
advance_on_file_reviewed = true    # after marking a file reviewed, jump to the next open file
```

Repository `.hunk/config.toml` may set these too, so they are treated as
coming from the code under review:

- Anything that reaches a command line is validated. `model` and `provider`
  must be plain tokens, and the harness binary (`claude`, `codex`, or `pi`) is
  looked up only in the absolute directories on PATH, never taken from config
  or from the repository.
- The harness runs inside the reviewed repository, so it ignores that
  repository's own agent config: `claude` loads only your user settings (no
  project hooks, settings, or `.mcp.json`), `pi` skips everything under
  `.pi/`, and `codex` applies project config only to projects you have
  trusted in Codex.
- A repository can still turn on `auto_generate` or pick a pricier `model`,
  which spends your tokens each time you open it. The caps on `max_turns`,
  `timeout_seconds`, and `max_prompt_chars` bound what one run can cost.
- With `tools = "read"` the agent can read any file your user can, not only
  the repository. A diff written to steer the model could get it to quote a
  local file into the guide. The guide stays on your machine, but that file's
  contents reach the model provider, so use `tools = "none"` for diffs you
  don't trust.

## Load a saved guide

A guide saved with `hunk-guide --json` can be loaded into a review without
regenerating it, which is handy for demos and tests:

```bash
HUNK_GUIDED_REVIEW_GUIDE=guide.json hunk diff --staged
```

The file is re-validated against the loaded diff, so paths or hunk numbers
that no longer exist are dropped and anything unassigned lands in *Remaining
changes*.

## Harnesses

| Harness  | Invocation                                                   | Structured output                     |
| -------- | ------------------------------------------------------------ | ------------------------------------- |
| `claude` | `claude -p --output-format json --json-schema … --setting-sources user --strict-mcp-config --allowedTools Read,Grep,Glob --permission-mode dontAsk` | enforced by `--json-schema` |
| `codex`  | `codex exec --ephemeral --sandbox read-only --output-schema … -o …` | enforced by `--output-schema`  |
| `pi`     | `pi -p --mode json --no-session --no-approve --no-extensions --tools read,grep,find,ls …` | requested in the prompt, parsed from the reply |

Codex has no system-prompt flag, so the guide instructions are folded into the
prompt. Pi takes them through `--append-system-prompt` but has no schema flag,
so the reply is parsed and then validated like any other; anything malformed
still ends up as a complete catch-all guide.

## How it works

1. On load, the extension hashes the reviewed patches and looks for a cached
   guide.
2. `ctrl+g` renders every file and hunk, numbered, into one prompt and runs
   the configured harness with a read-only tool set, no session persistence,
   and a turn cap.
3. The structured answer is validated against the real review: unknown paths
   and hunk numbers are dropped, duplicates keep their first section, and any
   hunk the model skipped lands in a trailing *Remaining changes* section.
4. The pane renders the guide; `hunk session comment apply` adds the
   explanations as inline notes to the live session, and a changeset
   transform reorders the review stream to follow the sections (the review
   refreshes once to apply it).

## Develop

```bash
bun install
bun run typecheck
bun test                                  # unit tests
HUNK_CHECKOUT=~/src/hunk bun test test/pty  # PTY integration test via Hunk's harness
```

The PTY test launches Hunk from a checkout of `modem-dev/hunk` (run
`bun install && bun add -d tuistory` there first), loads this extension with
`--extension`, seeds a guide, and drives the pane with real keypresses.

The extension is a folder extension: `index.tsx` registers the pane,
commands, events and highlighter; `src/` holds the pure pieces (prompt
rendering, response normalization, cache, session bridge, store, pane).
