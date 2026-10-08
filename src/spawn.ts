import { spawn } from "node:child_process";

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ProcessOptions {
  cwd: string;
  stdin: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

/**
 * Run one agent CLI to completion with the prompt on stdin, collecting its
 * output. A timeout or an abort kills the child (SIGTERM, then SIGKILL) and
 * rejects; a non-zero exit resolves so the caller can read what it printed.
 */
export function runProcess(binary: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, result?: ProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(result!);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    const kill = () => {
      try {
        child.kill("SIGTERM");
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // already gone
          }
        }, 2_000).unref?.();
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      kill();
      finish(new Error(`${binary} timed out after ${Math.round(options.timeoutMs / 1000)}s`));
    }, options.timeoutMs);
    const onAbort = () => {
      kill();
      finish(new Error("guide generation cancelled"));
    };
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "ENOENT" ? new Error(`could not find \`${binary}\` on PATH`) : error);
    });
    child.on("close", (code) =>
      finish(null, {
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
    // EPIPE when the child exits early; the close handler reports the real cause.
    child.stdin?.on("error", () => {});
    child.stdin?.end(options.stdin);
  });
}

/** The last few lines of a process's output, flattened into one line for an error message. */
export function tailOf(text: string, lines = 3): string {
  return text.trim().split("\n").slice(-lines).join(" ").slice(0, 300);
}
