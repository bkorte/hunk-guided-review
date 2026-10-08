import { describe, expect, test } from "bun:test";
import type { ExtensionDiffFile } from "hunkdiff/extension";
import { buildPromptFiles, inventoryOf, renderPrompt, splitPatchHunks, truncateHunkText } from "../src/prompt.ts";

const patch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "+const b = 2;",
  " export { a };",
  "@@ -10,2 +11,2 @@ function f() {",
  "-  return 1;",
  "+  return 2;",
  "",
].join("\n");

function file(overrides: Partial<ExtensionDiffFile> = {}): ExtensionDiffFile {
  return {
    id: "file-1",
    path: "src/a.ts",
    patch,
    stats: { additions: 2, deletions: 1 },
    metadata: {},
    agent: null,
    hunks: [
      { index: 0, header: "@@ -1,3 +1,4 @@", oldRange: [1, 3], newRange: [1, 4] },
      { index: 1, header: "@@ -10,2 +11,2 @@ function f() {", oldRange: [10, 11], newRange: [11, 12] },
    ],
    ...overrides,
  };
}

describe("splitPatchHunks", () => {
  test("splits at @@ lines and drops trailing blank rows", () => {
    const hunks = splitPatchHunks(patch);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.split("\n")[0]).toBe("@@ -1,3 +1,4 @@");
    expect(hunks[1]!).toBe("@@ -10,2 +11,2 @@ function f() {\n-  return 1;\n+  return 2;");
  });
});

describe("buildPromptFiles / renderPrompt", () => {
  test("numbers hunks 1-based and labels them in the prompt", () => {
    const files = buildPromptFiles([file()]);
    expect(files[0]!.hunks.map((hunk) => hunk.number)).toEqual([1, 2]);
    expect(inventoryOf(files)).toEqual([{ path: "src/a.ts", hunkCount: 2 }]);
    const prompt = renderPrompt(files, { title: "t", maxChars: 100_000 });
    expect(prompt).toContain("--- src/a.ts hunk 1 (old 1-3, new 1-4) ---");
    expect(prompt).toContain("--- src/a.ts hunk 2 (old 10-11, new 11-12) ---");
    expect(prompt).toContain("+const b = 2;");
    expect(prompt).not.toContain("Reviewer focus");
  });

  test("includes the reviewer focus when given", () => {
    const prompt = renderPrompt(buildPromptFiles([file()]), { title: "t", maxChars: 100_000, focus: "the retry path" });
    expect(prompt).toContain("Reviewer focus: the retry path");
  });

  test("falls back to the whole patch when hunk counts disagree", () => {
    const files = buildPromptFiles([file({ hunks: [{ index: 0, header: "@@ -1 +1 @@" }] })]);
    expect(files[0]!.hunks).toHaveLength(1);
    expect(files[0]!.hunks[0]!.text).toContain("return 2;");
  });

  test("shortens hunks when the budget is exceeded", () => {
    const big = Array.from({ length: 4000 }, (_, index) => `+line ${index}`).join("\n");
    const truncated = truncateHunkText(`@@ -1 +1,4000 @@\n${big}`, 5_000);
    expect(truncated.length).toBeLessThan(6_000);
    expect(truncated).toContain("lines omitted to fit the prompt budget");
    expect(truncated.startsWith("@@ -1 +1,4000 @@")).toBe(true);
    expect(truncated.endsWith("+line 3999")).toBe(true);
  });
});
