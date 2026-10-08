import type { ExtensionDiffFile } from "hunkdiff/extension";
import type { HunkInventoryFile } from "./guide.ts";

/** Bump when the prompt or schema changes enough that cached guides should be regenerated. */
export const PROMPT_VERSION = 2;

export interface PromptHunk {
  /** 1-based, matching `ExtensionDiffHunk.index + 1`. */
  number: number;
  header: string;
  oldRange?: readonly [number, number];
  newRange?: readonly [number, number];
  /** Unified diff text for this hunk, starting with its `@@` line. */
  text: string;
}

export interface PromptFile {
  path: string;
  previousPath?: string;
  changeType: string;
  additions: number;
  deletions: number;
  isBinary: boolean;
  isTooLarge: boolean;
  hunks: PromptHunk[];
}

/** Split one file's unified diff into its hunks, each starting at its `@@` line. */
export function splitPatchHunks(patch: string): string[] {
  const lines = patch.replace(/\r\n?/g, "\n").split("\n");
  const hunks: string[][] = [];
  for (const line of lines) {
    if (line.startsWith("@@")) {
      hunks.push([line]);
    } else if (hunks.length > 0) {
      hunks[hunks.length - 1]!.push(line);
    }
  }
  return hunks.map((rows) => {
    while (rows.length > 1 && rows[rows.length - 1] === "") rows.pop();
    return rows.join("\n");
  });
}

/** Project the reviewed files into the plain shape the prompt is rendered from. */
export function buildPromptFiles(files: readonly ExtensionDiffFile[]): PromptFile[] {
  return files.map((file) => {
    const summaries = file.hunks ?? [];
    const texts = splitPatchHunks(file.patch);
    const aligned = texts.length === summaries.length;
    const hunks: PromptHunk[] = summaries.map((hunk, index) => ({
      number: index + 1,
      header: hunk.header,
      oldRange: hunk.oldRange,
      newRange: hunk.newRange,
      text: aligned ? texts[index]! : hunk.header,
    }));
    if (!aligned && summaries.length > 0 && texts.length > 0) {
      // The parser and our splitter disagree; give the model the whole patch
      // under the first hunk so nothing is silently lost.
      hunks[0] = { ...hunks[0]!, text: file.patch.trimEnd() };
    }
    return {
      path: file.path,
      previousPath: file.previousPath,
      changeType: file.changeType ?? (file.isUntracked ? "new" : "change"),
      additions: file.stats.additions,
      deletions: file.stats.deletions,
      isBinary: file.isBinary === true,
      isTooLarge: file.isTooLarge === true,
      hunks,
    };
  });
}

export function inventoryOf(files: readonly PromptFile[]): HunkInventoryFile[] {
  return files.map((file) => ({ path: file.path, hunkCount: file.hunks.length }));
}

/** Keep the head and tail of an oversized hunk, marking what was cut. */
export function truncateHunkText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const lines = text.split("\n");
  const headBudget = Math.floor(maxChars * 0.65);
  const tailBudget = Math.floor(maxChars * 0.25);
  const head: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > headBudget) break;
    head.push(line);
    used += line.length + 1;
  }
  const tail: string[] = [];
  used = 0;
  for (let index = lines.length - 1; index > head.length; index -= 1) {
    const line = lines[index]!;
    if (used + line.length + 1 > tailBudget) break;
    tail.unshift(line);
    used += line.length + 1;
  }
  const omitted = lines.length - head.length - tail.length;
  if (omitted <= 0) return text;
  return [...head, `... [${omitted} lines omitted to fit the prompt budget] ...`, ...tail].join(
    "\n",
  );
}

export interface RenderPromptOptions {
  title: string;
  sourceLabel?: string;
  /** Upper bound on rendered prompt size, in characters. */
  maxChars: number;
  /** Optional reviewer focus typed into the generate dialog. */
  focus?: string;
}

function describeChange(file: PromptFile): string {
  const parts = [file.changeType];
  if (file.previousPath && file.previousPath !== file.path) parts.push(`from ${file.previousPath}`);
  parts.push(`+${file.additions} -${file.deletions}`);
  if (file.isBinary) parts.push("binary");
  if (file.isTooLarge) parts.push("too large to render");
  return parts.join(", ");
}

function rangeLabel(hunk: PromptHunk): string {
  const parts: string[] = [];
  if (hunk.oldRange) parts.push(`old ${hunk.oldRange[0]}-${hunk.oldRange[1]}`);
  if (hunk.newRange) parts.push(`new ${hunk.newRange[0]}-${hunk.newRange[1]}`);
  return parts.join(", ");
}

