import { spawn } from "node:child_process";
import { HOOK_LIMITS, type HookEvent } from "@openbot/contracts/ipc-hooks";
import { sourceText } from "@openbot/i18n/source";
import { redactText } from "@openbot/logging";

interface HookCommandRequest {
  command: string;
  timeoutMs: number;
  cwd: string;
  event: HookEvent;
  signal: AbortSignal;
}
export interface HookCommandResult {
  status: "completed" | "failed" | "interrupted" | "timed-out";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}
export type HookCommandExecutor = (request: HookCommandRequest) => Promise<HookCommandResult>;

/** Redaction can expand text, so bound bytes again after redaction. */
export function safeHookOutput(stdout: string, stderr: string, redact: (text: string) => string = redactText) {
  const first = Buffer.from(redactText(redact(stdout)));
  const second = Buffer.from(redactText(redact(stderr)));
  const out = first.subarray(0, HOOK_LIMITS.outputBytes);
  const err = second.subarray(0, HOOK_LIMITS.outputBytes - out.length);
  // Drop a partial last code point rather than create a replacement character over the byte cap.
  const decode = (bytes: Buffer) => new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/\uFFFD$/, "");
  return {
    stdout: decode(out),
    stderr: decode(err),
    truncated: first.length + second.length > HOOK_LIMITS.outputBytes,
  };
}

/**
 * POSIX process groups keep normal descendants in one cancellation boundary. The command is user
 * text; event fields never enter shell arguments. Provider tokens are not inherited.
 */
export const executeHookCommand: HookCommandExecutor = (request) => new Promise((resolve) => {
  if (process.platform === "win32") {
    resolve({
      status: "failed",
      exitCode: null,
      stdout: "",
      stderr: sourceText("error.backend.hooksPosixOnly"),
      truncated: false,
    });
    return;
  }
  if (request.signal.aborted) {
    resolve({ status: "interrupted", exitCode: null, stdout: "", stderr: "", truncated: false });
    return;
  }
  // The launcher waits until its crash guardian exists. EOF before the ready line exits safely.
  const child = spawn("/bin/sh", ["-c", 'IFS= read -r ready || exit 1; exec /bin/sh -c "$1"', "openbot-hook", request.command], {
    cwd: request.cwd,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    },
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let captured = 0;
  let truncated = false;
  let stopped: "interrupted" | "timed-out" | null = null;
  let spawnFailed = false;
  let finished = false;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let pipeDeadline: ReturnType<typeof setTimeout> | undefined;
  const guardian = child.pid ? spawn("/bin/sh", ["-c",
    'cat >/dev/null; kill -TERM -"$1" 2>/dev/null; sleep 0.25; kill -KILL -"$1" 2>/dev/null',
    "openbot-hook-guardian", String(child.pid)], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      env: { PATH: "/usr/bin:/bin" },
    }) : null;
  const capture = (target: Buffer[], chunk: Buffer) => {
    const accepted = chunk.subarray(0, Math.max(0, HOOK_LIMITS.outputBytes - captured));
    if (accepted.length < chunk.length) truncated = true;
    if (accepted.length) target.push(accepted);
    captured += accepted.length;
  };
  const killGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // A closed group needs no signal.
    }
  };
  const stop = (status: "interrupted" | "timed-out") => {
    if (finished || stopped) return;
    stopped = status;
    killGroup("SIGTERM");
    escalation = setTimeout(() => killGroup("SIGKILL"), 250);
    pipeDeadline = setTimeout(() => {
      // A user command can detach a child that keeps output pipes open. Bound the receipt anyway.
      killGroup("SIGKILL");
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }, 1000);
  };
  const abort = () => stop("interrupted");
  request.signal.addEventListener("abort", abort, { once: true });
  const deadline = setTimeout(() => stop("timed-out"), request.timeoutMs);
  child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
  child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
  child.stdin.on("error", () => { /* A command may close stdin without reading the event. */ });
  child.on("error", () => {
    spawnFailed = true;
  });
  guardian?.stdin.on("error", () => { /* A guardian that has exited needs no input. */ });
  guardian?.on("error", () => {
    spawnFailed = true;
    killGroup("SIGKILL");
    child.stdin.end();
  });
  guardian?.on("spawn", () => {
    if (!finished && !stopped) child.stdin.end(`ready\n${JSON.stringify(request.event)}\n`);
    else child.stdin.end();
  });
  guardian?.on("close", () => {
    if (!finished) {
      spawnFailed = true;
      killGroup("SIGKILL");
    }
  });
  child.on("close", (code) => {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    if (escalation) clearTimeout(escalation);
    if (pipeDeadline) clearTimeout(pipeDeadline);
    request.signal.removeEventListener("abort", abort);
    // A shell can finish while a background child still runs. End that group as well.
    killGroup("SIGKILL");
    const output = safeHookOutput(Buffer.concat(stdout).toString("utf8"),
      spawnFailed ? sourceText("error.backend.hooksCommandStart") : Buffer.concat(stderr).toString("utf8"));
    const result: HookCommandResult = {
      status: stopped ?? (spawnFailed || code !== 0 ? "failed" : "completed"),
      exitCode: code,
      ...output,
      truncated: truncated || output.truncated,
    };
    if (guardian && guardian.exitCode === null && guardian.signalCode === null) {
      // Wait for the guardian's cleanup too. Its input pipe also closes automatically on app crash.
      const guardianDeadline = setTimeout(() => {
        if (guardian.pid) {
          try {
            process.kill(-guardian.pid, "SIGKILL");
          } catch {
            // Already closed.
          }
        }
      }, 1000);
      guardian.once("close", () => {
        clearTimeout(guardianDeadline);
        resolve(result);
      });
      guardian.stdin.end();
    } else resolve(result);
  });
  if (!guardian) child.stdin.end();
  // The signal can become aborted between the initial check and listener registration.
  if (request.signal.aborted) abort();
});
