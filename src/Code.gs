/**
 * 포트리스 4인 대전 - Google Apps Script 서버
 *
 * 역할
 *  - 웹앱 HTML 제공 (doGet)
 *  - 방(Room) 생성/참가/로비 관리
 *  - 턴 순서(딜레이), 바람, 승패 판정 등 "규칙"의 최종 권한
 *  - 포격 결과(지형 파괴, 데미지)는 쏜 사람의 클라이언트가 계산해서 보내고,
 *    서버는 이벤트 로그로 모든 참가자에게 중계한다.
 *
 * 저장소: CacheService(스크립트 캐시, 최대 6시간 유지)
 *   R_<code>          방 정보(JSON)
 *   E_<code>_<n>      n번째 이벤트
 *   L_<code>          현재 턴 플레이어의 실시간 위치/각도
 *   S_<code>_<pid>    플레이어 마지막 접속 시각
 */

var CACHE_TTL = 21600;      // 6시간(캐시 최대치)
var TURN_MS = 25000;        // 한 턴 제한 시간
var TURN_GRACE_MS = 22000;  // 포격 애니메이션 + 통신 지연 여유
var AWAY_MS = 15000;        // 이 시간 이상 응답 없으면 자리 비움으로 보고 턴 넘김
var LEAVE_MS = 90000;       // 이 시간 이상 응답 없으면 탈주 처리
var SKIP_DELAY = 500;       // 턴을 넘겼을 때 추가 딜레이
var MAX_PLAYERS = 4;
var TANK_IDS = ['cannon', 'missile', 'laser', 'multi', 'ice', 'air'];
var THEMES = ['grass', 'desert', 'snow', 'night', 'volcano'];

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('포트리스 4인 대전')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/* ---------------- 저장소 헬퍼 ---------------- */

function cache_() { return CacheService.getScriptCache(); }

function getRoom_(code) {
  var raw = cache_().get('R_' + code);
  return raw ? JSON.parse(raw) : null;
}

function putRoom_(room) {
  cache_().put('R_' + room.code, JSON.stringify(room), CACHE_TTL);
}

