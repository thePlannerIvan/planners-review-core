"""Exercise a producer-built surface in HTTP and opaque-iframe hosts."""
import argparse
import json
import subprocess
import time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

CORE = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--surface', required=True)
parser.add_argument('--opaque', action='store_true')
parser.add_argument('--screenshot')
args = parser.parse_args()
surface = Path(args.surface).resolve()
directory = surface.parent
entry = (directory / 'index.html').read_text()
data = json.loads(entry.split('<script id="reviewData" type="application/json">')[1].split('</script>')[0])
draft_file = directory / json.loads(surface.read_text())['draft']
submission_file = directory / 'review-submissions.json'

def wait_draft(test):
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        try:
            draft = json.loads(draft_file.read_text())
            if test(draft):
                return draft
        except (FileNotFoundError, json.JSONDecodeError, KeyError):
            pass
        time.sleep(.05)
    raise AssertionError('Draft did not match')

HARNESS = '''<!doctype html><meta charset="utf-8"><style>body{margin:0;overflow:hidden}iframe{display:block;width:100vw;height:100vh;border:0}</style>
<iframe id="frame" sandbox="allow-scripts" src="plugin-frame.html"></iframe><script>
const frame=document.getElementById('frame');window.calls=[];window.failDraft=false;
addEventListener('message',async event=>{
 const d=event.data;if(event.source!==frame.contentWindow||!d||d.__review!==true)return;
 const send=value=>frame.contentWindow.postMessage({__review:true,nonce:d.nonce,...value},'*');
 if(d.type==='hello'){window.nonce=d.nonce;return send({type:'init',host:'test',capabilities:['draft','asset-upload'],surface:{id:'test'}});}
 if(d.type!=='call')return;window.calls.push(d.method);
 try{
  if(d.method==='draft'&&window.failDraft)throw Error('test failure');let value;
  if(d.method==='read'||d.method==='asset'){
   const r=await fetch(d.payload.rel);if(!r.ok)throw Error('read '+r.status);
   value={bytes:new Uint8Array(await r.arrayBuffer()),type:r.headers.get('content-type')};
  }else{
   const r=await fetch('/__review/'+d.method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d.payload)});
   value=await r.json();if(!r.ok||value.ok===false)throw Error('write '+r.status);
  }send({type:'result',id:d.id,ok:true,value});
 }catch(error){send({type:'result',id:d.id,ok:false,error:String(error)});}
});</script>'''
if args.opaque:
    bridge = (CORE / 'assets/review-bridge.js').read_text()
    frame = entry.replace('{{REVIEW_BRIDGE}}', '<script>' + bridge + '</script>')
    frame = frame.replace('<head>', '<head><meta http-equiv="Content-Security-Policy" content="img-src blob: data:">')
    (directory / 'plugin-frame.html').write_text(frame)
    (directory / 'harness.html').write_text(HARNESS)
