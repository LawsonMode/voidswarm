// Turret-kit offense reload for the HUD sweep. Pure (no DOM), unit-tested.
// YouState.cd.primary is (gunReadyTick − tick) / (class gunCooldown · TICK_RATE), clamped to 1. While
// attached, gunReadyTick is set by the turret kit (flakCd / podCd, several times longer than the class
// gun), so the raw value sits at 1 for most of the reload and then drops to 0 in the last moment.
// Below 1 the value is exact (remaining = cd · gunCooldown); at the clamp we only know "≥ gunCooldown",
// so the estimator times the reload locally from the moment it saw it start.

/** Reload time (s) of a turret kit's offense, or 0 for continuous weapons (Laser Lance). */
export function turretOffenseCooldown(kitId: string, skill: Record<string, number>): number {
  switch (kitId) {
    case 'flak': return skill.flakCd ?? 0.45;
    case 'seekerpod': return skill.podCd ?? 1;
    default: return 0;
  }
}

export class TurretReload {
  /** performance.now() at which the reload is estimated to finish (0 = unknown / ready). */
  private readyAt = 0;
  private last = 0;

  reset(): void { this.readyAt = 0; this.last = 0; }

  /**
   * Remaining fraction 0..1 of the kit reload. `cdFrac` = YouState.cd.primary, `gunCd` = stats.gunCooldown,
   * `kitCd` = turretOffenseCooldown(...), `nowMs` = frame time.
   */
  frac(cdFrac: number, gunCd: number, kitCd: number, nowMs: number): number {
    const started = cdFrac >= 1 && this.last < 1; // a new reload began (from ready, or from the tail of the last one)
    this.last = cdFrac;
    if (!(kitCd > 0) || !(cdFrac > 0)) { this.readyAt = 0; return 0; }
    if (cdFrac < 1) {
      const rem = cdFrac * gunCd; // exact
      this.readyAt = nowMs + rem * 1000;
      return Math.min(1, rem / kitCd);
    }
    if (started || this.readyAt === 0) this.readyAt = nowMs + kitCd * 1000;
    const rem = Math.max(gunCd, (this.readyAt - nowMs) / 1000);
    return Math.min(1, rem / kitCd);
  }
}
