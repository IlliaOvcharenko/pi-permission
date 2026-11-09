import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createExtension } from "../src/index.ts";
import { canonicalPath } from "../src/paths.ts";
import { MODE_ENTRY } from "../src/sessions.ts";
import { Sandbox } from "../src/sandbox.ts";

function harness() {
  const base = canonicalPath(mkdtempSync(path.join(os.tmpdir(), "pi-perm-hooks-")));
  const root = path.join(base, "project"), home = path.join(base, "home"), agent = path.join(home, ".pi", "agent"), scratch = path.join(base, "scratch");
  for (const p of [root, agent, scratch, path.join(root, "notes"), path.join(root, "src")]) mkdirSync(p, { recursive: true });
  writeFileSync(path.join(root, "main.ts"), "public");
  writeFileSync(path.join(root, "notes", "secret.md"), "private");
  const events = new Map<string, Function>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const notices: string[] = [];
  let entries: any[] = [];
  let allow = true;
  let oldExtension = false;
  const prompts: string[] = [];
  const pi: any = {
    on: (name: string, fn: Function) => events.set(name, fn),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerFlag() {}, registerShortcut: (name: string, shortcut: any) => shortcuts.set(name, shortcut), getFlag() {},
    getCommands: () => oldExtension ? [{ sourceInfo: { path: "/npm/pi-permission-modes/src/index.ts" } }] : [],
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
  };
  const ctx: any = {
    cwd: root, hasUI: true, isProjectTrusted: () => true,
    sessionManager: { getBranch: () => entries, getSessionId: () => "test" },
    ui: { setStatus() {}, notify: (text: string) => notices.push(text), select: async (title: string) => { prompts.push(title); return allow ? "Allow once" : "Deny"; }, confirm: async (title: string) => { prompts.push(title); return allow; } },
  };
  const factory = (name: string) => (_cwd: string, options?: any) => ({
    name, parameters: {}, description: name,
    execute: async (_id: string, params: any, _signal: any, _update: any, context: any) => {
      if (name === "bash") return await options.operations.exec(params.command, context.cwd, { onData() {} });
      return { content: [{ type: "text", text: name }], details: undefined };
    },
  });
  const sdk: any = {
    CONFIG_DIR_NAME: ".pi", getAgentDir: () => agent,
    getDocsPath: () => root, getExamplesPath: () => root, getReadmePath: () => path.join(root, "README.md"),
    truncateHead: (text: string) => ({ content: text, truncated: false }),
    createReadToolDefinition: factory("read"), createWriteToolDefinition: factory("write"), createEditToolDefinition: factory("edit"),
    createGrepToolDefinition: factory("grep"), createFindToolDefinition: factory("find"), createLsToolDefinition: factory("ls"), createBashToolDefinition: factory("bash"),
  };
  const box = new Sandbox(async () => { throw new Error("sandbox deliberately unavailable"); });
  createExtension(pi, sdk, { home, agentDir: agent, scratch: () => scratch, sandbox: box });
  return {
    root, agent, home, scratch, tools, prompts, ctx, events, commands, shortcuts, notices,
    configure: (value: unknown) => { mkdirSync(path.join(agent, "pi-perm"), { recursive: true }); writeFileSync(path.join(agent, "pi-perm", "config.json"), JSON.stringify(value)); },
    start: (reason = "new") => events.get("session_start")!({ reason }, ctx),
    call: (name: string, input: any, id = "call") => events.get("tool_call")!({ toolName: name, input, toolCallId: id }, ctx),
    setAllow: (value: boolean) => { allow = value; },
    setOld: () => { oldExtension = true; },
    setEntries: (mode: string) => { entries = [{ type: "custom", customType: MODE_ENTRY, data: { mode } }]; },
    cleanup: async () => { await events.get("session_shutdown")!({}, ctx); rmSync(base, { recursive: true, force: true }); },
  };
}
test("Plan blocks code edits, permits Markdown and normal reads without asking", async () => {
  const h = harness();
  try {
    await h.start();
    assert.equal((await h.call("write", { path: "main.ts" })).block, true);
    assert.equal(await h.call("write", { path: "requested.md" }), undefined);
    assert.equal(await h.call("read", { path: "main.ts" }), undefined);
    assert.equal((await h.call("read", { path: "notes/secret.md" })).block, true);
    assert.equal(h.prompts.length, 0);
  } finally { await h.cleanup(); }
});
test("custom tools ask and denials are respected; web_enable is free", async () => {
  const h = harness();
  try {
    await h.start(); h.setAllow(false);
    assert.equal((await h.call("unknown", { action: "run" })).block, true);
    assert.equal(await h.call("web_enable", {}), undefined);
    assert.equal(h.prompts.length, 1);
  } finally { await h.cleanup(); }
});
test("recursive file tools omit denied directories and descendant symlinks", async () => {
  const h = harness();
  try {
    symlinkSync(path.join(h.root, "notes"), path.join(h.root, "alias-notes"));
    await h.start();
    for (const name of ["ls", "find"]) {
      const id = `call-${name}`;
      assert.equal(await h.call(name, { path: ".", pattern: "**/*" }, id), undefined);
      const result = await h.tools.get(name).execute(id, { path: ".", pattern: "**/*" }, undefined, undefined, h.ctx);
      const text = result.content[0].text;
      assert.ok(text.includes("main.ts"));
      assert.equal(text.includes("notes"), false);
      assert.equal(text.includes("secret"), false);
    }
  } finally { await h.cleanup(); }
});
test("Approve and Build edit tools do not add UI prompts; their chat rules differ", async () => {
  const h = harness();
  try {
    for (const mode of ["approve", "build"]) {
      h.setEntries(mode); await h.start("resume");
      assert.equal(await h.call("write", { path: "main.ts" }), undefined);
      const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
      h.events.get("before_agent_start")!(event, h.ctx);
      const text = event.systemPromptOptions.sections.pi_perm_mode;
      assert.ok(text.includes(mode === "approve" ? "standalone approval question" : "without separate chat approval"));
    }
  } finally { await h.cleanup(); }
});
test("Bash cannot fall back to unsandboxed execution", async () => {
  const h = harness();
  try {
    await h.start();
    assert.equal(await h.call("bash", { command: "python script.py" }), undefined);
    await assert.rejects(h.tools.get("bash").execute("call", { command: "python script.py" }, undefined, undefined, h.ctx), /sandbox deliberately unavailable/);
  } finally { await h.cleanup(); }
});
test("loading both permission extensions blocks calls", async () => {
  const h = harness();
  try {
    h.setOld(); await h.start();
    assert.equal((await h.call("read", { path: "main.ts" })).block, true);
  } finally { await h.cleanup(); }
});
test("invalid configuration blocks rather than discarding restrictions", async () => {
  const h = harness();
  try {
    mkdirSync(path.join(h.root, ".pi"));
    writeFileSync(path.join(h.root, ".pi", "pi-perm.json"), "{");
    await h.start();
    assert.equal((await h.call("read", { path: "main.ts" })).block, true);
  } finally { await h.cleanup(); }
});
test("project grant expansions need UI trust, persist, and revoke", async () => {
  const h = harness();
  try {
    mkdirSync(path.join(h.root, ".pi"));
    const ref = path.join(h.home, "reference"); mkdirSync(ref);
    writeFileSync(path.join(h.root, ".pi", "pi-perm.json"), JSON.stringify({ read: { allow: [ref], deny: ["src/private"] } }));
    h.setAllow(false); await h.start();
    assert.ok(h.prompts.includes("Trust project read grants?"));
    h.setAllow(true); await h.commands.get("perm").handler("trust", h.ctx);
    const count = h.prompts.filter(p => p === "Trust project read grants?").length;
    await h.start("reload");
    assert.equal(h.prompts.filter(p => p === "Trust project read grants?").length, count);
    await h.commands.get("perm").handler("revoke", h.ctx);
    h.setAllow(false); await h.start("reload");
    assert.equal(h.prompts.filter(p => p === "Trust project read grants?").length, count + 1);
  } finally { await h.cleanup(); }
});
test("fixed modes, cycle order, prompt sections, reload and config inspection", async () => {
  const h = harness();
  try {
    const config = {
      defaultMode: "plan", cycleOrder: ["plan", "build"],
      modes: { plan: { systemPromptAppend: "Custom review instructions." } },
      prompts: { sections: { pi_perm_extra: { source: "text", when: ["plan"], text: "Review only extra." } } },
    };
    h.configure(config); await h.start();
    const event = { systemPromptOptions: { sections: { unrelated: "keep", pi_perm: "stale", permission_mode: "old", pi_perm_stale: "stale" } as Record<string, string> } };
    h.events.get("before_agent_start")!(event, h.ctx);
    assert.ok(event.systemPromptOptions.sections.pi_perm_mode.includes("Custom review instructions"));
    assert.equal(event.systemPromptOptions.sections.pi_perm_extra, "Review only extra.");
    assert.ok(event.systemPromptOptions.sections.pi_perm_runtime.includes("`plan`"));
    assert.equal(event.systemPromptOptions.sections.unrelated, "keep");
    assert.equal(event.systemPromptOptions.sections.permission_mode, undefined);
    assert.equal(event.systemPromptOptions.sections.pi_perm_stale, undefined);
    await h.shortcuts.get("alt+m").handler(h.ctx);
    h.events.get("before_agent_start")!(event, h.ctx);
    assert.equal(event.systemPromptOptions.sections.pi_perm_extra, undefined);
    assert.ok(event.systemPromptOptions.sections.pi_perm_runtime.includes("build"));
    h.configure({ ...config, modes: { ...config.modes, build: { systemPrompt: "Updated prompt" } } });
    h.events.get("before_agent_start")!(event, h.ctx);
    assert.ok(!event.systemPromptOptions.sections.pi_perm_mode.includes("Updated prompt"));
    await h.start("reload");
    h.events.get("before_agent_start")!(event, h.ctx);
    assert.equal(event.systemPromptOptions.sections.pi_perm_mode, "## Mode: `build`\n\nUpdated prompt");
    await h.commands.get("perm").handler("config", h.ctx);
    const effective = JSON.parse(h.notices.at(-1)!);
    assert.deepEqual(Object.keys(effective.settings.modes), ["plan", "approve", "build", "yolo"]);
    assert.equal(effective.promptSections.pi_perm_mode, event.systemPromptOptions.sections.pi_perm_mode);
  } finally { await h.cleanup(); }
});
test("configured ask file writes accept only the approved call; denies still win", async () => {
  const h = harness();
  try {
    h.configure({ defaultMode: "build", modes: { build: { permission: { write: "ask" } } } });
    await h.start();
    const input = { path: "main.ts", content: "replacement" };
    assert.equal(await h.call("write", input, "approved"), undefined);
    const tool = h.tools.get("write");
    await assert.doesNotReject(tool.execute("approved", input, undefined, undefined, h.ctx));
    await assert.rejects(tool.execute("approved", { ...input, path: "other.ts" }, undefined, undefined, h.ctx));
    await assert.rejects(tool.execute("approved", { ...input, path: "notes/private.md" }, undefined, undefined, h.ctx));
  } finally { await h.cleanup(); }
});
test("project permission allow cannot loosen a global deny", async () => {
  const h = harness();
  try {
    h.configure({ shared: { permission: { read: "deny" } } });
    mkdirSync(path.join(h.root, ".pi"));
    writeFileSync(path.join(h.root, ".pi", "pi-perm.json"), JSON.stringify({ modes: { plan: { permission: { read: "allow" } } } }));
    await h.start();
    assert.equal((await h.call("read", { path: "main.ts" })).block, true);
  } finally { await h.cleanup(); }
});
test("YOLO requires confirmation and clears sandbox-only sections", async () => {
  const h = harness();
  try {
    await h.start(); h.setAllow(false);
    await h.commands.get("perm").handler("yolo", h.ctx);
    assert.equal((await h.call("write", { path: "main.ts" })).block, true);
    h.setAllow(true); await h.commands.get("perm").handler("yolo", h.ctx);
    assert.equal(await h.call("read", { path: "notes/secret.md" }), undefined);
    const event = { systemPromptOptions: { sections: { pi_perm_mode: "old", pi_perm_runtime: "old" } as Record<string, string> } };
    h.events.get("before_agent_start")!(event, h.ctx);
    assert.deepEqual(event.systemPromptOptions.sections, {});
    h.configure({ invalid: true }); await h.start("reload");
    assert.equal((await h.call("read", { path: "main.ts" })).block, true);
  } finally { await h.cleanup(); }
});
