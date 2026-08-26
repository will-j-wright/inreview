import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import {
  JjCancelledError,
  JjCommandError,
  JjExecutableNotFoundError,
  JjExecutableSpawnError,
  JjOutputLimitError,
  JjTimeoutError,
} from "./errors";

export interface ProcessRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly stdoutLimitBytes: number | null;
  readonly stderrLimitBytes: number;
  readonly stdoutMode?: "capture" | "probe";
  readonly stdoutProbeBytes?: number;
}

export interface ProcessResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly exitCode: number;
  readonly stdoutByteLength?: number;
  readonly stdoutContainsNul?: boolean;
}

export interface JjCommandExecutor {
  execute(request: ProcessRequest): Promise<ProcessResult>;
}

type Release = () => void;

class Semaphore {
  private active = 0;
  private readonly waiters: {
    readonly resolve: (release: Release) => void;
    readonly reject: (error: JjCancelledError) => void;
    readonly signal?: AbortSignal;
    readonly onAbort?: () => void;
  }[] = [];

  public constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError("Concurrency must be a positive integer.");
    }
  }

  public async acquire(signal?: AbortSignal): Promise<Release> {
    if (signal?.aborted === true) {
      throw new JjCancelledError();
    }
    if (this.active < this.limit) {
      this.active += 1;
      return this.createRelease();
    }

    return await new Promise<Release>((resolve, reject) => {
      const waiter: {
        resolve: (release: Release) => void;
        reject: (error: JjCancelledError) => void;
        signal?: AbortSignal;
        onAbort?: () => void;
      } = { resolve, reject };
      if (signal !== undefined) {
        const onAbort = (): void => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) {
            this.waiters.splice(index, 1);
          }
          reject(new JjCancelledError());
        };
        waiter.signal = signal;
        waiter.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private createRelease(): Release {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const waiter = this.waiters.shift();
      if (waiter === undefined) {
        this.active -= 1;
        return;
      }
      if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve(this.createRelease());
    };
  }
}

export interface NodeProcessExecutorOptions {
  readonly maxConcurrency?: number;
}

export class NodeProcessExecutor implements JjCommandExecutor {
  private readonly semaphore: Semaphore;

  public constructor(options: NodeProcessExecutorOptions = {}) {
    this.semaphore = new Semaphore(options.maxConcurrency ?? 4);
  }

  public async execute(request: ProcessRequest): Promise<ProcessResult> {
    const release = await this.semaphore.acquire(request.signal);
    try {
      return await this.spawnAndCapture(request);
    } finally {
      release();
    }
  }

  private async spawnAndCapture(request: ProcessRequest): Promise<ProcessResult> {
    if (request.signal?.aborted === true) {
      throw new JjCancelledError();
    }

    return await new Promise<ProcessResult>((resolve, reject) => {
      let child: ChildProcessByStdio<null, Readable, Readable>;
      try {
        child = spawn(request.executable, [...request.args], {
          ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
          env: { ...process.env, NO_COLOR: "1" },
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (error) {
        reject(mapSpawnError(request.executable, error));
        return;
      }

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let capturedBytes = 0;
      let stdoutContainsNul = false;
      let terminalError: Error | undefined;

      const stop = (error: Error): void => {
        if (terminalError !== undefined) {
          return;
        }
        terminalError = error;
        child.kill();
      };
      const timeout = setTimeout(() => {
        stop(new JjTimeoutError(request.timeoutMs));
      }, request.timeoutMs);
      const onAbort = (): void => {
        stop(new JjCancelledError());
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (
          request.stdoutLimitBytes !== null &&
          stdoutBytes > request.stdoutLimitBytes
        ) {
          stop(new JjOutputLimitError("stdout", request.stdoutLimitBytes));
          return;
        }
        if (chunk.includes(0)) {
          stdoutContainsNul = true;
        }
        if (request.stdoutMode === "probe") {
          const remaining = (request.stdoutProbeBytes ?? 8192) - capturedBytes;
          if (remaining > 0) {
            const captured = chunk.subarray(0, remaining);
            stdout.push(captured);
            capturedBytes += captured.length;
          }
        } else {
          stdout.push(chunk);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > request.stderrLimitBytes) {
          stop(new JjOutputLimitError("stderr", request.stderrLimitBytes));
          return;
        }
        stderr.push(chunk);
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        terminalError ??= mapSpawnError(request.executable, error);
      });
      child.on("close", (exitCode) => {
        clearTimeout(timeout);
        request.signal?.removeEventListener("abort", onAbort);
        if (terminalError !== undefined) {
          reject(terminalError);
          return;
        }
        const stdoutBuffer = Buffer.concat(stdout);
        const stderrBuffer = Buffer.concat(stderr);
        if (exitCode !== 0) {
          reject(
            new JjCommandError(
              request.executable,
              request.args,
              exitCode,
              stderrBuffer.toString("utf8"),
            ),
          );
          return;
        }
        resolve({
          stdout: stdoutBuffer,
          stderr: stderrBuffer,
          exitCode: 0,
          stdoutByteLength: stdoutBytes,
          stdoutContainsNul,
        });
      });
    });
  }
}

function mapSpawnError(executable: string, error: unknown): Error {
  const rawSystemCode =
    typeof error === "object" && error !== null && "code" in error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
  const systemCode =
    typeof rawSystemCode === "string" ? rawSystemCode : undefined;
  if (
    systemCode === "ENOENT"
  ) {
    return new JjExecutableNotFoundError(executable, { cause: error });
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new JjExecutableSpawnError(executable, systemCode, detail, {
    cause: error,
  });
}
