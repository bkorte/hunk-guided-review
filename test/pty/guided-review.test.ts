import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { changesetKey, writeCachedGuide } from "../../src/cache.ts";
import { collectFiles } from "../../scripts/generate.ts";

/**
 * PTY integration test, driven through Hunk's own test harness.
 *
 * Needs a Hunk checkout with its dev dependencies installed (`bun install`,
 * plus `bun add -d tuistory`), pointed at by HUNK_CHECKOUT:
 *
 *   HUNK_CHECKOUT=~/src/hunk bun test test/pty
 *
 * Without HUNK_CHECKOUT the test is skipped.
 */
const HUNK_CHECKOUT = process.env.HUNK_CHECKOUT;
const EXTENSION = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
// The harness type lives in the Hunk checkout; keep it loose so this file compiles without one.
type Harness = {
  cleanup(): void;
  launchHunk(options: { args: string[]; cwd?: string; cols?: number; rows?: number; env?: Record<string, string | undefined> }): Promise<any>;
  waitForSnapshot(session: any, predicate: (text: string) => boolean, timeoutMs?: number): Promise<string>;
  ensureKeyboardIsLive(session: any): Promise<void>;
};
const harnessModule = HUNK_CHECKOUT
  ? ((await import(join(HUNK_CHECKOUT, "test/pty/harness.ts"))) as { createPtyHarness(): Harness })
  : null;
const harness = harnessModule?.createPtyHarness() as Harness;
const run = harnessModule ? test : test.skip;
setDefaultTimeout(60_000);

const dirs: string[] = [];
afterEach(() => {
  harness?.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Left-click a rendered cell; snapshots carry a leading blank line, so terminal row = line index - 1. */
async function click(session: any, x: number, y: number) {
  // Two presses within the double-click window are coalesced, so space clicks out.
  await new Promise((resolve) => setTimeout(resolve, 600));
  await session.clickAt(x, y - 1);
  await session.waitIdle();
}

/** Find the first (row, column) where `needle` appears on a line containing `onLine`. */
function locate(text: string, onLine: string, needle: string): { x: number; y: number } {
  const lines = text.split("\n");
  const y = lines.findIndex((line) => line.includes(onLine) && line.includes(needle));
  if (y < 0) throw new Error(`no line with ${onLine} and ${needle}:\n${text}`);
  return { x: lines[y]!.indexOf(needle), y };
}

function git(args: string[], cwd: string) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "guided-review-"));
  dirs.push(dir);
  git(["init", "-q"], dir);
  git(["config", "user.name", "Pi"], dir);
  git(["config", "user.email", "pi@example.com"], dir);
  const filler = Array.from({ length: 30 }, (_, i) => `export const filler${i} = ${i};`).join("\n");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/app.ts"), `export function start() {\n  return 1;\n}\n${filler}\nexport function stop() {\n  return 0;\n}\n`);
  writeFileSync(join(dir, "README.md"), "# App\n\nOld intro.\n");
  writeFileSync(join(dir, ".gitignore"), ".hunk/\nguide.json\n");
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "initial"], dir);
  writeFileSync(join(dir, "src/app.ts"), `export function start() {\n  return 2; // changed\n}\n${filler}\nexport function stop() {\n  return -1; // changed\n}\n`);
  writeFileSync(join(dir, "README.md"), "# App\n\nNew intro that explains more.\n");
  mkdirSync(join(dir, ".hunk"), { recursive: true });
  writeFileSync(join(dir, ".hunk/config.toml"), `[extension.hunk-guided-review]\ninline_notes = false\npane_width = 44\n`);

  const guide = {
    version: 1,
    changesetKey: "seed",
    generatedAt: new Date().toISOString(),
    title: "Flip start and stop return values",
    summary: "Both entry points now return different sentinel values, and the README explains the app.",
    sections: [
      {
        title: "Core Logic",
        kind: "core",
        risk: "high",
        explanation: "start and stop return new sentinels; every caller comparing against the old values must change.",
        lookFor: ["Callers that compare against 1 or 0"],
        locations: [
          { path: "src/app.ts", hunk: 1, note: "entry point" },
          { path: "src/app.ts", hunk: 2 },
        ],
      },
      {
        title: "Docs Refresh",
        kind: "docs",
        risk: "low",
        explanation: "The README intro is rewritten.",
        lookFor: [],
        locations: [{ path: "README.md", hunk: 1 }],
      },
    ],
    unassigned: 0,
  };
  const guidePath = join(dir, "guide.json");
  writeFileSync(guidePath, JSON.stringify(guide));
  return { dir, guidePath };
}

