/**
 * 온라인 로비 경쟁 상태(race) 회귀 테스트 — 비기너 토글
 *  google.script.run 은 호출 순서를 보장하지 않는다. 방장 브라우저 1 + 손님 1 로 네트워크 지연을 직접 조절해서 확인한다:
 *   A) 방장이 [비기너 토글] 직후 곧바로 [게임 시작] 을 눌렀을 때 (hostUpdate 는 느리고 startGame 은 빠름)
 *      → 시작 이벤트(start.beginner)와 서버 room.beginner 가 방장이 본 값(켜짐)과 같아야 한다.
 *   B) 토글 전에 보낸 낡은 poll 응답이 hostUpdate 응답 뒤에 도착해도 방장의 체크박스가 꺼졌다 켜졌다 하면 안 된다.
 *   C) 빠르게 두 번 눌러도(켬 → 끔) 마지막 값(끔)이 서버에 남는다.
 *
 *  NODE_PATH=$(npm root -g) HTML=/path/built.html node tools/test-lobby-race.js
 *  (HTML 기본값: dist/fortress.html)
 */
const { chromium } = require('playwright');
const path = require('path');
const { createServer } = require('./gas-mock');
const HTML = process.env.HTML ? path.resolve(process.env.HTML) : path.resolve(__dirname, '../dist/fortress.html');

const INIT = `
  window.google = { script: { run: new Proxy({}, { get(_, fn) {
    const mk = (ok, fail) => new Proxy({}, { get(_, name) {
      if (name === 'withSuccessHandler') return f => mk(f, fail);
      if (name === 'withFailureHandler') return f => mk(ok, f);
      return (...args) => { window.__gas(name, JSON.stringify(args)).then(r => { const o = JSON.parse(r); if (o.err) fail && fail(new Error(o.err)); else ok && ok(o.res); }); };
    }});
    return mk(null, null)[fn];
  }})}};`;

