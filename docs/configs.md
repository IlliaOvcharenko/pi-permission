# Configuration reference (version 2)

This is the shared format for `<agentDir>/pi-permission/config.json` and
`<project>/.pi/pi-permission.json`. Neither `config.example.json` nor this document is
loaded as policy. Runtime validation in `src/config.ts` is authoritative;
`config.schema.json` supplies editor hints. No live configuration is migrated or
written automatically.

## Format and layering

```json
{
  "configVersion": 2,
  "defaultMode": "plan",
  "cycleOrder": ["plan", "approve", "build"],
  "permissionGroups": {
    "development": {
      "tool-parser": {
        "*": "allow",
        "bash": { "*": "ask", "ls": "allow", "npm test": "allow" },
        "read": { "*": "allow", "**/*.private": "deny" },
        "dangerous_tool": "deny"
      },
      "bash-sandbox": {
        "enabled": true,
        "filesystem": {
          "writeRoots": ["${project}", "${scratch}"],
          "denyRead": [],
          "denyWrite": []
        },
        "linux": { "allowNestedUserNamespaces": false }
      },
      "filesystem": {
        "readRoots": ["${project}", "${scratch}"],
        "externalRead": "ask",
        "writeRoots": ["${project}", "${scratch}"],
        "denyRead": ["${home}/.ssh"],
        "denyWrite": [],
        "denyDirectoryNames": [".git", "credentials"],
        "protectedWrite": ["**/.env", "**/.env.*"]
      },
      "skills": { "*": "ask", "review": "allow" }
    }
  },
  "modes": {
    "build": { "permissionGroups": ["development"], "color": "#7aa2f7" }
  }
}
```

**This example replaces the entire shipped `development` group.** Its shorter
path policy is illustrative, not equivalent to the shipped safeguards. Start
from the actual group in `defaults.json` when preserving those defaults matters.

Resolution is shipped defaults → global → trusted project:

- Later group definitions replace same-name groups **atomically**. Omitted
  internal fields do not survive replacement. Other groups inherit by name.
- Modes merge by fixed mode ID and explicitly supplied fields. `permissionGroups`
  arrays and `cycleOrder` replace inherited arrays, never append. Empty mode
  selections are invalid; use an explicitly defined empty group alongside a
  sandbox-requiring group for unrestricted consent policy.
- Prompt sections merge by section name and supplied `source`, `when`, and
  `text` fields. Changing source without text removes inherited text. Arrays
  replace, including section `when` and `removeLegacySections`.
- Omitted values inherit; `null`, unknown keys, unknown references, unsupported
  maps, invalid actions/paths/variables/colors and obsolete fields fail closed.
- Nonempty overlays require `configVersion: 2`; an absent file or `{}` inherits.
  Four fixed IDs remain: `plan`, `approve`, `build`, `yolo`. The default and cycle
  cannot include YOLO. Every non-YOLO mode must select a group requiring sandboxing.

A global group asking for Bash can be replaced locally by a group allowing Bash.
Global configuration is **not an administrator ceiling**. This requires trusted
project loading, not tighten-only semantics. Group source files and mode-field
sources appear in `/pi-permission config`; `replacements` explains which defining source
replaced each earlier group and `promptSources` retains defining files for prompt
fields. Selected group sources appear in status and runtime facts.

## Pattern maps and independent groups

Each rule is `allow`, `ask`, `deny`, or an ordered pattern-to-action map. A scalar
is shorthand for `{ "*": "action" }`. No action wrappers, reasons, `match`,
`default`, or `safeCommands` fields exist.

- Last matching entry wins **within one map**. Put `*` first as a fallback.
  `{ "*": "deny", "ls": "allow" }` allows a supported literal `ls` command.
- `*` matches any text, including `/`; `?` matches one character; `**/` also
  matches zero directory levels. Other regex punctuation is literal.
- Empty/numeric-only pattern keys and control characters are rejected. Numeric
  keys would have surprising JavaScript enumeration order.
- Within a group, a named tool replaces that group's `tool-parser.*` fallback
  completely, even when its own map has no matching entry.
- A missing applicable rule contributes no restriction. **Unspecified tools,
  including custom tools, allow by default.**
- Each selected group is evaluated independently. Across groups use
  **deny > ask > allow**, regardless of selection order. Groups are not flattened.
  Decisions retain matching group, defining source, surface, pattern and action.

For example, selecting a group allowing `npm test` and another asking for all
Bash still asks for `npm test`. Change/replace the asking group, or select a
different group; adding another allow group cannot cancel an existing ask/deny.
The example overlay in `config.example.json` intentionally demonstrates this.

