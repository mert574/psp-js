/**
 * Ambient type declarations for AudioWorkletGlobalScope.
 *
 * TypeScript's lib.dom.d.ts exposes AudioWorkletProcessor as an interface +
 * declare var, which cannot be extended.  The AudioWorklet spec defines it as
 * a base class in the worklet's own global scope.  These declarations give
 * TypeScript the class form it needs to compile audio-worklet-processor.ts
 * without resorting to @ts-nocheck or @ts-ignore.
 *
 * This file is intentionally separate from lib.dom.d.ts — the AudioWorklet
 * processor runs in AudioWorkletGlobalScope, not Window.
 */

/** Base class for AudioWorklet processors (AudioWorkletGlobalScope). */
declare class AudioWorkletProcessor {
  /** MessagePort for bidirectional communication with the AudioWorkletNode. */
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
  /**
   * Called by the audio thread for each render quantum (~128 frames).
   * Return false to deactivate the processor.
   */
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

/** Registers a processor class under a name for use with AudioWorkletNode. */
declare function registerProcessor(
  name: string,
  ctor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void;
