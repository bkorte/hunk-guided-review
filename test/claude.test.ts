import { describe, expect, test } from "bun:test";
import { buildClaudeArgs, parseClaudeEnvelope, READ_ONLY_TOOLS } from "../src/claude.ts";

describe("buildClaudeArgs", () => {
  test("read-only tools and a floor of two turns", () => {
    const args = buildClaudeArgs({ schema: { type: "object" }, systemPrompt: "sys", maxTurns: 1, tools: "read", model: "sonnet" });
    expect(args.slice(0, 3)).toEqual(["-p", "--output-format", "json"]);
    expect(args).toContain("--json-schema");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("2");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe(READ_ONLY_TOOLS);
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
    expect(args).toContain("--no-session-persistence");
  });

  test("ignores the reviewed repo's settings, hooks, and MCP servers", () => {
    const args = buildClaudeArgs({ schema: {}, systemPrompt: "sys", maxTurns: 5, tools: "read" });
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("user");
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--mcp-config");
  });

  test("no tools at all for diff-only runs", () => {
    const args = buildClaudeArgs({ schema: {}, systemPrompt: "sys", maxTurns: 5, tools: "none" });
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).not.toContain("--model");
  });
});

describe("parseClaudeEnvelope", () => {
  test("prefers structured_output", () => {
    const { output } = parseClaudeEnvelope(JSON.stringify({ result: "text", structured_output: { a: 1 } }));
    expect(output).toEqual({ a: 1 });
  });

  test("falls back to JSON in result, fenced or not", () => {
    expect(parseClaudeEnvelope(JSON.stringify({ result: '{"a":2}' })).output).toEqual({ a: 2 });
    expect(parseClaudeEnvelope(JSON.stringify({ result: "```json\n{\"a\":3}\n```" })).output).toEqual({ a: 3 });
  });

  test("reports errors and empty output", () => {
    expect(() => parseClaudeEnvelope(JSON.stringify({ is_error: true, result: "boom" }))).toThrow(/boom/);
    expect(() => parseClaudeEnvelope("")).toThrow(/no output/);
    expect(() => parseClaudeEnvelope(JSON.stringify({ result: "just prose", subtype: "error_max_turns" }))).toThrow(/error_max_turns/);
  });

  test("takes the last JSON line when warnings precede it", () => {
    const text = `warning: something\n${JSON.stringify({ structured_output: { ok: true } })}`;
    expect(parseClaudeEnvelope(text).output).toEqual({ ok: true });
  });
});
