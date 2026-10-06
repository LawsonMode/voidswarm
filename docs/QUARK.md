# Voidswarm and Quark

Voidswarm is an optional Quark client (the school hub: one sign-in, monitored class chat, standards evidence). The adapter is `src/client/quark.ts`; the UI is `src/client/ui/QuarkPanel.ts` and a **School sign-in** entry in the Esc menu. It does nothing unless the page is served by Quark's games host, which serves `/quark-hub.js`. GitHub Pages, the Voidswarm server and `npm run dev` are unchanged.

- **What is reported:** one activity, `after-action-note` (`quark-manifest.json`): the student's own written reflection on teamwork and online conduct, sent with `verb: submitted` and no score. Playing, winning, levels and loot are never reported (Quark: playing is not evidence).
- **Chat:** the panel mounts Quark's class chat. Voidswarm's in-game room chat and moderation are separate and untouched; moving them onto Quark is plan item Q2.
- **A teacher limit** (`access_limited`) leaves the match, stops the controls and shows a notice until it lapses.
- **Never:** collect names, emails or student numbers; store or log the token; rename `app_voidswarm` or `after-action-note`.

## Teacher to-do

1. Build the client for the games host's address (`VITE_BASE=/voidswarm/ npm run build -- --outDir <scratch>`, or the folder the games host serves) and put it in Quark's `games/` folder.
2. Edit `origins` in `quark-manifest.json` to the exact scheme, host and port the game is served from (the file says `http://127.0.0.1:4200`, the demo address), then register and approve it on the Quark teacher screen (Apps and data).
3. Test with `npm run hub -- demo` and `QUARK_DEV_SIGNIN=1` (development only).
