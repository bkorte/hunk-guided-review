import { describe, expect, test } from "bun:test";
import { buildPiArgs, extractJsonObject, isHarness, parsePiOutput } from "../src/harness.ts";

describe("buildPiArgs", () => {
  test("ignores project-local files and discovery", () => {
    const args = buildPiArgs({ systemPrompt: "sys", tools: "read" });
    for (const flag of ["--no-approve", "--no-extensions", "--no-skills", "--no-context-files"]) {
      expect(args).toContain(flag);
    }
    expect(args).not.toContain("--approve");
    expect(args[args.indexOf("--tools") + 1]).toBe("read,grep,find,ls");
  });

  test("no tools, provider and model passed through", () => {
    const args = buildPiArgs({ systemPrompt: "sys", tools: "none", provider: "openrouter", model: "m1" });
    expect(args).toContain("--no-tools");
    expect(args).not.toContain("--tools");
    expect(args[args.indexOf("--provider") + 1]).toBe("openrouter");
    expect(args[args.indexOf("--model") + 1]).toBe("m1");
  });
});

describe("extractJsonObject", () => {
  test("raw, fenced, and embedded JSON", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(extractJsonObject('Here you go:\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJsonObject('Sure! {"a":3} Done.')).toEqual({ a: 3 });
    expect(() => extractJsonObject("no json here")).toThrow(/no JSON object/);
  });
});

describe("parsePiOutput", () => {
  const event = (type: string, extra: object) => JSON.stringify({ type, ...extra });
  test("takes the final assistant message from agent_end", () => {
    const stdout = [
      event("session", {}),
      event("message_end", { message: { role: "assistant", content: [{ type: "text", text: "draft" }], model: "m1" } }),
      event("agent_end", {
        messages: [
          { role: "user", content: [{ type: "text", text: "q" }] },
          { role: "assistant", content: [{ type: "thinking", text: "hmm" }, { type: "text", text: '{"a":1}' }], model: "m2", usage: { cost: { total: 0.01 } } },
        ],
      }),
    ].join("\n");
    expect(parsePiOutput(stdout)).toEqual({ text: '{"a":1}', model: "m2", costUsd: 0.01, error: undefined });
  });
  test("surfaces provider errors", () => {
    const stdout = event("message_end", { message: { role: "assistant", content: [], errorMessage: "Connection error." } });
    expect(parsePiOutput(stdout).error).toBe("Connection error.");
    expect(parsePiOutput("").error).toMatch(/no assistant message/);
  });
});

describe("isHarness", () => {
  test("accepts only known harnesses", () => {
    expect(isHarness("codex")).toBe(true);
    expect(isHarness("gemini")).toBe(false);
  });
});

import { strictSchema } from "../src/harness.ts";
import { GUIDE_JSON_SCHEMA } from "../src/guide.ts";

describe("strictSchema", () => {
  test("requires every property and makes optional ones nullable", () => {
    const strict = strictSchema(GUIDE_JSON_SCHEMA) as any;
    const location = strict.properties.sections.items.properties.locations.items;
    expect(location.required).toEqual(["path", "hunk", "note"]);
    expect(location.properties.note.type).toEqual(["string", "null"]);
    expect(location.properties.path.type).toBe("string");
    expect(location.additionalProperties).toBe(false);
    expect(strict.required).toEqual(["title", "summary", "sections"]);
  });
});
