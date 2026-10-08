import { describe, expect, test } from "bun:test";
import {
  nextUnreviewedFile,
  nextUnreviewedSection,
  normalizeGuide,
  orderedLocations,
  parseStoredGuide,
  REMAINING_SECTION_TITLE,
  sectionIndexFor,
} from "../src/guide.ts";

const inventory = [
  { path: "src/a.ts", hunkCount: 2 },
  { path: "src/b.ts", hunkCount: 1 },
  { path: "README.md", hunkCount: 1 },
];

describe("normalizeGuide", () => {
  test("keeps valid sections and appends unassigned hunks", () => {
    const guide = normalizeGuide(
      {
        title: "Add thing",
        summary: "Does a thing.",
        sections: [
          {
            title: "Core",
            kind: "core",
            risk: "high",
            explanation: "The core.",
            lookFor: ["edge case"],
            locations: [
              { path: "src/a.ts", hunk: 1, note: "entry point" },
              { path: "src/b.ts", hunk: 1 },
            ],
          },
        ],
      },
      inventory,
      { changesetKey: "k" },
    );
    expect(guide.sections).toHaveLength(2);
    expect(guide.sections[0]!.locations).toEqual([
      { path: "src/a.ts", hunk: 1, note: "entry point" },
      { path: "src/b.ts", hunk: 1 },
    ]);
    expect(guide.sections[1]!.title).toBe(REMAINING_SECTION_TITLE);
    expect(guide.sections[1]!.locations).toEqual([
      { path: "src/a.ts", hunk: 2 },
      { path: "README.md", hunk: 1 },
    ]);
    expect(guide.unassigned).toBe(2);
    expect(guide.changesetKey).toBe("k");
  });

  test("drops unknown paths, out-of-range hunks, duplicates, and empty sections", () => {
    const guide = normalizeGuide(
      {
        sections: [
          { title: "Ghost", locations: [{ path: "nope.ts", hunk: 1 }, { path: "src/a.ts", hunk: 9 }] },
          { title: "First", kind: "weird", risk: "extreme", locations: [{ path: "src/a.ts", hunk: 1 }] },
          { title: "Dup", locations: [{ path: "src/a.ts", hunk: 1 }, { path: "src/a.ts", hunk: 2 }] },
        ],
      },
      inventory,
      { changesetKey: "k" },
    );
    expect(guide.sections.map((section) => section.title)).toEqual(["First", "Dup", REMAINING_SECTION_TITLE]);
    expect(guide.sections[0]!.kind).toBe("supporting");
    expect(guide.sections[0]!.risk).toBe("low");
    expect(guide.sections[1]!.locations).toEqual([{ path: "src/a.ts", hunk: 2 }]);
    expect(guide.title).toBe("Review guide");
  });

  test("garbage output still yields a complete catch-all guide", () => {
    const guide = normalizeGuide("nonsense", inventory, { changesetKey: "k" });
    expect(guide.sections).toHaveLength(1);
    expect(guide.sections[0]!.locations).toHaveLength(4);
    expect(orderedLocations(guide).map((location) => location.sectionIndex)).toEqual([0, 0, 0, 0]);
  });

  test("sectionIndexFor and parseStoredGuide round trip", () => {
    const guide = normalizeGuide(
      { sections: [{ title: "Only", locations: [{ path: "src/b.ts", hunk: 1 }] }] },
      inventory,
      { changesetKey: "k" },
    );
    expect(sectionIndexFor(guide, "src/b.ts", 1)).toBe(0);
    expect(sectionIndexFor(guide, "src/a.ts", 1)).toBe(1);
    expect(sectionIndexFor(guide, "src/a.ts", 7)).toBe(-1);
    expect(parseStoredGuide(JSON.stringify(guide))).toEqual(guide);
    expect(parseStoredGuide("{}")).toBeNull();
    expect(parseStoredGuide("not json")).toBeNull();
  });
});

describe("auto-advance helpers", () => {
  const guide = normalizeGuide(
    {
      sections: [
        { title: "A", locations: [{ path: "src/a.ts", hunk: 1 }, { path: "src/b.ts", hunk: 1 }] },
        { title: "B", locations: [{ path: "src/a.ts", hunk: 2 }] },
        { title: "C", locations: [{ path: "README.md", hunk: 1 }] },
      ],
    },
    inventory,
    { changesetKey: "k" },
  );
  test("nextUnreviewedSection wraps and skips finished sections", () => {
    expect(nextUnreviewedSection(guide, 0, new Set())).toBe(1);
    expect(nextUnreviewedSection(guide, 2, new Set())).toBe(0);
    expect(nextUnreviewedSection(guide, 0, new Set(["src/a.ts"]))).toBe(2);
    expect(nextUnreviewedSection(guide, 1, new Set(["src/a.ts", "src/b.ts", "README.md"]))).toBe(-1);
  });
  test("nextUnreviewedFile walks (section, file) stops in order", () => {
    expect(nextUnreviewedFile(guide, 0, "src/a.ts", new Set(["src/a.ts"]))).toEqual({ sectionIndex: 0, path: "src/b.ts", hunk: 1 });
    expect(nextUnreviewedFile(guide, 0, "src/b.ts", new Set(["src/a.ts", "src/b.ts"]))).toEqual({ sectionIndex: 2, path: "README.md", hunk: 1 });
    expect(nextUnreviewedFile(guide, 2, "README.md", new Set(["README.md"]))).toEqual({ sectionIndex: 0, path: "src/a.ts", hunk: 1 });
    expect(nextUnreviewedFile(guide, 2, "README.md", new Set(["src/a.ts", "src/b.ts", "README.md"]))).toBeNull();
  });
});
