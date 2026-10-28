# 0.8.2 Release Notes

Version 0.8.2 keeps the 0.8 major/minor line and the existing application identifier and updater signing configuration.

## Product changes

- The Sources panel can queue every supported source that is not yet ingested, including failed and cancelled tasks. Active and successfully ingested sources are skipped. The action is disabled until an ingest model is configured.
- URL import returns a visible error for every submitted URL when the HTTP transport cannot initialize.

## Review and verification

- Code review confirmed the previous 0.8.1 import archive and page-refresh fixes remain in place. This release addresses a URL import failure path and reduces the per-file work needed to recover pending sources.
- Frontend mock suite: 206 test files and 2,802 tests passed.
- Focused source/recovery and localization checks: 4 test files and 25 tests passed.
- `npm run build:desktop` passed, including frontend type checking, production Vite build, and MCP TypeScript build.
- MCP server suite: 25 tests passed.
- The production build reports existing CSS highlight pseudo-element, large chunk, and ineffective dynamic-import warnings; none blocked the build.
