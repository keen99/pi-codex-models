#!/usr/bin/env node
// Deep pinned-pi smoke for codex-models. Boots real pi in RPC mode with a
// pre-seeded models.dev cache containing a fake gpt model, then asserts the
// debug marker proves registerProvider actually fired on the real process.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), 'pi-codex-models-deep-'));
const agentDir = join(dir, 'agent');
const cacheDir = join(dir, 'cache', 'pi-codex-models');
mkdirSync(join(agentDir, 'sessions', 'tmp'), { recursive: true });
mkdirSync(cacheDir, { recursive: true });
// Fresh cache with a fake new model the bundled codex registry cannot have.
writeFileSync(join(cacheDir, 'models-dev.json'), JSON.stringify([
	{ id: 'gpt-6-harness-fake', name: 'GPT-6 Harness', reasoning: true, limit: { context: 400000, output: 32000 }, cost: { input: 3, output: 9 } },
]));
const MARKER = join(agentDir, 'codex-models-registered.json');

const child = spawn(
	process.env.PI_TEST_BIN ?? join(dirname(process.execPath), 'pi'),
	['--mode', 'rpc', '--no-extensions', '-e', join(root, 'index.ts'), '--session-dir', join(agentDir, 'sessions', 'tmp')],
	{ env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, XDG_CACHE_HOME: join(dir, 'cache'), CODEX_MODELS_DEBUG: '1' }, cwd: dir },
);
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });

const t0 = Date.now();
const hard = setTimeout(() => child.kill('SIGKILL'), 30_000);
const poll = setInterval(() => {
	if (existsSync(MARKER)) {
		clearInterval(poll);
		finish();
	} else if (Date.now() - t0 > 20_000) {
		clearInterval(poll);
		console.error('FAIL timed out — no registration marker. stderr tail:', out.slice(-600));
		child.kill('SIGTERM');
		clearTimeout(hard);
		rmSync(dir, { recursive: true, force: true });
		process.exit(1);
	}
}, 200);

function finish() {
	child.kill('SIGTERM');
	child.on('exit', () => {
		clearTimeout(hard);
		try {
			const m = JSON.parse(readFileSync(MARKER, 'utf8'));
			if (m.registered !== true) throw new Error(`marker says registered=false: ${JSON.stringify(m)}`);
			if (!Array.isArray(m.ids) || !m.ids.includes('gpt-6-harness-fake')) throw new Error(`marker ids missing fake model: ${JSON.stringify(m)}`);
			console.log(`Deep smoke PASS: registerProvider fired with gpt-6-harness-fake in real pi (${(Date.now() - t0) / 1000 | 0}s).`);
			process.exit(0);
		} catch (e) {
			console.error('FAIL', e.message);
			process.exit(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}
