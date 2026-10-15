#!/usr/bin/env python3
"""Create the extra input fixtures of the compatibility matrix.

Adds to test/fixtures/matrix/ (run after `node test/matrix.cjs --make-fixtures`):
templates and macro-enabled variants (made by changing the package type of the DOCX/XLSX/PPTX/
ODF samples; the content stays the same), renamed copies (.htm, .xhtml, .markdown, .tab, .pps,
.pot, .jpeg), hand-written DIF and SYLK spreadsheets, a gzipped SVG, and raster images
(GIF/BMP/WebP/TIFF) rendered from the PNG sample with Pillow.  Appends them to manifest.json.
"""
import gzip
import io
import json
import os
import shutil
import zipfile

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
M = os.path.join(HERE, 'fixtures', 'matrix')
TEXT = 'Serverless Office Converter'


def path(ext):
    return os.path.join(M, 'sample.' + ext)


def repackage(src_ext, dst_ext, replacements):
    """Copy a zip package, applying text replacements to the named parts."""
    out = io.BytesIO()
    with zipfile.ZipFile(path(src_ext)) as zin, zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zout:
        names = zin.namelist()
        if 'mimetype' in names:  # ODF: the mimetype entry comes first and is stored
            names.remove('mimetype')
            names.insert(0, 'mimetype')
        for name in names:
            data = zin.read(name)
            for part, old, new in replacements:
                if name == part:
                    text = data.decode('utf-8')
                    assert old in text, (dst_ext, part, old)
                    data = text.replace(old, new).encode('utf-8')
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED if name == 'mimetype' else zipfile.ZIP_DEFLATED
            zout.writestr(info, data)
    open(path(dst_ext), 'wb').write(out.getvalue())


CT = '[Content_Types].xml'
OO = 'application/vnd.openxmlformats-officedocument.'
OOXML = [
    ('docx', 'dotx', OO + 'wordprocessingml.document.main+xml', OO + 'wordprocessingml.template.main+xml'),
    ('docx', 'docm', OO + 'wordprocessingml.document.main+xml', 'application/vnd.ms-word.document.macroEnabled.main+xml'),
    ('docx', 'dotm', OO + 'wordprocessingml.document.main+xml', 'application/vnd.ms-word.template.macroEnabledTemplate.main+xml'),
    ('xlsx', 'xltx', OO + 'spreadsheetml.sheet.main+xml', OO + 'spreadsheetml.template.main+xml'),
    ('xlsx', 'xlsm', OO + 'spreadsheetml.sheet.main+xml', 'application/vnd.ms-excel.sheet.macroEnabled.main+xml'),
    ('xlsx', 'xltm', OO + 'spreadsheetml.sheet.main+xml', 'application/vnd.ms-excel.template.macroEnabled.main+xml'),
    ('pptx', 'potx', OO + 'presentationml.presentation.main+xml', OO + 'presentationml.template.main+xml'),
    ('pptx', 'pptm', OO + 'presentationml.presentation.main+xml', 'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml'),
    ('pptx', 'ppsx', OO + 'presentationml.presentation.main+xml', OO + 'presentationml.slideshow.main+xml'),
    ('pptx', 'ppsm', OO + 'presentationml.presentation.main+xml', 'application/vnd.ms-powerpoint.slideshow.macroEnabled.main+xml'),
]
ODF = [('odt', 'ott', 'text'), ('ods', 'ots', 'spreadsheet'), ('odp', 'otp', 'presentation'), ('odg', 'otg', 'graphics')]
COPIES = [('html', 'htm'), ('html', 'xhtml'), ('md', 'markdown'), ('tsv', 'tab'), ('ppt', 'pps'), ('ppt', 'pot'), ('jpg', 'jpeg')]

DIF = '\n'.join([
    'TABLE', '0,1', '"EXCEL"', 'VECTORS', '0,4', '""', 'TUPLES', '0,3', '""', 'DATA', '0,0', '""',
    '-1,0', 'BOT', '1,0', '"Region"', '1,0', '"Q1"', '1,0', '"Q2"', '1,0', '"Total"',
    '-1,0', 'BOT', '1,0', '"North"', '0,200', 'V', '0,300', 'V', '0,500', 'V',
    '-1,0', 'BOT', '1,0', '"South"', '0,300', 'V', '0,450', 'V', '0,750', 'V',
    '-1,0', 'EOD', ''])
SLK = '\n'.join([
    'ID;PSCALC3', 'C;Y1;X1;K"Region"', 'C;X2;K"Q1"', 'C;X3;K"Q2"', 'C;X4;K"Total"',
    'C;Y2;X1;K"North"', 'C;X2;K200', 'C;X3;K300', 'C;X4;K500',
    'C;Y3;X1;K"South"', 'C;X2;K300', 'C;X3;K450', 'C;X4;K750', 'E', ''])


def main():
    made = []  # (ext, marker, source)
    for src, dst, old, new in OOXML:
        repackage(src, dst, [(CT, old, new)])
        made.append((dst, {'d': TEXT, 'x': 'North', 'p': TEXT}[dst[0] if dst[0] in 'dxp' else 'd'][:], 'package type of sample.%s changed' % src))
    for src, dst, kind in ODF:
        mime = 'application/vnd.oasis.opendocument.%s' % kind
        repackage(src, dst, [('mimetype', mime, mime + '-template'),
                             ('META-INF/manifest.xml', 'manifest:media-type="%s"' % mime,
                              'manifest:media-type="%s-template"' % mime)])
        made.append((dst, {'text': TEXT, 'spreadsheet': 'North', 'presentation': TEXT, 'graphics': None}[kind],
                     'ODF template made from sample.%s' % src))
    for src, dst in COPIES:
        shutil.copyfile(path(src), path(dst))
        made.append((dst, None, 'copy of sample.%s' % src))
    open(path('dif'), 'w').write(DIF)
    made.append(('dif', 'North', 'hand-written DIF'))
    open(path('slk'), 'w').write(SLK)
    made.append(('slk', 'North', 'hand-written SYLK'))
    with open(path('svg'), 'rb') as f:
        open(path('svgz'), 'wb').write(gzip.compress(f.read(), mtime=0))
    made.append(('svgz', None, 'gzipped sample.svg'))
    png = Image.open(path('png')).convert('RGB')
    png = png.resize((png.width // 2, png.height // 2))  # keep the BMP/TIFF fixtures small
    for ext, fmt in (('gif', 'GIF'), ('bmp', 'BMP'), ('webp', 'WEBP'), ('tiff', 'TIFF')):
        png.save(path(ext), fmt, **({'compression': 'tiff_lzw'} if fmt == 'TIFF' else {}))
        made.append((ext, None, 'sample.png saved as %s with Pillow' % fmt))

    manifest_path = os.path.join(M, 'manifest.json')
    manifest = [e for e in json.load(open(manifest_path)) if e['ext'] not in {m[0] for m in made}]
    manifest += [{'ext': ext, 'marker': marker, 'source': source} for ext, marker, source in made]
    json.dump(manifest, open(manifest_path, 'w'), indent=2)
    open(manifest_path, 'a').write('\n')
    for ext, _, _ in made:
        print('fixture', ext, os.path.getsize(path(ext)), 'bytes')


if __name__ == '__main__':
    main()
