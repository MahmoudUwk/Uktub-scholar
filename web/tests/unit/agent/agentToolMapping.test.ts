// SPDX-License-Identifier: AGPL-3.0-or-later
// Core tool result (MCP-style, from the worker) -> pi-agent-core AgentToolResult.
import { toAgentToolResult } from '../../../src/services/agent/agentUktubTools';

describe('toAgentToolResult', () => {
	it('passes success content through with structured content and no error', () => {
		const out = toAgentToolResult({
			content: [{ type: 'text', text: 'found 2 papers' }],
			structuredContent: { total: 2 },
			details: {},
		});
		expect(out.content).toEqual([{ type: 'text', text: 'found 2 papers' }]);
		expect(out.structuredContent).toEqual({ total: 2 });
		expect(out.isError).toBeFalsy();
	});

	it('marks a refusal as an error (verify missing-key refusal stays visible)', () => {
		const out = toAgentToolResult({
			content: [
				{
					type: 'text',
					text: 'Refused: VERIFY_NO_KEY — the hosted verifier needs a free key.',
				},
			],
			structuredContent: null,
			details: {
				refused: { code: 'VERIFY_NO_KEY', message: 'no key' },
			},
		});
		expect(out.isError).toBe(true);
		expect(out.content[0]).toMatchObject({ type: 'text' });
		expect(out.details).toMatchObject({
			refused: { code: 'VERIFY_NO_KEY' },
		});
	});

	it('marks a thrown worker envelope as an error without losing the message', () => {
		const out = toAgentToolResult({
			content: [{ type: 'text', text: 'tool registry failed: boom' }],
			structuredContent: null,
			details: { thrown: true, tool: 'registry', message: 'boom' },
		});
		expect(out.isError).toBe(true);
		expect(out.content).toEqual([
			{ type: 'text', text: 'tool registry failed: boom' },
		]);
	});
});
