/**
 * 判据二：块内连续中文输入（含标点、换行、撤销），不丢字、不错位、保存后文本正确；
 * 外加跨块选区按整块吸附并派发。
 *
 * 走真实浏览器（Playwright + CDP），不是模拟 DOM：
 *   · IME：CDP Input.imeSetComposition 触发 composition，再 Input.insertText 提交
 *   · 标点：逐字插入中文标点
 *   · 块内换行：Shift+Enter，落盘后仍是同一块
 *   · 回车分块：Enter 在光标处切成两块，新块拿新锚点
 *   · 删空合并：空块开头 Backspace，并入前一块
 *   · 撤销/重做：Meta/Ctrl+Z、Meta/Ctrl+Shift+Z，每次等自动保存落盘后再断言磁盘
 *   · 跨块选区：程序化 Range 跨三块，断言吸附到三块整块并原样派发
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  compareBlocks, getJson, loadPlaywright, openWorkbench, readDoc, sandboxCorpus,
} from './harness.mjs';

const COMPOSITIONS = [['zhongwen', '中文'], ['shuru', '输入'], ['shice', '实测']];
const PUNCTUATION = '，标点：。！？「引号」；';
const TYPED = `${COMPOSITIONS.map(([, text]) => text).join('')}${PUNCTUATION}`;
const UNDO_CHUNK = '撤销重做';
const NEWLINE_CHUNK = '换行之后';
const SPLIT_CHUNK = '分块之后';
const META = process.platform === 'darwin' ? 'Meta' : 'Control';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const readBlockRaw = (path, anchor) => {
  try {
    const parsed = readDoc(path).parsed;
    return parsed.blocks.find((block) => block.anchor === anchor)?.raw ?? null;
  } catch {
    return null;
  }
};

async function waitForDisk(path, anchor, predicate, timeout = 8000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeout) {
    last = readBlockRaw(path, anchor);
    if (predicate(last)) return { ok: true, raw: last, waited_ms: Date.now() - started };
    await sleep(80);
  }
  return { ok: false, raw: last, waited_ms: Date.now() - started };
}

async function statusText(page) {
  return page.evaluate(() => document.querySelector('#saveState')?.textContent ?? '');
}

/** 把光标放到块尾：确保追加而不是在块中间插入。 */
async function caretToEnd(page, selector) {
  await page.evaluate((sel) => {
    const node = document.querySelector(sel);
    node.focus();
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, selector);
}

export async function runTyping(corpus) {
  const cases = [];
  const details = { phases: {} };
  const browserInfo = await loadPlaywright();
  if (!browserInfo.available) {
    return {
      id: 'typing',
      title: '中文输入、跨块选区、撤销重做',
      blocked: true,
      blocked_reason: browserInfo.reason,
      cases: [{
        id: 'typing/blocked',
        ok: false,
        blocked: true,
        name: '没有可用浏览器，中文输入无法验证',
        evidence: { reason: browserInfo.reason },
      }],
      details,
    };
  }

  const sandbox = sandboxCorpus('acceptance-typing-');
  // 选一份正文长、中文密的真实语料；具体块在页面打开后按「纯文本单行段落」挑。
  const entry = corpus.documents.find((item) => item.id === '02-gwtb')
    ?? corpus.documents.find((item) => item.id === '01-needscope');
  const path = join(sandbox.dir, entry.file);
  let browser = null;
  let browserVersion = null;
  let server = null;
  try {
    server = await openWorkbench(path);
    const opened = await getJson(`${server.url}/api/doc`);
    const target = opened.body.blocks.find((block) => block.type === 'paragraph'
      && block.anchor
      && !String(block.raw).includes('\n')
      && /[\u4e00-\u9fff]/.test(block.raw)
      && !/[\\*_`\[\]<>&~|]/.test(block.raw));
    if (!target) throw Error('语料里找不到适合输入的纯文本中文段落');
    const originalRaw = target.raw;
    const beforeTyping = readDoc(path);
    details.target = { anchor: target.anchor, original_raw: originalRaw, doc: entry.id };

    browser = await browserInfo.playwright.chromium.launch({ headless: true });
    browserVersion = browser.version();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const saveRequests = [];
    page.on('request', (request) => {
      if (!request.url().endsWith('/api/block')) return;
      let body = null;
      try { body = request.postDataJSON(); } catch { body = request.postData(); }
      saveRequests.push({ at: Date.now(), body });
    });
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.doc-block', { timeout: 15000 });
    await page.waitForFunction(() => /已载入|结构问题/.test(document.querySelector('#saveState')?.textContent ?? ''), { timeout: 15000 });

    const selector = `.doc-block[data-anchor="${target.anchor}"] .block-text[contenteditable="true"]`;
    await page.waitForSelector(selector);
    const domBefore = await page.locator(selector).innerText();
    cases.push({
      id: 'typing/render',
      ok: domBefore === originalRaw,
      name: '打开后块内文本与磁盘 raw 一致（输入前基线）',
      evidence: { disk_raw: originalRaw, dom_text: domBefore },
    });
    await page.locator(selector).click();
    await caretToEnd(page, selector);

    const cdp = await page.context().newCDPSession(page);
    let compositionEvents = 0;
    for (const [pinyin, text] of COMPOSITIONS) {
      await cdp.send('Input.imeSetComposition', {
        text: pinyin, selectionStart: pinyin.length, selectionEnd: pinyin.length,
      });
      compositionEvents += 1;
      await sleep(60);
      await cdp.send('Input.insertText', { text });
      await sleep(80);
    }
    await page.keyboard.insertText(PUNCTUATION);
    const expectedAfterTyping = `${originalRaw}${TYPED}`;
    const typedSave = await waitForDisk(path, target.anchor, (raw) => raw === expectedAfterTyping);
    const domAfterTyping = await page.locator(selector).innerText();
    const statusAfterTyping = await statusText(page);
    const noopBaseline = readDoc(path);
    details.phases.typing = {
      method: 'CDP Input.imeSetComposition + Input.insertText + keyboard.insertText',
      composition_events: compositionEvents,
      typed: TYPED,
      dom_after: domAfterTyping,
      status: statusAfterTyping,
      saved_raw: typedSave.raw,
      waited_ms: typedSave.waited_ms,
    };
    cases.push({
      id: 'typing/no-loss',
      ok: typedSave.ok && domAfterTyping === expectedAfterTyping,
      name: '连续中文与标点：不丢字、不错位（DOM 与磁盘都等于原文+输入）',
      evidence: {
        expected_tail: TYPED,
        expected_length: expectedAfterTyping.length,
        dom_length: domAfterTyping.length,
        saved_raw: typedSave.raw,
        status: statusAfterTyping,
      },
    });
    cases.push({
      id: 'typing/only-one-block',
      ok: typedSave.ok && (() => {
        const comparison = compareBlocks(beforeTyping, readDoc(path));
        return comparison.changed.length === 1 && comparison.changed[0].anchor_after === target.anchor;
      })(),
      name: '只有被输入的这一块变，其余块不动',
      evidence: { saved_raw: typedSave.raw },
    });

    // 撤销 / 重做：每次等自动保存落盘后再看磁盘。
    await page.keyboard.insertText(UNDO_CHUNK);
    const withChunk = `${expectedAfterTyping}${UNDO_CHUNK}`;
    const chunkSave = await waitForDisk(path, target.anchor, (raw) => raw === withChunk);
    await page.keyboard.press(`${META}+z`);
    const undoResult = await waitForDisk(path, target.anchor, (raw) => raw !== withChunk && raw !== null);
    const undoRaw = undoResult.raw;
    const undoAccepted = undoResult.ok && undoRaw === expectedAfterTyping;
    await page.keyboard.press(`${META}+Shift+z`);
    const redoResult = await waitForDisk(path, target.anchor, (raw) => raw === withChunk);
    details.phases.undo = {
      chunk: UNDO_CHUNK,
      typed_saved: chunkSave.raw,
      after_undo: undoRaw,
      after_redo: redoResult.raw,
      undo_status: await statusText(page),
    };
    cases.push({
      id: 'typing/undo',
      ok: chunkSave.ok && undoAccepted,
      name: '撤销：磁盘回到输入前的正确文本',
      evidence: { expected_after_undo: expectedAfterTyping, actual_after_undo: undoRaw },
    });
    cases.push({
      id: 'typing/redo',
      ok: redoResult.ok,
      name: '重做：磁盘恢复被撤销的输入',
      evidence: { expected_after_redo: withChunk, actual_after_redo: redoResult.raw },
    });

    // 块内换行：Shift+Enter（SPEC 第 4 节）。浏览器可能把它落成 `\\` + 换行（<br>），
    // 也可能落成文本里的换行；两种都必须是「同一块两行」并且能保存。
    const requestsBeforeNewline = saveRequests.length;
    const responsePromise = page.waitForResponse((response) => response.url().endsWith('/api/block'), { timeout: 8000 }).catch(() => null);
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.insertText(NEWLINE_CHUNK);
    const newlineResponse = await responsePromise;
    const newlineStatus = await statusText(page);
    const newlineForms = [`${withChunk}\\\n${NEWLINE_CHUNK}`, `${withChunk}\n${NEWLINE_CHUNK}`];
    const newlineSave = await waitForDisk(path, target.anchor, (raw) => newlineForms.includes(raw));
    const newlineReceipt = newlineResponse ? await newlineResponse.json().catch(() => null) : null;
    const newlineDiskRaw = newlineSave.raw;
    const newlinePayload = saveRequests.slice(requestsBeforeNewline).at(-1)?.body ?? null;
    const newlineDom = await page.locator(selector).innerText();
    details.phases.newline = {
      key: 'Shift+Enter',
      inserted: NEWLINE_CHUNK,
      accepted_forms: newlineForms,
      response_status: newlineResponse?.status() ?? null,
      receipt: newlineReceipt,
      request_payload: newlinePayload,
      status_text: newlineStatus,
      dom_after: newlineDom,
      disk_raw: newlineDiskRaw,
    };
    cases.push({
      id: 'typing/newline',
      ok: newlineResponse?.status() === 200
        && newlineForms.includes(newlineDiskRaw)
        && newlineDom.includes(NEWLINE_CHUNK),
      name: '块内换行（Shift+Enter）：保存后磁盘上还是同一块，换行后的新文本在',
      evidence: {
        response_status: newlineResponse?.status() ?? null,
        receipt: newlineReceipt,
        request_payload: newlinePayload,
        accepted_forms: newlineForms,
        disk_raw: newlineDiskRaw,
        dom_contains_new_text: newlineDom.includes(NEWLINE_CHUNK),
        status_text: newlineStatus,
      },
    });

    // 跨块选区：选 DOM 里连续三个「有块内编辑面」的块，保证选区中间不夹表格/代码/图片。
    const anchors = await page.evaluate(() => {
      const all = [...document.querySelectorAll('.doc-block')];
      let at = -1;
      for (let i = 0; i + 2 < all.length; i += 1) {
        if (all.slice(i, i + 3).every((node) => node.querySelector('.block-text'))) { at = i; break; }
      }
      if (at < 0) return null;
      const chosen = all.slice(at, at + 3);
      const selection = window.getSelection();
      selection.removeAllRanges();
      const range = document.createRange();
      range.setStart(chosen[0].querySelector('.block-text'), 0);
      const last = chosen[2].querySelector('.block-text');
      range.setEnd(last, last.childNodes.length);
      selection.addRange(range);
      return chosen.map((node) => node.dataset.anchor);
    });
    if (!anchors) throw Error('找不到连续三个可编辑块，无法测跨块选区');
    await sleep(350);
    const targetAnchors = await page.evaluate(() => [...document.querySelectorAll('.doc-block.is-feedback-target')]
      .map((node) => node.dataset.anchor));
    const buttonVisible = await page.locator('#selectionFeedback').isVisible();
    await page.locator('#selectionFeedback').click();
    const composerVisible = await page.locator('#feedbackComposer').isVisible();
    const note = await page.locator('#feedbackTargetNote').innerText();
    const shaBeforeFeedback = (await getJson(`${server.url}/api/doc`)).body.sha256;
    const feedbackPromise = page.waitForResponse((response) => response.url().endsWith('/api/feedback'), { timeout: 10000 });
    await page.locator('#feedbackText').fill('这三块一起改：把结论提前。');
    await page.locator('#feedbackSubmit').click();
    const feedbackResponse = await feedbackPromise;
    const feedbackReceipt = await feedbackResponse.json().catch(() => null);
    const shaAfterFeedback = (await getJson(`${server.url}/api/doc`)).body.sha256;
    details.phases.selection = {
      anchors,
      highlighted: targetAnchors,
      button_visible: buttonVisible,
      composer_visible: composerVisible,
      note,
      feedback_status: feedbackResponse.status(),
      feedback_receipt: feedbackReceipt,
      doc_sha_unchanged: shaBeforeFeedback === shaAfterFeedback,
    };
    cases.push({
      id: 'typing/cross-block-selection',
      ok: JSON.stringify(targetAnchors) === JSON.stringify(anchors) && buttonVisible,
      name: '跨块选区吸附到三块整块（半句也吸）',
      evidence: { expected: anchors, actual: targetAnchors },
    });
    cases.push({
      id: 'typing/selection-feedback',
      ok: composerVisible && note.includes('3')
        && feedbackResponse.status() === 200
        && feedbackReceipt?.ok === true
        && feedbackReceipt?.task?.blocks?.length === 3
        && shaBeforeFeedback === shaAfterFeedback,
      name: '跨块选区派发：回执绑定三块，原文未改',
      evidence: {
        note,
        feedback_status: feedbackResponse.status(),
        task_blocks: feedbackReceipt?.task?.blocks?.length ?? null,
        dispatch_channel: feedbackReceipt?.dispatch?.channel ?? null,
        doc_sha_unchanged: shaBeforeFeedback === shaAfterFeedback,
      },
    });

    // 回车分块：SPEC 第 4 节「回车分块」。目标块在块尾回车时后半为空，空块先在页面里
    // 待定（契约要求锚点贴内容），第一次输入才带着内容调一次 split；新块拿新锚点。
    const docBeforeSplit = (await getJson(`${server.url}/api/doc`)).body;
    const countBeforeSplit = docBeforeSplit.blocks.length;
    const rawBeforeSplit = readBlockRaw(path, target.anchor);
    await page.locator(selector).click();
    await caretToEnd(page, selector);
    const splitResponsePromise = page.waitForResponse((response) => response.url().endsWith('/api/block/split'), { timeout: 10000 }).catch(() => null);
    await page.keyboard.press('Enter');
    const pendingVisible = await page.waitForSelector('.doc-block.is-pending', { timeout: 3000 }).then(() => true).catch(() => false);
    await page.keyboard.insertText(SPLIT_CHUNK);
    const splitResponse = await splitResponsePromise;
    await sleep(300);
    const splitReceipt = splitResponse ? await splitResponse.json().catch(() => null) : null;
    const afterSplit = (await getJson(`${server.url}/api/doc`)).body;
    const splitAnchor = splitReceipt?.new_block?.anchor ?? null;
    const splitBlock = splitAnchor ? afterSplit.blocks.find((block) => block.anchor === splitAnchor) : null;
    details.phases.split = {
      pending_block_visible: pendingVisible,
      inserted: SPLIT_CHUNK,
      response_status: splitResponse?.status() ?? null,
      receipt: splitReceipt,
      new_anchor: splitAnchor,
      new_block_raw: splitBlock?.raw ?? null,
      block_count: { before: countBeforeSplit, after: afterSplit.blocks.length },
    };
    cases.push({
      id: 'typing/enter-split',
      ok: pendingVisible
        && splitResponse?.status() === 200
        && splitReceipt?.ok === true
        && typeof splitAnchor === 'string' && splitAnchor !== target.anchor
        && splitBlock?.raw === SPLIT_CHUNK
        && afterSplit.blocks.find((block) => block.anchor === target.anchor)?.raw === rawBeforeSplit
        && afterSplit.blocks.length === countBeforeSplit + 1,
      name: '回车分块：新块拿新锚点、原块内容不变，块数 +1',
      evidence: {
        response_status: splitResponse?.status() ?? null,
        new_anchor: splitAnchor,
        new_block_raw: splitBlock?.raw ?? null,
        original_raw_unchanged: afterSplit.blocks.find((block) => block.anchor === target.anchor)?.raw === rawBeforeSplit,
        block_count: { before: countBeforeSplit, after: afterSplit.blocks.length },
      },
    });

    // 空块 Backspace 合并：把新块清空再按 Backspace，后一块的锚点删除、前一块留原锚点。
    if (splitAnchor) {
      const newSelector = `.doc-block[data-anchor="${splitAnchor}"] .block-text`;
      await page.locator(newSelector).click();
      await page.evaluate((selectorForBlock) => {
        const node = document.querySelector(selectorForBlock);
        node.focus();
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }, newSelector);
      await page.keyboard.press('Backspace');
      await sleep(150);
      const mergeResponsePromise = page.waitForResponse((response) => response.url().endsWith('/api/block/merge'), { timeout: 10000 }).catch(() => null);
      await page.keyboard.press('Backspace');
      const mergeResponse = await mergeResponsePromise;
      await sleep(400);
      const mergeReceipt = mergeResponse ? await mergeResponse.json().catch(() => null) : null;
      const afterMerge = (await getJson(`${server.url}/api/doc`)).body;
      details.phases.merge = {
        removed_anchor: splitAnchor,
        response_status: mergeResponse?.status() ?? null,
        receipt: mergeReceipt,
        block_count: { before: countBeforeSplit + 1, after: afterMerge.blocks.length },
        kept_raw: afterMerge.blocks.find((block) => block.anchor === target.anchor)?.raw ?? null,
      };
      cases.push({
        id: 'typing/backspace-merge',
        ok: mergeResponse?.status() === 200
          && mergeReceipt?.ok === true
          && !afterMerge.blocks.some((block) => block.anchor === splitAnchor)
          && afterMerge.blocks.find((block) => block.anchor === target.anchor)?.raw === rawBeforeSplit
          && afterMerge.blocks.length === countBeforeSplit,
        name: '空块 Backspace：并入前一块，被删块的锚点不再存在，前一块内容逐字不动',
        evidence: {
          response_status: mergeResponse?.status() ?? null,
          removed_anchor: splitAnchor,
          kept_anchor: target.anchor,
          kept_raw: afterMerge.blocks.find((block) => block.anchor === target.anchor)?.raw ?? null,
          block_count: { before: countBeforeSplit + 1, after: afterMerge.blocks.length },
        },
      });
    }

    // ── 行首前缀 → 块类型（票 30，SPEC 第 7 节） ─────────────────────────────
    // 回车新开一块，敲 `## `：保存路径把这一块变成一页，前缀隐去、目录里出现这一页。
    const pageResponsePromise = page.waitForResponse((response) => response.url().endsWith('/api/block/split'), { timeout: 10000 }).catch(() => null);
    await page.locator(selector).click();
    await caretToEnd(page, selector);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.doc-block.is-pending', { timeout: 3000 });
    await page.keyboard.insertText('## 前缀验收页');
    const pageResponse = await pageResponsePromise;
    await sleep(500);
    const pageReceipt = pageResponse ? await pageResponse.json().catch(() => null) : null;
    const afterPage = readDoc(path);
    const pageTitle = afterPage.parsed.pages.find((item) => item.title === '前缀验收页') ?? null;
    // 目录在中等宽度会把页名藏起来（只留页号），所以按条目自己的 title 判，不看可见文本。
    const tocPages = await page.locator('#toc [data-page]').evaluateAll((items) => items.map((item) => item.title));
    details.phases.prefix = { prefix_page: { response_status: pageResponse?.status() ?? null, receipt: pageReceipt } };
    cases.push({
      id: 'typing/prefix-page',
      ok: pageResponse?.status() === 200
        && Boolean(pageTitle)
        && afterPage.raw.includes('## 前缀验收页')
        && !afterPage.raw.includes('\\##')
        && !afterPage.raw.includes('## 前缀验收页<!--')
        && tocPages.includes('前缀验收页'),
      name: '行首 `## ` 得到一页：文件里是真标题行、目录里出现这一页、前缀不被转义',
      evidence: {
        response_status: pageResponse?.status() ?? null,
        page_title: pageTitle?.title ?? null,
        file_has_real_heading: afterPage.raw.includes('## 前缀验收页'),
        escaped_prefix: afterPage.raw.includes('\\##'),
        anchor_on_heading: afterPage.raw.includes('## 前缀验收页<!--'),
        toc_has_page: tocPages.includes('前缀验收页'),
        toc_pages: tocPages,
      },
    });

    // `### `：得到标题块；写完前缀隐去，编辑面里只剩标题文字。
    await page.locator(selector).click();
    await page.evaluate((selectorForBlock) => {
      const node = document.querySelector(selectorForBlock);
      node.focus();
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }, selector);
    const headingResponsePromise = page.waitForResponse((response) => response.url().endsWith('/api/block'), { timeout: 10000 }).catch(() => null);
    await page.keyboard.insertText('### 前缀验收标题');
    const headingResponse = await headingResponsePromise;
    await sleep(500);
    const headingReceipt = headingResponse ? await headingResponse.json().catch(() => null) : null;
    const headingDom = {
      type: await page.locator(`.doc-block[data-anchor="${target.anchor}"]`).getAttribute('data-type'),
      text: await page.locator(selector).innerText(),
      prefix: await page.locator(`.doc-block[data-anchor="${target.anchor}"] .block-prefix`).innerText().catch(() => null),
    };
    details.phases.prefix.prefix_heading = { response_status: headingResponse?.status() ?? null, receipt: headingReceipt, dom: headingDom };
    cases.push({
      id: 'typing/prefix-heading',
      ok: headingResponse?.status() === 200
        && headingReceipt?.block?.type === 'heading'
        && headingReceipt?.block?.raw === '### 前缀验收标题'
        && headingDom.type === 'heading'
        && headingDom.text === '前缀验收标题'
        && headingDom.prefix === '### ',
      name: '行首 `### ` 得到标题块：写入后前缀从正文隐去，只留排版',
      evidence: {
        response_status: headingResponse?.status() ?? null,
        block_type: headingReceipt?.block?.type ?? null,
        block_raw: headingReceipt?.block?.raw ?? null,
        dom: headingDom,
      },
    });

    // 标题删空：退回段落，前缀重新出现在正文里。
    await page.locator(selector).click();
    await page.evaluate((selectorForBlock) => {
      const node = document.querySelector(selectorForBlock);
      node.focus();
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }, selector);
    const revertResponsePromise = page.waitForResponse((response) => response.url().endsWith('/api/block'), { timeout: 10000 }).catch(() => null);
    await page.keyboard.press('Backspace');
    const revertResponse = await revertResponsePromise;
    await sleep(600);
    const revertReceipt = revertResponse ? await revertResponse.json().catch(() => null) : null;
    const revertDom = {
      type: await page.locator(`.doc-block[data-anchor="${target.anchor}"]`).getAttribute('data-type'),
      text: await page.locator(selector).innerText(),
      prefixSpans: await page.locator(`.doc-block[data-anchor="${target.anchor}"] .block-prefix`).count(),
    };
    details.phases.prefix.prefix_revert = { response_status: revertResponse?.status() ?? null, receipt: revertReceipt, dom: revertDom };
    cases.push({
      id: 'typing/prefix-revert',
      ok: revertResponse?.status() === 200
        && revertReceipt?.block?.type === 'paragraph'
        && revertDom.type === 'paragraph'
        && revertDom.text.includes('###')
        && revertDom.prefixSpans === 0,
      name: '标题里把字删空：退回段落、前缀重新出现，保存不返回 409',
      evidence: {
        response_status: revertResponse?.status() ?? null,
        block_type: revertReceipt?.block?.type ?? null,
        dom: revertDom,
      },
    });

    // 输入法组字期间不转换：组字中不排保存，提交后才按前缀得到标题块。
    await page.locator(selector).click();
    await page.evaluate((selectorForBlock) => {
      const node = document.querySelector(selectorForBlock);
      node.focus();
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }, selector);
    const imeBefore = readDoc(path).raw;
    await cdp.send('Input.imeSetComposition', { text: '#### 组字中', selectionStart: 5, selectionEnd: 5 });
    await sleep(1200);
    const imeDuring = readDoc(path).raw;
    const imeResponsePromise = page.waitForResponse((response) => response.url().endsWith('/api/block'), { timeout: 10000 }).catch(() => null);
    await cdp.send('Input.insertText', { text: '#### 输入法标题' });
    const imeResponse = await imeResponsePromise;
    await sleep(500);
    const imeReceipt = imeResponse ? await imeResponse.json().catch(() => null) : null;
    const imeAfter = readDoc(path);
    details.phases.prefix.prefix_ime = {
      during_unchanged: imeDuring === imeBefore,
      response_status: imeResponse?.status() ?? null,
      receipt: imeReceipt,
    };
    cases.push({
      id: 'typing/prefix-ime',
      ok: imeDuring === imeBefore
        && imeResponse?.status() === 200
        && imeReceipt?.block?.type === 'heading'
        && imeReceipt?.block?.raw === '#### 输入法标题'
        && imeAfter.raw.includes('#### 输入法标题')
        && !imeAfter.raw.includes('\\####'),
      name: '输入法组字期间不转换；提交后才按 `#### ` 得到四级标题块',
      evidence: {
        during_composition_file_unchanged: imeDuring === imeBefore,
        response_status: imeResponse?.status() ?? null,
        block_raw: imeReceipt?.block?.raw ?? null,
        file_has_heading: imeAfter.raw.includes('#### 输入法标题'),
        escaped_prefix: imeAfter.raw.includes('\\####'),
      },
    });

    // 工具栏只有四个行内格式，不做块按钮（块类型靠前缀，不靠菜单）。
    const toolbarCommands = await page.locator('#inlineToolbar [data-inline]').evaluateAll((items) => items.map((item) => item.dataset.inline));
    const blockButtons = await page.locator('#inlineToolbar [data-block]').count();
    cases.push({
      id: 'typing/toolbar-inline-only',
      ok: JSON.stringify([...toolbarCommands].sort()) === JSON.stringify(['bold', 'code', 'italic', 'link']) && blockButtons === 0,
      name: '工具栏只保留加粗、斜体、链接、行内代码四个行内格式，不做块按钮',
      evidence: { commands: toolbarCommands, block_buttons: blockButtons },
    });
  } catch (error) {
    cases.push({
      id: 'typing/error',
      ok: false,
      name: '浏览器用例异常',
      evidence: { error: error.message, stack: error.stack?.split('\n').slice(0, 4) },
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await server.close().catch(() => {});
    sandbox.cleanup();
  }
  return {
    id: 'typing',
    title: '中文输入、跨块选区、撤销重做',
    blocked: false,
    cases,
    details,
    environment: { playwright: browserInfo.resolvedFrom, chromium_version: browserVersion },
  };
}
