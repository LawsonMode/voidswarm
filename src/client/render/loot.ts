// In-world loot caches, carrier pips, radar dots/beacons and loot event FX (RENDER agent, v0.3 M2).
// Drawn by GameRenderer: `batch` (a SpriteBatch on the loot.pc ParticleContainer, right after gems.pc)
// for the crates, the renderer's additive dynG for dashed reservation rings and carrier pips.
// Rarity colours (RARITY_COLORS) are UI / cache-glow only, never ship accents.
import type { Graphics } from 'pixi.js';
import type { RenderFrame } from '../contracts';
import { LOOT_BEACON_COUNT, LOOT_BEACON_RARITY } from '../../shared/constants';
import { RARITY_COLORS } from '../../shared/data/loot';
import type { CarryView, EntityId, GameEvent, LootSet, LootView, PlayerId } from '../../shared/types';
import type { SpriteBatch } from './particles';
import type { Atlas } from './textures';
import { brighten } from './palette';

/** Beam height (px) by rarity: rare / epic / legendary only. */
export const LOOT_BEAM_H: readonly number[] = [0, 0, 120, 220, 320];
/** Crate sprite size (px). */
export const LOOT_CRATE_PX = 24;
const TAU = Math.PI * 2;

export interface ShipAnchor { x: number; y: number; r: number; alpha: number; ally: boolean; cloaked: boolean }

/** What the loot layer needs from the renderer (keeps loot.ts free of GameRenderer internals). */
export interface LootHost {
  inView(x: number, y: number, margin: number): boolean;
  playerColor(frame: RenderFrame, pid: PlayerId): number;
  /** Display position/radius/root alpha of a live ship (null if not drawn). */
  shipAnchor(shipId: EntityId): ShipAnchor | null;
  /** Live ship id of a player (0 = none). */
  shipOfPlayer(pid: PlayerId): EntityId;
  ring(x: number, y: number, r0: number, r1: number, life: number, color: number, width: number, follow?: EntityId): void;
  burst(x: number, y: number, n: number, color: number, spMin: number, spMax: number, life: number, scale: number, dots?: boolean): void;
  flash(x: number, y: number, size: number, color: number, life: number, alpha: number): void;
  impulse(x: number, y: number, radius: number, strength: number): void;
}

export const isBeacon = (c: CarryView): boolean => c.n >= LOOT_BEACON_COUNT || c.best >= LOOT_BEACON_RARITY;

export class LootLayer {
  constructor(private readonly A: Atlas, readonly batch: SpriteBatch) {}

  /** Crates (sprites) + reservation rings (dynG). */
  draw(frame: RenderFrame, t: number, g: Graphics, host: LootHost): void {
    const b = this.batch;
    b.begin();
    const loot = frame.loot;
    if (loot) for (const lv of loot) this.drawCrate(lv, frame, t, g, host);
    b.end();
  }