Custom tools accept scalar actions only, including explicit named `ask`/`deny`.
Argument maps are rejected because no custom-tool argument adapter is defined.
There is no implicit JSON-input matching. `skills` accepts a scalar or a skill-name
map and independently gates `skill` / `skill:<name>` tool calls. For the generic
`skill` tool, the adapter extracts a string `name` or `skill` field; a direct caller
may supply the literal skill name. It does not intercept Pi's automatic resource
loading or trusted user slash-command expansion.
Custom extension tools are **not OS-sandboxed** by `bash-sandbox`.

## File-tool matching

`read`, `write`, `edit`, `grep`, `find`, and `ls` parse structured path targets.
Permission maps match normalized absolute paths when the pattern is absolute
(including expanded `~/`), otherwise project-relative paths with `/` separators.
Literal and canonical aliases are evaluated separately and composed strictly;
a permissive symlink alias cannot erase a canonical deny. `..` and `@` aliases
are normalized before matching. Case-sensitive permission maps are separate from
the case-insensitive directory-name/protected-write restrictions.

File wrappers repeat checks at execution time. Recursive searches check each
visited entry, filter denied paths, skip descendant symlinks, and bound traversal
to 100,000 entries. Search globs (`*`, `**`, `?`) are not permission globs: search
`*` does not cross `/`. Searches do not apply `.gitignore`; grep invokes
`rg --no-config` without a shell. An approved starting directory never overrides
a child's deny.

## Parsed Bash matching

Bash rules match parsed executable and argument **boundaries**, never arbitrary
whole-source substrings:

| Pattern | Contract |
| --- | --- |
| `ls` | Literal executable shorthand; arguments must be conservatively understood for a narrow allow. |
| `npm test` | Exact executable and argument sequence, no extra arguments. |
| `npm test *` | That executable/prefix, with zero or more additional arguments. |
| `printf "two words"` | One argument containing a space, not two arguments. |
| `/bin/echo hi` | That literal executable path; `echo hi` is different. |
| `*` or scalar | Broad consent for the Bash operation, including unsupported structures. Sandbox remains required. |

Patterns use whitespace-separated words and single/double quotes. Configuration
patterns are not shell programs: shell operators, substitutions, escapes outside
quotes, and dynamic executable patterns are rejected. Argument globs apply within
an argument; a final bare `*` is the additional-argument marker. Quote characters
in the actual source do not change literal argument identity.

Every command in supported lists, `&&` / `||` chains and pipelines is evaluated.
The strictest component wins; `npm test` does not authorize
`npm test; other-command`. Name-only narrow allows conservatively understand
arguments for the exploration grammar (`ls`, `grep`, `fd`, `fdfind`, `rg`, `find`,
`pwd`), not arbitrary programs. Execution-capable options (`find -exec/-delete`,
`fd -x`, `rg --pre` and similar), follow options and unapproved literal paths
cannot obtain an automatic name-only allow. These are parser capabilities, not
hardcoded permission actions: actual allowed command names live in configuration.

Redirections, substitutions, assignments, functions, loops/conditionals, wrappers,
expansions, variable-built executables, unknown nodes and parse errors cannot earn
narrow automatic allows. Recognizable commands are still traversed so established
denies survive unsupported surroundings. Missing/failed parsing requires ask
unless explicit broad wildcard/scalar consent says otherwise. An absent Bash
rule contributes no restriction, like any unspecified tool rule. No raw-source
override is retained.

The parser is a **consent check**, not an executable blacklist. Approved scripts
can read files, start processes, access the network and perform actions not visible
in their initial command line. Use the sandbox for Bash filesystem containment,
not command patterns as a substitute.

## Filesystem policy and sandbox composition

Group `filesystem` settings:

| Field | Meaning |
| --- | --- |
| `readRoots` | File-tool file/directory roots not subject to that group's external-read action. Omitted means no read-root restriction from this group. |
| `externalRead` | Action outside that group's roots. Omitted adds no restriction. |
| `writeRoots` | Allowed file-tool write regions; also restrict Bash. Omitted adds no restriction, `[]` permits no configured writes. |
| `writeExtensions` | File-tool extensions such as `.md`; omitted unrestricted, empty permits none. Does not constrain Bash extensions. |
| `denyRead`, `denyWrite` | Literal subtrees denied to file tools and Bash. Read-denied paths are also write-denied. |
| `denyDirectoryNames` | Case-insensitive project-relative path segment denies at any depth, propagated to Bash read/write denies. |
| `protectedWrite` | Case-insensitive write-deny patterns, propagated to Bash, separate from read denial. |

