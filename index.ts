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
import { mkdirSync, mtimeSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MODELS_DEV_URL = "https://models.dev/api.json";
const PROVIDER = "openai-codex";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const ID_PREFIX = "gpt-6";

interface ModelsDevModel {
	id?: string;
	name?: string;
	reasoning?: boolean;
	limit?: { context?: number; input?: number; output?: number };
	cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
}

const CACHE_FILE = join(
	process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
	"pi-codex-models",
	"models-dev.json",
);

/** Fetch models.dev openai section with 12h disk cache. Returns [] on failure. */
async function fetchCandidates(): Promise<ModelsDevModel[]> {
	try {
		if (Date.now() - mtimeSync(CACHE_FILE).getTime() < CACHE_TTL_MS) {
			const cached = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
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
			(m): m is ModelsDevModel => typeof m.id === "string" && m.id.startsWith(ID_PREFIX),
		);
		try {
			mkdirSync(dirname(CACHE_FILE), { recursive: true });
			writeFileSync(CACHE_FILE, JSON.stringify(models));
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
		contextWindow: candidate.limit?.context ?? template.contextWindow,
		maxTokens: candidate.limit?.output ?? template.maxTokens,
	};
}

/** Cached candidates read synchronously (for module-load registration). */
function cachedCandidates(): ModelsDevModel[] {
	try {
		const cached = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
		return Array.isArray(cached) ? cached : [];
	} catch {
		return [];
	}
}

/** Merge + register missing gpt-6 models onto the codex provider. */
function registerMissing(pi: ExtensionAPI, candidates: ModelsDevModel[]): boolean {
	try {
		const existing = getModels(PROVIDER) as Model<Api>[];
		if (!existing.length) return false;
		const existingIds = new Set(existing.map((m) => m.id));
		const missing = candidates.filter((c) => c.id && !existingIds.has(c.id));
		if (!missing.length) return false;

		// Template: closest existing sibling (same api/auth shape).
		const template = existing.find((m) => m.id.startsWith("gpt-5")) ?? existing[0]!;
		const additions = missing.map((c) => buildEntry(c, template));

		pi.registerProvider(PROVIDER, {
			baseUrl: template.baseUrl,
			models: [...existing, ...additions],
		});
		return true;
	} catch {
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
