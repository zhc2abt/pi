// Bosch Model Farm (BMF) Claude provider.
//
// BMF exposes Claude only via the Vertex AI Publisher `rawPredict`/`streamRawPredict`
// endpoint, which speaks the Anthropic Messages format but at a non-standard URL and
// requires `anthropic_version: "vertex-2023-10-16"` in the body + `Authorization: Bearer`.
//
// We reuse pi's own `streamAnthropic` (full message/tool conversion, SSE parsing,
// usage/cost) and just (a) rewrite the request URL to `streamRawPredict` and
// (b) inject `anthropic_version` via onPayload.
//
// `streamAnthropic` is not exported from the `@earendil-works/pi-ai` main entry, and
// jiti cannot resolve the `@earendil-works/pi-ai/anthropic` subpath via static import,
// so we load it at runtime through Node's resolver (which honors the package `exports`
// map), scoped to pi-coding-agent's install location. Loading is lazy so that even if
// it fails, this extension still loads and GPT/Gemini keep working.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const BMF = "https://aoai-farm.bosch-temp.com";
const ANTHROPIC_VERSION = "vertex-2023-10-16";

function loadStreamAnthropic(): any {
	const anyRequire = (globalThis as any).require;
	if (!anyRequire) throw new Error("No require in extension context");
	const { createRequire } = anyRequire("node:module");

	// Strategy 1: scope to pi-coding-agent (depends on pi-ai) and use the exports subpath.
	try {
		const r = createRequire(anyRequire.resolve("@earendil-works/pi-coding-agent"));
		const mod = r("@earendil-works/pi-ai/anthropic");
		if (mod?.streamAnthropic) return mod.streamAnthropic;
	} catch {}

	// Strategy 2: scope to pi-ai's own main and deep-load the provider file.
	try {
		const r = createRequire(anyRequire.resolve("@earendil-works/pi-ai"));
		const mod = r("./dist/providers/anthropic.js");
		if (mod?.streamAnthropic) return mod.streamAnthropic;
	} catch {}

	throw new Error("Could not load streamAnthropic from @earendil-works/pi-ai");
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider("bmf-claude", {
		name: "Bosch Model Farm (Claude)",
		baseUrl: BMF,
		apiKey: "$BMF_API_KEY",
		api: "bmf-claude-rawpredict",
		models: [
			{
				id: "claude-opus-4-7",
				name: "Claude Opus 4.7 (BMF)",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200000,
				maxTokens: 32000,
			},
		],
		streamSimple: (model: any, context: any, options: any) => {
			const stream = createAssistantMessageEventStream();

			let streamAnthropic: any;
			try {
				streamAnthropic = loadStreamAnthropic();
			} catch (e) {
				(async () => {
					const err = e instanceof Error ? e.message : String(e);
					const output: any = {
						role: "assistant",
						content: [],
						api: "anthropic-messages",
						provider: model.provider,
						model: model.id,
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
						stopReason: "error",
						errorMessage: `bmf-claude extension: ${err}`,
						timestamp: Date.now(),
					};
					stream.push({ type: "start", partial: output });
					stream.push({ type: "error", reason: "error", error: output });
					stream.end();
				})();
				return stream;
			}

			const apiKey = options?.apiKey;
			if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);

			const realFetch = globalThis.fetch.bind(globalThis);
			// Intercept fetch ONLY for the Anthropic SDK's /v1/messages calls against BMF,
			// redirecting to streamRawPredict with Bearer auth. GPT/Gemini BMF requests
			// use /chat/completions paths and are untouched.
			const patchedFetch = async (input: any, init?: any) => {
				const url: string =
					typeof input === "string" ? input : input instanceof URL ? input.href : input?.url ?? "";
				if (url.includes("aoai-farm.bosch-temp.com") && url.includes("/v1/messages")) {
					const target = `${BMF}/api/google/v1/publishers/anthropic/models/${model.id}:streamRawPredict`;
					const headers = new Headers(init?.headers);
					headers.set("Authorization", `Bearer ${apiKey}`);
					headers.delete("x-api-key");
					return realFetch(target, { ...init, headers });
				}
				return realFetch(input, init);
			};
			(globalThis as any).fetch = patchedFetch;

			const restore = () => {
				if ((globalThis as any).fetch === patchedFetch) {
					(globalThis as any).fetch = realFetch;
				}
			};

			const anthropicModel = { ...model, api: "anthropic-messages", baseUrl: BMF };
			const inner = streamAnthropic(anthropicModel, context, {
				...options,
				apiKey,
				onPayload: (params: any) => ({ ...params, anthropic_version: ANTHROPIC_VERSION }),
			});

			// Forward inner stream events to our stream, and restore fetch on completion.
			(async () => {
				try {
					for await (const ev of inner) stream.push(ev);
					stream.end();
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					const output: any = {
						role: "assistant",
						content: [],
						api: "anthropic-messages",
						provider: model.provider,
						model: model.id,
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
						stopReason: "error",
						errorMessage: `bmf-claude: ${msg}`,
						timestamp: Date.now(),
					};
					stream.push({ type: "start", partial: output });
					stream.push({ type: "error", reason: "error", error: output });
					stream.end();
				} finally {
					restore();
				}
			})();

			return stream;
		},
	});
}
