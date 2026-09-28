import { runSwarm } from './v10_swarm.mjs';
const mix4 = ['brute','tech','engineer','tech'];
for (const sd of [1,2,3,4]) for (const mr of [0.8, 0]) {
  const r = runSwarm({ classes: mix4, seed: sd, kits: true, respawn: true, maxT: 900, connect: 0.35, floor: 4, stopAfterRooms: 4, minuteRate: mr, pulseRate: mr ? 0.25 : 0 });
  console.log(sd, mr, 't', r.t.toFixed(0), 'rooms', r.rooms, r.roomTimes.map(x=>x.toFixed(0)).join(','), 'lives', r.livesLost, 'left', r.livesLeft, 'L', r.L.toFixed(1), 'alive', r.E.length, r.E.slice(0,6).join(' '), 'pilots', r.pilots.map(p=>p.alive?'A':'d').join(''));
}
