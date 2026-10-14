# serverless-office-thumbnail

`<office-thumbnail>`: a web component that shows a preview image of a Word, Excel,
PowerPoint or OpenDocument file. The preview is rendered **in the visitor's browser** by
LibreOffice compiled to WebAssembly, so documents are never uploaded anywhere.

```sh
npm install serverless-office-thumbnail
```

```html
<script type="module">
  import { OfficeEngine, OfficeThumbnail } from 'serverless-office-thumbnail';
  // Directory on YOUR origin that serves the engine (see "Hosting the engine"):
  OfficeThumbnail.engine = new OfficeEngine({ base: '/office-engine/' });
</script>

<office-thumbnail src="/files/report.docx"></office-thumbnail>
```

Or give it a `File` straight from an `<input type="file">` or a drop:

```js
const thumb = document.createElement('office-thumbnail');
thumb.file = input.files[0];
list.append(thumb);
```

## How it behaves

* **Asynchronous and lazy.** Nothing is rendered until the element is (nearly) on screen. The
  engine starts on the first thumbnail; until a preview is ready the element shows the file
  extension as a placeholder.
* **Low priority.** Previews go through the same queue as `OfficeEngine.convert()`, behind any
  conversion your page requests, so they never delay real work. One document is converted at a
  time.
* **Plain images** (png, jpg, gif, webp, svg, bmp) are shown directly, without the engine.
* **First page / slide / sheet** only, exported as PNG.
* The same `File` shown by several elements is converted once.
* Files over 25 MB are skipped (attribute `max-size`, in bytes).

## API

| | |
| --- | --- |
| `src` attribute | URL of the document (fetched same-origin or via CORS) |
| `file` property | `File`/`Blob` to preview (alternative to `src`) |
| `name` attribute | File name, when it can't be derived from `src`/`file` (its extension selects the import filter) |
| `max-size` attribute | Largest input in bytes (default 26214400) |
| `engine` property | `OfficeEngine` for this element (default: `OfficeThumbnail.engine`) |
| `state` attribute (read-only) | `empty`, `waiting`, `loading`, `ready` or `error` |
| events | `thumbnail-ready` (`detail: {url, blob}`), `thumbnail-error` (`detail: Error`), both bubble |

Styling: CSS custom properties `--office-thumbnail-width` (64px), `--office-thumbnail-aspect`
(4 / 5), `--office-thumbnail-border`, `--office-thumbnail-radius`,
`--office-thumbnail-background`, `--office-thumbnail-placeholder`, `--office-thumbnail-color`;
shadow parts `frame`, `image`, `placeholder`.

### `OfficeEngine`

```js
const engine = new OfficeEngine({ base: '/office-engine/', timeoutMs: 300000 });
engine.addEventListener('state', (e) => console.log(e.detail.state)); // idle|loading|ready|busy|error
const { data } = await engine.convert(await file.arrayBuffer(), file.name, TARGET_BY_ID.get('pdf'));
```

`convert(data, name, target, input?, {priority?, quiet?})` resolves to
`{data: ArrayBuffer, family, filter, ms}`. `formats.js` exports the format tables
(`TARGETS`, `TARGET_BY_ID`, `INPUT_FILTERS`, `extensionOf`, `guessFamily`, ...). A crashed or
hung engine is discarded and restarted for the next job.

## Hosting the engine

The component is small (a few KB); the engine is the LibreOffice WebAssembly build (about 30 MB,
downloaded once and then cached). It must be served from **your own origin**, in a page that is
cross-origin isolated (`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`), because LibreOffice uses threads
(`SharedArrayBuffer`). On hosts that can't set headers (e.g. GitHub Pages), the service worker
from the repository does it for you.

Take these from the [repository](https://github.com/Skitionek/serverless-office-converter)'s
`web/` directory and serve them from `base`:

`engine.html`, `engine.js`, `lo-thread.js`, `sw.js`, `vendor/`, `lo/`

and register `sw.js` on your page (see `index.html` there) unless you send the headers yourself.
`lo/` holds the prebuilt runtime; `build/build-libreoffice-wasm.sh` rebuilds it.

## Notes

* Needs a current desktop browser (WebAssembly exceptions, SharedArrayBuffer) and about 1 GB of
  memory. On other browsers thumbnails end in the `error` state and show the placeholder.
* Not supported: PDF input, password-protected files, formats whose import filters were left out
  to keep the build small (Visio, Publisher, Keynote, WordPerfect, ...).