function pushEvent_(room, ev) {
  ev.i = room.evCount;
  ev.t = Date.now();
  cache_().put('E_' + room.code + '_' + room.evCount, JSON.stringify(ev), CACHE_TTL);
  room.evCount++;
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function uid_(n) {
  var s = Utilities.getUuid().replace(/-/g, '');
  return s.substring(0, n || 10);
}

function newCode_() {
  var abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (var tries = 0; tries < 20; tries++) {
    var c = '';
    for (var i = 0; i < 4; i++) c += abc.charAt(Math.floor(Math.random() * abc.length));
    if (!getRoom_(c)) return c;
  }
  throw new Error('방 코드를 만들 수 없습니다. 잠시 후 다시 시도하세요.');
}

function cleanName_(name) {
  name = String(name || '').replace(/[<>&"']/g, '').trim();
  return (name || '플레이어').substring(0, 10);
}

function findPlayer_(room, pid) {
  for (var i = 0; i < room.players.length; i++) if (room.players[i].id === pid) return room.players[i];
  return null;
}

function auth_(room, pid, token) {
  if (!room) throw new Error('방을 찾을 수 없습니다.');
  var p = findPlayer_(room, pid);
  if (!p || p.token !== token) throw new Error('인증 실패');
  return p;
}

function freeSlot_(room) {
  for (var s = 0; s < MAX_PLAYERS; s++) {
    var used = false;
    for (var i = 0; i < room.players.length; i++) if (room.players[i].slot === s) used = true;
    if (!used) return s;
  }
  return -1;
}

/** 클라이언트에 보낼 때 토큰 제거 */
function publicRoom_(room) {
  return {
    code: room.code, hostId: room.hostId, status: room.status, theme: room.theme,
    teamMode: room.teamMode, evCount: room.evCount, turn: room.turn, winners: room.winners || null,
    players: room.players.map(function (p) {
      return { id: p.id, name: p.name, tank: p.tank, team: p.team, slot: p.slot, cpu: !!p.cpu,
               alive: p.alive, hp: p.hp, left: !!p.left };
    })
  };
}

/* ---------------- 로비 API ---------------- */

function createRoom(name) {
  return withLock_(function () {
    var room = {
      code: newCode_(), hostId: null, status: 'lobby', theme: 'random', teamMode: false,
      players: [], evCount: 0, turn: null, createdAt: Date.now()
    };
    var p = { id: uid_(8), token: uid_(16), name: cleanName_(name), tank: 'cannon', team: 0, slot: 0, cpu: false };
    room.players.push(p);
    room.hostId = p.id;
    putRoom_(room);
    touch_(room.code, p.id);
    return { code: room.code, pid: p.id, token: p.token };
  });
}

function joinRoom(code, name) {
  code = String(code || '').toUpperCase().trim();
  return withLock_(function () {
    var room = getRoom_(code);
    if (!room) throw new Error('방을 찾을 수 없습니다: ' + code);
    if (room.status !== 'lobby') throw new Error('이미 게임이 시작된 방입니다.');
    var slot = freeSlot_(room);
    if (slot < 0) throw new Error('방이 가득 찼습니다 (최대 4명).');
    var p = { id: uid_(8), token: uid_(16), name: cleanName_(name), tank: TANK_IDS[slot % TANK_IDS.length],
              team: 0, slot: slot, cpu: false };
    room.players.push(p);
    putRoom_(room);
    touch_(code, p.id);
    return { code: code, pid: p.id, token: p.token };
  });
}

/** 내 탱크/팀/이름 변경 */
function updateMe(code, pid, token, data) {
  return withLock_(function () {
    var room = getRoom_(code);
    var p = auth_(room, pid, token);
    if (room.status !== 'lobby') return publicRoom_(room);
    applyPlayerData_(p, data);
    putRoom_(room);
    return publicRoom_(room);
  });
}

function applyPlayerData_(p, data) {
  data = data || {};
  if (data.tank && TANK_IDS.indexOf(data.tank) >= 0) p.tank = data.tank;
  if (data.team === 0 || data.team === 1 || data.team === 2) p.team = data.team;
  if (data.name) p.name = cleanName_(data.name);
}

/** 방장 전용: 맵/팀전 설정, CPU 추가·수정·삭제 */
function hostUpdate(code, pid, token, data) {
  return withLock_(function () {
    var room = getRoom_(code);
    auth_(room, pid, token);
    if (room.hostId !== pid) throw new Error('방장만 변경할 수 있습니다.');
    if (room.status !== 'lobby') return publicRoom_(room);
    data = data || {};
    if (data.theme && (data.theme === 'random' || THEMES.indexOf(data.theme) >= 0)) room.theme = data.theme;
    if (typeof data.teamMode === 'boolean') room.teamMode = data.teamMode;
    if (data.addCpu) {
      var slot = freeSlot_(room);
      if (slot >= 0) {
        room.players.push({ id: 'cpu' + uid_(5), token: uid_(16), name: 'CPU ' + (slot + 1),
                            tank: TANK_IDS[Math.floor(Math.random() * TANK_IDS.length)], team: 0, slot: slot, cpu: true });
      }
    }
    if (data.cpuId) {
      var c = findPlayer_(room, data.cpuId);
      if (c && c.cpu) {
        if (data.remove) room.players.splice(room.players.indexOf(c), 1);
        else applyPlayerData_(c, data);
      }
    }
    if (data.kick) {
      var k = findPlayer_(room, data.kick);
      if (k && k.id !== room.hostId) room.players.splice(room.players.indexOf(k), 1);
    }
    putRoom_(room);
    return publicRoom_(room);
  });
}

function leaveRoom(code, pid, token) {
  return withLock_(function () {
    var room = getRoom_(code);
    if (!room) return true;
    var p = auth_(room, pid, token);
    removePlayer_(room, p);
    putRoom_(room);
    return true;
  });
}

function removePlayer_(room, p) {
  if (room.status === 'lobby') {
    room.players.splice(room.players.indexOf(p), 1);
  } else if (!p.left) {
    p.left = true;
    if (room.status === 'playing') {
      p.alive = false;
      pushEvent_(room, { type: 'leave', pid: p.id });
      if (room.turn && room.turn.pid === p.id) {
        if (!checkEnd_(room)) nextTurn_(room);
      } else {
        checkEnd_(room);
      }
    }
  }
  // 방장 위임 (사람 중에서)
  if (room.hostId === p.id) {
    var next = room.players.filter(function (q) { return !q.cpu && !q.left; })[0];
    room.hostId = next ? next.id : null;
  }
}

/* ---------------- 게임 진행 ---------------- */

function startGame(code, pid, token) {
  return withLock_(function () {
    var room = getRoom_(code);
    auth_(room, pid, token);
    if (room.hostId !== pid) throw new Error('방장만 시작할 수 있습니다.');
    if (room.status !== 'lobby') throw new Error('이미 시작되었습니다.');
    if (room.players.length < 2) throw new Error('2명 이상 있어야 시작할 수 있습니다.');
    if (room.teamMode) {
      var teams = {};
      room.players.forEach(function (p) { teams[sideKey_(room, p)] = 1; });
      if (Object.keys(teams).length < 2) throw new Error('팀전은 최소 두 팀이 필요합니다.');
    }
    var seed = Math.floor(Math.random() * 2147483647);
    var theme = room.theme === 'random' ? THEMES[Math.floor(Math.random() * THEMES.length)] : room.theme;
    room.status = 'playing';
    room.seed = seed;
    room.players.sort(function (a, b) { return a.slot - b.slot; });
    room.players.forEach(function (p) {
      p.alive = true;
      p.delay = Math.floor(Math.random() * 60);
      p.lastTurn = -1;
    });
    pushEvent_(room, {
      type: 'start', seed: seed, theme: theme, teamMode: room.teamMode,
      players: room.players.map(function (p) {
        return { id: p.id, name: p.name, tank: p.tank, team: room.teamMode ? p.team : 0, slot: p.slot, cpu: !!p.cpu };
      })
    });
    room.turn = { pid: null, no: 0, startedAt: Date.now() };
    nextTurn_(room);
    putRoom_(room);
    return publicRoom_(room);
  });
}

/** 딜레이가 가장 적은 생존자가 다음 턴 (포트리스식 딜레이 턴제) */
function nextTurn_(room) {
  var alive = room.players.filter(function (p) { return p.alive && !p.left; });
  if (!alive.length) return;
  alive.sort(function (a, b) {
    return (a.delay - b.delay) || (a.lastTurn - b.lastTurn) || (a.slot - b.slot);
  });
  var p = alive[0];
  var wind = Math.round((Math.random() * 2 - 1) * 10);
  var no = (room.turn ? room.turn.no : 0) + 1;
  room.turn = { pid: p.id, no: no, startedAt: Date.now(), wind: wind };
  cache_().remove('L_' + room.code);
  pushEvent_(room, { type: 'turn', pid: p.id, no: no, wind: wind });
}

/** 팀전에서 팀(1=A, 2=B)을 고른 사람은 팀으로, 0(개인)은 혼자 한 편 */
function sideKey_(room, p) {
  return room.teamMode && p.team ? 'T' + p.team : p.id;
}

/** 승패 판정. 끝났으면 true */
function checkEnd_(room) {
  var sides = {};
  room.players.forEach(function (p) {
    if (p.alive && !p.left) sides[sideKey_(room, p)] = 1;
  });
  var keys = Object.keys(sides);
  if (keys.length > 1) return false;
  var winners = room.players.filter(function (p) {
    if (!keys.length) return false;
    return sideKey_(room, p) === keys[0];
  }).map(function (p) { return p.id; });
  room.status = 'ended';
  room.winners = winners;
  pushEvent_(room, { type: 'end', winners: winners });
  return true;
}

/**
 * 행동 제출
 * action = { type:'shot', actor, no, params, result } | { type:'skip', actor, no }
 */
function submit(code, pid, token, action) {
  return withLock_(function () {
    var room = getRoom_(code);
    auth_(room, pid, token);
    touch_(code, pid);
    if (room.status !== 'playing') return { ok: false, reason: 'not-playing' };
    var actor = findPlayer_(room, action.actor);
    if (!actor || !room.turn || room.turn.pid !== actor.id || room.turn.no !== action.no) {
      return { ok: false, reason: 'not-your-turn' };
    }
    if (actor.id !== pid && !(actor.cpu && room.hostId === pid)) return { ok: false, reason: 'forbidden' };

    if (action.type === 'shot') {
      pushEvent_(room, { type: 'shot', pid: actor.id, no: action.no, params: action.params, result: action.result });
      var res = action.result || {};
      (res.players || []).forEach(function (rp) {
        var p = findPlayer_(room, rp.id);
        if (!p) return;
        p.hp = rp.hp;
        if (!p.left) p.alive = !!rp.alive;
        p.delay += Math.max(0, Math.min(400, rp.freeze || 0));
      });
      actor.delay += Math.max(300, Math.min(1400, Number(action.params && action.params.delayAdd) || 700));
    } else {
      pushEvent_(room, { type: 'skip', pid: actor.id, no: action.no, pos: cleanPos_(action.pos) });
      actor.delay += SKIP_DELAY;
    }
    actor.lastTurn = action.no;
    if (!checkEnd_(room)) nextTurn_(room);
    putRoom_(room);
    return { ok: true };
  });
}

function cleanPos_(p) {
  if (!p || !isFinite(p.x) || !isFinite(p.y)) return null;
  return { x: Number(p.x), y: Number(p.y), facing: p.facing === -1 ? -1 : 1, angle: Math.max(0, Math.min(90, Number(p.angle) || 0)) };
}

/** 현재 턴 플레이어의 실시간 이동/조준 공유 (잠금 없이 가볍게) */
function sendLive(code, pid, token, data) {
  var room = getRoom_(code);
  auth_(room, pid, token);
  touch_(code, pid);
  if (!room.turn || room.status !== 'playing') return false;
  var actor = findPlayer_(room, data.actor);
  if (!actor || room.turn.pid !== actor.id) return false;
  if (actor.id !== pid && !(actor.cpu && room.hostId === pid)) return false;
  data.no = room.turn.no;
  cache_().put('L_' + code, JSON.stringify(data), 600);
  return true;
}

function touch_(code, pid) {
  cache_().put('S_' + code + '_' + pid, String(Date.now()), CACHE_TTL);
}

/**
 * 주기적 폴링: 방 상태 + since 이후 이벤트 + 실시간 위치
 */
function poll(code, pid, token, since) {
  var room = getRoom_(code);
  auth_(room, pid, token);
  touch_(code, pid);
  since = Math.max(0, Number(since) || 0);
  var now = Date.now();

  // 접속 끊긴 플레이어 / 시간 초과 처리
  if (room.status !== 'ended') {
    var needFix = false;
    var seen = lastSeenMap_(room);
    room.players.forEach(function (p) {
      if (p.cpu || p.left || p.id === pid) return;
      if (now - (seen[p.id] || room.createdAt) > LEAVE_MS) needFix = true;
    });
    if (room.status === 'playing' && room.turn) {
      var tp = findPlayer_(room, room.turn.pid);
      var who = tp && tp.cpu ? room.hostId : room.turn.pid;
      var elapsed = now - room.turn.startedAt;
      if (elapsed > TURN_MS + TURN_GRACE_MS) needFix = true;
      if (who !== pid && elapsed > 5000 && now - (seen[who] || 0) > AWAY_MS) needFix = true;
    }
    if (needFix) room = fixStalled_(code, pid) || room;
  }

  var evs = [];
  var to = Math.min(room.evCount, since + 40);
  if (to > since) {
    var keys = [];
    for (var i = since; i < to; i++) keys.push('E_' + code + '_' + i);
    var got = cache_().getAll(keys);
    for (var j = 0; j < keys.length; j++) {
      if (!got[keys[j]]) break;
      evs.push(JSON.parse(got[keys[j]]));
    }
  }
  var live = cache_().get('L_' + code);
  return { room: publicRoom_(room), events: evs, live: live ? JSON.parse(live) : null, now: now };
}

function lastSeenMap_(room) {
  var keys = room.players.map(function (p) { return 'S_' + room.code + '_' + p.id; });
  var got = cache_().getAll(keys);
  var m = {};
  room.players.forEach(function (p) {
    var v = got['S_' + room.code + '_' + p.id];
    m[p.id] = v ? Number(v) : 0;
  });
  return m;
}

function fixStalled_(code, pid) {
  return withLock_(function () {
    var room = getRoom_(code);
    if (!room || room.status === 'ended') return room;
    var now = Date.now();
    var seen = lastSeenMap_(room);
    room.players.slice().forEach(function (p) {
      if (p.cpu || p.left || p.id === pid) return;
      if (now - (seen[p.id] || room.createdAt) > LEAVE_MS) removePlayer_(room, p);
    });
    // 사람 없이 CPU만 남으면 CPU도 정리
    if (room.hostId === null && room.status === 'playing') {
      room.status = 'ended';
      pushEvent_(room, { type: 'end', winners: [] });
    }
    if (room.status === 'playing' && room.turn) {
      var tp = findPlayer_(room, room.turn.pid);
      var who = tp && tp.cpu ? room.hostId : room.turn.pid;
      var elapsed = now - room.turn.startedAt;
      var away = who !== pid && elapsed > 5000 && now - (seen[who] || 0) > AWAY_MS;
      if (tp && (elapsed > TURN_MS + TURN_GRACE_MS || away)) {
        // 마지막으로 공유된 위치를 최종 위치로 확정 (모두 같은 위치로 맞추기 위해)
        var liveRaw = cache_().get('L_' + code), live = liveRaw ? JSON.parse(liveRaw) : null;
        var pos = live && live.no === room.turn.no && live.actor === tp.id ? cleanPos_(live) : null;
        pushEvent_(room, { type: 'skip', pid: tp.id, no: room.turn.no, reason: away ? 'away' : 'timeout', pos: pos });
        tp.delay += SKIP_DELAY;
        tp.lastTurn = room.turn.no;
        if (!checkEnd_(room)) nextTurn_(room);
      }
    }
    putRoom_(room);
    return room;
  });
}
