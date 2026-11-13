/*!
 * annotate.js —— 叠在任意 HTML 产物上的一层人工批注（artifact-annotations/1）
 *
 * 四件事，都只产出"人能读、模型能动手"的结构，不接管产物本身：
 *   1. 直接改正文 —— 点正文就能改，提交时给出 before / after / 逐字 ops
 *   2. 点选元素   —— 最短唯一选择器 + 索引路径 + 文本 + 章节 + 页面坐标
 *   3. 框选区域   —— 矩形 + 被框住的元素清单（子元素被全覆盖时收成父容器）+ 区域文本
 *   4. 选中文字   —— quote + 前后 40 字 + 字符偏移，供选择器失配时重新锚定
 *
 * 传输只走 planners-review-core 的桥：
 *   review.write(payload)   落成 surface 的 feedback 文件（这是决定）
 *   review.draft(payload)   未提交的草稿（刷新可恢复，模型不当收件）
 *   review.wake({unit})     只在提交时唤醒模型
 * 没有宿主时（双击打开）不报错：页面照常能批注，提交给出可复制的 JSON。
 *
 * 注入方式（宿主侧）：
 *   页面留一个裸的 REVIEW_ANNOTATE 标记（双花括号、独占一行）→ 原地换成内联源码；
 *   没留 → 宿主在 </body> 前追加。桥可能先注或后注，所以握手会重试。
 *   （这里不写标记字面量：内联之后它会把标记又带进页面，让"标记是否还在"这种检查失真。）
 *
 * 刻意不做的事：
 *   · 不碰 localStorage（不透明源里会抛）
 *   · 不改产物 DOM（唯一例外：编辑模式下给叶子文字块临时加 contenteditable）
 *   · 不截图（区域批注给元素与文本，不给人眼看的图）
 *   · 不解释"页/镜/Beat"是什么 —— 那是 Skill 的事
 */
