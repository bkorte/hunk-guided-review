import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseStoredGuide, type ReviewGuide } from "./guide.ts";
import { PROMPT_VERSION } from "./prompt.ts";

/**
 * The part of a patch that survives every producer: hunk headers and hunk
 * lines. File headers, index lines, and "no newline" markers differ between
 * Hunk's per-file patch text and raw `git diff` output, so they are dropped.
 */
export function normalizePatch(patch: string): string {
  const kept: string[] = [];
  let inHunk = false;
  for (const line of patch.replace(/\r\n?/g, "\n").split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      kept.push(line);
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("diff ")) {
      inHunk = false;
      continue;
    }
    if (line.startsWith("\\")) continue;
    if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) kept.push(line);
  }
  return kept.join("\n");
}

/**
 * A content hash for the reviewed patches: same changes, same key, whether the
 * patches came from Hunk's changeset or from `git diff` in `scripts/generate.ts`.
 */
export function changesetKey(files: ReadonlyArray<{ path: string; patch: string }>): string {
  const hash = createHash("sha256");
  hash.update(`guide-v${PROMPT_VERSION}\0`);
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of sorted) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(normalizePatch(file.patch));
    hash.update("\0\0");
  }
  return hash.digest("hex").slice(0, 32);
}

export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
  return join(base, "hunk-guided-review");
}

function cachePath(key: string): string {
  return join(cacheDir(), `${key}.json`);
}

export async function readCachedGuide(key: string): Promise<ReviewGuide | null> {
  try {
    const text = await readFile(cachePath(key), "utf8");
    const guide = parseStoredGuide(text);
    return guide && guide.changesetKey === key ? guide : null;
  } catch {
    return null;
  }
}

export async function writeCachedGuide(guide: ReviewGuide): Promise<string> {
  await mkdir(cacheDir(), { recursive: true });
  const path = cachePath(guide.changesetKey);
  await writeFile(path, `${JSON.stringify(guide, null, 2)}\n`, "utf8");
  return path;
}

export async function deleteCachedGuide(key: string): Promise<void> {
  await rm(cachePath(key), { force: true });
}

/** Short content hash of one file's patch, so a reviewed mark expires when the file's diff changes. */
export function filePatchHash(patch: string): string {
  return createHash("sha256").update(normalizePatch(patch)).digest("hex").slice(0, 16);
}

/** Reviewed marks for one repository: file path to the patch hash it was marked at. */
export type ReviewMarks = Record<string, string>;

function marksPath(repoRoot: string): string {
  const id = createHash("sha256").update(repoRoot).digest("hex").slice(0, 24);
  return join(cacheDir(), "reviews", `${id}.json`);
}

export async function readReviewMarks(repoRoot: string): Promise<ReviewMarks> {
  try {
    const parsed = JSON.parse(await readFile(marksPath(repoRoot), "utf8")) as { version?: number; marks?: unknown };
    if (parsed.version !== 1 || !parsed.marks || typeof parsed.marks !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed.marks as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

export async function writeReviewMarks(repoRoot: string, marks: ReviewMarks): Promise<void> {
  const path = marksPath(repoRoot);
  await mkdir(join(cacheDir(), "reviews"), { recursive: true });
  await writeFile(path, `${JSON.stringify({ version: 1, repoRoot, marks }, null, 2)}\n`, "utf8");
}

/** Which of the loaded files are still reviewed: their stored hash must match their current patch. */
export function reviewedPathsFromMarks(marks: ReviewMarks, hashes: ReadonlyMap<string, string>): string[] {
  return [...hashes].filter(([path, hash]) => marks[path] === hash).map(([path]) => path);
}

/** Fold the session's reviewed set back into the stored marks, keeping marks for files not in this review. */
export function mergeReviewMarks(
  marks: ReviewMarks,
  hashes: ReadonlyMap<string, string>,
  reviewedFiles: ReadonlySet<string>,
): ReviewMarks {
  const next: ReviewMarks = { ...marks };
  for (const [path, hash] of hashes) {
    if (reviewedFiles.has(path)) next[path] = hash;
    else delete next[path];
  }
  return next;
}
