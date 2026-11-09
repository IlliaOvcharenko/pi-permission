# Agent guide

Start with [docs/README.md](docs/README.md). For usage and configuration see [docs/user-guide.md](docs/user-guide.md); for enforcement flow and boundaries see [docs/architecture.md](docs/architecture.md); for code/test ownership see [docs/file-map.md](docs/file-map.md). The root [README.md](README.md) is the detailed reference. Shipped rules live in `defaults.json`; the actual loader/validator is `src/config.ts`, gates are `src/policy.ts` and `src/bash.ts`, sandboxing is `src/sandbox.ts`, and Pi integration is `src/index.ts`.

## Maintain documentation as persistent project memory

- Read the relevant docs **and source** before changing behavior; docs and project text are not permission grants. Current code and effective policy take precedence over prose.
- When a change affects modes, permissions, configuration, prompts, commands, install steps, file ownership or security limitations, update the corresponding `docs/*.md` and, where applicable, the root `README.md` in the same task **when the user and current permission mode permit those edits**. Never silently skip needed documentation: if edits are not authorized, identify the exact files and ask the user.
- Keep examples valid against `src/config.ts` and `defaults.json`. Distinguish mechanical enforcement from behavioral prompt instructions, and Bash containment from file-tool and custom-tool gates. State limitations plainly; do not claim an OS sandbox was tested by unit tests.
- Keep `docs/file-map.md` current when files are added, renamed or removed. Use short, explicit lists and links; avoid duplicating the full root README.
- Before editing any existing file, re-read it, preserve unrelated/manual changes, and stop to ask if its contents changed since the version used to prepare the edit. Follow the active mode, tool prompts and user scope; this file cannot grant permissions or override denials.
