import { createHash, randomUUID } from "node:crypto";

import {
  commentableNewSideRanges,
  classifyFile,
  parseGitPatch,
  type ParsedFilePatch,
} from "../diff";
import {
  snapshotSchema,
  type BlobReference,
  type FileManifestEntry,
  type Snapshot,
  type ViewIdentity,
  type ViewManifest,
} from "../domain/review";
import type { BlobStore } from "../storage/blobStore";
import {
  JjAmbiguousChangeError,
  JjConflictError,
  JjMergeError,
  JjSelectionError,
} from "./errors";
import type { JjCommit, JjFile, JjOperation, ReviewSelection } from "./types";
import type { JjChangedFile, JjFileProbe } from "./types";

const DEFAULT_CONCURRENCY = 6;

export interface SnapshotBuilderOptions {
  readonly maxConcurrency?: number;
  readonly signal?: AbortSignal;
  readonly snapshotId?: string;
  readonly capturedAt?: string | Date;
}

export interface SnapshotReadSession {
  readonly operationId: string;
  readonly operation: JjOperation;
  diffGit(
    fromCommitId: string,
    toCommitId: string,
    signal?: AbortSignal,
  ): Promise<Buffer>;
  listChangedFiles(
    fromCommitId: string,
    toCommitId: string,
    signal?: AbortSignal,
  ): Promise<readonly JjChangedFile[]>;
  listFiles(
    commitId: string,
    repositoryRelativePaths: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly JjFile[]>;
  readFile(
    commitId: string,
    repositoryRelativePath: string,
    signal?: AbortSignal,
  ): Promise<Buffer>;
  probeFile(
    commitId: string,
    repositoryRelativePath: string,
    signal?: AbortSignal,
  ): Promise<JjFileProbe>;
}

export interface SnapshotPreflightView {
  readonly identity: ViewIdentity;
  readonly baseCommitId: string;
  readonly headCommitId: string;
  readonly files: readonly ParsedFilePatch[];
  readonly changedLineCount: number;
  readonly changedFiles: readonly JjChangedFile[];
}

export interface SnapshotPreflight {
  readonly operationId: string;
  readonly combinedChangedLineCount: number;
  readonly totalChangedLineCount: number;
  readonly views: readonly SnapshotPreflightView[];
}

interface PreparedContent {
  readonly reference: BlobReference;
  readonly content: Buffer;
}

export class PreparedSnapshot {
  public readonly snapshot: Snapshot;
  readonly #contents: readonly PreparedContent[];

  public constructor(snapshot: Snapshot, contents: readonly PreparedContent[]) {
    this.snapshot = deepFreeze(snapshot);
    this.#contents = contents.map(({ reference, content }) => ({
      reference,
      content: Buffer.from(content),
    }));
  }

  public async persistBlobs(store: BlobStore): Promise<Snapshot> {
    await Promise.all(
      this.#contents.map(async ({ reference, content }) => {
        const persisted = await store.put(content);
        if (
          persisted.sha256 !== reference.sha256 ||
          persisted.byteLength !== reference.byteLength
        ) {
          throw new Error(`Blob ${reference.sha256} was persisted with a different identity.`);
        }
      }),
    );
    return this.snapshot;
  }
}

interface ViewDefinition {
  readonly identity: ViewIdentity;
  readonly baseCommitId: string;
  readonly headCommitId: string;
}

interface FileBytes {
  readonly patch: ParsedFilePatch;
  original: Buffer | null;
  modified: Buffer | null;
  readonly oldFile: JjFile | undefined;
  readonly newFile: JjFile | undefined;
  originalByteLength: number;
  modifiedByteLength: number;
  originalContainsNul: boolean;
  modifiedContainsNul: boolean;
}

