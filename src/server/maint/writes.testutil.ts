// OWNER: SERVER MODERATION (LAN task B8b). Test fixture (imported by *.test.ts only): a real maintenance worker whose
// op table has QUERY_OPS and WRITE_OPS. Once registry.ts spreads both into MAINT_OPS (handoff to B5) the default
// worker is used; until then a small entry module in the test's scratch folder runs the same runMaintWorker with
// { ...MAINT_OPS, ...QUERY_OPS, ...WRITE_OPS }.
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultWorkerFile, MaintClient, type MaintClientOptions } from './client';
import { MAINT_OPS } from './registry';

const here = (f: string): string => pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), f)).href;
const has = (op: string): boolean => Object.prototype.hasOwnProperty.call(MAINT_OPS, op);

/** True when registry.ts already carries the query and write ops. */
export const registryHasWrites = (): boolean => has('log.search') && has('purge.chat');

/** Start a worker on `t.db` (data folder `t.dir`) whose op table includes QUERY_OPS and WRITE_OPS. */
export async function startWriteWorker(t: { dir: string; db: string }, opts: Partial<MaintClientOptions> = {}): Promise<MaintClient> {
  if (registryHasWrites()) return MaintClient.start({ dataDir: t.dir, dbPath: t.db, ...opts });
  const entry = path.join(t.dir, 'maint-writes-worker.mjs');
  fs.writeFileSync(entry, [
    "import { workerData, parentPort } from 'node:worker_threads';",
    'const init = workerData.maint;',
    'delete workerData.maint; // worker.ts must not start its own copy on import',
    `const { runMaintWorker } = await import(${JSON.stringify(here('worker.ts'))});`,
    `const { MAINT_OPS } = await import(${JSON.stringify(here('registry.ts'))});`,
    `const { QUERY_OPS } = await import(${JSON.stringify(here('queries.ts'))});`,
    `const { WRITE_OPS } = await import(${JSON.stringify(here('writes.ts'))});`,
    'runMaintWorker({ postMessage: (m) => parentPort.postMessage(m), on: (e, cb) => parentPort.on(e, cb), off: (e, cb) => parentPort.off(e, cb) },',
    '  init, { ...MAINT_OPS, ...QUERY_OPS, ...WRITE_OPS });',
    '',
  ].join('\n'), 'utf8');
  return MaintClient.start({ dataDir: t.dir, dbPath: t.db, workerFile: pathToFileURL(entry), execArgv: defaultWorkerFile().execArgv ?? [], ...opts });
}
