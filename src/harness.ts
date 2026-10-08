import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClaudeStructured } from "./claude.ts";
import { runProcess, tailOf } from "./spawn.ts";

/** Which coding agent CLI produces the guide. */
export type Harness = "claude" | "codex" | "pi";
export const HARNESSES: readonly Harness[] = ["claude", "codex", "pi"];

export function isHarness(value: unknown): value is Harness {
  return typeof value === "string" && (HARNESSES as readonly string[]).includes(value);
}

/** "read": the agent may read repository files for context; "none": it answers from the diff alone. */
export type ToolAccess = "none" | "read";

export interface HarnessRunOptions {
  harness: Harness;
  cwd: string;
  prompt: string;
  systemPrompt: string;
  schema: unknown;
  model?: string;
  /** pi only: `--provider`; codex and claude pick the provider from the model. */
  provider?: string;
  maxTurns: number;
  tools: ToolAccess;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface HarnessRunResult {
  output: unknown;
  model?: string;
  costUsd?: number;
  durationMs: number;
}

/** Pull a JSON object out of free text: raw, fenced, or with prose around it. */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // keep looking
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]!.trim());
    } catch {
      // keep looking
    }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // fall through
    }
  }
  throw new Error(`no JSON object in the response: ${trimmed.slice(0, 200)}`);
}

/**
 * OpenAI structured outputs demand `additionalProperties: false` and every
 * property in `required` on each object. Optional properties become nullable,
 * which `normalizeGuide` already treats as absent.
 */
export function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== "object") return schema;
  const source = schema as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === "properties" && value && typeof value === "object") {
      result[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([name, property]) => [name, strictSchema(property)]),
      );
    } else if (key === "items" || key === "anyOf") {
      result[key] = strictSchema(value);
    } else {
      result[key] = value;
    }
  }
  if (source.type === "object" && source.properties && typeof source.properties === "object") {
    const keys = Object.keys(source.properties as Record<string, unknown>);
    const required = new Set(Array.isArray(source.required) ? (source.required as string[]) : []);
    const properties = result.properties as Record<string, Record<string, unknown>>;
    for (const key of keys) {
      if (required.has(key)) continue;
      const property = properties[key]!;
      const type = property.type;
      if (typeof type === "string") properties[key] = { ...property, type: [type, "null"] };
      else if (Array.isArray(type) && !type.includes("null")) properties[key] = { ...property, type: [...type, "null"] };
    }
    result.required = keys;
    result.additionalProperties = false;
  }
  return result;
}

/** Fold the system prompt into the user prompt for CLIs without a system-prompt flag. */
function promptWithInstructions(options: HarnessRunOptions, extra: string): string {
  return `<instructions>\n${options.systemPrompt}\n\n${extra}\n</instructions>\n\n${options.prompt}`;
}

/**
 * `codex exec`: read-only sandbox, ephemeral session, final answer constrained
 * by `--output-schema` and written to a file with `-o`.
 */
export async function runCodexStructured(options: HarnessRunOptions): Promise<HarnessRunResult> {
  const startedAt = Date.now();
  const dir = await mkdtemp(join(tmpdir(), "hunk-guide-codex-"));
  const schemaPath = join(dir, "schema.json");
  const outputPath = join(dir, "last-message.json");
  try {
    await writeFile(schemaPath, JSON.stringify(strictSchema(options.schema)));
    const args = [
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--color", "never",
      "--sandbox", "read-only",
      "-C", options.cwd,
      "--output-schema", schemaPath,
      "-o", outputPath,
    ];
    if (options.model) args.push("-m", options.model);
    args.push("-");
    const toolNote =
      options.tools === "none"
        ? "Answer from the diff alone: do not run any commands or read any files."
        : "You may read repository files with read-only commands to understand context; never modify anything.";
    const result = await runProcess("codex", args, {
      cwd: options.cwd,
      stdin: promptWithInstructions(options, toolNote),
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    let text = "";
    try {
      text = await readFile(outputPath, "utf8");
    } catch {
      // fall back to stdout below
    }
    if (result.code !== 0 && !text.trim()) {
      throw new Error(`codex exited with ${result.code}: ${tailOf(result.stderr || result.stdout)}`);
    }
    const output = extractJsonObject(text.trim() || result.stdout);
    return { output, model: options.model, durationMs: Date.now() - startedAt };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** One message as pi reports it in `--mode json`. */
interface PiMessage {
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
  usage?: { cost?: { total?: number } };
  model?: string;
  errorMessage?: string;
}

/** The events pi prints in `--mode json`; only the final assistant text matters here. */
interface PiEvent {
  type?: string;
  messages?: PiMessage[];
  message?: PiMessage;
}

/** Find the last assistant message in pi's JSONL stream. */
export function parsePiOutput(stdout: string): { text: string; model?: string; costUsd?: number; error?: string } {
  let last: PiMessage | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let event: PiEvent;
    try {
      event = JSON.parse(line) as PiEvent;
    } catch {
      continue;
    }
    if (event.type === "agent_end" && event.messages) {
      const assistant = [...event.messages].reverse().find((message) => message.role === "assistant");
      if (assistant) last = assistant;
    } else if (event.type === "message_end" && event.message?.role === "assistant") {
      last = event.message;
    }
  }
  if (!last) return { text: "", error: "pi produced no assistant message" };
  const text = (last.content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
  return { text, model: last.model, costUsd: last.usage?.cost?.total, error: last.errorMessage };
}

/** Assemble the `pi -p` argument list; nothing the reviewed repo supplies under `.pi/` is loaded. */
export function buildPiArgs(options: Pick<HarnessRunOptions, "systemPrompt" | "model" | "provider" | "tools">): string[] {
  const args = [
    "-p",
    "--mode", "json",
    "--no-session",
    "--no-approve",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--append-system-prompt", options.systemPrompt,
  ];
  if (options.tools === "none") args.push("--no-tools");
  else args.push("--tools", "read,grep,find,ls");
  if (options.provider) args.push("--provider", options.provider);
  if (options.model) args.push("--model", options.model);
  return args;
}

/** `pi -p --mode json`: no schema support, so the prompt asks for JSON and the reply is parsed. */
export async function runPiStructured(options: HarnessRunOptions): Promise<HarnessRunResult> {
  const startedAt = Date.now();
  const args = buildPiArgs(options);
  const schemaNote = `Respond with a single JSON object and nothing else, matching this JSON Schema exactly:\n${JSON.stringify(options.schema)}`;
  const result = await runProcess("pi", args, {
    cwd: options.cwd,
    stdin: `${options.prompt}\n\n${schemaNote}`,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
  const parsed = parsePiOutput(result.stdout);
  if (parsed.error && !parsed.text.trim()) {
    throw new Error(`pi failed: ${parsed.error}${result.stderr.trim() ? ` (${tailOf(result.stderr)})` : ""}`);
  }
  if (result.code !== 0 && !parsed.text.trim()) {
    throw new Error(`pi exited with ${result.code}: ${tailOf(result.stderr || result.stdout)}`);
  }
  return {
    output: extractJsonObject(parsed.text),
    model: parsed.model ?? options.model,
    costUsd: parsed.costUsd,
    durationMs: Date.now() - startedAt,
  };
}

/** Run the configured harness and return its structured answer. */
export function runHarnessStructured(options: HarnessRunOptions): Promise<HarnessRunResult> {
  switch (options.harness) {
    case "codex":
      return runCodexStructured(options);
    case "pi":
      return runPiStructured(options);
    default:
      return runClaudeStructured(options);
  }
}
