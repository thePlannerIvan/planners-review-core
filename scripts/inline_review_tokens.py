#!/usr/bin/env python3
"""把公共的 DSH 令牌表**内联**进一个审阅页 HTML。

**为什么必须内联**：审阅页跑在 `sandbox="allow-scripts"` 的**不透明源 iframe** 里 —— 宿主的
CSS 变量继承不进来，外链样式表也会被信任围栏打回 403。所以令牌只能随页面一起发。

**为什么要有这个脚本**：表只有一份（`assets/dsh-tokens.css`，本接缝里）。每个审阅页在**生成时**
把它内联进去 —— 谁都不许在页面模板里存第二份，那样改一次要同步三处，迟早漂移。

用法：

    python3 scripts/inline_review_tokens.py <页面.html>              # 原地替换
    python3 scripts/inline_review_tokens.py <模板.html> --out <产物.html>

模板里放占位符（CSS 注释，位置随意）：

    /*__DSH_TOKENS__*/

已经内联过的文件再跑一次是**幂等**的：脚本用 BEGIN/END 标记框住自己塞进去的那一段，
下次直接换掉那一段，不会叠加。

自检：替换后整段 `<style>` 的括号/引号必须配对、表必须真的在里面 —— 不满足就**报错退出、不写文件**。
（这一条不是形式：抽值截断曾留下未闭合的 `(`，CSS 解析器一路吞到文件尾，整页样式被丢掉，
而**任何地方都不报错**。）
"""
import argparse
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SHEET = HERE.parent/'assets/dsh-tokens.css'
PLACEHOLDER = '/*__DSH_TOKENS__*/'
BEGIN = '/*===DSH_TOKENS_BEGIN===*/'
END = '/*===DSH_TOKENS_END===*/'


def block(sheet_text):
    return f'{BEGIN}\n{sheet_text.rstrip()}\n{END}'


def inline(html, sheet_text):
    """返回 (新 HTML, 做了什么)。"""
    payload = block(sheet_text)
    if BEGIN in html and END in html:
        start = html.index(BEGIN)
        stop = html.index(END) + len(END)
        return html[:start] + payload + html[stop:], '替换已内联的那一段'
    if PLACEHOLDER in html:
        return html.replace(PLACEHOLDER, payload, 1), '替换占位符'
    raise SystemExit(f'这个文件里既没有 {PLACEHOLDER} 也没有 BEGIN/END 标记；'
                     '模板要先放占位符，否则会产出一张没上样式的页面（而且不报错）')


def check(html, sheet_text):
    """自检：样式块要能被 CSS 解析器吃下去。"""
    styles = re.findall(r'<style[^>]*>(.*?)</style>', html, re.S)
    if not styles:
        raise SystemExit('页面里没有 <style> 块')
    for css in styles:
        if css.count('(') != css.count(')') or css.count('{') != css.count('}'):
            raise SystemExit(f'<style> 括号不配对：( {css.count("(")} / ) {css.count(")")}，'
                             f'{{ {css.count("{")} / }} {css.count("}")}')
    if '--dsw-alias-bg-base' not in html:
        raise SystemExit('内联后页面里找不到令牌表的标志性变量，拒绝写文件')
    if sheet_text[:40] not in html:
        raise SystemExit('内联的后半段被截断了？拒绝写文件')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('page', help='要内联的 HTML（模板或页面）')
    ap.add_argument('--out', help='写到别的文件；不给就原地替换')
    args = ap.parse_args()

    if not SHEET.is_file():
        raise SystemExit(f'找不到令牌表 {SHEET}；先跑 scripts/vendor_dsh_tokens.py 生成')
    sheet_text = SHEET.read_text(encoding='utf-8')

    page = Path(args.page)
    html = page.read_text(encoding='utf-8')
    new_html, what = inline(html, sheet_text)
    check(new_html, sheet_text)

    out = Path(args.out) if args.out else page
    out.write_text(new_html, encoding='utf-8')
    print(f'{what}：{page} → {out}（+{len(new_html)-len(html)} 字节，表 {len(sheet_text)} 字节）')


if __name__ == '__main__':
    sys.exit(main())