host = json.loads(subprocess.check_output(['node',str(CORE / 'scripts/review-host.mjs'),'start',str(surface)],text=True))
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width':1352,'height':785})
    page = context.new_page()
    errors = []
    page.on('pageerror',lambda e: errors.append(str(e)))
    try:
        url = host['url'].rsplit('/',1)[0] + '/harness.html' if args.opaque else host['url']
        page.goto(url,wait_until='networkidle')
        ui = page.frame_locator('#frame') if args.opaque else page
        expect(ui.locator('#saveButton')).to_be_enabled()
        if args.screenshot:
            page.screenshot(path=args.screenshot)
        if data['sections']:
            expect(ui.locator('.story-card')).to_have_count(len(data['sections']))
            ui.locator('.story-card [data-field="title"]').first.fill('Human chapter')
            ui.locator('.thesis p').fill('Human thesis')
            first = data['sections'][0]['section_id']
            wait_draft(lambda d: d['edits']['sections'][first]['title'] == 'Human chapter')
            if len(data['sections']) > 1:
                ui.locator('.page-nav .drag-handle').first.press('Alt+ArrowDown')
                wait_draft(lambda d: d['section_order'][1] == first)
            ui.locator('[data-mode="bypage"]').click()
        ui.locator('#pageTitle').fill('Human "title"')
        if data['sections']:
            ui.locator('[data-block-text]').first.fill('Human expanded block')
        else:
            ui.locator('#pageContent .rich-block p').first.click()
            ui.locator('#pageContent textarea').fill('Human expanded copy')
            ui.locator('#pageTitle').click()
            cell = ui.locator('#pageContent td').first
            if cell.count():
                cell.click()
                cell.locator('textarea').fill('Human table cell')
                ui.locator('#pageTitle').click()
            for image in ui.locator('#pageContent img').all():
                expect(image).to_have_js_property('complete',True)
                assert image.evaluate('(el)=>el.naturalWidth') > 0
                if args.opaque:
                    assert image.get_attribute('src').startswith('blob:')
                image.click()
                expect(ui.locator('#imageModal')).to_have_class('modal open')
                ui.locator('#modalClose').click()
        wait_draft(lambda d: d['edits']['pages']['1']['title'] == 'Human "title"')
        ui.locator('#pageTitle').fill('')
        wait_draft(lambda d: d['edits']['pages']['1']['title'] == '')
        page.reload(wait_until='networkidle')
        expect(ui.locator('#pageTitle')).to_have_text('')
        ui.locator('#pageTitle').fill('Human "title"')
        if len(data['pages']) > 1:
            # Pointer drag, not a synthetic list assignment.
            handle = ui.locator('.page-nav[data-id="1"] .drag-handle').bounding_box()
            target = ui.locator('.page-nav[data-id="2"]').bounding_box()
            page.mouse.move(handle['x']+handle['width']/2,handle['y']+handle['height']/2)
            page.mouse.down()
            page.mouse.move(handle['x']+handle['width']/2,target['y']+target['height']*.85,steps=12)
            page.mouse.up()
            wait_draft(lambda d: d['page_order'][:2] == [2,1])
        assert not submission_file.exists(), 'Draft edits must not submit or wake'
        assert not (directory / 'wake-log.jsonl').exists()
        if args.opaque:
            page.evaluate('window.failDraft=true')
            ui.locator('#pageTitle').fill('Preserve failed edit')
            expect(ui.locator('#saveState')).to_have_text('未保存')
            expect(ui.locator('#pageTitle')).to_have_text('Preserve failed edit')
            page.evaluate('window.failDraft=false')
            ui.locator('#pageTitle').fill('Human "title"')
            ui.locator('#draftButton').click()
            wait_draft(lambda d: d['edits']['pages']['1']['title'] == 'Human "title"')
        ui.locator('[data-decision="approve"]').click()
        ui.locator('#saveButton').click()
        expect(ui.locator('#saveState')).to_have_text('已提交')
        payload = json.loads(submission_file.read_text())
        assert payload['review_changes']['edits']['pages']['1']['title'] == 'Human "title"'
        assert 'blob:' not in json.dumps(payload)
        assert payload['pre_check'] is True
        assert (directory / 'wake-log.jsonl').exists()
        page.reload(wait_until='networkidle')
        expect(ui.locator('#pageTitle')).to_have_text('Human "title"')
        snapshot = directory / 'review-snapshot.json'
        snapshot.write_text(json.dumps({'source_sha256':'0'*64}))
        if args.opaque:
            page.evaluate("frame.contentWindow.postMessage({__review:true,nonce:window.nonce,type:'review/changed',payload:{units:[]}},'*')")
        expect(ui.locator('#notice')).to_contain_text('原文已有更新',timeout=7000)
        expect(ui.locator('#pageTitle')).to_have_text('Human "title"')
        ui.locator('#saveButton').click()
        assert json.loads(submission_file.read_text())['saved_at'] == payload['saved_at']
        assert errors == [], errors
        dimensions = page.evaluate('({height:document.documentElement.scrollHeight,viewport:innerHeight})')
        assert dimensions['height'] <= dimensions['viewport'], dimensions
        print(('Opaque iframe' if args.opaque else 'HTTP') + ': producer shell editing, ordering, draft restore, submit, version safety PASS')
    finally:
        context.close()
        browser.close()
        subprocess.run(['node',str(CORE / 'scripts/review-host.mjs'),'stop',str(surface)],check=True,capture_output=True)
