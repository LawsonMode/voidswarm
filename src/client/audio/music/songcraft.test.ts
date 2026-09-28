// Composer lint for the Voidswarm soundtrack: format, craft and theory checks on every
// registered song, beyond songs.test.ts (which only requires a clean compile). If you add or
// rewrite a song, this is the file that tells you whether it still obeys the house rules.
import { describe, expect, it } from 'vitest';
import { compileSong, INSTRUMENT_DEFAULTS, parsePattern, resolvePitch, type CompiledSong, type CSection, type CTrack } from './compile';
import { isDrum, MUSIC_SCENES, type Song } from './format';
import { Sequencer } from './sequencer';
import { SCENE_SONG, SONGS, type SongId } from './songs/index';
import { transpose } from './songs/lib';
import { DEFAULT_STINGERS, PHRYGIAN_STINGERS } from './songs/stingers';
import { HOOK_LEAD, hookCellWide } from './songs/themes';
import { SynthCore } from './synth';
import { fakeCtx } from './testing/fakeAudio';
import { MODES, scalePcs } from './theory';
import { effectiveIntensity, layerActive } from './timing';

const REAL: readonly SongId[] = ['title', 'command', 'match', 'boss', 'victory', 'defeat'];

/**
 * Out-of-scale pitch classes each song may use, as semitones above the SECTION tonic
 * (song key + section transpose). Everything else must be in the song's mode.
 */
const ALLOWED_CHROMATIC: Readonly<Record<string, readonly number[]>> = {
  title: [11], //           the harmonic-minor leading tone (C# in D minor, D# after the key change)
  command: [8, 11], //      Bb (aeolian mixture: the VI of the title chorus) and C# (the A7 dominant)
  match: [11], //           G# (E major, the V)
  boss: [2, 4, 6, 11], //   F# (the payoff's E minor), G# (the E-major phrygian cadence), Bb (tritone), D# (the V)
  victory: [4, 9], //       C# and F#: the lift from A minor into A major (I and IV)
  defeat: [11], //          G# (the V before the bare tonic)
};

/**
 * Sections where the melody deliberately grinds a semitone against the harmony: the boss's bitonal
 * F/E riff, its b6-to-5 leaning lead, the b9 over its dominant and the tritone tension build.
 */
const ALLOWED_GRIND: Readonly<Record<string, readonly string[]>> = {
  boss: ['intro', 'A', 'B', 'A2', 'tension'],
};

function compiled(id: SongId): CompiledSong {
  const r = compileSong(SONGS[id]);
  expect(r.errors).toEqual([]);
  return r.compiled!;
}

function trackIndex(cs: CompiledSong, pred: (t: CTrack) => boolean): number[] {
  return cs.tracks.flatMap((t, i) => (pred(t) ? [i] : []));
}

/** The MIDI notes of the event on track `ti` that is sounding at `step` (null when silent). */
function soundingAt(sec: CSection, ti: number, step: number): readonly number[] | null {
  const row = sec.events[ti]!;
  for (let s = step; s >= 0; s--) for (const ev of row[s] ?? []) if (s + ev.frac + ev.len > step) return ev.midi;
  return null;
}

function eventCount(sec: CSection, ti: number): number {
  return sec.events[ti]!.reduce((a, evs) => a + (evs?.length ?? 0), 0);
}

const pc = (m: number): number => ((m % 12) + 12) % 12;

describe('the soundtrack registry', () => {
  it('every scene has a real song (the placeholder is only the engine fallback)', () => {
    for (const s of MUSIC_SCENES) {
      expect(SONGS[SCENE_SONG[s]]).toBeDefined();
      expect(SCENE_SONG[s]).not.toBe('placeholder');
      expect(SONGS[SCENE_SONG[s]]).not.toBe(SONGS.placeholder);
    }
  });
  it('command and lobby share one Song object (no transition between them)', () => {
    expect(SONGS[SCENE_SONG.command]).toBe(SONGS[SCENE_SONG.lobby]);
  });
  it('every song has a distinct title', () => {
    const titles = REAL.map((id) => SONGS[id].title);
    expect(new Set(titles).size).toBe(titles.length);
  });
});

