import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SETTINGS, isYolo, loadSettings, modeSettings, resolvePath } from "./config.ts";
import { approvedPolicy, describeGrant, savePolicy } from "./grants.ts";
import { absolutePath, canonicalPath, globRegex } from "./paths.ts";
import { filesystemPolicy, readDecision, READ_TOOLS, toolDecision, WRITE_TOOLS } from "./policy.ts";
import { sandboxProfile } from "./sandbox.ts";
import { bashDecision } from "./bash.ts";
import { makeScratch, Sandbox } from "./sandbox.ts";
import { MODE_ENTRY, savedMode, startMode } from "./sessions.ts";
import { applyPromptSections, promptSections } from "./prompts.ts";
import { MODES, isMode, type Mode, type PolicyContext, type ReadGrant } from "./types.ts";

type SDK = typeof import("@earendil-works/pi-coding-agent");
interface Dependencies { sandbox?: Sandbox; scratch?: (id: string) => string; home?: string; agentDir?: string }
/** Theme.style accepts concrete RGB colors; never pass hex to token lookup. */
export function modeLabel(theme: ExtensionContext["ui"]["theme"] | undefined, color: string, text: string): string {
  if (/^#[0-9a-fA-F]{6}$/.test(color)) {
    return theme?.style ? theme.style(text, { fg: { kind: "rgb", r: parseInt(color.slice(1, 3), 16), g: parseInt(color.slice(3, 5), 16), b: parseInt(color.slice(5, 7), 16) } }) : text;
  }
  return theme?.fg ? theme.fg(color as "muted", text) : text;
}

