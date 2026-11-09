import { isMode, type Mode, type SessionEntryLike, type Settings } from "./types.ts";
import { DEFAULT_SETTINGS } from "./config.ts";
export const MODE_ENTRY = "pi-perm.mode";
export function savedMode(entries: readonly SessionEntryLike[], names: readonly string[] = Object.keys(DEFAULT_SETTINGS.modes)): Mode | undefined {
  let mode: Mode | undefined;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === MODE_ENTRY) {
      const value = (entry.data as { mode?: unknown } | undefined)?.mode;
      // An entry for a removed mode resets the branch to its configured default,
      // rather than resurrecting an earlier, potentially more powerful mode.
      mode = isMode(value, names) ? value : undefined;
    }
  }
  return mode;
}
export function startMode(options: {
  reason: string; entries: readonly SessionEntryLike[]; defaultMode: Mode; flag?: unknown; inherited?: unknown; modes?: Settings["modes"]; 
}): Mode {
  // Explicit CLI override is startup-only. Never carry process.env from the
  // previous session ahead of the destination's recorded mode.
  const modes = options.modes ?? DEFAULT_SETTINGS.modes;
  const names = Object.keys(modes);
  if (options.reason === "startup" && options.flag !== undefined) {
    if (!isMode(options.flag, names)) throw new Error(`Unknown --perm mode: ${String(options.flag)}`);
    return options.flag;
  }
  const saved = savedMode(options.entries, names);
  if (saved) return saved;
  if (options.reason === "startup" && isMode(options.inherited, names) && options.inherited !== "yolo") return options.inherited;
  return isMode(options.defaultMode, names) && options.defaultMode !== "yolo" ? options.defaultMode : "plan";
}
