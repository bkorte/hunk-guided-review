import { describe, expect, test } from "bun:test";
import { DEFAULT_PANE_WIDTH, isPlainToken, readSettings } from "../src/settings.ts";

describe("readSettings", () => {
  test("defaults for an empty config", () => {
    const settings = readSettings({});
    expect(settings.autoGenerate).toBe(false);
    expect(settings.harness).toBe("claude");
    expect(settings.tools).toBe("read");
    expect(settings.maxTurns).toBe(30);
    expect(settings.timeoutMs).toBe(600_000);
    expect(settings.maxPromptChars).toBe(400_000);
    expect(settings.paneWidth).toBe(DEFAULT_PANE_WIDTH);
    expect(settings.model).toBeUndefined();
  });

  test("caps run limits so repo config cannot raise them without bound", () => {
    const settings = readSettings({ max_turns: 10_000, timeout_seconds: 86_400, max_prompt_chars: 50_000_000 });
    expect(settings.maxTurns).toBe(100);
    expect(settings.timeoutMs).toBe(1_800_000);
    expect(settings.maxPromptChars).toBe(1_000_000);
    const low = readSettings({ max_turns: 0, timeout_seconds: 1, max_prompt_chars: 5 });
    expect(low.maxTurns).toBe(2);
    expect(low.timeoutMs).toBe(30_000);
    expect(low.maxPromptChars).toBe(20_000);
  });

  test("ignores values of the wrong type or outside the known set", () => {
    const settings = readSettings({ auto_generate: "yes", harness: "bash", tools: "all", max_turns: "50", pane: "top" });
    expect(settings.autoGenerate).toBe(false);
    expect(settings.harness).toBe("claude");
    expect(settings.tools).toBe("read");
    expect(settings.maxTurns).toBe(30);
    expect(settings.placement).toBe("left");
  });

  test("passes plain model and provider names through and drops anything else", () => {
    expect(readSettings({ model: "claude-sonnet-4-5", provider: "openrouter" })).toMatchObject({
      model: "claude-sonnet-4-5",
      provider: "openrouter",
    });
    expect(readSettings({ model: "--dangerously-skip-permissions", provider: "-x" })).toMatchObject({
      model: undefined,
      provider: undefined,
    });
  });
});

describe("isPlainToken", () => {
  test("accepts model ids and rejects flags, spaces, and shell syntax", () => {
    for (const ok of ["sonnet", "gpt-5.4", "openai/gpt-5", "anthropic:claude-opus", "a"]) {
      expect(isPlainToken(ok)).toBe(true);
    }
    for (const bad of ["", "-m", "--model", "~custom", "a b", "a;b", "$(x)", "a\nb", "x".repeat(121), 7]) {
      expect(isPlainToken(bad)).toBe(false);
    }
  });
});
