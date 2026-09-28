// Dev-only harness for the Title attract scene (title/demo.html).
//   default   the scene alone, with mock logo / panel rects and a stats readout
//   ?ui=1     the real TitleScreen (styles.css, stub callbacks) over its scene; &static=1 = the static-host layout
//   ?q=0|1|2  pin the quality level          ?reduced=1  the reduced-motion poster
//   ?ff=<s>   fast-forward the timeline      ?snap=<ms>  show the canvas read back into an <img> after that long
//                                                         (headless screenshots can miss canvas updates)
//   ?debug=1  scene clock + ship positions in the readout
import { TitleScene } from './TitleScene';

const params = new URLSearchParams(location.search);
const host = document.getElementById('host')!;
const hud = document.getElementById('hud')!;

function sceneInternals(s: TitleScene) {
  return s as unknown as {
    rebuild(): void; step(dt: number): void; applyQuality(): void; t: number; W: number; H: number; dpr: number;
    governor: { level: number; sample: () => boolean }; cast: { crafts: { x: number; y: number; r: number }[] };
  };
}

function snapshotLater(canvas: HTMLCanvasElement, into: HTMLElement): void {
  const snap = Number(params.get('snap') ?? 0);
  if (!(snap > 0)) return;
  setTimeout(() => {
    const img = document.createElement('img');
    img.src = canvas.toDataURL('image/png');
    img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:1';
    into.appendChild(img);
  }, snap);
}

function readout(scene: TitleScene): void {
  setInterval(() => {
    const s = scene.stats, p = scene.profile;
    let text = `draw ${s.drawMs.toFixed(2)} ms  (back ${p.back.toFixed(2)} · cast ${p.cast.toFixed(2)})${s.fallback ? '  STATIC FALLBACK' : ''}\n`
      + `frame ${s.frameMs.toFixed(1)} ms  q${s.quality}  dpr ${s.dpr}  stars ${s.stars}  ships ${s.crafts}  particles ${s.particles}`;
    if (params.get('debug')) {
      const sc = sceneInternals(scene);
      text += `\nt ${sc.t.toFixed(2)}  ${sc.W}x${sc.H}  ` + sc.cast.crafts.slice(0, 4).map((c) => `(${c.x | 0},${c.y | 0} r${c.r | 0})`).join(' ');
    }
    hud.textContent = text;
  }, 250);
}

function tune(scene: TitleScene): void {
  const sc = sceneInternals(scene);
  const ff = Number(params.get('ff') ?? 0);
  if (ff > 0) { sc.rebuild(); for (let i = 0; i < ff * 60; i++) sc.step(1 / 60); }
  const pin = params.get('q');
  if (pin !== null) {
    sc.governor.level = Math.max(0, Math.min(2, Number(pin) | 0));
    sc.governor.sample = () => false;
    sc.applyQuality();
  }
}

async function mountUi(): Promise<void> {
  await import('../styles.css');
  const { TitleScreen } = await import('../ui/TitleScreen');
  document.body.classList.add('device-kbm');
  host.remove();
  const ui = document.createElement('div');
  ui.id = 'ui';
  ui.style.cssText = 'position:absolute;inset:0;z-index:2';
  document.body.prepend(ui);
  const log = (what: string) => () => { hud.textContent = `clicked: ${what}`; };
  const title = new TitleScreen({
    onOnline: log('online'), onOffline: log('offline'), onSettings: log('settings'), onControls: log('controls'),
  }, {
    name: 'Pilot', server: { url: 'ws://localhost:7777', source: 'default', pending: null }, resetToken: null,
    resetServerUrl: 'ws://localhost:7777', pageHost: location.hostname, staticHost: params.get('static') === '1',
  });
  ui.appendChild(title.root);
  title.root.classList.add('active');
  hud.style.zIndex = '5';
  // the scene is created by the screen when it becomes active
  requestAnimationFrame(() => {
    const scene = (window as unknown as { __voidswarmTitle?: TitleScene }).__voidswarmTitle;
    if (!scene) return;
    tune(scene);
    readout(scene);
    const bg = title.root.querySelector<HTMLElement>('.title-bg');
    if (bg) snapshotLater(scene.canvas, bg);
  });
}

function mountScene(): void {
  const scene = new TitleScene(host, { reducedMotion: params.get('reduced') === '1' });
  const mocks = [document.createElement('div'), document.createElement('div')];
  for (const m of mocks) { m.className = 'mock'; document.body.appendChild(m); }
  const layout = (): void => {
    const W = innerWidth, H = innerHeight;
    const colW = Math.min(544, W - 32);
    const logoW = Math.min(colW * 1.3, W - 32), logoH = Math.max(34, Math.min(112, Math.min(W, H) * 0.09));
    const top = Math.max(16, (H - 560) / 2);
    const logo = { left: (W - logoW) / 2, top, right: (W + logoW) / 2, bottom: top + logoH };
    const focus = { left: (W - colW) / 2, top, right: (W + colW) / 2, bottom: Math.min(H - 16, top + 560) };
    scene.setAnchors({ logo, focus });
    [logo, focus].forEach((r, i) => Object.assign(mocks[i].style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.right - r.left}px`, height: `${r.bottom - r.top}px` }));
  };
  layout();
  addEventListener('resize', layout);
  tune(scene);
  scene.start();
  readout(scene);
  snapshotLater(scene.canvas, host);
}

/** ?frames=1: the ui mode at phone sizes, side by side (same-origin iframes; the rest of the query is passed on). */
function mountFrames(): void {
  host.remove();
  hud.remove();
  document.body.style.cssText = 'margin:0;background:#222;overflow:auto;display:flex;gap:16px;padding:16px;align-items:flex-start';
  const rest = new URLSearchParams(params);
  rest.delete('frames');
  const sizes: [number, number, string][] = [[360, 740, ''], [390, 844, '&static=1']];
  for (const [w, h, extra] of sizes) {
    const f = document.createElement('iframe');
    f.width = String(w);
    f.height = String(h);
    f.style.border = '0';
    f.src = `demo.html?ui=1&${rest.toString()}${extra}`;
    document.body.appendChild(f);
  }
}

if (params.get('frames') === '1') mountFrames();
else if (params.get('ui') === '1') void mountUi();
else mountScene();
