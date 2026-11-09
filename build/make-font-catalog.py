#!/usr/bin/env python3
"""Write web/office-converter/font-catalog.json: the fonts that are downloaded on demand.

The converter bundles only a handful of core fonts.  Every other font is
fetched from a CDN when a document needs it (see
web/office-converter/font-catalog.js).  This script turns the family list in
build/font-catalog-seed.json into the catalog the browser reads: for each
family the exact files on the CDN, with their size and SHA-256.  The browser
refuses a file whose hash differs, so the catalog is what makes relying on a
CDN safe.

Where the fonts come from:

* Google Fonts families: the @expo-google-fonts/<family> npm packages, which
  hold Google Fonts as static TrueType files, at the version that is latest
  when this script runs.  The URL contains that version, so the files never
  change.  npm packages are served by jsDelivr (and, identically laid out, by
  unpkg), reliably; the google/fonts GitHub repository is too big for jsDelivr
  and answers randomly with "package size exceeded" errors.
* Other fonts (DejaVu): explicit files of an npm package, listed in the seed.

Which files of a family: Regular and Bold, and their italics, where they
exist.  A family that draws a script (the "scripts" in the seed) gets just
Regular: it only has to supply glyphs, and LibreOffice makes bold by
emboldening, which saves 5-10 MB per Chinese, Japanese or Korean font.

Usage:
  make-font-catalog.py          write the catalog
  make-font-catalog.py --check  download every catalogued file again and compare
                                it with the recorded hash
"""

import argparse
import concurrent.futures
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SEED_PATH = os.path.join(HERE, 'font-catalog-seed.json')
CATALOG_PATH = os.path.join(HERE, '..', 'web', 'office-converter', 'font-catalog.json')

NPM_REGISTRY = 'https://registry.npmjs.org/'
JSDELIVR_PACKAGES = 'https://data.jsdelivr.com/v1/packages/npm/'
GOOGLE_FONTS_PACKAGE_SCOPE = '@expo-google-fonts/'

FONT_MAGIC = (b'\x00\x01\x00\x00', b'OTTO', b'true', b'ttcf')
DOWNLOAD_ATTEMPTS = 4
PARALLEL_DOWNLOADS = 6

# @expo-google-fonts/open-sans/700Bold_Italic/OpenSans_700Bold_Italic.ttf
STATIC_FONT = re.compile(r'^/(?P<weight>\d{3})\w*?(?P<italic>_Italic)?/[^/]+\.ttf$')


def url_path(path):
    """Escape each segment but keep "," and "@": that is how CDNs spell these paths."""
    return '/'.join(urllib.parse.quote(part, safe=',@') for part in path.split('/'))


def download(url):
    last_error = None
    for attempt in range(DOWNLOAD_ATTEMPTS):
        try:
            with urllib.request.urlopen(url, timeout=120) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            last_error = error
        except (urllib.error.URLError, TimeoutError) as error:
            last_error = error
        time.sleep(2 ** attempt)
    sys.exit('error: could not download %s: %s' % (url, last_error))


def download_json(url):
    data = download(url)
    if data is None:
        sys.exit('error: %s does not exist' % url)
    return json.loads(data)


def google_fonts_package(family):
    """'Open Sans' -> '@expo-google-fonts/open-sans'"""
    return GOOGLE_FONTS_PACKAGE_SCOPE + re.sub(r'[^a-z0-9]+', '-', family.lower()).strip('-')


def google_fonts_files(family, regular_only):
    """The npm paths ('package@version/400Regular/File.ttf') of a Google Fonts family to catalog."""
    package = google_fonts_package(family)
    registry_entry = download(NPM_REGISTRY + package)
    if registry_entry is None:
        sys.exit('error: "%s" has no npm package %s' % (family, package))
    version = json.loads(registry_entry)['dist-tags']['latest']

    listing = download_json('%s%s@%s?structure=flat' % (JSDELIVR_PACKAGES, package, version))
    wanted_weights = ('400',) if regular_only else ('400', '700')
    chosen = []
    for file_entry in sorted(listing['files'], key=lambda f: f['name']):
        match = STATIC_FONT.match(file_entry['name'])
        if not match or match.group('weight') not in wanted_weights:
            continue
        if regular_only and match.group('italic'):
            continue
        chosen.append('%s@%s%s' % (package, version, file_entry['name']))
    if not any('/400' in path and '_Italic' not in path for path in chosen):
        sys.exit('error: %s@%s has no regular (400) font file' % (package, version))
    return chosen