(function () {
  'use strict';

  var VERSION = '0.1.0';
  var CONTRACT = 'artifact-annotations/1';
  var HOST_ID = 'ra-host';

  /* ============================== 小工具 ============================== */

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function oneLine(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

  function clip(s, n) {
    s = oneLine(s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function debounce(fn, ms) {
    var timer = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  function isTypingTarget(node) {
    if (!node) return false;
    if (node.isContentEditable) return true;
    return /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName || '');
  }

  /* ============================== 选择器 / 锚点 ============================== */

  var BLOCK_SEL = 'h1,h2,h3,h4,h5,h6,p,li,td,th,blockquote,figcaption,dt,dd,pre,code,figure,img,svg,table,tr';
  var EDIT_TAGS = 'h1,h2,h3,h4,h5,h6,p,li,td,th,blockquote,figcaption,dt,dd,pre';

  function stableClasses(el) {
    var out = [];
    Array.prototype.forEach.call(el.classList || [], function (c) {
      if (out.length >= 2) return;
      if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,30}$/.test(c)) return;
      if (c.indexOf('ra-') === 0) return;
      // 构建产物里常见 hash 类名（css-module），不拿来做锚点
      if (/^[a-z]+[-_]?[0-9a-f]{5,}$/i.test(c)) return;
      out.push(c);
    });
    return out;
  }

  function segment(el) {
    var tag = el.tagName.toLowerCase();
    var cls = stableClasses(el).map(function (c) { return '.' + c; }).join('');
    // 同名兄弟只要多于一个就写 nth-of-type —— 只给 index>1 的加，会让"第一个"永远没编号，
    // 于是 `section > p` 这种选择器在多段文档里根本不唯一（实测踩到过）。
    var index = 1, total = 1, sib = el;
    while ((sib = sib.previousElementSibling)) {
      if (sib.tagName === el.tagName) index += 1;
    }
    sib = el.nextElementSibling;
    while (sib) { if (sib.tagName === el.tagName) total += 1; sib = sib.nextElementSibling; }
    return tag + cls + (total > 1 ? ':nth-of-type(' + index + ')' : '');
  }

  function isUnique(sel) {
    try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; }
  }

  /** 最短的、在文档里唯一的 CSS 选择器。找不到就退到带 nth-of-type 的路径。 */
  function buildSelector(el) {
    if (!el || el === document.body) return 'body';
    if (el === document.documentElement) return 'html';
    if (el.id && isUnique('#' + CSS.escape(el.id))) return '#' + CSS.escape(el.id);

    var dataAttr = null;
    Array.prototype.forEach.call(el.attributes || [], function (a) {
      if (dataAttr) return;
      if (/^data-(block|block-id|id|key|unit|page|section|ref|el|name|type)$/i.test(a.name) &&
          a.value && a.value.length < 64 && /^[\w.:-]+$/.test(a.value)) {
        dataAttr = a;
      }
    });
    if (dataAttr) {
      var attrSel = '[' + dataAttr.name + '="' + dataAttr.value.replace(/"/g, '\\"') + '"]';
      if (isUnique(attrSel)) return attrSel;
    }

    // 爬到"够用"为止：既要求唯一，也要求带上一个结构性祖先（section / article / main），
    // 否则 `p:nth-of-type(2)` 这种"唯一但没上下文"的锚点在产物重新生成后会指到别处。
    var LANDMARK = /^(MAIN|SECTION|ARTICLE|NAV|ASIDE|HEADER|FOOTER|FIGCAPTION|TABLE)$/;
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      parts.unshift(segment(node));
      var sel = parts.join(' > ');
      if (isUnique(sel) && (node === document.body || LANDMARK.test(node.tagName))) return sel;
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  /** 机读的索引路径（body 下第 0 层起）：给"选择器失配"时留一条退路。 */
  function indexPath(el) {
    var parts = [];
    var node = el;
    while (node && node !== document.body && node.parentElement) {
      parts.unshift(Array.prototype.indexOf.call(node.parentElement.children, node));
      node = node.parentElement;
    }
    return parts.join('/');
  }

  function sectionOf(el) {
    var headings = Array.prototype.slice.call(document.querySelectorAll('h1,h2,h3,h4,h5,h6'));
    var found = '';
    headings.forEach(function (h) {
      if (h === el || h.contains(el)) return;
      if (!(h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) return;
      if (h.getBoundingClientRect().width === 0) return;
      found = oneLine(h.textContent);
    });
    return clip(found, 80);
  }

  function rectOfElement(el) {
    var r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left + window.scrollX),
      y: Math.round(r.top + window.scrollY),
      w: Math.round(r.width),
      h: Math.round(r.height)
    };
  }

  function describeElement(el) {
    var tag = el.tagName.toLowerCase();
    var cls = Array.prototype.slice.call(el.classList || []).slice(0, 2).map(function (c) { return '.' + c; }).join('');
    if (cls || !el.parentElement) return tag + cls;
    // 自己没有类名时借父级一层，`b` 这种标签名单独看没有意义
    var parent = el.parentElement;
    var pcls = Array.prototype.slice.call(parent.classList || []).slice(0, 1).map(function (c) { return '.' + c; }).join('');
    return parent.tagName.toLowerCase() + pcls + ' > ' + tag;
  }

  function targetOf(el, extra) {
    var base = {
      selector: buildSelector(el),
      path: indexPath(el),
      tag: el.tagName.toLowerCase(),
      label: describeElement(el),
      text: clip(el.innerText || el.textContent, 120),
      section: sectionOf(el),
      rect: rectOfElement(el)
    };
    if (extra) Object.keys(extra).forEach(function (k) { base[k] = extra[k]; });
    return base;
  }

  /* ---------- 文字范围锚点（类似 Hypothesis 的三件套） ---------- */

  function blockOf(node) {
    var el = node && node.nodeType === 1 ? node : (node && node.parentElement);
    if (!el || !el.closest) return null;
    return el.closest(BLOCK_SEL);
  }

  function offsetIn(root, node, offset) {
    var range = document.createRange();
    range.selectNodeContents(root);
    try { range.setEnd(node, offset); } catch (e) { return 0; }
    return range.toString().length;
  }

  function rangeAnchor(range) {
    var root = blockOf(range.startContainer);
    var rootEnd = blockOf(range.endContainer);
    if (!root) return null;
    if (rootEnd && rootEnd !== root && !root.contains(rootEnd)) root = range.commonAncestorContainer;
    if (root.nodeType !== 1) root = root.parentElement;
    var text = root.textContent || '';
    var start = offsetIn(root, range.startContainer, range.startOffset);
    var end = offsetIn(root, range.endContainer, range.endOffset);
    if (end < start) { var tmp = start; start = end; end = tmp; }
    return {
      el: root,
      start: start,
      end: end,
      quote: clip(text.slice(start, end), 400),
      prefix: text.slice(Math.max(0, start - 40), start),
      suffix: text.slice(end, end + 40)
    };
  }

  /* ============================== 逐字 diff ============================== */

  /** 只留标签骨架：文本节点被切分不算"标记被改坏"。 */
  function fingerprint(html) {
    return String(html).replace(/>[^<]*</g, '><').replace(/\s+/g, ' ');
  }

  function pushOp(ops, type, text) {
    if (!text) return;
    var last = ops[ops.length - 1];
    if (last && last.t === type) last.v += text;
    else ops.push({ t: type, v: text });
  }

  function lcsOps(a, b) {
    if (!a) return b ? [{ t: 'ins', v: b }] : [];
    if (!b) return [{ t: 'del', v: a }];
    if (a.length * b.length > 1000000) return [{ t: 'del', v: a }, { t: 'ins', v: b }];
    var n = a.length, m = b.length, width = m + 1;
    var dp = new Int32Array((n + 1) * width);
    for (var i = n - 1; i >= 0; i -= 1) {
      for (var j = m - 1; j >= 0; j -= 1) {
        dp[i * width + j] = a[i] === b[j]
          ? dp[(i + 1) * width + (j + 1)] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
      }
    }
    var ops = [], x = 0, y = 0;
    while (x < n || y < m) {
      if (x < n && y < m && a[x] === b[y]) { pushOp(ops, 'keep', a[x]); x += 1; y += 1; }
      else if (y < m && (x >= n || dp[x * width + (y + 1)] >= dp[(x + 1) * width + y])) { pushOp(ops, 'ins', b[y]); y += 1; }
      else { pushOp(ops, 'del', a[x]); x += 1; }
    }
    return ops;
  }

  /** 先剥掉公共前后缀，中间再做 LCS —— 人工改几个字时中间很小。 */
  function diffOps(before, after) {
    var p = 0;
    while (p < before.length && p < after.length && before[p] === after[p]) p += 1;
    var s = 0;
    while (s < before.length - p && s < after.length - p &&
           before[before.length - 1 - s] === after[after.length - 1 - s]) s += 1;
    var head = before.slice(0, p);
    var midA = before.slice(p, before.length - s);
    var midB = after.slice(p, after.length - s);
    var tail = before.slice(before.length - s);
    var ops = [];
    pushOp(ops, 'keep', head);
    lcsOps(midA, midB).forEach(function (op) { pushOp(ops, op.t, op.v); });
    pushOp(ops, 'keep', tail);
    return ops;
  }

  /* ============================== 样式 ============================== */

  var CSS = [
    ':host{',
    '  --ra-accent: var(--dsw-static-blue-500, #3b82f6);',
    '  --ra-accent-ink: var(--dsw-static-blue-600, #2563eb);',
    '  --ra-ink: var(--dsw-alias-label-primary, #101828);',
    '  --ra-ink-2: var(--dsw-alias-label-secondary, #667085);',
    '  --ra-ink-3: var(--dsw-alias-label-tertiary, #98a2b3);',
    '  --ra-bg: var(--dsw-alias-bg-base, #fff);',
    '  --ra-surface: var(--dsw-alias-bg-layer-2, #f9fafb);',
    '  --ra-border: var(--dsw-alias-border-l2, rgba(16,24,40,.12));',
    '  --ra-shadow: 0 8px 28px rgba(16,24,40,.14), 0 1px 2px rgba(16,24,40,.08);',
    '  font-family: var(--dsw-font-family-text-default, -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif);',
    '  font-size: 13px; color: var(--ra-ink);',
    '  -webkit-font-smoothing: antialiased;',
    '}',
    '*{box-sizing:border-box}',
    '.boxes{position:fixed;inset:0;pointer-events:none;z-index:1}',
    '.box{position:fixed;border:1.5px solid var(--ra-accent);border-radius:3px;',
    '  background:color-mix(in srgb, var(--ra-accent) 6%, transparent)}',
    '.box.region{border-style:dashed;background:color-mix(in srgb, var(--ra-accent) 4%, transparent)}',
    '.box.edit{border-color:var(--ra-accent);border-style:dashed;background:transparent;opacity:.8}',
    '.box.hover{border-style:solid;background:transparent}',
    '.pin{position:fixed;z-index:3;min-width:18px;height:18px;padding:0 4px;border-radius:999px;',
    '  background:var(--ra-accent);color:#fff;font:600 10.5px/18px inherit;text-align:center;',
    '  pointer-events:auto;cursor:pointer;border:1.5px solid var(--ra-bg);',
    '  box-shadow:0 1px 4px rgba(16,24,40,.24)}',

    '.marquee{position:fixed;z-index:2;border:1px dashed var(--ra-accent);border-radius:2px;',
    '  background:color-mix(in srgb, var(--ra-accent) 6%, transparent);pointer-events:none}',
    '.bar{position:fixed;left:50%;bottom:12px;transform:translateX(-50%);z-index:6;',
    '  display:flex;align-items:center;gap:1px;padding:3px;max-width:calc(100vw - 16px);',
    '  background:color-mix(in srgb, var(--ra-bg) 92%, transparent);backdrop-filter:blur(14px);',
    '  border:1px solid var(--ra-border);border-radius:999px;box-shadow:var(--ra-shadow);pointer-events:auto}',
    '.bar button{height:28px;padding:0 10px;border:0;border-radius:999px;background:transparent;',
    '  color:var(--ra-ink-2);font:500 12px/1 inherit;font-family:inherit;cursor:pointer;white-space:nowrap}',
    '.bar button:hover{background:color-mix(in srgb, var(--ra-ink) 5%, transparent);color:var(--ra-ink)}',
    '.bar button[data-mode][aria-pressed="true"]{background:var(--ra-ink);color:var(--ra-bg)}',
    '.bar button[data-mode][aria-pressed="true"]:hover{background:var(--ra-ink);color:var(--ra-bg)}',
    '.bar .count[aria-pressed="true"]{background:color-mix(in srgb, var(--ra-ink) 7%, transparent);color:var(--ra-ink)}',
    '.bar .sep{width:1px;height:16px;background:var(--ra-border);margin:0 3px;flex:none}',
    '.bar .count{color:var(--ra-ink-3)}',
    '.bar .count b{color:inherit;font-weight:600;font-variant-numeric:tabular-nums}',
    '.bar .submit{background:var(--ra-ink);color:var(--ra-bg)}',
    '.bar .submit:hover{background:var(--ra-ink);color:var(--ra-bg);opacity:.9}',
    '.bar .submit[disabled]{opacity:.3;cursor:default}',
    '.hint{position:fixed;left:50%;bottom:52px;transform:translateX(-50%);z-index:5;pointer-events:none;',
    '  font:400 11.5px/1.5 inherit;color:var(--ra-ink-2);background:color-mix(in srgb, var(--ra-bg) 94%, transparent);',
    '  border:1px solid var(--ra-border);padding:3px 10px;border-radius:999px;white-space:nowrap;',
    '  max-width:calc(100vw - 24px);overflow:hidden;text-overflow:ellipsis}',
    '.hint[hidden]{display:none}',
    '.bubble{position:fixed;z-index:6;pointer-events:auto;display:inline-flex;align-items:center;',
    '  height:26px;padding:0 10px;border-radius:999px;border:0;',
    '  background:var(--ra-ink);color:var(--ra-bg);font:500 12px/1 inherit;cursor:pointer;box-shadow:var(--ra-shadow)}',
    '.bubble[hidden]{display:none}',
    '.pop{position:fixed;z-index:8;width:min(300px,calc(100vw - 16px));padding:9px;',
    '  background:var(--ra-bg);border:1px solid var(--ra-border);border-radius:12px;box-shadow:var(--ra-shadow);pointer-events:auto}',
    '.pop-quote{margin:0 0 7px;padding:4px 8px;border-left:2px solid var(--ra-accent);background:var(--ra-surface);',
    '  border-radius:0 5px 5px 0;font:400 11.5px/1.6 inherit;color:var(--ra-ink-2);max-height:58px;overflow:auto;white-space:pre-wrap}',
    '.pop textarea{width:100%;min-height:58px;max-height:180px;resize:none;display:block;padding:7px 9px;',
    '  border:1px solid var(--ra-border);border-radius:8px;background:var(--ra-surface);color:var(--ra-ink);',
    '  font:400 13px/1.55 inherit;outline:none;-webkit-appearance:none}',
    '.pop textarea:focus{border-color:var(--ra-accent);background:var(--ra-bg)}',
    '.pop-foot{display:flex;align-items:center;justify-content:flex-end;gap:6px;margin-top:7px}',
    '.pop-foot button{height:27px;padding:0 12px;border-radius:7px;border:1px solid var(--ra-border);background:transparent;',
    '  color:var(--ra-ink-2);font:500 12px/1 inherit;cursor:pointer}',
    '.pop-foot button:hover{color:var(--ra-ink);border-color:var(--ra-ink-3)}',
    '.pop-foot .save{background:var(--ra-ink);border-color:var(--ra-ink);color:var(--ra-bg)}',
    '.pop-foot .save:hover{opacity:.9;color:var(--ra-bg)}',
    '.sheet{position:fixed;left:8px;right:8px;bottom:50px;z-index:7;max-height:42vh;display:none;flex-direction:column;',
    '  background:var(--ra-bg);border:1px solid var(--ra-border);border-radius:14px;box-shadow:var(--ra-shadow);pointer-events:auto;overflow:hidden}',
    '.sheet.open{display:flex}',
    '.sheet-head{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--ra-border);',
    '  font:600 12px/1 inherit;color:var(--ra-ink);flex:none}',
    '.sheet-head .meta{margin-left:auto;font:400 11px/1 inherit;color:var(--ra-ink-3)}',
    '.sheet-head button{border:0;background:transparent;color:var(--ra-ink-3);font:400 11.5px/1 inherit;cursor:pointer;padding:3px 4px;border-radius:4px}',
    '.sheet-head button:hover{background:var(--ra-surface);color:var(--ra-ink)}',
    '.sheet-list{overflow:auto;padding:5px;display:flex;flex-direction:column;gap:4px}',
    '.card{display:flex;gap:8px;padding:8px 8px 8px 9px;border-radius:9px;background:var(--ra-surface)}',
    '.card .badge{flex:none;width:18px;height:18px;border-radius:5px;background:var(--ra-accent);color:#fff;',
    '  font:600 10.5px/18px inherit;text-align:center}',
    '.card.edit .badge{background:var(--ra-ink-3)}',
    '.card .body{min-width:0;flex:1}',
    '.card .txt{font:400 12.5px/1.55 inherit;color:var(--ra-ink);white-space:pre-wrap;word-break:break-word}',
    '.card .quote{margin-bottom:2px;font:400 11.5px/1.5 inherit;color:var(--ra-ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.card .acts{display:flex;flex-direction:column;gap:1px;flex:none}',
    '.card .acts button{border:0;background:transparent;color:var(--ra-ink-3);font:400 11px/1 inherit;cursor:pointer;padding:2px 3px;border-radius:4px}',
    '.card .acts button:hover{background:var(--ra-bg);color:var(--ra-ink)}',
    '.empty{padding:18px 12px;text-align:center;font:400 12px/1.7 inherit;color:var(--ra-ink-3)}',
    '.notice{position:fixed;left:8px;right:8px;top:8px;z-index:9;display:flex;align-items:center;gap:8px;',
    '  padding:7px 10px;background:var(--ra-bg);border:1px solid var(--ra-border);border-radius:10px;',
    '  box-shadow:var(--ra-shadow);font:400 12px/1.45 inherit;color:var(--ra-ink);pointer-events:auto}',
    '.notice[hidden]{display:none}',
    '.notice .msg{flex:1;min-width:0}',
    '.notice button{flex:none;height:24px;padding:0 9px;border-radius:6px;border:1px solid var(--ra-border);',
    '  background:transparent;color:var(--ra-ink-2);font:500 11.5px/1 inherit;cursor:pointer}',
    '.notice button.primary{background:var(--ra-ink);border-color:var(--ra-ink);color:var(--ra-bg)}',
    '.toast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:9;pointer-events:none;',
    '  padding:6px 12px;border-radius:999px;background:var(--ra-ink);color:var(--ra-bg);font:500 12px/1.4 inherit;',
    '  box-shadow:var(--ra-shadow);opacity:0;transition:opacity .18s ease,transform .18s ease;max-width:calc(100vw - 24px);text-align:center}',
    '.toast.show{opacity:1;transform:translateX(-50%) translateY(-3px)}',
    '.toast.raised{bottom:calc(42vh + 60px)}',
    '.toast.err{background:#b42318}',
    '.modal{position:fixed;inset:0;z-index:10;display:none;align-items:center;justify-content:center;padding:16px;',
    '  background:rgba(16,24,40,.4);pointer-events:auto}',
    '.modal.open{display:flex}',
    '.modal-card{width:100%;max-width:560px;max-height:80vh;display:flex;flex-direction:column;background:var(--ra-bg);',
    '  border-radius:14px;box-shadow:var(--ra-shadow);overflow:hidden}',
    '.modal-card h3{margin:0;padding:12px 14px;border-bottom:1px solid var(--ra-border);font:600 13px/1.4 inherit}',
    '.modal-card textarea{flex:1;min-height:240px;border:0;padding:12px 14px;font:400 11.5px/1.6 ui-monospace,Menlo,monospace;',
    '  background:var(--ra-bg);color:var(--ra-ink);resize:none;outline:none}',
    '.modal-card footer{display:flex;gap:8px;justify-content:flex-end;padding:10px 14px;border-top:1px solid var(--ra-border)}',
    '.modal-card footer button{height:30px;padding:0 14px;border-radius:8px;border:1px solid var(--ra-border);background:transparent;',
    '  color:var(--ra-ink);font:500 12px/1 inherit;cursor:pointer}',
    '.modal-card footer .primary{background:var(--ra-ink);border-color:var(--ra-ink);color:var(--ra-bg)}'
  ].join('\n');

  /* ============================== 主体 ============================== */

  function mount(options) {
    options = options || {};
    if (document.getElementById(HOST_ID)) return window.ReviewAnnotate;

    var host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-ra-root', '');
    host.style.cssText = [
      'position:fixed', 'left:0', 'top:0', 'right:0', 'bottom:0',
      'z-index:2147483000', 'pointer-events:none', 'isolation:isolate'
    ].join(';');
    document.body.appendChild(host);

    var shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = [
      '<style>' + CSS + '</style>',
      '<div class="boxes" part="boxes"></div>',
      '<div class="hint" part="hint" hidden></div>',
      '<div class="marquee" part="marquee" hidden></div>',
      '<div class="bubble" part="bubble" hidden>批注</div>',
      '<div class="pop" part="pop" hidden></div>',
      '<div class="sheet" part="sheet">',
      '  <div class="sheet-head"><span class="title">批注</span><span class="meta"></span>',
      '    <button data-act="clear" type="button">清空</button>',
      '    <button data-act="close-sheet" type="button">收起</button>',
      '  </div>',
      '  <div class="sheet-list"></div>',
      '</div>',
      '<div class="bar" part="bar" role="toolbar" aria-label="批注工具">',
      '  <button type="button" data-mode="browse" aria-pressed="true" title="浏览（1）">浏览</button>',
      '  <button type="button" data-mode="edit" aria-pressed="false" title="直接改正文（2）">编辑</button>',
      '  <button type="button" data-mode="element" aria-pressed="false" title="点选元素（3）">点选</button>',
      '  <button type="button" data-mode="region" aria-pressed="false" title="框选区域（4）">框选</button>',
      '  <span class="sep"></span>',
      '  <button type="button" class="count" data-act="sheet" aria-pressed="false">批注 <b>0</b></button>',
      '  <button type="button" class="submit" data-act="submit" disabled>提交</button>',
      '</div>',
      '<div class="notice" part="notice" hidden></div>',
      '<div class="toast" part="toast" role="status" aria-live="polite"></div>',
      '<div class="modal" part="modal">',
      '  <div class="modal-card">',
      '    <h3>没有连接审阅宿主 —— 复制这段 JSON 交回对话</h3>',
      '    <textarea readonly spellcheck="false"></textarea>',
      '    <footer><button data-act="close-modal" type="button">关闭</button>',
      '      <button class="primary" data-act="copy" type="button">复制</button></footer>',
      '  </div>',
      '</div>'
    ].join('\n');

    var refs = {
      boxes: shadow.querySelector('.boxes'),
      hint: shadow.querySelector('.hint'),
      marquee: shadow.querySelector('.marquee'),
      bubble: shadow.querySelector('.bubble'),
      pop: shadow.querySelector('.pop'),
      sheet: shadow.querySelector('.sheet'),
      sheetList: shadow.querySelector('.sheet-list'),
      sheetMeta: shadow.querySelector('.sheet-meta') || shadow.querySelector('.sheet-head .meta'),
      bar: shadow.querySelector('.bar'),
      notice: shadow.querySelector('.notice'),
      toast: shadow.querySelector('.toast'),
      modal: shadow.querySelector('.modal'),
      modalText: shadow.querySelector('.modal textarea')
    };

    var state = {
      mode: 'browse',
      annotations: [],
      edits: new Map(),          // HTMLElement -> { el, before, after, ops, beforeHtml, afterHtml }
      originals: new Map(),      // HTMLElement -> { text, html }
      seq: 0,
      hoverEl: null,
      drag: null,
      pending: null,             // { kind, el?, range?, region?, rect? }
      bridge: null,
      host: 'none',
      capabilities: [],
      sheetOpen: false,
      connected: false,
      baseVersion: null,
      bundleId: '',
      loadedAt: new Date().toISOString(),
      draftStale: false
    };

    var els = [];
    var rafId = 0;

    /* ---------------- 渲染 ---------------- */

    function schedulePaint() {
      if (rafId) return;
      rafId = requestAnimationFrame(function () {
        rafId = 0;
        paint();
      });
    }

    function unionRects(list) {
      if (!list || !list.length) return null;
      var out = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
      Array.prototype.forEach.call(list, function (r) {
        if (!r.width && !r.height) return;
        out.left = Math.min(out.left, r.left);
        out.top = Math.min(out.top, r.top);
        out.right = Math.max(out.right, r.right);
        out.bottom = Math.max(out.bottom, r.bottom);
      });
      if (out.left === Infinity) return null;
      out.width = out.right - out.left;
      out.height = out.bottom - out.top;
      return out;
    }

    function viewportRectsOf(a) {
      if (a.kind === 'region') {
        var doc = a.region;
        return [{
          left: doc.x - window.scrollX,
          top: doc.y - window.scrollY,
          width: doc.w,
          height: doc.h
        }];
      }
      if (a.range && a.range.startContainer && a.range.startContainer.isConnected) {
        var list = a.range.getClientRects();
        var merged = unionRects(list);
        // 多行时给出每一行的小框，单行给一个整框
        if (list.length > 1) return Array.prototype.slice.call(list).filter(function (r) { return r.width > 1; });
        if (merged) return [merged];
      }
      if (a.el && a.el.isConnected) {
        var r = a.el.getBoundingClientRect();
        if (r.width || r.height) return [r];
      }
      if (a.rect) {
        return [{
          left: a.rect.x - window.scrollX,
          top: a.rect.y - window.scrollY,
          width: a.rect.w,
          height: a.rect.h
        }];
      }
      return [];
    }

    function placeBox(rect, cls) {
      var box = document.createElement('div');
      box.className = 'box ' + (cls || '');
      box.style.left = rect.left + 'px';
      box.style.top = rect.top + 'px';
      box.style.width = rect.width + 'px';
      box.style.height = rect.height + 'px';
      refs.boxes.appendChild(box);
      return box;
    }

    function paint() {
      refs.boxes.textContent = '';

      state.annotations.forEach(function (a, index) {
        var rects = viewportRectsOf(a);
        if (!rects.length) return;
        var cls = a.kind === 'region' ? 'region' : (a.kind === 'text-edit' ? 'edit' : '');
        rects.forEach(function (r) { placeBox(r, cls); });
        var first = rects[0];
        var pin = document.createElement('div');
        pin.className = 'pin';
        // 标号放在框外左上角：压在正文上会挡住人正要读的那几个字
        pin.style.left = Math.max(10, first.left - 2) + 'px';
        pin.style.top = Math.max(12, first.top - 2) + 'px';
        pin.style.transform = 'translate(-100%,-100%)';
        pin.textContent = String(index + 1);
        pin.dataset.annotationId = a.id;
        pin.title = a.comment || (a.kind === 'text-edit' ? '正文改动' : '');
        refs.boxes.appendChild(pin);
      });

      // 编辑模式里给“改过但还没提交”的块画虚框
      state.edits.forEach(function (edit) {
        if (!edit.el.isConnected) return;
        var r = edit.el.getBoundingClientRect();
        if (!r.width && !r.height) return;
        placeBox(r, 'edit');
      });

      if (state.hoverEl && state.hoverEl.isConnected && state.mode === 'element') {
        var hr = state.hoverEl.getBoundingClientRect();
        placeBox(hr, 'hover');
      }

      if (state.drag && state.drag.active) {
        var d = state.drag;
        var left = Math.min(d.x0, d.x1), top = Math.min(d.y0, d.y1);
        var w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
        refs.marquee.hidden = false;
        refs.marquee.style.left = left + 'px';
        refs.marquee.style.top = top + 'px';
        refs.marquee.style.width = w + 'px';
        refs.marquee.style.height = h + 'px';
      } else {
        refs.marquee.hidden = true;
      }
    }

    /* ---------------- 批注列表 / 提交按钮 ---------------- */

    function totalCount() {
      return state.annotations.length + state.edits.size;
    }

    function refreshChrome() {
      var count = totalCount();
      var badge = refs.bar.querySelector('.count b');
      if (badge) badge.textContent = String(count);
      var submit = refs.bar.querySelector('.submit');
      if (submit) submit.disabled = count === 0;
      var title = refs.sheet.querySelector('.title');
      if (title) title.textContent = '批注 ' + count;
      if (refs.sheetMeta) {
        refs.sheetMeta.textContent = state.connected ? '' : '未连接宿主';
      }
      paint();
    }

    /** 人眼可读的一行改动：只取增/删的那几段，不搬整段前后文。 */
    function editPreview(edit) {
      var removed = '', added = '';
      edit.ops.forEach(function (op) {
        if (op.t === 'del') removed += op.v;
        else if (op.t === 'ins') added += op.v;
      });
      removed = clip(removed, 42);
      added = clip(added, 42);
      if (removed && added) return '− ' + removed + '   →   + ' + added;
      if (added) return '+ ' + added;
      if (removed) return '− ' + removed;
      return '（内容有变化）';
    }

    function kindLabel(kind) {
      return {
        element: '点选',
        region: '框选',
        'text-comment': '文字',
        'text-edit': '改动'
      }[kind] || kind;
    }

    function renderSheet() {
      var items = state.annotations.slice();
      var edits = Array.from(state.edits.values());
      refs.sheetList.textContent = '';

      if (!items.length && !edits.length) {
        var empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = '还没有批注。点「点选」「框选」，或选中一句话写意见。';
        refs.sheetList.appendChild(empty);
        return;
      }

      function makeCard(options) {
        var card = document.createElement('div');
        card.className = 'card' + (options.edit ? ' edit' : '');
        if (options.annotationId) card.dataset.annotationId = options.annotationId;
        if (options.editKey !== undefined) card.dataset.editKey = String(options.editKey);

        var badge = document.createElement('div');
        badge.className = 'badge';
        badge.textContent = options.badge;

        var body = document.createElement('div');
        body.className = 'body';
        if (options.quote) {
          var quote = document.createElement('div');
          quote.className = 'quote';
          quote.textContent = options.quote;
          body.appendChild(quote);
        }
        var txt = document.createElement('div');
        txt.className = 'txt';
        txt.textContent = options.text;
        body.appendChild(txt);

        var acts = document.createElement('div');
        acts.className = 'acts';
        var jump = document.createElement('button');
        jump.type = 'button';
        jump.textContent = '定位';
        jump.dataset.act = options.jumpAction;
        var del = document.createElement('button');
        del.type = 'button';
        del.textContent = options.removeLabel;
        del.dataset.act = options.removeAction;
        acts.appendChild(jump);
        acts.appendChild(del);

        card.appendChild(badge);
        card.appendChild(body);
        card.appendChild(acts);
        return card;
      }

      items.forEach(function (a, index) {
        refs.sheetList.appendChild(makeCard({
          badge: String(index + 1),
          annotationId: a.id,
          quote: a.kind === 'text-comment' ? clip(a.quote.text, 42) : '',
          text: a.comment,
          jumpAction: 'jump',
          removeAction: 'delete',
          removeLabel: '删除'
        }));
      });

      edits.forEach(function (edit, index) {
        if (!edit.el.isConnected) return;
        refs.sheetList.appendChild(makeCard({
          badge: '改',
          edit: true,
          editKey: index,
          text: editPreview(edit),
          jumpAction: 'jump-edit',
          removeAction: 'revert-edit',
          removeLabel: '撤销'
        }));
      });
    }

    function openSheet(open) {
      state.sheetOpen = typeof open === 'boolean' ? open : !state.sheetOpen;
      refs.sheet.classList.toggle('open', state.sheetOpen);
      refs.toast.classList.toggle('raised', state.sheetOpen);
      refs.bar.querySelector('[data-act="sheet"]').setAttribute('aria-pressed', String(state.sheetOpen));
      if (state.sheetOpen) renderSheet();
    }

    function toast(message, kind) {
      refs.toast.textContent = message;
      refs.toast.className = 'toast show' + (kind === 'err' ? ' err' : '') + (state.sheetOpen ? ' raised' : '');
      clearTimeout(toast._timer);
      toast._timer = setTimeout(function () { refs.toast.className = 'toast' + (state.sheetOpen ? ' raised' : ''); }, 2600);
    }

    /* ---------------- 模式 ---------------- */

    var HINTS = {
      browse: '',
      edit: '点正文直接改',
      element: '点任意元素写批注',
      region: '拖一个框圈住要改的那一块'
    };
    var hintTimer = null;

    function showHint(text) {
      clearTimeout(hintTimer);
      if (!text) { refs.hint.hidden = true; return; }
      refs.hint.textContent = text;
      refs.hint.hidden = false;
      hintTimer = setTimeout(function () { refs.hint.hidden = true; }, 3000);
    }

    function hideHint() {
      clearTimeout(hintTimer);
      refs.hint.hidden = true;
    }

    function setMode(mode) {
      if (mode === state.mode && mode !== 'edit') return;
      if (state.mode === 'edit' && mode !== 'edit') finalizeEdits();
      state.mode = mode;
      state.hoverEl = null;
      state.drag = null;
      hideBubble();
      closePopover();

      Array.prototype.forEach.call(refs.bar.querySelectorAll('[data-mode]'), function (btn) {
        btn.setAttribute('aria-pressed', String(btn.dataset.mode === mode));
      });

      enableEditing(mode === 'edit');
      showHint(HINTS[mode]);
      document.documentElement.setAttribute('data-ra-mode', mode);
      paint();
    }

    /* ---------------- 编辑正文 ---------------- */

    function editableCandidates() {
      var list = Array.prototype.slice.call(document.querySelectorAll(BLOCK_SEL));
      return list.filter(function (el) {
        if (!el.isConnected) return false;
        if (el.closest('#' + HOST_ID)) return false;
        if (el.closest('[data-ra-skip]')) return false;
        // 只让"叶子块"可编辑：里面还有可编辑块就不再套一层（嵌套 contenteditable 会互相吃事件）
        if (el.querySelector(EDIT_TAGS)) return false;
        if (!oneLine(el.textContent)) return false;
        var rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) return false;
        return true;
      });
    }

    function enableEditing(on) {
      if (on) {
        els = editableCandidates();
        els.forEach(function (el) {
          if (!state.originals.has(el)) {
            state.originals.set(el, { text: el.textContent, html: el.innerHTML });
          }
          el.setAttribute('contenteditable', 'plaintext-only');
          el.setAttribute('spellcheck', 'false');
          el.setAttribute('data-ra-editable', '');
        });
      } else {
        els.forEach(function (el) {
          el.removeAttribute('contenteditable');
          el.removeAttribute('data-ra-editable');
        });
        els = [];
      }
    }

    function finalizeEdit(el) {
      var original = state.originals.get(el);
      if (!original) return;
      var before = original.text;
      var after = el.textContent;
      if (oneLine(before) === oneLine(after)) {
        if (state.edits.has(el)) state.edits.delete(el);
        return;
      }
      var ops = diffOps(before, after);
      state.edits.set(el, {
        el: el,
        before: before,
        after: after,
        ops: ops.slice(0, 120),
        opsTruncated: ops.length > 120,
        markupChanged: fingerprint(original.html) !== fingerprint(el.innerHTML)
      });
    }

    function finalizeEdits() {
      els.forEach(function (el) { finalizeEdit(el); });
      refreshChrome();
    }

    var onEditInput = debounce(function (el) {
      finalizeEdit(el);
      refreshChrome();
    }, 420);

    /* ---------------- 选区批注 ---------------- */

    function hideBubble() { refs.bubble.hidden = true; }

    function showBubble(range) {
      var rects = range.getClientRects();
      var rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
      if (!rect || (!rect.width && !rect.height)) return;
      refs.bubble.hidden = false;
      var bw = 74, bh = 28;
      var left = clamp(rect.left + rect.width / 2 - bw / 2, 8, window.innerWidth - bw - 8);
      var top = rect.bottom + 8;
      if (top + bh > window.innerHeight - 60) top = Math.max(8, rect.top - bh - 8);
      refs.bubble.style.left = left + 'px';
      refs.bubble.style.top = top + 'px';
      refs.bubble._range = range.cloneRange();
    }

    /* ---------------- 弹层（写意见） ---------------- */

    function closePopover() {
      refs.pop.hidden = true;
      refs.pop.textContent = '';
      state.pending = null;
      hideHint();
    }

    function openPopover(pending) {
      state.pending = pending;
      hideBubble();
      hideHint();
      ensureVisible(pending);
      refs.pop.hidden = false;

      var snippet = pending.kind === 'text-comment' && pending.anchor ? clip(pending.anchor.quote, 120) : '';
      var placeholder = pending.kind === 'region'
        ? '这一块要改什么？'
        : pending.kind === 'text-comment' ? '这句话要改成什么？' : '要改什么？';

      refs.pop.innerHTML = [
        snippet ? '<div class="pop-quote">“' + esc(snippet) + '”</div>' : '',
        '<textarea placeholder="' + esc(placeholder) + '" spellcheck="false"></textarea>',
        '<div class="pop-foot">',
        '  <button type="button" data-act="cancel">取消</button>',
        '  <button type="button" class="save" data-act="save">保存</button>',
        '</div>'
      ].join('');

      positionPopover(pending);
      var textarea = refs.pop.querySelector('textarea');
      setTimeout(function () { if (textarea) textarea.focus(); }, 20);

      textarea.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          commitPopover();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          closePopover();
        }
      });

      refs.pop.querySelector('[data-act="save"]').addEventListener('click', commitPopover);
      refs.pop.querySelector('[data-act="cancel"]').addEventListener('click', closePopover);
    }

    function asRect(r) {
      if (!r) return null;
      if (typeof r.bottom === 'number') return r;
      return {
        left: r.left, top: r.top,
        right: r.left + (r.width || 0),
        bottom: r.top + (r.height || 0),
        width: r.width || 0, height: r.height || 0
      };
    }

    /** 产物自己声明版本（生成时写进 meta）：页面把它带进提交，生产方据此判断"是不是同一版"。 */
    function artifactVersion() {
      var meta = document.querySelector('meta[name="artifact-version"]');
      if (meta && meta.getAttribute('content')) return meta.getAttribute('content');
      var attr = document.documentElement.getAttribute('data-artifact-version');
      return attr || null;
    }

    function uid(prefix) {
      return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }

    function resolveSelector(selector) {
      if (!selector) return null;
      try {
        var el = document.querySelector(selector);
        if (!el || el === document.body || el.closest('#' + HOST_ID)) return null;
        return el;
      } catch (e) {
        return null;
      }
    }

    /** 用引文在段落里重新找出 Range（选择器还在、但文字位置变了也能恢复高亮）。 */
    function rangeForQuote(el, exact) {
      if (!exact) return null;
      var at = (el.textContent || '').indexOf(exact);
      if (at < 0) return null;
      var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      var node, pos = 0, startNode = null, startOffset = 0, endNode = null, endOffset = 0;
      while ((node = walker.nextNode())) {
        var len = node.data.length;
        if (startNode === null && at < pos + len) { startNode = node; startOffset = at - pos; }
        var endAt = at + exact.length;
        if (endAt <= pos + len) { endNode = node; endOffset = endAt - pos; break; }
        pos += len;
      }
      if (!startNode || !endNode) return null;
      var range = document.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      return range;
    }

    function showNotice(message, actions) {
      refs.notice.textContent = '';
      var text = document.createElement('span');
      text.className = 'msg';
      text.textContent = message;
      refs.notice.appendChild(text);
      (actions || []).forEach(function (action) {
        var button = document.createElement('button');
        button.type = 'button';
        button.textContent = action.label;
        if (action.primary) button.className = 'primary';
        button.addEventListener('click', function () {
          refs.notice.hidden = true;
          if (typeof action.run === 'function') action.run();
        });
        refs.notice.appendChild(button);
      });
      refs.notice.hidden = false;
    }

    function hideNotice() { refs.notice.hidden = true; }

    /** 批注目标不在视口里时先滚进来 —— 弹层跟着一个屏幕外的锚点没有意义。 */
    function ensureVisible(pending) {
      var rect = null;
      if (pending.kind === 'region') rect = pending.rect;
      else if (pending.kind === 'text-comment' && pending.range) {
        var list = pending.range.getClientRects();
        rect = list.length ? list[list.length - 1] : null;
      } else if (pending.el && pending.el.isConnected) {
        rect = pending.el.getBoundingClientRect();
      }
      if (!rect) return;
      rect = asRect(rect);
      var margin = 24;
      if (rect.top >= margin && rect.bottom <= window.innerHeight - margin) return;
      if (pending.el && pending.el.isConnected) pending.el.scrollIntoView({ block: 'center' });
      else window.scrollBy(0, rect.top - window.innerHeight / 3);
    }

    function positionPopover(pending) {
      var anchor = pending.rect;
      if (pending.el && pending.el.isConnected) anchor = pending.el.getBoundingClientRect();
      if (pending.kind === 'text-comment' && pending.range) {
        var rects = pending.range.getClientRects();
        anchor = rects.length ? rects[rects.length - 1] : pending.range.getBoundingClientRect();
      }
      anchor = asRect(anchor);
      if (!anchor) return;
      var el = refs.pop;
      el.style.visibility = 'hidden';
      el.style.left = '0px';
      el.style.top = '0px';
      var width = el.offsetWidth || 306;
      var height = el.offsetHeight || 220;
      var left = clamp(anchor.left, 8, window.innerWidth - width - 8);
      var top = anchor.bottom + 8;
      if (top + height > window.innerHeight - 8) top = Math.max(8, anchor.top - height - 8);
      el.style.left = left + 'px';
      el.style.top = top + 'px';
      el.style.visibility = '';
    }

    function commitPopover() {
      var pending = state.pending;
      if (!pending) return;
      var textarea = refs.pop.querySelector('textarea');
      var comment = oneLine(textarea ? textarea.value : '');
      if (!comment) {
        toast('写一句要改什么再保存');
        if (textarea) textarea.focus();
        return;
      }

      var annotation;
      if (pending.kind === 'element') {
        annotation = {
          kind: 'element',
          el: pending.el,
          comment: comment,
          target: targetOf(pending.el)
        };
      } else if (pending.kind === 'region') {
        annotation = {
          kind: 'region',
          comment: comment,
          region: pending.region,
          rect: pending.region
        };
      } else {
        var anchor = pending.anchor;
        annotation = {
          kind: 'text-comment',
          el: anchor.el,
          range: pending.range,
          quote: {
            text: anchor.quote,
            prefix: anchor.prefix,
            suffix: anchor.suffix,
            start: anchor.start,
            end: anchor.end
          },
          comment: comment,
          target: targetOf(anchor.el),
          rect: rectOfElement(anchor.el)
        };
      }

      addAnnotation(annotation);
      closePopover();
      var sel = window.getSelection();
      if (sel) sel.removeAllRanges();
    }

    function addAnnotation(annotation) {
      state.seq += 1;
      annotation.id = 'a' + state.seq;
      annotation.createdAt = new Date().toISOString();
      state.annotations.push(annotation);
      refreshChrome();
      if (state.sheetOpen) renderSheet();
      saveDraftSoon();
    }

    /* ---------------- 元素 / 区域 / 选区 的命中 ---------------- */

    function elementAtPoint(x, y) {
      var el = document.elementFromPoint(x, y);
      if (!el) return null;
      if (el.closest('#' + HOST_ID)) return null;
      if (el === document.body || el === document.documentElement) return null;
      return el;
    }

    /** 子元素全被框住时，收成父容器（框住整张表 → table，而不是十个单元格）。 */
    function collapseCovered(list) {
      var changed = true;
      var guard = 0;
      while (changed && guard < 8) {
        changed = false;
        guard += 1;
        for (var i = 0; i < list.length; i += 1) {
          var parent = list[i].parentElement;
          if (!parent || parent === document.body || parent === document.documentElement) continue;
          var kids = Array.prototype.filter.call(parent.children, function (child) {
            return oneLine(child.textContent) || child.querySelector('img,svg,canvas');
          });
          if (kids.length < 2) continue;
          var covered = kids.every(function (child) {
            return list.indexOf(child) >= 0 || list.some(function (node) { return child.contains(node); });
          });
          if (!covered) continue;
          list = list.filter(function (node) { return !parent.contains(node); });
          list.push(parent);
          changed = true;
          break;
        }
      }
      return list;
    }

    function regionElements(rect) {
      var counts = new Map();
      var cols = 14, rows = 12;
      for (var i = 0; i <= cols; i += 1) {
        for (var j = 0; j <= rows; j += 1) {
          var el = elementAtPoint(rect.left + (rect.width * i) / cols, rect.top + (rect.height * j) / rows);
          if (!el) continue;
          var block = el.closest(BLOCK_SEL);
          if (!block || block === document.body) continue;
          counts.set(block, (counts.get(block) || 0) + 1);
        }
      }
      var list = Array.from(counts.keys());
      list = collapseCovered(list);
      // 父子同时命中：留更深的那一个
      list = list.filter(function (node) {
        return !list.some(function (other) {
          return other !== node && node.contains(other) && (counts.get(other) || 0) >= (counts.get(node) || 0) * 0.6;
        });
      });
      list.sort(function (a, b) { return (counts.get(b) || 0) - (counts.get(a) || 0); });
      list = list.slice(0, 10);
      list.sort(function (a, b) {
        return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });

      return list.map(function (el) {
        return {
          selector: buildSelector(el),
          tag: el.tagName.toLowerCase(),
          label: describeElement(el),
          text: clip(el.innerText || el.textContent, 140),
          rect: (function () {
            var r = el.getBoundingClientRect();
            return {
              x: Math.round(r.left + window.scrollX),
              y: Math.round(r.top + window.scrollY),
              w: Math.round(r.width),
              h: Math.round(r.height)
            };
          })()
        };
      });
    }

    /* ---------------- 事件 ---------------- */

    function onMouseDown(event) {
      if (event.target.closest && event.target.closest('#' + HOST_ID)) return;
      hideHint();

      if (state.mode === 'region') {
        if (event.button !== 0) return;
        event.preventDefault();
        state.drag = {
          x0: event.clientX, y0: event.clientY,
          x1: event.clientX, y1: event.clientY,
          active: true
        };
        document.body.style.userSelect = 'none';
        document.body.style.webkitUserSelect = 'none';
        schedulePaint();
        return;
      }

      if (state.mode === 'element') {
        event.preventDefault();
        event.stopPropagation();
      }
    }

    function onMouseMove(event) {
      if (state.drag && state.drag.active) {
        state.drag.x1 = event.clientX;
        state.drag.y1 = event.clientY;
        schedulePaint();
        return;
      }
      if (state.mode !== 'element') return;
      var el = elementAtPoint(event.clientX, event.clientY);
      if (el !== state.hoverEl) {
        state.hoverEl = el;
        schedulePaint();
      }
    }

    function onMouseUp(event) {
      if (state.drag && state.drag.active) {
        var d = state.drag;
        state.drag = null;
        document.body.style.userSelect = '';
        document.body.style.webkitUserSelect = '';
        schedulePaint();
        var left = Math.min(d.x0, d.x1), top = Math.min(d.y0, d.y1);
        var width = Math.abs(d.x1 - d.x0), height = Math.abs(d.y1 - d.y0);
        if (width < 10 || height < 10) return;
        var rect = { left: left, top: top, width: width, height: height };
        var elements = regionElements(rect);
        openPopover({
          kind: 'region',
          rect: rect,
          region: {
            x: Math.round(left + window.scrollX),
            y: Math.round(top + window.scrollY),
            w: Math.round(width),
            h: Math.round(height),
            elements: elements,
            text: clip(elements.map(function (e) { return e.text; }).join(' / '), 400)
          }
        });
        return;
      }

      if (state.mode === 'element' || state.mode === 'region') return;
      if (event.target.closest && event.target.closest('#' + HOST_ID)) return;

      var self = event;
      setTimeout(function () {
        var selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
          hideBubble();
          return;
        }
        var text = selection.toString().trim();
        if (text.length < 2) { hideBubble(); return; }
        var range = selection.getRangeAt(0);
        if (!document.body.contains(range.commonAncestorContainer)) { hideBubble(); return; }
        if (range.commonAncestorContainer.nodeType === 1 &&
            range.commonAncestorContainer.closest('#' + HOST_ID)) { hideBubble(); return; }
        showBubble(range);
      }, 12);
    }

    function onClick(event) {
      if (event.target.closest && event.target.closest('#' + HOST_ID)) return;
      if (state.mode === 'element') {
        event.preventDefault();
        event.stopPropagation();
        var el = elementAtPoint(event.clientX, event.clientY);
        if (!el) return;
        openPopover({ kind: 'element', el: el });
        return;
      }
      // 编辑模式里点链接不要跳走
      if (state.mode === 'edit' && event.target.closest('[data-ra-editable] a')) {
        event.preventDefault();
      }
    }

    function onKeyDown(event) {
      if (isTypingTarget(event.target)) {
        if (event.key === 'Escape') { event.target.blur(); }
        return;
      }
      if (event.key === 'Escape') {
        if (state.pending) { closePopover(); return; }
        if (state.mode !== 'browse') { setMode('browse'); return; }
        if (state.sheetOpen) openSheet(false);
        return;
      }
      if (event.key === '1') setMode('browse');
      else if (event.key === '2') setMode('edit');
      else if (event.key === '3') setMode('element');
      else if (event.key === '4') setMode('region');
      else if (event.key.toLowerCase() === 's' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        if (totalCount()) submit();
      }
    }

    // 输入：编辑
    document.addEventListener('input', function (event) {
      if (!state.editingEnabled()) return;
      var el = event.target.closest && event.target.closest('[data-ra-editable]');
      if (!el) return;
      onEditInput(el);
    }, true);

    document.addEventListener('focusout', function (event) {
      var el = event.target.closest && event.target.closest('[data-ra-editable]');
      if (!el) return;
      finalizeEdit(el);
      refreshChrome();
    }, true);

    state.editingEnabled = function () { return state.mode === 'edit' && els.length > 0; };

    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('mouseup', onMouseUp, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('scroll', schedulePaint, true);
    window.addEventListener('resize', schedulePaint);

    var mutationTimer = null;
    var observer = new MutationObserver(function () {
      clearTimeout(mutationTimer);
      mutationTimer = setTimeout(schedulePaint, 120);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    /* ---------------- 工具栏 ---------------- */

    refs.bar.addEventListener('click', function (event) {
      var button = event.target.closest('button');
      if (!button) return;
      if (button.dataset.mode) { setMode(button.dataset.mode); return; }
      var act = button.dataset.act;
      if (act === 'sheet') { openSheet(); }
      else if (act === 'submit') { submit(); }
    });

    refs.bubble.addEventListener('mousedown', function (event) { event.preventDefault(); });
    refs.bubble.addEventListener('click', function (event) {
      event.preventDefault();
      var range = refs.bubble._range;
      if (!range) return;
      var anchor = rangeAnchor(range);
      if (!anchor) return;
      openPopover({ kind: 'text-comment', range: range, anchor: anchor });
    });

    refs.sheet.addEventListener('click', function (event) {
      var button = event.target.closest('button');
      if (button) {
        var act = button.dataset.act;
        if (act === 'close-sheet') openSheet(false);
        else if (act === 'clear') {
          if (!totalCount()) return;
          if (!window.confirm('清空全部批注？')) return;
          state.annotations = [];
          state.edits.clear();
          state.originals.forEach(function (value, el) {
            if (el.isConnected) el.textContent = value.text;
          });
          refreshChrome();
          renderSheet();
        }
        return;
      }
      var card = event.target.closest('.card');
      if (!card) return;
      var target = event.target.closest('button');
      if (target && (target.dataset.act === 'jump-edit' || target.dataset.act === 'revert-edit')) {
        var entry = Array.from(state.edits.values())[Number(card.dataset.editKey)];
        if (!entry) return;
        if (target.dataset.act === 'revert-edit') {
          if (entry.el.isConnected) entry.el.textContent = entry.before;
          state.edits.delete(entry.el);
          refreshChrome(); renderSheet();
        } else {
          entry.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
        return;
      }
      if (target && target.dataset.act === 'delete') {
        var id = card.dataset.annotationId;
        state.annotations = state.annotations.filter(function (a) { return a.id !== id; });
        refreshChrome();
        renderSheet();
        return;
      }
      if (target && target.dataset.act === 'jump') {
        var annotation = state.annotations.filter(function (a) { return a.id === card.dataset.annotationId; })[0];
        if (!annotation) return;
        var el = annotation.el || null;
        if (el && el.isConnected) {
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        } else if (annotation.region) {
          window.scrollTo({ top: annotation.region.y - 120, behavior: 'smooth' });
        }
        pulse(annotation.id);
      }
    });

    refs.boxes.addEventListener('click', function (event) {
      var pin = event.target.closest('.pin');
      if (!pin) return;
      var id = pin.dataset.annotationId;
      if (!state.sheetOpen) openSheet(true);
      var card = refs.sheetList.querySelector('[data-annotation-id="' + id + '"]');
      if (card) card.scrollIntoView({ block: 'nearest' });
    });

    function pulse(id) {
      var box = refs.boxes.querySelector('[data-annotation-id="' + id + '"]');
      if (box) {
        box.style.transition = 'opacity .2s';
        box.style.opacity = '0.35';
        setTimeout(function () { box.style.opacity = '1'; }, 220);
      }
    }

    refs.modal.addEventListener('click', function (event) {
      var button = event.target.closest('button');
      if (!button) {
        if (event.target === refs.modal) refs.modal.classList.remove('open');
        return;
      }
      if (button.dataset.act === 'close-modal') refs.modal.classList.remove('open');
      if (button.dataset.act === 'copy') copyModal();
    });

    function copyModal() {
      var text = refs.modalText.value;
      function done() { toast('已复制 JSON'); refs.modal.classList.remove('open'); }
      function fail() {
        refs.modalText.focus();
        refs.modalText.select();
        toast('按下 ⌘C 复制');
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, fail);
      } else {
        fail();
      }
    }

    /* ---------------- payload ---------------- */

    function buildPayload() {
      finalizeEdits();
      var items = [];

      function targetWithSpace(target) {
        if (!target) return target;
        var copy = {};
        Object.keys(target).forEach(function (k) { copy[k] = target[k]; });
        if (copy.rect) copy.rect = { x: copy.rect.x, y: copy.rect.y, w: copy.rect.w, h: copy.rect.h, space: 'page' };
        return copy;
      }

      state.annotations.forEach(function (a) {
        var item = {
          id: a.id,
          kind: a.kind,
          // intent 说的是"要模型干什么"，kind 说的是"人在页面上怎么圈的"
          intent: { verb: 'change', severity: 'normal' },
          comment: a.comment
        };
        if (a.kind === 'region') {
          item.region = { x: a.region.x, y: a.region.y, w: a.region.w, h: a.region.h, space: 'page' };
          item.elements = a.region.elements;
          item.text = a.region.text;
        } else {
          item.target = targetWithSpace(a.target);
        }
        if (a.kind === 'text-comment') {
          item.quote = {
            exact: a.quote.text,
            prefix: a.quote.prefix,
            suffix: a.quote.suffix,
            start: a.quote.start,
            end: a.quote.end,
            unit: 'utf16'
          };
        }
        items.push(item);
      });

      state.edits.forEach(function (edit) {
        if (!edit.el.isConnected) return;
        items.push({
          id: 'e' + (items.length + 1),
          kind: 'text-edit',
          intent: { verb: 'replace', severity: 'normal' },
          comment: '',
          target: targetWithSpace((function () {
            var t = targetOf(edit.el);
            t.text = clip(edit.before, 160);
            return t;
          })()),
          edit: {
            before: edit.before,
            after: edit.after,
            ops: edit.ops,
            ops_truncated: edit.opsTruncated,
            markup_changed: edit.markupChanged
          }
        });
      });

      var stats = { total: items.length, element: 0, region: 0, text: 0, edit: 0 };
      items.forEach(function (item) {
        if (item.kind === 'element') stats.element += 1;
        else if (item.kind === 'region') stats.region += 1;
        else if (item.kind === 'text-comment') stats.text += 1;
        else if (item.kind === 'text-edit') stats.edit += 1;
      });

      return {
        contract: CONTRACT,
        bundle_id: state.bundleId,
        base: {
          version: state.baseVersion,
          captured_at: state.loadedAt,
          // 从旧版草稿恢复的批注：生产方看到它就必须按引文重锚，不许直接套用
          draft_stale: state.draftStale
        },
        artifact: {
          title: document.title,
          path: location.pathname,
          url: location.href,
          viewport: { width: window.innerWidth, height: window.innerHeight }
        },
        created_at: new Date().toISOString(),
        page: {
          host: state.host,
          // 这页不做版本核对：不把"我没核对"说成"我核对过"
          pre_check: false
        },
        annotations: items,
        stats: stats
      };
    }

    function wakeText(payload) {
      var s = payload.stats;
      return '产物批注：共 ' + s.total + ' 条（点选 ' + s.element + ' · 区域 ' + s.region +
        ' · 文字 ' + s.text + ' · 直接改动 ' + s.edit + '）。按 artifact-annotations/1 逐条改。';
    }

    function submit() {
      var payload = buildPayload();
      if (!payload.stats.total) { toast('还没有批注'); return; }

      if (!state.bridge) {
        refs.modalText.value = JSON.stringify(payload, null, 2);
        refs.modal.classList.add('open');
        refs.modalText.focus();
        refs.modalText.select();
        return;
      }

      var button = refs.bar.querySelector('.submit');
      button.disabled = true;
      button.textContent = '提交中…';

      state.bridge.write(payload).then(function (receipt) {
        var wrote = !(receipt && receipt.ok === false);
        return state.bridge.wake({ unit: 'artifact-annotations', text: wakeText(payload) })
          .then(function (woken) {
            var explicitMiss = !!(woken && (woken.ok === false || woken.woke === false));
            if (!wrote) { toast('宿主没有接受这次写入', 'err'); return; }
            if (!explicitMiss) { toast('已提交 · 模型已收到'); return; }
            toast(state.host === 'http'
              ? '已写入反馈；本地宿主没有模型可唤醒，回对话说一声'
              : '已写入，但没能确认唤醒模型', 'err');
          }, function () {
            toast(wrote ? '已写入，但唤醒失败（模型可能没收到）' : '写入失败', 'err');
          });
      }).catch(function (error) {
        toast('写入失败：' + (error && error.message ? error.message : error), 'err');
      }).then(function () {
        button.disabled = totalCount() === 0;
        button.textContent = '提交';
      });
    }

    /* ---------------- 草稿（尽力而为，不阻塞） ---------------- */

    var saveDraftSoon = debounce(function () {
      if (!state.bridge || !state.bridge.draft) return;
      if (state.capabilities.indexOf('draft') < 0) return;
      try {
        state.bridge.draft({
          contract: 'artifact-annotations-draft/1',
          saved_at: new Date().toISOString(),
          payload: buildPayload()
        }).catch(function () { /* 草稿失败不该打扰人 */ });
      } catch (e) { /* ignore */ }
    }, 900);

    /* ---------------- 草稿恢复（版本变了也不丢） ---------------- */

    function restoreDraft(saved, stale) {
      var payload = saved && saved.payload;
      if (!payload || !Array.isArray(payload.annotations)) return;
      var restored = 0, lost = 0;

      payload.annotations.forEach(function (item) {
        if (!item || typeof item.kind !== 'string') return;

        if (item.kind === 'text-edit') {
          var editEl = resolveSelector(item.target && item.target.selector);
          if (!editEl || !item.edit) { lost += 1; return; }
          if (oneLine(editEl.textContent) !== oneLine(item.edit.before)) { lost += 1; return; }
          editEl.textContent = item.edit.after;
          state.originals.set(editEl, { text: item.edit.before, html: editEl.innerHTML });
          state.edits.set(editEl, {
            el: editEl,
            before: item.edit.before,
            after: item.edit.after,
            ops: item.edit.ops || diffOps(item.edit.before, item.edit.after),
            opsTruncated: !!item.edit.ops_truncated,
            markupChanged: false
          });
          restored += 1;
          return;
        }

        if (item.kind === 'region' && item.region) {
          state.seq += 1;
          state.annotations.push({
            id: 'a' + state.seq,
            kind: 'region',
            comment: item.comment || '',
            region: item.region,
            rect: { x: item.region.x, y: item.region.y, w: item.region.w, h: item.region.h }
          });
          restored += 1;
          return;
        }

        var el = resolveSelector(item.target && item.target.selector);
        if (!el) { lost += 1; return; }
        state.seq += 1;
        var annotation = {
          id: 'a' + state.seq,
          kind: item.kind,
          el: el,
          comment: item.comment || '',
          target: item.target
        };
        if (item.kind === 'text-comment' && item.quote) {
          annotation.quote = {
            text: item.quote.exact,
            prefix: item.quote.prefix,
            suffix: item.quote.suffix,
            start: item.quote.start,
            end: item.quote.end
          };
          var range = rangeForQuote(el, item.quote.exact);
          if (range) annotation.range = range;
        }
        state.annotations.push(annotation);
        restored += 1;
      });

      if (stale || (payload.base && payload.base.draft_stale === true)) state.draftStale = true;
      refreshChrome();
      if (state.sheetOpen) renderSheet();
      if (restored || lost) {
        toast('已恢复 ' + restored + ' 条' + (lost ? '，' + lost + ' 条在新版里找不到' : ''), lost ? 'err' : '');
      }
      saveDraftSoon();
    }

    function draftCount(saved) {
      var payload = saved && saved.payload;
      return payload && Array.isArray(payload.annotations) ? payload.annotations.length : 0;
    }

    /* ---------------- 握手 ---------------- */

    var connectAttempts = 0;

    function connect() {
      if (!window.ReviewBridge) {
        // 页面可能把批注层放在桥前面：等桥就位再试，但不无限等。
        if (connectAttempts < 4) {
          connectAttempts += 1;
          setTimeout(connect, 120 * connectAttempts);
        }
        return;
      }
      var timeout = new Promise(function (resolve) { setTimeout(function () { resolve(null); }, 1500); });
      var attempt = window.ReviewBridge.connect().catch(function () { return null; });
      Promise.race([attempt, timeout]).then(function (bridge) {
        if (!bridge) {
          state.host = 'none';
          state.connected = false;
          refreshChrome();
          return;
        }
        state.bridge = bridge;
        state.host = bridge.transport;
        state.capabilities = bridge.capabilities || [];
        state.connected = true;
        refreshChrome();
        if (bridge.on) {
          bridge.on('changed', function () {
            // 宿主只说"变了"，不替人决定要不要丢状态。有未提交的东西就先问。
            if (totalCount() > 0) {
              showNotice('产物已更新，这页还有 ' + totalCount() + ' 条未提交批注', [
                { label: '重新加载', primary: true, run: function () { window.location.reload(); } },
                { label: '继续', run: hideNotice }
              ]);
            }
          });
        }
        if (bridge.draftRead) {
          bridge.draftRead().then(function (saved) {
            var draft = saved && saved.draft;
            if (!draft || !draft.payload) return;
            var sameVersion = (draft.payload.base || {}).version === state.baseVersion;
            if (sameVersion) { restoreDraft(draft, false); return; }
            var count = draftCount(draft);
            if (!count) return;
            showNotice('有 ' + count + ' 条未提交批注基于旧版产物', [
              { label: '恢复', primary: true, run: function () { restoreDraft(draft, true); } },
              { label: '忽略', run: hideNotice }
            ]);
          }).catch(function () { /* 没有草稿能力就算了 */ });
        }
      });
    }

    /* ---------------- 启动 ---------------- */

    state.baseVersion = artifactVersion();
    state.bundleId = uid('b');
    refreshChrome();
    connect();
    paint();

    var api = {
      version: VERSION,
      contract: CONTRACT,
      mount: mount,
      setMode: setMode,
      submit: submit,
      payload: buildPayload,
      getState: function () {
        return {
          mode: state.mode,
          host: state.host,
          connected: state.connected,
          annotations: state.annotations.length,
          edits: state.edits.size
        };
      }
    };

    window.ReviewAnnotate = api;
    return api;
  }

  window.ReviewAnnotate = window.ReviewAnnotate || { version: VERSION, contract: CONTRACT, mount: mount };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      if (document.documentElement.getAttribute('data-ra-auto') !== 'off') mount();
    });
  } else if (document.documentElement.getAttribute('data-ra-auto') !== 'off') {
    mount();
  }
})();
