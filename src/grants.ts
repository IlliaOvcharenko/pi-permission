import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ReadGrant } from "./types.ts";
import { absolutePath, canonicalPath } from "./paths.ts";

interface Registry { version: 1; projects: Record<string, ReadGrant[]>; policies?: Record<string, string> }
export function describeGrant(raw: string, root: string, home?: string): ReadGrant {
  const target = canonicalPath(absolutePath(root, raw, home));
  const st = statSync(target);
  if (!st.isDirectory() && !st.isFile()) throw new Error(`Read grant must name an existing file or directory: ${raw}`);
  return { path: target, kind: st.isDirectory() ? "directory" : "file" };
}
export function sameGrant(a: ReadGrant, b: ReadGrant): boolean { return a.path === b.path && a.kind === b.kind; }
export function grantCovers(grant: ReadGrant, target: string): boolean {
  const rel = path.relative(grant.path, target);
  return rel === "" || (grant.kind === "directory" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
export function trustedGrants(requested: ReadGrant[], approved: ReadGrant[]): ReadGrant[] {
  // Exact entries, not ancestor coverage: replacing a requested file with a directory
  // or redirecting a symlink requires fresh trust. Removed requests stop applying.
  return requested.filter(g => approved.some(a => sameGrant(g, a)));
}
function readRegistry(file: string): Registry {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, projects: {} };
    throw new Error(`Cannot read pi-permission trust registry: ${String(error)}`);
  }
  const r = raw as Registry;
  if (!r || r.version !== 1 || !r.projects || typeof r.projects !== "object" || Array.isArray(r.projects)) throw new Error("Invalid pi-permission trust registry");
  for (const grants of Object.values(r.projects)) {
    if (!Array.isArray(grants) || grants.some(g => !g || typeof g.path !== "string" || !path.isAbsolute(g.path) || !["file", "directory"].includes(g.kind))) throw new Error("Invalid pi-permission trust entries");
  }
  if (r.policies !== undefined && (!r.policies || typeof r.policies !== "object" || Array.isArray(r.policies) || Object.values(r.policies).some(d => !/^[a-f0-9]{64}$/.test(d)))) throw new Error("Invalid project policy trust entries");
  return r;
}
export function approvedPolicy(file: string, project: string): string | undefined {
  return readRegistry(file).policies?.[canonicalPath(project)];
}
export function savePolicy(file: string, project: string, digest?: string): void {
  const registry = readRegistry(file);
  registry.policies ??= {};
  if (digest) registry.policies[canonicalPath(project)] = digest;
  else delete registry.policies[canonicalPath(project)];
  writeRegistry(file, registry);
}
export function readApproved(file: string, project: string): ReadGrant[] {
  return readRegistry(file).projects[canonicalPath(project)] ?? [];
}
export function saveApproved(file: string, project: string, grants: ReadGrant[]): void {
  const registry = readRegistry(file);
  registry.projects[canonicalPath(project)] = grants;
  writeRegistry(file, registry);
}
function writeRegistry(file: string, registry: Registry): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // This host-side store is separate from project settings and write-denied
  // to agent file tools and sandboxed Bash. Only a confirmed UI action calls this.
  if (canonicalPath(dir) !== path.resolve(dir)) throw new Error("Trust registry directory must not be a symlink");
  const temp = path.join(dir, `trust-${randomUUID()}.json`);
  writeFileSync(temp, JSON.stringify(registry, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  renameSync(temp, file);
}
