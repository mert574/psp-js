/**
 * sceSas voice synthesizer — port of PPSSPP's Core/HW/SasAudio.cpp.
 *
 * Synthesizes the PSP's hardware voice mixer (used for most game SFX and
 * voices): VAG (4-bit ADPCM) and PCM voices, per-voice pitch (sample-rate
 * conversion), L/R volume, and ADSR envelopes. __sceSasCore mixes all active
 * voices into one stereo grain that the game then sends to sceAudioOutput.
 *
 * Not ported (rare / deferred): ATRAC3 voices, noise/triangle/pulse waveforms,
 * and the reverb/effect send path (dry mixing only — matches the common case).
 */

import type { MemoryBus } from "../memory/memory-bus.js";

const PITCH_BASE = 0x1000;
const PITCH_MASK = 0xfff;
const PITCH_SHIFT = 12;
const ENV_MAX = 0x40000000; // PSP_SAS_ENVELOPE_HEIGHT_MAX = (1<<30)
export const SAS_VOICES_MAX = 32;

// Voice types (PSP_SAS VOICETYPE_*)
const VOICETYPE_OFF = 0;
const VOICETYPE_VAG = 1;
const VOICETYPE_PCM = 5;

// ADSR curve modes
const CURVE_LINEAR_INCREASE = 0;
const CURVE_LINEAR_DECREASE = 1;
const CURVE_LINEAR_BENT = 2;
const CURVE_EXPONENT_DECREASE = 3;
const CURVE_EXPONENT_INCREASE = 4;
const CURVE_DIRECT = 5;

// ADSR states
const STATE_KEYON_STEP = -42;
const STATE_KEYON = -2;
const STATE_OFF = -1;
const STATE_ATTACK = 0;
const STATE_DECAY = 1;
const STATE_SUSTAIN = 2;
const STATE_RELEASE = 3;

// VAG ADPCM filter coefficients (SasAudio.cpp:31).
const VAG_F: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [60, 0], [115, 52], [98, 55], [122, 60],
  [0, 0], [0, 0], [52, 0], [55, 2], [60, 125],
  [0, 0], [0, 91], [0, 0], [2, 216], [125, 6], [0, 151],
];

function clampS16(v: number): number {
  return v < -32768 ? -32768 : v > 32767 ? 32767 : v;
}

// ── ADSR rate/type decode (SasAudio.cpp:251-326) ─────────────────────────────

function simpleRate(n: number): number {
  n &= 0x7f;
  if (n === 0x7f) return 0;
  const rate = ((7 - (n & 3)) << 26) >> (n >> 2);
  return rate === 0 ? 1 : rate;
}
function exponentRate(n: number): number {
  n &= 0x7f;
  if (n === 0x7f) return 0;
  const rate = ((7 - (n & 3)) << 24) >> (n >> 2);
  return rate === 0 ? 1 : rate;
}
function getAttackRate(b1: number): number { return simpleRate(b1 >> 8); }
function getAttackType(b1: number): number {
  return (b1 & 0x8000) === 0 ? CURVE_LINEAR_INCREASE : CURVE_LINEAR_BENT;
}
function getDecayRate(b1: number): number {
  const n = (b1 >> 4) & 0xf;
  return n === 0 ? 0x7fffffff : (0x80000000 >>> n);
}
function getSustainType(b2: number): number { return (b2 >> 14) & 3; }
function getSustainRate(b2: number): number {
  return getSustainType(b2) === CURVE_EXPONENT_DECREASE ? exponentRate(b2 >> 6) : simpleRate(b2 >> 6);
}
function getReleaseType(b2: number): number {
  return (b2 & 0x20) === 0 ? CURVE_LINEAR_DECREASE : CURVE_EXPONENT_DECREASE;
}
function getReleaseRate(b2: number): number {
  const n = b2 & 0x1f;
  if (n === 31) return 0;
  if (getReleaseType(b2) === CURVE_LINEAR_DECREASE) {
    if (n === 30) return 0x40000000;
    if (n === 29) return 1;
    return 0x10000000 >> n;
  }
  if (n === 0) return 0x7fffffff;
  return 0x80000000 >>> n;
}
function getSustainLevel(b1: number): number { return ((b1 & 0xf) + 1) << 26; }

// ── VAG (ADPCM) decoder ──────────────────────────────────────────────────────

class VagDecoder {
  private data = 0;
  private read = 0;
  private curSample = 28;
  private curBlock = -1;
  private numBlocks = 0;
  private s1 = 0;
  private s2 = 0;
  private end_ = true;
  private loopEnabled = false;
  private loopAtNextBlock = false;
  private loopStartBlock = -1;
  private readonly samples = new Int16Array(28);

