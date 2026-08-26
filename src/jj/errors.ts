export type JjErrorCode =
  | "ambiguous-change"
  | "cancelled"
  | "command-failed"
  | "conflict"
  | "executable-not-found"
  | "invalid-output"
  | "invalid-repository"
  | "invalid-selection"
  | "merge"
  | "output-limit"
  | "stale-selection"
  | "timeout"
  | "unsupported-version";

export class JjError extends Error {
  public constructor(
    public readonly code: JjErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class JjExecutableNotFoundError extends JjError {
  public constructor(executable: string, options?: ErrorOptions) {
    super(
      "executable-not-found",
      `The jj executable "${executable}" was not found.`,
      options,
    );
  }
}

export class JjUnsupportedVersionError extends JjError {
  public constructor(
    public readonly detectedVersion: string,
    public readonly supportedRange: string,
  ) {
    super(
      "unsupported-version",
      `jj ${detectedVersion} is not supported. Install ${supportedRange}.`,
    );
  }
}

export class JjInvalidRepositoryError extends JjError {
  public constructor(repository: string, options?: ErrorOptions) {
    super(
      "invalid-repository",
      `The path "${repository}" is not a readable jj repository.`,
      options,
    );
  }
}

export class JjCommandError extends JjError {
  public constructor(
    public readonly executable: string,
    public readonly args: readonly string[],
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(
      "command-failed",
      stderr.trim() || `jj exited with code ${String(exitCode)}.`,
    );
  }
}

export class JjTimeoutError extends JjError {
  public constructor(public readonly timeoutMs: number) {
    super("timeout", `jj did not finish within ${String(timeoutMs)} ms.`);
  }
}

export class JjCancelledError extends JjError {
  public constructor() {
    super("cancelled", "The jj operation was cancelled.");
  }
}

export class JjOutputLimitError extends JjError {
  public constructor(
    public readonly stream: "stdout" | "stderr",
    public readonly limitBytes: number,
  ) {
    super(
      "output-limit",
      `jj ${stream} exceeded the ${String(limitBytes)} byte limit.`,
    );
  }
}

export class JjInvalidOutputError extends JjError {
  public constructor(message: string, options?: ErrorOptions) {
    super("invalid-output", message, options);
  }
}

export class JjSelectionError extends JjError {
  public constructor(message: string, options?: ErrorOptions) {
    super("invalid-selection", message, options);
  }
}

export class JjAmbiguousChangeError extends JjError {
  public constructor(public readonly changeId: string) {
    super(
      "ambiguous-change",
      `Change ${changeId} resolves to more than one visible commit.`,
    );
  }
}

export class JjMergeError extends JjError {
  public constructor(public readonly changeId: string) {
    super(
      "merge",
      `Change ${changeId} is a merge. Reviews require a single-parent stack.`,
    );
  }
}

export class JjConflictError extends JjError {
  public constructor(public readonly changeId: string) {
    super(
      "conflict",
      `Change ${changeId} has unresolved conflicts and cannot be reviewed.`,
    );
  }
}

export class JjStaleSelectionError extends JjError {
  public constructor(message: string) {
    super("stale-selection", message);
  }
}