let failed = 0;
const check = (c, msg) => { if (!c) { failed++; console.log('CHECK FAILED:', msg); } else console.log('ok:', msg); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const server = createServer();
  // 함수별 지연 (ms). pre = 서버에 닿기 전 지연 (그 사이에 다른 호출이 먼저 처리될 수 있음) · post = 서버가 처리한 뒤 응답이 돌아오기까지 (낡은 스냅샷)
  const lat = { pre: {}, post: {} };
  let lastPollAt = 0;
  const browser = await chromium.launch();
  const errors = [];
  const open = async (i) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 780 } });
    await ctx.exposeFunction('__gas', async (fn, argsJson) => {
      if (fn === 'poll' && i === 0) lastPollAt = Date.now();   // 방장 페이지의 poll 만
      await sleep(lat.pre[fn] != null ? lat.pre[fn] : 30);
      let out;
      try { out = JSON.stringify({ res: server.call(fn, JSON.parse(argsJson)) }); } catch (e) { out = JSON.stringify({ err: e.message }); }
      await sleep(lat.post[fn] || 0);
      return out;
    });
    await ctx.addInitScript(INIT);
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(`[P${i}] ${e.message}\n${e.stack}`));
    page.on('dialog', d => d.accept());
    await page.goto('file://' + HTML);
    return page;
  };
  let host, guest;
  // 시나리오마다 새 브라우저 컨텍스트 2개 (방장 · 손님) 로 새 방을 만든다
  const newRoom = async () => {
    if (host) { await host.context().close(); await guest.context().close(); }
    host = await open(0); guest = await open(1);
    await host.click('#btn-online');
    await host.fill('#on-name', '방장');
    await host.click('#on-create');
    await host.waitForFunction(() => /^[A-Z]{4}$/.test(document.querySelector('#room-code').textContent));
    const code = await host.textContent('#room-code');
    await guest.click('#btn-online');
    await guest.fill('#on-name', '손님');
    await guest.fill('#on-code', code);
    await guest.click('#on-join');
    await guest.waitForSelector('#scr-onlineLobby.show');
    await host.waitForFunction(() => document.querySelectorAll('#on-slots .slot:not(.empty)').length === 2, null, { timeout: 15000 });
    await host.waitForFunction(() => !document.querySelector('#on-start').disabled, null, { timeout: 15000 });
    return code;
  };
  const room = code => JSON.parse(server.store.get('R_' + code));
  const startEv = code => JSON.parse(server.store.get('E_' + code + '_0'));

  // ---- A) 토글 직후 시작 ----
  {
    const code = await newRoom();
    lat.pre = { hostUpdate: 500, startGame: 20 }; lat.post = {};
    await host.evaluate(() => { document.querySelector('#on-beginner').click(); document.querySelector('#on-start').click(); });
    for (let i = 0; i < 60 && room(code).status === 'lobby'; i++) await sleep(100);
    await sleep(900);
    const r = room(code);
    check(r.status === 'playing', 'A) game started (status ' + r.status + ')');
    check(r.beginner === true, 'A) server room.beginner is true after toggle+start in the same tick (got ' + r.beginner + ')');
    check(startEv(code).beginner === true, 'A) start event beginner === true (got ' + startEv(code).beginner + ')');
    await host.waitForFunction(() => G.screen === 'play' && G.beginner === true, null, { timeout: 15000 }).then(() => check(true, 'A) host client plays by beginner rules'), () => check(false, 'A) host client plays by beginner rules'));
  }

  // ---- B) 낡은 poll 응답이 체크박스를 되돌리지 않는다 ----
  {
    lat.pre = { hostUpdate: 30 }; lat.post = {};
    const code = await newRoom();
    lat.pre = { poll: 5, hostUpdate: 30 }; lat.post = { poll: 800 };       // poll: 서버는 요청 즉시 스냅샷, 응답은 0.8초 뒤에 도착
    // 방금 poll 이 나간 직후에 클릭
    for (let i = 0; i < 1000 && Date.now() - lastPollAt > 120; i++) await sleep(5);
    await host.evaluate(() => {
      window.__seq = []; const el = document.querySelector('#on-beginner'); const t0 = performance.now();
      window.__tm = setInterval(() => window.__seq.push(el.checked ? 1 : 0), 25);
      el.click();
    });
    await sleep(3800);
    const seq = await host.evaluate(() => { clearInterval(window.__tm); return window.__seq; });
    const firstOn = seq.indexOf(1), flicker = firstOn >= 0 && seq.slice(firstOn).indexOf(0) >= 0;
    check(firstOn >= 0, 'B) checkbox turned on after the click');
    check(!flicker, 'B) checkbox never flips back off while the server value is on (samples: ' + seq.join('').replace(/(.)\1*/g, (m, c) => c + '×' + m.length + ' ').trim() + ')');
    check(room(code).beginner === true, 'B) server room.beginner is true');
    const finalChecked = await host.evaluate(() => document.querySelector('#on-beginner').checked);
    check(finalChecked === true, 'B) checkbox ends on');
  }

  // ---- C) 빠르게 켬 → 끔: 마지막 값이 이긴다 ----
  {
    lat.pre = { hostUpdate: 30 }; lat.post = {};
    const code = await newRoom();
    lat.pre = { hostUpdate: 250 }; lat.post = {};
    await host.evaluate(() => { const el = document.querySelector('#on-beginner'); el.click(); setTimeout(() => el.click(), 60); });
    await sleep(2500);
    check(room(code).beginner === false, 'C) quick on→off leaves server room.beginner false (got ' + room(code).beginner + ')');
    const st = await host.evaluate(() => document.querySelector('#on-beginner').checked);
    check(st === false, 'C) checkbox ends off');
    // 켬 → 끔 → 켬 + 곧바로 시작
    await host.evaluate(() => { const el = document.querySelector('#on-beginner'); el.click(); setTimeout(() => el.click(), 40); setTimeout(() => { el.click(); document.querySelector('#on-start').click(); }, 80); });
    for (let i = 0; i < 80 && room(code).status === 'lobby'; i++) await sleep(100);
    check(room(code).status === 'playing' && startEv(code).beginner === true, 'C) on→off→on + start: started as beginner (got ' + startEv(code).beginner + ')');
  }

  check(errors.length === 0, 'no page errors' + (errors.length ? '\n' + errors.join('\n') : ''));
  await browser.close();
  console.log(failed ? `FAILED (${failed})` : 'ALL LOBBY RACE TESTS PASSED');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