  start(data: number, vagSize: number, loopEnabled: boolean): void {
    this.loopEnabled = loopEnabled;
    this.loopAtNextBlock = false;
    this.loopStartBlock = -1;
    this.numBlocks = (vagSize / 16) | 0;
    this.end_ = false;
    this.data = data;
    this.read = data;
    this.curSample = 28;
    this.curBlock = -1;
    this.s1 = 0;
    this.s2 = 0;
  }

  get ended(): boolean { return this.end_; }

  private decodeBlock(bus: MemoryBus): void {
    if (this.curBlock === this.numBlocks - 1) { this.end_ = true; return; }
    let p = this.read;
    const predictNr = bus.readU8(p++);
    const shiftFactor = predictNr & 0xf;
    const predict = predictNr >> 4;
    const flags = bus.readU8(p++);
    if (flags === 7) { this.end_ = true; return; }
    if (flags === 6) this.loopStartBlock = this.curBlock;
    else if (flags === 3 && this.loopEnabled) this.loopAtNextBlock = true;

    let s1 = this.s1, s2 = this.s2;
    const coef1 = VAG_F[predict]![0];
    const coef2 = -VAG_F[predict]![1];
    for (let i = 0; i < 28; i += 2) {
      const d = bus.readU8(p++);
      const sample1 = (((d & 0x0f) << 12) << 16 >> 16) >> shiftFactor; // sign-extend s16 then >> shift
      const sample2 = (((d & 0xf0) << 8) << 16 >> 16) >> shiftFactor;
      s2 = clampS16(sample1 + ((s1 * coef1 + s2 * coef2) >> 6));
      s1 = clampS16(sample2 + ((s2 * coef1 + s1 * coef2) >> 6));
      this.samples[i] = s2;
      this.samples[i + 1] = s1;
    }
    this.s1 = s1;
    this.s2 = s2;
    this.curSample = 0;
    this.curBlock++;
    this.read = p;
  }

  getSamples(bus: MemoryBus, out: Int16Array, outOff: number, numSamples: number): void {
    if (this.end_) { out.fill(0, outOff, outOff + numSamples); return; }
    for (let i = 0; i < numSamples; i++) {
      if (this.curSample === 28) {
        if (this.loopAtNextBlock) {
          this.read = this.data + 16 * this.loopStartBlock + 16;
          this.curBlock = this.loopStartBlock;
          this.loopAtNextBlock = false;
        }
        this.decodeBlock(bus);
        if (this.end_) { out.fill(0, outOff + i, outOff + numSamples); return; }
      }
      out[outOff + i] = this.samples[this.curSample++]!;
    }
  }
}

// ── ADSR envelope ────────────────────────────────────────────────────────────

class Envelope {
  attackRate = 0; decayRate = 0; sustainRate = 0; sustainLevel = 0; releaseRate = 0;
  attackType = CURVE_LINEAR_INCREASE;
  decayType = CURVE_LINEAR_DECREASE;
  sustainType = CURVE_LINEAR_DECREASE;
  releaseType = CURVE_LINEAR_DECREASE;
  private height = 0; // up to ENV_MAX
  private state = STATE_OFF;

  getHeight(): number { return this.height > ENV_MAX ? ENV_MAX : this.height; }
  needsKeyOn(): boolean { return this.state === STATE_KEYON; }
  hasEnded(): boolean { return this.state === STATE_OFF; }

  setSimple(env1: number, env2: number): void {
    this.attackRate = getAttackRate(env1);
    this.attackType = getAttackType(env1);
    this.decayRate = getDecayRate(env1);
    this.decayType = CURVE_EXPONENT_DECREASE;
    this.sustainRate = getSustainRate(env2);
    this.sustainType = getSustainType(env2);
    this.releaseRate = getReleaseRate(env2);
    this.releaseType = getReleaseType(env2);
    this.sustainLevel = getSustainLevel(env1);
  }

  setEnvelope(flag: number, a: number, d: number, s: number, r: number): void {
    if (flag & 1) this.attackType = a;
    if (flag & 2) this.decayType = d;
    if (flag & 4) this.sustainType = s;
    if (flag & 8) this.releaseType = r;
  }
  setRate(flag: number, a: number, d: number, s: number, r: number): void {
    if (flag & 1) this.attackRate = a;
    if (flag & 2) this.decayRate = d;
    if (flag & 4) this.sustainRate = s;
    if (flag & 8) this.releaseRate = r;
  }

