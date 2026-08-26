import type {
  FileKind,
  FileSummary,
  LineRange,
  PatchHunk,
} from "../domain/review";
import type { JjFileType } from "../jj/types";
import type { ParsedFilePatch } from "./gitPatchParser";

const utf8Decoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: false,
});

export interface FileClassification {
  readonly kind: FileKind;
  readonly summary: FileSummary;
}

export function classifyFile(
  patch: ParsedFilePatch,
  original: Uint8Array | null,
  modified: Uint8Array | null,
  oldFileType?: JjFileType,
  newFileType?: JjFileType,
  originalByteLength = original?.byteLength ?? 0,
  modifiedByteLength = modified?.byteLength ?? 0,
): FileClassification {
  const symbolicLink =
    patch.oldMode === "120000" ||
    patch.newMode === "120000" ||
    oldFileType === "symlink" ||
    newFileType === "symlink";
  if (symbolicLink) {
    return {
      kind: "symbolic-link",
      summary: {
        kind: "symbolic-link",
        originalTarget: original === null ? null : decodeLinkTarget(original),
        modifiedTarget: modified === null ? null : decodeLinkTarget(modified),
      },
    };
  }

  const nonRegularTypes = [oldFileType, newFileType].filter(
    (fileType): fileType is string =>
      fileType !== undefined &&
      fileType !== "file" &&
      fileType !== "conflict",
  );
  if (nonRegularTypes.length > 0) {
    return {
      kind: "non-regular",
      summary: {
        kind: "non-regular",
        originalType: oldFileType ?? null,
        modifiedType: newFileType ?? null,
      },
    };
  }

  if (
    patch.binary ||
    original?.includes(0) === true ||
    modified?.includes(0) === true
  ) {
    return {
      kind: "binary",
      summary: {
        kind: "binary",
        originalByteLength,
        modifiedByteLength,
      },
    };
  }
  return {
    kind: "text",
    summary: {
      kind: "text",
      encoding:
        isUtf8(original) && isUtf8(modified) ? "utf-8" : "windows-1252",
    },
  };
}

export function decodeTextForDisplay(content: Uint8Array): string {
  if (content.includes(0)) {
    throw new TypeError("The content contains NUL bytes and is not displayable text.");
  }
  return isUtf8(content)
    ? utf8Decoder.decode(content)
    : new TextDecoder("windows-1252").decode(content);
}

export function commentableNewSideRanges(
  hunks: readonly PatchHunk[],
): readonly LineRange[] {
  const lines = new Set<number>();
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind !== "deletion" && line.newLine !== null) {
        lines.add(line.newLine);
      }
    }
  }
  const ordered = [...lines].sort((left, right) => left - right);
  const ranges: LineRange[] = [];
  for (const line of ordered) {
    const previous = ranges.at(-1);
    if (previous !== undefined && line === previous.end + 1) {
      previous.end = line;
    } else {
      ranges.push({ start: line, end: line });
    }
  }
  return ranges;
}

function isUtf8(content: Uint8Array | null): boolean {
  if (content === null) {
    return true;
  }
  try {
    utf8Decoder.decode(content);
    return true;
  } catch {
    return false;
  }
}

function decodeLinkTarget(content: Uint8Array): string {
  if (content.includes(0)) {
    return "<invalid symbolic-link target>";
  }
  return decodeTextForDisplay(content);
}
