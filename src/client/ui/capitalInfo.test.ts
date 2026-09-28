// v0.5 hardpoints + capital ships: HUD / lobby / controls presentation (capitalInfo.ts). Pure: no DOM, no Sim.
import { describe, expect, it } from 'vitest';
import { MAX_HARDPOINTS } from '../../shared/constants';
import { SHIP_CLASS_IDS, SHIP_CLASSES } from '../../shared/data/ships';
import { turretOffset } from '../../shared/sim/world';
import type { ShipStats, YouState } from '../../shared/types';
import {
  CAPITAL_SKILL_IDS, CAPITAL_SLOT_INDEX, CapitalCooldown, capitalActiveSec, capitalBadgeModel, capitalControlsLine,
  capitalCooldownSec, capitalCost, capitalLobbyLine, capitalRoster, hardpointName, hardpointSplit, isHosting,
  skillBarModel, turretSeatText,
} from './capitalInfo';
import { SLOT_KEYS, SLOT_ORDER } from './classInfo';
import { OVERCHARGE_END } from '../../shared/sim/capital';

const stats = (cls: keyof typeof SHIP_CLASSES = 'brute', skill: Record<string, number> = {}): ShipStats =>
  ({ ...SHIP_CLASSES[cls].base, skill: { ...SHIP_CLASSES[cls].base.skill, ...skill } });

describe('hardpoint names (slot of count → mount, read off HARDPOINT_LAYOUT)', () => {
  it('match the ARCHITECTURE table for 1–5 turrets', () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => hardpointName(i, n));
    expect(names(1)).toEqual(['bow']);
    expect(names(2)).toEqual(['fore port', 'fore starboard']);
    expect(names(3)).toEqual(['fore port', 'fore starboard', 'center aft']);
    expect(names(4)).toEqual(['fore port', 'fore starboard', 'aft port', 'aft starboard']);
    expect(names(5)).toEqual(['bow', 'fore port', 'fore starboard', 'aft port', 'aft starboard']);
    for (let n = 1; n <= MAX_HARDPOINTS; n++) expect(new Set(names(n)).size).toBe(n); // one turret per mount
  });

  it('agree with where turretOffset actually puts the dome (port = left of the heading on a y-down screen)', () => {
    for (const angle of [0, 1.1, -2.4]) {
      const c = Math.cos(angle), s = Math.sin(angle);
      for (let n = 1; n <= MAX_HARDPOINTS; n++) {
        for (let i = 0; i < n; i++) {
          const o = turretOffset(angle, i, n, 30);
          const along = o.dx * c + o.dy * s; // + = toward the bow
          const side = -o.dx * s + o.dy * c; // + = starboard
          const name = hardpointName(i, n);
          if (name === 'bow') { expect(along).toBeGreaterThan(20); expect(Math.abs(side)).toBeLessThan(1e-9); }
          if (name === 'center aft') { expect(along).toBeLessThan(-20); expect(Math.abs(side)).toBeLessThan(1e-9); }
          if (name.startsWith('fore')) expect(along).toBeGreaterThan(0);
          if (name.startsWith('aft')) expect(along).toBeLessThan(0);
          if (name.endsWith('port') && name !== 'bow') expect(side).toBeLessThan(0);
          if (name.endsWith('starboard')) expect(side).toBeGreaterThan(0);
        }
      }
    }
  });

  it('clamp like turretOffset (out-of-range slot / count, junk)', () => {
    expect(hardpointName(9, 9)).toBe(hardpointName(4, 5));
    expect(hardpointName(-1, 0)).toBe('bow');
    expect(hardpointName(3, 2)).toBe('fore starboard');
    expect(hardpointName(NaN, NaN)).toBe('bow');
    expect(hardpointName(1.7, 2.9)).toBe('fore starboard');
  });

  it('a full house is 3 fore + 2 aft (the owner\'s "3 front, 2 back")', () => {
    expect(hardpointSplit()).toEqual({ fore: 3, aft: 2 });
  });
});

