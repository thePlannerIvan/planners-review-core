"""宿主的生命周期：**传输层**。判据一条都不在这里，全在 `scripts/review-host.mjs`。

本文件只做三件事：**spawn 那个 CLI、解析它吐的 JSON、把名字映射过去**。
僵尸语义、按内容判身份、"注入点以外逐字节"、启动自检日志解析、越界出声 ——
全部在 Node 那一边（唯一实现）。改之前先看 `review-host.mjs` 的文件头。

## 为什么实现是 Node、传输是 Python

缝的四块里三块本来就是 Node（契约 JSON、`validate-surface.mjs`、`serve-review.mjs`、桥），
而 **Node 是所有人的底线**：校验器、无插件宿主都是 Node CLI，连 Python 技能也要找 node 才能
用它们。生命周期放 Python，就把纯 `.mjs` 的调用方（planners-bypage 全是 `.mjs`，而且它的运行
契约明确不许假定 `python3` 存在）关在门外；而它们**不能**再写一份 Node 生命周期 —— 那正是
要消灭的"两份副本各自漂移"。**收到 Node，谁都不多一个依赖**；这一份只是让 Python 调用方
（ppt-hell / video-craft）不必自己拼命令行。

## 留在这一侧的两件事（都不是判据）

- **`node_binary()`**：怎么**启动**那个 CLI。实现侧用 `process.execPath`（它自己就是 node），
  只有调用方需要找 node。
- ~~`webbrowser.open`~~ —— **已经不在这里了**。开浏览器是**一件事**，一件事就只该有一套行为：
  以前 CLI 的 `open` 不开、这一份开，于是 bypage（纯 `.mjs`）只得在自己 Skill 侧再写一遍平台开关
  绕过去。现在开在 `review-host.mjs` 的 `launchBrowser()`，关在 `--no-open`。

自检：`python3 review_host.py --check`
"""
from __future__ import annotations

import glob
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path

# 这几个名字**镜像**自 CLI。`test_review_host.py::test_mirrored_names_agree_with_the_cli`
# 会跑一次 CLI 的 `constants` 核对它们，所以"两份事实各说各话"是不可能的。
CONTRACT_VERSION = 'review-surface/2.0.0'
BRIDGE_PLACEHOLDER = '{{REVIEW_BRIDGE}}'
HOST_STATE_NAME = 'review_host.json'
HOST_LOG_NAME = 'review_host.log'
WAKE_LOG_NAME = 'wake-log.jsonl'

HERE = Path(__file__).resolve().parent          # <review-core>/scripts/lib
CLI = HERE.parent/'review-host.mjs'

# 最近几次 CLI 调用：给调试，以及"这一段到底起没起宿主"这类断言用（传输层的痕迹，不是判据）。
_INVOCATIONS: list = []
_TRACE_LIMIT = 20


def node_binary():
    """启动那个 CLI 要一个 node。找不到就明说，不猜一个别的解释器跑。

    顺序：`$REVIEW_CORE_NODE` → PATH → 常见安装位置 → **版本管理器**。最后那一档不是多余的：
    Agent 进程常带一条精简 PATH（实测 `/usr/bin:/bin:/usr/sbin:/sbin`），nvm 装的 node 不在里面，
    而它在磁盘上好好的。按版本号排序取最新的一个。
    """
    override = os.environ.get('REVIEW_CORE_NODE')
    if override:
        return override
    for directory in os.environ.get('PATH', '').split(os.pathsep):
        candidate = Path(directory)/'node' if directory else None
        if candidate and candidate.exists():
            return str(candidate)
    for candidate in (Path('/opt/homebrew/bin/node'), Path('/usr/local/bin/node'), Path('/usr/bin/node')):
        if candidate.exists():
            return str(candidate)
    home = Path.home()
    managed = []
    for pattern in ('~/.nvm/versions/node/*/bin/node', '~/.volta/bin/node',
                    '~/.fnm/node-versions/*/installation/bin/node',
                    '~/.local/share/fnm/node-versions/*/installation/bin/node'):
        managed.extend(Path(path) for path in glob.glob(str(home/pattern[2:])))

    def release_key(path):
        numbers = [int(part) for part in re.findall(r'\d+', path.parent.parent.name)]
        return numbers or [0]
    for candidate in sorted([path for path in managed if path.exists()], key=release_key):
        return str(candidate)
    raise ValueError('找不到 node 可执行文件（生命周期实现 review-host.mjs 要它）。装 Node.js，'
                     '或设 REVIEW_CORE_NODE 指向它。找过：PATH、/opt/homebrew/bin、/usr/local/bin、'
                     '~/.nvm、~/.volta、~/.fnm。')


def _run(command, *args, payload=None):
    """spawn CLI → 解析 JSON。**只做这两件事。**

    CLI 的约定：成功时 stdout 是结果 JSON、退出码 0；失败时 stdout 是 `{ok:false,error}`
    且退出码非零。所以这里：非零 → 抛 `ValueError(error)` —— 报错措辞由实现侧给，
    调用方的 `assertRaisesRegex(..., '不合规' | '启动失败' | '还没有审阅面')` 因此照旧成立。
    """
    argv = [node_binary(), str(CLI), command, *[str(one) for one in args]]
    _INVOCATIONS.append([command, *[str(one) for one in args]])
    del _INVOCATIONS[:-_TRACE_LIMIT]
    result = subprocess.run(
        argv,
        input=None if payload is None else json.dumps(payload, ensure_ascii=False),
        capture_output=True, text=True)
    raw = (result.stdout or '').strip()
    try:
        data = json.loads(raw) if raw else {}
    except ValueError:
        data = {}
    if result.returncode != 0 or data.get('ok') is False:
        message = data.get('error') or raw or (result.stderr or '').strip() or (command + ' 失败')
        raise ValueError(message)
    return data


