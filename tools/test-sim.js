#!/usr/bin/env node
/**
 * 헤드리스 물리 결정성 테스트 (Core + Sim 만 로드)
 *  - 무작위 포격(아이템 포함)을 두 번씩 시뮬레이션해 결과가 완전히 같은지 (일반 / 비기너 규칙 모두)
 *  - 회복/파워업/듀얼 아이템이 의도대로 동작하는지
 *  - fx 훅 인자(damage info, item, heal)가 올바른지
 *  - 일반 모드 결과가 비기너 규칙 도입 이전 코드와 바이트 단위로 같은지 (회귀 방지 다이제스트)
 *  - 비기너 규칙(폭발 반경, 피격 반경, 자기 포탄 면역, 낙하 데미지 없음, SS 충전)이 수치로 확인되는지
 *   node tools/test-sim.js [N]
 *   BASE_REF=<git ref> node tools/test-sim.js   → 그 커밋의 Core/Sim 과 직접 비교 (다이제스트 상수 대신)
 */
const fs = require('fs'), path = require('path'), vm = require('vm');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { loadSim } = require('./sim-node');
const S = loadSim();
const N = +(process.argv[2] || 120);
let fails = 0;
const ok = (c, msg) => { if (!c) { fails++; console.log('FAIL:', msg); } };

/** 일반 모드 회귀 다이제스트 (비기너 도입 전 커밋 2eb1cbe 의 Core/Sim 으로 계산한 값) */
const NORMAL_GOLDEN = {
  shots: 300,
  digest: '2812498c503e418729dc4980f2266a70f1c42851df202dc1810faa75f1103e7c'
};

function setup(SS, seed, tanks) {
  const gen = SS.genTerrain(seed);
  const terrain = new SS.TerrainMask(gen.mask);
  const xs = SS.spawnXs(seed, tanks.length);
  const players = tanks.map((t, i) => ({
    id: 'p' + i, tank: t, team: 0, x: xs[i], y: Math.round(gen.heights[xs[i]]), facing: xs[i] < SS.W / 2 ? 1 : -1, angle: 45,
    hp: SS.TANKS[t].hp, maxHp: SS.TANKS[t].hp, alive: true, sunk: false, ss: 0
  }));
  // 시작 위치 안정화
  const w = SS.makeWorld(terrain, players, 0, 1, null);
  for (let i = 0; i < 600 && !SS.worldSettled(w); i++) SS.stepWorld(w, SS.SIM_DT);
  return { terrain, players };
}

function mockFx() {
  const log = [];
  const f = new Proxy({}, { get: (_, k) => (...a) => { log.push([k, a]); } });
  return { fx: f, log };
}

/** 월드를 공유하는 라이브 재생 방식으로 한 발 쏜 결과 (+ fx 로그) */
function liveShot(SS, terrain, players, params) {
  const live = terrain.clone(), lps = players.map(SS.makeSimPlayer);
  const sp = lps.find(q => q.id === params.pid); sp.x = params.x; sp.y = params.y; sp.facing = params.facing;
  const { fx, log } = mockFx();
  const w = SS.makeWorld(live, lps, params.wind, params.seed, fx);
  SS.fireShot(w, params.pid, params.weapon, params.angle, params.power, params.item);
  for (let i = 0; i < 30 / SS.SIM_DT && !SS.worldSettled(w); i++) SS.stepWorld(w, SS.SIM_DT);
  return { res: SS.shotResult(w, live.ops), log };
}

function applyRes(terrain, players, res) {
  res.ops.forEach(o => terrain.apply(o));
  res.players.forEach(rp => { const q = players.find(z => z.id === rp.id); Object.assign(q, { x: rp.x, y: rp.y, hp: rp.hp, alive: rp.alive, sunk: rp.sunk, ss: rp.ss }); });
}

