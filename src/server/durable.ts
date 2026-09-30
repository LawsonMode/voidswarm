// OWNER: SERVER. fsync where it is allowed.
//
// Node 24's permission model (the LAN child and its maintenance process run under --permission, §2.2) disables the
// synchronous fsync family: fs.fsyncSync / fdatasyncSync (and writeFileSync's `flush`) throw ERR_ACCESS_DENIED
// ("fsync API is disabled when Permission Model is enabled"; measured on 24.16.0), while FileHandle.sync() still
// works. The atomic writers here are synchronous (temp file, fsync, rename), so inside the sandbox they keep the temp
// + rename (a reader never sees half a file; the settings file also keeps its .bak) and skip the flush to disk.
import * as fs from 'node:fs';

let disabled = false;

/** True once an fsync was refused by the permission model (this process then stops trying). */
export const fsyncDisabled = (): boolean => disabled;

/**
 * fs.fsyncSync(fd), unless the permission model disables it: then false (nothing thrown). Other errors are thrown.
 * `sync` is injectable for tests and for callers with their own fs layer.
 */
export function fsyncBestEffort(fd: number, sync: (fd: number) => void = fs.fsyncSync): boolean {
  if (disabled && sync === fs.fsyncSync) return false;
  try {
    sync(fd);
    return true;
  } catch (e) {
    if ((e as { code?: unknown })?.code === 'ERR_ACCESS_DENIED') {
      if (sync === fs.fsyncSync) disabled = true;
      return false;
    }
    throw e;
  }
}
