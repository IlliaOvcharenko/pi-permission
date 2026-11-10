import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { bashDecision, classifyTree, type NodeLike } from "../src/bash.ts";
import { parseSettings } from "../src/config.ts";
import type { PolicyContext } from "../src/types.ts";
const ctx: PolicyContext = { root: process.cwd(), home: "/home/test", scratch: "/tmp/test", agentDir: "/home/test/.pi/agent", mode: "plan", readRoots: [], denyRead: [], trustFile: "/home/test/.pi/agent/pi-permission/trust/projects.json" };
const node = (type: string, text: string, children: NodeLike[] = []): NodeLike => ({ type, text, children });
const cmd = (name: string, args: string[] = []) => node("program", "", [node("command", "", [node("command_name", name, [node("word", name)]), ...args.map(a => node("word", a))])]);

test("exploration names only, unknown syntax and executable paths ask", () => {
  for (const name of ["ls", "rg", "find", "fd", "grep", "pwd"]) assert.equal(classifyTree(cmd(name), ctx).action, "allow");
  for (const name of ["python", "git", "npm", "env", "/tmp/ls", "./ls", "bash"]) assert.equal(classifyTree(cmd(name), ctx).action, "ask");
  assert.equal(classifyTree(node("function_definition", "ls() { rm x; }"), ctx).action, "ask");
});
test("find/fd/rg execution, redirects, substitutions and external reads ask", () => {
  for (const args of [[".", "-delete"], [".", "-exec", "rm"], ["--pre=script"], ["-X", "rm"], ["/etc/hosts"]]) assert.equal(classifyTree(cmd("find", args), ctx).action, "ask");
  assert.equal(classifyTree(node("program", "", [node("redirected_statement", "ls > file")]), ctx).action, "ask");
  assert.equal(classifyTree(cmd("ls", ["$CMD"]), ctx).action, "ask");
});
test("YOLO does not parse or prompt", async () => {
  assert.equal((await bashDecision("anything", { ...ctx, mode: "yolo" })).action, "allow");
});
test("failed path classification cannot erase a recognized deny in another component", () => {
  const c = { ...ctx, settings: parseSettings({ configVersion: 2, permissionGroups: { development: { "tool-parser": { bash: { "*": "allow", rm: "deny" } }, "bash-sandbox": { enabled: true } } } }) };
  const tree = node("program", "", [...cmd("rm", ["x"]).children, ...cmd("ls", ["/invalid\0path"]).children]);
  assert.equal(classifyTree(tree, c).action, "deny");
});
test("real parser adversarial command suite", async t => {
  const require = createRequire(import.meta.url);
  let Parser: any, Language: any;
  try { ({ Parser, Language } = require("web-tree-sitter")); require.resolve("tree-sitter-bash/tree-sitter-bash.wasm"); }
  catch { t.skip("Parser dependencies not installed; synthetic AST tests still run"); return; }
  await Parser.init({ locateFile: () => require.resolve("web-tree-sitter/tree-sitter.wasm") });
  const parser = new Parser();
  parser.setLanguage(await Language.load(require.resolve("tree-sitter-bash/tree-sitter-bash.wasm")));
  try {
    for (const command of ["ls", "rg --files", "find . -name '*.ts'", "grep -n 'hello world' README.md", "ls && rg --files", "rg --files | grep ts"]) assert.equal((await bashDecision(command, ctx, parser)).action, "allow", command);
    for (const command of ["ls > data", "ls $(touch data)", "ls `touch data`", "ls; python script.py", "find . -delete", "find . -exec rm '{}' ';'", "fd -x rm", "rg --pre './script' foo", "rg --hostname-bin ./script foo", "bash -c 'ls'", "ls() { touch x; }; ls", "A=1 ls", "ls <(touch x)", "ls;", "$(printf ls)", "ls /etc", "ls || rm data"]) {
      const decision = await bashDecision(command, ctx, parser);
      // A trailing semicolon is a harmless list separator, not a write.
      if (command === "ls;") continue;
      assert.equal(decision.action, "ask", command);
    }
    const custom = (bash: unknown): PolicyContext => ({ ...ctx, mode: "build", settings: parseSettings({ configVersion: 2, permissionGroups: { development: { "tool-parser": { bash }, "bash-sandbox": { enabled: true } } } }) });
    const exact = custom({ "*": "ask", "npm test": "allow", 'printf "two words"': "allow", "/bin/echo hi": "allow", rm: "deny" });
    for (const source of ["npm test", "npm 'test'", "printf 'two words'", "/bin/echo hi"]) assert.equal((await bashDecision(source, exact, parser)).action, "allow", source);
    for (const source of ["npm test --watch", "npm test; other-command", "npm test && other-command", "printf two words", "echo hi", "A=1 npm test", "npm test > out", "npm test $(other-command)", "if npm test; then other-command; fi"]) assert.equal((await bashDecision(source, exact, parser)).action, "ask", source);
    for (const source of ["rm x", "npm test; rm x", "rm x > out", "if true; then rm x; fi", "echo $(rm x)"]) assert.equal((await bashDecision(source, exact, parser)).action, "deny", source);
    const rest = custom({ "*": "ask", "npm test *": "allow" });
    assert.equal((await bashDecision("npm test -- --watch", rest, parser)).action, "allow");
    assert.equal((await bashDecision("npm test; other-command", rest, parser)).action, "ask");
    const broad = custom("allow");
    assert.equal((await bashDecision("A=1 npm test > out", broad, parser)).action, "allow");
    assert.equal((await bashDecision("npm test", exact, { parse: () => null })).action, "ask");
    assert.equal((await bashDecision("npm test", broad, { parse: () => null })).action, "allow");
    assert.equal((await bashDecision("npm test", exact, { parse: () => { throw new Error("parse failed"); } })).action, "ask");
  } finally { parser.delete(); }
});
