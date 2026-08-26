import type {
  FileStatus,
  PatchHunk,
  PatchLine,
} from "../domain/review";

export class GitPatchParseError extends Error {
  public constructor(
    message: string,
    public readonly line: number,
  ) {
    super(`Invalid Git patch at line ${String(line)}: ${message}`);
    this.name = "GitPatchParseError";
  }
}

export interface ParsedFilePatch {
  readonly status: FileStatus;
  readonly originalPath: string | null;
  readonly currentPath: string | null;
  readonly oldMode: string | null;
  readonly newMode: string | null;
  readonly binary: boolean;
  readonly hunks: readonly PatchHunk[];
  readonly addedLines: number;
  readonly deletedLines: number;
  readonly raw: Buffer;
  readonly pathResolution: "exact" | "ambiguous";
}

interface HeaderPathPair {
  readonly oldPath: string;
  readonly newPath: string;
}

export interface PatchPathFallback {
  readonly status: FileStatus;
  readonly originalPath: string | null;
  readonly currentPath: string | null;
}

interface MutablePatchMetadata {
  oldMode: string | null;
  newMode: string | null;
  newFile: boolean;
  deletedFile: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  copyFrom: string | null;
  copyTo: string | null;
  markerOldPath: string | null | undefined;
  markerNewPath: string | null | undefined;
  binary: boolean;
  gitBinaryPayload: boolean;
}

const modePattern = /^[0-7]{6}$/u;
const hunkHeaderPattern =
  /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/u;

export function parseGitPatch(
  patch: Uint8Array | string,
  pathFallbacks: readonly PatchPathFallback[] = [],
): readonly ParsedFilePatch[] {
  const patchBytes =
    typeof patch === "string" ? Buffer.from(patch, "utf8") : Buffer.from(patch);
  if (patchBytes.includes(0)) {
    throw new GitPatchParseError("NUL bytes are not valid patch text.", 1);
  }
  if (patchBytes.length === 0) {
    return [];
  }

  // Latin-1 gives every input byte a unique code point. Structural parsing can
  // then inspect ASCII delimiters without replacing non-UTF-8 hunk bytes.
  const byteText = patchBytes.toString("latin1");
  const hasFinalNewline = byteText.endsWith("\n");
  const lines = byteText.split("\n");
  if (hasFinalNewline) {
    lines.pop();
  }

  const files: ParsedFilePatch[] = [];
  let index = 0;
  while (index < lines.length) {
    const sectionStart = index;
    const header = lines[index];
    if (!header?.startsWith("diff --git ")) {
      throw new GitPatchParseError('Expected a "diff --git" header.', index + 1);
    }
    const headerPairs = parseDiffHeader(header, index + 1);
    index += 1;

    const metadata: MutablePatchMetadata = {
      oldMode: null,
      newMode: null,
      newFile: false,
      deletedFile: false,
      renameFrom: null,
      renameTo: null,
      copyFrom: null,
      copyTo: null,
      markerOldPath: undefined,
      markerNewPath: undefined,
      binary: false,
      gitBinaryPayload: false,
    };
    const hunks: PatchHunk[] = [];

    while (index < lines.length && !lines[index]?.startsWith("diff --git ")) {
      const line = lines[index];
      if (line === undefined) {
        break;
      }
      if (line.startsWith("@@ ")) {
        if (metadata.markerOldPath === undefined || metadata.markerNewPath === undefined) {
          throw new GitPatchParseError(
            "A text hunk requires both --- and +++ path markers.",
            index + 1,
          );
        }
        const parsed = parseHunk(lines, index);
        hunks.push(parsed.hunk);
        index = parsed.nextIndex;
        continue;
      }
      parseMetadataLine(line, metadata, index + 1);
      index += 1;
    }

    validateMetadata(metadata, hunks, sectionStart + 1);
    const status = resolveStatus(metadata);
    const fallback = pathFallbacks[files.length];
    if (fallback !== undefined && fallback.status !== status) {
      throw new GitPatchParseError(
        "The diff metadata status does not match the Git patch.",
        sectionStart + 1,
      );
    }
    const paths = resolvePaths(
      headerPairs,
      metadata,
      sectionStart + 1,
      fallback,
      metadata.binary || hunks.length === 0,
    );
    const sectionEndsAtPatchEnd = index === lines.length;
    const rawText =
      lines.slice(sectionStart, index).join("\n") +
      (sectionEndsAtPatchEnd && !hasFinalNewline ? "" : "\n");
    const addedLines = hunks.reduce(
      (total, hunk) =>
        total + hunk.lines.filter(({ kind }) => kind === "addition").length,
      0,
    );
    const deletedLines = hunks.reduce(
      (total, hunk) =>
        total + hunk.lines.filter(({ kind }) => kind === "deletion").length,
      0,
    );

    files.push({
      status,
      originalPath:
        status === "added" ? null : (paths?.oldPath ?? fallback?.originalPath ?? null),
      currentPath:
        status === "deleted" ? null : (paths?.newPath ?? fallback?.currentPath ?? null),
      oldMode: metadata.oldMode,
      newMode: metadata.newMode,
      binary: metadata.binary,
      hunks,
      addedLines,
      deletedLines,
      raw: Buffer.from(rawText, "latin1"),
      pathResolution: paths === null && fallback === undefined ? "ambiguous" : "exact",
    });
  }
  if (pathFallbacks.length > 0 && pathFallbacks.length !== files.length) {
    throw new GitPatchParseError(
      "The diff metadata count does not match the Git patch.",
      lines.length,
    );
  }
  return files;
}

