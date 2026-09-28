// AudioFx — synthesized WebAudio SFX (RENDER agent). No asset files. Implements IAudioFx.
// v0.2: per-skill sounds + resonance-driven laser hum loops (fed by render/beamBus, no contract change).
// v0.3 M2: loot SFX — lootDrop chime pitched by rarity, pickup, spill, secured — and UI blips
// 'reveal' / 'reveal-epic' / 'reveal-legendary' / 'equip' (debrief crates, Hangar).
// v0.3 M3: objective SFX (global events, never silent, panned): flag taken (siren when it is YOUR flag) / dropped /
// returned / captured (fanfare or loss), zone captured / neutralized, hot point moving (warn) / moved / armed
// (the armed pulse comes over render/beamBus), overtime and sudden death. "Ours" uses beamBus.localTeam.
// v0.3 M4: rift SFX — arming klaxon / seal slam / clear chime / regroup reset, chest open, portal open, departing,
// descend (floorStart), extract, boss intro roar / phase roar, telegraph warn, spawn rumble, life lost, out of lives,
// party wiped, instability, run end — plus a looping portal hum for the nearest open portal (render/beamBus).
import type { IAudioFx } from '../contracts';
import { NO_TEAM } from '../../shared/constants';
import {
  BEAM_LASER, BEAM_WELD, type DeployableKind, type EntityId, type GameEvent, type PlayerId, type Rarity, type SkillId, type TeamId,
} from '../../shared/types';
import { beamBus } from '../render/beamBus';

const HEAR_DIST = 1600;
const MAX_VOICES = 24;
const MAX_HUMS = 3;

type Kind =
  | 'autocannon' | 'plasma' | 'rivet' | 'gun' | 'explode' | 'pop' | 'gem' | 'level' | 'attach' | 'detach' | 'hit' | 'death'
  | 'wave' | 'nova' | 'arc' | 'heal' | 'blink' | 'deploy' | 'deployDeath'
  | 'rockets' | 'ram' | 'ironhide' | 'singularity' | 'sentry' | 'repair' | 'wall' | 'talent'
  | 'lootDrop' | 'lootPickup' | 'lootSpill' | 'lootSecured'
  | 'flagTaken' | 'flagDropped' | 'flagReturned' | 'flagCaptured' | 'zoneCaptured' | 'zoneNeutralized'
  | 'hotWarn' | 'hotMoved' | 'hotArmed' | 'overtime'
  | 'roomArming' | 'roomSeal' | 'roomClear' | 'roomReset' | 'chestOpen' | 'portalOpen' | 'departing' | 'descend'
  | 'extract' | 'bossIntro' | 'bossPhase' | 'telegraph' | 'spawnWarn' | 'lifeLost' | 'outOfLives' | 'partyWiped'
  | 'instability' | 'riftEnd';

/** Minimum seconds between two sounds of the same kind. */
const RATE: Record<Kind, number> = {
  autocannon: 0.05, plasma: 0.04, rivet: 0.03, gun: 0.035, explode: 0.05, pop: 0.03, gem: 0.04, level: 0.2,
  attach: 0.1, detach: 0.1, hit: 0.08, death: 0.08, wave: 1, nova: 0.1, arc: 0.06, heal: 0.09, blink: 0.08,
  deploy: 0.1, deployDeath: 0.08, rockets: 0.1, ram: 0.15, ironhide: 0.15, singularity: 0.15, sentry: 0.12,
  repair: 0.2, wall: 0.15, talent: 0.1,
  lootDrop: 0.08, lootPickup: 0.06, lootSpill: 0.15, lootSecured: 0.3,
  flagTaken: 0.3, flagDropped: 0.25, flagReturned: 0.3, flagCaptured: 0.8, zoneCaptured: 0.4, zoneNeutralized: 0.3,
  hotWarn: 1, hotMoved: 1, hotArmed: 1, overtime: 2,
  roomArming: 0.5, roomSeal: 0.5, roomClear: 0.6, roomReset: 0.6, chestOpen: 0.12, portalOpen: 0.5, departing: 1,
  descend: 1.5, extract: 0.3, bossIntro: 2, bossPhase: 1, telegraph: 0.2, spawnWarn: 0.25, lifeLost: 0.3,
  outOfLives: 0.5, partyWiped: 2, instability: 3, riftEnd: 2,
};

/** The rift events AudioFx voices (all but none: every RiftGameEvent type). */
export type RiftSfxEvent = Extract<GameEvent['t'],
  'roomSeal' | 'roomClear' | 'roomReset' | 'spawnWarn' | 'chestOpen' | 'bossIntro' | 'bossPhase' | 'telegraph' | 'portalOpen'
  | 'departing' | 'floorStart' | 'lifeLost' | 'outOfLives' | 'extract' | 'partyWiped' | 'instability' | 'riftEnd'>;

/** Rift event → the rate-gate kind it plays under (roomSeal splits by `sec`: arming klaxon vs seal slam). */
export const RIFT_SFX: Readonly<Record<RiftSfxEvent, Kind>> = {
  roomSeal: 'roomSeal', roomClear: 'roomClear', roomReset: 'roomReset', spawnWarn: 'spawnWarn', chestOpen: 'chestOpen',
  bossIntro: 'bossIntro', bossPhase: 'bossPhase', telegraph: 'telegraph', portalOpen: 'portalOpen', departing: 'departing',
  floorStart: 'descend', lifeLost: 'lifeLost', outOfLives: 'outOfLives', extract: 'extract', partyWiped: 'partyWiped',
  instability: 'instability', riftEnd: 'riftEnd',
};

/** Hum loop kind for rift portals (makeHum). */
const HUM_PORTAL = 100;
/** Portal hum audible within this distance (px). */
export const PORTAL_HEAR = 1400;

/** Objective event → the rate-gate kind it plays under (exported for tests). */
export const OBJECTIVE_SFX: Readonly<Record<Extract<GameEvent, { t: 'objective' }>['kind'], Kind>> = {
  flagTaken: 'flagTaken', flagDropped: 'flagDropped', flagReturned: 'flagReturned', flagCaptured: 'flagCaptured',
  zoneCaptured: 'zoneCaptured', zoneNeutralized: 'zoneNeutralized', hotWarn: 'hotWarn', hotMoved: 'hotMoved',
  overtime: 'overtime', suddenDeath: 'overtime',
};

/** Loot chime root per rarity (C5 E5 G5 C6 E6): higher = rarer. */
export const LOOT_PITCH: readonly number[] = [523.25, 659.25, 783.99, 1046.5, 1318.5];

