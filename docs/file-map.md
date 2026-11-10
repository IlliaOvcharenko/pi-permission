# Repository file map

## Root

| Path | Responsibility |
| --- | --- |
| `README.md` | Detailed project reference: mode matrix, configuration, containment limits and migration. |
| `docs/` | Short persistent navigation, architecture, usage and ownership map for maintainers. |
| `AGENTS.md` | Agent navigation and documentation-maintenance instructions. |
| `defaults.json` | Shipped mode policies, permission groups, sandbox defaults and prompt prose. |
| `config.example.json` | Non-live example of a user overlay. |
| `config.schema.json` | Shared editor schema for global/project v2 overlays; runtime validation lives in `src/config.ts`. |
| `package.json` | Pi extension entry (`src/index.ts`), Node requirement, dependencies and scripts. |
| `package-lock.json` | Locked npm dependency graph. |
| `tsconfig.json` | TypeScript checking of source and tests. |
| `LICENSE`, `THIRD_PARTY_NOTICES.md` | Project license and attribution for adapted upstream work. |
| `node_modules/` | Locally installed dependencies; not project source. |

## Configuration documents

- [Configuration reference](configs.md): implemented v2 schema, layering, group composition, parser targets, filesystem propagation, project trust, colors and migration.
- [Implementation plan](config-system-implementation-plan.md): redesign acceptance checklist and original design direction; finalized contracts live in the reference.

## `src/`

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Pi entry point; lifecycle and command registration, tool-call checks, file-tool overrides and recursive search walker. |
| `src/config.ts` | Shared v2 validation, provenance-aware layering, atomic groups, mode/prompt merges and final prompt-file loading. |
| `src/types.ts` | Mode IDs and shared types for settings, decisions, grants, contexts and sandbox profile. |
| `src/policy.ts` | Independent group decisions/traces, alias-aware file gates, filesystem root intersection/deny union and structural trust protection. |
| `src/bash.ts` | Tree-sitter executable/argument consent, conservative narrow allows and unsupported-syntax handling. |
| `src/sandbox.ts` | Sandbox profile, private scratch, Bash launcher, command lifecycle and fail-closed runtime adapter. |
| `src/paths.ts` | Path expansion/canonicalization, containment, command-pattern tokenization and separate search globs. |
| `src/grants.ts` | Persistent content-bound policy approval and legacy read-grant identity/coverage/store helpers. |
| `src/prompts.ts` | Effective runtime fact section and per-turn prompt-section refresh. |
| `src/sessions.ts` | Saved branch mode and startup/resume mode selection. |

## `tests/`

Each test module targets the corresponding source unit unless noted:

- `bash.test.ts`: synthetic AST cases and real parser integration.
- `config.test.ts`: overlays, groups, fixed modes, validation and prompt files.
- `extension.test.ts`: fake Pi lifecycle/commands, tool registration, policy trust/change/revocation, root identities, colors and error paths.
- `grants.test.ts`: grant identity, persistence and symlink retargeting.
- `paths.test.ts`: path aliases, command-pattern argument boundaries and search globs.
- `policy.test.ts`: read/write/tool decisions and hard denies.
- `prompts.test.ts`: prompt timing, runtime facts and reserved sections.
- `sandbox.test.ts`: runtime profiles, lifecycle, refusal and YOLO bypass with a fake manager.
- `sessions.test.ts`: branch, reload, CLI and inherited mode selection.
- `settings-policy.test.ts`: cross-module configuration/policy/profile behavior and pinned runtime schema compatibility.

Tests are mostly unit/fake-runtime tests; a passing suite does not prove OS containment.
