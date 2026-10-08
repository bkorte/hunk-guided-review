import { describe, expect, test } from "bun:test";
import { normalizeGuide } from "../src/guide.ts";
import { buildGuideComments, collectCommentIds, hunkBinary, NOTE_AUTHOR } from "../src/session.ts";

describe("buildGuideComments", () => {
  test("first location carries the section explanation, others only their note", () => {
    const guide = normalizeGuide(
      {
        sections: [
          {
            title: "Core",
            kind: "core",
            risk: "high",
            explanation: "Why.",
            lookFor: ["check x"],
            locations: [
              { path: "a.ts", hunk: 1 },
              { path: "b.ts", hunk: 1, note: "glue" },
            ],
          },
        ],
      },
      [
        { path: "a.ts", hunkCount: 1 },
        { path: "b.ts", hunkCount: 1 },
      ],
      { changesetKey: "k" },
    );
    const comments = buildGuideComments(guide);
    expect(comments).toHaveLength(2);
    expect(comments[0]).toEqual({
      filePath: "a.ts",
      hunk: 1,
      summary: "§1 Core (1/2) · high risk",
      rationale: "Why.\n\nLook for:\n- check x",
      author: NOTE_AUTHOR,
    });
    expect(comments[1]).toEqual({ filePath: "b.ts", hunk: 1, summary: "§1 Core (2/2) · high risk", rationale: "glue", author: NOTE_AUTHOR });
  });
});

describe("collectCommentIds", () => {
  test("finds ids anywhere in the response", () => {
    const ids = collectCommentIds({ result: { applied: [{ commentId: "c1" }, { commentId: "c2", nested: { commentId: "c3" } }] } });
    expect(ids).toEqual(["c1", "c2", "c3"]);
  });
});

describe("hunkBinary", () => {
  test("uses the running Hunk binary when that is what we are", () => {
    expect(hunkBinary("/Users/me/.hunk/bin/hunk")).toBe("/Users/me/.hunk/bin/hunk");
    expect(hunkBinary("C:\\hunk\\hunk.exe")).toBe("C:\\hunk\\hunk.exe");
    expect(hunkBinary("/usr/local/bin/bun")).toBe("hunk");
  });
});
