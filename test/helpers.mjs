export const RATE = 16000;

/** Segnale di prova: tratti di tono (voce finta) e di silenzio, in millisecondi. */
export function synth(parts, rate = RATE) {
  const total = parts.reduce((sum, part) => sum + Math.round((part.ms / 1000) * rate), 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const part of parts) {
    const length = Math.round((part.ms / 1000) * rate);
    for (let i = 0; i < length; i++) {
      const noise = (Math.random() - 0.5) * 0.002;
      const tone = part.hz ? Math.sin((2 * Math.PI * part.hz * i) / rate) * (part.amp ?? 0.3) : 0;
      out[offset + i] = Math.round((tone + noise) * 32767);
    }
    offset += length;
  }
  return out;
}
