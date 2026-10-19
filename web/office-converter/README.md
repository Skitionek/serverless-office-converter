# serverless-office-converter

Convert Word, Excel, PowerPoint and OpenDocument files to PDF, DOCX, ODT, XLSX, PNG, ... **in the
browser**. It is LibreOffice compiled to WebAssembly, running in a **Web Worker**: your page stays
responsive and no file is ever uploaded. The package includes the engine (about 30 MB, downloaded
once by your visitors and then cached).

```sh
npm install serverless-office-converter
```

```js
import { OfficeEngine } from 'serverless-office-converter';

const engine = new OfficeEngine({ base: '/node_modules/serverless-office-converter/' });
const { blob, filename } = await engine.convertFile(fileFromInput, 'pdf');
// blob: Blob, filename: 'report.pdf'
```

Preview thumbnails for your file lists: [`serverless-office-thumbnail`](../office-thumbnail/README.md).

## Setup

1. **Serve the package directory** (or copy it) from your own origin, so that `engine-worker.js`,
   `lo-thread.js`, `lo-pthread.js`, `lockdown.js`, `vendor/` and `lo/` are reachable under `base`.
   With a bundler, copy
   `node_modules/serverless-office-converter/{engine-worker.js,lo-thread.js,lo-pthread.js,lockdown.js,vendor,lo}`
   to your public/static folder; they are plain files the worker loads at run time. `OfficeEngine`'s
   `base` defaults to the directory it is loaded from, which is right when you serve the package as is.
