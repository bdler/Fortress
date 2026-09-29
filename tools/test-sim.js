#!/usr/bin/env node
/**
 * 헤드리스 물리 결정성 테스트 (Core + Sim 만 로드)
 *  - 무작위 포격(아이템 포함)을 두 번씩 시뮬레이션해 결과가 완전히 같은지
 *  - 회복/파워업/듀얼 아이템이 의도대로 동작하는지
 *  - fx 훅 인자(damage info, item, heal)가 올바른지
 *   node tools/test-sim.js [N]
 */
const { loadSim } = require('./sim-node');
const S = loadSim();
const N = +(process.argv[2] || 120);
let fails = 0;
const ok = (c, msg) => { if (!c) { fails++; console.log('FAIL:', msg); } };

function setup(seed, tanks) {
  const gen = S.genTerrain(seed);
  const terrain = new S.TerrainMask(gen.mask);
  const xs = S.spawnXs(seed, tanks.length);
  const players = tanks.map((t, i) => ({
    id: 'p' + i, tank: t, team: 0, x: xs[i], y: Math.round(gen.heights[xs[i]]), facing: xs[i] < S.W / 2 ? 1 : -1, angle: 45,
    hp: S.TANKS[t].hp, maxHp: S.TANKS[t].hp, alive: true, sunk: false, ss: 0
  }));
  // 시작 위치 안정화
  const w = S.makeWorld(terrain, players, 0, 1, null);
  for (let i = 0; i < 600 && !S.worldSettled(w); i++) S.stepWorld(w, S.SIM_DT);
  return { terrain, players };
}

function mockFx() {
  const log = [];
  const f = new Proxy({}, { get: (_, k) => (...a) => { log.push([k, a]); } });
  return { fx: f, log };
}

// 1) 결정성: 같은 입력 → 같은 결과 (아이템 포함), 턴을 이어가며 누적
const rng = S.mulberry32(12345);
let shots = 0;
for (let g = 0; g < Math.ceil(N / 10); g++) {
  const tanks = []; for (let i = 0; i < 4; i++) tanks.push(S.TANK_IDS[Math.floor(rng() * S.TANK_IDS.length)]);
  let { terrain, players } = setup(Math.floor(rng() * 2147483647), tanks);
  for (let k = 0; k < 10; k++) {
    const alive = players.filter(p => p.alive);
    if (alive.length < 2) break;
    const p = alive[Math.floor(rng() * alive.length)];
    const params = {
      pid: p.id, weapon: Math.floor(rng() * 3), angle: Math.round(rng() * 90), power: Math.round(rng() * 1000) / 10,
      x: p.x, y: p.y, facing: rng() < 0.5 ? 1 : -1, wind: Math.round(rng() * 20 - 10), seed: Math.floor(rng() * 2147483647),
      item: [null, 'dual', 'power', 'heal', 'bogus'][Math.floor(rng() * 5)]
    };
    if (params.weapon === 2) p.ss = 100;
    const a = S.simulateShot(terrain, players, params), b = S.simulateShot(terrain, players, params);
    ok(JSON.stringify(a) === JSON.stringify(b), `nondeterministic shot g${g} k${k}`);
    // 라이브 재생(월드 공유 방식)과 헤드리스 결과 비교
    const live = terrain.clone(), lps = players.map(S.makeSimPlayer);
    const sp = lps.find(q => q.id === p.id); sp.x = params.x; sp.y = params.y; sp.facing = params.facing;
    const { fx } = mockFx();
    const w = S.makeWorld(live, lps, params.wind, params.seed, fx);
    S.fireShot(w, params.pid, params.weapon, params.angle, params.power, params.item);
    for (let i = 0; i < 30 / S.SIM_DT && !S.worldSettled(w); i++) S.stepWorld(w, S.SIM_DT);
    const c = S.shotResult(w, live.ops);
    ok(JSON.stringify(a) === JSON.stringify(c), `live replay differs g${g} k${k} item=${params.item}`);
    shots++;
    // 결과 적용
    a.ops.forEach(o => terrain.apply(o));
    a.players.forEach(rp => { const q = players.find(z => z.id === rp.id); Object.assign(q, { x: rp.x, y: rp.y, hp: rp.hp, alive: rp.alive, sunk: rp.sunk, ss: rp.ss }); });
  }
}
console.log(`determinism: ${shots} shots x2 checked`);

