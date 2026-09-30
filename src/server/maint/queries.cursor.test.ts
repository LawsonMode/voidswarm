// A partial page's cursor (nextBefore / nextBeforeTs) must never name a line the caller may not see: a SELF-HARM line
// when includeSelfHarm is false (a moderator). Comparing cursors with the ids they can see would tell a moderator that
// a named student wrote a hidden line, and when (the M1 gate's fix of the B8a verifier finding). Paging on must still
// find every visible line exactly once.
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatLogEntry } from '../../shared/room/moderation';
import { ModStore } from '../moderation/store';
import { searchChatLog, type LogQuery } from './queries';
import { addAccount, open, tmpData, type TmpData } from './testutil';

const T0 = Date.UTC(2026, 8, 28, 14, 0, 0);
let t: TmpData;
let db: DatabaseSync;
let store: ModStore;
const hidden: number[] = [];

beforeAll(() => {
  t = tmpData('vs-cursor-');
  store = new ModStore(t.db, { log: () => {} });
  db = open(t.db);
  addAccount(db, { id: 'acc-x', username: 'NovaPilot' });
  for (let i = 0; i < 400; i++) {
    // Every 37th line a review-only SELF-HARM line (the generated, neutral test label, never real words).
    const wb = i % 37 === 5;
    const text = wb ? 'generated review wellbeing words' : `line ${i} words`;
    store.logChat({
      time: T0 + i * 1000, roomId: 'r1', roomName: 'R', roomUid: 'b:r1', channel: 'all', team: -1, playerId: 1, name: 'NovaPilot', accountId: 'acc-x',
      address: '10.0.0.5', original: text, shown: text, action: wb ? 'flag' : 'pass', hits: wb ? ['flag:selfharm:x'] : [], display: 'as-typed',
    } as ChatLogEntry);
    store.flushAll();
    if (wb) hidden.push(Number((db.prepare('SELECT max(id) AS m FROM chat_log').get() as { m: number }).m));
  }
});
afterAll(() => { try { store.close(); } catch { /* closed */ } db.close(); t.cleanup(); });

describe('partial pages never hand back a hidden line as their cursor', () => {
  const cases: [string, LogQuery][] = [
    ['person plan', { accountId: 'acc-x' }],
    ['person plan with a text nobody typed', { accountId: 'acc-x', q: 'zzqxv' }],
    ['FTS plan (shown text)', { q: 'words', searchIn: 'shown' }],
  ];
  for (const [label, q] of cases) {
    it(label, () => {
      expect(hidden.length).toBeGreaterThan(5);
      const exact = searchChatLog(db, { ...q, limit: 1000, includeSelfHarm: false }).lines.map((l) => l.id);
      for (const w of [1, 2, 3, 5, 7, 11, 13]) {
        let before: number | undefined;
        let beforeTs: number | undefined;
        const got: number[] = [];
        let partials = 0;
        for (let k = 0; k < 4000; k++) {
          const p = searchChatLog(db, { ...q, before, beforeTs, limit: 100, includeSelfHarm: false },
            { maxMs: 1e9, windowIds: w, maxWindows: 1, includeSelfHarmDefault: false });
          got.push(...p.lines.map((l) => l.id));
          if (p.nextBefore === null) break;
          if (p.partial) partials++;
          expect(hidden, `${label}, window ${w}: cursor ${p.nextBefore}`).not.toContain(p.nextBefore);
          before = p.nextBefore;
          beforeTs = p.nextBeforeTs ?? undefined;
        }
        expect(partials, `${label}, window ${w}`).toBeGreaterThan(0);
        // Nothing lost, nothing twice, nothing hidden.
        expect(got, `${label}, window ${w}`).toEqual(exact);
      }
    });
  }
});
