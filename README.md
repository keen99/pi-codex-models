# pi-codex-models

![CI](https://github.com/keen99/pi-codex-models/actions/workflows/ci.yml/badge.svg)
![release-watch](https://github.com/keen99/pi-codex-models/actions/workflows/release-watch.yml/badge.svg)
[![pi tested](https://img.shields.io/github/v/release/keen99/pi-codex-models?label=pi%20tested%200.75.0%20%E2%86%92)](https://github.com/keen99/pi-codex-models/releases)

Adds new OpenAI models to the `openai-codex` provider on pinned pi
versions. pi bundles the codex model list at build time, so new
releases (gpt-6-sol etc.) never appear until pi is updated. This
extension fetches models.dev's `openai` catalog at session start,
finds `gpt-*` models missing from the codex registry, and
re-registers the provider with the full merged list. Context is
capped at 272K (SAFE_CONTEXT) like pi-zai-models.

## Install

```bash
# ssh
pi install git:git@github.com:keen99/pi-codex-models

# https
pi install git:github.com/keen99/pi-codex-models
```

## Development

`npm test` runs the unit suite; `npm run test:matrix` boots every
stable pi release (>= 0.75.0) in RPC mode, seeds a fake gpt model in
the models.dev cache, and asserts via `CODEX_MODELS_DEBUG=1` that
`registerProvider` actually fired with the addition on the real
process. Cached installs live in `.matrix-cache/`.

Real bugs found and fixed while building the harness: the cache
freshness check called `mtimeSync`, which does not exist in
`node:fs` — the check threw every run, so the 12h disk cache was
never read and models.dev was refetched on every session start.
`XDG_CACHE_HOME` and `CODEX_MODELS_DEBUG`/`PI_CODING_AGENT_DIR` are
now resolved per call so tests never touch real state.