  private walkCurve(type: number, rate: number): void {
    switch (type) {
      case CURVE_LINEAR_INCREASE: this.height += rate; break;
      case CURVE_LINEAR_DECREASE: this.height -= rate; break;
      case CURVE_LINEAR_BENT:
        this.height += this.height <= (ENV_MAX * 3) / 4 ? rate : Math.floor(rate / 4);
        break;
      case CURVE_EXPONENT_DECREASE: {
        let expDelta = this.height - ENV_MAX;
        expDelta += Math.floor((-expDelta * rate) / 0x100000000);
        this.height = expDelta + ENV_MAX - Math.floor((rate + 3) / 4);
        break;
      }
      case CURVE_EXPONENT_INCREASE: {
        let expDelta = this.height - ENV_MAX;
        expDelta += Math.floor((-expDelta * rate) / 0x100000000);
        this.height = expDelta + 0x4000 + ENV_MAX;
        break;
      }
      case CURVE_DIRECT: this.height = rate; break;
    }
  }

  private setState(state: number): void {
    if (this.height > ENV_MAX) this.height = ENV_MAX;
    this.state = state;
  }

  step(): void {
    switch (this.state) {
      case STATE_ATTACK:
        this.walkCurve(this.attackType, this.attackRate);
        if (this.height >= ENV_MAX || this.height < 0) this.setState(STATE_DECAY);
        break;
      case STATE_DECAY:
        this.walkCurve(this.decayType, this.decayRate);
        if (this.height < this.sustainLevel) this.setState(STATE_SUSTAIN);
        break;
      case STATE_SUSTAIN:
        this.walkCurve(this.sustainType, this.sustainRate);
        if (this.height <= 0) { this.height = 0; this.setState(STATE_RELEASE); }
        break;
      case STATE_RELEASE:
        this.walkCurve(this.releaseType, this.releaseRate);
        if (this.height <= 0) { this.height = 0; this.setState(STATE_OFF); }
        break;
      case STATE_KEYON:
        this.height = 0;
        this.setState(STATE_KEYON_STEP);
        break;
      case STATE_KEYON_STEP:
        this.height++;
        if (this.height >= 31) { this.height = 0; this.setState(STATE_ATTACK); }
        break;
      case STATE_OFF:
      default:
        break;
    }
  }

  keyOn(): void { this.setState(STATE_KEYON); }
  keyOff(): void { this.setState(STATE_RELEASE); }
  end(): void { this.setState(STATE_OFF); this.height = 0; }
}

// ── Voice ────────────────────────────────────────────────────────────────────

class Voice {
  type = VOICETYPE_OFF;
  playing = false;
  on = false;
  paused = false;
  vagAddr = 0; vagSize = 0;
  pcmAddr = 0; pcmSize = 0; pcmIndex = 0; pcmLoopPos = 0;
  loop = false;
  pitch = PITCH_BASE;
  volumeLeft = 0x1000; volumeRight = 0x1000;
  effectLeft = 0; effectRight = 0;
  sampleFrac = 0;
  readonly resampleHist = new Int16Array(2);
  readonly vag = new VagDecoder();
  readonly envelope = new Envelope();

  readSamples(bus: MemoryBus, out: Int16Array, outOff: number, numSamples: number): void {
    if (this.type === VOICETYPE_VAG) {
      this.vag.getSamples(bus, out, outOff, numSamples);
    } else if (this.type === VOICETYPE_PCM) {
      let needed = numSamples;
      let pos = outOff;
      while (needed > 0) {
        if (!this.on) { this.pcmIndex = 0; break; }
        const size = Math.min(this.pcmSize - this.pcmIndex, needed);
        for (let i = 0; i < size; i++) {
          out[pos + i] = bus.readU16(this.pcmAddr + (this.pcmIndex + i) * 2) << 16 >> 16;
        }
        this.pcmIndex += size;
        needed -= size;
        pos += size;
        if (this.pcmIndex >= this.pcmSize) {
          if (!this.loop) break;
          this.pcmIndex = this.pcmLoopPos;
        }
      }
      if (needed > 0) out.fill(0, pos, pos + needed);
    } else {
      out.fill(0, outOff, outOff + numSamples);
    }
  }

  haveSamplesEnded(): boolean {
    if (this.type === VOICETYPE_VAG) return this.vag.ended;
    if (this.type === VOICETYPE_PCM) return this.pcmIndex >= this.pcmSize;
    return false;
  }

  keyOn(): void {
    this.envelope.keyOn();
    if (this.type === VOICETYPE_VAG) {
      this.vag.start(this.vagAddr, this.vagSize, this.loop);
    }
    this.playing = true;
    this.on = true;
    this.paused = false;
    this.sampleFrac = 0;
  }

  keyOff(): void {
    this.on = false;
    this.envelope.keyOff();
  }
}

// ── SAS instance ─────────────────────────────────────────────────────────────

export class SasInstance {
  grainSize = 256;
  outputMode = 0; // 0 = MIXED
  readonly voices: Voice[] = Array.from({ length: SAS_VOICES_MAX }, () => new Voice());
  private mixL = new Int32Array(0);
  private mixR = new Int32Array(0);
  private mixTemp = new Int16Array(0);