function randomParams(SS, rng, p) {
  return {
    pid: p.id, weapon: Math.floor(rng() * 3), angle: Math.round(rng() * 90), power: Math.round(rng() * 1000) / 10,
    x: p.x, y: p.y, facing: rng() < 0.5 ? 1 : -1, wind: Math.round(rng() * 20 - 10), seed: Math.floor(rng() * 2147483647),
    item: [null, 'dual', 'power', 'heal', 'bogus'][Math.floor(rng() * 5)]
  };
}

// 0) 규칙 프리셋
{
  const R0 = S.RULES;
  S.setRules(true);
  ok(S.RULES === R0, 'setRules keeps the RULES object identity');
  ok(S.RULES.beginner === true && S.RULES.hitR === 26 && S.RULES.blastMul === 1.3 && S.RULES.dmgMul === 1 && S.RULES.fallDmg === false &&
     S.RULES.noSelfHit === true && S.RULES.ssMul === 1.5 && S.RULES.turnTime === 40 && S.RULES.chargeSpeed === 30 && S.RULES.windMax === 2 &&
     S.RULES.aiErr === 4 && S.RULES.healMul === 2, 'beginner preset values: ' + JSON.stringify(S.RULES));
  ok(S.TURN_TIME === 40, 'TURN_TIME getter follows RULES.turnTime (beginner): ' + S.TURN_TIME);
  ok(S.startItems().heal === 2 && S.startItems().dual === 1 && S.startItems().power === 1, 'beginner start items: heal x2');
  S.setRules(false);
  ok(S.RULES === R0, 'RULES identity after switching back');
  ok(S.RULES.beginner === false && S.RULES.hitR === 21 && S.RULES.blastMul === 1 && S.RULES.dmgMul === 1 && S.RULES.fallDmg === true &&
     S.RULES.noSelfHit === false && S.RULES.ssMul === 1 && S.RULES.turnTime === 25 && S.RULES.chargeSpeed === 52 && S.RULES.windMax === 10 &&
     S.RULES.aiErr === 1 && S.RULES.healMul === 1, 'normal preset values: ' + JSON.stringify(S.RULES));
  ok(S.TURN_TIME === 25 && S.TANK_HIT_R === 21, 'TURN_TIME / TANK_HIT_R compat constants (normal)');
  ok(S.startItems().heal === 1, 'normal start items: heal x1');
  S.setRules('yes'); ok(S.RULES.beginner === false, 'setRules only accepts strict boolean true');
  S.setRules(false);
  console.log('rules presets OK');
}

// 1) 결정성: 같은 입력 → 같은 결과 (아이템 포함), 턴을 이어가며 누적 — 일반/비기너 각각
function determinism(mode) {
  S.setRules(mode === 'beginner');
  const rng = S.mulberry32(mode === 'beginner' ? 424242 : 12345);
  let shots = 0;
  for (let g = 0; g < Math.ceil(N / 10); g++) {
    const tanks = []; for (let i = 0; i < 4; i++) tanks.push(S.TANK_IDS[Math.floor(rng() * S.TANK_IDS.length)]);
    let { terrain, players } = setup(S, Math.floor(rng() * 2147483647), tanks);
    for (let k = 0; k < 10; k++) {
      const alive = players.filter(p => p.alive);
      if (alive.length < 2) break;
      const p = alive[Math.floor(rng() * alive.length)];
      const params = randomParams(S, rng, p);
      if (mode === 'beginner') params.wind = Math.round(rng() * 4 - 2);
      if (params.weapon === 2) p.ss = 100;
      const a = S.simulateShot(terrain, players, params), b = S.simulateShot(terrain, players, params);
      ok(JSON.stringify(a) === JSON.stringify(b), `[${mode}] nondeterministic shot g${g} k${k}`);
      // 라이브 재생(월드 공유 방식)과 헤드리스 결과 비교
      const c = liveShot(S, terrain, players, params).res;
      ok(JSON.stringify(a) === JSON.stringify(c), `[${mode}] live replay differs g${g} k${k} item=${params.item}`);
      // 규칙을 잠깐 바꿨다가 되돌려도 (다른 모드의 잔여 상태 없이) 같은 결과
      if (k === 0) {
        S.setRules(mode !== 'beginner');
        S.simulateShot(terrain, players, params);
        S.setRules(mode === 'beginner');
        ok(JSON.stringify(S.simulateShot(terrain, players, params)) === JSON.stringify(a), `[${mode}] no state leak across setRules g${g}`);
      }
      shots++;
      applyRes(terrain, players, a);
    }
  }
  console.log(`determinism [${mode}]: ${shots} shots x2 checked`);
  S.setRules(false);
}
determinism('normal');
determinism('beginner');

