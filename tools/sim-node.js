// Core + Sim (+ Assist 풀이기) 스크립트를 Node 에서 로드 (헤드리스 물리/조준 도우미 테스트용)
//
//  loadSim()            → vm 컨텍스트 (Core, Sim, Assist 의 최상위 함수/변수가 전역으로 보임, AssistSolver 포함)
//  SRC_DIR=/다른/src    → 다른 작업 트리의 src 로 로드 (병합 전 교차 검증용)
//
//  RULES 호환: 병합 전(Core/Sim 에 RULES 가 아직 없을 때)에도 테스트가 돌도록, 없으면 같은 의미의
//  RULES/setRules 와 Sim 패치를 즉석에서 넣는다. 병합 후(코드에 RULES 가 있으면)에는 아무것도 패치하지 않는다.
const fs = require('fs'), path = require('path'), vm = require('vm');

const RULES_SHIM = `
var RULES_NORMAL = Object.freeze({ beginner: false, hitR: 21, blastMul: 1, dmgMul: 1, fallDmg: true, noSelfHit: false, ssMul: 1, turnTime: 25, chargeSpeed: 52, windMax: 10, aiErr: 1, healMul: 1 });
var RULES_BEGINNER = Object.freeze({ beginner: true, hitR: 26, blastMul: 1.3, dmgMul: 1, fallDmg: false, noSelfHit: true, ssMul: 1.5, turnTime: 40, chargeSpeed: 30, windMax: 2, aiErr: 4, healMul: 2 });
var RULES = Object.assign({}, RULES_NORMAL);
function setRules(beginner) { return Object.assign(RULES, beginner === true ? RULES_BEGINNER : RULES_NORMAL); }
`;

/** Sim.html 에 RULES 가 아직 없을 때만: RULES 담당 구현과 같은 의미로 패치 (테스트 전용) */
function shimSim(src) {
  if (/RULES\./.test(src)) return src;
  return src
    .replace('const m = world.terrain.mask, w = e.w, x = e.x;', 'const m = world.terrain.mask, w = e.w, x = e.x, sr = w.sr * RULES.blastMul;')
    .replace('world.terrain.crater(x, y, w.sr);', 'world.terrain.crater(x, y, sr);')
    .replace('Math.abs(p.x - x) < w.sr + 14', 'Math.abs(p.x - x) < sr + 14')
    .replace('if (!p.alive || (p.id === pr.owner && pr.age < 0.35)) continue;', 'if (!p.alive || (p.id === pr.owner && (pr.age < 0.35 || RULES.noSelfHit))) continue;')
    .replace('< TANK_HIT_R) { explode(', '< RULES.hitR) { explode(')
    .replace('else world.terrain.crater(x, y, w.r);', 'else world.terrain.crater(x, y, w.r * RULES.blastMul);')
    .replace('w.mound ? w.mound * 0.7 : w.r, w.fx', 'w.mound ? w.mound * 0.7 : w.r * RULES.blastMul, w.fx')
    .replace('damageArea(world, x, y, w.r, w.dmg', 'damageArea(world, x, y, w.r * RULES.blastMul, w.dmg')
    .replace('const reach = r + TANK_HIT_R,', 'const reach = r + RULES.hitR,')
    .replace('if (!p.alive || amt <= 0) return;', 'if (!p.alive || amt <= 0) return;\n  if (RULES.noSelfHit && owner != null && p.id === owner) return;');
}

function loadSim(opts) {
  opts = opts || {};
  const dir = opts.srcDir || process.env.SRC_DIR || path.join(__dirname, '..', 'src');
  const ctx = { console, Math, Date, performance: { now: () => Date.now() }, window: {}, document: { querySelector() {}, querySelectorAll() { return []; } } };
  vm.createContext(ctx);
  const strip = (f, extra) => {
    let src = fs.readFileSync(path.join(dir, f + '.html'), 'utf8').replace(/<\/?script>/g, '')
      .replace(/^const (\w+)/gm, 'var $1').replace(/^let (\w+)/gm, 'var $1').replace(/^class (\w+)/gm, 'var $1 = class $1').replace(/^'use strict';/m, '');
    return extra ? extra(src) : src;
  };
  for (const f of ['Core', 'Sim', 'Assist']) {
    if (f === 'Assist' && !fs.existsSync(path.join(dir, 'Assist.html'))) continue;
    if (f === 'Sim' && typeof ctx.RULES === 'undefined') vm.runInContext(RULES_SHIM, ctx);
    vm.runInContext(strip(f, f === 'Sim' ? shimSim : null), ctx, { filename: f + '.html' });
  }
  return ctx;
}
module.exports = { loadSim };
