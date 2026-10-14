// probe.test.mjs — Playwright tests for the static provider-access probe.
// Runnable with: node probe.test.mjs  (no external services; local servers only)
// Fails on ANY request to a host other than 127.0.0.1/localhost.
import { chromium } from 'playwright-core';
import { startMock } from './mock-provider.mjs';
import os from 'node:os';

const SHELL_1243 = os.homedir + '/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const CHROME_1243 = os.homedir + '/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
import { startStatic } from './serve.mjs';

const TEST_KEY = 'sk-test-key-ABC123-do-not-use';
const RESULTS = [];
let externalRequestSeen = null;

function check(name, cond, extra = '') {
  RESULTS.push({ name, pass: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}

async function newPage(browser, staticPort, mockPort, mode = 'normal') {
  // bypassCSP: the page's own meta CSP (connect-src 'self' + provider origin)
  // would block the local mock; the tag itself is still asserted separately.
  const ctx = await browser.newContext({ bypassCSP: true });
  const page = await ctx.newPage();
  page.on('request', (req) => {
    const u = new URL(req.url());
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') {
      externalRequestSeen = req.url();
    }
  });
  const consoleMsgs = [];
  page.on('console', (m) => consoleMsgs.push(m.text()));
  page.on('pageerror', (e) => consoleMsgs.push('PAGEERROR: ' + e.message));
  await page.goto(`http://127.0.0.1:${staticPort}/index.html`, { waitUntil: 'load' });
  await page.evaluate(
    ({ mockPort, mode, key }) => {
      window.__probe.setBaseUrl(`http://127.0.0.1:${mockPort}/mock/${mode}/v1`);
      window.__probe.setKey(key, false);
    },
    { mockPort, mode, key: TEST_KEY }
  );
  return { page, consoleMsgs };
}

async function run() {
  const mock = await startMock(0);
  const mockPort = mock.port;
  const stat = await startStatic(0);
  const staticPort = stat.port;
  const browser = await chromium.launch({ executablePath: SHELL_1243 });
  // request log lives on the mock server object
  const log = mock.requests;

  try {
    // ---- 1. key/limits info ----
    {
      const { page, consoleMsgs } = await newPage(browser, staticPort, mockPort);
      const r = await page.evaluate(() => window.__probe.runKeyInfo());
      const detail = await page.evaluate(() => window.__probe.getRow('key').detail);
      check('key-info pass path', r.pass && /remaining/i.test(detail), detail.slice(0, 160));
      check('key-info shows free-tier + rate values', /free/i.test(detail) && /rate|requests/i.test(detail), detail.slice(0, 160));
      await page.close();
    }
    // ---- 2. models classify free/paid ----
    {
      const { page } = await newPage(browser, staticPort, mockPort);
      const r = await page.evaluate(() => window.__probe.runModels());
      const detail = await page.evaluate(() => window.__probe.getRow('models').detail);
      const sel = await page.evaluate(() => window.__probe.getModelOptions());
      check('models pass path with free/paid counts', r.pass && /1 free/.test(detail) && /1 paid/.test(detail), detail.slice(0, 160));
      check('model selector defaults to a FREE model', sel.selectedFree === true, JSON.stringify(sel));
      await page.close();
    }
    // ---- 3. paid-model refusal without confirm ----
    {
      const { page } = await newPage(browser, staticPort, mockPort);
      await page.evaluate(() => window.__probe.runModels());
      log.length = 0;
      const r = await page.evaluate(() => window.__probe.runStream({ model: 'mock/paid-model' }));
      const chatCalls = log.filter((e) => e.path.includes('chat/completions'));
      check('paid model refused client-side without confirm', r.pass === false && /confirm/i.test(r.detail), r.detail.slice(0, 140));
      check('refused request sent no HTTP call', chatCalls.length === 0, `${chatCalls.length} calls`);
      // with confirm it sends
      await page.evaluate(() => { window.__probe.setConfirmPaid(true); });
      log.length = 0;
      const r2 = await page.evaluate(() => window.__probe.runStream({ model: 'mock/paid-model' }));
      const chatCalls2 = log.filter((e) => e.path.includes('chat/completions'));
      check('paid model sends once confirmed', r2.pass && chatCalls2.length >= 1, r2.detail.slice(0, 120));
      await page.close();
    }
    // ---- 4. streaming pass ----
    {
      const { page } = await newPage(browser, staticPort, mockPort);
      await page.evaluate(() => window.__probe.runModels());
      const r = await page.evaluate(() => window.__probe.runStream({}));
      check('streaming pass: incremental text + ttfb + tokens', r.pass && /first token/i.test(r.detail) && /token/i.test(r.detail), r.detail.slice(0, 180));
      await page.close();
    }
    // ---- 5. tool round trip ----
    {
      const { page } = await newPage(browser, staticPort, mockPort);
      await page.evaluate(() => window.__probe.runModels());
      const r = await page.evaluate(() => window.__probe.runTools());
      check('tool call round trip ends with final answer', r.pass && /final answer/i.test(r.detail), r.detail.slice(0, 180));
      await page.close();
    }
    // ---- 6. cancellation timing (slow stream) ----
    {
      const { page } = await newPage(browser, staticPort, mockPort, 'slow');
      await page.evaluate(() => window.__probe.runModels());
      const r = await page.evaluate(() => window.__probe.runCancel());
      check('cancellation stops reader, shows stop time, no growth', r.pass && /stop/i.test(r.detail), r.detail.slice(0, 180));
      await page.close();
    }
    // ---- 7/8/9. 401 / 402 / 429 ----
    for (const [mode, want] of [['unauthorized', '401'], ['exhausted', '402'], ['ratelimited', '429']]) {
      const { page } = await newPage(browser, staticPort, mockPort, mode);
      const r = await page.evaluate(() => window.__probe.runErrors());
      const detail = await page.evaluate(() => window.__probe.getRow('errors').detail);
      check(`${want} handled truthfully`, r.pass && detail.includes(want), detail.slice(0, 200));
      await page.close();
    }
    // ---- 10. permissive 429 shows Retry-After value ----
    {
      const { page } = await newPage(browser, staticPort, mockPort, 'ratelimited');
      const r = await page.evaluate(() => window.__probe.runErrors());
      check('permissive CORS: Retry-After value readable', /retry-after: 2/i.test(r.detail), r.detail.slice(0, 200));
      await page.close();
    }
    // ---- 11. hidden-header CORS: header exists but unreadable ----
    {
      const { page } = await newPage(browser, staticPort, mockPort, 'hidden-headers');
      await page.evaluate(() => window.__probe.runModels());
      const r = await page.evaluate(() => window.__probe.runErrorCase('ratelimited-hidden'));
      check('hidden headers: says Retry-After not exposed', /not exposed/i.test(r.detail), r.detail.slice(0, 200));
      await page.close();
    }
    // ---- 12. nocors failure ----
    {
      const { page } = await newPage(browser, staticPort, mockPort, 'nocors');
      const r = await page.evaluate(() => window.__probe.runErrors());
      check('CORS failure truthful (network/CORS)', /cors|network|failed/i.test(r.detail), r.detail.slice(0, 200));
      await page.close();
    }
    // ---- 13. no model switch ----
    {
      const { page } = await newPage(browser, staticPort, mockPort, 'ratelimited');
      log.length = 0;
      await page.evaluate(() => window.__probe.runErrors());
      const line = await page.evaluate(() => document.getElementById('no-switch-line').textContent);
      const modelsHit = [...new Set(log.filter((e) => e.model).map((e) => e.model))];
      check('no-switch line visible', /no request was moved to another model/i.test(line), line.slice(0, 80));
      check('never switched model automatically', modelsHit.length <= 1, JSON.stringify(modelsHit));
      await page.close();
    }
    // ---- 14. PKCE ----
    {
      const { page } = await newPage(browser, staticPort, mockPort);
      // RFC 7636 Appendix B vector
      const got = await page.evaluate(() => window.__probe.pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'));
      check('PKCE challenge = base64url(sha256(verifier))', got === 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', String(got));
      // full exchange against mock: callback URL with ?code=, then exchange
      await page.evaluate((mp) => {
        sessionStorage.setItem('probe.pkce.verifier', 'test-verifier-abc');
        const u = new URL(location.href);
        u.searchParams.set('code', 'mock-code-123');
        history.replaceState(null, '', u.toString());
      }, mockPort);
      log.length = 0;
      const ex = await page.evaluate((mp) => window.__probe.finishPkce(`http://127.0.0.1:${mp}/mock/normal/v1`), mockPort);
      const urlAfter = page.url();
      const exch = log.find((e) => e.path.includes('auth/keys'));
      check('PKCE exchange returns key', ex.ok === true && typeof ex.key === 'string', JSON.stringify(ex).slice(0, 100));
      check('code stripped from URL', !urlAfter.includes('mock-code-123'), urlAfter);
      check(
        'exchange body exact {code, code_verifier, code_challenge_method}',
        !!exch && JSON.stringify(Object.keys(exch.body || {}).sort()) === JSON.stringify(['code', 'code_challenge_method', 'code_verifier']),
        JSON.stringify(exch && exch.body)
      );
      await page.close();
    }
    // ---- 15b. CSP meta rewritten on provider/base change ----
    {
      const { page } = await newPage(browser, staticPort, mockPort);
      const csp0 = await page.evaluate(() => document.getElementById('csp-meta').getAttribute('content'));
      await page.evaluate(() => window.__probe.setBaseUrl('https://api.groq.com/openai/v1'));
      const csp1 = await page.evaluate(() => document.getElementById('csp-meta').getAttribute('content'));
      check('CSP meta allows only self + selected provider origin', /connect-src 'self' https:\/\/api\.groq\.com/.test(csp1) && !/openrouter/.test(csp1), String(csp1).slice(0, 120));
      await page.close();
    }
    {
      const { page, consoleMsgs } = await newPage(browser, staticPort, mockPort);
      await page.evaluate(() => window.__probe.runModels());
      const html = await page.evaluate(() => document.documentElement.outerHTML);
      const url = page.url();
      const ls = await page.evaluate(() => ({ ...localStorage }));
      const res = await page.evaluate(() => JSON.stringify(window.__probe.getResults()));
      const leaked = [html, url, JSON.stringify(ls), res].some((s) => s.includes(TEST_KEY)) || consoleMsgs.some((m) => m.includes(TEST_KEY));
      check('key absent from DOM/URL/storage/results/console (no Remember)', !leaked, leaked ? 'LEAK FOUND' : 'clean');
      // remember on -> only localStorage
      await page.evaluate((k) => window.__probe.setKey(k, true), TEST_KEY);
      const ls2 = await page.evaluate(() => ({ ...localStorage }));
      const html2 = await page.evaluate(() => document.documentElement.outerHTML);
      check('Remember: key only in localStorage', JSON.stringify(ls2).includes(TEST_KEY) && !html2.includes(TEST_KEY), Object.keys(ls2).join(','));
      // forget removes
      await page.evaluate(() => window.__probe.forgetKey());
      const ls3 = await page.evaluate(() => ({ ...localStorage }));
      const memEmpty = await page.evaluate(() => window.__probe.hasKey() === false);
      check('Forget clears memory + storage', !JSON.stringify(ls3).includes(TEST_KEY) && memEmpty, Object.keys(ls3).join(',') || 'empty');
      await page.close();
    }
  } finally {
    await browser.close();
    mock.close();
    stat.close();
  }

  check('no request to any non-local host during tests', externalRequestSeen === null, externalRequestSeen || 'all local');
  const failed = RESULTS.filter((r) => !r.pass);
  console.log(`\n${RESULTS.length - failed.length}/${RESULTS.length} tests passed`);
  if (failed.length) {
    console.log('FAILED:', failed.map((f) => f.name).join(' | '));
    process.exit(1);
  }
}

run().catch((e) => {
  console.error('TEST HARNESS ERROR:', e.message);
  process.exit(2);
});
