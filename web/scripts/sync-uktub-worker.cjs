// Copies the Uktub browser worker bundle (built at the repo root by
// `pnpm build:browser`) into the web app's static assets so one
// UktubBrowserClient can be opened per project.
//
// Usage: `node scripts/sync-uktub-worker.cjs [--no-build]`
// Copies `<root>/dist-browser/worker.js` + sibling `*.wasm` files to
// `web/public/uktub/` (gitignored; served under `${base}/uktub/`).
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const webRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(webRoot, '..');
const distBrowser = path.join(repoRoot, 'dist-browser');
const outDir = path.join(webRoot, 'public', 'uktub');

function main() {
	const noBuild = process.argv.includes('--no-build');
	const workerSrc = path.join(distBrowser, 'worker.js');
	if (!fs.existsSync(workerSrc) && !noBuild) {
		console.log('[sync-uktub-worker] building root dist-browser/worker.js...');
		execFileSync('pnpm', ['build:browser'], {
			cwd: repoRoot,
			stdio: 'inherit',
		});
	}
	if (!fs.existsSync(workerSrc)) {
		throw new Error(
			`Uktub worker bundle missing: ${workerSrc} (run \`pnpm build:browser\` at the repo root)`,
		);
	}
	fs.mkdirSync(outDir, { recursive: true });
	const copied = [];
	for (const entry of fs.readdirSync(distBrowser)) {
		if (entry !== 'worker.js' && !entry.endsWith('.wasm')) continue;
		fs.copyFileSync(path.join(distBrowser, entry), path.join(outDir, entry));
		copied.push(entry);
	}
	if (!copied.includes('worker.js')) {
		throw new Error('worker.js was not copied; aborting');
	}
	console.log(`[sync-uktub-worker] copied to public/uktub/: ${copied.join(', ')}`);
}

main();
