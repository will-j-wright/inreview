import { StorageError } from "../domain/errors";
import {
  JjError,
  JjExecutableNotFoundError,
  JjExecutableSpawnError,
} from "../jj/errors";
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
    if (error instanceof JjExecutableNotFoundError) {
      return {
        message: `${error.message} Restart VS Code after changing PATH, or set inreview.jj.path to an absolute path.`,
        severity: "error",
      };
    }
    if (error instanceof JjExecutableSpawnError) {
      const permission =
        error.systemCode === "EACCES" || error.systemCode === "EPERM";
      return {
        message: permission
          ? `VS Code does not have permission to run the jj executable "${error.executable}". Check its permissions or set inreview.jj.path to an executable absolute path.`
          : `${error.message} Check inreview.jj.path and the executable permissions.`,
        severity: "error",
      };
    }
    const hints: Partial<Record<JjError["code"], string>> = {
      "invalid-repository": " Open a folder inside one local jj repository.",
      timeout:
        " Check that jj can run in this workspace, then try again.",
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
