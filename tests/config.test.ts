import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSettings, parseSettings, resolveSettings } from "../src/config.ts";

const v2 = (value: object) => ({ configVersion: 2, ...value });
const group = (action: string) => ({ "tool-parser": { bash: action }, "bash-sandbox": { enabled: true } });
test("shipped defaults, example, and fixed modes resolve", () => {
  const s = parseSettings({});
  assert.equal(s.defaultMode, "plan");
  assert.deepEqual(s.cycleOrder, ["plan", "approve", "build"]);
  assert.deepEqual(s.modes.plan.permissionGroups, ["development", "planning"]);
  assert.deepEqual(Object.keys(s.modes), ["plan", "approve", "build", "yolo"]);
  for (const file of ["defaults.json", "config.example.json"]) assert.doesNotThrow(() => parseSettings(JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"))));
});
test("identical schema, atomic local replacement including relaxation, mode arrays replace and omissions inherit", () => {
  for (const inherited of ["ask", "deny"]) {
    const global = v2({ permissionGroups: { development: group(inherited) }, modes: { build: { color: "#123AbC", systemPromptAppend: "Inherited" } } });
    const local = v2({ permissionGroups: { development: group("allow") }, modes: { build: { permissionGroups: ["development"] } } });
    const s = parseSettings(global, local);
    assert.equal(s.permissionGroups.development["tool-parser"]!.bash, "allow");
    assert.equal(s.permissionGroups.development.filesystem, undefined);
    assert.equal(s.permissionGroups.development.source, "project config");
    assert.equal(s.modes.build.color, "#123AbC");
    assert.equal(s.modes.build.systemPromptAppend, "Inherited");
    assert.equal(s.modes.build.sources.color, "global config");
    assert.deepEqual(s.replacements.at(-1), { group: "development", previousSource: "global config", source: "project config" });
    assert.equal(s.promptSources["modes.build.systemPromptAppend"].source, "global config");
    assert.deepEqual(s.modes.build.permissionGroups, ["development"]);
    assert.doesNotThrow(() => parseSettings(local));
  }
});
test("references are validated after all layers, conflicting groups are independent not errors", () => {
  const s = resolveSettings([
    { value: v2({ modes: { build: { permissionGroups: ["later", "development"] } } }), source: "global", base: "/global" },
    { value: v2({ permissionGroups: { later: { "tool-parser": { bash: "deny" } } } }), source: "project", base: "/project" },
  ]);
  assert.equal(s.permissionGroups.later.base, "/project");
  assert.deepEqual(s.modes.build.permissionGroups, ["later", "development"]);
});
test("obsolete keys, malformed maps, paths, variables, references, colors and sandbox disabling fail closed at either scope", () => {
  const invalid: unknown[] = [null, [], { modes: {} }, v2({ read: {} }), v2({ shared: {} }), v2({ defaultMode: "yolo" }), v2({ cycleOrder: [] }), v2({ cycleOrder: ["yolo"] }), v2({ modes: { custom: {} } }), v2({ modes: { build: { permission: {} } } }), v2({ modes: { build: { permissionGroups: [] } } }), v2({ modes: { build: { permissionGroups: ["unknown"] } } }), v2({ permissionGroups: { development: {} } }), v2({ permissionGroups: { development: { "bash-sandbox": { enabled: false } } } })];
  for (const color of ["#abc", "#1234567", "#gg1122", "\x1b[31m", "blue"]) invalid.push(v2({ modes: { build: { color } } }));
  for (const rule of [{ "123": "allow" }, { "": "allow" }, { "x": { action: "allow" } }, { "x": "oops" }, { "npm test; rm": "allow" }, { "'unclosed": "allow" }, { safeCommands: ["ls"] }]) invalid.push(v2({ permissionGroups: { test: { "tool-parser": { bash: rule } } } }));
  for (const p of ["${unknown}/x", "$HOME/x", "${home", "src/*"]) invalid.push(v2({ permissionGroups: { test: { filesystem: { writeRoots: [p] } } } }));
  invalid.push(v2({ permissionGroups: { test: { "tool-parser": { custom: { "*": "allow" } } } } }));
  for (const value of invalid) {
    assert.throws(() => parseSettings(value), JSON.stringify(value));
    assert.throws(() => parseSettings({}, value), JSON.stringify(value));
  }
  for (const color of ["muted", "mdLink", "accent", "error", "#123ABC"]) assert.doesNotThrow(() => parseSettings(v2({ modes: { build: { color } } })));
});
test("prompt namespace, source/timing merges and reserved facts are validated", () => {
  for (const section of [{ when: "never" }, { source: "text", text: "fake" }, { text: "fake" }]) assert.throws(() => parseSettings(v2({ prompts: { sections: { pi_perm_runtime: section } } })));
  assert.throws(() => parseSettings(v2({ prompts: { sections: { unrelated: { source: "text", when: "always", text: "x" } } } })));
  assert.throws(() => parseSettings(v2({ prompts: { sections: { pi_perm_extra: { source: "text", when: ["missing"], text: "x" } } } })));
  const s = parseSettings(v2({ prompts: { sections: { pi_perm_shared: { when: "never" } } } }));
  assert.ok(s.prompts.sections.pi_perm_shared.text);
  assert.equal(s.prompts.sections.pi_perm_shared.when, "never");
});
test("global relative paths and inherited prompt files keep original provenance after local overrides", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pi-perm-config-"));
  try {
    mkdirSync(path.join(dir, "project"));
    const global = path.join(dir, "global.json"), project = path.join(dir, "project", "local.json");
    writeFileSync(global, JSON.stringify(v2({ permissionGroups: { refs: { filesystem: { readRoots: ["relative"] } } }, modes: { build: { systemPromptAppend: "@./extra.md" } } })));
    writeFileSync(project, JSON.stringify(v2({ modes: { build: { color: "#abcdef" } } })));
    assert.throws(() => loadSettings(global, project));
    writeFileSync(path.join(dir, "extra.md"), "First");
    const s = loadSettings(global, project);
    assert.equal(s.permissionGroups.refs.base, dir);
    assert.equal(s.permissionGroups.refs.source, global);
    assert.equal(s.modes.build.systemPromptAppend, "First");
    writeFileSync(path.join(dir, "extra.md"), "Second");
    assert.equal(loadSettings(global, project).modes.build.systemPromptAppend, "Second");
    assert.equal(s.modes.build.systemPromptAppend, "First");
    rmSync(path.join(dir, "extra.md"));
    writeFileSync(project, JSON.stringify(v2({ modes: { build: { systemPromptAppend: "Overridden" } } })));
    assert.equal(loadSettings(global, project).modes.build.systemPromptAppend, "Overridden");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
