# VOIDSWARM

A neon, SubSpace-inspired arena shooter for up to **32 players**. Fly Newtonian ships where **energy is your health and your ammo**. Fight in free-for-all or across up to **8 teams**, and **attach to teammates as turrets** to build flying battle stations. The whole time, Geometry Wars–style swarms flood the arena, dropping XP for Vampire Survivors–style level-up upgrades.

## Quick start
```bash
npm install
npm run dev          # http://localhost:5173 → "Play Offline vs Bots" works with no server
```
Multiplayer:
```bash
npm run server       # game server on ws://localhost:7777
npm run dev          # then "Play Online" in two browser tabs
```
Host for friends / LAN (one port serves both the game page and the socket):
```bash
npm run build
npm start            # http://<your-ip>:7777
```

## Controls
| | Mouse + Keyboard | Gamepad |
|---|---|---|
| Move | WASD | Left stick |
| Aim | Mouse | Right stick |
| Guns / Bomb / Mine | LMB / RMB / E | RT / RB / LB |
| Afterburner | Shift | LT |
| Ability | Space | A |
| Attach to teammate (turret) | F | Y |
| Detach / shake off turrets | X | B |
| Pick upgrade | 1 / 2 / 3 | D-pad ← ↑ → |
| Scoreboard / Map | Tab / M | View / D-pad ↓ |
| Chat / Team chat | Enter / T | — |

## Ships
- **Striker:** dogfighter. Ability: Overdrive.
- **Lancer:** bouncing bombs. Ability: Repel.
- **Bastion:** tank and the best turret. Ability: Aegis Shield.
- **Carrier:** carries 5 turrets. Ability: Rally.
- **Phantom:** cloak and mines.
- **Hornet:** spread guns and mines. Ability: Shrapnel Burst.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design and module contract.
