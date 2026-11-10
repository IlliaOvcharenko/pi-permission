# pi-permission

A personal permission extension for Pi, independent of `pi-permission-modes`.
**Enable only one permission extension at a time.** This is not a compatible
loader for the older extension's configuration or session state.

It separates **tool parsing and consent** (`tool-parser`) from **Bash OS
containment** (`bash-sandbox`) and built-in **filesystem gates** (`filesystem`).
Ordinary policy lives in `defaults.json`; prompts are not interpreted as policy.

## Shipped behavior

| | Plan | Approve | Build | YOLO |
| --- | --- | --- | --- | --- |
| Bash | Sandbox; scratch writes | Sandbox; project + scratch writes | Sandbox; project + scratch writes | Unsandboxed |
| File changes | Requested Markdown only | Filename proposal + explicit chat confirmation | Requested task, no separate chat approval | Unrestricted |
| Parsed exploration Bash | Allow | Allow | Allow | Allow |
| Other Bash | Ask | Ask | Ask | Allow |
| Reads within configured roots | Allow | Allow | Allow | Allow |
| External file-tool reads | Ask | Ask | Ask | Allow |
| Configured read/write denies | Enforced | Enforced | Enforced | Bypassed |
| Skills and unspecified custom tools | Allow | Allow | Allow | Allow |

Plan is the default; Alt+M cycles Plan → Approve → Build. Four fixed mode IDs
always exist. YOLO requires explicit UI confirmation, is never a default/cycle
entry, and can be restored from a previously selected saved session.

**The table describes defaults, not immutable mode-specific path policy.**
Plan's Markdown extension restriction and scratch-only Bash roots now come from
the editable `planning` group. Authoritative global or trusted project policy
can replace ordinary permissions and boundaries. Mandatory non-YOLO sandboxing,
trust-store protection, invalid-policy blocking and explicit YOLO selection are
structural safeguards, not configurable ordinary rules.

Approve's filename proposal/standalone approval question/wait-for-confirmation
rule is **behavioral**, not mechanically checked. Likewise, requested-only Plan
edits and re-reading files before edits depend on agent behavior. Changing
prompt prose does not grant a mechanically denied tool.

## Configuration version 2

**Read [docs/configs.md](docs/configs.md)** for the full format, matching contracts,
filesystem propagation, trust model, colors, migration and limitations.

| File | Role |
| --- | --- |
| Package `defaults.json` | Automatically loaded shipped groups/modes/prompts. |
| `<agentDir>/pi-permission/config.json` | Optional global authoritative overlay; normally `~/.pi/agent/pi-permission/config.json`. |
| `<project>/.pi/pi-permission.json` | Optional authoritative project overlay, after Pi trust and content-bound UI approval. |
| Package `config.example.json` | Non-live example; not loaded. |
| Package `config.schema.json` | Same editor schema at both scopes; runtime validation remains authoritative. |

Resolution: **defaults → global → trusted project**. Later same-name groups
replace earlier groups entirely. Modes merge supplied fields; arrays replace.
A local group can replace a global ask/deny with allow. Across the groups that
remain selected, **deny > ask > allow**, independently of group-selection order.
Inside a map, the last matching entry wins. Unspecified tools, including custom
tools, **allow by default**; custom argument maps are rejected rather than
implicitly matching serialized JSON.

An example overlay that adds an independent read-only group without replacing
shipped safeguards:

```json
{
  "configVersion": 2,
  "permissionGroups": {
    "review": { "tool-parser": { "write": "deny", "edit": "deny" } }
  },
  "modes": {
    "plan": {
      "permissionGroups": ["development", "planning", "review"],
      "color": "#8899aa",
      "systemPromptAppend": "Review only; report concrete findings."
    }
  }
}
```

Use scalar actions or compact ordered pattern maps. Permission `*` crosses `/`,
`?` matches one character, `**/` also matches zero directory levels. Put `*`
first as a fallback. A named tool replaces only its own group's tool wildcard.
Adding an allow group cannot cancel another selected group's ask/deny.

