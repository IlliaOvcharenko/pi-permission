import test from "node:test";
import assert from "node:assert/strict";
import { parseSettings } from "../src/config.ts";
import { applyPromptSections, promptSections } from "../src/prompts.ts";
import type { Mode, PolicyContext } from "../src/types.ts";
const context = (settings = parseSettings({}), mode: Mode = "build"): PolicyContext => ({ root: "/project", scratch: "/scratch", home: "/home/test", agentDir: "/home/test/.pi/agent", mode, readRoots: [], denyRead: [], trustFile: "/home/test/.pi/agent/pi-permission/trust/projects.json", settings });
test("exact namespaces, section merging, timing and unrelated text preservation", () => {
  const settings = parseSettings({ configVersion: 2, prompts: { removeLegacySections: [], sections: {
    pi_permission_shared: { when: "never" }, pi_permission_extra: { source: "text", when: ["approve"], text: "Extra" }, pi_permission_always: { source: "text", when: "always", text: "Always" },
  } } });
  const sections: Record<string, string> = { unrelated: "Keep", permission_mode: "Keep too", pi_permission_stale: "Drop" };
  applyPromptSections(sections, context(settings, "approve"));
  assert.equal(sections.pi_permission_extra, "Extra");
  assert.equal(sections.pi_permission_shared, undefined);
  assert.ok(sections.pi_permission_mode.includes("standalone approval"));
  assert.equal(sections.pi_permission_stale, undefined);
  applyPromptSections(sections, context(settings, "yolo"));
  assert.deepEqual(sections, { unrelated: "Keep", permission_mode: "Keep too", pi_permission_always: "Always" });
});
test("runtime reports permissions without configuration provenance and separates file-tool and Bash restrictions", () => {
  const settings = parseSettings({}, { configVersion: 2, permissionGroups: { local: { "tool-parser": { custom: "deny" }, "bash-sandbox": { filesystem: { denyRead: ["${project}/bash-only"] } } } }, modes: { plan: { permissionGroups: ["development", "planning", "local"] } } });
  const text = promptSections(context(settings, "plan")).pi_permission_runtime;
  for (const absent of ["development", "planning", "`local`", "project config", "Active groups", "Local same-name", "Tool parser:"]) assert.ok(!text.includes(absent), absent);
  for (const expected of ["### Tool permissions", "### Skill permissions", "### File-tool read permissions", "Outside these roots: **ask**", "Bash writable locations\n- `/scratch`",  "File-tool writable locations\n- `/project`", "`.md`", "`custom`: **deny**", "/project/bash-only", "deny > ask > allow", "Unspecified tools allow", "NOT whole submitted source", "behavioral", "NOT OS-sandboxed"]) assert.ok(text.includes(expected), expected);
});
test("runtime preserves independent tool, skill and read rules without flattening", () => {
  const settings = parseSettings({ configVersion: 2, permissionGroups: {
    extra: {
      "tool-parser": { "*": "deny", bash: { "*": "ask", "npm test": "allow" }, read: {} },
      skills: { "*": "ask", review: "allow" },
      filesystem: { readRoots: ["${project}/restricted"], externalRead: "deny" },
    },
  }, modes: { build: { permissionGroups: ["development", "extra"] } } });
  const text = promptSections(context(settings)).pi_permission_runtime;
  for (const heading of ["Tool permissions", "Skill permissions", "File-tool read permissions"]) {
    const section = text.split(`### ${heading}\n\n`)[1].split("\n\n### ")[0];
    assert.ok(section.includes("#### Rule set 1"), heading);
    assert.ok(section.includes("#### Rule set 2"), heading);
  }
  for (const expected of ["apply independently, not as overrides", "a named tool replaces that set's wildcard fallback", "`read`: no additional restriction", "`npm test`: **allow**", "`review`: **allow**", "`/project/restricted`", "Outside these roots: **deny**"]) assert.ok(text.includes(expected), expected);
  assert.ok(!text.includes("extra"));
});
test("runtime distinguishes empty restrictions from omitted fields and deduplicates identical rules", () => {
  const settings = parseSettings({ configVersion: 2, permissionGroups: {
    empty: { filesystem: { readRoots: [], writeRoots: [], writeExtensions: [] }, skills: "allow" },
    omitted: { filesystem: { externalRead: "deny" }, skills: "allow" },
  }, modes: { build: { permissionGroups: ["development", "empty", "omitted"] } } });
  const text = promptSections(context(settings)).pi_permission_runtime;
  assert.ok(text.includes("File-tool writable locations\n- None."));
  assert.ok(text.includes("File-tool write extensions\n- None; file-tool writes are denied."));
  assert.ok(text.includes("- None.\n\nOutside these roots: **allow**"));
  assert.ok(!text.includes("Outside these roots: **deny**"));
  assert.equal(text.match(/`skills`: \*\*allow\*\*/g)?.length, 1);
});
test("mode prompts preserve inherited settings and distinguish mechanical policy from prose", () => {
  const settings = parseSettings({ configVersion: 2, modes: { plan: { systemPrompt: "Review only.", systemPromptAppend: "Be concise." } } });
  assert.equal(promptSections(context(settings, "plan")).pi_permission_mode, "## Mode: `plan`\n\nReview only.\n\nBe concise.");
  assert.ok(promptSections(context(settings)).pi_permission_runtime.includes("Trust-registry"));
});