# ------------------------------------------------------------------ 映射（无判据）

def write_surface(surface, document):
    """把**各家建好的**文档落盘（幂等）。文档内容是哪家的业务，本层不生产。"""
    return Path(_run('write', Path(surface).resolve(), payload=document)['surface'])


def validate_surface(surface):
    """跑唯一校验器。不合规 → ValueError。"""
    _run('validate', Path(surface).resolve())
    return True


def host_state_path(surface):
    return Path(surface).resolve().parent/HOST_STATE_NAME


def read_surface(surface):
    """读那份 surface —— 只负责读文件与缺件措辞，**不解释**里面的字段。"""
    path = Path(surface).resolve()
    if not path.is_file():
        raise ValueError('还没有审阅面：先跑生成审阅面那一步，写出 ' + str(path))
    return json.loads(path.read_text(encoding='utf-8'))


def surface_paths(surface):
    """surface 里那些**相对它自己**的路径 → 绝对路径。

    这是**映射**（接绝对路径），不是判据：CLI 侧对同一份文档做同一件事，那边那份才是
    权威（`alive` 与 `serve` 都吃它）。这里给调用方与测试一个顺手的形式。
    """
    path = Path(surface).resolve()
    doc = read_surface(path)
    base = path.parent
    dir_abs = (base/str(doc.get('dir') or '.')).resolve()
    return {
        'surface': path,
        'base': base,
        'dir': dir_abs,
        'project_root': (base/str(doc.get('project_root') or '.')).resolve(),
        'entry': (dir_abs/str(doc['entry'])).resolve(),
        'feedback': (base/str(doc['feedback'])).resolve() if doc.get('feedback') else None,
        # 草稿：与 feedback 分开的两个文件、两件事（决定 vs 未提交的草稿）。
        'draft': (base/str(doc['draft'])).resolve() if doc.get('draft') else None,
        'watch': [(base/str(rel)).resolve() for rel in (doc.get('watch') or [])],
        'wake_log': base/WAKE_LOG_NAME,
    }


def host_state(surface):
    """上次起的宿主的状态（或 None）。"""
    return _run('state', Path(surface).resolve())


def host_alive(surface, state=None):
    """那个宿主还活着吗？活着 → 那份状态，否则 None。

    `state` 给了就核那一份（测试用它喂"偷来的"状态）；不给就让 CLI 读状态文件。
    """
    if state is None:
        return _run('alive', Path(surface).resolve())['state']
    return _run('alive', Path(surface).resolve(), '--state', '-', payload=state)['state']


def start_host(surface, port=0):
    """起一个无插件宿主，返回它的状态。"""
    return _run('start', Path(surface).resolve(), '--port', str(port))


def stop_host(state, timeout=5.0):
    """停掉一个宿主。**报 True 才算收干净。**"""
    if not state or not state.get('pid'):
        return False
    return bool(_run('stop', '--state', '-', payload=state)['stopped'])


def open_review(surface, port=0, open_browser=True):
    """起/复用宿主 → 拿到 URL → **开浏览器（这件事只有一套行为，在 CLI 里）**。

    `open_browser=False` → 传 `--no-open`（测试与无头环境用）。
    """
    args = [Path(surface).resolve(), '--port', str(port)]
    if not open_browser:
        args.append('--no-open')
    return _run('open', *args)


def _pid_alive(pid):
    """那个 pid 还在吗 —— **判据在 CLI 那一边**（僵尸语义、EPERM 语义都归它）。"""
    if pid is None:
        return False
    return bool(_run('pid', int(pid))['alive'])


def _startup_report(log):
    """从宿主日志里解析启动自证（跨行的 JSON）。解析规则在 CLI 那一边。"""
    return _run('report', str(Path(log).resolve()))['report']


def served_entry_is_ours(entry, served):
    """serve 回来的这一页是不是磁盘上那一份入口。判据在 CLI 那一边。

    `served` 是字节时落一个临时文件递过去（CLI 收文件路径，免得 argv 里塞几万字节）。
    """
    handle, temp = tempfile.mkstemp(prefix='review-served-', suffix='.html')
    try:
        with os.fdopen(handle, 'wb') as out:
            out.write(served if isinstance(served, (bytes, bytearray)) else str(served).encode('utf-8'))
        return bool(_run('match', str(Path(entry).resolve()), '--served', temp)['match'])
    finally:
        os.unlink(temp)


if __name__ == '__main__':
    import sys
    if '--check' in sys.argv:
        try:
            print('node → ' + node_binary())
        except ValueError as error:
            print('node → ' + str(error).splitlines()[0])
        print('实现 → ' + str(CLI) + ('（在）' if CLI.is_file() else '（缺）'))
        try:
            print('镜像核对 → ' + json.dumps(_run('constants'), ensure_ascii=False))
        except (ValueError, OSError) as error:
            print('镜像核对 → ' + str(error).splitlines()[0])
        raise SystemExit(0)
    print('用法：python3 review_host.py --check')
    raise SystemExit(2)