describe('capital skill bar swap', () => {
  it('a pilot who hosts nobody keeps the four class skills', () => {
    for (const id of SHIP_CLASS_IDS) {
      const m = skillBarModel(id, false);
      expect(m.key).toBe(`skills:${id}`);
      expect(m.capitalIndex).toBe(-1);
      expect(m.specs.map((s) => s.name)).toEqual(SLOT_ORDER.map((slot) => SHIP_CLASSES[id].skills[slot].name));
      expect(m.specs.some((s) => s.capital)).toBe(false);
    }
  });

  it('a host gets its capital skill in the Space slot (same key glyphs), every other slot unchanged', () => {
    for (const id of SHIP_CLASS_IDS) {
      const def = SHIP_CLASSES[id];
      const plain = skillBarModel(id, false), cap = skillBarModel(id, true);
      expect(cap.key).toBe(`capital:${id}`);
      expect(cap.key).not.toBe(plain.key); // SkillBar.setSlots rebuilds on the swap (and back)
      expect(cap.capitalIndex).toBe(CAPITAL_SLOT_INDEX);
      expect(SLOT_ORDER[cap.capitalIndex]).toBe('mobility');
      const slot = cap.specs[cap.capitalIndex];
      expect(slot).toMatchObject({ name: def.capital.skill.name, icon: def.capital.skill.icon, keys: SLOT_KEYS.mobility, capital: true });
      cap.specs.forEach((s, i) => { if (i !== cap.capitalIndex) expect(s).toEqual(plain.specs[i]); });
    }
    expect(skillBarModel('brute', true).specs[CAPITAL_SLOT_INDEX].name).toBe('Broadside');
    expect(skillBarModel('tech', true).specs[CAPITAL_SLOT_INDEX].name).toBe('Resonance Overcharge');
    expect(skillBarModel('engineer', true).specs[CAPITAL_SLOT_INDEX].name).toBe('Repair Bay');
    expect(skillBarModel('nope', true).key).toBe('capital:brute'); // unknown class falls back like the HUD
  });

  it('isHosting: ≥ 1 turret and not a turret yourself', () => {
    const you = (turrets: number[], attachedTo = 0) => ({ turrets, attachedTo }) as Pick<YouState, 'turrets' | 'attachedTo'>;
    expect(isHosting(you([]))).toBe(false);
    expect(isHosting(you([7]))).toBe(true);
    expect(isHosting(you([7, 8], 3))).toBe(false);
    expect(isHosting(null)).toBe(false);
  });

  it('cost and cooldown come from the capCost / capCooldown knobs (mobility ones as a fallback)', () => {
    expect(capitalCost(stats('brute'))).toBe(SHIP_CLASSES.brute.base.skill.capCost);
    expect(capitalCooldownSec(stats('brute'))).toBe(SHIP_CLASSES.brute.base.skill.capCooldown);
    expect(capitalCost(stats('engineer'))).toBe(0);
    expect(capitalCooldownSec(stats('tech'))).toBe(SHIP_CLASSES.tech.base.skill.capCooldown);
    const bare = { ...SHIP_CLASSES.tech.base, skill: {} } as ShipStats;
    expect(capitalCost(bare)).toBe(bare.mobilityCost);
    expect(capitalCooldownSec(bare)).toBe(bare.mobilityCooldown);
    expect(CAPITAL_SKILL_IDS).toEqual(new Set(['broadside', 'overcharge', 'repairbay']));
    expect(capitalActiveSec('overcharge', stats('tech'))).toBe(SHIP_CLASSES.tech.base.skill.overchargeTime);
    expect(capitalActiveSec('repairbay', stats('engineer'))).toBe(SHIP_CLASSES.engineer.base.skill.bayTime);
    expect(capitalActiveSec('broadside', stats('brute'))).toBeLessThan(1);
  });
});

describe('CapitalCooldown (the Space slot sweep while hosting)', () => {
  const CD = 8;

  it('the server cooldown (cd.mobility normalized by capCooldown) is shown as-is', () => {
    const c = new CapitalCooldown();
    expect(c.state(0, 0, CD, 0)).toEqual({ cd: 0, cdSec: 0 });
    expect(c.state(0.5, 4, CD, 0)).toEqual({ cd: 0.5, cdSec: 4 });
    c.onAbility('broadside', 1000);
    expect(c.state(1, 8, CD, 1000)).toEqual({ cd: 1, cdSec: 8 });
    // once the server has reported this use's cooldown it stays authoritative (no local clock lag at the end)
    expect(c.state(0, 0, CD, 1500)).toEqual({ cd: 0, cdSec: 0 });
  });

  it('a heard use the server never times (a Sim that keeps the capital cooldown elsewhere) runs a local clock', () => {
    const c = new CapitalCooldown();
    c.onAbility('overcharge', 10_000);
    expect(c.state(0, 0, CD, 10_000)).toEqual({ cd: 1, cdSec: CD });
    const mid = c.state(0, 0, CD, 14_000);
    expect(mid.cd).toBeCloseTo(0.5);
    expect(mid.cdSec).toBeCloseTo(4);
    expect(c.state(0, 0, CD, 18_001)).toEqual({ cd: 0, cdSec: 0 });
    c.reset();
    expect(c.state(0, 0, CD, 10_500)).toEqual({ cd: 0, cdSec: 0 });
  });

  it('only capital skills count; the effect glow lasts the effect (Overcharge / Repair Bay), Broadside flashes', () => {
    const c = new CapitalCooldown();
    c.onAbility('ram', 0);
    c.onAbility('repair', 0);
    expect(c.state(0, 0, CD, 100)).toEqual({ cd: 0, cdSec: 0 });
    expect(c.active(stats('brute'), 100)).toBe(false);
    const tech = stats('tech');
    c.onAbility('overcharge', 1000);
    expect(c.active(tech, 1000 + (tech.skill.overchargeTime - 0.1) * 1000)).toBe(true);
    expect(c.active(tech, 1000 + (tech.skill.overchargeTime + 0.1) * 1000)).toBe(false);
    c.onAbility('broadside', 5000);
    expect(c.active(stats('brute'), 5100)).toBe(true);
    expect(c.active(stats('brute'), 6000)).toBe(false);
    expect(c.active(stats('brute'), 5100, false)).toBe(true); // a Broadside is instant: skillActive never covers it
  });

  it("the Sim's OVERCHARGE_END marker ends the glow early and is never a new use; skillActive false ends it too", () => {
    const tech = stats('tech');
    const c = new CapitalCooldown();
    c.onAbility('overcharge', 1000);
    expect(c.active(tech, 1500, true)).toBe(true);
    expect(c.active(tech, 1500, false)).toBe(false); // the server says the effect is over (last turret left, death)
    c.onAbility('overcharge', 2000, OVERCHARGE_END);
    expect(c.active(tech, 2100, true)).toBe(false);
    // the marker did not restart the local cooldown clock (still counting from the use at 1000 ms)
    expect(c.state(0, 0, CD, 5000).cdSec).toBeCloseTo(CD - 4);
    c.onAbility('overcharge', 3000, 'someTalentProc'); // other tagged events are ignored
    expect(c.state(0, 0, CD, 5000).cdSec).toBeCloseTo(CD - 4);
    c.onAbility('overcharge', 10_000); // the next real use lights it again
    expect(c.active(tech, 10_100, true)).toBe(true);
  });
});

