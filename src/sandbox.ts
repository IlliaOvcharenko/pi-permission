// POSIX sandbox lifecycle/command transport adapted from pi-permission-modes (MIT).
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { PolicyContext, RuntimeProfile } from "./types.ts";
import { canonicalPath, pathVariants } from "./paths.ts";
import { filesystemPolicy } from "./policy.ts";
import { isYolo, selectedGroups } from "./config.ts";

export interface RuntimeManager {
  isSupportedPlatform(): boolean;
  isSandboxingEnabled(): boolean;
  checkDependenciesAsync(): Promise<{ errors: string[]; warnings?: string[] }>;
  initialize(profile: RuntimeProfile): Promise<void>;
  wrapWithSandbox(command: string, shell?: string, config?: RuntimeProfile, signal?: AbortSignal, attribution?: { commandId: string; commandText: string }): Promise<string>;
  cleanupAfterCommand(): void;
  reset(): Promise<void>;
  annotateStderrWithSandboxFailures?(id: string, text: string): string;
}
export interface ExecOptions {
  onData: (data: Buffer) => void;
  signal?: AbortSignal;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}
export type Runner = (command: string, cwd: string, options: ExecOptions) => Promise<{ exitCode: number | null }>;
export const quote = (text: string): string => "'" + text.replace(/'/g, "'\\''") + "'";
const casePattern = (text: string) => [...text].map(c => /[a-z]/i.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c).join("");
const literal = (text: string) => ({ path: text, literal: true as const });
const globLiteral = (text: string) => text.replace(/[?*\[]/g, c => `[${c}]`);
/** Runtime ? cannot cross separators. Broaden it rather than weakening a deny.
 * Permission stars cross separators; preserve optional directory globstars. */
export function runtimeDenyPattern(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    if (pattern.slice(i, i + 3) === "**/" && (i === 0 || pattern[i - 1] === "/")) { out += "**/"; i += 2; }
    else if (pattern[i] === "*" || pattern[i] === "?") { out += "**"; while (pattern[i + 1] === "*") i++; }
    else out += casePattern(globLiteral(pattern[i]));
  }
  return out;
}
export function sandboxProfile(ctx: PolicyContext): RuntimeProfile {
  const root = canonicalPath(ctx.root);
  const fs = filesystemPolicy(ctx, true);
  const groups = selectedGroups(ctx);
  if (!isYolo(ctx) && !groups.some(([, g]) => g["bash-sandbox"]?.enabled === true)) throw new Error("Bash sandbox is required; refusing execution");
  const hard = fs.denyRead.flatMap(p => [p, canonicalPath(p)]);
  const names = fs.directoryNames.flatMap(name => [
    literal(path.join(root, name)),
    // Runtime 0.0.81 expands read-deny globs on Linux at each wrap and
    // compiles them into Seatbelt rules on macOS. No write-allow globs.
    `${globLiteral(root)}/**/${casePattern(globLiteral(name))}`,
  ]);
  return {
    // Intentionally OMIT allowedDomains. [] would block all traffic instead.
    network: { deniedDomains: [] },
    allowNestedUserNamespaces: groups.some(([, g]) => g["bash-sandbox"]?.linux?.allowNestedUserNamespaces === true) && !groups.some(([, g]) => g["bash-sandbox"]?.linux?.allowNestedUserNamespaces === false),
    filesystem: {
      allowWrite: fs.writeRoots.map(literal),
      denyRead: [...[...new Set(hard)].map(literal), ...names],
      denyWrite: [
        ...[...new Set([...hard, ...fs.denyWrite, ...pathVariants(ctx.root, path.dirname(ctx.trustFile))])].map(literal),
        ...names,
        ...fs.protectedWrite.flatMap(p => path.isAbsolute(p) ? [runtimeDenyPattern(p)] : [...new Set([root, ...fs.writeRoots])].map(r => `${globLiteral(r)}/${runtimeDenyPattern(p)}`)),
      ],
    },
  };
}
export function makeScratch(sessionId: string): string {
  const base = path.join(os.tmpdir(), "pi-permission");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const stat = lstatSync(base);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) {
    throw new Error("Scratch base must be a private directory owned by the current user");
  }
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "session";
  // A fresh private folder for each extension instance. Never reuse an
  // agent-writable command transport directory across reloads.
  return mkdtempSync(path.join(base, safe + "-"));
}
export const spawnCommand: Runner = async (command, cwd, opts) => {
  if (opts.signal?.aborted) throw new Error("aborted");
  return await new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", command], {
      cwd, env: opts.env ?? process.env, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const kill = () => {
      if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
    };
    const clean = () => { if (timer) clearTimeout(timer); opts.signal?.removeEventListener("abort", kill); };
    child.stdout.on("data", opts.onData);
    child.stderr.on("data", opts.onData);
    child.once("error", error => { clean(); reject(error); });
    child.once("close", (code, signal) => {
      // Also kill background descendants when the foreground shell exits.
      kill(); clean();
      if (opts.signal?.aborted) reject(new Error("aborted"));
      else if (timedOut) reject(new Error(`timeout:${opts.timeout}`));
      else resolve({ exitCode: code ?? (signal ? 128 + (os.constants.signals[signal] ?? 1) : null) });
    });
    opts.signal?.addEventListener("abort", kill, { once: true });
    if (opts.signal?.aborted) kill();
    if (opts.timeout && opts.timeout > 0) timer = setTimeout(() => { timedOut = true; kill(); }, opts.timeout * 1000);
  });
};
export class Sandbox {
  private manager?: RuntimeManager;
  private initialized = false;
  private busy = false;
  private transport?: string;
  private queue: Promise<unknown> = Promise.resolve();
  status = "not initialized";
  private load: () => Promise<RuntimeManager>;
  private run: Runner;
  private platform: string;
  constructor(load: () => Promise<RuntimeManager> = async () => {
    const require = createRequire(import.meta.url);
    return require("@anthropic-ai/sandbox-runtime").SandboxManager;
  }, run: Runner = spawnCommand, platform: string = process.platform) {
    this.load = load;
    this.run = run;
    this.platform = platform;
  }
  get active(): boolean { return this.busy; }
  async exec(command: string, cwd: string, opts: ExecOptions, ctx: PolicyContext): Promise<{ exitCode: number | null }> {
    // Serialize runtime wraps/cleanup: profiles cannot be interleaved with
    // another run's cleanup. A rejection never poisons the next invocation.
    const task = this.queue.then(() => this.execute(command, cwd, opts, ctx));
    this.queue = task.catch(() => undefined);
    return await task;
  }
  private async execute(command: string, cwd: string, opts: ExecOptions, ctx: PolicyContext): Promise<{ exitCode: number | null }> {
    this.busy = true;
    let file: string | undefined;
    let wrapped = false;
    try {
      if (opts.signal?.aborted) throw new Error("aborted");
      const env: NodeJS.ProcessEnv = { ...(opts.env ?? process.env), TMPDIR: ctx.scratch, CLAUDE_TMPDIR: ctx.scratch };
      // Avoid shell startup injection even when inherited from the host.
      delete env.BASH_ENV; delete env.ENV;
      if (isYolo(ctx)) return await this.run(command, cwd, { ...opts, env });
      if (this.platform !== "darwin" && this.platform !== "linux") throw new Error("pi-permission sandbox supports macOS and Linux only; refusing unsandboxed execution");
      this.manager ??= await this.load();
      if (!this.manager.isSupportedPlatform()) throw new Error("OS sandbox unsupported; execution refused");
      const profile = sandboxProfile(ctx);
      if (!this.initialized) {
        const deps = await this.manager.checkDependenciesAsync();
        if (deps.errors.length) throw new Error(`Sandbox dependencies: ${deps.errors.join("; ")}`);
        // Initialization errors are never converted into an unsandboxed run.
        try { await this.manager.initialize(profile); }
        catch (error) { await this.manager.reset(); throw error; }
        this.initialized = true;
      }
      if (!this.manager.isSandboxingEnabled()) throw new Error("Sandbox disabled; execution refused");
      this.transport ??= mkdtempSync(path.join(os.tmpdir(), "pi-permission-commands-"));
      file = path.join(this.transport, randomUUID() + ".sh");
      writeFileSync(file, command, { mode: 0o600, flag: "wx" });
      const executionProfile: RuntimeProfile = {
        ...profile,
        filesystem: { ...profile.filesystem, denyWrite: [...profile.filesystem.denyWrite, literal(this.transport)] },
      };
      const id = randomUUID();
      const launcher = `TMPDIR=${quote(ctx.scratch)} CLAUDE_TMPDIR=${quote(ctx.scratch)} /bin/bash --noprofile --norc ${quote(file)}`;
      const text = await this.manager.wrapWithSandbox(launcher, "/bin/bash", executionProfile, opts.signal, { commandId: id, commandText: command });
      wrapped = true;
      if (opts.signal?.aborted) throw new Error("aborted");
      this.status = "ready";
      try { return await this.run(text, cwd, { ...opts, env }); }
      finally {
        const violations = this.manager.annotateStderrWithSandboxFailures?.(id, "");
        if (violations) opts.onData(Buffer.from(violations));
      }
    } catch (error) {
      this.status = String(error);
      throw error;
    } finally {
      try { if (wrapped) this.manager?.cleanupAfterCommand(); }
      finally {
        try { if (file) rmSync(file, { force: true }); }
        finally { this.busy = false; }
      }
    }
  }
  async close(): Promise<void> {
    await this.queue;
    if (this.initialized) await this.manager?.reset();
    this.initialized = false;
    if (this.transport) rmSync(this.transport, { recursive: true, force: true });
    this.transport = undefined;
    this.status = "closed";
  }
}
