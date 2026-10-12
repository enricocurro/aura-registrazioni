/**
 * Analisi delle battute con i prompt di Aura — la cascata a due chiamate del backend
 * (`alarm-pipeline.ts`): prima il prompt aggressivo con `{"contesto": [max 2], "TARGET"}`,
 * poi, solo se la frase non è aggressiva, il prompt assertivo con `{"battute": [TARGET]}`.
 *
 * I due testi in `lib/prompts/` sono la copia esatta dei prompt del committente
 * (`Prompt_aggressivo_BEST.txt`, `Prompt_assertivo_CoT_BEST.txt`): si aggiornano solo
 * ricopiandoli da Aura, mai a mano. Modello e temperatura sono quelli di Aura.
 *
 * Senza `OPENROUTER_API_KEY` l'analisi è spenta e le battute restano senza esito.
 */
import { readFile } from "node:fs/promises";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const TEMPERATURE = 0.2;
const MAX_ATTEMPTS = 2;
/** Battute precedenti passate come contesto, come in Aura. */
export const CONTEXT_CHUNKS = 2;

/**
 * Classe finale dai due step. `step2` è `null` quando lo step 1 ha già deciso AGGRESSIVO.
 * Un'annotazione fuori dai valori attesi è un errore, mai un NEUTRO silenzioso.
 */
export function combineTwoStep(step1, step2) {
  if (step1 === "AGGRESSIVO") return "AGGRESSIVO";
  if (step1 !== "NON_AGGRESSIVO") throw new Error(`step aggressivo: annotazione non valida: ${step1}`);
  if (step2 === "ASSERTIVO") return "ASSERTIVO";
  if (step2 !== "NON_ASSERTIVO") throw new Error(`step assertivo: annotazione non valida: ${step2}`);
  return "NEUTRO";
}

export async function createAnalyzer({ apiKey, model = "openai/gpt-4.1", fetchImpl = fetch }) {
  if (!apiKey) return { enabled: false, model, classify: async () => null };

  const [aggressivo, assertivo] = await Promise.all(
    ["aggressivo", "assertivo"].map((name) => readFile(new URL(`./prompts/${name}.txt`, import.meta.url), "utf8")),
  );

  async function call(system, payload) {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetchImpl(OPENROUTER_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            temperature: TEMPERATURE,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: system },
              { role: "user", content: JSON.stringify(payload) },
            ],
          }),
          signal: AbortSignal.timeout(30000),
        });
        if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const data = await res.json();
        return JSON.parse(data.choices?.[0]?.message?.content ?? "");
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
  }

  return {
    enabled: true,
    model,
    /** Restituisce l'esito e la risposta di ciascuno step (`assertivo` è `null` se non è servito). */
    async classify({ contesto, target }) {
      const first = await call(aggressivo, { contesto, TARGET: target });
      const second = first?.annotazione === "AGGRESSIVO" ? null : await call(assertivo, { battute: [target] });
      return { esito: combineTwoStep(first?.annotazione, second?.annotazione), aggressivo: first, assertivo: second };
    },
  };
}
