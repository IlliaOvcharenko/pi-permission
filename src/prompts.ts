import type { Permission, PolicyContext } from "./types.ts";
import { DEFAULT_SETTINGS, isYolo, modeSettings, resolvePath, selectedGroups } from "./config.ts";
import { filesystemPolicy } from "./policy.ts";

// Use code spans for literal paths/patterns, including unusual Markdown names.
function literal(text: string): string {
  const fence = "`".repeat(Math.max(0, ...[...text.matchAll(/`+/g)].map(m => m[0].length)) + 1);
  const padding = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${padding}${text.replace(/[\r\n]/g, " ")}${padding}${fence}`;
}
function list(title: string, entries: string[]): string {
  return entries.length ? [`### ${title}`, ...entries.map(entry => `- ${entry}`)].join("\n") : "";
}
function permissionList(permission: Permission | undefined): string {
  return Object.entries(permission ?? {}).flatMap(([surface, rule]) => {
    if (typeof rule === "string") return [`${literal(surface)}: **${rule}**`];
    const entries = Object.entries(rule);
    if (!entries.length) return [`${literal(surface)}: no additional restriction`];
    return [[
      `${literal(surface)} (last matching pattern wins):`,
      ...entries.map(([pattern, value]) => {
        return `  - ${literal(pattern)}: **${value}**`;
      }),
    ].join("\n")];
  }).map(entry => `- ${entry}`).join("\n");
}
// Keep independently evaluated maps separate without exposing configuration provenance.
function ruleSets(title: string, bodies: string[]): string {
  const unique = [...new Set(bodies.filter(Boolean))];
  if (!unique.length) return "";
  return [`### ${title}`, ...unique.map((body, i) => unique.length === 1 ? body : `#### Rule set ${i + 1}\n${body}`)].join("\n\n");
}

/** Facts are generated from the same resolved profile consumed by enforcement.
 * This reserved section is not a user-supplied policy or editable text template. */
function runtimeText(ctx: PolicyContext): string {
  const fs = filesystemPolicy(ctx);
  const bash = filesystemPolicy(ctx, true);
  const groups = selectedGroups(ctx);
  return [
    `## pi-permission runtime — ${literal(ctx.mode)}`,
    "Bash must use its OS sandbox. Failure means refusal, never an unsandboxed fallback.",
    "Apply all applicable restrictions; the strictest action wins: deny > ask > allow. Numbered rule sets apply independently, not as overrides. Within each rule set, the last matching pattern wins and a named tool replaces that set's wildcard fallback. Unspecified tools allow.",
    "Permission patterns: `*` crosses `/`; `?` is one character; `**/` also matches zero directories. Bash rules match parsed executable/argument sequences, NOT whole submitted source. Narrow allows require supported syntax and every command to pass; unsupported structures ask unless explicitly broadly allowed or denied.",
    list("Bash writable locations", [...bash.writeRoots.map(literal), "No implicit scratch grant; use TMPDIR only when permitted. Runtime-mandatory temporary exceptions also apply."]),
    list("File-tool writable locations", fs.writeRoots.length ? fs.writeRoots.map(literal) : ["None."]),
    list("File-tool write extensions", fs.extensions === undefined ? [] : fs.extensions.length ? fs.extensions.map(literal) : ["None; file-tool writes are denied."]),
    list("Configured read denies (read roots never override these)", fs.denyRead.map(literal)),
    list("Configured project directory-name denies", fs.directoryNames.map(literal)),
    list("Configured protected-write patterns", fs.protectedWrite.map(literal)),
    list("File-tool write denies", fs.denyWrite.map(literal)),
    list("Additional Bash read denies", bash.denyRead.filter(p => !fs.denyRead.includes(p)).map(literal)),
    list("Bash write denies", bash.denyWrite.map(literal)),
    ruleSets("Tool permissions", groups.map(([, g]) => permissionList(g["tool-parser"]))),
    ruleSets("Skill permissions", groups.map(([, g]) => permissionList(g.skills === undefined ? undefined : { skills: g.skills }))),
    ruleSets("File-tool read permissions", groups.map(([, g]) => {
      const policy = g.filesystem;
      if (policy?.readRoots === undefined) return "";
      const roots = policy.readRoots.map(p => `- ${literal(resolvePath(ctx, g, p))}`).join("\n");
      return `Read roots (configured denies and tool permissions still apply):\n${roots || "- None."}\n\nOutside these roots: **${policy.externalRead ?? "allow"}**.`;
    })),
    "Trust-registry and private command-transport protections are structural. Approve chat confirmation, requested-only Plan edits, and re-reading are behavioral, not mechanically checked.",
    "Approved scripts do not ask for every file they open. Bash reads broadly except sandbox denies. Network is unrestricted. Custom extension tools are NOT OS-sandboxed. Never bypass denials.",
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
  for (const name of Object.keys(sections)) if (name === "pi_permission" || name.startsWith("pi_permission_")) delete sections[name];
  for (const name of (ctx.settings ?? DEFAULT_SETTINGS).prompts.removeLegacySections) delete sections[name];
  Object.assign(sections, promptSections(ctx));
}
