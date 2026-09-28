// v0.5 hardpoints + capital ships: HUD / lobby / controls presentation. Pure (no DOM, no Sim), unit-tested.
// Canon: HARDPOINT_LAYOUT / capitalScale (sim/world.ts), ShipClassDef.capital (data/ships.ts), MAX_HARDPOINTS.
import { MAX_HARDPOINTS } from '../../shared/constants';
import { SHIP_CLASS_IDS, SHIP_CLASSES } from '../../shared/data/ships';
import { OVERCHARGE_END } from '../../shared/sim/capital';
import { HARDPOINT_LAYOUT } from '../../shared/sim/world';
import type { ShipClassId, ShipStats, SkillDef, SkillId, YouState } from '../../shared/types';
import { SLOT_KEYS, SLOT_ORDER } from './classInfo';
import type { SlotSpec } from './SkillBar';

/** The capital skills (they replace the mobility / Space skill while the ship hosts ≥ 1 turret). */
export const CAPITAL_SKILL_IDS: ReadonlySet<SkillId> = new Set(SHIP_CLASS_IDS.map((id) => SHIP_CLASSES[id].capital.skill.id));

/** Index of the mobility (Space) slot in the class skill bar: the one the capital skill takes over. */
export const CAPITAL_SLOT_INDEX = SLOT_ORDER.indexOf('mobility');

function classDef(cls: ShipClassId | string | undefined) {
  return SHIP_CLASSES[cls as ShipClassId] ?? SHIP_CLASSES.brute;
}

/** Same clamping as turretOffset (world.ts), so the name always matches where the dome actually sits. */
function mount(slot: number, count: number): readonly [number, number] {
  const n = Math.max(1, Math.min(MAX_HARDPOINTS, Number.isFinite(count) ? Math.floor(count) : 1));
  const layout = HARDPOINT_LAYOUT[n];
  const i = Math.max(0, Math.min(layout.length - 1, Number.isFinite(slot) ? Math.floor(slot) : 0));
  return layout[i];
}

/**
 * Name of the hardpoint turret `slot` of `count` occupies, read off HARDPOINT_LAYOUT ([along, side]: along +1 = bow,
 * side −1 = port): 'bow' | 'fore port' | 'fore starboard' | 'center aft' | 'aft port' | 'aft starboard'.
 */
export function hardpointName(slot: number, count: number): string {
  const [along, side] = mount(slot, count);
  if (Math.abs(side) < 0.2) return along >= 0 ? 'bow' : 'center aft';
  return `${along >= 0 ? 'fore' : 'aft'} ${side < 0 ? 'port' : 'starboard'}`;
}

/** Full-house mounts split fore / aft (3 front, 2 back for the v0.5 layout). */
export function hardpointSplit(): { fore: number; aft: number } {
  const full = HARDPOINT_LAYOUT[MAX_HARDPOINTS];
  const fore = full.filter(([along]) => along >= 0).length;
  return { fore, aft: full.length - fore };
}

/** You fly a capital ship: you host ≥ 1 turret and are not a turret yourself. */
export function isHosting(you: Pick<YouState, 'turrets' | 'attachedTo'> | null | undefined): boolean {
  return !!you && !you.attachedTo && (you.turrets?.length ?? 0) > 0;
}

export interface SkillBarModel {
  /** SkillBar.setSlots key: the bar rebuilds only when the class or the capital form changes. */
  key: string;
  specs: SlotSpec[];
  /** Slot index showing the capital skill, or -1 (not hosting). */
  capitalIndex: number;
}

/** The pilot's skill bar: the class skills, with the capital skill in the Space slot while hosting. */
export function skillBarModel(cls: ShipClassId | string | undefined, hosting: boolean): SkillBarModel {
  const def = classDef(cls);
  const cap = hosting ? def.capital?.skill : undefined;
  const specs: SlotSpec[] = SLOT_ORDER.map((slot) => {
    const sk: SkillDef = slot === 'mobility' && cap ? cap : def.skills[slot];
    const spec: SlotSpec = { icon: sk.icon, name: sk.name, keys: SLOT_KEYS[slot] };
    if (sk === cap) spec.capital = true;
    return spec;
  });
  return { key: `${cap ? 'capital' : 'skills'}:${def.id}`, specs, capitalIndex: cap ? CAPITAL_SLOT_INDEX : -1 };
}

