// 단독 HTML 스모크 테스트: 타이틀 → 로컬 로비 → 게임 → 발사, 이어서 비기너 규칙 매치
//   HTML=/path/to/built.html node tools/smoke.js   (기본: dist/fortress.html)
const { chromium } = require('playwright');
const path = require('path');
const OUT = process.env.SHOTS || '/tmp';
const HTML = process.env.HTML ? path.resolve(process.env.HTML) : path.resolve(__dirname, '../dist/fortress.html');
let bad = 0;
const check = (c, msg) => { if (!c) { bad++; console.log('CHECK FAILED:', msg); } };
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message + '\n' + e.stack));
  page.on('console', m => { if (m.type() === 'error' && !/ERR_CERT|fonts\.g/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('dialog', d => d.accept());
  await page.goto('file://' + HTML);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: OUT + '/1-title.png' });
  await page.click('#btn-local');
  await page.waitForTimeout(600);
  await page.screenshot({ path: OUT + '/2-lobby.png' });
  await page.click('#local-start');
  await page.waitForTimeout(2600);
  await page.screenshot({ path: OUT + '/3-game.png' });
  // 일반 규칙 확인
  const rn = await page.evaluate(() => ({ b: G.beginner, hitR: RULES.hitR, turn: RULES.turnTime, tt: TURN_TIME, cs: RULES.chargeSpeed, items: G.players.map(p => p.items.heal) }));
  console.log('normal rules', JSON.stringify(rn));
  check(rn.b === false && rn.hitR === 21 && rn.turn === 25 && rn.tt === 25 && rn.cs === 52 && rn.items.every(n => n === 1), 'normal rules in a default local match');
  // 몇 턴 진행 (사람 턴이면 발사)
  let chargePower = null;
  for (let i = 0; i < 40; i++) {
    const mine = await page.evaluate(() => !!(G.ctl && !findPlayer(G.ctl.pid).cpu && !G.busy));
    if (mine) {
      await page.keyboard.down('ArrowRight'); await page.waitForTimeout(300); await page.keyboard.up('ArrowRight');
      await page.keyboard.down('ArrowUp'); await page.waitForTimeout(250); await page.keyboard.up('ArrowUp');
      // 아이템(4/5/6) · 감정표현(7/8/9/0) 키
      await page.keyboard.press(String(4 + (i % 3))); await page.keyboard.press(String((7 + i) % 10));
      const sel = await page.evaluate(() => ({ item: G.ctl && G.ctl.item, emote: G.players.find(p => !p.cpu).emote }));
      console.log('item/emote', JSON.stringify(sel));
      await page.keyboard.down('Space'); await page.waitForTimeout(1100);
      if (chargePower === null) chargePower = await page.evaluate(() => (G.ctl && G.ctl.power) || 0);
      await page.screenshot({ path: OUT + '/4-charging.png' });
      await page.keyboard.up('Space');
      await page.waitForTimeout(700);
      await page.screenshot({ path: OUT + '/5-flight.png' });
    }
    await page.waitForTimeout(1000);
    if (i === 12) await page.screenshot({ path: OUT + '/6-mid.png' });
    const st = await page.evaluate(() => ({ screen: G.screen, turn: G.turn && G.turn.no, alive: G.players.filter(p => p.alive).length }));
    if (st.screen === 'result') break;
  }
  await page.screenshot({ path: OUT + '/7-late.png' });
  const st = await page.evaluate(() => ({ screen: G.screen, turn: G.turn && G.turn.no, hp: G.players.map(p => p.name + ':' + p.hp + (p.alive ? '' : 'X')), ops: G.terrain && G.terrain.ops.length,
    items: G.players.map(p => JSON.stringify(p.items)), stats: G.players.map(p => JSON.stringify(p.stats)), order: G.turnOrder }));
  console.log(JSON.stringify(st));
  console.log('normal charge power after ~1.1s hold:', chargePower && chargePower.toFixed(1), '(expect ~57)');
  check(chargePower > 45 && chargePower < 70, 'normal charge speed ~52/s, got ' + chargePower);
  const windsN = await page.evaluate(() => G.log.filter(e => e.type === 'turn').map(e => e.wind));
  check(windsN.length > 0 && windsN.every(w => Math.abs(w) <= 10), 'normal winds within ±10');

  // ---- 비기너 매치 (로컬): 사람 1 + CPU 2 ----
  const cfg = { teamMode: false, theme: 'grass', beginner: true, players: [
    { id: 'p0', name: '나', tank: 'cannon', team: 0, slot: 0, cpu: false },
    { id: 'p1', name: 'CPU 1', tank: 'missile', team: 0, slot: 1, cpu: true },
    { id: 'p2', name: 'CPU 2', tank: 'ice', team: 0, slot: 2, cpu: true }] };
  await page.evaluate(c => { G.lastConfig = c; launchLocal(c); }, cfg);
  await page.waitForFunction(() => G.screen === 'play' && G.beginner && G.players.length === 3 && G.turn, null, { timeout: 15000 });
  const rb = await page.evaluate(() => ({ b: G.beginner, hitR: RULES.hitR, blast: RULES.blastMul, turn: RULES.turnTime, tt: TURN_TIME, cs: RULES.chargeSpeed, tl: G.turn.timeLeft, items: G.players.map(p => p.items.heal), start: G.log[0].beginner }));
  console.log('beginner rules', JSON.stringify(rb));
  check(rb.b === true && rb.start === true && rb.hitR === 26 && rb.blast === 1.3 && rb.turn === 40 && rb.tt === 40 && rb.cs === 30 && rb.items.every(n => n === 2), 'beginner rules applied at match start');
  check(rb.tl > 35 && rb.tl <= 40, 'beginner turn timer starts at 40, got ' + rb.tl);
  let beginnerCharge = null, humanShots = 0, ring = null;
  for (let i = 0; i < 60 && humanShots < 3; i++) {
    const mine = await page.evaluate(() => !!(G.ctl && !findPlayer(G.ctl.pid).cpu && !G.busy && G.ctl.delayT <= 0));
    if (mine) {
      if (ring === null) ring = await page.evaluate(() => ({ off: parseFloat(document.querySelector('#hud-timer-rng').style.strokeDashoffset), tl: G.turn.timeLeft }));
      await page.keyboard.down('ArrowUp'); await page.waitForTimeout(200); await page.keyboard.up('ArrowUp');
      await page.keyboard.down('Space'); await page.waitForTimeout(1100);
      if (beginnerCharge === null) beginnerCharge = await page.evaluate(() => (G.ctl && G.ctl.power) || 0);
      if (humanShots === 0) await page.screenshot({ path: OUT + '/8-beginner-charging.png' });
      await page.keyboard.up('Space');
      humanShots++;
      await page.waitForTimeout(600);
    }
    await page.waitForTimeout(900);
    if (await page.evaluate(() => G.screen === 'result')) break;
  }
  console.log('beginner charge power after ~1.1s hold:', beginnerCharge && beginnerCharge.toFixed(1), '(expect ~33); timer ring', JSON.stringify(ring));
  check(beginnerCharge > 24 && beginnerCharge < 42, 'beginner charge speed ~30/s, got ' + beginnerCharge);
  check(ring && ring.off < 25, 'timer ring nearly full at the start of a 40s turn (dashoffset ' + (ring && ring.off) + ')');
  await page.screenshot({ path: OUT + '/9-beginner-late.png' });
  const fin = await page.evaluate(() => ({ screen: G.screen, turns: G.log.filter(e => e.type === 'turn').length, winds: G.log.filter(e => e.type === 'turn').map(e => e.wind),
    selfHits: G.log.filter(e => e.type === 'shot').reduce((n, e) => n + e.result.players.filter(r => r.id === e.pid && r.taken > 0).length, 0),
    hp: G.players.map(p => p.name + ':' + p.hp + (p.alive ? '' : 'X')) }));
  console.log(JSON.stringify(fin));
  check(fin.winds.length > 2 && fin.winds.every(w => Math.abs(w) <= 2), 'beginner winds within ±2: ' + fin.winds.join(','));
  check(fin.selfHits === 0, 'no self damage in beginner shots');
  // 다시 일반 매치로 돌아오면 규칙이 원래대로
  await page.evaluate(() => { const c = Object.assign({}, G.lastConfig, { beginner: false }); G.lastConfig = c; launchLocal(c); });
  await page.waitForFunction(() => G.screen === 'play' && G.players.length === 3 && G.turn && !G.beginner, null, { timeout: 15000 });
  const back = await page.evaluate(() => ({ turn: RULES.turnTime, hitR: RULES.hitR, tt: TURN_TIME, heal: G.players[0].items.heal }));
  check(back.turn === 25 && back.hitR === 21 && back.tt === 25 && back.heal === 1, 'normal rules restored: ' + JSON.stringify(back));

  console.log(errors.length ? errors.join('\n') : 'NO ERRORS');
  await browser.close();
  process.exit(errors.length || bad ? 1 : 0);
})();
