// SPDX-License-Identifier: AGPL-3.0-or-later
// Outcome of the one-shot key test run on entry. The classifier is pure:
// it only reads the AssistantMessage shape pi-ai resolves with
// (stopReason + errorMessage) or a thrown error, and never sees the key.

export type KeyTestStatus = 'ok' | 'rejected' | 'blocked' | 'error';

export interface KeyTestClassification {
	status: KeyTestStatus;
	detail: string;
}

export type KeyTestInput =
	| { stopReason: string; errorMessage?: string | null }
	| { thrown: unknown };

const REJECTED_RE =
	/\b40[13]\b|unauthori[sz]ed|forbidden|invalid[_\s-]?(api[_\s-]?)?key|incorrect[_\s-]?(api[_\s-]?)?key|authentication[_\s-]?(failed|error|required)|not[_\s-]?authenticated|invalid[_\s-]?credentials|missing[_\s-]?api[_\s-]?key|api[_\s-]?key[_\s-]?(is[_\s-]?)?(invalid|incorrect|missing|required|not[_\s-]?valid)/i;

const BLOCKED_RE =
	/failed[_\s-]?to[_\s-]?fetch|fetch[_\s-]?failed|network\s?error|load[_\s-]?failed|cors|cross-origin|blocked[_\s-]?by[_\s-]?the[_\s-]?browser|connection[_\s-]?(refused|reset|failed|aborted|error)|api[_\s-]?connection|econnrefused|enotfound|etimedout|timed?\s?out|unreachable|offline|network request failed/i;

// A leading HTTP status ("401: …", "401 {…}", "Prefix (401): …", "(401) …") means the request reached the
// provider, so the outcome is never `blocked`.
const HTTP_STATUS_RE = /^\s*(?:[^():]*\()?[1-5]\d{2}\b/;

const SECRET_RE =
	/\b(sk-[A-Za-z0-9_-]{8,}|xox[bap]-[A-Za-z0-9-]+|Bearer\s+[A-Za-z0-9._~+/-]+|api[_-]?key\s*[:=]\s*['"]?[^'"\s,}]{8,})/gi;

const MAX_DETAIL_CHARS = 200;

function redactSecrets(text: string): string {
	return text.replace(SECRET_RE, '[redacted]');
}

function messageOf(thrown: unknown): string {
	if (thrown instanceof Error) {
		const status = (thrown as unknown as { status?: unknown }).status;
		const extra = typeof status === 'number' ? `(${status}) ` : '';
		return `${extra}${thrown.message}`;
	}
	if (typeof thrown === 'string') return thrown;
	return '';
}

function classifyText(text: string): KeyTestClassification {
	const clean = redactSecrets(text.trim());
	if (REJECTED_RE.test(text)) {
		return {
			status: 'rejected',
			detail: 'The provider refused the key (401/403). Check the key and try again.',
		};
	}
	if (!HTTP_STATUS_RE.test(text) && BLOCKED_RE.test(text)) {
		return {
			status: 'blocked',
			detail:
				'The request was blocked by the browser or unreachable ' +
				'(the provider may not allow browser calls).',
		};
	}
	if (!clean) {
		return { status: 'error', detail: 'The provider returned an error with no message.' };
	}
	return { status: 'error', detail: clean.slice(0, MAX_DETAIL_CHARS) };
}

export function classifyKeyTestResult(input: KeyTestInput): KeyTestClassification {
	if ('thrown' in input) {
		return classifyText(messageOf(input.thrown));
	}
	if (input.stopReason !== 'error') {
		if (input.stopReason === 'aborted') {
			return { status: 'error', detail: 'The key test was cancelled.' };
		}
		if (input.stopReason === 'pending') {
			return { status: 'error', detail: 'The key test did not finish.' };
		}
		return { status: 'ok', detail: 'Key accepted.' };
	}
	return classifyText(input.errorMessage ?? '');
}
