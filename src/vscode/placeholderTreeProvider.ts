import * as vscode from "vscode";

export class PlaceholderTreeProvider
  implements vscode.TreeDataProvider<vscode.TreeItem>
{
  public getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(): vscode.TreeItem[] {
    return [];
  }
}
