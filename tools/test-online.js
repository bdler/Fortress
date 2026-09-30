/**
 * 온라인 4인 대전 통합 테스트
 *  - Code.gs 를 목 서버로 실행
 *  - 브라우저 페이지 3개(사람) + 방장이 돌리는 CPU 1명
 *  - 사람 턴은 AI 로직으로 자동 조작
 *  - 모든 클라이언트의 지형/체력이 끝까지 동일한지 검사
 *  - BEGINNER=1 : 방장이 비기너 모드를 켜고 시작 → 모든 클라이언트가 비기너 규칙(40초, 바람 ±2 ...)으로 진행하는지 검사
 *  - HTML=<경로> : 빌드 결과 위치 (기본 dist/fortress.html)
 */
const { chromium } = require('playwright');
const path = require('path');
const { createServer } = require('./gas-mock');
const OUT = process.env.SHOTS || '/tmp';
const HTML = process.env.HTML ? path.resolve(process.env.HTML) : path.resolve(__dirname, '../dist/fortress.html');
const BEGINNER = process.env.BEGINNER === '1';
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
    await page.goto('file://' + HTML);
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
  let failed = 0;
  const check = (c, msg) => { if (!c) { failed++; console.log('CHECK FAILED:', msg); } };
  const serverRoom = () => JSON.parse(server.store.get('R_' + code));
  check(serverRoom().beginner === false, 'new room starts with beginner=false');
  if (BEGINNER) {
    // 방장이 비기너 토글 (UI 체크박스가 있으면 클릭, 없으면 서버 API 직접 호출)
    const hasToggle = !!(await pages[0].$('#on-beginner'));
    if (hasToggle) {
      await pages[0].evaluate(() => document.querySelector('#on-beginner').click());
      console.log('host toggled #on-beginner');
    } else {
      await pages[0].evaluate(async () => { const B = G.backend; B.room = await Net.call('hostUpdate', B.code, B.pid, B.token, { beginner: true }); });
      console.log('no #on-beginner checkbox in this build: called hostUpdate({beginner:true}) directly');
    }
    for (let i = 0; i < 40 && !serverRoom().beginner; i++) await new Promise(r => setTimeout(r, 250));
    check(serverRoom().beginner === true, 'server room.beginner is true after host toggle');
    // 손님들도 방 정보로 비기너를 본다
    for (let i = 1; i < 3; i++) {
      await pages[i].waitForFunction(() => G.backend && G.backend.room && G.backend.room.beginner === true, null, { timeout: 15000 });
      if (hasToggle) {
        const st = await pages[i].evaluate(() => { const e = document.querySelector('#on-beginner'); return e ? { checked: e.checked, disabled: e.disabled } : null; });
        check(st && st.checked === true && st.disabled === true, `guest P${i} #on-beginner reflects room (checked+disabled): ` + JSON.stringify(st));
      }
    }
    // 방장이 아닌 사람은 서버에서도 못 바꾼다
    const rej = await pages[1].evaluate(async () => { try { const B = G.backend; await Net.call('hostUpdate', B.code, B.pid, B.token, { beginner: false }); return 'accepted'; } catch (e) { return e.message; } });
    check(/방장/.test(rej), 'guest hostUpdate rejected: ' + rej);
    check(serverRoom().beginner === true, 'still beginner after guest attempt');
    await pages[2].screenshot({ path: OUT + '/on-1b-lobby-beginner.png' });
  }
  await pages[0].click('#on-start');
  await Promise.all(pages.map(p => p.waitForSelector('#hud:not(.hidden)', { timeout: 20000 })));
  console.log('game started on all clients');
  // 모든 클라이언트가 같은 규칙으로 시작했는가
  const rules0 = await Promise.all(pages.map(p => p.evaluate(() => ({ b: G.beginner, tt: RULES.turnTime, ttc: TURN_TIME, hitR: RULES.hitR, blast: RULES.blastMul, cs: RULES.chargeSpeed, startB: G.log[0] && G.log[0].beginner, tl: G.turn && G.turn.timeLeft }))));
  console.log('rules at start:', JSON.stringify(rules0));
  rules0.forEach((r, i) => {
    check(r.b === BEGINNER && r.startB === BEGINNER, `P${i}: G.beginner === ${BEGINNER} (start event beginner ${r.startB})`);
    check(r.tt === (BEGINNER ? 40 : 25) && r.ttc === r.tt, `P${i}: RULES.turnTime ${r.tt} / TURN_TIME ${r.ttc}`);
    check(r.hitR === (BEGINNER ? 26 : 21) && r.blast === (BEGINNER ? 1.3 : 1) && r.cs === (BEGINNER ? 30 : 52), `P${i}: hitR/blast/chargeSpeed ${r.hitR}/${r.blast}/${r.cs}`);
  });

  // 사람 턴은 AI 로 자동 조작
  const autopilot = () => {
    if (window.__auto) return;
    window.__auto = setInterval(() => {
      if (G.ctl && !G.ctl.ai && !G.ctl.done && !G.busy && !window.__walking) {
        if (Math.random() < 0.2) {
          // 가끔은 걸어가다가 턴을 넘긴다 (skip 동기화 검증)
          window.__walking = true; Input.left = true;
          setTimeout(() => { Input.left = false; skipMyTurn(); window.__walking = false; window.__skips = (window.__skips || 0) + 1; }, 700);
        } else {
          // 가끔 아이템을 직접 골라서 쏜다 (아이템 동기화 검증)
          if (Math.random() < 0.45) selectItem(ITEM_IDS[Math.floor(Math.random() * 3)]);
          G.ctl.ai = { phase: 'think', t: 0.3 };
        }
      }
      if (G.screen === 'play' && Math.random() < 0.06) sendEmote(Math.floor(Math.random() * EMOTES.length));
    }, 300);
    // 다른 사람의 말풍선이 도착했는지 센다
    const orig = window.applyEmote;
    window.applyEmote = (pid, i) => { if (!(G.backend && pid === G.backend.pid)) window.__emotesIn = (window.__emotesIn || 0) + 1; return orig(pid, i); };
  };
  for (const p of pages) await p.evaluate(autopilot);

  const snap = p => p.evaluate(() => ({
    screen: G.screen, busy: G.busy || !!G.anim || G.queue.length > 0, turn: G.turn && G.turn.no, log: G.log.length,
    ops: JSON.stringify(G.terrain.ops.map(o => o.map(v => typeof v === 'number' ? Math.round(v) : v))),
    hp: G.players.map(q => q.name + ':' + q.hp + (q.alive ? '' : '✖')).join(' '),
    items: JSON.stringify(G.players.map(q => [q.items, q.stats])),
    maxHeal: Math.max(...G.players.map(q => q.items.heal)), beginner: G.beginner, tt: RULES.turnTime,
    order: JSON.stringify(G.turnOrder),
    // 지금 턴인 플레이어는 이동 중일 수 있으므로(실시간 위치는 지연 전달) 비교에서 제외
    pos: G.players.filter(q => !G.turn || q.id !== G.turn.pid).map(q => Math.round(q.x) + ',' + Math.round(q.y)).join(' '),
    nops: G.terrain.ops.length
  }));

  let checks = 0, mismatches = 0, lastTurn = 0, shot = 0, maxHealSeen = 0, ruleDrift = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 8 * 60 * 1000) {
    await new Promise(r => setTimeout(r, 1500));
    const ss = await Promise.all(pages.map(snap));
    ss.forEach(s => { maxHealSeen = Math.max(maxHealSeen, s.maxHeal); if (s.beginner !== BEGINNER || s.tt !== (BEGINNER ? 40 : 25)) ruleDrift++; });
    if (ss.every(s => s.screen === 'result')) { console.log('game ended on all clients'); break; }
    // 모두 같은 로그 위치에서 쉬고 있을 때만 비교
    if (ss.every(s => !s.busy && s.log === ss[0].log && s.turn === ss[0].turn)) {
      checks++;
      const bad = ss.some(s => s.ops !== ss[0].ops || s.hp !== ss[0].hp || s.pos !== ss[0].pos || s.items !== ss[0].items || s.order !== ss[0].order);
      if (bad) { mismatches++; console.log('MISMATCH at turn', ss[0].turn); ss.forEach((s, i) => console.log('  P' + i, s.hp, '|', s.pos, '| ops', s.nops, '|', s.items, s.order)); }
      if (ss[0].turn !== lastTurn) { lastTurn = ss[0].turn; console.log(`turn ${lastTurn}: ${ss[0].hp}`); }
      if (lastTurn >= 4 && shot === 0) { shot = 1; await pages[1].screenshot({ path: OUT + '/on-2-game.png' }); }
    }
    if (lastTurn > MAX_TURNS) break;
  }
  await pages[2].screenshot({ path: OUT + '/on-3-late.png' });
  const room = JSON.parse(server.store.get('R_' + code));
  console.log('skips:', (await Promise.all(pages.map(p => p.evaluate(() => window.__skips || 0)))).join(','));
  const emo = await Promise.all(pages.map(p => p.evaluate(() => window.__emotesIn || 0)));
  console.log('emotes received:', emo.join(','));
  const used = await pages[0].evaluate(() => G.players.map(q => q.name + ':' + JSON.stringify(q.items) + ' shots ' + q.stats.shots + ' hits ' + q.stats.hits + ' dmg ' + q.stats.dealt).join(' | '));
  console.log('items/stats:', used);
  console.log('server room status:', room.status, 'events:', room.evCount, 'turn:', room.turn && room.turn.no);
  console.log(`consistency checks: ${checks}, mismatches: ${mismatches}`);
  // 규칙 검증: 시작 이벤트, 바람 범위 (서버 로그 전체 + 각 클라이언트 로그), 회복 아이템 개수
  const lim = BEGINNER ? 2 : 10;
  const srvEvs = []; for (let i = 0; i < room.evCount; i++) srvEvs.push(JSON.parse(server.store.get('E_' + code + '_' + i)));
  const srvWinds = srvEvs.filter(e => e.type === 'turn').map(e => e.wind);
  check(srvEvs[0].type === 'start' && srvEvs[0].beginner === BEGINNER, 'server start event beginner === ' + BEGINNER);
  check(srvWinds.length > 3 && srvWinds.every(w => Math.abs(w) <= lim), `server turn winds within ±${lim}: ${srvWinds.join(',')}`);
  const cliWinds = await Promise.all(pages.map(p => p.evaluate(() => G.log.filter(e => e.type === 'turn').map(e => e.wind))));
  cliWinds.forEach((w, i) => check(w.length > 3 && w.every(x => Math.abs(x) <= lim), `P${i} turn winds within ±${lim}: ${w.join(',')}`));
  check(ruleDrift === 0, 'rules identical on all clients throughout (drift samples: ' + ruleDrift + ')');
  check(maxHealSeen === (BEGINNER ? 2 : 1), `heal items at start ${maxHealSeen} (want ${BEGINNER ? 2 : 1})`);
  console.log(`rules check [${BEGINNER ? 'BEGINNER' : 'normal'}]: winds ${Math.min(...srvWinds)}..${Math.max(...srvWinds)} over ${srvWinds.length} turns, max heal ${maxHealSeen}, failed checks ${failed}`);
  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'NO PAGE ERRORS');
  await browser.close();
  process.exit(failed || mismatches || errors.length || checks < 3 || emo.some(n => n === 0) ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
