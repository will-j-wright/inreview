# Changelog

## 0.0.1 - 2026-08-26

### Added

- Review `@` and its recent jj ancestors as a combined stack or as individual
  changes.
- View native diffs for added, modified, deleted, renamed, copied, binary, and
  symbolic-link files.
- Add line and file comments, refresh after rewrites, keep unmatched comments
  as outdated, and archive or restore reviews.
- Let GitHub Copilot CLI read, reply to, and resolve comments through a
  tokenless loopback MCP server.
- Start MCP after VS Code startup on a deterministic per-repository port from
  `41000` to `48999`, with an explicit fixed-port override.
- Store immutable snapshots and comments in local VS Code extension storage.

### Limitations

- Requires VS Code 1.96 or newer, jj 0.44 or newer, and one trusted local jj
  repository per window.
- Supports only contiguous, single-parent stacks that end at `@`. Merges and
  unresolved selected conflicts are rejected.
- Deleted lines cannot receive line comments. Use a file comment instead.
- The MCP server has no authentication. Do not use it in an untrusted
  multi-user environment.
- There is no cloud synchronization, shared review server, Marketplace release,
  SSH workspace support, dev-container support, or cross-host WSL forwarding.
- Windows received full release verification. Linux, macOS, and WSL remain
  manual platform-validation gaps.