Approval dialogs show the complete `toolName({...parameters})` call, followed by
only approval-requiring rules and Bash commands, with the exact syntax/argument
fragment when parser limits prevent automatic approval. No raw trace JSON is
shown. Choose Allow once, Allow for session (same request), or Deny. Requests
without UI or over the review-size limit refuse rather than being truncated.

Bash patterns now match **parsed commands and argument boundaries**, not whole
submitted source. `npm test` is exact; `npm test *` permits extra arguments.
Every command in a supported pipeline/list is evaluated. Unsupported syntax,
redirections, substitutions, execution flags and unknown arguments cannot earn a
narrow automatic allow. An intentional scalar/wildcard allow is broader consent
but still requires the sandbox. The parser is consent UX, not containment or an
executable blacklist.

## Default filesystem gates

File-tool read roots are the project, private session scratch, and the configured
agent directory's `skills` and `prompts` directories. Other file-tool locations
ask. Pi's external installation docs/examples are no longer hidden automatic
grants; add explicit literal roots if desired.

Shipped configurable denies cover project path segments `archive`, `notes`,
`.git`, `credentials` (case-insensitive), SSH and Pi credential locations, and
protected writes such as `.env*`, `node_modules`, editor/config and shell startup
paths. Read roots and one-call approvals never override denies. File tools check
literal and canonical aliases; a symlink allow cannot erase a deny.

`filesystem` supplies file-tool read roots/external action, write roots/extensions
and restrictions shared with Bash. `bash-sandbox.filesystem` adds **Bash-only**
roots/denies. Denies union and roots intersect by containment across groups.
Omitted roots impose no extra restriction; empty roots permit no configured
writes. Scratch is never silently re-added after intersection. Paths support
`${home}`, `${agentDir}`, `${project}`, `${scratch}` and `~`; relative filesystem
paths and `@prompt` files retain their defining config directory as base.

Search wrappers check every encountered entry, skip denied children and descendant
symlinks, and bound traversal. `grep` uses `rg --no-config`; searches deliberately
do not honor `.gitignore`. Native read/write/edit retain Pi's formatting, images,
edit queues and diffs. Search globs and permission globs are different languages.

## Project authority and reload

A project policy is an authority source, not merely a restriction request.
**Trust project permission policy?** shows its contents, location and digest.
No UI, refusal, invalid config or an oversized review blocks execution. Approval
is stored outside the project in `<agentDir>/pi-permission/trust/projects.json` and
binds project bytes/location, resolved policy/prompt text and read-root identities.
Changed/retargeted roots need fresh review. Legacy read-grant records do not
automatically authorize v2 policy.

Project changes are checked before turns, tool calls and built-in execution.
They block further execution until successful reload/review; an agent-writable
policy cannot silently approve its own expansion. Configuration/prompt changes
activate only on successful startup or `/reload`. Already running commands keep
their launch profile. Invalid reload never partially activates a policy.

The extension refreshes `pi_permission_*` prompt sections before every turn.
`pi_permission_runtime` is generated and cannot be replaced/disabled. It describes
active permissions without permission-group names, config source paths or layering
details. Independent rule sets remain separate where needed for correct composition;
provenance remains available through config/status diagnostics and decision traces.
Other shared/mode prose and extra namespaced sections are editable; `@file` text loads on reload.
Unrelated prompt sections are preserved. See the configuration reference for
explicit section-field merge rules.

## Commands and sessions

```text
/pi-permission plan | approve | build
/pi-permission yolo             Explicit warning and confirmation
/pi-permission status           Mode/safety, global/local config paths and load state, errors
/pi-permission config           Resolved policy, active mode, filesystem, Bash profile, prompts
/pi-permission trust            Reload and review pending project policy
/pi-permission revoke           Revoke persistent project-policy trust and block until review
/pi-permission clear-approvals  Forget same-request session tool approvals
```

