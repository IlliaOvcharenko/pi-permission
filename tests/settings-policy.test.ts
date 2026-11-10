import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { parseSettings, resolveSettings } from "../src/config.ts";
import { filesystemPolicy, intersectRoots, readDecision, ruleDecision, toolDecision, writeDecision } from "../src/policy.ts";
import { sandboxProfile } from "../src/sandbox.ts";
import { canonicalPath } from "../src/paths.ts";
import type { Action, PolicyContext } from "../src/types.ts";
const v2 = (value: object) => ({ configVersion: 2, ...value });
function context(value: unknown = {}): PolicyContext {
  return { root: canonicalPath(process.cwd()), scratch: canonicalPath(os.tmpdir()), home: "/home/test", agentDir: "/home/test/.pi/agent", mode: "build", settings: parseSettings(value), readRoots: [], denyRead: [], trustFile: "/home/test/.pi/agent/pi-permission/trust/projects.json" };
}
test("all action combinations across groups compose strictly, regardless of selection order", () => {
  const rank = { allow: 0, ask: 1, deny: 2 };
  for (const a of ["allow", "ask", "deny"] as Action[]) for (const b of ["allow", "ask", "deny"] as Action[]) for (const order of [["a", "b"], ["b", "a"]]) {
    const c = context(v2({ permissionGroups: { a: { "tool-parser": { custom: a } }, b: { "tool-parser": { custom: b } } }, modes: { build: { permissionGroups: ["development", ...order] } } }));
    const d = toolDecision(c, "custom");
    assert.equal(d.action, rank[a] > rank[b] ? a : b);
    assert.ok(d.trace?.some(t => t.group === "a" && t.action === a && t.source === "global config"));
    assert.ok(d.trace?.some(t => t.group === "b" && t.action === b));
  }
});
test("last match, scalar shorthand, named tool wildcard replacement, skills, and missing rules", () => {
  const c = context(v2({ permissionGroups: { rules: { "tool-parser": { "*": "deny", custom: "allow", read: { "*": "ask", "src/*": "allow", "src/private/*": "deny" } }, skills: { "*": "ask", review: "allow" } } }, modes: { build: { permissionGroups: ["development", "rules"] } } }));
  assert.equal(toolDecision(c, "custom").action, "allow");
  assert.equal(toolDecision(c, "other").action, "deny");
  assert.equal(readDecision(c, "src/nested/file.ts").action, "allow");
  assert.equal(readDecision(c, "other/file.ts").action, "ask");
  assert.equal(readDecision(c, "src/private/file.ts").action, "deny");
  const skills = context(v2({ permissionGroups: { rules: { skills: { "*": "ask", review: "allow" } } }, modes: { build: { permissionGroups: ["development", "rules"] } } }));
  assert.equal(toolDecision(skills, "skill:review").action, "allow");
  assert.equal(toolDecision(skills, "skill:other").action, "ask");
  assert.equal(toolDecision(context(), "unknown").action, "allow");
  assert.equal(ruleDecision({ "*": "deny", "**/x": "allow" }, ["x"], c.home).action, "allow");
  assert.equal(ruleDecision({ "a[0]": "deny" }, ["a[0]"], c.home).action, "deny");
});
test("same-name local replacement may relax global ask or deny; other groups remain restrictive", () => {
  for (const inherited of ["ask", "deny"]) {
    const global = v2({ permissionGroups: { custom: { "tool-parser": { custom: inherited } } }, modes: { build: { permissionGroups: ["development", "custom"] } } });
    const c = context();
    c.settings = parseSettings(global, v2({ permissionGroups: { custom: { "tool-parser": { custom: "allow" } } } }));
    assert.equal(toolDecision(c, "custom").action, "allow");
    c.settings = parseSettings(global, v2({ permissionGroups: { custom: { "tool-parser": { custom: "allow" } }, deny: { "tool-parser": { custom: "deny" } } }, modes: { build: { permissionGroups: ["development", "custom", "deny"] } } }));
    assert.equal(toolDecision(c, "custom").action, "deny");
  }
});
test("filesystem roots intersect by containment; denies union; Bash-only policy does not gate file tools", () => {
  const c = context(v2({ permissionGroups: {
    narrow: { filesystem: { writeRoots: ["${project}/src"], denyRead: ["${project}/private"], denyWrite: ["${project}/src/frozen"] }, "bash-sandbox": { filesystem: { writeRoots: ["${project}/src/nested"], denyRead: ["${project}/bash-private"] } } },
  }, modes: { build: { permissionGroups: ["development", "narrow"] } } }));
  assert.deepEqual(filesystemPolicy(c).writeRoots, [path.join(c.root, "src")]);
  assert.equal(writeDecision(c, "src/file.ts").action, "allow");
  assert.equal(writeDecision(c, "other/file.ts").action, "deny");
  assert.equal(writeDecision(c, "src/frozen/file.ts").action, "deny");
  assert.equal(readDecision(c, "private/secret").action, "deny");
  assert.equal(readDecision(c, "bash-private/secret").action, "allow");
  const p = sandboxProfile(c);
  assert.deepEqual(p.filesystem.allowWrite, [{ path: path.join(c.root, "src/nested"), literal: true }]);
  assert.ok(p.filesystem.denyRead.some(p => typeof p !== "string" && p.path === path.join(c.root, "bash-private")));
  assert.deepEqual(intersectRoots(["/p", "/scratch"], ["/p/src"]), ["/p/src"]);
  assert.deepEqual(intersectRoots(["/p"], []), []);
  assert.deepEqual(intersectRoots(undefined, ["/p"]), ["/p"]);
});
test("empty roots forbid writes and never silently add scratch; policy defaults can be replaced", () => {
  const c = context(v2({ permissionGroups: { development: { "bash-sandbox": { enabled: true, filesystem: { writeRoots: [] } }, filesystem: { writeRoots: [] } } } }));
  assert.deepEqual(sandboxProfile(c).filesystem.allowWrite, []);
  assert.equal(writeDecision(c, path.join(c.scratch, "x")).action, "deny");
  // Exercise configurable formerly denied names on disposable scratch paths,
  // never on the host checkout's sandbox-denied directories.
  c.root = path.join(c.scratch, "pi-permission-disposable-policy");
  assert.equal(readDecision(c, "notes/x").action, "allow");
  c.settings = parseSettings(v2({ permissionGroups: { development: { "bash-sandbox": { enabled: true } } } }));
  assert.equal(writeDecision(c, path.join(c.root, ".env")).action, "allow");
  assert.equal(writeDecision(c, c.trustFile).action, "deny");
});
test("relative global filesystem paths preserve their source base after project overlays", () => {
  const c = context();
  c.settings = resolveSettings([{ value: v2({ permissionGroups: { refs: { filesystem: { denyRead: ["private"] } } }, modes: { build: { permissionGroups: ["development", "refs"] } } }), source: "/global/config.json", base: "/global" }, { value: v2({ modes: { build: { color: "#112233" } } }), source: "/project/config.json", base: "/project" }]);
  assert.ok(filesystemPolicy(c).denyRead.includes("/global/private"));
  assert.equal(readDecision(c, "/global/private/x").action, "deny");
});
test("pinned runtime accepts compiled filesystem and platform fields (not an OS containment test)", () => {
  const require = createRequire(import.meta.url);
  let schema = require("@anthropic-ai/sandbox-runtime").SandboxRuntimeConfigSchema;
  while (!schema.shape && schema.innerType) schema = schema.innerType();
  const p = sandboxProfile(context());
  assert.equal(schema.shape.filesystem.safeParse(p.filesystem).success, true);
  assert.equal(schema.shape.allowNestedUserNamespaces.safeParse(p.allowNestedUserNamespaces).success, true);
});