/** Render the user prompt: an inventory plus every hunk, numbered the way the guide must cite them. */
export function renderPrompt(files: readonly PromptFile[], options: RenderPromptOptions): string {
  const totalHunks = files.reduce((count, file) => count + file.hunks.length, 0);
  const additions = files.reduce((count, file) => count + file.additions, 0);
  const deletions = files.reduce((count, file) => count + file.deletions, 0);

  const overhead = 4_000;
  const budget = Math.max(10_000, options.maxChars - overhead);
  const rawTotal = files.reduce(
    (count, file) => count + file.hunks.reduce((inner, hunk) => inner + hunk.text.length, 0),
    0,
  );
  const perHunkCap =
    rawTotal > budget ? Math.max(1_500, Math.floor(budget / Math.max(1, totalHunks))) : Infinity;

  const lines: string[] = [];
  lines.push(`# Changeset: ${options.title}`);
  if (options.sourceLabel) lines.push(`Source: ${options.sourceLabel}`);
  lines.push(
    `${files.length} file${files.length === 1 ? "" : "s"}, ${totalHunks} hunk${totalHunks === 1 ? "" : "s"}, +${additions} -${deletions}`,
  );
  if (perHunkCap !== Infinity) {
    lines.push(
      `Note: some hunks were shortened to fit the prompt budget; omitted lines are marked inline.`,
    );
  }
  if (options.focus?.trim()) {
    lines.push("", `Reviewer focus: ${options.focus.trim()}`);
  }
  lines.push("", "## File inventory");
  for (const file of files) {
    lines.push(`- ${file.path} (${describeChange(file)}; ${file.hunks.length} hunks)`);
  }
  lines.push("", "## Hunks", "");
  lines.push(
    "Cite hunks as `path` + `hunk` number exactly as labelled below. Every hunk should end up in exactly one section.",
    "",
  );
  for (const file of files) {
    lines.push(`=== FILE ${file.path} (${describeChange(file)}) ===`);
    if (file.hunks.length === 0) {
      lines.push("(no reviewable hunks)", "");
      continue;
    }
    for (const hunk of file.hunks) {
      const range = rangeLabel(hunk);
      lines.push(`--- ${file.path} hunk ${hunk.number}${range ? ` (${range})` : ""} ---`);
      lines.push(truncateHunkText(hunk.text, perHunkCap));
      lines.push("");
    }
  }
  return lines.join("\n");
}

/** The guide instructions: appended to the harness's own system prompt, or folded into the prompt where there is no flag for it. */
export const SYSTEM_PROMPT = `You write review guides for code changes.

A review guide takes a diff that a tool has already split into files and hunks and regroups it into a small number of logical sections, so a reviewer reads the change by concern rather than in filesystem order. Each section pairs a short explanation of what its hunks do and why with the hunks themselves. The guide is a map that orients the reviewer before they read code; it is not a verdict and not a line-by-line narration.

How to build the guide:
- Group by concern, not by file. A section often spans several files (an interface change plus its call sites, a model plus its serializer plus its test, the client and server halves of one feature). One file with unrelated edits may be split across sections, but keep a file's hunks together unless they clearly serve different concerns.
- Order sections the way the work was reasoned through: the core of the change first, so the reviewer has an entry point; then the consequences of that change in the code that consumes it; then supporting changes, tests, configuration, generated code, documentation, and mechanical cleanup (imports, formatting, renames) last, kept separate so they can be skimmed deliberately. Within a section, order hunks so each one makes the next easier to understand.
- Every hunk in the input must appear in exactly one section. Nothing is left out; low-signal changes get their own low-risk section rather than being dropped.
- Keep the section count proportional to the change: two to four sections for a small change, rarely more than eight for a large one. A tiny change may be one section.
- Section titles are two to four word noun phrases naming the concern ("Request Rate Limiter", "Session Expiry Handling"), never a file name.
- Explanations are two to four sentences for someone who has not read the diff: start with what the change is, then its consequences for the rest of the system; name the contract or invariant being touched; when helpful, say where to start reading and why. Do not restate the diff, do not list files, do not pad.
- "lookFor" holds zero to three concrete, checkable questions specific to this code: an edge case the new branch may miss, a caller that still assumes the old behavior, a migration that cannot be reversed. Skip generic review advice; an empty list is fine.
- "risk" reflects how much could go wrong and how hard it would be to notice: behavior changes on hot paths, data migrations, auth, money, and concurrency are high; refactors covered by tests are medium; docs, comments, formatting, and generated files are low.
- A location "note" is optional; add one only when a hunk's role in its section is not obvious from the section explanation.
- Cite file paths and hunk numbers exactly as labelled in the input.

If you can read repository files, use that only to understand callers, types, or context you need to explain a section well. Never modify anything.`;
