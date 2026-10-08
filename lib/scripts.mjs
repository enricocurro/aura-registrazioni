/**
 * Copioni da recitare.
 *
 * Due fonti: una raccolta fissa (`copioni.json`, modificabile a mano) e la generazione di una
 * conversazione nuova a ogni richiesta, via OpenRouter. Senza chiave, o se la generazione
 * fallisce, si pesca dalla raccolta.
 *
 * I copioni non portano etichette (aggressivo/assertivo/neutro): quelle le dà chi valuta,
 * ascoltando. Portano solo un'indicazione di tono per chi recita.
 */
import { randomBytes, randomInt } from "node:crypto";
import { readFile } from "node:fs/promises";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Spunti combinati a caso, così due richieste di fila non producono la stessa scena. */
const AMBITI = [
  "coppia", "genitore e figlio adolescente", "genitori e bambino piccolo", "fratelli adulti",
  "colleghi di lavoro", "responsabile e collaboratore", "allenatore e atleta", "insegnante e genitore",
  "amici", "coinquilini", "vicini di casa", "nonni e genitori", "cliente e negoziante", "medico e familiare di un paziente",
];
const SPUNTI = [
  "un ritardo che ha fatto saltare un programma", "una spesa non concordata", "un compito non svolto",
  "una promessa dimenticata", "un prestito non restituito", "una critica fatta davanti ad altri",
  "la divisione dei lavori di casa", "un errore che è costato caro", "una decisione presa senza consultare l'altro",
  "l'uso del telefono a tavola", "una vacanza da organizzare", "un rumore che disturba", "un invito rifiutato",
  "un oggetto rotto o perso", "orari che non coincidono", "un regalo non gradito", "una richiesta di aiuto all'ultimo minuto",
  "un merito non riconosciuto", "una regola che uno dei due non rispetta", "una confidenza riferita a terzi",
];

const SYSTEM_PROMPT = `Scrivi brevi dialoghi in italiano parlato, da far recitare ad alta voce a persone comuni per una ricerca sulla comunicazione.

Regole:
- 2 o 3 personaggi con nomi italiani comuni; 11-15 battute in tutto, in ordine cronologico.
- Linguaggio quotidiano e realistico, frasi come si dicono davvero a voce. Niente didascalie dentro il testo, niente parentesi.
- Il dialogo deve contenere, mescolati in modo naturale: momenti ostili (accuse, sarcasmo, risposte secche o di chiusura, rimproveri, svalutazioni), momenti in cui qualcuno resta fermo ma aperto (riconosce l'altro, esprime un bisogno, propone una soluzione, si scusa) e battute semplicemente neutre (informazioni, conferme).
- Almeno un personaggio cambia atteggiamento nel corso della scena. Non tutte le scene finiscono bene.
- Battute di lunghezza varia: alcune di una o due parole, altre di due frasi. Mai più di 35 parole.
- Niente nomi di persone reali, marchi, riferimenti politici o religiosi, volgarità pesanti.
- Per ogni battuta dai un'indicazione di tono per l'attore (2-5 parole, es. "spazientita", "calmo, fermo"). L'indicazione NON deve usare le parole aggressivo, assertivo, passivo, neutro.

Rispondi SOLO con un JSON:
{"titolo": "<3-5 parole>", "contesto": "<una frase che spiega chi sono e dove sono>", "battute": [{"nome": "...", "testo": "...", "tono": "..."}]}`;

function clean(value, max) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** Normalizza un copione e lo rifiuta se non è recitabile. */
export function validateScript(raw) {
  const battute = (Array.isArray(raw?.battute) ? raw.battute : [])
    .map((line) => ({ nome: clean(line?.nome, 40), testo: clean(line?.testo, 400), tono: clean(line?.tono, 80) }))
    .filter((line) => line.nome && line.testo);
  const titolo = clean(raw?.titolo, 80);
  if (!titolo || battute.length < 6 || battute.length > 30) return null;
  if (new Set(battute.map((line) => line.nome)).size < 2) return null;
  return { titolo, contesto: clean(raw?.contesto, 300), battute };
}

export async function createScripts({ libraryPath, apiKey, model = "openai/gpt-4.1", fetchImpl = fetch }) {
  const library = JSON.parse(await readFile(libraryPath, "utf8"))
    .map((raw) => {
      const script = validateScript(raw);
      return script && typeof raw.id === "string" ? { id: raw.id, origine: "raccolta", ...script } : null;
    })
    .filter(Boolean);
  if (library.length === 0) throw new Error(`${libraryPath}: nessun copione valido`);

  /** Ultimi copioni di raccolta serviti: si evita di riproporre subito gli stessi. */
  const recent = [];

  function fromLibrary(id) {
    if (id) return library.find((script) => script.id === id) ?? null;
    const fresh = library.filter((script) => !recent.includes(script.id));
    const pool = fresh.length ? fresh : library;
    const pick = pool[randomInt(pool.length)];
    recent.push(pick.id);
    if (recent.length > Math.max(1, library.length - 1)) recent.shift();
    return pick;
  }

  async function generate() {
    const ambito = AMBITI[randomInt(AMBITI.length)];
    const spunto = SPUNTI[randomInt(SPUNTI.length)];
    const res = await fetchImpl(OPENROUTER_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Ambito: ${ambito}. Spunto: ${spunto}. Scena numero ${randomInt(100000)}.` },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const script = validateScript(JSON.parse(data.choices?.[0]?.message?.content ?? "{}"));
    if (!script) throw new Error("copione generato non valido");
    return { id: `gen-${randomBytes(5).toString("hex")}`, origine: "generato", ...script };
  }

  return {
    canGenerate: Boolean(apiKey),
    list: () => library.map(({ id, titolo, contesto, battute }) => ({ id, titolo, contesto, battute: battute.length })),
    fromLibrary,
    /** Una conversazione nuova; se non si può generare, una della raccolta. */
    async fresh() {
      if (apiKey) {
        try {
          return await generate();
        } catch (error) {
          console.warn(`[copioni] generazione fallita, uso la raccolta: ${error.message}`);
        }
      }
      return fromLibrary(null);
    },
  };
}
