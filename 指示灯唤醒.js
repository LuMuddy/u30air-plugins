//<!-- [KANO_PLUGIN_START] Muddy-指示灯 -->
//<script>
/*
 * U30 Air 指示灯  v1.5.1
 *
 * 作者：Muddy
 *
 * 面板三颗灯（电池 / WiFi / 信号）由模组固件驱动，固件自己按状态亮灭：
 *   WiFi 灯  —— WiFi 开着才亮（读 SSID1 判断）
 *   信号灯   —— 按 network_rssi 的格数来，0 格表示无服务
 *   电池灯   —— 按电量/充电状态
 * 固件只有一个总闸 indicator_light_switch，没有分灯控制；所以本插件做两件事：
 *   1. 把真实状态读出来，告诉你每颗灯"应该"是什么样
 *   2. 灯没按预期亮时，把总闸写 0 再写 1，逼固件重跑一遍灯逻辑
 *
 * 数据走 App 自带反代 /api/goform/*，需要登录票据 localStorage['kano_sms_token']。
 */
(function () {
  'use strict';

  var VERSION = '1.5.1';
  var HOST_ID = 'u30air-ledwake-host';
  var ENTRY_ID = 'u30air-ledwake-entry';
  var API = '/api/goform';

  var now = function () { return Date.now(); };
  var pad2 = function (n) { return n < 10 ? '0' + n : '' + n; };
  function fmtTime(ts) {
    if (!ts) return '--';
    var d = new Date(ts);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ------------------------------ 接口 ------------------------------ */

  function authHeaders(extra) {
    var h = extra || {};
    try {
      var token = localStorage.getItem('kano_sms_token');
      if (token) h.authorization = token;
    } catch (e) {}
    return h;
  }

  async function apiGet(cmd) {
    var res = await fetch(API + '/goform_get_cmd_process?cmd=' + encodeURIComponent(cmd), {
      headers: authHeaders({ Accept: 'application/json' })
    });
    var text = await res.text();
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + text.slice(0, 80));
    try { return JSON.parse(text); } catch (e) { throw new Error('返回不是 JSON：' + text.slice(0, 60)); }
  }

  async function apiSet(fields) {
    var res = await fetch(API + '/goform_set_cmd_process', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }),
      body: new URLSearchParams(fields).toString()
    });
    var text = await res.text();
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + text.slice(0, 80));
    try { return JSON.parse(text); } catch (e) { throw new Error('返回不是 JSON：' + text.slice(0, 60)); }
  }

  async function readStatus() {
    if (!authHeaders().authorization) throw new Error('未找到登录票据，请先在 UFI-TOOLS 里登录');
    var d = await apiGet([
      'indicator_light_switch', 'SSID1', 'network_rssi', 'network_type',
      'network_provider', 'battery_vol_percent', 'battery_charging', 'modem_main_state'
    ].join(','));
    var rssi = Number(d.network_rssi);
    var ssid = (d.SSID1 || '').trim();
    state.status = {
      switchOn: d.indicator_light_switch === '1',
      ssid: ssid,
      wifiOn: ssid.length > 0,
      rssi: isFinite(rssi) ? rssi : -1,
      type: d.network_type || '',
      provider: d.network_provider || '',
      battery: d.battery_vol_percent || '',
      charging: d.battery_charging === '1',
      modem: d.modem_main_state || ''
    };
    render();
    return state.status;
  }

  async function setSwitch(on) {
    var res = await apiSet({
      goformId: 'INDICATOR_LIGHT_SETTING',
      isTest: 'false',
      indicator_light_switch: on ? '1' : '0'
    });
    if (res && res.result !== 'success') throw new Error(JSON.stringify(res).slice(0, 80));
  }

  async function redrive() {
    if (state.busy) return;
    if (!state.status || !state.status.switchOn) {
      log('WARN', '总闸没开，先去 App 的「指示灯」开关打开');
      return;
    }
    state.busy = true;
    render();
    try {
      await setSwitch(false);
      log('INFO', '关闭总闸，等固件重跑灯逻辑');
      await sleep(700);
      await setSwitch(true);
      log('OK', '重新打开总闸完成');
      await readStatus();
    } catch (e) {
      log('ERR', e.message);
    } finally {
      state.busy = false;
      render();
    }
  }

  /* ------------------------------ 判断 ------------------------------ */

  function judge(s) {
    if (!s) return { level: 'warn', text: '还没读到状态' };
    if (!s.switchOn) return { level: 'bad', text: '总闸没开，去 App 的「指示灯」开关打开' };
    var problems = [];
    if (s.rssi <= 0) problems.push('模组没上报信号格数');
    if (!s.type) problems.push('没识别到网络制式');
    if (!s.modem || s.modem !== 'modem_init_complete') problems.push('模组状态：' + (s.modem || '未知'));
    if (problems.length) return { level: 'warn', text: '数据异常：' + problems.join('、') };
    return { level: 'ok', text: '数据正常，灯应处于对应状态' };
  }

  function wifiText(s) {
    if (!s) return '—';
    return s.wifiOn ? '开 · ' + s.ssid : '关';
  }

  function signalText(s) {
    if (!s) return '—';
    if (s.rssi <= 0) return '无信号';
    var bars = '';
    for (var i = 1; i <= 5; i++) bars += i <= s.rssi ? '▮' : '▯';
    return bars;
  }

  function signalLevel(s) {
    if (!s || s.rssi <= 0) return 'bad';
    if (s.rssi >= 4) return 'ok';
    if (s.rssi >= 2) return 'warn';
    return 'bad';
  }

  /* ------------------------------ 状态 ------------------------------ */

  var state = { status: null, logs: [], busy: false };
  var liveTimer = null;

  function startLive() {
    stopLive();
    liveTimer = setInterval(function () {
      if (!ui.wrap || ui.wrap.style.display === 'none') return;
      if (state.busy) return;
      readStatus().catch(function () {});
    }, 5000);
  }

  function stopLive() {
    if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
  }

  function log(level, text) {
    state.logs.unshift({ t: now(), level: level, text: text });
    if (state.logs.length > 30) state.logs.length = 30;
    render();
  }

  /* ------------------------------ UI ------------------------------ */

  var doc = null, shadow = null, entry = null, host = null;
  var ui = {};

  var CSS = [
    ':host{all:initial}',
    '.wrap{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(5,11,19,.68);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;color:#e6f0fb}',
    '.panel{width:min(400px,93vw);max-height:90vh;overflow:auto;background:#0b1622;border:1px solid #1b3346;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.6)}',
    '.hd{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid #17293c}',
    '.hbar{width:3px;height:15px;border-radius:2px;background:#3b82f6;flex:none}',
    '.ttl{font-weight:700;font-size:14px;flex:1}',
    '.closebtn{background:#14395c;border:1px solid #1d5591;color:#bfe0ff;border-radius:8px;padding:5px 11px;font-size:11.5px;cursor:pointer}',
    '.body{padding:10px 12px 12px;display:flex;flex-direction:column;gap:9px}',
    '.hero{background:#11202e;border:1px solid #1b3346;border-radius:12px;padding:10px 12px}',
    '.hero .st{font-size:11px;color:#6d87a1}',
    '.hero .big{font-size:15px;font-weight:700;margin-top:3px}',
    '.hero .msg{font-size:11.5px;margin-top:4px}',
    '.ok{color:#34d399}.warn{color:#fbbf24}.bad{color:#f87171}',
    '.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}',
    '.cell{background:#11202e;border:1px solid #1b3346;border-radius:10px;padding:7px 9px}',
    '.cell .k{font-size:10px;color:#6d87a1}',
    '.cell .v{font-size:12.5px;font-weight:600;margin-top:1px;word-break:break-all}',
    '.cell .n{font-size:10px;color:#5c7590;margin-top:2px}',
    '.btns{display:flex;flex-wrap:wrap;gap:7px}',
    'button.b{border:1px solid #1d5591;background:#14395c;color:#cfe6ff;border-radius:9px;padding:7px 11px;font-size:12px;cursor:pointer;flex:1 1 0;min-width:0}',
    'button.b.primary{background:#2563eb;border-color:#3b82f6;color:#fff;font-weight:600}',
    'button.b:disabled{opacity:.5}',
    '.sec{font-size:10px;letter-spacing:.08em;color:#5c7590}',
    '.log{background:#081320;border:1px solid #17293c;border-radius:11px;padding:8px;max-height:96px;overflow:auto;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10.5px;line-height:1.5;white-space:pre-wrap;word-break:break-all}',
    '.log .l{display:block}',
    '.log .t{color:#4f6980}',
    '.log .OK{color:#34d399}.log .ERR{color:#f87171}.log .WARN{color:#fbbf24}.log .INFO{color:#6ea8fe}'
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
    var heroBig = h('div', { class: 'big', text: '读取中…' });
    var heroMsg = h('div', { class: 'msg', text: '—' });
    var hero = h('div', { class: 'hero' }, h('div', { class: 'st', text: '指示灯总闸' }), heroBig, heroMsg);

    var wVal = h('div', { class: 'v', text: '—' });
    var wNote = h('div', { class: 'n', text: 'WiFi 灯' });
    var sVal = h('div', { class: 'v', text: '—' });
    var sNote = h('div', { class: 'n', text: '信号灯' });
    var bVal = h('div', { class: 'v', text: '—' });
    var bNote = h('div', { class: 'n', text: '电池灯' });

    var grid = h('div', { class: 'grid' },
      h('div', { class: 'cell' }, h('div', { class: 'k', text: 'WiFi' }), wVal, wNote),
      h('div', { class: 'cell' }, h('div', { class: 'k', text: '信号' }), sVal, sNote),
      h('div', { class: 'cell' }, h('div', { class: 'k', text: '电量' }), bVal, bNote)
    );

    var redriveBtn = h('button', { class: 'b primary', type: 'button', text: '重新驱动', onclick: function () { redrive(); } });
    var refreshBtn = h('button', { class: 'b', type: 'button', text: '刷新', onclick: function () { refresh(); } });
    var logBox = h('div', { class: 'log' });

    var panel = h('div', { class: 'panel' },
      h('div', { class: 'hd' },
        h('span', { class: 'hbar' }),
        h('span', { class: 'ttl', text: '指示灯 v' + VERSION }),
        h('button', { class: 'closebtn', type: 'button', text: '关闭', onclick: close })
      ),
      h('div', { class: 'body' },
        hero,
        grid,
        h('div', { class: 'btns' }, redriveBtn, refreshBtn),
        h('div', { class: 'sec', text: '日志' }),
        logBox
      )
    );

    var wrap = h('div', { class: 'wrap' }, panel);
    wrap.addEventListener('click', function (event) { if (event.target === wrap) close(); });
    ui = {
      wrap: wrap, heroBig: heroBig, heroMsg: heroMsg,
      wVal: wVal, wNote: wNote, sVal: sVal, sNote: sNote, bVal: bVal, bNote: bNote,
      logBox: logBox, redriveBtn: redriveBtn
    };
    return wrap;
  }

  async function refresh() {
    try {
      await readStatus();
      log('INFO', '状态已刷新');
    } catch (e) {
      log('ERR', '读取失败：' + e.message);
    }
  }

  function render() {
    if (!ui.wrap) return;
    var s = state.status;
    var v = judge(s);
    var on = !!(s && s.switchOn);
    if (!s) {
      ui.heroBig.textContent = '读取中…';
      ui.heroBig.className = 'big warn';
      ui.heroMsg.textContent = '正在获取实时状态';
      ui.heroMsg.className = 'msg warn';
      ui.wVal.textContent = '—'; ui.wNote.textContent = '';
      ui.sVal.textContent = '—'; ui.sNote.textContent = '';
      ui.bVal.textContent = '—'; ui.bNote.textContent = '';
    } else {
      ui.heroBig.textContent = (on ? '已开启' : '未开启') + '（' + (on ? '1' : '0') + '）';
      ui.heroBig.className = 'big ' + (on ? 'ok' : 'bad');
      ui.heroMsg.textContent = v.text;
      ui.heroMsg.className = 'msg ' + v.level;

      ui.wVal.textContent = wifiText(s);
      ui.wVal.className = 'v ' + (s.wifiOn ? 'ok' : 'warn');
      ui.wNote.textContent = on ? (s.wifiOn ? 'WiFi 灯应亮' : 'WiFi 灯应灭') : '总闸未开，不驱动';

      ui.sVal.textContent = signalText(s);
      ui.sVal.className = 'v ' + (on ? signalLevel(s) : '');
      ui.sNote.textContent = on
        ? (s.rssi > 0 ? s.rssi + ' 格 · ' + (s.type || '?') : '无信号')
        : '总闸未开，不驱动';

      ui.bVal.textContent = (s.battery || '—') + '%';
      ui.bNote.textContent = on ? (s.charging ? '充电中' : '未充电') : '总闸未开，不驱动';
    }
    ui.redriveBtn.disabled = state.busy || !on;
    ui.redriveBtn.textContent = state.busy ? '处理中…' : (on ? '重新驱动' : '总闸未开');

    ui.logBox.innerHTML = state.logs.map(function (item) {
      return '<span class="l"><span class="t">' + fmtTime(item.t) + '</span> ' +
        '<span class="' + item.level + '">[' + item.level + ']</span> ' +
        escapeHtml(item.text) + '</span>';
    }).join('') || '<span class="l t">暂无日志</span>';
  }

  function open() {
    if (!ui.wrap) return;
    if (!ui.wrap.isConnected) shadow.appendChild(ui.wrap);
    ui.wrap.style.display = 'flex';
    state.status = null;
    render();
    refresh();
    startLive();
  }
  function close() {
    if (!ui.wrap) return;
    ui.wrap.style.display = 'none';
    stopLive();
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
    entry.textContent = '💡 指示灯';
    entry.style.cssText = 'display:inline-flex;align-items:center;gap:8px;min-height:44px';
    entry.addEventListener('click', open);

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

    render();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (entry && entry.parentNode) entry.parentNode.removeChild(entry);
    if (host && host.parentNode) host.parentNode.removeChild(host);
    if (window.__MuddyLedWake__ === owner) delete window.__MuddyLedWake__;
  }

  var previous = window.__MuddyLedWake__;
  if (previous && typeof previous.dispose === 'function') previous.dispose();
  var owner = { version: VERSION, dispose: dispose, open: open, refresh: refresh, redrive: redrive };
  window.__MuddyLedWake__ = owner;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startPlugin, { once: true });
  else startPlugin();
})();
//</script>
//<!-- [KANO_PLUGIN_END] Muddy-指示灯 -->
