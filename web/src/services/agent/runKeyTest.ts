// SPDX-License-Identifier: AGPL-3.0-or-later
// One real key-test call against the selected model, classified into
// ok | rejected | blocked | error. The key is passed straight through to
// pi-ai and never logged, stored or echoed here.
import type { Model, Models } from '@earendil-works/pi-ai';

import {
	classifyKeyTestResult,
	type KeyTestClassification,
} from './classifyKeyTest';

export async function runKeyTest(
	models: Models,
	model: Model<string>,
	apiKey: string,
	signal: AbortSignal,
): Promise<KeyTestClassification> {
	try {
		const message = await models.completeSimple(
			model as Model<never>,
			{
				messages: [
					{
						role: 'user',
						content: 'Reply with OK.',
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey, maxTokens: 16, maxRetries: 0, timeoutMs: 30000, signal },
		);
		// pi-ai never throws for request failures: setup failures are encoded
		// by lazy.js as stopReason "error" + errorMessage, and provider
		// failures surface the same way via formatProviderError.
		const errorMessage = (message as { errorMessage?: string }).errorMessage ?? null;
		return classifyKeyTestResult({ stopReason: message.stopReason, errorMessage });
	} catch (err) {
		if (signal.aborted) {
			return { status: 'error', detail: 'The key test was cancelled.' };
		}
		return classifyKeyTestResult({ thrown: err });
	}
}