type Sp = { g: number; p: number };

interface Hum {
  id: number;
  gain: GainNode; pan: StereoPannerNode; filter: BiquadFilterNode;
  o1: OscillatorNode; o2: OscillatorNode; lfo: OscillatorNode; lfoGain: GainNode;
  kind: number; alive: boolean;
}

export class AudioFx implements IAudioFx {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private comp!: DynamicsCompressorNode;
  private noiseBuf!: AudioBuffer;
  private volume = 0.7;
  private voices = 0;
  private last: Partial<Record<Kind, number>> = {};
  private gemCombo = 0;
  private gemLast = 0;
  /** Local player id, learned from shipSpawn/shipDeath events carrying localShipId (0 = unknown). */
  private localPid = 0;
  private hums = new Map<number, Hum>();
  private humTimer = 0;
  /** Last beamBus.hotArmSeq seen (-1 = not synced yet: a pulse from before unlock never plays). */
  private hotArmSeen = -1;
  /** v0.3 M4: the looping hum of the nearest open rift portal (null = silent). */
  private portalHum: Hum | null = null;
  /** Test / debug: a portal hum is playing. */
  get portalHumOn(): boolean { return this.portalHum !== null; }

  unlock(): void {
    if (!this.ctx) {
      const AC: typeof AudioContext | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      this.ctx = ctx;
      this.comp = ctx.createDynamicsCompressor();
      this.comp.threshold.value = -18;
      this.comp.knee.value = 12;
      this.comp.ratio.value = 6;
      this.comp.attack.value = 0.003;
      this.comp.release.value = 0.2;
      this.master = ctx.createGain();
      this.master.gain.value = this.volume;
      this.comp.connect(this.master).connect(ctx.destination);
      const len = ctx.sampleRate * 1.5;
      this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.humTimer = window.setInterval(() => this.updateHums(), 50);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setVolume(master: number): void {
    this.volume = Math.max(0, Math.min(1, master));
    if (this.ctx) this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
  }

  // ------------------------------------------------------------------------------------------
  playEvents(events: GameEvent[], lx: number, ly: number, localShipId: EntityId): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || this.volume <= 0) return;
    for (const ev of events) {
      if ((ev.t === 'shipSpawn' || ev.t === 'shipDeath') && ev.shipId === localShipId && localShipId) this.localPid = ev.playerId;
    }
    // hot point armed (renderer pulse over the bus; stale pulses from before this session are skipped)
    if (beamBus.hotArmSeq !== this.hotArmSeen) {
      const fresh = this.hotArmSeen >= 0 && performance.now() - beamBus.hotArmAt < 600;
      this.hotArmSeen = beamBus.hotArmSeq;
      if (fresh) this.hotArmed();
    }
    let pops = 0;
    for (const ev of events) {
      switch (ev.t) {
        case 'fire': {
          const sp = this.spatial(ev.x, ev.y, lx, ly); if (!sp) break;
          this.primary(ev.skill, sp, ev.shipId === localShipId);
          break;
        }
        case 'ability': {
          const sp = this.spatial(ev.x, ev.y, lx, ly); if (!sp) break;
          if (ev.talent) this.talent(ev.talent, sp);
          else this.skill(ev.skill, sp);
          break;
        }
        case 'explode': {
          const sp = this.spatial(ev.x, ev.y, lx, ly); if (!sp) break;
          if (ev.kind === 'bullet' || ev.kind === 'shrapnel' || ev.kind === 'enemyShot' || ev.kind === 'plasma') break;
          this.boom(sp, Math.min(1.5, ev.radius / 100), 'explode');
          break;
        }
        case 'enemyDeath': {
          if (pops >= 3) break;
          const sp = this.spatial(ev.x, ev.y, lx, ly); if (!sp) break;
          if (ev.kind === 'hive' || ev.kind === 'blackhole') { this.boom(sp, 1.6, 'death'); break; }
          if (this.pop(sp, ev.elite)) pops++;
          break;
        }
        case 'shipDeath': {
          const sp = this.spatial(ev.x, ev.y, lx, ly, 2200); if (!sp) break;
          this.boom(sp, ev.shipId === localShipId ? 2 : 1.3, 'death');
          break;
        }
        case 'hit':
          if (ev.targetKind === 'ship' && ev.targetId === localShipId) this.hitThud();
          break;
        case 'heal': {
          const sp = this.spatial(ev.x, ev.y, lx, ly, 900); if (!sp) break;
          if (!this.gate('heal')) break;
          const f = ev.targetId === localShipId ? 1.4 : 1;
          this.tone({ g: sp.g * f, p: sp.p }, 'sine', 1180 + Math.random() * 120, 0.08, 0.08);
          this.tone({ g: sp.g * f, p: sp.p }, 'sine', 1770, 0.1, 0.04, 0.03);
          break;
        }
        case 'blink': {
          const sp = this.spatial(ev.x, ev.y, lx, ly); if (!sp) break;
          if (!this.gate('blink')) break;
          this.sweep(sp, 'sine', 380, 1700, 0.1, 0.22);
          this.noise(sp, 0.08, 'highpass', 2500, 0.15);
          this.tone(sp, 'triangle', 1400, 0.08, 0.12, 0.09);
          break;
        }
        case 'deployDeath': {
          const sp = this.spatial(ev.x, ev.y, lx, ly); if (!sp) break;
          this.deployDeath(ev.kind, sp);
          break;
        }
        case 'gem':
          this.gem(ev, lx, ly);
          break;
        case 'levelUp':
          if (this.localPid && ev.playerId === this.localPid) this.ui('levelUp');
          break;
        case 'attach':
        case 'detach':
          if (ev.turretShipId === localShipId || ev.hostShipId === localShipId) this.whoosh(ev.t === 'attach');
          break;
        case 'nova': {
          const sp = this.spatial(ev.x, ev.y, lx, ly); if (!sp) break;
          if (!this.gate('nova')) break;
          this.sweep(sp, 'sine', 120, 600, 0.35, 0.25);
          break;
        }
        case 'arc': {
          const sp = this.spatial(ev.points[0] ?? lx, ev.points[1] ?? ly, lx, ly); if (!sp) break;
          if (!this.gate('arc')) break;
          this.crackle(sp, 0.18, 0.3);
          this.sweep(sp, 'sawtooth', 2400, 500, 0.12, 0.08);
          break;
        }
        case 'waveStart':
          if (!this.gate('wave')) break;
          this.alarm(ev.boss);
          break;
        case 'lootDrop': {
          const sp = this.spatial(ev.x, ev.y, lx, ly, ev.rarity >= 3 ? 2400 : HEAR_DIST); if (!sp) break;
          this.lootDrop(sp, ev.rarity);
          break;
        }
        case 'lootPickup': {
          const mine = (localShipId !== 0 && ev.shipId === localShipId) || (this.localPid !== 0 && ev.playerId === this.localPid);
          if (mine) { this.lootPickup({ g: 1, p: 0 }, ev.rarity, 1); break; }
          const sp = this.spatial(ev.x, ev.y, lx, ly, 900); if (!sp) break;
          this.lootPickup(sp, ev.rarity, 0.35);
          break;
        }
        case 'lootSpill': {
          const mine = this.localPid !== 0 && ev.playerId === this.localPid;
          const sp = mine ? { g: 1, p: 0 } : this.spatial(ev.x, ev.y, lx, ly); if (!sp) break;
          this.lootSpill(sp, ev.count, ev.best, mine);
          break;
        }
        case 'lootSecured':
          if (this.localPid !== 0 && ev.playerId === this.localPid && this.gate('lootSecured')) {
            let best = 0;
            for (const t of ev.tokens) best = Math.max(best, t.rarity);
            this.chord({ g: 1, p: 0 }, [523.25, 659.25, 783.99, 1046.5].map((f) => f * (1 + best * 0.06)), 0.5, 0.1);
          }
          break;
        case 'objective':
          this.objective(ev, lx, ly);
          break;
        case 'roomSeal': case 'roomClear': case 'roomReset': case 'spawnWarn': case 'chestOpen': case 'bossIntro':
        case 'bossPhase': case 'telegraph': case 'portalOpen': case 'departing': case 'floorStart': case 'lifeLost':
        case 'outOfLives': case 'extract': case 'partyWiped': case 'instability': case 'riftEnd':
          this.rift(ev, lx, ly);
          break;
        default:
          break;
      }
    }
  }

