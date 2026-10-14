#!/usr/bin/env bash
# Cross-compile LibreOffice core (headless, no UI toolkit) to WebAssembly and
# package the result into web/lo/ for the static site.
#
# Requirements: an activated Emscripten SDK (see EMSDK_VERSION below), plus the
# usual LibreOffice build tools for the build platform (gcc/g++, make,
# autoconf, automake, bison, flex, gperf, libtool, pkg-config, python3,
# xsltproc, zip/unzip, nasm, wget/curl, git).  build/Dockerfile provides all of
# it.
#
# Environment overrides:
#   LO_BRANCH   LibreOffice git branch/tag to build      (libreoffice-26-8)
#   WORK        scratch directory for sources and build  (./work)
#   JOBS        build parallelism                        (nproc)
#   SITE_LO_DIR where to put the packaged runtime        (<repo>/web/lo)
#   WASM_MODULES LibreOffice modules to include          ("writer calc impress")
set -euo pipefail

EMSDK_VERSION=4.0.10
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
LO_BRANCH=${LO_BRANCH:-libreoffice-26-8}
WORK=${WORK:-$REPO/work}
JOBS=${JOBS:-$(nproc)}
SITE_LO_DIR=${SITE_LO_DIR:-$REPO/web/lo}
WASM_MODULES=${WASM_MODULES:-writer calc impress}
LO_SRC=$WORK/lo-core

command -v emcc >/dev/null || { echo "emcc not found: activate emsdk $EMSDK_VERSION first" >&2; exit 1; }
EM_VERSION=$(emcc -dumpversion)
[ "$EM_VERSION" = "$EMSDK_VERSION" ] || echo "warning: building with emscripten $EM_VERSION, tested with $EMSDK_VERSION" >&2

mkdir -p "$WORK/tarballs"

if [ ! -d "$LO_SRC/.git" ]; then
    git clone --depth 1 --branch "$LO_BRANCH" https://git.libreoffice.org/core "$LO_SRC"
fi

# Local fixes on top of upstream, if any.
for patch in "$HERE"/patches/*.patch; do
    [ -e "$patch" ] || continue
    if git -C "$LO_SRC" apply --check "$patch" 2>/dev/null; then
        echo "applying $(basename "$patch")"
        git -C "$LO_SRC" apply "$patch"
    else
        echo "skipping $(basename "$patch") (already applied?)"
    fi
done

# Headless WASM configuration, cf. static/README.wasm.md ("Building headless
# LibreOffice as WASM for use in another product").  Converting files in the
# browser needs no networking, so curl (and with it WebDAV) is left out.
cat > "$LO_SRC/autogen.input" <<EOF
--host=wasm32-local-emscripten
--disable-gui
--with-wasm-module=$WASM_MODULES
--with-package-format=emscripten
--disable-debug
--disable-crashdump
--without-java
--without-help
--without-helppack-integration
--disable-online-update
--disable-extension-integration
--disable-report-builder
--disable-curl
--without-webdav
--with-parallelism=$JOBS
--with-external-tar=$WORK/tarballs
EMSCRIPTEN_EXTRA_SOFFICE_PRE_JS=$HERE/soffice-pre.js
EOF

cd "$LO_SRC"
if [ ! -f config_host.mk ] || [ autogen.input -nt config_host.mk ]; then
    ./autogen.sh
fi

# gbuild occasionally trips over a directory-creation race in the
# cross-toolset phase on the first run; a second invocation continues fine.
make || make

LO_VERSION=$(sed -n 's/^export LIBO_VERSION_MAJOR=//p;s/^export LIBO_VERSION_MINOR=//p;s/^export LIBO_VERSION_MICRO=//p' config_host.mk | paste -sd.)
LO_VERSION="$LO_VERSION ($(git rev-parse --short=10 HEAD))"

python3 -I "$HERE/package-wasm.py" \
    "$LO_SRC/workdir/installation/LibreOffice/emscripten" "$SITE_LO_DIR" \
    --lo-version "$LO_VERSION" --emscripten "$EM_VERSION"
