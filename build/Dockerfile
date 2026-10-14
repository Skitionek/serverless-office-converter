# Reproducible build environment for the LibreOffice WebAssembly build.
#
#   docker build -t lo-wasm-builder build/
#   docker run --rm -v "$PWD:/src" -w /src lo-wasm-builder build/build-libreoffice-wasm.sh
#
# Emscripten version as required by LibreOffice's static/README.wasm.md.
FROM emscripten/emsdk:4.0.10

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        autoconf automake bison ccache flex gettext git gperf libtool make nasm \
        patch pkg-config python3 unzip wget xsltproc libxml2-utils zip \
 && rm -rf /var/lib/apt/lists/*
