#!/usr/bin/env python3
"""Validate the outputs of test/matrix.cjs and render the compatibility table.

    python3 test/matrix-report.py [--out test/out/matrix] [--readme README.md] [--no-readme]

A conversion only counts as working when the output is a valid file of the target
type AND, for fixtures with a marker text, still contains that text (images and
drawings: valid and non-trivial).  Needs pdftotext (poppler) and Pillow.
Writes <out>/validated.json and the table between the compat markers in the README.
"""
import argparse
import io
import json
import os
import re
import subprocess
import sys
import zipfile

START = '<!-- compat:start -->'
END = '<!-- compat:end -->'

ODF_MIME = {
    'odt': 'application/vnd.oasis.opendocument.text',
    'ods': 'application/vnd.oasis.opendocument.spreadsheet',
    'odp': 'application/vnd.oasis.opendocument.presentation',
    'odg': 'application/vnd.oasis.opendocument.graphics',
}
OOXML_PART = {'docx': 'word/document.xml', 'xlsx': 'xl/workbook.xml', 'pptx': 'ppt/presentation.xml'}
OLE_MAGIC = bytes.fromhex('d0cf11e0a1b11ae1')
TAG = re.compile(rb'<[^>]*>')


def xml_text(data):
    return TAG.sub(b'', data).decode('utf-8', 'replace')


def zip_text(data):
    """All text of an OOXML/ODF package (XML parts with tags removed)."""
    out = []
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for name in z.namelist():
            if name.endswith('.xml') and not name.startswith('META-INF'):
                out.append(xml_text(z.read(name)))
    return '\n'.join(out)


def rtf_text(data):
    s = data.decode('latin-1')
    s = re.sub(r'\\\'[0-9a-fA-F]{2}', '', s)
    s = re.sub(r'\\[a-zA-Z]+-?\d* ?', '', s)
    return re.sub(r'[{}]', '', s)


