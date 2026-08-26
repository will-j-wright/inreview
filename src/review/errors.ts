export type ReviewLifecycleErrorCode =
  | "active-review-conflict"
  | "archived-read-only"
  | "confirmation-required"
  | "invalid-change-count"
  | "no-active-review"
  | "review-not-found"
  | "stale-review";

export class ReviewLifecycleError extends Error {
  public constructor(
    public readonly code: ReviewLifecycleErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ActiveReviewConflictError extends ReviewLifecycleError {
  public constructor(public readonly activeReviewId: string) {
    super(
      "active-review-conflict",
      `Review ${activeReviewId} is active. Archive it or cancel this operation.`,
    );
  }
}

export class ArchivedReviewReadOnlyError extends ReviewLifecycleError {
  public constructor(public readonly reviewId: string) {
    super(
      "archived-read-only",
      `Review ${reviewId} is archived and is read-only until it is restored.`,
    );
  }
}

export class LargeDiffConfirmationRequiredError extends ReviewLifecycleError {
  public constructor(
    public readonly changedLineCount: number,
    public readonly warningLineCount: number,
  ) {
    super(
      "confirmation-required",
      `The review changes ${String(changedLineCount)} lines, above the warning threshold of ${String(warningLineCount)}. Confirmation is required.`,
    );
  }
}

export class InvalidChangeCountError extends ReviewLifecycleError {
  public constructor(public readonly requestedChangeCount: number) {
    super(
      "invalid-change-count",
      "The requested change count must be a positive integer.",
    );
  }
}

export class NoActiveReviewError extends ReviewLifecycleError {
  public constructor() {
    super("no-active-review", "This repository has no active review.");
  }
}

export class ReviewNotFoundError extends ReviewLifecycleError {
  public constructor(public readonly reviewId: string, options?: ErrorOptions) {
    super("review-not-found", `Review ${reviewId} does not exist.`, options);
  }
}

export class StaleReviewError extends ReviewLifecycleError {
  public constructor(message: string) {
    super("stale-review", message);
  }
}