function parseDiffHeader(line: string, lineNumber: number): readonly HeaderPathPair[] {
  const value = line.slice("diff --git ".length);
  if (value.startsWith('"')) {
    const first = parseQuotedToken(value, lineNumber);
    const rest = value.slice(first.consumed);
    if (!rest.startsWith(" ")) {
      throw new GitPatchParseError("Quoted diff paths must be separated by one space.", lineNumber);
    }
    const second = parseQuotedToken(rest.slice(1), lineNumber);
    if (second.consumed !== rest.length - 1) {
      throw new GitPatchParseError("Unexpected text follows the second diff path.", lineNumber);
    }
    return [
      {
        oldPath: stripSidePrefix(first.value, "a/", lineNumber),
        newPath: stripSidePrefix(second.value, "b/", lineNumber),
      },
    ];
  }

  if (!value.startsWith("a/")) {
    throw new GitPatchParseError('The old diff path must start with "a/".', lineNumber);
  }
  const pairs: HeaderPathPair[] = [];
  let delimiter = value.indexOf(" b/");
  while (delimiter >= 0) {
    pairs.push({
      oldPath: decodeUnquotedPath(value.slice(2, delimiter), lineNumber),
      newPath: decodeUnquotedPath(value.slice(delimiter + 3), lineNumber),
    });
    delimiter = value.indexOf(" b/", delimiter + 1);
  }
  if (pairs.length === 0 || pairs.some(({ oldPath, newPath }) => oldPath.length === 0 || newPath.length === 0)) {
    throw new GitPatchParseError("The unquoted diff paths are malformed.", lineNumber);
  }
  return pairs;
}

function parseMetadataLine(
  line: string,
  metadata: MutablePatchMetadata,
  lineNumber: number,
): void {
  if (metadata.gitBinaryPayload) {
    return;
  }
  if (line === "" || /^dissimilarity index \d+%$/u.test(line) || /^similarity index \d+%$/u.test(line)) {
    return;
  }
  if (line === "GIT binary patch") {
    metadata.binary = true;
    metadata.gitBinaryPayload = true;
    return;
  }
  if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
    metadata.binary = true;
    return;
  }
  if (line.startsWith("old mode ")) {
    metadata.oldMode = setMode(metadata.oldMode, line.slice(9), lineNumber);
    return;
  }
  if (line.startsWith("new mode ")) {
    metadata.newMode = setMode(metadata.newMode, line.slice(9), lineNumber);
    return;
  }
  if (line.startsWith("new file mode ")) {
    metadata.newMode = setMode(metadata.newMode, line.slice(14), lineNumber);
    metadata.newFile = true;
    return;
  }
  if (line.startsWith("deleted file mode ")) {
    metadata.oldMode = setMode(metadata.oldMode, line.slice(18), lineNumber);
    metadata.deletedFile = true;
    return;
  }
  if (line.startsWith("rename from ")) {
    metadata.renameFrom = setPath(metadata.renameFrom, line.slice(12), lineNumber);
    return;
  }
  if (line.startsWith("rename to ")) {
    metadata.renameTo = setPath(metadata.renameTo, line.slice(10), lineNumber);
    return;
  }
  if (line.startsWith("copy from ")) {
    metadata.copyFrom = setPath(metadata.copyFrom, line.slice(10), lineNumber);
    return;
  }
  if (line.startsWith("copy to ")) {
    metadata.copyTo = setPath(metadata.copyTo, line.slice(8), lineNumber);
    return;
  }
  if (line.startsWith("index ")) {
    const match = /^index [0-9a-f]+\.\.[0-9a-f]+(?: ([0-7]{6}))?$/u.exec(line);
    if (match === null) {
      throw new GitPatchParseError("The index header is malformed.", lineNumber);
    }
    const mode = match[1];
    if (mode !== undefined) {
      metadata.oldMode ??= mode;
      metadata.newMode ??= mode;
    }
    return;
  }
  if (line.startsWith("--- ")) {
    if (metadata.markerOldPath !== undefined) {
      throw new GitPatchParseError("The old path marker is duplicated.", lineNumber);
    }
    metadata.markerOldPath = parseMarkerPath(line.slice(4), "a/", lineNumber);
    return;
  }
  if (line.startsWith("+++ ")) {
    if (metadata.markerNewPath !== undefined) {
      throw new GitPatchParseError("The new path marker is duplicated.", lineNumber);
    }
    metadata.markerNewPath = parseMarkerPath(line.slice(4), "b/", lineNumber);
    return;
  }
  throw new GitPatchParseError(`Unexpected patch header "${line}".`, lineNumber);
}

