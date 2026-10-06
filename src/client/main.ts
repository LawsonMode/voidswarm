// Voidswarm client entry: boot, screens state machine, fixed-rate input loop, per-frame render.
import './fonts.css';
import './styles.css';
import type { IAudioFx, IGameRenderer, RenderFrame } from './contracts';
import { GameRenderer } from './render/GameRenderer';
import { AudioFx } from './audio/AudioFx';
import { MusicDirector } from './audio/music/director';
import { MusicDriver, type MusicSink } from './musicDriver';
import { DT, NAME_MAX_LEN } from '../shared/constants';
import { GAME_TYPES } from '../shared/data/gameTypes';
import type { GameEvent, GameMap, GameType } from '../shared/types';
import { InputManager, type UiAction } from './input/InputManager';
import { pickAttachCandidate } from './net/attach';
import { ConnectSuperseded, GameClient } from './net/GameClient';
import { apiBaseFromServerUrl, isSessionExpiredMessage, SESSION_EXPIRED_MSG } from './net/accounts';
import { classifyClose, closeNoticeText, retryStatusParts, SessionRetry, type RedialSession } from './net/reconnect';
import { fetchChatNotice } from './net/serverInfo';
import { defaultServerUrl, normalizeServerUrl, resolveServer } from './net/serverUrl';
import { QuarkLink } from './quark';
import { loadSettings, saveSettings, type ClientSettings } from './settings';
import { loadStr, saveStr } from './storage';
import { CommandScreen } from './ui/CommandScreen';
import { activateFocused, moveFocus } from './ui/FocusNav';
import { HangarModal } from './ui/HangarModal';
import { Hud } from './ui/Hud';
import { grantSummary } from './ui/lootInfo';
import { MobileSupport } from './ui/mobile';
import { ControlsModal, CreateGameModal, MenuModal, SettingsModal, Toasts, type Modal } from './ui/Overlays';
import { LagLabPanel } from './ui/LagLabPanel';
import { QuarkLimitNotice, QuarkModal } from './ui/QuarkPanel';
import { RoomLobby } from './ui/RoomLobby';
import { ResultsScreen, Scoreboard } from './ui/Scoreboard';
import { TitleScreen } from './ui/TitleScreen';

/** v0.3: 'command' replaces the v0.2 'zone' lobby; the Hangar is a modal, not a screen (computeScreen stays derived). */
type ScreenId = 'title' | 'command' | 'room' | 'game';

const KEY_NAME = 'voidswarm.name';
const KEY_SERVER = 'voidswarm.server';

/** An online session that reached the zone: what an auto-reconnect dials again (net/reconnect.ts). */
type LiveSession = RedialSession;

/** Used only if the real renderer fails to initialize — keeps the UI usable. */
class FallbackRenderer implements IGameRenderer {
  private fx = 0; private fy = 0; private w = 0; private h = 0;
  constructor(private host: HTMLElement) {}
  async init(): Promise<void> { /* nothing */ }
  setMap(_map: GameMap): void { /* nothing */ }
  render(f: RenderFrame): void { this.fx = f.focusX; this.fy = f.focusY; this.w = this.host.clientWidth; this.h = this.host.clientHeight; }
  screenToWorld(sx: number, sy: number) { return { x: this.fx + sx - this.w / 2, y: this.fy + sy - this.h / 2 }; }
  setBigMap(): void { /* nothing */ }
  setScreenShake(): void { /* nothing */ }
  destroy(): void { /* nothing */ }
}

const NULL_AUDIO: IAudioFx = { unlock() {}, playEvents() {}, ui() {}, setVolume() {} };

