import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { combineTwoStep } from "../lib/analysis.mjs";
import { createApp, readConfig } from "../server.mjs";
import { synth } from "./helpers.mjs";

const quiet = { warn() {}, error() {}, log() {} };
let app;
let base;
let dataDir;

/**
 * Finto Google e finto OpenRouter: è aggressiva ogni frase che contiene "basta". Le battute si
 * trascrivono in parallelo, quindi il testo dipende dalla durata dell'audio, non dall'ordine.
 */
const llmCalls = [];
async function fakeFetch(url, options) {
  const target = String(url);
  if (target.includes("oauth2")) return Response.json({ access_token: "token", expires_in: 3600 });
  if (target.includes("speech.googleapis.com")) {
    const long = Buffer.from(JSON.parse(options.body).content, "base64").length > 44 + 1.7 * 16000 * 2;
    return Response.json({ results: [{ alternatives: [{ transcript: long ? "Adesso basta" : "Va bene, facciamo così" }] }] });
  }
  if (target.includes("openrouter.ai")) {
    const body = JSON.parse(options.body);
    const [system, user] = body.messages;
    const payload = JSON.parse(user.content);
    const step = system.content.includes("NON_AGGRESSIVO") ? "aggressivo" : "assertivo";
    llmCalls.push({ step, payload, model: body.model, temperature: body.temperature });
    const annotazione =
      step === "aggressivo"
        ? /basta/i.test(payload.TARGET) ? "AGGRESSIVO" : "NON_AGGRESSIVO"
        : /facciamo/i.test(payload.battute[0]) ? "ASSERTIVO" : "NON_ASSERTIVO";
    return Response.json({ choices: [{ message: { content: JSON.stringify({ analisi: { conclusione: `motivo ${step}` }, annotazione }) } }] });
  }
  return new Response("no", { status: 500 });
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "aura-reg-"));
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const config = readConfig({
    USER_PASSWORD: "utente-prova",
    ADMIN_PASSWORD: "admin-prova",
    SESSION_SECRET: "segreto-di-prova",
    DATA_DIR: dataDir,
    OPENROUTER_API_KEY: "chiave-di-prova",
    GOOGLE_STT_CREDENTIALS_JSON: JSON.stringify({
      project_id: "progetto",
      client_email: "sa@progetto.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    }),
  });
  app = await createApp(config, { log: quiet, fetchImpl: fakeFetch });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => app.server.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
});

