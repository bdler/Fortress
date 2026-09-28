// 단독 HTML 스모크 테스트: 타이틀 → 로컬 로비 → 게임 → 발사
const { chromium } = require('playwright');
const path = require('path');
const OUT = process.env.SHOTS || '/tmp';
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message + '\n' + e.stack));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('dialog', d => d.accept());
  await page.goto('file://' + path.resolve(__dirname, '../dist/fortress.html'));
  await page.waitForTimeout(2500);
  await page.screenshot({ path: OUT + '/1-title.png' });
  await page.click('#btn-local');
  await page.waitForTimeout(600);
  await page.screenshot({ path: OUT + '/2-lobby.png' });
  await page.click('#local-start');
  await page.waitForTimeout(2600);
  await page.screenshot({ path: OUT + '/3-game.png' });
  // 몇 턴 진행 (사람 턴이면 발사)
  for (let i = 0; i < 40; i++) {
    const mine = await page.evaluate(() => !!(G.ctl && !findPlayer(G.ctl.pid).cpu && !G.busy));
    if (mine) {
      await page.keyboard.down('ArrowRight'); await page.waitForTimeout(300); await page.keyboard.up('ArrowRight');
      await page.keyboard.down('ArrowUp'); await page.waitForTimeout(250); await page.keyboard.up('ArrowUp');
      await page.keyboard.down('Space'); await page.waitForTimeout(1100);
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
  const st = await page.evaluate(() => ({ screen: G.screen, turn: G.turn && G.turn.no, hp: G.players.map(p => p.name + ':' + p.hp + (p.alive ? '' : 'X')), ops: G.terrain && G.terrain.ops.length }));
  console.log(JSON.stringify(st));
  console.log(errors.length ? errors.join('\n') : 'NO ERRORS');
  await browser.close();
})();
