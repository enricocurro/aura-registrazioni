/**
 * Analisi audio lato server, su PCM 16 bit mono.
 *
 * Tutto ciò che serve a valutare una registrazione nasce qui: i confini delle battute (VAD),
 * il volume, le pause e l'intonazione. L'audio originale resta salvato in WAV, quindi queste
 * misure si possono sempre ricalcolare con altri parametri.
 */

/** Durata di un frame di analisi: volume e intonazione hanno un valore ogni 20 ms. */
export const FRAME_MS = 20;

/** Parametri del rilevatore di parlato. Soglia di base e silenzio di chiusura sono quelli dell'app Aura. */
export const VAD = {
  BASE_THRESHOLD: 0.015,
  MIN_THRESHOLD: 0.006,
  MAX_THRESHOLD: 0.05,
  NOISE_FACTOR: 3,
  SILENCE_MS: 800,
  MIN_SPEECH_MS: 250,
  MAX_SEGMENT_MS: 20000,
  PRE_ROLL_MS: 100,
  POST_ROLL_MS: 160,
};

const PITCH = { MIN_HZ: 65, MAX_HZ: 420, TARGET_RATE: 8000, WINDOW_MS: 40, MIN_CORRELATION: 0.55 };

/** Intestazione WAV (PCM 16 bit mono) per `dataBytes` byte di campioni. */
export function wavHeader(dataBytes, sampleRate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

/** Vista Int16 su un Buffer di PCM little-endian (copia se il buffer non è allineato). */
export function toInt16(buffer) {
  const length = Math.floor(buffer.length / 2);
  if (buffer.byteOffset % 2 === 0) return new Int16Array(buffer.buffer, buffer.byteOffset, length);
  const copy = new Int16Array(length);
  for (let i = 0; i < length; i++) copy[i] = buffer.readInt16LE(i * 2);
  return copy;
}

export function msToSample(ms, sampleRate) {
  return Math.round((ms / 1000) * sampleRate);
}

/** Volume RMS (0..1) di ogni frame da 20 ms. */
export function frameRms(samples, sampleRate) {
  const frameSize = Math.round((sampleRate * FRAME_MS) / 1000);
  const frames = Math.floor(samples.length / frameSize);
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const start = f * frameSize;
    for (let i = start; i < start + frameSize; i++) {
      const v = samples[i] / 32768;
      sum += v * v;
    }
    out[f] = Math.sqrt(sum / frameSize);
  }
  return out;
}

/**
 * Soglia fra silenzio e parlato. Parte da quella dell'app e si adatta al rumore di fondo
 * della registrazione (stimato sul 10% dei frame più silenziosi), così una stanza rumorosa
 * non diventa un'unica battuta e un microfono debole non perde tutto.
 */
export function speechThreshold(rms) {
  if (rms.length === 0) return VAD.BASE_THRESHOLD;
  const sorted = Float32Array.from(rms).sort();
  const floor = sorted[Math.floor(sorted.length * 0.1)];
  const peak = sorted[Math.floor(sorted.length * 0.98)];
  let threshold = Math.max(VAD.BASE_THRESHOLD, floor * VAD.NOISE_FACTOR);
  // Parlato debole (microfono lontano): se anche i frame più forti superano di poco la
  // soglia, la si abbassa restando sopra il rumore di fondo.
  if (peak < threshold * 2) threshold = Math.max(floor * 2, peak / 3);
  return Math.min(VAD.MAX_THRESHOLD, Math.max(VAD.MIN_THRESHOLD, threshold));
}

/**
 * Divide la registrazione in battute: una battuta finisce dopo 800 ms di silenzio. Le
 * battute più lunghe di 20 s vengono spezzate, quelle sotto i 250 ms di parlato scartate
 * (colpi, click).
 */
export function detectSegments(rms, threshold = speechThreshold(rms)) {
  const silenceFrames = Math.round(VAD.SILENCE_MS / FRAME_MS);
  const maxFrames = Math.round(VAD.MAX_SEGMENT_MS / FRAME_MS);
  const minSpeechFrames = Math.round(VAD.MIN_SPEECH_MS / FRAME_MS);
  const pre = Math.round(VAD.PRE_ROLL_MS / FRAME_MS);
  const post = Math.round(VAD.POST_ROLL_MS / FRAME_MS);

  const segments = [];
  let start = -1;
  let lastSpeech = -1;
  let speechCount = 0;
  let previousEnd = 0;

  const close = (endFrame) => {
    if (speechCount >= minSpeechFrames) {
      const from = Math.max(previousEnd, start - pre);
      const to = Math.min(rms.length, endFrame + post);
      segments.push({ startMs: from * FRAME_MS, endMs: to * FRAME_MS });
      previousEnd = to;
    }
    start = -1;
    speechCount = 0;
  };

  for (let f = 0; f < rms.length; f++) {
    const speaking = rms[f] >= threshold;
    if (start < 0) {
      if (speaking) {
        start = f;
        lastSpeech = f;
        speechCount = 1;
      }
      continue;
    }
    if (speaking) {
      lastSpeech = f;
      speechCount++;
    }
    if (f - lastSpeech >= silenceFrames) close(lastSpeech + 1);
    else if (f - start >= maxFrames) close(f);
  }
  if (start >= 0) close(lastSpeech + 1);
  return segments;
}

/** Riduce la frequenza di campionamento di un fattore intero, mediando i campioni. */
function decimate(samples, from, to, factor) {
  const length = Math.floor((to - from) / factor);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    let sum = 0;
    const base = from + i * factor;
    for (let k = 0; k < factor; k++) sum += samples[base + k];
    out[i] = sum / factor / 32768;
  }
  return out;
}

