#!/usr/bin/env python3
"""Package the LibreOffice WebAssembly build for static hosting.

Every runtime file (soffice.js, soffice.wasm, soffice.data, ...) is gzip
compressed and split into parts small enough for a git repository / GitHub
Pages (GitHub rejects files over 100 MB and warns above 50 MB).  A
manifest.json describes how to reassemble them; web/sw.js does that
transparently in the browser with a DecompressionStream.

Usage: package-wasm.py <emscripten-output-dir> <site-lo-dir> [--lo-version X] [--emscripten X]
"""

import argparse
import datetime
import gzip
import hashlib
import json
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('src')
    parser.add_argument('dest')
    parser.add_argument('--lo-version', default='')
    parser.add_argument('--emscripten', default='')
    parser.add_argument('--part-size', type=int, default=PART_SIZE)
    args = parser.parse_args()

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
        path = os.path.join(args.src, name)
        with open(path, 'rb') as f:
            raw = f.read()
        # mtime=0 keeps the output reproducible for identical inputs.
        packed = gzip.compress(raw, compresslevel=9, mtime=0)
        digest.update(name.encode() + b'\0' + hashlib.sha256(packed).digest())
        parts = []
        for i in range(0, max(len(packed), 1), args.part_size):
            part_name = '%s.gz.%03d' % (name, len(parts))
            with open(os.path.join(args.dest, part_name), 'wb') as out:
                out.write(packed[i:i + args.part_size])
            parts.append(part_name)
        files[name] = {
            'type': mime_for(name),
            'size': len(raw),
            'encoding': 'gzip',
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
