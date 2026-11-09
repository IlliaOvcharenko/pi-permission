import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { absolutePath } from "./paths.ts";
import { MODES, isMode, type ModeSettings, type PermissionGroup, type Permission, type PolicyContext, type ProjectSettings, type PromptSection, type Rule, type SandboxSettings, type Settings } from "./types.ts";

const STOCK = JSON.parse(readFileSync(new URL("../defaults.json", import.meta.url), "utf8"));
const ACTIONS = ["allow", "ask", "deny"];
const RESERVED = new Set(["status", "trust", "revoke", "clear-approvals", "config", "constructor", "prototype", "__proto__"]);
function rejectNull(value: unknown): void {
  if (value === null) throw new Error("Configuration values cannot be null; omit a field to inherit it");
  if (typeof value === "object") for (const child of Object.values(value as object)) rejectNull(child);
}
function object(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, any>;
}
function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown ${label} key: ${key}`);
}
function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(p => typeof p !== "string" || !p.trim() || /[\0\r\n]/.test(p))) throw new Error(`${label} must be an array of nonempty strings`);
  return [...new Set(value)];
}
function paths(value: unknown, label: string): string[] {
  const result = strings(value, label);
  if (result.some(p => /[*?[\]]/.test(p))) throw new Error(`${label} must use literal paths, not globs`);
  return result;
}
function modeName(name: string): void {
  if (!isMode(name)) throw new Error(`Unknown mode: ${name}; use plan, approve, build, or yolo`);
}
export function parseRead(value: unknown): ProjectSettings["read"] {
  const read = value === undefined ? {} : object(value, "read");
  keys(read, ["allow", "deny"], "read");
  return { allow: paths(read.allow ?? [], "read.allow"), deny: paths(read.deny ?? [], "read.deny") };
}
function permission(value: unknown, project = false): Permission {
  const raw = object(value, "permission");
  const result: Permission = Object.create(null);
  for (const [surface, rule] of Object.entries(raw)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_.:-]*$/.test(surface) || RESERVED.has(surface) || surface === "groups") throw new Error(`Invalid permission surface: ${surface}`);
    if (typeof rule === "string" && ACTIONS.includes(rule)) { result[surface] = rule as Rule; continue; }
    const map = object(rule, `permission.${surface}`);
    for (const [pattern, action] of Object.entries(map)) {
      if (!pattern || pattern.length > 4096 || /^\d+$/.test(pattern)) throw new Error("Permission patterns must be nonempty nonnumeric strings of at most 4096 characters");
      if (typeof action === "string" && ACTIONS.includes(action)) continue;
      const entry = object(action, "rule"); keys(entry, ["action", "reason"], "rule");
      if (!ACTIONS.includes(entry.action) || (entry.reason !== undefined && (project || typeof entry.reason !== "string" || entry.reason.length > 500))) throw new Error("Invalid permission action/reason (project reasons are not allowed)");
    }
    result[surface] = map as Rule;
  }
  return result;
}
/** Groups contain ordinary tool rules and optionally one AST-checked Bash rule. */
function group(value: unknown): PermissionGroup {
  const raw = { ...object(value, "permission group") };
  if (Object.hasOwn(raw, "groups")) throw new Error("Permission groups cannot include other groups");
  let safeBash: PermissionGroup["safeBash"];
  if (typeof raw.bash === "object" && raw.bash && Object.hasOwn(raw.bash, "safeCommands")) {
    keys(raw.bash, ["safeCommands", "action"], "safe Bash rule");
    const commands = strings(raw.bash.safeCommands, "safeCommands");
    if (commands.some(s => !/^[a-zA-Z0-9_-]+$/.test(s)) || !ACTIONS.includes(raw.bash.action)) throw new Error("safeCommands requires bare command names and an allow/ask/deny action");
    safeBash = { safeCommands: commands, action: raw.bash.action };
    delete raw.bash;
  }
  return { permission: permission(raw), ...(safeBash ? { safeBash } : {}) };
}
function selectedPermission(value: unknown): { rules: Permission; groups?: string[] } {
  const raw = { ...object(value, "permission") };
  const groups = raw.groups === undefined ? undefined : strings(raw.groups, "permission.groups");
  delete raw.groups;
  return { rules: permission(raw), groups };
}
function sandbox(value: unknown, base: SandboxSettings, project = false): SandboxSettings {
  const raw = object(value, "sandbox");
  keys(raw, project ? ["writable", "allowWrite", "denyRead", "denyWrite", "allowLocalBinding"] : ["enabled", "writable", "allowWrite", "denyRead", "denyWrite", "allowLocalBinding", "macos", "linux"], "sandbox");
  const out = { ...base, ...raw, macos: { ...base.macos }, linux: { ...base.linux } } as SandboxSettings;
  for (const key of ["enabled", "writable", "allowLocalBinding"] as const) if (typeof out[key] !== "boolean") throw new Error(`sandbox.${key} must be boolean`);
  for (const key of ["allowWrite", "denyRead", "denyWrite"] as const) out[key] = paths(out[key], `sandbox.${key}`);
  for (const [key, field] of [["macos", "enableWeakerNetworkIsolation"], ["linux", "allowNestedUserNamespaces"]] as const) {
    if (raw[key] !== undefined) {
      const options = object(raw[key], key); keys(options, [field], key);
      if (options[field] !== undefined && typeof options[field] !== "boolean") throw new Error(`${key}.${field} must be boolean`);
      Object.assign(out[key], options);
    }
  }
  return out;
}
export function parseSettings(value: unknown): Settings {
  rejectNull(value);
  const raw = object(value, "config");
  keys(raw, ["$schema", "$comment", "defaultMode", "cycleOrder", "read", "shared", "modes", "prompts", "permissionGroups"], "config");
  const shared = raw.shared === undefined ? {} : object(raw.shared, "shared");
  keys(shared, ["sandbox", "permission"], "shared");
  const sharedSandbox = sandbox(shared.sandbox ?? {}, STOCK.shared.sandbox);
  const stockPermission = selectedPermission(STOCK.shared.permission);
  const sharedPermission = selectedPermission(shared.permission ?? {});
  const permissionGroups: Settings["permissionGroups"] = Object.create(null);
  const definitions = { ...STOCK.permissionGroups, ...object(raw.permissionGroups ?? {}, "permissionGroups") };
  for (const [name, value] of Object.entries(definitions)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(name) || RESERVED.has(name)) throw new Error(`Invalid permission group name: ${name}`);
    permissionGroups[name] = group(value);
  }
  const changes = raw.modes === undefined ? {} : object(raw.modes, "modes");
  for (const name of Object.keys(changes)) modeName(name);
  const modes: Settings["modes"] = Object.create(null);
  for (const name of MODES) {
    const patch = object(changes[name] ?? {}, `mode ${name}`);
    const stock = STOCK.modes[name];
    const def = { ...stock, ...patch };
    keys(def, ["color", "systemPrompt", "systemPromptAppend", "sandbox", "permission"], `mode ${name}`);
    const sb = sandbox({ ...object(stock.sandbox ?? {}, "stock sandbox"), ...object(patch.sandbox ?? {}, "mode sandbox") }, sharedSandbox);
    const stockMode = selectedPermission(stock.permission ?? {});
    const local = selectedPermission(patch.permission ?? {});
    const groups = local.groups ?? sharedPermission.groups ?? stockMode.groups ?? stockPermission.groups ?? [];
    const grouped: Permission = Object.create(null);
    let safeBash: PermissionGroup["safeBash"];
    let bashDefinition: string | undefined;
    for (const groupName of groups) {
      if (!Object.hasOwn(permissionGroups, groupName)) throw new Error(`Unknown permission group: ${groupName}`);
      const entry = permissionGroups[groupName];
      for (const [surface, rule] of Object.entries(entry.permission)) {
        if (Object.hasOwn(grouped, surface) && JSON.stringify(grouped[surface]) !== JSON.stringify(rule)) throw new Error(`Conflicting permission groups for ${surface}`);
        grouped[surface] = rule;
      }
      const bash = entry.safeBash ?? entry.permission.bash;
      if (bash !== undefined) {
        const signature = JSON.stringify(bash);
        if (bashDefinition !== undefined && bashDefinition !== signature) throw new Error("Conflicting permission groups for bash");
        bashDefinition = signature;
      }
      if (entry.safeBash) safeBash = entry.safeBash;
    }
    modes[name] = {
      color: def.color ?? "muted",
      systemPrompt: def.systemPrompt ?? "", systemPromptAppend: def.systemPromptAppend ?? "",
      sandbox: sb, groups, safeBash,
      permission: { ...stockPermission.rules, ...grouped, ...sharedPermission.rules, ...stockMode.rules, ...local.rules },
    };
    const m = modes[name];
    if (!["muted", "mdLink", "accent", "error"].includes(m.color)) throw new Error("Invalid mode color");
    if (typeof m.systemPrompt !== "string" || typeof m.systemPromptAppend !== "string") throw new Error("systemPrompt and systemPromptAppend must be strings (inline or @file)");
    if (name !== "yolo" && !sb.enabled) throw new Error("Only yolo may disable the sandbox");
    if (name === "yolo" && sb.enabled) throw new Error("yolo must set sandbox.enabled=false");
    if (name === "plan" && sb.writable) throw new Error("plan must set sandbox.writable=false");
  }
  const defaultMode = raw.defaultMode ?? STOCK.defaultMode;
  if (!isMode(defaultMode) || defaultMode === "yolo") throw new Error("defaultMode must be plan, approve, or build");
  const cycleOrder = strings(raw.cycleOrder ?? STOCK.cycleOrder, "cycleOrder");
  if (!cycleOrder.length || cycleOrder.some(n => !isMode(n) || n === "yolo")) throw new Error("cycleOrder must use plan, approve, or build; YOLO requires explicit selection");
  const prompts = raw.prompts === undefined ? {} : object(raw.prompts, "prompts");
  keys(prompts, ["$comment", "removeLegacySections", "sections"], "prompts");
  const removeLegacySections = strings(prompts.removeLegacySections ?? STOCK.prompts.removeLegacySections, "removeLegacySections");
  if (removeLegacySections.some(n => !["permission_mode", "permission_mode_docs", "permission_mode_steering"].includes(n))) throw new Error("Only known legacy permission sections may be removed");
  const patches = prompts.sections === undefined ? {} : object(prompts.sections, "prompt sections");
  const sections: Record<string, PromptSection> = Object.create(null);
  for (const [name, patch] of Object.entries({ ...STOCK.prompts.sections, ...patches })) {
    if (!/^pi_perm_[a-z][a-z0-9_]*$/.test(name)) throw new Error("Prompt sections must use the pi_perm_ namespace");
    const fields = object(patch, name);
    const section = { ...STOCK.prompts.sections[name], ...fields } as PromptSection;
    if (fields.source !== undefined && fields.source !== STOCK.prompts.sections[name]?.source && fields.text === undefined) delete section.text;
    keys(section as unknown as Record<string, unknown>, ["source", "when", "text"], name);
    if (!["text", "mode", "runtime"].includes(section.source)) throw new Error(`Invalid prompt source: ${name}`);
    if (Array.isArray(section.when)) { if (section.when.some(n => !Object.hasOwn(modes, n))) throw new Error("Prompt when references an unknown mode"); }
    else if (!["sandboxed", "always", "never"].includes(section.when)) throw new Error(`Invalid prompt when: ${name}`);
    if (section.source === "text" ? typeof section.text !== "string" : section.text !== undefined) throw new Error("Only text-source sections accept text");
    if (name === "pi_perm_runtime" ? section.source !== "runtime" || section.when !== "sandboxed" : section.source === "runtime") throw new Error("pi_perm_runtime is generated automatically and cannot be overridden or disabled");
    sections[name] = section;
  }
  return { defaultMode, cycleOrder: cycleOrder as Settings["cycleOrder"], read: parseRead(raw.read), modes, permissionGroups, prompts: { removeLegacySections, sections } };
}
export const DEFAULT_SETTINGS: Settings = parseSettings({});
export function modeSettings(ctx: PolicyContext): ModeSettings {
  const mode = (ctx.settings ?? DEFAULT_SETTINGS).modes[ctx.mode];
  if (!mode) throw new Error(`Unknown mode: ${ctx.mode}`);
  const overlay = ctx.project?.modes?.[ctx.mode];
  if (!overlay?.sandbox) return mode;
  const p = overlay.sandbox;
  const sb = { ...mode.sandbox, ...p, denyRead: [...mode.sandbox.denyRead, ...(p.denyRead ?? [])], denyWrite: [...mode.sandbox.denyWrite, ...(p.denyWrite ?? [])] };
  return { ...mode, sandbox: sb };
}
export function isYolo(ctx: PolicyContext): boolean { return ctx.mode === "yolo"; }
export function parseProject(value: unknown): ProjectSettings {
  rejectNull(value);
  const raw = object(value, "project config"); keys(raw, ["$schema", "$comment", "read", "modes"], "project config");
  const result: ProjectSettings = { read: parseRead(raw.read) };
  if (raw.modes !== undefined) {
    result.modes = Object.create(null);
    for (const [name, value] of Object.entries(object(raw.modes, "project modes"))) {
      modeName(name);
      const m = object(value, name); keys(m, ["permission", "sandbox"], `project mode ${name}`);
      const parsed: any = {};
      if (m.permission !== undefined) parsed.permission = permission(m.permission, true);
      if (m.sandbox !== undefined) {
        const s = object(m.sandbox, "project sandbox");
        sandbox(s, DEFAULT_SETTINGS.modes.build.sandbox, true);
        if (s.writable === true || s.allowLocalBinding === true) throw new Error("Projects cannot enable writes or local binding");
        parsed.sandbox = s;
      }
      result.modes![name] = parsed;
    }
  }
  return result;
}
export function validateProject(project: ProjectSettings, settings: Settings, root: string, home: string): void {
  for (const [name, m] of Object.entries(project.modes ?? {})) {
    if (!isMode(name) || !Object.hasOwn(settings.modes, name)) throw new Error(`Project references unknown mode: ${name}`);
    const allowed = settings.modes[name].sandbox.allowWrite.map(p => absolutePath(root, p, home));
    if (m.sandbox?.allowWrite?.some(p => !allowed.includes(absolutePath(root, p, home)))) throw new Error("Project allowWrite may only remove global entries");
  }
}
export function loadJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Cannot load ${file}: ${String(error)}`);
  }
}
export function loadSettings(file: string): Settings {
  const settings = parseSettings(loadJson(file));
  const text = (s: string) => s.startsWith("@") ? readFileSync(absolutePath(path.dirname(file), s.slice(1), os.homedir()), "utf8") : s;
  for (const m of Object.values(settings.modes)) { m.systemPrompt = text(m.systemPrompt); m.systemPromptAppend = text(m.systemPromptAppend); }
  for (const s of Object.values(settings.prompts.sections)) if (s.source === "text") s.text = text(s.text!);
  return settings;
}
export function loadProject(file: string): ProjectSettings { return parseProject(loadJson(file)); }
