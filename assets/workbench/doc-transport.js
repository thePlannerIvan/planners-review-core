/**
 * 页面到存储的唯一一条通道 —— 同一份页面，两种宿主。
 *
 *   · DSH 侧栏：页面在不透明源 iframe 里，宿主只 serve 静态文件，不转发 `/api/*`。
 *     保存 / 派发 / 裁决 / 重排全部走公共桥的 `review.command(...)`；
 *     派发由页面再调 `review.wake(...)`，因为只有页面知道任务与文案。
 *   · 没有插件：页面是本地工作台的顶层文档，走同一台服务器上的 `/api/*`。
 *
 * 两条通道回执同形（`{ok, ...}`），页面逻辑因此只有一份：它只认回执，不认宿主。
 * 写盘、解析、journal、锁判定都在服务端（本地会话 / 侧栏命令后端），这里绝不自己拼文档。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DocTransport = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ROUTES = {
    open: '/api/doc',
    block: '/api/block',
    reorder: '/api/reorder',
    feedback: '/api/feedback',
    tasks: '/api/tasks',
    conflicts: '/api/conflicts',
    decide: '/api/conflict/decide',
  };

  function bridgeUsable() {
    const inFrame = globalThis.parent && globalThis.parent !== globalThis;
    // 没有插件时宿主（serve-review）也会注入桥并把 __REVIEW_BASE__ 放好；两种都算侧栏通道。
    return typeof globalThis.ReviewBridge !== 'undefined' && (inFrame || typeof globalThis.__REVIEW_BASE__ === 'string');
  }

  /* ---------------- 没有插件：本地工作台的 HTTP 入口 ---------------- */

  async function httpJson(path, body) {
    const init = body === undefined
      ? undefined
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
    const response = await fetch(path, init);
    let receipt;
    try {
      receipt = await response.json();
    } catch {
      receipt = {};
    }
    if (!receipt || typeof receipt !== 'object') receipt = {};
    if (typeof receipt.ok !== 'boolean') receipt.ok = response.ok;
    if (!response.ok) receipt.ok = false;
    receipt.status = response.status;
    return receipt;
  }

  function localTransport() {
    return {
      mode: 'local',
      open: () => httpJson(ROUTES.open),
      saveBlock: (payload) => httpJson(ROUTES.block, payload),
      reorder: (payload) => httpJson(ROUTES.reorder, payload),
      feedback: (payload) => httpJson(ROUTES.feedback, payload),
      tasks: () => httpJson(ROUTES.tasks),
      conflicts: () => httpJson(ROUTES.conflicts),
      decide: (payload) => httpJson(ROUTES.decide, payload),
      // 同源，浏览器直接取；版本参数让换过文件的图不吃旧缓存。
      imageUrl: (path, version) => {
        const base = `/asset?path=${encodeURIComponent(path)}`;
        const stamp = typeof version === 'string' ? version.slice(0, 12) : '';
        return Promise.resolve(stamp ? `${base}&v=${encodeURIComponent(stamp)}` : base);
      },
    };
  }

  /* ---------------- 有插件：DSH 侧栏，走公共桥 ---------------- */

  function sidebarTransport(review) {
    // 宿主没有声明 command 时立刻说清原因：页面没有 /api 可退，静默失败只会看起来"坏了"。
    if (!Array.isArray(review.capabilities) || review.capabilities.indexOf('command') < 0) {
      throw Error('侧栏宿主没有声明 command：需要同步 planners-review-core，并让 Review Dock 允许 doc-workbench/1');
    }
    const call = async (op, payload) => {
      const receipt = await review.command({ op, ...(payload || {}) });
      if (!receipt || typeof receipt !== 'object') throw Error(`侧栏命令 ${op} 没有回执`);
      return receipt;
    };
    return {
      mode: 'sidebar',
      open: () => call('open'),
      saveBlock: (payload) => call('block', payload),
      reorder: (payload) => call('reorder', payload),
      tasks: () => call('tasks'),
      conflicts: () => call('conflicts'),
      decide: (payload) => call('decide', payload),
      async feedback(payload) {
        const receipt = await call('feedback', payload);
        const dispatch = receipt.dispatch || {};
        // 派发的出口由服务端按「有没有插件」分流：wake 由页面真正唤醒；inbox 已经落盘。
        if (receipt.ok && dispatch.channel === 'wake' && typeof review.wake === 'function') {
          try {
            await review.wake({ unit: receipt.task?.id, text: dispatch.text });
            receipt.dispatch = { ...dispatch, woke: true };
          } catch (error) {
            receipt.dispatch = { ...dispatch, error: error?.message ?? String(error) };
          }
        }
        return receipt;
      },
      // 不透明帧里子资源走不了 HTTP：桥把字节递进来，页面自己造 blob。
      imageUrl: (path, version) => review.asset(String(path), version ? { v: version } : undefined),
    };
  }

  async function connect() {
    if (bridgeUsable()) {
      const review = await globalThis.ReviewBridge.connect();
      return sidebarTransport(review);
    }
    return localTransport();
  }

  return { connect, ROUTES };
});
