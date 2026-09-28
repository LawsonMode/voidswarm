// Tiny in-page bus: GameRenderer publishes the continuous beams it drew this frame; AudioFx reads it
// to drive its laser hum loops. Keeps the frozen IAudioFx contract unchanged (no per-frame ship feed).
// v0.3 M3: also the viewer's side (objective SFX pick "ours" / "theirs" variants) and the hot point's
// armed pulse (the ObjectiveView armIn → 0 transition has no event; the objective layer bumps hotArmSeq).
// v0.3 M4: the open rift portals of the frame (the rift layer publishes them; AudioFx loops the nearest one's hum).
// v0.5: docked turrets' fire styles (AudioFx plays the mass-driver thump for that style) and renderer-raised SFX cues
// (the capital transform has no event of its own: the renderer sees turretCount 0 ↔ ≥ 1 and raises a cue).
export interface BeamInfo { id: number; x: number; y: number; resonance: number; kind: number }

export const beamBus = {
  beams: [] as BeamInfo[],
  count: 0,
  listenerX: 0,
  listenerY: 0,
  /** performance.now() of the last publish; hums fade out when this goes stale. */
  stamp: 0,
  /** Viewer's team (≥ 0 teams, -1 FFA, < -1 spectator / unknown) and player id, set every frame. */
  localTeam: -2,
  localPid: 0,
  /** Bumped once per hot point arming completion; hotArmAt = performance.now() of that bump. */
  hotArmSeq: 0,
  hotArmAt: 0,
  /** v0.3 M4: open rift portals this frame (AudioFx portal hum); reset by the rift layer every frame. */
  portals: [] as PortalInfo[],
  portalCount: 0,
  /** v0.5: fire style (capital.ts FIRE_CODE) of every docked turret this frame, by ship id (AudioFx: mass-driver thump). */
  turretFire: new Map<number, number>(),
  /** v0.5: cosmetic SFX cues the renderer raises (capital transform); a ring buffer read by sequence number. */
  cues: [] as CueInfo[],
  /** Sequence number of the newest cue (0 = none yet). */
  cueSeq: 0,
};

/** v0.5 renderer-raised SFX cue: `kind` CUE_*, world position, performance.now() when raised. */
export interface CueInfo { seq: number; kind: number; x: number; y: number; at: number }
/** A host took its first turret: the capital transform (whoosh + clank). */
export const CUE_CAP_UP = 1;
/** Its last turret left: the capital folds back. */
export const CUE_CAP_DOWN = 2;
export const CUE_RING = 16;

export function publishCue(kind: number, x: number, y: number): void {
  const seq = ++beamBus.cueSeq;
  const i = seq % CUE_RING;
  let c = beamBus.cues[i];
  if (!c) { c = { seq: 0, kind: 0, x: 0, y: 0, at: 0 }; beamBus.cues[i] = c; }
  c.seq = seq; c.kind = kind; c.x = x; c.y = y; c.at = performance.now();
}

/** An open rift portal: level 1 open, 2 departing; kind 0 Descend, 1 Extract / Exit. */
export interface PortalInfo { x: number; y: number; level: number; kind: number }

export function publishPortal(x: number, y: number, level: number, kind: number): void {
  let p = beamBus.portals[beamBus.portalCount];
  if (!p) { p = { x: 0, y: 0, level: 0, kind: 0 }; beamBus.portals.push(p); }
  p.x = x; p.y = y; p.level = level; p.kind = kind;
  beamBus.portalCount++;
}

export function publishBeam(id: number, x: number, y: number, resonance: number, kind: number): void {
  let b = beamBus.beams[beamBus.count];
  if (!b) { b = { id: 0, x: 0, y: 0, resonance: 1, kind: 0 }; beamBus.beams.push(b); }
  b.id = id; b.x = x; b.y = y; b.resonance = resonance; b.kind = kind;
  beamBus.count++;
}
