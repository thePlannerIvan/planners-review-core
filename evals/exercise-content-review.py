"""Exercise a producer-built surface in HTTP and opaque-iframe hosts.

两种壳共用这一份验收：
- legacy（interactions.js）：`workbench` 不为真，走旧审批截面；
- workbench（workbench-editor.js）：行内编辑、行内批注卡、按页自动保存、悬停拖动把手。
"""
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
parser.add_argument('--hook-cmd', help='工作台流程里模拟「模型改了主稿」：shell 命令，应在第一页内容上留下可核对的变化')
args = parser.parse_args()
surface = Path(args.surface).resolve()
directory = surface.parent
entry = (directory / 'index.html').read_text()
data = json.loads(entry.split('<script id="reviewData" type="application/json">')[1].split('</script>')[0])
surface_doc = json.loads(surface.read_text())
draft_file = directory / surface_doc['draft']
submission_file = directory / 'review-submissions.json'
workbench = bool(data.get('workbench'))


def read_json(path):
    return json.loads(Path(path).read_text())


def wait_until(test, message, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            value = test()
            if value:
                return value
        except (FileNotFoundError, json.JSONDecodeError, KeyError, TypeError):
            pass
        time.sleep(.05)
    raise AssertionError(message)


def wait_draft(test, message='Draft did not match'):
    return wait_until(lambda: read_json(draft_file) if test(read_json(draft_file)) else None, message)


HARNESS = '''<!doctype html><meta charset="utf-8"><style>body{margin:0;overflow:hidden}iframe{display:block;width:100vw;height:100vh;border:0}</style>
<iframe id="frame" sandbox="allow-scripts" src="plugin-frame.html"></iframe><script>
const frame=document.getElementById('frame');window.calls=[];window.failDraft=false;
addEventListener('message',async event=>{
 const d=event.data;if(event.source!==frame.contentWindow||!d||d.__review!==true)return;
 const send=value=>frame.contentWindow.postMessage({__review:true,nonce:d.nonce,...value},'*');
 if(d.type==='hello'){window.nonce=d.nonce;return send({type:'init',host:'test',capabilities:['draft','asset-upload','command'],surface:{id:'test'}});}
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
host = json.loads(subprocess.check_output(['node', str(CORE / 'scripts/review-host.mjs'), 'start', str(surface)], text=True))


def legacy_flow(page, ui, args=args):
    """旧审批截面（interactions.js）：一章一张故事卡，提交走 review-submissions。"""
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
            expect(image).to_have_js_property('complete', True)
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
        page.mouse.move(handle['x']+handle['width']/2, handle['y']+handle['height']/2)
        page.mouse.down()
        page.mouse.move(handle['x']+handle['width']/2, target['y']+target['height']*.85, steps=12)
        page.mouse.up()
        wait_draft(lambda d: d['page_order'][:2] == [2, 1])
    assert not submission_file.exists(), 'Draft edits must not submit or wake'
    assert not (directory / 'wake-log.jsonl').exists()
    if args.opaque:
        page.evaluate('window.failDraft=true')
        ui.locator('#pageTitle').fill('Preserve failed edit')
        expect(ui.locator('#saveState')).to_have_text('未保存')
        expect(ui.locator('#pageTitle')).to_have_text('Preserve failed edit')
        page.evaluate('window.failDraft=false')
        ui.locator('#pageTitle').fill('Human "title"')
        # 草稿自动保存（400ms 防抖），不再有手动按钮：等它自己落盘
        page.wait_for_timeout(300)
        wait_draft(lambda d: d['edits']['pages']['1']['title'] == 'Human "title"')
    ui.locator('[data-decision="approve"]').click()
    ui.locator('#saveButton').click()
    expect(ui.locator('#saveState')).to_have_text('已提交')
    payload = read_json(submission_file)
    assert payload['review_changes']['edits']['pages']['1']['title'] == 'Human "title"'
    assert 'blob:' not in json.dumps(payload)
    assert payload['pre_check'] is True
    assert (directory / 'wake-log.jsonl').exists()
    page.reload(wait_until='networkidle')
    expect(ui.locator('#pageTitle')).to_have_text('Human "title"')
    snapshot = directory / 'review-snapshot.json'
    snapshot.write_text(json.dumps({'source_sha256': '0'*64}))
    if args.opaque:
        page.evaluate("frame.contentWindow.postMessage({__review:true,nonce:window.nonce,type:'review/changed',payload:{units:[]}},'*')")
    expect(ui.locator('#notice')).to_contain_text('原文已有更新', timeout=7000)
    expect(ui.locator('#pageTitle')).to_have_text('Human "title"')
    ui.locator('#saveButton').click()
    assert read_json(submission_file)['saved_at'] == payload['saved_at']


def head_path():
    return directory / 'workbench' / 'head.json'


def head():
    return read_json(head_path())


def box(locator):
    """iframe 里 Playwright 的 bounding_box() 偶尔会在重渲染瞬间拿到 None，用 DOM rect 更稳。"""
    locator.wait_for(state='visible')
    return locator.evaluate('(el)=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};}')


def wait_head(test, message):
    return wait_until(lambda: head() if test(head()) else None, message)


def pending_tasks(scope=None):
    return [task for task in head().get('tasks', []) if task.get('status') == 'pending'
            and (scope is None or task.get('scope') == scope)]


def workbench_flow(page, ui):
    """新工作台（workbench-editor.js）：行内编辑、行内批注、按页自动保存与排序。"""
    expect(ui.locator('#saveButton')).to_be_enabled()
    expect(ui.locator('.page-nav')).to_have_count(len(data['pages']))
    assert not submission_file.exists(), '工作台不写 legacy 提交文件'

    if data['sections']:
        expect(ui.locator('#outlineList .outline-line')).to_have_count(len(data['pages']))
        # 章节与核心判断仍可改；章节信息默认折叠，展开后是故事卡
        if ui.locator('#chapterDetails').get_attribute('open') is None:
            ui.locator('#chapterDetails summary').click()
        expect(ui.locator('.story-card')).to_have_count(len(data['sections']))
        ui.locator('.thesis p').fill('Human thesis')
        ui.locator('.story-card [data-field="title"]').first.fill('Human chapter')
        first_section = data['sections'][0]['section_id']
        wait_draft(lambda d: d['edits'].get('thesis') == 'Human thesis'
                   and d['edits']['sections'][first_section]['title'] == 'Human chapter')
        # 故事线行内编辑：一句主张一行，支撑点哪改哪
        ui.locator('[data-outline-id="1"] [data-outline-title]').fill('Human "title"')
        wait_draft(lambda d: d['edits']['pages']['1']['title'] == 'Human "title"')
        support = ui.locator('[data-outline-id="1"] .support-text[data-support-index="0"]')
        expect(support).to_be_visible()
        support.fill('Human expanded support')
        wait_draft(lambda d: d['edits']['pages']['1']['blocks'][0] == 'Human expanded support')
        # 回车加一条、退格删掉空行（旧 UI 的 block-bullet 行为搬到了 support-text）
        row = ui.locator('[data-outline-id="1"]')
        before = len(read_json(draft_file)['edits']['pages']['1']['blocks'])
        ui.locator('[data-outline-id="1"] .support-text[data-support-index="0"]').press('Enter')
        wait_draft(lambda d: len(d['edits']['pages']['1']['blocks']) == before+1,
                   'Enter 应新增一条支撑')
        ui.locator('[data-outline-id="1"] .support-text[data-support-index="1"]').press('Backspace')
        wait_draft(lambda d: len(d['edits']['pages']['1']['blocks']) == before,
                   '空支撑退格应删除该行')
        if row.locator('[data-content-notes]').count():
            row.locator('[data-content-notes]').fill('Human content notes')
            wait_draft(lambda d: d['edits']['pages']['1'].get('notes') == 'Human content notes')
        # 行内批注卡：[data-outline-note] 是按钮，点开是 [data-note-input] 卡片
        expect(ui.locator('[data-note-input]')).to_have_count(0)
        ui.locator('[data-outline-note="1"]').click()
        note = ui.locator('[data-note-input="1"]')
        expect(note).to_be_visible()
        note.fill('Human page note')
        wait_draft(lambda d: d['feedbacks'].get('1') == 'Human page note')
        assert not pending_tasks('page'), '行内批注卡输入只存草稿，点「提交这一页」才生成任务'
        ui.locator('[data-comment-submit="1"]').click()
        wait_head(lambda h: any(t['scope'] == 'page' for t in pending_tasks('page')),
                  '行内批注提交后应产生 pending task')
        expect(ui.locator('#saveState')).to_have_text('已提交')
        page_task = pending_tasks('page')[-1]
        assert page_task['pages'] == [head()['page_mapping']['1']], page_task
        assert page_task['page_keys'] == [1], page_task
        assert page_task['page_hashes'] and page_task['page_hashes']['1'], page_task
        assert page_task['page_versions']['1'] == head()['page_versions']['1'], page_task
        assert page_task.get('created_at'), page_task
        if args.opaque:
            wait_until(lambda: (directory / 'wake-log.jsonl').exists(), '不透明 iframe 提交批注应唤醒模型')
        # 整页批注按钮（#pageTaskButton）保留：写右侧批注、一次提交所有页
        ui.locator('#feedback').fill('Human deck note')
        ui.locator('#pageTaskButton').click()
        wait_head(lambda h: len([t for t in h.get('tasks', []) if t.get('scope') == 'annotations']) >= 1,
                  '#pageTaskButton 应提交 annotations 任务')
        annotation_task = [t for t in pending_tasks('annotations')][-1]
        assert annotation_task['page_keys'] and annotation_task['page_hashes'], annotation_task
    else:
        # 逐页稿工作台：没有故事线，主编辑面是 #pageTitle 与正文
        expect(ui.locator('#pageTitle')).to_be_visible()
        ui.locator('#pageTitle').fill('Human "title"')
        wait_draft(lambda d: d['edits']['pages']['1']['title'] == 'Human "title"')
        if ui.locator('#pageContent .content-block p').count():
            ui.locator('#pageContent .content-block p').first.fill('Human expanded block')
        elif ui.locator('#pageContent .rich-block').count():
            ui.locator('#pageContent .rich-block p').first.click()
            ui.locator('#pageContent textarea').fill('Human expanded copy')
            ui.locator('#pageTitle').click()
        cell = ui.locator('#pageContent td').first
        if cell.count():
            cell.click()
            cell.locator('textarea').fill('Human table cell')
            ui.locator('#pageTitle').click()
        for image in ui.locator('#pageContent img').all():
            expect(image).to_have_js_property('complete', True)
            assert image.evaluate('(el)=>el.naturalWidth') > 0
            if args.opaque:
                assert image.get_attribute('src').startswith('blob:')
            # 工作台在图片上叠了「移除」按钮，命中测试会挡住中心点；用 DOM click 验预览仍打开。
            image.evaluate('(el)=>el.click()')
            expect(ui.locator('#imageModal')).to_have_class('modal open')
            ui.locator('#modalClose').click()
        if ui.locator('#pageContent img').count():
            assert ui.locator('#pageContent .image-inline-actions').count() > 0, '工作台图片应能就地移除'
        ui.locator('#feedback').fill('Human page note')
        wait_draft(lambda d: d['feedbacks'].get('1') == 'Human page note')
        ui.locator('#pageTaskButton').click()
        wait_head(lambda h: any(t.get('scope') == 'annotations' for t in pending_tasks()),
                  '#pageTaskButton 应提交 annotations 任务')
        expect(ui.locator('#saveState')).to_have_text('已提交')

    # 「模型动了这一页」的模拟钩子：钩子只改第一页内容；随后用户再改第一页，
    # 保存应被按页拒绝（deferred）并弹出行内冲突卡，而不是把模型版本悄悄覆盖。
    if args.hook_cmd:
        assert data['sections'] or data['pages'], '--hook-cmd 需要一页可编辑内容'
        subprocess.run(args.hook_cmd, shell=True, check=True, cwd=str(directory))
        if data['sections']:
            ui.locator('[data-outline-id="1"] [data-outline-title]').fill('After model update')
            conflict_card = ui.locator('[data-conflict="1"]')
        else:
            ui.locator('#pageTitle').fill('After model update')
            conflict_card = ui.locator('#pageNotice .line-conflict')
        wait_draft(lambda d: d['edits']['pages']['1']['title'] == 'After model update')
        wait_head(lambda h: (h.get('deferred') or {}).get('pages') == [1],
                  '模型改过的页再次保存应 deferred')
        expect(ui.locator('#saveState')).to_contain_text('页待核对')
        expect(conflict_card).to_be_visible()
        expect(ui.locator('#notice')).to_contain_text('模型已更新第 1 页')
        ui.locator('[data-keep-mine]').first.click()
        wait_head(lambda h: not (h.get('deferred') or {}).get('pages'),
                  '保留我的之后 deferred 应清空')
        wait_draft(lambda d: d['edits']['pages']['1']['title'] == 'After model update')
        expect(ui.locator('#saveState')).to_have_text('已自动保存')
        expect(conflict_card).to_have_count(0)
        saved_title = 'After model update'
    else:
        saved_title = 'Human "title"'

    # 悬停才出现的拖动把手：pointer 拖动换序（不是 HTML5 draggable，也不再是「点手柄展开」）
    if len(data['pages']) > 1:
        def drag(handle_locator, row_locator, after):
            handle = box(handle_locator)
            target = box(row_locator)
            page.mouse.move(handle['x']+handle['width']/2, handle['y']+handle['height']/2)
            page.mouse.down()
            y = target['y'] + target['height'] * (.85 if after else .15)
            page.mouse.move(handle['x']+handle['width']/2, y, steps=12)
            page.mouse.up()

        if data['sections']:
            # 键盘 Alt+↓ 仍保留：1 下移到 2 后面 → [2,1]
            grip = ui.locator('.outline-line[data-outline-id="1"] .outline-grip')
            grip.focus()
            grip.press('Alt+ArrowDown')
            wait_draft(lambda d: d['page_order'][:2] == [2, 1], 'Alt+↓ 应改变页面顺序')
            # 指针拖动把 1 拖回 2 前面 → [1,2]
            drag(ui.locator('.outline-line[data-outline-id="1"] .outline-grip'),
                 ui.locator('.outline-line[data-outline-id="2"]'), False)
            wait_draft(lambda d: d['page_order'][:2] == [1, 2], '指针拖动应改变页面顺序')
            # 再拖 2 到 1 前面 → 最终 [2,1]
            drag(ui.locator('.outline-line[data-outline-id="2"] .outline-grip'),
                 ui.locator('.outline-line[data-outline-id="1"]'), False)
        else:
            handle = ui.locator('.page-nav[data-id="1"] .drag-handle')
            handle.focus()
            handle.press('Alt+ArrowDown')
            wait_draft(lambda d: d['page_order'][:2] == [2, 1], 'Alt+↓ 应改变页面顺序')
            drag(ui.locator('.page-nav[data-id="2"] .drag-handle'),
                 ui.locator('.page-nav[data-id="1"]'), True)
            wait_draft(lambda d: d['page_order'][:2] == [1, 2], '指针拖动应改变页面顺序')
            drag(ui.locator('.page-nav[data-id="2"] .drag-handle'),
                 ui.locator('.page-nav[data-id="1"]'), False)
        wait_draft(lambda d: d['page_order'][:2] == [2, 1], '最终页序应回到 [2,1]')
        wait_head(lambda h: h['state']['page_order'][:2] == [2, 1], '排序保存后 head 页序应更新')
        expect(ui.locator('#saveState')).to_contain_text('已自动保存')

    # 刷新后编辑仍在（自动保存已经写到主稿；草稿也能恢复）
    page.reload(wait_until='networkidle')
    if data['sections']:
        expect(ui.locator('[data-outline-id="1"] [data-outline-title]')).to_have_text(saved_title)
        expect(ui.locator('.thesis p')).to_have_text('Human thesis')
    else:
        expect(ui.locator('#pageTitle')).to_have_text(saved_title)
    assert not submission_file.exists(), '工作台保存不是 legacy 提交'
    if not args.opaque:
        assert not (directory / 'wake-log.jsonl').exists(), 'HTTP standalone 工作台保存不应唤醒模型'


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 1352, 'height': 785})
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    try:
        url = host['url'].rsplit('/', 1)[0] + '/harness.html' if args.opaque else host['url']
        page.goto(url, wait_until='networkidle')
        ui = page.frame_locator('#frame') if args.opaque else page
        expect(ui.locator('#saveButton')).to_be_enabled()
        if args.screenshot:
            page.screenshot(path=args.screenshot)
        if workbench:
            workbench_flow(page, ui)
        else:
            legacy_flow(page, ui)
        assert errors == [], errors
        dimensions = page.evaluate('({height:document.documentElement.scrollHeight,viewport:innerHeight})')
        assert dimensions['height'] <= dimensions['viewport'], dimensions
        print(('Opaque iframe' if args.opaque else 'HTTP') + ': producer shell editing, ordering, draft restore, submit, version safety PASS')
    finally:
        context.close()
        browser.close()
        subprocess.run(['node', str(CORE / 'scripts/review-host.mjs'), 'stop', str(surface)], check=True, capture_output=True)
