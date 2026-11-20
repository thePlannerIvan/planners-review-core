/**
 * 块内行内格式的序列化：DOM → Markdown。
 *
 * 只认四种行内格式（加粗、斜体、行内代码、链接）和纯文本。浏览器里由
 * `doc-workbench.js` 调用；Node 侧用最小 DOM 形状跑同一份规则（见 test_doc_workbench）。
 * 这个文件没有浏览器专属 API，所以两边是同一实现。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DocInline = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TEXT_NODE = 3;
  const CDATA_NODE = 4;

  const children = (node, options) => Array.from(node.childNodes || [])
    .map((child) => nodeToMarkdown(child, options))
    .join('');

  const textOf = (node) => String(node.nodeValue ?? node.textContent ?? '');
  /** 代码里不转义：反引号由围栏长度处理，其余字符按原文进 Markdown。 */
  const rawTextOf = (node) => {
    if (!node) return '';
    if (node.nodeType === TEXT_NODE || node.nodeType === CDATA_NODE) return textOf(node);
    return Array.from(node.childNodes || []).map(rawTextOf).join('');
  };

  /** Markdown 里有语义的 ASCII 标点；不转义就会被下一次解析当成格式。 */
  const escapeText = (value, options = {}) => {
    const escaped = String(value)
      .replace(/\\/g, '\\\\')
      .replace(/`/g, '\\`')
      .replace(/\*/g, '\\*')
      .replace(/_/g, '\\_')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]')
      .replace(/</g, '\\<')
      .replace(/>/g, '\\>')
      .replace(/~/g, '\\~')
      .replace(/&/g, '\\&')
      .replace(/!(?=\[)/g, '\\!');
    return options.table ? escaped.replace(/\|/g, '\\|') : escaped;
  };

  const codeSpan = (value) => {
    const longest = (String(value).match(/`+/g) || []).reduce((max, run) => Math.max(max, run.length), 0);
    const ticks = '`'.repeat(longest + 1);
    const pad = /^`|`$|^\s|\s$/.test(value) ? ' ' : '';
    return `${ticks}${pad}${value}${pad}${ticks}`;
  };

  const linkTarget = (href) => {
    const value = String(href ?? '');
    if (!value) return null;
    return /[\s()<>]/.test(value) ? `<${value.replace(/>/g, '%3E')}>` : value;
  };

  function nodeToMarkdown(node, options = {}) {
    if (!node) return '';
    if (node.nodeType === TEXT_NODE || node.nodeType === CDATA_NODE) {
      return escapeText(textOf(node), options);
    }
    if (node.nodeType !== 1) return '';
    const tag = String(node.tagName || node.nodeName || '').toUpperCase();
    switch (tag) {
      case 'BR':
        // 反斜杠 + 换行是 CommonMark 的硬换行；不用行尾两个空格，
        // 因为保存时会规范化掉行尾空白。
        return '\\\n';
      case 'STRONG':
      case 'B': {
        const inner = children(node, options);
        return inner ? `**${inner}**` : '';
      }
      case 'EM':
      case 'I': {
        const inner = children(node, options);
        return inner ? `*${inner}*` : '';
      }
      case 'CODE':
        return codeSpan(rawTextOf(node));
      case 'A': {
        const label = children(node, options) || escapeText(textOf(node), options);
        const href = typeof node.getAttribute === 'function' ? node.getAttribute('href') : node.href;
        const target = linkTarget(href);
        return target ? `[${label}](${target})` : label;
      }
      default:
        // 未知行内标签（粘贴进来的 span 等）只保留文字：不把 HTML 写回文档。
        return children(node, options);
    }
  }

  /**
   * 行首的块前缀要原样交给保存路径（票 30）：
   * 前缀在那里被认成块类型，`# ` 得到标题、`- ` 得到列表……序列化层不再抢着把它
   * 转义成字面量。只有行首才还原——行中间的 `*` / `>` 仍然是普通文本，照旧转义。
   */
  const unescapeLineStart = (line) => {
    if (!line) return line;
    let text = line;
    if (/^\\\*[ \t]/.test(text) || /^\\>[ \t]/.test(text)) text = text.slice(1);
    text = text.replace(/^(?:\\`){3,}/, (run) => run.replace(/\\/g, ''));
    text = text.replace(/^(?:\\~){3,}/, (run) => run.replace(/\\/g, ''));
    return text;
  };

  function serializeInline(node, options = {}) {
    const markdown = nodeToMarkdown(node, options).replace(/\u00a0/g, ' ');
    return markdown.split('\n').map(unescapeLineStart).join('\n');
  }

  return { serializeInline, escapeText };
});