2. **Make the page cross-origin isolated.** LibreOffice uses threads, so it needs
   `SharedArrayBuffer`, which browsers only give to pages sent with
   `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`.
   * If you control the headers: send them (and `Cross-Origin-Resource-Policy: same-origin` on the engine files),
     and give the engine's worker scripts (`engine-worker.js`, `lo-pthread.js`) the policy the
     included service worker adds (see [Security](#security)), with `<base>` the URL of the
     package directory:
     ```
     Content-Security-Policy: default-src 'none'; script-src <base> 'unsafe-eval' 'wasm-unsafe-eval'; connect-src <base>lo/; worker-src <base>lo-pthread.js
     ```
   * If you can't (e.g. GitHub Pages): use the included service worker. Create `sw.js` at the
     root of your site:
     ```js
     self.OFFICE_ENGINE_DIR = 'node_modules/serverless-office-converter/'; // where the package is served, relative to sw.js
     importScripts('node_modules/serverless-office-converter/service-worker.js');
     ```
     and call, before using the engine:
     ```js
     import { ensureCrossOriginIsolation } from 'serverless-office-converter';
     await ensureCrossOriginIsolation('sw.js'); // reloads once on the first visit
     ```
     The service worker also adds the headers and the engine's Content Security Policy, and
     serves the engine from its compressed form (xz, with a small wasm decoder) and caches it
     decompressed (checked against the SHA-256 in `lo/manifest.json` the first time each
     service worker instance serves it): one 30 MB download per release.

## API

### `new OfficeEngine({ base?, workerUrl?, timeoutMs?, isolateNetwork?, isolateDocuments? })`

Starts lazily on the first conversion (or `engine.start()`): a dedicated worker that loads
LibreOffice (about 7-10 s the first time; the download is cached afterwards).

* `isolateNetwork` (default `true`): the engine has no network (see [Security](#security)), so a
  document crafted to take over LibreOffice can't send anything anywhere. No cost: converting
  never needs the network. `false` loads the worker as `engine-worker.js?network`, without
  the policy and network lockdown.
* `isolateDocuments` (default `false`): every document gets a fresh engine, so such a document
  can't read or change the ones converted after it either. Performance fee: about **1.5 s per
  document**, the restart of the cached engine. Jobs with the same `key` (by default the `File`
  or handle passed to `convertFile`) are one document and share an engine; they run before
  other documents' jobs while it is open.
* Both can be changed at any time (`engine.isolateNetwork`, `engine.isolateDocuments`); a change
  applies from the next job, which gets a fresh engine if needed.

* `convertFile(file, targetId, { name?, priority?, quiet?, key? })` → `{ blob, filename, family, filter, ms }`
  converts a `File`/`Blob` (or reads a `FileSystemFileHandle`). `targetId` is a key of `TARGET_BY_ID`: `pdf`, `pdfa`, `docx`, `doc`,
  `odt`, `rtf`, `txt`, `md`, `xlsx`, `xls`, `ods`, `csv`, `html` (spreadsheets), `pptx`, `ppt`, `odp`,
  `odg`, `svg` (slides and drawings only), `png`, `jpg`, `fodt`, `fods`, `fodp`. The input format is detected from the file
  name's extension and content; `family` tells what it turned out to be (`writer`, `calc`,
  `impress`, `draw`).
* `convert(arrayBuffer, name, target, input?, opts?)` is the lower-level variant (pass the
  document's `key` in `opts` to share an engine with its other jobs).
* If the WebAssembly runtime hits a fault (an engine trap rather than a problem with the
  document), the worker is discarded and the job is retried once on a fresh one.
* Jobs run **one at a time, highest `priority` first** (default 0); `quiet` jobs don't flip the
  engine's state to `busy`. Rejections carry `error.message` from LibreOffice.
* `engine.state` and the `state` event (`detail: {state, text, detail}`): `idle`, `loading`, `ready`,
  `busy`, `error`. A crashed, hung (`timeoutMs`, default 5 min) or unsupported-browser engine
  goes to `error`; the next call starts a fresh worker.
* Download progress: the service worker posts `{file, loaded, total, version}` on a
  `BroadcastChannel('lo-assets')`.

### Files and folders (`file-system.js`)

Helpers for the [File System Access API](https://developer.mozilla.org/docs/Web/API/File_System_API),
with fallbacks where it is missing (Firefox, Safari). Inputs are only read; nothing is ever
written over an existing file.

* `openFiles(opts?)`, `openDirectory(opts?)` (recursive), `entriesFromDataTransfer(dataTransfer)`
  (call it synchronously in the `drop` handler; folders are expanded; `{ handles: false }` uses
  only plain files, without the File System Access API),
  `entriesFromInput(input.files)` (also for `<input webkitdirectory>`), `listDirectory(dirHandle)`
  → `[{ file, handle?, path, root? }]`. `path` is relative, e.g. `Reports/2025/q1.docx`; files
  inside folders are filtered with `isConvertible(name)` (known extension, not hidden, not a
  `~$` lock file). Cancelling a picker resolves with `[]`.
* `writeNewFile(dirHandle, 'Reports/2025/q1.pdf', blob)` → `{ handle, path }` creates the file
  (and folders). If the name is taken it writes `q1 (1).pdf`, `q1 (2).pdf`, ... instead;
  calls are serialised so concurrent writes never pick the same name.
* `saveFileAs(blob, suggestedName, { startIn?, protect? })` → handle or `null`: the save dialog.
  Browsers empty a file as soon as it is picked there, so pass the originals as
  `protect: [{ handle, data }]` (`data`: their bytes, or a promise of them started before the
  call): picking one puts its content back and rejects with a `SourceFileError`.
* `watchDirectory(dirHandle, onChange, { ignore?, debounceMs?, pollMs?, observe? })` →
  `{ stop(), observed }` calls `onChange(entries)` with the files that appeared or changed
  (new `lastModified`), using `FileSystemObserver` where available and polling otherwise.
  `ignore(path)` leaves out e.g. results you wrote into the watched folder yourself.
* `rememberHandle(key, handle)` / `recallHandle(key)` keep handles in IndexedDB across visits
  (call `ensureWritable()` on a recalled one from a click: the browser may ask again).
* `relativePath(dirHandle, handle)`: where a handle is inside a folder (`resolve()`), or `null`.
* `pickOutputDirectory()`, `ensureWritable(handle)`, `availableName(dirHandle, name)`.
* `outputName('report.docx', 'pdf')` → `report.pdf`; for the same format
  `report (converted).docx`, so a result never has its input's name. `outputPath()` keeps the
  folders. `convertFile()` uses the same naming and also accepts a `FileSystemFileHandle`.
* `canPickFiles`, `canPickDirectory`, `canPickSaveFile`, `canObserve`, `PICKER_TYPES`.

### Format tables (`formats.js`)

`TARGETS`, `TARGET_BY_ID`, `INPUT_FILTERS`, `INPUT_FAMILIES`, `ACCEPT` (for `<input accept>`),
`extensionOf(name)`, `guessFamily(name)`, `targetsForFamily(family)`, `FAMILY_LABELS`.

For migrating old documents: `newestOfficeTarget(name, family?)` → `{ target }` with `'docx'`,
`'xlsx'` or `'pptx'` for a document whose current Office format differs (DOC, XLS, PPT, RTF,
OpenDocument, Lotus, ...), or `{ target: null, reason }` for files to leave as they are
(already DOCX/XLSX/PPTX or another current Office format, plain text and data such as CSV,
drawings and images). `NEWEST_OFFICE` (`{ id, label }`) is the converter page's name for
that choice.

## Security

Documents are untrusted input to a large C++ parser. LibreOffice runs as WebAssembly in the
browser's sandbox, so a crafted document can't take over the computer, and macros are never
run. In case one takes over the engine itself (WebAssembly memory corruption, then JavaScript
through Embind), it is contained further:

* **No network** (`isolateNetwork`, on by default). The service worker gives the engine's
  workers a Content Security Policy: requests only to `lo/`, scripts only from the package
  directory, no workers but LibreOffice's threads (`lo-pthread.js`, which always get the
  policy). Once the engine has started, `lockdown.js` also removes `fetch`, `XMLHttpRequest`,
  `WebSocket`, ... and `importScripts` from its workers. Only the page can start the engine
  with the network (`engine-worker.js?network`).
* **No storage, no other pages** (always). `lockdown.js` removes IndexedDB (where `rememberHandle()` keeps
  folder handles), Cache Storage, `navigator.storage`, `BroadcastChannel`, ... from the engine's
  workers.
* **Nothing that outlives the document.** Without storage APIs the engine can't plant
  anything; the cached engine is also checked against the SHA-256 in `lo/manifest.json` when a
  service worker instance first serves it.
* **Optional: nothing shared between documents.** With `isolateDocuments`, every document gets a
  fresh engine (about 1.5 s per document).

What remains: a compromised engine controls the result of *its* document (without
`isolateDocuments`, also of the documents converted after it by the same engine), and can fail
or hang (see `timeoutMs`). Other pages on your origin are outside this: they share its storage.
`test/security.cjs` in the repository checks the above in Chromium.

## What's inside, and what isn't

LibreOffice 26.8 core (Writer, Calc, Impress, Draw filters), headless, trimmed for size. See the
[repository](https://github.com/Skitionek/serverless-office-converter) for the build and the
patches. Not supported: PDF input, password-protected files, formats whose import filters were
left out (Visio, Publisher, Keynote, WordPerfect, ...), HTML export of text documents. Needs a
current desktop browser and about 1 GB of memory.

`lo/manifest.json` records the LibreOffice version and commit; LibreOffice is MPL-2.0,
`vendor/xz-decompress.min.js` is MIT (see `vendor/README.md`).
