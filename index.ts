/**
 * pi-codex-models — add new OpenAI models to openai-codex on pinned pi.
 *
 * pi bundles the openai-codex model list at build time. On a pinned pi
 * version, new releases (gpt-6-sol etc.) never appear until pi is updated.
 * This extension fetches models.dev's `openai` catalog at session start,
 * finds gpt-6 models missing from the codex registry, and re-registers
 * openai-codex with existing models + the new ones.
 *
 * registerProvider replaces a provider's models, so we always send the
 * full merged list: bundled models first, then the additions.
 */

import { getModels, type Model, type Api } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MODELS_DEV_URL = "https://models.dev/api.json";
const PROVIDER = "openai-codex";
// Cap context like pi-zai-models SAFE_CONTEXT: pi cannot safely compact
// 1M -> 272K when switching models or during compaction recovery. Keep the
// codex provider at the known-safe 272K ceiling; quota burn also matches.
const SAFE_CONTEXT = 272000;
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
// Match every gpt-* model from models.dev's openai catalog that the codex
// registry lacks — self-heals for all future releases, no prefix bumps.

interface ModelsDevModel {
	id?: string;
	name?: string;
	reasoning?: boolean;
	limit?: { context?: number; input?: number; output?: number };
	cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
}

function cacheFile(): string {
	return join(
		process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
		"pi-codex-models",
		"models-dev.json",
	);
}

/** Harness/diag marker: env-gated JSON dump of what got registered. */
function debugMarker(data: Record<string, unknown>): void {
	if (process.env.CODEX_MODELS_DEBUG !== "1") return;
	try {
		const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "codex-models-registered.json"), JSON.stringify(data) + "\n");
	} catch {
		/* best-effort */
	}
}

export async function fetchCandidates(): Promise<ModelsDevModel[]> {
	try {
		const cache = cacheFile();
		if (Date.now() - statSync(cache).mtimeMs < CACHE_TTL_MS) {
			const cached = JSON.parse(readFileSync(cache, "utf8"));
			if (Array.isArray(cached)) return cached;
		}
	} catch {
		/* no cache */
	}
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 8000);
		const response = await fetch(MODELS_DEV_URL, { signal: controller.signal });
		clearTimeout(timer);
		if (!response.ok) return [];
		const data = (await response.json()) as Record<string, { models?: Record<string, ModelsDevModel> }>;
		const openai = data.openai?.models ?? {};
		const models = Object.values(openai).filter(
			(m): m is ModelsDevModel =>
				typeof m.id === "string" && m.id.startsWith("gpt-"),
		);
		try {
			mkdirSync(dirname(cacheFile()), { recursive: true });
			writeFileSync(cacheFile(), JSON.stringify(models));
		} catch {
			/* cache write best-effort */
		}
		return models;
	} catch {
		return [];
	}
}

/** Build a codex model entry from a models.dev record, using a template for api/stream shape. */
function buildEntry(candidate: ModelsDevModel, template: Model<Api>): Model<Api> {
	return {
		...template,
		id: candidate.id!,
		name: candidate.name ?? candidate.id!,
		reasoning: candidate.reasoning ?? template.reasoning,
		cost: {
			input: candidate.cost?.input ?? template.cost.input,
			output: candidate.cost?.output ?? template.cost.output,
			cacheRead: candidate.cost?.cache_read ?? template.cost.cacheRead,
			cacheWrite: candidate.cost?.cache_write ?? template.cost.cacheWrite,
		},
		contextWindow: Math.min(candidate.limit?.context ?? template.contextWindow, SAFE_CONTEXT),
		maxTokens: candidate.limit?.output ?? template.maxTokens,
	};
}

/** Cached candidates read synchronously (for module-load registration). */
function cachedCandidates(): ModelsDevModel[] {
	try {
		const cached = JSON.parse(readFileSync(cacheFile(), "utf8"));
		return Array.isArray(cached) ? cached : [];
	} catch {
		return [];
	}
}

/** Pure diff: candidates the codex registry lacks, templated for registration. */
export function computeAdditions(
	candidates: ModelsDevModel[],
	existing: Model<Api>[],
): Model<Api>[] {
	if (!existing.length) return [];
	const existingIds = new Set(existing.map((m) => m.id));
	const missing = candidates.filter((c) => c.id && !existingIds.has(c.id));
	if (!missing.length) return [];
	// Template: closest existing sibling (same api/auth shape).
	const template = existing.find((m) => m.id.startsWith("gpt-5")) ?? existing[0]!;
	return missing.map((c) => buildEntry(c, template));
}

/** Merge + register missing gpt-6 models onto the codex provider. */
export function registerMissing(
	pi: ExtensionAPI,
	candidates: ModelsDevModel[],
	existingOverride?: Model<Api>[],
): boolean {
	try {
		const existing = (existingOverride ?? (getModels(PROVIDER) as Model<Api>[]));
		if (!existing.length) return false;
		const additions = computeAdditions(candidates, existing);
		if (!additions.length) return false;

		// Template: closest existing sibling (same api/auth shape).
		const template = existing.find((m) => m.id.startsWith("gpt-5")) ?? existing[0]!;
		pi.registerProvider(PROVIDER, {
			baseUrl: template.baseUrl,
			apiKey: "OPENAI_API_KEY",
			models: [...existing, ...additions],
		});
		debugMarker({ registered: true, count: additions.length, ids: additions.map((a) => a.id) });
		return true;
	} catch (err) {
		debugMarker({ registered: false, error: String(err) });
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	// Sync path: register from disk cache immediately at load so `-p` CLI
	// model resolution and the /model picker see the additions.
	const cached = cachedCandidates();
	if (cached.length) registerMissing(pi, cached);

	// Async path: refresh from models.dev, then re-register if new ids appeared.
	pi.on("session_start", async () => {
		try {
			const candidates = await fetchCandidates();
			if (candidates.length && registerMissing(pi, candidates)) {
				pi.notify(`codex-models: refreshed (${candidates.length} candidates)`, "info");
			}
		} catch {
			/* never block startup */
		}
	});
}