export async function preflightSnapshot(
  selection: ReviewSelection,
  session: SnapshotReadSession,
  options: Pick<SnapshotBuilderOptions, "maxConcurrency" | "signal"> = {},
): Promise<SnapshotPreflight> {
  validateCaptureSelection(selection, session);
  const concurrency = parseConcurrency(options.maxConcurrency);
  const definitions = viewDefinitions(selection);
  const views = await mapLimit(definitions, concurrency, async (definition) => {
    const [patch, changedFiles] = await Promise.all([
      session.diffGit(
        definition.baseCommitId,
        definition.headCommitId,
        options.signal,
      ),
      session.listChangedFiles(
        definition.baseCommitId,
        definition.headCommitId,
        options.signal,
      ),
    ]);
    const files = parseGitPatch(patch, changedFiles);
    return {
      ...definition,
      files,
      changedFiles,
      changedLineCount: files.reduce(
        (total, file) => total + file.addedLines + file.deletedLines,
        0,
      ),
    };
  });
  const combinedChangedLineCount = views[0]?.changedLineCount ?? 0;
  return deepFreeze({
    operationId: session.operationId,
    combinedChangedLineCount,
    totalChangedLineCount: views.reduce(
      (total, view) => total + view.changedLineCount,
      0,
    ),
    views,
  });
}

export function shouldWarnForChangedLines(
  preflight: SnapshotPreflight,
  warningLineSetting: number,
): boolean {
  if (!Number.isSafeInteger(warningLineSetting) || warningLineSetting < 0) {
    throw new RangeError("The changed-line warning setting must be a non-negative integer.");
  }
  return preflight.combinedChangedLineCount > warningLineSetting;
}

