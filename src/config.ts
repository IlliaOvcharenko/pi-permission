import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { absolutePath, commandWords } from "./paths.ts";
import { MODES, isMode, type Action, type PermissionGroup, type PolicyContext, type PromptSection, type Rule, type Settings } from "./types.ts";

const STOCK = JSON.parse(readFileSync(new URL("../defaults.json", import.meta.url), "utf8"));
const ACTIONS = ["allow", "ask", "deny"];
export function object(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, any>;
}
function rejectNull(value: unknown): void {
  if (value === null) throw new Error("Configuration values cannot be null; omit a field to inherit");
  if (typeof value === "object") for (const child of Object.values(value)) rejectNull(child);
}
function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown ${label} key: ${key}. See docs/configs.md for configuration version 2 migration.`);
}
function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(p => typeof p !== "string" || !p.trim() || /[\x00-\x1f\x7f]/.test(p))) throw new Error(`${label} must be an array of nonempty strings`);
  return [...new Set(value)];
}
function action(value: unknown): asserts value is Action {
  if (!ACTIONS.includes(value as string)) throw new Error("Expected allow, ask, or deny");
}
export function parseRule(value: unknown): Rule {
  if (typeof value === "string") { action(value); return value; }
  const map = object(value, "permission rule");
  for (const [pattern, value] of Object.entries(map)) {
    if (!pattern.trim() || pattern.length > 4096 || /^\d+$/.test(pattern) || /[\x00-\x1f\x7f]/.test(pattern)) throw new Error("Invalid permission pattern (nonempty, nonnumeric, at most 4096 characters)");
    action(value);
  }
  return { ...map };
}
function filesystem(value: unknown, bash = false): void {
  const fs = object(value, "filesystem");
  keys(fs, bash ? ["writeRoots", "denyRead", "denyWrite"] : ["readRoots", "externalRead", "writeRoots", "writeExtensions", "denyRead", "denyWrite", "denyDirectoryNames", "protectedWrite"], "filesystem");
  for (const [key, value] of Object.entries(fs)) {
    if (key === "externalRead") { action(value); continue; }
    const entries = strings(value, key);
    if (["readRoots", "writeRoots", "denyRead", "denyWrite"].includes(key)) {
      for (const p of entries) {
        if (/[*?[\]]/.test(p)) throw new Error(`${key} requires literal paths`);
        if (/\$(?!\{(?:home|agentDir|project|scratch)\})/.test(p)) throw new Error(`Unknown path variable in ${p}`);
      }
    }
    if (key === "denyDirectoryNames" && entries.some(p => /[/\\*?]/.test(p) || p === "." || p === "..")) throw new Error("denyDirectoryNames requires literal directory names");
    if (key === "writeExtensions" && entries.some(p => !/^\.[a-zA-Z0-9]+$/.test(p))) throw new Error("writeExtensions requires extensions such as .md");
  }
}
function group(value: unknown, source: string, base: string): PermissionGroup {
  const g = object(value, "permission group");
  keys(g, ["tool-parser", "bash-sandbox", "filesystem", "skills"], "permission group");
  if (g["tool-parser"] !== undefined) {
    const parser = object(g["tool-parser"], "tool-parser");
    for (const [tool, rule] of Object.entries(parser)) {
      if (tool !== "*" && (!/^[a-zA-Z_][a-zA-Z0-9_.:-]*$/.test(tool) || ["__proto__", "constructor", "prototype"].includes(tool))) throw new Error(`Invalid tool name: ${tool}`);
      parseRule(rule);
      if (tool === "bash" && typeof rule === "object") for (const pattern of Object.keys(rule!)) if (pattern !== "*") commandWords(pattern);
      if (!["bash", "read", "write", "edit", "grep", "find", "ls"].includes(tool) && typeof rule !== "string") throw new Error(`No argument matching adapter for ${tool}; use a scalar action`);
    }
  }
  if (g.skills !== undefined) parseRule(g.skills);
  if (g.filesystem !== undefined) filesystem(g.filesystem);
  if (g["bash-sandbox"] !== undefined) {
    const sb = object(g["bash-sandbox"], "bash-sandbox");
    keys(sb, ["enabled", "filesystem", "linux"], "bash-sandbox");
    if (sb.enabled !== undefined && typeof sb.enabled !== "boolean") throw new Error("bash-sandbox.enabled must be boolean");
    if (sb.filesystem !== undefined) filesystem(sb.filesystem, true);
    if (sb.linux !== undefined) {
      const linux = object(sb.linux, "linux"); keys(linux, ["allowNestedUserNamespaces"], "linux");
      if (linux.allowNestedUserNamespaces !== undefined && typeof linux.allowNestedUserNamespaces !== "boolean") throw new Error("allowNestedUserNamespaces must be boolean");
    }
  }
  return { ...structuredClone(g), source, base };
}
export interface ConfigLayer { value: unknown; source: string; base: string; loadText?: boolean }
/** Same partial schema at both scopes. References are checked only after layering. */
export function resolveSettings(layers: ConfigLayer[]): Settings {
  const result = { configVersion: 2, replacements: [], promptSources: Object.create(null), modes: Object.create(null), permissionGroups: Object.create(null), prompts: { removeLegacySections: [], sections: Object.create(null) } } as unknown as Settings;
  const allLayers: ConfigLayer[] = [{ value: STOCK, source: "shipped defaults", base: process.cwd(), loadText: false }, ...layers];
  const sectionTextLayers = new Map<string, ConfigLayer>();
  for (const layer of allLayers) {
    rejectNull(layer.value);
    const raw = object(layer.value, "config");
    keys(raw, ["$schema", "$comment", "configVersion", "defaultMode", "cycleOrder", "permissionGroups", "modes", "prompts"], "config");
    for (const key of ["$schema", "$comment"]) if (raw[key] !== undefined && typeof raw[key] !== "string") throw new Error(`${key} must be a string`);
    if (Object.keys(raw).length && raw.configVersion !== 2) throw new Error("Set configVersion: 2 and migrate old permission, safeCommands, shared, and read settings; see docs/configs.md");
    const text = (value: unknown): string => {
      if (typeof value !== "string") throw new Error("Prompt text must be a string");
      return value;
    };
    if (raw.defaultMode !== undefined) {
      if (!isMode(raw.defaultMode) || raw.defaultMode === "yolo") throw new Error("defaultMode must be plan, approve, or build");
      result.defaultMode = raw.defaultMode;
    }
    if (raw.cycleOrder !== undefined) {
      const cycle = strings(raw.cycleOrder, "cycleOrder");
      if (!cycle.length || cycle.some(n => !isMode(n) || n === "yolo")) throw new Error("cycleOrder requires non-YOLO modes");
      result.cycleOrder = cycle as Settings["cycleOrder"];
    }
    for (const [name, value] of Object.entries(object(raw.permissionGroups ?? {}, "permissionGroups"))) {
      if (!/^[a-z][a-z0-9_-]*$/.test(name) || ["constructor", "prototype"].includes(name)) throw new Error(`Invalid group name: ${name}`);
      if (Object.hasOwn(result.permissionGroups, name)) result.replacements.push({ group: name, previousSource: result.permissionGroups[name].source, source: layer.source });
      result.permissionGroups[name] = group(value, layer.source, layer.base);
    }
    for (const [name, value] of Object.entries(object(raw.modes ?? {}, "modes"))) {
      if (!isMode(name)) throw new Error(`Unknown mode: ${name}`);
      const patch = object(value, name); keys(patch, ["permissionGroups", "color", "systemPrompt", "systemPromptAppend"], name);
      const mode = result.modes[name] ?? { color: "muted", systemPrompt: "", systemPromptAppend: "", permissionGroups: [], sources: {} };
      if (patch.permissionGroups !== undefined) {
        mode.permissionGroups = strings(patch.permissionGroups, "mode.permissionGroups");
        if (!mode.permissionGroups.length) throw new Error("Mode permissionGroups cannot be empty");
      }
      if (patch.color !== undefined) {
        if (!["muted", "mdLink", "accent", "error"].includes(patch.color) && !(typeof patch.color === "string" && /^#[0-9a-fA-F]{6}$/.test(patch.color))) throw new Error("Invalid mode color; use a theme token or #RRGGBB");
        mode.color = patch.color;
      }
      for (const key of ["systemPrompt", "systemPromptAppend"] as const) if (patch[key] !== undefined) {
        mode[key] = text(patch[key]);
        result.promptSources[`modes.${name}.${key}`] = { source: layer.source, ...(mode[key].startsWith("@") ? { file: absolutePath(layer.base, mode[key].slice(1), os.homedir()) } : {}) };
      }
      for (const key of Object.keys(patch)) mode.sources[key] = layer.source;
      result.modes[name] = mode;
    }
    const prompts = object(raw.prompts ?? {}, "prompts"); keys(prompts, ["removeLegacySections", "sections"], "prompts");
    if (prompts.removeLegacySections !== undefined) {
      result.prompts.removeLegacySections = strings(prompts.removeLegacySections, "removeLegacySections");
      if (result.prompts.removeLegacySections.some(n => !["permission_mode", "permission_mode_docs", "permission_mode_steering"].includes(n))) throw new Error("Only known legacy sections can be removed");
    }
    for (const [name, value] of Object.entries(object(prompts.sections ?? {}, "prompt sections"))) {
      if (!/^pi_permission_[a-z][a-z0-9_]*$/.test(name)) throw new Error("Prompt sections require pi_permission_ namespace");
      const patch = object(value, name); keys(patch, ["source", "when", "text"], name);
      const section = { ...result.prompts.sections[name], ...patch } as PromptSection;
      if (patch.source !== undefined && patch.source !== result.prompts.sections[name]?.source && patch.text === undefined) delete section.text;
      if (patch.text !== undefined) { section.text = text(patch.text); sectionTextLayers.set(name, layer); }
      if (!["text", "mode", "runtime"].includes(section.source)) throw new Error("Invalid prompt source");
      if (Array.isArray(section.when) ? section.when.some(n => !isMode(n)) : !["sandboxed", "always", "never"].includes(section.when)) throw new Error("Invalid prompt timing");
      if (section.source === "text" ? typeof section.text !== "string" : section.text !== undefined) throw new Error("Only text-source sections accept text");
      if (name === "pi_permission_runtime" ? section.source !== "runtime" || section.when !== "sandboxed" : section.source === "runtime") throw new Error("pi_permission_runtime cannot be overridden or disabled");
      for (const field of Object.keys(patch)) result.promptSources[`sections.${name}.${field}`] = { source: layer.source, ...(field === "text" && typeof patch.text === "string" && patch.text.startsWith("@") ? { file: absolutePath(layer.base, patch.text.slice(1), os.homedir()) } : {}) };
      if (section.text === undefined) delete result.promptSources[`sections.${name}.text`];
      result.prompts.sections[name] = section;
    }
  }
  for (const name of MODES) {
    const groups = result.modes[name].permissionGroups.map(n => {
      if (!Object.hasOwn(result.permissionGroups, n)) throw new Error(`Unknown permission group: ${n}`);
      return result.permissionGroups[n];
    });
    if (name !== "yolo" && !groups.some(g => g["bash-sandbox"]?.enabled === true)) throw new Error(`${name} must require the Bash sandbox`);
  }
  const loadText = (text: string, layer?: ConfigLayer) => layer?.loadText && text.startsWith("@") ? readFileSync(absolutePath(layer.base, text.slice(1), os.homedir()), "utf8") : text;
  for (const mode of Object.values(result.modes)) for (const key of ["systemPrompt", "systemPromptAppend"] as const) mode[key] = loadText(mode[key], allLayers.findLast(l => l.source === mode.sources[key]));
  for (const [name, section] of Object.entries(result.prompts.sections)) if (section.text !== undefined) section.text = loadText(section.text, sectionTextLayers.get(name));
  return result;
}
export function parseSettings(value: unknown, project?: unknown): Settings {
  return resolveSettings([{ value, source: "global config", base: process.cwd() }, ...(project === undefined ? [] : [{ value: project, source: "project config", base: process.cwd() }])]);
}
export const DEFAULT_SETTINGS = parseSettings({});
export function modeSettings(ctx: PolicyContext) { return (ctx.settings ?? DEFAULT_SETTINGS).modes[ctx.mode]; }
export function selectedGroups(ctx: PolicyContext): [string, PermissionGroup][] {
  const settings = ctx.settings ?? DEFAULT_SETTINGS;
  return modeSettings(ctx).permissionGroups.map(name => [name, settings.permissionGroups[name]]);
}
export function isYolo(ctx: PolicyContext): boolean { return ctx.mode === "yolo"; }
export function loadJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Cannot load ${file}: ${String(error)}`);
  }
}
export function loadSettings(file: string, projectFile?: string): Settings {
  return resolveSettings([file, ...(projectFile ? [projectFile] : [])].map(source => ({ value: loadJson(source), source, base: path.dirname(source), loadText: true })));
}
export function resolvePath(ctx: PolicyContext, group: PermissionGroup, raw: string): string {
  const vars: Record<string, string> = { home: ctx.home, agentDir: ctx.agentDir, project: ctx.root, scratch: ctx.scratch };
  return absolutePath(group.base, raw.replace(/\$\{([^}]+)\}/g, (_, name) => {
    if (!Object.hasOwn(vars, name)) throw new Error(`Unknown path variable: ${name}`);
    return vars[name];
  }), ctx.home);
}
