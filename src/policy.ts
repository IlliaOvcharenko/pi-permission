import path from "node:path";
import { statSync } from "node:fs";
import type { Decision, PolicyContext, ReadGrant, Rule } from "./types.ts";
import { absolutePath, canonicalPath, expandPath, markdown, pathVariants, protectedWrite, restrictedInProject, within } from "./paths.ts";
import { grantCovers } from "./grants.ts";
import { isYolo, modeSettings } from "./config.ts";

export const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
export const WRITE_TOOLS = new Set(["write", "edit"]);
const RANK = { allow: 0, ask: 1, deny: 2 };
export function strictest(...decisions: Decision[]): Decision {
  return decisions.reduce((a, b) => RANK[b.action] >= RANK[a.action] ? b : a, { action: "allow" } as Decision);
}
/** Policy globs intentionally differ from search globs: * crosses slashes. */
function patternRegex(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    if (pattern.slice(i, i + 3) === "**/" && (i === 0 || pattern[i - 1] === "/")) { out += "(?:.*/)?"; i += 2; }
    else if (pattern[i] === "*") out += ".*";
    else if (pattern[i] === "?") out += ".";
    else out += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(out + "$", "s");
}
export function hasPatternMatch(rule: Rule | undefined, target: string, home: string): boolean {
  return typeof rule === "object" && Object.keys(rule).some(pattern => patternRegex(expandPath(pattern, home)).test(expandPath(target, home)));
}
export function ruleDecision(rule: Rule | undefined, targets: string[], home: string, fallback: Decision["action"] = "ask"): Decision {
  if (typeof rule === "string") return { action: rule };
  if (!rule) return { action: fallback };
  let result: Decision = { action: fallback };
  for (const [pattern, value] of Object.entries(rule)) {
    const regex = patternRegex(expandPath(pattern, home));
    if (targets.some(target => regex.test(expandPath(target, home)))) result = typeof value === "string" ? { action: value } : value;
  }
  return result;
}
export function permissionDecision(ctx: PolicyContext, surface: string, targets: string[], fallback: Decision["action"] = "ask"): Decision {
  const base = ruleDecision(modeSettings(ctx).permission[surface], targets, ctx.home, fallback);
  const overlay = ctx.project?.modes?.[ctx.mode]?.permission;
  return strictest(base, ruleDecision(overlay?.[surface], targets, ctx.home, "allow"));
}
function fileTargets(ctx: PolicyContext, raw: string): string[] {
  const variants = pathVariants(ctx.root, raw, ctx.home);
  return [...new Set([raw, ...variants, ...variants.map(p => path.relative(ctx.root, p).split(path.sep).join("/"))])];
}
function filePolicy(ctx: PolicyContext, surface: string, raw: string, outside: boolean): Decision {
  const targets = fileTargets(ctx, raw);
  return strictest(permissionDecision(ctx, surface, targets), permissionDecision(ctx, "path", targets, "allow"), outside ? permissionDecision(ctx, "external_directory", targets) : { action: "allow" });
}
export function globalReadDenies(home: string, agentDir: string): string[] {
  return [...new Set([path.join(home, ".ssh"), ...[path.join(home, ".pi", "agent"), agentDir].flatMap(dir => [path.join(dir, "auth.json"), path.join(dir, "oauth.json")])])];
}
export function readDenies(ctx: PolicyContext): string[] {
  return [...globalReadDenies(ctx.home, ctx.agentDir), ...ctx.denyRead, ...modeSettings(ctx).sandbox.denyRead.map(p => absolutePath(ctx.root, p, ctx.home))];
}
export function hardReadReason(ctx: PolicyContext, raw: string): string | undefined {
  const targets = pathVariants(ctx.root, raw, ctx.home);
  const roots = [path.resolve(ctx.root), canonicalPath(ctx.root)];
  if (targets.some(t => roots.some(r => restrictedInProject(r, t)))) return "Project archive, notes, .git, and credentials directories are unreadable";
  for (const denied of readDenies(ctx)) {
    const variants = pathVariants(ctx.root, denied, ctx.home);
    if (targets.some(t => variants.some(d => within(d, t)))) return `Read denied: ${denied}`;
  }
  return undefined;
}
function usableGrant(g: ReadGrant): boolean {
  try {
    if (canonicalPath(g.path) !== g.path) return false;
    const st = statSync(g.path);
    return g.kind === "directory" ? st.isDirectory() : st.isFile();
  } catch { return false; }
}
export function readDecision(ctx: PolicyContext, raw: string, once: ReadGrant[] = [], surface = "read"): Decision {
  if (isYolo(ctx)) return { action: "allow" };
  const denied = hardReadReason(ctx, raw);
  if (denied) return { action: "deny", reason: denied };
  const target = canonicalPath(absolutePath(ctx.root, raw, ctx.home));
  const covered = (grants: ReadGrant[]) => grants.some(g => usableGrant(g) && grantCovers(g, target));
  const inside = [ctx.root, ctx.scratch].some(r => within(canonicalPath(r), target)) || covered(ctx.readRoots);
  const decision = filePolicy(ctx, surface, raw, !inside);
  if (decision.action === "ask" && covered(once)) return { action: "allow" };
  return decision;
}
export function writeRoots(ctx: PolicyContext): string[] {
  const roots = modeSettings(ctx).sandbox.allowWrite.map(p => canonicalPath(absolutePath(ctx.root, p, ctx.home)));
  if (roots.some(p => !within(canonicalPath(ctx.root), p) && !within(canonicalPath(ctx.scratch), p))) throw new Error("Non-YOLO allowWrite roots must stay inside the project or session scratch");
  return [...new Set([...roots, canonicalPath(ctx.scratch)])];
}
export function writeDecision(ctx: PolicyContext, raw: string, surface = "write"): Decision {
  if (isYolo(ctx)) return { action: "allow" };
  const targets = pathVariants(ctx.root, raw, ctx.home);
  if (targets.some(t => pathVariants(ctx.root, path.dirname(ctx.trustFile), ctx.home).some(p => within(p, t)))) return { action: "deny", reason: "Trust decisions can only be changed through the pi-perm UI" };
  const denied = hardReadReason(ctx, raw);
  if (denied) return { action: "deny", reason: denied };
  if (targets.some(protectedWrite)) return { action: "deny", reason: "Protected path" };
  const mode = modeSettings(ctx);
  const target = targets.at(-1)!;
  if (!writeRoots(ctx).some(r => within(r, target))) return { action: "deny", reason: "Writes are limited to configured project roots and session scratch" };
  if (mode.sandbox.denyWrite.some(p => targets.some(t => pathVariants(ctx.root, p, ctx.home).some(d => within(d, t))))) return { action: "deny", reason: "Sandbox denyWrite path" };
  if (ctx.mode === "plan" && !markdown(target)) return { action: "deny", reason: "Plan allows requested Markdown changes only" };
  if (ctx.mode !== "plan" && !mode.sandbox.writable && !within(canonicalPath(ctx.scratch), target)) return { action: "deny", reason: "Mode is read-only" };
  return filePolicy(ctx, surface, raw, false);
}
export function toolDecision(ctx: PolicyContext, name: string, raw?: string, input = ""): Decision {
  if (isYolo(ctx)) return { action: "allow" };
  if (READ_TOOLS.has(name)) return readDecision(ctx, raw ?? ".", [], name);
  if (WRITE_TOOLS.has(name)) return raw ? writeDecision(ctx, raw, name) : { action: "deny", reason: "Missing file path" };
  if (name === "skill" || name.startsWith("skill:")) return permissionDecision(ctx, "skill", [name.slice(6) || input || name]);
  const mode = modeSettings(ctx);
  const base = Object.hasOwn(mode.permission, name) ? permissionDecision(ctx, name, [input]) : permissionDecision(ctx, "tool", [name]);
  // A named project rule also tightens tools that use the generic global rule.
  const overlay = ctx.project?.modes?.[ctx.mode]?.permission;
  return strictest(base, ruleDecision(overlay?.[name], [input], ctx.home, "allow"), ruleDecision(overlay?.tool, [name], ctx.home, "allow"));
}
