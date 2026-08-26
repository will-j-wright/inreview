import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";

import { StorageError, errorMessage } from "../domain/errors";
import type { BlobReference } from "../domain/review";
import {
  atomicWriteFile,
  cleanupTemporaryFiles,
  type StorageFaultInjector,
} from "./atomicFile";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const blobFilePattern = /^([a-f0-9]{64})\.gz$/u;

export class BlobStore {
  readonly #directory: string;
  readonly #faultInjector: StorageFaultInjector | undefined;

  public constructor(directory: string, faultInjector?: StorageFaultInjector) {
    this.#directory = directory;
    this.#faultInjector = faultInjector;
  }

  public async initialize(): Promise<void> {
    await mkdir(this.#directory, { recursive: true });
    await cleanupTemporaryFiles(this.#directory);
  }

  public async put(content: Uint8Array): Promise<BlobReference> {
    const sha256 = createHash("sha256").update(content).digest("hex");
    const reference: BlobReference = {
      sha256,
      byteLength: content.byteLength,
      encoding: "gzip",
    };
    const destination = this.pathFor(sha256);

    try {
      await stat(destination);
      await this.get(reference);
      return reference;
    } catch (error) {
      if (
        !(error instanceof StorageError) &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        // The blob is new.
      } else if (error instanceof StorageError && error.code === "NOT_FOUND") {
        // The blob is new.
      } else {
        throw error;
      }
    }

    const compressed = await gzipAsync(content, { level: 9 });
    await atomicWriteFile(
      destination,
      compressed,
      "before-blob-rename",
      this.#faultInjector,
    );
    return reference;
  }

  public async get(reference: BlobReference): Promise<Buffer> {
    const filePath = this.pathFor(reference.sha256);
    let compressed: Buffer;
    try {
      compressed = await readFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new StorageError("NOT_FOUND", `Blob ${reference.sha256} does not exist.`, {
          cause: error,
          path: filePath,
        });
      }
      throw new StorageError("IO_ERROR", `Could not read blob ${reference.sha256}.`, {
        cause: error,
        path: filePath,
      });
    }

    let content: Buffer;
    try {
      content = await gunzipAsync(compressed);
    } catch (error) {
      throw new StorageError(
        "CORRUPT_DATA",
        `Blob ${reference.sha256} is not valid gzip data: ${errorMessage(error)}`,
        { cause: error, path: filePath },
      );
    }

    const actualHash = createHash("sha256").update(content).digest("hex");
    if (actualHash !== reference.sha256 || content.byteLength !== reference.byteLength) {
      throw new StorageError(
        "HASH_MISMATCH",
        `Blob ${reference.sha256} failed SHA-256 or length validation.`,
        { path: filePath },
      );
    }
    return content;
  }

  public async garbageCollect(referencedHashes: ReadonlySet<string>): Promise<number> {
    const entries = await readdir(this.#directory, { withFileTypes: true });
    const removals = entries.flatMap((entry) => {
      const match = entry.isFile() ? blobFilePattern.exec(entry.name) : null;
      const hash = match?.[1];
      return hash !== undefined && !referencedHashes.has(hash)
        ? [rm(path.join(this.#directory, entry.name))]
        : [];
    });
    await Promise.all(removals);
    return removals.length;
  }

  private pathFor(hash: string): string {
    if (!/^[a-f0-9]{64}$/u.test(hash)) {
      throw new StorageError("CORRUPT_DATA", "A blob reference contains an invalid hash.");
    }
    return path.join(this.#directory, `${hash}.gz`);
  }
}
