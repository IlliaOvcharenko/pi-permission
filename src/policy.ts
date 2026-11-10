import path from "node:path";
import { statSync } from "node:fs";
import type { Action, Decision, PolicyContext, ReadGrant, Rule, PermissionGroup } from "./types.ts";
import { absolutePath, canonicalPath, expandPath, pathVariants, within } from "./paths.ts";
import { grantCovers } from "./grants.ts";
import { isYolo, resolvePath, selectedGroups } from "./config.ts";

export const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
export const WRITE_TOOLS = new Set(["write", "edit"]);
const RANK = { allow: 0, ask: 1, deny: 2 };
export function strictest(...decisions: Decision[]): Decision {
  const final = decisions.reduce((a, b) => RANK[b.action] >= RANK[a.action] ? b : a, { action: "allow" } as Decision);
  const trace = decisions.flatMap(d => d.trace ?? []);
  return { ...final, ...(trace.length ? { trace } : {}) };
}
/** Permission globs, not search or runtime globs. */
export function patternRegex(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    if (pattern.slice(i, i + 3) === "**/" && (i === 0 || pattern[i - 1] === "/")) { out += "(?:.*/)?"; i += 2; }
    else if (pattern[i] === "*") out += ".*";
    else if (pattern[i] === "?") out += ".";
    else out += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(out + "$", "s");
}
export function ruleDecision(rule: Rule | undefined, targets: string[], home: string, fallback: Action = "allow"): Decision {
  if (typeof rule === "string") return { action: rule };
  // Each alias is evaluated independently; an allow for a literal alias must
  // never erase a deny established for the canonical target (or vice versa).
  return strictest(...targets.map(target => {
    let result: Decision = { action: fallback };
    for (const [pattern, action] of Object.entries(rule ?? {})) if (patternRegex(expandPath(pattern, home)).test(expandPath(target, home))) result = { action };
    return result;
  }));
}
export function groupDecision(name: string, group: PermissionGroup, surface: string, rule: Rule | undefined, targets: string[], home: string): Decision {
  const decisions = targets.map(target => {
    let match: string | undefined;
    let action: Action = "allow";
    if (typeof rule === "string") { match = "*"; action = rule; }
    else for (const [pattern, value] of Object.entries(rule ?? {})) if (patternRegex(expandPath(pattern, home)).test(expandPath(target, home))) { match = pattern; action = value; }
    return match === undefined ? { action } : { action, reason: `${name} (${group.source}): ${surface} ${match} → ${action}`, trace: [{ group: name, source: group.source, surface, pattern: match, action }] };
  });
  return strictest(...decisions);
}
export function permissionDecision(ctx: PolicyContext, surface: string, targets: string[]): Decision {
  return strictest(...selectedGroups(ctx).map(([name, group]) => {
    const parser = group["tool-parser"];
    return groupDecision(name, group, surface, parser?.[surface] ?? parser?.["*"], targets, ctx.home);
  }));
}
function filePermission(ctx: PolicyContext, surface: string, variants: string[]): Decision {
  return strictest(...selectedGroups(ctx).flatMap(([name, g]) => variants.map(target => {
    const rule = g["tool-parser"]?.[surface] ?? g["tool-parser"]?.["*"];
    if (typeof rule !== "object") return groupDecision(name, g, surface, rule, [target], ctx.home);
    let result: Decision = { action: "allow" };
    for (const [pattern, action] of Object.entries(rule)) {
      const expanded = expandPath(pattern, ctx.home);
      const matchTarget = path.isAbsolute(expanded) ? target : path.relative(ctx.root, target).split(path.sep).join("/");
      if (patternRegex(expanded).test(matchTarget)) result = { action, reason: `${name} (${g.source}): ${surface} ${pattern} → ${action}`, trace: [{ group: name, source: g.source, surface, pattern, action }] };
    }
    return result;
  })));
}
/** Region intersection uses containment, preserving omitted versus empty. */
export function intersectRoots(a: string[] | undefined, b: string[]): string[] {
  if (a === undefined) return [...new Set(b)];
  return [...new Set(a.flatMap(x => b.flatMap(y => within(x, y) ? [y] : within(y, x) ? [x] : [])))];
}
export function filesystemPolicy(ctx: PolicyContext, bash = false) {
  let roots: string[] | undefined;
  let extensions: string[] | undefined;
  const denyRead = [...ctx.denyRead], denyWrite: string[] = [], directoryNames: string[] = [], protectedWrite: string[] = [];
  for (const [, g] of selectedGroups(ctx)) {
    const sections = bash ? [g.filesystem, g["bash-sandbox"]?.filesystem] : [g.filesystem];
    for (const fs of sections) {
      if (!fs) continue;
      if (fs.writeRoots !== undefined) roots = intersectRoots(roots, fs.writeRoots.map(p => canonicalPath(resolvePath(ctx, g, p))));
      denyRead.push(...(fs.denyRead ?? []).flatMap(p => pathVariants(g.base, resolvePath(ctx, g, p), ctx.home)));
      denyWrite.push(...(fs.denyWrite ?? []).flatMap(p => pathVariants(g.base, resolvePath(ctx, g, p), ctx.home)));
    }
    const fs = g.filesystem;
    if (fs?.writeExtensions !== undefined) {
      const allowed = fs.writeExtensions.map(e => e.toLowerCase());
      extensions = extensions === undefined ? allowed : extensions.filter(e => allowed.includes(e));
    }
    directoryNames.push(...(fs?.denyDirectoryNames ?? []));
    protectedWrite.push(...(fs?.protectedWrite ?? []));
  }
  return { writeRoots: roots ?? [path.parse(ctx.root).root], extensions, denyRead: [...new Set(denyRead)], denyWrite: [...new Set(denyWrite)], directoryNames: [...new Set(directoryNames)], protectedWrite: [...new Set(protectedWrite)] };
}
export function readDenies(ctx: PolicyContext): string[] { return filesystemPolicy(ctx).denyRead; }
function restriction(name: string, g: PermissionGroup, field: string, pattern: string): Decision {
  return { action: "deny", reason: `${name} (${g.source}): filesystem.${field} ${pattern} → deny`, trace: [{ group: name, source: g.source, surface: `filesystem.${field}`, pattern, action: "deny" }] };
}
function hardReadDecision(ctx: PolicyContext, raw: string): Decision | undefined {
  const targets = pathVariants(ctx.root, raw, ctx.home);
  for (const [name, g] of selectedGroups(ctx)) {
    for (const denied of g.filesystem?.denyRead ?? []) if (targets.some(t => pathVariants(g.base, resolvePath(ctx, g, denied), ctx.home).some(d => within(d, t)))) return restriction(name, g, "denyRead", denied);
    for (const denied of g.filesystem?.denyDirectoryNames ?? []) if (targets.some(t => pathVariants(ctx.root, ctx.root).some(root => within(root, t) && path.relative(root, t).split(path.sep).some(p => p.toLowerCase() === denied.toLowerCase())))) return restriction(name, g, "denyDirectoryNames", denied);
  }
  if (targets.some(t => ctx.denyRead.some(d => pathVariants(ctx.root, d, ctx.home).some(p => within(p, t))))) return { action: "deny", reason: "Explicit context read deny" };
  return undefined;
}
export function hardReadReason(ctx: PolicyContext, raw: string): string | undefined { return hardReadDecision(ctx, raw)?.reason; }
function usableGrant(g: ReadGrant): boolean {
  try {
    if (canonicalPath(g.path) !== g.path) return false;
    const st = statSync(g.path);
    return g.kind === "directory" ? st.isDirectory() : st.isFile();
  } catch { return false; }
}
export function readDecision(ctx: PolicyContext, raw: string, once: ReadGrant[] = [], surface = "read"): Decision {
  if (isYolo(ctx)) return { action: "allow" };
  const denied = hardReadDecision(ctx, raw);
  if (denied) return denied;
  const target = canonicalPath(absolutePath(ctx.root, raw, ctx.home));
  const covered = (grants: ReadGrant[]) => grants.some(g => usableGrant(g) && grantCovers(g, target));
  const external = selectedGroups(ctx).map(([name, g]) => {
    const fs = g.filesystem;
    if (fs?.readRoots === undefined || covered(ctx.readRoots)) return { action: "allow" } as Decision;
    const inside = fs.readRoots.some(p => {
      const root = canonicalPath(resolvePath(ctx, g, p));
      try { return statSync(root).isFile() ? root === target : within(root, target); }
      catch { return within(root, target); }
    });
    return groupDecision(name, g, "filesystem.externalRead", inside ? undefined : fs.externalRead, [target], ctx.home);
  });
  const variants = pathVariants(ctx.root, raw, ctx.home);
  const decision = strictest(...external, filePermission(ctx, surface, variants));
  return decision.action === "ask" && covered(once) ? { ...decision, action: "allow" } : decision;
}
export function writeRoots(ctx: PolicyContext): string[] { return filesystemPolicy(ctx).writeRoots; }
export function protectedPattern(ctx: PolicyContext, target: string, patterns: string[]): boolean {
  const normalized = target.toLowerCase().split(path.sep).join("/");
  const relative = path.relative(ctx.root, target).toLowerCase().split(path.sep).join("/");
  return patterns.some(p => patternRegex(p.toLowerCase()).test(normalized) || patternRegex(p.toLowerCase()).test(relative));
}
export function writeDecision(ctx: PolicyContext, raw: string, surface = "write"): Decision {
  if (isYolo(ctx)) return { action: "allow" };
  const targets = pathVariants(ctx.root, raw, ctx.home);
  if (targets.some(t => pathVariants(ctx.root, path.dirname(ctx.trustFile), ctx.home).some(p => within(p, t)))) return { action: "deny", reason: "Trust decisions can only be changed through the pi-perm UI" };
  const denied = hardReadDecision(ctx, raw);
  if (denied) return denied;
  for (const [name, g] of selectedGroups(ctx)) {
    const fs = g.filesystem;
    if (!fs) continue;
    for (const pattern of fs.protectedWrite ?? []) if (targets.some(t => protectedPattern(ctx, t, [pattern]))) return restriction(name, g, "protectedWrite", pattern);
    if (fs.writeRoots !== undefined && !targets.every(t => fs.writeRoots!.some(p => within(canonicalPath(resolvePath(ctx, g, p)), t)))) return restriction(name, g, "writeRoots", JSON.stringify(fs.writeRoots));
    for (const p of fs.denyWrite ?? []) if (targets.some(t => pathVariants(g.base, resolvePath(ctx, g, p), ctx.home).some(d => within(d, t)))) return restriction(name, g, "denyWrite", p);
    if (fs.writeExtensions !== undefined && targets.some(t => !fs.writeExtensions!.map(e => e.toLowerCase()).includes(path.extname(t).toLowerCase()))) return restriction(name, g, "writeExtensions", JSON.stringify(fs.writeExtensions));
  }
  return filePermission(ctx, surface, targets);
}
export function toolDecision(ctx: PolicyContext, name: string, raw?: string, input = ""): Decision {
  if (isYolo(ctx)) return { action: "allow" };
  if (READ_TOOLS.has(name)) return readDecision(ctx, raw ?? ".", [], name);
  if (WRITE_TOOLS.has(name)) return raw ? writeDecision(ctx, raw, name) : { action: "deny", reason: "Missing file path" };
  if (name === "skill" || name.startsWith("skill:")) {
    let target = name.slice(6) || input || name;
    if (name === "skill") {
      try { const value = JSON.parse(input); target = typeof value.name === "string" ? value.name : typeof value.skill === "string" ? value.skill : target; }
      catch { /* Direct callers may already supply the literal skill name. */ }
    }
    return strictest(permissionDecision(ctx, name, [input]), ...selectedGroups(ctx).map(([n, g]) => groupDecision(n, g, "skills", g.skills, [target], ctx.home)));
  }
  return permissionDecision(ctx, name, [input]);
}
