// FROZEN CONTRACT — the seam between the CLIENT agent (net/input/ui/main) and the RENDER agent (render/audio).

import type { PlayerInfo } from '../shared/protocol';
import type {
  CarryView, DeployableView, EnemyView, EntityId, GameEvent, GameMap, GemView, LootView, MatchView, PlayerId,
  ProjectileView, ShipView, YouState,
} from '../shared/types';

/**
 * One render frame's worth of state, produced by the client GameClient (interpolated remote
 * entities, predicted local ship) and consumed by GameRenderer.render(). Positions are world px.
 */
export interface RenderFrame {
  /** Seconds since page load (monotonic), for animation. */
  time: number;
  /** Seconds since previous frame. */
  dt: number;
  /** Fractional server tick being displayed (interpolated). Use for Orbit Blade angles. */
  renderTick: number;
  localPlayerId: PlayerId;
  /** 0 when spectating or not spawned yet. */
  localShipId: EntityId;
  /** Camera focus point (local ship, or spectate target / map center). */
  focusX: number;
  focusY: number;
  ships: ShipView[];
  enemies: EnemyView[];
  projectiles: ProjectileView[];
  gems: GemView[];
  /** v0.2: sentries, walls, wells, drones, napalm, nanite clouds (interpolated). */
  deployables: DeployableView[];
  /** Events that arrived since the previous frame — each is delivered exactly once. */
  events: GameEvent[];
  you: YouState | null;
  match: MatchView | null;
  /** playerId -> info, for name labels and colors. */
  players: Map<PlayerId, PlayerInfo>;
  /** World-space aim point of the local player (cursor / stick), for the reticle. */
  aimX: number;
  aimY: number;
  /** Ship id of the teammate the attach key would target (highlight it), 0 = none. */
  attachCandidateId: EntityId;
  /** v0.3: in-world caches (interpolated like gems). Absent = none. */
  loot?: LootView[];
  /** v0.3: ships carrying unsecured caches (carrier pips + radar beacons). */
  carry?: CarryView[];
  // Cosmetics need no new field: the renderer reads frame.players.get(pid)?.cosmetics.
  // Rift/objective state arrives via frame.match.dungeon / frame.match.objective and setMap(map)
  // (map.dungeon / map.features).
}

/** Implemented by render/GameRenderer.ts (RENDER agent). */
export interface IGameRenderer {
  /** Create the Pixi app inside `parent` (fills it, handles resize itself). */
  init(parent: HTMLElement): Promise<void>;
  /** Called at matchStart AND at every rift floorStart (must be re-entrant: rebuild walls, minimap,
   *  rift/objective layers; sweep unused ship caches). */
  setMap(map: GameMap): void;
  render(frame: RenderFrame): void;
  /** Screen (CSS px relative to the canvas) -> world px, using the most recent camera. */
  screenToWorld(sx: number, sy: number): { x: number; y: number };
  /** Toggle the fullscreen big-map overlay. */
  setBigMap(open: boolean): void;
  /** 0..1 user setting */
  setScreenShake(amount: number): void;
  destroy(): void;
}

/** Implemented by audio/AudioFx.ts (RENDER agent). Synthesized WebAudio — no asset files. */
export interface IAudioFx {
  /** Must be called from a user gesture (click/keypress) to unlock audio. */
  unlock(): void;
  /** Play SFX for new events, attenuated by distance from the listener. */
  playEvents(events: GameEvent[], listenerX: number, listenerY: number, localShipId: EntityId): void;
  /** UI blips: 'click' | 'chat' | 'levelUp' | 'select' | 'error' | 'countdown' | 'start' */
  ui(name: string): void;
  setVolume(master: number): void;
}
