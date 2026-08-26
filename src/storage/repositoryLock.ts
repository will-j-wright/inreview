import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { StorageError, errorMessage } from "../domain/errors";

const lockDataSchema = z
  .object({
    version: z.literal(2),
    pid: z.number().int().positive(),
    hostname: z.string().min(1),
    nonce: z.uuid(),
    acquiredAt: z.iso.datetime({ offset: true }),
    heartbeatAt: z.iso.datetime({ offset: true }),
    processIdentity: z.string().min(1).nullable(),
  })
  .strict();

const legacyLockDataSchema = z
  .object({
    version: z.literal(1),
    pid: z.number().int().positive(),
    hostname: z.string().min(1),
    nonce: z.uuid(),
    acquiredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

type LockData = z.infer<typeof lockDataSchema>;

export interface RepositoryLockOptions {
  readonly staleMalformedLockMilliseconds?: number;
  readonly leaseMilliseconds?: number;
  readonly heartbeatIntervalMilliseconds?: number;
  readonly processIsAlive?: (pid: number) => boolean;
  readonly processIdentity?: (
    pid: number,
  ) => string | undefined | Promise<string | undefined>;
  readonly hostname?: string;
  readonly pid?: number;
  readonly now?: () => Date;
}

export interface RepositoryLockStatus {
  readonly state: "held" | "ownership-lost" | "released";
  readonly pid: number;
  readonly hostname: string;
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
  readonly lastError?: StorageError;
}

const DEFAULT_LEASE_MILLISECONDS = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL_MILLISECONDS = 5_000;

function defaultProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class RepositoryLock {
  readonly #lockPath: string;
  readonly #now: () => Date;
  #data: LockData;
  #released = false;
  #heartbeatTimer: NodeJS.Timeout | undefined;
  #heartbeatTail: Promise<void> = Promise.resolve();
  #heartbeatError: StorageError | undefined;

  private constructor(
    lockPath: string,
    data: LockData,
    now: () => Date,
    heartbeatIntervalMilliseconds: number,
  ) {
    this.#lockPath = lockPath;
    this.#data = data;
    this.#now = now;
    if (heartbeatIntervalMilliseconds > 0) {
      this.#heartbeatTimer = setInterval(() => {
        this.#heartbeatTail = this.#heartbeatTail
          .then(async () => this.refreshLease())
          .catch((error: unknown) => {
            this.#heartbeatError =
              error instanceof StorageError
                ? error
                : new StorageError(
                    "IO_ERROR",
                    `Could not refresh the review-store lock: ${errorMessage(error)}`,
                    { cause: error, path: this.#lockPath },
                  );
          });
      }, heartbeatIntervalMilliseconds);
      this.#heartbeatTimer.unref();
    }
  }

  public static async acquire(
    repositoryStorageDirectory: string,
    options: RepositoryLockOptions = {},
  ): Promise<RepositoryLock> {
    validateDurations(options);
    await mkdir(repositoryStorageDirectory, { recursive: true });
    const lockPath = path.join(repositoryStorageDirectory, "writer.lock");
    const currentHostname = options.hostname ?? hostname();
    const currentPid = options.pid ?? process.pid;
    const now = options.now ?? (() => new Date());
    const identity = await options.processIdentity?.(currentPid);
    const acquiredAt = now().toISOString();
    const data: LockData = {
      version: 2,
      pid: currentPid,
      hostname: currentHostname,
      nonce: randomUUID(),
      acquiredAt,
      heartbeatAt: acquiredAt,
      processIdentity: identity ?? null,
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      let handle;
      try {
        handle = await open(lockPath, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new StorageError(
            "IO_ERROR",
            `Could not acquire the review-store lock: ${errorMessage(error)}`,
            { cause: error, path: lockPath },
          );
        }
      }

      if (handle !== undefined) {
        try {
          await handle.writeFile(serializeLock(data), "utf8");
          await handle.sync();
          await handle.close();
          return new RepositoryLock(
            lockPath,
            data,
            now,
            options.heartbeatIntervalMilliseconds ??
              DEFAULT_HEARTBEAT_INTERVAL_MILLISECONDS,
          );
        } catch (error) {
          await handle.close().catch(() => undefined);
          await rm(lockPath, { force: true }).catch(() => undefined);
          throw new StorageError(
            "IO_ERROR",
            `Could not write the review-store lock: ${errorMessage(error)}`,
            { cause: error, path: lockPath },
          );
        }
      }

      const recovered = await this.recoverIfStale(lockPath, {
        ...options,
        hostname: currentHostname,
        now,
      });
      if (!recovered) {
        throw new StorageError(
          "LOCK_HELD",
          "Another live InReview extension host holds the repository review-store lock.",
          { path: lockPath },
        );
      }
    }

    throw new StorageError(
      "LOCK_HELD",
      "The repository review-store lock changed repeatedly. Try again.",
      { path: lockPath },
    );
  }

  private static async recoverIfStale(
    lockPath: string,
    options: RepositoryLockOptions & {
      readonly hostname: string;
      readonly now: () => Date;
    },
  ): Promise<boolean> {
    let raw: string;
    try {
      raw = await readFile(lockPath, "utf8");
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }

    const existing = parseLock(raw);
    if (existing !== undefined) {
      if (existing.hostname !== options.hostname) {
        return false;
      }
      const age = options.now().getTime() - Date.parse(existing.heartbeatAt);
      const lease = options.leaseMilliseconds ?? DEFAULT_LEASE_MILLISECONDS;
      const processIsAlive = options.processIsAlive ?? defaultProcessIsAlive;
      const alive = processIsAlive(existing.pid);
      let identityMatches = true;
      if (alive && options.processIdentity !== undefined) {
        const currentIdentity = await options.processIdentity(existing.pid);
        identityMatches =
          existing.processIdentity === null ||
          currentIdentity === existing.processIdentity;
      }
      if (alive && identityMatches && age <= lease) {
        return false;
      }
    } else {
      let lockStat;
      try {
        lockStat = await stat(lockPath);
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT";
      }
      const staleAfter =
        options.staleMalformedLockMilliseconds ?? 24 * 60 * 60 * 1_000;
      if (options.now().getTime() - lockStat.mtimeMs < staleAfter) {
        return false;
      }
    }

    const quarantinePath = `${lockPath}.stale-${randomUUID()}`;
    try {
      await rename(lockPath, quarantinePath);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
    await rm(quarantinePath, { force: true });
    return true;
  }

  public getStatus(): RepositoryLockStatus {
    return {
      state: this.#released
        ? "released"
        : this.#heartbeatError === undefined
          ? "held"
          : "ownership-lost",
      pid: this.#data.pid,
      hostname: this.#data.hostname,
      acquiredAt: this.#data.acquiredAt,
      heartbeatAt: this.#data.heartbeatAt,
      ...(this.#heartbeatError === undefined
        ? {}
        : { lastError: this.#heartbeatError }),
    };
  }

  public async refreshLease(): Promise<void> {
    if (this.#released) {
      throw new StorageError("LOCK_NOT_OWNED", "The review-store lock was released.", {
        path: this.#lockPath,
      });
    }
    let handle;
    try {
      handle = await open(this.#lockPath, "r+");
      const raw = await handle.readFile("utf8");
      const current = parseLock(raw);
      if (current?.nonce !== this.#data.nonce) {
        throw new StorageError(
          "LOCK_NOT_OWNED",
          "The review-store lock is owned by another writer.",
          { path: this.#lockPath },
        );
      }
      this.#data = {
        ...this.#data,
        heartbeatAt: this.#now().toISOString(),
      };
      await handle.truncate(0);
      await handle.write(serializeLock(this.#data), 0, "utf8");
      await handle.sync();
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError(
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "LOCK_NOT_OWNED"
          : "IO_ERROR",
        `Could not refresh the review-store lock: ${errorMessage(error)}`,
        { cause: error, path: this.#lockPath },
      );
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  public async release(): Promise<void> {
    if (this.#released) {
      return;
    }
    if (this.#heartbeatTimer !== undefined) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }
    await this.#heartbeatTail;

    let raw: string;
    try {
      raw = await readFile(this.#lockPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new StorageError("LOCK_NOT_OWNED", "The review-store lock no longer exists.", {
          cause: error,
          path: this.#lockPath,
        });
      }
      throw error;
    }

    if (parseLock(raw)?.nonce !== this.#data.nonce) {
      throw new StorageError(
        "LOCK_NOT_OWNED",
        "The review-store lock is owned by another writer and was not removed.",
        { path: this.#lockPath },
      );
    }

    await rm(this.#lockPath);
    this.#released = true;
  }
}

function parseLock(raw: string): LockData | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    const current = lockDataSchema.safeParse(value);
    if (current.success) {
      return current.data;
    }
    const legacy = legacyLockDataSchema.safeParse(value);
    if (legacy.success) {
      return {
        ...legacy.data,
        version: 2,
        heartbeatAt: legacy.data.acquiredAt,
        processIdentity: null,
      };
    }
  } catch {
    // A malformed lock is handled by its file age.
  }
  return undefined;
}

function serializeLock(data: LockData): string {
  return `${JSON.stringify(data)}\n`;
}

function validateDurations(options: RepositoryLockOptions): void {
  for (const [name, value] of [
    ["leaseMilliseconds", options.leaseMilliseconds],
    ["heartbeatIntervalMilliseconds", options.heartbeatIntervalMilliseconds],
    ["staleMalformedLockMilliseconds", options.staleMalformedLockMilliseconds],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new RangeError(`${name} must be a non-negative finite number.`);
    }
  }
}
