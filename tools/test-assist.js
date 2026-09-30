#!/usr/bin/env node
/**
 * 조준 도우미(AssistSolver) 정확도 테스트 — 순수 Node (브라우저 없음)
 *
 *   node tools/test-assist.js [맵 수=40] [--quiet]
 *   SRC_DIR=/다른/작업트리/src node tools/test-assist.js     (다른 Sim 으로 교차 검증)
 *
 *  무작위 맵 × 무작위 위치 × 바람(일반 ±10 / 비기너 ±2 규칙) × 탱크 6종 × 무기(0,1,SS) 에 대해
 *   1) solve() 의 추천 (각도, 힘) 으로 진짜 simulateShot 을 돌려 목표가 실제로 피해를 입는지 (명중률)
 *   2) 초록 구간 양 끝 (pLo, pHi, aLo, aHi) 으로 쏴도 맞는지
 *   3) traj() 가 예측한 폭발 지점이 진짜 시뮬레이션의 첫 폭발(크레이터)과 일치하는지 (임의의 각도/힘)
 *   4) 풀이 시간, 못 맞추는 경우 rec.ok=false (거짓말 X) 인지
 *  를 확인한다. 요구: 일반탄 계열(캐논 0/1 · 미사일 0 · 멀티/에어 0) 명중률 ≥ 95%.
 */
const { loadSim } = require('./sim-node');
const S = loadSim();
const A = S.AssistSolver;
if (!A) { console.log('AssistSolver 를 찾을 수 없음'); process.exit(1); }
const NMAPS = +(process.argv[2] && /^\d+$/.test(process.argv[2]) ? process.argv[2] : 40);
const QUIET = process.argv.includes('--quiet');
const BRUTE = process.argv.includes('--brute');
let bruteN = 0, bruteMissed = 0;
let fails = 0;
const fail = m => { fails++; console.log('FAIL:', m); };

const rng = S.mulberry32(20240607);
const R = (a, b) => a + rng() * (b - a);
const RI = (a, b) => Math.floor(R(a, b + 1));

function setup(seed, n, tanks) {
  const gen = S.genTerrain(seed);
  const terrain = new S.TerrainMask(gen.mask);
  // 서로 최소 260px 떨어진 무작위 x
  const xs = [];
  for (let tries = 0; xs.length < n && tries < 400; tries++) {
    const x = Math.round(R(90, S.W - 90));
    if (xs.every(o => Math.abs(o - x) > 260)) xs.push(x);
  }
  if (xs.length < n) return null;
  const players = xs.map((x, i) => ({
    id: 'p' + i, tank: tanks[i], team: 0, x, y: Math.round(gen.heights[x]), facing: 1, angle: 45,
    hp: S.TANKS[tanks[i]].hp, maxHp: S.TANKS[tanks[i]].hp, alive: true, sunk: false, ss: 0
  }));
  const w = S.makeWorld(terrain, players.map(S.makeSimPlayer), 0, 1, null);
  for (let i = 0; i < 900 && !S.worldSettled(w); i++) S.stepWorld(w, S.SIM_DT);
  w.players.forEach((q, i) => { players[i].x = q.x; players[i].y = q.y; players[i].alive = q.alive; });
  if (!players.every(p => p.alive)) return null;
  return { terrain, players };
}

const WEAPON_NAMES = [];
for (const t of S.TANK_IDS) S.TANKS[t].weapons.forEach((w, i) => WEAPON_NAMES.push(t + ':' + i));
const SHELL_GROUP = new Set(['cannon:0', 'cannon:1', 'missile:0', 'multi:0', 'air:0']);   // 요구 사항: ≥ 95%
const stats = {};
const stat = k => stats[k] || (stats[k] = { n: 0, ok: 0, hit: 0, zoneN: 0, zoneHit: 0, unreach: 0, far: 0, blocked: 0, ms: [] });
let trajN = 0, trajBad = 0, trajMax = 0, zoneAtN = 0, zoneAtFail = 0, zoneAtEnds = 0, zoneAtEndsHit = 0;
const trajWorst = [];

function params(p, wi, angle, power, facing, wind, seed) {
  return { pid: p.id, weapon: wi, angle, power, x: p.x, y: p.y, facing, wind, seed, item: null };
}
function damaged(terrain, players, prm, tid) {
  const before = players.find(p => p.id === tid).hp;
  const res = S.simulateShot(terrain, players, prm);
  const after = res.players.find(p => p.id === tid);
  return { hit: after.hp < before, res };
}

