"""Real Chromium checks for the optional content shell; no DOM stubs."""
import argparse
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('--html', required=True)
args = parser.parse_args()
html = Path(args.html).read_text()
data = json.loads(html.split('<script id="reviewData" type="application/json">')[1].split('</script>')[0])
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    try:
        for stuck in (False, True):
            page = browser.new_page(viewport={'width':1352,'height':785})
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            entry = html.replace('{{REVIEW_BRIDGE}}', '<script>window.ReviewBridge={connect:()=>new Promise(()=>{})}</script>' if stuck else '')
            page.set_content(entry)
            expected = len(data['sections']) or len(data['pages'])
            expect(page.locator('.page-nav')).to_have_count(expected)
            expect(page.locator('.story-card').first if data['sections'] else page.locator('#pageTitle')).not_to_be_empty()
            expect(page.locator('#reload')).to_be_visible()
            expect(page.locator('.watermark')).to_contain_text('阿祖不看 TVC')
            assert page.locator('#editToggle').count() == 0
            page.wait_for_timeout(2700 if stuck else 100)
            expect(page.locator('#notice')).to_contain_text('暂时无法保存')
            assert errors == [], errors
            assert page.evaluate('document.documentElement.scrollHeight <= innerHeight')
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.close()
    finally:
        browser.close()
print('Chromium: offline and stalled handshake render PASS')
