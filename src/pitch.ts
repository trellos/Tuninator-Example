/**
 * Pitch and range maths shared by the timeline and the mock.
 *
 * The library exposes no frequency↔note helper, and both the canvas (turning a
 * `DetectedPitch` into a vertical position) and the mock (synthesising one) need
 * the same conversions. They lived twice, under different names — `hzToMidi`
 * against `hzToMidiFloat` — which is exactly how two copies drift.
 *
 * No DOM, no library imports beyond the `PitchClass` type.
 */

import type { PitchClass } from "tuninator";

/** Sharp-spelled, matching the library's `PitchClass`. */
const PITCH_CLASSES: readonly PitchClass[] = [
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];

const A4_MIDI = 69;
const A4_HZ = 440;

export function midiToHz(midi: number): number {
  return A4_HZ * Math.pow(2, (midi - A4_MIDI) / 12);
}

/** Fractional MIDI, so a bend or a detuned string keeps its cents. */
export function hzToMidi(hz: number): number {
  return A4_MIDI + 12 * Math.log2(hz / A4_HZ);
}

export function pitchClassOf(midi: number): PitchClass {
  const index = ((Math.round(midi) % 12) + 12) % 12;
  return PITCH_CLASSES[index] ?? "C";
}

/** Scientific octave: A4 is octave 4, C4 is middle C. */
export function octaveOf(midi: number): number {
  return Math.floor(Math.round(midi) / 12) - 1;
}

/** Scientific pitch notation, e.g. "A4", "F#3". */
export function noteNameOf(midi: number): string {
  return `${pitchClassOf(midi)}${octaveOf(midi)}`;
}

export function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}
