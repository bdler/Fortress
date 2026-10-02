/**
 * "어린이 봇" 종단 테스트: 조준 도우미를 아이가 쓰는 방법 그대로 (G 자동 조준 / 방향키 → Space 꾹 → 초록 구간에서 떼기) 만 써서 플레이한다.
 *
 *   1) 비기너 로컬 매치 (타이틀 '🐣 비기너로 시작' → 게임 시작, 사람 1 + CPU 2, 랜덤 맵): 사람 턴 TURNS 번
 *      - 명중률(적에게 피해) >= 80 % · 코치 문장이 1 → 2 → 3 단계로 진행 · 코치 카드/버튼 표시 · 페이지 에러 없음 · 매치가 계속 돌아감
 *      - 추천 (각도, 힘) 과 초록 구간 표본을 '이 화면의 실제 simulateShot' 으로 다시 쏴 보고 목표를 맞히는지 (>= 95 %)
 *   2) 일반 규칙 로컬 매치 + 도우미 2단계(H H): 같은 방식으로 NORMAL_TURNS 번 (추천을 받은 발사 기준 >= 80 %, 전체 명중률은 참고)
 *   3) 온라인(목 서버): 일반 방은 Assist.allowed() === false (버튼/코치 숨김, H G T 무반응), 비기너 방은 true + 한 번 쏴 봄
 *   4) 휴대폰 터치(844x390, hasTouch): 코치 문구에 키보드 말투(Space·Esc·키)가 없고 kbd 배지가 안 보임 · 목표 탱크를 골짜기/왼쪽 끝/오른쪽 끝/높은 곳에 옮겨도
 *      카메라가 코치 카드·HUD 위로 끌어올려 가려지지 않음 · '목표 쪽을 봐요' 안내가 버튼 말투 · 각도가 안 맞은 채 힘을 채우다 ✋ 취소 버튼으로 발사 없이 취소
 *
 *   NODE_PATH=$(npm root -g) HTML=/path/built.html node tools/test-kidbot.js
 *   환경변수: TURNS(12) NORMAL_TURNS(10)
 *             REACT_MS(150): 초록 "지금 놓으세요" 신호를 본 뒤 손을 떼기까지의 반응 시간 (Playwright 왕복 ~50ms 가 더해진다.
 *                            어린이는 0.3~0.6초 → REACT_MS=300 / 500 으로 민감도 확인)
 *             AIM(G | arrows): 각도를 G 로 맞출지, 방향키만으로 코치의 ▲▼ 안내를 따라갈지
 *             SIZE(1280x720) SHOTS(/tmp: 스크린샷 폴더) ONLINE=0 (온라인 검사 건너뜀) NORMAL=0 (일반 규칙 검사 건너뜀) TOUCH=0 (휴대폰 터치 검사 건너뜀) ONLY_TOUCH=1 (터치 검사만)
 *             TRACE=1 (빗나간 발사의 힘 막대 프레임별 기록 출력)
 */
const { chromium } = require('playwright');
const path = require('path');
const { createServer } = require('./gas-mock');

const HTML = process.env.HTML ? path.resolve(process.env.HTML) : path.resolve(__dirname, '../dist/fortress.html');
const TURNS = +(process.env.TURNS || 12);
const NORMAL_TURNS = +(process.env.NORMAL_TURNS || 10);
const REACT_MS = +(process.env.REACT_MS || 150);
const [VW, VH] = (process.env.SIZE || '1280x720').split('x').map(Number);
const OUT = process.env.SHOTS || '/tmp';
const MIN_RATE = 0.8;
const TRACE = process.env.TRACE === '1';
const AIM = process.env.AIM || 'G';   // 'G' = 자동 조준 키 / 'arrows' = 방향키만 (코치의 ▲▼ 안내를 따라감)