`pi --pi-permission plan` overrides startup mode only. Resume/reload restores that
session's saved mode, not another session's environment mode. Tree navigation
restores the destination branch. `PI_PERMISSION_MODE` forwards only non-YOLO modes to
startup children, never overriding an existing saved selection. Session approvals
are keyed by mode and the exact request, not executable name alone.

## Install / migrate (manual)

1. Use Node.js >= 22.18.0 and Pi with local-package support. Install this package's
   declared dependencies yourself. Linux also needs `bubblewrap`, `socat`, and
   `ripgrep` on PATH; macOS/Linux are the supported sandbox systems.
2. Disable `pi-permission-modes` in Pi settings. Conflict detection blocks tools
   if its commands are detected; arbitrary other extensions cannot be safely
   arbitrated. Never load two permission extensions.
3. Register the checkout, for example `pi install /absolute/path/to/pi-permission`.
   Local packages load in place; source files alone do not activate it.
4. **Migrate old names before restarting/reloading** using
   [Rename from pi-perm](docs/configs.md#rename-from-pi-perm). The old config
   paths are not loaded; move global/project policy and rename prompt sections
   before relying on your existing restrictions. For version-1 configs also use
   [the schema migration](docs/configs.md#migration-from-version-1).
   `shared`, `permission`, `permission.groups`, `safeCommands`, ambiguous `read`,
   action wrappers and obsolete network/macOS options fail validation. There is
   no automatic live-config rewrite or legacy session import.
5. Restart in Plan, inspect `/pi-permission status` and `/pi-permission config`, review project
   authority, and test on disposable data before relying on containment.

Defaults preserve prompt guidance to re-read files and preserve manual edits,
use inherited PATH/Python/Conda without managing packages/environments, perform
no Git operations except clone, explain missing dependencies for the user, never
dump credentials, and never bypass denials. Ordinary project documents and
skills are not grants; only approved configuration is policy authority.

## Containment limits

- Every non-YOLO Bash command uses the OS sandbox. Unsupported platforms,
  missing dependencies, disabled runtime, initialization/wrap failures refuse
  execution; **never an unsandboxed fallback**.
- Bash reads broadly except compiled denies. Approved scripts are not prompted
  for every file they open. File-tool roots do not create a Bash read allowlist.
- **Custom extension tools are not OS-sandboxed and now allow by default.**
  Configure ask/deny explicitly for untrusted tools. Arbitrary approved extensions
  execute with their own process privileges and can access/mutate host state.
- **Network is unrestricted**, including loopback/service-side writes. The runtime
  profile intentionally omits `allowedDomains`; `[]` would block networking.
  No network controls are exposed by this extension.
- Runtime-required temporary exceptions remain even with empty configured write
  roots. `TMPDIR`/`CLAUDE_TMPDIR` point at private scratch but do not grant it.
- Linux expands deny globs at launch; newly created restricted paths may not be
  masked until the next launch. Runtime protected-pattern compilation may deny
  more than file-tool matching. Hardlinks, copied secrets, symlink races and
  inherited environment credentials remain limitations.
- Commands are serialized in fresh Bash process groups, startup injection is
  stripped, command transport is protected, and background descendants are
  stopped when the foreground shell exits. No managed background-shell tools,
  port exposure, sandbox install command or general container isolation is offered.
- Pi loads resources outside tool hooks. Do not put secrets into automatically
  loaded context/skills, or load malicious extensions.

## Development / validation

With dependencies already installed:

```sh
node --test tests/*.test.ts
tsc --noEmit
```

Tests cover v2 overlays, trust lifecycle, parser integration and fake sandbox
profiles/lifecycle. **Passing tests is not an OS containment audit.** Test real
macOS/Linux containment separately on disposable data; report unavailable
sandboxing rather than bypass it. No packages or live Pi configuration are
installed or changed by the test suite.

Maintainer navigation: [docs/README.md](docs/README.md),
[architecture](docs/architecture.md), [file map](docs/file-map.md).
