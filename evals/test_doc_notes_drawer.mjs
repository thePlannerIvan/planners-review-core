import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// 票 37 的判据是一句话：抽屉里只出现「被引用的那句话」。页名、章节名、页号、分组标题
// 都是噪声；点一条批注要跳回正文里那一块、把光标放进去、短暂高亮；底部只剩两枚按钮。
// 看不清像素的那一半用真实页面量：文字内容、元素在不在、点了之后焦点落在哪。
async function openBrowser(t) {
  const { loadPlaywright } = await import('./acceptance/lib/harness.mjs');
  const browserInfo = await loadPlaywright();
  if (!browserInfo.available) {
    t.skip(`跳过真实页面验收：${browserInfo.reason}`);
    return null;
  }
  const dir = mkdtempSync(join(tmpdir(), 'planners-notes-drawer-'));
  const docPath = join(dir, 'storyline.md');
  // 十几页：要跳的那一块远在视野之外；页名与章节名都写得一眼能认出来。
  const pages = [];
  for (let index = 1; index <= 12; index += 1) {
    const lines = [`## 品类机会${index}`];
    for (let line = 1; line <= 3; line += 1) {
      // 锚点形状是 b: + 6~12 位十六进制，六个字符刚好。
      lines.push(`第 ${line} 段正文，平铺一句正常的话。<!-- b:a${String(index).padStart(2, '0')}${String(line).padStart(2, '0')}0 -->`);
    }
    pages.push(lines.join('\n\n'));
  }
  pages.push('## 最后一页\n\n这一块是批注指向的那一句，它长到一行肯定放不下，所以要被截断成一行并省略。<!-- b:ff0001 -->');
  writeFileSync(docPath, '---\ncontract: planners-doc/2\ndoc: storyline\nproject: 抽屉跳转\n---\n\n'
    + '# 一、判断\n\n' + pages.join('\n\n') + '\n', 'utf8');

  const target = 'b:ff0001';
  const { startDocWorkbench } = await import('../scripts/doc-workbench.mjs');
  const server = await startDocWorkbench({ docPath, port: 0 });
  const added = await fetch(`${server.url}/api/note`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ anchor: target, text: '这段太长了，收一收' }),
  });
  assert.equal(added.status, 200, `加一条草稿：${await added.text()}`);

  const browser = await browserInfo.playwright.chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await server.close();
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(server.url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.body.dataset.layout === 'wide');
  const row = page.locator('#notesList .note-row').first();
  await row.waitFor({ state: 'visible' });
  return { page, row, target };
}

test('抽屉里只有被引用的那句话：没有页名 / 章节名 / 页号，也没有分组标题', async (t) => {
  const opened = await openBrowser(t);
  if (!opened) return;
  const { page } = opened;

  const drawerText = await page.locator('#notesList').innerText();
  assert.match(drawerText, /这段太长了，收一收/, '你写的那句话还在');
  assert.match(drawerText, /这一块是批注指向的那一句/, '每条带着它引用的那句话');
  for (const noise of ['品类机会', '一、判断', '最后一页']) {
    assert.equal(drawerText.includes(noise), false, `抽屉里不该出现页名 / 章节名：${noise}`);
  }
  assert.doesNotMatch(drawerText, /第\s*\d+\s*页/, '抽屉里不该出现页号');
  assert.equal(await page.locator('#notesList .note-page-title').count(), 0, '没有按页分组的分组标题');

  // 每条只有三样：引用的话、时间、删除；那句引用只出现一次（不再由分组头重复）。
  const row = opened.row;
  assert.equal(await row.locator('.note-quote').count(), 1, '一条批注只有一句引用');
  assert.equal(await row.locator('.note-text').count(), 1);
  assert.equal(await row.locator('time').count(), 1);
  assert.equal(await row.locator('.note-delete').count(), 1);

  // 引用的话截成一行：单行省略，不撑高抽屉。
  const quote = await row.locator('.note-quote').evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      whiteSpace: style.whiteSpace,
      textOverflow: style.textOverflow,
      overflow: style.overflowX || style.overflow,
      height: node.getBoundingClientRect().height,
      lineHeight: parseFloat(style.lineHeight),
      clipped: node.scrollWidth > node.clientWidth + 1,
    };
  });
  assert.equal(quote.whiteSpace, 'nowrap', '引用的话不换行');
  assert.equal(quote.textOverflow, 'ellipsis', '放不下就省略');
  assert.equal(quote.overflow, 'hidden');
  assert.ok(quote.clipped, '这句话比一行长，确实被截掉了');
  assert.ok(quote.height <= quote.lineHeight * 1.5, `只占一行的高度：${quote.height} / ${quote.lineHeight}`);
});

test('底部只有两枚按钮：整篇反馈与提交模型（带条数）', async (t) => {
  const opened = await openBrowser(t);
  if (!opened) return;
  const { page } = opened;
  const foot = page.locator('.notes-foot');
  assert.deepEqual(await foot.locator('button').allInnerTexts(), ['整篇反馈', '提交模型 · 1'],
    '底部就是这两枚：整篇反馈 + 提交模型（条数跟着草稿数）');
  assert.equal(await page.locator('#notesOverallPage').count(), 0, '「反馈这一页」的入口删掉');
  const panelText = await page.locator('#notesPanel').innerText();
  assert.equal(panelText.includes('反馈整份'), false, '「反馈整份」的入口删掉');

  // 整篇反馈：草稿就写在抽屉里，光标进去。
  await page.locator('#notesOverallDoc').click();
  await page.locator('#notesCompose').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('#notesComposeText')), true,
    '整篇反馈的草稿写在抽屉里，光标已经进去');
  assert.deepEqual(await foot.locator('button').allInnerTexts(), ['整篇反馈', '提交模型 · 1'],
    '写整篇反馈没有在底部多出第三枚按钮');
});

test('点一条批注：正文滚到那一块、光标进可编辑块、短暂高亮', async (t) => {
  const opened = await openBrowser(t);
  if (!opened) return;
  const { page, row, target } = opened;
  const selector = `[data-anchor="${target}"]`;

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(() => window.scrollY === 0);
  const before = await page.evaluate((sel) => {
    const rect = document.querySelector(sel).getBoundingClientRect();
    return { top: rect.top, viewport: window.innerHeight };
  }, selector);
  assert.ok(before.top > before.viewport, `前提：那一块还在视野外（${before.top} > ${before.viewport}）`);

  await row.locator('.note-jump').click();

  // 短暂高亮：点完立刻亮起。
  await page.waitForFunction((sel) => document.querySelector(sel).classList.contains('is-note-flash'), selector,
    { timeout: 3000 });
  // 聚焦：可编辑块把光标放进去。
  assert.equal(await page.evaluate((sel) => {
    const editable = document.querySelector(`${sel} [contenteditable="true"]`);
    return editable !== null && document.activeElement === editable;
  }, selector), true, '光标落进那一块');
  // 滚过去：那一块现在整块在视野里。
  await page.waitForFunction((sel) => {
    const rect = document.querySelector(sel).getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= window.innerHeight;
  }, selector, { timeout: 5000 });

  // 高亮是短暂的：过一会儿自己退掉，不留一个常亮状态。
  await page.waitForTimeout(1800);
  assert.equal(await page.evaluate((sel) => document.querySelector(sel).classList.contains('is-note-flash'), selector),
    false, '高亮只是路过');
  // 抽屉保持打开：点完还能接着看别的批注。
  assert.equal(await page.locator('#notesPanel').isVisible(), true);
});
