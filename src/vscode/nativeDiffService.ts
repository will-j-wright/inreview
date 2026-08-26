import type * as vscode from "vscode";

import type { RevealFileRequest } from "./activeReviewTree";
import {
  NativeDiffContent,
  type NativeDiffBlobReader,
  type NativeDiffReviewQuery,
} from "./nativeDiffContent";
import {
  ImmutableVirtualDocumentProvider,
  MODIFIED_DOCUMENT_SCHEME,
  ORIGINAL_DOCUMENT_SCHEME,
  VirtualDocumentUriCodec,
} from "./virtualDocumentProvider";

export interface NativeDiffVscodeApi {
  readonly Uri: {
    from(components: {
      readonly scheme: string;
      readonly authority: string;
      readonly path: string;
    }): vscode.Uri;
  };
  readonly workspace: {
    registerTextDocumentContentProvider(
      scheme: string,
      provider: vscode.TextDocumentContentProvider,
    ): vscode.Disposable;
  };
  readonly commands: {
    executeCommand(
      command: "vscode.diff",
      original: vscode.Uri,
      modified: vscode.Uri,
      title: string,
      options: { readonly preview: boolean },
    ): Thenable<unknown>;
  };
}

export interface NativeDiffServiceOptions {
  readonly reviews: NativeDiffReviewQuery;
  readonly blobs: NativeDiffBlobReader;
  readonly signingKey: string | Uint8Array;
  readonly vscode: NativeDiffVscodeApi;
}

export class NativeDiffService implements vscode.Disposable {
  readonly #content: NativeDiffContent;
  readonly #codec: VirtualDocumentUriCodec;
  readonly #vscode: NativeDiffVscodeApi;
  readonly #disposables: readonly vscode.Disposable[];
  #disposed = false;

  public constructor(options: NativeDiffServiceOptions) {
    this.#vscode = options.vscode;
    this.#content = new NativeDiffContent(options.reviews, options.blobs);
    this.#codec = new VirtualDocumentUriCodec(
      options.signingKey,
      options.vscode.Uri,
    );
    const provider = new ImmutableVirtualDocumentProvider(
      this.#codec,
      this.#content,
    );
    const disposables: vscode.Disposable[] = [];
    try {
      disposables.push(
        options.vscode.workspace.registerTextDocumentContentProvider(
          ORIGINAL_DOCUMENT_SCHEME,
          provider,
        ),
        options.vscode.workspace.registerTextDocumentContentProvider(
          MODIFIED_DOCUMENT_SCHEME,
          provider,
        ),
      );
    } catch (error) {
      for (const disposable of disposables.reverse()) {
        disposable.dispose();
      }
      throw error;
    }
    this.#disposables = disposables;
  }

  public async revealFile(request: RevealFileRequest): Promise<void> {
    if (this.#disposed) {
      throw new Error("The InReview native diff service is closed.");
    }
    const resolved = await this.#content.resolve(request);
    await this.#vscode.commands.executeCommand(
      "vscode.diff",
      this.#codec.encode(resolved.original),
      this.#codec.encode(resolved.modified),
      resolved.title,
      { preview: false },
    );
  }

  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    for (const disposable of [...this.#disposables].reverse()) {
      disposable.dispose();
    }
  }
}
