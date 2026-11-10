# Architecture and enforcement

## Configuration and authority

1. `src/index.ts` registers Pi hooks, commands, shortcut, flags and tool overrides.
   Startup/reload builds a candidate configuration and context; errors block tools.
2. `src/config.ts` uses one v2 parser for shipped, global and project layers.
   Groups replace atomically by name, mode fields merge explicitly, arrays replace,
   and prompt sections merge named fields. Relative filesystem and prompt paths
   retain the defining source base. Only final referenced prompt text is loaded.
   References and non-YOLO sandbox requirements are checked after layering.
3. Global policy is authoritative but not an administrator ceiling. Project policy
   may replace groups, relax permissions, override modes/default/cycle/prompts and
   ordinary path boundaries, using the same schema. Fixed mode IDs, YOLO UI
   confirmation/exclusion from defaults and mandatory sandboxing remain structural.
4. A nonempty project file requires Pi project trust plus content-bound UI approval.
   SHA-256 binds its bytes/location, resolved candidate policy/prompt text, and
   read-root canonical paths/kinds. Session-specific scratch identity is excluded.
   `src/grants.ts` persists policy digests outside the project in
   `<agentDir>/pi-perm/trust/projects.json`, retaining legacy grant records without
   activating them as v2 authority. A refused/no-UI/oversized review blocks tools.
5. Project bytes/location and root identities are rechecked before turns, tool
   calls and built-in execution. Changed authority blocks until successful
   reload/review. Config/prompt values are not live-applied mid-session. Invalid
   reload never partially activates a candidate; running commands keep their profile.

Full field and precedence contracts: [configs.md](configs.md).

## Decision flow

1. `tool_call` blocks on initialization errors, changed project authority or detected
   legacy extension conflict. YOLO bypasses ordinary gates only after valid startup.
   Otherwise Bash uses `src/bash.ts`; built-in file/custom tools use `src/policy.ts`.
2. Each selected group's `tool-parser` is evaluated separately. Named tools replace
   only their group's wildcard. Scalar shorthand and ordered maps use last-match;
   missing rules contribute no restriction. Across groups, deny > ask > allow,
   independent of group order. Custom tools default allow and accept scalar actions
   only. Decisions retain group, source, pattern, surface and action diagnostics.
3. File maps use normalized absolute or project-relative matching bases. Literal
   and canonical aliases compose strictly. Sibling `filesystem` sections supply
   roots, external-read actions, extensions and shared denies/protected patterns.
   Ordinary credential/name/Plan policies are shipped data, not source constants.
   Structural trust-registry write protection always survives configuration changes.
4. Bash tree-sitter visits all executable commands in supported lists/pipelines,
   matching executable and argument boundaries. It never matches raw-line prefixes.
   Narrow allows require supported structure; recognized denies survive unsupported
   surroundings. Missing/failed parsing cannot earn narrow allows. Broad explicit
   wildcard consent remains possible but never disables containment. Grammar and
   conservative argument understanding are implementation capabilities, not policy.
5. Ask prompts show the request and decision diagnostics. Session approvals bind
   mode, title and exact details. No UI or oversized request refuses. File wrappers
   repeat policy checks; native tools execute read/write/edit. Bounded grep/find/ls
   walkers filter denied entries and descendant symlinks; grep uses `rg --no-config`.
   Searches do not honor `.gitignore` and use a different glob syntax from policy.
6. `src/sandbox.ts` compiles shared filesystem plus Bash-only settings. Denies union,
   roots intersect by containment, omitted fields add no restriction, empty root
   arrays grant nothing, and scratch is not silently re-added. Write extensions are
   file-tool-only. Any sandbox requirement wins; explicit Linux namespace false
   wins over true. Literal/canonical denies and platform-adapted patterns remain.
7. Every non-YOLO Bash invocation uses `@anthropic-ai/sandbox-runtime` on macOS/Linux.
   Dependency/initialization/disabled/wrap failures refuse without fallback.
   Commands serialize in fresh process groups via `/bin/bash --noprofile --norc`;
   startup injection is removed, transport is protected, TMPDIR points at private
   scratch, and background descendants are killed after the foreground shell ends.
   The network profile intentionally omits `allowedDomains` and uses
   `deniedDomains: []`; `allowedDomains: []` would block networking.

## Prompts, colors and sessions

- `src/prompts.ts` refreshes only `pi_perm_*` and explicitly configured known legacy
  sections before each turn. Generated runtime facts list selected groups/sources,
  parser rules, filesystem policy and Bash restrictions separately. They cannot be
  overridden. Shared/mode prompt text is advisory, not a permission grant.
- Approve chat confirmation, re-reading and requested-only Plan edits remain
  behavioral. Plan extensions/Bash roots are editable shipped policy.
- Strict mode `#RRGGBB` values render through concrete RGB `theme.style`; existing
  theme tokens use `theme.fg`. Missing color support falls back to plain text.
- `src/sessions.ts` saves branch-local `pi-perm.mode`. Commands/Alt+M update it;
  tree navigation restores the destination. Startup `--perm` takes precedence;
  non-YOLO environment inheritance never overrides saved selections. Reload
  restores the current session, including previously explicitly selected YOLO.

## Security boundaries and limitations

- Bash sandboxing does **not** contain custom extension tools, which now allow by
  default. Their own implementations/host privileges determine side effects.
  Pi resource loading can occur outside these tool hooks.
- Bash reads broadly except configured denies; file-tool roots do not turn it into
  a read allowlist. Approved scripts are not re-prompted for each file/process.
- Network is unrestricted, including loopback and service-side writes. Runtime
  temporary exceptions remain even with empty roots. No network options are exposed.
- Path checks are not race-proof against symlink swaps or hardlinks. Linux glob
  masks reflect launch-time entries; newly created restricted paths may remain
  accessible during that command. Runtime protected-pattern conversion can be
  conservatively broader than file-tool matching, notably for `?`.
- Trust/transport protection is structural but cannot defend against arbitrary
  malicious host extensions. Legacy conflict detection cannot arbitrate arbitrary
  later tool overrides. Run one permission extension only.
- Unit/fake-runtime tests do not prove OS containment. Test real runtimes separately
  on disposable data and report unavailable sandboxing rather than bypass it.
