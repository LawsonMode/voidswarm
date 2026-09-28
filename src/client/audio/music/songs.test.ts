// Validates EVERY registered song + the default stingers. Composers: this is your lint.
import { describe, expect, it } from 'vitest';
import { chromaticNotes, compileSong, maxPolyphony, timelineSteps, validateStinger } from './compile';
import { MUSIC_SCENES } from './format';
import { SCENE_SONG, SONGS, type SongId } from './songs/index';
import { DEFAULT_STINGERS } from './songs/stingers';

describe('registered songs', () => {
  for (const id of Object.keys(SONGS) as SongId[]) {
    it(`${id}: "${SONGS[id].title}" compiles with no errors`, () => {
      const r = compileSong(SONGS[id]);
      if (r.warnings.length) console.warn(`[${id}] ${r.warnings.length} warnings:\n  ${r.warnings.join('\n  ')}`);
      expect(r.errors).toEqual([]);
      const cs = r.compiled!;
      expect(timelineSteps(cs)).toBeGreaterThan(0);
      for (const sec of cs.sections) expect(maxPolyphony(cs, sec)).toBeLessThanOrEqual(24);
      // informational theory check: how much is outside the key (V chords etc. are expected)
      const chrom = chromaticNotes(cs);
      let total = 0;
      for (const sec of cs.sections) for (const row of sec.events) for (const evs of row) for (const ev of evs ?? []) total += ev.midi.length;
      if (total > 0) expect(chrom.length / total).toBeLessThan(0.5);
      for (const st of Object.values(SONGS[id].stingers ?? {})) if (st) expect(validateStinger(st.parts)).toEqual([]);
    });
  }
  it('every scene maps to a registered song', () => {
    for (const s of MUSIC_SCENES) expect(SONGS[SCENE_SONG[s]]).toBeDefined();
  });
  it('default stingers are valid', () => {
    for (const st of Object.values(DEFAULT_STINGERS)) expect(validateStinger(st.parts)).toEqual([]);
  });
  it('the placeholder final chorus is a whole step up', () => {
    const cs = compileSong(SONGS.placeholder).compiled!;
    expect(cs.sections.find((s) => s.name === 'final')!.transpose).toBe(2);
  });
});
