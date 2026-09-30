// T-ROOM-5 (docs/LAN-EDITION-proposal.md §11.8): no Math.random in the sim, and none in the Zone's chat pipeline.
// The determinism smoke (`npm run smoke -- --mode all`) and the parity tests (src/shared/ai/*Parity.test.ts) are the
// other half of T-ROOM-5; they run on their own.
//
// Room.ts and util.ts still draw room-side randomness (bot callsigns, bot chatter, bot seeds / classes, map seeds,
// dedupe suffixes) from Math.random on purpose: the smoke and the parity gates make those draws reproducible by
// seeding Math.random itself (smoke.ts `seededRandom`). Moving them to an injected Rng needs the smoke to seed that
// instead, so for now they are a ratchet: the count may only go down.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Code without comments (block comments, and line comments that start a line or follow whitespace). */
const code = (file: string): string => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
const uses = (file: string): number => (code(file).match(/Math\.random/g) ?? []).length;
const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) return sources(p);
  return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
});

/** Room-side draws that the smoke seeds through Math.random (see the header). Lower these as they move to an Rng. */
const RATCHET: Readonly<Record<string, number>> = { 'Room.ts': 18, 'util.ts': 2 };

describe('T-ROOM-5: no Math.random in src/shared/sim or the room chat pipeline', () => {
  it('src/shared/sim never calls Math.random', () => {
    const files = sources(path.join(ROOT, 'sim'));
    expect(files.length).toBeGreaterThan(10);
    const offenders = files.filter((f) => uses(f) > 0).map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it('src/shared/room: none outside the ratcheted room-side draws (Zone.ts and moderation.ts: none at all)', () => {
    const files = sources(path.join(ROOT, 'room'));
    expect(files.map((f) => path.basename(f))).toEqual(expect.arrayContaining(['Zone.ts', 'Room.ts', 'moderation.ts', 'util.ts']));
    for (const f of files) {
      const name = path.basename(f);
      expect(uses(f), name).toBeLessThanOrEqual(RATCHET[name] ?? 0);
    }
    expect(uses(path.join(ROOT, 'room', 'Zone.ts'))).toBe(0);
    expect(uses(path.join(ROOT, 'room', 'moderation.ts'))).toBe(0);
  });
});
