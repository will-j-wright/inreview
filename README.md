# InReview

InReview is a VS Code extension for reviewing local [Jujutsu (`jj`)](https://jj-vcs.github.io/jj/latest/) changes without opening a pull request.

Select the latest `X` changes, inspect their combined or per-change diffs in VS Code, and leave comments on the new side of the diff. A local MCP server lets GitHub Copilot CLI read those comments, reply to them, and resolve them after it updates the code.

> InReview is an experimental local build. It is not published to the VS Code Marketplace.

## Features

- Review the working-copy change at `@` and up to `X - 1` contiguous ancestors.
- Switch between one combined stack diff and per-change diffs.
- Use VS Code's native diff editor, syntax highlighting, themes, and Comments API.
- Add comments to added lines, unchanged context lines, and whole files.
- Review added, modified, deleted, renamed, copied, binary, and symbolic-link entries.
- Refresh a review after jj rewrites while keeping exact comment history.
- Keep unmatched comments as outdated threads linked to their original snapshot.
- Archive and restore local reviews.
- Connect GitHub Copilot CLI through a loopback MCP server.

## Requirements

- VS Code 1.96 or newer.
- `jj` 0.44.x available to the VS Code extension host.
- A trusted local workspace containing one jj repository.
- GitHub Copilot CLI if you want agent review support.

Windows, Linux, macOS, and same-distribution VS Code WSL workspaces are the intended targets. Cross-host Windows-to-WSL connections are not supported.

If VS Code cannot find `jj`, restart every VS Code window after changing `PATH`, or set **InReview: Jj Path** to the absolute executable path.

## Install the local VSIX

Build and install:

```powershell
npm ci
npm run package:vsix
code --install-extension .\inreview-0.0.1.vsix --force
```

Reload VS Code after installation.

## Review changes

1. Open one trusted jj repository in VS Code.
2. Open the **InReview** Activity Bar view.
3. Run **InReview: Start Review**.
4. Enter the number of latest changes to include. The default is `1`.
5. Select a file under **Active Review** to open its native diff.
6. Use the comment gutter on an added or unchanged new-side line, or use **Add File Comment**.
7. After the change is rewritten, run **InReview: Refresh Review**.

InReview stores immutable snapshots. A thread remains inline only when its complete target and context map exactly and uniquely to the refreshed diff. Otherwise, it becomes **Outdated** and stays available from the Comments view.

Deleted lines are visible but are not commentable. Deleted files can receive file-level comments.

## Connect GitHub Copilot CLI

The MCP server starts automatically for an eligible trusted workspace.
By default, InReview derives a static port in the `41000`-`48999` range from
the repository and environment fingerprint. Thus, copied MCP configuration
stays valid across VS Code restarts. Set `inreview.mcp.port` to use a different
fixed port. If that port is in use, the server stays in an error state. Set an
available fixed port, then run **InReview: Copy Copilot CLI MCP Setup** again.

This deterministic endpoint is sufficient for v1, so InReview does not need a
persistent port assignment or a separate bridge process.

1. Run **InReview: Copy Copilot CLI MCP Setup**.
2. Select either the `copilot mcp add` command or the `mcp-config.json` fragment.
3. Paste the result into GitHub Copilot CLI in the same local or WSL environment.
4. Use `/mcp show` to confirm the server connection.

The copied command has this shape:

```text
copilot mcp add --transport http --tools "connect_workspace,read_review_metadata,read_comments,reply_comment,close_comments" <server-name> http://127.0.0.1:<port>/mcp
```

Then ask the agent to connect to the absolute workspace root and review the open comments.

### MCP tools

| Tool | Purpose |
| --- | --- |
| `connect_workspace` | Bind the MCP session to the exact workspace root and active review. |
| `read_review_metadata` | Read selected changes, snapshots, file metadata, and comment counts. |
| `read_comments` | Read filtered current, outdated, open, or resolved threads. |
| `reply_comment` | Reply to one open thread as `Agent` without resolving it. |
| `close_comments` | Atomically resolve one or more open threads with optional resolution notes. |

The server binds only to `127.0.0.1`. It has no bearer token. Strict Host and Origin validation, MCP session isolation, request limits, and a narrow tool surface remain enforced. Any local process can reach a loopback port, so do not use this server for untrusted multi-user environments.

## Views

- **Active Review** shows the selected changes, current snapshot, display mode, and changed files.
- **Comments** groups open current, open outdated, and resolved threads.
- **History** shows the latest 20 archived reviews.

Review data is stored in VS Code extension storage. It is not written into the repository. InReview uses compressed content-addressed blobs and sends no telemetry.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `inreview.jj.path` | `jj` | Command name or absolute path for the jj executable. |
| `inreview.review.defaultChangeCount` | `1` | Initial value for the Last `X` prompt. |
| `inreview.review.largeDiffWarningLines` | `10000` | Changed-line count that requires confirmation. |
| `inreview.mcp.enabled` | `true` | Start the local MCP server for an eligible workspace. |
| `inreview.mcp.port` | unset | Optional fixed loopback port override. The default is a deterministic repository port from `41000` to `48999`. |
| `inreview.logging.level` | `info` | Output-channel logging threshold. |

## Current limitations

- One jj repository per VS Code window.
- Only a contiguous, single-parent stack ending at `@`.
- Merge changes and unresolved conflicts are rejected.
- No comments on deleted lines.
- Native per-file diffs rather than VS Code's proposed multi-file diff API.
- No SSH workspaces, dev containers, or cross-host WSL forwarding.
- No cloud synchronization or shared review server.

## Development

```powershell
npm ci
npm run typecheck
npm run lint
npm run test:unit
npm run test:integration
npm run package:vsix
```

`npm run check` runs type checking, linting, unit and jj integration tests, the production bundle, and package validation.

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
