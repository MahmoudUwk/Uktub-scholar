// SPDX-License-Identifier: AGPL-3.0-or-later
// Lazy singleton for pi-ai's built-in model catalog. The static import of
// `@earendil-works/pi-ai/providers/all` lives behind this dynamic import so
// provider SDKs stay lazily loaded (pi-ai wraps them in `*.lazy` imports)
// and the whole agent stack splits into its own lazy chunk.
import type { Models } from '@earendil-works/pi-ai';

let cached: Promise<Models> | null = null;

export function getAgentModels(): Promise<Models> {
	if (!cached) {
		cached = import('@earendil-works/pi-ai/providers/all').then((m) => m.builtinModels());
		cached.catch(() => {
			cached = null;
		});
	}
	return cached;
}

/** Test seam only: forget the cached collection. */
export function clearAgentModelsForTest(): void {
	cached = null;
}
