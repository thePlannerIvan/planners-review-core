"""Real Chromium checks for the optional content shell; no DOM stubs.

两种壳都验：legacy（interactions.js）与 workbench（workbench-editor.js）。
重点是「桥不好使时页面也要先把自己画出来」：离线（根本没有桥）和握手卡住（桥不 resolve）
都不能白屏，也不能把可读内容藏到握手后面。
"""
import argparse
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('--html', required=True)
args = parser.parse_args()
html = Path(args.html).read_text()
data = json.loads(html.split('<script id="reviewData" type="application/json">')[1].split('</script>')[0])
workbench = bool(data.get('workbench'))
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    try:
        for stuck in (False, True):
            page = browser.new_page(viewport={'width': 1352, 'height': 785})
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            entry = html.replace('{{REVIEW_BRIDGE}}', '<script>window.ReviewBridge={connect:()=>new Promise(()=>{})}</script>' if stuck else '')
            page.set_content(entry)
            # 两种壳共有：永久刷新出口、水印、没有旧版 editToggle
            expect(page.locator('#reload')).to_be_visible()
            expect(page.locator('.watermark')).to_contain_text('阿祖不看 TVC')
            assert page.locator('#editToggle').count() == 0
            assert page.locator('#saveButton').count() == 1
            if workbench:
                # 工作台先 render() 再连桥：内容必须已经在页面上。
                expect(page.locator('.page-nav')).to_have_count(len(data['pages']))
                if data['sections']:
                    expect(page.locator('#outlineList .outline-line')).to_have_count(len(data['pages']))
                    expect(page.locator('.line-title').first).not_to_be_empty()
                    assert page.locator('.support-text[data-support-index]').count() >= len(data['pages'])
                    assert page.locator('[data-outline-note]').count() == len(data['pages'])
                    expect(page.locator('.thesis p')).not_to_be_empty()
                else:
                    expect(page.locator('#pageTitle')).to_be_visible()
                if stuck:
                    # 握手卡住：2.5s 兜底之后必须说出来「暂时无法保存」并进入只读，而不是静默白等。
                    page.wait_for_timeout(2700)
                    expect(page.locator('#notice')).to_contain_text('暂时无法保存修改')
                    expect(page.locator('#saveState')).to_have_text('未连接')
                else:
                    page.wait_for_timeout(100)
                    # 离线（没有桥）：仍然可读，并说明只读原因（不再把 ReviewBridge 未定义抛给人看）
                    expect(page.locator('#notice')).to_contain_text('当前只读')
                    expect(page.locator('#notice')).to_contain_text('没有连上审阅宿主')
                assert page.locator('#saveButton').is_disabled()
                assert page.locator('#feedback').is_disabled()
            else:
                expected = len(data['sections']) or len(data['pages'])
                expect(page.locator('.page-nav')).to_have_count(expected)
                expect(page.locator('.story-card').first if data['sections'] else page.locator('#pageTitle')).not_to_be_empty()
                page.wait_for_timeout(2700 if stuck else 100)
                expect(page.locator('#notice')).to_contain_text('暂时无法保存')
            assert errors == [], errors
            assert page.evaluate('document.documentElement.scrollHeight <= innerHeight')
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.close()
    finally:
        browser.close()
print('Chromium: offline and stalled handshake render PASS')
