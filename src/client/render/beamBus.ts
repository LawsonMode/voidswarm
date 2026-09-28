// Tiny in-page bus: GameRenderer publishes the continuous beams it drew this frame; AudioFx reads it
// to drive its laser hum loops. Keeps the frozen IAudioFx contract unchanged (no per-frame ship feed).
// v0.3 M3: also the viewer's side (objective SFX pick "ours" / "theirs" variants) and the hot point's
// armed pulse (the ObjectiveView armIn → 0 transition has no event; the objective layer bumps hotArmSeq).
// v0.3 M4: the open rift portals of the frame (the rift layer publishes them; AudioFx loops the nearest one's hum).
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
};

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