describe.each(REAL)('song "%s"', (id) => {
  const song: Song = SONGS[id];

  it('compiles with no errors and no warnings', () => {
    const r = compileSong(song);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('bars add up: every pattern is whole bars and every chain fills its section exactly', () => {
    const drumTrack = new Map(song.tracks.map((t) => [t.id, isDrum(t.inst)]));
    for (const [name, sec] of Object.entries(song.sections)) {
      expect(Number.isInteger(sec.bars) && sec.bars >= 1, `${name}.bars`).toBe(true);
      const steps = sec.bars * 16;
      for (const [tid, ref] of Object.entries(sec.play)) {
        const chain = typeof ref === 'string' ? [ref] : [...ref];
        let len = 0;
        for (const pid of chain) {
          const pp = parsePattern(song.patterns[pid]!, drumTrack.get(tid) ?? false);
          expect(pp.length % 16, `pattern "${pid}" is ${pp.length} steps (not whole bars)`).toBe(0);
          len += pp.length;
        }
        expect(len <= steps && steps % len === 0, `${name}/${tid}: chain ${len} steps vs section ${steps}`).toBe(true);
      }
    }
  });

  it('no zero-length notes, nothing rings past its section end, every note in its instrument range', () => {
    const cs = compiled(id);
    for (const sec of cs.sections) {
      cs.tracks.forEach((tr, ti) => {
        const [lo, hi] = INSTRUMENT_DEFAULTS[tr.inst].range;
        sec.events[ti]!.forEach((evs, s) => {
          for (const ev of evs ?? []) {
            expect(ev.len, `${sec.name}/${tr.id}@${s}`).toBeGreaterThan(0);
            if (tr.isDrum) continue;
            expect(s + ev.frac + ev.len, `${sec.name}/${tr.id}@${s} overhangs the section`).toBeLessThanOrEqual(sec.steps + 1e-9);
            for (const m of ev.midi) {
              expect(m, `${sec.name}/${tr.id}@${s}`).toBeGreaterThanOrEqual(lo);
              expect(m, `${sec.name}/${tr.id}@${s}`).toBeLessThanOrEqual(hi);
            }
          }
        });
      });
    }
  });

  it('layer thresholds are sane: every played track is reachable, and no section ever goes silent', () => {
    const cs = compiled(id);
    const used = new Set<string>();
    for (const sec of cs.sections) {
      const reach = effectiveIntensity(1, cs.intensityMin, cs.intensityMax, sec.intensity);
      const floor = effectiveIntensity(0, cs.intensityMin, cs.intensityMax, sec.intensity);
      let audibleAtFloor = 0;
      cs.tracks.forEach((tr, ti) => {
        expect(tr.threshold).toBeGreaterThanOrEqual(0);
        expect(tr.threshold).toBeLessThanOrEqual(1);
        const n = eventCount(sec, ti);
        if (n === 0) return;
        used.add(tr.id);
        expect(tr.threshold, `${sec.name}/${tr.id} can never be heard (max eff ${reach.toFixed(2)})`).toBeLessThanOrEqual(reach);
        if (layerActive(false, floor, tr.threshold)) audibleAtFloor += n;
      });
      expect(audibleAtFloor, `${sec.name} is silent at the lowest intensity`).toBeGreaterThan(0);
    }
    for (const tr of cs.tracks) expect(used.has(tr.id), `track "${tr.id}" never plays`).toBe(true);
  });

  it('the bass sits on the chord (root, a chord tone, or the root under a rootless voicing) at every chord change', () => {
    const cs = compiled(id);
    const [pad] = trackIndex(cs, (t) => t.inst === 'pad');
    const [bass] = trackIndex(cs, (t) => t.inst === 'bass');
    if (pad === undefined || bass === undefined) return;
    const extension = new Set([2, 3, 4, 7, 9, 10, 11]);
    for (const sec of cs.sections) {
      sec.events[pad]!.forEach((evs, s) => {
        const chord = evs?.[0]?.midi;
        const b = sec.events[bass]![s]?.[0]?.midi[0];
        if (!chord || b === undefined) return;
        const pcs = new Set(chord.map(pc));
        const rootless = [...pcs].every((p) => extension.has(pc(p - b)));
        expect(pcs.has(pc(b)) || rootless, `${sec.name}@bar${Math.floor(s / 16) + 1}: bass ${b} under [${chord.join(' ')}]`).toBe(true);
      });
    }
  });

  it('the lead sits on or above the pads', () => {
    const cs = compiled(id);
    const [pad] = trackIndex(cs, (t) => t.inst === 'pad');
    const leads = trackIndex(cs, (t) => t.inst === 'lead');
    if (pad === undefined) return;
    for (const sec of cs.sections) {
      for (const li of leads) {
        sec.events[li]!.forEach((evs, s) => {
          const chord = soundingAt(sec, pad, s);
          if (!chord) return;
          for (const ev of evs ?? []) expect(ev.midi[0]!, `${sec.name}@${s}`).toBeGreaterThanOrEqual(Math.max(...chord));
        });
      }
    }
  });

  it('the melody never grinds a minor 2nd / minor 9th against the harmony (on a beat, for 3+ steps, or struck together)', () => {
    const cs = compiled(id);
    const melodic = new Set(['lead', 'bell']);
    const voices = new Set(['lead', 'bell', 'pad', 'brass', 'bass']);
    const allowed = new Set(ALLOWED_GRIND[id] ?? []);
    const bad: string[] = [];
    for (const sec of cs.sections) {
      if (allowed.has(sec.name)) continue;
      const notes: { tr: string; inst: string; m: number; s: number; e: number }[] = [];
      cs.tracks.forEach((tr, ti) => {
        if (!voices.has(tr.inst)) return;
        sec.events[ti]!.forEach((evs, s) => {
          for (const ev of evs ?? []) for (const m of ev.midi) notes.push({ tr: tr.id, inst: tr.inst, m, s: s + ev.frac, e: s + ev.frac + ev.len });
        });
      });
      for (const a of notes) {
        for (const b of notes) {
          if (a.tr === b.tr || !(melodic.has(a.inst) || melodic.has(b.inst)) || b.m <= a.m) continue;
          const d = b.m - a.m; // b is the upper note
          if (d !== 1 && d !== 13) continue;
          const from = Math.max(a.s, b.s);
          const ov = Math.min(a.e, b.e) - from;
          // an off-beat passing tone of an 8th or less over a held chord is fine; not when both are struck together
          if (ov <= 0 || (ov < 3 && from % 4 !== 0 && a.s !== b.s)) continue;
          bad.push(`${sec.name}@bar${Math.floor(from / 16) + 1}.${from % 16}: ${b.tr} ${b.m} over ${a.tr} ${a.m}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('stays in key: out-of-scale notes are only the song\'s deliberate colours', () => {
    const cs = compiled(id);
    const allowed = new Set(ALLOWED_CHROMATIC[id]);
    for (const sec of cs.sections) {
      const tonic = pc(cs.tonicPc + sec.transpose);
      const scale = scalePcs(tonic, cs.mode);
      cs.tracks.forEach((tr, ti) => {
        if (tr.isDrum) return;
        sec.events[ti]!.forEach((evs, s) => {
          for (const ev of evs ?? []) for (const m of ev.midi) {
            if (scale.has(pc(m))) continue;
            expect(allowed.has(pc(m - tonic)), `${sec.name}/${tr.id}@${s}: ${m} (+${pc(m - tonic)} from the tonic)`).toBe(true);
          }
        });
      });
    }
  });

  it('its pad/brass chord variety fits the engine\'s chord-loop cache (48) with headroom', () => {
    const cs = compiled(id);
    const loops = new Set<string>();
    for (const sec of cs.sections) {
      cs.tracks.forEach((tr, ti) => {
        if (tr.inst !== 'pad' && tr.inst !== 'brass') return;
        for (const evs of sec.events[ti]!) for (const ev of evs ?? []) loops.add(`${tr.inst}:${ev.midi.join(',')}`);
      });
    }
    expect(loops.size).toBeLessThanOrEqual(40);
  });

  it('a drum fill (toms or a snare run) closes every 8-bar phrase', () => {
    const cs = compiled(id);
    if (!cs.loop) return;
    const toms = trackIndex(cs, (t) => t.inst === 'tom');
    const snares = trackIndex(cs, (t) => t.inst === 'snare');
    const backbeat = trackIndex(cs, (t) => t.inst === 'snare' || t.inst === 'clap');
    for (const sec of cs.sections) {
      if (sec.bars < 8 || backbeat.every((ti) => eventCount(sec, ti) === 0)) continue;
      for (let bar = 7; bar < sec.bars; bar += 8) {
        const inBar = (ti: number): number => sec.events[ti]!.slice(bar * 16, bar * 16 + 16).reduce((a, e) => a + (e?.length ?? 0), 0);
        const tomHits = toms.reduce((a, ti) => a + inBar(ti), 0);
        const snareHits = snares.reduce((a, ti) => a + inBar(ti), 0);
        expect(tomHits > 0 || snareHits >= 4, `${sec.name} bar ${bar + 1} has no fill`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The brief, song by song
// ---------------------------------------------------------------------------------------------

describe('the brief', () => {
  it('title: 118–124 bpm minor theme; 16-bar build pads → bass → drums; hook chorus; final chorus a whole step up; loops', () => {
    const s = SONGS.title;
    expect(s.bpm).toBeGreaterThanOrEqual(118);
    expect(s.bpm).toBeLessThanOrEqual(124);
    expect(['aeolian', 'minor', 'dorian', 'harmonicMinor']).toContain(s.mode);
    const intro = ['introA', 'introB', 'introC', 'introD'];
    expect(s.form.slice(0, 4)).toEqual(intro);
    expect(intro.reduce((a, n) => a + s.sections[n]!.bars, 0)).toBe(16);
    expect(Object.keys(s.sections.introA!.play)).not.toContain('bass');
    expect(Object.keys(s.sections.introB!.play)).toContain('bass');
    expect(Object.keys(s.sections.introB!.play)).not.toContain('kick');
    expect(Object.keys(s.sections.introC!.play)).toContain('kick');
    expect(s.patterns[s.sections.chorus!.play.lead as string]).toBe(HOOK_LEAD);
    expect(s.sections.final!.transpose! - (s.sections.chorus!.transpose ?? 0)).toBe(2);
    expect(s.sections.final!.play.lead).toBe(s.sections.chorus!.play.lead);
    expect(s.loop ?? true).toBe(true);
    expect(s.form[s.loopTo ?? 0]).toBe('verse');
  });

  it('title hook: an 8-bar call/answer, rising sequence in bars 1–3, answer resolves to the tonic', () => {
    const lead = compiled('title').sections.find((x) => x.name === 'chorus')!;
    const ti = compiled('title').tracks.findIndex((t) => t.id === 'lead');
    const notes = lead.events[ti]!.flatMap((evs, s) => (evs ?? []).map((e) => ({ s, m: e.midi[0]! })));
    const firstOfBar = (b: number): number => notes.find((n) => n.s >= b * 16)!.m;
    expect(firstOfBar(1) - firstOfBar(0)).toBeGreaterThan(0); // the cell climbs by step…
    expect(firstOfBar(2) - firstOfBar(1)).toBeGreaterThan(0); // …three times
    expect(firstOfBar(4)).toBe(firstOfBar(0)); // the answer restates the call
    expect(pc(notes[notes.length - 1]!.m)).toBe(2); // and comes home to D
  });

  it('command: 96–104 bpm, loops every 32 bars, and its motif is the hook cell in augmentation', () => {
    const s = SONGS.command;
    expect(s.bpm).toBeGreaterThanOrEqual(96);
    expect(s.bpm).toBeLessThanOrEqual(104);
    const loopBars = s.form.slice(s.loopTo ?? 0).reduce((a, fe) => {
      const name = typeof fe === 'string' ? fe : fe.section;
      const rep = typeof fe === 'string' ? 1 : (fe.repeat ?? 1);
      return a + s.sections[name]!.bars * rep;
    }, 0);
    expect(loopBars).toBe(32);
    const leads = Object.values(s.sections).map((sec) => sec.play.lead).filter(Boolean).map((p) => s.patterns[p as string] as string);
    expect(leads.some((l) => l.includes(hookCellWide('F5', 'A5', 'B5')))).toBe(true);
  });

  it('match: 132–140 bpm; A / B / breakdown / C (modulated) sections; the hook returns in C', () => {
    const s = SONGS.match;
    expect(s.bpm).toBeGreaterThanOrEqual(132);
    expect(s.bpm).toBeLessThanOrEqual(140);
    for (const n of ['A', 'B', 'breakdown', 'C']) expect(s.form).toContain(n);
    expect(s.sections.C!.transpose).toBe(2);
    expect(s.sections.breakdown!.intensity!).toBeLessThan(0);
    expect(s.patterns[s.sections.C!.play.lead as string]).toBe(transpose(HOOK_LEAD, -5));
    const bars = s.form.reduce((a: number, fe) => a + s.sections[typeof fe === 'string' ? fe : fe.section]!.bars, 0);
    expect(bars).toBeGreaterThanOrEqual(96); // a long loop: a 10-minute match hears it ~3 times
  });

  it('match intensity layers: low = bass + pads + hats; mid adds drums and the arp; high adds lead, brass, crashes', () => {
    const cs = compiled('match');
    const A = cs.sections.find((x) => x.name === 'A')!;
    const active = (x: number): string[] => {
      const eff = effectiveIntensity(x, cs.intensityMin, cs.intensityMax, A.intensity);
      return cs.tracks.filter((t, ti) => eventCount(A, ti) > 0 && layerActive(false, eff, t.threshold)).map((t) => t.id).sort();
    };
    expect(active(0)).toEqual(['bass', 'hat', 'pad']);
    const mid = active(0.5);
    for (const t of ['kick', 'snare', 'arp']) expect(mid).toContain(t);
    for (const t of ['lead', 'brass', 'crash']) expect(mid).not.toContain(t);
    const high = active(1);
    for (const t of ['lead', 'brass', 'crash', 'bell', 'tom', 'clap']) expect(high).toContain(t);
  });

  it('boss: ≥ 140 bpm, dark mode, floor toms always on, and the payoff is the hook (E minor, then a semitone up)', () => {
    const s = SONGS.boss;
    expect(s.bpm).toBeGreaterThanOrEqual(140);
    expect(['phrygian', 'aeolian', 'harmonicMinor', 'locrian']).toContain(s.mode);
    const tom = s.tracks.find((t) => t.inst === 'tom')!;
    expect(effectiveIntensity(0, s.intensity!.min!, s.intensity!.max!, 0)).toBeGreaterThanOrEqual(0.35);
    expect(tom.layer).toBe('drums');
    expect(s.patterns[s.sections.payoff!.play.lead as string]).toBe(transpose(HOOK_LEAD, 2));
    expect(s.sections.payoff2!.transpose).toBe(1);
  });

  it('victory is a 4–8 bar one-shot that ends on a MAJOR tonic; defeat a 4–6 bar one-shot that ends on a minor one', () => {
    const last = (id: SongId): readonly number[] => {
      const cs = compiled(id);
      const sec = cs.sections[cs.timeline[cs.timeline.length - 1]!]!;
      const pad = cs.tracks.findIndex((t) => t.inst === 'pad');
      return soundingAt(sec, pad, sec.steps - 1)!;
    };
    const bars = (id: SongId): number => compiled(id).timeline.reduce((a, si) => a + compiled(id).sections[si]!.bars, 0);
    for (const id of ['victory', 'defeat'] as const) expect(SONGS[id].loop).toBe(false);
    expect(bars('victory')).toBeGreaterThanOrEqual(4);
    expect(bars('victory')).toBeLessThanOrEqual(8);
    expect(bars('defeat')).toBeGreaterThanOrEqual(4);
    expect(bars('defeat')).toBeLessThanOrEqual(6);
    const tonicA = 9;
    const vic = new Set(last('victory').map(pc));
    expect(vic.has(tonicA) && vic.has(pc(tonicA + 4))).toBe(true); // A major (C#)
    const def = new Set(last('defeat').map(pc));
    expect(def.has(tonicA) && def.has(pc(tonicA + 3))).toBe(true); // A minor (C)
  });
});

describe('stingers', () => {
  const ctx = (tonicPc: number, mode: 'aeolian' | 'phrygian' | 'dorian') => ({ tonicPc, mode, octave: 3, voicing: 'fold' as const, transpose: 0 });
  const firstChord = (steps: string, c: ReturnType<typeof ctx>): number[] => resolvePitch(steps.split(/\s+/)[0]!.replace(/[!?~]+$/, ''), c);

  it('waveStart waits for the beat, bossIncoming for the bar (2 bars long)', () => {
    expect(DEFAULT_STINGERS.waveStart.quantize).toBe('beat');
    expect(DEFAULT_STINGERS.bossIncoming.quantize).toBe('bar');
    for (const p of DEFAULT_STINGERS.bossIncoming.parts) expect(p.steps.replace(/\|/g, ' ').trim().split(/\s+/).length).toBe(32);
  });

  it('bossIncoming opens on a semitone cluster in every mode the songs use', () => {
    const brass = (st: typeof DEFAULT_STINGERS.bossIncoming): string => st.parts.find((p) => p.inst === 'brass')!.steps;
    for (const [tonic, mode] of [[2, 'aeolian'], [9, 'aeolian'], [2, 'dorian']] as const) {
      const [a, b] = firstChord(brass(DEFAULT_STINGERS.bossIncoming), ctx(tonic, mode));
      expect(b! - a!).toBe(1);
    }
    const [a, b] = firstChord(brass(PHRYGIAN_STINGERS.bossIncoming!), ctx(4, 'phrygian'));
    expect(b! - a!).toBe(1);
    expect(SONGS.boss.stingers?.bossIncoming).toBe(PHRYGIAN_STINGERS.bossIncoming);
    expect(MODES[SONGS.boss.mode][1]).toBe(1); // phrygian's 2nd IS the minor 2nd
  });

  it('in the real sequencer, bossIncoming lands on the match\'s next bar line and waveStart on its next beat', () => {
    for (const [id, gridBeats] of [['bossIncoming', 4], ['waveStart', 1]] as const) {
      const { fake, ctx: ac } = fakeCtx();
      const seq = new Sequencer(new SynthCore(ac));
      seq.setIntensity(1, true);
      const cs = compiled('match');
      seq.play(cs, 0);
      const at = 5.013;
      for (let t = 0; t <= at + 1e-9; t += 0.025) { fake.currentTime = t; seq.pump(t); }
      const n0 = fake.starts.length;
      seq.stinger(DEFAULT_STINGERS[id], at);
      const added = fake.starts.slice(n0).filter((s) => s.kind === 'buffer');
      expect(added.length).toBeGreaterThan(0);
      const first = Math.min(...added.map((s) => s.t));
      const grid = (60 / cs.bpm) * gridBeats;
      const k = (first - 0.08) / grid; // the song's origin is 0.08 s after play()
      expect(Math.abs(k - Math.round(k)), id).toBeLessThan(1e-6);
      expect(first).toBeGreaterThanOrEqual(at);
      expect(first - at).toBeLessThan(grid + 1e-6);
    }
  });
});
