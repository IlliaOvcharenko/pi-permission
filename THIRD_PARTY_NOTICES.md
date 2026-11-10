# Third-party notices

`pi-permission` adapts path normalization/canonicalization and the POSIX sandbox
lifecycle/command-file transport approach from **pi-permission-modes 2.7.2**:

- Author: Nico Merz
- Source: https://github.com/wynainfo/pi-permission-modes
- License: MIT, Copyright (c) 2026 Nico Merz
- The applicable notice and license terms are included in `LICENSE`.

The conservative tree-sitter classifier is informed by the same project's
Bash analysis. No dependency on the old permission extension is required.

Runtime dependencies (`@anthropic-ai/sandbox-runtime`, `tree-sitter-bash`,
`web-tree-sitter`) retain their respective upstream licenses. Their code is
not vendored in this package.
