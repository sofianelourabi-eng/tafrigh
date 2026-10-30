// Capte le micro par blocs de 100 ms
class Rec extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = [];
    this.n = 0;
    this.target = Math.round(sampleRate * 0.1);
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      this.buf.push(ch.slice(0));
      this.n += ch.length;
      if (this.n >= this.target) {
        const out = new Float32Array(this.n);
        let o = 0;
        for (const b of this.buf) { out.set(b, o); o += b.length; }
        this.port.postMessage(out, [out.buffer]);
        this.buf = [];
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('rec', Rec);
