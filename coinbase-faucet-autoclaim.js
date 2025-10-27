// ==UserScript==
// @name         Coinbase Faucet AutoClaim 
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  修复点击后停住的问题：每次操作重查 DOM，点击后等待按钮状态/新按钮出现，处理 modal，并带有 Start/Stop 与紧急停止。仅在 https://portal.cdp.coinbase.com/products/faucet* 生效。
// @author       awan
// @match        https://portal.cdp.coinbase.com/products/faucet*
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /********** 可配置 **********/
  let MIN_DELAY_MS = 250;   // 最小延迟（ms）
  let MAX_DELAY_MS = 600;   // 最大延迟（ms）
  const CLICK_RETRY = 3;    // 点击重试次数
  const POLL_INTERVAL_MS = 700; // 没找到 Claim 时的保守轮询间隔
  const WAIT_AFTER_CLICK_MS = 1200; // 目标等待：如果没检测到状态变化，先等待这个基线时间
  const WAIT_FOR_NEW_BTN_TIMEOUT = 8000; // 点击后等待新按钮或状态恢复的最大超时
  /****************************/

  // 状态
  let running = false;
  let stopRequested = false;

  // 注入样式和面板
  GM_addStyle(`
    .ac-fixed-panel { position: fixed; right: 12px; bottom: 12px; z-index: 2147483646;
      background: rgba(0,0,0,0.78); color: #fff; padding: 10px; border-radius: 8px; font-family: Arial, sans-serif; font-size:13px; }
    .ac-fixed-panel button { margin-left:6px; padding:6px 8px; border-radius:6px; border:none; cursor:pointer; }
    .ac-status { margin-top:6px; font-size:12px; opacity:0.9; }
  `);

  const panel = document.createElement('div');
  panel.className = 'ac-fixed-panel';
  panel.innerHTML = `
    <div>
      <strong>Coinbase Faucet AutoClaim </strong>
      <button id="ac-start">Start</button>
      <button id="ac-stop" disabled>Stop</button>
      <button id="ac-stop-em" title="紧急停止（立即标志）">EmergencyStop</button>
    </div>
    <div class="ac-status" id="ac-status">状态：已停止</div>
  `;
  document.body.appendChild(panel);

  const startBtn = document.getElementById('ac-start');
  const stopBtn = document.getElementById('ac-stop');
  const emBtn = document.getElementById('ac-stop-em');
  const statusEl = document.getElementById('ac-status');

  function updateStatus(text) { statusEl.textContent = '状态：' + text; }
  function randBetween(a,b){ return Math.floor(a + Math.random()*(b-a+1)); }
  function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

  // 全局紧急停止（可在控制台执行 window.AutoClaimEmergencyStop() ）
  window.AutoClaimEmergencyStop = function () {
    stopRequested = true;
    running = false;
    updateStatus('紧急停止已触发');
    startBtn.disabled = false;
    stopBtn.disabled = true;
    console.warn('[AutoClaim] EmergencyStop invoked');
  };
  emBtn.addEventListener('click', () => window.AutoClaimEmergencyStop());

  // 更稳健的点击：先 scroll/focus，再 click，若失败尝试 dispatch events
  async function safeClick(el) {
    if (!el) return false;
    try {
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
      el.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
      el.focus({ preventScroll: true });
      el.click();
      return true;
    } catch (e) {
      try {
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return true;
      } catch (e2) {
        console.warn('[AutoClaim] safeClick failed', e2);
        return false;
      }
    }
  }

  // 每次都重新查找 Claim 按钮（确保不会用到已被替换的旧引用）
  function findClaimButton() {
    // 优先 aria-label 精确匹配
    const byAria = document.querySelector('button[aria-label="Claim funds"], button[aria-label*="Claim"]');
    if (byAria) return byAria;
    // 然后线性扫描按钮文本（避免生成大型 NodeList 再 filter）
    const nodes = document.getElementsByTagName('button');
    for (let i = 0; i < nodes.length; i++) {
      const t = (nodes[i].textContent || '').trim();
      if (/^Claim\b/i.test(t)) return nodes[i];
    }
    return null;
  }

  function findGetMoreButton() {
    const nodes = document.getElementsByTagName('button');
    for (let i = 0; i < nodes.length; i++) {
      const t = (nodes[i].textContent || '').trim();
      if (/Get more funds/i.test(t)) return nodes[i];
    }
    return null;
  }

  // 等待函数：直到 predicate 返回 true 或超时
  async function waitFor(predicate, timeout = WAIT_FOR_NEW_BTN_TIMEOUT, interval = 200) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (stopRequested) return false;
      try {
        if (predicate()) return true;
      } catch (e) { /* ignore predicate errors */ }
      await sleep(interval);
    }
    return false;
  }

  // 处理页面可能弹出的模态（尝试寻找并点击常见关闭按钮）
  async function tryCloseModalShort() {
    // 常见文本：Close / Close window / OK / Got it / Done / Dismiss / Cancel / 确定 / 关闭
    const closeTexts = ['Close', 'OK', 'Got it', 'Done', 'Dismiss', 'Cancel', '确定', '关闭'];
    const nodes = document.getElementsByTagName('button');
    for (let i = 0; i < nodes.length; i++) {
      const t = (nodes[i].textContent || '').trim();
      if (!t) continue;
      for (const ct of closeTexts) {
        if (t === ct || t.includes(ct)) {
          try {
            await safeClick(nodes[i]);
            await sleep(300);
            return true;
          } catch (e) { /* ignore */ }
        }
      }
    }
    return false;
  }

  // 单次领取：点击 Claim -> 等待按钮状态变动或新按钮出现 -> 处理 Get more -> 返回是否成功点击过一次
  async function singleClaimCycle() {
    // 查找最新 Claim 按钮（每次都重新查）
    const claimBtn = findClaimButton();
    if (!claimBtn) {
      // 没找到
      return false;
    }
    if (claimBtn.disabled || claimBtn.getAttribute('aria-disabled') === 'true') {
      return false;
    }

    // 记录按钮点击前的关键属性（用以判断是否发生变化）
    const beforeText = (claimBtn.textContent || '').trim();
    const beforeDisabled = claimBtn.disabled || claimBtn.getAttribute('aria-disabled') === 'true';

    // 点击
    let clicked = false;
    for (let i = 0; i < CLICK_RETRY; i++) {
      clicked = await safeClick(claimBtn);
      if (clicked) break;
      await sleep(80);
    }
    if (!clicked) return false;

    // 点击后至少等待一个基线时间，让请求发出并触发 DOM 变化
    await sleep(WAIT_AFTER_CLICK_MS);

    // 等待条件：1) Claim 按钮文本发生变化（例如变成 "Claiming..."、"Claimed"、被禁用等）
    // 或 2) Claim 按钮元素被移除并且随后出现新的 Claim（新 DOM 节点）
    const changed = await waitFor(() => {
      const current = findClaimButton();
      if (!current) return true; // 按钮被移除（可能意味着成功或进入等待）
      const curText = (current.textContent || '').trim();
      const curDisabled = current.disabled || current.getAttribute('aria-disabled') === 'true';
      // 文本或可用状态变化视为已触发
      if (curText !== beforeText) return true;
      if (curDisabled !== beforeDisabled) return true;
      return false;
    }, WAIT_FOR_NEW_BTN_TIMEOUT, 250);

    // 如果检测到了模态，尝试关闭（短暂）
    await tryCloseModalShort();

    // 处理 "Get more funds"（如果出现）
    const getMoreBtn = findGetMoreButton();
    if (getMoreBtn && !(getMoreBtn.disabled || getMoreBtn.getAttribute('aria-disabled') === 'true')) {
      let gmClicked = false;
      for (let i = 0; i < CLICK_RETRY; i++) {
        gmClicked = await safeClick(getMoreBtn);
        if (gmClicked) break;
        await sleep(80);
      }
      if (gmClicked) {
        // 再次等待 Get more 的响应
        await sleep(randBetween(MIN_DELAY_MS, MAX_DELAY_MS));
      }
    }

    // 如果等待超时（changed === false），我们视为页面没有正常响应，返回失败以便脚本进行退避
    return !!changed;
  }

  // 主循环：反复执行 singleClaimCycle（具备 stop 与退避）
  async function mainLoop() {
    if (running) return;
    running = true;
    stopRequested = false;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    updateStatus('运行中');

    let consecutiveFails = 0;

    while (running && !stopRequested) {
      try {
        const claimBtn = findClaimButton();
        if (!claimBtn) {
          // 没找到：等待并继续
          await sleep(POLL_INTERVAL_MS);
          continue;
        }

        const ok = await singleClaimCycle();
        if (ok) {
          consecutiveFails = 0;
          // 正常成功：短随机等待再继续
          await sleep(randBetween(MIN_DELAY_MS, MAX_DELAY_MS));
        } else {
          consecutiveFails++;
          // 如果多次失败，进行指数退避（延长等待）
          const backoff = Math.min(30000, 500 * Math.pow(2, Math.min(consecutiveFails, 6)));
          console.warn('[AutoClaim] singleCycle failed, consecutiveFails=', consecutiveFails, 'backoff=', backoff);
          updateStatus('遇到问题，退避中 ' + Math.round(backoff/1000) + 's');
          await sleep(backoff);
          updateStatus('运行中');
        }
      } catch (err) {
        console.error('[AutoClaim] loop error', err);
        await sleep(2000);
      }
    }

    running = false;
    stopRequested = false;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    updateStatus('已停止');
  }

  // 绑定按钮事件
  startBtn.addEventListener('click', () => {
    if (!running) mainLoop();
  });
  stopBtn.addEventListener('click', () => {
    stopRequested = true;
    running = false;
    updateStatus('停止请求中...');
  });

  // 初始提示
  updateStatus('已注入，手动点击 Start 开始（避免页面自动卡顿）');

})();
