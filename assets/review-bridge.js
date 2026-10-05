/*!
 * review-bridge.js —— 审阅页面与宿主之间唯一的说话方式（review-surface/2.0.0）
 *
 * 同一份代码，两种宿主：
 *   有插件：页面在 DSH 侧栏的 iframe 里（sandbox="allow-scripts"，不透明源）→ postMessage
 *   没插件：页面是公共模组起的本地服务器的顶层文档              → fetch
 *
 * 用法：
 *   const review = await ReviewBridge.connect()
 *   await review.write(payload)                 // 写进 surface 的 feedback 文件（**这是决定**）
 *   await review.draft(payload)                 // 写进 surface 的 draft 文件（**这是草稿**，不唤醒、模型不当它是收件）
 *   await review.wake({ unit: 'page-03' })      // 唤醒模型
 *   img.src = await review.asset('shots/page-03.png', { v: 'v2' })   // 资产：两种宿主都可用
 *   var snap = JSON.parse(await review.readText('state.json'))   // 取非图片资产（文本）
 *   review.on('changed', (payload) => …)      // 宿主推来的「变了」（payload 形状由 Skill 定，宿主不解释）
 *
 * 刻意不做的事：不碰 localStorage / sessionStorage（不透明源下会抛），不解释反馈的形状，
 * 不知道「页」「镜」「Beat」是什么。
 */
