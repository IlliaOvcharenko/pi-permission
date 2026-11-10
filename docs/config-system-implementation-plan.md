# Configuration system redesign: implementation plan

Status: version-2 implementation delivered. This document retains the original design direction and acceptance checklist; the finalized runtime contracts and migration instructions are in [configs.md](configs.md). The implementation uses sibling `filesystem` policy, parsed executable/argument matching, `configVersion: 2`, and content-bound project-policy approval stored outside the project. Unit/fake-runtime validation does not establish real OS containment.

Validation note: the unit/fake-runtime suite and TypeScript checks pass. A separate disposable macOS containment smoke check was attempted from the agent sandbox, but nested `sandbox-exec` refused with `sandbox_apply: Operation not permitted` (exit 71). Neither test write executed; this is **not** containment validation. No unsandboxed fallback was attempted. Real macOS/Linux checks remain an operator verification step.

## 1. Goals and agreed decisions

- Clearly separate Bash OS containment (`bash-sandbox`) from tool parsing and consent (`tool-parser`).
- Use compact permission maps: pattern to `allow`, `ask`, or `deny`. `*` means all targets and serves as the fallback. Do not introduce `safeCommands`, `match`, action wrappers, or a separate default property.
- Allow multiple reusable permission groups. Every mode selects one or more groups.
- Resolve contradictions between selected groups using `deny > ask > allow`.
- Allow unspecified tools by default, including custom tools. This is an intentional change from the current custom-tool default of ask.
- Use the same configuration format and validation schema for global and project configuration.
- Resolve configuration in order: shipped defaults, global user configuration, project configuration.
- Permit project settings to relax global settings. Global ask plus a local replacement allowing Bash resolves to allow; global configuration is not an administrator-enforced ceiling.
- Replace a global permission group entirely when the project defines a group with the same name. Do not merge the internal rules of replaced groups.
- Let project mode settings override global mode settings. A local mode's group-selection array replaces the inherited array.
- Move ordinary hardcoded path and tool policy into explicit, editable configuration.
- Move long explanatory JSON comments into `docs/configs.md`.
- Support strict `#RRGGBB` mode colors alongside existing theme tokens.
- Preserve the distinction between configurable policy, behavioral prompt instructions, and structural implementation safeguards.

## 2. Target configuration shape

The following illustrates the agreed core format. It is not valid input for the current loader and is not the complete future shipped policy.

```json
{
  "configVersion": 2,
  "defaultMode": "plan",
  "cycleOrder": ["plan", "approve", "build"],
  "permissionGroups": {
    "development": {
      "tool-parser": {
        "*": "allow",
        "bash": {
          "*": "ask",
          "npm test": "allow"
        },
        "read": {
          "*": "allow",
          "**/*.private": "deny"
        }
      },
      "bash-sandbox": {
        "enabled": true,
        "filesystem": {
          "writeRoots": ["${project}", "${scratch}"],
          "denyRead": [],
          "denyWrite": []
        }
      },
      "skills": "allow"
    }
  },
  "modes": {
    "plan": {
      "permissionGroups": ["development"],
      "color": "#8899aa"
    },
    "approve": {
      "permissionGroups": ["development"]
    },
    "build": {
      "permissionGroups": ["development"],
      "color": "#7aa2f7"
    }
  }
}
```

The exact version marker and the supplementary filesystem-policy field names must be finalized when writing the schema. Do not treat example omissions as a decision to remove existing safeguards.

## 3. Configuration layering and group composition

These are separate operations and must not be conflated.

### 3.1 Layering

1. Load shipped defaults.
2. Apply global user configuration.
3. Apply project configuration using the same format.
4. Validate references and invariants against the resolved configuration.
5. Compile the selected mode's effective groups.

Overlay rules:

- Permission groups merge by group name; a later definition replaces the entire earlier group.
- Modes merge by mode name and explicitly supplied settings.
- Arrays replace inherited arrays, including `permissionGroups` and `cycleOrder`.
- Omitted settings inherit.
- Map-like configuration such as prompt section definitions needs explicit field-level merge rules; document these rather than using an unspecified recursive merge.
- Resolve relative paths and prompt files using their source configuration location. Preserve provenance so an inherited global path does not become project-relative.
- Apply changes only on successful startup or reload. Invalid configuration blocks affected execution rather than partially applying policy.

Example: a global `development` group asks for Bash. A project definition of `development` allows Bash. The project definition replaces the global group, so the resulting group allows Bash. If another selected group denies Bash, the final result is deny.

### 3.2 Within a permission group

