"""Build the Quick Guide PDF for the current version: guide/quick-guide.html -> hrm-viewer/static/quick-guide.pdf.
Run before every release:  python3 make_guide.py"""
import datetime, os, re
from playwright.sync_api import sync_playwright
W = "/home/claude/work"
ver = re.search(r'^VERSION = "([^"]+)"', open(os.path.join(W, "hrm-viewer/app.py")).read(), re.M).group(1)
html = open(os.path.join(W, "guide/quick-guide.html"), encoding="utf-8").read()
html = html.replace("{{VERSION}}", ver).replace("{{DATE}}", datetime.date.today().strftime("%-d %B %Y"))
tmp = os.path.join(W, "guide/_build.html")
open(tmp, "w", encoding="utf-8").write(html)
out = os.path.join(W, "hrm-viewer/static/quick-guide.pdf")
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome")
    pg = b.new_page()
    pg.goto("file://" + tmp); pg.wait_for_timeout(400)
    pg.pdf(path=out, format="A4", print_background=True, display_header_footer=True,
           header_template="<span></span>",
           footer_template=f'<div style="width:100%;font:8px Segoe UI,Arial,sans-serif;color:#7a8496;padding:0 13mm;display:flex;justify-content:space-between">'
                           f'<span>HRM Viewer {ver} · Quick Guide</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>',
           margin={"top": "14mm", "bottom": "16mm", "left": "13mm", "right": "13mm"})
    b.close()
os.remove(tmp)
print("Quick Guide", ver, "->", out, os.path.getsize(out), "bytes")
