import path from "node:path";
import { realpath } from "node:fs/promises";

import {
  JjCommandError,
  JjInvalidOutputError,
  JjInvalidRepositoryError,
  JjSelectionError,
  JjUnsupportedVersionError,
} from "./errors";
import {
  COMMIT_JSON_TEMPLATE,
  DIFF_FILE_JSON_TEMPLATE,
  FILE_JSON_TEMPLATE,
  OPERATION_JSON_TEMPLATE,
} from "./jjTemplates";
import {
  NodeProcessExecutor,
  type JjCommandExecutor,
  type ProcessRequest,
} from "./processRunner";
import {
  buildLastSelection,
  buildRefreshSelection,
} from "./reviewSelection";
import type {
  JjCapabilities,
  JjChangedFile,
  JjCommit,
  JjFile,
  JjFileProbe,
  JjOperation,
  JjVersion,
  ReviewSelection,
} from "./types";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_STDOUT_LIMIT = 64 * 1024 * 1024;
const DEFAULT_STDERR_LIMIT = 1024 * 1024;
const DEFAULT_CAPTURE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_PROBE_BYTES = 8192;
const VERSION_RANGE = "jj 0.44.x";
const CHANGE_ID_PATTERN = /^[k-z]{32}$/;
const COMMIT_ID_PATTERN = /^[0-9a-f]{40,128}$/;
const OPERATION_ID_PATTERN = /^[0-9a-f]{64,256}$/;

export interface JjClientOptions {
  readonly executable?: string;
  readonly executor?: JjCommandExecutor;
  readonly maxConcurrency?: number;
  readonly timeoutMs?: number;
  readonly stdoutLimitBytes?: number;
  readonly stderrLimitBytes?: number;
  readonly captureTimeoutMs?: number;
  readonly captureStdoutLimitBytes?: number | null;
}

interface RunOptions {
  readonly signal?: AbortSignal;
  readonly stdoutLimitBytes?: number | null;
  readonly timeoutMs?: number;
  readonly stdoutMode?: "capture" | "probe";
  readonly stdoutProbeBytes?: number;
  readonly repository?: boolean;
  readonly operationId?: string;
  readonly cwd?: string;
}

export class JjClient {
  public readonly executable: string;
  public readonly repository: string;
  private readonly executor: JjCommandExecutor;
  private readonly timeoutMs: number;
  private readonly stdoutLimitBytes: number;
  private readonly stderrLimitBytes: number;
  private readonly captureTimeoutMs: number;
  private readonly captureStdoutLimitBytes: number | null;
  private capabilities: JjCapabilities | undefined;

  public constructor(repository: string, options: JjClientOptions = {}) {
    if (repository.length === 0) {
      throw new TypeError("A repository path is required.");
    }
    this.repository = path.resolve(repository);
    this.executable = options.executable ?? "jj";
    this.executor =
      options.executor ??
      new NodeProcessExecutor(
        options.maxConcurrency === undefined
          ? {}
          : { maxConcurrency: options.maxConcurrency },
      );
    this.timeoutMs = positiveLimit(
      options.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      "timeoutMs",
    );
    this.stdoutLimitBytes = positiveLimit(
      options.stdoutLimitBytes,
      DEFAULT_STDOUT_LIMIT,
      "stdoutLimitBytes",
    );
    this.stderrLimitBytes = positiveLimit(
      options.stderrLimitBytes,
      DEFAULT_STDERR_LIMIT,
      "stderrLimitBytes",
    );
    this.captureTimeoutMs = positiveLimit(
      options.captureTimeoutMs,
      DEFAULT_CAPTURE_TIMEOUT_MS,
      "captureTimeoutMs",
    );
    this.captureStdoutLimitBytes = nullablePositiveLimit(
      options.captureStdoutLimitBytes,
      null,
      "captureStdoutLimitBytes",
    );
  }

