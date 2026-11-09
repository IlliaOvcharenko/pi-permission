import test from "node:test";
import assert from "node:assert/strict";
import { MODE_ENTRY, savedMode, startMode } from "../src/sessions.ts";
import { parseSettings } from "../src/config.ts";
const entry = (mode: string) => ({ type: "custom", customType: MODE_ENTRY, data: { mode } });

test("destination mode wins over previous session environment on resume", () => {
  assert.equal(startMode({ reason: "resume", entries: [entry("approve")], defaultMode: "plan", inherited: "build", flag: "build" }), "approve");
});
test("reload preserves saved mode; independent new session uses default", () => {
  assert.equal(startMode({ reason: "reload", entries: [entry("build")], defaultMode: "plan", inherited: "approve" }), "build");
  assert.equal(startMode({ reason: "new", entries: [], defaultMode: "plan", inherited: "build", flag: "build" }), "plan");
});
test("startup explicit flag wins, then session, then non-YOLO inheritance", () => {
  assert.equal(startMode({ reason: "startup", entries: [entry("approve")], defaultMode: "plan", flag: "build" }), "build");
  assert.equal(startMode({ reason: "startup", entries: [entry("approve")], defaultMode: "plan", inherited: "build" }), "approve");
  assert.equal(startMode({ reason: "startup", entries: [], defaultMode: "plan", inherited: "yolo" }), "plan");
});
test("branch-local entries and invalid values", () => {
  assert.equal(savedMode([entry("approve"), entry("bad")]), undefined);
  assert.equal(savedMode([]), undefined);
  assert.equal(startMode({ reason: "fork", entries: [entry("build")], defaultMode: "plan" }), "build");
});
test("legacy custom modes fall back safely; fixed YOLO restores only from saved selection", () => {
  const { modes } = parseSettings({});
  assert.equal(startMode({ reason: "resume", entries: [entry("review")], defaultMode: "plan", modes }), "plan");
  assert.equal(startMode({ reason: "resume", entries: [entry("build"), entry("removed")], defaultMode: "approve", modes }), "approve");
  assert.equal(startMode({ reason: "startup", entries: [], defaultMode: "plan", inherited: "yolo", modes }), "plan");
  assert.equal(startMode({ reason: "resume", entries: [entry("yolo")], defaultMode: "plan", modes }), "yolo");
  assert.throws(() => startMode({ reason: "startup", entries: [], defaultMode: "plan", flag: "missing", modes }));
});
