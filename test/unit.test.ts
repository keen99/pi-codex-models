import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	computeAdditions,
	fetchCandidates,
	registerMissing,
	buildEntry,
	type ModelsDevModel,
} from "../index.js";
import type { Model, Api } from "@earendil-works/pi-ai";

let tmp = "";
function useTempCache(): string {
	tmp = mkdtempSync(join(tmpdir(), "pi-codex-models-"));
	process.env.XDG_CACHE_HOME = tmp;
	return tmp;
}
function cleanup() {
	delete process.env.XDG_CACHE_HOME;
	delete process.env.CODEX_MODELS_DEBUG;
	rmSync(tmp, { recursive: true, force: true });
}

const template: Model<Api> = {
	id: "gpt-5",
	name: "GPT-5",
	api: "openai-responses" as Api,
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	contextWindow: 272000,
	maxTokens: 128000,
	cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
} as unknown as Model<Api>;

const existing = [template];

// ---------- computeAdditions ----------
test("computeAdditions: missing gpt-* diffed against existing ids", () => {
	const cands: ModelsDevModel[] = [
		{ id: "gpt-5", name: "GPT-5" },
		{ id: "gpt-6-sol", name: "GPT-6 Sol" },
	];
	const add = computeAdditions(cands, existing);
	assert.equal(add.length, 1);
	assert.equal(add[0].id, "gpt-6-sol");
});
test("computeAdditions: no existing models -> nothing", () => {
	assert.deepEqual(computeAdditions([{ id: "gpt-6" }], []), []);
});
test("computeAdditions: nothing new -> nothing", () => {
	assert.deepEqual(computeAdditions([{ id: "gpt-5" }], existing), []);
});
test("computeAdditions: template prefers gpt-5 sibling", () => {
	const gpt4 = { ...template, id: "gpt-4o", contextWindow: 128000 } as Model<Api>;
	const add = computeAdditions([{ id: "gpt-6-x" }], [gpt4, template]);
	assert.equal(add[0].api, template.api);
});

// ---------- buildEntry (via computeAdditions) ----------
test("buildEntry: contextWindow capped at SAFE_CONTEXT 272000", () => {
	const add = computeAdditions([{ id: "gpt-6-big", limit: { context: 1_000_000, output: 64_000 } }], existing);
	assert.equal(add[0].contextWindow, 272000);
	assert.equal(add[0].maxTokens, 64_000);
});
test("buildEntry: cost snake_case -> camelCase, fallbacks to template", () => {
	const add = computeAdditions(
		[{ id: "gpt-6-cost", cost: { input: 2, output: 8, cache_read: 0.5 } as never }],
		existing,
	);
	assert.deepEqual(add[0].cost, { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 });
});
test("buildEntry: name fallback to id, reasoning fallback to template", () => {
	const add = computeAdditions([{ id: "gpt-6-min" }], existing);
	assert.equal(add[0].name, "gpt-6-min");
	assert.equal(add[0].reasoning, true);
});

// ---------- fetchCandidates ----------
test("fetchCandidates: warm cache served without network", async () => {
	const dir = useTempCache();
	const cdir = join(dir, "pi-codex-models");
	mkdirSync(cdir, { recursive: true });
	writeFileSync(join(cdir, "models-dev.json"), JSON.stringify([{ id: "gpt-cached" }]));
	let fetched = false;
	const origFetch = globalThis.fetch;
	globalThis.fetch = (async () => {
		fetched = true;
		throw new Error("should not fetch");
	}) as typeof fetch;
	try {
		const out = await fetchCandidates();
		assert.equal(fetched, false);
		assert.deepEqual(out, [{ id: "gpt-cached" }]);
	} finally {
		globalThis.fetch = origFetch;
		cleanup();
	}
});
test("fetchCandidates: fetch parses openai.models, filters gpt-*, writes cache", async () => {
	useTempCache();
	const payload = {
		openai: {
			models: {
				"gpt-6-a": { id: "gpt-6-a", name: "6A" },
				"gpt-6-b": { id: "gpt-6-b" },
				"o4-mini": { id: "o4-mini" },
			},
		},
		anthropic: { models: { "gpt-fake": { id: "gpt-fake" } } },
	};
	const origFetch = globalThis.fetch;
	globalThis.fetch = (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch;
	try {
		const out = await fetchCandidates();
		assert.deepEqual(out.map((m) => m.id).sort(), ["gpt-6-a", "gpt-6-b"]);
	} finally {
		globalThis.fetch = origFetch;
		cleanup();
	}
});
test("fetchCandidates: fetch non-ok -> empty", async () => {
	useTempCache();
	const origFetch = globalThis.fetch;
	globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
	try {
		assert.deepEqual(await fetchCandidates(), []);
	} finally {
		globalThis.fetch = origFetch;
		cleanup();
	}
});
test("fetchCandidates: fetch throws -> empty", async () => {
	useTempCache();
	const origFetch = globalThis.fetch;
	globalThis.fetch = (async () => {
		throw new Error("network down");
	}) as typeof fetch;
	try {
		assert.deepEqual(await fetchCandidates(), []);
	} finally {
		globalThis.fetch = origFetch;
		cleanup();
	}
});

// ---------- registerMissing ----------
test("registerMissing: registers merged list on provider + writes debug marker", () => {
	const dir = useTempCache();
	process.env.CODEX_MODELS_DEBUG = "1";
	process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
	const registered: unknown[] = [];
	const pi = {
		registerProvider: (...args: unknown[]) => registered.push(args),
	} as never;
	const ok = registerMissing(pi, [{ id: "gpt-6-sol" }] as ModelsDevModel[], existing as Model<Api>[]);
	assert.equal(ok, true);
	assert.equal(registered.length, 1);
	const [provider, cfg] = registered[0] as [string, { models: Model<Api>[]; baseUrl: string; apiKey: string }];
	assert.equal(provider, "openai-codex");
	assert.equal(cfg.apiKey, "OPENAI_API_KEY");
	assert.equal(cfg.models.length, 2);
	assert.equal(cfg.models[1].id, "gpt-6-sol");
	const marker = JSON.parse(readFileSync(join(dir, "agent", "codex-models-registered.json"), "utf8"));
	assert.equal(marker.registered, true);
	assert.deepEqual(marker.ids, ["gpt-6-sol"]);
	cleanup();
});
test("registerMissing: provider error -> false + failure marker", () => {
	const dir = useTempCache();
	process.env.CODEX_MODELS_DEBUG = "1";
	process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
	const pi = {
		registerProvider: () => {
			throw new Error("boom");
		},
	} as never;
	assert.equal(registerMissing(pi, [{ id: "gpt-6-y" }] as ModelsDevModel[], existing as Model<Api>[]), false);
	const marker = JSON.parse(readFileSync(join(dir, "agent", "codex-models-registered.json"), "utf8"));
	assert.equal(marker.registered, false);
	assert.match(marker.error, /boom/);
	cleanup();
});
test("registerMissing: no candidates missing -> false, no registration", () => {
	const calls: unknown[] = [];
	const pi = { registerProvider: (...a: unknown[]) => calls.push(a) } as never;
	assert.equal(registerMissing(pi, [{ id: "gpt-5" }] as ModelsDevModel[], existing as Model<Api>[]), false);
	assert.equal(calls.length, 0);
	cleanup();
});
