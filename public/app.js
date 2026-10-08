/**
 * Aura Registrazioni — interfaccia.
 *
 * Una pagina sola, senza librerie. Chi entra come `user` vede solo i due pulsanti per
 * registrare; chi entra come `admin` ha anche "Valuta registrazioni". Dopo ogni
 * registrazione si torna alla pagina iniziale vuota: chi registra non vede mai nulla di
 * ciò che è stato raccolto.
 */

const app = document.getElementById("app");
const TAGS = [
  ["AGGRESSIVO", "Aggressivo"],
  ["ASSERTIVO", "Assertivo"],
  ["NEUTRO", "Neutro"],
];
const UPLOAD_EVERY_MS = 3000;
/** Volume oltre il quale la barra del livello diventa rossa (soglia urla di Aura, RMS 0,06). */
const LOUD_RMS = 0.06;

let session = null;
/** Pulizia della vista corrente (timer, microfono, ascoltatori): chiamata a ogni cambio pagina. */
let cleanup = null;

// ── Utilità ──────────────────────────────────────────────────────────────────

/** Crea un elemento: `el("button", { class: "big", onclick }, "Testo")`. Il testo non è mai HTML. */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value == null || value === false) continue;
    if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "class") node.className = value;
    else if (key === "value") node.value = value;
    else if (key === "checked" || key === "disabled") node[key] = Boolean(value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function show(node, { wide = false } = {}) {
  if (cleanup) {
    try {
      cleanup();
    } catch {
      /* la vista precedente è comunque da buttare */
    }
    cleanup = null;
  }
  app.className = wide ? "wide" : "";
  app.replaceChildren(node);
  window.scrollTo(0, 0);
}

async function api(path, { method = "GET", body, raw, headers = {} } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      "X-Requested-With": "aura-registrazioni",
      ...(body !== undefined && !raw ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* risposta senza corpo */
  }
  if (res.status === 401 && session) {
    session = null;
    viewLogin("La sessione è scaduta: accedi di nuovo.");
    throw new Error("Sessione scaduta");
  }
  if (!res.ok) {
    const error = new Error(data?.error ?? `Errore ${res.status}`);
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function clock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function formatDate(iso) {
  return new Date(iso).toLocaleString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Istante dentro una registrazione, al decimo di secondo: `0:07,2`. */
function stamp(ms) {
  const tenths = Math.round(ms / 100);
  return `${Math.floor(tenths / 600)}:${String(Math.floor((tenths % 600) / 10)).padStart(2, "0")},${tenths % 10}`;
}

const num = (value, digits = 1) => (value == null ? "—" : Number(value).toLocaleString("it-IT", { maximumFractionDigits: digits }));

// ── Cattura del microfono ────────────────────────────────────────────────────

/**
 * Registra il microfono in PCM 16 bit mono e lo invia al server a pezzi mentre si parla.
 * Echo cancellation, riduzione del rumore e controllo automatico del guadagno sono spenti:
 * altererebbero volume e intonazione, che sono proprio ciò che si vuole misurare.
 */
class Recorder {
  constructor() {
    this.capturing = false;
    this.samples = 0;
    this.pending = [];
    this.seq = 0;
    this.id = null;
    this.level = 0;
    this.uploading = Promise.resolve();
    this.failed = null;
    this.getMarkers = () => [];
  }

  async prepare() {
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
      throw new Error("Questo browser non permette di registrare. Usa una versione recente di Chrome, Safari, Edge o Firefox.");
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
    } catch (error) {
      throw new Error(
        error.name === "NotAllowedError"
          ? "Il microfono è bloccato. Consenti l'accesso al microfono per questo sito e riprova."
          : "Non riesco ad accedere al microfono.",
      );
    }
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    // Si prova a registrare direttamente a 16 kHz (file leggeri, più che sufficienti per la
    // voce). Dove il browser non lo consente — Firefox non collega un microfono a un contesto
    // con frequenza diversa — si registra alla frequenza del dispositivo.
    for (const options of [{ sampleRate: 16000 }, undefined]) {
      try {
        this.context = new AudioCtx(options);
        this.source = this.context.createMediaStreamSource(this.stream);
        break;
      } catch (error) {
        this.context?.close().catch(() => {});
        this.context = null;
        if (!options) throw new Error("Non riesco ad avviare la registrazione audio in questo browser.");
      }
    }
    await this.context.resume();
    await this.context.audioWorklet.addModule("/recorder-worklet.js");
    this.sampleRate = Math.round(this.context.sampleRate);
    this.node = new AudioWorkletNode(this.context, "recorder", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    this.node.port.onmessage = (event) => this.onBlock(event.data);
    // Uscita a volume zero: tiene attivo il nodo senza far sentire nulla dagli altoparlanti.
    this.mute = this.context.createGain();
    this.mute.gain.value = 0;
    this.source.connect(this.node);
    this.node.connect(this.mute);
    this.mute.connect(this.context.destination);
  }

  onBlock(block) {
    let sum = 0;
    for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
    this.level = Math.sqrt(sum / block.length);
    if (!this.capturing) return;
    const pcm = new Int16Array(block.length);
    for (let i = 0; i < block.length; i++) {
      const v = Math.max(-1, Math.min(1, block[i]));
      pcm[i] = v < 0 ? v * 32768 : v * 32767;
    }
    this.pending.push(pcm);
    this.samples += pcm.length;
  }

  get positionMs() {
    return (this.samples / this.sampleRate) * 1000;
  }

  start(id) {
    this.id = id;
    this.capturing = true;
    this.timer = setInterval(() => this.flush(), UPLOAD_EVERY_MS);
  }

  /** Mette in coda l'audio raccolto finora; i pezzi partono uno alla volta, in ordine. */
  flush() {
    if (this.pending.length === 0) return;
    const length = this.pending.reduce((total, part) => total + part.length, 0);
    const joined = new Int16Array(length);
    let offset = 0;
    for (const part of this.pending) {
      joined.set(part, offset);
      offset += part.length;
    }
    this.pending = [];
    const seq = this.seq++;
    this.uploading = this.uploading.then(() => this.send(seq, joined));
  }

  async send(seq, pcm) {
    if (this.failed) return;
    for (let attempt = 0; ; attempt++) {
      try {
        await api(`/recordings/${this.id}/audio?seq=${seq}`, {
          method: "PUT",
          raw: true,
          body: pcm.buffer,
          headers: { "Content-Type": "application/octet-stream", "X-Markers": this.getMarkers().map(Math.round).join(",") },
        });
        return;
      } catch (error) {
        // Errori definitivi (durata massima, registrazione chiusa): inutile insistere.
        if ([400, 403, 404, 409, 413].includes(error.status) || attempt >= 7) {
          this.failed = error;
          return;
        }
        await sleep(Math.min(8000, 500 * 2 ** attempt));
      }
    }
  }

  /** Ferma la cattura e aspetta che tutto l'audio sia arrivato al server. */
  async stop() {
    this.node?.port.postMessage("flush");
    await sleep(150);
    this.capturing = false;
    clearInterval(this.timer);
    this.flush();
    await this.uploading;
    if (this.failed) throw this.failed;
  }

  close() {
    this.capturing = false;
    clearInterval(this.timer);
    this.stream?.getTracks().forEach((track) => track.stop());
    this.context?.close().catch(() => {});
  }
}

// ── Accesso ──────────────────────────────────────────────────────────────────

function viewLogin(message) {
  const error = el("div", { class: "notice bad", hidden: !message, role: "alert" }, message ?? "");
  const username = el("input", { type: "text", name: "username", autocomplete: "username", autocapitalize: "none", required: true });
  const password = el("input", { type: "password", name: "password", autocomplete: "current-password", required: true });
  const submit = el("button", { type: "submit", class: "big" }, "Accedi");
  const form = el(
    "form",
    {
      class: "stack card",
      onsubmit: async (event) => {
        event.preventDefault();
        submit.disabled = true;
        try {
          session = await api("/login", { method: "POST", body: { username: username.value.trim(), password: password.value } });
          session = await api("/me");
          viewHome();
        } catch (failure) {
          error.textContent = failure.message;
          error.hidden = false;
          submit.disabled = false;
        }
      },
    },
    el("label", {}, "Nome utente", username),
    el("label", {}, "Password", password),
    error,
    submit,
  );
  show(el("div", { class: "home stack" }, el("h1", {}, "Aura Registrazioni"), el("p", { class: "muted" }, "Accedi per registrare una conversazione."), form));
  username.focus();
}

function viewHome(message) {
  const actions = el(
    "div",
    { class: "actions" },
    el("button", { class: "big", onclick: () => viewConsent("reale") }, "Avvia registrazione reale"),
    el("button", { class: "big secondary", onclick: () => viewScript() }, "Recita una conversazione"),
    session.role === "admin" ? el("button", { class: "big secondary", onclick: () => viewList() }, "Valuta registrazioni") : null,
  );
  show(
    el(
      "div",
      { class: "home" },
      el("h1", {}, "Aura Registrazioni"),
      el("p", { class: "muted" }, "Registra una conversazione vera oppure recitane una seguendo il testo sullo schermo."),
      message ? el("div", { class: "notice good", role: "status" }, message) : null,
      actions,
      el(
        "p",
        { class: "center" },
        el(
          "button",
          {
            class: "link",
            onclick: async () => {
              await api("/logout", { method: "POST" }).catch(() => {});
              session = null;
              viewLogin();
            },
          },
          "Esci",
        ),
      ),
    ),
  );
}

// ── Prima di registrare ──────────────────────────────────────────────────────

function consentBox(mode) {
  const checkbox = el("input", { type: "checkbox" });
  const text =
    mode === "reale"
      ? "Tutte le persone presenti sanno che la conversazione viene registrata e sono d'accordo. Nessuna delle persone registrate è minorenne, oppure c'è il consenso di chi ne ha la responsabilità."
      : "Le persone che recitano sanno di essere registrate e sono d'accordo.";
  return { checkbox, node: el("label", { class: "check" }, checkbox, el("span", {}, text)) };
}

function viewConsent(mode, script = null) {
  const consent = consentBox(mode);
  const error = el("div", { class: "notice bad", hidden: true, role: "alert" });
  const start = el("button", { class: "big", disabled: true }, "Avvia");
  consent.checkbox.addEventListener("change", () => (start.disabled = !consent.checkbox.checked));
  start.addEventListener("click", async () => {
    start.disabled = true;
    start.textContent = "Preparo il microfono…";
    try {
      await beginRecording(mode, script);
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
      start.textContent = "Avvia";
      start.disabled = !consent.checkbox.checked;
    }
  });
  show(
    el(
      "div",
      { class: "stack" },
      el("h1", {}, mode === "reale" ? "Registrazione reale" : script.titolo),
      el(
        "div",
        { class: "card stack" },
        mode === "reale"
          ? [
              el("p", {}, "Appoggia il telefono o il computer vicino a chi parla e conversate normalmente. La registrazione parte dopo un conto alla rovescia e continua finché non premi «Termina»."),
              el("p", { class: "muted" }, `Durata massima: ${session.maxMinutes} minuti. L'audio verrà ascoltato solo da chi valuta le registrazioni, a scopo di ricerca.`),
            ]
          : [
              el("p", {}, "Sullo schermo comparirà una battuta alla volta. Chi ha quella parte la dice ad alta voce, nel modo più naturale possibile, poi si preme «Battuta successiva»."),
              el("p", { class: "muted" }, "Non serve essere precisi parola per parola: conta il tono. L'indicazione in corsivo suggerisce come dirla."),
            ],
        consent.node,
        error,
        start,
        el("button", { class: "secondary", onclick: () => viewHome() }, "Annulla"),
      ),
    ),
  );
}

async function viewScript(requestedId = null) {
  show(el("div", { class: "home center" }, el("p", { class: "muted" }, "Preparo una nuova conversazione…")));
  let script;
  let info;
  try {
    [script, info] = await Promise.all([
      api("/scripts/new", { method: "POST", body: requestedId ? { id: requestedId } : {} }),
      api("/scripts"),
    ]);
  } catch (failure) {
    if (session) show(el("div", { class: "stack" }, el("div", { class: "notice bad" }, failure.message), el("button", { onclick: () => viewHome() }, "Torna all'inizio")));
    return;
  }
  const speakers = [...new Set(script.battute.map((line) => line.nome))];
  const picker = el(
    "select",
    { "aria-label": "Scegli una conversazione dalla raccolta", onchange: (event) => event.target.value && viewScript(event.target.value) },
    el("option", { value: "" }, "Scegli dalla raccolta…"),
    info.raccolta.map((item) => el("option", { value: item.id }, `${item.titolo} (${item.battute} battute)`)),
  );
  show(
    el(
      "div",
      { class: "stack" },
      el("h1", {}, script.titolo),
      el("p", { class: "muted" }, script.contesto),
      el(
        "div",
        { class: "card stack" },
        el("p", {}, el("b", {}, "Personaggi: "), speakers.join(", "), ` · ${script.battute.length} battute`),
        el(
          "div",
          { class: "preview", tabindex: "0", "aria-label": "Anteprima del testo" },
          script.battute.map((line) => el("p", {}, el("b", { class: `who s${speakers.indexOf(line.nome) % 4}` }, `${line.nome}: `), line.testo)),
        ),
        el("button", { class: "big", onclick: () => viewConsent("recitata", script) }, "Recita questa conversazione"),
        el("div", { class: "row" }, el("button", { class: "secondary grow", onclick: () => viewScript() }, "Un'altra conversazione"), el("div", { class: "grow" }, picker)),
        el("button", { class: "link", onclick: () => viewHome() }, "Annulla"),
      ),
    ),
  );
}

// ── Registrazione ────────────────────────────────────────────────────────────

async function beginRecording(mode, script) {
  const recorder = new Recorder();
  try {
    await recorder.prepare();
    const { id } = await api("/recordings", {
      method: "POST",
      body: { mode, sampleRate: recorder.sampleRate, consent: true, script: script ?? undefined },
    });
    await countdown();
    viewRecording({ recorder, id, mode, script });
  } catch (failure) {
    recorder.close();
    throw failure;
  }
}

function countdown() {
  return new Promise((resolve) => {
    const number = el("div", { class: "number", "aria-live": "assertive" }, "3");
    const overlay = el("div", { class: "countdown", role: "alert" }, number, el("div", {}, "La registrazione sta per iniziare"));
    document.body.append(overlay);
    let value = 3;
    const timer = setInterval(() => {
      value--;
      if (value === 0) {
        clearInterval(timer);
        overlay.remove();
        resolve();
      } else {
        number.textContent = String(value);
      }
    }, 1000);
  });
}

function viewRecording({ recorder, id, mode, script }) {
  const markers = [];
  recorder.getMarkers = () => markers;
  let current = 0;
  let finished = false;
  let wakeLock = null;

  const timer = el("div", { class: mode === "reale" ? "timer huge" : "timer" }, "00:00");
  const levelFill = el("div");
  const level = el("div", { class: "level", role: "img", "aria-label": "Livello del microfono" }, levelFill);
  const status = el("div", { class: "notice bad", hidden: true, role: "alert" });
  const speakers = script ? [...new Set(script.battute.map((line) => line.nome))] : [];
  const lineNodes = script
    ? script.battute.map((line) =>
        el(
          "div",
          { class: "line" },
          el("div", { class: `who s${speakers.indexOf(line.nome) % 4}` }, line.nome, line.tono ? el("span", { class: "tone" }, ` — ${line.tono}`) : null),
          el("div", { class: "text" }, line.testo),
        ),
      )
    : [];

  function paintLines() {
    lineNodes.forEach((node, index) => {
      node.classList.toggle("done", index < current);
      node.classList.toggle("current", index === current);
    });
    lineNodes[current]?.scrollIntoView({ block: "center", behavior: "smooth" });
    if (script) next.textContent = current >= script.battute.length - 1 ? "Ultima battuta: termina" : "Battuta successiva";
  }

  async function finish() {
    if (finished) return;
    finished = true;
    next.disabled = true;
    stop.disabled = true;
    cancel.disabled = true;
    stop.textContent = "Salvataggio in corso…";
    try {
      await recorder.stop();
      await api(`/recordings/${id}/finish`, { method: "POST", body: { markers: markers.map(Math.round) } });
      recorder.close();
      viewHome("Registrazione salvata. Grazie!");
    } catch (failure) {
      recorder.close();
      show(
        el(
          "div",
          { class: "stack home" },
          el("div", { class: "notice bad", role: "alert" }, `La registrazione non è stata salvata per intero: ${failure.message}`),
          el("button", { class: "big", onclick: () => viewHome() }, "Torna all'inizio"),
        ),
      );
    }
  }

  function advance() {
    if (finished || !script) return;
    markers.push(recorder.positionMs);
    current++;
    if (current >= script.battute.length) finish();
    else paintLines();
  }

  const next = el("button", { class: "big", onclick: advance }, "Battuta successiva");
  const stop = el("button", { class: script ? "secondary" : "big", onclick: finish }, "Termina registrazione");
  const cancel = el(
    "button",
    {
      class: "link",
      onclick: async () => {
        if (finished || !window.confirm("Annullare la registrazione? L'audio registrato finora verrà eliminato.")) return;
        finished = true;
        recorder.close();
        await api(`/recordings/${id}`, { method: "DELETE" }).catch(() => {});
        viewHome("Registrazione annullata ed eliminata.");
      },
    },
    "Annulla ed elimina",
  );

  const tick = setInterval(() => {
    timer.textContent = clock(recorder.positionMs);
    levelFill.style.width = `${Math.min(100, Math.round(Math.sqrt(recorder.level) * 160))}%`;
    level.classList.toggle("loud", recorder.level >= LOUD_RMS);
    if (recorder.failed && !finished) {
      status.textContent = `Problema di collegamento: ${recorder.failed.message}. La registrazione viene chiusa.`;
      status.hidden = false;
      finish();
    } else if (recorder.positionMs >= session.maxMinutes * 60000 && !finished) {
      finish();
    }
  }, 100);

  const onKey = (event) => {
    if (!script || event.repeat) return;
    if ([" ", "Enter", "ArrowRight", "ArrowDown"].includes(event.key) && !["BUTTON", "A"].includes(event.target.tagName)) {
      event.preventDefault();
      advance();
    }
  };
  const onLeave = (event) => {
    if (!finished) event.preventDefault();
  };
  document.addEventListener("keydown", onKey);
  window.addEventListener("beforeunload", onLeave);
  navigator.wakeLock
    ?.request("screen")
    .then((lock) => (wakeLock = lock))
    .catch(() => {});

  show(
    el(
      "div",
      {},
      el("div", { class: "rec-bar" }, el("span", { class: "rec-dot", "aria-hidden": "true" }), script ? timer : el("b", {}, "In registrazione"), level),
      status,
      script
        ? el("div", { class: "lines" }, lineNodes)
        : el("div", { class: "center home" }, timer, el("p", { class: "muted" }, "Parlate normalmente. Quando avete finito, premi «Termina registrazione».")),
      el("div", { class: "rec-footer" }, script ? next : null, stop, cancel),
    ),
  );
  cleanup = () => {
    clearInterval(tick);
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("beforeunload", onLeave);
    wakeLock?.release().catch(() => {});
    if (!finished) {
      finished = true;
      recorder.close();
    }
  };

  recorder.start(id);
  paintLines();
}

// ── Valutazione: elenco ──────────────────────────────────────────────────────

const STATUS_TONE = { pronta: "good", "in elaborazione": "warn", "in registrazione": "warn", interrotta: "bad", errore: "bad" };

async function viewList() {
  let data;
  try {
    data = await api("/admin/recordings");
  } catch (failure) {
    if (session) show(el("div", { class: "stack" }, el("div", { class: "notice bad" }, failure.message), el("button", { onclick: () => viewHome() }, "Torna all'inizio")));
    return;
  }
  const rows = data.registrazioni.map((item) =>
    el(
      "tr",
      {},
      el("td", {}, formatDate(item.createdAt)),
      el("td", {}, item.mode === "recitata" ? `Recitata — ${item.titolo ?? ""}` : "Reale"),
      el("td", {}, item.durationMs == null ? "—" : clock(item.durationMs)),
      el("td", {}, item.battute ? `${item.valutate} / ${item.battute}` : "—"),
      el(
        "td",
        {},
        el("span", { class: `badge ${STATUS_TONE[item.status] ?? ""}` }, item.status),
        item.status === "pronta" && item.battute > 0 && item.valutate === item.battute ? el("span", { class: "badge good" }, "valutata") : null,
      ),
      el("td", {}, el("button", { class: "secondary", onclick: () => viewDetail(item.id) }, "Apri")),
    ),
  );
  show(
    el(
      "div",
      { class: "stack" },
      el(
        "div",
        { class: "row spread" },
        el("h1", {}, "Valuta registrazioni"),
        el(
          "div",
          { class: "row" },
          el("a", { class: "button secondary", href: "/api/admin/export.csv" }, "Esporta tutto (CSV)"),
          el("button", { class: "secondary", onclick: () => viewList() }, "Aggiorna"),
          el("button", { class: "link", onclick: () => viewHome() }, "Torna all'inizio"),
        ),
      ),
      data.sttAttiva ? null : el("div", { class: "notice warn" }, "La trascrizione automatica non è configurata: il testo delle battute va scritto a mano."),
      rows.length === 0
        ? el("div", { class: "card muted" }, "Non ci sono ancora registrazioni.")
        : el(
            "div",
            { class: "card table-wrap" },
            el(
              "table",
              {},
              el("thead", {}, el("tr", {}, ["Data", "Tipo", "Durata", "Valutate", "Stato", ""].map((label) => el("th", { scope: "col" }, label)))),
              el("tbody", {}, rows),
            ),
          ),
    ),
    { wide: true },
  );
}

// ── Valutazione: una registrazione ───────────────────────────────────────────

async function viewDetail(id) {
  let record;
  try {
    record = await api(`/admin/recordings/${id}`);
  } catch (failure) {
    if (session) show(el("div", { class: "stack" }, el("div", { class: "notice bad" }, failure.message), el("button", { onclick: () => viewList() }, "Torna all'elenco")));
    return;
  }

  const base = `/admin/recordings/${id}`;
  const saved = el("div", { class: "saved", role: "status" });
  let savedTimer = null;
  let stopAt = null;
  let polling = null;
  let disposed = false;

  function flash(text) {
    saved.textContent = text;
    clearTimeout(savedTimer);
    if (text === "Salvato") savedTimer = setTimeout(() => (saved.textContent = ""), 2000);
  }

  async function save(path, body) {
    flash("Salvo…");
    try {
      await api(path, { method: "PATCH", body });
      flash("Salvato");
      return true;
    } catch (failure) {
      flash(`Non salvato: ${failure.message}`);
      return false;
    }
  }

  const header = el(
    "div",
    { class: "row spread" },
    el("h1", {}, record.mode === "recitata" ? `Recitata — ${record.script?.titolo ?? ""}` : "Registrazione reale"),
    el("div", { class: "row" }, saved, el("button", { class: "link", onclick: () => viewList() }, "Torna all'elenco")),
  );
  const meta = el(
    "p",
    { class: "muted" },
    `${formatDate(record.createdAt)} · ${record.durationMs == null ? "durata sconosciuta" : clock(record.durationMs)} · ${record.chunks.length} battute · `,
    el("span", { class: `badge ${STATUS_TONE[record.status] ?? ""}` }, record.status),
  );

  const removeButton = el(
    "button",
    {
      class: "danger",
      onclick: async () => {
        if (!window.confirm("Eliminare definitivamente questa registrazione, con audio e valutazioni?")) return;
        await api(base, { method: "DELETE" });
        viewList();
      },
    },
    "Elimina registrazione",
  );

  if (record.status !== "pronta") {
    const recover =
      record.status === "in elaborazione"
        ? null
        : el(
            "button",
            {
              onclick: async (event) => {
                event.target.disabled = true;
                try {
                  await api(`${base}/recover`, { method: "POST" });
                  viewDetail(id);
                } catch (failure) {
                  window.alert(failure.message);
                  event.target.disabled = false;
                }
              },
            },
            "Elabora l'audio arrivato",
          );
    show(
      el(
        "div",
        { class: "stack" },
        header,
        meta,
        el(
          "div",
          { class: `notice ${record.status === "in elaborazione" ? "" : "warn"}` },
          record.status === "in elaborazione"
            ? "Sto preparando la registrazione: la pagina si aggiorna da sola."
            : record.status === "errore"
              ? `L'elaborazione non è riuscita (${record.error ?? "errore sconosciuto"}).`
              : "La registrazione non è stata chiusa (pagina abbandonata, oppure ancora in corso). Si può elaborare l'audio arrivato fin qui.",
        ),
        el("div", { class: "row" }, recover, removeButton),
      ),
      { wide: true },
    );
    if (record.status === "in elaborazione") {
      const timer = setTimeout(() => viewDetail(id), 2500);
      cleanup = () => clearTimeout(timer);
    }
    return;
  }

  const audio = el("audio", { controls: true, preload: "metadata", src: `/api${base}/audio` });
  const showTone = el("input", { type: "checkbox" });
  const cards = new Map();

  function playChunk(chunk) {
    stopAt = chunk.endMs / 1000;
    audio.currentTime = chunk.startMs / 1000;
    audio.play().catch(() => {});
  }

  function sttBadge(chunk) {
    if (chunk.sttStatus === "ok") return null;
    if (chunk.sttStatus === "non configurata") return null;
    const tone = chunk.sttStatus === "errore" || chunk.sttStatus === "troppo lunga" ? "bad" : "warn";
    return el("span", { class: `badge ${tone}` }, `trascrizione ${chunk.sttStatus}`);
  }

  function featureLine(chunk) {
    const f = chunk.features ?? {};
    const item = (label, value) => el("span", {}, `${label} `, el("b", {}, value));
    return el(
      "div",
      { class: "features" },
      item("Durata", `${num(f.durationMs / 1000)} s`),
      item("Pausa prima", f.pauseBeforeMs == null ? "—" : `${num(f.pauseBeforeMs / 1000)} s`),
      item("Velocità", f.wordsPerSecond == null ? "—" : `${num(f.wordsPerSecond)} parole/s`),
      item("Volume", `${num(f.volumeDbfsMean)} dB (picco ${num(f.volumeDbfsPeak)})`),
      item("Intonazione", f.pitchMedianHz == null ? "—" : `${num(f.pitchMedianHz, 0)} Hz (${num(f.pitchLowHz, 0)}–${num(f.pitchHighHz, 0)})`),
      item("Pause interne", String(f.internalPauses ?? 0)),
    );
  }

  function chunkCard(chunk) {
    const state = { ...chunk };
    const speaker = el("input", { type: "text", class: "speaker", value: chunk.speaker ?? "", placeholder: "Chi parla", "aria-label": "Chi parla", maxlength: "40" });
    const transcript = el("textarea", { rows: "3", value: chunk.transcript ?? "", placeholder: record.sttAttiva ? "" : "Scrivi qui ciò che viene detto" });
    const note = el("textarea", { rows: "3", value: chunk.nota ?? "", placeholder: "Perché questa valutazione, dubbi, osservazioni sul tono…" });
    const badgeSlot = el("span", {}, sttBadge(chunk));
    const tone = chunk.scriptTone ? el("span", { class: "tone muted small", hidden: true }, ` — indicazione data a chi recita: ${chunk.scriptTone}`) : null;
    const node = el("div", { class: `card chunk${chunk.annotazione ? " rated" : ""}` });

    const buttons = TAGS.map(([tag, label]) =>
      el(
        "button",
        {
          type: "button",
          "data-tag": tag,
          "aria-pressed": String(state.annotazione === tag),
          onclick: async () => {
            // Premere di nuovo la scelta attiva la toglie.
            const value = state.annotazione === tag ? null : tag;
            if (await save(`${base}/chunks/${chunk.n}`, { annotazione: value })) {
              state.annotazione = value;
              buttons.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.tag === value)));
              node.classList.toggle("rated", Boolean(value));
              progress();
            }
          },
        },
        label,
      ),
    );

    const bind = (field, key) =>
      field.addEventListener("change", async () => {
        const value = field.value;
        if (await save(`${base}/chunks/${chunk.n}`, { [key]: value })) state[key] = value;
      });
    bind(speaker, "speaker");
    bind(transcript, "transcript");
    bind(note, "nota");

    node.append(
      el(
        "div",
        { class: "head row" },
        el("button", { class: "secondary", onclick: () => playChunk(chunk), "aria-label": `Ascolta la battuta ${chunk.n}` }, "▶ Ascolta"),
        el("b", {}, `#${chunk.n}`),
        el("span", { class: "muted small" }, `${stamp(chunk.startMs)} – ${stamp(chunk.endMs)}`),
        speaker,
        badgeSlot,
      ),
      el(
        "div",
        { class: "stack" },
        chunk.scriptText ? el("div", { class: "script small" }, el("b", {}, "Copione: "), chunk.scriptText, tone) : null,
        el("label", {}, "Trascrizione (si può correggere)", transcript),
      ),
      el("div", { class: "stack" }, el("div", { class: "eval", role: "group", "aria-label": `Valutazione della battuta ${chunk.n}` }, buttons), el("label", {}, "Note", note)),
      featureLine(chunk),
    );
    cards.set(chunk.n, { node, state, transcript, badgeSlot, tone });
    return node;
  }

  const progressText = el("b", {});
  function progress() {
    const rated = [...cards.values()].filter((card) => card.state.annotazione).length;
    progressText.textContent = `${rated} / ${cards.size} valutate`;
  }

  /** Aggiorna trascrizioni e stato arrivati dal server, senza toccare ciò che si sta scrivendo. */
  function mergeFromServer(fresh) {
    for (const chunk of fresh.chunks) {
      const card = cards.get(chunk.n);
      if (!card) continue;
      if (document.activeElement !== card.transcript && card.transcript.value === (card.state.transcript ?? "") && chunk.transcript !== card.state.transcript) {
        card.transcript.value = chunk.transcript ?? "";
        card.state.transcript = chunk.transcript;
      }
      if (chunk.sttStatus !== card.state.sttStatus) {
        card.state.sttStatus = chunk.sttStatus;
        card.badgeSlot.replaceChildren(...[sttBadge(chunk)].filter(Boolean));
      }
    }
  }

  const sttPending = (item) => item.chunks.some((chunk) => chunk.sttStatus === "in attesa" || chunk.sttStatus === "in corso");

  function startPolling() {
    clearInterval(polling);
    polling = setInterval(async () => {
      if (disposed) return;
      try {
        const fresh = await api(base);
        if (disposed) return;
        mergeFromServer(fresh);
        if (!sttPending(fresh)) clearInterval(polling);
      } catch {
        /* si riprova al giro successivo */
      }
    }, 3000);
  }

  audio.addEventListener("timeupdate", () => {
    const time = audio.currentTime;
    if (stopAt != null && time >= stopAt) {
      audio.pause();
      stopAt = null;
    }
    for (const [n, card] of cards) {
      const chunk = record.chunks[n - 1];
      card.node.classList.toggle("playing", !audio.paused && time >= chunk.startMs / 1000 && time < chunk.endMs / 1000);
    }
  });
  // Spostandosi a mano nel player si ascolta liberamente, senza fermarsi a fine battuta.
  audio.addEventListener("seeking", () => {
    if (stopAt != null && (audio.currentTime > stopAt || audio.currentTime < stopAt - 120)) stopAt = null;
  });
  audio.addEventListener("pause", () => cards.forEach((card) => card.node.classList.remove("playing")));

  showTone.addEventListener("change", () => cards.forEach((card) => card.tone && (card.tone.hidden = !showTone.checked)));

  const generalNote = el("textarea", { rows: "2", value: record.nota ?? "", placeholder: "Osservazioni sull'intera conversazione" });
  generalNote.addEventListener("change", () => save(base, { nota: generalNote.value }));

  const retranscribe = record.sttAttiva
    ? el(
        "button",
        {
          class: "secondary",
          onclick: async (event) => {
            event.target.disabled = true;
            try {
              await api(`${base}/retranscribe`, { method: "POST" });
              flash("Trascrizione riavviata");
              startPolling();
            } catch (failure) {
              flash(failure.message);
            }
            setTimeout(() => (event.target.disabled = false), 4000);
          },
        },
        "Trascrivi di nuovo",
      )
    : null;

  const chunkNodes = record.chunks.map(chunkCard);
  progress();

  show(
    el(
      "div",
      { class: "stack" },
      header,
      meta,
      record.sttAttiva ? null : el("div", { class: "notice warn" }, "La trascrizione automatica non è configurata: il testo delle battute va scritto a mano."),
      el("div", { class: "player" }, audio),
      el(
        "div",
        { class: "card stack" },
        el("div", { class: "row spread" }, progressText, el("div", { class: "row" }, retranscribe, el("a", { class: "button secondary", href: `/api${base}/export.csv` }, "Esporta CSV"), el("a", { class: "button secondary", href: `/api${base}/analysis` }, "Scarica analisi audio"))),
        el("label", {}, "Note sulla registrazione", generalNote),
        record.mode === "recitata" ? el("label", { class: "check" }, showTone, el("span", {}, "Mostra l'indicazione di tono data a chi recitava (può influenzare la valutazione)")) : null,
      ),
      record.chunks.length === 0 ? el("div", { class: "notice warn" }, "In questa registrazione non è stato rilevato parlato.") : chunkNodes,
      el("div", { class: "row spread" }, el("button", { class: "secondary", onclick: () => viewList() }, "Torna all'elenco"), removeButton),
    ),
    { wide: true },
  );
  cleanup = () => {
    disposed = true;
    clearInterval(polling);
    clearTimeout(savedTimer);
    audio.pause();
  };
  if (sttPending(record)) startPolling();
}

// ── Avvio ────────────────────────────────────────────────────────────────────

(async () => {
  try {
    const res = await fetch("/api/me", { credentials: "same-origin" });
    if (res.ok) {
      session = await res.json();
      viewHome();
      return;
    }
  } catch {
    /* server non raggiungibile: si mostra comunque l'accesso */
  }
  viewLogin();
})();
