// mock-provider.mjs — dependency-free local mock of an OpenAI-compatible
// provider, reproducing documented provider behaviours for client-logic tests.
// Modes are selected by path prefix: /mock/<mode>/v1/...
//   normal | hidden-headers | nocors | unauthorized | exhausted | ratelimited | slow
// A mock proves CLIENT logic only, never real provider behaviour (see README).
import http from 'node:http';

const MODES = new Set(['normal', 'hidden-headers', 'nocors', 'unauthorized', 'exhausted', 'ratelimited', 'slow']);

const FREE_MODEL = { id: 'mock/free-model', pricing: { prompt: '0', completion: '0' } };
const PAID_MODEL = { id: 'mock/paid-model', pricing: { prompt: '0.000001', completion: '0.000002' } };

function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => { s += c; });
    req.on('end', () => {
      try { resolve(s ? JSON.parse(s) : {}); } catch { resolve({}); }
    });
  });
}

// CORS: permissive everywhere except nocors. hidden-headers omits
// Access-Control-Expose-Headers so Retry-After / x-ratelimit-* are unreadable.
function corsHeaders(mode, origin) {
  if (mode === 'nocors') return {};
  const h = {
    'access-control-allow-origin': origin || '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, http-referer, x-openrouter-title',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
  if (mode !== 'hidden-headers') {
    h['access-control-expose-headers'] = 'retry-after, x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset';
  }
  return h;
}

const errJson = (code, message, metadata) => JSON.stringify({ error: { code, message, ...(metadata ? { metadata } : {}) } });

function send(res, mode, origin, status, headers, body) {
  res.writeHead(status, { 'content-type': 'application/json', ...corsHeaders(mode, origin), ...headers });
  res.end(body);
}

const sseChunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

function streamText(res, mode, origin, { model, slow, usage }) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    ...corsHeaders(mode, origin),
  });
  const words = ['Hello', ' from', ' the', ' mock', ' stream.'];
  let i = 0;
  const step = () => {
    if (i < words.length) {
      res.write(sseChunk({ id: 'cmpl-mock', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: { content: words[i] }, finish_reason: null }] }));
      i += 1;
      // slow mode: first token fast, then a long pause (cancellation tests abort here)
      setTimeout(step, i === 1 && slow ? 3000 : 25);
    } else {
      if (usage) {
        res.write(sseChunk({ id: 'cmpl-mock', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }));
      }
      res.write('data: [DONE]\n\n');
      res.end();
    }
  };
  step();
}