export async function prepareSnapshot(
  selection: ReviewSelection,
  session: SnapshotReadSession,
  options: SnapshotBuilderOptions & {
    readonly preflight?: SnapshotPreflight;
  } = {},
): Promise<PreparedSnapshot> {
  validateCaptureSelection(selection, session);
  const concurrency = parseConcurrency(options.maxConcurrency);
  const preflight =
    options.preflight ??
    (await preflightSnapshot(selection, session, {
      maxConcurrency: concurrency,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }));
  validatePreflight(preflight, selection, session);

  const pathsByCommit = new Map<string, Set<string>>();
  for (const view of preflight.views) {
    for (const patch of view.files) {
      if (patch.originalPath !== null) {
        addPath(pathsByCommit, view.baseCommitId, patch.originalPath);
      }
      if (patch.currentPath !== null) {
        addPath(pathsByCommit, view.headCommitId, patch.currentPath);
      }
    }
  }
  const fileLists = await mapLimit(
    [...pathsByCommit],
    concurrency,
    async ([commitId, paths]) => ({
      commitId,
      files: await session.listFiles(commitId, [...paths], options.signal),
    }),
  );
  const filesByCommit = new Map(
    fileLists.map(({ commitId, files }) => [
      commitId,
      new Map(files.map((file) => [file.path, file])),
    ]),
  );
  rejectFileConflicts(
    fileLists.filter(({ commitId }) => selection.commitIds.includes(commitId)),
    selection,
  );
  rejectChangedFileConflicts(preflight.views, selection);

  const readCache = new Map<string, Promise<Buffer>>();
  const readTasks: (() => Promise<void>)[] = [];
  const bytesByFile = new Map<string, FileBytes>();
  for (const [viewIndex, view] of preflight.views.entries()) {
    for (const [fileIndex, patch] of view.files.entries()) {
      const key = `${String(viewIndex)}:${String(fileIndex)}`;
      const changedFile = view.changedFiles[fileIndex];
      const oldFile =
        patch.originalPath === null
          ? undefined
          : (filesByCommit.get(view.baseCommitId)?.get(patch.originalPath) ??
            fileFromDiffMetadata(
              patch.originalPath,
              changedFile?.oldFileType ?? null,
            ));
      const newFile =
        patch.currentPath === null
          ? undefined
          : (filesByCommit.get(view.headCommitId)?.get(patch.currentPath) ??
            fileFromDiffMetadata(
              patch.currentPath,
              changedFile?.newFileType ?? null,
            ));
      const value: FileBytes = {
        patch,
        original: null,
        modified: null,
        oldFile,
        newFile,
        originalByteLength: 0,
        modifiedByteLength: 0,
        originalContainsNul: false,
        modifiedContainsNul: false,
      };
      bytesByFile.set(key, value);
      if (
        patch.originalPath !== null &&
        shouldReadContentSide(oldFile)
      ) {
        readTasks.push(async () => {
          if (shouldProbeContent(patch, oldFile)) {
            const probe = await session.probeFile(
              view.baseCommitId,
              patch.originalPath ?? "",
              options.signal,
            );
            value.originalByteLength = probe.byteLength;
            value.originalContainsNul = probe.containsNul;
          } else {
            value.original = await readCached(
              readCache,
              session,
              view.baseCommitId,
              patch.originalPath ?? "",
              options.signal,
            );
            value.originalByteLength = value.original.byteLength;
            value.originalContainsNul = value.original.includes(0);
          }
        });
      }
      if (
        patch.currentPath !== null &&
        shouldReadContentSide(newFile)
      ) {
        readTasks.push(async () => {
          if (shouldProbeContent(patch, newFile)) {
            const probe = await session.probeFile(
              view.headCommitId,
              patch.currentPath ?? "",
              options.signal,
            );
            value.modifiedByteLength = probe.byteLength;
            value.modifiedContainsNul = probe.containsNul;
          } else {
            value.modified = await readCached(
              readCache,
              session,
              view.headCommitId,
              patch.currentPath ?? "",
              options.signal,
            );
            value.modifiedByteLength = value.modified.byteLength;
            value.modifiedContainsNul = value.modified.includes(0);
          }
        });
      }
    }
  }
  await runTasks(readTasks, concurrency);

  const textReadTasks: (() => Promise<void>)[] = [];
  for (const [viewIndex, view] of preflight.views.entries()) {
    for (const [fileIndex, patch] of view.files.entries()) {
      const value = bytesByFile.get(`${String(viewIndex)}:${String(fileIndex)}`);
      if (value === undefined || patch.binary) {
        continue;
      }
      if (
        patch.originalPath !== null &&
        value.original === null &&
        shouldReadContentSide(value.oldFile) &&
        !value.originalContainsNul
      ) {
        textReadTasks.push(async () => {
          value.original = await readCached(
            readCache,
            session,
            view.baseCommitId,
            patch.originalPath ?? "",
            options.signal,
          );
          value.originalByteLength = value.original.byteLength;
        });
      }
      if (
        patch.currentPath !== null &&
        value.modified === null &&
        shouldReadContentSide(value.newFile) &&
        !value.modifiedContainsNul
      ) {
        textReadTasks.push(async () => {
          value.modified = await readCached(
            readCache,
            session,
            view.headCommitId,
            patch.currentPath ?? "",
            options.signal,
          );
          value.modifiedByteLength = value.modified.byteLength;
        });
      }
    }
  }
  await runTasks(textReadTasks, concurrency);

  const contents = new Map<string, PreparedContent>();
  const emptyReference = addContent(contents, Buffer.alloc(0));
  const views: ViewManifest[] = preflight.views.map((view, viewIndex) => {
    const files = view.files.map((_, fileIndex) => {
      const value = bytesByFile.get(`${String(viewIndex)}:${String(fileIndex)}`);
      if (value === undefined) {
        throw new Error("A captured file is missing its byte record.");
      }
      return buildFileManifest(view, value, contents, emptyReference);
    });
    return {
      identity: view.identity,
      baseCommitId: view.baseCommitId,
      headCommitId: view.headCommitId,
      files,
      changedLineCount: view.changedLineCount,
    };
  });

  const capturedAt =
    options.capturedAt instanceof Date
      ? options.capturedAt.toISOString()
      : (options.capturedAt ?? new Date().toISOString());
  const snapshot = snapshotSchema.parse({
    id: options.snapshotId ?? randomUUID(),
    capturedAt,
    operationId: session.operationId,
    operation: { ...session.operation, parentIds: [...session.operation.parentIds] },
    orderedChangeIds: [...selection.changeIds],
    changes: selection.commits.map((commit) => snapshotChange(commit)),
    baseCommitId: selection.baseCommitId,
    headCommitId: selection.headCommitId,
    views,
  });
  return new PreparedSnapshot(snapshot, [...contents.values()]);
}