describe("hunk-guided-review", () => {
  run("loads a seeded guide, renders the pane, and navigates by section", async () => {
    const { dir, guidePath } = makeFixture();
    const cache = mkdtempSync(join(tmpdir(), "guided-review-cache-"));
    dirs.push(cache);
    const session = await harness.launchHunk({
      args: ["diff", "--extension", EXTENSION],
      cwd: dir,
      cols: 160,
      rows: 40,
      env: { HUNK_GUIDED_REVIEW_GUIDE: guidePath, XDG_CACHE_HOME: cache },
    });
    try {
      let text = await harness.waitForSnapshot(
        session,
        (snapshot) => snapshot.includes("▶ 2. Docs Refresh") && snapshot.includes("README.md #1"),
        15_000,
      );
      expect(text).toContain("Flip start and stop return values");
      expect(text).toContain("1. Core Logic");
      expect(text).toContain("1/3 hunks seen");
      // A key the host already owns is refused, so the hint would drop it.
      expect(text).toContain("J next hunk");
      // The guide pane stands in for the files pane while it is open.
      expect(text).not.toMatch(/\bM\s+app\.ts/);

      await harness.ensureKeyboardIsLive(session);
      await session.press("H");
      text = await harness.waitForSnapshot(session, (snapshot) => snapshot.includes("▶ 1. Core Logic"), 10_000);
      expect(text).toContain("src/app.ts #1");
      expect(text).toContain("entry point");
      expect(text).toContain("Callers that compare");

      await session.press("J");
      text = await harness.waitForSnapshot(session, (snapshot) => snapshot.includes("3/3 hunks seen"), 10_000);
      expect(text).toContain("· src/app.ts #1 #2");

      await session.press("J");
      text = await harness.waitForSnapshot(session, (snapshot) => snapshot.includes("▶ 2. Docs Refresh"), 10_000);

      session.writeRaw("\x18"); // ctrl+x: mark section 2 reviewed, auto-advance wraps to section 1
      text = await harness.waitForSnapshot(session, (snapshot) => /Marked section 2/.test(snapshot) && snapshot.includes("▶ 1. Core Logic"), 10_000);
      expect(text).toMatch(/✓ 2\. Docs Refresh/);
      expect(text).toContain("1/2 files done");

      // Go back to section 2, click its button to unmark it, then click the file checkbox to mark
      // just the file; that auto-advances to the next open file, back in section 1.
      await session.press("L");
      text = await harness.waitForSnapshot(session, (snapshot) => snapshot.includes("[✓ section reviewed]"), 10_000);
      let target = locate(text, "Documentation", "[✓ section reviewed]");
      await click(session, target.x + 1, target.y);
      text = await harness.waitForSnapshot(session, (snapshot) => snapshot.includes("[ mark section reviewed ]") && snapshot.includes("0/2 files done"), 10_000);
      target = locate(text, "README.md #1", "[ ]");
      await click(session, target.x + 1, target.y);
      text = await harness.waitForSnapshot(session, (snapshot) => snapshot.includes("1/2 files done") && snapshot.includes("▶ 1. Core Logic"), 10_000);
      expect(text).toMatch(/✓ 2\. Docs Refresh/);

      // Mark the current file (src/app.ts) with the key; everything is done now.
      await session.press("x");
      text = await harness.waitForSnapshot(session, (snapshot) => snapshot.includes("2/2 files done"), 10_000);
      expect(text).toMatch(/✓ 1\. Core Logic/);

      session.writeRaw("\x07"); // ctrl+g: guide exists dialog
      text = await harness.waitForSnapshot(session, (snapshot) => snapshot.includes("A review guide already exists"), 10_000);
      await session.press("escape");

      session.writeRaw("\x14"); // ctrl+t: toggle pane off
      text = await harness.waitForSnapshot(session, (snapshot) => !snapshot.includes("Core Logic") && /\bM\s+app\.ts/.test(snapshot), 10_000);
      expect(text).not.toContain("Review guide");
    } finally {
      session.close();
    }
  });

  run("without a guide the pane explains how to generate one", async () => {
    const { dir } = makeFixture();
    const cache = mkdtempSync(join(tmpdir(), "guided-review-cache-"));
    dirs.push(cache);
    const session = await harness.launchHunk({
      args: ["diff", "--extension", EXTENSION],
      cwd: dir,
      cols: 160,
      rows: 40,
      env: { XDG_CACHE_HOME: cache },
    });
    try {
      await harness.waitForSnapshot(session, (snapshot) => snapshot.includes("src/app.ts"), 15_000);
      await harness.ensureKeyboardIsLive(session);
      session.writeRaw("\x14");
      const text = await harness.waitForSnapshot(session, (snapshot) => snapshot.includes("Review guide"), 10_000);
      expect(text).toContain("Press ctrl+g to generate");
    } finally {
      session.close();
    }
  });

  run("a guide pre-generated from git diff is found in the cache by a plain launch", async () => {
    const { dir, guidePath } = makeFixture();
    writeFileSync(join(dir, "NOTES.txt"), "brand new file\nwith two lines\n");
    const cache = mkdtempSync(join(tmpdir(), "guided-review-cache-"));
    dirs.push(cache);
    process.env.XDG_CACHE_HOME = cache;

    const files = collectFiles({ cwd: dir, gitArgs: [], includeUntracked: true });
    expect(files.map((file) => file.path).sort()).toEqual(["NOTES.txt", "README.md", "src/app.ts"]);
    const stored = JSON.parse(readFileSync(guidePath, "utf8"));
    stored.changesetKey = changesetKey(files);
    stored.title = "PREGENERATED GUIDE";
    stored.sections.push({ title: "New Notes", kind: "docs", risk: "low", explanation: "Adds notes.", lookFor: [], locations: [{ path: "NOTES.txt", hunk: 1 }] });
    await writeCachedGuide(stored);

    const session = await harness.launchHunk({
      args: ["diff", "--extension", EXTENSION],
      cwd: dir,
      cols: 160,
      rows: 40,
      env: { XDG_CACHE_HOME: cache },
    });
    try {
      const text = await harness.waitForSnapshot(
        session,
        (snapshot) => snapshot.includes("PREGENERATED GUIDE") && snapshot.includes("3. New Notes"),
        15_000,
      );
      expect(text).toContain("cached");
      expect(text).not.toContain("Remaining changes");
      // The review stream is reordered by section: src/app.ts (section 1) before README.md (section 2).
      const streamLines = text.split("\n").filter((line) => !/\bM\s+\S/.test(line) && !line.includes("#"));
      const appIndex = streamLines.findIndex((line) => /src\/app\.ts\s+\+\d/.test(line));
      const readmeIndex = streamLines.findIndex((line) => /README\.md\s+\+\d/.test(line));
      expect(appIndex).toBeGreaterThanOrEqual(0);
      expect(readmeIndex).toBeGreaterThan(appIndex);
    } finally {
      session.close();
    }
  });

  run("reviewed marks survive quitting and relaunching", async () => {
    const { dir, guidePath } = makeFixture();
    const cache = mkdtempSync(join(tmpdir(), "guided-review-cache-"));
    dirs.push(cache);
    const launch = () =>
      harness.launchHunk({
        args: ["diff", "--extension", EXTENSION],
        cwd: dir,
        cols: 160,
        rows: 40,
        env: { HUNK_GUIDED_REVIEW_GUIDE: guidePath, XDG_CACHE_HOME: cache },
      });

    let session = await launch();
    try {
      await harness.waitForSnapshot(session, (snapshot) => snapshot.includes("▶ 2. Docs Refresh"), 15_000);
      await harness.ensureKeyboardIsLive(session);
      await session.press("x"); // README.md reviewed; auto-advance moves to src/app.ts
      await harness.waitForSnapshot(session, (snapshot) => snapshot.includes("1/2 files done"), 10_000);
      await new Promise((resolve) => setTimeout(resolve, 500)); // let the mark reach disk
    } finally {
      session.close();
    }

    session = await launch();
    try {
      const text = await harness.waitForSnapshot(session, (snapshot) => snapshot.includes("1/2 files done"), 15_000);
      expect(text).toMatch(/✓ 2\. Docs Refresh/);
    } finally {
      session.close();
    }
  });
});