- A scalar action is shorthand for `{ "*": "action" }`.
- Within a pattern map, the last matching entry wins. Put `*` first when using it as a fallback with exceptions.
- Keep existing documented permission glob behavior unless deliberately changed: `*` crosses `/`, `?` matches one character, and `**/` matches zero or more directories. Do not confuse permission patterns with search globs or sandbox-runtime globs.
- Reject numeric-only keys whose JavaScript enumeration ordering would make rule order surprising.
- A named tool rule replaces that group's top-level tool wildcard fallback for that tool.
- A missing applicable rule contributes no additional restriction.

Thus `{"*":"deny","ls":"allow"}` permits a recognized `ls` invocation within that map; deny precedence must not be applied between the entries of one map.

### 3.3 Across selected groups

- Evaluate each group independently.
- Combine applicable decisions using `deny > ask > allow`.
- Group-selection order must not affect the result.
- If no group restricts a tool, allow it.
- Do not flatten groups into one permission map: that would lose independent restrictions and explanations.
- Preserve group, pattern, source file, and action in decision diagnostics.

## 4. Unified global and project loading

Primary files: `src/config.ts`, `src/types.ts`, `src/index.ts`, `src/grants.ts`.

- Replace the reduced, tighten-only project schema with the same parser and schema used for global configuration.
- Remove validation that prohibits local permission relaxation or local replacement of global group definitions.
- Allow project mode overrides and local group definitions using the same keys as global configuration.
- Preserve source provenance for paths, prompt files, definitions, and mode settings.
- Keep fixed mode IDs and explicit YOLO confirmation unless a separately approved change alters them. Same schema does not mean structural invariants disappear.
- Define how trusted project policy is loaded before enabling authoritative overrides. A project file can now grant permissions, so it is an authority source, not merely a restriction request.
- Trust/change approval is a separate loading safeguard, not a reason to reintroduce tighten-only semantics. The exact approval UX and change-detection mechanism remain an implementation design item.
- Never allow an agent-writable policy file to silently approve its own newly expanded authority. Trust decisions remain outside the project and protected from ordinary file writes.
- Preserve existing external-read grant identity checks where applicable; decide how those requests fit the unified schema.

## 5. Tool-parser evaluation

Primary files: `src/policy.ts`, `src/bash.ts`, `src/paths.ts`, `src/index.ts`.

### 5.1 Built-in file tools

- Parse file/path targets for `read`, `write`, `edit`, `grep`, `find`, and `ls`.
- Evaluate literal, normalized, and canonical aliases without allowing a less-restrictive alias to bypass a deny.
- Retain independent execution-time checks in tool wrappers.
- Preserve policy-aware search traversal, denied-entry filtering, and descendant-symlink handling.
- Define matching bases explicitly for relative and absolute path patterns.
- Keep search syntax separate from permission pattern syntax.

### 5.2 Bash tree-sitter evaluation

Replace the selected-group `safeCommands` shortcut with parsed-command policy evaluation.

Recommended command matching contract to finalize with implementation tests:

- `ls`: literal executable name shorthand, including arguments that the parser can safely classify.
- `npm test`: exact parsed executable and argument sequence.
- `npm test *`: command/argument pattern permitting additional arguments.
- `*`: fallback action for the Bash operation.

Requirements:

- Match structured commands, not arbitrary raw-source substrings.
- Preserve argument boundaries and quoting semantics; do not simply join arguments with spaces.
- Evaluate every executable command in supported pipelines and compound statements.
- Combine component actions using strictest precedence.
- `npm test` must not authorize `npm test; other-command` unless the latter command is separately allowed.
- A name-only allow must not automatically authorize command-specific execution options such as `find -exec` or `rg --pre`.
- Handle redirections, substitutions, assignments, functions, wrappers, variable-built executables, parse errors, and parser unavailability explicitly.
- Narrow rules must not grant automatic allow to structures the parser cannot safely interpret.
- Recognized denies must survive unsupported surrounding syntax where they can be established reliably.
- Unsupported syntax normally requires ask unless a policy already denies it. An intentional unrestricted wildcard allow is broader consent, but it still does not disable the sandbox.
- Do not retain the old whole-command-string override behavior accidentally; document any supported command-line matching separately from parsed command semantics.
- Parser rules are consent checks, not an executable blacklist or process containment boundary. Approved scripts can perform actions not visible in their initial command line.

Parser grammar, AST handling, and conservative understanding of command behavior are implementation capabilities, not configurable lists of trusted tools. The user's actual permission actions and command lists belong in config.

### 5.3 Custom tools and skills

- Unspecified custom tools allow by default, as agreed.
- Support explicit scalar custom-tool actions.
- Require a defined adapter/matching target for argument-pattern maps; reject unsupported maps rather than matching serialized JSON implicitly.
- Do not claim custom extension tools are sandboxed by `bash-sandbox`.
- Support both `"skills": "allow"` and per-skill pattern maps with the same precedence model.

## 6. Filesystem policy and configurable path restrictions

