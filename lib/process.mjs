/**
 * Chiusura di una registrazione: dai campioni grezzi alla scheda pronta da valutare.
 *
 *   1. audio completo in WAV;
 *   2. volume e intonazione ogni 20 ms (salvati per intero in `<id>.analysis.json`);
 *   3. divisione in battute — dai passaggi di battuta segnati da chi recita, oppure dal
 *      rilevatore di silenzi per le registrazioni reali;
 *   4. misure di ogni battuta (durata, pause, volume, intonazione);
 *   5. trascrizione di ogni battuta, in secondo piano;
 *   6. analisi di ogni battuta coi prompt di Aura, sul testo trascritto.
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import {
  FRAME_MS,
  chunkFeatures,
  detectSegments,
  frameRms,
  msToSample,
  pitchTrack,
  speechThreshold,
  toInt16,
  wavHeader,
} from "./audio.mjs";
import { CONTEXT_CHUNKS } from "./analysis.mjs";
import { STT_MAX_MS } from "./stt.mjs";

const MIN_CHUNK_MS = 200;
const STT_CONCURRENCY = 3;
const ANALYSIS_CONCURRENCY = 3;
/** Testo di una battuta: quello trascritto (o corretto a mano), altrimenti quello del copione. */
const chunkText = (chunk) => (chunk.transcript || chunk.scriptText || "").trim();
const pause = () => new Promise((resolve) => setImmediate(resolve));

/** Intonazione di tutta la registrazione, a blocchi, lasciando respirare il server fra uno e l'altro. */
async function fullPitchTrack(samples, sampleRate, frames, threshold) {
  const frameSize = Math.round((sampleRate * FRAME_MS) / 1000);
  const out = new Float32Array(frames);
  const block = 500;
  for (let f = 0; f < frames; f += block) {
    const from = f * frameSize;
    const to = Math.min(samples.length, (f + block) * frameSize + Math.round(sampleRate * 0.1));
    const part = pitchTrack(samples, sampleRate, from, to, threshold);
    out.set(part.subarray(0, Math.min(block, part.length, frames - f)), f);
    await pause();
  }
  return out;
}

/** Battute di una recita: ogni passaggio di battuta segnato chiude la riga corrente del copione. */
export function chunksFromMarkers(markers, script, durationMs) {
  const chunks = [];
  let start = 0;
  const ends = (Array.isArray(markers) ? markers : [])
    .map(Number)
    .filter((ms) => Number.isFinite(ms) && ms > 0)
    .slice(0, script.battute.length);
  ends.forEach((raw, index) => {
    const end = Math.min(durationMs, Math.max(start, raw));
    if (end - start >= MIN_CHUNK_MS) {
      const line = script.battute[index];
      chunks.push({ startMs: Math.round(start), endMs: Math.round(end), speaker: line.nome, scriptText: line.testo, scriptTone: line.tono, scriptLine: index + 1 });
    }
    start = end;
  });
  return chunks;
}

