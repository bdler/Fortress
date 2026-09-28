#!/usr/bin/env node
/**
 * 시각 확인용 스크린샷 도구 (Playwright 필요: NODE_PATH=$(npm root -g))
 *
 *  node tools/shot.js --html /tmp/a.html --out /tmp/shots [옵션]
 *   --screen title|lobby|play|result   (기본 play)
 *   --theme grass|desert|snow|night|volcano|random
 *   --tanks cannon,missile,laser,multi (최대 4)
 *   --human 1          첫 슬롯을 사람으로 (기본: 전부 CPU)
 *   --ss 1             모든 탱크 SS 게이지를 계속 100으로 (필살기 확인)
 *   --frames 6 --every 1500   스크린샷 개수/간격(ms)
 *   --size 1400x860    뷰포트 (모바일 예: 844x390)
 *   --anim 1           포격 애니메이션/폭발 중일 때만 찍기
 *   --eval "JS"        게임 시작 후 페이지에서 실행할 코드
 * 페이지 에러(pageerror/console.error)를 모두 출력하고, 있으면 exit 1.
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const A = {};
for (let i = 2; i < process.argv.length; i += 2) A[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const html = path.resolve(A.html || path.join(__dirname, '..', 'dist', 'fortress.html'));
const out = path.resolve(A.out || '/tmp/shots');
fs.mkdirSync(out, { recursive: true });
const [vw, vh] = (A.size || '1400x860').split('x').map(Number);
const frames = +(A.frames || 6), every = +(A.every || 1500), screen = A.screen || 'play';
const tanks = (A.tanks || 'cannon,missile,laser,multi').split(',');
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: vw, height: vh }, hasTouch: vw < 900, isMobile: vw < 900 });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('pageerror: ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 4).join('\n')));
  p.on('console', m => { if (m.type() === 'error' && !/ERR_CERT|fonts\.g|Failed to load resource/.test(m.text())) errs.push('console: ' + m.text()); });
  p.on('dialog', d => d.accept());
  await p.goto('file://' + html);
  await p.waitForTimeout(1200);
  const snap = async name => { await p.screenshot({ path: path.join(out, name + '.png') }); console.log('saved', path.join(out, name + '.png')); };
  if (screen === 'title') { for (let i = 0; i < frames; i++) { await p.waitForTimeout(every); await snap('title-' + i); } }
  else if (screen === 'lobby') {
    await p.evaluate(() => { renderLocalLobby(); showScreen('lobby'); });
    for (let i = 0; i < frames; i++) { await p.waitForTimeout(every); await snap('lobby-' + i); }
  } else {
    await p.evaluate(({ tanks, theme, human }) => {
      const names = ['포돌이', '미사일맨', '레이저킹', '뿌요'];
      launchLocal({ teamMode: false, theme: theme || 'random', players: tanks.slice(0, 4).map((t, i) => ({ id: 'p' + i, name: names[i], tank: t, team: 0, slot: i, cpu: !(human && i === 0) })) });
    }, { tanks, theme: A.theme, human: A.human === '1' });
    await p.waitForTimeout(1500);
    if (A.eval) await p.evaluate(A.eval);
    if (screen === 'result') {
      await p.evaluate(() => { G.players.forEach((q, i) => { if (i) { q.hp = 0; q.alive = false; } }); showResult({ type: 'end', winners: [G.players[0].id] }); });
      for (let i = 0; i < frames; i++) { await p.waitForTimeout(every); await snap('result-' + i); }
    } else {
      let n = 0; const t0 = Date.now();
      while (n < frames && Date.now() - t0 < frames * every * 6 + 20000) {
        await p.waitForTimeout(A.anim === '1' ? 200 : every);
        if (A.ss === '1') await p.evaluate(() => G.players.forEach(q => { if (q.alive) q.ss = 100; }));
        if (A.anim === '1') {
          const busy = await p.evaluate(() => !!G.anim && (G.fx.parts.length > 60 || G.fx.beams.length > 0 || G.fx.planes.length > 0));
          if (!busy) continue;
        }
        await snap('play-' + n++);
        if (A.anim === '1') await p.waitForTimeout(400);
      }
    }
  }
  console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') : 'NO PAGE ERRORS');
  await b.close();
  process.exit(errs.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
