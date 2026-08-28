# InReview

InReview is a VS Code extension for reviewing local [Jujutsu (`jj`)](https://jj-vcs.github.io/jj/latest/) changes without opening a pull request.

Select a contiguous range of jj changes, inspect their combined or per-change
diffs in VS Code, and leave comments on the new side of the diff. A native
local MCP bridge lets GitHub Copilot CLI read those comments, reply to them,
and resolve them after it updates the code.

> InReview is an experimental local build. It is not published to the VS Code Marketplace.

## Features

- Review a historical contiguous change range, a revset, or the latest `X`
  changes ending at `@`.
- Switch between one combined stack diff and per-change diffs.
- Use VS Code's native diff editor, syntax highlighting, themes, and Comments API.
- Add comments to any line on the stored new side of a changed text file, or
  to the whole file.
- Review added, modified, deleted, renamed, copied, binary, and symbolic-link entries.
- Refresh a review after jj rewrites while keeping exact comment history.
- Keep unmatched comments as outdated threads linked to their original snapshot.
- Archive and restore local reviews.
- Connect GitHub Copilot CLI once through a native per-user MCP bridge.

## Requirements

- VS Code 1.96 or newer.
- `jj` 0.44 or newer available to the VS Code extension host.
- A trusted file-system workspace containing one jj repository.
- GitHub Copilot CLI if you want agent review support.

The packaged extension includes the native bridge executable. End users do not
need Node.js, Rust, or another bridge runtime.

Local and remote extension hosts are supported when the matching native VSIX
can run there. This includes WSL, SSH, Dev Containers, and VS Code Tunnels. Run
GitHub Copilot CLI in the same extension-host environment as InReview. The
bridge does not forward IPC between hosts.

If VS Code cannot find `jj`, restart every VS Code window after changing `PATH`, or set **InReview: Jj Path** to the absolute executable path.

## Install the local VSIX

Build and install:

```powershell
npm ci
npm run package:vsix
code --install-extension .\inreview-<target>-0.0.1.vsix --force
```

Building a VSIX requires Rust 1.88 or newer. `<target>` is the current native
platform, such as `linux-x64`, `darwin-arm64`, or `win32-x64`.

Reload VS Code after installation.

### Known issue: Node URL deprecation warning

VS Code 1.135 can print a Node `DEP0169` warning about `url.parse()` after it
successfully installs any local VSIX. A deprecation trace points to the gallery
metadata request in VS Code's `cliProcessMain.js`; the same trace occurs with a
minimal extension in isolated user-data and extension directories. Test startup
can also report the warning as `[AgentHost:stderr]` immediately after VS Code's
built-in Agent Host starts. InReview's source and production bundle do not call
the deprecated API. Microsoft owns the upstream fix in
[microsoft/vscode#301941](https://github.com/microsoft/vscode/issues/301941);
[the matching VSIX report](https://github.com/microsoft/vscode/issues/326998)
was closed as a duplicate.

## Review changes

1. Open one trusted jj repository in VS Code.
2. Open the **InReview** Activity Bar view.
3. Run **InReview: Start Review**.
4. Choose **Choose Range**, **Current Stack (Last X)**, or
   **Advanced: Enter jj Revset**.
5. For a range, select the newest included change and then the oldest included
   change. Use **Load older changes** to extend the history window.
6. Confirm the ordered selection preview.
7. Select a file under **Active Review** to open its native diff.
8. Use the comment gutter on an added or unchanged new-side line, or use **Add File Comment**.
9. After a selected change is rewritten, run **InReview: Refresh Review**.

InReview stores immutable snapshots. A thread remains inline only when its complete target and context map exactly and uniquely to the refreshed diff. Otherwise, it becomes **Outdated** and stays available from the Comments view.

**Last X** means `@` plus up to `X - 1` direct ancestors. The selection is a
contiguous, single-parent stack. It stops before the jj root change, so a
request can contain fewer than `X` changes. InReview rejects merges,
divergent changes, and unresolved conflicts in the selected stack. Refresh
follows the original stable change IDs after rewrites; it does not add a new
child that later becomes `@`.

**Choose Range** browses up to 200 ancestors of `@` in pages of 50. The newest
and oldest selected changes are both included. InReview rejects a range that
crosses a merge, contains a divergent change or unresolved conflict, or does
not form one contiguous parent chain.

**Advanced jj Revset** accepts any revset that resolves to 1–200 changes in one
contiguous, single-parent chain. InReview previews the resolved changes and
stores their full stable change IDs. It does not save or re-evaluate the
original revset during refresh.

Line comments are available on any line of the stored new-side content for a
text file included in the diff. Expand an unchanged section in the native diff
to comment outside a displayed hunk. Deleted lines remain visible but are not
commentable. Deleted files can receive file comments. A refresh keeps a thread
current only when its full target and context have one exact match. Hunk
comments and full-file comments use separate exact anchors; InReview does not
fall back to fuzzy matching. All other threads become **Outdated** and remain
linked to their immutable original snapshot. User comments can be edited or
deleted. Agent replies are immutable. Resolved threads can be reopened.

## Connect GitHub Copilot CLI

The extension installs its packaged native bridge in stable extension storage.
One per-user bridge daemon serves every eligible InReview window in the same
extension-host environment. Each trusted window registers its canonical
workspace over a user-restricted Unix-domain socket or Windows named pipe.
InReview does not open a TCP port.

The bridge starts automatically when a trusted window contains one supported
jj repository and `inreview.mcp.enabled` is on. Opening an InReview view or
running a command is not required.

1. Run **InReview: Copy InReview MCP Setup**.
2. Select either the `copilot mcp add` command or the `mcp-config.json` fragment.
3. Paste the result into GitHub Copilot CLI once in the same extension-host environment.
4. Use `/mcp show` to confirm the server connection.

The copied command has this shape:

```text
copilot mcp add --tools "list_workspaces,connect_workspace,read_review_metadata,read_comments,reply_comment,close_comments" inreview -- "<native-launcher>"
```

The `inreview` entry discovers every workspace registered in that environment.
You do not need one MCP entry per repository. Ask the agent to list the open
workspaces, connect to one returned absolute root, and review its open comments.

### MCP tools

| Tool | Purpose |
| --- | --- |
| `list_workspaces` | List canonical roots and host platforms registered with the bridge. |
| `connect_workspace` | Bind the MCP session to the exact workspace root and active review. |
| `read_review_metadata` | Read selected changes, snapshots, file metadata, and comment counts. |
| `read_comments` | Read filtered current, outdated, open, or resolved threads. |
| `reply_comment` | Reply to one open thread as `Agent` without resolving it. |
| `close_comments` | Atomically resolve one or more open threads with optional resolution notes. |

The bridge uses no bearer token. It restricts its socket or named pipe to the
current user, validates bounded messages, isolates MCP sessions, and exposes
only the six tools above. The bridge routes operations to the registered
extension process; it cannot read arbitrary files, run shell commands, or run
jj. Do not use it in an untrusted shared-user environment.

## Commands

Use the Command Palette or the matching view and comment actions.

| Command | Purpose |
| --- | --- |
| **InReview: Start Review** | Select and capture a range, revset, or latest change stack. |
| **InReview: Refresh Review** | Capture rewritten versions of the same stable change IDs. |
| **InReview: Archive Review** | Make the active review read-only and move it to history. |
| **InReview: Restore Archived Review** | Restore an archived review as the active review. |
| **InReview: Rename Review** | Change the active review title. |
| **InReview: Delete Archived Review** | Permanently remove one archived review. |
| **InReview: Show Combined Diff** | Compare the parent of the oldest change with the stack head. |
| **InReview: Show Per-Change Diffs** | Show each selected change against its direct parent. |
| **InReview: Add File Comment** | Add a comment that applies to the whole file. |
| **InReview: Resolve Comment** / **Reopen Comment** | Change a thread's resolution state. |
| **InReview: Submit/Edit/Save/Cancel/Delete Comment** | Manage user comments through VS Code's Comments UI. |
| **InReview: Copy InReview MCP Setup** | Copy the one-time native stdio command or JSON MCP configuration. |
| **InReview: Show MCP Bridge Status** | Show the native bridge installation and workspace registration state. |

## Views

- **Active Review** shows the selected changes, current snapshot, display mode, and changed files.
- **Comments** groups open current, open outdated, and resolved threads.
- **History** shows the latest 20 archived reviews.

Review data is stored under VS Code's extension global storage. It includes
immutable file snapshots, review metadata, and comments. It is never written
into the repository. InReview uses compressed content-addressed blobs,
serializes writes per repository, retains the latest 20 archived reviews, and
garbage-collects unreferenced blobs. It sends no telemetry and makes no network
requests. MCP traffic stays on a local per-user socket or named pipe.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `inreview.jj.path` | `jj` | Command name or absolute path for the jj executable. |
| `inreview.review.defaultChangeCount` | `1` | Initial value for the **Current Stack (Last X)** prompt. |
| `inreview.review.largeDiffWarningLines` | `10000` | Changed-line count that requires confirmation. |
| `inreview.mcp.enabled` | `true` | Register an eligible trusted workspace with the native MCP bridge. |
| `inreview.logging.level` | `info` | Output-channel logging threshold. |

## Current limitations

- One jj repository per VS Code window.
- Reviews must contain one contiguous, single-parent change stack.
- Merge changes and unresolved conflicts are rejected.
- No comments on deleted lines or unchanged files outside the selected diff.
- Native per-file diffs rather than VS Code's proposed multi-file diff API.
- No bridge forwarding between local and remote extension hosts.
- No cloud synchronization or shared review server.
- The bridge has no application token. Its local IPC endpoint relies on the
  current user's operating-system access controls.
- Linux, macOS, WSL, SSH, Dev Container, and Tunnel extension hosts are
  supported targets but were not all manually exercised for the 0.0.1 release.

## Development

```powershell
npm ci
npm run typecheck
npm run lint
npm run test:unit
npm run test:integration
npm run build:production
npm run validate:package
npm run package:vsix
```

`npm run check` runs type checking, linting, unit and jj integration tests, the production bundle, and package validation.

The extension uses stable public VS Code APIs. It does not enable proposed APIs.
Package validation enforces an exact VSIX allowlist: the manifest, README,
changelog, production bundle, and icon.

The main source areas are:

```text
src/domain/   Persisted review and comment models
src/storage/  Atomic manifests, locks, and content-addressed blobs
src/jj/       Safe jj process adapter and snapshot capture
src/diff/     Git patch parsing and file classification
src/review/   Review lifecycle and comment services
src/vscode/   Views, native virtual diffs, and Comments API integration
src/mcp/      Streamable HTTP transport, tools, and Copilot setup
```
