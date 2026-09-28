import { runSwarm } from './v10_swarm.mjs';
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const mix4 = ['brute','tech','engineer','tech'];
function row(lbl, cfg) {
  const rs = [1,2,3,4].map(sd => runSwarm({ classes: mix4, seed: sd, kits: true, respawn: true, maxT: 900, connect: 0.35, ...cfg }));
  const R = cfg.stopAfterRooms;
  console.log(lbl.padEnd(40), 'cleared', rs.filter(r=>r.rooms>=R).length+'/4', 'lives', avg(rs.map(r=>r.livesLost)).toFixed(1), 'room1 time', avg(rs.map(r=>r.roomTimes[0] ?? 999)).toFixed(0), 'hull/pilot', avg(rs.map(r=>r.pilots.reduce((a,p)=>a+p.hullLost/p.maxIntegrity,0)/4)).toFixed(1));
}
row('f3 spec (3 pulses, 3 rooms)', { floor: 3, stopAfterRooms: 3 });
row('f3 with 4 pulses/room', { floor: 3, stopAfterRooms: 3, pulses: 4 });
row('f4 spec (4 pulses, 4 rooms)', { floor: 4, stopAfterRooms: 4 });
row('f4 with 3 pulses/room, 4 rooms', { floor: 4, stopAfterRooms: 4, pulses: 3 });
row('f4 with 3 pulses/room, 3 rooms', { floor: 4, stopAfterRooms: 3, pulses: 3 });
row('f4 4 pulses, 3 rooms', { floor: 4, stopAfterRooms: 3 });
row('f4 4 pulses, 2 rooms', { floor: 4, stopAfterRooms: 2 });
row('f4 4 pulses, 1 room', { floor: 4, stopAfterRooms: 1 });
row('f4 no halls, 4 rooms', { floor: 4, stopAfterRooms: 4, halls: false });
row('f4 k-growth off?', { floor: 4, stopAfterRooms: 4, minuteRate: 0, pulseRate: 0 });
row('f3 clock off', { floor: 3, stopAfterRooms: 3, minuteRate: 0, pulseRate: 0 });
row('f6 clock off', { floor: 6, stopAfterRooms: 4, minuteRate: 0, pulseRate: 0 });
row('f2 spec', { floor: 2, stopAfterRooms: 3 });
row('f2 clock off', { floor: 2, stopAfterRooms: 3, minuteRate: 0, pulseRate: 0 });
