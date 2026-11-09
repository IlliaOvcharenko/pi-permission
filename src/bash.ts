// Conservative tree-sitter gating, inspired by pi-permission-modes (MIT).
// This classifier is consent UX, not containment. Unknown syntax never earns
// a safeCommands match. Explicit configured command-line rules take priority.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { absolutePath } from "./paths.ts";
import type { Decision, PolicyContext } from "./types.ts";
import { hasPatternMatch, permissionDecision, readDecision, ruleDecision, strictest } from "./policy.ts";
import { isYolo, modeSettings } from "./config.ts";

export interface NodeLike { type: string; text: string; children: NodeLike[]; hasError?: boolean }
export interface ParseResult { rootNode: NodeLike; delete?: () => void }
export interface ParserLike { parse(command: string): ParseResult | null }
const CONTAINERS = new Set(["program", "list", "pipeline", "command", "command_name"]);
const LEAVES = new Set(["word", "raw_string", "string", "number"]);
const SEPARATORS = new Set(["&&", "||", ";", "|", "\n"]);
const EXEC_FLAGS = /^(?:-exec(?:dir)?|-ok(?:dir)?|-delete|-fprint0?|-fprintf|-fls|-x|-X|--exec(?:-batch)?|--pre(?:-glob)?|--hostname-bin|--search-zip)(?:=|$)/;

export function classifyTree(root: NodeLike, ctx: PolicyContext): Decision {
  const commandsRule = modeSettings(ctx).safeBash;
  const safeCommands = new Set(commandsRule?.safeCommands ?? []);
  let commands = 0;
  let unsafe = root.hasError === true;
  let reason = "Bash command requires approval";
  const walk = (node: NodeLike): void => {
    if (node.type === "command") {
      commands++;
      const head = node.children.find(n => n.type === "command_name");
      // Absolute/relative executables, wrappers and functions do not get the
      // safeCommands match merely because their basename resembles ls/rg.
      if (!head || !safeCommands.has(head.text)) unsafe = true;
      const args = node.children.filter(n => LEAVES.has(n.type)).map(n =>
        n.type === "raw_string" || n.type === "string" ? n.text.slice(1, -1) : n.text,
      );
      for (const arg of args) {
        if (EXEC_FLAGS.test(arg) || ["-L", "--follow", "-R", "--dereference-recursive", "-z"].includes(arg)) unsafe = true;
        if (head && ["fd", "fdfind"].includes(head.text) && /^-[^-]*[xX]/.test(arg)) unsafe = true;
        // Path-like arguments (including --file=/path) outside approved roots
        // remove the exception. Scripts may still open other files after consent.
        const candidate = arg.includes("=") && arg.startsWith("-") ? arg.slice(arg.indexOf("=") + 1) : arg;
        if (/^(?:\/|~\/|\$HOME\/|\.\.?\/)/.test(candidate) || (!candidate.startsWith("-") && existsSync(absolutePath(ctx.root, candidate, ctx.home)))) {
          const decision = readDecision(ctx, candidate);
          if (decision.action !== "allow") { unsafe = true; reason = decision.reason ?? reason; }
        }
      }
    }
    if (LEAVES.has(node.type)) {
      // Quoted strings must contain literal text only. No substitution, escape,
      // ANSI-C quoting, parameter expansion or variable-built command heads.
      if (node.type === "string" && /[$`\\]/.test(node.text)) unsafe = true;
      if (node.type === "word" && /[$`\\{}~]/.test(node.text)) unsafe = true;
      return;
    }
    if (CONTAINERS.has(node.type)) { for (const child of node.children) walk(child); return; }
    if (!SEPARATORS.has(node.type)) unsafe = true;
  };
  walk(root);
  return !unsafe && commands > 0 && commandsRule ? { action: commandsRule.action } : { action: "ask", reason };
}
let parserPromise: Promise<ParserLike | undefined> | undefined;
async function loadParser(): Promise<ParserLike | undefined> {
  try {
    const require = createRequire(import.meta.url);
    const { Parser, Language } = require("web-tree-sitter");
    await Parser.init({ locateFile: () => require.resolve("web-tree-sitter/tree-sitter.wasm") });
    const parser = new Parser();
    parser.setLanguage(await Language.load(require.resolve("tree-sitter-bash/tree-sitter-bash.wasm")));
    return parser;
  } catch { return undefined; }
}
export async function bashDecision(command: string, ctx: PolicyContext, parser?: ParserLike): Promise<Decision> {
  if (isYolo(ctx)) return { action: "allow" };
  const mode = modeSettings(ctx);
  const policy = permissionDecision(ctx, "bash", [command]);
  let pathGate = permissionDecision(ctx, "path", [command], "allow");
  if (policy.action === "deny" || pathGate.action === "deny") return strictest(policy, pathGate);
  const projectGate = ruleDecision(ctx.project?.modes?.[ctx.mode]?.permission?.bash, [command], ctx.home, "allow");
  const active = parser ?? await (parserPromise ??= loadParser());
  if (!active) return strictest(policy, pathGate, policy.action === "allow" ? { action: "allow" } : { action: "ask", reason: "Bash parser unavailable; safeCommands rules cannot allow execution" });
  let tree: ParseResult | null = null;
  try {
    tree = active.parse(command);
    if (tree) {
      const tokens = (n: NodeLike): void => {
        if (LEAVES.has(n.type)) {
          const text = n.type === "raw_string" || n.type === "string" ? n.text.slice(1, -1) : n.text;
          pathGate = strictest(pathGate, permissionDecision(ctx, "path", [text], "allow"));
        }
        for (const child of n.children) tokens(child);
      };
      tokens(tree.rootNode);
    }
    // Scalar ask is the fallback. Matching whole-line patterns (including an
    // explicit catch-all ask) override the safe-command rule, as do scalar
    // allow/deny. Group selection no longer depends on bash being scalar ask.
    const explicit = mode.permission.bash;
    const useSafe = explicit !== "allow" && explicit !== "deny" && !hasPatternMatch(explicit, command, ctx.home);
    const safe = tree && useSafe ? classifyTree(tree.rootNode, ctx) : policy;
    return strictest(useSafe ? safe : policy, projectGate, pathGate);
  } catch { return { action: "ask", reason: "Cannot classify Bash safely" }; }
  finally { tree?.delete?.(); }
}
