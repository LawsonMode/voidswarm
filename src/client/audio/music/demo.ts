// /music-demo.html: scene buttons, intensity/volume, live meter, section/bar display, offline
// CPU benchmark. Also exposes window.__music for automated checks.
import { renderOffline, type OfflineReport } from './bench';
import { compileSong } from './compile';
import { MusicDirector } from './director';
import { MUSIC_SCENES, type MusicScene } from './format';
import { SCENE_SONG, SONGS, type SongId } from './songs/index';

const app = document.getElementById('app')!;
const director = new MusicDirector();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { cls?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  const { cls, ...rest } = props;
  Object.assign(e, rest);
  if (cls) e.className = cls;
  for (const k of kids) e.append(k);
  return e;
}

function panel(title: string, ...kids: (Node | string)[]): HTMLElement {
  return el('section', { cls: 'panel' }, el('h2', { textContent: title }), ...kids);
}

// ------------------------------------------------------------------ header / unlock
app.append(
  el('h1', { textContent: 'VOIDSWARM · MUSIC ENGINE' }),
  el('p', { cls: 'sub', textContent: 'All synthesized in WebAudio. No audio happens until you click Start (unlock).' }),
);
const startBtn = el('button', { cls: 'big', textContent: '▶ Start audio (unlock)' });
app.append(panel('Audio', el('div', { cls: 'row' }, startBtn)));

// ------------------------------------------------------------------ scenes
const sceneBtns = new Map<MusicScene, HTMLButtonElement>();
const sceneRow = el('div', { cls: 'row' });
for (const s of MUSIC_SCENES) {
  const b = el('button', { textContent: s });
  b.onclick = (): void => { director.setScene(s); refreshScenes(); };
  sceneBtns.set(s, b);
  sceneRow.append(b);
}
function refreshScenes(): void {
  const cur = director.getState().scene;
  for (const [s, b] of sceneBtns) b.classList.toggle('on', s === cur);
}
app.append(panel('Scene', sceneRow));

// ------------------------------------------------------------------ controls
const intensity = el('input', { type: 'range', min: '0', max: '1', step: '0.01', value: '0.5' });
const intensityVal = el('span', { cls: 'kv', textContent: '0.50' });
intensity.oninput = (): void => { director.setIntensity(Number(intensity.value)); intensityVal.textContent = Number(intensity.value).toFixed(2); };
const volume = el('input', { type: 'range', min: '0', max: '1', step: '0.01', value: '0.8' });
const volumeVal = el('span', { cls: 'kv', textContent: '0.80' });
volume.oninput = (): void => { director.setVolume(Number(volume.value)); volumeVal.textContent = Number(volume.value).toFixed(2); };
const mute = el('button', { textContent: 'Mute' });
mute.onclick = (): void => { const m = !director.getState().muted; director.setMuted(m); mute.classList.toggle('on', m); };
const stinger = el('button', { textContent: '★ Level-up stinger' });
stinger.onclick = (): void => director.stingerLevelUp();
const waveBtn = el('button', { textContent: '⚑ Wave start' });
waveBtn.onclick = (): void => director.stingerWaveStart();
const bossBtn = el('button', { textContent: '☠ Boss incoming' });
bossBtn.onclick = (): void => director.stingerBossIncoming();
const jumpSel = el('select');
const jumpBtn = el('button', { textContent: 'Jump (next bar)' });
jumpBtn.onclick = (): void => { if (jumpSel.value) director.jumpToSection(jumpSel.value); };
app.append(panel('Controls',
  el('div', { cls: 'row' }, el('label', { textContent: 'Intensity' }), intensity, intensityVal),
  el('div', { cls: 'row' }, el('label', { textContent: 'Volume   ' }), volume, volumeVal, mute),
  el('div', { cls: 'row' }, stinger, waveBtn, bossBtn, el('label', { textContent: 'Section' }), jumpSel, jumpBtn),
));
director.setIntensity(0.5);
director.setVolume(0.8);

// ------------------------------------------------------------------ meter + status
const peakFill = el('div', { cls: 'fill' });
const peakHold = el('div', { cls: 'hold' });
const rmsFill = el('div', { cls: 'fill' });
const meterTxt = el('div', { cls: 'kv' });
const status = el('div', { cls: 'grid' });
app.append(panel('Output',
  el('div', { cls: 'kv', textContent: 'Peak' }), el('div', { cls: 'meter' }, peakFill, peakHold),
  el('div', { cls: 'kv', textContent: 'RMS' }), el('div', { cls: 'meter' }, rmsFill),
  meterTxt,
), panel('Now playing', status));

// ------------------------------------------------------------------ benchmark + validation
const benchSong = el('select');
for (const id of Object.keys(SONGS) as SongId[]) benchSong.append(el('option', { value: id, textContent: `${id} — ${SONGS[id].title}` }));
benchSong.value = 'match';
const benchBtn = el('button', { textContent: 'Offline render 12 s @ intensity 1 (timed after 4 s)' });
const benchOut = el('div', { cls: 'mono' });
benchBtn.onclick = async (): Promise<void> => {
  benchBtn.disabled = true;
  benchOut.textContent = 'rendering…';
  try {
    const id = benchSong.value as SongId;
    // the first chorus-kind section (songs name their sections freely: 'chorus', 'B', 'payoff', ...)
    const target = Object.entries(SONGS[id].sections).find(([n, s]) => (s.kind ?? n) === 'chorus')?.[0];
    const r = await bench(id, 12, 1, target);
    benchOut.textContent = fmtReport(r);
  } catch (e) { benchOut.textContent = String(e); }
  benchBtn.disabled = false;
};
const valOut = el('div', { cls: 'mono' });
const lines: string[] = [];
for (const id of Object.keys(SONGS) as SongId[]) {
  const r = compileSong(SONGS[id]);
  lines.push(`${id.padEnd(12)} ${r.errors.length ? `✗ ${r.errors.length} errors` : '✓'}  ${r.warnings.length} warnings${r.errors.length ? `\n    ${r.errors.join('\n    ')}` : ''}`);
}
valOut.textContent = lines.join('\n');
app.append(panel('Benchmark (OfflineAudioContext, same engine)', el('div', { cls: 'row' }, benchSong, benchBtn), benchOut),
  panel('Song validation', valOut));