/** Energy cost of the capital skill (the `capCost` knob; the mobility cost if a class has none). */
export function capitalCost(stats: ShipStats): number {
  const v = stats.skill?.capCost;
  return typeof v === 'number' && Number.isFinite(v) ? v : stats.mobilityCost;
}

/** Capital skill cooldown in seconds (the `capCooldown` knob; replaces mobilityCooldown while hosting). */
export function capitalCooldownSec(stats: ShipStats): number {
  const v = stats.skill?.capCooldown;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : stats.mobilityCooldown;
}

/** How long the HUD lights the capital slot after a use: the effect's duration (Broadside is one volley). */
export function capitalActiveSec(skill: SkillId, stats: ShipStats): number {
  const k = stats.skill ?? {};
  if (skill === 'overcharge') return k.overchargeTime ?? 4;
  if (skill === 'repairbay') return k.bayTime ?? 4;
  return 0.35;
}

/**
 * The capital slot's cooldown sweep + "effect running" glow.
 * - Cooldown: the server's `cd.mobility` / `cdSec.mobility` (sim/capital.ts times the capital skill on the Space
 *   slot's ready tick, mobilityReadyTick; the snapshot normalizes it by capCooldown while hosting). If a use is heard
 *   (own `ability` event) but the server never reports that cooldown, a local capCooldown clock stands in.
 * - Active: from the own `ability` event for the effect's duration (Overcharge / Repair Bay; a short flash for
 *   Broadside), cut short by the Sim's OVERCHARGE_END marker or by the server's YouState.skillActive going false
 *   (the Sim holds mobilityActiveUntilTick while Overcharge / Repair Bay run).
 */
export class CapitalCooldown {
  private usedAt = -1e9;
  private endedAt = -1e9;
  private skill: SkillId | null = null;
  /** The server reported a running mobility cooldown since the last heard use: it is authoritative for that use. */
  private serverSeen = false;

  reset(): void {
    this.usedAt = this.endedAt = -1e9;
    this.skill = null;
    this.serverSeen = false;
  }

  /**
   * An own `ability` event. Only untagged capital events are uses; a `talent`-tagged one is a marker (the Sim's
   * OVERCHARGE_END ends the running Overcharge early) and never restarts the cooldown.
   */
  onAbility(skill: SkillId, nowMs: number, talent?: string): void {
    if (!CAPITAL_SKILL_IDS.has(skill)) return;
    if (talent) {
      if (talent === OVERCHARGE_END && this.skill === skill) this.endedAt = nowMs;
      return;
    }
    this.skill = skill;
    this.usedAt = nowMs;
    this.serverSeen = false;
  }

  state(serverFrac: number, serverSec: number, cooldownSec: number, nowMs: number): { cd: number; cdSec: number } {
    const sf = Number.isFinite(serverFrac) ? Math.max(0, Math.min(1, serverFrac)) : 0;
    const ss = Number.isFinite(serverSec) ? Math.max(0, serverSec) : 0;
    if (ss > 0 || sf > 0) this.serverSeen = true;
    if (this.serverSeen || !(cooldownSec > 0)) return { cd: sf, cdSec: ss };
    const left = Math.max(0, cooldownSec - (nowMs - this.usedAt) / 1000);
    return left > 0 ? { cd: Math.min(1, left / cooldownSec), cdSec: left } : { cd: 0, cdSec: 0 };
  }

  /** `serverActive` = YouState.skillActive (omit when unknown): false ends a timed effect's glow at once. */
  active(stats: ShipStats, nowMs: number, serverActive?: boolean): boolean {
    if (!this.skill || this.endedAt >= this.usedAt) return false;
    if (serverActive === false && this.skill !== 'broadside') return false;
    return nowMs - this.usedAt < capitalActiveSec(this.skill, stats) * 1000;
  }
}