  public async checkCapabilities(
    signal?: AbortSignal,
  ): Promise<JjCapabilities> {
    if (this.capabilities !== undefined) {
      return this.capabilities;
    }
    const result = await this.execute(["--version"], {
      ...(signal === undefined ? {} : { signal }),
      repository: false,
      stdoutLimitBytes: 4096,
    });
    const version = parseVersion(result.toString("utf8"));
    if (version.major !== 0 || version.minor !== 44) {
      throw new JjUnsupportedVersionError(version.display, VERSION_RANGE);
    }
    this.capabilities = {
      executable: this.executable,
      version,
      coherentOperationReads: true,
      jsonTemplates: true,
      gitFormatDiffs: true,
      binaryFileReads: true,
    };
    return this.capabilities;
  }

  public async openReadSession(
    signal?: AbortSignal,
  ): Promise<JjReadSession> {
    const capabilities = await this.checkCapabilities(signal);
    let output: Buffer;
    try {
      output = await this.execute(
        ["op", "log", "--no-graph", "--limit", "1", "-T", OPERATION_JSON_TEMPLATE],
        signal === undefined ? {} : { signal },
      );
    } catch (error) {
      if (error instanceof JjCommandError) {
        throw new JjInvalidRepositoryError(this.repository, { cause: error });
      }
      throw error;
    }
    const operations = parseJsonLines(output, isOperation, "operation");
    const operation = operations[0];
    if (operations.length !== 1 || operation === undefined) {
      throw new JjInvalidOutputError(
        "jj did not return exactly one current operation.",
      );
    }
    assertOperationId(operation.id);
    return new JjReadSession(this, capabilities, operation);
  }

  public async resolveRepositoryRoot(signal?: AbortSignal): Promise<string> {
    await this.checkCapabilities(signal);
    let output: Buffer;
    try {
      output = await this.execute(
        ["--color", "never", "--no-pager", "--quiet", "root"],
        {
          repository: false,
          cwd: this.repository,
          ...(signal === undefined ? {} : { signal }),
        },
      );
    } catch (error) {
      if (error instanceof JjCommandError) {
        throw new JjInvalidRepositoryError(this.repository, { cause: error });
      }
      throw error;
    }
    const root = output.toString("utf8").trim();
    if (root.length === 0 || !path.isAbsolute(root) || root.includes("\0")) {
      throw new JjInvalidOutputError("jj returned an invalid repository root.");
    }
    try {
      return await realpath(root);
    } catch (error) {
      throw new JjInvalidRepositoryError(root, { cause: error });
    }
  }

  public buildCommandArgs(
    commandArgs: readonly string[],
    operationId?: string,
  ): readonly string[] {
    const args = [
      "--repository",
      this.repository,
      "--color",
      "never",
      "--no-pager",
      "--quiet",
    ];
    if (operationId !== undefined) {
      assertOperationId(operationId);
      args.push("--at-operation", operationId);
    }
    args.push(...commandArgs);
    return args;
  }

  public async runRead(
    operationId: string,
    commandArgs: readonly string[],
    signal?: AbortSignal,
    stdoutLimitBytes?: number | null,
  ): Promise<Buffer> {
    const outputLimit =
      stdoutLimitBytes === undefined
        ? undefined
        : nullablePositiveLimit(
            stdoutLimitBytes,
            stdoutLimitBytes,
            "stdoutLimitBytes",
          );
    return await this.execute(commandArgs, {
      operationId,
      ...(signal === undefined ? {} : { signal }),
      ...(outputLimit === undefined ? {} : { stdoutLimitBytes: outputLimit }),
    });
  }

