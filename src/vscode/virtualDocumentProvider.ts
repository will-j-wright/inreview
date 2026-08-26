import { createHmac, timingSafeEqual } from "node:crypto";

import type * as vscode from "vscode";

import type { ViewIdentity } from "../domain/review";

export const ORIGINAL_DOCUMENT_SCHEME = "inreview-original";
export const MODIFIED_DOCUMENT_SCHEME = "inreview-modified";

export type NativeDiffSide = "original" | "modified";

export interface VirtualDocumentIdentity {
  readonly reviewId: string;
  readonly snapshotId: string;
  readonly view: ViewIdentity;
  readonly fileId: string;
  readonly side: NativeDiffSide;
  readonly repositoryPath: string;
  readonly readOnly: boolean;
}

export interface UriFactory {
  from(components: {
    readonly scheme: string;
    readonly authority: string;
    readonly path: string;
  }): vscode.Uri;
}

export interface VirtualDocumentSource {
  readDocument(identity: VirtualDocumentIdentity): Promise<string>;
}

export class InvalidVirtualDocumentUriError extends Error {
  public constructor(message = "The InReview document URI is invalid or has been changed.") {
    super(message);
    this.name = "InvalidVirtualDocumentUriError";
  }
}

interface EncodedIdentityBase {
  readonly v: 2;
  readonly r: string;
  readonly s: string;
  readonly f: string;
  readonly d: NativeDiffSide;
  readonly o: boolean;
}

type EncodedIdentity =
  | (EncodedIdentityBase & {
      readonly m: "combined";
    })
  | (EncodedIdentityBase & {
      readonly m: "per-change";
      readonly c: string;
    });

export class VirtualDocumentUriCodec {
  readonly #key: Buffer;
  readonly #uriFactory: UriFactory;

  public constructor(signingKey: string | Uint8Array, uriFactory: UriFactory) {
    if (
      (typeof signingKey === "string" && signingKey.length === 0) ||
      (typeof signingKey !== "string" && signingKey.byteLength === 0)
    ) {
      throw new TypeError("The virtual document URI signing key must not be empty.");
    }
    this.#key = Buffer.from(signingKey);
    this.#uriFactory = uriFactory;
  }

  public encode(identity: VirtualDocumentIdentity): vscode.Uri {
    validateIdentity(identity);
    const scheme = schemeForSide(identity.side);
    const encoded: EncodedIdentity =
      identity.view.mode === "combined"
        ? {
            v: 2,
            r: identity.reviewId,
            s: identity.snapshotId,
            m: "combined",
            f: identity.fileId,
            d: identity.side,
            o: identity.readOnly,
          }
        : {
            v: 2,
            r: identity.reviewId,
            s: identity.snapshotId,
            m: "per-change",
            c: identity.view.changeId,
            f: identity.fileId,
            d: identity.side,
            o: identity.readOnly,
          };
    // URI authorities are case-insensitive. Use lowercase hex so VS Code's
    // authority normalization cannot change the signed payload.
    const payload = Buffer.from(JSON.stringify(encoded), "utf8").toString("hex");
    const signature = this.sign(scheme, payload, identity.repositoryPath);
    return this.#uriFactory.from({
      scheme,
      authority: `v2.${payload}.${signature}`,
      path: `/${identity.repositoryPath}`,
    });
  }

  public decode(uri: vscode.Uri): VirtualDocumentIdentity {
    try {
      if (
        uri.query.length !== 0 ||
        uri.fragment.length !== 0 ||
        (uri.scheme !== ORIGINAL_DOCUMENT_SCHEME &&
          uri.scheme !== MODIFIED_DOCUMENT_SCHEME)
      ) {
        throw new InvalidVirtualDocumentUriError();
      }
      const parts = uri.authority.split(".");
      if (
        parts.length !== 3 ||
        parts[0] !== "v2" ||
        parts[1] === undefined ||
        parts[2] === undefined ||
        parts[1].length % 2 !== 0 ||
        !/^[a-f0-9]+$/u.test(parts[1]) ||
        !/^[a-f0-9]{64}$/u.test(parts[2])
      ) {
        throw new InvalidVirtualDocumentUriError();
      }
      const repositoryPath = uri.path.startsWith("/")
        ? uri.path.slice(1)
        : "";
      validateRepositoryPath(repositoryPath);
      const expected = this.sign(uri.scheme, parts[1], repositoryPath);
      const suppliedBytes = Buffer.from(parts[2], "hex");
      const expectedBytes = Buffer.from(expected, "hex");
      if (
        suppliedBytes.byteLength !== expectedBytes.byteLength ||
        !timingSafeEqual(suppliedBytes, expectedBytes)
      ) {
        throw new InvalidVirtualDocumentUriError();
      }
      const parsed = JSON.parse(
        Buffer.from(parts[1], "hex").toString("utf8"),
      ) as unknown;
      const encoded = parseEncodedIdentity(parsed);
      const side =
        uri.scheme === ORIGINAL_DOCUMENT_SCHEME ? "original" : "modified";
      if (encoded.d !== side) {
        throw new InvalidVirtualDocumentUriError();
      }
      const identity: VirtualDocumentIdentity = {
        reviewId: encoded.r,
        snapshotId: encoded.s,
        view:
          encoded.m === "combined"
            ? { mode: "combined" }
            : { mode: "per-change", changeId: encoded.c },
        fileId: encoded.f,
        side,
        repositoryPath,
        readOnly: encoded.o,
      };
      validateIdentity(identity);
      return identity;
    } catch (error) {
      if (error instanceof InvalidVirtualDocumentUriError) {
        throw error;
      }
      throw new InvalidVirtualDocumentUriError();
    }
  }

  private sign(scheme: string, payload: string, repositoryPath: string): string {
    return createHmac("sha256", this.#key)
      .update(`${scheme}\0${payload}\0${repositoryPath}`, "utf8")
      .digest("hex");
  }
}

