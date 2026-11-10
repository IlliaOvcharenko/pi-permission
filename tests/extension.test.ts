import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createExtension, modeLabel } from "../src/index.ts";
import { canonicalPath } from "../src/paths.ts";
import { MODE_ENTRY } from "../src/sessions.ts";
import { Sandbox } from "../src/sandbox.ts";

function harness() {
  const base = canonicalPath(mkdtempSync(path.join(os.tmpdir(), "pi-permission-hooks-")));
  const root = path.join(base, "project"), home = path.join(base, "home"), agent = path.join(home, ".pi", "agent"), scratch = path.join(base, "scratch");
  for (const p of [root, agent, scratch, path.join(root, "notes"), path.join(root, "src")]) mkdirSync(p, { recursive: true });
  writeFileSync(path.join(root, "main.ts"), "public");
  writeFileSync(path.join(root, "notes", "secret.md"), "private");
  const events = new Map<string, Function>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const flags = new Map<string, any>();
  const flagValues = new Map<string, unknown>();
  const notices: string[] = [];
  let entries: any[] = [];
  let allow = true;
  let oldExtension = false;
  const prompts: string[] = [];
  const pi: any = {
    on: (name: string, fn: Function) => events.set(name, fn),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerFlag: (name: string, definition: any) => flags.set(name, definition),
    registerShortcut: (name: string, shortcut: any) => shortcuts.set(name, shortcut),
    getFlag: (name: string) => flagValues.get(name),
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
  ctx.reload = () => events.get("session_start")!({ reason: "reload" }, ctx);
  return {
    root, agent, home, scratch, tools, prompts, ctx, events, commands, shortcuts, flags, flagValues, notices,
    configure: (value: unknown) => { mkdirSync(path.join(agent, "pi-permission"), { recursive: true }); writeFileSync(path.join(agent, "pi-permission", "config.json"), JSON.stringify({ configVersion: 2, ...(value as object) })); },
    start: (reason = "new") => events.get("session_start")!({ reason }, ctx),
    call: (name: string, input: any, id = "call") => events.get("tool_call")!({ toolName: name, input, toolCallId: id }, ctx),
    setAllow: (value: boolean) => { allow = value; },
    setOld: () => { oldExtension = true; },
    setEntries: (mode: string) => { entries = [{ type: "custom", customType: MODE_ENTRY, data: { mode } }]; },
    cleanup: async () => { await events.get("session_shutdown")!({}, ctx); rmSync(base, { recursive: true, force: true }); },
  };
}
test("pi-permission owns command, flag, config paths, trust protection and mode environment", async () => {
  const previous = process.env.PI_PERMISSION_MODE;
  const h = harness();
  try {
    assert.deepEqual([...h.commands.keys()], ["pi-permission"]);
    assert.deepEqual([...h.flags.keys()], ["pi-permission"]);
    h.configure({ defaultMode: "approve" });
    h.flagValues.set("pi-permission", "build");
    await h.start("startup");
    assert.equal(process.env.PI_PERMISSION_MODE, "build");
    await h.commands.get("pi-permission").handler("config", h.ctx);
    const config = JSON.parse(h.notices.at(-1)!);
    assert.equal(config.configFile, path.join(h.agent, "pi-permission", "config.json"));
    assert.equal(config.projectFile, path.join(h.root, ".pi", "pi-permission.json"));
    await h.commands.get("pi-permission").handler("status", h.ctx);
    assert.equal(h.notices.at(-1), [
      "pi-permission: build (sandbox required)",
      `Global: ${config.configFile} (loaded)`,
      `Local: ${config.projectFile} (absent; using defaults)`,
    ].join("\n"));
    assert.equal((await h.call("write", { path: path.join(h.agent, "pi-permission", "trust", "projects.json") })).block, true);
  } finally {
    await h.cleanup();
    if (previous === undefined) delete process.env.PI_PERMISSION_MODE;
    else process.env.PI_PERMISSION_MODE = previous;
  }
});
test("status reports defaults, loaded local policy, and blocked reloads concisely", async () => {
  const h = harness();
  const global = path.join(h.agent, "pi-permission", "config.json");
  const local = path.join(h.root, ".pi", "pi-permission.json");
  const status = async () => {
    await h.commands.get("pi-permission").handler("", h.ctx);
    return h.notices.at(-1)!;
  };
  try {
    await h.start();
    assert.equal(await status(), `pi-permission: plan (sandbox required)\nGlobal: ${global} (absent; using defaults)\nLocal: ${local} (absent; using defaults)`);
    mkdirSync(path.dirname(local), { recursive: true });
    writeFileSync(local, JSON.stringify({ configVersion: 2 }));
    await h.start("reload");
    assert.ok((await status()).includes(`Local: ${local} (loaded)`));
    h.configure({ defaultMode: "yolo" });
    await h.start("reload");
    const blocked = await status();
    assert.ok(blocked.includes("(blocked)"));
    assert.ok(blocked.includes(`Global: ${global} (not active)`));
    assert.ok(blocked.includes(`Local: ${local} (not active)`));
    assert.ok(blocked.includes("Error:"));
  } finally { await h.cleanup(); }
});
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
test("custom tools default allow; explicit ask respects denial", async () => {
  const h = harness();
  try {
    h.configure({ permissionGroups: { consent: { "tool-parser": { unknown: "ask" } } }, modes: { plan: { permissionGroups: ["development", "planning", "consent"] } } });
    await h.start(); h.setAllow(false);
    assert.equal(await h.call("other_unknown", {}), undefined);
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
      const text = event.systemPromptOptions.sections.pi_permission_mode;
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
    writeFileSync(path.join(h.root, ".pi", "pi-permission.json"), "{");
    await h.start();
    assert.equal((await h.call("read", { path: "main.ts" })).block, true);
  } finally { await h.cleanup(); }
});
test("project policy requires content-bound trust, persists, and revokes", async () => {
  const h = harness();
  try {
    mkdirSync(path.join(h.root, ".pi"));
    writeFileSync(path.join(h.root, ".pi", "pi-permission.json"), JSON.stringify({ configVersion: 2, modes: { build: { color: "#112233" } } }));
    h.setAllow(false); await h.start();
    assert.ok(h.prompts.includes("Trust project permission policy?"));
    assert.equal((await h.call("read", { path: "main.ts" })).block, true);
    h.setAllow(true); await h.commands.get("pi-permission").handler("trust", h.ctx);
    const count = h.prompts.filter(p => p === "Trust project permission policy?").length;
    await h.start("reload");
    assert.equal(h.prompts.filter(p => p === "Trust project permission policy?").length, count);
    await h.commands.get("pi-permission").handler("revoke", h.ctx);
    h.setAllow(false); await h.start("reload");
    assert.equal(h.prompts.filter(p => p === "Trust project permission policy?").length, count + 1);
  } finally { await h.cleanup(); }
});
test("fixed modes, cycle order, prompt sections, reload and config inspection", async () => {
  const h = harness();
  try {
    const config = {
      defaultMode: "plan", cycleOrder: ["plan", "build"],
      modes: { plan: { systemPromptAppend: "Custom review instructions." } },
      prompts: { sections: { pi_permission_extra: { source: "text", when: ["plan"], text: "Review only extra." } } },
    };
    h.configure(config); await h.start();
    const event = { systemPromptOptions: { sections: { unrelated: "keep", pi_permission: "stale", permission_mode: "old", pi_permission_stale: "stale" } as Record<string, string> } };
    h.events.get("before_agent_start")!(event, h.ctx);
    assert.ok(event.systemPromptOptions.sections.pi_permission_mode.includes("Custom review instructions"));
    assert.equal(event.systemPromptOptions.sections.pi_permission_extra, "Review only extra.");
    assert.ok(event.systemPromptOptions.sections.pi_permission_runtime.includes("`plan`"));
    assert.equal(event.systemPromptOptions.sections.unrelated, "keep");
    assert.equal(event.systemPromptOptions.sections.permission_mode, undefined);
    assert.equal(event.systemPromptOptions.sections.pi_permission_stale, undefined);
    await h.shortcuts.get("alt+m").handler(h.ctx);
    h.events.get("before_agent_start")!(event, h.ctx);
    assert.equal(event.systemPromptOptions.sections.pi_permission_extra, undefined);
    assert.ok(event.systemPromptOptions.sections.pi_permission_runtime.includes("build"));
    h.configure({ ...config, modes: { ...config.modes, build: { systemPrompt: "Updated prompt" } } });
    h.events.get("before_agent_start")!(event, h.ctx);
    assert.ok(!event.systemPromptOptions.sections.pi_permission_mode.includes("Updated prompt"));
    await h.start("reload");
    h.events.get("before_agent_start")!(event, h.ctx);
    assert.equal(event.systemPromptOptions.sections.pi_permission_mode, "## Mode: `build`\n\nUpdated prompt");
    await h.commands.get("pi-permission").handler("config", h.ctx);
    const effective = JSON.parse(h.notices.at(-1)!);
    assert.deepEqual(Object.keys(effective.settings.modes), ["plan", "approve", "build", "yolo"]);
    assert.equal(effective.promptSections.pi_permission_mode, event.systemPromptOptions.sections.pi_permission_mode);
  } finally { await h.cleanup(); }
});
test("configured ask file writes accept only the approved call; denies still win", async () => {
  const h = harness();
  try {
    h.configure({ defaultMode: "build", permissionGroups: { consent: { "tool-parser": { write: "ask" } } }, modes: { build: { permissionGroups: ["development", "consent"] } } });
    await h.start();
    const input = { path: "main.ts", content: "replacement" };
    assert.equal(await h.call("write", input, "approved"), undefined);
    const tool = h.tools.get("write");
    await assert.doesNotReject(tool.execute("approved", input, undefined, undefined, h.ctx));
    await assert.rejects(tool.execute("approved", { ...input, path: "other.ts" }, undefined, undefined, h.ctx));
    await assert.rejects(tool.execute("approved", { ...input, path: "notes/private.md" }, undefined, undefined, h.ctx));
  } finally { await h.cleanup(); }
});
test("approved project group replaces global deny with allow", async () => {
  const h = harness();
  try {
    h.configure({ permissionGroups: { development: { "tool-parser": { read: "deny" }, "bash-sandbox": { enabled: true } } } });
    mkdirSync(path.join(h.root, ".pi"));
    writeFileSync(path.join(h.root, ".pi", "pi-permission.json"), JSON.stringify({ configVersion: 2, permissionGroups: { development: { "tool-parser": { read: "allow" }, "bash-sandbox": { enabled: true } } } }));
    await h.start();
    assert.equal(await h.call("read", { path: "main.ts" }), undefined);
  } finally { await h.cleanup(); }
});
test("YOLO requires confirmation and clears sandbox-only sections", async () => {
  const h = harness();
  try {
    await h.start(); h.setAllow(false);
    await h.commands.get("pi-permission").handler("yolo", h.ctx);
    assert.equal((await h.call("write", { path: "main.ts" })).block, true);
    h.setAllow(true); await h.commands.get("pi-permission").handler("yolo", h.ctx);
    assert.equal(await h.call("read", { path: "notes/secret.md" }), undefined);
    const event = { systemPromptOptions: { sections: { pi_permission_mode: "old", pi_permission_runtime: "old" } as Record<string, string> } };
    h.events.get("before_agent_start")!(event, h.ctx);
    assert.deepEqual(event.systemPromptOptions.sections, {});
    h.configure({ invalid: true }); await h.start("reload");
    assert.equal((await h.call("read", { path: "main.ts" })).block, true);
  } finally { await h.cleanup(); }
});
test("project policy cannot silently expand itself; invalid reload never partially activates", async () => {
  const h = harness();
  try {
    await h.start();
    mkdirSync(path.join(h.root, ".pi"));
    const file = path.join(h.root, ".pi", "pi-permission.json");
    writeFileSync(file, JSON.stringify({ configVersion: 2, modes: { build: { color: "#123456" } } }));
    assert.equal((await h.call("unknown", {})).block, true);
    const event = { systemPromptOptions: { sections: { pi_permission_mode: "stale" } as Record<string, string> } };
    h.events.get("before_agent_start")!(event, h.ctx);
    assert.match(event.systemPromptOptions.sections.pi_permission_runtime, /failed closed/);
    assert.equal(event.systemPromptOptions.sections.pi_permission_mode, undefined);
    h.setAllow(false); await h.start("reload");
    assert.equal((await h.call("unknown", {})).block, true);
    h.setAllow(true); await h.start("reload");
    assert.equal(await h.call("unknown", {}), undefined);
    writeFileSync(file, JSON.stringify({ configVersion: 2, permissionGroups: { development: { "tool-parser": { "*": "allow" }, "bash-sandbox": { enabled: false } } } }));
    await h.start("reload");
    assert.equal((await h.call("unknown", {})).block, true);
  } finally { await h.cleanup(); }
});
test("no UI or Pi project trust never activates project authority", async () => {
  for (const kind of ["no-ui", "untrusted"]) {
    const h = harness();
    try {
      mkdirSync(path.join(h.root, ".pi"));
      writeFileSync(path.join(h.root, ".pi", "pi-permission.json"), JSON.stringify({ configVersion: 2 }));
      if (kind === "no-ui") h.ctx.hasUI = false;
      else h.ctx.isProjectTrusted = () => false;
      await h.start();
      assert.equal((await h.call("unknown", {})).block, true);
    } finally { await h.cleanup(); }
  }
});
test("read-root symlink retargeting and file/directory identity changes need new policy trust", async () => {
  const h = harness();
  try {
    const a = path.join(h.home, "a"), b = path.join(h.home, "b"), link = path.join(h.home, "reference");
    mkdirSync(a); mkdirSync(b); symlinkSync(a, link);
    mkdirSync(path.join(h.root, ".pi"));
    writeFileSync(path.join(h.root, ".pi", "pi-permission.json"), JSON.stringify({ configVersion: 2, permissionGroups: { refs: { filesystem: { readRoots: [link] } } } }));
    await h.start();
    const count = h.prompts.filter(p => p === "Trust project permission policy?").length;
    rmSync(link); symlinkSync(b, link);
    assert.equal((await h.call("unknown", {})).block, true);
    await h.start("reload");
    assert.equal(h.prompts.filter(p => p === "Trust project permission policy?").length, count + 1);
    rmSync(b, { recursive: true }); writeFileSync(b, "file not directory");
    assert.equal((await h.call("unknown", {})).block, true);
    await h.start("reload");
    assert.equal(h.prompts.filter(p => p === "Trust project permission policy?").length, count + 2);
  } finally { await h.cleanup(); }
});
test("a project policy changed during its UI approval is never saved or activated", async () => {
  const h = harness();
  try {
    mkdirSync(path.join(h.root, ".pi"));
    const file = path.join(h.root, ".pi", "pi-permission.json");
    writeFileSync(file, JSON.stringify({ configVersion: 2 }));
    h.ctx.ui.confirm = async () => { writeFileSync(file, JSON.stringify({ configVersion: 2, defaultMode: "build" })); return true; };
    await h.start();
    assert.equal((await h.call("unknown", {})).block, true);
    assert.ok(h.notices.some(n => n.includes("changed during trust review")));
  } finally { await h.cleanup(); }
});
test("mode colors use theme tokens or concrete RGB and handle absent UI color support", () => {
  let style: any;
  const theme: any = { fg: (token: string, text: string) => `${token}:${text}`, style: (text: string, options: any) => { style = options; return text; } };
  assert.equal(modeLabel(theme, "accent", "build"), "accent:build");
  assert.equal(modeLabel(theme, "#12AbEf", "build"), "build");
  assert.deepEqual(style.fg, { kind: "rgb", r: 18, g: 171, b: 239 });
  assert.equal(modeLabel(undefined, "#123456", "build"), "build");
  assert.equal(modeLabel(undefined, "muted", "plan"), "plan");
});
