#!/usr/bin/env node
/**
 * Code.gs 규칙 테스트 (순수 Node, tools/gas-mock.js 사용 — 브라우저 불필요)
 *  - 방 만들기 → 방장만 비기너 토글 (엄격히 boolean) → 게임 시작 → start 이벤트에 beginner:true
 *  - 비기너 방: 바람 ±2, 회복 아이템 2개, 턴 제한 시간 40초 / 일반 방: 바람 ±10, 회복 1개, 25초
 *  - 게임 시작 후에는 바꿀 수 없다
 *   node tools/test-server.js
 */
const { createServer } = require('./gas-mock');
let fails = 0;
const ok = (c, msg) => { if (!c) { fails++; console.log('FAIL:', msg); } };

function makeRoom(server) {
  const c = (fn, ...args) => server.call(fn, args);
  const host = c('createRoom', '방장');
  const guest = c('joinRoom', host.code, '손님');
  const room = () => JSON.parse(server.store.get('R_' + host.code));
  const events = () => { const r = room(), out = []; for (let i = 0; i < r.evCount; i++) out.push(JSON.parse(server.store.get('E_' + host.code + '_' + i))); return out; };
  return { c, host, guest, room, events, code: host.code };
}

function startRoom(server, beginner) {
  const R = makeRoom(server);
  if (beginner !== undefined) R.c('hostUpdate', R.code, R.host.pid, R.host.token, { beginner });
  R.c('startGame', R.code, R.host.pid, R.host.token);
  return R;
}

/** 현재 턴 플레이어가 skip 을 제출 (턴을 계속 진행시켜 바람을 많이 뽑는다) */
function skipTurn(R) {
  const r = R.room(), t = r.turn;
  const who = [R.host, R.guest].find(x => x.pid === t.pid);
  return R.c('submit', R.code, who.pid, who.token, { type: 'skip', actor: t.pid, no: t.no, pos: null });
}

// 1) 방 기본값 + 방장 전용 + 엄격한 boolean
{
  const server = createServer();
  const R = makeRoom(server);
  ok(R.room().beginner === false, 'new room: beginner false');
  ok(R.c('updateMe', R.code, R.host.pid, R.host.token, {}).beginner === false, 'publicRoom_ includes beginner:false');
  // 방장이 아닌 사람은 못 바꾼다
  let err = null;
  try { R.c('hostUpdate', R.code, R.guest.pid, R.guest.token, { beginner: true }); } catch (e) { err = e.message; }
  ok(err && /방장/.test(err), 'non-host hostUpdate({beginner}) rejected: ' + err);
  ok(R.room().beginner === false, 'still false after rejected non-host change');
  // boolean 이 아닌 값은 무시
  for (const bad of ['true', 1, 'yes', null, {}, [], 0, 'false']) {
    const pr = R.c('hostUpdate', R.code, R.host.pid, R.host.token, { beginner: bad });
    ok(pr.beginner === false && R.room().beginner === false, 'non-boolean beginner ignored: ' + JSON.stringify(bad));
  }
  // 방장이 켜고 끄기
  let pr = R.c('hostUpdate', R.code, R.host.pid, R.host.token, { beginner: true });
  ok(pr.beginner === true && R.room().beginner === true, 'host sets beginner true');
  const pl = R.c('poll', R.code, R.guest.pid, R.guest.token, 0);
  ok(pl.room.beginner === true, 'guest poll sees room.beginner true');
  pr = R.c('hostUpdate', R.code, R.host.pid, R.host.token, { beginner: false });
  ok(pr.beginner === false, 'host sets beginner false');
  // 다른 설정 변경이 beginner 를 건드리지 않는다
  R.c('hostUpdate', R.code, R.host.pid, R.host.token, { beginner: true });
  R.c('hostUpdate', R.code, R.host.pid, R.host.token, { teamMode: false, theme: 'snow' });
  ok(R.room().beginner === true, 'other host settings keep beginner');
  R.c('updateMe', R.code, R.guest.pid, R.guest.token, { tank: 'ice' });
  ok(R.room().beginner === true, 'updateMe keeps beginner');
  console.log('lobby rules OK');
}

