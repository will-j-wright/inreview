export interface CommandDefinition {
  readonly id: `inreview.${string}`;
  readonly title: string;
}

export const commandDefinitions = [
  { id: "inreview.startReview", title: "Start Review" },
  { id: "inreview.refreshReview", title: "Refresh Review" },
  { id: "inreview.archiveReview", title: "Archive Review" },
  { id: "inreview.restoreArchivedReview", title: "Restore Archived Review" },
  { id: "inreview.renameReview", title: "Rename Review" },
  { id: "inreview.deleteArchivedReview", title: "Delete Archived Review" },
  { id: "inreview.showCombinedDiff", title: "Show Combined Diff" },
  { id: "inreview.showPerChangeDiffs", title: "Show Per-Change Diffs" },
  { id: "inreview.addFileComment", title: "Add File Comment" },
  { id: "inreview.resolveComment", title: "Resolve Comment" },
  { id: "inreview.reopenComment", title: "Reopen Comment" },
  {
    id: "inreview.copyCopilotCliMcpSetup",
    title: "Copy Copilot CLI MCP Setup",
  },
  { id: "inreview.showMcpServerStatus", title: "Show MCP Server Status" },
] as const satisfies readonly CommandDefinition[];
