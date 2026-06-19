# Bosch Model Farm (BMF) providers for pi

Example configuration for using the [Bosch Model Farm (BMF)](https://inside-docupedia.bosch.com/confluence2/spaces/FARM) (`aoai-farm.bosch-temp.com`) as a model provider for the pi coding agent.

BMF authenticates every endpoint with `Authorization: Bearer $BMF_API_KEY` and exposes models through four endpoint shapes. This example wires up three of them:

| Model | BMF endpoint | pi mechanism |
|-------|-------------|--------------|
| Gemini 3.5 Flash | Vertex OpenAI-compatible (Chat) | `models.json` — `openai-completions` |
| GPT-5.4 / GPT-5.5 | Azure OpenAI API (`?api-version=` in baseUrl) | `models.json` — `openai-completions` |
| Claude Opus 4.7 | Vertex Publisher `:streamRawPredict` | `index.ts` extension (rawPredict is not a standard pi provider) |

> ⚠️ `aoai-farm.bosch-temp.com` is a Bosch-internal endpoint, reachable only from the
> Bosch network/VPN. The `apiKey` is referenced as `$BMF_API_KEY` (env var), so no
> credential is stored in these files.

## Setup

1. Install this extension and the model config into your pi config dir
   (`~/.pi/agent/`, i.e. `C:\Users\<you>\.pi\agent\` on Windows):

   ```bash
   cp index.ts        ~/.pi/agent/extensions/bmf-claude.ts
   cp models.json     ~/.pi/agent/models.json   # merge if you already have one
   ```

2. Set your BMF subscription key:

   ```bash
   # Windows (reopen the terminal afterwards)
   setx BMF_API_KEY "<your-key>"
   # macOS / Linux
   export BMF_API_KEY="<your-key>"
   ```

3. Use the models:

   ```bash
   pi --provider bmf-gpt-55  --model gpt-5.5-2026-04-24
   pi --provider bmf-gpt-54  --model gpt-5.4-2026-03-05
   pi --provider bmf-gemini  --model google/gemini-3.5-flash
   pi --provider bmf-claude  --model claude-opus-4-7
   ```

   Or pick them interactively with `/model` inside pi.

## How the Claude extension works

BMF only exposes Claude through the Vertex AI Publisher `rawPredict` / `streamRawPredict`
methods, which speak the Anthropic Messages format but at a non-standard URL and require
`anthropic_version: "vertex-2023-10-16"` in the body. That isn't a built-in pi provider
shape, so the extension:

- reuses pi's own `streamAnthropic` (loaded at runtime via Node's resolver, because jiti
  can't resolve the `@earendil-works/pi-ai/anthropic` subpath through a static import) for
  all message/tool conversion, SSE parsing, and usage/cost handling;
- intercepts `fetch` **only** for the Anthropic SDK's `/v1/messages` calls against BMF and
  redirects them to `:streamRawPredict` with `Authorization: Bearer`, leaving GPT/Gemini
  `/chat/completions` requests untouched;
- injects `anthropic_version` via `onPayload`.

The `fetch` interception is scoped to BMF `/v1/messages` URLs and restored when the stream
finishes, so it never affects other providers.
