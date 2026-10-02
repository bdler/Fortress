#!/usr/bin/env node
/**
 * 조준 도우미(AssistSolver) 정확도 테스트 — 순수 Node (브라우저 없음)
 *
 *   node tools/test-assist.js [맵 수=40] [--quiet]
 *   node tools/test-assist.js 40 --src=/다른/작업트리/src     (다른 Core/Sim 으로 교차 검증. 환경변수 SRC_DIR 도 됨)
 *   --brute  '풀이 불가' 판정이 진짜인지 무차별 탐색으로 확인 · DEBUG_MISS=1 빗나간 경우 실제 폭발 지점 출력
 *
 *  무작위 맵 × 무작위 위치 × 바람(일반 ±10 / 비기너 ±2 규칙) × 탱크 6종 × 무기(0,1,SS) 에 대해
 *   1) solve() 의 추천 (각도, 힘) 으로 진짜 simulateShot 을 돌려 목표가 실제로 피해를 입는지 (명중률)
 *   2) 초록 구간 양 끝 (pLo, pHi, aLo, aHi) 으로 쏴도 맞는지
 *   3) traj() 가 예측한 폭발 지점이 진짜 시뮬레이션의 첫 폭발(크레이터)과 일치하는지 (임의의 각도/힘)
 *   4) 풀이 시간, 못 맞추는 경우 rec.ok=false (거짓말 X) 인지
 *  를 확인한다. 요구: 일반탄 계열(캐논 0/1 · 미사일 0 · 멀티/에어 0) 명중률 ≥ 95%.
 *  + 회귀 시나리오 (regressions()):
 *   - 폭격/눈보라/위성 '창(window)' 캐시가 제자리에서 바뀐 지형에 대해 낡은 값을 돌려주지 않는다 (지형 버전 없이 불러도 · 넘겨도)
 *   - 해석 해가 전부 막힌 높은 섬/절벽 위 목표도 격자 재탐색으로 풀리고, 그 추천이 진짜 시뮬레이션에서 맞는다
 *   - ok 인 추천의 힘 구간 폭은 항상 1 이상 (머리카락처럼 얇은 구간은 추천하지 않고 reason 'narrow')
 *   - zoneText: 정수 구간 · 약 N · 게이지 대부분이 맞는 자리는 '어디서나'
 */
const { loadSim } = require('./sim-node');
const srcArg = process.argv.find(a => a.startsWith('--src='));
const S = loadSim({ srcDir: srcArg ? srcArg.slice(6) : undefined });
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
const angleWin = [], powWin = [];

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
        if (rec.pHi - rec.pLo < 1 - 1e-9) fail(`ok 추천인데 힘 구간이 1 미만: ${key} zone ${rec.pLo}~${rec.pHi}`);
        angleWin.push(rec.aHi - rec.aLo); powWin.push(rec.pHi - rec.pLo);
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