  private async execute(
    commandArgs: readonly string[],
    options: RunOptions = {},
  ): Promise<Buffer> {
    const args =
      options.repository === false
        ? commandArgs
        : this.buildCommandArgs(commandArgs, options.operationId);
    const request: ProcessRequest = {
      executable: this.executable,
      args,
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      stdoutLimitBytes:
        options.stdoutLimitBytes === undefined
          ? this.stdoutLimitBytes
          : options.stdoutLimitBytes,
      stderrLimitBytes: this.stderrLimitBytes,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.stdoutMode === undefined
        ? {}
        : { stdoutMode: options.stdoutMode }),
      ...(options.stdoutProbeBytes === undefined
        ? {}
        : { stdoutProbeBytes: options.stdoutProbeBytes }),
    };
    const result = await this.executor.execute(request);
    return result.stdout;
  }

  public async runCapture(
    operationId: string,
    commandArgs: readonly string[],
    signal?: AbortSignal,
    stdoutLimitBytes: number | null = this.captureStdoutLimitBytes,
  ): Promise<Buffer> {
    return await this.execute(commandArgs, {
      operationId,
      timeoutMs: this.captureTimeoutMs,
      stdoutLimitBytes,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  public async runProbe(
    operationId: string,
    commandArgs: readonly string[],
    signal?: AbortSignal,
  ): Promise<JjFileProbe> {
    const args = this.buildCommandArgs(commandArgs, operationId);
    const result = await this.executor.execute({
      executable: this.executable,
      args,
      timeoutMs: this.captureTimeoutMs,
      stdoutLimitBytes: this.captureStdoutLimitBytes,
      stderrLimitBytes: this.stderrLimitBytes,
      stdoutMode: "probe",
      stdoutProbeBytes: DEFAULT_PROBE_BYTES,
      ...(signal === undefined ? {} : { signal }),
    });
    return {
      prefix: Buffer.from(result.stdout),
      byteLength: result.stdoutByteLength ?? result.stdout.byteLength,
      containsNul: result.stdoutContainsNul ?? result.stdout.includes(0),
    };
  }
}

export class JjReadSession {
  public readonly operationId: string;
  public readonly repository: string;

  public constructor(
    private readonly client: JjClient,
    public readonly capabilities: JjCapabilities,
    public readonly operation: JjOperation,
  ) {
    this.operationId = operation.id;
    this.repository = client.repository;
  }

  public async selectLast(
    count: number,
    signal?: AbortSignal,
  ): Promise<ReviewSelection> {
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new JjSelectionError(
        "The requested change count must be a positive integer.",
      );
    }
    const records = await this.readCommitRevset(
      `ancestors(@, ${String(count)})`,
      signal,
    );
    return buildLastSelection(this.operationId, count, records);
  }

  public async resolveSelection(
    storedChangeIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<ReviewSelection> {
    if (storedChangeIds.length === 0) {
      throw new JjSelectionError("A refresh requires at least one change ID.");
    }
    for (const changeId of storedChangeIds) {
      if (!CHANGE_ID_PATTERN.test(changeId)) {
        throw new JjSelectionError(
          `Stored change ID "${changeId}" is not a full jj change ID.`,
        );
      }
    }
    const revset = storedChangeIds
      .map((changeId) => `change_id("${changeId}")`)
      .join(" | ");
    const records = await this.readCommitRevset(revset, signal);
    return buildRefreshSelection(
      this.operationId,
      storedChangeIds,
      records,
    );
  }

  public async getCommit(
    commitId: string,
    signal?: AbortSignal,
  ): Promise<JjCommit> {
    assertCommitId(commitId);
    const records = await this.readCommitRevset(
      `exactly(${commitId}, 1)`,
      signal,
    );
    const record = records[0];
    if (records.length !== 1 || record === undefined) {
      throw new JjInvalidOutputError(
        `jj did not return commit ${commitId}.`,
      );
    }
    return record;
  }

  public async diffGit(
    fromCommitId: string,
    toCommitId: string,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    assertCommitId(fromCommitId);
    assertCommitId(toCommitId);
    return await this.client.runCapture(
      this.operationId,
      ["diff", "--git", "--from", fromCommitId, "--to", toCommitId],
      signal,
    );
  }

  public async listChangedFiles(
    fromCommitId: string,
    toCommitId: string,
    signal?: AbortSignal,
  ): Promise<readonly JjChangedFile[]> {
    assertCommitId(fromCommitId);
    assertCommitId(toCommitId);
    const output = await this.client.runRead(
      this.operationId,
      [
        "diff",
        "--from",
        fromCommitId,
        "--to",
        toCommitId,
        "-T",
        DIFF_FILE_JSON_TEMPLATE,
      ],
      signal,
    );
    return parseJsonLines(output, isChangedFileRecord, "changed file").map(
      changedFileFromRecord,
    );
  }

  public async listFiles(
    commitId: string,
    repositoryRelativePaths?: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly JjFile[]> {
    assertCommitId(commitId);
    if (repositoryRelativePaths?.length === 0) {
      return [];
    }
    const filesets = repositoryRelativePaths?.map(exactRootFileset) ?? [];
    const output = await this.client.runRead(
      this.operationId,
      [
        "file",
        "list",
        "--revision",
        commitId,
        "-T",
        FILE_JSON_TEMPLATE,
        ...(filesets.length === 0 ? [] : ["--", ...filesets]),
      ],
      signal,
    );
    return parseJsonLines(output, isFile, "file");
  }

  public async readFile(
    commitId: string,
    repositoryRelativePath: string,
    signal?: AbortSignal,
    limitBytes?: number,
  ): Promise<Buffer> {
    assertCommitId(commitId);
    const fileset = exactRootFileset(repositoryRelativePath);
    const outputLimit =
      limitBytes === undefined
        ? undefined
        : positiveLimit(limitBytes, limitBytes, "limitBytes");
    return await this.client.runCapture(
      this.operationId,
      ["file", "show", "--revision", commitId, "--", fileset],
      signal,
      outputLimit,
    );
  }

  public async probeFile(
    commitId: string,
    repositoryRelativePath: string,
    signal?: AbortSignal,
  ): Promise<JjFileProbe> {
    assertCommitId(commitId);
    const fileset = exactRootFileset(repositoryRelativePath);
    return await this.client.runProbe(
      this.operationId,
      ["file", "show", "--revision", commitId, "--", fileset],
      signal,
    );
  }

  private async readCommitRevset(
    revset: string,
    signal?: AbortSignal,
  ): Promise<readonly JjCommit[]> {
    const output = await this.client.runRead(
      this.operationId,
      [
        "log",
        "--no-graph",
        "--reversed",
        "--revisions",
        revset,
        "-T",
        COMMIT_JSON_TEMPLATE,
      ],
      signal,
    );
    return parseJsonLines(output, isCommit, "commit");
  }
}

export function parseVersion(output: string): JjVersion {
  const match = /^jj\s+(\d+)\.(\d+)\.(\d+)(?:[-+][^\s]+)?\s*$/u.exec(
    output.trim(),
  );
  if (match === null) {
    throw new JjInvalidOutputError(
      `The executable returned an unrecognized version: ${output.trim()}`,
    );
  }
  const [, majorText, minorText, patchText] = match;
  const major = Number(majorText);
  const minor = Number(minorText);
  const patch = Number(patchText);
  return {
    major,
    minor,
    patch,
    display: `${String(major)}.${String(minor)}.${String(patch)}`,
  };
}

export function exactRootFileset(repositoryRelativePath: string): string {
  if (
    repositoryRelativePath.length === 0 ||
    repositoryRelativePath.includes("\0") ||
    path.win32.isAbsolute(repositoryRelativePath) ||
    path.posix.isAbsolute(repositoryRelativePath)
  ) {
    throw new TypeError("The file path must be repository-relative.");
  }
  const normalized = repositoryRelativePath.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new TypeError(
      "The file path must not contain empty, dot, or parent segments.",
    );
  }
  let escaped = "";
  for (const character of normalized) {
    escaped += escapeFilesetCharacter(character);
  }
  return `root-file:"${escaped}"`;
}

function escapeFilesetCharacter(character: string): string {
  switch (character) {
    case '"':
      return '\\"';
    case "\\":
      return "\\\\";
    case "\t":
      return "\\t";
    case "\n":
      return "\\n";
    default: {
      const code = character.charCodeAt(0);
      return code < 32
        ? `\\x${code.toString(16).padStart(2, "0")}`
        : character;
    }
  }
}

function positiveLimit(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
  return selected;
}

function nullablePositiveLimit(
  value: number | null | undefined,
  fallback: number | null,
  name: string,
): number | null {
  const selected = value === undefined ? fallback : value;
  if (selected === null) {
    return null;
  }
  return positiveLimit(selected, selected, name);
}

function parseJsonLines<T>(
  output: Buffer,
  guard: (value: unknown) => value is T,
  recordName: string,
): readonly T[] {
  const text = output.toString("utf8");
  if (text.length === 0) {
    return [];
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines.map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new JjInvalidOutputError(
        `jj returned invalid ${recordName} JSON on line ${String(index + 1)}.`,
        { cause: error },
      );
    }
    if (!guard(value)) {
      throw new JjInvalidOutputError(
        `jj returned an invalid ${recordName} record on line ${String(index + 1)}.`,
      );
    }
    return value;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string")
  );
}

function isOperation(value: unknown): value is JjOperation {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    OPERATION_ID_PATTERN.test(value.id) &&
    isStringArray(value.parentIds) &&
    value.parentIds.every((id) => OPERATION_ID_PATTERN.test(id)) &&
    typeof value.description === "string" &&
    typeof value.timestamp === "string" &&
    typeof value.snapshot === "boolean" &&
    typeof value.root === "boolean"
  );
}

