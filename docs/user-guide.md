# User guide

## Install

1. Use Node.js >= 22.18.0 and Pi with support for local packages. Install the dependencies declared in `package.json` yourself. On Linux the sandbox additionally needs `bubblewrap`, `socat` and `ripgrep` on PATH. macOS and Linux are the supported sandbox platforms.
2. Disable `pi-permission-modes` in Pi configuration. Do not run both extensions.
3. Register this checkout as a local Pi package: `pi install /absolute/path/to/pi-permission`. The package loads in place; the source checkout alone is not active.
4. Restart Pi. Check `/perm status` in Plan mode and exercise disposable test files before relying on the policy. This does not migrate the older extension's configuration or session state.

## Daily use

- `/perm plan`, `/perm approve`, `/perm build`: switch fixed mode; `Alt+M` cycles the configured non-YOLO list.
- `/perm yolo`: explicitly confirm unsandboxed, unrestricted operation in the UI. Do not use on valuable/unisolated work.
- `/perm status`: see mode, config path, sandbox status, scratch, read roots and cycle. `/perm config`: inspect loaded and effective settings plus next-turn prompt sections.
- `/perm trust`: review pending project read requests. `/perm revoke`: confirm removal of this project's stored grants. `/perm clear-approvals`: forget session-specific tool-call approvals.
- `pi --perm plan`: set startup mode for this process. Edit configuration, then use `/reload` (or restart Pi) to apply it.

With shipped defaults, Plan allows requested Markdown edits through file tools but forbids code edits. Approve and Build allow project/scratch file-tool writes; Approve additionally instructs the agent to list every affected filename, ask a standalone approval question and wait for explicit confirmation. This chat rule is **not mechanically validated**. Bash may write only scratch in Plan, project and scratch in Approve/Build; it always runs sandboxed outside YOLO. Safe exploration commands (`ls`, `grep`, `fd`, `fdfind`, `rg`, `find`, `pwd`) may run without a tool prompt when parsed as safe. Other Bash commands ask by default; approval does not disable sandboxing.

## Configuration files

| Path | Purpose |
| --- | --- |
| Package `defaults.json` | Automatically loaded shipped baseline; do not edit to configure a user installation. |
| `<agentDir>/pi-perm/config.json` (usually `~/.pi/agent/pi-perm/config.json`) | Optional authoritative user overlay. |
| `<project>/.pi/pi-perm.json` | Optional project read requests and tighten-only per-mode restrictions. |
| Package `config.example.json` | Illustrative overlay; not loaded. |
| Package `config.schema.json` | Editor hints; runtime validation is authoritative. |

User overlay example (create the file yourself):

```json
{
  "defaultMode": "plan",
  "cycleOrder": ["plan", "approve", "build"],
  "read": { "allow": ["~/reference"], "deny": ["~/private"] },
  "modes": {
    "plan": { "permission": { "write": "deny", "edit": "deny" } },
    "build": {
      "permission": {
        "bash": { "*": "ask", "node --test *": "allow" },
        "tool": { "*": "ask", "web_enable": "allow" }
      },
      "sandbox": { "allowWrite": ["src", "tests"] }
    }
  }
}
```

Here the `node --test *` rule matches the **whole submitted Bash line**; it is not a guarantee about nested shell operations. `sandbox.allowWrite` limits project Bash/file-tool writes to `src` and `tests` (plus private scratch). A configured `allow` on Bash still runs inside the sandbox. Other surfaces (`read`, `grep`, `find`, `ls`, `write`, `edit`, `path`, `external_directory`, `skill`, names of other tools) accept `allow`, `ask`, `deny`, or an ordered glob-to-action map. Last matching pattern wins in a map; `*` crosses `/`, `?` matches one character, `**/` matches zero or more directories. Use a leading `"*"` for an explicit fallback. `permissionGroups` can define reusable surfaces, selected with `modes.<id>.permission.groups`; only group Bash rules accept `{ "safeCommands": ["ls"], "action": "allow" }`. See [architecture](architecture.md) and the root [README](../README.md) for composition and validation details.

Project read request example in `<project>/.pi/pi-perm.json`:

```json
{
  "read": { "allow": ["../shared-reference"], "deny": ["data/private"] },
  "modes": { "build": { "permission": { "bash": "ask" }, "sandbox": { "denyWrite": ["generated"] } } }
}
```

The requested external path must already exist. Project configuration cannot change prompts, mode selection, defaults, groups, or remove global hard denies; project permissions only tighten. New read grants require project trust **and** a separate UI confirmation; approvals persist outside the project and are restricted to the currently requested canonical path and file/directory kind. Project settings are not a source of authority over these checks.

For prompt wording, use `prompts.sections.pi_perm_shared` (text), a mode's `systemPrompt`/`systemPromptAppend`, or custom `pi_perm_*` sections. A string beginning with `@` loads a file relative to user `config.json` on startup/reload. `pi_perm_runtime` is reserved/generated; changing prompt prose does not change tool enforcement. No network allowlist is provided; network filtering is disabled.

## Validation and troubleshooting

- With declared tools already installed, run `node --test tests/*.test.ts` and `tsc --noEmit`; neither is an OS sandbox audit.
- If configuration fails, inspect `/perm status`, correct the named user/project config or prompt file, then `/reload`. Tools stay blocked until successful initialization. Missing sandbox dependencies must be installed by the user; never run unsandboxed as a workaround.
- Other file-tool reads generally ask; hard-denied paths never become readable through a grant. Sandbox Bash reads are broader than file-tool reads. Searches skip denied entries and do not use `.gitignore`.