export async function captureSnapshot(
  selection: ReviewSelection,
  session: SnapshotReadSession,
  store: BlobStore,
  options: SnapshotBuilderOptions & {
    readonly preflight?: SnapshotPreflight;
  } = {},
): Promise<Snapshot> {
  const prepared = await prepareSnapshot(selection, session, options);
  return prepared.persistBlobs(store);
}

function buildFileManifest(
  view: SnapshotPreflightView,
  value: FileBytes,
  contents: Map<string, PreparedContent>,
  emptyReference: BlobReference,
): FileManifestEntry {
  const { patch, oldFile, newFile } = value;
  const symbolicLink =
    patch.oldMode === "120000" ||
    patch.newMode === "120000" ||
    oldFile?.fileType === "symlink" ||
    newFile?.fileType === "symlink";
  const original =
    symbolicLink && value.original?.byteLength === 0
      ? (symlinkTargetFromHunks(patch, "old") ?? value.original)
      : value.original;
  const modified =
    symbolicLink && value.modified?.byteLength === 0
      ? (symlinkTargetFromHunks(patch, "new") ?? value.modified)
      : value.modified;
  let resolvedOriginal = original;
  let resolvedModified = modified;
  if (
    symbolicLink &&
    patch.hunks.length === 0 &&
    !patch.binary &&
    patch.originalPath !== null &&
    patch.currentPath !== null
  ) {
    if (
      (resolvedOriginal === null || resolvedOriginal.byteLength === 0) &&
      resolvedModified !== null &&
      resolvedModified.byteLength > 0
    ) {
      resolvedOriginal = Buffer.from(resolvedModified);
    }
    if (
      (resolvedModified === null || resolvedModified.byteLength === 0) &&
      resolvedOriginal !== null &&
      resolvedOriginal.byteLength > 0
    ) {
      resolvedModified = Buffer.from(resolvedOriginal);
    }
  }

  function symlinkTargetFromHunks(
    patch: ParsedFilePatch,
    side: "old" | "new",
  ): Buffer | null {
    const lines = patch.hunks.flatMap((hunk) =>
      hunk.lines.filter(({ kind }) =>
        side === "old" ? kind !== "addition" : kind !== "deletion",
      ),
    );
    if (lines.length !== 1) {
      return null;
    }
    const line = lines[0];
    if (line === undefined) {
      return null;
    }
    return Buffer.from(
      `${line.content}${line.noNewlineAtEnd === true ? "" : "\n"}`,
      "utf8",
    );
  }
  const classification = classifyFile(
    patch,
    resolvedOriginal,
    resolvedModified,
    oldFile?.fileType,
    newFile?.fileType,
    value.originalByteLength,
    value.modifiedByteLength,
  );
  const text = classification.kind === "text";
  const contentRequired =
    text || classification.kind === "symbolic-link";
  if (
    contentRequired &&
    (patch.originalPath === null) !== (resolvedOriginal === null)
  ) {
    throw new Error(`The original content state for ${patch.originalPath ?? "<absent>"} is invalid.`);
  }
  if (
    contentRequired &&
    (patch.currentPath === null) !== (resolvedModified === null)
  ) {
    throw new Error(`The modified content state for ${patch.currentPath ?? "<absent>"} is invalid.`);
  }
  const hunks = text ? [...patch.hunks] : [];
  const originalContent =
    resolvedOriginal === null ? null : addContent(contents, resolvedOriginal);
  const modifiedContent =
    resolvedModified === null
      ? patch.status === "deleted" && contentRequired
        ? emptyReference
        : null
      : addContent(contents, resolvedModified);
  return {
    fileId: deterministicFileId(view, patch),
    status: patch.status,
    kind: classification.kind,
    originalPath: patch.originalPath,
    currentPath: patch.currentPath,
    originalContent,
    modifiedContent,
    patch: addContent(contents, patch.raw),
    hunks,
    addedLines: patch.addedLines,
    deletedLines: patch.deletedLines,
    commentableRanges: text ? [...commentableNewSideRanges(hunks)] : [],
    summary: classification.summary,
  };
}

