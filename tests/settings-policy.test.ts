import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { parseSettings, parseProject } from "../src/config.ts";
import { readDecision, ruleDecision, toolDecision, writeDecision } from "../src/policy.ts";
import { bashDecision, type NodeLike } from "../src/bash.ts";
import { sandboxProfile } from "../src/sandbox.ts";
import { canonicalPath } from "../src/paths.ts";
import type { PolicyContext } from "../src/types.ts";
function context(value: unknown = {}): PolicyContext {
  return { root: canonicalPath(process.cwd()), scratch: canonicalPath(os.tmpdir()), home: "/home/test", agentDir: "/home/test/.pi/agent", mode: "build", settings: parseSettings(value), readRoots: [], denyRead: [], trustFile: "/home/test/.pi/agent/pi-perm/trust/projects.json" };
}
const tree: NodeLike = { type: "program", text: "ls", children: [{ type: "command", text: "ls", children: [{ type: "command_name", text: "ls", children: [{ type: "word", text: "ls", children: [] }] }] }] };
const parser = { parse: () => ({ rootNode: tree }) };

test("ordered policy globs cross slashes, accept relative aliases, and preserve reasons", () => {
  const c = context({ modes: { build: { permission: { read: { "src/*": "allow" }, write: { "*": "ask", "src/*": "allow" }, path: { "*": "allow", "*.private": { action: "deny", reason: "Private data" } } } } } });
  assert.equal(readDecision(c, path.join(c.root, "src", "nested", "file.ts")).action, "allow");
  assert.equal(readDecision(c, "other/file.ts").action, "ask");
  assert.equal(writeDecision(c, "src/nested/file.ts").action, "allow");
  assert.equal(writeDecision(c, "other/file.ts").action, "ask");
  assert.deepEqual(readDecision(c, "src/x.private"), { action: "deny", reason: "Private data" });
  assert.equal(ruleDecision({ "**/x": "deny" }, ["x"], c.home).action, "deny");
  assert.equal(ruleDecision({ "a[0]": "allow" }, ["a[0]"], c.home).action, "allow");
});
test("named tools, generic fallback, skills, and project tightening", () => {
  const c = context({ modes: { build: { permission: { tool: { "*": "deny", "custom": "allow" }, web_search: "allow", skill: { "*": "ask", "review": "allow" } } } } });
  assert.equal(toolDecision(c, "custom").action, "allow");
  assert.equal(toolDecision(c, "other").action, "deny");
  assert.equal(toolDecision(c, "web_search").action, "allow");
  assert.equal(toolDecision(c, "skill:review").action, "allow");
  assert.equal(toolDecision(c, "skill:other").action, "ask");
  c.project = parseProject({ modes: { build: { permission: { tool: "deny", web_search: "allow" } } } });
  assert.equal(toolDecision(c, "web_search").action, "deny");
  assert.equal(toolDecision(c, "custom").action, "deny");
});
test("sandbox roots and denies are shared by file wrappers and generated runtime profile", () => {
  const c = context({ modes: { build: { sandbox: { allowWrite: ["src"], denyWrite: ["src/frozen"], denyRead: ["private-data"], allowLocalBinding: true, macos: { enableWeakerNetworkIsolation: true }, linux: { allowNestedUserNamespaces: true } } } } });
  assert.equal(writeDecision(c, "src/file.ts").action, "allow");
  assert.equal(writeDecision(c, "other/file.ts").action, "deny");
  assert.equal(writeDecision(c, "src/frozen/file.ts").action, "deny");
  assert.equal(readDecision(c, "private-data/secret").action, "deny");
  const p = sandboxProfile(c);
  assert.deepEqual(p.filesystem.allowWrite, [{ path: path.join(c.root, "src"), literal: true }, { path: c.scratch, literal: true }]);
  assert.equal(p.network.allowLocalBinding, true);
  assert.equal(p.enableWeakerNetworkIsolation, true);
  assert.equal(p.allowNestedUserNamespaces, true);
  assert.ok(p.filesystem.denyRead.some(p => typeof p !== "string" && p.path === path.join(c.root, "private-data")));
  c.project = parseProject({ modes: { build: { sandbox: { writable: false, allowWrite: [], denyWrite: ["more"], denyRead: ["extra"] } } } });
  assert.equal(readDecision(c, "extra/x").action, "deny");
  assert.equal(writeDecision(c, "src/file.ts").action, "deny");
  assert.deepEqual(sandboxProfile(c).filesystem.allowWrite, [{ path: c.scratch, literal: true }]);
  const invalid = context({ modes: { build: { sandbox: { allowWrite: ["/"] } } } });
  assert.throws(() => sandboxProfile(invalid), /inside the project/);
});
test("configured Bash actions, disabled groups and project gates override safe commands", async () => {
  assert.equal((await bashDecision("ls", context(), parser)).action, "allow");
  assert.equal((await bashDecision("ls", context({ modes: { build: { permission: { groups: [] } } } }), parser)).action, "ask");
  assert.equal((await bashDecision("ls", context({ shared: { permission: { bash: { "*": "ask" } } } }), parser)).action, "ask");
  assert.equal((await bashDecision("ls", context({ shared: { permission: { bash: "deny" } } }), parser)).action, "deny");
  assert.equal((await bashDecision("python script.py", context({ shared: { permission: { bash: { "*": "ask", "python *": "allow" } } } }), { parse: () => null })).action, "allow");
  const c = context(); c.project = parseProject({ modes: { build: { permission: { bash: "ask" } } } });
  assert.equal((await bashDecision("ls", c, parser)).action, "ask");
  const deny = context({ shared: { permission: { path: { "*": "allow", "ls": "deny" } } } });
  assert.equal((await bashDecision("ls", deny, parser)).action, "deny");
});
test("per-mode command globs coexist with grouped safe commands and override matches", async () => {
  const c = context({ modes: { build: { permission: { bash: { "npm test": "allow", "ls secret": "ask" } } } } });
  assert.equal((await bashDecision("ls", c, parser)).action, "allow");
  assert.equal((await bashDecision("ls secret", c, parser)).action, "ask");
  assert.equal((await bashDecision("npm test", c, { parse: () => null })).action, "allow");
  assert.equal((await bashDecision("python script.py", c, { parse: () => null })).action, "ask");
  c.mode = "plan";
  assert.equal((await bashDecision("npm test", c, { parse: () => null })).action, "ask");
  const denied = context({ permissionGroups: { exploration: { bash: { safeCommands: ["ls"], action: "deny" } } } });
  assert.equal((await bashDecision("ls", denied, parser)).action, "deny");
  assert.equal((await bashDecision("ls", context(), { parse: () => null })).action, "ask");
});
test("pinned runtime accepts generated filesystem and platform settings", t => {
  const require = createRequire(import.meta.url);
  let schema: any;
  try { schema = require("@anthropic-ai/sandbox-runtime").SandboxRuntimeConfigSchema; }
  catch { t.skip("Runtime dependency unavailable; no OS sandbox is invoked by this test"); return; }
  while (!schema.shape && schema.innerType) schema = schema.innerType();
  const p = sandboxProfile(context());
  // Runtime's public schema requires allowedDomains, whereas its direct API
  // deliberately supports omission for unfiltered networking. Validate the
  // independently exposed filesystem schema without changing network semantics.
  assert.equal(schema.shape.filesystem.safeParse(p.filesystem).success, true);
  assert.equal(schema.shape.enableWeakerNetworkIsolation.safeParse(p.enableWeakerNetworkIsolation).success, true);
  assert.equal(schema.shape.allowNestedUserNamespaces.safeParse(p.allowNestedUserNamespaces).success, true);
});
