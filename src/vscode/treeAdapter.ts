import * as vscode from "vscode";

import type { ReviewTreeItem, ReviewTreeSource } from "./treeTypes";

export class VscodeTreeAdapter
  implements vscode.TreeDataProvider<ReviewTreeItem>, vscode.Disposable
{
  readonly #emitter = new vscode.EventEmitter<
    ReviewTreeItem | undefined | null
  >();
  readonly #subscription;
  public readonly onDidChangeTreeData = this.#emitter.event;

  public constructor(private readonly source: ReviewTreeSource) {
    this.#subscription = source.subscribe(() => {
      this.#emitter.fire(undefined);
    });
  }

  public getTreeItem(element: ReviewTreeItem): vscode.TreeItem {
    const item = new vscode.TreeItem(
      element.label,
      collapsibleState(element.collapsible),
    );
    item.id = element.id;
    if (element.description !== undefined) {
      item.description = element.description;
    }
    if (element.tooltip !== undefined) {
      item.tooltip = element.tooltip;
    }
    item.contextValue = element.contextValue;
    item.iconPath = new vscode.ThemeIcon(element.icon);
    if (element.command !== undefined) {
      item.command = {
        command: element.command.command,
        title: element.command.title,
        arguments: [...(element.command.arguments ?? [])],
      };
    }
    return item;
  }

  public getChildren(
    element?: ReviewTreeItem,
  ): vscode.ProviderResult<ReviewTreeItem[]> {
    return this.source
      .getChildren(element)
      .then((children) => [...children]);
  }

  public dispose(): void {
    this.#subscription.dispose();
    this.#emitter.dispose();
  }
}

function collapsibleState(
  value: ReviewTreeItem["collapsible"],
): vscode.TreeItemCollapsibleState {
  if (value === "expanded") {
    return vscode.TreeItemCollapsibleState.Expanded;
  }
  if (value === "collapsed") {
    return vscode.TreeItemCollapsibleState.Collapsed;
  }
  return vscode.TreeItemCollapsibleState.None;
}