export function createProcessor({ store, stt, analyzer, log = console }) {
  async function transcribeChunk(id, wavPath, sampleRate, n) {
    const record = await store.read(id);
    const chunk = record?.chunks.find((c) => c.n === n);
    if (!chunk) return;
    let patch;
    if (chunk.endMs - chunk.startMs > STT_MAX_MS) {
      patch = { sttStatus: "troppo lunga" };
    } else {
      try {
        const wav = await readFile(wavPath);
        const from = 44 + msToSample(chunk.startMs, sampleRate) * 2;
        const to = Math.min(wav.length, 44 + msToSample(chunk.endMs, sampleRate) * 2);
        const pcm = wav.subarray(from, to);
        const text = await stt.transcribe(Buffer.concat([wavHeader(pcm.length, sampleRate), pcm]));
        patch = { sttStatus: "ok", sttText: text };
      } catch (error) {
        log.warn(`[stt] ${id}#${n}: ${error.message}`);
        patch = { sttStatus: "errore" };
      }
    }
    await store.update(id, (current) => {
      const target = current.chunks.find((c) => c.n === n);
      if (!target) return false;
      Object.assign(target, patch);
      // Il testo corretto a mano non viene mai sovrascritto da una nuova trascrizione.
      if (patch.sttText != null && !target.transcriptEdited) target.transcript = patch.sttText;
    });
  }

  async function transcribeAll(id) {
    const record = await store.read(id);
    if (!record || !stt.enabled) return;
    const pending = record.chunks.map((c) => c.n);
    await store.update(id, (current) => {
      for (const chunk of current.chunks) chunk.sttStatus = "in corso";
    });
    const wavPath = store.path(id, "wav");
    const workers = Array.from({ length: STT_CONCURRENCY }, async () => {
      while (pending.length) await transcribeChunk(id, wavPath, record.sampleRate, pending.shift());
    });
    await Promise.all(workers);
  }

  async function analyzeChunk(id, n) {
    const record = await store.read(id);
    const index = record?.chunks.findIndex((c) => c.n === n) ?? -1;
    if (index < 0) return;
    const target = chunkText(record.chunks[index]);
    const contesto = record.chunks.slice(Math.max(0, index - CONTEXT_CHUNKS), index).map(chunkText).filter(Boolean);
    let patch;
    if (!target) {
      patch = { analysisStatus: "senza testo", analysis: null };
    } else {
      try {
        const result = await analyzer.classify({ contesto, target });
        patch = { analysisStatus: "ok", analysis: { ...result, testo: target, contesto, modello: analyzer.model, at: new Date().toISOString() } };
      } catch (error) {
        log.warn(`[analisi] ${id}#${n}: ${error.message}`);
        patch = { analysisStatus: "errore", analysis: null };
      }
    }
    await store.update(id, (current) => {
      const chunk = current.chunks.find((c) => c.n === n);
      // Se nel frattempo il testo è stato corretto, vale l'analisi partita dopo la correzione.
      if (!chunk || chunkText(chunk) !== target) return false;
      Object.assign(chunk, patch);
    });
  }

  /**
   * Battute senza un esito valido: mai analizzate, fallite, oppure analizzate su un testo o un
   * contesto che nel frattempo è cambiato. Le altre non si rianalizzano: ogni analisi costa.
   */
  function toAnalyze(record) {
    return record.chunks
      .filter((chunk, index) => {
        const target = chunkText(chunk);
        if (!target) return chunk.analysisStatus !== "senza testo";
        if (chunk.analysisStatus !== "ok" || !chunk.analysis) return true;
        const contesto = record.chunks.slice(Math.max(0, index - CONTEXT_CHUNKS), index).map(chunkText).filter(Boolean);
        return chunk.analysis.testo !== target || JSON.stringify(chunk.analysis.contesto) !== JSON.stringify(contesto);
      })
      .map((chunk) => chunk.n);
  }

  /** Analizza le battute indicate (tutte, se `only` manca). Il contesto sono le due battute precedenti. */
  async function analyze(id, only) {
    const record = await store.read(id);
    if (!record || !analyzer.enabled) return;
    const pending = record.chunks.map((c) => c.n).filter((n) => !only || only.includes(n));
    await store.update(id, (current) => {
      for (const chunk of current.chunks) if (pending.includes(chunk.n)) chunk.analysisStatus = "in corso";
    });
    const workers = Array.from({ length: ANALYSIS_CONCURRENCY }, async () => {
      while (pending.length) await analyzeChunk(id, pending.shift());
    });
    await Promise.all(workers);
  }

  async function finalize(id, { markers }) {
    const record = await store.read(id);
    if (!record) throw new Error("registrazione inesistente");
    const pcm = await readFile(store.path(id, "pcm"));
    const usable = pcm.subarray(0, pcm.length - (pcm.length % 2));
    const { sampleRate } = record;
    await writeFile(store.path(id, "wav"), Buffer.concat([wavHeader(usable.length, sampleRate), usable]));

    const samples = toInt16(usable);
    const durationMs = Math.round((samples.length / sampleRate) * 1000);
    const rms = frameRms(samples, sampleRate);
    const threshold = speechThreshold(rms);
    const pitch = await fullPitchTrack(samples, sampleRate, rms.length, threshold);

    const bounds =
      record.mode === "recitata" && record.script
        ? chunksFromMarkers(markers, record.script, durationMs)
        : detectSegments(rms, threshold).map((segment) => ({ ...segment, speaker: "", scriptText: null, scriptTone: null, scriptLine: null }));

    let previousSpeechEndMs = null;
    const chunks = bounds.map((bound, index) => {
      const features = chunkFeatures({ rms, pitch, threshold, startMs: bound.startMs, endMs: bound.endMs, previousSpeechEndMs });
      if (features.speechMs > 0) previousSpeechEndMs = features.speechEndMs;
      return {
        n: index + 1,
        ...bound,
        transcript: "",
        transcriptEdited: false,
        sttText: null,
        sttStatus: stt.enabled ? "in attesa" : "non configurata",
        annotazione: null,
        nota: "",
        analysisStatus: analyzer.enabled ? "in attesa" : "non configurata",
        analysis: null,
        features,
      };
    });

    await store.writeJson(store.path(id, "analysis.json"), {
      frameMs: FRAME_MS,
      sampleRate,
      soglia_parlato_rms: Number(threshold.toFixed(5)),
      volume_rms: Array.from(rms, (v) => Number(v.toFixed(4))),
      intonazione_hz: Array.from(pitch, (v) => Math.round(v)),
    });
    await store.update(id, (current) => {
      current.status = "pronta";
      current.durationMs = durationMs;
      current.chunks = chunks;
    });
    await rm(store.path(id, "pcm"), { force: true });
  }

  return {
    /** Avvia la chiusura senza far aspettare chi ha registrato; l'esito finisce nella scheda. */
    start(id, options) {
      return finalize(id, options)
        .then(() => transcribeAll(id))
        .then(() => analyze(id))
        .catch(async (error) => {
          log.error(`[chiusura] ${id}: ${error.stack ?? error.message}`);
          await store.update(id, (current) => {
            if (current.status !== "pronta") {
              current.status = "errore";
              current.error = error.message;
            }
          });
        });
    },
    transcribeAll,
    analyze,
    toAnalyze,
  };
}
