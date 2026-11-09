import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Sandbox, sandboxProfile, type RuntimeManager } from "../src/sandbox.ts";
import { canonicalPath } from "../src/paths.ts";
import type { PolicyContext } from "../src/types.ts";
function fixture() {
  const dir = canonicalPath(mkdtempSync(path.join(os.tmpdir(), "pi-perm-sandbox-")));
  mkdirSync(path.join(dir, "scratch"));
  const c: PolicyContext = { root: dir, scratch: path.join(dir, "scratch"), home: "/home/test", agentDir: "/home/test/.pi/agent", mode: "plan", readRoots: [], denyRead: ["/private-data"], trustFile: "/home/test/.pi/agent/pi-perm/trust/projects.json" };
  const events: string[] = [];
  const manager: RuntimeManager = {
    isSupportedPlatform: () => true, isSandboxingEnabled: () => true,
    checkDependenciesAsync: async () => ({ errors: [] }),
    initialize: async () => { events.push("initialize"); },
    wrapWithSandbox: async () => { events.push("wrap"); return "SANDBOX-WRAPPER"; },
    cleanupAfterCommand: () => { events.push("cleanup"); },
    reset: async () => { events.push("reset"); },
  };
  return { c, events, manager, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
test("profiles: Plan scratch-only; other modes project + scratch; no network filtering", () => {
  const { c, cleanup } = fixture();
  try {
    const p = sandboxProfile(c);
    const literal = (p: string) => ({ path: p, literal: true });
    assert.deepEqual(p.filesystem.allowWrite, [literal(c.scratch)]);
    assert.equal("allowedDomains" in p.network, false);
    assert.ok(p.filesystem.denyRead.some(p => typeof p !== "string" && p.path === "/home/test/.ssh" && p.literal));
    assert.ok(p.filesystem.denyRead.some(p => typeof p === "string" && p.includes("**/") && p.includes("[nN]")));
    assert.ok(p.filesystem.denyRead.some(p => typeof p !== "string" && p.path === "/private-data" && p.literal));
    assert.deepEqual(sandboxProfile({ ...c, mode: "build" }).filesystem.allowWrite, [literal(c.root), literal(c.scratch)]);
    const special = sandboxProfile({ ...c, root: path.join(c.root, "project[*]?"), denyRead: ["/private[secret]*?"] });
    assert.ok(special.filesystem.denyRead.some(p => typeof p !== "string" && p.path === "/private[secret]*?" && p.literal));
    assert.ok(special.filesystem.denyRead.some(p => typeof p === "string" && p.includes("project[[][*]][?]/**/")));
  } finally { cleanup(); }
});
test("only wrapped command reaches runner; exactly one cleanup per successful wrap", async () => {
  const { c, manager, events, cleanup } = fixture();
  const box = new Sandbox(async () => manager, async command => { events.push(command); return { exitCode: 0 }; }, "linux");
  try {
    await box.exec("touch /outside", c.root, { onData() {} }, c);
    assert.deepEqual(events, ["initialize", "wrap", "SANDBOX-WRAPPER", "cleanup"]);
    await box.close(); assert.equal(events.at(-1), "reset");
  } finally { await box.close(); cleanup(); }
});
test("missing dependencies, disabled/unsupported sandbox and wrap failures never run raw command", async () => {
  for (const kind of ["dependencies", "disabled", "unsupported", "wrap", "initialize", "platform"]) {
    const { c, manager, events, cleanup } = fixture();
    if (kind === "dependencies") manager.checkDependenciesAsync = async () => ({ errors: ["missing bwrap"] });
    if (kind === "disabled") manager.isSandboxingEnabled = () => false;
    if (kind === "unsupported") manager.isSupportedPlatform = () => false;
    if (kind === "wrap") manager.wrapWithSandbox = async () => { throw new Error("cannot wrap"); };
    if (kind === "initialize") manager.initialize = async () => { throw new Error("init failed"); };
    let runs = 0;
    const box = new Sandbox(async () => manager, async () => { runs++; return { exitCode: 0 }; }, kind === "platform" ? "win32" : "linux");
    try {
      await assert.rejects(box.exec("touch outside", c.root, { onData() {} }, c));
      assert.equal(runs, 0, kind);
      assert.equal(events.includes("cleanup"), false, kind);
    } finally { await box.close(); cleanup(); }
  }
});
test("runner failure still cleans up, aborted command never starts", async () => {
  const { c, manager, events, cleanup } = fixture();
  const box = new Sandbox(async () => manager, async () => { throw new Error("spawn failed"); }, "linux");
  try {
    await assert.rejects(box.exec("command", c.root, { onData() {} }, c));
    assert.equal(events.filter(x => x === "cleanup").length, 1);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(box.exec("command", c.root, { onData() {}, signal: controller.signal }, c));
    assert.equal(events.filter(x => x === "wrap").length, 1);
  } finally { await box.close(); cleanup(); }
});
test("YOLO alone bypasses sandbox and keeps TMPDIR", async () => {
  const { c, cleanup } = fixture();
  let raw = "";
  const box = new Sandbox(async () => { throw new Error("must not load"); }, async (command, _cwd, opts) => {
    raw = command; assert.equal(opts.env?.TMPDIR, c.scratch); return { exitCode: 0 };
  }, "linux");
  try { await box.exec("raw", c.root, { onData() {} }, { ...c, mode: "yolo" }); assert.equal(raw, "raw"); }
  finally { await box.close(); cleanup(); }
});
