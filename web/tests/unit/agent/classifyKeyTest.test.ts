// SPDX-License-Identifier: AGPL-3.0-or-later
import {
	classifyKeyTestResult,
	type KeyTestClassification,
} from '../../../src/services/agent/classifyKeyTest';

// Fixture shapes mirror pi-ai 1.3.0's real code paths:
// - setup/auth failures: lazy.js createSetupErrorMessage -> { stopReason: "error",
//   errorMessage: error.message } — e.g. ModelsError("auth", "Provider is not configured").
// - provider failures: api/openai-completions.js catch -> errorMessage =
//   formatProviderError(normalizeProviderError(sdkError)) which yields
//   "<status>: <body>" (error-body.js formatProviderError) when the SDK message
//   does not already carry the body, else the raw SDK message.
// - success: AssistantMessage with stopReason "stop".
describe('classifyKeyTestResult', () => {
	it('maps a successful reply to ok', () => {
		expect(
			classifyKeyTestResult({ stopReason: 'stop' } satisfies {
				stopReason: string;
			}),
		).toEqual({ status: 'ok', detail: 'Key accepted.' });
	});

	it('maps an OpenAI-style 401 body to rejected', () => {
		const out: KeyTestClassification = classifyKeyTestResult({
			stopReason: 'error',
			errorMessage:
				'401: {"error":{"message":"Incorrect API key provided: sk-abc123.","type":"invalid_request_error","code":"invalid_api_key"}}',
		});
		expect(out.status).toBe('rejected');
	});

	it('maps an Anthropic-style 401 message to rejected', () => {
		const out = classifyKeyTestResult({
			stopReason: 'error',
			errorMessage: '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
		});
		expect(out.status).toBe('rejected');
	});

	it('maps a browser CORS/network failure to blocked', () => {
		const out = classifyKeyTestResult({
			stopReason: 'error',
			errorMessage: 'Failed to fetch',
		});
		expect(out.status).toBe('blocked');
		expect(out.detail).toMatch(/browser/i);
	});

	it('maps fetch failed to blocked', () => {
		expect(
			classifyKeyTestResult({ stopReason: 'error', errorMessage: 'fetch failed' }).status,
		).toBe('blocked');
	});

	it('maps the Anthropic/OpenAI SDK connection error to blocked', () => {
		// Observed live (MiniMax CORS probe): the Anthropic SDK surfaces a
		// browser CORS failure as APIConnectionError "Connection error."
		const out = classifyKeyTestResult({ stopReason: 'error', errorMessage: 'Connection error.' });
		expect(out.status).toBe('blocked');
		expect(out.detail).toMatch(/browser/i);
	});

	it('maps a 429 rate-limit message to error with the bounded provider message', () => {
		const long = `429: ${'x'.repeat(500)}`;
		const out = classifyKeyTestResult({ stopReason: 'error', errorMessage: long });
		expect(out.status).toBe('error');
		expect(out.detail.length).toBeLessThanOrEqual(200);
	});

	it('never maps a reply that carries an HTTP status to blocked: the request reached the provider', () => {
		// formatProviderError yields "<status>: <body>", "<prefix> (<status>): <message>" or the SDK
		// message ("<status> <body>"); a provider timeout or a body that mentions a connection is not a browser block.
		for (const errorMessage of [
			'408: {"error":{"message":"Request timed out"}}',
			'429 {"error":{"message":"Too many requests; connection limit reached"}}',
			'Google (503): The service is unavailable, connection reset by upstream',
		]) {
			expect(classifyKeyTestResult({ stopReason: 'error', errorMessage }).status).toBe('error');
		}
	});

	it('maps a provider that answers 400 with an invalid-key message to rejected', () => {
		const out = classifyKeyTestResult({
			stopReason: 'error',
			errorMessage: '400: {"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}',
		});
		expect(out.status).toBe('rejected');
	});

	it('maps a thrown auth error to rejected without throwing', () => {
		const out = classifyKeyTestResult({
			thrown: Object.assign(new Error('401 Unauthorized'), { status: 401 }),
		});
		expect(out.status).toBe('rejected');
	});

	it('maps an empty error message to error, never the key', () => {
		const out = classifyKeyTestResult({ stopReason: 'error', errorMessage: '' });
		expect(out.status).toBe('error');
		expect(out.detail).not.toContain('sk-');
	});

	it('redacts key-like tokens from echoed provider text', () => {
		const out = classifyKeyTestResult({
			stopReason: 'error',
			errorMessage: '400: bad key sk-abcdefgh12345678 rejected here',
		});
		expect(out.detail).not.toContain('sk-abcdefgh12345678');
	});

	it('maps an aborted test to error', () => {
		expect(classifyKeyTestResult({ stopReason: 'aborted' }).status).toBe('error');
	});
});
