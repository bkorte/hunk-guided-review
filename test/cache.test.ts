import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changesetKey,
  filePatchHash,
  mergeReviewMarks,
  normalizePatch,
  readReviewMarks,
  reviewedPathsFromMarks,
  writeReviewMarks,
} from "../src/cache.ts";

describe("changesetKey", () => {
  const hunkBody = "@@ -1,2 +1,2 @@\n-a\n+b\n c";
  test("ignores file headers, order, and no-newline markers", () => {
    const fromHunk = [{ path: "x.ts", patch: `diff --git a/x.ts b/x.ts\nindex 1..2 100644\n--- a/x.ts\n+++ b/x.ts\n${hunkBody}\n` }, { path: "y.ts", patch: `--- a/y.ts\n+++ b/y.ts\n@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n` }];
    const fromGit = [{ path: "y.ts", patch: `diff --git a/y.ts b/y.ts\n--- a/y.ts\n+++ b/y.ts\n@@ -1 +1 @@\n-old\n+new\n` }, { path: "x.ts", patch: `${hunkBody}` }];
    expect(changesetKey(fromHunk)).toBe(changesetKey(fromGit));
    expect(normalizePatch(fromHunk[0]!.patch)).toBe(hunkBody);
  });
  test("changes when content changes", () => {
    expect(changesetKey([{ path: "x.ts", patch: hunkBody }])).not.toBe(changesetKey([{ path: "x.ts", patch: hunkBody.replace("+b", "+B") }]));
  });
});

describe("reviewed marks", () => {
  test("survive a round trip and expire when a file's patch changes", async () => {
    const cache = mkdtempSync(join(tmpdir(), "guide-marks-"));
    const previous = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = cache;
    try {
      const hashes = new Map([
        ["src/a.ts", filePatchHash("@@ -1 +1 @@\n-a\n+b")],
        ["README.md", filePatchHash("@@ -1 +1 @@\n-x\n+y")],
      ]);
      expect(await readReviewMarks("/repo")).toEqual({});
      const marks = mergeReviewMarks({ "old.ts": "deadbeef" }, hashes, new Set(["src/a.ts"]));
      await writeReviewMarks("/repo", marks);
      const stored = await readReviewMarks("/repo");
      expect(stored).toEqual({ "old.ts": "deadbeef", "src/a.ts": hashes.get("src/a.ts")! });
      expect(reviewedPathsFromMarks(stored, hashes)).toEqual(["src/a.ts"]);
      // The same file with a different diff is no longer reviewed.
      const changed = new Map(hashes).set("src/a.ts", filePatchHash("@@ -1 +1 @@\n-a\n+c"));
      expect(reviewedPathsFromMarks(stored, changed)).toEqual([]);
      // Unmarking removes the entry; marks for files outside this review are kept.
      expect(mergeReviewMarks(stored, hashes, new Set())).toEqual({ "old.ts": "deadbeef" });
    } finally {
      if (previous === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previous;
      rmSync(cache, { recursive: true, force: true });
    }
  });
});