  setGrainSize(n: number): void {
    this.grainSize = n;
    this.mixL = new Int32Array(n);
    this.mixR = new Int32Array(n);
    // Max pitch 0x4000 → up to 4x grain samples, plus history margin.
    this.mixTemp = new Int16Array(n * 4 + 18);
  }

  private ensureBuffers(): void {
    if (this.mixL.length !== this.grainSize) this.setGrainSize(this.grainSize);
  }

  getEndFlag(): number {
    let flag = 0;
    for (let i = 0; i < SAS_VOICES_MAX; i++) {
      if (!this.voices[i]!.playing) flag |= (1 << i);
    }
    return flag >>> 0;
  }

  private mixVoice(bus: MemoryBus, voice: Voice): void {
    if (voice.type === VOICETYPE_VAG && !voice.vagAddr) return;
    if (voice.type === VOICETYPE_PCM && !voice.pcmAddr) return;

    const grainSize = this.grainSize;
    const temp = this.mixTemp;

    let delay = 0;
    if (voice.envelope.needsKeyOn()) {
      const ignorePitch = voice.type === VOICETYPE_PCM && voice.pitch > PITCH_BASE;
      delay = ignorePitch ? 32 : (32 * voice.pitch) >> PITCH_SHIFT;
      if (voice.type === VOICETYPE_VAG) delay++;
    }

    temp[0] = voice.resampleHist[0]!;
    temp[1] = voice.resampleHist[1]!;

    const voicePitch = voice.pitch;
    let sampleFrac = voice.sampleFrac;
    let samplesToRead = (sampleFrac + voicePitch * Math.max(0, grainSize - delay)) >> PITCH_SHIFT;
    if (samplesToRead > temp.length - 2) samplesToRead = temp.length - 2;
    let readPos = 2;
    if (voice.envelope.needsKeyOn()) { readPos = 0; samplesToRead += 2; }
    voice.readSamples(bus, temp, readPos, samplesToRead);
    const tempPos = readPos + samplesToRead;

    for (let i = 0; i < delay; i++) voice.envelope.step();

    const needsInterp = voicePitch !== PITCH_BASE || (sampleFrac & PITCH_MASK) !== 0;
    for (let i = delay; i < grainSize; i++) {
      const idx = sampleFrac >> PITCH_SHIFT;
      let sample = temp[idx]!;
      if (needsInterp) {
        const f = sampleFrac & PITCH_MASK;
        sample = (temp[idx]! * (PITCH_MASK - f) + temp[idx + 1]! * f) >> PITCH_SHIFT;
      }
      sampleFrac += voicePitch;

      let envelopeValue = voice.envelope.getHeight();
      voice.envelope.step();
      envelopeValue = (envelopeValue + (1 << 14)) >> 15;
      sample = ((sample * envelopeValue) + (1 << 14)) >> 15;

      this.mixL[i]! += (sample * voice.volumeLeft) >> 12;
      this.mixR[i]! += (sample * voice.volumeRight) >> 12;
    }

    voice.resampleHist[0] = temp[tempPos - 2]!;
    voice.resampleHist[1] = temp[tempPos - 1]!;
    voice.sampleFrac = sampleFrac - (tempPos - 2) * PITCH_BASE;

    if (voice.haveSamplesEnded()) voice.envelope.end();
    if (voice.envelope.hasEnded()) { voice.playing = false; voice.on = false; }
  }

  /** Synthesize one grain. `inAddr` (0 = none) is mixed in, scaled by
   *  leftVol/rightVol (the __sceSasCoreWithMix path); `mute` clears output. */
  mix(bus: MemoryBus, outAddr: number, inAddr: number, leftVol: number, rightVol: number, mute: boolean): void {
    this.ensureBuffers();
    const grainSize = this.grainSize;
    this.mixL.fill(0);
    this.mixR.fill(0);

    if (!mute) {
      for (let v = 0; v < SAS_VOICES_MAX; v++) {
        const voice = this.voices[v]!;
        if (!voice.playing || voice.paused) continue;
        this.mixVoice(bus, voice);
      }
    }

    // Write the clipped stereo grain (MIXED/dry path). With inAddr, add the
    // caller's existing buffer scaled by leftVol/rightVol (CoreWithMix).
    for (let i = 0; i < grainSize; i++) {
      let l = this.mixL[i]!;
      let r = this.mixR[i]!;
      if (inAddr !== 0) {
        l += (((bus.readU16(inAddr + i * 4) << 16 >> 16) * leftVol) >> 12);
        r += (((bus.readU16(inAddr + i * 4 + 2) << 16 >> 16) * rightVol) >> 12);
      }
      bus.writeU16(outAddr + i * 4, clampS16(l) & 0xffff);
      bus.writeU16(outAddr + i * 4 + 2, clampS16(r) & 0xffff);
    }
  }
}
