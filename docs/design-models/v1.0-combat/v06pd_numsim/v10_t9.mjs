import { runSwarm } from './v10_swarm.mjs';
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
for (const [c, w] of [['engineer','phaser'],['engineer','massdriver'],['engineer','laser'],['tech','laser'],['tech','massdriver'],['brute','massdriver'],['brute','laser']]) for (const tender of [true, false]) {
  const cells = [1,2,3].map(f => { const rs=[1,2,3,4].map(sd=>runSwarm({floor:f,classes:[c],weapons:[w],seed:sd,kits:true,respawn:true,maxT:900,connect:0.35,stopAfterRooms:3,tender}));
    return `f${f} ${rs.filter(r=>r.rooms>=3).length}/4 hull ${avg(rs.map(r=>r.pilots[0].hullLost/r.pilots[0].maxIntegrity)).toFixed(1)} lives ${avg(rs.map(r=>r.livesLost)).toFixed(1)} rayHeal ${avg(rs.map(r=>r.rayHeal)).toFixed(0)}`; });
  console.log(`solo ${c} ${w} tender=${tender}: ` + cells.join(' | '));
}