(function () {
  'use strict';

  var VERSION = '2.0.0';

  function nonce() {
    var bytes = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
    else for (var i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    return Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  function connect(options) {
    options = options || {};
    var inFrame = window.parent && window.parent !== window;

    return (inFrame ? postMessageTransport(options) : httpTransport(options));
  }

  /* ---------------- 宿主是插件：走 postMessage ---------------- */

  function postMessageTransport(options) {
    var myNonce = nonce();
    var seq = 0;
    var pending = {};
    var listeners = {};
    var hostAssetBase = './';
    var surfaceInfo = null;
    var capabilities = [];
    var assetCache = {};
    var settled = null;

    var sticky = {};
    function emit(event, payload) {
      // baseline 是"一次性、但可能早于页面订阅"的事件 —— 做成粘性：晚订阅的也补发
      if (event === 'baseline') sticky.baseline = payload;
      (listeners[event] || []).forEach(function (fn) {
        try { fn(payload); } catch (error) { if (window.console) console.error('[review-bridge]', error); }
      });
    }

    function send(message) {
      // targetOrigin 必须是 '*'：不透明源里拿不到父窗口的源，传具体值会直接 SyntaxError
      window.parent.postMessage(Object.assign({ __review: true, nonce: myNonce }, message), '*');
    }

    function call(method, payload) {
      return new Promise(function (resolve, reject) {
        var id = 'c' + (seq += 1);
        pending[id] = { resolve: resolve, reject: reject };
        send({ type: 'call', id: id, method: method, payload: payload });
        window.setTimeout(function () {
          if (pending[id]) { delete pending[id]; reject(new Error('review 宿主没有回应 ' + method + '（超时）')); }
        }, 30000);
      });
    }

    window.addEventListener('message', function (event) {
      var data = event.data;
      if (!data || data.__review !== true) return;
      // 反向防冒充：不透明源的 event.origin 是 "null"，不可鉴权；只能比对 source
      if (event.source !== window.parent) return;
      if (data.type === 'init') {
        if (data.nonce !== myNonce) return;
        hostAssetBase = data.assetBase || './';
        surfaceInfo = data.surface || null;
        capabilities = data.capabilities || [];
        if (settled) settled();
        emit('ready', { host: data.host || null, surface: surfaceInfo });
        return;
      }
      if (data.nonce !== myNonce) return;
      if (data.type === 'result') {
        var slot = pending[data.id];
        if (!slot) return;
        delete pending[data.id];
        if (data.ok) slot.resolve(data.value);
        else slot.reject(new Error(data.error || 'review 宿主拒绝了这次调用'));
        return;
      }
      // 规范拼法是 review/changed（宿主 → 页面的一条"戳"）。旧拼法 changed 容忍但会出声 ——
      // 静默不触发是这条线最坏的失败方式（曾经真的发生过：插件发 review/changed，桥只认 changed，
      // 页面一动不动，没有任何报错）。
      if (data.type === 'review/changed' || data.type === 'changed') {
        if (data.type === 'changed' && window.console && window.console.warn) {
          window.console.warn('[review-bridge] 收到旧拼法 "changed"；规范是 "review/changed"');
        }
        emit('changed', data.payload || { units: data.units || [] });
        return;
      }
      if (window.console && window.console.warn && typeof data.type === 'string' && data.type.indexOf('review/') === 0) {
        window.console.warn('[review-bridge] 不认识的宿主消息类型：' + data.type);
      }
    });

    var ready = new Promise(function (resolve) { settled = resolve; });
    send({ type: 'hello', bridge: VERSION, surface: options.surface || null });

    return ready.then(function () {
      return {
        transport: 'postMessage',
        bridgeVersion: VERSION,
        surface: surfaceInfo,
        capabilities: capabilities,
        // 资产在**不透明帧里不能直接走 HTTP**（实测：/api 下的子资源请求被判 cross-site → 403，且不带 cookie）。
        // 所以由父页面（同源、带 cookie）代取字节，postMessage 递进来，子帧自己造 blob。
        // 二进制走结构化克隆，不用 base64。
        asset: function (rel, extra) {
          var key = String(rel) + (extra && extra.v ? '?v=' + extra.v : '');
          if (!assetCache[key]) {
            assetCache[key] = call('asset', { rel: String(rel), v: (extra && extra.v) || null }).then(function (value) {
              var blob = new Blob([value.bytes], { type: value.type || 'application/octet-stream' });
              var url = URL.createObjectURL(blob);
              // 同一个 rel 的旧版本放开，别攒内存
              Object.keys(assetCache).forEach(function (other) {
                if (other !== key && other.indexOf(String(rel) + '?') === 0) {
                  assetCache[other].then(function (old) { try { URL.revokeObjectURL(old); } catch (e) { /* 已经没了 */ } });
                  delete assetCache[other];
                }
              });
              return url;
            });
          }
          return assetCache[key];
        },
        write: function (payload) { return call('write', payload); },
        draft: function (payload) {
          if (capabilities.indexOf('draft') < 0) return Promise.reject(new Error('这个宿主没有声明 draft 能力'));
          return call('draft', payload);
        },
        wake: function (payload) { return call('wake', payload || {}); },
        upload: function (file, rel) {
          if (capabilities.indexOf('asset-upload') < 0) return Promise.reject(new Error('这个宿主没有声明 asset-upload 能力'));
          return file.arrayBuffer().then(function (bytes) {
            return call('upload', { rel: rel, name: file.name || '', bytes: bytes });
          });
        },
        // 取原始字节（给 JSON 这类非图片资产用）。不动缓存：调用方自己决定怎么存。
        read: function (rel) {
          return call('read', { rel: String(rel) });
        },
        readText: function (rel) {
          return call('read', { rel: String(rel) }).then(function (value) {
            return new TextDecoder('utf-8').decode(new Uint8Array(value.bytes));
          });
        },
        on: function (event, handler) {
          (listeners[event] = listeners[event] || []).push(handler);
          if (event === 'baseline' && sticky.baseline) {
            try { handler(sticky.baseline); } catch (error) { if (window.console) console.error('[review-bridge]', error); }
          }
          return function () { listeners[event] = (listeners[event] || []).filter(function (f) { return f !== handler; }); };
        }
      };
    });
  }

  /* ---------------- 没有插件：走本地服务器 ---------------- */

  function httpTransport(options) {
    var listeners = {};
    var assetCache = {};
    var capabilities = (options && options.capabilities) || [];
    // 契约里页面的 `rel` 相对 `dir`，而**页面自己那一层不一定就是 dir**（第二家 video-craft
    // 的页面在 `<project>/review/` 下，dir 是项目根 → './' 会指向 /review/，与插件侧不一致）。
    // 所以宿主在注入桥的时候顺带注入真正的 base；没有就用页面自己那一层（页面就在 dir 根时两者相同）。
    var base = (typeof window.__REVIEW_BASE__ === 'string' && window.__REVIEW_BASE__ !== '')
      ? window.__REVIEW_BASE__
      : (options.base || './');
    var lastToken = null;

    var sticky = {};
    function emit(event, payload) {
      if (event === 'baseline') sticky.baseline = payload;
      (listeners[event] || []).forEach(function (fn) {
        try { fn(payload); } catch (error) { if (window.console) console.error('[review-bridge]', error); }
      });
    }

    function post(path, body) {
      return fetch(base + '__review/' + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {})
      }).then(function (response) {
        return response.json().then(function (value) {
          if (!response.ok || value.ok === false) throw new Error(value.error || ('本地审阅服务器返回 ' + response.status));
          return value;
        });
      });
    }

    // 没有插件就没有推送通道：轮询版本令牌，变了就告诉页面（页面自己决定要不要刷新）。
    // **第一次采样立刻做**：只建立基准，但它把"页面刚加载就改了文件"的窗口从 2 秒缩到毫秒 ——
    // 原来第一次采样要等 2 秒，那期间的变化永远不会被算成"变了"（实测踩到过，见 GOTCHAS 第 5 条）。
    function sample() {
      fetch(base + '__review/version', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (value) {
          if (lastToken === null) { lastToken = value.token; emit('baseline', { token: value.token }); return; }
          if (value.token !== lastToken) { lastToken = value.token; emit('changed', { units: null }); }
        })
        .catch(function () { /* 服务器关了就算了，别刷错误 */ });
    }
    sample();
    window.setInterval(sample, 2000);

    // 先问宿主支持什么能力，**再交出对象**。曾经不是这样：返回对象时取了当时的空数组，
    // 而后到的 fetch 重新绑定了变量（不是改数组内容），于是 review.capabilities 永远是 [] —— 
    // upload() 走闭包所以能用，属性却是空的（实测抓到过）。
    var capabilitiesReady = fetch(base + '__review/capabilities', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (value) { capabilities = value.capabilities || []; })
      .catch(function () { /* 拿不到就当作不支持 */ });

    return capabilitiesReady.then(function () { return {
      transport: 'http',
      bridgeVersion: VERSION,
      surface: null,
      capabilities: capabilities,
      // 没有插件时页面就是顶层文档，同源，资产直接走 HTTP（浏览器自己缓存）
      asset: function (rel, extra) {
        var url = base + String(rel);
        if (extra && extra.v) url += '?v=' + encodeURIComponent(String(extra.v));
        return Promise.resolve(url);
      },
      write: function (payload) { return post('write', payload); },
      draft: function (payload) {
        if (capabilities.indexOf('draft') < 0) return Promise.reject(new Error('这个宿主没有声明 draft 能力'));
        return post('draft', payload);
      },
      wake: function (payload) { return post('wake', payload || {}); },
      upload: function (file, rel) {
        if (capabilities.indexOf('asset-upload') < 0) return Promise.reject(new Error('这个宿主没有声明 asset-upload 能力'));
        return fetch(base + '__review/upload?rel=' + encodeURIComponent(rel), { method: 'POST', body: file })
          .then(function (response) {
            return response.json().then(function (value) {
              if (!response.ok || value.ok === false) throw new Error(value.error || ('上传失败 ' + response.status));
              return value;
            });
          });
      },
      // 同源，直接取
      read: function (rel) {
        return fetch(base + String(rel), { cache: 'no-store' }).then(function (r) { return r.arrayBuffer(); })
          .then(function (bytes) { return { bytes: bytes }; });
      },
      readText: function (rel) {
        return fetch(base + String(rel), { cache: 'no-store' }).then(function (r) { return r.text(); });
      },
      on: function (event, handler) {
        (listeners[event] = listeners[event] || []).push(handler);
        if (event === 'baseline' && sticky.baseline) {
          try { handler(sticky.baseline); } catch (error) { if (window.console) console.error('[review-bridge]', error); }
        }
        return function () { listeners[event] = (listeners[event] || []).filter(function (f) { return f !== handler; }); };
      }
    }; });
  }

  window.ReviewBridge = { connect: connect, VERSION: VERSION };
})();