function addContent(
  contents: Map<string, PreparedContent>,
  content: Uint8Array,
): BlobReference {
  const buffer = Buffer.from(content);
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const existing = contents.get(sha256);
  if (existing !== undefined) {
    return existing.reference;
  }
  const reference: BlobReference = {
    sha256,
    byteLength: buffer.byteLength,
    encoding: "gzip",
  };
  contents.set(sha256, { reference, content: buffer });
  return reference;
}

function deterministicFileId(
  view: SnapshotPreflightView,
  patch: ParsedFilePatch,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        view: view.identity,
        base: view.baseCommitId,
        head: view.headCommitId,
        status: patch.status,
        originalPath: patch.originalPath,
        currentPath: patch.currentPath,
      }),
      "utf8",
    )
    .digest("hex");
}

function snapshotChange(commit: JjCommit): {
  readonly changeId: string;
  readonly normalChangeId: string;
  readonly commitId: string;
  readonly parentCommitId: string;
  readonly parentCommitIds: readonly string[];
  readonly description: string;
  readonly subject: string;
} {
  const parentCommitId = commit.parentCommitIds[0];
  if (parentCommitId === undefined) {
    throw new JjMergeError(commit.changeId);
  }
  return {
    changeId: commit.changeId,
    normalChangeId: commit.normalChangeId,
    commitId: commit.commitId,
    parentCommitId,
    parentCommitIds: [...commit.parentCommitIds],
    description: commit.description,
    subject: commit.subject,
  };
}

function viewDefinitions(selection: ReviewSelection): readonly ViewDefinition[] {
  return [
    {
      identity: { mode: "combined" },
      baseCommitId: selection.baseCommitId,
      headCommitId: selection.headCommitId,
    },
    ...selection.commits.map((commit) => {
      const parentCommitId = commit.parentCommitIds[0];
      if (parentCommitId === undefined) {
        throw new JjMergeError(commit.changeId);
      }
      return {
        identity: { mode: "per-change" as const, changeId: commit.changeId },
        baseCommitId: parentCommitId,
        headCommitId: commit.commitId,
      };
    }),
  ];
}

function validateCaptureSelection(
  selection: ReviewSelection,
  session: SnapshotReadSession,
): void {
  if (selection.operationId !== session.operationId) {
    throw new JjSelectionError("The selection and read session use different jj operations.");
  }
  if (
    selection.commits.length === 0 ||
    selection.commits.length !== selection.changeIds.length ||
    selection.commits.length !== selection.commitIds.length
  ) {
    throw new JjSelectionError("The capture selection metadata is inconsistent.");
  }
  const seen = new Set<string>();
  for (const [index, commit] of selection.commits.entries()) {
    if (commit.conflict) {
      throw new JjConflictError(commit.changeId);
    }
    if (commit.divergent || seen.has(commit.changeId)) {
      throw new JjAmbiguousChangeError(commit.changeId);
    }
    seen.add(commit.changeId);
    if (commit.root || commit.parentCommitIds.length !== 1) {
      throw new JjMergeError(commit.changeId);
    }
    if (
      commit.changeId !== selection.changeIds[index] ||
      commit.commitId !== selection.commitIds[index] ||
      (index > 0 &&
        commit.parentCommitIds[0] !== selection.commits[index - 1]?.commitId)
    ) {
      throw new JjSelectionError("The selected changes do not form the declared stack.");
    }
  }
  if (
    selection.baseCommitId !== selection.commits[0]?.parentCommitIds[0] ||
    selection.headCommitId !== selection.commits.at(-1)?.commitId
  ) {
    throw new JjSelectionError("The selected base or head commit is inconsistent.");
  }
}

