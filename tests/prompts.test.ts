import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSettings } from "../src/config.ts";
import { applyPromptSections, promptSections } from "../src/prompts.ts";
import type { Mode, PolicyContext } from "../src/types.ts";
const context = (settings = parseSettings({}), mode: Mode = "build"): PolicyContext => ({ root: "/project", scratch: "/scratch", home: "/home/test", agentDir: "/home/test/.pi/agent", mode, readRoots: [], denyRead: [], trustFile: "/home/test/.pi/agent/pi-perm/trust/projects.json", settings });

test("example configuration parses and explicitly describes fixed versus editable prompt sources", () => {
  const example = JSON.parse(readFileSync(new URL("../config.example.json", import.meta.url), "utf8"));
  const settings = parseSettings(example);
  assert.ok(example.$comment.includes("FIXED IN CODE"));
  assert.equal(settings.prompts.sections.pi_perm_runtime.source, "runtime");
  assert.ok(settings.prompts.sections.pi_perm_shared.text);
  assert.deepEqual(Object.keys(settings.modes), ["plan", "approve", "build", "yolo"]);
  assert.doesNotThrow(() => JSON.parse(readFileSync(new URL("../config.schema.json", import.meta.url), "utf8")));
});
test("exact prompt namespaces, timing, extra sections and unrelated text preservation", () => {
  const settings = parseSettings({ prompts: { removeLegacySections: [], sections: {
    pi_perm_shared: { when: "never" },
    pi_perm_extra: { source: "text", when: ["approve"], text: "Approve extra" },
    pi_perm_always: { source: "text", when: "always", text: "Always here" },
  } } });
  const sections = { unrelated: "Keep", permission_mode: "Keep too", pi_perm_stale: "Drop" } as Record<string, string>;
  applyPromptSections(sections, context(settings, "approve"));
  assert.equal(sections.pi_perm_extra, "Approve extra");
  assert.equal(sections.pi_perm_shared, undefined);
  assert.ok(sections.pi_perm_mode.includes("standalone approval"));
  assert.equal(sections.pi_perm_stale, undefined);
  applyPromptSections(sections, context(settings, "yolo"));
  assert.deepEqual(sections, { unrelated: "Keep", permission_mode: "Keep too", pi_perm_always: "Always here" });
});
test("runtime facts follow the effective global and project settings, not editable prompt claims", () => {
  const settings = parseSettings({ modes: { build: { systemPrompt: "My customizable text", sandbox: { allowWrite: ["src"], denyWrite: ["src/frozen"], denyRead: ["data/private"], allowLocalBinding: true }, permission: { bash: "deny", tool: "allow" } } } });
  const ctx = context(settings);
  ctx.project = { read: { allow: [], deny: [] }, modes: { build: { sandbox: { writable: false }, permission: { tool: "deny" } } } };
  const sections = promptSections(ctx);
  assert.ok(sections.pi_perm_mode.startsWith("## Mode: `build`"));
  assert.ok(sections.pi_perm_mode.endsWith("My customizable text"));
  assert.ok(sections.pi_perm_runtime.includes("### Bash writable locations\n- `/scratch` — private session scratch; use TMPDIR"));
  assert.ok(sections.pi_perm_runtime.includes("`bash`: **deny**"));
  assert.ok(sections.pi_perm_runtime.includes("### Project tightening (composes with tool permissions; stricter action wins)\n- `tool`: **deny**"));
  assert.ok(sections.pi_perm_runtime.includes("/project/data/private"));
  assert.ok(sections.pi_perm_runtime.includes("Local binding requested: enabled"));
  assert.ok(!sections.pi_perm_runtime.includes("Bash exploration exception"));
});
test("runtime renders roots and ordered permission maps as Markdown and omits absent overrides", () => {
  const ctx = context(parseSettings({ modes: { build: { permission: {
    bash: { "*": "ask", "npm test": "allow" },
    tool: { "*": "ask", web_enable: "allow", risky_tool: { action: "deny", reason: "Do not use" } },
  } } } }));
  ctx.readRoots = [{ path: "/reference", kind: "directory" }, { path: "/guide.md", kind: "file" }];
  const text = promptSections(ctx).pi_perm_runtime;
  assert.ok(text.includes("- `/reference` — directory"));
  assert.ok(text.includes("- `/guide.md` — file"));
  assert.ok(text.includes("- `bash` (last matching pattern wins):\n  - `*`: **ask**\n  - `npm test`: **allow**"));
  assert.ok(text.includes("`risky_tool`: **deny** — `Do not use`"));
  assert.ok(text.includes("a bare `*` means all targets"));
  assert.ok(text.includes("the last matching rule wins"));
  assert.ok(text.includes("deny > ask > allow"));
  assert.ok(text.includes("entire submitted command line"));
  for (const absent of ["Project tightening", "Additional write denies", "Bash exploration exception", '"kind":', "{}", "[]"]) assert.ok(!text.includes(absent), absent);
});
test("pattern explanation also appears for project-only maps", () => {
  const settings = parseSettings({});
  for (const mode of Object.values(settings.modes)) {
    for (const surface of Object.keys(mode.permission)) mode.permission[surface] = "ask";
  }
  const ctx = context(settings);
  assert.ok(!promptSections(ctx).pi_perm_runtime.includes("Permission patterns:"));
  ctx.project = { read: { allow: [], deny: [] }, modes: { build: { permission: { bash: { "*": "ask" } } } } };
  assert.ok(promptSections(ctx).pi_perm_runtime.includes("a bare `*` means all targets"));
});
test("mode section identifies the fixed mode without redundant metadata", () => {
  const settings = parseSettings({ modes: { plan: { systemPrompt: "Review only.", systemPromptAppend: "Be concise." } } });
  assert.equal(promptSections(context(settings, "plan")).pi_perm_mode,
    "## Mode: `plan`\n\nReview only.\n\nBe concise.");
});
test("Plan explains scratch-only Bash writes and default exploration in plain text", () => {
  const text = promptSections(context(undefined, "plan")).pi_perm_runtime;
  assert.ok(text.includes("Project writes are disabled for Bash."));
  assert.ok(text.includes("private session scratch; use TMPDIR"));
  assert.ok(text.includes("### Bash safe-command permission"));
  assert.ok(!text.includes("`/tmp` — temporary files"));
  assert.ok(!text.includes("kind:"));
});
