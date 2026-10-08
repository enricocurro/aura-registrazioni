import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp, readConfig } from "../server.mjs";
import { synth } from "./helpers.mjs";

const quiet = { warn() {}, error() {}, log() {} };
let app;
let base;
let dataDir;

/** Finto Google/OpenRouter: la trascrizione risponde sempre, la generazione dei copioni no. */
const sttCalls = [];
async function fakeFetch(url, options) {
  const target = String(url);
  if (target.includes("oauth2")) return Response.json({ access_token: "token", expires_in: 3600 });
  if (target.includes("speech.googleapis.com")) {
    sttCalls.push(JSON.parse(options.body));
    return Response.json({ results: [{ alternatives: [{ transcript: `frase ${sttCalls.length}` }] }] });
  }
  return new Response("no", { status: 500 });
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "aura-reg-"));
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const config = readConfig({
    USER_PASSWORD: "utente-prova",
    ADMIN_PASSWORD: "admin-prova",
    SESSION_SECRET: "segreto-di-prova",
    DATA_DIR: dataDir,
    MAX_MINUTES: "1",
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

function client() {
  let cookie = "";
  const call = async (path, { method = "GET", body, raw, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(method === "GET" ? {} : { "X-Requested-With": "aura-registrazioni" }),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body !== undefined && !raw ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return res;
  };
  call.login = async (username, password) => call("/api/login", { method: "POST", body: { username, password } });
  return call;
}

async function waitFor(check, label) {
  for (let i = 0; i < 100; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`tempo scaduto: ${label}`);
}

const pcmBuffer = (samples) => Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);

test("senza accesso non si entra, e le credenziali sbagliate sono rifiutate", async () => {
  const anon = client();
  assert.equal((await anon("/api/me")).status, 401);
  assert.equal((await anon("/api/admin/recordings")).status, 401);
  assert.equal((await anon.login("user", "sbagliata")).status, 401);
  assert.equal((await anon("/api/me")).status, 401);
});

test("le pagine statiche si aprono e non si esce dalla cartella pubblica", async () => {
  const anon = client();
  const home = await anon("/");
  assert.equal(home.status, 200);
  assert.match(home.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal((await anon("/app.js")).status, 200);
  assert.equal((await anon("/..%2Fserver.mjs")).status, 404);
  assert.equal((await anon("/%2e%2e/.env")).status, 404);
});

test("una richiesta che modifica senza l'intestazione della pagina è rifiutata", async () => {
  const res = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin-prova" }),
  });
  assert.equal(res.status, 403);
});

test("registrazione reale: caricamento a pezzi, divisione in battute, trascrizione, valutazione", async () => {
  const user = client();
  assert.equal((await user.login("user", "utente-prova")).status, 200);
  assert.equal((await (await user("/api/me")).json()).role, "user");
  // Chi registra non vede nulla dell'area di valutazione.
  assert.equal((await user("/api/admin/recordings")).status, 403);

  assert.equal((await user("/api/recordings", { method: "POST", body: { mode: "reale", sampleRate: 16000 } })).status, 400, "senza consenso");
  const created = await user("/api/recordings", { method: "POST", body: { mode: "reale", sampleRate: 16000, consent: true } });
  assert.equal(created.status, 201);
  const { id } = await created.json();

  const samples = synth([{ ms: 600 }, { ms: 1500, hz: 190 }, { ms: 1400 }, { ms: 1100, hz: 240 }, { ms: 900 }]);
  const bytes = pcmBuffer(samples);
  const half = Math.floor(bytes.length / 4) * 2;
  const put = (seq, part) => user(`/api/recordings/${id}/audio?seq=${seq}`, { method: "PUT", raw: true, body: part, headers: { "Content-Type": "application/octet-stream" } });
  assert.equal((await put(1, bytes.subarray(0, half))).status, 409, "pezzo fuori ordine");
  assert.equal((await put(0, bytes.subarray(0, half))).status, 200);
  assert.equal((await put(0, bytes.subarray(0, half))).status, 200, "pezzo ritrasmesso: confermato, non riscritto");
  assert.equal((await put(1, bytes.subarray(half))).status, 200);

  // Un'altra sessione non può toccare la registrazione.
  const other = client();
  await other.login("user", "utente-prova");
  assert.equal((await other(`/api/recordings/${id}/finish`, { method: "POST", body: {} })).status, 403);

  assert.equal((await user(`/api/recordings/${id}/finish`, { method: "POST", body: {} })).status, 202);
  assert.equal((await put(2, bytes.subarray(0, 100))).status, 409, "registrazione chiusa");

  const admin = client();
  await admin.login("admin", "admin-prova");
  const record = await waitFor(async () => {
    const data = await (await admin(`/api/admin/recordings/${id}`)).json();
    return data.status === "pronta" && data.chunks.every((chunk) => chunk.sttStatus === "ok") ? data : null;
  }, "elaborazione");

  assert.equal(record.owner, undefined, "i dati di sessione non escono");
  assert.equal(record.durationMs, 5500);
  assert.equal(record.chunks.length, 2);
  assert.ok(Math.abs(record.chunks[0].features.pitchMedianHz - 190) < 8);
  assert.ok(Math.abs(record.chunks[1].features.pitchMedianHz - 240) < 10);
  assert.ok(Math.abs(record.chunks[1].features.pauseBeforeMs - 1400) <= 60);
  assert.match(record.chunks[0].transcript, /^frase \d$/);
  assert.equal(record.chunks[0].features.wordsPerSecond > 0, true);
  assert.equal(sttCalls[0].config.languageCodes[0], "it-IT");
  assert.equal(Buffer.from(sttCalls[0].content, "base64").toString("ascii", 0, 4), "RIFF");

  // Audio: intero e a intervalli.
  const whole = await admin(`/api/admin/recordings/${id}/audio`);
  assert.equal(whole.status, 200);
  assert.equal(Number(whole.headers.get("content-length")), 44 + bytes.length);
  await whole.arrayBuffer();
  const range = await admin(`/api/admin/recordings/${id}/audio`, { headers: { Range: "bytes=44-143" } });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 100);
  assert.equal((await user(`/api/admin/recordings/${id}/audio`)).status, 403);

  // Valutazione, nota e correzione del testo.
  const patch = (n, body) => admin(`/api/admin/recordings/${id}/chunks/${n}`, { method: "PATCH", body });
  assert.equal((await patch(1, { annotazione: "PASSIVO" })).status, 400);
  assert.equal((await patch(1, { annotazione: "AGGRESSIVO", nota: 'Tono secco; "chiusura"', speaker: "Lui" })).status, 200);
  assert.equal((await patch(2, { transcript: "Testo corretto a mano" })).status, 200);
  assert.equal((await patch(9, { annotazione: "NEUTRO" })).status, 404);

  // Una nuova trascrizione non cancella il testo corretto a mano.
  assert.equal((await admin(`/api/admin/recordings/${id}/retranscribe`, { method: "POST" })).status, 202);
  const again = await waitFor(async () => {
    const data = await (await admin(`/api/admin/recordings/${id}`)).json();
    return data.chunks.every((chunk) => chunk.sttStatus === "ok") && sttCalls.length >= 4 ? data : null;
  }, "seconda trascrizione");
  assert.equal(again.chunks[1].transcript, "Testo corretto a mano");
  assert.equal(again.chunks[0].annotazione, "AGGRESSIVO");

  const list = await (await admin("/api/admin/recordings")).json();
  const row = list.registrazioni.find((item) => item.id === id);
  assert.deepEqual([row.battute, row.valutate, row.status], [2, 1, "pronta"]);

  const csv = await (await admin(`/api/admin/recordings/${id}/export.csv`)).text();
  const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^registrazione,data,tipo,dialogo,riga,nome,testo,annotazione,nota,/);
  assert.match(lines[1], /,1,Lui,frase \d,Aggressivo,"Tono secco; ""chiusura""",/);

  const analysis = await (await admin(`/api/admin/recordings/${id}/analysis`)).json();
  assert.equal(analysis.frameMs, 20);
  assert.equal(analysis.volume_rms.length, 275);
  assert.equal(analysis.intonazione_hz.length, 275);

  assert.equal((await admin(`/api/admin/recordings/${id}`, { method: "DELETE" })).status, 200);
  assert.equal((await admin(`/api/admin/recordings/${id}`)).status, 404);
  assert.equal((await admin(`/api/admin/recordings/${id}/audio`)).status, 404);
});

