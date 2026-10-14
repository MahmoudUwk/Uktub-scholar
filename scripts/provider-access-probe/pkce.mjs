// pkce.mjs — OpenRouter PKCE helpers, exactly as documented at
// https://openrouter.ai/docs/guides/overview/auth/oauth
// Step 1: GET https://openrouter.ai/auth?callback_url=<URL>
//           &code_challenge=<CHALLENGE>&code_challenge_method=S256
//   code_challenge = base64url(sha256(code_verifier)) for S256.
// Step 2: POST https://openrouter.ai/api/v1/auth/keys with JSON body
//   { code, code_verifier, code_challenge_method } -> { key }.

export function base64url(bytes) {
  let s = '';
  const arr = new Uint8Array(bytes);
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function createVerifier() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes.buffer);
}

export async function createChallengeS256(verifier) {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return base64url(hash);
}

export function buildAuthUrl({ authUrl, callbackUrl, challenge, method = 'S256', keyLabel }) {
  const u = new URL(authUrl);
  if (callbackUrl) u.searchParams.set('callback_url', callbackUrl);
  if (challenge) {
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', method);
  }
  if (keyLabel) u.searchParams.set('key_label', keyLabel);
  return u.toString();
}

export async function exchangeCode(exchangeUrl, { code, verifier, method = 'S256' }) {
  const resp = await fetch(exchangeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: method }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.key) {
    throw new Error(`code exchange failed: HTTP ${resp.status} ${data?.error?.message || ''}`.trim());
  }
  return data.key;
}