  private drawCrate(lv: LootView, frame: RenderFrame, t: number, g: Graphics, host: LootHost): void {
    const r = Math.max(0, Math.min(4, lv.rarity | 0));
    const beamH = LOOT_BEAM_H[r];
    if (!host.inView(lv.x, lv.y, beamH + 40)) return;
    const b = this.batch, A = this.A;
    const col = RARITY_COLORS[r];
    const ph = (lv.id % 97) * 0.77;
    let a = 1;
    const reservedElse = lv.reservedFor !== 0 && lv.reservedFor !== frame.localPlayerId;
    if (reservedElse) a *= 0.5;
    if (lv.lifeFrac < 0.1 && Math.floor(t * 8) % 2) a *= 0.3;
    const x = lv.x, y = lv.y + Math.sin(t * 2.2 + ph) * 3;
    const pulse = 0.85 + 0.15 * Math.sin(t * 3 + ph);
    // rarity glow
    const gs = 0.55 + 0.12 * r;
    b.put(A.soft, x, y, 0, gs, gs, col, (0.3 + 0.06 * r) * pulse * a);
    // loot beam (rare+)
    if (beamH > 0) {
      const bw = 0.45 + 0.12 * (r - 2);
      b.put(A.beam, x, y - beamH / 2, 0, bw, beamH / 64, col, (0.32 + 0.1 * (r - 2)) * (0.8 + 0.2 * Math.sin(t * 4 + ph)) * a);
    }
    // ring pulse (epic+)
    if (r >= 3) {
      const cyc = (t * (r === 4 ? 1.1 : 0.8) + ph) % 1;
      const s = 0.35 + 0.65 * cyc;
      b.put(A.ring, x, y, 0, s, s, col, (1 - cyc) * 0.7 * a);
    }
    // the crate itself (24 px) + set mark
    const cs = LOOT_CRATE_PX / 32;
    b.put(A.hexCrate, x, y, t * 0.8 + ph, cs, cs, brighten(col, 0.25), a);
    const mark = setMark(lv.set);
    if (mark) { const ms = mark === 'ring' ? 0.17 : 0.32; b.put(A[mark], x, y, -t * 1.2 + ph, ms, ms, 0xffffff, 0.75 * a); }
    // reservation: dashed ring in the reserver's colour
    if (lv.reservedFor !== 0) {
      const rc = host.playerColor(frame, lv.reservedFor);
      const rr = 19, rot = t * 1.4 + ph;
      for (let i = 0; i < 8; i++) {
        const a0 = rot + (i * TAU) / 8;
        g.moveTo(x + Math.cos(a0) * rr, y + Math.sin(a0) * rr).arc(x, y, rr, a0, a0 + TAU / 16);
      }
      g.stroke({ width: 1.6, color: rc, alpha: 0.85 * a });
    }
  }

  /** Carrier pips at r + 16 above every carrying ship, plus a beacon ring on beacon carriers (dynG). */
  drawCarriers(frame: RenderFrame, t: number, g: Graphics, host: LootHost): void {
    const carry = frame.carry;
    if (!carry) return;
    for (const cv of carry) {
      if (cv.n <= 0) continue;
      const s = host.shipAnchor(cv.shipId);
      if (!s) continue;
      if (!s.ally && s.alpha < 0.2) continue; // never weaken cloak / invulnerability blink
      const count = Math.min(cv.n, 12);
      const R = s.r + 16;
      const step = 0.26;
      const best = RARITY_COLORS[Math.max(0, Math.min(4, cv.best | 0))];
      for (let i = 0; i < count; i++) {
        const ang = -Math.PI / 2 + (i - (count - 1) / 2) * step;
        const px = s.x + Math.cos(ang) * R, py = s.y + Math.sin(ang) * R;
        const mid = i === ((count - 1) >> 1);
        g.circle(px, py, mid ? 3.2 : 2.1).fill({ color: mid ? best : RARITY_COLORS[0], alpha: (mid ? 1 : 0.75) * s.alpha });
      }
      if (cv.n > 12) g.circle(s.x, s.y - R - 7, 1.6).fill({ color: 0xffffff, alpha: 0.8 * s.alpha });
      if (isBeacon(cv)) {
        const p = 0.5 + 0.5 * Math.sin(t * 5 + cv.shipId);
        g.circle(s.x, s.y, s.r + 24 + p * 4).stroke({ width: 1.4, color: best, alpha: (0.25 + 0.35 * p) * s.alpha });
      }
    }
  }

