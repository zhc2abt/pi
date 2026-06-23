// Bosch Model Farm (BMF) providers for pi.
//
// - Claude Opus 4.7: BMF exposes Claude only via the Vertex Publisher
//   `:streamRawPredict` endpoint (Anthropic Messages format, non-standard URL,
//   requires `anthropic_version` + Bearer). Not a built-in pi provider shape.
// - GPT-5.4 / 5.5: BMF Azure OpenAI API requires `?api-version=` on the URL, which
//   the OpenAI SDK mangles when it's embedded in baseURL.
//
// Both reuse pi's own provider stream functions (full message/tool conversion,
// SSE parsing, usage/cost) and only patch the outgoing request:
//   Claude -> rewrite /v1/messages to :streamRawPredict + Bearer + inject anthropic_version
//   GPT    -> append ?api-version to the Azure deployment chat/completions URL
//
// Gemini 3.5 Flash is plain OpenAI-compatible, so it lives in models.json (no extension).
//
// The provider stream functions live under `@earendil-works/pi-ai/<subpath>`, but their
// export names and file locations changed across versions:
//   - <= 0.79.9: `streamAnthropic` / `streamOpenAICompletions` in `providers/*.js`
//   - 0.79.10+:  `stream` / `streamSimple`            in `api/*.js`
// jiti cannot resolve the subpath via a static import, so we load it at runtime via the
// module-scoped require, trying both the new and old names/paths. Loading is lazy so the
// extension always loads even if resolution fails.

import { createRequire } from "node:module";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BMF = "https://aoai-farm.bosch-temp.com";
const AOAI_API_VERSION = "2025-04-01-preview";
const ANTHROPIC_VERSION = "vertex-2023-10-16";

declare const require: any;

function getReq(): any {
	try {
		if (typeof require !== "undefined" && require) return require;
	} catch {}
	try {
		return createRequire(import.meta.url);
	} catch {}
	return (globalThis as any).require;
}

function loadPiAiFn(subpath: string, names: string[], deepFiles: string[]): any {
	const req = getReq();
	if (!req) throw new Error("No require available in extension context");
	const pick = (mod: any) => {
		for (const n of names) {
			const fn = mod?.[n] ?? mod?.default?.[n];
			if (fn) return fn;
		}
		return undefined;
	};
	// Strategy 1: subpath (exports map resolves to the right file per version).
	try {
		const fn = pick(req(`@earendil-works/pi-ai/${subpath}`));
		if (fn) return fn;
	} catch {}
	// Strategy 2: resolve pi-ai main, try each known deep path.
	if (typeof req.resolve === "function") {
		try {
			const main: string = req.resolve("@earendil-works/pi-ai");
			const dir = main.replace(/[\\/][^\\/]+$/, ""); // strip filename -> dist dir
			for (const df of deepFiles) {
				try {
					const fn = pick(req(`${dir}/${df}`));
					if (fn) return fn;
				} catch {}
			}
		} catch {}
	}
	throw new Error(`Could not load ${names.join(" / ")} from @earendil-works/pi-ai`);
}

function errorStream(model: any, api: string, message: string) {
	const stream = createAssistantMessageEventStream();
	const out: any = {
		role: "assistant",
		content: [],
		api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: message,
		timestamp: Date.now(),
	};
	stream.push({ type: "start", partial: out });
	stream.push({ type: "error", reason: "error", error: out });
	stream.end();
	return stream;
}

