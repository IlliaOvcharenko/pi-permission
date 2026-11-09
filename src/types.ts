export const MODES = ["plan", "approve", "build", "yolo"] as const;
export type Mode = (typeof MODES)[number];
export type Action = "allow" | "ask" | "deny";
export interface Decision { action: Action; reason?: string }
export type Rule = Action | Record<string, Action | { action: Action; reason?: string }>;
export type Permission = Record<string, Rule>;
export interface SafeCommandRule { safeCommands: string[]; action: Action }
/** Parsed group rules. Safe Bash rules remain distinct from whole-line globs. */
export interface PermissionGroup { permission: Permission; safeBash?: SafeCommandRule }
export interface ReadGrant { path: string; kind: "file" | "directory" }
export interface ReadSettings { allow: string[]; deny: string[] }
export interface SandboxSettings {
  enabled: boolean; writable: boolean; allowWrite: string[]; denyRead: string[]; denyWrite: string[];
  allowLocalBinding: boolean;
  macos: { enableWeakerNetworkIsolation: boolean };
  linux: { allowNestedUserNamespaces: boolean };
}
export interface ModeSettings {
  color: "muted" | "mdLink" | "accent" | "error";
  systemPrompt: string; systemPromptAppend: string;
  sandbox: SandboxSettings; permission: Permission;
  groups: string[]; safeBash?: SafeCommandRule;
}
export interface PromptSection {
  when: "sandboxed" | "always" | "never" | string[];
  source: "text" | "mode" | "runtime";
  text?: string;
}
export interface Settings {
  defaultMode: Mode; cycleOrder: Mode[]; read: ReadSettings;
  modes: Record<Mode, ModeSettings>;
  permissionGroups: Record<string, PermissionGroup>;
  prompts: { removeLegacySections: string[]; sections: Record<string, PromptSection> };
}
export interface ProjectMode {
  permission?: Permission;
  sandbox?: Partial<Pick<SandboxSettings, "writable" | "allowWrite" | "denyRead" | "denyWrite" | "allowLocalBinding">>;
}
export interface ProjectSettings { read: ReadSettings; modes?: Record<string, ProjectMode> }
export interface PolicyContext {
  root: string; scratch: string; home: string; agentDir: string; mode: Mode;
  readRoots: ReadGrant[]; denyRead: string[]; trustFile: string;
  settings?: Settings; project?: ProjectSettings;
}
export type RuntimePath = string | { path: string; literal: true };
export interface RuntimeProfile {
  network: { deniedDomains: string[]; allowLocalBinding: boolean };
  filesystem: { allowWrite: RuntimePath[]; denyWrite: RuntimePath[]; denyRead: RuntimePath[] };
  enableWeakerNetworkIsolation?: boolean;
  allowNestedUserNamespaces?: boolean;
}
export interface SessionEntryLike { type: string; customType?: string; data?: unknown }
export function isMode(value: unknown, names: readonly string[] = MODES): value is Mode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value) && names.includes(value);
}
