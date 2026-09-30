/**
 * Code.gs 를 Node vm 에서 실행하기 위한 Apps Script 목(mock).
 * CacheService / LockService / Utilities 만 흉내낸다.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

function createServer() {
  const store = new Map();
  const cache = {
    get: k => (store.has(k) ? store.get(k) : null),
    put: (k, v) => { if (String(v).length > 100 * 1024) throw new Error('cache value too large: ' + k); store.set(k, String(v)); },
    getAll: keys => { const o = {}; keys.forEach(k => { if (store.has(k)) o[k] = store.get(k); }); return o; },
    remove: k => store.delete(k)
  };
  const ctx = {
    CacheService: { getScriptCache: () => cache },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: { getUuid: () => crypto.randomUUID() },
    HtmlService: {}, console, Date, Math, JSON
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'Code.gs'), 'utf8'), ctx);
  return {
    store, ctx,
    // 가짜 시계 (턴 시간 초과 같은 시간 의존 규칙 테스트용). setClock(() => ms) / setClock(null) 로 복원
    setClock(fn) { ctx.Date = fn ? Object.assign(function () { }, { now: fn }) : Date; },
    // google.script.run 처럼 인자/결과를 JSON 직렬화해서 호출
    call(fn, args) {
      if (typeof ctx[fn] !== 'function' || fn.endsWith('_')) throw new Error('no such server function: ' + fn);
      const res = ctx[fn](...JSON.parse(JSON.stringify(args)));
      return res === undefined ? null : JSON.parse(JSON.stringify(res));
    }
  };
}
module.exports = { createServer };