`bash-sandbox.filesystem` contains only `writeRoots`, `denyRead`, `denyWrite` and
adds **Bash-only** restrictions. File tools never inherit Bash-only settings.
`bash-sandbox.enabled: true` requires sandboxing. Any requirement wins; false
cannot cancel another group's true. No non-YOLO configuration may remove all
sandbox requirements. YOLO explicitly bypasses both policy and sandboxing.

Across groups, read/write denies union; write roots intersect by containment
(project intersect project/src is project/src). Shared filesystem and Bash-only
roots intersect too. Write-extension sets intersect for file tools. Scratch is
**not automatically added**: include `${scratch}` in each restricting root list
where it should survive intersection. If all root fields are omitted, policy
adds no restriction (the filesystem root); do not remove the shipped boundaries
accidentally when replacing a group. `linux.allowNestedUserNamespaces` defaults
false; any explicit false wins over true across groups.

Read roots do not override denies or make Bash reads an allowlist. Multiple groups
with read roots independently apply their external-read actions. A one-call UI
read approval can satisfy ask, never deny. Project policy approval binds existing
read-root canonical paths and file/directory kinds; changes/missing-to-existing
transitions require reload and review. Read-root identity checks do not attempt
to bind every descendant inode or defend against filesystem races.

All filesystem path lists are literal paths (no globs). Supported variables:
`${home}`, `${agentDir}`, `${project}`, `${scratch}`; unknown `$` variables fail.
`~` is also supported. Relative filesystem paths and `@prompt.md` references
resolve against **the defining configuration file's directory**, not the last
layer's directory. Shipped paths use explicit variables. Permission-map relative
patterns instead use the project matching base described above.

Protected-write patterns use permission glob semantics (without path-variable
interpolation); runtime compilation is conservative and platform-dependent.
Permission `*` becomes runtime `**`; permission `?` is broadened to runtime `**`
rather than weakened by the runtime's separator semantics. Literal brackets are
escaped and case-insensitive matches are expanded. Runtime globs are not passed through as
permission maps. Linux masks existing matching entries at command launch; newly
created restricted paths may not be masked until a later launch. Runtime-mandatory
temporary write exceptions remain even with empty configured roots.

## Project policy authority and trust

Project config can grant authority. Pi project trust **and** a separate
**Trust project permission policy?** confirmation are required before activating
any nonempty project file. No UI, refusal, oversized review (>16,000 characters),
invalid config, or a change during review blocks execution, not just the overlay.
The dialog shows the project file, raw configuration, digest and relaxation
warning. Review referenced prompt files too; they are trusted configuration.

Approval is stored outside the project in
`<agentDir>/pi-permission/trust/projects.json`, keyed by canonical project root. Its
SHA-256 digest includes project bytes/location, resolved configuration (including
loaded prompt text), and read-root identities. Changing global inherited policy
can also require fresh project review. Scratch identity is session-private and
excluded so new scratch allocation does not invalidate trust each session.
Legacy read-grant records are retained but no longer implicitly activate v2 roots.

Project bytes/location and configured read-root identities are checked before
turn prompts, tool calls, and built-in file/Bash execution. A change blocks further
execution until successful `/reload` and approval. Already running commands retain
their launch profile. Prompt text is loaded only on reload, not live-reloaded;
changes to referenced text are part of the next approval digest.

`/pi-permission trust` initiates reload/review; `/pi-permission revoke` removes stored policy trust
and blocks the current session until review or project-policy removal. The trust
registry and private command transport remain structurally write-protected,
even if project policy removes all ordinary protected paths. A project policy
cannot silently approve its own expansion. Arbitrary malicious extensions still
run with host privileges and are outside this boundary.

## Colors and prompts

Mode `color` accepts `muted`, `mdLink`, `accent`, `error`, or strict `#RRGGBB`.
Hex uses the supported concrete RGB `theme.style` API, never theme-token lookup;
missing color support falls back to plain text. Short hex, malformed colors and
terminal control sequences are invalid.

`systemPrompt` replaces and `systemPromptAppend` supplements a mode's prose.
Both accept inline text or `@file`. Prompt section definitions use
`source: text | mode`, `when: sandboxed | always | never | [mode IDs]`, and `text`
only for text sources. `pi_permission_runtime` is reserved, generated, sandboxed-only,
and cannot be replaced or disabled. Before each turn, only extension-owned
`pi_permission_*` sections and configured known legacy sections are refreshed/removed.
Prompt instructions cannot grant mechanically denied tools. Approve filename/chat
confirmation, re-reading, and whether Plan edits were requested are behavioral.

