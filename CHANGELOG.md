# Changelog

## 0.0.1 - 2026-08-26

### Added

- Comment on unchanged lines outside displayed hunks for text files already
  included in a review diff, with exact immutable full-file anchors across
  refreshes.
- Append new direct descendant changes through `@` to an active review without
  replacing its comment and snapshot history.
- Select a historical contiguous range through searchable newest and oldest
  change pickers, or enter an advanced jj revset and preview its resolved
  changes before capture.
- Review `@` and its recent jj ancestors as a combined stack or as individual
  changes.
- View native diffs for added, modified, deleted, renamed, copied, binary, and
  symbolic-link files.
- Add line and file comments, refresh after rewrites, keep unmatched comments
  as outdated, and archive or restore reviews.
- Let GitHub Copilot CLI read, reply to, and resolve comments through a native
  per-user MCP bridge.
- Register every eligible workspace with one local bridge over a Unix-domain
  socket or Windows named pipe, with one global stdio MCP configuration.
- Discover registered open workspaces through the read-only `list_workspaces`
  MCP tool before binding a client session.
- Store immutable snapshots and comments in local VS Code extension storage.

### Limitations

- Requires VS Code 1.96 or newer, jj 0.44 or newer, and one trusted local jj
  repository per window.
- Supports only contiguous, single-parent stacks. The default range browser
  shows up to 200 ancestors of `@`; other selections require a revset. Merges
  and unresolved selected conflicts are rejected.
- Deleted lines cannot receive line comments. Use a file comment instead.
- The MCP bridge relies on per-user operating-system IPC permissions and has no
  application token. Do not use it in an untrusted shared-user environment.
- There is no cloud synchronization, shared review server, Marketplace release,
  or bridge forwarding between local and remote extension hosts.
- Windows received full release verification. Linux, macOS, WSL, SSH, Dev
  Container, and Tunnel extension hosts remain manual platform-validation gaps.

### Fixed

- Prevent host-injected Copilot CLI arguments from reaching the fixed native
  bridge command and breaking MCP initialization.
