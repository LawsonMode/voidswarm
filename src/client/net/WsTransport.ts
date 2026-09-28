import { decodeSnapshot } from '../../shared/net/codec';
import type { ClientMsg, ServerMsg } from '../../shared/protocol';
import type { Snapshot } from '../../shared/types';
import type { Transport } from './transport';

const CONNECT_TIMEOUT_MS = 7000;

/** JSON text frames for messages; binary frames are snapshots (decodeSnapshot). */
export class WsTransport implements Transport {
  readonly kind = 'online' as const;
  onMessage: ((msg: ServerMsg) => void) | null = null;
  onSnapshot: ((s: Snapshot) => void) | null = null;
  onClose: ((reason: string, code?: number) => void) | null = null;
  private ws: WebSocket | null = null;
  private closedByUs = false;
  private decodeErrors = 0;

  constructor(readonly url: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.url);
      } catch (e) {
        reject(new Error(`Bad server URL: ${this.url}`));
        return;
      }
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.closedByUs = true;
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error(`Timed out connecting to ${this.url}`));
      }, CONNECT_TIMEOUT_MS);
      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Could not connect to ${this.url}`));
      };
      ws.onclose = (ev) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(new Error(`Connection to ${this.url} closed (${ev.code})`));
          return;
        }
        if (!this.closedByUs) this.onClose?.(ev.reason || `Connection lost (code ${ev.code})`, ev.code);
      };
      ws.onmessage = (ev) => this.receive(ev.data);
    });
  }

  private receive(data: unknown): void {
    if (typeof data === 'string') {
      let msg: ServerMsg;
      try { msg = JSON.parse(data) as ServerMsg; } catch { return; }
      this.onMessage?.(msg);
    } else if (data instanceof ArrayBuffer) {
      let snap: Snapshot;
      try {
        snap = decodeSnapshot(data);
      } catch (e) {
        if (this.decodeErrors++ < 3) console.error('[voidswarm] snapshot decode failed', e);
        return;
      }
      this.onSnapshot?.(snap);
    }
  }

  send(msg: ClientMsg): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
  }

  close(): void {
    this.closedByUs = true;
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
  }
}
