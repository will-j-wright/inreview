import { StorageError } from "../domain/errors";
import { JjError } from "../jj/errors";
import { CommentServiceError } from "../review/commentService";
import { ReviewLifecycleError } from "../review/errors";

export interface UserFacingError {
  readonly message: string;
  readonly severity: "information" | "warning" | "error";
}

export function mapUserFacingError(error: unknown): UserFacingError {
  if (error instanceof CommentServiceError) {
    return {
      message: error.message,
      severity:
        error.code === "stale" ||
        error.code === "conflict" ||
        error.code === "immutable"
          ? "warning"
          : "error",
    };
  }
  if (error instanceof ReviewLifecycleError) {
    if (error.code === "no-active-review") {
      return { message: error.message, severity: "information" };
    }
    if (
      error.code === "active-review-conflict" ||
      error.code === "stale-review"
    ) {
      return { message: error.message, severity: "warning" };
    }
    return { message: error.message, severity: "error" };
  }
  if (error instanceof JjError) {
    const hints: Partial<Record<JjError["code"], string>> = {
      "executable-not-found":
        " Configure InReview: Jj Path with a supported jj executable.",
      "unsupported-version": " Install the supported jj version.",
      "invalid-repository": " Open a folder inside one local jj repository.",
      conflict: " Resolve the jj conflicts, then try again.",
      merge: " Select a contiguous single-parent stack.",
      "stale-selection":
        " A selected change is no longer unique and contiguous. Start a new review.",
    };
    return {
      message: `${error.message}${hints[error.code] ?? ""}`,
      severity: error.code === "cancelled" ? "information" : "error",
    };
  }
  if (error instanceof StorageError) {
    const message =
      error.code === "LOCK_HELD"
        ? "Another InReview window is already writing this repository. Close it and retry."
        : error.message;
    return { message, severity: "error" };
  }
  return {
    message: error instanceof Error ? error.message : "An unexpected error occurred.",
    severity: "error",
  };
}
