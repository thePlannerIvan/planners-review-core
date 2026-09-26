#!/usr/bin/env python3
"""`scripts/lib/review_host.py` 自己的生命周期测试。

它现在是**四家 Skill 共用的唯一一份**宿主生命周期，所以这几条行为不能再靠"某家的测试顺带
覆盖"—— 两份副本就是在这里漂移的，测试要钉在模组这一侧：

  ① 起 → 判活 → 停 → 判死（`stop_host` 报 True 才算收干净）；
  ② **僵尸不算活着**：`os.kill(pid, 0)` 对僵尸返回成功，依赖它的判据会把"已经关掉的宿主"
     报成"没停掉"（实测踩到）；
  ③ **同时开着两个不同项目的宿主时，身份按内容判、不按端口**：两个宿主都是 `--port 0`，
     端口没有判断力；`watch` 声明的项目文件才分得出谁是谁。

跑法：python3 -m unittest discover -s evals -p 'test_*.py'
（需要 node —— 宿主与校验器都是它写的；没有就整类 skip。）
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock
from pathlib import Path

CORE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CORE / 'scripts' / 'lib'))

import review_host  # noqa: E402


def _not_json(line: str) -> bool:
    import json as _json
    try:
        _json.loads(line)
        return False
    except ValueError:
        return True


def have_node():
    try:
        review_host.node_binary()
        return True
    except ValueError:
        return False


MARKER = review_host.BRIDGE_PLACEHOLDER


def make_project(root: Path, tag: str) -> Path:
    """一个最小但真的能开的项目：入口带裸注入点，另有一个项目专属文件给 `watch` 盯。

    布局与各家的真实布局同形：surface 在子目录里，`dir` 是项目根，`watch` 相对 surface 文件。
    """
    (root / 'review').mkdir(parents=True, exist_ok=True)
    (root / 'timeline').mkdir(parents=True, exist_ok=True)
    (root / 'review' / 'index.html').write_text(
        '<!doctype html><html><head>\n' + MARKER + '\n</head>'
        f'<body><h1>{tag}</h1></body></html>\n', encoding='utf-8')
    # 项目专属：内容不同 → 只有真正的那个项目才对得上
    (root / 'timeline' / 'data.json').write_text(json.dumps({'tag': tag}), encoding='utf-8')
    surface = root / 'review' / 'review-surface.json'
    review_host.write_surface(surface, {
        'contract_version': review_host.CONTRACT_VERSION,
        'id': 'test/lifecycle',
        'title': f'fixture {tag}',
        'project_root': '..',
        'dir': '..',
        'entry': 'review/index.html',
        'feedback': 'submissions.json',
        'wake': {'mode': 'queue', 'text': '{unit} 已定。'},
        'watch': ['../timeline/data.json'],
        'capabilities': [],
    })
    return surface


class TempProjects(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix='review-host-test-')).resolve()
        self.a = make_project(self.base / 'alpha', 'alpha')
        self.b = make_project(self.base / 'beta', 'beta')
        self.started = []

    def tearDown(self):
        for state in self.started:
            review_host.stop_host(state)

    def start(self, surface):
        state = review_host.start_host(surface)
        self.started.append(state)
        return state


@unittest.skipUnless(have_node(), 'needs node (the host and the validator are serve-review.mjs / validate-surface.mjs)')
class HostLifecycle(TempProjects):
    def test_write_validate_start_alive_stop_dead(self):
        # 写 + 校验（模组只管落盘与校验，文档内容是调用方建的）
        self.assertTrue(review_host.validate_surface(self.a))
        state = self.start(self.a)

        # 起来的样子：有 url/pid，且反馈文件与唤醒日志从 surface 推出来、落在它旁边
        self.assertTrue(state['url'].startswith('http://127.0.0.1:'))
        self.assertGreater(state['port'], 0)
        self.assertEqual(state['surface'], str(self.a))
        self.assertEqual(state['feedback_path'], str(self.a.parent / 'submissions.json'))
        self.assertEqual(state['wake_log'], str(self.a.parent / 'wake-log.jsonl'))
        self.assertTrue(review_host.host_state_path(self.a).is_file(), '状态写在 surface 旁边')

        # 判活：读回来的是同一份状态
        self.assertEqual(review_host.host_alive(self.a)['pid'], state['pid'])

        # 停：报 True 才算收干净；停了之后连状态都认不出来了
        self.assertTrue(review_host.stop_host(state), 'stop_host 必须把它真的停掉')
        self.assertFalse(review_host._pid_alive(state['pid']))
        self.assertIsNone(review_host.host_alive(self.a))
        # 元数据还在盘上 —— 只看它就会以为宿主还活着（这正是要"读回页面"的原因）
        self.assertTrue(review_host.host_state_path(self.a).is_file())

    def test_browser_opening_has_exactly_one_behaviour_and_only_the_cli_does_it(self):
        """**开浏览器只有一套行为**，在 CLI 里；Python 入口只把开关翻成 `--no-open`。

        以前这件事有两套：CLI 的 `open` 不开、Python 这份开（`webbrowser`）—— 于是 bypage
        （纯 `.mjs`）只得在自己 Skill 侧再写一遍平台开关绕过去。同一件事两套行为，就是要消灭的那类。
        """
        self.start(self.a)
        # ① 这一侧**不再**持有第二套实现
        self.assertFalse(hasattr(review_host, 'webbrowser'),
                         '这个模块里不许再有一个开浏览器的东西')
        # ② 开关翻成 CLI 的参数：要开就不带 `--no-open`，不开就带
        seen = []
        real = review_host._run

        def spy(command, *args, **kwargs):
            seen.append([command, *args])
            return real(command, *([*args, '--no-open'] if command == 'open' else args), **kwargs)

        with mock.patch.object(review_host, '_run', side_effect=spy):
            review_host.open_review(self.a, open_browser=True)
            review_host.open_review(self.a, open_browser=False)
        calls = [one for one in seen if one[0] == 'open']
        self.assertEqual(len(calls), 2)
        self.assertNotIn('--no-open', calls[0], 'open_browser=True → 要开（不带 --no-open）')
        self.assertIn('--no-open', calls[1], 'open_browser=False → 不开（带 --no-open）')
        # ③ CLI 真的认这个开关（端到端，不开真浏览器由 ② 保证）
        self.assertFalse(review_host._run('open', self.a, '--port', '0', '--no-open')['opened'],
                         '--no-open 必须真的不开')

    def test_open_review_reuses_a_live_host_and_restarts_a_dead_one(self):
        first = self.start(self.a)
        again = review_host.open_review(self.a, open_browser=False)
        self.assertFalse(again['started'])
        self.assertTrue(again['reused'])
        self.assertEqual(again['pid'], first['pid'])

        review_host.stop_host(first)
        third = review_host.open_review(self.a, open_browser=False)
        self.started.append(third)
        self.assertTrue(third['started'])
        self.assertNotEqual(third['pid'], first['pid'])

    def test_a_dead_host_is_judged_dead(self):
        """「已经退出但没被回收的 pid 不许被当成活着」。

        以前这条在 Python 侧靠句柄（`Popen.poll()` 顺手回收僵尸）—— 因为 `os.kill(pid, 0)`
        **对僵尸返回成功**，实测把"已经关掉的宿主"报成"没停掉"。现在判据搬进 Node，而
        **Node 的 libuv 自己收 SIGCHLD**：子进程退出 400ms 后 `process.kill(pid,0)` 就是 ESRCH，
        这个坑在实现侧结构上不存在（实测见 `test_review_host.mjs` 的同名用例）。
        这里钉住可观察的那一半：宿主被杀之后必须判死，而且**不能靠端口**判。
        """
        import signal
        state = self.start(self.a)
        self.assertTrue(review_host._pid_alive(state['pid']))
        os.kill(int(state['pid']), signal.SIGKILL)
        for _ in range(50):
            if not review_host._pid_alive(state['pid']):
                break
            time.sleep(0.1)
        self.assertFalse(review_host._pid_alive(state['pid']), '死了就是死了')
        self.assertIsNone(review_host.host_alive(self.a), '判据是内容，不是端口')

    def test_two_hosts_of_different_projects_are_told_apart_by_content(self):
        """同时开着两个项目的宿主：都是 `--port 0`，**端口没有判断力**，只有内容分得出。

        两个都活着、都能被各自的 surface 认出来；把 A 的状态拿去问 B，必须判成"不是我们的"。
        """
        first = self.start(self.a)
        second = self.start(self.b)
        self.assertNotEqual(first['port'], second['port'], '两个宿主各占一个自动选的端口')

        self.assertEqual(review_host.host_alive(self.a)['pid'], first['pid'])
        self.assertEqual(review_host.host_alive(self.b)['pid'], second['pid'])

        # A 的 pid + A 的 URL，拿去问 B：页面模板一样、桥也注入过，但 A 端出来的
        # `timeline/data.json` 不是 B 的那一份 → 不是我们的。
        self.assertIsNone(review_host.host_alive(self.b, state=first))
        self.assertIsNone(review_host.host_alive(self.a, state=second))
        # 反向确认这条判据不是"永远为假"：把 URL 换成自己的，同一个 state 就认得出
        self.assertIsNotNone(review_host.host_alive(self.b, state=second))

    def test_identity_is_about_content_not_the_port(self):
        """同一个 URL 上换一份页面 / 换一个静态服务器，都要判得出来。

        宿主是按请求读盘的，所以**磁盘上的入口换了一版**（页面本来就会被重出）仍然是我们；
        被拒的是「这个 URL 端出来的东西不是我们这一份」。
        """
        import functools
        import http.server
        import threading
        state = self.start(self.a)
        entry = self.a.parent / 'index.html'

        # ① 重出同一份入口的新版本 → 仍认（宿主读盘）
        entry.write_text(entry.read_text(encoding='utf-8').replace('alpha', 'alpha v2'), encoding='utf-8')
        self.assertIsNotNone(review_host.host_alive(self.a), '同一份入口的新版本仍是我们')

        # ② 拿 `http.server` 直接把目录端出来 → 注入点还在，不是审阅宿主
        class Plain(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *args):
                pass
        static = http.server.ThreadingHTTPServer(
            ('127.0.0.1', 0), functools.partial(Plain, directory=str(self.base / 'alpha')))
        self.addCleanup(static.server_close)
        self.addCleanup(static.shutdown)
        threading.Thread(target=static.serve_forever, daemon=True).start()
        stolen = {**state, 'url': f'http://127.0.0.1:{static.server_address[1]}/review/index.html'}
        self.assertIsNone(review_host.host_alive(self.a, state=stolen), '注入点还在 = 没被 serve 过')

        # ③ 别人的页面（另一个服务器端出来的）→ 不是我们的
        class Foreign(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                body = b'<!doctype html><html><body>someone else</body></html>'
                self.send_response(200)
                self.send_header('content-type', 'text/html; charset=utf-8')
                self.send_header('content-length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            def log_message(self, *args):
                pass
        foreign = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Foreign)
        self.addCleanup(foreign.server_close)
        self.addCleanup(foreign.shutdown)
        threading.Thread(target=foreign.serve_forever, daemon=True).start()
        alien = {**state, 'url': f'http://127.0.0.1:{foreign.server_address[1]}/review/index.html'}
        self.assertIsNone(review_host.host_alive(self.a, state=alien), '别人的页面不认')

        # ④ 反向确认判据不是"永远为假"：真的那个 URL 认得出
        self.assertIsNotNone(review_host.host_alive(self.a))

    def test_the_startup_report_is_parsed_from_a_pretty_printed_log(self):
        """宿主的启动自证是**跨多行**的 JSON（`JSON.stringify(..., null, 2)`），日志里还混着别的输出。
        逐行解析在美化输出上永远失败 —— 解析规则在 Node 那一边。"""
        state = self.start(self.a)
        log = Path(state['log'])
        self.assertTrue(log.is_file())
        raw = log.read_text(encoding='utf-8')
        # 先证明"逐行解析一定失败"：单独取一行解析不出来
        self.assertTrue(len(raw.splitlines()) > 3, '自证应当是美化过的多行 JSON')
        self.assertTrue(all(_not_json(line) for line in raw.splitlines() if line.strip()),
                        '没有哪一行单独是合法 JSON —— 所以逐行那条路必然失败')
        report = review_host._startup_report(log)
        self.assertEqual(report['url'], state['url'])
        self.assertEqual(int(state['url'].rsplit(':', 1)[-1].split('/')[0]), state['port'])

    def test_a_surface_pointing_outside_the_project_is_rejected(self):
        doc = review_host.read_surface(self.a)
        review_host.write_surface(self.a, {**doc, 'dir': '../../../../..'})
        with self.assertRaisesRegex(ValueError, '不合规'):
            review_host.validate_surface(self.a)
        review_host.write_surface(self.a, doc)                  # 复原
        self.assertTrue(review_host.validate_surface(self.a))

    def test_a_missing_surface_is_reported_not_guessed(self):
        missing = self.base / 'nowhere' / 'review-surface.json'
        with self.assertRaisesRegex(ValueError, '还没有审阅面'):
            review_host.validate_surface(missing)
        with self.assertRaisesRegex(ValueError, '还没有审阅面'):
            review_host.read_surface(missing)


class MirroredNames(TempProjects):
    """Python 侧镜像了 CLI 的几个名字。**镜像要有闸门**，否则就是"两份事实各说各话"。"""

    def test_mirrored_names_agree_with_the_cli(self):
        constants = review_host._run('constants')
        for name in ('CONTRACT_VERSION', 'BRIDGE_PLACEHOLDER', 'HOST_STATE_NAME', 'HOST_LOG_NAME', 'WAKE_LOG_NAME'):
            with self.subTest(name=name):
                self.assertEqual(getattr(review_host, name), constants[name])


class NodeLookup(TempProjects):
    def test_node_is_found_or_reported(self):
        try:
            self.assertTrue(Path(review_host.node_binary()).name.startswith('node'))
        except ValueError as error:
            self.assertIn('node', str(error))


if __name__ == '__main__':
    unittest.main()