## Rename from pi-perm

This is a breaking naming change, not a schema-version change (`configVersion: 2`
remains current). There are no old-name command, flag, environment or config aliases.
Before restarting/reloading, back up and migrate live settings yourself:

| Old | New |
| --- | --- |
| Package/status name `pi-perm` | `pi-permission` |
| `/perm` | `/pi-permission` |
| `--perm` | `--pi-permission` |
| `<agentDir>/pi-perm/config.json` | `<agentDir>/pi-permission/config.json` |
| `<project>/.pi/pi-perm.json` | `<project>/.pi/pi-permission.json` |
| `<agentDir>/pi-perm/trust/projects.json` | `<agentDir>/pi-permission/trust/projects.json` |
| `PI_PERM_MODE` | `PI_PERMISSION_MODE` |
| Prompt section prefix `pi_perm_` | `pi_permission_` |
| Session entry `pi-perm.mode` | `pi-permission.mode` |
| Temporary scratch/transport prefix `pi-perm` | `pi-permission` |

Old config paths are ignored, so unmigrated restrictions do not apply. Rename
custom prompt section keys as well as paths; old section keys in a migrated
config fail validation. Moving global config changes the base for relative paths
and `@file` prompts: move those resources or adjust references to preserve targets.
Do not overwrite an existing destination config blindly; reconcile it manually.

Project policy must be reviewed again because its path and resolved policy are
part of the trust digest. There is no need to copy old trust approvals; the new
registry starts empty. Old session entries are not imported: select the intended
mode explicitly (old YOLO selections are not restored). Restart Pi to clear old
process environment, prompt/status state and loaded extension code; never load
both versions. No live files, session records or dependencies are moved automatically.
Inspect `/pi-permission status` and `/pi-permission config`, then test disposable
data. References to the separate upstream `pi-permission-modes` project are unchanged.

## Migration from version 1

1. Back up your live config yourself. This source migration does not edit it.
2. Add `configVersion: 2`. Move `shared.permission`, per-mode `permission` and
   group rules into named groups' `tool-parser` sections. Select via each mode's
   `permissionGroups` array, not `permission.groups`.
3. Replace `safeCommands` wrappers with ordered Bash maps. Review whole-line
   patterns carefully: `npm test*` does not mean the old raw-line prefix grant.
   Use exact `npm test` or parsed `npm test *` as appropriate.
4. Replace `tool` fallback maps with `tool-parser.*` plus scalar named tools.
   Remove custom-tool JSON maps/action wrappers/reasons; they are unsupported.
   Move `skill` rules to `skills`. Unspecified custom tools now **allow**, not ask.
5. Replace ambiguous `read.allow/deny` with `filesystem.readRoots`, `externalRead`
   and `denyRead`. Move sandbox fields to `bash-sandbox`; put common roots/denies
   in sibling `filesystem`. There is no `writable` flag: configure root lists.
6. Preserve the desired shipped group content when replacing groups. Plan
   extension/scratch policy is now the editable `planning` group, not hardcoded.
   External docs/examples are no longer hidden automatic read grants; add literal
   read roots to configured policy if desired.
7. Project configs now have the same keys and can relax policy, but require
   whole-policy content-bound trust. Old read-grant approval alone is insufficient.
8. Remove obsolete network/macOS options. Networking remains unrestricted and
   no network controls are exposed. Use `/reload`, inspect `/pi-permission config`, and
   test disposable data before relying on the new policy.

## Structural safeguards and limits

Canonicalization/symlink checks, trust-registry and command-transport protections,
invalid-policy blocking, fixed mode IDs/YOLO confirmation, mandatory non-YOLO
sandboxing, platform/dependency refusal and process lifecycle protections remain
implemented in code. Ordinary tool/path policy lives in `defaults.json` and can
be replaced by authoritative configuration.

Bash supports macOS/Linux only; failure never falls back unsandboxed. Network is
unfiltered, including loopback and service-side writes. Runtime temporary exceptions,
hardlinks, copies of secrets, symlink races, launch-time Linux masks, inherited
credentials and arbitrary extension privileges limit containment. Passing unit or
fake-runtime tests is **not** proof of real OS containment; test it separately on
disposable data on supported systems.
