// Tree-sitter consent checks; never a process containment boundary.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { absolutePath, commandWords } from "./paths.ts";
import type { Action, Decision, PermissionGroup, PolicyContext, Rule } from "./types.ts";
import { patternRegex, readDecision, strictest } from "./policy.ts";
import { isYolo, selectedGroups } from "./config.ts";

export interface NodeLike { type: string; text: string; children: NodeLike[]; hasError?: boolean }
export interface ParseResult { rootNode: NodeLike; delete?: () => void }
export interface ParserLike { parse(command: string): ParseResult | null }
const CONTAINERS = new Set(["program", "list", "pipeline", "command", "command_name"]);
const LEAVES = new Set(["word", "raw_string", "string", "number"]);
const SEPARATORS = new Set(["&&", "||", ";", "|", "\n"]);
const EXEC_FLAGS = /^(?:-exec(?:dir)?|-ok(?:dir)?|-delete|-fprint0?|-fprintf|-fls|-x|-X|--exec(?:-batch)?|--pre(?:-glob)?|--hostname-bin|--search-zip)(?:=|$)/;
// These are parser capabilities, NOT configured permission actions. Unknown
// programs need an exact argument rule rather than a name-only argument grant.
const UNDERSTOOD_ARGUMENTS = new Set(["ls", "grep", "fd", "fdfind", "rg", "find", "pwd"]);
function literal(node: NodeLike): string | undefined {
  if (node.type === "raw_string" && /^'[^']*'$/.test(node.text)) return node.text.slice(1, -1);
  if (node.type === "string" && /^"[^$`\\]*"$/.test(node.text)) return node.text.slice(1, -1);
  if (["word", "number"].includes(node.type) && !/[$`\\{}~*?\[\]]/.test(node.text)) return node.text;
  return undefined;
}
function evaluate(name: string, g: PermissionGroup, rule: Rule | undefined, words: string[] | undefined, narrowSafe: boolean, argumentSafe: boolean): Decision {
  if (rule === undefined) return { action: "allow" };
  let action: Action = "allow", match: string | undefined;
  if (typeof rule === "string") { action = rule; match = "*"; }
  else for (const [pattern, value] of Object.entries(rule ?? {})) {
    if (pattern === "*") { action = value; match = pattern; continue; }
    if (!words?.length) continue;
    const expected = commandWords(pattern);
    const nameOnly = expected.length === 1;
    const rest = expected.at(-1) === "*" && expected.length > 1;
    const prefix = rest ? expected.slice(0, -1) : expected;
    const matches = words[0] === prefix[0] && (nameOnly || (rest ? words.length >= prefix.length : words.length === prefix.length)) && prefix.slice(1).every((p, i) => patternRegex(p).test(words[i + 1]));
    if (!matches) continue;
    // Established denies survive unsupported shell surroundings. A name-only
    // rule can deny even when arguments are dynamic; it cannot narrowly allow.
    action = value === "allow" && (!narrowSafe || (nameOnly && !argumentSafe)) ? "ask" : value;
    match = pattern;
  }
  // Unknown structures require consent unless the effective rule is genuinely
  // unrestricted (* or scalar), not a parser-derived narrow allow.
  if (!narrowSafe && match === undefined) action = "ask";
  return { action, reason: match ? `${name} (${g.source}): bash ${match} → ${action}` : "Unsupported Bash structure requires approval", ...(match ? { trace: [{ group: name, source: g.source, surface: "bash", pattern: match, action }] } : {}) };
}
export function classifyTree(root: NodeLike, ctx: PolicyContext): Decision {
  let unsupported = root.hasError === true;
  const commands: { words?: string[]; safe: boolean; argumentsSafe: boolean }[] = [];
  const walk = (node: NodeLike): void => {
    if (node.type === "command") {
      const head = node.children.find(n => n.type === "command_name");
      const executable = head && (head.children.length === 1 ? literal(head.children[0]) : /^[\w./-]+$/.test(head.text) ? head.text : undefined);
      let safe = !!executable, argumentsSafe = !!executable && UNDERSTOOD_ARGUMENTS.has(executable);
      const args: string[] = [];
      for (const n of node.children) {
        if (n === head) continue;
        const value = literal(n);
        if (value === undefined) { safe = false; continue; }
        args.push(value);
        if (EXEC_FLAGS.test(value) || ["-L", "--follow", "-R", "--dereference-recursive", "-z"].includes(value) || (executable && ["fd", "fdfind"].includes(executable) && /^-[^-]*[xX]/.test(value))) argumentsSafe = false;
        const candidate = value.startsWith("-") && value.includes("=") ? value.slice(value.indexOf("=") + 1) : value;
        try {
          if (/^(?:\/|~\/|\.\.?\/)/.test(candidate) || (!candidate.startsWith("-") && existsSync(absolutePath(ctx.root, candidate, ctx.home)))) {
            if (readDecision(ctx, candidate).action !== "allow") argumentsSafe = false;
          }
        } catch { argumentsSafe = false; } // Keep established denies in other components.
      }
      if (safe && args.length === 0) argumentsSafe = true;
      commands.push({ words: executable ? [executable, ...args] : undefined, safe, argumentsSafe });
    }
    if (!CONTAINERS.has(node.type) && !LEAVES.has(node.type) && !SEPARATORS.has(node.type)) unsupported = true;
    for (const child of node.children) walk(child);
  };
  walk(root);
  return strictest(...selectedGroups(ctx).map(([name, g]) => {
    const rule = g["tool-parser"]?.bash ?? g["tool-parser"]?.["*"];
    if (!commands.length) return evaluate(name, g, rule, undefined, false, false);
    return strictest(...commands.map(c => evaluate(name, g, rule, c.words, !unsupported && c.safe, c.argumentsSafe)));
  }));
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
  let tree: ParseResult | null = null;
  try {
    const active = parser ?? await (parserPromise ??= loadParser());
    tree = active?.parse(command) ?? null;
    if (tree) return classifyTree(tree.rootNode, ctx);
  } catch { /* Fall back only to explicit broad consent, never a narrow allow. */ }
  finally { tree?.delete?.(); }
  return strictest(...selectedGroups(ctx).map(([n, g]) => evaluate(n, g, g["tool-parser"]?.bash ?? g["tool-parser"]?.["*"], undefined, false, false)));
}
