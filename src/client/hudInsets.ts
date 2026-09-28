// v0.3 M3 (INTEGRATOR): how much of the game view the DOM HUD covers at its top and bottom edges, in CSS px of the
// view (the renderer's screen space). The HUD measures its top row (scores / objective strip / stats) and its bottom
// block (skill panel, XP bar, loot tray) and reports them here; the objective layer keeps off-screen edge pointers
// clear of both (render/objectives.ts drawPointers). A plain module value, so neither side imports the other and the
// frozen IGameRenderer contract stays as it is. 0 = unknown (the renderer's own minimum insets apply).
export interface HudInsets {
  top: number;
  bottom: number;
}

const insets: HudInsets = { top: 0, bottom: 0 };

const clean = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.min(4000, Math.round(v))) : 0);

export function setHudInsets(top: number, bottom: number): void {
  insets.top = clean(top);
  insets.bottom = clean(bottom);
}

export function hudInsets(): Readonly<HudInsets> {
  return insets;
}