Primary files: `src/paths.ts`, `src/policy.ts`, `src/sandbox.ts`, `defaults.json`.

Inventory and remove embedded ordinary policy choices:

- Project directory read denies: `archive`, `notes`, `.git`, `credentials`.
- SSH and Pi credential read-denied locations.
- Protected-write directory and filename lists.
- Special `.git` write deny entries.
- Default tool actions and exploration command lists.
- Plan write-extension policy and project/scratch write scope where these are policy choices.

Represent these explicitly in shipped defaults and allow authoritative global/project configuration to replace them according to the layering rules.

### Supplementary filesystem section

`bash-sandbox` must describe Bash only. The core group format still needs a place for file-tool read roots, write boundaries, extension restrictions, and restrictions shared with Bash.

Recommended design: a sibling `filesystem` section inside groups, with fields for:

- File-tool read roots and external-read action.
- File-tool write roots and allowed write extensions.
- Read/write denies and protected-write patterns.
- Project directory-name restrictions where a literal path list is insufficient.

Finalize names and precise propagation before implementation. Do not place file-tool restrictions under `bash-sandbox` or pretend a path-parser allow is an OS boundary.

Replace the ambiguous current top-level `read` section by separating read-root requests, read denies, and external-read consent. A read root never overrides a deny, and does not make Bash reads an allowlist.

### Structural safeguards

Retain and document separately:

- Canonicalization and symlink checks.
- Protected trust registry and private command transport.
- Invalid-policy refusal.
- Sandbox startup refusal without an unsandboxed fallback.
- Platform/runtime requirements and unavoidable runtime exceptions.

Do not claim all behavior is configurable: ordinary path/tool policy is configurable, while safe enforcement mechanics remain implemented in code.

## 7. Bash sandbox compilation

Primary files: `src/sandbox.ts`, `src/types.ts`, `src/config.ts`.

Compile effective selected groups into one runtime profile:

| Setting | Composition across selected groups |
| --- | --- |
| `denyRead` | Union |
| `denyWrite` | Union |
| `writeRoots` | Intersection of permitted regions |
| Sandbox requirement | Any requirement wins, subject to mode invariants |
| Omitted field | No additional restriction |

- Compute path intersections using containment, not string equality: project intersect project/src yields project/src.
- Distinguish omitted write roots from an empty list.
- Specify scratch treatment explicitly; do not add it in a way that silently defeats configured restrictions.
- Preserve runtime-required temporary exceptions and explain them accurately.
- Expand `${home}`, `${agentDir}`, `${project}`, and `${scratch}` through an explicit allowlist; reject unknown variables.
- Preserve literal/canonical handling and adapt configured deny patterns to each supported runtime platform.
- Keep network unrestricted unless separately requested. Do not reintroduce removed network settings as part of this task.
- Keep non-YOLO fail-closed sandbox behavior and process lifecycle protections.

## 8. Hex colors

Primary files: `src/types.ts`, `src/config.ts`, `src/index.ts`.

- Support current theme tokens plus strict `#RRGGBB` values.
- Validate color input; reject terminal control sequences and malformed values.
- Render hex via a supported color API, not the theme-token lookup.
- Handle absent UI/color support gracefully.
- Read relevant Pi theme/TUI docs and examples before implementing this integration.

## 9. Configuration versioning and validation

Primary files: `src/config.ts`, `config.schema.json`, `config.example.json`, `defaults.json`.

- Add an explicit format version or an equally unambiguous migration discriminator.
- Use a single configuration schema for both global and project files.
- Validate nonempty mode group selections, references, actions, patterns, paths, variables, and colors.
- Reject unknown and obsolete keys rather than silently ignoring them.
- Define group replacement, mode merging, arrays, and provenance-aware relative paths in tests.
- Keep runtime validation authoritative and editor schema aligned.
- Recommended migration: reject old `permission`, `safeCommands`, and ambiguous `read` structures with actionable guidance. Do not mix old and new precedence semantics silently.
- Do not edit a user's live configuration automatically as part of source migration.

## 10. Pi integration and explanations

Primary files: `src/index.ts`, `src/prompts.ts`, `src/sessions.ts` as needed.

Update:

- Startup/reload initialization and failures.
- `/pi-permission status` and `/pi-permission config`.
- Tool approval/refusal details.
- Effective runtime prompt sections.
- File-tool execution-time checks and search wrappers.
- Read-grant review and project-policy trust handling.

Show active groups, defining source, matching patterns, final actions, effective filesystem policy, and Bash sandbox restrictions separately. Explain why local replacements won and why another selected group may still make the result stricter.

Preserve behavioral-versus-mechanical distinctions: Approve chat confirmation and whether Plan edits were requested are not established by permission maps alone.

## 11. Documentation deliverables

Create `docs/configs.md` as the configuration reference:

