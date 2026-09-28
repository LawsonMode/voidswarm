/**
 * "DEFEAT" (one-shot stinger, plays once). ORIGINAL composition for Voidswarm.
 * A minor · 78 bpm · 5 bars ≈ 15 s. No drums. Low pads (octave 3), a slow lead with a late
 * vibrato, and a bell that tolls the chord tones. The lead's opening sigh E – F – E is the hook
 * cell's falling tail (6th → 5th) slowed right down; the harmonic-minor V (E, G#) resolves to a
 * bare tonic, with no picardy third: the swarm won.
 *
 *   bar 1  Am            the sigh (5 – b6 – 5)
 *   bar 2  F             falls to the 3rd, then the tonic below
 *   bar 3  Dm            a last reach up (D – F – E – D)
 *   bar 4  E7sus4 → E    the suspension resolves to the leading tone G#
 *   bar 5  Am            the tonic, held; the bell's last toll
 */
import type { Song } from '../format';
import { held, rest, seq } from './lib';

export const DEFEAT: Song = {
  title: 'Defeat',
  bpm: 78,
  timeSig: '4/4',
  key: 'A',
  mode: 'aeolian',
  loop: false,
  transition: 'fade',
  intensity: { min: 1, max: 1 },
  delay: { time: '8d', feedback: 0.38 },
  reverb: { decay: 3.6 },
  pump: 0,
  tracks: [
    { id: 'pad', inst: 'pad', octave: 3, layer: 'base', reverb: 0.5 },
    { id: 'bass', inst: 'bass', layer: 'base', tone: { decay: 0.8, sustain: 0.7, cutoff: 120, envAmount: 600 } },
    { id: 'lead', inst: 'lead', layer: 'base', gain: 0.85, tone: { cutoff: 1500, attack: 0.05, vibrato: 22, vibratoDelay: 0.45, glide: 0.16 } },
    { id: 'bell', inst: 'bell', layer: 'base', pan: -0.2, gain: 0.8 },
  ],
  patterns: {
    pad: held(['@Am', 16], ['@F', 16], ['@Dm', 16], ['@E7sus4', 8], ['@E', 8], ['@Am', 16]),
    bass: held(['A1', 16], ['F1', 16], ['D2', 16], ['E1', 16], ['A1', 16]),
    lead: seq(
      'E5 - - - - - - - F5 - - - E5 - - -', //   Am
      'C5 - - - - - - - - - - - A4 - - -', //    F
      'D5 - - - - - - - F5 - - - E5 - D5 -', //  Dm
      'B4 - - - - - - - G#4 - - - - - - -', //   E7sus4 → E
      'A4 - - - - - - - - - - - - - . .', //     Am
    ),
    bell: seq('E6 . . . . . . . C6 . . . A5 . . .', rest(16), 'F6 . . . . . . . D6 . . . A5 . . .', rest(16), 'A5 . . . . . . . . . . . . . . .'),
  },
  sections: {
    lament: { bars: 5, kind: 'outro', play: { pad: 'pad', bass: 'bass', lead: 'lead', bell: 'bell' } },
  },
  form: ['lament'],
};
