import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalPath, commandWords, expandPath, globRegex, within } from "../src/paths.ts";

test("normalize aliases and URLs", () => {
  assert.equal(expandPath("@~/a", "/home/me"), "/home/me/a");
  assert.equal(expandPath("$HOME/a", "/home/me"), "/home/me/a");
  assert.equal(expandPath("file:///a/b%20c"), "/a/b c");
  assert.throws(() => expandPath("bad\0path"));
});
test("path boundaries and command pattern argument boundaries", () => {
  assert.equal(within("/project", "/project-other/a"), false);
  assert.equal(within("/project", "/project/..foo"), true);
  assert.deepEqual(commandWords('npm test "two words" *'), ["npm", "test", "two words", "*"]);
  assert.throws(() => commandWords("npm test; rm"));
  assert.throws(() => commandWords("npm 'oops"));
});
test("dangling symlink targets cannot masquerade as project paths", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pi-perm-paths-"));
  try {
    mkdirSync(path.join(dir, "project"));
    symlinkSync(path.join(dir, "outside", "missing"), path.join(dir, "project", "link"));
    assert.equal(canonicalPath(path.join(dir, "project", "link", "new.md")), path.join(canonicalPath(dir), "outside", "missing", "new.md"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("simple documented glob subset", () => {
  const re = globRegex("**/*.ts");
  assert.equal(re.test("file.ts"), true);
  assert.equal(re.test("a/file.ts"), true);
  assert.equal(re.test("file.js"), false);
  assert.equal(globRegex("a?.md").test("ab.md"), true);
});
