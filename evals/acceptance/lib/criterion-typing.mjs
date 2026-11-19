/**
 * 判据二：块内连续中文输入（含标点、换行、撤销），不丢字、不错位、保存后文本正确；
 * 外加跨块选区按整块吸附并派发。
 *
 * 走真实浏览器（Playwright + CDP），不是模拟 DOM：
 *   · IME：CDP Input.imeSetComposition 触发 composition，再 Input.insertText 提交
 *   · 标点：逐字插入中文标点
 *   · 换行：Enter（工作台的 keydown 把 Enter 接成块内换行）
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

    // 换行：Enter 是工作台声明的块内换行入口（SPEC 第 4 节则写作「回车分块」）。
    // 记录工作台实际回执与磁盘，不替实现圆场。
    const requestsBeforeNewline = saveRequests.length;
    const responsePromise = page.waitForResponse((response) => response.url().endsWith('/api/block'), { timeout: 8000 }).catch(() => null);
    await page.keyboard.press('Enter');
    await page.keyboard.insertText(NEWLINE_CHUNK);
    const newlineResponse = await responsePromise;
    const newlineStatus = await statusText(page);
    await sleep(300);
    const newlineReceipt = newlineResponse ? await newlineResponse.json().catch(() => null) : null;
    const newlineDiskRaw = readBlockRaw(path, target.anchor);
    const newlinePayload = saveRequests.slice(requestsBeforeNewline).at(-1)?.body ?? null;
    const newlineDom = await page.locator(selector).innerText();
    details.phases.newline = {
      key: 'Enter',
      inserted: NEWLINE_CHUNK,
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
        && typeof newlineDiskRaw === 'string'
        && newlineDiskRaw.includes(NEWLINE_CHUNK)
        && newlineDom.includes(NEWLINE_CHUNK),
      name: '换行：保存后磁盘文本正确（含换行后的新文本）',
      evidence: {
        response_status: newlineResponse?.status() ?? null,
        receipt: newlineReceipt,
        request_payload: newlinePayload,
        dom_contains_new_text: newlineDom.includes(NEWLINE_CHUNK),
        disk_contains_new_text: String(newlineDiskRaw).includes(NEWLINE_CHUNK),
        status_text: newlineStatus,
      },
    });
    // 把换行撤掉，恢复可保存文本，继续测跨块选区。
    await page.keyboard.press(`${META}+z`);
    await sleep(900);
    await waitForDisk(path, target.anchor, (raw) => raw === withChunk, 5000);

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