function streamToolCall(res, mode, origin, model) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...corsHeaders(mode, origin) });
  res.write(sseChunk({ id: 'cmpl-mock', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_probe_info', arguments: '{"detail":"version"}' } }] }, finish_reason: null }] }));
  setTimeout(() => {
    res.write(sseChunk({ id: 'cmpl-mock', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
    res.write('data: [DONE]\n\n');
    res.end();
  }, 25);
}

function finalAnswer(res, mode, origin, model) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...corsHeaders(mode, origin) });
  res.write(sseChunk({ id: 'cmpl-mock', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: { content: 'Tool result received. Final answer: probe v1.' }, finish_reason: null }] }));
  res.write(sseChunk({ id: 'cmpl-mock', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
  res.write('data: [DONE]\n\n');
  res.end();
}

export function startMock(port = 0) {
  const requests = []; // {method, path, model?, auth, body?} — key material never logged
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const url = new URL(req.url, 'http://x');
    const m = url.pathname.match(/^\/mock\/([^/]+)\/v1(\/.*)$/);
    if (!m || !MODES.has(m[1])) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(errJson(404, 'unknown mock path'));
      return;
    }
    const [, mode, sub] = m;
    if (req.method === 'OPTIONS') {
      const h = corsHeaders(mode, origin);
      res.writeHead(mode === 'nocors' ? 200 : 204, h);
      res.end();
      return;
    }
    const auth = req.headers.authorization || '';
    const hasAuth = auth.startsWith('Bearer ') && auth.length > 7;
    const keyTag = !hasAuth ? 'absent' : auth === 'Bearer probe-bad-key' ? 'bad' : auth === 'Bearer probe-exhausted-key' ? 'exhausted' : auth === 'Bearer probe-ratelimited-key' ? 'ratelimited' : 'valid';
    const body = (req.method === 'POST' || req.method === 'PUT') ? await readBody(req) : {};
    if (sub === '/auth/keys') {
      requests.push({ method: req.method, path: url.pathname, auth: hasAuth ? 'n/a' : 'absent', body });
      if (body && body.code === 'mock-code-123') {
        send(res, mode, origin, 200, {}, JSON.stringify({ key: 'mock-key-pkce-001' }));
      } else {
        send(res, mode, origin, 403, {}, errJson(403, 'Invalid code or code_verifier'));
      }
      return;
    }
    if (sub === '/key') {
      requests.push({ method: req.method, path: url.pathname, auth: keyTag });
      if (mode === 'unauthorized' || keyTag === 'bad' || !hasAuth) {
        send(res, mode, origin, 401, {}, errJson(401, 'Invalid credentials (disabled/invalid API key)'));
        return;
      }
      send(res, mode, origin, 200, {}, JSON.stringify({
        data: {
          label: 'probe-key', limit: 100, limit_remaining: 87.5, usage: 12.5,
          usage_daily: 0.4, usage_weekly: 2.1, usage_monthly: 12.5,
          is_free_tier: true,
          free_model_daily_requests: { used: 3, limit: 50, remaining: 47 },
        },
      }));
      return;
    }
    if (sub === '/models') {
      requests.push({ method: req.method, path: url.pathname, auth: keyTag });
      if (mode === 'unauthorized' || keyTag === 'bad' || !hasAuth) {
        send(res, mode, origin, 401, {}, errJson(401, 'Invalid credentials (disabled/invalid API key)'));
        return;
      }
      send(res, mode, origin, 200, {}, JSON.stringify({ data: [FREE_MODEL, PAID_MODEL] }));
      return;
    }
    if (sub === '/chat/completions') {
      const model = body && typeof body.model === 'string' ? body.model : null;
      requests.push({ method: req.method, path: url.pathname, auth: keyTag, model });
      const rateHeaders = { 'retry-after': '2', 'x-ratelimit-limit': '20', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '60' };
      if (mode === 'unauthorized' || keyTag === 'bad' || !hasAuth) {
        send(res, mode, origin, 401, {}, errJson(401, 'Invalid credentials (disabled/invalid API key)'));
        return;
      }
      if (mode === 'exhausted' || keyTag === 'exhausted') {
        send(res, mode, origin, 402, {}, errJson(402, 'This request would exceed your available credits. Add more credits and retry the request.',
          { limit_source: 'openrouter_credits', remedy_hint: 'Add credits, or use a free model variant.' }));
        return;
      }
      if (mode === 'ratelimited' || keyTag === 'ratelimited') {
        send(res, mode, origin, 429, rateHeaders, errJson(429, 'Rate limit exceeded', { error_type: 'rate_limit_exceeded' }));
        return;
      }
      const msgs = Array.isArray(body.messages) ? body.messages : [];
      const hasToolResult = msgs.some((x) => x && x.role === 'tool');
      const wantsTools = Array.isArray(body.tools) && body.tools.length > 0;
      if (wantsTools && !hasToolResult) { streamToolCall(res, mode, origin, model); return; }
      if (hasToolResult) { finalAnswer(res, mode, origin, model); return; }
      streamText(res, mode, origin, { model, slow: mode === 'slow', usage: body.stream_options && body.stream_options.include_usage });
      return;
    }
    send(res, mode, origin, 404, {}, errJson(404, 'unknown mock endpoint'));
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ port: server.address().port, requests, close: () => server.close() }));
  });
}

// CLI: node mock-provider.mjs [port]
const cliPort = Number(process.argv[2] || 8788);
if (process.argv[1] && process.argv[1].endsWith('mock-provider.mjs')) {
  startMock(cliPort).then(({ port }) => console.log(`mock provider on http://127.0.0.1:${port}`));
}
