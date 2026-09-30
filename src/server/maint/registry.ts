// OWNER: SERVER MODERATION (LAN task B5). Every op the maintenance worker knows:
//   CORE_OPS  (ops.ts)      backups, restore staging, the deletion ledger, disk, the FTS tidy, compaction
//   QUERY_OPS (queries.ts)  B8a: log, search, context, rooms, stats, conduct, exports
//   WRITE_OPS (writes.ts)   B8b: purges, retention pruning, deletion, address minimisation, wellbeing clears
// Names are '<area>.<verb>'; a later table must not reuse an earlier name (checked here at load).
import { CORE_OPS, type OpTable } from './ops';
import { QUERY_OPS } from './queries';
import { WRITE_OPS } from './writes';

function merge(...tables: OpTable[]): OpTable {
  const out: Record<string, OpTable[string]> = {};
  for (const t of tables) {
    for (const [k, v] of Object.entries(t)) {
      if (Object.prototype.hasOwnProperty.call(out, k)) throw new Error(`maint op "${k}" is defined twice`);
      out[k] = v;
    }
  }
  return out;
}

export const MAINT_OPS: OpTable = Object.freeze(merge(CORE_OPS, QUERY_OPS, WRITE_OPS));