/**
 * Intonazione (frequenza fondamentale, Hz) di ogni frame da 20 ms fra `fromSample` e
 * `toSample`; 0 dove non c'è voce intonata (silenzio, consonanti sorde, rumore).
 * Autocorrelazione normalizzata sul segnale portato a ~8 kHz.
 */
export function pitchTrack(samples, sampleRate, fromSample = 0, toSample = samples.length, threshold = VAD.BASE_THRESHOLD) {
  const factor = Math.max(1, Math.round(sampleRate / PITCH.TARGET_RATE));
  const rate = sampleRate / factor;
  const signal = decimate(samples, fromSample, toSample, factor);
  const hop = Math.round((rate * FRAME_MS) / 1000);
  const window = Math.round((rate * PITCH.WINDOW_MS) / 1000);
  const minLag = Math.floor(rate / PITCH.MAX_HZ);
  const maxLag = Math.ceil(rate / PITCH.MIN_HZ);
  const frames = Math.max(0, Math.floor(signal.length / hop));
  const out = new Float32Array(frames);

  for (let f = 0; f < frames; f++) {
    const start = f * hop;
    if (start + window + maxLag > signal.length) break;
    let energy = 0;
    for (let i = start; i < start + window; i++) energy += signal[i] * signal[i];
    if (Math.sqrt(energy / window) < threshold) continue;

    let bestLag = 0;
    let best = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let cross = 0;
      let shifted = 0;
      for (let i = start; i < start + window; i++) {
        cross += signal[i] * signal[i + lag];
        shifted += signal[i + lag] * signal[i + lag];
      }
      const correlation = cross / Math.sqrt(energy * shifted + 1e-12);
      // Il primo picco abbastanza alto vince: evita di scambiare l'ottava sotto per la nota.
      if (correlation > best + 0.02) {
        best = correlation;
        bestLag = lag;
      }
    }
    if (best >= PITCH.MIN_CORRELATION && bestLag > 0) out[f] = rate / bestLag;
  }
  return out;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))];
}

const round = (value, digits = 1) => (value == null || !Number.isFinite(value) ? null : Number(value.toFixed(digits)));

export function toDbfs(rms) {
  return rms > 0 ? 20 * Math.log10(rms) : -100;
}

/**
 * Misure di una battuta, dai frame di volume e intonazione già calcolati.
 * `pauseBeforeMs` è il silenzio fra la fine della battuta precedente e l'inizio del parlato
 * di questa (comprende quindi l'eventuale silenzio in testa al chunk).
 */
export function chunkFeatures({ rms, pitch, threshold, startMs, endMs, previousSpeechEndMs }) {
  const from = Math.max(0, Math.floor(startMs / FRAME_MS));
  const to = Math.min(rms.length, Math.ceil(endMs / FRAME_MS));
  let sumSquares = 0;
  let peak = 0;
  let speechFrames = 0;
  let firstSpeech = -1;
  let lastSpeech = -1;
  let longestPause = 0;
  let pauseRun = 0;
  let pauses = 0;
  const voiced = [];

  for (let f = from; f < to; f++) {
    const value = rms[f];
    if (value >= threshold) {
      speechFrames++;
      sumSquares += value * value;
      if (value > peak) peak = value;
      if (firstSpeech < 0) firstSpeech = f;
      // Una pausa interna conta se dura almeno 300 ms.
      if (pauseRun * FRAME_MS >= 300 && lastSpeech >= 0) pauses++;
      if (lastSpeech >= 0 && pauseRun > longestPause) longestPause = pauseRun;
      pauseRun = 0;
      lastSpeech = f;
      if (pitch[f] > 0) voiced.push(pitch[f]);
    } else if (firstSpeech >= 0) {
      pauseRun++;
    }
  }

  const speechStartMs = firstSpeech >= 0 ? firstSpeech * FRAME_MS : startMs;
  const speechEndMs = lastSpeech >= 0 ? (lastSpeech + 1) * FRAME_MS : endMs;
  const sorted = voiced.sort((a, b) => a - b);
  const mean = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null;
  const std = sorted.length
    ? Math.sqrt(sorted.reduce((a, b) => a + (b - mean) * (b - mean), 0) / sorted.length)
    : null;
  const rmsMean = speechFrames ? Math.sqrt(sumSquares / speechFrames) : 0;

  return {
    durationMs: Math.round(endMs - startMs),
    speechMs: speechFrames * FRAME_MS,
    speechStartMs,
    speechEndMs,
    pauseBeforeMs: previousSpeechEndMs == null ? null : Math.max(0, Math.round(speechStartMs - previousSpeechEndMs)),
    internalPauses: pauses,
    longestInternalPauseMs: longestPause * FRAME_MS,
    volumeDbfsMean: round(toDbfs(rmsMean)),
    volumeDbfsPeak: round(toDbfs(peak)),
    pitchMedianHz: round(percentile(sorted, 0.5)),
    pitchLowHz: round(percentile(sorted, 0.05)),
    pitchHighHz: round(percentile(sorted, 0.95)),
    pitchStdHz: round(std),
    voicedRatio: speechFrames ? round(sorted.length / speechFrames, 2) : 0,
  };
}

/** Parole al secondo di parlato effettivo: la velocità di eloquio di una battuta. */
export function speechRate(text, speechMs) {
  const words = (text ?? "").trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  if (!words || !speechMs) return null;
  return round(words / (speechMs / 1000), 2);
}