// 2) 아이템 효과 (일반 규칙)
{
  S.setRules(false);
  const { terrain, players } = setup(S, 777, ['cannon', 'missile', 'laser', 'multi']);
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

// 3) 일반 모드 회귀: 비기너 규칙 도입 이전 코드와 결과가 바이트 단위로 같아야 한다
const FX_KEEP = new Set(['explode', 'damage', 'fire', 'item', 'heal', 'death', 'land', 'splash', 'beam', 'target', 'split', 'bounce', 'drill', 'plane', 'storm']);
function normalDigest(SS) {
  if (typeof SS.setRules === 'function') SS.setRules(false);
  const h = crypto.createHash('sha256');
  const rng = SS.mulberry32(20240607);
  let n = 0;
  for (let g = 0; g < 30; g++) {
    const tanks = []; for (let i = 0; i < 4; i++) tanks.push(SS.TANK_IDS[Math.floor(rng() * SS.TANK_IDS.length)]);
    const { terrain, players } = setup(SS, Math.floor(rng() * 2147483647), tanks);
    for (let k = 0; k < 10; k++) {
      const alive = players.filter(p => p.alive);
      if (alive.length < 2) break;
      const p = alive[Math.floor(rng() * alive.length)];
      // 무작위 + 가끔 적 방향으로 조준된 포격 (실제로 맞고 부서지는 경우를 충분히 포함)
      const params = randomParams(SS, rng, p);
      if (rng() < 0.6) {
        const tg = alive.filter(q => q !== p)[Math.floor(rng() * (alive.length - 1))];
        params.facing = tg.x >= p.x ? 1 : -1;
        params.angle = 25 + Math.round(rng() * 50);
        params.power = 35 + Math.round(rng() * 650) / 10;
      }
      if (params.weapon === 2) p.ss = 100;
      const { res, log } = liveShot(SS, terrain, players, params);
      const r2 = SS.simulateShot(terrain, players, params);
      h.update(JSON.stringify(res)); h.update(JSON.stringify(r2));
      h.update(JSON.stringify(log.filter(e => FX_KEEP.has(e[0]))));
      n++;
      applyRes(terrain, players, res);
    }
  }
  return { shots: n, digest: h.digest('hex') };
}
{
  const cur = normalDigest(S);
  let want = NORMAL_GOLDEN;
  if (process.env.BASE_REF) {
    // 지정한 커밋의 Core/Sim 을 그대로 불러와 같은 픽스처를 돌린다
    const ctx = { console, Math, Date, performance: { now: () => Date.now() }, window: {}, document: { querySelector() {}, querySelectorAll() { return []; } } };
    vm.createContext(ctx);
    for (const f of ['Core', 'Sim']) {
      const src = execFileSync('git', ['show', process.env.BASE_REF + ':src/' + f + '.html'], { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 1 << 26 })
        .replace(/<\/?script>/g, '').replace(/^const (\w+)/gm, 'var $1').replace(/^class (\w+)/gm, 'var $1 = class $1').replace(/^'use strict';/m, '');
      vm.runInContext(src, ctx);
    }
    want = normalDigest(ctx);
    console.log(`normal-mode regression vs ${process.env.BASE_REF}: base ${want.digest} (${want.shots} shots)`);
  }
  ok(cur.shots === want.shots, `regression fixture shot count ${cur.shots} vs ${want.shots}`);
  ok(cur.digest === want.digest, `normal-mode results changed vs base! digest ${cur.digest} != ${want.digest}`);
  console.log(`normal-mode regression: ${cur.shots} shots (results + fx events) digest ${cur.digest} ${cur.digest === want.digest ? 'IDENTICAL to base' : 'DIFFERENT'}`);
}

// 4) 비기너 규칙 수치 검증
{
  const player = (players, id) => players.find(q => q.id === id);
  const dealtTo = (res, id) => res.players.find(q => q.id === id).taken;
  const maxCrater = res => Math.max(0, ...res.ops.filter(o => o[0] === 'c').map(o => o[3]));

  // 4a) 같은 파라미터 → 비기너가 더 큰 구덩이, 일반이 못 맞히는 목표를 비기너는 맞힘 (2인 배치, 격자 탐색)
  let totN = 0, totB = 0, onlyB = 0, onlyN = 0, cases = 0, craterChecked = false;
  const rng = S.mulberry32(9001);
  const t0 = Date.now();
  for (let sc = 0; sc < 8; sc++) {
    const tanks = ['cannon', S.TANK_IDS[Math.floor(rng() * 6)]];
    const { terrain, players } = setup(S, Math.floor(rng() * 2147483647), tanks);
    const p = players[0], tg = players[1];
    if (Math.abs(p.x - tg.x) < 250) continue;     // 너무 가까운 배치는 제외
    const face = tg.x >= p.x ? 1 : -1;
    for (let ang = 22; ang <= 78; ang += 5) for (let pw = 30; pw <= 100; pw += 4) {
      const prm = { pid: p.id, weapon: 0, angle: ang, power: pw, x: p.x, y: p.y, facing: face, wind: 0, seed: 7 };
      S.setRules(false); const rn = S.simulateShot(terrain, players, prm);
      S.setRules(true);  const rb = S.simulateShot(terrain, players, prm);
      S.setRules(false);
      const hn = dealtTo(rn, tg.id) > 0, hb = dealtTo(rb, tg.id) > 0;
      cases++; totN += hn; totB += hb;
      if (hb && !hn) onlyB++;
      if (hn && !hb) onlyN++;
      if (!craterChecked && rn.ops.length && rb.ops.length) {
        craterChecked = true;
        ok(maxCrater(rn) === 34 && maxCrater(rb) === Math.round(34 * 1.3), `crater radius same shot: normal ${maxCrater(rn)} beginner ${maxCrater(rb)} (expect 34 / 44)`);
      }
    }
  }
  ok(craterChecked, 'crater comparison ran');
  ok(onlyN === 0, `beginner hits a superset of normal hits (normal-only hits: ${onlyN})`);
  ok(onlyB > 0, 'some shot misses in normal but hits in beginner (same params)');
  ok(totB >= totN * 1.15, `beginner hit rate clearly higher: ${totN} -> ${totB}`);
  console.log(`beginner vs normal (same ${cases} grid shots at a target): normal hits ${totN} (${(100 * totN / cases).toFixed(1)}%), beginner hits ${totB} (${(100 * totB / cases).toFixed(1)}%), only-beginner ${onlyB}, only-normal ${onlyN}  [${Date.now() - t0} ms]`);

  // 4b) 자기 포탄 면역: 수직으로 쏘면 제자리로 떨어진다
  {
    const { terrain, players } = setup(S, 31337, ['cannon', 'missile']);
    const p = players[0];
    const up = { pid: p.id, weapon: 0, angle: 90, power: 45, x: p.x, y: p.y, facing: p.facing, wind: 0, seed: 3 };
    S.setRules(false); const rn = S.simulateShot(terrain, players, up);
    S.setRules(true);  const rb = S.simulateShot(terrain, players, up);
    ok(dealtTo(rn, p.id) > 0, 'normal: straight-up shot hurts the shooter (taken ' + dealtTo(rn, p.id) + ')');
    ok(dealtTo(rb, p.id) === 0 && rb.players.find(q => q.id === p.id).hp === p.maxHp, 'beginner: shooter takes no damage from own shell');
    // 가까이 떨어지는 무작위 포격 60발: 비기너는 자해 0, 일반은 자해가 생긴다
    let selfN = 0, selfB = 0; const r2 = S.mulberry32(5150);
    for (let i = 0; i < 60; i++) {
      const prm = { pid: p.id, weapon: Math.floor(r2() * 2), angle: 40 + Math.round(r2() * 50), power: 8 + Math.round(r2() * 30), x: p.x, y: p.y, facing: p.facing, wind: 0, seed: i + 1 };
      S.setRules(false); if (dealtTo(S.simulateShot(terrain, players, prm), p.id) > 0) selfN++;
      S.setRules(true);  if (dealtTo(S.simulateShot(terrain, players, prm), p.id) > 0) selfB++;
    }
    S.setRules(false);
    ok(selfB === 0 && selfN > 0, `self hits over 60 short shots: normal ${selfN}, beginner ${selfB}`);
    console.log(`noSelfHit: straight-up self damage normal ${dealtTo(rn, p.id)} / beginner ${dealtTo(rb, p.id)}; 60 short shots self-hit normal ${selfN} / beginner ${selfB}`);
  }

  // 4c) 낙하 데미지: 받침 기둥을 날려 130px 떨어뜨린다
  {
    const mk = () => {
      const mask = new Uint8Array(S.W * S.H);
      for (let y = 600; y < S.H; y++) mask.fill(1, y * S.W, (y + 1) * S.W);
      for (let y = 450; y < 600; y++) mask.fill(1, y * S.W + 780, y * S.W + 821);
      return new S.TerrainMask(mask);
    };
    const run = beginner => {
      S.setRules(beginner);
      const tm = mk();
      const pl = [S.makeSimPlayer({ id: 'a', tank: 'cannon', x: 800, y: 450, facing: 1, angle: 45, hp: 1100, maxHp: 1100, alive: true }),
                  S.makeSimPlayer({ id: 'b', tank: 'cannon', x: 300, y: 600, facing: 1, angle: 45, hp: 1100, maxHp: 1100, alive: true })];
      const w = S.makeWorld(tm, pl, 0, 1, null);
      for (let i = 0; i < 120; i++) S.stepWorld(w, S.SIM_DT);   // 기둥 위에서 안정
      tm.crater(800, 520, 90);
      for (let i = 0; i < 480; i++) S.stepWorld(w, S.SIM_DT);   // 4초면 충분히 낙하·착지
      S.setRules(false);
      return { hp: pl[0].hp, y: pl[0].y };
    };
    const n = run(false), b = run(true);
    ok(n.y > 550 && b.y > 550, `tank fell (y normal ${n.y}, beginner ${b.y})`);
    ok(n.hp < 1100, 'normal: fall damage applied, hp ' + n.hp);
    ok(b.hp === 1100, 'beginner: no fall damage, hp ' + b.hp);
    console.log(`fallDmg: fell to y=${n.y}; hp normal ${n.hp} / beginner ${b.hp}`);
  }

  // 4d) SS 게이지: 같은 직격 → 비기너는 1.5배 충전
  {
    let done = false;
    const r3 = S.mulberry32(77);
    for (let sc = 0; sc < 12 && !done; sc++) {
      const { terrain, players } = setup(S, Math.floor(r3() * 2147483647), ['cannon', 'missile']);
      const p = players[0], tg = players[1];
      if (Math.abs(p.x - tg.x) < 250) continue;
      const face = tg.x >= p.x ? 1 : -1;
      for (let ang = 22; ang <= 78 && !done; ang += 2) for (let pw = 30; pw <= 100 && !done; pw += 2) {
        const prm = { pid: p.id, weapon: 0, angle: ang, power: pw, x: p.x, y: p.y, facing: face, wind: 0, seed: 7 };
        S.setRules(true); const rb = S.simulateShot(terrain, players, prm); S.setRules(false);
        const sh = rb.players.find(q => q.id === p.id), tk = rb.players.find(q => q.id === tg.id);
        if (sh.dealt < 100 || sh.dealt > 400) continue;
        // 비기너 결과의 ss 는 dealt * 0.12 * 1.5 (내가 준 피해로 충전) — 같은 피해량이 일반 규칙이면 * 0.12
        ok(Math.abs(sh.ss - Math.min(100, sh.dealt * 0.12 * 1.5)) < 0.3, `shooter SS gain x1.5: dealt ${sh.dealt} ss ${sh.ss}`);
        ok(Math.abs(tk.ss - Math.min(100, tk.taken * 0.06 * 1.5)) < 0.3, `victim SS gain x1.5: taken ${tk.taken} ss ${tk.ss}`);
        S.setRules(false);
        const rn = S.simulateShot(terrain, players, prm);
        const shn = rn.players.find(q => q.id === p.id);
        if (shn.dealt > 0) ok(Math.abs(shn.ss - Math.min(100, shn.dealt * 0.12)) < 0.3, `normal SS gain x1: dealt ${shn.dealt} ss ${shn.ss}`);
        console.log(`ssMul: beginner dealt ${sh.dealt} -> ss ${sh.ss} (x1.5 of ${(sh.dealt * 0.12).toFixed(1)}); normal dealt ${shn.dealt} -> ss ${shn.ss}`);
        done = true;
      }
    }
    ok(done, 'found a hit for the SS gain check');
  }

  // 4e) dmgMul 훅: 무기 피해에만 곱해진다 (규칙 프리셋은 1.0 이지만 훅이 살아있는지)
  {
    const { terrain, players } = setup(S, 777, ['cannon', 'missile', 'laser', 'multi']);
    const p = players[0];
    let checked = false;
    for (let ang = 20; ang <= 80 && !checked; ang += 2) for (let pw = 30; pw <= 100 && !checked; pw += 2) {
      const prm = { pid: p.id, weapon: 0, angle: ang, power: pw, x: p.x, y: p.y, facing: players[1].x > p.x ? 1 : -1, wind: 0, seed: 42 };
      S.setRules(false);
      const r1 = S.simulateShot(terrain, players, prm), d1 = r1.players.find(q => q.id === players[1].id).taken;
      if (d1 < 200) continue;
      S.RULES.dmgMul = 0.5;
      const r2 = S.simulateShot(terrain, players, prm), d2 = r2.players.find(q => q.id === players[1].id).taken;
      S.setRules(false);
      ok(d2 > 0 && d2 <= Math.ceil(d1 * 0.5) + 1, `dmgMul hook: ${d1} -> ${d2}`);
      checked = true;
    }
    ok(checked, 'dmgMul hook test found a hit');
    ok(S.RULES.dmgMul === 1, 'RULES restored');
  }

  // 4f) 궤도 레이저(위성): 반경이 blastMul 을 따른다
  {
    const run = beginner => {
      S.setRules(beginner);
      const gen = S.genTerrain(555), tm = new S.TerrainMask(gen.mask);
      const pl = [S.makeSimPlayer({ id: 'a', tank: 'laser', x: 200, y: Math.round(gen.heights[200]), facing: 1, angle: 45, hp: 900, maxHp: 900, alive: true, ss: 100 }),
                  S.makeSimPlayer({ id: 'b', tank: 'cannon', x: 1300, y: Math.round(gen.heights[1300]), facing: -1, angle: 45, hp: 1100, maxHp: 1100, alive: true })];
      const w = S.makeWorld(tm, pl, 0, 1, null);
      S.runPending(w, { kind: 'orbital', x: 700, w: S.TANKS.laser.weapons[2], owner: 'a' });
      S.setRules(false);
      return tm.ops.map(o => o[3]);
    };
    const rn = run(false), rb = run(true);
    ok(rn.every(r => r === 30) && rb.every(r => r === Math.round(30 * 1.3)), `orbital beam radius normal ${rn[0]} beginner ${rb[0]}`);
  }
  console.log('beginner rule numbers OK');
}

console.log(fails ? `${fails} FAILURES` : 'ALL SIM TESTS PASSED');
process.exit(fails ? 1 : 0);
