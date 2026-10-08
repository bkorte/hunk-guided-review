import type { ExtensionPanePlacement } from "hunkdiff/extension";
import { isHarness, type Harness, type ToolAccess } from "./harness.ts";

/** Wide enough for a full explanation sentence per row; Hunk shrinks it on narrower terminals. */
export const DEFAULT_PANE_WIDTH = 75;

/** User settings from `[extension.hunk-guided-review]`, validated because repo config can set them. */
export interface Settings {
  autoGenerate: boolean;
  inlineNotes: boolean;
  dimLowSignal: boolean;
  cache: boolean;
  reorderFiles: boolean;
  /** Close the built-in files pane while the guide pane is open, and reopen it when the guide closes. */
  replaceFilesPane: boolean;
  /** After marking a section or file reviewed, move to the next one still open. */
  advanceOnSectionReviewed: boolean;
  advanceOnFileReviewed: boolean;
  harness: Harness;
  model?: string;
  provider?: string;
  tools: ToolAccess;
  maxTurns: number;
  timeoutMs: number;
  maxPromptChars: number;
  placement: Extract<ExtensionPanePlacement, "left" | "right">;
  paneWidth: number;
}

/**
 * A model or provider name safe to pass as a flag value: a plain token that
 * starts with a letter or digit, so it can never be read as another flag.
 */
export function isPlainToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/~-]{0,119}$/.test(value);
}

/**
 * Read the extension's settings. Hunk layers repo config over user config, so
 * a reviewed repository can set any of these; the run limits are capped to
 * bound what a repo that turns on `auto_generate` can spend.
 */
export function readSettings(config: Record<string, unknown>): Settings {
  const bool = (key: string, fallback: boolean) =>
    typeof config[key] === "boolean" ? (config[key] as boolean) : fallback;
  const num = (key: string, fallback: number, min: number, max: number) => {
    const value = config[key];
    return typeof value === "number" && Number.isFinite(value)
      ? Math.min(max, Math.max(min, value))
      : fallback;
  };
  const token = (key: string) => (isPlainToken(config[key]) ? config[key] : undefined);
  return {
    autoGenerate: bool("auto_generate", false),
    inlineNotes: bool("inline_notes", true),
    dimLowSignal: bool("dim_low_signal", true),
    cache: bool("cache", true),
    reorderFiles: bool("reorder_files", true),
    replaceFilesPane: bool("replace_files_pane", true),
    advanceOnSectionReviewed: bool("advance_on_section_reviewed", true),
    advanceOnFileReviewed: bool("advance_on_file_reviewed", true),
    harness: isHarness(config.harness) ? config.harness : "claude",
    model: token("model"),
    provider: token("provider"),
    tools: config.tools === "none" ? "none" : "read",
    maxTurns: num("max_turns", 30, 2, 100),
    timeoutMs: num("timeout_seconds", 600, 30, 1_800) * 1_000,
    maxPromptChars: num("max_prompt_chars", 400_000, 20_000, 1_000_000),
    placement: config.pane === "right" ? "right" : "left",
    paneWidth: num("pane_width", DEFAULT_PANE_WIDTH, 28, 400),
  };
}