const errors = [];
let failed = 0;
const check = (c, msg) => { if (!c) { failed++; console.log('CHECK FAILED:', msg); } else console.log('ok:', msg); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function watch(page, tag) {
  page.on('pageerror', e => errors.push(`[${tag}] pageerror: ${e.message}\n${(e.stack || '').split('\n').slice(0, 4).join('\n')}`));
  page.on('console', m => { if (m.type() === 'error' && !/ERR_CERT|fonts\.g|Failed to load resource/.test(m.text())) errors.push(`[${tag}] console: ${m.text()}`); });
  page.on('dialog', d => d.accept());
}

/** 코치 문장 기록기: 매 프레임(rAF) (단계, 문장) 을 턴별로 쌓는다 */
const RECORDER = () => {
  if (window.__kb) return;
  window.__kb = { turn: -1, seq: [], texts: [] };
  const rec = () => {
    try {
      if (typeof Assist !== 'undefined' && G.ctl && !G.ctl.ai && Assist.state.active && G.turn) {
        const m = Assist.state.msg, K = window.__kb;
        if (K.turn !== G.turn.no) { K.turn = G.turn.no; K.seq = []; K.texts = []; }
        if (K.seq[K.seq.length - 1] !== m.step) K.seq.push(m.step);
        if (K.texts[K.texts.length - 1] !== m.text) K.texts.push(m.text);
      }
    } catch (e) { /* 무시 */ }
    requestAnimationFrame(rec);
  };
  requestAnimationFrame(rec);
};

/** TRACE=1: 충전 중 프레임마다 (시간, 힘, 구간, 느려짐) 기록 → 빗나간 발사의 원인 분석용 */
const TRACER = () => {
  if (window.__pw) return;
  window.__pw = [];
  const f = () => {
    try {
      const c = G.ctl;
      if (c && !c.ai && c.charging) { const s = Assist.state; window.__pw.push([Math.round(performance.now()), +c.power.toFixed(2), s.zone ? +s.zone.pLo.toFixed(1) : null, s.zone ? +s.zone.pHi.toFixed(1) : null, s.slow ? 1 : 0, s.inPower ? 1 : 0, Math.round(findPlayer(c.pid).angle)]); }
    } catch (e) { /* 무시 */ }
    requestAnimationFrame(f);
  };
  requestAnimationFrame(f);
};

const readState = page => page.evaluate(() => {
  const s = Assist.state, c = G.ctl, p = c && findPlayer(c.pid);
  const t = s.target != null ? findPlayer(s.target) : null;
  return {
    level: Assist.level, active: s.active, allowed: Assist.allowed(), hasRec: !!s.rec, ok: !!(s.rec && s.rec.ok), reason: s.rec && s.rec.reason,
    recAngle: s.rec && s.rec.angle, recPower: s.rec && s.rec.power, zone: s.zone ? [s.zone.pLo, s.zone.pHi] : null,
    inAngle: s.inAngle, inPower: s.inPower, step: s.msg.step, icon: s.msg.icon, text: s.msg.text,
    angle: p && Math.round(p.angle), facing: p && p.facing, x: p && p.x, tx: t && t.x, fuel: c && c.fuel
  };
});

/** 사람 턴이 준비될 때까지 (또는 판이 끝날 때까지) 기다린다. 'turn' | 'result' | 'dead' | 'timeout' */
async function waitHumanTurn(page, wantLevel2) {
  const t0 = Date.now();
  while (Date.now() - t0 < 150000) {
    const st = await page.evaluate(() => {
      if (G.screen === 'result') return 'result';
      if (G.screen !== 'play') return 'wait';
      const me = G.players.find(p => !p.cpu);
      if (me && !me.alive) return 'dead';
      const c = G.ctl;
      if (!(c && !c.ai && !c.done && !G.busy && c.delayT <= 0)) return 'wait';
      if (Assist.level < 2) return 'level';                 // 일반 매치는 H 를 눌러 2단계로 (판이 새로 시작되면 도우미는 다시 꺼져 있다)
      return Assist.state.active && Assist.state.rec && Assist.state.msg.text ? 'turn' : 'wait';
    });
    if (st === 'level') { if (wantLevel2) await page.keyboard.press('h'); else await sleep(300); await sleep(150); continue; }
    if (st === 'turn' || st === 'result' || st === 'dead') return st;
    await sleep(120);
  }
  return 'timeout';
}

/** 사람 한 턴을 아이처럼 플레이. 결과 요약을 돌려준다. */
async function kidTurn(page, opts) {
  opts = opts || {};
  const before = await page.evaluate(() => {
    const me = G.players.find(p => !p.cpu);
    return { id: me.id, hits: me.stats.hits, dealt: me.stats.dealt, shots: me.stats.shots, turn: G.turn.no, weapon: G.ctl.weapon,
      hp: G.players.filter(p => p !== me).map(p => p.hp), beginner: G.beginner, level: Assist.level, coachVisible: (() => {
        const e = document.querySelector('#coach'); if (!e) return false; const cs = getComputedStyle(e); return cs.display !== 'none' && cs.visibility !== 'hidden' && e.getBoundingClientRect().width > 50;
      })(), assistBtn: (() => { const e = document.querySelector('#btn-assist'); if (!e) return false; return getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 10; })() };
  });
  const out = { turn: before.turn, coachVisible: before.coachVisible, assistBtn: before.assistBtn, level: before.level, aim: 'G', moved: 0, note: '' };

  // 1) 각도 맞추기: G (목표를 못 맞히는 자리면 ◀ ▶ 로 가까이 가 본다)
  await sleep(200);
  let s = await readState(page);
  for (let tries = 0; tries < 6 && s.hasRec && !s.ok; tries++) {
    if (tries === 2) { await page.keyboard.press('t'); await sleep(250); }
    const dir = s.tx != null && s.tx < s.x ? 'ArrowLeft' : 'ArrowRight';
    await page.keyboard.down(dir); await sleep(450); await page.keyboard.up(dir); await sleep(350);
    out.moved++;
    s = await readState(page);
  }
  out.recOk = s.ok; out.reason = s.reason;
  let okAngle = false;
  if (AIM === 'G') {
    await page.keyboard.press('g');
    try { await page.waitForFunction(() => Assist.state.inAngle, null, { timeout: 3500, polling: 50 }); okAngle = true; } catch (e) { /* 방향키로 */ }
  }
  if (!okAngle) {
    // 방향키 폴백: 코치의 ▲ / ▼ / 방향 안내를 따라 조금씩
    out.aim = 'arrows';
    for (let i = 0; i < 60; i++) {
      s = await readState(page);
      if (s.inAngle) { okAngle = true; break; }
      if (!s.ok) break;
      if (s.icon === '👉' || s.icon === '👈') { const k = s.icon === '👉' ? 'ArrowRight' : 'ArrowLeft'; await page.keyboard.down(k); await sleep(60); await page.keyboard.up(k); await sleep(120); continue; }
      const k = s.icon === '▼' ? 'ArrowDown' : 'ArrowUp';
      await page.keyboard.down(k); await sleep(s.icon === '▲' || s.icon === '▼' ? 90 : 60); await page.keyboard.up(k); await sleep(140);
    }
  }
  out.angleOk = okAngle;

  // (검증) 추천값과 초록 구간을 '지금 이 화면의 실제 시뮬레이션'(simulateShot) 으로 다시 쏴 본다 — 도우미의 약속이 진짜인지
  out.verify = await page.evaluate(() => {
    const s = Assist.state, rec = s.rec, c = G.ctl, p = c && findPlayer(c.pid), z = s.zone;
    if (!p || !rec || !rec.ok || !z || !s.inAngle) return null;
    const tgt = s.target;
    const shoot = (angle, power) => {
      const r = simulateShot(G.terrain, G.players, { pid: p.id, weapon: c.weapon, angle, power, x: p.x, y: p.y, facing: p.facing, wind: G.turn.wind, seed: 12345, delayAdd: 0, item: c.item || null });
      const t = r.players.find(q => q.id === tgt);
      return !!(t && t.taken > 0);
    };
    const ang = Math.round(p.angle);
    return { tank: p.tank, weapon: c.weapon, angle: ang, rec: p.facing === rec.facing ? shoot(rec.angle, rec.power) : null,
      zone: [z.pLo, z.pHi], samples: [z.pLo + 0.1, (z.pLo + z.pHi) / 2, z.pHi - 0.1].map(pw => shoot(ang, Math.round(pw * 10) / 10)) };
  });

  // 2) 힘 채우기: Space 꾹 → 초록 구간 신호(inPower)를 보고 REACT_MS 뒤에 뗀다
  let release = 'none';
  s = await readState(page);
  out.rec = { angle: s.recAngle, power: s.recPower, zone: s.zone };
  if (TRACE) await page.evaluate(() => { window.__pw.length = 0; });
  await page.keyboard.down('Space');
  try {
    const h = await page.waitForFunction(() => { const c = G.ctl; if (!c || c.done) return 'gone'; if (Assist.state.inPower) return 'zone'; if (c.power >= 96) return 'over'; return false; }, null, { polling: 'raf', timeout: 12000 });
    release = await h.jsonValue();
  } catch (e) { release = 'timeout'; }
  const rel = await page.evaluate(() => { const c = G.ctl; return c && !c.done ? { power: Math.round(c.power * 10) / 10, inPower: Assist.state.inPower, zone: Assist.state.zone ? [Assist.state.zone.pLo, Assist.state.zone.pHi] : null } : null; });
  if (release === 'zone' && opts.onZone) await opts.onZone();
  if (release === 'zone' && REACT_MS > 0) await sleep(REACT_MS);
  await page.keyboard.up('Space');
  out.release = release; out.relInfo = rel;
  // 코치 문장 기록은 '떼자마자' 챙긴다 (연속으로 사람 턴이 오면 기록기가 다음 턴으로 넘어가 버리므로)
  await sleep(90);
  const fireRec = await page.evaluate(() => ({ seq: window.__kb.seq.slice(), texts: window.__kb.texts.slice(), turn: window.__kb.turn }));

  // 3) 발사 → 결과 기다리기
  // 전적(stats.shots) 은 포격 재생이 끝난 뒤에 반영된다 → 그때까지 기다리면 결과가 확정된 것
  try { await page.waitForFunction(a => G.players.find(p => p.id === a.id).stats.shots > a.shots, { id: before.id, shots: before.shots }, { timeout: 40000, polling: 50 }); } catch (e) { out.note += ' shot-timeout'; }
  const after = await page.evaluate(id => {
    const me = G.players.find(p => p.id === id); const K = window.__kb;
    const shot = G.log.filter(e => e.type === 'shot' && e.pid === id).pop();
    return { hits: me.stats.hits, dealt: me.stats.dealt, shots: me.stats.shots, params: shot && { angle: shot.params.angle, power: shot.params.power, facing: shot.params.facing },
      seq: K.seq.slice(), texts: K.texts.slice(), kturn: K.turn, enemyHp: G.players.filter(p => p.id !== id).map(p => p.hp) };
  }, before.id);
  out.fired = after.shots > before.shots;
  out.hit = after.hits > before.hits && after.dealt > before.dealt;
  if (TRACE && !out.hit) {
    const tr = await page.evaluate(() => window.__pw.filter((_, i) => i % 3 === 0 || true).slice(-40));
    console.log('TRACE (ms, power, pLo, pHi, slow, inPower, angle):\n' + tr.map(r => r.join(',')).join(' | '));
  }
  out.dealt = after.dealt - before.dealt;
  out.params = after.params; out.seq = fireRec.seq; out.texts = fireRec.texts;
  if (fireRec.turn !== before.turn) out.note += ' recorder-turn ' + fireRec.turn + '!=' + before.turn;
  return out;
}

/** coach 단계 기록이 1 → 2 → 3 으로 진행되었는가 */
function progressed(seq) {
  const i2 = seq.indexOf(2), i3 = seq.lastIndexOf(3);
  return i2 >= 0 && i3 > i2;
}

async function playMatches(page, label, turns, wantLevel2, extra) {
  const res = [];
  let matches = 1, ended = 0;
  while (res.length < turns) {
    const st = await waitHumanTurn(page, wantLevel2);
    if (st === 'timeout') { console.log(`[${label}] timeout waiting for a human turn`); break; }
    if (st === 'result' || st === 'dead') {
      ended++; matches++;
      console.log(`[${label}] match ended (${st}) after ${res.length} shots -> next match`);
      if (st === 'result') { try { await page.click('#res-again', { timeout: 5000 }); } catch (e) { await page.evaluate(() => launchLocal(G.lastConfig)); } }
      else await page.evaluate(() => launchLocal(G.lastConfig));
      await page.waitForFunction(() => G.screen === 'play' && G.turn && G.players.length >= 3, null, { timeout: 20000 });
      continue;
    }
    const r = await kidTurn(page, extra);
    res.push(r);
    console.log(`[${label}] #${res.length} turn ${r.turn} aim=${r.aim} recOk=${r.recOk}${r.recOk ? '' : '(' + r.reason + ')'}${r.moved ? ' moved=' + r.moved : ''} release=${r.release} power=${r.relInfo && r.relInfo.power} zone=${JSON.stringify(r.relInfo && r.relInfo.zone)} `
      + `rec=${r.rec.angle}deg/${r.rec.power} shot=${r.params && r.params.angle}deg/${r.params && r.params.power} -> ${r.hit ? 'HIT dmg ' + r.dealt : 'miss'} steps=${r.seq.join('>')}${r.note}` + (r.seq.length < 3 && r.hit ? ' texts=' + r.texts.join('|') : ''));
  }
  return { res, matches, ended };
}

function verifyReport(label, res) {
  const v = res.filter(r => r.verify);
  const rec = v.filter(r => r.verify.rec !== null), recHit = rec.filter(r => r.verify.rec).length;
  const smp = v.reduce((a, r) => a.concat(r.verify.samples), []), smpHit = smp.filter(Boolean).length;
  console.log(`   [${label}] live-sim check of the assistant's promise: recommended (angle,power) hits the target ${recHit}/${rec.length}; zone samples (pLo+0.1, middle, pHi-0.1) hit ${smpHit}/${smp.length}`);
  v.filter(r => r.verify.rec === false || r.verify.samples.some(x => !x)).forEach(r => console.log(`   ! turn ${r.turn}: tank ${r.verify.tank} weapon ${r.verify.weapon} angle ${r.verify.angle} zone ${JSON.stringify(r.verify.zone)} rec ${r.verify.rec} samples ${JSON.stringify(r.verify.samples)}`));
  return { rec: rec.length, recHit, samples: smp.length, smpHit };
}

function summarize(label, res) {
  const shots = res.filter(r => r.fired);
  const hits = shots.filter(r => r.hit).length;
  const prog = shots.filter(r => progressed(r.seq)).length;
  const first1 = shots.filter(r => r.seq[0] === 1).length;
  const rate = shots.length ? hits / shots.length : 0;
  const recOkShots = shots.filter(r => r.recOk);
  const recOkHits = recOkShots.filter(r => r.hit).length;
  console.log(`\n== ${label}: human shots ${shots.length}, hit ${hits} (${(rate * 100).toFixed(0)}%), assist-recommended ${recOkShots.length} -> hit ${recOkHits}, `
    + `coach 1>2>3 progressed ${prog}/${shots.length} (step 1 shown first ${first1}), G-aim ${shots.filter(r => r.aim === 'G').length}, arrows ${shots.filter(r => r.aim === 'arrows').length}, `
    + `released in zone ${shots.filter(r => r.release === 'zone').length}, repositioned ${shots.filter(r => r.moved).length}`);
  return { shots: shots.length, hits, rate, prog, recOkShots: recOkShots.length, recOkHits };
}

/* ---------------- 온라인 (목 서버) ---------------- */
const INIT = `
  window.google = { script: { run: new Proxy({}, { get(_, fn) {
    const mk = (ok, fail) => new Proxy({}, { get(_, name) {
      if (name === 'withSuccessHandler') return f => mk(f, fail);
      if (name === 'withFailureHandler') return f => mk(ok, f);
      return (...args) => { window.__gas(name, JSON.stringify(args)).then(r => { const o = JSON.parse(r); if (o.err) fail && fail(new Error(o.err)); else ok && ok(o.res); }); };
    }});
    return mk(null, null)[fn];
  }})}};`;

async function onlineRoom(browser, server, beginner) {
  const tag = beginner ? 'online-beginner' : 'online-normal';
  const ctx = await browser.newContext({ viewport: { width: VW, height: VH } });
  await ctx.exposeFunction('__gas', async (fn, argsJson) => {
    await sleep(60 + Math.random() * 120);
    try { return JSON.stringify({ res: server.call(fn, JSON.parse(argsJson)) }); } catch (e) { return JSON.stringify({ err: e.message }); }
  });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  watch(page, tag);
  await page.goto('file://' + HTML);
  await page.waitForTimeout(800);
  await page.click('#btn-online');
  await page.fill('#on-name', '어린이');
  await page.click('#on-create');
  await page.waitForFunction(() => /^[A-Z]{4}$/.test(document.querySelector('#room-code').textContent));
  await page.waitForSelector('#on-slots [data-act=cpu]');
  await page.click('#on-slots [data-act=cpu]');
  await page.waitForFunction(() => document.querySelectorAll('#on-slots .slot:not(.empty)').length === 2, null, { timeout: 15000 });
  if (beginner) {
    await page.evaluate(() => document.querySelector('#on-beginner').click());
    await page.waitForFunction(() => G.backend && G.backend.room && G.backend.room.beginner === true, null, { timeout: 15000 });
  }
  await page.click('#on-start');
  await page.waitForSelector('#hud:not(.hidden)', { timeout: 20000 });
  await page.waitForFunction(() => G.screen === 'play' && G.turn, null, { timeout: 20000 });
  await page.evaluate(RECORDER);
  const info = await page.evaluate(() => ({ beginner: G.beginner, allowed: Assist.allowed(), local: !!G.backend.local, level: Assist.level }));
  console.log(`[${tag}]`, JSON.stringify(info));
  check(info.beginner === beginner, `${tag}: G.beginner === ${beginner}`);
  check(info.allowed === beginner, `${tag}: Assist.allowed() === ${beginner}`);
  // 첫 사람 턴: 버튼/코치 보임 여부
  const t0 = Date.now(); let seen = null;
  while (Date.now() - t0 < 90000) {
    const st = await page.evaluate(() => {
      if (G.screen === 'result') return { over: true };
      const c = G.ctl; if (!(c && !c.ai && !c.done && !G.busy && c.delayT <= 0)) return null;
      const vis = sel => { const e = document.querySelector(sel); if (!e) return false; const cs = getComputedStyle(e); return cs.display !== 'none' && cs.visibility !== 'hidden' && e.getBoundingClientRect().width > 10; };
      return { active: Assist.state.active, level: Assist.level, coach: vis('#coach'), btn: vis('#btn-assist'), text: Assist.state.msg.text };
    });
    if (st && st.over) break;
    if (st) { await sleep(500); seen = await page.evaluate(() => { const vis = sel => { const e = document.querySelector(sel); if (!e) return false; const cs = getComputedStyle(e); return cs.display !== 'none' && cs.visibility !== 'hidden' && e.getBoundingClientRect().width > 10; }; return { active: Assist.state.active, level: Assist.level, coach: vis('#coach'), btn: vis('#btn-assist'), text: Assist.state.msg.text }; }); break; }
    await sleep(300);
  }
  console.log(`[${tag}] first human turn:`, JSON.stringify(seen));
  check(!!seen, `${tag}: reached a human turn`);
  let shotRes = null;
  if (seen) {
    if (beginner) {
      check(seen.active && seen.level === 2 && seen.coach && seen.btn, `${tag}: assist active at level 2, coach + button visible`);
      const pr = await kidTurn(page, {});
      shotRes = pr;
      console.log(`[${tag}] kid shot: ${pr.hit ? 'HIT dmg ' + pr.dealt : 'miss'} aim=${pr.aim} steps=${pr.seq.join('>')}`);
      check(pr.fired, `${tag}: kid shot fired`);
    } else {
      check(!seen.active && seen.level === 0 && !seen.coach && !seen.btn, `${tag}: assist inactive, coach + button hidden`);
      await page.keyboard.press('h'); await page.keyboard.press('g'); await page.keyboard.press('t'); await sleep(400);
      const after = await page.evaluate(() => ({ level: Assist.level, active: Assist.state.active, path: !!Assist.state.path, rec: !!Assist.state.rec }));
      check(after.level === 0 && !after.active && !after.path && !after.rec, `${tag}: H/G/T do nothing in a normal online room ` + JSON.stringify(after));
      // 방장 화면에 도우미 관련 오버레이가 없다 (조준 미리보기 궤적 없음)
    }
  }
  await page.screenshot({ path: path.join(OUT, `kid-${tag}.png`) });
  await page.evaluate(() => { try { G.backend.leave(); } catch (e) { /* 무시 */ } });
  await ctx.close();
  return { info, seen, shotRes };
}


/* ---------------- 4) 휴대폰 터치 (844x390) ---------------- */
/** 이 화면에서 (코치 카드 · HUD) 에 가려지거나 화면 밖인 목표 탱크 점들 + 코치 문구/배지 정보 */
const TOUCH_PROBE = () => {
  const box = sel => { const e = document.querySelector(sel); if (!e) return null; const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') return null; const b = e.getBoundingClientRect(); return b.width > 4 && b.height > 4 ? [b.left, b.top, b.right, b.bottom] : null; };
  const boxes = ['#coach', '#hud'].map(box).filter(Boolean);
  const inside = q => boxes.some(b => q.x >= b[0] && q.x <= b[2] && q.y >= b[1] && q.y <= b[3]) || q.x < 0 || q.x > innerWidth || q.y < 0 || q.y > innerHeight;
  const s = Assist.state, tp = s.target != null ? findPlayer(s.target) : null, me = findPlayer(G.ctl.pid);
  const pts = q => [w2s(q.x, q.y - 14), w2s(q.x, q.y + 8), w2s(q.x, q.y - 40 * TANK_SCALE)];   // 몸통 가운데 · 바닥 · 꼭대기
  const co = document.querySelector('#coach');
  const pads = ['#touch .tpad.left', '#touch .tpad.right'].map(box).filter(Boolean);
  const cb = box('#coach');
  return {
    targetHidden: tp ? pts(tp).some(inside) : null, meHidden: pts(me).some(inside),
    coachText: co ? co.innerText : '', kbdShown: [...document.querySelectorAll('#coach kbd')].filter(k => getComputedStyle(k).display !== 'none').length,
    padOverlap: cb ? pads.some(b => cb[0] < b[2] && cb[2] > b[0] && cb[1] < b[3] && cb[3] > b[1]) : false,
    touchClass: document.body.classList.contains('touch'), msg: s.msg && (s.msg.text + ' / ' + s.msg.sub), zoom: +Cam.zoom.toFixed(2)
  };
};
const TOUCH_PLACE = place => {
  if (!G.ctl) return false;
  const me = findPlayer(G.ctl.pid), en = G.players.filter(o => o.id !== me.id && o.alive);
  const sy = xx => surfaceY(G.terrain.mask, xx);
  const cand = []; for (let xx = 90; xx <= 1510; xx += 10) if (Math.abs(xx - me.x) > 200 && Math.abs(xx - me.x) < 900) cand.push(xx);
  if (!cand.length) return false;
  let x;
  if (place === 'valley') x = cand.reduce((a, c) => sy(c) > sy(a) ? c : a, cand[0]);
  else if (place === 'high') x = cand.reduce((a, c) => sy(c) < sy(a) ? c : a, cand[0]);
  else if (place === 'left') x = Math.max(90, Math.min(...cand));
  else x = Math.min(1510, Math.max(...cand));
  const tp = en[0]; tp.x = x; tp.y = sy(x); tp.vy = 0;
  en.slice(1).forEach((o, i) => { o.x = me.x < 800 ? 1500 - i * 60 : 100 + i * 60; o.y = sy(o.x); });
  Assist._onTurn(me, G.ctl);
  return true;
};

async function touchPhone(browser) {
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  watch(page, 'touch');
  await page.goto('file://' + HTML);
  await page.waitForTimeout(1200);
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) { /* 무시 */ } });
  await page.evaluate(RECORDER);
  const cfg = theme => ({ teamMode: false, theme, beginner: true, players: [
    { id: 'p0', name: '나', tank: 'cannon', team: 0, slot: 0, cpu: false },
    { id: 'p1', name: 'CPU 1', tank: 'missile', team: 0, slot: 1, cpu: true },
    { id: 'p2', name: 'CPU 2', tank: 'laser', team: 0, slot: 2, cpu: true }] });
  const KEYWORDS = /Space|Esc|키를|키\)|키로|\bkey\b/;
  let measured = 0; const hidden = [], padHits = [];
  let textChecked = false;
  for (const theme of ['grass', 'night', 'desert', 'volcano']) {
    await page.evaluate(c => { window.__prevStart = G.startEv; G.lastConfig = c; launchLocal(c); }, cfg(theme));
    await page.waitForFunction(() => G.startEv !== window.__prevStart && G.screen === 'play' && G.turn && G.players.length === 3, null, { timeout: 20000 });
    const st = await waitHumanTurn(page, false);
    if (st !== 'turn') { console.log(`[touch ${theme}] no human turn (${st})`); continue; }
    await sleep(1200);
    if (!textChecked) {
      textChecked = true;
      const a = await page.evaluate(TOUCH_PROBE);
      console.log('[touch] first turn coach:', JSON.stringify(a.coachText.replace(/\n/g, ' | ')));
      check(a.touchClass, 'touch: body.touch is set on a touch device');
      check(!KEYWORDS.test(a.coachText) && a.kbdShown === 0, `touch: coach card has no keyboard words (Space/Esc/키) and no visible kbd badge (kbd shown ${a.kbdShown})`);
      // 목표 반대쪽을 보게 하면 '버튼' 말투
      await page.evaluate(() => { const me = findPlayer(G.ctl.pid); me.facing = -Assist.state.rec.facing; });
      await sleep(500);
      const away = await page.evaluate(TOUCH_PROBE);
      console.log('[touch] facing away:', JSON.stringify(away.msg));
      check(/목표 쪽을 봐요/.test(away.msg) && /버튼/.test(away.msg) && !KEYWORDS.test(away.msg + away.coachText), 'touch: facing-away hint speaks in buttons, not keys');
      await page.evaluate(() => { const me = findPlayer(G.ctl.pid); me.facing = Assist.state.rec.facing; });
      await sleep(400);
      // 각도가 안 맞은 채 힘 채우기 → 안내 + ✋ 취소 버튼 (발사하지 않고 처음부터)
      await page.evaluate(() => { findPlayer(G.ctl.pid).angle = 8; });
      await sleep(400);
      await page.evaluate(() => { Input.fire = true; });
      await sleep(600);
      const ch = await page.evaluate(() => ({ charging: !!(G.ctl && G.ctl.charging), power: G.ctl && G.ctl.power, msg: Assist.state.msg.text + ' / ' + Assist.state.msg.sub, cancelBtn: (() => { const e = document.querySelector('.tcancel'); if (!e) return false; const b = e.getBoundingClientRect(); return getComputedStyle(e).display !== 'none' && b.width > 30; })() }));
      console.log('[touch] charging with a wrong angle:', JSON.stringify(ch));
      check(ch.charging && /각도부터/.test(ch.msg) && ch.cancelBtn, 'touch: charging with the wrong angle shows the "angle first" hint and a visible ✋ cancel button');
      try { await page.tap('.tcancel', { timeout: 2000 }); } catch (e) { console.log('tap failed', e.message.split('\n')[0]); }
      await sleep(300);
      const after = await page.evaluate(() => ({ charging: !!(G.ctl && G.ctl.charging), alive: !!(G.ctl && !G.ctl.done), power: G.ctl ? G.ctl.power : null }));
      await page.evaluate(() => { Input.fire = false; });
      await sleep(300);
      const after2 = await page.evaluate(() => ({ alive: !!(G.ctl && !G.ctl.done) }));
      check(!after.charging && after.alive && after2.alive, 'touch: ✋ cancel stops the charge without firing (turn still ours after releasing) ' + JSON.stringify([after, after2]));
      await page.evaluate(() => { if (G.ctl) Assist._onTurn(findPlayer(G.ctl.pid), G.ctl); });
      await sleep(500);
      // 🎯 버튼으로 도우미를 꺼도 (실수) 코치 자리에 '켜기' 버튼이 남아서 되살릴 수 있다
      await page.evaluate(() => Assist.cycle());      // 2 -> 0
      await sleep(700);
      const off = await page.evaluate(() => { const b = document.querySelector('#co-on'), c = document.querySelector('#coach'); const vis = e => !!e && getComputedStyle(e).display !== 'none' && !e.hidden && e.getBoundingClientRect().width > 20; return { lvl: Assist.level, onBtn: vis(b), coach: vis(c) && !c.classList.contains('hidden'), text: c.innerText.replace(/\n/g, ' | ') }; });
      console.log('[touch] assist switched off:', JSON.stringify(off));
      check(off.lvl === 0 && off.coach && off.onBtn && /꺼졌어요/.test(off.text) && !KEYWORDS.test(off.text), 'touch: after switching the assistant off a "켜기" chip stays on the card and speaks in buttons');
      try { await page.tap('#co-on', { timeout: 2000 }); } catch (e) { console.log('tap #co-on failed', e.message.split('\n')[0]); }
      await sleep(500);
      check((await page.evaluate(() => Assist.level)) === 2, 'touch: tapping 켜기 turns the assistant back on (level 2)');
    }
    for (const place of ['valley', 'left', 'right', 'high']) {
      const ok = await page.evaluate(TOUCH_PLACE, place);
      if (!ok) continue;
      await sleep(1900);
      const r = await page.evaluate(TOUCH_PROBE);
      measured++;
      if (r.targetHidden || r.meHidden) { hidden.push(`${theme}/${place}`); await page.screenshot({ path: path.join(OUT, `touch-hidden-${theme}-${place}.png`) }); }
      if (r.padOverlap) padHits.push(`${theme}/${place}`);
    }
    // 이 판은 여기서 끝 (다음 테마로)
  }
  check(measured >= 12, `touch: measured ${measured} target placements (>= 12)`);
  check(hidden.length === 0, `touch: my tank and the target tank stay visible above the coach card / HUD in ${measured} hard placements (hidden: ${hidden.join(', ') || 'none'})`);
  check(padHits.length === 0, `touch: the coach card never covers the on-screen arrow/fire pads (overlaps: ${padHits.join(', ') || 'none'})`);
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch();
  if (process.env.ONLY_TOUCH === '1') {      // 휴대폰 터치 검사만 빠르게
    await touchPhone(browser);
    console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'NO PAGE ERRORS');
    await browser.close();
    process.exit(failed || errors.length ? 1 : 0);
  }
  const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, hasTouch: false });
  const page = await ctx.newPage();
  watch(page, 'local');
  await page.goto('file://' + HTML);
  await page.waitForTimeout(1500);
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) { /* 무시 */ } });
  await page.evaluate(RECORDER);
  if (TRACE) await page.evaluate(TRACER);

  /* ---- 1) 비기너 로컬: 타이틀의 [🐣 비기너로 시작] → 로비 → 게임 시작 ---- */
  await page.click('#btn-beginner');
  await page.waitForSelector('#scr-lobby.show');
  const lob = await page.evaluate(() => ({ checked: document.querySelector('#local-beginner').checked, slots: LocalLobby.slots.map(s => s.kind).join(','), theme: LocalLobby.theme }));
  console.log('lobby:', JSON.stringify(lob));
  check(lob.checked && lob.slots === 'human,cpu,cpu,none' && lob.theme === 'random', 'beginner quick start: toggle on, 1 human + 2 CPU, random theme');
  await page.click('#local-start');
  await page.waitForFunction(() => G.screen === 'play' && G.beginner && G.players.length === 3 && G.turn, null, { timeout: 20000 });
  const rules = await page.evaluate(() => ({ beginner: G.beginner, hitR: RULES.hitR, blast: RULES.blastMul, allowed: Assist.allowed(), local: !!G.backend.local }));
  check(rules.beginner && rules.hitR === 26 && rules.allowed && rules.local, 'beginner match started with beginner rules and assist allowed ' + JSON.stringify(rules));
  const turnsAtStart = await page.evaluate(() => G.log.filter(e => e.type === 'turn').length);
  const B = await playMatches(page, 'beginner', TURNS, false);
  const sb = summarize('BEGINNER local (assist default level 2)', B.res);
  const vb = verifyReport('beginner', B.res);
  check(vb.rec === 0 || vb.recHit / vb.rec >= 0.95, `beginner: the recommended shot hits the target in the live simulation ${vb.recHit}/${vb.rec} (>= 95%)`);
  const vis = B.res.filter(r => r.coachVisible && r.assistBtn && r.level === 2).length;
  check(sb.shots >= TURNS, `beginner: played ${sb.shots} human shots (>= ${TURNS})`);
  check(sb.rate >= MIN_RATE, `beginner: ${(sb.rate * 100).toFixed(0)}% of the human's shots hurt an enemy (>= ${MIN_RATE * 100}%)`);
  check(sb.prog >= Math.ceil(sb.shots * 0.9), `beginner: coach messages progressed step 1>2>3 in ${sb.prog}/${sb.shots} turns`);
  check(vis === B.res.length, `beginner: coach card + assist button visible at level 2 on every human turn (${vis}/${B.res.length})`);
  const cont = await page.evaluate(() => ({ screen: G.screen, turns: G.log.filter(e => e.type === 'turn').length, cpuShots: G.log.filter(e => e.type === 'shot' && G.players.find(p => p.id === e.pid) && G.players.find(p => p.id === e.pid).cpu).length }));
  console.log('match progress:', JSON.stringify(cont), 'turns at start', turnsAtStart);
  check(cont.turns > turnsAtStart || B.matches > 1, 'beginner: the match keeps running (turn events keep coming)');
  check(B.res.some(r => r.seq.length) && B.res.every(r => r.texts.length > 0), 'beginner: coach texts recorded every turn');
  const sample = B.res.find(r => r.texts.length > 2);
  if (sample) console.log('sample coach texts:', sample.texts.join(' | '));

  /* ---- 2) 일반 규칙 로컬 + 도우미 2단계 ---- */
  let sn = null;
  if (process.env.NORMAL !== '0') {
    await page.evaluate(() => goTitle());
    await page.waitForSelector('#scr-title.show');
    await page.click('#btn-local');
    await page.waitForSelector('#scr-lobby.show');
    await page.uncheck('#local-beginner');
    await page.evaluate(() => { const S = LocalLobby.slots; S[0].kind = 'human'; S[1].kind = 'cpu'; S[2].kind = 'cpu'; S[3].kind = 'none'; renderLocalLobby(); });
    const nl = await page.evaluate(() => ({ checked: document.querySelector('#local-beginner').checked, ls: localStorage.getItem('fortress_beginner') }));
    check(!nl.checked, 'normal lobby: beginner toggle off ' + JSON.stringify(nl));
    await page.click('#local-start');
    await page.waitForFunction(() => G.screen === 'play' && !G.beginner && G.players.length === 3 && G.turn, null, { timeout: 20000 });
    const nr = await page.evaluate(() => ({ hitR: RULES.hitR, allowed: Assist.allowed(), level: Assist.level, turn: RULES.turnTime }));
    check(nr.hitR === 21 && nr.turn === 25 && nr.allowed && nr.level === 0, 'normal local match: normal rules, assist allowed (practice) but off by default ' + JSON.stringify(nr));
    await page.keyboard.press('h'); await page.keyboard.press('h');
    const lv = await page.evaluate(() => Assist.level);
    check(lv === 2, 'normal local: H H -> assist level 2');
    const N = await playMatches(page, 'normal', NORMAL_TURNS, true);
    sn = summarize('NORMAL local + assist level 2 (H H)', N.res);
    const vn = verifyReport('normal', N.res);
    check(vn.rec === 0 || vn.recHit / vn.rec >= 0.95, `normal: the recommended shot hits the target in the live simulation ${vn.recHit}/${vn.rec} (>= 95%)`);
    check(sn.shots >= NORMAL_TURNS, `normal: played ${sn.shots} human shots`);
    // 일반 규칙은 CPU 가 강해서 사람이 걸어야 하는(도우미가 '가까이 가요' 라고 하는) 턴이 섞인다 → 추천을 받은 발사 기준으로 80%
    check(sn.recOkShots > 0 && sn.recOkHits / sn.recOkShots >= MIN_RATE, `normal + assist: ${sn.recOkHits}/${sn.recOkShots} of the shots that followed a recommendation hit (>= ${MIN_RATE * 100}%); all shots ${(sn.rate * 100).toFixed(0)}% (informational)`);
  }

  console.log(errors.length ? 'LOCAL ERRORS:\n' + errors.join('\n') : 'local: no page errors');

  /* ---- 3) 온라인 목 서버: 일반 방 = 금지, 비기너 방 = 허용 ---- */
  if (process.env.ONLINE !== '0') {
    const server = createServer();
    await onlineRoom(browser, server, false);
    await onlineRoom(browser, server, true);
  }

  /* ---- 4) 휴대폰 터치 ---- */
  if (process.env.TOUCH !== '0') await touchPhone(browser);

  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'NO PAGE ERRORS');
  console.log(JSON.stringify({ beginner: sb, normal: sn, reactMs: REACT_MS, failed, errors: errors.length }));
  await browser.close();
  process.exit(failed || errors.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
