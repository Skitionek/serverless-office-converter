#!/usr/bin/env python3
"""Package the LibreOffice WebAssembly build for static hosting.

Every runtime file (soffice.js, soffice.wasm, soffice.data, ...) is xz
compressed (about 35-40% smaller than gzip) and split into parts small enough
for a git repository / GitHub Pages (GitHub rejects files over 100 MB and warns
above 50 MB).  A manifest.json describes how to reassemble them; web/sw.js does
that transparently in the browser (xz via web/vendor/xz-decompress.min.js,
gzip via DecompressionStream).

Optionally, files can be dropped from LibreOffice's in-memory file system
image (soffice.data) at this stage: its file list lives in the separately
loaded soffice.data.js.metadata, so it can be rewritten without relinking.

Usage: package-wasm.py <emscripten-output-dir> <site-lo-dir> [--lo-version X]
           [--emscripten X] [--data-exclude patterns.txt] [--compression xz|gzip]
"""

import argparse
import datetime
import fnmatch
import gzip
import hashlib
import json
import lzma
import os
import shutil
import sys

PART_SIZE = 40 * 1024 * 1024

MIME = {
    '.wasm': 'application/wasm',
    '.js': 'text/javascript',
    '.data': 'application/octet-stream',
    '.metadata': 'application/json',
    '.json': 'application/json',
}

# Files of the emscripten installation set that are needed at run time.
RUNTIME_SUFFIXES = ('.js', '.wasm', '.data', '.metadata')
SKIP = ('.html', '.ico', '.debug.wasm', '.dwp', '.map')


def mime_for(name):
    for suffix, mime in MIME.items():
        if name.endswith(suffix):
            return mime
    return 'application/octet-stream'


def read_patterns(path):
    patterns = []
    with open(path, encoding='utf-8') as f:
        for line in f:
            line = line.split('#', 1)[0].strip()
            if line:
                patterns.append(line)
    return patterns


def trim_data_image(src, patterns):
    """Return (data, metadata) for soffice.data without the files matching patterns."""
    with open(os.path.join(src, 'soffice.data'), 'rb') as f:
        data = f.read()
    with open(os.path.join(src, 'soffice.data.js.metadata'), encoding='utf-8') as f:
        metadata = json.load(f)
    kept = []
    out = bytearray()
    removed = {}
    for entry in metadata['files']:
        name = entry['filename']
        match = next((p for p in patterns if fnmatch.fnmatchcase(name, p)), None)
        size = entry['end'] - entry['start']
        if match:
            removed.setdefault(match, [0, 0])
            removed[match][0] += 1
            removed[match][1] += size
            continue
        chunk = data[entry['start']:entry['end']]
        new_entry = dict(entry, start=len(out), end=len(out) + len(chunk))
        out += chunk
        kept.append(new_entry)
    unused = [p for p in patterns if p not in removed]
    for pattern, (count, size) in sorted(removed.items(), key=lambda kv: -kv[1][1]):
        print('  data-exclude %-60s %4d files %7.1f MB' % (pattern, count, size / 1e6))
    if unused:
        sys.exit('error: data-exclude patterns matched nothing: ' + ', '.join(unused))
    metadata['files'] = kept
    metadata['remote_package_size'] = len(out)
    if 'package_uuid' in metadata:
        metadata['package_uuid'] = 'sha256-' + hashlib.sha256(out).hexdigest()
    print('  soffice.data: %.1f MB -> %.1f MB' % (len(data) / 1e6, len(out) / 1e6))
    return bytes(out), json.dumps(metadata, separators=(',', ':')).encode()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('src')
    parser.add_argument('dest')
    parser.add_argument('--lo-version', default='')
    parser.add_argument('--emscripten', default='')
    parser.add_argument('--part-size', type=int, default=PART_SIZE)
    parser.add_argument('--compression', choices=('xz', 'gzip'), default='xz')
    parser.add_argument('--data-exclude', help='file with fnmatch patterns of soffice.data '
                        'paths to leave out')
    args = parser.parse_args()

    overrides = {}
    if args.data_exclude:
        data, metadata = trim_data_image(args.src, read_patterns(args.data_exclude))
        overrides = {'soffice.data': data, 'soffice.data.js.metadata': metadata}

    names = sorted(
        n for n in os.listdir(args.src)
        if os.path.isfile(os.path.join(args.src, n))
        and n.endswith(RUNTIME_SUFFIXES) and not n.endswith(SKIP))
    if 'soffice.wasm' not in names or 'soffice.js' not in names:
        sys.exit('error: %s does not look like a LibreOffice emscripten build (%s)'
                 % (args.src, ', '.join(names)))

    if os.path.isdir(args.dest):
        shutil.rmtree(args.dest)
    os.makedirs(args.dest)

    digest = hashlib.sha256()
    files = {}
    compressed_total = 0
    for name in names:
        if name in overrides:
            raw = overrides[name]
        else:
            with open(os.path.join(args.src, name), 'rb') as f:
                raw = f.read()
        if args.compression == 'xz':
            # CRC32 is the cheapest integrity check xz-embedded supports.
            packed = lzma.compress(raw, format=lzma.FORMAT_XZ, check=lzma.CHECK_CRC32,
                                   preset=9 | lzma.PRESET_EXTREME)
        else:
            # mtime=0 keeps the output reproducible for identical inputs.
            packed = gzip.compress(raw, compresslevel=9, mtime=0)
        suffix = 'xz' if args.compression == 'xz' else 'gz'
        digest.update(name.encode() + b'\0' + hashlib.sha256(packed).digest())
        parts = []
        for i in range(0, max(len(packed), 1), args.part_size):
            part_name = '%s.%s.%03d' % (name, suffix, len(parts))
            with open(os.path.join(args.dest, part_name), 'wb') as out:
                out.write(packed[i:i + args.part_size])
            parts.append(part_name)
        files[name] = {
            'type': mime_for(name),
            'size': len(raw),
            # Checked by the service worker before it serves a cached copy.
            'sha256': hashlib.sha256(raw).hexdigest(),
            'encoding': args.compression,
            'compressedSize': len(packed),
            'parts': parts,
        }
        compressed_total += len(packed)
        print('%-28s %8.1f MB -> %7.1f MB in %d part(s)'
              % (name, len(raw) / 1e6, len(packed) / 1e6, len(parts)))

    manifest = {
        'version': digest.hexdigest()[:16],
        'libreoffice': args.lo_version,
        'emscripten': args.emscripten,
        'built': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
        'compressedSize': compressed_total,
        'files': files,
    }
    with open(os.path.join(args.dest, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=2)
        f.write('\n')
    print('total compressed: %.1f MB, version %s' % (compressed_total / 1e6, manifest['version']))


if __name__ == '__main__':
    main()
