/** PSP sample-voice mixer: PCM, VAG ADPCM, pitch, volume and ADSR. */
import type { MemoryBus } from "../memory/memory-bus.js";
export const SAS_VOICES_MAX = 32;
const MAX_ENV = 0x40000000;
const clamp = (value: number): number => Math.max(-32768, Math.min(32767, value));
const signed = (value: number): number => (value << 16) >> 16;
const prediction = [[0, 0], [60, 0], [115, -52], [98, -55], [122, -60]] as const;
class AdpcmStream {
  private address = 0;
  private limit = 0;
  private restart = 0;
  private repeat = false;
  private shouldRepeat = false;
  private pending = new Int16Array(28);
  private consumed = 28;
  private recentSample = 0;
  private olderSample = 0;
  ended = true;
  start(address: number, bytes: number, repeat: boolean): void {
    this.address = address; this.limit = address + Math.floor(bytes / 16) * 16;
    this.restart = address; this.repeat = repeat; this.shouldRepeat = false;
    this.consumed = 28; this.recentSample = this.olderSample = 0; this.ended = false;
  }
  next(bus: MemoryBus): number {
    if (this.ended) return 0;
    if (this.consumed === 28) {
      if (this.shouldRepeat) { this.address = this.restart; this.shouldRepeat = false; }
      if (this.address >= this.limit) { this.ended = true; return 0; }
      const format = bus.readU8(this.address);
      const flags = bus.readU8(this.address + 1);
      if (flags === 7) { this.ended = true; return 0; }
      if (flags === 6) this.restart = this.address;
      this.shouldRepeat = flags === 3 && this.repeat;
      const [recent, older] = prediction[format >>> 4] ?? prediction[0];
      for (let n = 0; n < 28; n++) {
        const packed = bus.readU8(this.address + 2 + Math.floor(n / 2));
        const nibble = (packed >>> ((n % 2) * 4)) & 15;
        const residual = signed(nibble << 12) >> (format & 15);
        const sample = clamp(residual + ((this.recentSample * recent + this.olderSample * older) >> 6));
        this.pending[n] = sample;
        this.olderSample = this.recentSample;
        this.recentSample = sample;
      }
      this.address += 16; this.consumed = 0;
    }
    return this.pending[this.consumed++]!;
  }
}
const linearRate = (n: number, shift = 26): number => {
  n &= 127;
  return n === 127 ? 0 : Math.max(1, ((7 - (n & 3)) << shift) >> (n >>> 2));
};
type Phase = "off" | "delay" | "attack" | "decay" | "sustain" | "release";
class Envelope {
  attackRate = 0; decayRate = 0; sustainRate = 0; releaseRate = 0; sustainLevel = 0;
  attackType = 0; decayType = 1; sustainType = 1; releaseType = 1;
  private level = 0;
  private phase: Phase = "off";
  private delay = 0;
  getHeight(): number { return Math.min(MAX_ENV, this.level); }
  needsKeyOn(): boolean { return this.phase === "delay" && this.delay === 32; }
  hasEnded(): boolean { return this.phase === "off"; }
  keyOn(): void { this.phase = "delay"; this.delay = 32; }
  keyOff(): void { this.phase = "release"; this.level = Math.min(this.level, MAX_ENV); }
  end(): void { this.phase = "off"; this.level = 0; }
  setSimple(first: number, second: number): void {
    const decay = (first >>> 4) & 15;
    const release = second & 31;
    this.attackRate = linearRate(first >>> 8);
    this.attackType = first & 0x8000 ? 2 : 0;
    this.decayRate = decay ? 0x80000000 >>> decay : 0x7fffffff;
    this.decayType = 3;
    this.sustainType = (second >>> 14) & 3;
    this.sustainRate = linearRate(second >>> 6, this.sustainType === 3 ? 24 : 26);
    this.sustainLevel = ((first & 15) + 1) * 0x4000000;
    this.releaseType = second & 32 ? 3 : 1;
    this.releaseRate = release === 31 ? 0 : this.releaseType === 3
      ? release ? 0x80000000 >>> release : 0x7fffffff
      : release === 30 ? MAX_ENV : release === 29 ? 1 : 0x10000000 >> release;
  }
  setRate(mask: number, a: number, d: number, s: number, r: number): void {
    if (mask & 1) this.attackRate = a;
    if (mask & 2) this.decayRate = d;
    if (mask & 4) this.sustainRate = s;
    if (mask & 8) this.releaseRate = r;
  }
  setEnvelope(mask: number, a: number, d: number, s: number, r: number): void {
    if (mask & 1) this.attackType = a;
    if (mask & 2) this.decayType = d;
    if (mask & 4) this.sustainType = s;
    if (mask & 8) this.releaseType = r;
  }
  step(): void {
    if (this.phase === "off") return;
    if (this.phase === "delay") {
      this.level = this.delay === 32 ? 0 : 32 - this.delay;
      if (--this.delay === 0) { this.level = 0; this.phase = "attack"; }
      return;
    }
    const phase = this.phase;
    const rate = this[`${phase}Rate`];
    const mode = this[`${phase}Type`];
    switch (mode) {
      case 0: this.level += rate; break;
      case 1: this.level -= rate; break;
      case 2: this.level += this.level <= MAX_ENV * 0.75 ? rate : Math.floor(rate / 4); break;
      case 3: this.level += Math.floor((MAX_ENV - this.level) * rate / 0x100000000) - Math.floor((rate + 3) / 4); break;
      case 4: this.level += Math.floor((MAX_ENV - this.level) * rate / 0x100000000) + 0x4000; break;
      case 5: this.level = rate; break;
    }
    if (phase === "attack" && (this.level >= MAX_ENV || this.level < 0)) {
      this.level = Math.min(this.level, MAX_ENV); this.phase = "decay";
    } else if (phase === "decay" && this.level < this.sustainLevel) this.phase = "sustain";
    else if (phase === "sustain" && this.level <= 0) { this.level = 0; this.phase = "release"; }
    else if (phase === "release" && this.level <= 0) this.end();
  }
}
class Voice {
  type = 0; playing = false; on = false; paused = false;
  vagAddr = 0; vagSize = 0; pcmAddr = 0; pcmSize = 0; pcmIndex = 0; pcmLoopPos = 0;
  loop = false; pitch = 0x1000; volumeLeft = 0x1000; volumeRight = 0x1000;
  effectLeft = 0; effectRight = 0;
  readonly envelope = new Envelope();
  private readonly adpcm = new AdpcmStream();
  private fraction = 0;
  private history = new Int16Array(2);
  private scratch = new Int16Array(0);
  keyOn(): void {
    this.envelope.keyOn();
    this.adpcm.start(this.vagAddr, this.vagSize, this.loop);
    this.playing = this.on = true; this.paused = false; this.fraction = 0;
  }
  keyOff(): void { this.on = false; this.envelope.keyOff(); }
  private sample(bus: MemoryBus): number {
    if (this.type === 1) return this.adpcm.next(bus);
    if (this.type !== 5 || !this.on) { this.pcmIndex = 0; return 0; }
    if (this.pcmIndex >= this.pcmSize) return 0;
    const value = signed(bus.readU16(this.pcmAddr + this.pcmIndex * 2));
    if (++this.pcmIndex === this.pcmSize && this.loop && this.pcmLoopPos < this.pcmSize) this.pcmIndex = this.pcmLoopPos;
    return value;
  }
  render(bus: MemoryBus, left: Int32Array, right: Int32Array): void {
    if ((this.type === 1 && !this.vagAddr) || (this.type === 5 && !this.pcmAddr)) return;
    const initial = this.envelope.needsKeyOn();
    const delay = initial ? (this.type === 5 && this.pitch > 0x1000 ? 32 : (32 * this.pitch) >> 12) + (this.type === 1 ? 1 : 0) : 0;
    const advance = (this.fraction + this.pitch * Math.max(0, left.length - delay)) >> 12;
    if (this.scratch.length < advance + 4) this.scratch = new Int16Array(advance + 4);
    const samples = this.scratch;
    if (!initial) samples.set(this.history);
    for (let n = initial ? 0 : 2; n < advance + 2; n++) samples[n] = this.sample(bus);
    for (let n = 0; n < delay; n++) this.envelope.step();
    const interpolate = this.pitch !== 0x1000 || (this.fraction & 0xfff) !== 0;
    for (let frame = delay; frame < left.length; frame++) {
      const position = this.fraction >> 12;
      const fraction = this.fraction & 0xfff;
      const value = interpolate ? (samples[position]! * (4095 - fraction) + samples[position + 1]! * fraction) >> 12 : samples[position]!;
      const gain = (this.envelope.getHeight() + 0x4000) >> 15;
      this.envelope.step();
      const scaled = (value * gain + 0x4000) >> 15;
      left[frame]! += scaled * this.volumeLeft >> 12;
      right[frame]! += scaled * this.volumeRight >> 12;
      this.fraction += this.pitch;
    }
    this.history.set(samples.subarray(advance, advance + 2));
    this.fraction -= advance * 4096;
    if ((this.type === 1 && this.adpcm.ended) || (this.type === 5 && this.pcmIndex >= this.pcmSize)) this.envelope.end();
    if (this.envelope.hasEnded()) this.playing = this.on = false;
  }
}
export class SasInstance {
  grainSize = 256;
  outputMode = 0;
  readonly voices = Array.from({ length: SAS_VOICES_MAX }, () => new Voice());
  private left = new Int32Array(0);
  private right = new Int32Array(0);
  setGrainSize(size: number): void { this.grainSize = size; }
  getEndFlag(): number {
    return this.voices.reduce((flags, voice, index) => voice.playing ? flags : flags | (1 << index), 0) >>> 0;
  }
  mix(bus: MemoryBus, output: number, input: number, leftVolume: number, rightVolume: number, mute: boolean): void {
    if (this.left.length !== this.grainSize) {
      this.left = new Int32Array(this.grainSize);
      this.right = new Int32Array(this.grainSize);
    }
    const left = this.left, right = this.right;
    left.fill(0); right.fill(0);
    if (!mute) for (const voice of this.voices) if (voice.playing && !voice.paused) voice.render(bus, left, right);
    for (let frame = 0; frame < this.grainSize; frame++) {
      const at = frame * 4;
      const l = left[frame]! + (input ? signed(bus.readU16(input + at)) * leftVolume >> 12 : 0);
      const r = right[frame]! + (input ? signed(bus.readU16(input + at + 2)) * rightVolume >> 12 : 0);
      bus.writeU16(output + at, clamp(l) & 0xffff);
      bus.writeU16(output + at + 2, clamp(r) & 0xffff);
    }
  }
}
