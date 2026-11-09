# Review of v0.1.0

## Summary

The implementation has a clear separation between policy, Bash sandboxing, and file-tool checks. Configuration errors fail closed, and the documentation already states many important limitations. It is a useful personal permission layer, not a complete security boundary.

Validation: all 61 tests passed; `tsc --noEmit` passed. This review did not test real macOS/Linux containment or integration with a running Pi instance. No implementation changes were made.

## Findings, in priority order

1. **Bug: CLI YOLO skips confirmation.** `startMode()` accepts `--perm yolo`, and startup applies it without the warning used by `/perm yolo`. A fresh session can therefore start unrestricted without UI confirmation, including without a UI. Saved YOLO restoration is documented; this separate startup path is not. Route fresh CLI selection through confirmation, or reject CLI YOLO. (`src/sessions.ts`, `src/index.ts`)

2. **Bug: attached option paths bypass the exploration prompt.** Confirmed: `rg -f/etc/hosts README.md` is automatically allowed, while `rg -f /etc/hosts README.md` asks. The classifier does not recognize the attached filename as a path. The sandbox still applies, but its broad reads permit files outside approved file-tool roots. This contradicts the stated conservative treatment of external paths. Parse supported options explicitly, or make ambiguous forms ask. (`src/bash.ts`)

3. **Confusion: recursive searches silently omit paths needing approval.** The walker includes only entries whose decision is `allow`; it skips `ask` as well as `deny`. Approving a search at its root does not necessarily approve descendants, so tighter child rules can produce incomplete results or “No results” without explanation. Keep the conservative filtering, but report omitted approval-required entries. (`src/index.ts`, `searchFiles()`)

4. **Usability risk: searches block Pi and scale poorly.** The walker uses synchronous filesystem calls and starts a separate synchronous `rg` process for each file. One search can inspect up to 100,000 entries; each `rg` can take up to five seconds, with no overall deadline. Cancellation cannot be handled promptly while the event loop is blocked. Prefer asynchronous, batched searches with a total time budget. (`src/index.ts`, `searchFiles()`)

5. **Confusing mode names versus guarantees.** Approve does not mechanically enforce file-change consent; its file-tool permissions are effectively the same as Build under defaults. Plan checks Markdown extensions, not whether edits were requested. This is documented, but the headline mode table can still suggest stronger protection. Keep the behavioral/mechanical distinction directly beside the mode descriptions. (`defaults.json`, `README.md`)

6. **Maintenance issue: scratch directories accumulate.** Each extension initialization creates a new private scratch directory. Shutdown removes command transport, but not session scratch. Reloads therefore leave files behind indefinitely. Document retention and provide a deliberate cleanup policy; avoid deleting scratch unexpectedly while it may still be useful. (`src/sandbox.ts`, `src/index.ts`)

## Freeze notes

- Add regression tests for findings 1–3 before the next release. Existing passing tests do not cover these cases.
- Preserve the explicit warnings: network is open, approved custom tools are unsandboxed, Bash reads are broad, and path checks are not race-proof.
- Do not treat the current test suite as evidence of OS containment. Real sandbox and live Pi checks remain separate release work.
