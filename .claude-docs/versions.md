# Current stack — resolved versions

Generated 2026-06-08 · TTL 7d · refresh with `fleet currency`.
Do not edit by hand; do not trust your training cutoff over this table.

| package | pinned | latest | drift | source |
| --- | --- | --- | --- | --- |
| tsx | ^4.19.2 | 4.22.4 | ⬆ update | [www.npmjs.com](https://www.npmjs.com/package/tsx) |
| typescript | ^5.7.2 | 6.0.3 | ⬆ update | [www.npmjs.com](https://www.npmjs.com/package/typescript) |

## Current LLM model IDs

| model ID | provider note | source |
| --- | --- | --- |
| `claude-opus-4-8` | Anthropic — Opus 4.8 (most capable) | [docs.anthropic.com](https://docs.anthropic.com/en/docs/about-claude/models) |
| `claude-sonnet-4-6` | Anthropic — Sonnet 4.6 | [docs.anthropic.com](https://docs.anthropic.com/en/docs/about-claude/models) |
| `claude-haiku-4-5-20251001` | Anthropic — Haiku 4.5 | [docs.anthropic.com](https://docs.anthropic.com/en/docs/about-claude/models) |

## External tools (probed live)

| tool | tested version | provenance |
| --- | --- | --- |
| cmux | `0.64.12 (92) [ac60b2cd7]` | `cmux --version` on 2026-06-09 — the build target for the event stream (`events.stream`) + `feed.*`/`notification.*` RPCs behind the event-driven Captain (F1) and proof gate (F3). Both features hard-gate on `cmux capabilities` and fall back to polling when absent. |
