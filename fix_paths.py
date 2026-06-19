from pathlib import Path
import re

ROOT = Path('.')
HTML_FILES = [Path('index.html'), Path('404.html'), *sorted(Path('pages').glob('*.html'))]

# Insert path-utils before UI/auth code in every HTML file.
def add_path_utils(html: str, prefix: str) -> str:
    src = f'{prefix}js/path-utils.js'
    if 'path-utils.js' in html:
        return html
    # Prefer inserting before firebase-config, because all local modules can use it.
    target = f'<script src="{prefix}js/firebase-config.js"></script>'
    insert = f'<script src="{src}"></script>\n  {target}'
    if target in html:
        return html.replace(target, insert, 1)
    # Fallback: before ui.js
    target = f'<script src="{prefix}js/ui.js"></script>'
    insert = f'<script src="{src}"></script>\n  {target}'
    if target in html:
        return html.replace(target, insert, 1)
    return html


def convert_html(path: Path):
    html = path.read_text(encoding='utf-8')
    in_pages = path.parent.name == 'pages'
    prefix = '../' if in_pages else './'
    page_prefix = '' if in_pages else 'pages/'

    # Root-level asset references.
    replacements = {
        'href="/css/': f'href="{prefix}css/',
        'href="/manifest.json"': f'href="{prefix}manifest.json"',
        'href="/images/': f'href="{prefix}images/',
        'src="/images/': f'src="{prefix}images/',
        'src="/js/': f'src="{prefix}js/',
        'src="/sources/': f'src="{prefix}sources/',
    }
    for old, new in replacements.items():
        html = html.replace(old, new)

    # HTML navigation links.
    html = html.replace('href="/pages/', f'href="{page_prefix}')
    html = html.replace("href='/pages/", f"href='{page_prefix}")
    html = html.replace('href="/"', f'href="{prefix}index.html"')
    html = html.replace("href='/'", f"href='{prefix}index.html'")

    # Inline script/template root asset URLs in HTML.
    html = html.replace("'/images/", f"'{prefix}images/")
    html = html.replace('"/images/', f'"{prefix}images/')
    html = html.replace("`/images/", f"`{prefix}images/")

    # Inline script/template generated hrefs and redirects.
    html = html.replace('href="/pages/', f'href="{page_prefix}')
    html = html.replace("href='/pages/", f"href='{page_prefix}")
    html = html.replace("window.location.href = '/'", f"window.location.href = '{prefix}index.html'")
    html = html.replace('window.location.href = "/"', f'window.location.href = "{prefix}index.html"')
    html = re.sub(r"window\.location\.href\s*=\s*`/pages/([^`]+)`", lambda m: f"window.location.href = AppPath.to('pages/{m.group(1)}')", html)
    html = re.sub(r"window\.location\.href\s*=\s*'/pages/([^']+)'", lambda m: f"window.location.href = AppPath.to('pages/{m.group(1)}')", html)
    html = re.sub(r'window\.location\.href\s*=\s*"/pages/([^"]+)"', lambda m: f'window.location.href = AppPath.to("pages/{m.group(1)}")', html)

    html = add_path_utils(html, prefix)
    path.write_text(html, encoding='utf-8')

for html_path in HTML_FILES:
    convert_html(html_path)

# Patch JavaScript modules with AppPath helpers for redirects and generated markup.
js_files = list(Path('js').glob('*.js')) + list(Path('sources').glob('*.js'))
for path in js_files:
    text = path.read_text(encoding='utf-8')
    text = text.replace("window.location.href = '/'", "window.location.href = AppPath.home()")
    text = text.replace('window.location.href = "/"', 'window.location.href = AppPath.home()')
    text = re.sub(r"window\.location\.href\s*=\s*`/pages/([^`]+)`", lambda m: f"window.location.href = AppPath.to('pages/{m.group(1)}')", text)
    text = re.sub(r"window\.location\.href\s*=\s*'/pages/([^']+)'", lambda m: f"window.location.href = AppPath.to('pages/{m.group(1)}')", text)
    text = re.sub(r'window\.location\.href\s*=\s*"/pages/([^"]+)"', lambda m: f'window.location.href = AppPath.to("pages/{m.group(1)}")', text)
    path.write_text(text, encoding='utf-8')

print('Path conversion complete')
