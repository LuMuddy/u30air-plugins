//<!-- [KANO_PLUGIN_START] Muddy-来电检测 -->
//<script>
/*
 * 来电检测  v1.0.0
 * 插件名固定为 Muddy-来电检测：升级时保持文件名与标记不变，宿主才会原地覆盖而不是新增一个。
 *
 * 作者：Muddy
 * 版权：Copyright (c) 2026 Muddy. All rights reserved.
 *
 * 宿主：UFI-TOOLS / KANO WebView 插件容器
 * 依赖：宿主注入的 runShellWithRoot(command, timeout) -> Promise<{success, content}>
 *
 * 做什么：盯着设备当前通话状态，来电时给出提示。
 *   - 多探针轮询（telephony.registry / telecom / getprop / audio），自动挑能用的那个
 *   - 记录：号码 拨号 / 号码 结束（含时长），保留最近 50 条
 *   - 提示：入口按钮左侧指示灯变色（待机绿 / 来电黄 / 通话中红）+ 提示音 + 震动
 *   - 面板：默认不弹出，点开才显示当前状态与历史记录
 * 无任何网络请求，不转发、不上传。
 * 记录落盘到 /data/adb/u30air-callwatch/store.json，关掉 App 也不丢。
 * 无任何网络请求，不转发、不上传，不写系统启动项。
 */
