#!/usr/bin/env bun
/**
 * Pre-generate a review guide for a git diff, without opening Hunk.
 *
 *   hunk-guide                      # working tree, untracked files included (what `hunk diff` reviews)
 *   hunk-guide --staged             # what `hunk diff --staged` reviews
 *   hunk-guide main...HEAD          # a range
 *   hunk-guide HEAD~1               # git diff arguments pass straight through
 *
 * The guide is written to the same cache `hunk diff` reads, so the next Hunk
 * launch on the same changes shows it immediately. Options:
 *
 *   --json <path>    also write the guide JSON to a file
 *   --no-save        do not touch the cache
 *   --quiet          print only the summary line
 *   --no-untracked   leave untracked files out of a working-tree diff
 *
 * Environment: HUNK_GUIDE_HARNESS=claude|codex|pi, HUNK_GUIDE_MODEL, HUNK_GUIDE_PROVIDER (pi),
 * HUNK_GUIDE_TOOLS=none|read, HUNK_GUIDE_MAX_TURNS.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionDiffFile, ExtensionDiffHunk } from "hunkdiff/extension";
import { changesetKey, writeCachedGuide } from "../src/cache.ts";
import { isHarness, runHarnessStructured } from "../src/harness.ts";
import { GUIDE_JSON_SCHEMA, normalizeGuide, type ReviewGuide } from "../src/guide.ts";
import { buildPromptFiles, inventoryOf, renderPrompt, splitPatchHunks, SYSTEM_PROMPT } from "../src/prompt.ts";

/** The same prefix normalization Hunk's git adapter applies, so paths and headers line up. */
const GIT_PREFIX_ARGS = [
  "-c", "diff.noprefix=false",
  "-c", "diff.mnemonicPrefix=false",
  "-c", "diff.srcPrefix=a/",
  "-c", "diff.dstPrefix=b/",
];
const GIT_DIFF_ARGS = ["diff", "--no-ext-diff", "--find-renames", "--no-color"];
const MAX_UNTRACKED_BYTES = 2_000_000;

function parseHeader(header: string): Pick<ExtensionDiffHunk, "oldRange" | "newRange"> {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
  if (!match) return {};
  const oldStart = Number(match[1]);
  const oldCount = match[2] === undefined ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newCount = match[4] === undefined ? 1 : Number(match[4]);
  return {
    oldRange: [oldStart, Math.max(oldStart, oldStart + oldCount - 1)],
    newRange: [newStart, Math.max(newStart, newStart + newCount - 1)],
  };
}

function fileFromPatch(patch: string, index: number, overrides: Partial<ExtensionDiffFile> = {}): ExtensionDiffFile {
  const pathMatch = /^diff --git a\/(.+?) b\/(.+)$/m.exec(patch);
  const path = pathMatch?.[2] ?? `file-${index}`;
  const previousPath = pathMatch && pathMatch[1] !== pathMatch[2] ? pathMatch[1] : undefined;
  const hunks: ExtensionDiffHunk[] = splitPatchHunks(patch).map((text, hunkIndex) => {
    const header = text.split("\n")[0]!;
    return { index: hunkIndex, header, ...parseHeader(header) };
  });
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) inHunk = true;
    else if (line.startsWith("diff ")) inHunk = false;
    else if (inHunk && line.startsWith("+")) additions += 1;
    else if (inHunk && line.startsWith("-")) deletions += 1;
  }
  return {
    id: `file-${index}`,
    path,
    previousPath,
    patch,
    stats: { additions, deletions },
    metadata: {},
    agent: null,
    hunks,
    changeType: /^new file mode/m.test(patch) ? "new" : /^deleted file mode/m.test(patch) ? "deleted" : previousPath ? "rename-changed" : "change",
    isBinary: /^Binary files/m.test(patch),
    ...overrides,
  } as ExtensionDiffFile;
}

/** Split `git diff` output into per-file patches shaped like Hunk's extension file views. */
export function filesFromGitDiff(diff: string): ExtensionDiffFile[] {
  return diff
    .split(/^(?=diff --git )/m)
    .filter((chunk) => chunk.trim())
    .map((patch, index) => fileFromPatch(patch, index));
}

/** Synthesize an added-file patch for an untracked file the way Hunk does. */
export function untrackedFilePatch(path: string, contents: string): string {
  const body = contents.endsWith("\n") ? contents.slice(0, -1) : contents;
  const lines = body === "" && contents === "" ? [] : body.split("\n");
  const patch = [`diff --git a/${path} b/${path}`, "new file mode 100644", "--- /dev/null\t", `+++ b/${path}`];
  if (lines.length > 0) patch.push(`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`));
  return `${patch.join("\n")}\n`;
}

function runGit(args: string[], cwd: string) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  // git can follow the reason with its whole usage text; the first line is the part worth showing.
  if (result.status !== 0) throw new Error(result.stderr.trim().split("\n")[0] || `git ${args[0]} exited with ${result.status}`);
  return result.stdout;
}

