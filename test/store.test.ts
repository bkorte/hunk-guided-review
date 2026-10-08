import { beforeEach, describe, expect, test } from "bun:test";
import { normalizeGuide } from "../src/guide.ts";
import {
  getState,
  setAdvanceSettings,
  setGuide,
  setReviewedFiles,
  toggleFileReviewed,
  toggleSectionReviewed,
} from "../src/store.ts";

const guide = normalizeGuide(
  {
    sections: [
      { title: "A", locations: [{ path: "src/a.ts", hunk: 1 }, { path: "src/b.ts", hunk: 1 }] },
      { title: "B", locations: [{ path: "src/a.ts", hunk: 2 }] },
      { title: "C", locations: [{ path: "README.md", hunk: 1 }] },
    ],
  },
  [
    { path: "src/a.ts", hunkCount: 2 },
    { path: "src/b.ts", hunkCount: 1 },
    { path: "README.md", hunkCount: 1 },
  ],
  { changesetKey: "k" },
);

beforeEach(() => {
  setGuide(guide, false);
  setReviewedFiles([]);
  setAdvanceSettings(true, true);
});

describe("toggleSectionReviewed", () => {
  test("marks every file in the section and pins the next open section", () => {
    expect(toggleSectionReviewed(0)).toEqual({ reviewed: true, next: { sectionIndex: 2, path: "README.md", hunk: 1 } });
    expect([...getState().reviewedFiles].sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(getState().pinnedSection).toBe(2);
  });

  test("reports null once every section is reviewed, and unmarks without advancing", () => {
    setReviewedFiles(["src/a.ts", "src/b.ts"]);
    expect(toggleSectionReviewed(2)).toEqual({ reviewed: true, next: null });
    expect(toggleSectionReviewed(2)).toEqual({ reviewed: false });
    expect(getState().reviewedFiles.has("README.md")).toBe(false);
  });

  test("does not advance when the setting is off", () => {
    setAdvanceSettings(false, true);
    expect(toggleSectionReviewed(0)).toEqual({ reviewed: true });
  });
});

describe("toggleFileReviewed", () => {
  test("marks one file and moves to the next open file in reading order", () => {
    expect(toggleFileReviewed("src/a.ts", 0)).toEqual({ reviewed: true, next: { sectionIndex: 0, path: "src/b.ts", hunk: 1 } });
    expect(getState().pinnedSection).toBe(0);
  });

  test("reports null once every file is reviewed, and unmarks without advancing", () => {
    setReviewedFiles(["src/a.ts", "src/b.ts"]);
    expect(toggleFileReviewed("README.md", 2)).toEqual({ reviewed: true, next: null });
    expect(toggleFileReviewed("README.md", 2)).toEqual({ reviewed: false });
  });

  test("does not advance when the setting is off", () => {
    setAdvanceSettings(true, false);
    expect(toggleFileReviewed("src/a.ts", 0)).toEqual({ reviewed: true });
  });
});