export class ImmutableVirtualDocumentProvider
  implements vscode.TextDocumentContentProvider
{
  public constructor(
    private readonly codec: VirtualDocumentUriCodec,
    private readonly source: VirtualDocumentSource,
  ) {}

  public async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    return this.source.readDocument(this.codec.decode(uri));
  }
}

function parseEncodedIdentity(value: unknown): EncodedIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidVirtualDocumentUriError();
  }
  const record = value as Record<string, unknown>;
  const allowed =
    record.m === "per-change"
      ? ["v", "r", "s", "m", "c", "f", "d", "o"]
      : ["v", "r", "s", "m", "f", "d", "o"];
  if (
    Object.keys(record).length !== allowed.length ||
    Object.keys(record).some((key) => !allowed.includes(key)) ||
    record.v !== 2 ||
    typeof record.r !== "string" ||
    typeof record.s !== "string" ||
    typeof record.f !== "string" ||
    typeof record.o !== "boolean" ||
    (record.m !== "combined" && record.m !== "per-change") ||
    (record.m === "per-change" && typeof record.c !== "string")
  ) {
    throw new InvalidVirtualDocumentUriError();
  }
  const side = record.d;
  if (side !== "original" && side !== "modified") {
    throw new InvalidVirtualDocumentUriError();
  }
  if (record.m === "combined") {
    return {
      v: 2,
      r: record.r,
      s: record.s,
      m: "combined",
      f: record.f,
      d: side,
      o: record.o,
    };
  }
  const changeId = record.c;
  if (typeof changeId !== "string") {
    throw new InvalidVirtualDocumentUriError();
  }
  return {
    v: 2,
    r: record.r,
    s: record.s,
    m: "per-change",
    c: changeId,
    f: record.f,
    d: side,
    o: record.o,
  };
}

function validateIdentity(identity: VirtualDocumentIdentity): void {
  if (
    !isUuid(identity.reviewId) ||
    !isUuid(identity.snapshotId) ||
    typeof identity.readOnly !== "boolean" ||
    !isIdentifier(identity.fileId) ||
    (identity.view.mode === "per-change" &&
      !isIdentifier(identity.view.changeId))
  ) {
    throw new InvalidVirtualDocumentUriError();
  }
  validateRepositoryPath(identity.repositoryPath);
}

function validateRepositoryPath(value: string): void {
  const segments = value.split("/");
  if (
    value.length === 0 ||
    value.length > 32_768 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new InvalidVirtualDocumentUriError(
      "The InReview document URI contains an unsafe repository path.",
    );
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

function isIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !value.includes("\0");
}

function schemeForSide(side: NativeDiffSide): string {
  return side === "original"
    ? ORIGINAL_DOCUMENT_SCHEME
    : MODIFIED_DOCUMENT_SCHEME;
}
