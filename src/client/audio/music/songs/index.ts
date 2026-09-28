// SONG REGISTRY. Composers: add your song file under songs/, import it here, and point the
// matching SONGS entry at it (or add a new SongId and remap SCENE_SONG). Every entry is validated
// by songs.test.ts and songcraft.test.ts.
//
// The Voidswarm soundtrack (all ORIGINAL, see each file's header for its structure):
//   title    "Voidswarm (Main Theme)"  D minor, 122 bpm, key change to E minor   title.ts
//   command  "Command Deck"            D dorian, 100 bpm, 32-bar loop            command.ts
//   match    "Swarm Protocol"          A minor, 136 bpm, intensity-layered       match.ts
//   boss     "Hive Mother"             E phrygian, 150 bpm                       boss.ts
//   victory  "Victory"                 5-bar one-shot, A minor → A major         victory.ts
//   defeat   "Defeat"                  5-bar one-shot lament, A minor            defeat.ts
// The shared leitmotif (the hook) lives in themes.ts; composer helpers in lib.ts.
import type { MusicScene, Song } from '../format';
import { BOSS } from './boss';
import { COMMAND } from './command';
import { DEFEAT } from './defeat';
import { MATCH } from './match';
import { PLACEHOLDER } from './placeholder';
import { TITLE } from './title';
import { VICTORY } from './victory';

export type SongId = 'title' | 'command' | 'lobby' | 'match' | 'boss' | 'victory' | 'defeat' | 'placeholder';

export const SONGS: Record<SongId, Song> = {
  title: TITLE,
  command: COMMAND,
  // the same Song object as command: switching command ↔ lobby keeps the music running
  lobby: COMMAND,
  match: MATCH,
  boss: BOSS,
  victory: VICTORY,
  defeat: DEFEAT,
  // engine fallback only (the director plays it if a registered song fails to compile)
  placeholder: PLACEHOLDER,
};

/**
 * Which song each game scene plays. Two scenes that map to the SAME Song object share it: switching
 * between them keeps the music running without a transition (e.g. command ↔ lobby).
 */
export const SCENE_SONG: Record<MusicScene, SongId> = {
  title: 'title',
  command: 'command',
  lobby: 'lobby',
  match: 'match',
  boss: 'boss',
  victory: 'victory',
  defeat: 'defeat',
};