// --- Claude via Vertex streamRawPredict ---
const claudeStreamSimple = (model: any, context: any, options: any) => {
	let streamAnthropic: any;
	try {
		streamAnthropic = loadPiAiFn(
			"anthropic",
			["stream", "streamSimple", "streamAnthropic", "streamSimpleAnthropic"],
			["api/anthropic-messages.js", "providers/anthropic.js"],
		);
	} catch (e) {
		return errorStream(model, "anthropic-messages", `bmf-claude: ${e instanceof Error ? e.message : String(e)}`);
	}

	const apiKey = options?.apiKey;
	const realFetch = globalThis.fetch.bind(globalThis);
	// Intercept ONLY the Anthropic SDK's /v1/messages calls against BMF, redirecting to
	// streamRawPredict with Bearer auth. Other BMF requests are untouched.
	const patchedFetch = async (input: any, init?: any) => {
		const url: string = typeof input === "string" ? input : input instanceof URL ? input.href : (input?.url ?? "");
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
		if ((globalThis as any).fetch === patchedFetch) (globalThis as any).fetch = realFetch;
	};

	const inner = streamAnthropic({ ...model, api: "anthropic-messages", baseUrl: BMF }, context, {
		...options,
		apiKey,
		// rawPredict takes the model from the URL and rejects a body-level `model`
		// field ("model: Extra inputs are not permitted"). Strip it and add the
		// required anthropic_version.
		onPayload: (params: any) => {
			const { model: _drop, ...rest } = params;
			return { ...rest, anthropic_version: ANTHROPIC_VERSION };
		},
	});
	inner.result().then(restore, restore);
	return inner;
};

// --- GPT-5.x via Azure OpenAI (inject ?api-version) ---
const gptStreamSimple = (model: any, context: any, options: any) => {
	let streamOpenAI: any;
	try {
		streamOpenAI = loadPiAiFn(
			"openai-completions",
			["stream", "streamSimple", "streamOpenAICompletions", "streamSimpleOpenAICompletions"],
			["api/openai-completions.js", "providers/openai-completions.js"],
		);
	} catch (e) {
		return errorStream(model, "openai-completions", `bmf-gpt: ${e instanceof Error ? e.message : String(e)}`);
	}

	const realFetch = globalThis.fetch.bind(globalThis);
	// Intercept ONLY OpenAI SDK chat/completions calls against BMF Azure deployments,
	// appending the required api-version query. Other requests are untouched.
	const patchedFetch = async (input: any, init?: any) => {
		const url: string = typeof input === "string" ? input : input instanceof URL ? input.href : (input?.url ?? "");
		if (
			url.includes("aoai-farm.bosch-temp.com") &&
			url.includes("/openai/deployments/") &&
			url.includes("/chat/completions") &&
			!url.includes("api-version=")
		) {
			return realFetch(`${url}?api-version=${AOAI_API_VERSION}`, init);
		}
		return realFetch(input, init);
	};
	(globalThis as any).fetch = patchedFetch;
	const restore = () => {
		if ((globalThis as any).fetch === patchedFetch) (globalThis as any).fetch = realFetch;
	};

	const inner = streamOpenAI({ ...model, api: "openai-completions" }, context, options);
	inner.result().then(restore, restore);
	return inner;
};

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
		streamSimple: claudeStreamSimple,
	});

	const gptModel = (id: string, name: string) => ({
		id,
		name,
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	});

	pi.registerProvider("bmf-gpt-55", {
		name: "Bosch Model Farm (GPT-5.5)",
		baseUrl: `${BMF}/api/openai/deployments/gpt-5.5-2026-04-24`,
		apiKey: "$BMF_API_KEY",
		api: "bmf-gpt-openai",
		models: [gptModel("gpt-5.5-2026-04-24", "GPT-5.5 (BMF)")],
		streamSimple: gptStreamSimple,
	});

	pi.registerProvider("bmf-gpt-54", {
		name: "Bosch Model Farm (GPT-5.4)",
		baseUrl: `${BMF}/api/openai/deployments/gpt-5.4-2026-03-05`,
		apiKey: "$BMF_API_KEY",
		api: "bmf-gpt-openai",
		models: [gptModel("gpt-5.4-2026-03-05", "GPT-5.4 (BMF)")],
		streamSimple: gptStreamSimple,
	});
}
