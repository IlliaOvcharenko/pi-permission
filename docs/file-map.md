# Repository file map

## Root

| Path | Responsibility |
| --- | --- |
| `README.md` | Detailed project reference: mode matrix, configuration, containment limits and migration. |
| `docs/` | Short persistent navigation, architecture, usage and ownership map for maintainers. |
| `AGENTS.md` | Agent navigation and documentation-maintenance instructions. |
| `defaults.json` | Shipped mode policies, permission groups, sandbox defaults and prompt prose. |
| `config.example.json` | Non-live example of a user overlay. |
| `config.schema.json` | Editor schema for the user overlay; runtime validation lives in `src/config.ts`. |
| `package.json` | Pi extension entry (`src/index.ts`), Node requirement, dependencies and scripts. |
| `package-lock.json` | Locked npm dependency graph. |
| `tsconfig.json` | TypeScript checking of source and tests. |
| `LICENSE`, `THIRD_PARTY_NOTICES.md` | Project license and attribution for adapted upstream work. |
| `node_modules/` | Locally installed dependencies; not project source. |

## `src/`

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Pi entry point; lifecycle and command registration, tool-call checks, file-tool overrides and recursive search walker. |
| `src/config.ts` | Defaults/overlays, schema-like runtime validation, group resolution, prompt-file loading, project tightening. |
| `src/types.ts` | Mode IDs and shared types for settings, decisions, grants, contexts and sandbox profile. |
| `src/policy.ts` | Action precedence, pattern matching, file read/write and custom-tool decisions, hard path safeguards. |
| `src/bash.ts` | Tree-sitter Bash safe-command classification and whole-line Bash permission decisions. |
| `src/sandbox.ts` | Sandbox profile, private scratch, Bash launcher, command lifecycle and fail-closed runtime adapter. |
| `src/paths.ts` | Path expansion, canonicalization, containment checks, protected names and search globs. |
| `src/grants.ts` | Project read-grant identity, coverage, persistent trust registry. |
| `src/prompts.ts` | Effective runtime fact section and per-turn prompt-section refresh. |
| `src/sessions.ts` | Saved branch mode and startup/resume mode selection. |

## `tests/`

Each test module targets the corresponding source unit unless noted:

- `bash.test.ts`: synthetic AST cases and real parser integration.
- `config.test.ts`: overlays, groups, fixed modes, validation and prompt files.
- `extension.test.ts`: fake Pi lifecycle, commands, tool registration, grants and error paths.
- `grants.test.ts`: grant identity, persistence and symlink retargeting.
- `paths.test.ts`: path aliases, restricted segments and globs.
- `policy.test.ts`: read/write/tool decisions and hard denies.
- `prompts.test.ts`: prompt timing, runtime facts and reserved sections.
- `sandbox.test.ts`: runtime profiles, lifecycle, refusal and YOLO bypass with a fake manager.
- `sessions.test.ts`: branch, reload, CLI and inherited mode selection.
- `settings-policy.test.ts`: cross-module configuration/policy/profile behavior and pinned runtime schema compatibility.

Tests are mostly unit/fake-runtime tests; a passing suite does not prove OS containment.
