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
test("runtime reports selected group provenance and separate file-tool and Bash restrictions", () => {
  const settings = parseSettings({}, { configVersion: 2, permissionGroups: { local: { "tool-parser": { custom: "deny" }, "bash-sandbox": { filesystem: { denyRead: ["${project}/bash-only"] } } } }, modes: { plan: { permissionGroups: ["development", "planning", "local"] } } });
  const text = promptSections(context(settings, "plan")).pi_permission_runtime;
  for (const expected of ["`local` — `project config`", "Bash writable locations\n- `/scratch`", "File-tool writable locations\n- `/project`", "`.md`", "`custom`: **deny**", "/project/bash-only", "deny > ask > allow", "Unspecified tools allow", "NOT whole submitted source", "behavioral", "NOT OS-sandboxed"]) assert.ok(text.includes(expected), expected);
});
test("mode prompts preserve inherited settings and distinguish mechanical policy from prose", () => {
  const settings = parseSettings({ configVersion: 2, modes: { plan: { systemPrompt: "Review only.", systemPromptAppend: "Be concise." } } });
  assert.equal(promptSections(context(settings, "plan")).pi_permission_mode, "## Mode: `plan`\n\nReview only.\n\nBe concise.");
  assert.ok(promptSections(context(settings)).pi_permission_runtime.includes("Trust-registry"));
});
