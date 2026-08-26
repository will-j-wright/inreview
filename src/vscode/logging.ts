import * as vscode from "vscode";

import { JjCommandError, JjError } from "../jj/errors";

export type LogLevel = "error" | "warn" | "info" | "debug";

const priorities: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class InReviewLogger implements vscode.Disposable {
  readonly #channel: vscode.OutputChannel;

  public constructor(private readonly level: LogLevel) {
    this.#channel = vscode.window.createOutputChannel("InReview");
  }

  public debug(message: string): void {
    this.write("debug", message);
  }

  public info(message: string): void {
    this.write("info", message);
  }

  public warn(message: string): void {
    this.write("warn", message);
  }

  public error(message: string, error?: unknown): void {
    const detail =
      error instanceof Error ? `: ${formatErrorForLog(error)}` : "";
    this.write("error", `${message}${detail}`);
  }

  public show(): void {
    this.#channel.show(true);
  }

  public dispose(): void {
    this.#channel.dispose();
  }

  private write(level: LogLevel, message: string): void {
    if (priorities[level] < priorities[this.level]) {
      return;
    }
    this.#channel.appendLine(
      `[${level}] ${redactLogText(message).replaceAll(/\r?\n/gu, " ")}`,
    );
  }
}

export function redactLogText(value: string): string {
  return value.replace(
    /("(?:secret|body|content)"\s*:\s*")[^"]*(")/giu,
    "$1[REDACTED]$2",
  );
}

function formatErrorForLog(error: Error): string {
  const code =
    "code" in error && typeof error.code === "string"
      ? ` [${error.code}]`
      : "";
  const detail = `${error.name}${code}: ${error.message}`;
  if (
    error instanceof JjError &&
    error.code === "invalid-repository" &&
    error.cause instanceof JjCommandError
  ) {
    return `${detail} Caused by ${error.cause.name} [${error.cause.code}]: ${error.cause.message}`;
  }
  return detail;
}
