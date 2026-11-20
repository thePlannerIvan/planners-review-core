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
 *
 * 通道只有一套动作词汇：每次发 `{ route, body }`。`route` 是本地宿主那条路的动作名，
 * `body` 是本地服务器本来就会收到的原始请求体。本地页按 `route` 直接路由；侧栏桥只把
 * 这两个字段原样交给 `review.command(...)`，不翻译、也不另存一份动作名。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DocTransport = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 本地宿主的路由表：route 名与 `scripts/doc-workbench.mjs` 的动作一一对应。
  // 侧栏桥不复制这张表 —— 它只转发 route 与 body。
  const ROUTES = {
    open: '/api/doc',
    block: '/api/block',
    split: '/api/block/split',
    merge: '/api/block/merge',
    reorder: '/api/reorder',
    asset_replace: '/api/asset/replace',
    feedback: '/api/feedback',
    tasks: '/api/tasks',
    conflicts: '/api/conflicts',
    decide: '/api/conflict/decide',
    history: '/api/history',
    restore: '/api/history/restore',
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
    const send = (route, body) => httpJson(ROUTES[route], body);
    return {
      mode: 'local',
      send,
      open: () => send('open'),
      saveBlock: (body) => send('block', body),
      splitBlock: (body) => send('split', body),
      mergeBlock: (body) => send('merge', body),
      reorder: (body) => send('reorder', body),
      replaceAsset: (body) => send('asset_replace', body),
      feedback: (body) => send('feedback', body),
      tasks: () => send('tasks'),
      conflicts: () => send('conflicts'),
      decide: (body) => send('decide', body),
      history: () => send('history'),
      restore: (body) => send('restore', body),
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
    // 桥没有自己的动作词汇表：`{route, body}` 原样转发，白名单在传输层检查 route。
    const send = async (route, body) => {
      const receipt = await review.command({ route, body: body || {} });
      if (!receipt || typeof receipt !== 'object') throw Error(`侧栏命令 ${route} 没有回执`);
      return receipt;
    };
    return {
      mode: 'sidebar',
      send,
      open: () => send('open'),
      saveBlock: (body) => send('block', body),
      splitBlock: (body) => send('split', body),
      mergeBlock: (body) => send('merge', body),
      reorder: (body) => send('reorder', body),
      replaceAsset: (body) => send('asset_replace', body),
      tasks: () => send('tasks'),
      conflicts: () => send('conflicts'),
      decide: (body) => send('decide', body),
      history: () => send('history'),
      restore: (body) => send('restore', body),
      async feedback(payload) {
        const receipt = await send('feedback', payload);
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