describe('capital badge ("CAPITAL: Dreadnought", hardpoints n/5)', () => {
  it('no badge while hosting nobody', () => {
    expect(capitalBadgeModel('brute', 0, 2)).toBeNull();
    expect(capitalBadgeModel('brute', NaN, 2)).toBeNull();
  });

  it('names the capital, counts turrets / usable mounts and marks mounts beyond maxTurrets as locked', () => {
    const b = capitalBadgeModel('brute', 2, SHIP_CLASSES.brute.base.maxTurrets)!;
    expect(b.label).toBe('CAPITAL: Dreadnought');
    expect(b.count).toBe('HARDPOINTS 2/2'); // full: no free seat (not "2/5", which suggested three more)
    expect(b.title).toContain(`2 of ${MAX_HARDPOINTS} hardpoints open`);
    expect(b.pips).toEqual(['on', 'on', 'locked', 'locked', 'locked']);
    expect(b.cap).toBe(2);
    expect(b.skill.id).toBe('broadside');
    expect(b.title).toContain('fore port, fore starboard');
    // a Bulwark battle station (maxTurrets 5) with 3 aboard
    expect(capitalBadgeModel('brute', 3, 5)!.pips).toEqual(['on', 'on', 'on', 'free', 'free']);
    expect(capitalBadgeModel('brute', 3, 5)!.count).toBe('HARDPOINTS 3/5');
    expect(capitalBadgeModel('brute', 3, 5)!.title).not.toContain('hardpoints open');
    expect(capitalBadgeModel('tech', 1, 2)!.label).toBe('CAPITAL: Spire');
    expect(capitalBadgeModel('engineer', 1, 3)!.pips).toEqual(['on', 'free', 'free', 'locked', 'locked']);
    // never more than the hardpoints, and never fewer mounts than turrets aboard
    const over = capitalBadgeModel('engineer', 9, 12)!;
    expect(over.used).toBe(MAX_HARDPOINTS);
    expect(over.count).toBe('HARDPOINTS 5/5');
    expect(capitalBadgeModel('brute', 3, 1)!.pips).toEqual(['on', 'on', 'on', 'locked', 'locked']);
  });

  it('a turret\'s line names its mount', () => {
    expect(turretSeatText('Nova', 0, 2, 'Flak Cannon')).toBe('Turret on Nova — FORE PORT · Flak Cannon');
    expect(turretSeatText('Nova', 0, 1, 'Laser Lance')).toBe('Turret on Nova — BOW · Laser Lance');
    expect(turretSeatText('Nova', 2, 3, 'Seeker Volley')).toBe('Turret on Nova — CENTER AFT · Seeker Volley');
    expect(turretSeatText('Nova', 4, 5, 'Flak Cannon')).toBe('Turret on Nova — AFT STARBOARD · Flak Cannon');
  });
});

describe('lobby + controls wording', () => {
  it('every class names its capital form, capital skill and the mobility skill it replaces', () => {
    for (const id of SHIP_CLASS_IDS) {
      const d = SHIP_CLASSES[id];
      const line = capitalLobbyLine(id);
      expect(line).toMatch(/^Carry a teammate to transform/);
      expect(line).toContain(d.capital.name);
      expect(line).toContain(d.capital.skill.name);
      expect(line).toContain(d.skills.mobility.name);
      expect(line).toContain(`${MAX_HARDPOINTS} bubble-turret hardpoints, 3 fore · 2 aft`);
    }
  });

  it('the controls roster lists each class → capital (skill)', () => {
    expect(capitalRoster().map((r) => `${r.className} → ${r.capital} (${r.skill})`)).toEqual([
      'Juggernaut → Dreadnought (Broadside)', 'Arcanist → Spire (Resonance Overcharge)', 'Artificer → Foundry (Repair Bay)',
    ]);
    expect(capitalControlsLine()).toContain('Space');
    expect(capitalControlsLine()).toContain('3 fore · 2 aft');
  });
});
