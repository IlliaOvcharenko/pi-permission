// Path normalization/canonicalization adapted from pi-permission-modes (MIT).
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function expandPath(raw: string, home = os.homedir()): string {
  let p = raw.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  if (p.startsWith("@")) p = p.slice(1);
  if (p.includes("\0")) throw new Error("NUL byte in path");
  if (p.startsWith("file://")) p = fileURLToPath(p);
  if (p === "~" || p === "$HOME") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  if (p.startsWith("$HOME/")) return path.join(home, p.slice(6));
  return p;
}
export function absolutePath(root: string, raw: string, home = os.homedir()): string {
  return path.resolve(root, expandPath(raw, home));
}
export function canonicalPath(raw: string): string {
  let current = path.resolve(raw);
  const tail: string[] = [];
  for (let hops = 0; hops < 256; hops++) {
    try { return path.join(realpathSync(current), ...tail); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      try {
        if (lstatSync(current).isSymbolicLink()) {
          current = path.resolve(path.dirname(current), readlinkSync(current));
          continue;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...tail);
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
  throw new Error("Cannot safely resolve path (symlink loop or excessive depth)");
}
export function within(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
export function pathVariants(root: string, raw: string, home?: string): string[] {
  const literal = absolutePath(root, raw, home);
  return [...new Set([literal, canonicalPath(literal)])];
}
/** Configuration command patterns preserve argument boundaries. A final bare
 * star matches additional arguments; quoted text remains one argument. */
export function commandWords(pattern: string): string[] {
  const words: string[] = [];
  let word = "", quote = "", started = false;
  for (const c of pattern) {
    if (quote) { if (c === quote) quote = ""; else word += c; started = true; }
    else if (c === "'" || c === '"') { quote = c; started = true; }
    else if (/\s/.test(c)) { if (started) { words.push(word); word = ""; started = false; } }
    else { if (/[;$`\\|&<>(){}]/.test(c)) throw new Error("Bash rules describe literal commands, not shell source"); word += c; started = true; }
  }
  if (quote) throw new Error("Unclosed quote in Bash permission pattern");
  if (started) words.push(word);
  if (!words.length || !/^[a-zA-Z0-9_./-]+$/.test(words[0])) throw new Error("Bash patterns require a literal executable");
  return words;
}
export function globRegex(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") { i++; out += "(?:.*/)?"; } else out += ".*";
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(out + "$");
}
