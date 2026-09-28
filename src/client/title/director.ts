// Event timeline for the Title attract scene (pure, no DOM). A 20 s cycle: the Juggernaut set-piece opens
// each cycle, one "major" beat (a dogfight or a swarm chase, alternating) follows once it has crossed, and
// small ambient flybys / shooting stars fill the gaps. Majors never overlap, so the scene stays calm
// enough for the login panel to remain the focus.
import { range, type Rand } from './sceneMath';

export type SceneEvent = 'flyby' | 'dogfight' | 'swarm' | 'setpiece' | 'shooting';

export interface DirectorTiming {
  /** A short dogfight right after load, so the scene is alive at once. */
  firstMajor: number;
  setpieceFirst: number;
  setpieceEvery: number;
  /** How long the set-piece owns the stage (the Juggernaut's crossing). */
  setpieceLength: number;
  /** When the cycle's major beat starts, relative to the set-piece start. */
  majorOffset: readonly [number, number];
  flybyEvery: readonly [number, number];
  shootingEvery: readonly [number, number];
}

export const DEFAULT_TIMING: DirectorTiming = {
  firstMajor: 0.6,
  setpieceFirst: 6.5,
  setpieceEvery: 20,
  setpieceLength: 11,
  majorOffset: [11.5, 12.5],
  flybyEvery: [1.8, 3.6],
  shootingEvery: [2.5, 6.5],
};

export class Director {
  t = 0;
  private readonly tm: DirectorTiming;
  private nextSetpiece: number;
  private nextMajor: number;
  private majorKind: 'dogfight' | 'swarm' = 'dogfight';
  private nextFlyby: number;
  private nextShooting: number;

  constructor(private rand: Rand, timing: Partial<DirectorTiming> = {}) {
    this.tm = { ...DEFAULT_TIMING, ...timing };
    this.nextSetpiece = this.tm.setpieceFirst;
    this.nextMajor = this.tm.firstMajor;
    this.nextFlyby = range(rand, 0.3, 1.2);
    this.nextShooting = range(rand, 1, 3);
  }

  /** Start time of the next set-piece (scene time, s). */
  get setpieceAt(): number { return this.nextSetpiece; }

  /** Advance the clock by dt seconds and append the events that fell due (in time order per kind). */
  step(dt: number, out: SceneEvent[]): void {
    this.t += Math.max(0, dt);
    const t = this.t;
    const tm = this.tm;
    while (t >= this.nextMajor) {
      out.push(this.majorKind);
      this.majorKind = this.majorKind === 'dogfight' ? 'swarm' : 'dogfight';
      // The next major follows the next set-piece's crossing (the first one precedes the first set-piece).
      const sp = this.nextMajor < this.nextSetpiece ? this.nextSetpiece : this.nextSetpiece + tm.setpieceEvery;
      this.nextMajor = sp + range(this.rand, tm.majorOffset[0], tm.majorOffset[1]);
    }
    while (t >= this.nextSetpiece) {
      out.push('setpiece');
      this.nextSetpiece += tm.setpieceEvery;
    }
    while (t >= this.nextFlyby) {
      out.push('flyby');
      this.nextFlyby += range(this.rand, tm.flybyEvery[0], tm.flybyEvery[1]);
    }
    while (t >= this.nextShooting) {
      out.push('shooting');
      this.nextShooting += range(this.rand, tm.shootingEvery[0], tm.shootingEvery[1]);
    }
  }
}
