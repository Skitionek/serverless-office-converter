# Third-party notices

The converter's own code is licensed under the [MPL-2.0](LICENSE). It ships the following
third-party software, all of which runs in the visitor's browser.

| Component | Where | License |
| --- | --- | --- |
| [LibreOffice](https://www.libreoffice.org/) core, built for WebAssembly | `lo/soffice.{js,wasm,data}` | MPL-2.0; some parts LGPLv3+. Bundled libraries (ICU, Boost, libxml2, ...) carry their own licenses, listed with their full texts in [`lo/LICENSE.html`](lo/LICENSE.html) |
| [Emscripten](https://emscripten.org/) runtime | `lo/soffice.js` | MIT or University of Illinois/NCSA |
| Liberation Sans, Serif, Mono and Sans Narrow fonts | `lo/soffice.data` | SIL Open Font License 1.1 |
| Carlito font | `lo/soffice.data` | SIL Open Font License 1.1 |
| Caladea font | `lo/soffice.data` | Apache-2.0, as listed by LibreOffice (upstream has since moved to the SIL OFL 1.1) |
| DejaVu Sans font | `lo/soffice.data` | Bitstream Vera and Arev font licenses; DejaVu changes are public domain |
| OpenSymbol font | `lo/soffice.data` | Part of LibreOffice (MPL-2.0) |
| [xz-decompress](https://www.npmjs.com/package/xz-decompress) 0.2.3 | `vendor/xz-decompress.min.js` | MIT (xz-embedded: public domain; walloc: MIT); see [`vendor/README.md`](vendor/README.md) |

[`lo/LICENSE.html`](lo/LICENSE.html) is LibreOffice's own licensing listing
(`readlicense_oo/license/license.xml`) from the commit the engine was built from (recorded in
`lo/manifest.json`). It covers the full LibreOffice distribution, including components this
trimmed WebAssembly build leaves out; `build/build-libreoffice-wasm.sh` copies it on every build.
