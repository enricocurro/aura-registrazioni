import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FRAME_MS,
  chunkFeatures,
  detectSegments,
  frameRms,
  pitchTrack,
  speechRate,
  speechThreshold,
  toInt16,
  wavHeader,
} from "../lib/audio.mjs";
import { chunksFromMarkers } from "../lib/process.mjs";

import { RATE, synth } from "./helpers.mjs";

test("l'intestazione WAV dichiara formato, frequenza e lunghezza", () => {
  const header = wavHeader(32000, RATE);
  assert.equal(header.length, 44);
  assert.equal(header.toString("ascii", 0, 4), "RIFF");
  assert.equal(header.readUInt32LE(24), RATE);
  assert.equal(header.readUInt16LE(34), 16);
  assert.equal(header.readUInt32LE(40), 32000);
});

test("toInt16 legge i campioni anche da un buffer non allineato", () => {
  const source = Buffer.alloc(7);
  source.writeInt16LE(-1234, 1);
  source.writeInt16LE(4321, 3);
  assert.deepEqual(Array.from(toInt16(source.subarray(1, 5))), [-1234, 4321]);
});

test("il silenzio di 800 ms separa due battute, uno più breve no", () => {
  const samples = synth([
    { ms: 500 },
    { ms: 1200, hz: 180 },
    { ms: 400 }, // pausa breve: stessa battuta
    { ms: 800, hz: 180 },
    { ms: 1500 }, // pausa lunga: battuta nuova
    { ms: 1000, hz: 220 },
    { ms: 700 },
  ]);
  const rms = frameRms(samples, RATE);
  const segments = detectSegments(rms);
  assert.equal(segments.length, 2);
  assert.ok(Math.abs(segments[0].startMs - 400) <= 60, `inizio ${segments[0].startMs}`);
  assert.ok(Math.abs(segments[0].endMs - 3060) <= 80, `fine ${segments[0].endMs}`);
  assert.ok(Math.abs(segments[1].startMs - 4300) <= 60);
});

test("un colpo secco non diventa una battuta", () => {
  const rms = frameRms(synth([{ ms: 1000 }, { ms: 100, hz: 300 }, { ms: 2000 }]), RATE);
  assert.equal(detectSegments(rms).length, 0);
});

test("una battuta oltre i 20 secondi viene spezzata", () => {
  const rms = frameRms(synth([{ ms: 45000, hz: 150 }]), RATE);
  const segments = detectSegments(rms);
  assert.equal(segments.length, 3);
  assert.ok(segments.every((segment) => segment.endMs - segment.startMs <= 20200));
  assert.equal(segments[1].startMs, segments[0].endMs);
});

test("la soglia si alza in una stanza rumorosa", () => {
  const quiet = frameRms(synth([{ ms: 2000 }, { ms: 1000, hz: 200 }]), RATE);
  const noisy = quiet.map((value) => value + 0.02);
  assert.ok(speechThreshold(noisy) > speechThreshold(quiet));
});

test("l'intonazione riconosce la frequenza di un tono, a 16 e a 48 kHz", () => {
  for (const [rate, hz] of [[16000, 200], [48000, 120], [44100, 250]]) {
    const samples = synth([{ ms: 600, hz }], rate);
    const voiced = Array.from(pitchTrack(samples, rate)).filter((value) => value > 0);
    assert.ok(voiced.length > 10, `pochi frame intonati a ${rate}`);
    const median = voiced.sort((a, b) => a - b)[Math.floor(voiced.length / 2)];
    assert.ok(Math.abs(median - hz) / hz < 0.04, `${rate} Hz: atteso ${hz}, trovato ${median}`);
  }
});

test("il silenzio non ha intonazione", () => {
  assert.ok(Array.from(pitchTrack(synth([{ ms: 500 }]), RATE)).every((value) => value === 0));
});

test("le misure di una battuta: pausa prima, pause interne, volume, intonazione", () => {
  const samples = synth([
    { ms: 1000, hz: 200 }, // battuta precedente
    { ms: 1400 },
    { ms: 600, hz: 200, amp: 0.3 },
    { ms: 500 },
    { ms: 600, hz: 200, amp: 0.3 },
    { ms: 300 },
  ]);
  const rms = frameRms(samples, RATE);
  const threshold = speechThreshold(rms);
  const pitch = pitchTrack(samples, RATE, 0, samples.length, threshold);
  const features = chunkFeatures({ rms, pitch, threshold, startMs: 2000, endMs: 4400, previousSpeechEndMs: 1000 });
  assert.equal(features.durationMs, 2400);
  assert.ok(Math.abs(features.pauseBeforeMs - 1400) <= 2 * FRAME_MS, `pausa ${features.pauseBeforeMs}`);
  assert.ok(Math.abs(features.speechMs - 1200) <= 3 * FRAME_MS);
  assert.equal(features.internalPauses, 1);
  assert.ok(Math.abs(features.longestInternalPauseMs - 500) <= 2 * FRAME_MS);
  // Un seno di ampiezza 0,3 ha RMS 0,212 → circa −13,5 dBFS.
  assert.ok(Math.abs(features.volumeDbfsMean - -13.5) < 0.6, `volume ${features.volumeDbfsMean}`);
  assert.ok(Math.abs(features.pitchMedianHz - 200) < 8);
});

test("una battuta di solo silenzio non produce numeri inventati", () => {
  const samples = synth([{ ms: 1000 }]);
  const rms = frameRms(samples, RATE);
  const features = chunkFeatures({ rms, pitch: new Float32Array(rms.length), threshold: 0.015, startMs: 0, endMs: 1000, previousSpeechEndMs: null });
  assert.equal(features.speechMs, 0);
  assert.equal(features.pitchMedianHz, null);
  assert.equal(features.pauseBeforeMs, null);
});

test("la velocità di eloquio conta le parole sul parlato effettivo", () => {
  assert.equal(speechRate("Va bene, domani ne parliamo.", 2000), 2.5);
  assert.equal(speechRate("", 2000), null);
  assert.equal(speechRate("Ciao", 0), null);
});

test("i passaggi di battuta di una recita diventano una battuta per riga del copione", () => {
  const script = { battute: [{ nome: "A", testo: "uno", tono: "" }, { nome: "B", testo: "due", tono: "" }, { nome: "A", testo: "tre", tono: "" }] };
  const chunks = chunksFromMarkers([2000, 2100, 5000, 9000], script, 6000);
  // La seconda riga è durata 100 ms (doppio tocco): viene saltata; il quarto segno è in più.
  assert.deepEqual(
    chunks.map((chunk) => [chunk.startMs, chunk.endMs, chunk.scriptText, chunk.scriptLine]),
    [[0, 2000, "uno", 1], [2100, 5000, "tre", 3]],
  );
});