(function () {
  'use strict';

  var VERSION = '1.0.0';
  var HOST_ID = 'u30air-cd-host';
  var ENTRY_ID = 'u30air-cd-entry';
  var STORE_KEY = 'kano_muddy_cd';
  var API_LIMIT = 4 * 1024 * 1024;
  var LOG_MAX = 80;
  var HISTORY_MAX = 50;

  var DATA_DIR = '/data/adb/u30air-callwatch';

  var DEFAULTS = {
    autoStart: true,
    pollSec: 3,
    sound: true,
    vibrate: true,
    adaptive: true
  };

  var CALL_LABEL = { '-1': '检测不可用', 0: '空闲', 1: '响铃', 2: '通话中' };
  var EVENT_LABEL = { dial: '拨号', answered: '接通', end: '结束' };

  /* ------------------------------ 工具 ------------------------------ */

  var quote = function (value) {
    return "'" + String(value).replace(/'/g, "'\\''") + "'";
  };
  var now = function () { return Date.now(); };
  var pad2 = function (n) { return n < 10 ? '0' + n : '' + n; };
  function fmtTime(ts) {
    if (!ts) return '--';
    var d = new Date(ts);
    return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function fmtDur(ms) {
    if (!ms || ms < 0) return '0:00';
    var total = Math.round(ms / 1000);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    return h > 0 ? h + ':' + pad2(m) + ':' + pad2(s) : m + ':' + pad2(s);
  }
  function assign(target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      if (!src) continue;
      for (var k in src) {
        if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k];
      }
    }
    return target;
  }

  /* ------------------------------ 持久化 ------------------------------ */

  function readStore() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      var value = JSON.parse(raw);
      return value && typeof value === 'object' ? value : null;
    } catch (e) { return null; }
  }

  var stored = readStore() || {};
  var cfg = assign({}, DEFAULTS, stored.cfg || {});

  var state = {
    running: false,
    busy: false,
    probeId: '',
    call: { state: -1, number: '', since: 0 },
    ringAt: 0,
    activeAt: 0,
    pausedAt: 0,
    history: Array.isArray(stored.history) ? stored.history.slice(0, HISTORY_MAX) : [],
    stats: assign({ incoming: 0, ringMs: 0, lastDial: 0, day: '' }, stored.stats || {}),
    expanded: (stored.expanded && typeof stored.expanded === 'object') ? stored.expanded : {},
    logs: [],
    fails: 0,
    latency: 0,
    lastError: ''
  };

  var DATA_FILE = DATA_DIR + '/store.json';
  var saveTimer = null;

  function writeStore() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ cfg: cfg, expanded: state.expanded }));
    } catch (e) {}
  }

  function saveDeviceStore() {
    if (!sh) return Promise.resolve();
    var payload = JSON.stringify({
      history: state.history.slice(0, HISTORY_MAX),
      stats: state.stats
    });
    return sh("mkdir -p " + DATA_DIR + "; cat > " + DATA_FILE + " <<'STORE_EOF'\n" + payload + "\nSTORE_EOF", 15000);
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { saveDeviceStore().catch(function () {}); }, 800);
  }

  async function loadDeviceStore() {
    if (!sh) return false;
    var res = await sh('cat ' + DATA_FILE + ' 2>/dev/null', 15000);
    var raw = (res.out || '').trim();
    if (!raw) return false;
    var data;
    try { data = JSON.parse(raw); } catch (e) { return false; }
    if (data && Array.isArray(data.history)) state.history = data.history.slice(0, HISTORY_MAX);
    if (data && data.stats && typeof data.stats === 'object') state.stats = assign({}, state.stats, data.stats);
    return true;
  }

  /* ------------------------------ Shell ------------------------------ */

  var sh = null;
  function createShell(sdk) {
    var tail = Promise.resolve();
    function run(command, timeout) {
      var next = function () { return runOnce(command, timeout); };
      var p = tail.then(next, next);
      tail = p.then(function () {}, function () {});
      return p;
    }
    async function runOnce(command, timeout) {
      if (typeof sdk !== 'function') throw new Error('请在 UFI-TOOLS 中打开本插件');
      var result;
      try {
        result = await sdk(
          '/system/bin/sh -c ' + quote(command) + '\nr=$?\nprintf "\\n__CD_RC__=%s\\n" "$r"',
          timeout || 20000
        );
      } catch (e) {
        throw new Error('设备连接中断');
      }
      if (!result || result.success !== true) throw new Error('请登录 UFI-TOOLS 并开启高级功能');
      var out = String(result.content == null ? '' : result.content).replace(/\r\n?/g, '\n');
      if (out.length > API_LIMIT + 8192) throw new Error('设备响应过大');
      var marker = out.match(/(?:^|\n)__CD_RC__=(\d+)\s*$/);
      if (!marker) throw new Error('设备响应未确认');
      return { code: Number(marker[1]), out: out.slice(0, marker.index).trim() };
    }
    return run;
  }

  /* ------------------------------ 探针 ------------------------------ */

  var PROBES = [
    {
      id: 'telephony',
      cmd: "dumpsys telephony.registry 2>/dev/null | grep -m4 -E 'mCallState=|mCallIncomingNumber='",
      parse: function (out) {
        var states = [], m, re = /mCallState=(\d+)/g;
        while ((m = re.exec(out))) states.push(Number(m[1]));
        if (!states.length) return null;
        var num = out.match(/mCallIncomingNumber=([^\s,}]+)/);
        return {
          state: Math.max.apply(null, states),
          number: num && num[1] !== 'null' ? num[1] : ''
        };
      }
    },
    {
      id: 'telecom',
      cmd: "dumpsys telecom 2>/dev/null | grep -m4 -E 'mIsInCall|isInCall=|CALL_STATE_(RINGING|ACTIVE|DIALING|DISCONNECTED)'",
      parse: function (out) {
        var flag = out.match(/mIsInCall=(true|false)/i);
        if (flag) return { state: flag[1].toLowerCase() === 'true' ? 2 : 0, number: '' };
        if (/CALL_STATE_ACTIVE/.test(out)) return { state: 2, number: '' };
        if (/CALL_STATE_(RINGING|DIALING)/.test(out)) return { state: 1, number: '' };
        if (/CALL_STATE_DISCONNECTED/.test(out)) return { state: 0, number: '' };
        return null;
      }
    },
    {
      id: 'prop',
      cmd: "getprop 2>/dev/null | grep -iE 'gsm\\.call|call[._]state|in[._]call' | head -8",
      parse: function (out) {
        if (!out) return null;
        var named = out.match(/calling[_ ]?state[^\[]*\[(\w+)\]/i);
        if (named) {
          var v = named[1].toLowerCase();
          if (v === 'active' || v === 'in_call' || v === 'call') return { state: 2, number: '' };
          if (v === 'ringing' || v === 'incoming') return { state: 1, number: '' };
          if (v === 'idle' || v === 'false' || v === '0') return { state: 0, number: '' };
        }
        var numeric = out.match(/call[._]state[^\[]*\[(\d+)\]/i);
        if (numeric) return { state: Number(numeric[1]), number: '' };
        return null;
      }
    },
    {
      id: 'audio',
      cmd: "dumpsys audio 2>/dev/null | grep -m3 -E 'MODE_IN_CALL|mode: *[0-9]|mMode='",
      parse: function (out) {
        if (!out) return null;
        if (/MODE_IN_CALL/.test(out)) return { state: 2, number: '' };
        if (/mode:\s*2\b|mMode=2\b/.test(out)) return { state: 2, number: '' };
        if (/mode:\s*[013]\b|mMode=[013]\b/.test(out)) return { state: 0, number: '' };
        return null;
      }
    }
  ];

  function probeOrder() {
    var list = [], i;
    if (state.probeId && !list.some(function (p) { return p.id === state.probeId; })) {
      for (i = 0; i < PROBES.length; i++) if (PROBES[i].id === state.probeId) list.push(PROBES[i]);
    }
    for (i = 0; i < PROBES.length; i++) {
      if (!list.some(function (p) { return p.id === PROBES[i].id; })) list.push(PROBES[i]);
    }
    return list;
  }

  async function detectCall() {
    var list = probeOrder();
    for (var i = 0; i < list.length; i++) {
      var probe = list[i];
      var res = await sh(probe.cmd, 15000);
      if (!res || !res.out) continue;
      var parsed = probe.parse(res.out);
      if (!parsed) continue;
      state.probeId = probe.id;
      return { state: parsed.state, number: parsed.number || '' };
    }
    return null;
  }

  /* ------------------------------ 本地提示 ------------------------------ */

  var audioCtx = null;

  function primeAudio() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === 'suspended' && audioCtx.resume) audioCtx.resume();
    } catch (e) {}
  }

  function tone(at, freq, dur, peak) {
    var osc = audioCtx.createOscillator();
    var gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peak, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }

  function ringTone() {
    if (!cfg.sound) return;
    try {
      primeAudio();
      if (!audioCtx) return;
      var t = audioCtx.currentTime;
      tone(t, 880, 0.18, 0.3);
      tone(t + 0.24, 1180, 0.2, 0.3);
      tone(t + 0.6, 880, 0.18, 0.26);
    } catch (e) {}
  }

  function clickTone() {
    if (!cfg.sound) return;
    try {
      primeAudio();
      if (!audioCtx) return;
      tone(audioCtx.currentTime, 660, 0.1, 0.16);
    } catch (e) {}
  }

  function vibrate(pattern) {
    if (!cfg.vibrate) return;
    try {
      if (typeof navigator !== 'undefined' && navigator && typeof navigator.vibrate === 'function') {
        navigator.vibrate(pattern);
      }
    } catch (e) {}
  }

  /* ------------------------------ 状态机 ------------------------------ */

  function log(level, text) {
    state.logs.unshift({ t: now(), level: level, text: text });
    if (state.logs.length > LOG_MAX) state.logs.length = LOG_MAX;
    render();
  }

  function rollDay() {
    var day = fmtTime(now()).slice(0, 5);
    if (state.stats.day !== day) {
      state.stats.day = day;
      state.stats.incoming = 0;
      state.stats.ringMs = 0;
    }
  }

  function record(event) {
    rollDay();
    if (event.kind === 'dial') {
      state.stats.incoming += 1;
      state.stats.lastDial = event.ts;
    }
    if (event.kind === 'end' && event.duration && event.mode !== 'talk') state.stats.ringMs += event.duration;
    state.history.unshift(event);
    if (state.history.length > HISTORY_MAX) state.history.length = HISTORY_MAX;
    writeStore();
    scheduleSave();
    log('INFO',
      (event.number ? event.number + ' ' : '') + (EVENT_LABEL[event.kind] || event.kind) +
      (event.duration ? ' · ' + (event.mode === 'talk' ? '通话 ' : '响铃 ') + fmtDur(event.duration) : ''));
    if (event.kind === 'dial') {
      ringTone();
      vibrate([220, 120, 220, 120, 320]);
    } else if (event.kind === 'answered') {
      clickTone();
      vibrate([100, 80, 100]);
    }
    render();
  }

  async function tick(silent) {
    if (state.busy) return false;
    state.busy = true;
    var ok = false;
    var t0 = now();
    try {
      var detected = await detectCall();
      state.latency = now() - t0;
      if (!detected) {
        if (state.call.state !== -1) state.call = { state: -1, number: '', since: now() };
        state.lastError = '未找到可用探针';
        state.fails += 1;
        if (state.fails >= 3) {
          state.fails = 0;
          log('ERR', '连续 3 次读不到通话状态，已自动停止检测');
          stop();
          return false;
        }
      } else if (silent) {
        state.fails = 0;
        state.call = { state: detected.state, number: detected.number || '', since: now() };
        state.ringAt = detected.state === 1 ? now() : 0;
        state.activeAt = detected.state === 2 ? now() : 0;
        state.lastError = '';
        ok = true;
      } else {
        state.fails = 0;
        var prev = state.call.state;
        var number = detected.state === 0 ? '' : (detected.number || state.call.number || '');
        if (detected.state !== prev) {
          var ts = now();
          if (detected.state === 1) {
            state.ringAt = ts;
            state.activeAt = 0;
            record({ kind: 'dial', number: number, ts: ts });
          } else if (detected.state === 2) {
            state.activeAt = ts;
            record({ kind: 'answered', number: number, ts: ts });
          } else if (detected.state === 0) {
            if (prev === 1 || prev === 2) {
              record({
                kind: 'end', number: state.call.number || number, ts: ts, mode: prev === 1 ? 'ring' : 'talk',
                duration: prev === 1 ? (state.ringAt ? ts - state.ringAt : 0)
                                     : (state.activeAt ? ts - state.activeAt : 0)
              });
            }
            state.ringAt = 0;
            state.activeAt = 0;
          }
          state.call = { state: detected.state, number: number, since: ts };
          if (detected.state !== 0) state.lastError = '';
        } else {
          state.call.number = number;
          state.lastError = '';
        }
        ok = true;
      }
    } catch (err) {
      state.lastError = err.message;
      log('ERR', err.message);
    } finally {
      state.busy = false;
      render();
    }
    return ok;
  }

  var loopTimer = null;
  var tickTimer = null;

  function nextDelay() {
    var base = Math.max(1500, Number(cfg.pollSec) * 1000);
    if (cfg.adaptive) {
      var s = state.call.state;
      if (s === 1) base = Math.max(1500, Math.round(base / 2));
      else if (s === 2) base = Math.round(base * 0.75);
      else base = Math.min(15000, Math.round(base * 2.5));
    }
    if (state.latency > 0) base = Math.max(base, state.latency * 2);
    return Math.min(30000, base);
  }

  function schedule() {
    if (!state.running) return;
    clearTimeout(loopTimer);
    loopTimer = window.setTimeout(function () {
      if (!state.running) return;
      tick().then(function () { if (state.running) schedule(); });
    }, nextDelay());
  }

  async function start() {
    if (state.running) return;
    if (typeof runShellWithRoot !== 'function') {
      log('ERR', '未检测到 runShellWithRoot，请先登录 UFI-TOOLS');
      return;
    }
    state.running = true;
    rollDay();
    var resume = state.pausedAt > 0;
    state.pausedAt = 0;
    log('INFO', (resume ? '恢复检测' : '开始检测') + '（每 ' + cfg.pollSec + ' 秒）' +
      (resume ? '，暂停期间的状态变化不再补记' : ''));
    await tick(resume);
    schedule();
    clearInterval(tickTimer);
    tickTimer = setInterval(function () { updateClock(); }, 1000);
    render();
  }

  function stop() {
    if (!state.running) return;
    state.running = false;
    state.pausedAt = now();
    clearTimeout(loopTimer);
    clearInterval(tickTimer);
    var s = state.call.state;
    log('INFO', '已停止检测' + (s === 1 ? '（当前仍在响铃，电话不会被挂断）' : s === 2 ? '（当前仍在通话，电话不会被挂断）' : ''));
    render();
  }

  /* ------------------------------ UI ------------------------------ */

  var doc = null, shadow = null, entry = null, host = null;
  var ui = {};

  var CSS = [
    ':host{all:initial}',
    '.wrap{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(5,11,19,.68);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif;color:#e6f0fb}',
    '.panel{width:min(420px,93vw);max-height:92vh;overflow:auto;background:#0b1622;border:1px solid #1b3346;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.6)}',
    '.hd{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid #17293c;position:sticky;top:0;background:#0b1622;z-index:2}',
    '.hbar{width:3px;height:15px;border-radius:2px;background:#3b82f6;flex:none}',
    '.dot{width:9px;height:9px;border-radius:50%;background:#4b5563;flex:none}',
    '.dot.on{background:#34d399;box-shadow:0 0 0 4px rgba(52,211,153,.16)}',
    '.dot.ring{background:#fbbf24;box-shadow:0 0 0 5px rgba(251,191,36,.22)}',
    '.dot.talk{background:#f87171;box-shadow:0 0 0 5px rgba(248,113,113,.22)}',
    '.dot.err{background:#f87171}',
    '.ttl{font-weight:700;font-size:14px;flex:1;letter-spacing:.02em}',
    '.closebtn{background:#14395c;border:1px solid #1d5591;color:#bfe0ff;border-radius:8px;padding:5px 11px;font-size:11.5px;cursor:pointer;flex:none}',
    '.closebtn:active{background:#1a4772}',
    '.body{padding:9px 11px 11px;display:flex;flex-direction:column;gap:8px}',
    '.htop{display:flex;align-items:center;justify-content:space-between;gap:10px}',
    '.hero{border-radius:12px;padding:7px 11px;background:#11202e;border:1px solid #1b3346;transition:background .2s,border-color .2s}',
    '.hero.ring{background:#332713;border-color:#7a5c12;box-shadow:0 0 0 3px rgba(251,191,36,.12)}',
    '.hero.talk{background:#33141f;border-color:#6d2b42;box-shadow:0 0 0 3px rgba(248,113,113,.12)}',
    '.hero .st{font-size:11px;color:#8b93a7;letter-spacing:.1em}',
    '.hero .num{font-size:17px;font-weight:700;margin-top:2px;word-break:break-all;font-variant-numeric:tabular-nums;text-align:center}',
    '.hero .dur{font-size:11.5px;color:#9aa3b8;font-variant-numeric:tabular-nums;flex:none}',
    '.row{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}',
    '.cell{background:#11202e;border:1px solid #1b3346;border-radius:10px;padding:6px 8px}',
    '.cell .k{color:#6d87a1;font-size:10px}',
    '.cell .v{font-size:12.5px;font-weight:600;margin-top:1px}',
    'label{display:flex;flex-direction:column;gap:3px;font-size:12px;color:#9aa3b8}',
    'input,select{background:#0d1a26;border:1px solid #1b3346;color:#e6f0fb;border-radius:9px;padding:6px 8px;font-size:12px;outline:none;width:100%;box-sizing:border-box}',
    'input:focus,select:focus{border-color:#3b82f6}',
    '.swrow{display:flex;flex-wrap:wrap;gap:10px;justify-content:space-between}',
    '.sw{display:flex;flex-direction:row;align-items:center;gap:6px;font-size:11.5px;color:#93aec7;cursor:pointer}',
    '.sw input{appearance:none;-webkit-appearance:none;width:34px;height:19px;border-radius:10px;background:#24384b;border:0;position:relative;flex:none;transition:background .15s;cursor:pointer}',
    '.sw input:checked{background:#2563eb}',
    '.sw input:after{content:"";position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:#fff;transition:transform .15s}',
    '.sw input:checked:after{transform:translateX(15px)}',
    '.btns{display:flex;flex-wrap:wrap;gap:7px}',
    '.btns button{flex:1 1 0;min-width:0}',
    'button.b{border:1px solid #1d5591;background:#14395c;color:#cfe6ff;border-radius:9px;padding:6px 11px;font-size:12px;cursor:pointer}',
    'button.b.primary{background:#2563eb;border-color:#3b82f6;color:#fff;font-weight:600}',
    'button.b.danger{background:#3a1522;border-color:#6b2437;color:#f3a2b3}',
    'button.b:active{transform:translateY(1px)}',
    '.log{background:#081320;border:1px solid #17293c;border-radius:11px;padding:8px;max-height:76px;min-height:34px;overflow:auto;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10.5px;line-height:1.5;white-space:pre-wrap;word-break:break-all}',
    '.log .l{display:block}',
    '.log .t{color:#4f6980}',
    '.log .OK{color:#34d399}.log .ERR{color:#f87171}.log .WARN{color:#fbbf24}.log .INFO{color:#6ea8fe}',
    '.hist{display:flex;flex-direction:column;gap:5px;max-height:224px;overflow:auto}',
    '.grp{background:#11202e;border:1px solid #1b3346;border-radius:11px;overflow:hidden}',
    '.grp.open{border-color:#2c5f8f;background:#13263a}',
    '.ghead{display:flex;align-items:center;gap:8px;padding:7px 10px;cursor:pointer}',
    '.ghead:active{background:#1a2033}',
    '.gnum{flex:1;font-size:12.5px;font-weight:600;word-break:break-all}',
    '.gmeta{color:#6d87a1;font-size:10.5px;flex:none}',
    '.gchev{color:#6d87a1;font-size:10px;flex:none}',
    '.gbody{border-top:1px solid #1b3346;padding:2px 0}',
    '.ev{display:flex;gap:8px;font-size:10.5px;padding:3px 10px}',
    '.ev .et{color:#7e9cb8;font-variant-numeric:tabular-nums}',
    '.ev .ek{flex:1;text-align:right}',
    '.ev .ek.dial{color:#fbbf24}',
    '.ev .ek.end{color:#6ea8fe}',
    '.ev .ek.answered{color:#34d399}',
    '.empty{color:#6d87a1;font-size:12px;padding:10px 2px}',
    '.field{display:flex;align-items:center;gap:8px;font-size:11.5px;color:#8aa6c0}',
    '.field input{width:68px;text-align:center;padding:6px 4px}',
    '.field .u{color:#5f6880}',
    '.sechead{display:flex;align-items:center;justify-content:space-between;margin-top:2px}',
    '.sechead .sec{margin-top:0}',
    '.sechead .field{font-size:11px}',
    'button.b.mini{padding:5px 11px;font-size:11px;border-radius:9px}',
    '.sec{font-size:10px;letter-spacing:.08em;color:#5c7590;margin-top:2px}'
  ].join('');

  function h(tag, attrs) {
    var node = doc.createElement(tag);
    var map = attrs || {};
    Object.keys(map).forEach(function (key) {
      var value = map[key];
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value == null ? '' : String(value);
      else if (key.indexOf('on') === 0 && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
      else node.setAttribute(key, value == null ? '' : String(value));
    });
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child == null || child === false) continue;
      node.appendChild(typeof child === 'object' ? child : doc.createTextNode(String(child)));
    }
    return node;
  }

  function buildUI() {
    var dot = h('span', { class: 'dot', id: 'dot' });
    var header = h('div', { class: 'hd' }, dot,
      h('span', { class: 'hbar' }),
      h('span', { class: 'ttl', text: '来电检测 v' + VERSION }),
      h('button', { class: 'closebtn', type: 'button', text: '关闭', onclick: close })
    );

    var heroState = h('div', { class: 'st', text: '空闲' });
    var heroNum = h('div', { class: 'num', text: '—' });
    var heroDur = h('div', { class: 'dur', text: '待机' });
    var hero = h('div', { class: 'hero' }, h('div', { class: 'htop' }, heroState, heroDur), heroNum);

    var cIn = h('div', { class: 'v', text: '0' });
    var cMiss = h('div', { class: 'v', text: '0' });
    var cTalk = h('div', { class: 'v', text: '0:00' });
    var stats = h('div', { class: 'row' },
      h('div', { class: 'cell' }, h('div', { class: 'k', text: '今日来电' }), cIn),
      h('div', { class: 'cell' }, h('div', { class: 'k', text: '响铃累计' }), cMiss),
      h('div', { class: 'cell' }, h('div', { class: 'k', text: '最近来电' }), cTalk)
    );

    var pollIn = h('input', { type: 'number', min: '2', max: '30', value: String(cfg.pollSec) });
    pollIn.addEventListener('input', function () {
      var v = Number(pollIn.value);
      if (v >= 2 && v <= 30) { cfg.pollSec = v; writeStore(); if (state.running) schedule(); }
    });


    var soundSw = h('input', { type: 'checkbox' });
    soundSw.checked = !!cfg.sound;
    soundSw.addEventListener('change', function () { cfg.sound = soundSw.checked; writeStore(); if (cfg.sound) ringTone(); });
    var vibSw = h('input', { type: 'checkbox' });
    vibSw.checked = !!cfg.vibrate;
    vibSw.addEventListener('change', function () { cfg.vibrate = vibSw.checked; writeStore(); });
    var adaptiveSw = h('input', { type: 'checkbox' });
    adaptiveSw.checked = !!cfg.adaptive;
    adaptiveSw.addEventListener('change', function () {
      cfg.adaptive = adaptiveSw.checked;
      writeStore();
      if (state.running) schedule();
      log('INFO', '自适应轮询' + (cfg.adaptive ? '已开启' : '已关闭'));
    });

    var histBox = h('div', { class: 'hist' });
    histBox.addEventListener('click', function (event) {
      var node = event.target;
      while (node && node !== histBox) {
        if (node.getAttribute && node.getAttribute('data-num')) {
          var key = node.getAttribute('data-num');
          state.expanded[key] = !state.expanded[key];
          writeStore();
          render();
          return;
        }
        node = node.parentNode;
      }
    });
    var logBox = h('div', { class: 'log' });

    var startBtn = h('button', { class: 'b primary', type: 'button', text: '开始检测', onclick: function () { start(); } });
    var stopBtn = h('button', { class: 'b danger', type: 'button', text: '停止检测', onclick: function () { stop(); } });
    var clearBtn = h('button', { class: 'b mini', type: 'button', text: '清空', onclick: function () {
      state.history = [];
      state.stats.incoming = 0;
      state.stats.ringMs = 0;
      state.stats.lastDial = 0;
      writeStore();
      scheduleSave();
      render();
    }});

    var panel = h('div', { class: 'panel' },
      header,
      h('div', { class: 'body' },
        hero,
        stats,
        h('div', { class: 'sechead' },
          h('span', { class: 'sec', text: '检测设置' }),
          h('div', { class: 'field' }, h('span', { text: '轮询' }), pollIn, h('span', { class: 'u', text: '秒' }))
        ),
        h('div', { class: 'swrow' },
          h('label', { class: 'sw' }, soundSw, h('span', { text: '提示音' })),
          h('label', { class: 'sw' }, vibSw, h('span', { text: '震动' })),
          h('label', { class: 'sw' }, adaptiveSw, h('span', { text: '自适应' }))
        ),
        h('div', { class: 'btns' }, startBtn, stopBtn),
        h('div', { class: 'sechead' }, h('span', { class: 'sec', text: '通话记录' }), clearBtn),
        histBox,
        h('div', { class: 'sec', text: '日志' }),
        logBox
      )
    );

    var wrap = h('div', { class: 'wrap' }, panel);
    wrap.addEventListener('click', function (event) { if (event.target === wrap) close(); });

    ui = {
      wrap: wrap, dot: dot, hero: hero, heroState: heroState, heroNum: heroNum, heroDur: heroDur,
      cIn: cIn, cMiss: cMiss, cTalk: cTalk,
      histBox: histBox, logBox: logBox, startBtn: startBtn, stopBtn: stopBtn
    };
    return wrap;
  }

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  var entryLed = null, entryLabel = null;

  function setLed(s) {
    if (!entryLed) return;
    var color = s === 1 ? '#fbbf24' : s === 2 ? '#f87171' : (state.running ? '#34d399' : '#4b5563');
    entryLed.style.background = color;
    entryLed.style.boxShadow = (s === 1 || s === 2) ? '0 0 8px ' + color : 'none';
    entryLed.style.opacity = '1';
  }

  function entryText() {
    var s = state.call.state;
    if (s === 1) return '📞 来电 ' + (state.call.number || '');
    if (s === 2) return '📞 通话中 ' + (state.activeAt ? fmtDur(now() - state.activeAt) : '');
    return state.running ? '📞 待机' : '📞 来电检测';
  }

  function updateClock() {
    if (!ui.wrap) return;
    var s = state.call.state;
    if (s === 1) ui.heroDur.textContent = '响铃 ' + fmtDur(now() - (state.ringAt || now()));
    else if (s === 2) ui.heroDur.textContent = fmtDur(now() - (state.activeAt || now()));
    else ui.heroDur.textContent = state.running ? '待机' : '未启动';
    if (entryLabel) entryLabel.textContent = entryText();
  }

  function render() {
    if (!ui.wrap) return;
    var s = state.call.state;
    var cls = 'dot';
    if (state.lastError && state.running) cls += ' err';
    else if (s === 1) cls += ' ring';
    else if (s === 2) cls += ' talk';
    else if (state.running) cls += ' on';
    ui.dot.className = cls;

    ui.hero.className = 'hero' + (s === 1 ? ' ring' : s === 2 ? ' talk' : '');
    ui.heroState.textContent = !state.running && s <= 0 ? '未启动' : (CALL_LABEL[s] || '空闲');
    ui.heroNum.textContent = state.call.number || '—';
    updateClock();

    ui.cIn.textContent = String(state.stats.incoming || 0);
    ui.cMiss.textContent = fmtDur(state.stats.ringMs || 0);
    ui.cTalk.textContent = state.stats.lastDial ? fmtTime(state.stats.lastDial).slice(6) : '—';

    ui.startBtn.disabled = state.running;
    ui.startBtn.textContent = state.running ? '检测中' : '开始检测';
    ui.stopBtn.disabled = !state.running;
    ui.stopBtn.textContent = '停止检测';

    var groups = {};
    state.history.forEach(function (item) {
      var key = item.number || '未知号码';
      if (!groups[key]) groups[key] = { number: key, items: [] };
      groups[key].items.push(item);
    });
    var ordered = Object.keys(groups).map(function (k) { return groups[k]; });
    ordered.sort(function (a, b) { return (b.items[0].ts || 0) - (a.items[0].ts || 0); });
    ui.histBox.innerHTML = ordered.length ? ordered.map(function (grp) {
      var open = !!state.expanded[grp.number];
      var rows = grp.items.slice(0, 30).map(function (i) {
        return '<div class="ev"><span class="et">' + fmtTime(i.ts) + '</span>' +
          '<span class="ek ' + (i.kind || '') + '">' + (EVENT_LABEL[i.kind] || i.kind) +
          (i.duration ? ' · ' + (i.mode === 'talk' ? '通话 ' : '响铃 ') + fmtDur(i.duration) : '') + '</span></div>';
      }).join('');
      return '<div class="grp' + (open ? ' open' : '') + '" data-num="' + escapeHtml(grp.number) + '">' +
        '<div class="ghead"><span class="gnum">' + escapeHtml(grp.number) + '</span>' +
        '<span class="gmeta">' + grp.items.length + ' 条 · ' + fmtTime(grp.items[0].ts).slice(6) + '</span>' +
        '<span class="gchev">' + (open ? '▾' : '▸') + '</span></div>' +
        (open ? '<div class="gbody">' + rows + '</div>' : '') + '</div>';
    }).join('') : '<div class="empty">暂无记录</div>';

    ui.logBox.innerHTML = state.logs.map(function (item) {
      return '<span class="l"><span class="t">' + fmtTime(item.t) + '</span> ' +
        '<span class="' + item.level + '">[' + item.level + ']</span> ' +
        escapeHtml(item.text) + '</span>';
    }).join('') || '<span class="l t">暂无日志</span>';

    if (entryLabel) entryLabel.textContent = entryText();
    setLed(s);
  }

  function open() {
    if (!ui.wrap) return;
    if (!ui.wrap.isConnected) shadow.appendChild(ui.wrap);
    ui.wrap.style.display = 'flex';
    render();
  }
  function close() {
    if (!ui.wrap) return;
    ui.wrap.style.display = 'none';
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  var disposed = false;

  function startPlugin() {
    if (disposed) return;
    doc = document;

    var orphan = document.getElementById(HOST_ID);
    if (orphan) orphan.remove();
    var orphanEntry = document.getElementById(ENTRY_ID);
    if (orphanEntry) orphanEntry.remove();

    host = document.createElement('div');
    host.id = HOST_ID;
    shadow = host.attachShadow({ mode: 'open' });
    shadow.appendChild(h('style', { text: CSS }));

    entry = document.createElement('button');
    entry.id = ENTRY_ID;
    entry.type = 'button';
    entry.className = 'btn';
    entry.style.cssText = 'display:inline-flex;align-items:center;gap:8px;min-height:44px';
    entryLed = document.createElement('span');
    entryLed.style.cssText = 'width:10px;height:10px;border-radius:50%;background:#4b5563;flex:none;transition:background .15s,opacity .15s';
    entryLabel = document.createElement('span');
    entryLabel.textContent = '📞 来电检测';
    entry.appendChild(entryLed);
    entry.appendChild(entryLabel);
    entry.addEventListener('click', function () { primeAudio(); open(); });

    var target = document.querySelector('.functions-container .actions-buttons');
    if (target) target.appendChild(entry);
    else {
      entry.style.cssText += ';position:fixed;right:18px;bottom:75px;z-index:2147482999;padding:10px 16px;border-radius:14px;background:#7c8cff;color:#fff;border:0';
      document.body.appendChild(entry);
    }
    document.body.appendChild(host);

    var wrap = buildUI();
    wrap.style.display = 'none';
    shadow.appendChild(wrap);

    sh = createShell(function (command, timeout) {
      if (typeof runShellWithRoot !== 'function') return Promise.reject(new Error('请先登录 UFI-TOOLS'));
      return runShellWithRoot(command, timeout);
    });

    render();
    (async function () {
      try {
        var loaded = await loadDeviceStore();
        if (!loaded && state.history.length) scheduleSave();
        render();
      } catch (e) {}
      if (cfg.autoStart) start().catch(function (e) { log('ERR', e.message); });
    })();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    stop();
    document.removeEventListener('DOMContentLoaded', startPlugin);
    if (entry && entry.parentNode) entry.parentNode.removeChild(entry);
    if (host && host.parentNode) host.parentNode.removeChild(host);
    if (window.__MuddyCallDetect__ === owner) delete window.__MuddyCallDetect__;
  }

  var previous = window.__MuddyCallDetect__;
  if (previous && typeof previous.dispose === 'function') previous.dispose();
  var owner = { version: VERSION, dispose: dispose, open: function () { open(); }, isBusy: function () { return state.busy; } };
  window.__MuddyCallDetect__ = owner;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startPlugin, { once: true });
  else startPlugin();
})();
//</script>
//<!-- [KANO_PLUGIN_END] Muddy-来电检测 -->