def fingerprint(base_url, path):
    data = download(base_url + url_path(path))
    if data is None:
        sys.exit('error: %s%s does not exist' % (base_url, path))
    if not data.startswith(FONT_MAGIC):
        sys.exit('error: %s%s is not a font file' % (base_url, path))
    return {'path': path, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


def build_catalog(seed):
    sources = seed['sources']
    script_families = set(seed['scripts'].values())

    with concurrent.futures.ThreadPoolExecutor(PARALLEL_DOWNLOADS) as pool:
        google_families = seed['googleFonts']
        google_paths = pool.map(lambda family: google_fonts_files(family, family in script_families),
                                google_families)
        listings = {family: ('npm', paths) for family, paths in zip(google_families, google_paths)}
        for family, entry in seed['otherFonts'].items():
            listings[family] = (entry['source'], entry['files'])

        jobs = [(family, source, path) for family, (source, paths) in listings.items() for path in paths]
        print('hashing %d files of %d families ...' % (len(jobs), len(listings)), file=sys.stderr)
        results = list(pool.map(lambda job: fingerprint(sources[job[1]], job[2]), jobs))

    families = {}
    for (family, source, _), file_entry in zip(jobs, results):
        entry = families.setdefault(family, {'source': source, 'files': []})
        entry['files'].append(file_entry)

    for name, target in seed['aliases'].items():
        if target not in families:
            sys.exit('error: alias %s points at %s, which is not in the catalog' % (name, target))
    for script, family in seed['scripts'].items():
        if family not in families:
            sys.exit('error: script %s points at %s, which is not in the catalog' % (script, family))

    return {
        'format': 1,
        'sources': sources,
        'families': dict(sorted(families.items(), key=lambda item: item[0].lower())),
        'aliases': seed['aliases'],
        'scripts': seed['scripts'],
    }


def check_catalog(catalog):
    jobs = [(family, catalog['sources'][entry['source']], file_entry)
            for family, entry in catalog['families'].items() for file_entry in entry['files']]

    def check(job):
        family, base, file_entry = job
        data = download(base + url_path(file_entry['path']))
        digest = hashlib.sha256(data).hexdigest() if data is not None else None
        if digest == file_entry['sha256']:
            return 0
        print('MISMATCH %s: %s (%s)' % (family, file_entry['path'], digest or 'missing'))
        return 1

    with concurrent.futures.ThreadPoolExecutor(PARALLEL_DOWNLOADS) as pool:
        return sum(pool.map(check, jobs))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--check', action='store_true', help='verify the existing catalog against the CDN')
    args = parser.parse_args()

    if args.check:
        with open(CATALOG_PATH, encoding='utf-8') as f:
            problems = check_catalog(json.load(f))
        print('catalog verified' if not problems else '%d file(s) differ' % problems)
        sys.exit(1 if problems else 0)

    with open(SEED_PATH, encoding='utf-8') as f:
        seed = json.load(f)
    catalog = build_catalog(seed)
    with open(CATALOG_PATH, 'w', encoding='utf-8') as f:
        json.dump(catalog, f, indent=1, ensure_ascii=False)
        f.write('\n')

    total = sum(file_entry['size'] for entry in catalog['families'].values() for file_entry in entry['files'])
    print('%d families, %.0f MB in total on the CDN, written to %s'
          % (len(catalog['families']), total / 1e6, os.path.relpath(CATALOG_PATH)))


if __name__ == '__main__':
    main()