/* ---------------- 회귀 시나리오 ---------------- */
function regressions() {
  S.setRules(true);
  const mkP = (gen, id, tank, x) => ({ id, tank, team: 0, x, y: Math.round(gen.heights[x]), facing: 1, angle: 45, hp: S.TANKS[tank].hp, alive: true, sunk: false, ss: 100 });

  // 1) 폭격기 SS: 목표 머리 위에 판을 얹으면 'roof', 그 판을 제자리에서 걷어내면 다시 풀린다 — 바람/위치가 그대로여도 낡은 창을 쓰면 안 된다.
  //    (a) 지형 버전을 안 넘기는 호출자 (b) 넘기는 호출자(게임: G.terrain.ops.length) 둘 다
  let n = 0, bad = 0, hits = 0, fresh = 0;
  for (const seed of [11, 12, 13, 14, 15, 17, 18]) {
    for (const useKey of [false, true]) {
      const gen = S.genTerrain(seed), terrain = new S.TerrainMask(gen.mask), xs = S.spawnXs(seed, 2);
      const sh = mkP(gen, 'me', 'air', xs[0]), tg = mkP(gen, 'tg', 'cannon', xs[1]);
      sh.facing = tg.x >= sh.x ? 1 : -1;
      const players = [sh, tg], w = S.TANKS.air.weapons[2], opt = () => useKey ? { terrainKey: terrain.ops.length } : {};
      const r0 = A.solve(terrain.mask, players, sh, 'tg', w, 0, opt());
      if (!r0.ok) continue;
      n++;
      terrain.mound(tg.x, tg.y - 140, 90);
      const r1 = A.solve(terrain.mask, players, sh, 'tg', w, 0, opt());
      terrain.crater(tg.x, tg.y - 140, 95);
      const r2 = A.solve(terrain.mask, players, sh, 'tg', w, 0, opt());
      if (r1.ok || r1.reason !== 'roof') { bad++; fail(`slab over the target: expected roof, got ${JSON.stringify([r1.ok, r1.reason])} (seed ${seed}, key ${useKey})`); }
      if (!r2.ok) { bad++; fail(`slab removed in place: still ${r2.reason} — stale window (seed ${seed}, key ${useKey})`); }
      else {
        fresh++;
        if (damaged(terrain, players, params(sh, 2, r2.angle, r2.power, r2.facing, 0, 777), 'tg').hit) hits++;
      }
      // traj() 도 같은 캐시를 쓴다: 판이 다시 생기면 (지형 버전이 바뀜) 착탄 창(band)이 없어지거나 바뀌어야 한다
      if (useKey) {
        const t1 = A.traj(terrain.mask, players, sh, sh.facing, r2.angle, r2.power, w, 0, { targetId: 'tg', terrainKey: terrain.ops.length });
        terrain.mound(tg.x, tg.y - 140, 90);
        const t2 = A.traj(terrain.mask, players, sh, sh.facing, r2.angle, r2.power, w, 0, { targetId: 'tg', terrainKey: terrain.ops.length });
        if (t1.hit && t2.hit) { bad++; fail(`traj() still reports a hit after the slab appeared (seed ${seed}) — stale window`); }
      }
    }
  }
  console.log(`회귀 1 (낡은 창 캐시): ${n} 시나리오, 실패 ${bad}, 걷어낸 뒤 추천 → 실제 명중 ${hits}/${fresh}`);
  if (n < 6) fail('회귀 1: 시나리오가 너무 적음 ' + n);
  if (fresh && hits / fresh < 0.8) fail(`회귀 1: 걷어낸 뒤 추천이 실제로 맞지 않음 ${hits}/${fresh}`);

  // 2) 해석 해가 전부 막힌 높은 섬 위 목표 (검토자가 재현한 두 경우): 격자 재탐색으로 풀리고, 그 추천은 진짜로 맞는다
  const cases = [
    { seed: 158380, shooter: ['ice', 1094, 528], target: ['cannon', 795, 275], wind: 0, wi: 0 },
    { seed: 783981, shooter: ['missile', 602, 498], target: ['cannon', 345, 286], wind: 1, wi: 0 }
  ];
  let solved = 0, real = 0;
  for (const c of cases) {
    const gen = S.genTerrain(c.seed), terrain = new S.TerrainMask(gen.mask);
    const P = (id, [tank, x, y]) => ({ id, tank, team: 0, x, y, facing: 1, angle: 45, hp: S.TANKS[tank].hp, alive: true, sunk: false, ss: 0 });
    const sh = P('me', c.shooter), tg = P('tg', c.target);
    sh.facing = tg.x >= sh.x ? 1 : -1;
    const players = [sh, tg], w = S.TANKS[sh.tank].weapons[c.wi];
    const rec = A.solve(terrain.mask, players, sh, 'tg', w, c.wind, {});
    if (!rec.ok) { fail(`high-island target (seed ${c.seed}): solver says ${rec.reason} but a real shot hits`); continue; }
    solved++;
    if (damaged(terrain, players, params(sh, c.wi, rec.angle, rec.power, rec.facing, c.wind, 4242), 'tg').hit) real++;
    else fail(`high-island target (seed ${c.seed}): recommendation ${rec.angle}/${rec.power} does not hit in the real simulation`);
  }
  console.log(`회귀 2 (높은 섬 목표 격자 재탐색): 풀림 ${solved}/${cases.length}, 진짜 명중 ${real}/${solved}`);

  // 3) zoneText
  const zt = [[{ pLo: 62, pHi: 66.4, power: 64 }, '62~66'], [{ pLo: 62.2, pHi: 62.8, power: 62.5 }, '약 63'], [{ pLo: 1, pHi: 100, power: 50 }, '어디서나'], [{ pLo: 5, pHi: 70, power: 40 }, '어디서나'], [{ pLo: 14, pHi: 60, power: 30 }, '14~60']];
  for (const [z, want] of zt) { const got = S.zoneText(z); if (got !== want) fail(`zoneText ${JSON.stringify(z)}: want ${want} got ${got}`); }
  console.log('회귀 3 (zoneText): ' + (fails ? '' : '통과'));
  S.setRules(false);
}

const t0 = Date.now();
regressions();
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
{
  const srt = a => a.slice().sort((x, y) => x - y), qq = (a, f) => a.length ? srt(a)[Math.min(a.length - 1, Math.floor(a.length * f))] : 0;
  console.log(`추천의 허용 폭: 힘 구간 중앙값 ${qq(powWin, 0.5).toFixed(1)} · 최소 ${Math.min(...powWin).toFixed(1)} · 각도 구간 중앙값 ${qq(angleWin, 0.5)}도 · 각도 폭 0도 ${angleWin.filter(x => x === 0).length}/${angleWin.length}`);
}
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