function runRuleSet(beginner) {
  S.setRules(beginner);
  const label = beginner ? '비기너' : '일반';
  const windMax = beginner ? 2 : 10;
  for (let m = 0; m < NMAPS; m++) {
    const n = RI(2, 4);
    const tanks = []; for (let i = 0; i < n; i++) tanks.push(S.TANK_IDS[RI(0, S.TANK_IDS.length - 1)]);
    const seed = RI(1, 2147483646);
    const env = setup(seed, n, tanks);
    if (!env) continue;
    const { terrain, players } = env;
    const wind = RI(-windMax, windMax);
    for (let si = 0; si < players.length; si++) {
      const sh = players[si];
      // 목표: 무작위 상대 하나 (가까운/먼 경우가 골고루 나오도록)
      const others = players.filter(p => p !== sh);
      const tg = others[RI(0, others.length - 1)];
      const T = S.TANKS[sh.tank];
      for (let wi = 0; wi < 3; wi++) {
        const name = sh.tank + ':' + wi, w = T.weapons[wi];
        if (wi === 2 && rng() < 0.5) continue;                 // SS 는 절반만 (시간)
        const key = label + '|' + name, st = stat(key);
        const c0 = process.cpuUsage(), s0 = A.stats();
        const rec = A.solve(terrain.mask, players, sh, tg.id, w, wind, {});
        const cu = process.cpuUsage(c0), ms = (cu.user + cu.system) / 1e3, s1 = A.stats();
        st.ms.push(ms); st.shots = (st.shots || 0) + (s1.shots - s0.shots);
        st.n++;
        if (w.mound) { if (rec.ok || rec.reason !== 'mound') fail(`mound ${key}: expected reason=mound got ${JSON.stringify(rec)}`); continue; }
        if (!rec.ok) {
          st.unreach++; if (rec.reason === 'far') st.far++; else st.blocked++;
          // 불가 판정이 거짓말은 아닌지 (진짜로 못 맞추는지) 무차별 탐색으로 확인 (--brute)
          if (BRUTE && bruteN < 12) {
            bruteN++;
            let found = null;
            for (let a = 5; a <= 89 && !found; a++) for (let p = 5; p <= 100 && !found; p += 0.5) {
              const tr = A.traj(terrain.mask, players, sh, rec.facing, a, p, w, wind, { targetId: tg.id, path: false });
              if (tr.hit) found = [a, p];
            }
            console.log(`  unreachable ${key} reason=${rec.reason} dist=${rec.dist.toFixed(0)} wind=${wind}: brute-force ${found ? 'FOUND ' + found.join('/') : 'none'}`);
            if (found) { bruteMissed++; const tr = A.traj(terrain.mask, players, sh, rec.facing, found[0], found[1], w, wind, { targetId: tg.id, path: false }); console.log('    DEBUG', JSON.stringify({ seed, sh: [sh.x, sh.y, sh.tank], tg: [tg.x, tg.y], others: players.map(q => [q.id, q.x, q.y]), tr: tr.kind, land: tr.land, d: tr.d })); }
          }
          continue;
        }
        st.ok++;
        const seedShot = RI(1, 2147483646);
        // 1) 추천값 그대로 쏘기
        const r1 = damaged(terrain, players, params(sh, wi, rec.angle, rec.power, rec.facing, wind, seedShot), tg.id);
        if (r1.hit) st.hit++;
        else if (!QUIET && process.env.DEBUG_MISS) debugMiss(terrain, players, sh, tg, wi, rec, wind);
        if (!r1.hit && !QUIET) console.log(`  miss ${key} wind=${wind} seed=${seed} angle=${rec.angle} power=${rec.power} dist=${rec.dist.toFixed(0)} zone=${rec.pLo}~${rec.pHi} a=${rec.aLo}~${rec.aHi}`);
        // 2) 초록 구간 끝
        const ends = [[rec.angle, rec.pLo], [rec.angle, rec.pHi], [rec.aLo, rec.power], [rec.aHi, rec.power]];
        for (const [a, p] of ends) {
          st.zoneN++;
          const rr = damaged(terrain, players, params(sh, wi, a, p, rec.facing, wind, RI(1, 2147483646)), tg.id);
          if (rr.hit) st.zoneHit++;
          else if (!QUIET) console.log(`  zone-miss ${key} wind=${wind} seed=${seed} a=${a} p=${p} (rec ${rec.angle}/${rec.power}, zone ${rec.pLo}~${rec.pHi}, a ${rec.aLo}~${rec.aHi})`);
        }
        // 2b) 지금 각도(추천 각도 구간 안 임의 각도)에서의 힘 구간(zoneAt) 도 진짜로 맞는지
        for (let k = 0; k < 2 && rec.aHi > rec.aLo; k++) {
          const a = RI(rec.aLo, rec.aHi);
          const z = A.zoneAt(terrain.mask, players, sh, tg.id, w, wind, a, { seedPower: rec.power });
          zoneAtN++;
          if (!z.ok) { zoneAtFail++; if (!QUIET) console.log(`  zoneAt-none ${key} a=${a} in [${rec.aLo},${rec.aHi}] rec=${rec.angle}/${rec.power}`); continue; }
          for (const pw of [z.pLo, z.pHi, z.power]) {
            zoneAtEnds++;
            if (damaged(terrain, players, params(sh, wi, a, pw, rec.facing, wind, RI(1, 2147483646)), tg.id).hit) zoneAtEndsHit++;
            else if (!QUIET) console.log(`  zoneAt-miss ${key} a=${a} p=${pw} zone ${z.pLo}~${z.pHi}`);
          }
        }
        // 3) 예측 궤적 vs 진짜 첫 폭발 (임의의 각도/힘, 일반탄 계열만: 첫 op 가 그 탄의 폭발)
        if (!w.drill && !w.strike && !w.mound && !w.split && !w.count) {
          for (let k = 0; k < 2; k++) {
            const a = RI(15, 80), p = round1(R(25, 100));
            const tr = A.traj(terrain.mask, players, sh, rec.facing, a, p, w, wind, { targetId: tg.id, path: false });
            if (tr.kind === 'sea' || tr.kind === 'out' || tr.kind === 'timeout') continue;
            const res = S.simulateShot(terrain, players, params(sh, wi, a, p, rec.facing, wind, 5));
            const op = res.ops[0];
            if (!op) continue;
            const dev = Math.max(Math.abs(op[1] - Math.round(tr.land.x)), Math.abs(op[2] - Math.round(tr.land.y)));
            trajN++; trajMax = Math.max(trajMax, dev);
            if (dev > 1) { trajBad++; if (trajWorst.length < 5) trajWorst.push(`${key} a=${a} p=${p} wind=${wind}: pred(${tr.land.x.toFixed(1)},${tr.land.y.toFixed(1)}) real(${op[1]},${op[2]})`); }
          }
        }
      }
    }
  }
}
const round1 = v => Math.round(v * 10) / 10;
/** 빗나간 경우 진짜 시뮬레이션에서 폭발 지점들을 찍어 예측과 비교 (DEBUG_MISS=1) */
function debugMiss(terrain, players, sh, tg, wi, rec, wind) {
  const ex = [];
  const fx = new Proxy({}, { get: (_, k) => (...a) => { if (k === 'explode') ex.push([Math.round(a[0]), Math.round(a[1]), a[2]]); } });
  const tm = terrain.clone(), ps = players.map(S.makeSimPlayer), sp = ps.find(q => q.id === sh.id);
  sp.x = sh.x; sp.y = sh.y; sp.facing = rec.facing;
  const w = S.makeWorld(tm, ps, wind, 4242, fx);
  S.fireShot(w, sh.id, wi, rec.angle, rec.power, null);
  for (let i = 0; i < 30 / S.SIM_DT && !S.worldSettled(w); i++) S.stepWorld(w, S.SIM_DT);
  const wp = S.TANKS[sh.tank].weapons[wi];
  const tr = A.traj(terrain.mask, players, sh, rec.facing, rec.angle, rec.power, wp, wind, { targetId: tg.id, path: false });
  console.log('   DEBUG target', tg.x, tg.y, 'shooter', sh.x, sh.y, 'pred explosion', tr.land.x.toFixed(1), tr.land.y.toFixed(1), tr.kind, 'band', JSON.stringify(tr.land.band), 'real explosions', JSON.stringify(ex));
}

