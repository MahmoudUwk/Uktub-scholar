// providers.mjs — provider list. Base URLs and auth header names come from each
// provider's official documentation page (URL cited above each entry).
// A provider whose docs do not state an OpenAI-compatible endpoint is left out
// (NVIDIA: not confirmed — see NOTES.md; use Custom with your own base URL).

export const PROVIDERS = [
  {
    id: 'openrouter',
    name: 'OpenRouter (default)',
    // Docs: https://openrouter.ai/docs/api-reference/authentication
    //   "If you're using the OpenAI Typescript SDK, set the api_base to
    //    https://openrouter.ai/api/v1 and the apiKey to your API key."
    // Auth header: Authorization: Bearer <OPENROUTER_API_KEY>
    //   (https://openrouter.ai/docs/api-reference/overview — Headers section)
    baseUrl: 'https://openrouter.ai/api/v1',
    authHeader: 'Authorization',
    authScheme: 'Bearer',
    // PKCE sign-in: https://openrouter.ai/docs/guides/overview/auth/oauth
    pkce: {
      authUrl: 'https://openrouter.ai/auth',
      exchangeUrl: 'https://openrouter.ai/api/v1/auth/keys',
    },
  },
  {
    id: 'groq',
    name: 'Groq',
    // Docs: https://console.groq.com/docs/openai
    //   "change the base_url to https://api.groq.com/openai/v1" and
    //   "pass your Groq API key to the api_key parameter" (Bearer).
    baseUrl: 'https://api.groq.com/openai/v1',
    authHeader: 'Authorization',
    authScheme: 'Bearer',
  },
  {
    id: 'gemini',
    name: 'Gemini (OpenAI-compatible)',
    // Docs: https://ai.google.dev/gemini-api/docs/openai
    //   base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
    //   api_key="GEMINI_API_KEY"; REST uses Authorization: Bearer.
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    authHeader: 'Authorization',
    authScheme: 'Bearer',
  },
  {
    id: 'custom',
    name: 'Custom base URL',
    baseUrl: '',
    authHeader: 'Authorization',
    authScheme: 'Bearer',
  },
];

export function providerById(id) {
  return PROVIDERS.find((p) => p.id === id) || PROVIDERS[0];
}

// A model is FREE only when every pricing field is numerically zero.
// OpenRouter's GET /api/v1/models returns pricing {prompt, completion, ...}
// as decimal strings; :free variants are priced at zero.
export function isFreeModel(m) {
  const pricing = (m && m.pricing) || {};
  const vals = Object.values(pricing);
  if (!vals.length) return false;
  return vals.every((v) => Number(v) === 0);
}
