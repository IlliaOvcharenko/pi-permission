import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readDecision, toolDecision, writeDecision } from "../src/policy.ts";
import { canonicalPath } from "../src/paths.ts";
import type { Mode, PolicyContext } from "../src/types.ts";

function fixture() {
  const base = canonicalPath(mkdtempSync(path.join(os.tmpdir(), "pi-perm-policy-")));
  const root = path.join(base, "project"), home = path.join(base, "home"), scratch = path.join(base, "scratch");
  for (const p of [root, home, scratch, path.join(home, ".ssh"), path.join(root, "notes"), path.join(home, ".pi", "agent")]) mkdirSync(p, { recursive: true });
  const c: PolicyContext = { root, home, scratch, agentDir: path.join(home, ".pi", "agent"), mode: "plan", readRoots: [], denyRead: [], trustFile: path.join(home, ".pi", "agent", "pi-perm", "trust", "projects.json") };
  return { c, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
test("all sandboxed modes allow normal project reads and hard-deny private paths", () => {
  const { c, cleanup } = fixture();
  try {
    for (const mode of ["plan", "approve", "build"] as Mode[]) {
      c.mode = mode;
      assert.equal(readDecision(c, "main.ts").action, "allow");
      for (const p of ["notes/a.md", "a/archive/data", ".git/config", "credentials/key", path.join(c.home, ".ssh", "id_rsa"), path.join(c.agentDir, "auth.json"), path.join(c.agentDir, "oauth.json")]) assert.equal(readDecision(c, p).action, "deny", p);
      assert.equal(readDecision(c, "/etc/hosts").action, "ask");
    }
  } finally { cleanup(); }
});
test("Plan only permits Markdown writes; other modes permit project and scratch writes", () => {
  const { c, cleanup } = fixture();
  try {
    assert.equal(writeDecision(c, "doc.md").action, "allow");
    assert.equal(writeDecision(c, "main.ts").action, "deny");
    for (const mode of ["approve", "build"] as Mode[]) {
      c.mode = mode;
      assert.equal(writeDecision(c, "main.ts").action, "allow");
      assert.equal(writeDecision(c, path.join(c.scratch, "work.py")).action, "allow");
      assert.equal(writeDecision(c, path.join(c.home, "outside.md")).action, "deny");
      assert.equal(writeDecision(c, path.join(c.scratch, "..", "other.md")).action, "deny");
      assert.equal(writeDecision(c, ".env").action, "deny");
    }
  } finally { cleanup(); }
});
test("symlink aliases, project-root credentials, and denied grants cannot bypass policy", () => {
  const { c, cleanup } = fixture();
  try {
    symlinkSync(path.join(c.home, ".ssh"), path.join(c.root, "alias"));
    symlinkSync(path.join(c.root, "notes"), path.join(c.root, "alias-notes"));
    c.readRoots.push({ path: c.home, kind: "directory" });
    assert.equal(readDecision(c, "alias/id_rsa").action, "deny");
    assert.equal(readDecision(c, "alias-notes/file.md").action, "deny");
    c.denyRead = [path.join(c.root, "private")];
    assert.equal(readDecision(c, "private/new").action, "deny");
    c.root = c.home;
    assert.equal(readDecision(c, path.join(c.agentDir, "auth.json")).action, "deny");
    c.mode = "build";
    assert.equal(writeDecision(c, c.trustFile).action, "deny");
  } finally { cleanup(); }
});
test("file grants do not authorize siblings, ancestors, or descendants; denies win", () => {
  const { c, cleanup } = fixture();
  try {
    const file = canonicalPath(path.resolve(import.meta.dirname, "../README.md"));
    assert.equal(readDecision(c, file).action, "ask");
    c.readRoots.push({ path: file, kind: "file" });
    assert.equal(readDecision(c, file).action, "allow");
    assert.equal(readDecision(c, path.dirname(file)).action, "ask");
    assert.equal(readDecision(c, file + "/child").action, "ask");
    c.denyRead.push(file);
    assert.equal(readDecision(c, file).action, "deny");
    c.agentDir = path.join(c.home, "custom-agent");
    assert.equal(readDecision(c, path.join(c.home, ".pi", "agent", "auth.json")).action, "deny");
  } finally { cleanup(); }
});
test("only project and session scratch are automatic, not other temporary locations", () => {
  const { c, cleanup } = fixture();
  try {
    for (const mode of ["plan", "approve", "build"] as const) {
      c.mode = mode;
      assert.equal(readDecision(c, path.join(c.scratch, "work.txt")).action, "allow");
      assert.equal(readDecision(c, "/tmp").action, "ask");
      assert.equal(readDecision(c, "/tmp/another-session/work.txt").action, "ask");
      assert.equal(readDecision(c, path.join(c.scratch, "..", "other-session", "work.txt")).action, "ask");
      symlinkSync(path.dirname(c.scratch), path.join(c.root, `outside-${mode}`));
      assert.equal(readDecision(c, `outside-${mode}/other-session/work.txt`).action, "ask");
    }
    c.readRoots.push({ path: canonicalPath(path.dirname(c.scratch)), kind: "directory" });
    assert.equal(readDecision(c, path.join(c.scratch, "..", "other-session", "work.txt")).action, "allow");
  } finally { cleanup(); }
});
test("tool defaults and explicit YOLO bypass", () => {
  const { c, cleanup } = fixture();
  try {
    assert.equal(toolDecision(c, "web_enable").action, "allow");
    for (const name of ["web_search", "powershell", "codemode", "unknown"]) assert.equal(toolDecision(c, name).action, "ask");
    c.mode = "yolo";
    assert.equal(readDecision(c, "notes/a").action, "allow");
    assert.equal(writeDecision(c, "/etc/a").action, "allow");
    assert.equal(toolDecision(c, "anything").action, "allow");
  } finally { cleanup(); }
});