/** Exported seam: tests exercise real hooks without loading or activating Pi. */
export function createExtension(pi: ExtensionAPI, sdk: SDK, dependencies: Dependencies = {}): void {
  const home = dependencies.home ?? os.homedir();
  const agentDir = dependencies.agentDir ?? sdk.getAgentDir();
  const stateDir = path.join(agentDir, "pi-perm");
  const trustFile = path.join(stateDir, "trust", "projects.json");
  const configFile = path.join(stateDir, "config.json");
  let settings = DEFAULT_SETTINGS;
  const sandbox = dependencies.sandbox ?? new Sandbox();
  let mode: Mode = "plan";
  let policy: PolicyContext | undefined;
  let error: string | undefined = "pi-perm has not initialized";
  let projectFile = "";
  let activeSignature = "";
  const projectText = (): string => {
    try { return readFileSync(projectFile, "utf8"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return ""; throw e; }
  };
  const signature = (c: PolicyContext): string => {
    const identities = Object.values(c.settings!.permissionGroups).flatMap(g => (g.filesystem?.readRoots ?? []).filter(raw => !raw.includes("${scratch}")).map(raw => {
      const target = resolvePath(c, g, raw);
      try { const st = statSync(target); return [target, canonicalPath(target), st.isDirectory() ? "directory" : st.isFile() ? "file" : "other"]; }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return [target, "missing"]; throw e; }
    }));
    return createHash("sha256").update(JSON.stringify([canonicalPath(projectFile), projectText(), identities])).digest("hex");
  };
  let conflict = false;
  const sessionApprovals = new Set<string>();
  const readCalls = new Map<string, { mode: Mode; grants: ReadGrant[]; input: string; name: string; approved: boolean }>();
  const inherited = process.env.PI_PERM_MODE;

  const status = (ctx: ExtensionContext) => {
    const definition = settings.modes[mode];
    const name = modeLabel(ctx.ui.theme, definition?.color ?? "muted", mode);
    if (ctx.hasUI) ctx.ui.setStatus("pi-perm", `pi-perm: ${name}${error || conflict ? " [blocked]" : mode === "yolo" ? " [UNSANDBOXED]" : " [sandbox required]"}`);
  };
  const current = (): PolicyContext => {
    if (!policy || error) throw new Error(error ?? "pi-perm not initialized");
    if (signature(policy) !== activeSignature) {
      error = "Project policy or read-root identity changed; /reload and review trust again";
      sessionApprovals.clear(); readCalls.clear();
      throw new Error(error);
    }
    return { ...policy, mode };
  };
  const confirm = async (ctx: ExtensionContext, title: string, details: string): Promise<boolean> => {
    if (!ctx.hasUI || details.length > 16000) return false;
    const key = `${mode}:${title}:${details}`;
    if (sessionApprovals.has(key)) return true;
    const choice = await ctx.ui.select(`${title}\n${details}`, ["Allow once", "Allow for session (same request)", "Deny"]);
    if (choice === "Allow for session (same request)") sessionApprovals.add(key);
    return choice === "Allow once" || choice === "Allow for session (same request)";
  };
  const changeMode = async (next: Mode, ctx: ExtensionContext) => {
    if (sandbox.active) { if (ctx.hasUI) ctx.ui.notify("Wait for the running Bash command before changing mode", "warning"); return; }
    if (next === "yolo" && (!ctx.hasUI || !(await ctx.ui.confirm("Enter YOLO?", "No sandbox or permission prompts. Use only in an already isolated disposable container.")))) return;
    mode = next;
    pi.appendEntry(MODE_ENTRY, { mode });
    process.env.PI_PERM_MODE = mode;
    sessionApprovals.clear(); readCalls.clear(); status(ctx);
  };

  pi.registerFlag("perm", { description: "pi-perm startup mode", type: "string" });
  pi.registerCommand("perm", {
    description: "pi-perm: plan | approve | build | yolo | status | config | trust | revoke | clear-approvals",
    handler: async (args, ctx) => {
      const command = args.trim() || "status";
      if (isMode(command, Object.keys(settings.modes))) { await changeMode(command, ctx); return; }
      let c: PolicyContext | undefined;
      if (!error && policy) { try { c = current(); } catch (e) { error = String(e); } }
      if (command === "config") {
        ctx.ui.notify(JSON.stringify({ configFile, projectFile, settings, activeMode: c ? modeSettings(c) : undefined, filesystem: c ? filesystemPolicy(c) : undefined, bashSandbox: c ? sandboxProfile(c) : undefined, promptSections: c ? promptSections(c) : {}, error }, null, 2), "info");
        return;
      }
      if (command === "clear-approvals") { sessionApprovals.clear(); ctx.ui.notify("Session tool approvals cleared", "info"); return; }
      if (command === "trust") { await ctx.reload(); return; }
      if (command === "revoke") {
        if (sandbox.active) { ctx.ui.notify("Wait for running Bash before revoking grants", "warning"); return; }
        if (ctx.hasUI && await ctx.ui.confirm("Revoke project policy trust?", canonicalPath(ctx.cwd))) {
          savePolicy(trustFile, ctx.cwd);
          error = "Project policy trust revoked; remove project config or /reload to review it";
          sessionApprovals.clear(); readCalls.clear();
        }
        return;
      }
      if (command !== "status") { ctx.ui.notify("Unknown pi-perm command", "warning"); return; }
      ctx.ui.notify(JSON.stringify({ mode, modes: Object.keys(settings.modes), cycleOrder: settings.cycleOrder, configFile, error, conflict, sandbox: sandbox.status, scratch: policy?.scratch, groups: settings.modes[mode].permissionGroups.map(name => ({ name, source: settings.permissionGroups[name].source })), filesystem: c ? filesystemPolicy(c) : undefined, trustFile }, null, 2), "info");
    },
  });
  pi.registerShortcut("alt+m", {
    description: "Cycle pi-perm modes in configured cycleOrder",
    handler: async ctx => {
      const cycle = settings.cycleOrder;
      await changeMode(cycle[(cycle.indexOf(mode) + 1) % cycle.length], ctx);
    },
  });
  pi.on("session_start", async (event, ctx) => {
    sessionApprovals.clear(); readCalls.clear(); policy = undefined;
    error = "pi-perm is loading configuration";
    try {
      conflict = pi.getCommands().some(c => c.sourceInfo?.path?.includes("pi-permission-modes"));
      projectFile = path.join(ctx.cwd, sdk.CONFIG_DIR_NAME, "pi-perm.json");
      const sourceText = projectText();
      if (sourceText && !ctx.isProjectTrusted()) throw new Error("Pi project trust is required before loading project policy");
      const candidate = loadSettings(configFile, projectFile);
      if (projectText() !== sourceText) throw new Error("Project policy changed while loading; reload to review the new content");
      mode = startMode({ reason: event.reason, entries: ctx.sessionManager.getBranch(), defaultMode: candidate.defaultMode, flag: pi.getFlag("perm"), inherited, modes: candidate.modes });
      // Persist startup as well as explicit mode changes, so new sessions and
      // reloads never borrow the previously open session's environment mode.
      if (savedMode(ctx.sessionManager.getBranch(), Object.keys(settings.modes)) !== mode) pi.appendEntry(MODE_ENTRY, { mode });
      process.env.PI_PERM_MODE = mode;
      const scratch = (dependencies.scratch ?? makeScratch)(ctx.sessionManager.getSessionId());
      const next: PolicyContext = {
        root: canonicalPath(ctx.cwd), scratch: canonicalPath(scratch), home, agentDir, mode,
        readRoots: [], trustFile, settings: candidate, denyRead: [],
      };
      const nextSignature = signature(next);
      const digest = createHash("sha256").update(JSON.stringify([nextSignature, candidate])).digest("hex");
      if (sourceText && approvedPolicy(trustFile, ctx.cwd) !== digest) {
        const details = `${canonicalPath(ctx.cwd)}\n${projectFile}\nSHA-256: ${digest}\nThis configuration can RELAX global permissions, replace groups, and change prompts. Review referenced prompt files too.\n${sourceText}`;
        if (!ctx.hasUI || details.length > 16000 || !(await ctx.ui.confirm("Trust project permission policy?", details))) throw new Error("Project policy not approved; /perm trust or /reload to review again");
        if (signature(next) !== nextSignature || JSON.stringify(loadSettings(configFile, projectFile)) !== JSON.stringify(candidate)) throw new Error("Project policy or referenced prompt changed during trust review");
        savePolicy(trustFile, ctx.cwd, digest);
      }
      for (const name of MODES) if (name !== "yolo") sandboxProfile({ ...next, mode: name });
      if (signature(next) !== nextSignature) throw new Error("Project policy changed during initialization");
      settings = candidate;
      activeSignature = nextSignature;
      policy = next;
      error = undefined;
      if (conflict && ctx.hasUI) ctx.ui.notify("Disable pi-permission-modes before using pi-perm; tool execution is blocked while both are loaded", "error");
    } catch (e) {
      error = String(e);
      if (ctx.hasUI) ctx.ui.notify(`pi-perm failed closed: ${error}`, "error");
    }
    status(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => {
    mode = savedMode(ctx.sessionManager.getBranch(), Object.keys(settings.modes)) ?? settings.defaultMode;
    process.env.PI_PERM_MODE = mode;
    sessionApprovals.clear(); readCalls.clear(); status(ctx);
  });
  pi.on("session_shutdown", async () => { sessionApprovals.clear(); readCalls.clear(); await sandbox.close(); });
  pi.on("before_agent_start", (event) => {
    const sections = event.systemPromptOptions.sections ??= {};
    if (!error && !conflict && policy) {
      try { applyPromptSections(sections, current()); return; }
      catch (e) { error = String(e); }
    }
    {
      for (const name of Object.keys(sections)) if (name === "pi_perm" || name.startsWith("pi_perm_")) delete sections[name];
      sections.pi_perm_runtime = `pi-perm failed closed: ${error ?? "Conflicting permission extensions"}. Do not execute tools; ask the user to fix the configuration.`;
    }
  });
  pi.on("tool_call", async (event, ctx) => {
    if (conflict) return { block: true, reason: "Two permission extensions are loaded; disable the old one and reload" };
    if (error) return { block: true, reason: `pi-perm failed closed: ${error}` };
    let c: PolicyContext;
    try { c = current(); } catch (e) { return { block: true, reason: String(e) }; }
    if (isYolo(c)) return;
    const input = event.input as Record<string, unknown>;
    const raw = typeof input.path === "string" ? input.path : undefined;
    const decision = event.toolName === "bash"
      ? await bashDecision(String(input.command ?? ""), c)
      : toolDecision(c, event.toolName, raw, JSON.stringify(input));
    if (decision.action === "deny") return { block: true, reason: decision.reason };
    if (decision.action === "ask" && !(await confirm(ctx, `Allow ${event.toolName}?`, `${decision.reason ?? ""}\n${JSON.stringify(decision.trace ?? [])}\n${JSON.stringify(input, null, 2)}`))) {
      return { block: true, reason: "Permission refused (or no UI / request too large to review). Do not retry or rephrase it." };
    }
    if (READ_TOOLS.has(event.toolName) || WRITE_TOOLS.has(event.toolName)) {
      const grants = READ_TOOLS.has(event.toolName) && decision.action === "ask" ? [describeGrant(raw ?? ".", c.root, home)] : [];
      readCalls.set(event.toolCallId, { mode, grants, input: JSON.stringify(input), name: event.toolName, approved: decision.action === "ask" });
    }
  });
  pi.on("tool_execution_end", event => { readCalls.delete(event.toolCallId); });

  // Wrap file tools so recursive searches cannot bypass denies by targeting a
  // parent directory. Never follow descendant symlinks into unapproved roots.
  const factories = {
    read: sdk.createReadToolDefinition, write: sdk.createWriteToolDefinition,
    edit: sdk.createEditToolDefinition, grep: sdk.createGrepToolDefinition,
    find: sdk.createFindToolDefinition, ls: sdk.createLsToolDefinition,
  };
  for (const [name, factory] of Object.entries(factories)) {
    const definition = factory(process.cwd());
    pi.registerTool({
      ...definition,
      ...(name === "find" ? { description: "Find files by *, ** and ? glob, skipping denied paths and descendant symlinks. Does not apply gitignore." } : {}),
      ...(name === "grep" ? { description: "Search approved files using ripgrep regex, skipping denied paths and descendant symlinks. Does not apply gitignore." } : {}),
      executionMode: "sequential",
      async execute(id: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: ExtensionContext) {
        if (conflict || error) throw new Error(error ?? "Conflicting permission extensions");
        const c = current();
        const approval = readCalls.get(id);
        const valid = approval?.mode === mode && approval.name === name && approval.input === JSON.stringify(params);
        const once = valid ? approval!.grants : [];
        const decision = READ_TOOLS.has(name) ? readDecision(c, params.path ?? ".", once, name) : toolDecision(c, name, params.path);
        if (decision.action === "deny" || (decision.action === "ask" && !(valid && approval!.approved))) throw new Error(decision.reason ?? "Permission changed before execution; request approval again");
        if (isYolo(c) || name === "read" || WRITE_TOOLS.has(name)) {
          const tool = factory(ctx.cwd);
          return await (tool.execute as any)(id, params, signal, onUpdate, ctx);
        }
        return searchFiles(name, params, c, once, signal, sdk);
      },
    } as any);
  }
  const bash = sdk.createBashToolDefinition(process.cwd(), {
    operations: {
      exec: async (command, cwd, opts) => {
        if (conflict || error) throw new Error(error ?? "Conflicting permission extensions");
        return await sandbox.exec(command, cwd, opts, current());
      },
    },
  });
  pi.registerTool({ ...bash, executionMode: "sequential", promptGuidelines: ["Bash always runs sandboxed except in YOLO; use TMPDIR for temporary files."] });
}

function searchFiles(name: string, params: any, ctx: PolicyContext, once: ReadGrant[], signal: AbortSignal | undefined, sdk: SDK): any {
  const root = absolutePath(ctx.root, params.path ?? ".", ctx.home);
  const limit = Math.max(1, Math.min(Number(params.limit) || (name === "grep" ? 100 : 1000), 10000));
  const glob = params.glob ?? (name === "find" ? params.pattern : undefined);
  if (glob && (typeof glob !== "string" || glob.length > 256)) throw new Error("Glob must be at most 256 characters");
  const match = glob ? globRegex(glob) : undefined;
  const lines: string[] = [];
  let visited = 0;
  let reached = false;
  function check(file: string): boolean { return readDecision(ctx, file, once, name).action === "allow"; }
  function visit(file: string, top = false): void {
    if (signal?.aborted) throw new Error("aborted");
    if (++visited > 100000) throw new Error("Search scan limit reached; narrow the search path");
    if (!check(file) || reached) return;
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() && !top) return;
    const directory = stat.isDirectory() || (top && stat.isSymbolicLink() && describeGrant(file, ctx.root, ctx.home).kind === "directory");
    if (directory) {
      for (const child of readdirSync(file).sort()) {
        const full = path.join(file, child);
        if (!check(full)) continue;
        if (name === "ls") {
          const st = lstatSync(full);
          lines.push(child + (st.isDirectory() ? "/" : st.isSymbolicLink() ? "@" : ""));
          if (lines.length >= limit) { reached = true; break; }
        } else visit(full);
        if (reached) break;
      }
    } else if (stat.isFile() || (top && stat.isSymbolicLink())) {
      const relative = path.relative(root, file).split(path.sep).join("/") || path.basename(file);
      if (match && !match.test(glob.includes("/") ? relative : path.basename(file))) return;
      if (name !== "grep") lines.push(relative);
      else {
        const args = ["--no-config", "--color=never", "--line-number", "--with-filename", "--max-count", String(limit), "--max-columns", "500"];
        if (params.ignoreCase) args.push("--ignore-case");
        if (params.literal) args.push("--fixed-strings");
        if (params.context) args.push("--context", String(Math.min(Math.max(0, params.context), 20)));
        args.push("-e", String(params.pattern), "--", file);
        const result = spawnSync("rg", args, { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, signal });
        if (result.error) throw new Error(`Search failed; ripgrep must be installed by the user: ${result.error.message}`);
        if (result.status !== 0 && result.status !== 1) throw new Error(result.stderr || "ripgrep failed");
        if (result.stdout) lines.push(...result.stdout.trimEnd().split("\n"));
      }
      if (lines.length >= limit) reached = true;
    }
  }
  visit(root, true);
  const text = lines.slice(0, limit).join("\n") || "No results";
  const truncated = sdk.truncateHead(text);
  return {
    content: [{ type: "text", text: truncated.content + (reached ? `\n[Result limit ${limit} reached; narrow the search]` : "") + (truncated.truncated ? "\n[Output truncated; narrow the search]" : "") }],
    details: { truncation: truncated.truncated ? truncated : undefined },
  };
}

export default async function piPerm(pi: ExtensionAPI): Promise<void> {
  const sdk = await import("@earendil-works/pi-coding-agent");
  createExtension(pi, sdk);
}