export type HardpointPip = 'on' | 'free' | 'locked';

export interface CapitalBadgeModel {
  /** "CAPITAL: Dreadnought" */
  label: string;
  name: string;
  icon: string;
  /** Turrets docked (≤ MAX_HARDPOINTS) and the hardpoints on any capital (MAX_HARDPOINTS). */
  used: number;
  total: number;
  /** Mounts this ship can fill right now (maxTurrets, capped to the hardpoints). */
  cap: number;
  /** One pip per hardpoint: docked, free, or beyond this ship's maxTurrets. */
  pips: HardpointPip[];
  /** "HARDPOINTS 2/2": turrets aboard / mounts this ship can fill now (locked pips show the rest of the 5). */
  count: string;
  skill: SkillDef;
  /** Tooltip: the capital's description + which mounts are manned. */
  title: string;
}

/** The host's capital badge (null while hosting nobody). */
export function capitalBadgeModel(cls: ShipClassId | string | undefined, turretCount: number, maxTurrets: number): CapitalBadgeModel | null {
  const n = Number.isFinite(turretCount) ? Math.floor(turretCount) : 0;
  if (n <= 0) return null;
  const def = classDef(cls);
  const total = MAX_HARDPOINTS;
  const used = Math.min(total, n);
  const mt = Number.isFinite(maxTurrets) ? Math.floor(maxTurrets) : used;
  const cap = Math.max(used, Math.min(total, mt));
  const pips: HardpointPip[] = [];
  for (let i = 0; i < total; i++) pips.push(i < used ? 'on' : i < cap ? 'free' : 'locked');
  const mounts: string[] = [];
  for (let i = 0; i < used; i++) mounts.push(hardpointName(i, used));
  return {
    label: `CAPITAL: ${def.capital.name}`, name: def.capital.name, icon: def.capital.skill.icon,
    used, total, cap, pips, count: `HARDPOINTS ${used}/${cap}`, skill: def.capital.skill,
    title: `${def.capital.description} Manned: ${mounts.join(', ')}.` +
      (cap < total ? ` ${cap} of ${total} hardpoints open (more turret slots unlock the rest).` : ''),
  };
}

/** A turret's status line: "TURRET ON Nova — FORE PORT · Flak Cannon" (the HUD line is uppercase anyway). */
export function turretSeatText(hostName: string, slot: number, count: number, kitName: string): string {
  return `Turret on ${hostName} — ${hardpointName(slot, count).toUpperCase()} · ${kitName}`;
}

/** Lobby / build planner line: what carrying a teammate turns this class into. */
export function capitalLobbyLine(cls: ShipClassId | string | undefined): string {
  const def = classDef(cls);
  const { fore, aft } = hardpointSplit();
  return `Carry a teammate to transform: every turret you carry grows the ${def.capital.name}'s hull ` +
    `(up to ${MAX_HARDPOINTS} bubble-turret hardpoints, ${fore} fore · ${aft} aft) and ${def.capital.skill.name} ` +
    `replaces ${def.skills.mobility.name} on Space.`;
}

export interface CapitalRosterRow { cls: ShipClassId; className: string; capital: string; skill: string; icon: string }

/** Every class's capital variant, in class order (Controls overlay). */
export function capitalRoster(): CapitalRosterRow[] {
  return SHIP_CLASS_IDS.map((id) => {
    const d = SHIP_CLASSES[id];
    return { cls: id, className: d.name, capital: d.capital.name, skill: d.capital.skill.name, icon: d.capital.skill.icon };
  });
}

/** Controls overlay paragraph (the capitalRoster list follows it). */
export function capitalControlsLine(): string {
  const { fore, aft } = hardpointSplit();
  return `Carry teammates as turrets to transform into your capital ship: up to ${MAX_HARDPOINTS} bubble-turret hardpoints ` +
    `(${fore} fore · ${aft} aft), a hull that grows with every turret (easier to hit), and a capital skill that replaces ` +
    `your mobility skill on Space until the last turret leaves. Broadside fires from both flanks and the slugs cross ` +
    `on your aim point, so aim it like a shot.`;
}