test("registrazione recitata: una battuta per riga del copione, e recupero di una registrazione abbandonata", async () => {
  const user = client();
  await user.login("user", "utente-prova");
  const info = await (await user("/api/scripts")).json();
  assert.ok(info.raccolta.length >= 5);
  assert.equal(info.canGenerate, false);
  const script = await (await user("/api/scripts/new", { method: "POST", body: {} })).json();
  assert.ok(script.battute.length >= 6);
  const another = await (await user("/api/scripts/new", { method: "POST", body: {} })).json();
  assert.notEqual(another.id, script.id, "due richieste di fila danno copioni diversi");

  assert.equal((await user("/api/recordings", { method: "POST", body: { mode: "recitata", sampleRate: 16000, consent: true } })).status, 400, "senza copione");
  const { id } = await (await user("/api/recordings", { method: "POST", body: { mode: "recitata", sampleRate: 16000, consent: true, script } })).json();
  const samples = synth([{ ms: 300 }, { ms: 1200, hz: 200 }, { ms: 500 }, { ms: 1000, hz: 160 }, { ms: 1000 }]);
  // La pagina viene chiusa senza terminare: i passaggi di battuta sono arrivati insieme all'audio.
  const put = await user(`/api/recordings/${id}/audio?seq=0`, {
    method: "PUT",
    raw: true,
    body: pcmBuffer(samples),
    headers: { "Content-Type": "application/octet-stream", "X-Markers": "1800,4000" },
  });
  assert.equal(put.status, 200);

  const admin = client();
  await admin.login("admin", "admin-prova");
  assert.equal((await admin(`/api/admin/recordings/${id}/recover`, { method: "POST" })).status, 202);
  const record = await waitFor(async () => {
    const data = await (await admin(`/api/admin/recordings/${id}`)).json();
    return data.status === "pronta" ? data : null;
  }, "recupero");
  assert.equal(record.chunks.length, 2);
  assert.equal(record.chunks[0].scriptText, script.battute[0].testo);
  assert.equal(record.chunks[0].speaker, script.battute[0].nome);
  assert.deepEqual([record.chunks[1].startMs, record.chunks[1].endMs], [1800, 4000]);
  assert.ok(Math.abs(record.chunks[1].features.pitchMedianHz - 160) < 8);
  await admin(`/api/admin/recordings/${id}`, { method: "DELETE" });
});

