import { runFloor } from './swarm.mjs';
for (const f of [1, 2]) for (const s of [1, 2]) {
  const r = runFloor({ classes: ['brute'], floor: f, profile: 'typical', seed: s, dbg: true });
  const p = r.W.party[0];
  const tot = Object.values(r.W.dbg).reduce((a, b) => a + b, 0);
  console.log(`f${f} s${s}: polar casts ${r.W.polarCasts} in ${r.sec.toFixed(0)} s, polar kills ${p.st.polarKills}, kills ${p.st.kills}, deaths ${r.deaths}; dmg by src ${Object.entries(r.W.dbg).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([k,v])=>`${k} ${(100*v/tot).toFixed(0)}%`).join(', ')}`);
}