async function boot(): Promise<void> {
  const gameHost = document.getElementById('game')!;
  const uiHost = document.getElementById('ui')!;
  const overlayHost = document.getElementById('overlays')!;

  let settings: ClientSettings = loadSettings();

  // --- renderer / audio (RENDER agent) — degrade gracefully if unavailable.
  let renderer: IGameRenderer;
  try {
    const r = new GameRenderer() as IGameRenderer;
    await r.init(gameHost);
    renderer = r;
  } catch (e) {
    console.error('[voidswarm] renderer failed to initialize; running UI-only', e);
    renderer = new FallbackRenderer(gameHost);
  }
  let audio: IAudioFx;
  try { audio = new AudioFx() as IAudioFx; } catch (e) { console.error('[voidswarm] audio unavailable', e); audio = NULL_AUDIO; }
  const safeAudio: IAudioFx = {
    unlock: () => { try { audio.unlock(); } catch { /* ignore */ } },
    playEvents: (ev: GameEvent[], x: number, y: number, id: number) => { try { audio.playEvents(ev, x, y, id); } catch { /* ignore */ } },
    ui: (n: string) => { try { audio.ui(n); } catch { /* ignore */ } },
    setVolume: (v: number) => { try { audio.setVolume(v); } catch { /* ignore */ } },
  };
  // v0.3 M4: one MusicDirector for the page (its own AudioContext, created on the first gesture by unlock()).
  let musicSink: MusicSink | null = null;
  try { musicSink = new MusicDirector(); } catch (e) { console.error('[voidswarm] music unavailable', e); }
  const music = new MusicDriver(musicSink ?? {
    unlock() {}, setScene() {}, setIntensity() {}, setVolume() {}, setMuted() {},
    stingerLevelUp() {}, stingerWaveStart() {}, stingerBossIncoming() {},
  });
  music.setHidden(typeof document !== 'undefined' && document.hidden);
  document.addEventListener('visibilitychange', () => music.setHidden(document.hidden));
  const applySettings = () => {
    safeAudio.setVolume(settings.volume);
    music.setSettings(settings.musicVolume, settings.musicMuted);
    try { renderer.setScreenShake(settings.screenShake); } catch { /* ignore */ }
  };
  applySettings();

  const unlock = () => {
    safeAudio.unlock();
    music.unlock();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);

  const client = new GameClient(renderer);
  if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__voidswarm = { client, music, musicDirector: musicSink };
  const input = new InputManager(() => settings);
  input.attach(gameHost);
  const ui = (n: string) => safeAudio.ui(n);

  // --- screens & overlays
  const savedName = loadStr(KEY_NAME) || `Pilot${100 + Math.floor(Math.random() * 900)}`;
  // An untrusted ?server= comes back as `pending`: TitleScreen asks before anything is sent there.
  const server = resolveServer(window.location, loadStr(KEY_SERVER));
  const resetToken = takeResetToken();
  const toasts = new Toasts();
  const settingsModal = new SettingsModal(() => settings, (s) => { settings = s; saveSettings(s); applySettings(); });
  const controlsModal = new ControlsModal();
  const createGame = new CreateGameModal(
    (s) => { client.send({ type: 'createRoom', settings: s }); ui('click'); },
    (t: GameType) => `${client.name || 'Pilot'}'s ${GAME_TYPES[t].houseName}`);
  // v0.3 M2: equip cosmetics per class (Command top bar, Esc menu on Command, RoomLobby "Loadout").
  const hangar = new HangarModal(client, { onUi: (n) => ui(n) });
  const openCreate = (t: GameType) => openModal(createGame.openFor(t));
  let screen: ScreenId = 'title';
  let bigMap = false;
  let chatFocused = false;

  // --- LAN edition §3.7: an unexpected close retries for 60 s (net/reconnect.ts SessionRetry: the same server,
  // callsign and token), with the host-lost / restart text on its own Title line.
  /** The online session in play (null offline, on the title, and while reconnecting). */
  let live: LiveSession | null = null;
  let connecting = false;
  const retry = new SessionRetry({
    client,
    // an account session is only redialled while the Title still holds its token (never after Log out)
    currentToken: () => title.sessionToken,
    canAttempt: () => !connecting,
    onStatus: (s) => {
      if (s.state === 'waiting' || s.state === 'trying') {
        const p = retryStatusParts(s.notice, s.secondsLeft);
        title.setRetryStatus(p.text, p.countdown);
      } else if (s.state === 'gaveUp') {
        title.setRetryStatus(s.notice, '', true);
        ui('error');
      } else {
        title.setRetryStatus(''); // connected / stopped
      }
    },
    onRefused: (msg) => {
      // A refusal on purpose (ws close 4001: banned, session revoked, guests off...; a protocol mismatch after an
      // update): the retry ends with the server's message.
      showTitle(msg, true);
      if (isSessionExpiredMessage(msg)) title.expireSession(msg);
      ui('error');
    },
    onReconnected: (s, accepted) => {
      live = { url: s.url, name: s.name, token: accepted ? s.token : undefined };
      if (!accepted) {
        title.expireSession(SESSION_EXPIRED_MSG);
        toasts.show('Your session expired — playing as a guest. Log in again to use your account.', 'error', 6000);
      }
      title.setStatus('', false);
      title.noteAccount(client.account);
      toasts.show('Reconnected.', 'info', 3000);
      ui('start');
      loadChatNotice(s.url);
      refresh();
    },
  });
  /** Stop any auto-reconnect (and an attempt in flight): the player chose what happens next (Play, Log in, Quit...). */
  const stopReconnect = () => { retry.stop(); title.setRetryStatus(''); };

  // --- LAN edition §4.15: the server's chat notice (GET /api/info → notice) at the top of the lobby chat panels.
  let noticeSeq = 0;
  const setChatNotice = (text: string) => { command.chat.setNotice(text); room.chat.setNotice(text); };
  const loadChatNotice = (serverUrl: string) => {
    const seq = ++noticeSeq;
    setChatNotice('');
    const base = apiBaseFromServerUrl(serverUrl);
    if (!base) return;
    void fetchChatNotice(base).then((text) => { if (seq === noticeSeq && live) setChatNotice(text); });
  };
  const clearChatNotice = () => { noticeSeq++; setChatNotice(''); };

  const leave = () => { client.send({ type: 'leaveRoom' }); ui('click'); menu.close(); };
  /** Log out (account) / Disconnect (guest) / Quit to Title (offline). */
  const exitLabel = () => (client.offline ? 'Quit to Title' : client.account ? 'Log out' : 'Disconnect');
  const exit = () => {
    menu.close();
    const logOut = !client.offline && !!client.account;
    live = null;
    stopReconnect();
    clearChatNotice();
    client.disconnect(true);
    showTitle('');
    if (logOut) void title.logout();
  };
  /** Command's guest banner: leave the zone and open the Create account form. */
  const createAccount = () => {
    live = null;
    stopReconnect();
    clearChatNotice();
    client.disconnect(true);
    showTitle('');
    title.showView('register');
  };
  // Optional school sign-in (Quark): inert unless the page is served by a Quark games host (quark.ts).
  const quark = new QuarkLink();
  const quarkModal = new QuarkModal(quark);
  const quarkLimit = new QuarkLimitNotice(quark);
  // Lag Lab (docs/LAG-LAB.md): a docked panel, so the match keeps running while the network is made worse (offline play only).
  const lagLab = new LagLabPanel(client, {
    onQuiz: (score) => quark.reportLagQuiz(score),
    onReport: (text) => quark.submitLagReport(text),
    canSend: () => quark.canReportLagLab,
  }, ui);
  const menu = new MenuModal(() => {
    const items: { label: string; action: () => void; danger?: boolean }[] = [
      { label: 'Resume', action: () => menu.close() },
      { label: 'Settings', action: () => { menu.close(); openModal(settingsModal); } },
      { label: 'Controls', action: () => { menu.close(); openModal(controlsModal); } },
    ];
    if (quark.available) items.push({ label: quark.user ? `School sign-in (${quark.user.name})` : 'School sign-in', action: () => { menu.close(); openModal(quarkModal); } });
    if (client.offline && screen !== 'title') items.push({ label: lagLab.visible ? 'Close Lag Lab' : 'Lag Lab', action: () => { menu.close(); lagLab.toggle(); } });
    if (screen === 'command') items.push({ label: 'Hangar', action: () => { menu.close(); openModal(hangar); } });
    if (screen === 'game') items.push({ label: 'Leave Match', action: leave, danger: true });
    if (screen === 'room') items.push({ label: 'Back to Command', action: leave, danger: true });
    if (screen !== 'title') items.push({ label: exitLabel(), action: exit, danger: true });
    return items;
  });
  const modals: Modal[] = [menu, settingsModal, controlsModal, createGame, hangar, quarkModal];
  const modalStack: Modal[] = [];
  for (const m of modals) {
    overlayHost.appendChild(m.root);
    m.onClose = () => {
      const i = modalStack.indexOf(m);
      if (i >= 0) modalStack.splice(i, 1);
      input.modalOpen = modalStack.length > 0;
      ui('click');
      restoreFocus();
    };
  }
  function openModal(m: Modal): void {
    if (m.visible) return;
    modalStack.push(m);
    input.modalOpen = true;
    input.releaseAll();
    m.open();
    ui('click');
  }
  const topModal = (): Modal | null => modalStack[modalStack.length - 1] ?? null;

  const title = new TitleScreen({
    onOnline: (name, url, token) => void connect('online', name, url, token),
    onOffline: (name) => void connect('offline', name, ''),
    onSettings: () => openModal(settingsModal),
    onControls: () => openModal(controlsModal),
    onLogout: () => {
      // Nothing under way may bring the account back: no auto-reconnect, and no connect in flight with its token.
      stopReconnect();
      if (connecting) client.disconnect(true);
    },
  }, {
    name: savedName, server, resetToken,
    resetServerUrl: defaultServerUrl(window.location), pageHost: window.location.hostname,
  });
  const command = new CommandScreen(client, {
    onCreate: openCreate, onHangar: () => openModal(hangar), onSettings: () => openModal(settingsModal),
    onExit: exit, onCreateAccount: createAccount, onUi: ui,
  });
  const room = new RoomLobby(client, {
    onLeave: leave, onSettings: () => openModal(settingsModal), onLoadout: () => openModal(hangar), onUi: ui,
  });
  const hud = new Hud(client, (i) => pickUpgrade(i), (f) => { chatFocused = f; if (f) input.releaseAll(); }, ui, {
    // v0.3 M4: the rift's off-screen portal arrows project through the renderer's camera.
    screenToWorld: (x, y) => renderer.screenToWorld(x, y),
  });
  const scoreboard = new Scoreboard(client);
  const results = new ResultsScreen(client, ui);
  uiHost.append(title.root, command.root, room.root, hud.root);
  overlayHost.prepend(scoreboard.root, results.root);
  overlayHost.appendChild(toasts.root);
  overlayHost.appendChild(quarkLimit.root);
  overlayHost.appendChild(lagLab.root);
  // A teacher's access limit stops play: leave the match and keep the controls dead until it lapses (the server enforces it).
  quark.onChange(() => { if (quark.blocked && screen === 'game') leave(); });
  void quark.start();
  // v0.5 mobile (phones / tablets without a mouse only): controller card + "Play fullscreen" on Title and Command,
  // "Rotate to landscape" over the room lobby and the match in portrait. Only covers the view: the sim never pauses.
  // While it covers, #overlays (modals, debrief, scoreboard) and the room lobby are inert, so Tab / Enter can't reach
  // them; the match HUD is left alone (the ship controls stay live, a focused chat keeps its state).
  const mobile = new MobileSupport({
    onUi: ui,
    onCover: (covered, scr) => {
      overlayHost.toggleAttribute('inert', covered);
      uiHost.toggleAttribute('inert', covered && scr !== 'game');
    },
    onPromptDismissed: (scr) => { if (scr === 'title') title.focusDefault(); else command.focusDefault(); },
  });
  title.mountNotice(mobile.titleSlot);
  command.mountNotice(mobile.commandSlot);
  overlayHost.after(mobile.rotateOverlay); // beside #overlays (not in it), so it stays live while that is inert

  const screenRoots: Record<ScreenId, HTMLElement> = { title: title.root, command: command.root, room: room.root, game: hud.root };

  function computeScreen(): ScreenId {
    if (!client.connected || !client.welcomed) return 'title';
    if (client.roomId === null) return 'command';
    if (client.matchActive) return 'game';
    return 'room';
  }

  function restoreFocus(): void {
    if (topModal()) return;
    if (screen === 'title') title.focusDefault();
    else if (screen === 'game') (document.activeElement as HTMLElement | null)?.blur?.();
  }

  function setScreen(next: ScreenId): void {
    if (next === screen) return;
    const prev = screen;
    screen = next;
    for (const [id, el] of Object.entries(screenRoots)) el.classList.toggle('active', id === next);
    mobile.setScreen(next);
    document.body.classList.toggle('in-game', next === 'game');
    input.inMatch = next === 'game';
    if (next !== 'game') {
      if (bigMap) { bigMap = false; try { renderer.setBigMap(false); } catch { /* ignore */ } }
      results.hide();
      scoreboard.setVisible(false, 0);
    }
    if (prev === 'command') command.onHide();
    if (next === 'command') command.onShow();
    if (next === 'room') room.onShow();
    if (next === 'game') { hud.onShow(); (document.activeElement as HTMLElement | null)?.blur?.(); }
    if (next === 'title') title.focusDefault();
    if (prev === 'game' && menu.visible) menu.close();
  }

  function refresh(): void {
    setScreen(computeScreen());
    // Results belong to the match screen only (a lobby-only member can still receive matchEnd).
    if (screen !== 'game' && results.visible) results.hide();
    if (screen === 'command') command.refresh();
    if (screen === 'room') room.refresh();
  }

  function showTitle(msg: string, error = false): void {
    setScreen('title');
    title.setBusy(false);
    if (msg) title.setStatus(msg, error);
  }

  async function connect(kind: 'online' | 'offline', name: string, url: string, token?: string): Promise<void> {
    stopReconnect(); // the player's own choice replaces an auto-reconnect (its attempt is superseded)
    if (connecting) return; // one attempt at a time (Play buttons are disabled meanwhile)
    connecting = true;
    try { await connectNow(kind, name, url, token); } finally { connecting = false; }
  }

  async function connectNow(kind: 'online' | 'offline', name: string, url: string, token?: string): Promise<void> {
    safeAudio.unlock();
    music.unlock();
    name = name.slice(0, NAME_MAX_LEN);
    saveStr(KEY_NAME, name);
    if (kind === 'online') {
      url = normalizeServerUrl(url || title.serverUrl || defaultServerUrl(window.location));
      // A ?server= link is used for this visit only; it never becomes the saved server.
      if (title.isPersistable(url)) saveStr(KEY_SERVER, url);
    }
    title.setBusy(true, kind === 'online' ? `Connecting to ${url}…` : 'Starting offline zone…');
    live = null;
    clearChatNotice();
    try {
      if (kind === 'online') await client.connectOnline(url, name, token);
      else await client.connectOffline(name);
      title.setBusy(false);
      if (kind === 'online' && token && !client.account) {
        // Token not accepted: we're a guest on this server now.
        title.expireSession(SESSION_EXPIRED_MSG);
        toasts.show('Your session expired — playing as a guest. Log in again to use your account.', 'error', 6000);
      }
      if (kind === 'online') {
        live = { url, name, token: token && client.account ? token : undefined };
        loadChatNotice(url);
      }
      title.noteAccount(client.account);
      ui('start');
      refresh();
    } catch (e) {
      // superseded by a disconnect (Quit, Log out...): whoever did that owns the status line ("Logged out.")
      if (e instanceof ConnectSuperseded) { title.setBusy(false, null); return; }
      console.error('[voidswarm] connect failed', e);
      client.disconnect(true);
      title.setBusy(false);
      const msg = e instanceof Error ? e.message : String(e);
      if (isSessionExpiredMessage(msg)) title.expireSession(msg);
      else title.setStatus(msg, true);
      ui('error');
    }
  }

  client.on('change', refresh);
  client.on('close', (reason) => {
    if (retry.active) return; // a reconnect attempt failing: the retry carries on (or reports why not)
    const session = live;
    live = null;
    clearChatNotice();
    if (client.closeKicked) {
      // The server ended this session on purpose (ws close 4001; its 'error' message was already toasted):
      // back to the login screen with that message. A revoked session's stored token is forgotten.
      showTitle(reason, true);
      if (isSessionExpiredMessage(reason)) title.expireSession(reason);
      return;
    }
    if (!session) {
      toasts.show(`Disconnected: ${reason}`, 'error', 6000);
      showTitle(`Disconnected: ${reason}`, true);
      return;
    }
    // Lost an online session (the host slept / stopped / moved, or a planned restart): retry it for 60 s.
    const kind = classifyClose(reason, client.closeCode);
    const notice = closeNoticeText(kind, reason, session.url);
    toasts.show(notice, kind === 'restart' ? 'info' : 'error', 6000);
    showTitle('');
    ui('error');
    retry.start(session, notice);
  });
  client.on('error', (msg) => {
    if (isSessionExpiredMessage(msg)) title.expireSession(msg);
    toasts.show(msg, 'error');
    ui('error');
  });
  client.on('chat', (l) => { if (l.fromPlayerId !== client.playerId) ui('chat'); });
  client.on('matchEnd', (r) => {
    // Only for pilots/watchers in the match: someone still in the room lobby would get an overlay
    // that blocks every lobby button until the next match starts.
    if (screen !== 'game' || !client.matchActive) return;
    results.show(r, performance.now());
    scoreboard.setVisible(false, 0);
  });
  client.on('matchStart', () => { results.hide(); ui('start'); });
  // v0.3: the Debrief reveals this match's grant; a grant outside results (leaving mid-match with secured
  // caches) is summarized in a toast instead.
  client.on('lootGrant', ({ grant }) => {
    if (results.visible) { results.setGrant(grant, client.lastGrantAt || performance.now()); return; }
    const text = grantSummary(grant);
    if (text) toasts.show(text, 'info', 5000);
  });

  function pickUpgrade(i: number): void {
    // One pick per offer (with its offerId): a double-click / 1-then-2 can't spend the next queued offer.
    if (client.chooseUpgrade(i, performance.now())) ui('select');
  }

  function activeLayer(): HTMLElement | null {
    // "Rotate to landscape" is on top of everything: gamepad A / the D-pad land on its own button, never behind it
    if (mobile.rotateVisible) return mobile.rotateOverlay;
    const m = topModal();
    if (m) return m.root;
    if (screen === 'game') return null;
    return screenRoots[screen];
  }

  // --- UI actions from keyboard / gamepad
  // v0.5 mobile: nothing opens, closes or switches behind "Rotate to landscape" (the in-match controls stay live)
  const COVERED_ACTIONS: ReadonlySet<UiAction> = new Set<UiAction>(['menu', 'controls', 'back', 'chat', 'teamChat', 'tabPrev', 'tabNext']);
  input.onAction = (a: UiAction) => {
    if (mobile.rotateVisible && COVERED_ACTIONS.has(a)) return;
    const layer = activeLayer();
    switch (a) {
      case 'menu': {
        const m = topModal();
        if (m) { m.close(); return; }
        if (screen !== 'title' || quark.available) openModal(menu);
        return;
      }
      case 'controls':
        if (controlsModal.visible) controlsModal.close(); else openModal(controlsModal);
        return;
      case 'back': {
        const m = topModal();
        if (m) m.close();
        return;
      }
      case 'confirm': if (layer) { activateFocused(layer); ui('click'); } return;
      case 'navUp': if (layer) moveFocus(layer, 'up'); return;
      case 'navDown': if (layer) moveFocus(layer, 'down'); return;
      case 'navLeft': if (layer) moveFocus(layer, 'left'); return;
      case 'navRight': if (layer) moveFocus(layer, 'right'); return;
      case 'upgrade1': case 'upgrade2': case 'upgrade3':
        if (screen === 'game' && !topModal()) pickUpgrade(Number(a.slice(-1)) - 1);
        return;
      case 'bigMap':
        if (screen === 'game' && !topModal()) { bigMap = !bigMap; try { renderer.setBigMap(bigMap); } catch { /* ignore */ } }
        return;
      case 'chat': case 'teamChat': {
        if (topModal()) return;
        const ch = a === 'teamChat' ? 'team' : 'all';
        if (screen === 'game') { if (!results.visible) hud.chat.open(ch); }
        else if (screen === 'command') command.focusChat();
        else if (screen === 'room') room.chat.open(ch);
        return;
      }
      case 'spectateNext':
        if (screen === 'game' && !topModal() && !client.latest?.you) client.cycleSpectate();
        return;
      case 'tabPrev': case 'tabNext':
        if (topModal() === hangar) hangar.cycleClass(a === 'tabNext' ? 1 : -1);
        return;
    }
  };
  const applyDevice = () => {
    document.body.classList.toggle('device-pad', input.device === 'pad');
    document.body.classList.toggle('device-kbm', input.device === 'kbm');
  };
  input.onDeviceChange = applyDevice;
  applyDevice();

  // --- main loop
  let last = performance.now();
  let acc = 0;
  let fps = 60;
  let aimX = 0, aimY = 0, candidate = 0;
  let secondaryHeld = false;

  const sampleInput = () => {
    const pose = client.localPose();
    const s = input.sample({
      shipX: pose?.x ?? client.lastFrame?.focusX ?? 0, shipY: pose?.y ?? client.lastFrame?.focusY ?? 0, hasShip: !!pose,
      screenToWorld: (x, y) => { try { return renderer.screenToWorld(x, y); } catch { return { x, y }; } },
    });
    aimX = s.aimX; aimY = s.aimY;
    secondaryHeld = s.input.secondary;
    const f = client.lastFrame;
    const you = client.latest?.you;
    const own = f?.ships.find((v) => v.id === f.localShipId);
    candidate = f && own && you && you.alive && you.attachedTo === 0
      ? pickAttachCandidate(f.ships, own.id, own.team, client.mode, aimX, aimY) : 0;
    s.input.attachTarget = candidate;
    return s;
  };

  const frame = (now: number) => {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    if (dt > 0) fps = fps * 0.95 + (1 / dt) * 0.05;
    try {
      input.modalOpen = !!topModal();
      input.gameplayEnabled = screen === 'game' && !topModal() && !chatFocused && !results.visible && !quark.blocked;
      input.poll(now);
      if (screen === 'game') {
        acc += dt;
        let steps = 0;
        while (acc >= DT && steps < 4) {
          const s = sampleInput();
          client.sendInput(s.input);
          acc -= DT;
          steps++;
        }
        if (steps === 4 && acc > DT) acc = 0;
        if (steps === 0) sampleInput(); // keep the reticle responsive on high-refresh displays
        const f = client.buildFrame(now, now / 1000, dt, aimX, aimY, candidate);
        if (f) {
          renderer.render(f);
          safeAudio.playEvents(f.events, f.focusX, f.focusY, f.localShipId);
          if (!results.visible) music.onFrame(f, now, client.me?.team ?? -1, client.mode === 'ffa');
          hud.handleEvents(f.events, now);
          hud.update(f, now, fps, settings.showFps, secondaryHeld);
        }
        scoreboard.setVisible(input.scoreboardHeld && !results.visible && !topModal(), now);
        results.update(now);
      } else {
        acc = 0;
      }
      // Music scene by screen / state (a change only reaches the director once).
      music.updateScene({
        screen, result: screen === 'game' && results.visible ? client.lastResult : null, match: client.latest?.match,
        myPlayerId: client.playerId, myTeam: client.me?.team ?? -1, ffa: client.mode === 'ffa',
      });
    } catch (e) {
      console.error('[voidswarm] frame error', e);
    }
  };
  requestAnimationFrame(frame);

  window.addEventListener('beforeunload', () => client.disconnect(true));
  screenRoots.title.classList.add('active');
  title.focusDefault();
}

/** Read `?reset=<token>` (password-reset email link) and strip it from the address bar. */
function takeResetToken(): string | null {
  let token: string | null = null;
  try {
    const url = new URL(window.location.href);
    token = url.searchParams.get('reset');
    if (token !== null) {
      url.searchParams.delete('reset');
      window.history.replaceState(window.history.state, '', url.pathname + (url.search ? url.search : '') + url.hash);
    }
  } catch { token = null; }
  return token && /^\S{8,512}$/.test(token) ? token : null;
}

boot().catch((e) => {
  console.error(e);
  const el = document.getElementById('ui');
  if (el) el.textContent = `Voidswarm failed to start: ${e instanceof Error ? e.message : String(e)}`;
});
