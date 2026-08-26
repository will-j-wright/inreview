export type DomainErrorCode =
  | "INVALID_DOMAIN_DATA"
  | "INVARIANT_VIOLATION"
  | "NOT_FOUND"
  | "CONFLICT";

export class DomainError extends Error {
  public readonly code: DomainErrorCode;

  public constructor(code: DomainErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DomainError";
    this.code = code;
  }
}

export type StorageErrorCode =
  | "CORRUPT_DATA"
  | "HASH_MISMATCH"
  | "IO_ERROR"
  | "LOCK_HELD"
  | "LOCK_NOT_OWNED"
  | "NOT_FOUND"
  | "SCHEMA_TOO_NEW"
  | "MIGRATION_FAILED"
  | "CONFLICT";

export class StorageError extends Error {
  public readonly code: StorageErrorCode;
  public readonly path: string | undefined;

  public constructor(
    code: StorageErrorCode,
    message: string,
    options?: ErrorOptions & { readonly path?: string },
  ) {
    super(message, options);
    this.name = "StorageError";
    this.code = code;
    this.path = options?.path;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