function isCommit(value: unknown): value is JjCommit {
  return (
    isRecord(value) &&
    typeof value.changeId === "string" &&
    CHANGE_ID_PATTERN.test(value.changeId) &&
    typeof value.normalChangeId === "string" &&
    /^[0-9a-f]{32}$/u.test(value.normalChangeId) &&
    typeof value.commitId === "string" &&
    COMMIT_ID_PATTERN.test(value.commitId) &&
    isStringArray(value.parentCommitIds) &&
    value.parentCommitIds.every((id) => COMMIT_ID_PATTERN.test(id)) &&
    typeof value.description === "string" &&
    typeof value.subject === "string" &&
    typeof value.conflict === "boolean" &&
    typeof value.divergent === "boolean" &&
    typeof value.root === "boolean" &&
    typeof value.currentWorkingCopy === "boolean"
  );
}

function isFile(value: unknown): value is JjFile {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    value.path.length > 0 &&
    typeof value.fileType === "string" &&
    value.fileType.length > 0 &&
    typeof value.executable === "boolean" &&
    typeof value.conflict === "boolean"
  );
}

interface ChangedFileRecord {
  readonly status: "added" | "modified" | "removed" | "renamed" | "copied";
  readonly sourcePath: string;
  readonly sourceType: string;
  readonly targetPath: string;
  readonly targetType: string;
}