const t0 = Date.now();
runRuleSet(false);
runRuleSet(true);
S.setRules(false);

const pct = (a, b) => b ? (100 * a / b).toFixed(1) + '%' : '-';
const q = (arr, f) => { if (!arr.length) return 0; const s = arr.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * f))]; };
console.log('\n=== 결과 (맵 ' + NMAPS + '개 × 규칙 2종, ' + ((Date.now() - t0) / 1000).toFixed(1) + '초) ===');
const groups = {};
Object.keys(stats).sort().forEach(k => {
  const s = stats[k], [rule, name] = k.split('|');
  const g = groups[name] || (groups[name] = { n: 0, ok: 0, hit: 0, zoneN: 0, zoneHit: 0, unreach: 0, ms: [] });
  g.n += s.n; g.ok += s.ok; g.hit += s.hit; g.zoneN += s.zoneN; g.zoneHit += s.zoneHit; g.unreach += s.unreach; g.ms.push(...s.ms);
  if (!QUIET) console.log(`${k.padEnd(20)} 풀이 ${String(s.ok).padStart(3)}/${String(s.n).padEnd(3)} (불가 ${s.unreach}: 멀다 ${s.far} 막힘 ${s.blocked})  명중 ${pct(s.hit, s.ok).padStart(6)}  구간끝 ${pct(s.zoneHit, s.zoneN).padStart(6)}  평균 ${(s.ms.reduce((a, b) => a + b, 0) / Math.max(1, s.ms.length)).toFixed(1)}ms 발사 ${((s.shots || 0) / Math.max(1, s.n)).toFixed(0)}`);
});
console.log('\n--- 무기별 합계 (일반+비기너) ---');
let allHit = 0, allOk = 0, allZone = 0, allZoneHit = 0, shellHit = 0, shellOk = 0;
const allMs = [];
for (const name of Object.keys(groups)) {
  const g = groups[name];
  console.log(`${name.padEnd(12)} 명중 ${pct(g.hit, g.ok).padStart(6)} (${g.hit}/${g.ok})  구간끝 ${pct(g.zoneHit, g.zoneN).padStart(6)} (${g.zoneHit}/${g.zoneN})  풀이불가 ${g.unreach}/${g.n}`);
  allHit += g.hit; allOk += g.ok; allZone += g.zoneN; allZoneHit += g.zoneHit; allMs.push(...g.ms);
  if (SHELL_GROUP.has(name)) { shellHit += g.hit; shellOk += g.ok; if (g.ok >= 10 && g.hit / g.ok < 0.95) fail(`${name} 명중률 ${pct(g.hit, g.ok)} < 95%`); }
  if (g.ok >= 10 && g.hit / g.ok < 0.9) fail(`${name} 명중률 ${pct(g.hit, g.ok)} < 90%`);
  if (g.zoneN >= 20 && g.zoneHit / g.zoneN < 0.95) fail(`${name} 초록 구간 끝 적중 ${pct(g.zoneHit, g.zoneN)} < 95%`);
}
console.log(`\n전체 명중 ${pct(allHit, allOk)} (${allHit}/${allOk}) · 일반탄 계열 ${pct(shellHit, shellOk)} (${shellHit}/${shellOk}) · 초록 구간 끝 ${pct(allZoneHit, allZone)} (${allZoneHit}/${allZone})`);
console.log(`zoneAt (추천 각도 구간 안 다른 각도): 구간 있음 ${zoneAtN - zoneAtFail}/${zoneAtN} · 구간 끝/중앙 적중 ${zoneAtEndsHit}/${zoneAtEnds}`);
if (zoneAtFail > 0) fail(`zoneAt 이 추천 각도 구간 안에서 해를 못 찾음 (${zoneAtFail}/${zoneAtN})`);
if (zoneAtEnds && zoneAtEndsHit / zoneAtEnds < 0.97) fail(`zoneAt 구간 적중률 ${zoneAtEndsHit}/${zoneAtEnds} < 97%`);
// 포구 위치 식이 Sim.muzzle 과 정확히 같은지
{
  let bad = 0;
  for (let i = 0; i < 200; i++) {
    const gen = S.genTerrain(RI(1, 1e9)), x = RI(60, S.W - 60), y = Math.round(gen.heights[x]), f = rng() < 0.5 ? 1 : -1, ang = RI(0, 90);
    const a = S.muzzle(gen.mask, { x, y, facing: f }, ang), b = A.muzzleAt(A.pivotOf(gen.mask, { x, y }, f), ang);
    if (Math.abs(a.x - b.x) > 1e-9 || Math.abs(a.y - b.y) > 1e-9) bad++;
  }
  console.log(`muzzle 식 일치: ${200 - bad}/200`);
  if (bad) fail('AssistSolver 포구 위치가 Sim.muzzle 과 다름');
}
console.log(`궤적 예측 일치: ${trajN - trajBad}/${trajN} (최대 오차 ${trajMax}px)` + (trajWorst.length ? '\n  ' + trajWorst.join('\n  ') : ''));
if (trajN && trajBad / trajN > 0.02) fail(`궤적 예측이 실제와 다름 (${trajBad}/${trajN})`);
console.log(`풀이 시간(CPU): 평균 ${(allMs.reduce((a, b) => a + b, 0) / allMs.length).toFixed(1)}ms · 중앙값 ${q(allMs, 0.5).toFixed(1)}ms · p95 ${q(allMs, 0.95).toFixed(1)}ms · 최대 ${Math.max(...allMs).toFixed(1)}ms`);
if (q(allMs, 0.5) > 25) fail('풀이가 너무 느림 (중앙값 > 25ms)');
if (BRUTE) console.log(`불가 판정 ${bruteN}건 중 무차별 탐색이 해를 찾은 것: ${bruteMissed}건`);
console.log(fails ? `\n${fails} 개 실패` : '\n모두 통과');
process.exit(fails ? 1 : 0);
