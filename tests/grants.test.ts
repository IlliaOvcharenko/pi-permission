import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeGrant, grantCovers, readApproved, saveApproved, trustedGrants } from "../src/grants.ts";
import { canonicalPath } from "../src/paths.ts";

test("project grants require exact approved path and kind", () => {
  const approved = [{ path: "/data/file", kind: "file" as const }];
  assert.equal(trustedGrants([{ path: "/data/file", kind: "directory" }], approved).length, 0);
  assert.equal(trustedGrants([{ path: "/data/other", kind: "file" }], approved).length, 0);
  assert.equal(trustedGrants(approved, approved).length, 1);
  assert.equal(grantCovers(approved[0], "/data/file/child"), false);
  assert.equal(grantCovers({ path: "/data", kind: "directory" }, "/data-other/a"), false);
});
test("trust is isolated by project and survives a reload from disk", () => {
  const dir = canonicalPath(mkdtempSync(path.join(os.tmpdir(), "pi-permission-grants-")));
  try {
    const project = path.join(dir, "project"), ref = path.join(dir, "reference");
    mkdirSync(project); mkdirSync(ref);
    const store = path.join(dir, "trust", "projects.json");
    const grant = describeGrant(ref, project);
    assert.deepEqual(readApproved(store, project), []);
    saveApproved(store, project, [grant]);
    assert.deepEqual(readApproved(store, project), [grant]);
    assert.deepEqual(readApproved(store, path.join(dir, "other")), []);
    assert.deepEqual(trustedGrants([], readApproved(store, project)), []);
    saveApproved(store, project, []);
    assert.deepEqual(readApproved(store, project), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("symlink retargeting requires new trust; missing requests fail closed", () => {
  const dir = canonicalPath(mkdtempSync(path.join(os.tmpdir(), "pi-permission-links-")));
  try {
    for (const name of ["a", "b"]) mkdirSync(path.join(dir, name));
    const link = path.join(dir, "reference");
    symlinkSync(path.join(dir, "a"), link);
    const first = describeGrant(link, dir);
    unlinkSync(link); symlinkSync(path.join(dir, "b"), link);
    assert.deepEqual(trustedGrants([describeGrant(link, dir)], [first]), []);
    assert.throws(() => describeGrant(path.join(dir, "missing"), dir));
    const store = path.join(dir, "bad.json"); writeFileSync(store, "{}");
    assert.throws(() => readApproved(store, dir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
