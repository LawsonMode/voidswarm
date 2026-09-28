import type { ClientMsg, ServerMsg } from '../../shared/protocol';
import type { Snapshot } from '../../shared/types';

/** A connection to a Zone — over WebSocket (online) or in-page (offline). */
export interface Transport {
  readonly kind: 'online' | 'offline';
  /** Resolves once the connection is open (rejects on failure). */
  connect(): Promise<void>;
  send(msg: ClientMsg): void;
  onMessage: ((msg: ServerMsg) => void) | null;
  onSnapshot: ((s: Snapshot) => void) | null;
  /**
   * Unexpected close (not fired for an explicit close()). `code` = the WebSocket close code when known
   * (WS_CLOSE_KICKED = the server ended the session on purpose; `reason` is then its message).
   */
  onClose: ((reason: string, code?: number) => void) | null;
  close(): void;
}