// 2) 시작: start 이벤트, 바람 범위, 아이템, 시작 후 변경 불가
function checkMatch(beginner) {
  const server = createServer();
  const R = startRoom(server, beginner);
  const ev0 = R.events()[0];
  ok(ev0.type === 'start' && ev0.beginner === beginner, `start event beginner:${beginner} (got ${ev0.beginner})`);
  ok(R.room().players.every(p => p.items.dual === 1 && p.items.power === 1 && p.items.heal === (beginner ? 2 : 1)), `heal item count ${beginner ? 2 : 1}`);
  // 시작 후 변경 불가
  const pr = R.c('hostUpdate', R.code, R.host.pid, R.host.token, { beginner: !beginner });
  ok(R.room().beginner === beginner && pr.beginner === beginner, 'cannot change after start');
  // 턴을 200번 넘기며 바람 수집
  const winds = [];
  for (let i = 0; i < 200; i++) {
    const r = skipTurn(R);
    ok(r && r.ok, 'skip accepted turn ' + i);
  }
  R.events().filter(e => e.type === 'turn').forEach(e => winds.push(e.wind));
  const lim = beginner ? 2 : 10, mx = Math.max(...winds), mn = Math.min(...winds);
  ok(winds.length > 150, 'collected winds: ' + winds.length);
  ok(winds.every(w => Number.isInteger(w) && Math.abs(w) <= lim), `all winds within ±${lim} (min ${mn} max ${mx})`);
  if (beginner) ok(winds.some(w => w > 0) && winds.some(w => w < 0) && winds.some(w => w === 0), 'beginner winds vary in -2..2');
  else ok(Math.max(...winds.map(Math.abs)) > 5, 'normal winds reach beyond ±5');
  console.log(`match [${beginner ? 'beginner' : 'normal'}]: ${winds.length} turn winds in [${mn}, ${mx}] (limit ±${lim}), start.beginner=${ev0.beginner}`);
  return { server, R };
}
checkMatch(false);
checkMatch(true);
{
  // 방 설정을 건드리지 않은 방(beginner 필드 미지정)도 start 에 beginner:false
  const server = createServer();
  const R = startRoom(server, undefined);
  ok(R.events()[0].beginner === false, 'default room start event beginner:false');
}

// 3) 회복 아이템 서버 검증: 비기너는 2번, 일반은 1번
{
  // 정확한 횟수: 같은 사람이 회복 아이템을 몇 번 쓸 수 있나
  const count = beginner => {
    const server = createServer();
    const R = startRoom(server, beginner);
    let n = 0, guard = 0;
    while (guard++ < 60) {
      const r = R.room();
      if (r.status !== 'playing') break;
      const t = r.turn, who = [R.host, R.guest].find(x => x.pid === t.pid);
      if (who !== R.host) { skipTurn(R); continue; }
      const res = R.c('submit', R.code, who.pid, who.token, { type: 'shot', actor: t.pid, no: t.no, params: { pid: t.pid, item: 'heal', delayAdd: 700 }, result: { players: [] } });
      if (!res.ok) break;
      n++;
    }
    return n;
  };
  const nb = count(true), nn = count(false);
  ok(nb === 2 && nn === 1, `heal uses: beginner ${nb} (want 2), normal ${nn} (want 1)`);
  console.log(`heal item uses accepted by server: beginner ${nb}, normal ${nn}`);
}

// 4) 턴 제한 시간: 일반 25초(+22초 여유) / 비기너 40초(+22초 여유) — 가짜 시계로 확인
function timeoutAt(beginner) {
  const server = createServer();
  let now = 1700000000000;
  server.setClock(() => now);
  const R = startRoom(server, beginner);
  const startedAt = R.room().turn.startedAt;
  const no0 = R.room().turn.no;
  for (let s = 5; s <= 120; s += 5) {
    now = startedAt + s * 1000;
    // 두 사람 모두 계속 접속 중 (자리 비움 판정 방지)
    R.c('poll', R.code, R.host.pid, R.host.token, 0);
    R.c('poll', R.code, R.guest.pid, R.guest.token, 0);
    const skip = R.events().find(e => e.type === 'skip' && e.no === no0);
    if (skip) return { s, reason: skip.reason };
  }
  return null;
}
{
  const n = timeoutAt(false), b = timeoutAt(true);
  ok(n && n.reason === 'timeout' && n.s === 50, 'normal room turn times out at ~47s: ' + JSON.stringify(n));
  ok(b && b.reason === 'timeout' && b.s === 65, 'beginner room turn times out at ~62s: ' + JSON.stringify(b));
  console.log(`turn timeout (skip appears at first poll after): normal ${n && n.s}s (25+22), beginner ${b && b.s}s (40+22)`);
}

console.log(fails ? `${fails} FAILURES` : 'ALL SERVER TESTS PASSED');
process.exit(fails ? 1 : 0);
