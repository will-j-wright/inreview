import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

import { StorageError, errorMessage } from "../domain/errors";

export type StorageFaultPoint =
  | "before-blob-rename"
  | "before-manifest-rename"
  | "before-index-rename"
  | "before-directory-sync";

export type StorageFaultInjector = (point: StorageFaultPoint) => void | Promise<void>;

export class AtomicWriteError extends StorageError {
  public constructor(
    message: string,
    public readonly destinationReplaced: boolean,
    options: ErrorOptions & { readonly path: string },
  ) {
    super("IO_ERROR", message, options);
    this.name = "AtomicWriteError";
  }
}

const temporaryFilePattern = /^\.inreview-tmp-[0-9a-f-]{36}$/u;

export async function atomicWriteFile(
  destination: string,
  data: Uint8Array | string,
  faultPoint: StorageFaultPoint,
  faultInjector?: StorageFaultInjector,
): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporaryPath = path.join(path.dirname(destination), `.inreview-tmp-${randomUUID()}`);
  let handle;
  let destinationReplaced = false;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await faultInjector?.(faultPoint);
    await rename(temporaryPath, destination);
    destinationReplaced = true;
    await faultInjector?.("before-directory-sync");
    await syncParentDirectory(destination);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (error instanceof AtomicWriteError) {
      throw error;
    }
    throw new AtomicWriteError(
      `Could not atomically write "${destination}": ${errorMessage(error)}`,
      destinationReplaced,
      { cause: error, path: destination },
    );
  }
}

async function syncParentDirectory(destination: string): Promise<void> {
  let directoryHandle;
  try {
    directoryHandle = await open(path.dirname(destination), "r");
    await directoryHandle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      code === "ENOTSUP" ||
      code === "EOPNOTSUPP" ||
      code === "EBADF" ||
      code === "EINVAL" ||
      (process.platform === "win32" &&
        (code === "EACCES" ||
          code === "EISDIR" ||
          code === "EPERM"))
    ) {
      return;
    }
    throw error;
  } finally {
    await directoryHandle?.close().catch(() => undefined);
  }
}

export async function cleanupTemporaryFiles(directory: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return;
    }
    throw new StorageError("IO_ERROR", `Could not inspect "${directory}".`, {
      cause: error,
      path: directory,
    });
  }

  await Promise.all(
    entries
      .filter(
        (entry) => entry.isFile() && temporaryFilePattern.test(entry.name),
      )
      .map(async (entry) => {
        await rm(path.join(directory, entry.name), { force: true });
      }),
  );
}