function validatePreflight(
  preflight: SnapshotPreflight,
  selection: ReviewSelection,
  session: SnapshotReadSession,
): void {
  const expected = viewDefinitions(selection);
  if (
    preflight.operationId !== session.operationId ||
    preflight.views.length !== expected.length ||
    preflight.views.some((view, index) => {
      const expectedView = expected[index];
      return (
        expectedView === undefined ||
        JSON.stringify(view.identity) !== JSON.stringify(expectedView.identity) ||
        view.baseCommitId !== expectedView.baseCommitId ||
        view.headCommitId !== expectedView.headCommitId
      );
    })
  ) {
    throw new JjSelectionError("The snapshot preflight does not match this selection.");
  }
}

function rejectFileConflicts(
  fileLists: readonly { readonly commitId: string; readonly files: readonly JjFile[] }[],
  selection: ReviewSelection,
): void {
  const conflict = fileLists.find(({ files }) =>
    files.some(({ conflict, fileType }) => conflict || fileType === "conflict"),
  );
  if (conflict !== undefined) {
    const change =
      selection.commits.find(({ commitId }) => commitId === conflict.commitId) ??
      selection.commits[0];
    throw new JjConflictError(change?.changeId ?? "unknown");
  }
}

function rejectChangedFileConflicts(
  views: readonly SnapshotPreflightView[],
  selection: ReviewSelection,
): void {
  const conflictedHead = views.find(
    ({ headCommitId, changedFiles }) =>
      selection.commitIds.includes(headCommitId) &&
      changedFiles.some(({ newFileType }) => newFileType === "conflict"),
  );
  if (conflictedHead === undefined) {
    return;
  }
  const change = selection.commits.find(
    ({ commitId }) => commitId === conflictedHead.headCommitId,
  );
  throw new JjConflictError(change?.changeId ?? "unknown");
}

function addPath(
  pathsByCommit: Map<string, Set<string>>,
  commitId: string,
  filePath: string,
): void {
  let paths = pathsByCommit.get(commitId);
  if (paths === undefined) {
    paths = new Set<string>();
    pathsByCommit.set(commitId, paths);
  }
  paths.add(filePath);
}

function fileFromDiffMetadata(
  filePath: string,
  fileType: string | null,
): JjFile | undefined {
  if (fileType === null || fileType.length === 0) {
    return undefined;
  }
  return {
    path: filePath,
    fileType,
    executable: false,
    conflict: fileType === "conflict",
  };
}

function shouldReadContentSide(file: JjFile | undefined): boolean {
  if (file === undefined) {
    return false;
  }
  return (
    file.fileType === "file" ||
    file.fileType === "symlink" ||
    file.fileType === "conflict"
  );
}

function shouldProbeContent(
  patch: ParsedFilePatch,
  file: JjFile | undefined,
): boolean {
  return (
    (file?.fileType === "file" || file?.fileType === "conflict") &&
    (patch.binary || patch.hunks.length === 0)
  );
}

async function readCached(
  cache: Map<string, Promise<Buffer>>,
  session: SnapshotReadSession,
  commitId: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  const key = `${commitId}\0${filePath}`;
  let read = cache.get(key);
  if (read === undefined) {
    read = session.readFile(commitId, filePath, signal);
    cache.set(key, read);
  }
  return Buffer.from(await read);
}

function parseConcurrency(value: number | undefined): number {
  const concurrency = value ?? DEFAULT_CONCURRENCY;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new RangeError("Snapshot concurrency must be a positive integer.");
  }
  return concurrency;
}

async function mapLimit<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        const value = values[index];
        if (value !== undefined) {
          results[index] = await mapper(value, index);
        }
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function runTasks(
  tasks: readonly (() => Promise<void>)[],
  concurrency: number,
): Promise<void> {
  await mapLimit(tasks, concurrency, async (task) => task());
}

function deepFreeze<T>(value: T): T {
  if (
    typeof value !== "object" ||
    value === null ||
    ArrayBuffer.isView(value) ||
    Object.isFrozen(value)
  ) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return value;
}