- Full format and examples.
- Global/project identical schema and local-over-global precedence.
- Atomic group replacement and mode overrides.
- Pattern ordering and strictest-group examples.
- Parser matching targets and limitations.
- Filesystem policy, trusted read roots, and sandbox composition.
- Path variables and relative bases.
- Project-policy authority/trust.
- Hex colors.
- Old-to-new migration.
- Structural safeguards, custom-tool default allow, and containment limitations.

Update in the same implementation task:

- `docs/README.md`
- `docs/user-guide.md`
- `docs/architecture.md`
- `docs/file-map.md`
- Root `README.md`
- `defaults.json`, `config.example.json`, and `config.schema.json`

Move long explanatory `$comment` content into the reference, leaving at most a short documentation pointer in JSON.

## 12. Test plan

### Configuration and overlays

- Same valid format accepted at both scopes.
- Local allow replaces global ask and global deny when replacing the relevant group.
- Same-name group replacement is atomic: omitted internal global rules do not survive.
- Local mode group arrays replace inherited arrays.
- Omitted mode settings inherit, including colors.
- Group selection order does not affect strictest composition.
- Unknown groups, empty selections, obsolete keys, malformed patterns, invalid variables, and invalid colors fail clearly.
- Relative global paths retain their global source base after project overlays.
- No partial policy activation on reload failure.

### Permission semantics

- All allow/ask/deny combinations across groups.
- Last-match behavior within maps.
- Wildcard fallback versus named tool override.
- Scalar shorthand and omitted-rule behavior.
- Unspecified custom tools allow, with explicit deny/ask working.
- Skill maps and unsupported custom-tool parser maps.
- Decision provenance and user-visible explanations.

### Bash

- Real parser integration and synthetic AST cases.
- Exact arguments, wildcard arguments, quotes, and executable-path handling.
- Pipelines, lists, conditionals, and mixed decisions.
- Redirections, substitutions, assignments, wrappers, functions, and parser errors.
- Execution-capable options cannot exploit a name-only allow.
- Missing parser never earns an unintended narrow allow.
- Explicit wildcard choices remain distinct from parser-derived allowances.

### Filesystem and sandbox

- Configurable directory names and credential/protected-path defaults.
- Literal/canonical aliases, symlinks, case behavior, and denied traversal.
- Read grants cannot override denies and retain target identity checks.
- Deny unions, root intersections, omitted versus empty roots, and scratch handling.
- Project overrides may relax ordinary global path policy after trusted loading.
- Structural trust/transport protections remain enforced.
- Startup/dependency failures refuse execution; YOLO behavior remains explicit.

### Integration and colors

- Startup, reload, branch/session mode restoration, and selected groups.
- Project-policy trust and policy-change handling once the mechanism is finalized.
- `/pi-permission config`, runtime prompts, and execution-time checks.
- Theme tokens, valid hex, malformed hex, absent UI.

Existing test ownership remains in the corresponding `tests/*.test.ts` modules. Add modules only when responsibility warrants it, and update `docs/file-map.md` for additions.

With dependencies already installed, run:

```bash
node --test tests/*.test.ts
tsc --noEmit
```

Do not install packages or manage environments automatically. Report missing dependencies for the user to install. Separately test real sandbox containment on disposable data on supported operating systems; fake-runtime/unit tests do not establish OS containment.

## 13. Implementation sequence

1. Finalize supplementary filesystem fields, Bash argument matching, version marker, and project-policy trust design.
2. Add shared types, ordered rule evaluation, group composition, and provenance.
3. Implement unified parsing and layered global/project resolution.
4. Define explicit shipped groups and migrate config schema/examples.
5. Refactor file-tool path policy and read grants.
6. Replace Bash safe-command classification with parsed-command policy evaluation.
7. Implement restrictive sandbox profile composition.
8. Integrate lifecycle, diagnostics, generated prompts, and hex colors.
9. Complete migration docs and configuration reference.
10. Run regression tests and separate disposable containment checks.

During implementation, re-read existing files immediately before editing and preserve unrelated/manual changes. Code and JSON changes require a mode that authorizes them; this plan does not itself grant permissions.

## 14. Acceptance criteria

- Global and project configuration use the same format and schema.
- Local group definitions replace global definitions; local modes override inherited settings as documented.
- Group order cannot weaken restrictions among the groups that remain selected.
- Every effective decision is traceable to configuration or a documented structural safeguard.
- No hidden ordinary path/tool policy remains in source constants.
- Narrow Bash allows do not authorize unchecked additional commands or unsupported execution constructs.
- `bash-sandbox` applies to Bash, not to custom extension tools or file-tool wrappers.
- Hex mode colors work without breaking theme tokens.
- Invalid configuration and unavailable sandboxing fail closed.
- Documentation accurately distinguishes consent, behavioral instructions, filesystem gates, and OS containment.
