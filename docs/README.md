# pi-permission: project map

`pi-permission` is a Pi permission extension with four fixed modes. It combines **tool-call decisions** (allow, ask, deny) with **OS sandboxing of Bash** in every mode except YOLO. It is not a replacement for OS/container isolation, nor a compatible loader for `pi-permission-modes` configuration. Run only one permission extension at a time.

## Read in this order

1. [User guide](user-guide.md): install, modes, commands, configuration examples.
2. [Architecture](architecture.md): configuration resolution, enforcement flow, security boundaries and limitations.
3. [File map](file-map.md): source, tests and root-file ownership.
4. [Configuration reference](configs.md): version-2 format, parser contracts, trust, migration and filesystem composition.
5. Root [README](../README.md): behavior summary, install and containment caveats.

## Core concepts

- **Mode** selects a fixed safety behavior: Plan, Approve, Build or YOLO. Plan is the default; YOLO is never a default or cycle entry.
- **Permission group** independently supplies `tool-parser`, `bash-sandbox`, sibling `filesystem` policy and `skills`. Modes select nonempty group lists. Within a map the last match wins; across groups deny > ask > allow. Unspecified custom tools allow.
- **Parsed Bash consent** matches executable/argument boundaries with tree-sitter. Narrow automatic allows require conservative supported structure; no old whole-line override remains. Parsing is not containment.
- **Sandbox profile** controls Bash write locations and selected read denies. Plan Bash writes to private scratch only; Approve/Build Bash may write within the configured project roots and scratch. Network access is unrestricted; no network configuration is exposed.
- **File-tool wrappers** independently gate Pi's built-in read/write/edit tools and perform policy-aware traversal for grep/find/ls. These are not the Bash sandbox.
- **Project policy authority** uses the same v2 schema as global configuration and may relax it through atomic group replacement and mode overrides. Pi trust plus separate content-bound policy approval are required. Read-root canonical identities remain checked; roots never override denies. This is separate from behavioral Approve chat confirmation.
- **Fail closed** means invalid configuration, conflicting legacy extension or unavailable sandbox prevents affected tool execution rather than silently allowing it.

## Mode summary (shipped defaults)

| Mode | Bash | File changes | Selection |
| --- | --- | --- | --- |
| Plan | Sandbox; scratch-only writes | Requested Markdown only; request condition is instructional | Default |
| Approve | Sandbox; project + scratch writes | Propose every filename and await explicit chat confirmation (instructional) | `/pi-permission approve` or cycle |
| Build | Sandbox; project + scratch writes | Requested task without separate chat confirmation | `/pi-permission build` or cycle |
| YOLO | Unsandboxed; permission checks bypassed | Unrestricted by this extension | Explicit `/pi-permission yolo` + UI confirmation; saved selection can be restored |

Shipped non-YOLO groups share configurable read denies, protected-write checks and project/scratch boundaries. These ordinary policies are replaceable; trust-store protection and mandatory sandboxing remain structural. Plan's configured Markdown extension is checked, but whether a change was requested is not; Approve's chat consent is not mechanically verified.