function parseHunk(
  lines: readonly string[],
  startIndex: number,
): { readonly hunk: PatchHunk; readonly nextIndex: number } {
  const rawHeader = lines[startIndex] ?? "";
  const match = hunkHeaderPattern.exec(rawHeader);
  if (match === null) {
    throw new GitPatchParseError("The hunk range header is malformed.", startIndex + 1);
  }
  const oldStart = safeInteger(match[1], startIndex + 1);
  const oldLines = safeInteger(match[2] ?? "1", startIndex + 1);
  const newStart = safeInteger(match[3], startIndex + 1);
  const newLines = safeInteger(match[4] ?? "1", startIndex + 1);
  const parsedLines: PatchLine[] = [];
  let oldLine = oldStart;
  let newLine = newStart;
  let consumedOld = 0;
  let consumedNew = 0;
  let index = startIndex + 1;

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || line.startsWith("diff --git ") || line.startsWith("@@ ")) {
      break;
    }
    if (line === "\\ No newline at end of file") {
      const previous = parsedLines.at(-1);
      if (previous === undefined || previous.noNewlineAtEnd === true) {
        throw new GitPatchParseError("The no-newline marker has no preceding line.", index + 1);
      }
      previous.noNewlineAtEnd = true;
      index += 1;
      continue;
    }
    const prefix = line[0];
    const content = decodePatchDisplay(line.slice(1));
    if (prefix === " ") {
      parsedLines.push({
        kind: "context",
        content,
        oldLine: positiveLine(oldLine, startIndex + 1),
        newLine: positiveLine(newLine, startIndex + 1),
      });
      oldLine += 1;
      newLine += 1;
      consumedOld += 1;
      consumedNew += 1;
    } else if (prefix === "+") {
      parsedLines.push({
        kind: "addition",
        content,
        oldLine: null,
        newLine: positiveLine(newLine, startIndex + 1),
      });
      newLine += 1;
      consumedNew += 1;
    } else if (prefix === "-") {
      parsedLines.push({
        kind: "deletion",
        content,
        oldLine: positiveLine(oldLine, startIndex + 1),
        newLine: null,
      });
      oldLine += 1;
      consumedOld += 1;
    } else {
      break;
    }
    index += 1;
  }

  if (consumedOld !== oldLines || consumedNew !== newLines) {
    throw new GitPatchParseError(
      `The hunk body has ${String(consumedOld)}/${String(consumedNew)} old/new lines; expected ${String(oldLines)}/${String(newLines)}.`,
      startIndex + 1,
    );
  }
  const raw = decodePatchDisplay(
    `${lines.slice(startIndex, index).join("\n")}\n`,
  );
  return {
    hunk: {
      header: decodePatchDisplay(rawHeader),
      oldStart,
      oldLines,
      newStart,
      newLines,
      lines: parsedLines,
      raw,
    },
    nextIndex: index,
  };
}