/** Untracked, non-ignored files, repo-relative, the same set `hunk diff` reviews. */
export function listUntracked(cwd: string): string[] {
  const output = runGit(["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd);
  return output
    .split("\0")
    .filter((entry) => entry.startsWith("?? "))
    .map((entry) => entry.slice(3));
}

export interface CollectOptions {
  cwd: string;
  gitArgs: string[];
  includeUntracked: boolean;
}

/** Whether these `git diff` arguments describe the plain working tree (where untracked files belong). */
export function isWorkingTreeDiff(gitArgs: string[]): boolean {
  const before = gitArgs.indexOf("--") >= 0 ? gitArgs.slice(0, gitArgs.indexOf("--")) : gitArgs;
  return !before.some((arg) => arg === "--staged" || arg === "--cached" || !arg.startsWith("-"));
}

/** Gather the files `hunk diff <args>` would review, as extension-shaped file views. */
export function collectFiles(options: CollectOptions): ExtensionDiffFile[] {
  const diff = runGit([...GIT_PREFIX_ARGS, ...GIT_DIFF_ARGS, ...options.gitArgs], options.cwd);
  const files = filesFromGitDiff(diff);
  if (!options.includeUntracked || !isWorkingTreeDiff(options.gitArgs)) return files;
  const root = runGit(["rev-parse", "--show-toplevel"], options.cwd).trim();
  for (const path of listUntracked(options.cwd)) {
    const absolute = join(root, path);
    let contents: Buffer;
    try {
      if (!statSync(absolute).isFile()) continue;
      contents = readFileSync(absolute);
    } catch {
      continue;
    }
    if (contents.length > MAX_UNTRACKED_BYTES || contents.includes(0)) continue;
    files.push(fileFromPatch(untrackedFilePatch(path, contents.toString("utf8")), files.length, { isUntracked: true, changeType: "new" }));
  }
  return files;
}

export function formatGuide(guide: ReviewGuide): string {
  const lines: string[] = [];
  lines.push(`# ${guide.title}`, "", guide.summary, "");
  guide.sections.forEach((section, index) => {
    const risk = section.risk === "low" ? "" : ` [${section.risk} risk]`;
    lines.push(`## ${String(index + 1).padStart(2, "0")} / ${String(guide.sections.length).padStart(2, "0")}  ${section.title} (${section.kind})${risk}`, "");
    lines.push(section.explanation, "");
    if (section.lookFor.length > 0) {
      lines.push("Look for:");
      for (const item of section.lookFor) lines.push(`- ${item}`);
      lines.push("");
    }
    for (const location of section.locations) {
      lines.push(`  ${location.path} #${location.hunk}${location.note ? ` — ${location.note}` : ""}`);
    }
    lines.push("");
  });
  return lines.join("\n");
}

function summaryLine(guide: ReviewGuide, cachePath: string | null): string {
  const meta = [
    `${guide.sections.length} sections`,
    guide.model ? guide.model : "",
    guide.costUsd !== undefined ? `$${guide.costUsd.toFixed(3)}` : "",
    guide.durationMs !== undefined ? `${Math.round(guide.durationMs / 1000)}s` : "",
    guide.unassigned ? `${guide.unassigned} unassigned` : "",
  ].filter(Boolean);
  return `Guide ready: ${meta.join(" · ")}${cachePath ? `\nCached at ${cachePath}; open the same changes with \`hunk diff\` to see it.` : ""}`;
}

/** Parse arguments, generate the guide, and write it out; failures throw with a message meant for the user. */
async function main(args: string[]): Promise<void> {
  if (args.includes("-h") || args.includes("--help")) {
    const source = readFileSync(new URL(import.meta.url), "utf8");
    console.log(source.slice(source.indexOf("/**") + 4, source.indexOf("*/")).replace(/^ \* ?/gm, "").trim());
    return;
  }
  const take = (flag: string) => {
    const index = args.indexOf(flag);
    if (index < 0) return false;
    args.splice(index, 1);
    return true;
  };
  const jsonIndex = args.indexOf("--json");
  const jsonPath = jsonIndex >= 0 ? args.splice(jsonIndex, 2)[1] : undefined;
  if (jsonIndex >= 0 && (!jsonPath || jsonPath.startsWith("-"))) throw new Error("--json needs a file path");
  const save = !take("--no-save");
  const quiet = take("--quiet");
  const includeUntracked = !take("--no-untracked");
  const maxTurns = Number(process.env.HUNK_GUIDE_MAX_TURNS ?? 30);
  if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new Error("HUNK_GUIDE_MAX_TURNS must be a positive whole number");

  const cwd = process.cwd();
  const files = collectFiles({ cwd, gitArgs: args, includeUntracked });
  if (files.length === 0) throw new Error("no changes to guide");
  const promptFiles = buildPromptFiles(files);
  const inventory = inventoryOf(promptFiles);
  const hunkCount = inventory.reduce((count, file) => count + file.hunkCount, 0);
  if (hunkCount === 0) throw new Error("no text hunks to guide");
  const prompt = renderPrompt(promptFiles, { title: `git diff ${args.join(" ")}`.trim(), maxChars: 400_000 });
  const harness = isHarness(process.env.HUNK_GUIDE_HARNESS) ? process.env.HUNK_GUIDE_HARNESS : "claude";
  console.error(`Asking ${harness} about ${files.length} files, ${hunkCount} hunks (${prompt.length} chars)…`);

  const result = await runHarnessStructured({
    harness,
    provider: process.env.HUNK_GUIDE_PROVIDER,
    cwd,
    prompt,
    systemPrompt: SYSTEM_PROMPT,
    schema: GUIDE_JSON_SCHEMA,
    model: process.env.HUNK_GUIDE_MODEL,
    maxTurns,
    tools: process.env.HUNK_GUIDE_TOOLS === "none" ? "none" : "read",
    timeoutMs: 600_000,
  });
  const guide = normalizeGuide(result.output, inventory, {
    changesetKey: changesetKey(files),
    model: result.model,
    costUsd: result.costUsd,
    durationMs: result.durationMs,
  });
  const cachePath = save ? await writeCachedGuide(guide) : null;
  if (jsonPath) await writeFile(jsonPath, `${JSON.stringify(guide, null, 2)}\n`);
  if (!quiet) console.log(formatGuide(guide));
  console.log(summaryLine(guide, cachePath));
}

if (import.meta.main) {
  await main(process.argv.slice(2)).catch((error) => {
    console.error(`hunk-guide: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