def check(target, ext, data, marker):
    """Returns None when the output is fine, else a short reason."""
    if len(data) == 0:
        return 'empty output'
    has = lambda text: marker is None or marker.lower() in text.lower()
    if target in ('pdf', 'pdfa'):
        if not data.startswith(b'%PDF-'):
            return 'not a PDF'
        if target == 'pdfa' and b'pdfaid:part' not in data:
            return 'no PDF/A marker'
        text = subprocess.run(['pdftotext', '-', '-'], input=data, capture_output=True).stdout.decode('utf-8', 'replace')
        if subprocess.run(['pdftotext', '-v'], capture_output=True).returncode > 1:
            return 'pdftotext unavailable'
        return None if has(text) else 'text lost'
    if target in OOXML_PART:
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                if OOXML_PART[target] not in z.namelist():
                    return 'not a ' + target
        except zipfile.BadZipFile:
            return 'not a zip'
        return None if has(zip_text(data)) else 'text lost'
    if target in ODF_MIME:
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                if z.read('mimetype').decode() != ODF_MIME[target]:
                    return 'wrong ODF type'
        except (zipfile.BadZipFile, KeyError):
            return 'not an ODF file'
        return None if has(zip_text(data)) else 'text lost'
    if target in ('doc', 'xls', 'ppt'):
        if not data.startswith(OLE_MAGIC):
            return 'not an OLE file'
        if marker is None:
            return None
        text = marker.encode()
        return None if text in data or marker.encode('utf-16le') in data else 'text lost'
    if target == 'rtf':
        if not data.startswith(b'{\\rtf'):
            return 'not RTF'
        return None if has(rtf_text(data)) else 'text lost'
    if target in ('txt', 'md', 'csv'):
        return None if has(data.decode('utf-8', 'replace')) else 'text lost'
    if target == 'html':
        text = data.decode('utf-8', 'replace')
        return None if '<html' in text.lower() and has(xml_text(data)) else 'not HTML or text lost'
    if target in ('fodt', 'fods', 'fodp'):
        text = data.decode('utf-8', 'replace')
        if 'office:document' not in text:
            return 'not flat ODF'
        return None if has(xml_text(data)) else 'text lost'
    if target == 'svg':
        text = data.decode('utf-8', 'replace')
        return None if '<svg' in text and len(data) > 500 else 'not SVG'
    if target in ('png', 'jpg'):
        from PIL import Image
        try:
            im = Image.open(io.BytesIO(data))
            im.verify()
            im = Image.open(io.BytesIO(data))
        except Exception:
            return 'not an image'
        if min(im.size) < 50:
            return 'image too small'
        if im.format != ('PNG' if target == 'png' else 'JPEG'):
            return 'wrong image format'
        return None
    return 'no validator for ' + target


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(os.path.dirname(__file__), 'out', 'matrix'))
    ap.add_argument('--readme', default=os.path.join(os.path.dirname(__file__), '..', 'README.md'))
    ap.add_argument('--no-readme', action='store_true')
    args = ap.parse_args()

    results = json.load(open(os.path.join(args.out, 'results.json')))
    targets = [t['id'] for t in results['targets']]
    ext_of = {t['id']: t['ext'] for t in results['targets']}
    ok = failed = na = 0
    problems = []
    for row in results['inputs']:
        for tid in targets:
            cell = row['cells'][tid]
            if cell['status'] == 'n/a':
                na += 1
                if cell.get('cross') == 'converted':
                    data = open(os.path.join(args.out, cell['file']), 'rb').read()
                    reason = check(tid, ext_of[tid], data, row['marker'])
                    cell['cross_verdict'] = 'ok' if reason is None else 'fail'
                    cell['cross_reason'] = reason
                elif cell.get('cross'):
                    cell['cross_verdict'] = 'fail'
                    cell['cross_reason'] = cell.get('error')
                continue
            if cell['status'] == 'error':
                cell['verdict'] = 'fail'
                cell['reason'] = cell['error']
            else:
                data = open(os.path.join(args.out, cell['file']), 'rb').read()
                reason = check(tid, ext_of[tid], data, row['marker'])
                cell['verdict'] = 'ok' if reason is None else 'fail'
                cell['reason'] = reason
            if cell['verdict'] == 'ok':
                ok += 1
            else:
                failed += 1
                problems.append((row['ext'], tid, cell['reason']))
    json.dump(results, open(os.path.join(args.out, 'validated.json'), 'w'), indent=2)
    print(f'{ok} ok, {failed} failed, {na} not offered')
    for ext, tid, reason in problems:
        print(f'  FAIL {ext} -> {tid}: {reason}')

    # --- tables ---
    names = {'pdfa': 'PDF/A'}
    groups = {'writer': 'Text documents', 'calc': 'Spreadsheets', 'impress': 'Presentations',
              'draw': 'Drawings and images'}

    def render(title, families, tids):
        rows = [r for r in results['inputs'] if r['family'] in families]
        head = '| From \\ To | ' + ' | '.join(names.get(t, t.upper()) for t in tids) + ' |'
        lines = [f'#### {title}', '', head, '| --- |' + ' :---: |' * len(tids)]
        for family in families:
            if len(families) > 1:
                lines.append('| **' + groups[family] + '** |' + ' |' * len(tids))
            for row in (r for r in rows if r['family'] == family):
                cells = []
                for tid in tids:
                    c = row['cells'][tid]
                    cells.append('·' if c['status'] == 'n/a' else '✅' if c['verdict'] == 'ok' else '❌')
                lines.append('| ' + row['ext'].upper() + ' | ' + ' | '.join(cells) + ' |')
        return '\n'.join(lines)

    common = ['pdf', 'pdfa', 'png', 'jpg']  # offered for every input
    shown = set(common)
    tables = [render('Common outputs (every input)', list(groups), common)]
    for family, title, tids in (
        ('writer', 'Text documents', ['docx', 'doc', 'odt', 'rtf', 'txt', 'md', 'fodt']),
        ('calc', 'Spreadsheets', ['xlsx', 'xls', 'ods', 'csv', 'html', 'fods']),
        ('impress', 'Presentations', ['pptx', 'ppt', 'odp', 'fodp', 'svg']),
        ('draw', 'Drawings and images', ['odg', 'svg']),
    ):
        tables.append(render(title + ': format-specific outputs', [family], tids))
        shown.update(tids)
    missing = [t for t in targets if t not in shown]
    assert not missing, 'targets not in any table: %s' % missing
    table = '\n\n'.join(tables)
    summary = (f'{ok} of {ok + failed} offered conversions produce a valid file with the content intact '
               f'({na} combinations are not offered).')
    block = f'{START}\n{summary}\n\n{table}\n{END}'
    open(os.path.join(args.out, 'table.md'), 'w').write(block + '\n')
    if not args.no_readme:
        readme = open(args.readme).read()
        if START in readme:
            readme = re.sub(re.escape(START) + '.*?' + re.escape(END), lambda m: block, readme, flags=re.S)
            open(args.readme, 'w').write(readme)
            print('README table updated')
        else:
            print('README has no compat markers; table written to', os.path.join(args.out, 'table.md'))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
