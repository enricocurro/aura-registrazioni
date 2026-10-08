/**
 * Cattura il microfono campione per campione e lo passa alla pagina a blocchi.
 * Nessuna elaborazione qui: l'audio deve arrivare al server così com'è.
 */
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.filled = 0;
    this.port.onmessage = (event) => {
      if (event.data === "flush" && this.filled > 0) {
        this.port.postMessage(this.buffer.slice(0, this.filled));
        this.filled = 0;
      }
    };
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.buffer[this.filled++] = channel[i];
        if (this.filled === this.buffer.length) {
          this.port.postMessage(this.buffer.slice());
          this.filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("recorder", RecorderProcessor);