  /** Radar / big-map layer: rare+ caches (epic+ pulsing) and beacon carriers. `sx/sy` = map px → radar px. */
  drawRadar(frame: RenderFrame, g: Graphics, ox: number, oy: number, sx: number, sy: number, big: boolean, t: number, host: LootHost): void {
    const loot = frame.loot;
    const pulse = 0.5 + 0.5 * Math.sin(t * 6);
    if (loot) {
      for (const lv of loot) {
        if (lv.rarity < 2) continue;
        const x = ox + lv.x * sx, y = oy + lv.y * sy;
        const epic = lv.rarity >= 3;
        const s = (big ? 2.6 : 1.7) * (epic ? 1 + 0.35 * pulse : 1);
        g.poly([x, y - s, x + s, y, x, y + s, x - s, y], true).fill({ color: RARITY_COLORS[lv.rarity], alpha: epic ? 0.55 + 0.45 * pulse : 0.9 });
      }
    }
    const carry = frame.carry;
    if (carry) {
      for (const cv of carry) {
        if (!isBeacon(cv)) continue;
        const s = host.shipAnchor(cv.shipId);
        if (!s || (s.cloaked && !s.ally)) continue;
        const x = ox + s.x * sx, y = oy + s.y * sy;
        const rr = (big ? 7 : 4.5) + pulse * (big ? 3 : 2);
        g.circle(x, y, rr).stroke({ width: big ? 1.6 : 1.1, color: RARITY_COLORS[Math.max(0, Math.min(4, cv.best | 0))], alpha: 0.45 + 0.5 * pulse });
      }
    }
  }

  /** Loot event FX (lootDrop / lootPickup / lootSpill / lootSecured). */
  event(ev: GameEvent, frame: RenderFrame, host: LootHost): void {
    switch (ev.t) {
      case 'lootDrop': {
        if (!host.inView(ev.x, ev.y, 240)) break;
        const r = ev.rarity, col = RARITY_COLORS[r];
        host.ring(ev.x, ev.y, 6, 40 + 18 * r, 0.45, col, 2 + 0.5 * r);
        host.burst(ev.x, ev.y, 6 + 4 * r, col, 60, 180 + 60 * r, 0.5, 0.4, true);
        host.flash(ev.x, ev.y, 0.5 + 0.25 * r, col, 0.25, 0.8);
        if (r >= 3) {
          host.ring(ev.x, ev.y, 10, 160 + 70 * (r - 3), 0.7, 0xffffff, 2);
          host.impulse(ev.x, ev.y, 160, 320);
        }
        break;
      }
      case 'lootPickup': {
        const col = RARITY_COLORS[ev.rarity];
        const s = host.shipAnchor(ev.shipId);
        // Root-alpha rule: no FX for a pickup by a ship we don't draw (a hidden cloaker: ships are otherwise always
        // sent) or by a cloaked / blinking non-ally below 0.2 alpha. A burst there, or a ring riding the ship, would
        // show where the cloaker is.
        if (!s || (!s.ally && (s.cloaked || s.alpha < 0.2))) break;
        if (host.inView(ev.x, ev.y, 80)) {
          host.burst(ev.x, ev.y, 8 + 2 * ev.rarity, col, 40, 160, 0.35, 0.35, true);
          host.flash(ev.x, ev.y, 0.5, col, 0.18, 0.8);
        }
        host.ring(s.x, s.y, 8, s.r + 26, 0.35, col, ev.playerId === frame.localPlayerId ? 2.6 : 1.6, ev.shipId);
        break;
      }
      case 'lootSpill': {
        if (!host.inView(ev.x, ev.y, 240)) break;
        const col = RARITY_COLORS[ev.best];
        host.burst(ev.x, ev.y, 8 + 3 * Math.min(12, ev.count), col, 80, 320, 0.6, 0.45, true);
        host.ring(ev.x, ev.y, 10, 90 + 6 * Math.min(12, ev.count), 0.45, col, 2.5);
        break;
      }
      case 'lootSecured': {
        const sid = host.shipOfPlayer(ev.playerId);
        const s = sid ? host.shipAnchor(sid) : null;
        if (!s) break;
        let best = 0;
        for (const tk of ev.tokens) best = Math.max(best, tk.rarity);
        host.ring(s.x, s.y, s.r + 40, 6, 0.5, RARITY_COLORS[best], 3, sid);
        host.ring(s.x, s.y, 8, s.r + 60, 0.6, 0xffffff, 1.5, sid);
        break;
      }
      default: break;
    }
  }
}

function setMark(set: LootSet): 'ring' | 'diamond' | 'hexCrate' | null {
  switch (set) {
    case 'rift': return 'ring';
    case 'gladiator': return 'diamond';
    case 'swarm': return 'hexCrate';
    default: return null;
  }
}
