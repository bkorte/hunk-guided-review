import type { HarnessRunOptions, HarnessRunResult } from "./harness.ts";
import { runProcess, tailOf } from "./spawn.ts";

export const READ_ONLY_TOOLS = "Read,Grep,Glob";

/** Assemble the `claude -p` argument list for one structured, non-interactive run. */
export function buildClaudeArgs(options: Pick<HarnessRunOptions, "schema" | "systemPrompt" | "model" | "maxTurns" | "tools">): string[] {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(options.schema),
    "--no-session-persistence",
    // Print mode skips workspace trust, so never load the reviewed repo's hooks, settings, or MCP servers.
    "--setting-sources",
    "user",
    "--strict-mcp-config",
    "--permission-mode",
    "dontAsk",
    "--max-turns",
    String(Math.max(2, Math.floor(options.maxTurns))),
    "--append-system-prompt",
    options.systemPrompt,
  ];
  if (options.model) args.push("--model", options.model);
  if (options.tools === "read") {
    args.push("--allowedTools", READ_ONLY_TOOLS);
  } else {
    args.push("--tools", "");
  }
  return args;
}

/** The envelope fields we read from `--output-format json`. */
interface ClaudeEnvelope {
  is_error?: boolean;
  result?: unknown;
  structured_output?: unknown;
  total_cost_usd?: number;
  modelUsage?: Record<string, unknown>;
  subtype?: string;
}

/** Pull the structured guide out of a print-mode envelope, or explain why there is none. */
export function parseClaudeEnvelope(stdout: string): { envelope: ClaudeEnvelope; output: unknown } {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("claude produced no output");
  let envelope: ClaudeEnvelope;
  try {
    envelope = JSON.parse(trimmed) as ClaudeEnvelope;
  } catch {
    // stream-json or a stray warning line: take the last JSON object on its own line.
    const lastLine = trimmed.split("\n").reverse().find((line) => line.trim().startsWith("{"));
    if (!lastLine) throw new Error(`claude output was not JSON: ${trimmed.slice(0, 200)}`);
    envelope = JSON.parse(lastLine) as ClaudeEnvelope;
  }
  if (envelope.is_error) {
    const message = typeof envelope.result === "string" ? envelope.result : JSON.stringify(envelope.result);
    throw new Error(`claude reported an error: ${message}`);
  }
  if (envelope.structured_output !== undefined && envelope.structured_output !== null) {
    return { envelope, output: envelope.structured_output };
  }
  if (typeof envelope.result === "string") {
    const text = envelope.result.trim();
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
    const candidate = fenced ? fenced[1]! : text;
    try {
      return { envelope, output: JSON.parse(candidate) };
    } catch {
      throw new Error(
        `claude returned no structured output (${envelope.subtype ?? "unknown"}): ${text.slice(0, 200)}`,
      );
    }
  }
  throw new Error(`claude returned no structured output (${envelope.subtype ?? "unknown"})`);
}

function primaryModel(envelope: ClaudeEnvelope): string | undefined {
  const usage = envelope.modelUsage;
  if (!usage) return undefined;
  const names = Object.keys(usage);
  return names.length > 0 ? names[0] : undefined;
}

/** Run `claude -p` with a JSON schema and return the structured result. */
export async function runClaudeStructured(options: HarnessRunOptions): Promise<HarnessRunResult> {
  const startedAt = Date.now();
  const result = await runProcess("claude", buildClaudeArgs(options), {
    cwd: options.cwd,
    stdin: options.prompt,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
  });
  let parsed: ReturnType<typeof parseClaudeEnvelope>;
  try {
    parsed = parseClaudeEnvelope(result.stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const detail = result.stderr.trim() ? ` (${tailOf(result.stderr)})` : "";
    throw new Error(result.code ? `claude exited with ${result.code}: ${message}${detail}` : `${message}${detail}`);
  }
  const { envelope, output } = parsed;
  return {
    output,
    model: primaryModel(envelope),
    costUsd: typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd : undefined,
    durationMs: Date.now() - startedAt,
  };
}
