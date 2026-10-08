import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { resolveBinary, runProcess } from "../src/spawn.ts";

/** A repo-like folder with an executable `fakeharness` in `bin/` and at its root. */
function plantedRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hunk-guide-spawn-")));
  mkdirSync(join(dir, "bin"));
  for (const path of [join(dir, "bin", "fakeharness"), join(dir, "fakeharness")]) {
    writeFileSync(path, "#!/bin/sh\necho PLANTED\n");
    chmodSync(path, 0o755);
  }
  writeFileSync(join(dir, "bin", "not-executable"), "");
  return dir;
}

describe.skipIf(process.platform === "win32")("resolveBinary", () => {
  test("finds executables in absolute PATH entries", () => {
    const dir = plantedRepo();
    try {
      expect(resolveBinary("fakeharness", [join(dir, "missing"), join(dir, "bin")].join(delimiter))).toBe(
        join(dir, "bin", "fakeharness"),
      );
      expect(resolveBinary("not-executable", join(dir, "bin"))).toBeUndefined();
      expect(resolveBinary("bin", dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips relative and empty PATH entries, even from inside the repo", async () => {
    const dir = plantedRepo();
    const previous = process.cwd();
    process.chdir(dir);
    try {
      for (const path of ["bin", ".", "", `bin${delimiter}${delimiter}.`]) {
        expect(resolveBinary("fakeharness", path)).toBeUndefined();
      }
      const run = runProcess("fakeharness", [], { cwd: dir, stdin: "", timeoutMs: 5_000, env: { PATH: `bin${delimiter}.` } });
      await expect(run).rejects.toThrow(/could not find `fakeharness` on PATH/);
    } finally {
      process.chdir(previous);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("runProcess runs the resolved binary", async () => {
    const dir = plantedRepo();
    try {
      const result = await runProcess("fakeharness", [], { cwd: tmpdir(), stdin: "", timeoutMs: 5_000, env: { PATH: join(dir, "bin") } });
      expect(result.stdout.trim()).toBe("PLANTED");
      expect(result.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
