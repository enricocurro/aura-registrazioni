/**
 * Trascrizione con Google Cloud Speech-to-Text v2 — stessa configurazione del backend Aura
 * (`GOOGLE_STT_CREDENTIALS_JSON`, `GOOGLE_STT_LOCATION`, modello `long`, italiano), via REST
 * e senza SDK: il token si ottiene firmando un JWT con la chiave del service account.
 *
 * Se le credenziali mancano la piattaforma funziona lo stesso: le battute restano senza
 * testo e chi valuta può scriverlo a mano.
 */
import { createSign } from "node:crypto";

const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
/** Limite del riconoscimento sincrono di Google: 60 s di audio per richiesta. */
export const STT_MAX_MS = 58000;

const base64url = (value) => Buffer.from(value).toString("base64url");

export function recognizeUrl(projectId, location) {
  const host = location === "global" ? "speech.googleapis.com" : `${location}-speech.googleapis.com`;
  return `https://${host}/v2/projects/${projectId}/locations/${location}/recognizers/_:recognize`;
}

export function createStt({ credentialsJson, location = "eu", languageCode = "it-IT", fetchImpl = fetch }) {
  if (!credentialsJson) return { enabled: false, transcribe: async () => null };

  let credentials;
  try {
    credentials = JSON.parse(credentialsJson);
  } catch {
    throw new Error("GOOGLE_STT_CREDENTIALS_JSON non è un JSON valido");
  }
  if (!credentials.project_id || !credentials.client_email || !credentials.private_key) {
    throw new Error("GOOGLE_STT_CREDENTIALS_JSON: servono project_id, client_email e private_key");
  }

  let cached = { token: null, expiresAt: 0 };

  async function accessToken() {
    if (cached.token && Date.now() < cached.expiresAt - 60000) return cached.token;
    const now = Math.floor(Date.now() / 1000);
    const tokenUri = credentials.token_uri ?? "https://oauth2.googleapis.com/token";
    const unsigned =
      base64url(JSON.stringify({ alg: "RS256", typ: "JWT" })) +
      "." +
      base64url(JSON.stringify({ iss: credentials.client_email, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600 }));
    const signature = createSign("RSA-SHA256").update(unsigned).sign(credentials.private_key).toString("base64url");
    const res = await fetchImpl(tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature}`,
      }),
    });
    if (!res.ok) throw new Error(`Google OAuth ${res.status}: ${await res.text()}`);
    const data = await res.json();
    cached = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
    return cached.token;
  }

  return {
    enabled: true,
    /** `wav` è un file WAV completo (intestazione + campioni). Restituisce il testo, anche vuoto. */
    async transcribe(wav) {
      const res = await fetchImpl(recognizeUrl(credentials.project_id, location), {
        method: "POST",
        headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          config: { autoDecodingConfig: {}, languageCodes: [languageCode], model: "long" },
          content: wav.toString("base64"),
        }),
      });
      if (!res.ok) throw new Error(`Google STT ${res.status}: ${await res.text()}`);
      const data = await res.json();
      return (data.results ?? [])
        .map((result) => result.alternatives?.[0]?.transcript ?? "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    },
  };
}
