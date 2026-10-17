/* TakeOne PCM tap — downsamples mic audio to 16kHz Int16 for Cloud STT */
class PcmTapProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._acc = [];
    this._ratio = sampleRate / 16000;
    this._pos = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || ch.length === 0) return true;
    let i = this._pos;
    while (i < ch.length) {
      const idx = Math.floor(i);
      const s = Math.max(-1, Math.min(1, ch[idx] || 0));
      this._acc.push(s < 0 ? s * 0x8000 : s * 0x7fff);
      i += this._ratio;
    }
    this._pos = i - ch.length;
    if (this._acc.length >= 1600) {
      const out = new Int16Array(this._acc);
      this._acc = [];
      this.port.postMessage(out.buffer, [out.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-tap', PcmTapProcessor);
