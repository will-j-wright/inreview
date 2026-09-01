# AGENTS.md

## Project

InReview is a workspace VS Code extension that reviews local jj change stacks. It captures immutable diff snapshots, stores review comments locally, and connects GitHub Copilot CLI through a narrow native per-user MCP bridge.

Read `README.md` and the relevant production modules before changing behavior.
Keep compatibility with jj 0.44 and newer. Do not require a newer jj release
without a documented product decision and compatibility tests.

## Version control

- Use Jujutsu for all version-control operations in this repository.
- Do not use `git commit`, `git checkout`, `git reset`, or other Git worktree commands.
- The repository uses a colocated Git backend so jj can push to GitHub.
- Inspect changes with `jj status`, `jj diff`, and `jj log`.
- Describe work with `jj describe`; create a new change with `jj new`.
- Do not rewrite or discard user changes.

## Architecture

| Area | Responsibility |
| --- | --- |
| `src/domain` | Runtime-validated persisted review, snapshot, thread, and message schemas. |
| `src/storage` | Repository-scoped locks, atomic JSON manifests, migrations, blob storage, retention, and garbage collection. |
| `src/jj` | Shell-free jj execution, coherent operation reads, stack selection, and snapshot capture. |
| `src/diff` | Byte-preserving Git patch parsing and file classification. |
| `src/review` | Review lifecycle, mutation serialization, exact comment projection, and comment operations. |
| `src/vscode` | Trees, commands, virtual documents, native diffs, and Comments API adapters. |
| `src/bridge` | Native bridge installation, extension IPC, workspace registration, and lifecycle. |
| `src/mcp` | Review tool handlers, schemas, session binding, and Copilot CLI setup. |
| `bridge` | Native Rust daemon, workspace router, bounded IPC, and MCP stdio frontend. |

Keep domain, storage, jj, and review services independent of `vscode`. Put VS Code API calls in `src/vscode` or the extension composition root.

## Required invariants

- Capture all metadata, patches, and file contents from one coherent jj operation.
- Track selected work by full stable change IDs. Refresh must not follow a new child at `@`.
- Reject merges, divergent selections, non-contiguous stacks, and unresolved selected conflicts.
- Treat snapshots and original comment anchors as immutable.
- Publish snapshot blobs and manifests under one store transaction. Never expose a record that references missing blobs.
- Serialize writes per repository. Nested mutation acquisition must fail rather than deadlock.
- Keep jj process execution bounded. The default executor limit is four
  concurrent processes. Snapshot work must use the existing bounded helpers.
- Keep MCP runtime lifecycle operations serialized. Do not bypass the review
  store's in-process write queue or cross-process repository lease.
- Keep only exact, unique comment projections current. Ambiguous or missing targets become outdated.
- Allow line comments on any stored original-side or modified-side line of a
  changed text file. Anchor and project each line on its recorded side.
- Keep Agent messages immutable. Batch resolution must validate every thread before changing any thread.
- Keep archived reviews read-only until restored.
- Do not add fuzzy comment matching without an explicit product decision.

## MCP bridge constraints

- Ship a native Rust executable. End users must not need Node.js, Rust, or another bridge runtime.
- Build platform-specific VSIX packages that contain only the matching bridge binary.
- Install a versioned binary and stable launcher under extension global storage, never in the repository.
- Run one daemon per user and extension-host environment. Use a Unix-domain socket on Unix-like hosts and a named pipe on Windows. Do not open a TCP port or forward IPC between hosts.
- Restrict the IPC endpoint to the current user. Keep the bridge tokenless unless an explicit product decision changes the security model.
- Register only eligible trusted workspaces. Reject duplicate live registrations for the same canonical workspace.
- Keep IPC messages runtime-validated, bounded, timed out, and free of file contents, comment bodies in logs, storage paths, stack traces, and secrets.
- Keep MCP client sessions isolated. Bind each session to one live extension registration and make it stale when that registration disconnects or the active review changes.
- Keep bridge and extension lifecycle operations serialized, reconnect with bounded backoff, and reject incompatible protocol versions.
- Expose only these tools: `list_workspaces`, `connect_workspace`, `read_review_metadata`, `read_comments`, `reply_comment`, and `close_comments`.
- Do not expose arbitrary file reads, file writes, shell execution, jj mutation, review refresh, or comment deletion through MCP.
- Never return file contents, storage paths, stack traces, or secrets in MCP errors.

## VS Code constraints

- Use stable public VS Code APIs. Do not depend on proposed APIs.
- Use the native per-file `vscode.diff` editor and immutable signed virtual-document URIs.
- Commands that consume `CommentReply` belong in `comments/commentThread/context`, not the thread title toolbar.
- Keep test-only extension APIs unavailable in production mode.
- Stay inert in untrusted workspaces.
- Support one repository per window. Handle unrelated non-jj workspace folders without masking executable errors.

## Storage and privacy

- Review state belongs under `ExtensionContext.globalStorageUri`, never in the user's repository.
- Do not add telemetry.
- Never log comment bodies, file contents, request bodies, or complete local storage paths.
- Keep the VSIX allowlist exact: `package.json`, `README.md`, `CHANGELOG.md`,
  `dist/extension.js`, the matching `dist/bridge/inreview-bridge` executable,
  and `media/inreview.svg`.
- Keep `.git`, `.jj`, `AGENTS.md`, source, tests, source maps, lockfiles,
  `.test-work`, `.verification`, local paths, temporary review data, and
  generated VSIX files out of the packaged extension.
- Preserve the archive-retention and blob-GC invariants when changing schemas.
- Add a schema migration for every incompatible persisted-data change.

## Development workflow

Install dependencies:

```powershell
npm ci
```

Building and packaging also requires Rust 1.88 or newer. End users do not need
Rust because each platform-specific VSIX includes the compiled bridge.

Use focused checks while editing:

```powershell
npx eslint <changed-files>
npx vitest run <focused-test-files>
```

Before handing off a complete change:

```powershell
npm run check
npm run test:integration
```

Before distributing:

```powershell
npm run package:vsix
```

Do not run shared full-suite or VS Code host tests concurrently with another agent that is editing the same worktree. These tests share build outputs and temporary jj roots. Give concurrent agents disjoint file ownership and let one integration owner run the final suite.

## Testing expectations

- Add regression tests for every bug fix.
- Use real temporary jj repositories for command and snapshot semantics.
- Use fakes for deterministic storage failures, clocks, UUIDs, process errors, and MCP sessions.
- Cover Windows path behavior and keep code portable across local, WSL, SSH, Dev Container, and Tunnel extension hosts.
- Test both success and failure atomicity. A failure must not publish partial state or report success.
- Inspect the VSIX file list after packaging.

## Code style

- Use strict TypeScript and existing Zod schemas.
- Do not weaken compiler options.
- Avoid `any`, unsafe double casts, broad catches, and silent fallbacks.
- Spawn jj directly with argument arrays and `shell: false`.
- Keep errors typed and map them once at the UI or protocol boundary.
- Prefer small interfaces and dependency injection for clocks, UUIDs, processes, storage, and VS Code adapters.
- Add comments only when code cannot explain an important invariant itself.
