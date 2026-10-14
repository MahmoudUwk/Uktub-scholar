// probe.mjs — static provider-access probe logic (no framework, no runtime deps).
import { PROVIDERS, providerById, isFreeModel } from './providers.mjs';
import { createVerifier, createChallengeS256, buildAuthUrl, exchangeCode } from './pkce.mjs';

const $ = (id) => document.getElementById(id);
const nowIso = () => new Date().toISOString();

const state = {
  providerId: 'openrouter',
  baseUrl: providerById('openrouter').baseUrl,
  key: '', // memory only by default; never rendered, logged, or saved in results
  remember: false,
  models: [], // {id, free}
  selectedModel: '',
  confirmPaid: false,
  rows: {}, // name -> {status, detail, at}
};

function setRow(name, status, detail) {
  state.rows[name] = { status, detail, at: nowIso() };
  const row = $('row-' + name);
  if (row) {
    row.querySelector('.status').textContent = status;
    row.querySelector('.detail').textContent = detail;
  }
}

function updateCsp() {
  let origin = "'self'";
  try { origin = new URL(state.baseUrl).origin; } catch { /* keep self */ }
  const meta = $('csp-meta');
  if (meta) meta.setAttribute('content', `connect-src 'self' ${origin}; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'`);
}

function authHeaders() {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${state.key}` };
}

// ---- SSE reader: incremental deltas, first-token timing, usage, tool calls ----
async function readSseStream(resp, signal, onText) {
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '', text = '', firstTokenAt = 0, usage = null, toolCalls = [], finishReason = null;
  const t0 = performance.now();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const event = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of event.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') continue;
        let obj;
        try { obj = JSON.parse(payload); } catch { continue; }
        if (obj.usage) usage = obj.usage;
        const choice = obj.choices && obj.choices[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta || {};
        if (typeof delta.content === 'string' && delta.content) {
          if (!firstTokenAt) firstTokenAt = performance.now();
          text += delta.content;
          if (onText) onText(text);
        }
        for (const tc of delta.tool_calls || []) {
          const slot = toolCalls[tc.index || 0] || (toolCalls[tc.index || 0] = { id: '', name: '', args: '' });
          if (tc.id) slot.id = tc.id;
          if (tc.function) {
            if (tc.function.name) slot.name += tc.function.name;
            if (tc.function.arguments) slot.args += tc.function.arguments;
          }
        }
      }
    }
    if (signal && signal.aborted) { try { await reader.cancel(); } catch { /* closed */ } break; }
  }
  return { text, msToFirstToken: firstTokenAt ? Math.round(firstTokenAt - t0) : null, usage, toolCalls, finishReason };
}

function headerReport(headers, names) {
  const out = [];
  for (const n of names) {
    const v = headers.get(n);
    out.push(v === null ? `${n}: unreadable (absent or not exposed to the page via CORS)` : `${n}: ${v}`);
  }
  return out.join('; ');
}

function errorDetail(label, status, headers, errBody) {
  const msg = (errBody && errBody.error && errBody.error.message) || '(no provider error text)';
  const meta = (errBody && errBody.error && errBody.error.metadata) || {};
  let s = `${label}: HTTP ${status}. Provider says: ${msg}`;
  s += ` | ${headerReport(headers, ['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'])}`;
  if (meta.limit_source) s += ` | limit_source: ${meta.limit_source}`;
  if (meta.remedy_hint) s += ` | hint: ${meta.remedy_hint}`;
  const ra = headers.get('retry-after');
  s += ra ? ` | You may retry after ${ra} seconds (manual retry only; no automatic retry loops).` : ' | Retry hint unreadable: Retry-After is not exposed to the page (absent or hidden by CORS policy). Manual retry only; no automatic retry loops.';
  s += ' No request was moved to another model.';
  return s;
}

async function postChat(payload, { key, signal } = {}) {
  const resp = await fetch(`${state.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key !== undefined ? key : state.key}` },
    body: JSON.stringify(payload),
    signal,
  });
  return resp;
}

function paidGuard(model) {
  const entry = state.models.find((m) => m.id === model);
  const free = entry ? entry.free : model.endsWith(':free');
  if (!free && !state.confirmPaid) {
    return `Refused client-side: "${model}" is not classified as free. Tick "this may spend my credits" to confirm a paid-model request. No request was sent.`;
  }
  return null;
}

// ---- rows ----
async function runKeyInfo() {
  const t0 = performance.now();
  try {
    const resp = await fetch(`${state.baseUrl}/key`, { headers: { Authorization: `Bearer ${state.key}` } });
    const ms = Math.round(performance.now() - t0);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const d = errorDetail('key/limits', resp.status, resp.headers, data);
      setRow('key', 'fail', d);
      return { pass: false, detail: d };
    }
    const k = data.data || {};
    const fm = k.free_model_daily_requests || {};
    const d = `Key OK (${ms} ms). limit_remaining: ${k.limit_remaining}; is_free_tier: ${k.is_free_tier}; ` +
      `free-model requests used/limit/remaining: ${fm.used}/${fm.limit}/${fm.remaining}; usage today: ${k.usage_daily}.`;
    setRow('key', 'pass', d);
    return { pass: true, detail: d };
  } catch (e) {
    const d = `key/limits: network/CORS failure (${e.name}: ${e.message}). No request was moved to another model.`;
    setRow('key', 'fail', d);
    return { pass: false, detail: d };
  }
}

async function runModels() {
  try {
    const resp = await fetch(`${state.baseUrl}/models`, { headers: { Authorization: `Bearer ${state.key}` } });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const d = errorDetail('models', resp.status, resp.headers, data);
      setRow('models', 'fail', d);
      return { pass: false, detail: d };
    }
    const list = (data.data || []).map((m) => ({ id: m.id, free: isFreeModel(m) }));
    state.models = list;
    const free = list.filter((m) => m.free), paid = list.filter((m) => !m.free);
    const sel = $('model');
    sel.innerHTML = '';
    for (const m of [...free, ...paid]) {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = `${m.id} (${m.free ? 'free' : 'paid'})`;
      sel.appendChild(o);
    }
    state.selectedModel = (free[0] || list[0] || {}).id || '';
    sel.value = state.selectedModel;
    const d = `Models: ${free.length} free, ${paid.length} paid of ${list.length}. Selector defaults to free model "${state.selectedModel}".`;
    setRow('models', 'pass', d);
    return { pass: true, detail: d };
  } catch (e) {
    const d = `models: network/CORS failure (${e.name}: ${e.message}). No request was moved to another model.`;
    setRow('models', 'fail', d);
    return { pass: false, detail: d };
  }
}

async function runStream({ model } = {}) {
  const useModel = model || state.selectedModel || ($('model') && $('model').value);
  const refused = paidGuard(useModel);
  if (refused) { setRow('stream', 'fail', refused); return { pass: false, detail: refused }; }
  const t0 = performance.now();
  try {
    const resp = await postChat({ model: useModel, messages: [{ role: 'user', content: 'Say hello in one short sentence.' }], stream: true, stream_options: { include_usage: true } });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      const d = errorDetail('streaming chat', resp.status, resp.headers, data);
      setRow('stream', 'fail', d);
      return { pass: false, detail: d };
    }
    const r = await readSseStream(resp, null, null);
    const ms = Math.round(performance.now() - t0);
    const tok = r.usage ? ` tokens prompt/completion/total: ${r.usage.prompt_tokens}/${r.usage.completion_tokens}/${r.usage.total_tokens}` : ' token count not reported by provider';
    const d = `Streamed "${useModel}" in ${ms} ms. Time to first token: ${r.msToFirstToken} ms.${tok}. Text: ${r.text}`;
    const pass = r.text.length > 0;
    setRow('stream', pass ? 'pass' : 'fail', d);
    return { pass, detail: d };
  } catch (e) {
    const d = `streaming chat: network/CORS failure (${e.name}: ${e.message}). No request was moved to another model.`;
    setRow('stream', 'fail', d);
    return { pass: false, detail: d };
  }
}

// The one trivial function the model may call during the tool round trip.
function get_probe_info(args) {
  return { probe: 'provider-access-probe', version: '1.0', detail: (args && args.detail) || '' };
}

async function runTools() {
  const useModel = state.selectedModel || ($('model') && $('model').value);
  const refused = paidGuard(useModel);
  if (refused) { setRow('tools', 'fail', refused); return { pass: false, detail: refused }; }
  const tools = [{ type: 'function', function: { name: 'get_probe_info', description: 'Return probe version info', parameters: { type: 'object', properties: { detail: { type: 'string' } } } } }];
  const messages = [{ role: 'user', content: 'Call get_probe_info with detail "version" and report what it returns.' }];
  try {
    const r1 = await postChat({ model: useModel, messages, tools, tool_choice: 'auto', stream: true });
    if (!r1.ok) {
      const data = await r1.json().catch(() => ({}));
      const d = errorDetail('tool call (step 1)', r1.status, r1.headers, data);
      setRow('tools', 'fail', d);
      return { pass: false, detail: d };
    }
    const s1 = await readSseStream(r1, null, null);
    if (!s1.toolCalls.length || !s1.toolCalls[0].name) {
      const d = `tool call: model returned text without a tool call. No request was moved to another model. Text: ${s1.text}`;
      setRow('tools', 'fail', d);
      return { pass: false, detail: d };
    }
    const tc = s1.toolCalls[0];
    let result;
    try { result = get_probe_info(JSON.parse(tc.args || '{}')); }
    catch { result = { error: 'bad arguments' }; }
    const follow = [
      ...messages,
      { role: 'assistant', tool_calls: [{ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args } }] },
      { role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) },
    ];
    const r2 = await postChat({ model: useModel, messages: follow, stream: true });
    if (!r2.ok) {
      const data = await r2.json().catch(() => ({}));
      const d = errorDetail('tool call (step 2)', r2.status, r2.headers, data);
      setRow('tools', 'fail', d);
      return { pass: false, detail: d };
    }
    const s2 = await readSseStream(r2, null, null);
    const pass = s2.text.length > 0;
    const d = `Tool round trip: model called ${tc.name}(${tc.args}); page executed it locally and returned ${JSON.stringify(result)}. Final answer arrived: ${s2.text}`;
    setRow('tools', pass ? 'pass' : 'fail', d);
    return { pass, detail: d };
  } catch (e) {
    const d = `tool call: network/CORS failure (${e.name}: ${e.message}). No request was moved to another model.`;
    setRow('tools', 'fail', d);
    return { pass: false, detail: d };
  }
}

async function runCancel() {
  const useModel = state.selectedModel || ($('model') && $('model').value);
  const refused = paidGuard(useModel);
  if (refused) { setRow('cancel', 'fail', refused); return { pass: false, detail: refused }; }
  const ctrl = new AbortController();
  let text = '', aborted = false;
  try {
    const resp = await postChat({ model: useModel, messages: [{ role: 'user', content: 'Talk at length.' }], stream: true }, { signal: ctrl.signal });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      const d = errorDetail('cancellation', resp.status, resp.headers, data);
      setRow('cancel', 'fail', d);
      return { pass: false, detail: d };
    }
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '', firstAt = 0;
    const t0 = performance.now();
    setTimeout(() => { aborted = true; ctrl.abort(); }, 400);
    const tAbort = { at: 0 };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const ev = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of ev.split('\n')) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const p = t.slice(5).trim();
            if (p === '[DONE]') continue;
            try {
              const o = JSON.parse(p);
              const c = o.choices && o.choices[0] && o.choices[0].delta && o.choices[0].delta.content;
              if (c) { if (!firstAt) firstAt = performance.now(); text += c; }
            } catch { /* skip */ }
          }
        }
      }
    } catch (e) {
      if (e.name === 'AbortError' || aborted) { tAbort.at = performance.now(); try { await reader.cancel(); } catch { /* closed */ } }
      else throw e;
    }
    const stopMs = tAbort.at ? Math.round(tAbort.at - t0) : Math.round(performance.now() - t0);
    const lenAtStop = text.length;
    await new Promise((r) => setTimeout(r, 700));
    const grew = text.length !== lenAtStop;
    const d = `Cancellation: aborted mid-stream; reader stopped ${stopMs} ms after start; text length at stop ${lenAtStop}, 700 ms later ${text.length} (${grew ? 'GREW — fail' : 'no further text'}). Text: ${text}`;
    const pass = aborted && !grew;
    setRow('cancel', pass ? 'pass' : 'fail', d);
    return { pass, detail: d };
  } catch (e) {
    if (e.name === 'AbortError') {
      const d = 'Cancellation: request aborted before streaming began. No request was moved to another model.';
      setRow('cancel', 'fail', d);
      return { pass: false, detail: d };
    }
    const d = `cancellation: network/CORS failure (${e.name}: ${e.message}). No request was moved to another model.`;
    setRow('cancel', 'fail', d);
    return { pass: false, detail: d };
  }
}

async function attemptChat(label, key) {
  try {
    const resp = await postChat({ model: state.selectedModel || 'mock/free-model', messages: [{ role: 'user', content: 'probe' }], stream: false }, { key });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok) return `${label}: unexpectedly OK (HTTP 200). No request was moved to another model.`;
    return errorDetail(label, resp.status, resp.headers, data);
  } catch (e) {
    return `${label}: network/CORS failure — the request never reached the provider (${e.name}: ${e.message}). No request was moved to another model.`;
  }
}

async function runErrors() {
  const parts = [];
  parts.push(await attemptChat('current-key attempt', undefined));
  parts.push(await attemptChat('bad-key attempt', 'probe-bad-key'));
  try {
    await fetch('http://127.0.0.1:9/unreachable', { signal: AbortSignal.timeout(5000) });
    parts.push('unreachable-host attempt: unexpectedly OK.');
  } catch (e) {
    parts.push(`unreachable-host attempt: network failure handled truthfully (${e.name}: ${e.message}). No request was moved to another model.`);
  }
  const d = parts.join('\n');
  setRow('errors', 'pass', d);
  return { pass: true, detail: d };
}

// One user-initiated retry only — never called automatically.
async function retryErrorsOnce() {
  return runErrors();
}

// ---- credential handling ----
function setKey(key, remember) {
  state.key = key || '';
  state.remember = !!remember;
  const input = $('api-key');
  if (input && document.activeElement !== input) input.value = state.key ? '••••••••' : '';
  if (state.remember && state.key) {
    try { localStorage.setItem('probe.key', state.key); } catch { /* storage blocked */ }
  } else {
    try { localStorage.removeItem('probe.key'); } catch { /* storage blocked */ }
  }
  const st = $('auth-status');
  if (st) st.textContent = state.key ? 'Key held in memory.' : 'No key stored.';
}

function forgetKey() {
  state.key = '';
  state.remember = false;
  try { localStorage.removeItem('probe.key'); } catch { /* blocked */ }
  try { sessionStorage.removeItem('probe.pkce.verifier'); } catch { /* blocked */ }
  const input = $('api-key');
  if (input) input.value = '';
  const rem = $('remember');
  if (rem) rem.checked = false;
  const st = $('auth-status');
  if (st) st.textContent = 'Key forgotten.';
}

async function startPkce() {
  const p = providerById(state.providerId);
  if (!p.pkce) { $('auth-status').textContent = 'This provider has no documented browser PKCE flow; paste an API key instead.'; return; }
  const verifier = createVerifier();
  try { sessionStorage.setItem('probe.pkce.verifier', verifier); } catch { /* blocked */ }
  const challenge = await createChallengeS256(verifier);
  const callbackUrl = location.origin + location.pathname;
  location.href = buildAuthUrl({ authUrl: p.pkce.authUrl, callbackUrl, challenge, keyLabel: 'uktub-probe' });
}

async function finishPkce(exchangeBase) {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  if (!code) return { ok: false, reason: 'no code in URL' };
  // Strip the code from the URL immediately after reading it.
  params.delete('code');
  const clean = location.pathname + (params.toString() ? '?' + params.toString() : '') + location.hash;
  history.replaceState(null, '', clean);
  let verifier = null;
  try { verifier = sessionStorage.getItem('probe.pkce.verifier'); } catch { /* blocked */ }
  const base = (exchangeBase || state.baseUrl).replace(/\/$/, '');
  const key = await exchangeCode(`${base}/auth/keys`, { code, verifier, method: 'S256' });
  try { sessionStorage.removeItem('probe.pkce.verifier'); } catch { /* blocked */ }
  setKey(key, state.remember);
  return { ok: true, key };
}

// ---- results download: key and code are never included ----
function getResults() {
  return {
    generatedAt: nowIso(),
    userAgent: navigator.userAgent,
    origin: location.origin,
    provider: state.providerId,
    rows: Object.entries(state.rows).map(([name, r]) => ({ name, status: r.status, detail: r.detail, at: r.at })),
    redaction: 'key and authorization code are never written to results',
  };
}

function downloadResults() {
  const blob = new Blob([JSON.stringify(getResults(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'probe-results.json';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
}

function setBaseUrl(url) {
  state.baseUrl = url;
  const input = $('base-url');
  if (input) input.value = url;
  updateCsp();
}

function setProvider(id) {
  state.providerId = id;
  const p = providerById(id);
  if (id !== 'custom') setBaseUrl(p.baseUrl);
  else updateCsp();
}

async function runAll() {
  await runKeyInfo();
  await runModels();
  await runStream({});
  await runTools();
  await runCancel();
  await runErrors();
}

function wire() {
  const prov = $('provider');
  PROVIDERS.forEach((p) => {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name;
    prov.appendChild(o);
  });
  prov.value = state.providerId;
  prov.addEventListener('change', () => setProvider(prov.value));
  $('base-url').value = state.baseUrl;
  $('base-url').addEventListener('change', (e) => { state.providerId = 'custom'; prov.value = 'custom'; setBaseUrl(e.target.value.trim()); });
  $('btn-pkce').addEventListener('click', () => startPkce().catch((e) => { $('auth-status').textContent = 'Sign-in failed: ' + e.message; }));
  $('api-key').addEventListener('change', (e) => setKey(e.target.value, $('remember').checked));
  $('remember').addEventListener('change', (e) => setKey(state.key || $('api-key').value === '••••••••' ? state.key : $('api-key').value, e.target.checked));
  $('btn-forget').addEventListener('click', forgetKey);
  $('model').addEventListener('change', (e) => { state.selectedModel = e.target.value; });
  $('confirm-paid').addEventListener('change', (e) => { state.confirmPaid = e.target.checked; });
  $('run-key').addEventListener('click', runKeyInfo);
  $('run-models').addEventListener('click', runModels);
  $('run-stream').addEventListener('click', () => runStream({}));
  $('run-tools').addEventListener('click', runTools);
  $('run-cancel').addEventListener('click', runCancel);
  $('run-errors').addEventListener('click', runErrors);
  $('retry-errors').addEventListener('click', retryErrorsOnce);
  $('run-all').addEventListener('click', runAll);
  $('btn-download').addEventListener('click', downloadResults);
  // Restore a remembered key (explicit opt-in from a previous session).
  let saved = null;
  try { saved = localStorage.getItem('probe.key'); } catch { /* blocked */ }
  if (saved) { $('remember').checked = true; setKey(saved, true); }
  updateCsp();
  // PKCE callback: exchange ?code= automatically on load.
  if (new URLSearchParams(location.search).get('code')) {
    finishPkce().then(
      () => { $('auth-status').textContent = 'Signed in with OpenRouter (key held in memory).'; },
      (e) => { $('auth-status').textContent = 'Sign-in failed: ' + e.message; }
    );
  }
}

document.addEventListener('DOMContentLoaded', wire);

async function runErrorCase(name) {
  if (name === 'ratelimited-hidden') {
    const saved = state.baseUrl;
    state.baseUrl = saved.replace(/\/mock\/[^/]+\//, '/mock/hidden-headers/');
    const d = await attemptChat('hidden-header 429 attempt', 'probe-ratelimited-key');
    state.baseUrl = saved;
    const pass = /429/.test(d) && /not exposed/.test(d);
    setRow('errors', pass ? 'pass' : 'fail', d);
    return { pass, detail: d };
  }
  return { pass: false, detail: 'unknown error case' };
}

// Test + UI automation surface (no secrets are ever exposed through it).
window.__probe = {
  setBaseUrl, setKey, setConfirmPaid: (b) => { state.confirmPaid = !!b; const c = $('confirm-paid'); if (c) c.checked = !!b; },
  hasKey: () => state.key.length > 0, forgetKey,
  runKeyInfo, runModels, runStream, runTools, runCancel, runErrors, runErrorCase,
  getRow: (n) => ({ ...(state.rows[n] || { status: 'unrun', detail: '' }) }),
  getResults,
  getModelOptions: () => {
    const sel = $('model');
    const cur = sel ? sel.value : state.selectedModel;
    const entry = state.models.find((m) => m.id === cur);
    return { value: cur, selectedFree: !!(entry && entry.free), count: state.models.length };
  },
  pkceChallenge: createChallengeS256,
  finishPkce,
};
