import { runSwarm } from './v10_swarm.mjs';
const mix4 = ['brute','tech','engineer','tech'];
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
for (const connect of [1, 0.5, 0.35, 0.25]) for (const f of [1, 3, 6]) {
  const R = f >= 4 ? 4 : 3;
  const rs = [1,2,3,4,5,6].map(sd => runSwarm({ floor: f, classes: mix4, seed: sd, kits: true, respawn: true, maxT: 900, connect, roomsTarget: R }));
  // time when R rooms done
  const tR = rs.map(r => r.roomTimes.length >= R ? r.roomTimes.slice(0,R).reduce((a,b)=>a+b,0) + 10*(R-1) : Infinity);
  console.log(`connect ${connect} f${f}: rooms in 900s ${avg(rs.map(r=>r.rooms)).toFixed(1)} | first-${R}-rooms time ${tR.map(x=>isFinite(x)?x.toFixed(0):'X').join(',')} | downs ${avg(rs.map(r=>r.downs)).toFixed(1)} | L end ${avg(rs.map(r=>r.L)).toFixed(1)} | room times ${rs[0].roomTimes.slice(0,5).map(x=>x.toFixed(0)).join(',')}`);
}