function validateMetadata(
  metadata: MutablePatchMetadata,
  hunks: readonly PatchHunk[],
  lineNumber: number,
): void {
  if ((metadata.renameFrom === null) !== (metadata.renameTo === null)) {
    throw new GitPatchParseError("Rename metadata requires both from and to paths.", lineNumber);
  }
  if ((metadata.copyFrom === null) !== (metadata.copyTo === null)) {
    throw new GitPatchParseError("Copy metadata requires both from and to paths.", lineNumber);
  }
  const statusMarkers = [
    metadata.newFile,
    metadata.deletedFile,
    metadata.renameFrom !== null,
    metadata.copyFrom !== null,
  ].filter(Boolean).length;
  if (statusMarkers > 1) {
    throw new GitPatchParseError("The patch contains conflicting file status headers.", lineNumber);
  }
  if ((metadata.markerOldPath === undefined) !== (metadata.markerNewPath === undefined)) {
    throw new GitPatchParseError("Text path markers must occur as an old/new pair.", lineNumber);
  }
  if (metadata.newFile && metadata.markerOldPath !== undefined && metadata.markerOldPath !== null) {
    throw new GitPatchParseError("An added file must use /dev/null as its old path.", lineNumber);
  }
  if (metadata.deletedFile && metadata.markerNewPath !== undefined && metadata.markerNewPath !== null) {
    throw new GitPatchParseError("A deleted file must use /dev/null as its new path.", lineNumber);
  }
  if (metadata.binary && hunks.length > 0) {
    throw new GitPatchParseError("A binary patch cannot contain text hunks.", lineNumber);
  }
  if (
    metadata.oldMode === null &&
    metadata.newMode === null &&
    metadata.renameFrom === null &&
    metadata.copyFrom === null &&
    metadata.markerOldPath === undefined &&
    !metadata.binary &&
    hunks.length === 0
  ) {
    throw new GitPatchParseError("The file patch contains no change metadata.", lineNumber);
  }
}

function resolvePaths(
  candidates: readonly HeaderPathPair[],
  metadata: MutablePatchMetadata,
  lineNumber: number,
  fallback: PatchPathFallback | undefined,
  allowAmbiguous: boolean,
): HeaderPathPair | null {
  const expectedOld =
    metadata.renameFrom ??
    metadata.copyFrom ??
    (metadata.markerOldPath === null ? undefined : metadata.markerOldPath);
  const expectedNew =
    metadata.renameTo ??
    metadata.copyTo ??
    (metadata.markerNewPath === null ? undefined : metadata.markerNewPath);
  const fallbackOld = fallback?.originalPath ?? undefined;
  const fallbackNew = fallback?.currentPath ?? undefined;
  let matches = candidates.filter(
    ({ oldPath, newPath }) =>
      (expectedOld === undefined || oldPath === expectedOld) &&
      (expectedNew === undefined || newPath === expectedNew) &&
      (fallbackOld === undefined || oldPath === fallbackOld) &&
      (fallbackNew === undefined || newPath === fallbackNew),
  );
  if (matches.length > 1 && expectedOld === undefined && expectedNew === undefined) {
    const unchanged = matches.filter(
      ({ oldPath, newPath }) => oldPath === newPath,
    );
    if (unchanged.length > 0) {
      matches = unchanged;
    }
  }
  const match = matches[0];
  if (matches.length === 1 && match !== undefined) {
    return match;
  }
  if (allowAmbiguous && matches.length > 1) {
    return null;
  }
  throw new GitPatchParseError(
    matches.length === 0
      ? "The diff paths do not match the file metadata."
      : "The unquoted diff paths are ambiguous.",
    lineNumber,
  );
}

function resolveStatus(metadata: MutablePatchMetadata): FileStatus {
  if (metadata.copyFrom !== null) {
    return "copied";
  }
  if (metadata.renameFrom !== null) {
    return "renamed";
  }
  if (metadata.newFile || metadata.markerOldPath === null) {
    return "added";
  }
  if (metadata.deletedFile || metadata.markerNewPath === null) {
    return "deleted";
  }
  return "modified";
}

function setMode(current: string | null, value: string, lineNumber: number): string {
  if (!modePattern.test(value) || (current !== null && current !== value)) {
    throw new GitPatchParseError("The file mode header is invalid or duplicated.", lineNumber);
  }
  return value;
}

