# User guide

## Install

1. Use Node.js >= 22.18.0 and Pi local packages. Install declared dependencies
   yourself; Linux additionally needs `bubblewrap`, `socat`, and `ripgrep` on PATH.
   macOS/Linux are the supported Bash sandbox systems.
2. Disable `pi-permission-modes`. Never run two permission extensions.
3. Register the checkout: `pi install /absolute/path/to/pi-permission`. Local
   packages load in place; the checkout alone is not active.
4. Migrate old names using [configs.md](configs.md#rename-from-pi-perm) and, if needed,
   the [version-1 migration](configs.md#migration-from-version-1).
   Restart, inspect `/pi-permission status`, and test disposable files. No live settings,
   dependencies or environments are migrated/managed automatically.

## Daily use

- `/pi-permission plan`, `/pi-permission approve`, `/pi-permission build`; Alt+M cycles non-YOLO modes.
- `/pi-permission yolo` requires explicit UI confirmation for unrestricted unsandboxed use.
- `/pi-permission status` (or just `/pi-permission`) shows a short mode/safety summary,
  global and local config paths with loaded/absent state, and any blocking errors.
  Absent files leave the inherited defaults in place; failed initialization marks configs
  not active. File presence reflects the last successful load, not live disk changes.
  `/pi-permission config` shows resolved groups/modes, separate file-tool/Bash profiles and
  generated next-turn prompt sections.
- `/pi-permission trust` reloads and reviews project policy. `/pi-permission revoke` revokes its
  content-bound trust and blocks tools until review/removal. `/pi-permission clear-approvals`
  forgets exact-request session approvals.
- `pi --pi-permission plan` sets startup mode. Reload/resume/tree restore saved branch
  selections; new sessions use the configured non-YOLO default.

Shipped Plan policy permits requested Markdown file edits and scratch-only Bash
writes. Approve/Build permit project + scratch writes; Approve additionally
instructs filename-by-filename proposal and explicit chat confirmation. That chat
rule, whether Plan edits were requested, and re-reading files are **behavioral**.
Ordinary mode policy can be replaced through configuration. Mandatory non-YOLO
Bash sandboxing and trust-store protection are structural.

### Permission dialogs

`Allow tool call?` shows the full tool name and parameters, then the command and
rule requiring consent. Parser limitations also identify the exact syntax or
argument that prevents automatic approval; an `ask` is not necessarily a policy
violation. Already-allowed commands and raw internal trace JSON are omitted from
the explanation (the complete requested call is still shown).

Choose **Allow once**, **Allow for session (same request)**, or **Deny**. Session
consent applies only to the same mode and exact review details. No UI or a request
larger than the review limit refuses execution; calls are never truncated for approval.

## Tool boundaries

| Tool | Checks outside YOLO |
| --- | --- |
| `read`, `grep`, `find`, `ls` | Path maps, configured read denies, per-group read roots/external-read actions. |
| `write`, `edit` | Path maps, shared denies, protected writes, file-tool roots/extensions, structural trust protection. |
| `bash` | Every parsed executable/argument sequence, strictest group/component action, mandatory Bash sandbox. |
| Custom tools | Named scalar action or that group's wildcard; unspecified tools allow. No automatic path checks or OS sandbox. |
| `skill` / `skill:*` | Tool rule plus independent per-skill map/scalar. Not automatic Pi resource loading. |

Dedicated tools parse structured targets, not Bash. Recursive searches filter
denied children, skip descendant symlinks, bound traversal, and do not apply
`.gitignore`. Consent to a parent never overrides a child deny. File tools repeat
checks at execution time.

Bash narrow allows require supported literal structure. Pipelines/lists evaluate
all commands; exact `npm test` never grants a second unchecked command. Execution
options (`find -exec`, `fd -x`, `rg --pre`), redirections, expansions and unknown
arguments cannot obtain a name-only automatic allow. Unsupported syntax normally
asks; explicit broad wildcard consent is different. Approval never disables the
non-YOLO sandbox. Approved scripts can do more than their initial command line
reveals; parsing is not containment.

**Custom tools allow by default and are not sandboxed.** Configure explicit ask
or deny for tools you do not trust, regardless of their `path` arguments.

## Configure

Global `<agentDir>/pi-permission/config.json` and project `.pi/pi-permission.json` use the same
version-2 schema. Defaults → global → trusted project; groups replace atomically
by name, modes merge explicit fields, and arrays replace. Local policy may relax
global policy, but selected groups still compose deny > ask > allow. Last-match
ordering applies within each map, not between groups.

Example at either scope, preserving shipped groups while adding read-only policy:

```json
{
  "configVersion": 2,
  "permissionGroups": {
    "review": { "tool-parser": { "write": "deny", "edit": "deny" } }
  },
  "modes": {
    "plan": { "permissionGroups": ["development", "planning", "review"], "color": "#8899aa" }
  }
}
```

Project files require Pi trust **and** separate whole-policy UI approval.
Approvals persist outside the project, bound to content, resolved prompts and
canonical read-root identities. Changes block tools until reload/review; a policy
cannot silently approve itself. Invalid reload never partially activates policy.

See [configs.md](configs.md) for all fields, full examples, path bases/variables,
parsed Bash matching, hex colors, prompt sections, sandbox composition and migration.
`config.example.json` is non-live; `config.schema.json` is an editor aid only.
Do not replace a shipped group without carrying forward the safeguards you want.

## Troubleshooting and limitations

- Invalid configuration blocks tools, including saved YOLO sessions. Inspect
  `/pi-permission status`, fix the named file, then `/reload`; no unsandboxed workaround.
- Missing dependencies are for the user to install. Do not manage environments.
- Bash reads broadly except denies, network is unrestricted, runtime temporary
  exceptions remain, and Linux glob denies mask launch-time entries. Hardlinks
  and symlink races are not fully contained. Custom extensions have host privileges.
- Default external docs/examples are not hidden read grants; configure literal
  roots if desired. Read roots never override denies.
- Run `node --test tests/*.test.ts` and `tsc --noEmit` with dependencies installed.
  Unit/fake-runtime results do not establish OS containment; test it separately
  on disposable data. See [architecture](architecture.md) and [README](../README.md).
