// Core + Sim 스크립트를 Node 에서 로드 (헤드리스 물리 테스트용)
const fs = require('fs'), path = require('path'), vm = require('vm');
function loadSim() {
  const ctx = { console, Math, Date, performance: { now: () => Date.now() }, window: {}, document: { querySelector() {}, querySelectorAll() { return []; } } };
  vm.createContext(ctx);
  for (const f of ['Core', 'Sim']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', f + '.html'), 'utf8').replace(/<\/?script>/g, '')
      .replace(/^const (\w+)/gm, 'var $1').replace(/^class (\w+)/gm, 'var $1 = class $1').replace(/^'use strict';/m, '');
    vm.runInContext(src, ctx);
  }
  return ctx;
}
module.exports = { loadSim };
