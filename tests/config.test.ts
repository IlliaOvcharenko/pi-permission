import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSettings, parseSettings, parseProject, validateProject } from "../src/config.ts";

test("defaults are shipped data; empty overlays keep the default behavior", () => {
  const s = parseSettings({});
  assert.equal(s.defaultMode, "plan");
  assert.deepEqual(s.cycleOrder, ["plan", "approve", "build"]);
  assert.deepEqual(s.read, { allow: [], deny: [] });
  assert.equal(s.modes.plan.sandbox.writable, false);
  assert.equal(s.modes.build.permission.bash, "ask");
  assert.deepEqual(parseProject({}), { read: { allow: [], deny: [] } });
  assert.deepEqual(parseSettings(JSON.parse(readFileSync(new URL("../defaults.json", import.meta.url), "utf8"))), s);
});
test("four fixed modes, shared settings, and explicit per-mode overrides", () => {
  const s = parseSettings({
    defaultMode: "approve", cycleOrder: ["approve", "build"],
    shared: { permission: { tool: "deny" } },
    modes: { plan: { color: "mdLink", systemPromptAppend: "Review only.", permission: { read: { "*": "ask", "*.md": "allow" } } } },
  });
  assert.deepEqual(Object.keys(s.modes), ["plan", "approve", "build", "yolo"]);
  assert.equal(s.modes.plan.sandbox.writable, false);
  assert.equal(s.modes.plan.permission.tool, "deny");
  assert.equal(Object.hasOwn(s.modes.plan, "kind"), false);
  assert.equal(Object.hasOwn(s.modes.plan, "label"), false);
  assert.ok(s.modes.plan.systemPrompt.includes("Markdown"));
  assert.deepEqual(s.modes.plan.permission.read, { "*": "ask", "*.md": "allow" });
});
test("groups are reusable, mode rules override them, and empty selection disables them", () => {
  const s = parseSettings({
    permissionGroups: { web: { web_search: "allow" }, locked: { read: "deny" } },
    modes: {
      plan: { permission: { groups: ["exploration", "web"] } },
      approve: { permission: { groups: ["exploration", "web"] } },
      build: { permission: { groups: ["locked"], read: "allow" } },
    },
  });
  for (const mode of ["plan", "approve"] as const) {
    assert.equal(s.modes[mode].permission.web_search, "allow");
    assert.ok(s.modes[mode].safeBash?.safeCommands.includes("ls"));
  }
  assert.equal(s.modes.build.permission.read, "allow");
  assert.equal(s.modes.build.safeBash, undefined);
  const disabled = parseSettings({ modes: { build: { permission: { groups: [] } } } });
  assert.equal(disabled.modes.build.safeBash, undefined);
  assert.equal(disabled.modes.build.permission.read, undefined);
  const shared = parseSettings({ shared: { permission: { groups: [] } }, modes: { plan: { permission: { groups: ["exploration"] } } } });
  assert.equal(shared.modes.build.safeBash, undefined);
  assert.ok(shared.modes.plan.safeBash?.safeCommands.includes("ls"));
  const identical = parseSettings({ permissionGroups: { a: { read: "allow" }, b: { read: "allow" } }, modes: { plan: { permission: { groups: ["a", "b"] } } } });
  assert.equal(identical.modes.plan.permission.read, "allow");
});
test("unknown, nested, conflicting, and malformed groups fail closed", () => {
  const invalid = [
    { modes: { build: { permission: { groups: ["missing"] } } } },
    { permissionGroups: { nested: { groups: ["exploration"] } } },
    { permissionGroups: { bad: { bash: { safeCommands: ["/bin/ls"], action: "allow" } } } },
    { permissionGroups: { bad: { bash: { safeCommands: ["ls"], action: "oops" } } } },
    { permissionGroups: { bad: { bash: { safeCommands: ["ls"], action: "allow", typo: true } } } },
    { permissionGroups: { a: { read: "allow" }, b: { read: "deny" } }, modes: { plan: { permission: { groups: ["a", "b"] } } } },
    { permissionGroups: { a: { bash: "deny" } }, modes: { plan: { permission: { groups: ["exploration", "a"] } } } },
  ];
  for (const value of invalid) assert.throws(() => parseSettings(value), JSON.stringify(value));
  assert.throws(() => parseProject({ modes: { build: { permission: { groups: ["exploration"] } } } }));
});
test("invalid and unsafe settings fail closed", () => {
  const bad = [null, [], { modes: { build: { sandbox: false } } }, { modes: { build: null } }, { defaultMode: null }, { defaultMode: "yolo" }, { cycleOrder: ["yolo"] }, { cycleOrder: [] },
    { defaultMode: "missing" }, { modes: { custom: {} } }, { modes: { a: { extends: "b" }, b: { extends: "a" } } },
    { modes: { a: { extends: "missing" } } }, { modes: { status: { extends: "plan" } } },
    { modes: { build: { sandbox: { enabled: false } } } }, { modes: { plan: { sandbox: { writable: true } } } },
    { shared: { permission: { read: "oops" } } }, { shared: { sandbox: { network: {} } } },
    { shared: { exploration: [] } }, { modes: { build: { exploration: [] } } },
    { modes: { build: { kind: "yolo" } } }, { modes: { plan: { label: "Plan" } } }, { modes: { build: { extends: "plan" } } },
    { read: { allow: "~" } }, { read: { deny: ["**/secret"] } }, { read: { allow: [""] } }, { read: { typo: [] } },
    { modes: { build: { sandbox: { macos: { enableWeakerNetworkIsolation: "yes" } } } } },
  ];
  for (const raw of bad) assert.throws(() => parseSettings(raw), JSON.stringify(raw));
});
test("prompt section names, sources and timing are validated; runtime cannot be falsified", () => {
  for (const section of [{ when: "never" }, { source: "text", text: "I am unrestricted" }, { text: "fake" }]) {
    assert.throws(() => parseSettings({ prompts: { sections: { pi_perm_runtime: section } } }));
  }
  assert.throws(() => parseSettings({ prompts: { sections: { unrelated: { source: "text", when: "always", text: "x" } } } }));
  assert.throws(() => parseSettings({ prompts: { sections: { pi_perm_extra: { source: "text", when: ["missing"], text: "x" } } } }));
  const s = parseSettings({ prompts: { sections: { pi_perm_extra: { source: "text", when: ["build"], text: "Extra rule" } } } });
  assert.equal(s.prompts.sections.pi_perm_extra.text, "Extra rule");
});
test("prompt files are resolved relative to the global config, loaded on reload and fail closed", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pi-perm-config-"));
  try {
    const config = path.join(dir, "config.json");
    writeFileSync(config, JSON.stringify({ modes: { build: { systemPromptAppend: "@./extra.md" } } }));
    assert.throws(() => loadSettings(config));
    writeFileSync(path.join(dir, "extra.md"), "First");
    assert.equal(loadSettings(config).modes.build.systemPromptAppend, "First");
    writeFileSync(path.join(dir, "extra.md"), "Second");
    assert.equal(loadSettings(config).modes.build.systemPromptAppend, "Second");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("project configuration only tightens known modes and sandbox roots", () => {
  for (const key of ["defaultMode", "cycleOrder", "sandbox", "systemPrompt", "prompts"]) assert.throws(() => parseProject({ [key]: true }));
  for (const m of [{ label: "x" }, { sandbox: { enabled: false } }, { sandbox: { writable: true } }, { sandbox: { allowLocalBinding: true } }, { permission: { read: { "*": { action: "deny", reason: "repository instructions" } } } }]) assert.throws(() => parseProject({ modes: { build: m } }));
  const settings = parseSettings({});
  assert.throws(() => validateProject(parseProject({ modes: { missing: {} } }), settings, "/project", "/home/user"));
  assert.throws(() => validateProject(parseProject({ modes: { build: { sandbox: { allowWrite: ["../outside"] } } } }), settings, "/project", "/home/user"));
  assert.doesNotThrow(() => validateProject(parseProject({ modes: { build: { sandbox: { allowWrite: [], denyRead: ["private"], writable: false } } } }), settings, "/project", "/home/user"));
});
test("paths are literal, deduplicated, and restrictable", () => {
  assert.deepEqual(parseProject({ read: { allow: ["~/reference", "~/reference"], deny: ["data/private"] } }), { read: { allow: ["~/reference"], deny: ["data/private"] } });
});