// 2) 아이템 효과
{
  const { terrain, players } = setup(777, ['cannon', 'missile', 'laser', 'multi']);
  const p = players[0];
  const base = { pid: p.id, weapon: 0, angle: 80, power: 5, x: p.x, y: p.y, facing: p.facing, wind: 0, seed: 42 };
  // 회복: 거의 수직으로 약하게 → 체력 25% 회복 (자해 없음을 가정 → taken 으로 보정)
  p.hp = 300;
  const h = S.simulateShot(terrain, players, Object.assign({}, base, { item: 'heal', angle: 60, power: 100 }));
  const hr = h.players.find(q => q.id === p.id);
  ok(hr.hp + hr.taken === Math.min(p.maxHp, 300 + Math.round(p.maxHp * 0.25)), `heal: hp ${hr.hp} taken ${hr.taken}`);
  p.hp = p.maxHp - 10;
  const h2 = S.simulateShot(terrain, players, Object.assign({}, base, { item: 'heal', angle: 60, power: 100 }));
  const hr2 = h2.players.find(q => q.id === p.id);
  ok(hr2.hp + hr2.taken === p.maxHp, 'heal capped at maxHp');
  p.hp = p.maxHp;

  // 파워업: 적을 직격하는 포격을 찾아 데미지 비교
  let found = false;
  for (let ang = 20; ang <= 80 && !found; ang += 2) for (let pw = 30; pw <= 100 && !found; pw += 1) {
    const prm = Object.assign({}, base, { angle: ang, power: pw, facing: players[1].x > p.x ? 1 : -1 });
    const r0 = S.simulateShot(terrain, players, prm);
    const d0 = r0.players.find(q => q.id === p.id).dealt;
    if (d0 < 150) continue;
    const r1 = S.simulateShot(terrain, players, Object.assign({}, prm, { item: 'power' }));
    const d1 = r1.players.find(q => q.id === p.id).dealt;
    found = true;
    ok(d1 > d0 * 1.15, `power: dealt ${d0} -> ${d1}`);
    const crat = r => r.ops.filter(o => o[0] === 'c').map(o => o[3]);
    ok(Math.max(...crat(r1)) >= Math.round(34 * 1.15), 'power: bigger crater ' + crat(r1));
    // 듀얼: 발사 2회, 데미지 증가
    const { fx, log } = mockFx();
    const lt = terrain.clone(), lps = players.map(S.makeSimPlayer); lps[0].facing = prm.facing;
    const w = S.makeWorld(lt, lps, prm.wind, prm.seed, fx);
    S.fireShot(w, prm.pid, prm.weapon, prm.angle, prm.power, 'dual');
    for (let i = 0; i < 30 / S.SIM_DT && !S.worldSettled(w); i++) S.stepWorld(w, S.SIM_DT);
    ok(log.filter(e => e[0] === 'fire').length === 2, 'dual: 2 fire calls');
    ok(log.some(e => e[0] === 'item' && e[1][1] === 'dual'), 'dual: fx.item called');
    const dmg = log.filter(e => e[0] === 'damage');
    ok(dmg.length > 0 && dmg.every(e => e[1][3] && typeof e[1][3].direct === 'boolean' && 'owner' in e[1][3]), 'damage info arg');
    ok(dmg.some(e => e[1][3].owner === p.id), 'damage info owner');
    const rd = S.simulateShot(terrain, players, Object.assign({}, prm, { item: 'dual' }));
    ok(rd.players.find(q => q.id === p.id).dealt >= d0, 'dual: at least as much damage');
    ok(rd.ops.length > r0.ops.length, 'dual: more terrain ops');
  }
  ok(found, 'found a hitting shot for power test');
  // 필살기 + 듀얼 → 듀얼 무시
  p.ss = 100;
  const { fx, log } = mockFx();
  const w = S.makeWorld(terrain.clone(), players.map(S.makeSimPlayer), 0, 5, fx);
  S.fireShot(w, p.id, 2, 45, 60, 'dual');
  for (let i = 0; i < 30 / S.SIM_DT && !S.worldSettled(w); i++) S.stepWorld(w, S.SIM_DT);
  ok(log.filter(e => e[0] === 'fire').length === 1, 'dual ignored for SS weapon');
}

console.log(fails ? `${fails} FAILURES` : 'ALL SIM TESTS PASSED');
process.exit(fails ? 1 : 0);
