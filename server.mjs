#!/usr/bin/env node
/**
 * Aura Registrazioni — raccolta e valutazione di conversazioni registrate.
 *
 * Servizio autonomo, separato dall'app Aura: nessuna dipendenza npm, un solo processo Node,
 * dati su file in DATA_DIR. Configurazione da variabili d'ambiente (v. `.env.example`).
 */
import { randomBytes } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { speechRate } from "./lib/audio.mjs";
import { COOKIE, createAuth, parseCookies } from "./lib/auth.mjs";
import { createProcessor } from "./lib/process.mjs";
import { createScripts, validateScript } from "./lib/scripts.mjs";
import { createStore, isValidId } from "./lib/store.mjs";
import { createStt } from "./lib/stt.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const TAGS = new Set(["AGGRESSIVO", "ASSERTIVO", "NEUTRO"]);
const TAG_LABEL = { AGGRESSIVO: "Aggressivo", ASSERTIVO: "Assertivo", NEUTRO: "Neutro" };
const SAMPLE_RATES = { min: 8000, max: 48000 };
const MAX_PART_BYTES = 8 * 1024 * 1024;
const MAX_JSON_BYTES = 256 * 1024;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function readConfig(env = process.env) {
  const missing = ["USER_PASSWORD", "ADMIN_PASSWORD"].filter((name) => !env[name]);
  if (missing.length) throw new Error(`Variabili mancanti: ${missing.join(", ")} (v. .env.example)`);
  if (env.USER_PASSWORD === env.ADMIN_PASSWORD) throw new Error("USER_PASSWORD e ADMIN_PASSWORD devono essere diverse");
  // Le credenziali Google si possono dare inline oppure come file JSON caricato sul server
  // (più comodo dove il pannello di hosting rovina virgolette e ritorni a capo).
  let sttCredentials = env.GOOGLE_STT_CREDENTIALS_JSON || null;
  if (!sttCredentials && env.GOOGLE_STT_CREDENTIALS_FILE) {
    const path = isAbsolute(env.GOOGLE_STT_CREDENTIALS_FILE) ? env.GOOGLE_STT_CREDENTIALS_FILE : join(ROOT, env.GOOGLE_STT_CREDENTIALS_FILE);
    try {
      sttCredentials = readFileSync(path, "utf8");
    } catch {
      throw new Error(`GOOGLE_STT_CREDENTIALS_FILE: non riesco a leggere ${path}`);
    }
  }
  // Un percorso relativo parte dalla cartella dell'applicazione, non da dove viene lanciata.
  const dataDir = env.DATA_DIR ? (isAbsolute(env.DATA_DIR) ? env.DATA_DIR : join(ROOT, env.DATA_DIR)) : join(ROOT, "data");
  return {
    port: Number(env.PORT ?? 3000),
    dataDir,
    secret: env.SESSION_SECRET || null,
    users: [
      { role: "user", username: env.USER_USERNAME ?? "user", password: env.USER_PASSWORD },
      { role: "admin", username: env.ADMIN_USERNAME ?? "admin", password: env.ADMIN_PASSWORD },
    ],
    trustProxy: env.TRUST_PROXY === "1",
    cookieSecure: env.COOKIE_SECURE === "1",
    maxMinutes: Number(env.MAX_MINUTES ?? 30),
    openrouterKey: env.OPENROUTER_API_KEY || null,
    openrouterModel: env.OPENROUTER_MODEL || "openai/gpt-4.1",
    sttCredentials,
    sttLocation: env.GOOGLE_STT_LOCATION || "eu",
  };
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return /[",\n\r;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const seconds = (ms) => (ms == null ? "" : (ms / 1000).toFixed(2));

/** Scheda come la vede l'admin: senza dati di sessione, con la velocità di eloquio calcolata. */
function adminView(record) {
  const { owner, ...rest } = record;
  return {
    ...rest,
    chunks: (record.chunks ?? []).map((chunk) => ({
      ...chunk,
      features: { ...chunk.features, wordsPerSecond: speechRate(chunk.transcript || chunk.scriptText, chunk.features?.speechMs) },
    })),
  };
}

function summary(record) {
  const chunks = record.chunks ?? [];
  // Una registrazione rimasta "in registrazione" da più di 10 minuti senza nuovi dati è stata abbandonata.
  const stale = record.status === "in registrazione" && Date.now() - Date.parse(record.updatedAt ?? record.createdAt) > 10 * 60 * 1000;
  return {
    id: record.id,
    createdAt: record.createdAt,
    mode: record.mode,
    status: stale ? "interrotta" : record.status,
    titolo: record.script?.titolo ?? null,
    durationMs: record.durationMs ?? null,
    battute: chunks.length,
    valutate: chunks.filter((chunk) => chunk.annotazione).length,
    trascrizione: chunks.some((chunk) => chunk.sttStatus === "in attesa" || chunk.sttStatus === "in corso") ? "in corso" : "ferma",
  };
}

const CSV_COLUMNS = [
  "registrazione", "data", "tipo", "dialogo", "riga", "nome", "testo", "annotazione", "nota",
  "testo_copione", "tono_copione", "testo_stt", "inizio_s", "fine_s", "durata_s", "parlato_s", "pausa_prima_s",
  "pause_interne", "pausa_interna_max_s", "parole_al_secondo", "volume_medio_dbfs", "volume_picco_dbfs",
  "intonazione_mediana_hz", "intonazione_bassa_hz", "intonazione_alta_hz", "intonazione_dev_std_hz",
];

function csvRows(record) {
  return adminView(record).chunks.map((chunk) => {
    const f = chunk.features ?? {};
    return [
      record.id, record.createdAt, record.mode, record.script?.titolo ?? "", chunk.n, chunk.speaker,
      chunk.transcript || chunk.scriptText || "", chunk.annotazione ? TAG_LABEL[chunk.annotazione] : "", chunk.nota,
      chunk.scriptText ?? "", chunk.scriptTone ?? "", chunk.sttText ?? "", seconds(chunk.startMs), seconds(chunk.endMs),
      seconds(f.durationMs), seconds(f.speechMs), seconds(f.pauseBeforeMs), f.internalPauses ?? "", seconds(f.longestInternalPauseMs),
      f.wordsPerSecond ?? "", f.volumeDbfsMean ?? "", f.volumeDbfsPeak ?? "", f.pitchMedianHz ?? "", f.pitchLowHz ?? "",
      f.pitchHighHz ?? "", f.pitchStdHz ?? "",
    ];
  });
}

function toCsv(records) {
  const lines = [CSV_COLUMNS, ...records.flatMap(csvRows)].map((row) => row.map(csvCell).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n";
}

export async function createApp(config, { log = console, fetchImpl = fetch } = {}) {
  const store = createStore(config.dataDir);
  await store.init();
  const auth = createAuth({ secret: config.secret ?? randomBytes(32).toString("hex"), users: config.users });
  if (!config.secret) log.warn("[avvio] SESSION_SECRET non impostato: le sessioni si azzerano a ogni riavvio.");
  const stt = createStt({ credentialsJson: config.sttCredentials, location: config.sttLocation, fetchImpl });
  const scripts = await createScripts({
    libraryPath: join(ROOT, "copioni.json"),
    apiKey: config.openrouterKey,
    model: config.openrouterModel,
    fetchImpl,
  });
  const processor = createProcessor({ store, stt, log });
  const maxBytesPerRecording = (rate) => config.maxMinutes * 60 * rate * 2;

  function send(res, status, body, headers = {}) {
    const payload = body == null ? "" : typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": typeof body === "object" && !Buffer.isBuffer(body) ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    });
    res.end(payload);
  }

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers["content-length"] ?? 0);
      if (declared > limit) {
        req.resume();
        reject(new HttpError(413, "Contenuto troppo grande"));
        return;
      }
      const parts = [];
      let size = 0;
      req.on("data", (part) => {
        size += part.length;
        if (size > limit) {
          reject(new HttpError(413, "Contenuto troppo grande"));
          req.destroy();
          return;
        }
        parts.push(part);
      });
      req.on("end", () => resolve(Buffer.concat(parts)));
      req.on("error", reject);
    });
  }

  async function readJson(req) {
    const body = await readBody(req, MAX_JSON_BYTES);
    if (body.length === 0) return {};
    try {
      const value = JSON.parse(body.toString("utf8"));
      return value && typeof value === "object" ? value : {};
    } catch {
      throw new HttpError(400, "JSON non valido");
    }
  }

  const isHttps = (req) => (config.trustProxy ? req.headers["x-forwarded-proto"] === "https" : Boolean(req.socket.encrypted));
  const clientIp = (req) =>
    (config.trustProxy && String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim()) || req.socket.remoteAddress || "?";

  function sessionCookie(req, value, maxAge) {
    const secure = config.cookieSecure || isHttps(req);
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
  }

  async function serveStatic(req, res, pathname) {
    const relative = pathname === "/" ? "index.html" : normalize(pathname).replace(/^[/\\]+/, "");
    const path = join(PUBLIC_DIR, relative);
    const type = TYPES[extname(path)];
    if (!path.startsWith(PUBLIC_DIR) || !type) throw new HttpError(404, "Non trovato");
    let content;
    try {
      content = await readFile(path);
    } catch {
      throw new HttpError(404, "Non trovato");
    }
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": extname(path) === ".ttf" ? "public, max-age=604800" : "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : content);
  }

  /** Audio completo, con supporto ai Range: serve per spostarsi nel player e ascoltare una battuta. */
  async function serveAudio(req, res, id) {
    const path = store.path(id, "wav");
    let size;
    try {
      size = (await stat(path)).size;
    } catch {
      throw new HttpError(404, "Audio non disponibile");
    }
    const headers = { "Content-Type": "audio/wav", "Accept-Ranges": "bytes", "Cache-Control": "private, no-store" };
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (!match || (match[1] === "" && match[2] === "")) {
      res.writeHead(200, { ...headers, "Content-Length": size });
      createReadStream(path).pipe(res);
      return;
    }
    let start = match[1] === "" ? Math.max(0, size - Number(match[2])) : Number(match[1]);
    let end = match[1] === "" || match[2] === "" ? size - 1 : Math.min(size - 1, Number(match[2]));
    if (start >= size || start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
    createReadStream(path, { start, end }).pipe(res);
  }

  async function requireRecord(id) {
    if (!isValidId(id)) throw new HttpError(404, "Registrazione inesistente");
    const record = await store.read(id);
    if (!record) throw new HttpError(404, "Registrazione inesistente");
    return record;
  }

  /** Registrazione in corso, della sessione che la sta facendo. */
  async function requireOwn(id, session) {
    const record = await requireRecord(id);
    if (record.owner !== session.sid) throw new HttpError(403, "Non è la tua registrazione");
    if (record.status !== "in registrazione") throw new HttpError(409, "Registrazione già chiusa");
    return record;
  }

  function parseMarkers(value) {
    return String(value ?? "")
      .split(",")
      .map(Number)
      .filter((ms) => Number.isFinite(ms) && ms > 0)
      .slice(0, 60);
  }

  async function api(req, res, url, session) {
    const { pathname } = url;
    const method = req.method;
    const seg = pathname.split("/").filter(Boolean).slice(1); // senza "api"

    // Le richieste che modificano qualcosa devono arrivare dalla pagina stessa.
    if (method !== "GET" && req.headers["x-requested-with"] !== "aura-registrazioni") {
      throw new HttpError(403, "Richiesta non valida");
    }

    if (seg[0] === "login" && method === "POST") {
      const body = await readJson(req);
      const role = auth.login(clientIp(req), body.username, body.password);
      if (role === "blocked") throw new HttpError(429, "Troppi tentativi: riprova fra qualche minuto");
      if (!role) throw new HttpError(401, "Nome utente o password non corretti");
      return send(res, 200, { role }, { "Set-Cookie": sessionCookie(req, auth.issue(role), auth.maxAgeSeconds) });
    }
    if (seg[0] === "logout" && method === "POST") {
      return send(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(req, "", 0) });
    }

    if (!session) throw new HttpError(401, "Accesso richiesto");

    if (seg[0] === "me" && method === "GET") {
      return send(res, 200, { role: session.role, maxMinutes: config.maxMinutes });
    }

    // ── Copioni ────────────────────────────────────────────────────────────────
    if (seg[0] === "scripts" && seg.length === 1 && method === "GET") {
      return send(res, 200, { canGenerate: scripts.canGenerate, raccolta: scripts.list() });
    }
    if (seg[0] === "scripts" && seg[1] === "new" && method === "POST") {
      const body = await readJson(req);
      const script = body.id ? scripts.fromLibrary(String(body.id)) : await scripts.fresh();
      if (!script) throw new HttpError(404, "Copione inesistente");
      return send(res, 200, script);
    }

    // ── Registrazione (user e admin) ───────────────────────────────────────────
    if (seg[0] === "recordings" && seg.length === 1 && method === "POST") {
      const body = await readJson(req);
      const mode = body.mode === "recitata" ? "recitata" : body.mode === "reale" ? "reale" : null;
      const sampleRate = Number(body.sampleRate);
      if (!mode) throw new HttpError(400, "Tipo di registrazione non valido");
      if (!Number.isInteger(sampleRate) || sampleRate < SAMPLE_RATES.min || sampleRate > SAMPLE_RATES.max) {
        throw new HttpError(400, "Frequenza di campionamento non valida");
      }
      if (body.consent !== true) throw new HttpError(400, "Serve il consenso delle persone registrate");
      let script = null;
      if (mode === "recitata") {
        const valid = validateScript(body.script);
        if (!valid) throw new HttpError(400, "Copione non valido");
        script = { id: String(body.script.id ?? "").slice(0, 40), origine: body.script.origine === "generato" ? "generato" : "raccolta", ...valid };
      }
      const now = new Date().toISOString();
      const record = await store.create({
        id: store.newId(),
        owner: session.sid,
        createdAt: now,
        updatedAt: now,
        mode,
        status: "in registrazione",
        sampleRate,
        nextSeq: 0,
        markers: [],
        consentAt: now,
        script,
        durationMs: null,
        nota: "",
        chunks: [],
      });
      return send(res, 201, { id: record.id });
    }

    if (seg[0] === "recordings" && isValidId(seg[1]) && seg[2] === "audio" && method === "PUT") {
      const record = await requireOwn(seg[1], session);
      const seq = Number(url.searchParams.get("seq"));
      // Un pezzo già ricevuto (ritrasmesso dopo un errore di rete) si conferma senza riscriverlo.
      if (Number.isInteger(seq) && seq < record.nextSeq) {
        req.resume();
        return send(res, 200, { nextSeq: record.nextSeq });
      }
      if (seq !== record.nextSeq) {
        req.resume();
        return send(res, 409, { error: "Pezzo fuori ordine", nextSeq: record.nextSeq });
      }
      const body = await readBody(req, MAX_PART_BYTES);
      if (body.length % 2 !== 0) throw new HttpError(400, "Audio non valido");
      if ((await store.pcmSize(record.id)) + body.length > maxBytesPerRecording(record.sampleRate)) {
        throw new HttpError(413, `Durata massima raggiunta (${config.maxMinutes} minuti)`);
      }
      await store.appendPcm(record.id, body);
      const markers = parseMarkers(req.headers["x-markers"]);
      const updated = await store.update(record.id, (current) => {
        current.nextSeq = seq + 1;
        if (markers.length) current.markers = markers;
      });
      return send(res, 200, { nextSeq: updated.nextSeq });
    }

    if (seg[0] === "recordings" && isValidId(seg[1]) && seg[2] === "finish" && method === "POST") {
      const record = await requireOwn(seg[1], session);
      const body = await readJson(req);
      const markers = Array.isArray(body.markers) ? parseMarkers(body.markers.join(",")) : record.markers;
      if ((await store.pcmSize(record.id)) < record.sampleRate) {
        await store.remove(record.id);
        throw new HttpError(400, "Registrazione troppo breve: non è stata salvata");
      }
      await store.update(record.id, (current) => {
        current.status = "in elaborazione";
        current.markers = markers;
      });
      void processor.start(record.id, { markers });
      return send(res, 202, { ok: true });
    }

    if (seg[0] === "recordings" && isValidId(seg[1]) && seg.length === 2 && method === "DELETE") {
      const record = await requireOwn(seg[1], session);
      await store.remove(record.id);
      return send(res, 200, { ok: true });
    }

    // ── Valutazione (solo admin) ───────────────────────────────────────────────
    if (seg[0] === "admin") {
      if (session.role !== "admin") throw new HttpError(403, "Riservato a chi valuta");
      const id = seg[2];

      if (seg[1] === "recordings" && seg.length === 2 && method === "GET") {
        return send(res, 200, { sttAttiva: stt.enabled, registrazioni: (await store.list()).map(summary) });
      }
      if (seg[1] === "export.csv" && method === "GET") {
        const records = (await store.list()).filter((record) => record.status === "pronta").reverse();
        return send(res, 200, toCsv(records), {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="registrazioni-${new Date().toISOString().slice(0, 10)}.csv"`,
        });
      }
      if (seg[1] !== "recordings" || !isValidId(id)) throw new HttpError(404, "Non trovato");
      const record = await requireRecord(id);

      if (seg.length === 3 && method === "GET") return send(res, 200, { sttAttiva: stt.enabled, ...adminView(record) });
      if (seg.length === 3 && method === "DELETE") {
        await store.remove(id);
        return send(res, 200, { ok: true });
      }
      if (seg.length === 3 && method === "PATCH") {
        const body = await readJson(req);
        const updated = await store.update(id, (current) => {
          if (typeof body.nota === "string") current.nota = body.nota.slice(0, 4000);
        });
        return send(res, 200, { nota: updated.nota });
      }
      if (seg[3] === "audio" && method === "GET") return serveAudio(req, res, id);
      if (seg[3] === "analysis" && method === "GET") {
        try {
          return send(res, 200, await readFile(store.path(id, "analysis.json")), {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition": `attachment; filename="analisi-${id}.json"`,
          });
        } catch {
          throw new HttpError(404, "Analisi non disponibile");
        }
      }
      if (seg[3] === "export.csv" && method === "GET") {
        return send(res, 200, toCsv([record]), {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="registrazione-${id}.csv"`,
        });
      }
      if (seg[3] === "retranscribe" && method === "POST") {
        if (!stt.enabled) throw new HttpError(409, "Trascrizione automatica non configurata");
        if (record.status !== "pronta") throw new HttpError(409, "Registrazione non ancora pronta");
        void processor.transcribeAll(id).catch((error) => log.warn(`[stt] ${id}: ${error.message}`));
        return send(res, 202, { ok: true });
      }
      // Registrazione abbandonata (pagina chiusa senza terminare): si elabora ciò che è arrivato.
      if (seg[3] === "recover" && method === "POST") {
        if (record.status !== "in registrazione" && record.status !== "errore") throw new HttpError(409, "Niente da recuperare");
        if ((await store.pcmSize(id)) < record.sampleRate) throw new HttpError(409, "Audio insufficiente: si può solo eliminare");
        await store.update(id, (current) => {
          current.status = "in elaborazione";
          current.error = undefined;
        });
        void processor.start(id, { markers: record.markers });
        return send(res, 202, { ok: true });
      }
      if (seg[3] === "chunks" && seg[4] && method === "PATCH") {
        const n = Number(seg[4]);
        const body = await readJson(req);
        if (body.annotazione != null && !TAGS.has(body.annotazione)) throw new HttpError(400, "Valutazione non valida");
        let found = null;
        await store.update(id, (current) => {
          const chunk = current.chunks.find((c) => c.n === n);
          if (!chunk) return false;
          if ("annotazione" in body) chunk.annotazione = body.annotazione ?? null;
          if (typeof body.nota === "string") chunk.nota = body.nota.slice(0, 2000);
          if (typeof body.speaker === "string") chunk.speaker = body.speaker.trim().slice(0, 40);
          if (typeof body.transcript === "string") {
            chunk.transcript = body.transcript.slice(0, 2000);
            chunk.transcriptEdited = true;
          }
          found = chunk;
        });
        if (!found) throw new HttpError(404, "Battuta inesistente");
        return send(res, 200, { ok: true });
      }
    }

    throw new HttpError(404, "Non trovato");
  }

  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Permissions-Policy", "microphone=(self), camera=(), geolocation=()");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; media-src 'self' blob:; img-src 'self' data:; style-src 'self'; script-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'",
    );
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname.startsWith("/api/")) {
        const session = auth.verify(parseCookies(req.headers.cookie)[COOKIE]);
        await api(req, res, url, session);
      } else if (req.method === "GET" || req.method === "HEAD") {
        await serveStatic(req, res, url.pathname);
      } else {
        throw new HttpError(405, "Metodo non ammesso");
      }
    } catch (error) {
      if (!(error instanceof HttpError)) log.error(`[errore] ${req.method} ${req.url}: ${error.stack ?? error}`);
      if (!res.headersSent) send(res, error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : "Errore interno" });
      else res.destroy();
    }
  });

  return { server, store, sttEnabled: stt.enabled, canGenerate: scripts.canGenerate };
}

/** Avvia il servizio con la configurazione dell'ambiente. Usato anche da `app.cjs` (Plesk/Passenger). */
export async function start() {
  try {
    const config = readConfig();
    const app = await createApp(config);
    app.server.listen(config.port, () => {
      console.log(`Aura Registrazioni in ascolto sulla porta ${config.port}`);
      console.log(`  dati: ${config.dataDir}`);
      console.log(`  trascrizione automatica: ${app.sttEnabled ? "attiva (Google STT)" : "NON configurata — testo da inserire a mano"}`);
      console.log(`  conversazioni generate: ${app.canGenerate ? "attive (OpenRouter)" : "NON configurate — si usa la raccolta di copioni"}`);
    });
    return app;
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await start();
