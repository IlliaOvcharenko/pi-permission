import type { Permission, PolicyContext } from "./types.ts";
import { DEFAULT_SETTINGS, isYolo, modeSettings } from "./config.ts";
import { readDenies, writeRoots } from "./policy.ts";

// Use code spans for literal paths/patterns, including unusual Markdown names.
function literal(text: string): string {
  const fence = "`".repeat(Math.max(0, ...[...text.matchAll(/`+/g)].map(m => m[0].length)) + 1);
  const padding = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${padding}${text.replace(/[\r\n]/g, " ")}${padding}${fence}`;
}
function list(title: string, entries: string[]): string {
  return entries.length ? [`### ${title}`, ...entries.map(entry => `- ${entry}`)].join("\n") : "";
}
function permissionList(title: string, permission: Permission | undefined): string {
  return list(title, Object.entries(permission ?? {}).flatMap(([surface, rule]) => {
    if (typeof rule === "string") return [`${literal(surface)}: **${rule}**`];
    const entries = Object.entries(rule);
    if (!entries.length) return [`${literal(surface)}: no matching rules (falls back to ask)`];
    return [[
      `${literal(surface)} (last matching pattern wins):`,
      ...entries.map(([pattern, value]) => {
        const action = typeof value === "string" ? value : value.action;
        const reason = typeof value === "string" ? "" : value.reason;
        return `  - ${literal(pattern)}: **${action}**${reason ? ` — ${literal(reason)}` : ""}`;
      }),
    ].join("\n")];
  }));
}

/** Facts are generated from the same resolved profile consumed by enforcement.
 * This reserved section is not a user-supplied policy or editable text template. */
function runtimeText(ctx: PolicyContext): string {
  const mode = modeSettings(ctx);
  const roots = mode.sandbox.writable ? writeRoots(ctx) : [ctx.scratch];
  const projectPermission = ctx.project?.modes?.[ctx.mode]?.permission;
  const safeBash = mode.safeBash;
  return [
    `## pi-perm runtime — ${literal(ctx.mode)}`,
    "Bash must use its OS sandbox. Failure means refusal, never an unsandboxed fallback.",
    list("Bash writable locations", [
      ...roots.map(root => `${literal(root)}${root === ctx.scratch ? " — private session scratch; use TMPDIR" : ""}`),
      ...(!mode.sandbox.writable ? ["Project writes are disabled for Bash."] : []),
      "Runtime-mandatory temporary exceptions also apply.",
    ]),
    list("File tools", [
      `Writes: configured project roots and scratch${ctx.mode === "plan" ? "; only requested Markdown changes" : mode.sandbox.writable ? "" : "; project writes disabled"}.`,
      "Protected-path and trust-registry safeguards remain enforced.",
      "Approve chat confirmation and re-reading are behavioral, not mechanically checked.",
    ]),
    list("File-tool read locations (subject to tool rules and hard denies)", [
      `${literal(ctx.root)} — current project`,
      `${literal(ctx.scratch)} — session scratch`,
      ...ctx.readRoots.map(root => `${literal(root.path)} — ${root.kind}`),
    ]),
    list("Hard read denies (grants never override these)", [
      ...[...new Set(readDenies(ctx))].map(literal),
      "Project directories named archive, notes, .git, or credentials, at every depth.",
    ]),
    list("Additional write denies", mode.sandbox.denyWrite.map(literal)),
    [mode.permission, projectPermission].some(permission => Object.values(permission ?? {}).some(rule => typeof rule !== "string"))
      ? "Permission patterns: `*` matches any text (including `/`); a bare `*` means all targets. `?` matches one character; `**/` matches zero or more directories. Within each map, the last matching rule wins; no match falls back to ask for base rules and adds no restriction for project overlays. Across applicable gates, deny > ask > allow; hard safeguards still win. Bash patterns match the entire submitted command line, not each nested executable."
      : "",
    permissionList("Tool permissions", mode.permission),
    permissionList("Project tightening (composes with tool permissions; stricter action wins)", projectPermission),
    safeBash?.safeCommands.length ? list("Bash safe-command permission", [
      `${safeBash.safeCommands.map(literal).join(", ")}: **${safeBash.action}** when tree-sitter confirms safe structure.`,
      "Matching command-line patterns override this rule; scalar ask is the fallback. Scalar allow/deny takes priority. Project restrictions and path gates still apply.",
    ]) : "",
    list("Platform options", [
      `Linux nested user namespaces: ${mode.sandbox.linux.allowNestedUserNamespaces ? "enabled" : "disabled"}.`,
    ]),
    "Approved scripts do not ask for every file they open. Bash reads broadly except sandbox denies. Custom extension tools are NOT OS-sandboxed. Never bypass denials.",
  ].filter(Boolean).join("\n\n");
}
export function promptSections(ctx: PolicyContext): Record<string, string> {
  const settings = ctx.settings ?? DEFAULT_SETTINGS;
  const mode = modeSettings(ctx);
  const result: Record<string, string> = {};
  for (const [name, section] of Object.entries(settings.prompts.sections)) {
    const applies = Array.isArray(section.when) ? section.when.includes(ctx.mode) : section.when === "always" || (section.when === "sandboxed" && !isYolo(ctx));
    if (!applies) continue;
    const text = section.source === "runtime" ? runtimeText(ctx) : section.source === "mode" ? [
      `## Mode: ${literal(ctx.mode)}`,
      mode.systemPrompt, mode.systemPromptAppend,
    ].filter(Boolean).join("\n\n") : section.text!;
    if (text) result[name] = text;
  }
  return result;
}
export function applyPromptSections(sections: Record<string, string>, ctx: PolicyContext): void {
  // Clear only our namespace and explicitly declared legacy permission sections.
  // This also removes text cached in a resumed session after a mode/config change.
  for (const name of Object.keys(sections)) if (name === "pi_perm" || name.startsWith("pi_perm_")) delete sections[name];
  for (const name of (ctx.settings ?? DEFAULT_SETTINGS).prompts.removeLegacySections) delete sections[name];
  Object.assign(sections, promptSections(ctx));
}
