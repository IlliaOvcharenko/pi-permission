export const MODES = ["plan", "approve", "build", "yolo"] as const;
export type Mode = (typeof MODES)[number];
export type Action = "allow" | "ask" | "deny";
export interface Trace { group: string; source: string; surface: string; pattern: string; action: Action; ruleAction?: Action; command?: string; explanation?: string }
export interface Decision { action: Action; reason?: string; trace?: Trace[] }
export type Rule = Action | Record<string, Action>;
export type Permission = Record<string, Rule>;
export interface FilesystemSettings {
  readRoots?: string[]; externalRead?: Action; writeRoots?: string[]; writeExtensions?: string[];
  denyRead?: string[]; denyWrite?: string[]; denyDirectoryNames?: string[]; protectedWrite?: string[];
}
export interface PermissionGroup {
  "tool-parser"?: Permission; "bash-sandbox"?: { enabled?: boolean; filesystem?: Pick<FilesystemSettings, "writeRoots" | "denyRead" | "denyWrite">; linux?: { allowNestedUserNamespaces?: boolean } };
  filesystem?: FilesystemSettings; skills?: Rule;
  source: string; base: string;
}
export interface ReadGrant { path: string; kind: "file" | "directory" }
export interface ModeSettings {
  color: "muted" | "mdLink" | "accent" | "error" | `#${string}`;
  systemPrompt: string; systemPromptAppend: string; permissionGroups: string[];
  sources: Record<string, string>;
}
export interface PromptSection {
  when: "sandboxed" | "always" | "never" | string[];
  source: "text" | "mode" | "runtime"; text?: string;
}
export interface Settings {
  configVersion: 2; defaultMode: Mode; cycleOrder: Mode[];
  replacements: { group: string; previousSource: string; source: string }[];
  promptSources: Record<string, { source: string; file?: string }>;
  modes: Record<Mode, ModeSettings>; permissionGroups: Record<string, PermissionGroup>;
  prompts: { removeLegacySections: string[]; sections: Record<string, PromptSection> };
}
export interface PolicyContext {
  root: string; scratch: string; home: string; agentDir: string; mode: Mode;
  readRoots: ReadGrant[]; denyRead: string[]; trustFile: string; settings?: Settings;
}
export type RuntimePath = string | { path: string; literal: true };
export interface RuntimeProfile {
  network: { deniedDomains: string[] };
  filesystem: { allowWrite: RuntimePath[]; denyWrite: RuntimePath[]; denyRead: RuntimePath[] };
  allowNestedUserNamespaces?: boolean;
}
export interface SessionEntryLike { type: string; customType?: string; data?: unknown }
export function isMode(value: unknown, names: readonly string[] = MODES): value is Mode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value) && names.includes(value);
}