function fmtReport(r: OfflineReport): string {
  const db = (x: number): string => (x > 0 ? (20 * Math.log10(x)).toFixed(1) : '-inf');
  return `steady-state CPU ≈ ${(r.cpu * 100).toFixed(2)} % of one core (audio ${(r.audioCpu * 100).toFixed(2)} % + scheduling ${(r.jsCpu * 100).toFixed(2)} %)\n`
    + `peak ${r.peak.toFixed(3)} (${db(r.peak)} dBFS)   RMS ${r.rms.toFixed(3)} (${db(r.rms)} dBFS)   clipped ${(r.clipped * 100).toFixed(3)} %\n`
    + `short-term (400 ms) ${r.shortTermMinDb.toFixed(1)} .. ${r.shortTermMaxDb.toFixed(1)} dBFS   longest near-silence ${r.longestGap.toFixed(2)} s`;
}

function bench(id: SongId, seconds: number, i: number, jumpTo?: string, sampleRate?: number): Promise<OfflineReport> {
  return renderOffline(SONGS[id], { seconds, intensity: i, jumpTo, warmup: Math.min(4, seconds / 3), sampleRate });
}

// ------------------------------------------------------------------ live metering
const buf = new Float32Array(2048);
const stats = { frames: 0, maxPeak: 0, sumRms: 0, sumSq: 0, clipFrames: 0, silentFrames: 0 };
let hold = 0;
let holdAt = 0;
function resetStats(): void { Object.assign(stats, { frames: 0, maxPeak: 0, sumRms: 0, sumSq: 0, clipFrames: 0, silentFrames: 0 }); }

function meter(): void {
  const an = director.getAnalyser();
  if (!an) return;
  an.getFloatTimeDomainData(buf);
  let pk = 0;
  let sq = 0;
  for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]!); if (a > pk) pk = a; sq += buf[i]! * buf[i]!; }
  const rms = Math.sqrt(sq / buf.length);
  if (director.getState().running) {
    stats.frames++;
    stats.maxPeak = Math.max(stats.maxPeak, pk);
    stats.sumRms += rms;
    stats.sumSq += rms * rms;
    if (pk >= 0.98) stats.clipFrames++;
    if (rms < 1e-4) stats.silentFrames++;
  }
  const now = performance.now();
  if (pk >= hold || now - holdAt > 1500) { hold = pk; holdAt = now; }
  const pct = (x: number): string => `${Math.min(100, Math.max(0, ((20 * Math.log10(Math.max(x, 1e-5)) + 60) / 60) * 100))}%`;
  peakFill.style.width = pct(pk);
  peakHold.style.left = pct(hold);
  rmsFill.style.width = pct(rms);
  const db = (x: number): string => (x > 1e-5 ? (20 * Math.log10(x)).toFixed(1) : '-inf');
  meterTxt.textContent = `peak ${pk.toFixed(3)} (${db(pk)} dBFS)  RMS ${rms.toFixed(3)} (${db(rms)} dBFS)  max since reset ${stats.maxPeak.toFixed(3)}  clip frames ${stats.clipFrames}`;
}

function kv(k: string, v: string): HTMLElement {
  return el('div', { cls: 'kv' }, el('b', { textContent: k }), v);
}

let lastSong = '';
function renderStatus(): void {
  const s = director.getState();
  status.replaceChildren(
    kv('song', s.song ?? '—'),
    kv('section', s.section ? `${s.section} (${s.kind})` : '—'),
    kv('bar', s.bars ? `${s.bar} / ${s.bars}` : '—'),
    kv('tempo / key', s.bpm ? `${s.bpm} bpm · ${s.key}` : '—'),
    kv('intensity', `${s.intensity.toFixed(2)} → eff ${s.effective.toFixed(2)}`),
    kv('voices', `${s.voices} (steals ${s.steals})`),
    kv('transition', s.pending ? `→ ${s.pending}` : s.ended ? 'song ended' : '—'),
    kv('state', `${s.unlocked ? (s.running ? 'running' : 'suspended') : 'locked'} · ${s.sampleRate ? `${s.sampleRate / 1000} kHz · ` : ''}t=${s.time.toFixed(1)} s`),
    kv('layers', s.layers.join(' ') || '—'),
  );
  if (s.song && s.song !== lastSong) {
    lastSong = s.song;
    const scene = s.scene;
    const id = scene ? SCENE_SONG[scene] : 'placeholder';
    jumpSel.replaceChildren(...Object.keys(SONGS[id].sections).map((n) => el('option', { value: n, textContent: n })));
  }
}

startBtn.onclick = (): void => {
  director.unlock();
  if (!director.getState().scene) director.setScene('title');
  refreshScenes();
  startBtn.textContent = '✓ Audio unlocked';
};

setInterval(meter, 50);
setInterval(renderStatus, 200);
renderStatus();

// automation hooks (used by the browser checks)
(window as unknown as { __music: unknown }).__music = {
  director,
  stats: () => ({ ...stats, avgRms: stats.frames ? stats.sumRms / stats.frames : 0 }),
  resetStats,
  bench,
};
