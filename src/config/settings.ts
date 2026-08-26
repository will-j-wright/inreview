import * as vscode from "vscode";

export interface InReviewSettings {
  readonly jjPath: string;
  readonly defaultChangeCount: number;
  readonly largeDiffWarningLines: number;
  readonly mcpEnabled: boolean;
  readonly logLevel: "error" | "warn" | "info" | "debug";
}

export function readSettings(resource?: vscode.Uri): InReviewSettings {
  const configuration = vscode.workspace.getConfiguration("inreview", resource);
  return {
    jjPath: nonEmptyString(configuration.get<string>("jj.path"), "jj"),
    defaultChangeCount: positiveInteger(
      configuration.get<number>("review.defaultChangeCount"),
      1,
    ),
    largeDiffWarningLines: nonNegativeInteger(
      configuration.get<number>("review.largeDiffWarningLines"),
      10_000,
    ),
    mcpEnabled: configuration.get<boolean>("mcp.enabled") !== false,
    logLevel: parseLogLevel(configuration.get<string>("logging.level")),
  };
}

function nonEmptyString(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0
    ? fallback
    : normalized;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : fallback;
}

function parseLogLevel(
  value: string | undefined,
): InReviewSettings["logLevel"] {
  return value === "error" ||
    value === "warn" ||
    value === "debug" ||
    value === "info"
    ? value
    : "info";
}
