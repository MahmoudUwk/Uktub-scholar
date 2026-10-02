# uktub-oa

Local-first scholarly research tools for coding agents. Pi package first; the core is
host-agnostic so later hosts (MCP servers for Claude Code / Codex) attach around the same
core.

Status: scaffold (U1). See `NOTICE.md` for provenance and attribution. Full documentation
lands with U8.

- Tools (Pi 1.0): `search_papers`, `register_papers`, `list_papers`
- CLI: `uktub-oa init | deregister | sync-bib | list`
- Storage: single SQLite file (`.registry/registry.db`) beside the LaTeX project, via `node:sqlite`
- Requirements: Node >= 22.19 (Pi 1.0 floor; see `engines`), Pi >= 1.0.0 for the extension
