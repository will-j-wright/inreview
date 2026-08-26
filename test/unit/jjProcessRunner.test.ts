import { describe, expect, it } from "vitest";

import {
  JjCancelledError,
  JjExecutableNotFoundError,
  JjTimeoutError,
  NodeProcessExecutor,
  type ProcessRequest,
} from "../../src/jj";

function nodeRequest(
  script: string,
  args: readonly string[] = [],
  overrides: Partial<ProcessRequest> = {},
): ProcessRequest {
  return {
    executable: process.execPath,
    args: ["-e", script, ...args],
    timeoutMs: 2_000,
    stdoutLimitBytes: 1024,
    stderrLimitBytes: 1024,
    ...overrides,
  };
}

describe("NodeProcessExecutor", () => {
  it("passes hostile-looking arguments literally without a shell", async () => {
    const hostile = "--flag=$(echo hacked); & whoami";
    const result = await new NodeProcessExecutor().execute({
      ...nodeRequest("process.stdout.write(process.argv[1])"),
      args: [
        "-e",
        "process.stdout.write(process.argv[1])",
        "--",
        hostile,
      ],
    });

    expect(result.stdout.toString()).toBe(hostile);
  });

  it("keeps stdout and stderr separate and reports command failures", async () => {
    const result = await new NodeProcessExecutor().execute(
      nodeRequest(
        "process.stdout.write('out'); process.stderr.write('err')",
      ),
    );
    expect(result.stdout.toString()).toBe("out");
    expect(result.stderr.toString()).toBe("err");

    await expect(
      new NodeProcessExecutor().execute(
        nodeRequest("process.stderr.write('failure'); process.exit(7)"),
      ),
    ).rejects.toMatchObject({
      code: "command-failed",
      exitCode: 7,
      stderr: "failure",
    });
  });

  it("reports a missing executable", async () => {
    await expect(
      new NodeProcessExecutor().execute({
        ...nodeRequest(""),
        executable: `missing-jj-${crypto.randomUUID()}`,
      }),
    ).rejects.toBeInstanceOf(JjExecutableNotFoundError);
  });

  it("enforces independent output limits", async () => {
    await expect(
      new NodeProcessExecutor().execute(
        nodeRequest("process.stdout.write('x'.repeat(20))", [], {
          stdoutLimitBytes: 10,
        }),
      ),
    ).rejects.toMatchObject({
      code: "output-limit",
      stream: "stdout",
      limitBytes: 10,
    });

    await expect(
      new NodeProcessExecutor().execute(
        nodeRequest("process.stderr.write('x'.repeat(20))", [], {
          stderrLimitBytes: 10,
        }),
      ),
    ).rejects.toMatchObject({
      stream: "stderr",
    });
  });

  it("counts and scans probe output without retaining the complete stream", async () => {
    const result = await new NodeProcessExecutor().execute(
      nodeRequest(
        "process.stdout.write(Buffer.concat([Buffer.alloc(9000, 65), Buffer.from([0]), Buffer.alloc(9000, 66)]))",
        [],
        {
          stdoutLimitBytes: null,
          stdoutMode: "probe",
          stdoutProbeBytes: 128,
        },
      ),
    );

    expect(result.stdout).toHaveLength(128);
    expect(result.stdoutByteLength).toBe(18_001);
    expect(result.stdoutContainsNul).toBe(true);
  });

  it("times out and supports cancellation", async () => {
    await expect(
      new NodeProcessExecutor().execute(
        nodeRequest("setTimeout(() => {}, 10_000)", [], {
          timeoutMs: 20,
        }),
      ),
    ).rejects.toBeInstanceOf(JjTimeoutError);

    const controller = new AbortController();
    const running = new NodeProcessExecutor().execute(
      nodeRequest("setTimeout(() => {}, 10_000)", [], {
        signal: controller.signal,
      }),
    );
    setTimeout(() => {
      controller.abort();
    }, 20);
    await expect(running).rejects.toBeInstanceOf(JjCancelledError);
  });

  it("bounds concurrency and cancels a queued command", async () => {
    const executor = new NodeProcessExecutor({ maxConcurrency: 1 });
    const first = executor.execute(
      nodeRequest("setTimeout(() => process.stdout.write('done'), 100)"),
    );
    const controller = new AbortController();
    const queued = executor.execute(
      nodeRequest("process.stdout.write('should not run')", [], {
        signal: controller.signal,
      }),
    );
    controller.abort();

    await expect(queued).rejects.toBeInstanceOf(JjCancelledError);
    await expect(first).resolves.toMatchObject({ exitCode: 0 });
  });
});