function setPath(current: string | null, value: string, lineNumber: number): string {
  if (current !== null) {
    throw new GitPatchParseError("The path header is duplicated.", lineNumber);
  }
  const decoded = decodeGitPath(value, lineNumber);
  assertRepositoryPath(decoded, lineNumber);
  return decoded;
}

function parseMarkerPath(
  value: string,
  prefix: "a/" | "b/",
  lineNumber: number,
): string | null {
  if (value === "/dev/null") {
    return null;
  }
  const decoded = decodeGitPath(value, lineNumber);
  return stripSidePrefix(decoded, prefix, lineNumber);
}

function decodeGitPath(value: string, lineNumber: number): string {
  if (!value.startsWith('"')) {
    return decodeUnquotedPath(value, lineNumber);
  }
  const token = parseQuotedToken(value, lineNumber);
  if (token.consumed !== value.length) {
    throw new GitPatchParseError("Unexpected text follows a quoted path.", lineNumber);
  }
  return token.value;
}

function parseQuotedToken(
  input: string,
  lineNumber: number,
): { readonly value: string; readonly consumed: number } {
  if (!input.startsWith('"')) {
    throw new GitPatchParseError("Expected a quoted path.", lineNumber);
  }
  const bytes: number[] = [];
  let index = 1;
  while (index < input.length) {
    const character = input[index];
    if (character === '"') {
      const value = decodeUtf8(bytes, lineNumber);
      assertRepositoryPath(value, lineNumber);
      return { value, consumed: index + 1 };
    }
    if (character === "\\") {
      const escaped = input[index + 1];
      if (escaped === undefined) {
        break;
      }
      const simple: Readonly<Record<string, number>> = {
        a: 7,
        b: 8,
        t: 9,
        n: 10,
        v: 11,
        f: 12,
        r: 13,
        '"': 34,
        "\\": 92,
      };
      const simpleByte = simple[escaped];
      if (simpleByte !== undefined) {
        bytes.push(simpleByte);
        index += 2;
        continue;
      }
      if (/^[0-7]$/u.test(escaped)) {
        let digits = escaped;
        let digitIndex = index + 2;
        while (digits.length < 3 && digitIndex < input.length) {
          const digit = input[digitIndex];
          if (digit === undefined || !/^[0-7]$/u.test(digit)) {
            break;
          }
          digits += digit;
          digitIndex += 1;
        }
        bytes.push(Number.parseInt(digits, 8));
        index = digitIndex;
        continue;
      }
      throw new GitPatchParseError(`Unsupported path escape "\\${escaped}".`, lineNumber);
    }
    if (character === undefined) {
      break;
    }
    const byte = character.charCodeAt(0);
    if (byte > 0xff) {
      throw new GitPatchParseError(
        "A quoted path contains a non-byte character.",
        lineNumber,
      );
    }
    bytes.push(byte);
    index += 1;
  }

  throw new GitPatchParseError("The quoted path is not terminated.", lineNumber);
}

function decodeUnquotedPath(value: string, lineNumber: number): string {
  const decoded = decodeUtf8(Buffer.from(value, "latin1"), lineNumber);
  assertRepositoryPath(decoded, lineNumber);
  return decoded;
}

function decodePatchDisplay(value: string): string {
  const bytes = Buffer.from(value, "latin1");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

function decodeUtf8(
  bytes: Uint8Array | readonly number[],
  lineNumber: number,
): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes),
    );
  } catch (error) {
    throw new GitPatchParseError(
      `The quoted path is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`,
      lineNumber,
    );
  }
}

function stripSidePrefix(
  value: string,
  prefix: "a/" | "b/",
  lineNumber: number,
): string {
  if (!value.startsWith(prefix)) {
    throw new GitPatchParseError(`The path must start with "${prefix}".`, lineNumber);
  }
  const result = value.slice(2);
  assertRepositoryPath(result, lineNumber);
  return result;
}

function assertRepositoryPath(value: string, lineNumber: number): void {
  const segments = value.split("/");
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new GitPatchParseError("A patch path must be repository-relative.", lineNumber);
  }
}

function safeInteger(value: string | undefined, lineNumber: number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new GitPatchParseError("A hunk range is outside the supported integer range.", lineNumber);
  }
  return result;
}

function positiveLine(value: number, lineNumber: number): number {
  if (value < 1) {
    throw new GitPatchParseError("A nonempty hunk cannot use line zero.", lineNumber);
  }
  return value;
}