function isChangedFileRecord(value: unknown): value is ChangedFileRecord {
  return (
    isRecord(value) &&
    (value.status === "added" ||
      value.status === "modified" ||
      value.status === "removed" ||
      value.status === "renamed" ||
      value.status === "copied") &&
    typeof value.sourcePath === "string" &&
    value.sourcePath.length > 0 &&
    typeof value.sourceType === "string" &&
    typeof value.targetPath === "string" &&
    value.targetPath.length > 0 &&
    typeof value.targetType === "string"
  );
}

function changedFileFromRecord(record: ChangedFileRecord): JjChangedFile {
  const added = record.status === "added";
  const deleted = record.status === "removed";
  return {
    status: deleted ? "deleted" : record.status,
    originalPath: added ? null : record.sourcePath,
    currentPath: deleted ? null : record.targetPath,
    oldFileType: added ? null : record.sourceType || null,
    newFileType: deleted ? null : record.targetType || null,
  };
}

function assertCommitId(commitId: string): void {
  if (!COMMIT_ID_PATTERN.test(commitId)) {
    throw new TypeError(`"${commitId}" is not a full commit ID.`);
  }
}

function assertOperationId(operationId: string): void {
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    throw new JjInvalidOutputError(
      `"${operationId}" is not a full operation ID.`,
    );
  }
}