test("una registrazione troppo breve non viene salvata, e chi registra può annullare", async () => {
  const user = client();
  await user.login("user", "utente-prova");
  const create = async () => (await (await user("/api/recordings", { method: "POST", body: { mode: "reale", sampleRate: 16000, consent: true } })).json()).id;
  const short = await create();
  assert.equal((await user(`/api/recordings/${short}/finish`, { method: "POST", body: {} })).status, 400);
  const cancelled = await create();
  assert.equal((await user(`/api/recordings/${cancelled}`, { method: "DELETE" })).status, 200);

  // Oltre la durata massima (qui 1 minuto) il server smette di accettare audio.
  const long = await create();
  const minute = Buffer.alloc(16000 * 2 * 31);
  const put = (seq) => user(`/api/recordings/${long}/audio?seq=${seq}`, { method: "PUT", raw: true, body: minute, headers: { "Content-Type": "application/octet-stream" } });
  assert.equal((await put(0)).status, 200);
  assert.equal((await put(1)).status, 413);
  await user(`/api/recordings/${long}`, { method: "DELETE" });

  const admin = client();
  await admin.login("admin", "admin-prova");
  const list = await (await admin("/api/admin/recordings")).json();
  assert.equal(list.registrazioni.length, 0);
});

test("dopo troppi tentativi sbagliati l'accesso si blocca", async () => {
  const anon = client();
  let status = 0;
  for (let i = 0; i < 12; i++) status = (await anon.login("admin", `tentativo-${i}`)).status;
  assert.equal(status, 429);
});
