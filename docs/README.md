# pi-perm: project map

`pi-perm` is a Pi permission extension with four fixed modes. It combines **tool-call decisions** (allow, ask, deny) with **OS sandboxing of Bash** in every mode except YOLO. It is not a replacement for OS/container isolation, nor a compatible loader for `pi-permission-modes` configuration. Run only one permission extension at a time.

## Read in this order

1. [User guide](user-guide.md): install, modes, commands, configuration examples.
2. [Architecture](architecture.md): configuration resolution, enforcement flow, security boundaries and limitations.
3. [File map](file-map.md): source, tests and root-file ownership.
4. Root [README](../README.md): detailed rule reference, migration guidance and operational caveats.

## Core concepts

- **Mode** selects a fixed safety behavior: Plan, Approve, Build or YOLO. Plan is the default; YOLO is never a default or cycle entry.
- **Permission surface** is a named gate (`bash`, `read`, `write`, `tool`, `path`, etc.). A surface has a scalar action or an ordered pattern map. Within a map the last matching rule wins; across gates the stricter action wins.
- **Safe-command classifier** uses tree-sitter Bash to grant the exploration group's allow rule only for recognized, conservative command structures. It is a consent shortcut, *not* a filesystem or process boundary. A Bash approval still runs inside the sandbox.
- **Sandbox profile** controls Bash write locations and selected read denies. Plan Bash writes to private scratch only; Approve/Build Bash may write within the configured project roots and scratch. Network filtering is disabled.
- **File-tool wrappers** independently gate Pi's built-in read/write/edit tools and perform policy-aware traversal for grep/find/ls. These are not the Bash sandbox.
- **Project read grant** is an existing literal file or directory requested by project configuration and separately trusted through UI; it never overrides a hard deny. Approve-mode chat confirmation of file changes is a different, behavioral requirement.
- **Fail closed** means invalid configuration, conflicting legacy extension or unavailable sandbox prevents affected tool execution rather than silently allowing it.

## Mode summary (shipped defaults)

| Mode | Bash | File changes | Selection |
| --- | --- | --- | --- |
| Plan | Sandbox; scratch-only writes | Requested Markdown only; request condition is instructional | Default |
| Approve | Sandbox; project + scratch writes | Propose every filename and await explicit chat confirmation (instructional) | `/perm approve` or cycle |
| Build | Sandbox; project + scratch writes | Requested task without separate chat confirmation | `/perm build` or cycle |
| YOLO | Unsandboxed; permission checks bypassed | Unrestricted by this extension | Explicit `/perm yolo` + UI confirmation; saved selection can be restored |

All non-YOLO modes share hard read denies, protected-write checks and a project/scratch write boundary. Do not infer that a prompt instruction is mechanically enforced: Plan's *Markdown extension* is checked, but whether a change was requested is not; Approve's chat consent is not parsed or verified by the extension.
