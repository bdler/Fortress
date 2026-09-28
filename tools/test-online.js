/**
 * 온라인 4인 대전 통합 테스트
 *  - Code.gs 를 목 서버로 실행
 *  - 브라우저 페이지 3개(사람) + 방장이 돌리는 CPU 1명
 *  - 사람 턴은 AI 로직으로 자동 조작
 *  - 모든 클라이언트의 지형/체력이 끝까지 동일한지 검사
 */
const { chromium } = require('playwright');
const path = require('path');
const { createServer } = require('./gas-mock');
const OUT = process.env.SHOTS || '/tmp';
const MAX_TURNS = +(process.env.MAX_TURNS || 14);

const server = createServer();
const INIT = `
  window.google = { script: { run: new Proxy({}, { get(_, fn) {
    const mk = (ok, fail) => new Proxy({}, { get(_, name) {
      if (name === 'withSuccessHandler') return f => mk(f, fail);
      if (name === 'withFailureHandler') return f => mk(ok, f);
      return (...args) => { window.__gas(name, JSON.stringify(args)).then(r => { const o = JSON.parse(r); if (o.err) fail && fail(new Error(o.err)); else ok && ok(o.res); }); };
    }});
    return mk(null, null)[fn];
  }})}};`;

(async () => {
  const browser = await chromium.launch();
  const pages = [];
  const errors = [];
  for (let i = 0; i < 3; i++) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 780 } });
    await ctx.exposeFunction('__gas', async (fn, argsJson) => {
      await new Promise(r => setTimeout(r, 80 + Math.random() * 300)); // 네트워크 지연 흉내
      try { return JSON.stringify({ res: server.call(fn, JSON.parse(argsJson)) }); }
      catch (e) { return JSON.stringify({ err: e.message }); }
    });
    await ctx.addInitScript(INIT);
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(`[P${i}] ${e.message}\n${e.stack}`));
    page.on('dialog', d => d.accept());
    await page.goto('file://' + path.resolve(__dirname, '../dist/fortress.html'));
    pages.push(page);
  }
  const names = ['앨리스', '밥', '찰리'];
  // 방 만들기
  await pages[0].click('#btn-online');
  await pages[0].fill('#on-name', names[0]);
  await pages[0].click('#on-create');
  await pages[0].waitForFunction(() => /^[A-Z]{4}$/.test(document.querySelector('#room-code').textContent));
  const code = await pages[0].textContent('#room-code');
  console.log('room code', code);
  for (let i = 1; i < 3; i++) {
    await pages[i].click('#btn-online');
    await pages[i].fill('#on-name', names[i]);
    await pages[i].fill('#on-code', code);
    await pages[i].click('#on-join');
    await pages[i].waitForSelector('#scr-onlineLobby.show');
  }
  // 방장: 탱크 변경 + CPU 추가
  await pages[1].waitForSelector('#on-slots .slot.you .arr');
  await pages[1].click('#on-slots .slot.you [data-act=next]');
  await pages[0].waitForSelector('#on-slots [data-act=cpu]');
  await pages[0].click('#on-slots [data-act=cpu]');
  await pages[0].waitForFunction(() => document.querySelectorAll('#on-slots .slot:not(.empty)').length === 4, null, { timeout: 15000 });
  await pages[2].waitForFunction(() => document.querySelectorAll('#on-slots .slot:not(.empty)').length === 4, null, { timeout: 15000 });
  await pages[2].screenshot({ path: OUT + '/on-1-lobby.png' });
  await pages[0].click('#on-start');
  await Promise.all(pages.map(p => p.waitForSelector('#hud:not(.hidden)', { timeout: 20000 })));
  console.log('game started on all clients');

  // 사람 턴은 AI 로 자동 조작
  const autopilot = () => {
    if (window.__auto) return;
    window.__auto = setInterval(() => {
      if (G.ctl && !G.ctl.ai && !G.ctl.done && !G.busy && !window.__walking) {
        if (Math.random() < 0.2) {
          // 가끔은 걸어가다가 턴을 넘긴다 (skip 동기화 검증)
          window.__walking = true; Input.left = true;
          setTimeout(() => { Input.left = false; skipMyTurn(); window.__walking = false; window.__skips = (window.__skips || 0) + 1; }, 700);
        } else G.ctl.ai = { phase: 'think', t: 0.3 };
      }
    }, 300);
  };
  for (const p of pages) await p.evaluate(autopilot);

  const snap = p => p.evaluate(() => ({
    screen: G.screen, busy: G.busy || !!G.anim || G.queue.length > 0, turn: G.turn && G.turn.no, log: G.log.length,
    ops: JSON.stringify(G.terrain.ops.map(o => o.map(v => typeof v === 'number' ? Math.round(v) : v))),
    hp: G.players.map(q => q.name + ':' + q.hp + (q.alive ? '' : '✖')).join(' '),
    // 지금 턴인 플레이어는 이동 중일 수 있으므로(실시간 위치는 지연 전달) 비교에서 제외
    pos: G.players.filter(q => !G.turn || q.id !== G.turn.pid).map(q => Math.round(q.x) + ',' + Math.round(q.y)).join(' '),
    nops: G.terrain.ops.length
  }));

  let checks = 0, mismatches = 0, lastTurn = 0, shot = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 8 * 60 * 1000) {
    await new Promise(r => setTimeout(r, 1500));
    const ss = await Promise.all(pages.map(snap));
    if (ss.every(s => s.screen === 'result')) { console.log('game ended on all clients'); break; }
    // 모두 같은 로그 위치에서 쉬고 있을 때만 비교
    if (ss.every(s => !s.busy && s.log === ss[0].log && s.turn === ss[0].turn)) {
      checks++;
      const bad = ss.some(s => s.ops !== ss[0].ops || s.hp !== ss[0].hp || s.pos !== ss[0].pos);
      if (bad) { mismatches++; console.log('MISMATCH at turn', ss[0].turn); ss.forEach((s, i) => console.log('  P' + i, s.hp, '|', s.pos, '| ops', s.nops)); }
      if (ss[0].turn !== lastTurn) { lastTurn = ss[0].turn; console.log(`turn ${lastTurn}: ${ss[0].hp}`); }
      if (lastTurn >= 4 && shot === 0) { shot = 1; await pages[1].screenshot({ path: OUT + '/on-2-game.png' }); }
    }
    if (lastTurn > MAX_TURNS) break;
  }
  await pages[2].screenshot({ path: OUT + '/on-3-late.png' });
  const room = JSON.parse(server.store.get('R_' + code));
  console.log('skips:', (await Promise.all(pages.map(p => p.evaluate(() => window.__skips || 0)))).join(','));
  console.log('server room status:', room.status, 'events:', room.evCount, 'turn:', room.turn && room.turn.no);
  console.log(`consistency checks: ${checks}, mismatches: ${mismatches}`);
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'NO PAGE ERRORS');
  await browser.close();
  process.exit(mismatches || errors.length || checks < 3 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
