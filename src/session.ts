import { spawn } from "node:child_process";
import type { ReviewGuide } from "./guide.ts";

export const NOTE_AUTHOR = "Review guide";

/** One item of the `hunk session comment apply` batch. */
export interface SessionCommentItem {
  filePath: string;
  hunk: number;
  summary: string;
  rationale?: string;
  author: string;
}

/**
 * The `hunk` executable to drive the live session with.
 *
 * Inside a compiled Hunk binary `process.execPath` is Hunk itself, which is the
 * exact version running this review; otherwise fall back to PATH.
 */
export function hunkBinary(execPath: string = process.execPath): string {
  const name = (execPath.split(/[\\/]/).pop() ?? "").toLowerCase();
  return name === "hunk" || name === "hunk.exe" ? execPath : "hunk";
}

function sectionRationale(section: ReviewGuide["sections"][number], note?: string): string {
  const parts: string[] = [];
  if (section.explanation) parts.push(section.explanation);
  if (section.lookFor.length > 0) {
    parts.push(["Look for:", ...section.lookFor.map((item) => `- ${item}`)].join("\n"));
  }
  if (note) parts.push(note);
  return parts.join("\n\n");
}

/** Build the inline notes that carry the guide into the diff itself. */
export function buildGuideComments(guide: ReviewGuide): SessionCommentItem[] {
  const items: SessionCommentItem[] = [];
  guide.sections.forEach((section, sectionIndex) => {
    const riskTag = section.risk === "high" ? " · high risk" : section.risk === "medium" ? " · medium risk" : "";
    section.locations.forEach((location, locationIndex) => {
      const position = `${locationIndex + 1}/${section.locations.length}`;
      const summary = `§${sectionIndex + 1} ${section.title} (${position})${riskTag}`;
      const rationale =
        locationIndex === 0 ? sectionRationale(section, location.note) : location.note;
      items.push({
        filePath: location.path,
        hunk: location.hunk,
        summary,
        ...(rationale ? { rationale } : {}),
        author: NOTE_AUTHOR,
      });
    });
  });
  return items;
}

/** Walk any JSON value and collect every `commentId` string it contains. */
export function collectCommentIds(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) collectCommentIds(entry, into);
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === "commentId" && typeof entry === "string") into.push(entry);
      else collectCommentIds(entry, into);
    }
  }
  return into;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runHunk(args: string[], cwd: string, stdin?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(hunkBinary(), args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
    child.stdin.on("error", () => {});
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

function failureMessage(result: RunResult, fallback: string): string {
  const text = (result.stderr || result.stdout).trim();
  return text ? text.split("\n").slice(-2).join(" ").slice(0, 240) : fallback;
}

/** Push the guide's explanations into the live session as agent notes; returns their ids. */
export async function applyGuideNotes(cwd: string, guide: ReviewGuide): Promise<string[]> {
  const comments = buildGuideComments(guide);
  if (comments.length === 0) return [];
  const result = await runHunk(
    ["session", "comment", "apply", "--repo", cwd, "--stdin", "--json"],
    cwd,
    `${JSON.stringify({ comments })}\n`,
  );
  if (result.code !== 0) {
    throw new Error(failureMessage(result, `hunk session comment apply exited with ${result.code}`));
  }
  try {
    return collectCommentIds(JSON.parse(result.stdout));
  } catch {
    return [];
  }
}

/** Remove notes this extension added earlier; missing ones are ignored. */
export async function removeGuideNotes(cwd: string, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    await runHunk(["session", "comment", "rm", "--repo", cwd, id, "--json"], cwd).catch(() => undefined);
  }
}
