# Bosch Model Farm (BMF) providers for pi

Example configuration for using the [Bosch Model Farm (BMF)](https://inside-docupedia.bosch.com/confluence2/spaces/FARM) (`aoai-farm.bosch-temp.com`) as a model provider for the pi coding agent.

BMF authenticates every endpoint with `Authorization: Bearer $BMF_API_KEY` and exposes models through four endpoint shapes. This example wires up three models:

| Model | BMF endpoint | pi mechanism |
|-------|-------------|--------------|
| Gemini 3.5 Flash | Vertex OpenAI-compatible (Chat) | `models.json` — `openai-completions` |
| GPT-5.4 / GPT-5.5 | Azure OpenAI API (needs `?api-version=`) | `index.ts` extension |
| Claude Opus 4.7 | Vertex Publisher `:streamRawPredict` | `index.ts` extension |

> ⚠️ `aoai-farm.bosch-temp.com` is a Bosch-internal endpoint, reachable only from the
> Bosch network/VPN. The `apiKey` is referenced as `$BMF_API_KEY` (env var), so no
> credential is stored in these files.

## Setup

1. Install this extension and the model config into your pi config dir
   (`~/.pi/agent/`, i.e. `C:\Users\<you>\.pi\agent\` on Windows):

   ```bash
   cp index.ts     ~/.pi/agent/extensions/bmf.ts
   cp models.json  ~/.pi/agent/models.json   # merge if you already have one
   ```

2. Set your BMF subscription key (persisted for new terminals):

   ```bash
   # Windows (reopen the terminal afterwards)
   setx BMF_API_KEY "<your-key>"
   # macOS / Linux
   export BMF_API_KEY="<your-key>"
   ```

   In a terminal you already have open, also set it for the current session
   (`$env:BMF_API_KEY="..."` in PowerShell, or `export BMF_API_KEY=...` in bash).

3. Use the models:

   ```bash
   pi --provider bmf-gemini  --model google/gemini-3.5-flash
   pi --provider bmf-gpt-55  --model gpt-5.5-2026-04-24
   pi --provider bmf-gpt-54  --model gpt-5.4-2026-03-05
   pi --provider bmf-claude  --model claude-opus-4-7
   ```

   Or pick them interactively with `/model` inside pi. Cycle the thinking level with
   `Shift+Tab` (the models are configured `reasoning: true`, so `high`/`xhigh` are available).

## How it works

**Gemini** uses a plain OpenAI-compatible BMF endpoint, so plain `models.json` with
`openai-completions` is enough — the OpenAI SDK pi uses already sends `Authorization: Bearer`.

**GPT-5.x** is on the Azure OpenAI API, which requires `?api-version=<version>` on the
chat/completions URL. The OpenAI SDK mangles a query string embedded in `baseURL`, so the
extension reuses pi's `streamOpenAICompletions` and appends `api-version` to the request URL
via a scoped `fetch` interception.

**Claude** is only on the Vertex Publisher `:streamRawPredict` endpoint — Anthropic Messages
format, but at a non-standard URL and requiring `anthropic_version: "vertex-2023-10-16"` in
the body. The extension reuses pi's `streamAnthropic` and (a) rewrites the Anthropic SDK's
`/v1/messages` call to `:streamRawPredict` with Bearer auth, and (b) injects
`anthropic_version` (and strips the body-level `model` field, which rawPredict rejects).

The provider stream functions are not exported from the `@earendil-works/pi-ai` main
entry, and jiti cannot resolve the `@earendil-works/pi-ai/<subpath>` subpath through a
static import. The extension loads them at runtime via the module-scoped `require` that
jiti provides, trying both layouts so it works across pi versions:

- **<= 0.79.9**: the functions are named `streamAnthropic` / `streamOpenAICompletions` and
  live in `providers/*.js`.
- **0.79.10+**: they are named `stream` / `streamSimple` and live in `api/*.js`.

The loader resolves the subpath (or, as a fallback, pi-ai's main and then the provider
file by absolute path) and picks whichever export name exists, so a normal `pi` install
needs no extra dependencies.

Each `fetch` interception is scoped to a specific BMF URL pattern and restored when the stream
finishes, so providers never interfere with each other.