  ui(name: string): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const c = { g: 0.5, p: 0 };
    switch (name) {
      case 'click': this.tone(c, 'square', 880, 0.04, 0.12); break;
      case 'select': this.tone(c, 'triangle', 660, 0.06, 0.2); this.tone(c, 'triangle', 990, 0.08, 0.18, 0.05); break;
      case 'chat': this.tone(c, 'sine', 1320, 0.05, 0.15); this.tone(c, 'sine', 1760, 0.06, 0.12, 0.05); break;
      case 'error': this.tone(c, 'square', 180, 0.12, 0.2); this.tone(c, 'square', 140, 0.14, 0.2, 0.1); break;
      case 'countdown': this.tone(c, 'square', 440, 0.12, 0.2); break;
      case 'start': this.tone(c, 'square', 880, 0.25, 0.22); this.tone(c, 'triangle', 1320, 0.3, 0.15, 0.02); break;
      case 'levelUp': {
        const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
        notes.forEach((f, i) => this.tone(c, 'triangle', f, 0.14, 0.2, i * 0.06));
        this.tone(c, 'sine', 2093, 0.3, 0.08, 0.3);
        break;
      }
      // v0.3 loot UI (Debrief crate reveals, Hangar equip)
      case 'reveal': // common..rare reveal: a bright two-note flip
        this.noise(c, 0.12, 'bandpass', 1800, 0.12, 5200);
        this.tone(c, 'triangle', 784, 0.1, 0.18, 0.06);
        this.tone(c, 'triangle', 1175, 0.16, 0.16, 0.13);
        break;
      case 'reveal-epic': // rising arpeggio + shimmer
        this.sweep(c, 'sine', 300, 900, 0.3, 0.12);
        [659.25, 830.61, 987.77, 1318.5].forEach((f, i) => this.tone(c, 'triangle', f, 0.22, 0.17, 0.2 + i * 0.07));
        this.noise(c, 0.5, 'highpass', 6000, 0.05, undefined, 0.3);
        break;
      case 'reveal-legendary': { // riser, then a bright major chord with a sparkle tail
        this.sweep(c, 'sawtooth', 110, 880, 0.55, 0.07);
        this.noise(c, 0.55, 'bandpass', 400, 0.12, 6000);
        this.chord(c, [523.25, 659.25, 783.99, 1046.5, 1318.5], 0.9, 0.12, 0.55);
        for (let i = 0; i < 6; i++) this.tone(c, 'sine', 2093 * (1 + i * 0.125), 0.12, 0.05, 0.7 + i * 0.07);
        break;
      }
      case 'equip': // mechanical click-clunk
        this.noise(c, 0.04, 'highpass', 3000, 0.18);
        this.tone(c, 'square', 330, 0.06, 0.12, 0.03);
        this.tone(c, 'triangle', 990, 0.08, 0.1, 0.07);
        break;
      default: this.tone(c, 'sine', 600, 0.05, 0.1);
    }
  }

  // ------------------------------------------------------------------------------------------
  // laser hum loops

  private updateHums(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const fresh = performance.now() - beamBus.stamp < 250 && ctx.state === 'running';
    for (const h of this.hums.values()) h.alive = false;
    if (fresh && this.volume > 0) {
      // nearest MAX_HUMS beams
      const lx = beamBus.listenerX, ly = beamBus.listenerY;
      const cand = beamBus.beams.slice(0, beamBus.count)
        .map((b) => ({ b, d: Math.hypot(b.x - lx, b.y - ly) }))
        .filter((q) => q.d < HEAR_DIST)
        .sort((a, b) => a.d - b.d)
        .slice(0, MAX_HUMS);
      for (const { b, d } of cand) {
        let h = this.hums.get(b.id);
        if (!h) { h = this.makeHum(b.id, b.kind); this.hums.set(b.id, h); }
        h.alive = true;
        const f = 1 - d / HEAR_DIST;
        const pan = Math.max(-1, Math.min(1, (b.x - lx) / 900));
        if (b.kind === BEAM_LASER) {
          const res = Math.max(1, b.resonance);
          const p = Math.pow(1.5, res - 1);
          const freq = 82 * Math.pow(2, ((res - 1) * 5) / 12);
          h.o1.frequency.setTargetAtTime(freq, t, 0.05);
          h.o2.frequency.setTargetAtTime(freq * 1.5 * 1.003, t, 0.05);
          h.filter.frequency.setTargetAtTime(500 + 650 * res, t, 0.05);
          h.lfo.frequency.setTargetAtTime(5 + res * 3, t, 0.1);
          h.lfoGain.gain.setTargetAtTime(freq * 0.015 * res, t, 0.1);
          h.gain.gain.setTargetAtTime(Math.min(0.2, 0.03 * p) * f * f, t, 0.04);
        } else {
          h.o1.frequency.setTargetAtTime(58, t, 0.05);
          h.o2.frequency.setTargetAtTime(117, t, 0.05);
          h.filter.frequency.setTargetAtTime(1400, t, 0.05);
          h.gain.gain.setTargetAtTime(0.025 * f * f, t, 0.04);
        }
        h.pan.pan.setTargetAtTime(pan, t, 0.05);
      }
    }
    for (const [id, h] of this.hums) {
      if (h.alive) continue;
      this.stopHum(h, t);
      this.hums.delete(id);
    }
    this.updatePortalHum(t, fresh);
  }

  private stopHum(h: Hum, t: number): void {
    h.gain.gain.setTargetAtTime(0, t, 0.05);
    h.o1.stop(t + 0.35); h.o2.stop(t + 0.35); h.lfo.stop(t + 0.35);
    setTimeout(() => { try { h.pan.disconnect(); } catch { /* */ } }, 450);
  }

  /**
   * v0.3 M4: one low drone for the nearest open rift portal (Descend: A1 + fifth; Extract: a fourth higher),
   * swelling and brightening while the party departs. Fades out when no portal is open or the renderer goes quiet.
   */
  private updatePortalHum(t: number, fresh: boolean): void {
    let best: { x: number; y: number; level: number; kind: number } | null = null, bd = PORTAL_HEAR;
    if (fresh && this.volume > 0) {
      const lx = beamBus.listenerX, ly = beamBus.listenerY;
      for (let i = 0; i < beamBus.portalCount; i++) {
        const p = beamBus.portals[i];
        const d = Math.hypot(p.x - lx, p.y - ly);
        if (d < bd) { bd = d; best = p; }
      }
    }
    if (!best) {
      if (this.portalHum) { this.stopHum(this.portalHum, t); this.portalHum = null; }
      return;
    }
    if (!this.portalHum) this.portalHum = this.makeHum(-1, HUM_PORTAL);
    const h = this.portalHum;
    const f = 1 - bd / PORTAL_HEAR, dep = best.level >= 2;
    const base = (best.kind === 1 ? 73.42 : 55) * (dep ? 1.5 : 1);
    h.o1.frequency.setTargetAtTime(base, t, 0.2);
    h.o2.frequency.setTargetAtTime(base * 1.5 * 1.004, t, 0.2);
    h.filter.frequency.setTargetAtTime(260 + 520 * f + (dep ? 700 : 0), t, 0.15);
    h.lfo.frequency.setTargetAtTime(dep ? 3.2 : 0.7, t, 0.2);
    h.lfoGain.gain.setTargetAtTime(base * 0.035, t, 0.2);
    h.gain.gain.setTargetAtTime((dep ? 0.11 : 0.07) * f * f, t, 0.12);
    h.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, (best.x - beamBus.listenerX) / 900)), t, 0.1);
  }

  private makeHum(id: number, kind: number): Hum {
    const ctx = this.ctx!;
    const gain = ctx.createGain(); gain.gain.value = 0;
    const pan = ctx.createStereoPanner();
    const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.Q.value = kind === BEAM_WELD ? 6 : kind === HUM_PORTAL ? 2 : 3;
    const o1 = ctx.createOscillator(); o1.type = kind === HUM_PORTAL ? 'triangle' : 'sawtooth';
    const o2 = ctx.createOscillator(); o2.type = kind === BEAM_WELD ? 'square' : 'sine';
    const lfo = ctx.createOscillator(); lfo.frequency.value = 6;
    const lfoGain = ctx.createGain(); lfoGain.gain.value = 2;
    lfo.connect(lfoGain); lfoGain.connect(o1.frequency);
    o1.connect(filter); o2.connect(filter);
    filter.connect(gain).connect(pan).connect(this.comp);
    const t = ctx.currentTime;
    o1.start(t); o2.start(t); lfo.start(t);
    return { id, gain, pan, filter, o1, o2, lfo, lfoGain, kind, alive: true };
  }

  // ------------------------------------------------------------------------------------------
  // helpers

  private gate(k: Kind): boolean {
    const now = this.ctx!.currentTime;
    if (this.voices >= MAX_VOICES) return false;
    // -Infinity (not -1): a first sound with RATE > 1 s must not be gated during the context's first second
    const l = this.last[k] ?? -Infinity;
    if (now - l < RATE[k]) return false;
    this.last[k] = now;
    return true;
  }

  private spatial(x: number, y: number, lx: number, ly: number, range = HEAR_DIST): Sp | null {
    const dx = x - lx, dy = y - ly;
    const d = Math.hypot(dx, dy);
    if (d > range) return null;
    const f = 1 - d / range;
    return { g: f * f, p: Math.max(-1, Math.min(1, dx / 900)) };
  }

  private out(sp: Sp, gain: number, dur: number, delay = 0): GainNode {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.value = 0;
    const pan = ctx.createStereoPanner();
    pan.pan.value = sp.p;
    g.connect(pan).connect(this.comp);
    this.voices++;
    const t = ctx.currentTime + delay;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain * sp.g, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    setTimeout(() => { this.voices--; try { pan.disconnect(); } catch { /* */ } }, (delay + dur + 0.1) * 1000);
    return g;
  }

  private tone(sp: Sp, type: OscillatorType, freq: number, dur: number, gain: number, delay = 0): void {
    const ctx = this.ctx!;
    const g = this.out(sp, gain, dur, delay);
    const o = ctx.createOscillator();
    o.type = type; o.frequency.value = freq;
    const t = ctx.currentTime + delay;
    o.connect(g); o.start(t); o.stop(t + dur + 0.02);
  }

  private sweep(sp: Sp, type: OscillatorType, f0: number, f1: number, dur: number, gain: number, delay = 0): void {
    const ctx = this.ctx!;
    const g = this.out(sp, gain, dur, delay);
    const o = ctx.createOscillator();
    o.type = type;
    const t = ctx.currentTime + delay;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    o.connect(g); o.start(t); o.stop(t + dur + 0.02);
  }

  private noise(sp: Sp, dur: number, ftype: BiquadFilterType, freq: number, gain: number, fEnd?: number, delay = 0): void {
    const ctx = this.ctx!;
    const g = this.out(sp, gain, dur, delay);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = ftype;
    const t = ctx.currentTime + delay;
    f.frequency.setValueAtTime(freq, t);
    if (fEnd) f.frequency.exponentialRampToValueAtTime(fEnd, t + dur);
    src.connect(f).connect(g);
    src.start(t, Math.random() * 0.5, dur + 0.05);
  }

  private crackle(sp: Sp, dur: number, gain: number): void {
    const n = 4;
    for (let i = 0; i < n; i++) this.noise(sp, 0.035, 'highpass', 2500 + Math.random() * 3000, gain * (0.6 + Math.random() * 0.4), undefined, (i * dur) / n + Math.random() * 0.02);
  }

  // ------------------------------------------------------------------------------------------
  // sounds

  private primary(skill: SkillId, sp: Sp, mine: boolean): void {
    const m = mine ? 1.5 : 1;
    switch (skill) {
      case 'autocannon':
        if (!this.gate('autocannon')) return;
        this.sweep(sp, 'sine', 170, 55, 0.12, 0.28 * m);
        this.sweep(sp, 'square', 320, 90, 0.05, 0.06 * m);
        this.noise(sp, 0.06, 'lowpass', 1400, 0.12 * m);
        break;
      case 'plasma':
        if (!this.gate('plasma')) return;
        this.sweep(sp, 'sawtooth', 1900, 380, 0.09, 0.07 * m);
        this.sweep(sp, 'sine', 2600, 900, 0.07, 0.07 * m);
        break;
      case 'rivet':
        if (!this.gate('rivet')) return;
        this.sweep(sp, 'square', 3200, 1900, 0.025, 0.05 * m);
        this.noise(sp, 0.018, 'highpass', 5000, 0.05 * m);
        break;
      default:
        if (!this.gate('gun')) return;
        this.sweep(sp, 'square', 1300, 360, 0.08, 0.07 * m);
    }
  }

  private skill(skill: SkillId, sp: Sp): void {
    switch (skill) {
      case 'rockets':
        if (!this.gate('rockets')) return;
        this.noise(sp, 0.4, 'bandpass', 350, 0.35, 3200);
        this.sweep(sp, 'sine', 120, 50, 0.15, 0.25);
        this.noise(sp, 0.3, 'bandpass', 500, 0.2, 2800, 0.07);
        break;
      case 'ram':
        if (!this.gate('ram')) return;
        this.sweep(sp, 'sawtooth', 65, 150, 0.5, 0.22);
        this.sweep(sp, 'square', 45, 90, 0.45, 0.1);
        this.noise(sp, 0.5, 'lowpass', 300, 0.4, 1800);
        break;
      case 'ironhide':
        if (!this.gate('ironhide')) return;
        for (const [f, gn] of [[523, 0.16], [1187, 0.1], [1790, 0.07], [2463, 0.05], [3150, 0.03]] as const) this.tone(sp, 'sine', f, 0.7, gn);
        this.noise(sp, 0.03, 'highpass', 3000, 0.25);
        this.sweep(sp, 'triangle', 220, 110, 0.25, 0.15);
        break;
      case 'arc':
        break; // the 'arc' event plays the crackle
      case 'blink':
        break; // the 'blink' event plays the pop
      case 'singularity':
        if (!this.gate('singularity')) return;
        this.sweep(sp, 'sine', 95, 42, 0.9, 0.3);
        this.sweep(sp, 'triangle', 190, 84, 0.9, 0.08);
        this.noise(sp, 0.6, 'lowpass', 800, 0.1, 120);
        break;
      case 'sentry':
        if (!this.gate('sentry')) return;
        this.sweep(sp, 'square', 260, 900, 0.16, 0.08);
        this.tone(sp, 'square', 1800, 0.03, 0.08, 0.17);
        this.sweep(sp, 'sine', 140, 60, 0.12, 0.2, 0.2);
        break;
      case 'repair':
        if (!this.gate('repair')) return;
        [784, 988, 1318, 1568].forEach((f, i) => this.tone(sp, 'sine', f, 0.35, 0.14, i * 0.05));
        this.noise(sp, 0.4, 'highpass', 6000, 0.04);
        break;
      case 'wall':
        if (!this.gate('wall')) return;
        this.noise(sp, 0.4, 'bandpass', 200, 0.3, 2400);
        this.sweep(sp, 'triangle', 220, 660, 0.4, 0.14);
        this.tone(sp, 'sine', 880, 0.3, 0.06, 0.35);
        break;
      default:
        break;
    }
  }

  private talent(talent: string, sp: Sp): void {
    if (!this.gate('talent')) return;
    switch (talent) {
      case 'ram_quake': this.boom(sp, 1.2, 'explode'); break;
      case 'sto_thunder': this.crackle(sp, 0.25, 0.4); this.sweep(sp, 'sine', 110, 35, 0.6, 0.35); break;
      case 'voi_collapse': this.sweep(sp, 'sine', 50, 200, 0.2, 0.3); this.boom(sp, 1.3, 'explode'); break;
      case 'sum_salvage': this.boom(sp, 0.9, 'explode'); break;
      default: this.tone(sp, 'triangle', 990, 0.1, 0.08); this.tone(sp, 'triangle', 1480, 0.1, 0.06, 0.05);
    }
  }

  private deployDeath(kind: DeployableKind, sp: Sp): void {
    if (!this.gate('deployDeath')) return;
    switch (kind) {
      case 'sentry': this.boom(sp, 0.6, 'explode'); this.noise(sp, 0.2, 'highpass', 3000, 0.1); break;
      case 'wall': this.noise(sp, 0.35, 'highpass', 2500, 0.25, 7000); this.tone(sp, 'sine', 1560, 0.3, 0.05); break;
      case 'well': this.sweep(sp, 'sine', 60, 300, 0.25, 0.2); break;
      case 'drone': this.pop(sp, false); break;
      default: break;
    }
  }

  private boom(sp: Sp, size: number, k: Kind): void {
    if (!this.gate(k)) return;
    const dur = 0.35 + size * 0.45;
    this.noise(sp, dur, 'lowpass', 2400 + size * 800, 0.45 + size * 0.2, 90);
    this.sweep(sp, 'sine', 140 + 40 / size, 30, dur * 0.9, 0.4 + size * 0.25);
  }

  private pop(sp: Sp, elite: boolean): boolean {
    if (!this.gate('pop')) return false;
    const f = (elite ? 500 : 700) * (0.8 + Math.random() * 0.5);
    this.sweep(sp, 'square', f, f * 2.2, 0.06, 0.08);
    this.noise(sp, 0.05, 'bandpass', 2500, 0.08);
    return true;
  }

  private gem(ev: Extract<GameEvent, { t: 'gem' }>, lx: number, ly: number): void {
    // Only the local player's pickups (by playerId once known; before that, pickups right at the listener).
    if (this.localPid ? ev.playerId !== this.localPid : Math.hypot(ev.x - lx, ev.y - ly) > 140) return;
    if (!this.gate('gem')) return;
    const now = this.ctx!.currentTime;
    this.gemCombo = now - this.gemLast < 0.5 ? Math.min(this.gemCombo + 1, 18) : 0;
    this.gemLast = now;
    const f = 880 * Math.pow(2, this.gemCombo / 12);
    this.tone({ g: 1, p: 0 }, 'sine', f, 0.09, 0.12);
    this.tone({ g: 1, p: 0 }, 'triangle', f * 2, 0.05, 0.05);
  }

  // ---- v0.3 loot

  private lootDrop(sp: Sp, rarity: Rarity): void {
    if (!this.gate('lootDrop')) return;
    const f = LOOT_PITCH[Math.max(0, Math.min(4, rarity))];
    this.tone(sp, 'triangle', f, 0.22, 0.16);
    this.tone(sp, 'sine', f * 2, 0.16, 0.06, 0.02);
    if (rarity >= 2) this.tone(sp, 'triangle', f * 1.5, 0.26, 0.12, 0.08);
    if (rarity >= 3) {
      this.tone(sp, 'triangle', f * 2, 0.34, 0.12, 0.16);
      this.noise(sp, 0.45, 'highpass', 5500, 0.05, undefined, 0.05);
    }
    if (rarity >= 4) {
      this.tone(sp, 'sine', f * 3, 0.5, 0.08, 0.24);
      this.sweep(sp, 'sine', 180, 90, 0.5, 0.18);
    }
  }

  private lootPickup(sp: Sp, rarity: Rarity, gain: number): void {
    if (!this.gate('lootPickup')) return;
    const f = LOOT_PITCH[Math.max(0, Math.min(4, rarity))] * 1.5;
    this.tone(sp, 'square', f, 0.05, 0.08 * gain);
    this.tone(sp, 'triangle', f * 1.335, 0.1, 0.14 * gain, 0.05);
  }

  private lootSpill(sp: Sp, count: number, best: Rarity, mine: boolean): void {
    if (!this.gate('lootSpill')) return;
    const g = mine ? 1.3 : 1;
    const n = Math.max(2, Math.min(6, count));
    for (let i = 0; i < n; i++) this.tone(sp, 'triangle', LOOT_PITCH[Math.max(0, Math.min(4, best))] * Math.pow(0.84, i), 0.09, 0.09 * g, i * 0.045);
    this.noise(sp, 0.25, 'bandpass', 2400, 0.1 * g, 500);
  }

  // ---- v0.3 objectives

  /** Global objective events: never silent (gain 0.45..1 by distance), gently panned. */
  private objSpatial(x: number, y: number, lx: number, ly: number): Sp {
    const dx = x - lx, d = Math.hypot(dx, y - ly);
    if (!Number.isFinite(d)) return { g: 0.6, p: 0 };
    const f = Math.max(0, 1 - d / 4000);
    return { g: 0.45 + 0.55 * f * f, p: Math.max(-0.7, Math.min(0.7, dx / 1400)) };
  }

  /**
   * `index` = the flag team (CTF) / zone / hot site; `team` + `playerId` = the acting side. "Ours" compares with
   * beamBus.localTeam (FFA: the local player id).
   */
  private objective(ev: Extract<GameEvent, { t: 'objective' }>, lx: number, ly: number): void {
    if (!this.gate(OBJECTIVE_SFX[ev.kind])) return;
    const team = beamBus.localTeam, pid = this.localPid || beamBus.localPid;
    const ours = (tm: TeamId, p: PlayerId): boolean => (team >= 0 ? tm === team : team === NO_TEAM && p !== 0 && p === pid);
    const me = pid !== 0 && ev.playerId === pid;
    const sp = me ? { g: 1, p: 0 } : this.objSpatial(ev.x, ev.y, lx, ly);
    const ourFlag = team >= 0 && ev.index === team;
    switch (ev.kind) {
      case 'flagTaken':
        if (ourFlag) { // your flag was stolen: a two-tone siren
          for (let i = 0; i < 4; i++) this.tone({ g: Math.max(sp.g, 0.8), p: sp.p }, 'square', i % 2 ? 554.37 : 739.99, 0.13, 0.1, i * 0.15);
        } else { // a steal: rising arpeggio (louder when it's your side)
          const gn = ours(ev.team, ev.playerId) ? 0.15 : 0.08;
          [523.25, 659.25, 783.99].forEach((f, i) => this.tone(sp, 'triangle', f, 0.12, gn, i * 0.06));
          this.noise(sp, 0.12, 'highpass', 4000, 0.06);
        }
        break;
      case 'flagDropped':
        this.sweep(sp, 'triangle', 620, 180, 0.22, 0.12);
        this.noise(sp, 0.1, 'lowpass', 500, 0.14);
        break;
      case 'flagReturned':
        if (ourFlag) { this.tone(sp, 'sine', 659.25, 0.14, 0.14); this.tone(sp, 'sine', 987.77, 0.2, 0.14, 0.1); }
        else { this.tone(sp, 'triangle', 329.63, 0.14, 0.08); this.tone(sp, 'triangle', 246.94, 0.2, 0.08, 0.1); }
        break;
      case 'flagCaptured': {
        const c = { g: 1, p: 0 };
        if (ourFlag) { // they capped your flag: descending minor
          [440, 349.23, 293.66].forEach((f, i) => this.tone(c, 'sawtooth', f, 0.26, 0.07, i * 0.2));
          this.sweep(c, 'sine', 220, 70, 0.7, 0.14, 0.2);
        } else if (ours(ev.team, ev.playerId)) { // your side scored: fanfare
          this.chord(c, [523.25, 659.25, 783.99], 0.3, 0.14);
          this.chord(c, [659.25, 783.99, 1046.5, 1318.5], 0.6, 0.14, 0.28);
          this.sweep(c, 'sine', 300, 1200, 0.3, 0.06);
          this.noise(c, 0.5, 'highpass', 6000, 0.05, undefined, 0.3);
        } else {
          this.chord(sp, [392, 493.88, 587.33], 0.4, 0.08);
        }
        break;
      }
      case 'zoneCaptured':
        if (ours(ev.team, ev.playerId)) this.chord(sp, [587.33, 739.99, 880], 0.35, 0.12);
        else { this.tone(sp, 'triangle', 392, 0.16, 0.09); this.tone(sp, 'triangle', 311.13, 0.24, 0.09, 0.12); }
        break;
      case 'zoneNeutralized':
        this.sweep(sp, 'sine', 820, 300, 0.3, 0.1);
        this.noise(sp, 0.15, 'bandpass', 1400, 0.06, 400);
        break;
      case 'hotWarn': { // the hot point moves in HOT_WARN_SEC: three ticks + a riser
        const c = { g: 0.8, p: sp.p };
        for (let i = 0; i < 3; i++) this.tone(c, 'square', 1175, 0.05, 0.07, i * 0.22);
        this.sweep(c, 'sine', 300, 900, 0.6, 0.06, 0.66);
        break;
      }
      case 'hotMoved': { // relocation whoosh + a low settle
        const c = { g: 0.9, p: sp.p };
        this.noise(c, 0.5, 'bandpass', 300, 0.18, 3000);
        this.sweep(c, 'sine', 180, 720, 0.45, 0.14);
        this.sweep(c, 'sine', 120, 40, 0.5, 0.18, 0.4);
        break;
      }
      case 'overtime': {
        const c = { g: 1, p: 0 };
        for (let i = 0; i < 3; i++) { this.tone(c, 'square', 880, 0.1, 0.09, i * 0.3); this.tone(c, 'square', 660, 0.1, 0.09, i * 0.3 + 0.12); }
        break;
      }
      case 'suddenDeath': {
        const c = { g: 1, p: 0 };
        for (let i = 0; i < 3; i++) { this.tone(c, 'sawtooth', 220, 0.28, 0.12, i * 0.34); this.tone(c, 'sawtooth', 233.08, 0.28, 0.08, i * 0.34); }
        break;
      }
    }
  }

  // ---- v0.3 M4 rift

  /**
   * Rift events. Global ones (seals, clears, boss, portals, extract, lives, run end) are never silent (objSpatial:
   * 0.45..1 by distance, gently panned); the positional spawnWarn / telegraph fade with distance.
   */
  private rift(ev: GameEvent, lx: number, ly: number): void {
    if (!(ev.t in RIFT_SFX)) return;
    const kind: Kind = ev.t === 'roomSeal' ? (ev.sec > 0 ? 'roomArming' : 'roomSeal') : RIFT_SFX[ev.t as RiftSfxEvent];
    const team = beamBus.localTeam, pid = this.localPid || beamBus.localPid;
    const ours = (tm: TeamId): boolean => team < 0 || tm === team; // co-op: one party; spectators hear it all
    const c = { g: 1, p: 0 };
    switch (ev.t) {
      case 'roomSeal': {
        if (!ours(ev.team) || !this.gate(kind)) return;
        if (ev.sec > 0) { // arming: a two-tone klaxon + the doors grinding shut
          for (let i = 0; i < 2; i++) { this.sweep(c, 'square', 440, 880, 0.26, 0.07, i * 0.34); this.tone(c, 'square', 660, 0.08, 0.05, i * 0.34 + 0.26); }
          this.noise(c, 1.3, 'bandpass', 250, 0.12, 1400);
        } else { // SEALED: the slam — a low thud, a metallic clang and the field's buzz
          this.sweep(c, 'sine', 95, 32, 0.55, 0.55);
          this.noise(c, 0.35, 'lowpass', 1800, 0.45, 120);
          for (const [f, gn] of [[311, 0.12], [739, 0.07], [1187, 0.05]] as const) this.tone(c, 'triangle', f, 0.45, gn, 0.01);
          this.tone(c, 'sawtooth', 55, 0.7, 0.08, 0.05);
          this.tone(c, 'sawtooth', 55.8, 0.7, 0.06, 0.05);
        }
        return;
      }
      case 'roomClear': {
        if (!this.gate(kind)) return;
        const sp = ours(ev.team) ? c : this.objSpatial(ev.x, ev.y, lx, ly);
        [1046.5, 1318.5, 1567.98, 2093].forEach((f, i) => this.tone(sp, 'triangle', f, 0.3, 0.1, i * 0.07));
        this.sweep(sp, 'sawtooth', 220, 60, 0.5, 0.06); // the field powering down
        this.noise(sp, 0.6, 'highpass', 6000, 0.05, undefined, 0.2);
        return;
      }
      case 'roomReset': {
        if (!this.gate(kind)) return;
        this.tone(c, 'triangle', 440, 0.18, 0.1);
        this.tone(c, 'triangle', 349.23, 0.3, 0.1, 0.16);
        this.noise(c, 0.3, 'bandpass', 1400, 0.07, 300);
        return;
      }
      case 'chestOpen': {
        if (!this.gate(kind)) return;
        const mine = pid !== 0 && ev.playerId === pid;
        const sp = mine ? c : this.objSpatial(ev.x, ev.y, lx, ly);
        const g = mine ? 1 : 0.6;
        this.sweep(sp, 'sine', 140, 70, 0.14, 0.2 * g); // the lid thunk
        this.noise(sp, 0.16, 'bandpass', 800, 0.14 * g, 2600);
        [783.99, 987.77, 1174.66, 1567.98].forEach((f, i) => this.tone(sp, 'triangle', f, 0.18, 0.1 * g, 0.08 + i * 0.05));
        return;
      }
      case 'portalOpen': {
        if (!this.gate(kind)) return;
        const sp = this.objSpatial(ev.x, ev.y, lx, ly);
        this.noise(sp, 0.9, 'bandpass', 200, 0.16, 3200);
        this.chord(sp, ev.extract ? [523.25, 659.25, 783.99, 1046.5] : [440, 554.37, 659.25, 987.77], 1.2, 0.1, 0.35);
        this.sweep(sp, 'sine', 90, 45, 1, 0.14);
        return;
      }
      case 'departing': {
        if (!this.gate(kind)) return;
        for (let i = 0; i < 3; i++) this.tone(c, 'square', 880 + i * 220, 0.07, 0.07, i * 0.18);
        this.sweep(c, 'sine', 200, 800, Math.min(2.5, Math.max(0.6, ev.sec * 0.3)), 0.07, 0.5);
        return;
      }
      case 'floorStart': { // descend: a long downward whoosh into the next floor
        if (!this.gate(kind)) return;
        this.noise(c, 1.1, 'bandpass', 4000, 0.22, 180);
        this.sweep(c, 'sine', 220, 40, 1.2, 0.3);
        this.sweep(c, 'triangle', 660, 110, 0.9, 0.06, 0.1);
        return;
      }
      case 'extract': {
        if (!this.gate(kind)) return;
        const mine = pid !== 0 && ev.playerId === pid;
        const sp = mine ? c : this.objSpatial(ev.x, ev.y, lx, ly);
        this.sweep(sp, 'sine', 200, 1600, 0.6, mine ? 0.14 : 0.08);
        this.chord(sp, [523.25, 659.25, 783.99, 1046.5, 1318.5], 0.8, mine ? 0.14 : 0.08, 0.45);
        this.noise(sp, 0.7, 'highpass', 6000, 0.06, undefined, 0.4);
        return;
      }
      case 'bossIntro': { // the Matriarch awakens: detuned low saws, a throat of filtered noise, a shriek, a sub
        if (!this.gate(kind)) return;
        const sp = this.objSpatial(ev.x, ev.y, lx, ly);
        this.sweep(sp, 'sawtooth', 72, 44, 1.6, 0.22);
        this.sweep(sp, 'sawtooth', 75, 46, 1.6, 0.18);
        this.noise(sp, 1.5, 'lowpass', 900, 0.45, 180);
        this.noise(sp, 1.1, 'bandpass', 1300, 0.16, 520, 0.15);
        this.sweep(sp, 'sine', 52, 34, 1.9, 0.4);
        return;
      }
      case 'bossPhase': {
        if (!this.gate(kind)) return;
        const sp = this.objSpatial(ev.x, ev.y, lx, ly);
        const hi = ev.phase >= 3 ? 1.3 : 1;
        this.sweep(sp, 'sawtooth', 90 * hi, 55 * hi, 0.8, 0.2);
        this.noise(sp, 0.7, 'lowpass', 1200, 0.3, 200);
        this.noise(sp, 0.5, 'bandpass', 1600 * hi, 0.1, 700);
        return;
      }
      case 'telegraph': { // boss attack warning: two sharp beeps, then a charge riser over the warning time
        const sp = this.spatial(ev.x, ev.y, lx, ly, 2400); if (!sp) return;
        if (!this.gate(kind)) return;
        const g = { g: Math.max(sp.g, 0.35), p: sp.p };
        this.tone(g, 'square', ev.shape === 'line' ? 1480 : 1175, 0.06, 0.09);
        this.tone(g, 'square', ev.shape === 'line' ? 1109 : 880, 0.06, 0.09, 0.09);
        this.sweep(g, 'sine', 300, 1200, Math.max(0.2, Math.min(1.2, ev.sec)), 0.06, 0.15);
        return;
      }
      case 'spawnWarn': { // enemies are about to burst through: a low crackling rumble
        const sp = this.spatial(ev.x, ev.y, lx, ly); if (!sp) return;
        if (!this.gate(kind)) return;
        this.noise(sp, Math.max(0.3, ev.sec), 'lowpass', 320, 0.18, 900);
        this.crackle(sp, Math.max(0.3, ev.sec), 0.08);
        this.sweep(sp, 'sine', 70, 45, Math.max(0.3, ev.sec), 0.12);
        return;
      }
      case 'lifeLost': {
        if (!ours(ev.team) || !this.gate(kind)) return;
        this.tone(c, 'triangle', 392, 0.12, 0.09);
        this.tone(c, 'triangle', 293.66, 0.2, 0.09, 0.1);
        return;
      }
      case 'outOfLives': {
        if (!this.gate(kind)) return;
        const mine = pid !== 0 && ev.playerId === pid;
        const sp = mine ? c : this.objSpatial(ev.x, ev.y, lx, ly);
        [440, 349.23, 261.63].forEach((f, i) => this.tone(sp, 'sawtooth', f, 0.24, mine ? 0.08 : 0.05, i * 0.18));
        return;
      }
      case 'partyWiped': {
        if (!this.gate(kind)) return;
        for (const f of [110, 130.81, 164.81]) this.tone(c, 'sawtooth', f, 1.6, 0.07);
        this.sweep(c, 'sine', 110, 35, 1.8, 0.3);
        return;
      }
      case 'instability': { // warbling alarm: the rift turns on the party
        if (!this.gate(kind)) return;
        for (let i = 0; i < 4; i++) this.tone(c, 'square', i % 2 ? 311.13 : 293.66, 0.16, 0.07, i * 0.17);
        this.noise(c, 0.7, 'bandpass', 500, 0.08, 1800);
        return;
      }
      case 'riftEnd': {
        if (!this.gate(kind)) return;
        if (ev.outcome === 'cleared' || ev.outcome === 'extracted') {
          this.chord(c, [523.25, 659.25, 783.99], 0.35, 0.14);
          this.chord(c, [659.25, 783.99, 1046.5, 1318.5], 0.8, 0.14, 0.32);
        } else {
          [392, 349.23, 311.13, 261.63].forEach((f, i) => this.tone(c, 'triangle', f, 0.4, 0.09, i * 0.26));
        }
        return;
      }
      default: return;
    }
  }

  /** The hot point finished arming (it scores from now on): a bright two-note ping. */
  private hotArmed(): void {
    if (!this.gate('hotArmed')) return;
    const c = { g: 0.9, p: 0 };
    this.tone(c, 'sine', 1318.5, 0.25, 0.12);
    this.tone(c, 'sine', 1760, 0.3, 0.1, 0.06);
    this.noise(c, 0.2, 'highpass', 6000, 0.05);
  }

  private chord(sp: Sp, notes: number[], dur: number, gain: number, delay = 0): void {
    notes.forEach((f, i) => this.tone(sp, 'triangle', f, dur, gain / Math.sqrt(notes.length) * 1.6, delay + i * 0.03));
  }

  private hitThud(): void {
    if (!this.gate('hit')) return;
    const c = { g: 1, p: 0 };
    this.sweep(c, 'sine', 160, 45, 0.16, 0.45);
    this.noise(c, 0.06, 'lowpass', 600, 0.2);
  }

  private whoosh(attach: boolean): void {
    if (!this.gate(attach ? 'attach' : 'detach')) return;
    const c = { g: 1, p: 0 };
    this.noise(c, 0.35, 'bandpass', attach ? 400 : 3000, 0.35, attach ? 3500 : 300);
    this.tone(c, 'triangle', attach ? 1320 : 440, 0.12, 0.12, attach ? 0.28 : 0);
  }

  private alarm(boss: boolean): void {
    const c = { g: 1, p: 0 };
    if (boss) {
      for (let i = 0; i < 3; i++) this.tone(c, 'sawtooth', 110, 0.5, 0.18, i * 0.55);
      for (let i = 0; i < 3; i++) this.tone(c, 'sawtooth', 116.5, 0.5, 0.12, i * 0.55);
    } else {
      this.tone(c, 'square', 660, 0.12, 0.1);
      this.tone(c, 'square', 880, 0.16, 0.1, 0.14);
    }
  }
}