async function login(username, password) {
  const res = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Requested-With": "aura-registrazioni" },
    body: JSON.stringify({ username, password }),
  });
  const cookie = res.headers.get("set-cookie").split(";")[0];
  return (path, { method = "GET", body, headers = {} } = {}) =>
    fetch(base + path, {
      method,
      headers: { Cookie: cookie, "X-Requested-With": "aura-registrazioni", ...(body && !Buffer.isBuffer(body) ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
}

async function waitFor(check, label) {
  for (let i = 0; i < 100; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`tempo scaduto: ${label}`);
}

test("i due step si combinano come in Aura, e un'annotazione inattesa è un errore", () => {
  assert.equal(combineTwoStep("AGGRESSIVO", null), "AGGRESSIVO");
  assert.equal(combineTwoStep("NON_AGGRESSIVO", "ASSERTIVO"), "ASSERTIVO");
  assert.equal(combineTwoStep("NON_AGGRESSIVO", "NON_ASSERTIVO"), "NEUTRO");
  assert.throws(() => combineTwoStep("NEUTRO", null));
  assert.throws(() => combineTwoStep("NON_AGGRESSIVO", undefined));
});

test("dopo la trascrizione ogni battuta viene analizzata; l'esito lo vede solo chi valuta", async () => {
  const user = await login("user", "utente-prova");
  const created = await user("/api/recordings", { method: "POST", body: { mode: "reale", sampleRate: 16000, consent: true } });
  const { id } = await created.json();
  const samples = synth([{ ms: 600 }, { ms: 2400, hz: 190 }, { ms: 1400 }, { ms: 900, hz: 240 }, { ms: 900 }]);
  const bytes = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  assert.equal((await user(`/api/recordings/${id}/audio?seq=0`, { method: "PUT", body: bytes, headers: { "Content-Type": "application/octet-stream" } })).status, 200);

  // Chi registra riceve solo la conferma: nessun esito, né subito né dopo.
  const finished = await user(`/api/recordings/${id}/finish`, { method: "POST", body: {} });
  assert.equal(finished.status, 202);
  assert.deepEqual(await finished.json(), { ok: true });

  const admin = await login("admin", "admin-prova");
  const detail = async () => (await admin(`/api/admin/recordings/${id}`)).json();
  const record = await waitFor(async () => {
    const data = await detail();
    return data.status === "pronta" && data.chunks.every((chunk) => chunk.analysisStatus === "ok") ? data : null;
  }, "analisi");
  assert.equal((await user(`/api/admin/recordings/${id}`)).status, 403);
  assert.equal(record.analisiAttiva, true);

  const [first, second] = record.chunks;
  assert.equal(first.analysis.esito, "AGGRESSIVO");
  assert.equal(first.analysis.assertivo, null, "frase aggressiva: la seconda chiamata non parte");
  assert.equal(second.analysis.esito, "ASSERTIVO");
  assert.equal(second.analysis.assertivo.analisi.conclusione, "motivo assertivo");
  assert.deepEqual(second.analysis.contesto, ["Adesso basta"]);

  assert.deepEqual(llmCalls.map((call) => call.step).sort(), ["aggressivo", "aggressivo", "assertivo"]);
  assert.deepEqual(llmCalls.find((call) => call.payload.TARGET === "Va bene, facciamo così").payload, { contesto: ["Adesso basta"], TARGET: "Va bene, facciamo così" });
  assert.deepEqual(llmCalls.find((call) => call.step === "assertivo").payload, { battute: ["Va bene, facciamo così"] });
  assert.ok(llmCalls.every((call) => call.model === "openai/gpt-4.1" && call.temperature === 0.2));

  // Correggere il testo fa ripartire l'analisi della battuta.
  assert.equal((await admin(`/api/admin/recordings/${id}/chunks/2`, { method: "PATCH", body: { transcript: "Ok." } })).status, 200);
  const edited = await waitFor(async () => {
    const data = await detail();
    return data.chunks[1].analysisStatus === "ok" && data.chunks[1].analysis.testo === "Ok." ? data : null;
  }, "nuova analisi");
  assert.equal(edited.chunks[1].analysis.esito, "NEUTRO");
  assert.equal(edited.chunks[0].analysis.esito, "AGGRESSIVO");

  // «Completa l'analisi» non rifà le battute che hanno già un esito sul testo attuale.
  const calls = llmCalls.length;
  const upToDate = await admin(`/api/admin/recordings/${id}/reanalyze`, { method: "POST" });
  assert.equal(upToDate.status, 202);
  assert.equal((await upToDate.json()).battute, 0);

  // Una battuta rimasta senza esito viene recuperata, e solo quella.
  await app.store.update(id, (current) => {
    current.chunks[0].analysisStatus = "errore";
    current.chunks[0].analysis = null;
  });
  assert.equal((await (await admin(`/api/admin/recordings/${id}/reanalyze`, { method: "POST" })).json()).battute, 1);
  await waitFor(async () => (await detail()).chunks[0].analysisStatus === "ok", "analisi recuperata");
  assert.equal(llmCalls.length, calls + 1);

  const csv = await (await admin(`/api/admin/recordings/${id}/export.csv`)).text();
  const lines = csv.trim().split("\r\n");
  assert.match(lines[0], /,esito_analisi$/);
  assert.match(lines[1], /,Aggressivo$/);
  assert.match(lines[2], /,Neutro$/);
});
