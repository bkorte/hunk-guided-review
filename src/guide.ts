/**
 * The review guide: a changeset regrouped into logical sections, each with an
 * explanation, ordered the way a reviewer should read them.
 */

export const GUIDE_FORMAT_VERSION = 1;

export const SECTION_KINDS = [
  "core",
  "supporting",
  "tests",
  "config",
  "docs",
  "generated",
  "cleanup",
] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

export const RISK_LEVELS = ["low", "medium", "high"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** One hunk the guide points at. `hunk` is 1-based within the file, in render order. */
export interface GuideLocation {
  path: string;
  hunk: number;
  /** What this specific hunk contributes to the section, when it is not obvious. */
  note?: string;
}

export interface GuideSection {
  title: string;
  kind: SectionKind;
  risk: RiskLevel;
  /** What the section does, why it exists, and how it connects to the rest. */
  explanation: string;
  /** Concrete things a reviewer should verify in this section. */
  lookFor: string[];
  /** Hunks in the order they should be read. */
  locations: GuideLocation[];
}

export interface ReviewGuide {
  version: typeof GUIDE_FORMAT_VERSION;
  /** Content hash of the reviewed patches this guide was written against. */
  changesetKey: string;
  generatedAt: string;
  model?: string;
  costUsd?: number;
  durationMs?: number;
  title: string;
  summary: string;
  sections: GuideSection[];
  /** Hunks the model never assigned; they land in the trailing catch-all section. */
  unassigned: number;
}

/** The JSON Schema for the model's answer: enforced by claude and codex, quoted in the prompt for pi. */
export const GUIDE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "summary", "sections"],
  properties: {
    title: {
      type: "string",
      description: "A short title for the whole change, like a good PR title.",
    },
    summary: {
      type: "string",
      description:
        "Two to four sentences: what the change accomplishes, why, and the shape of the approach. Written for a reviewer who has not read the diff.",
    },
    sections: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "kind", "risk", "explanation", "lookFor", "locations"],
        properties: {
          title: { type: "string", description: "Short section title naming the concern." },
          kind: { type: "string", enum: [...SECTION_KINDS] },
          risk: {
            type: "string",
            enum: [...RISK_LEVELS],
            description: "How much reviewer attention this section deserves.",
          },
          explanation: {
            type: "string",
            description:
              "Two to four sentences explaining what these hunks do together, why, and how they relate to the other sections.",
          },
          lookFor: {
            type: "array",
            items: { type: "string" },
            description: "Zero to three concrete things a reviewer should verify here.",
          },
          locations: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["path", "hunk"],
              properties: {
                path: { type: "string", description: "Exact file path as given in the input." },
                hunk: {
                  type: "integer",
                  minimum: 1,
                  description: "1-based hunk number within that file, as numbered in the input.",
                },
                note: {
                  type: "string",
                  description: "One sentence on what this hunk contributes, when not obvious.",
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

/** What the reviewed changeset actually contains, for validating model output. */
export interface HunkInventoryFile {
  path: string;
  hunkCount: number;
}

export interface GuideMeta {
  changesetKey: string;
  generatedAt?: string;
  model?: string;
  costUsd?: number;
  durationMs?: number;
}

export const REMAINING_SECTION_TITLE = "Remaining changes";

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

function isSectionKind(value: unknown): value is SectionKind {
  return typeof value === "string" && (SECTION_KINDS as readonly string[]).includes(value);
}

function isRiskLevel(value: unknown): value is RiskLevel {
  return typeof value === "string" && (RISK_LEVELS as readonly string[]).includes(value);
}

export function locationKey(path: string, hunk: number): string {
  return `${path}#${hunk}`;
}

/**
 * Turn raw model output into a guide that only references hunks the review
 * actually has, with every hunk assigned to exactly one section.
 *
 * Unknown paths and out-of-range hunk numbers are dropped, a hunk claimed twice
 * stays with the first section that claimed it, sections left empty disappear,
 * and anything the model never mentioned is collected into a trailing
 * "Remaining changes" section so the guide always covers the whole diff.
 */
export function normalizeGuide(
  raw: unknown,
  inventory: readonly HunkInventoryFile[],
  meta: GuideMeta,
): ReviewGuide {
  const source = (raw ?? {}) as Record<string, unknown>;
  const hunkCounts = new Map(inventory.map((file) => [file.path, file.hunkCount]));
  const seen = new Set<string>();
  const sections: GuideSection[] = [];

  const rawSections = Array.isArray(source.sections) ? source.sections : [];
  for (const entry of rawSections) {
    const section = (entry ?? {}) as Record<string, unknown>;
    const locations: GuideLocation[] = [];
    const rawLocations = Array.isArray(section.locations) ? section.locations : [];
    for (const candidate of rawLocations) {
      const location = (candidate ?? {}) as Record<string, unknown>;
      const path = asString(location.path);
      const hunk = typeof location.hunk === "number" ? Math.trunc(location.hunk) : Number.NaN;
      const count = hunkCounts.get(path);
      if (count === undefined || !Number.isInteger(hunk) || hunk < 1 || hunk > count) continue;
      const key = locationKey(path, hunk);
      if (seen.has(key)) continue;
      seen.add(key);
      const note = asString(location.note).trim();
      locations.push(note ? { path, hunk, note } : { path, hunk });
    }
    if (locations.length === 0) continue;
    sections.push({
      title: asString(section.title).trim() || `Section ${sections.length + 1}`,
      kind: isSectionKind(section.kind) ? section.kind : "supporting",
      risk: isRiskLevel(section.risk) ? section.risk : "low",
      explanation: asString(section.explanation).trim(),
      lookFor: asStringList(section.lookFor).map((item) => item.trim()),
      locations,
    });
  }

  const remaining: GuideLocation[] = [];
  for (const file of inventory) {
    for (let hunk = 1; hunk <= file.hunkCount; hunk += 1) {
      if (!seen.has(locationKey(file.path, hunk))) remaining.push({ path: file.path, hunk });
    }
  }
  if (remaining.length > 0) {
    sections.push({
      title: REMAINING_SECTION_TITLE,
      kind: "supporting",
      risk: "low",
      explanation:
        sections.length === 0
          ? "The guide could not be generated for this diff, so every hunk is listed here in file order."
          : "Hunks the guide did not assign to a section, listed in file order.",
      lookFor: [],
      locations: remaining,
    });
  }

  return {
    version: GUIDE_FORMAT_VERSION,
    changesetKey: meta.changesetKey,
    generatedAt: meta.generatedAt ?? new Date().toISOString(),
    model: meta.model,
    costUsd: meta.costUsd,
    durationMs: meta.durationMs,
    title: asString(source.title).trim() || "Review guide",
    summary: asString(source.summary).trim(),
    sections,
    unassigned: remaining.length,
  };
}

/** Every location in reading order, tagged with its section index. */
export function orderedLocations(
  guide: ReviewGuide,
): Array<GuideLocation & { sectionIndex: number }> {
  return guide.sections.flatMap((section, sectionIndex) =>
    section.locations.map((location) => ({ ...location, sectionIndex })),
  );
}

/** The section index owning one hunk, or -1. */
export function sectionIndexFor(guide: ReviewGuide, path: string, hunk: number): number {
  return guide.sections.findIndex((section) =>
    section.locations.some((location) => location.path === path && location.hunk === hunk),
  );
}

/** Read a guide back from JSON, refusing anything that is not one of ours. */
export function parseStoredGuide(text: string): ReviewGuide | null {
  try {
    const value = JSON.parse(text) as Partial<ReviewGuide>;
    if (
      value &&
      value.version === GUIDE_FORMAT_VERSION &&
      typeof value.changesetKey === "string" &&
      Array.isArray(value.sections)
    ) {
      return value as ReviewGuide;
    }
  } catch {
    // fall through
  }
  return null;
}

/** Unique file paths in one section, in reading order. */
export function sectionFiles(section: GuideSection): string[] {
  const paths: string[] = [];
  for (const location of section.locations) {
    if (!paths.includes(location.path)) paths.push(location.path);
  }
  return paths;
}

/** Every file the guide mentions, ordered by first appearance across sections. */
export function guideFileOrder(guide: ReviewGuide): string[] {
  const paths: string[] = [];
  for (const section of guide.sections) {
    for (const path of sectionFiles(section)) {
      if (!paths.includes(path)) paths.push(path);
    }
  }
  return paths;
}

/** Reorder files so the review stream follows the guide; unmentioned files keep their order at the end. */
export function orderFilesByGuide<T extends { path: string }>(files: readonly T[], guide: ReviewGuide): T[] {
  const rank = new Map(guideFileOrder(guide).map((path, index) => [path, index]));
  return files
    .map((file, index) => ({ file, index, rank: rank.get(file.path) ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => (a.rank === b.rank ? a.index - b.index : a.rank - b.rank))
    .map((entry) => entry.file);
}

/** A section counts as reviewed once every file it touches is marked reviewed. */
export function isSectionReviewed(section: GuideSection, reviewedFiles: ReadonlySet<string>): boolean {
  const paths = sectionFiles(section);
  return paths.length > 0 && paths.every((path) => reviewedFiles.has(path));
}

/** The next section after `fromIndex` (wrapping) that still has unreviewed files, or -1. */
export function nextUnreviewedSection(guide: ReviewGuide, fromIndex: number, reviewedFiles: ReadonlySet<string>): number {
  const count = guide.sections.length;
  for (let step = 1; step <= count; step += 1) {
    const index = (fromIndex + step) % count;
    if (!isSectionReviewed(guide.sections[index]!, reviewedFiles)) return index;
  }
  return -1;
}

export interface GuideFileStop {
  sectionIndex: number;
  path: string;
  /** First hunk of that file within the section, 1-based. */
  hunk: number;
}

/** Every (section, file) stop in reading order. */
export function fileStops(guide: ReviewGuide): GuideFileStop[] {
  return guide.sections.flatMap((section, sectionIndex) =>
    sectionFiles(section).map((path) => ({
      sectionIndex,
      path,
      hunk: section.locations.find((location) => location.path === path)!.hunk,
    })),
  );
}

/** The next unreviewed file stop after (sectionIndex, path), wrapping, or null when every file is done. */
export function nextUnreviewedFile(
  guide: ReviewGuide,
  sectionIndex: number,
  path: string,
  reviewedFiles: ReadonlySet<string>,
): GuideFileStop | null {
  const stops = fileStops(guide);
  const from = stops.findIndex((stop) => stop.sectionIndex === sectionIndex && stop.path === path);
  for (let step = 1; step <= stops.length; step += 1) {
    const stop = stops[(from + step) % stops.length]!;
    if (!reviewedFiles.has(stop.path)) return stop;
  }
  return null;
}
