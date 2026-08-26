export type TreeState =
  | { readonly kind: "restricted"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "ready" };

export interface TreeCommand {
  readonly command: string;
  readonly title: string;
  readonly arguments?: readonly unknown[];
}

export interface ReviewTreeItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly tooltip?: string;
  readonly contextValue: string;
  readonly icon: string;
  readonly collapsible: "none" | "collapsed" | "expanded";
  readonly command?: TreeCommand;
  readonly children?: readonly ReviewTreeItem[];
}

export interface TreeChangeSubscription {
  dispose(): void;
}

export abstract class ReviewTreeSource {
  readonly #listeners = new Set<() => void>();

  public subscribe(listener: () => void): TreeChangeSubscription {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  }

  public refresh(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }

  public abstract getRoots(): Promise<readonly ReviewTreeItem[]>;

  public getChildren(
    item: ReviewTreeItem | undefined,
  ): Promise<readonly ReviewTreeItem[]> {
    return item === undefined
      ? this.getRoots()
      : Promise.resolve(item.children ?? []);
  }
}

export function stateItem(state: Exclude<TreeState, { kind: "ready" }>): ReviewTreeItem {
  return {
    id: `state:${state.kind}`,
    label: state.kind === "restricted" ? "Restricted Workspace" : "InReview Unavailable",
    description: state.message,
    tooltip: state.message,
    contextValue: `inreview.state.${state.kind}`,
    icon: state.kind === "restricted" ? "lock" : "warning",
    collapsible: "none",
  };
}
