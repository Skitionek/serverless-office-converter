import {
    ACCEPT, FAMILY_LABELS, INPUT_FILTERS, OfficeEngine, TARGETS, TARGET_BY_ID,
    canPickDirectory, canPickFiles, canPickSaveFile, ensureWritable, entriesFromDataTransfer,
    entriesFromInput, extensionOf, guessFamily, openDirectory, openFiles, outputName, outputPath,
    pickOutputDirectory, saveFileAs, targetsForFamily, writeNewFile,
} from './office-converter/index.js';
import { OfficeThumbnail } from './office-thumbnail/office-thumbnail.js';

const $ = (id) => document.getElementById(id);

function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
}

// ---------------------------------------------------------------------------
// Engine: LibreOffice running in a Web Worker (see office-converter/).

const engine = new OfficeEngine();
OfficeThumbnail.engine = engine;

// ---------------------------------------------------------------------------
// Engine status UI, including download progress reported by sw.js.

const downloads = new Map();
let manifest = null;
let lastStatus = '';

function renderEngine(state, text, detail) {
    $('engine-dot').dataset.state = state;
    $('engine-text').textContent = text;
    $('engine-detail').textContent = detail || '';
    $('engine-load').hidden = state !== 'error';
    if (state !== 'loading') $('engine-progress').hidden = true;
}

// While loading, show download progress until everything is fetched, then
// the runtime's own status messages.
function renderLoading() {
    let loaded = 0;
    let total = 0;
    for (const d of downloads.values()) {
        loaded += d.loaded;
        total += d.total;
    }
    if (manifest && manifest.compressedSize) total = Math.max(total, manifest.compressedSize);
    const bar = $('engine-progress');
    if (total && loaded < total * 0.99) {
        bar.hidden = false;
        bar.max = total;
        bar.value = loaded;
        renderEngine('loading', 'Downloading the converter…',
                     formatBytes(loaded) + ' of ' + formatBytes(total) +
                     ' (only needed once; cached afterwards)');
    } else {
        bar.hidden = true;
        renderEngine('loading', 'Starting the converter…',
                     lastStatus || 'Initialising the office core; this takes a few seconds.');
    }
}

engine.addEventListener('state', (e) => {
    const { state, text, detail } = e.detail;
    if (state === 'loading') {
        if (detail) lastStatus = detail;
        renderLoading();
    } else {
        renderEngine(state, text, detail);
    }
});

new BroadcastChannel('lo-assets').addEventListener('message', (e) => {
    const { file, loaded, total } = e.data;
    downloads.set(file, { loaded, total });
    if (engine.state === 'loading') renderLoading();
});

$('engine-load').addEventListener('click', () => {
    engine.start().catch(() => {});
});

fetch(new URL('lo/manifest.json', engine.base), { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : null))
    .then((m) => {
        if (!m) return;
        manifest = m;
        const parts = [];
        if (m.libreoffice) parts.push('LibreOffice ' + m.libreoffice);
        if (m.emscripten) parts.push('Emscripten ' + m.emscripten);
        if (m.built) parts.push('built ' + m.built.slice(0, 10));
        $('build-info').textContent = parts.join(' · ') + (parts.length ? '.' : '');
        if (m.compressedSize && engine.state === 'idle') {
            $('engine-text').textContent = 'The converter (' + formatBytes(m.compressedSize) +
                ', downloaded once) loads when you add a file.';
        }
    })
    .catch(() => {});

// ---------------------------------------------------------------------------
// Browser support.

function checkSupport() {
    const missing = [];
    if (typeof WebAssembly !== 'object') missing.push('WebAssembly');
    else if (typeof WebAssembly.Exception !== 'function') missing.push('WebAssembly exception handling');
    if (!('serviceWorker' in navigator) && !window.crossOriginIsolated) {
        missing.push('service workers (needed for cross-origin isolation)');
    }
    if (missing.length) {
        const box = $('support-error');
        box.hidden = false;
        box.textContent = 'Your browser lacks features the converter needs: ' + missing.join(', ') +
            '. Please use a current version of Chrome, Edge, Firefox or Safari.';
        return false;
    }
    if (!window.crossOriginIsolated) {
        renderEngine('loading', 'Preparing a cross-origin isolated context…',
                     'If this message stays, reload the page.');
        return false;
    }
    return true;
}

const supported = checkSupport();

// ---------------------------------------------------------------------------
// File queue.

const items = [];
let running = false;

function fillTargetSelect(select, targets, selected) {
    select.replaceChildren(...targets.map((t) => {
        const option = new Option(t.label, t.id, false, t.id === selected);
        return option;
    }));
}

fillTargetSelect($('all-target'), TARGETS, 'pdf');
$('file-input').accept = ACCEPT;

function setStatus(item, state, text) {
    item.status = state;
    const el = item.row.querySelector('.file-status');
    el.dataset.state = state;
    el.textContent = text;
    syncRowButton(item);
}

// Files whose conversion has been asked for (by either kind of Convert button).
const requested = new Set();

// The row's own Convert button: offered for files that are not converted yet (or failed).
function syncRowButton(item) {
    const button = item.row.querySelector('.file-convert');
    const waiting = (item.status === 'queued' && !requested.has(item)) || item.status === 'error';
    button.hidden = !waiting || requested.has(item);
    button.textContent = item.status === 'error' ? 'Retry' : 'Convert';
    button.disabled = !supported;
}

function resetResult(item) {
    if (item.url) URL.revokeObjectURL(item.url);
    item.url = null;
    item.blob = null;
    item.savedTo = null;
    const link = item.row.querySelector('.file-download');
    link.hidden = true;
    link.removeAttribute('href');
}

// Accepts Files and FileEntry objects ({file, handle?, path, root?}, see
// office-converter/file-system.js), so files keep their handle and folder path.
function addFiles(list) {
    const entries = [...list].map((x) => (x instanceof Blob ? { file: x, path: x.name } : x));
    if (!entries.length) return;
    const defaultTarget = $('all-target').value;
    for (const { file, handle = null, path = file.name, root = null } of entries) {
        const family = guessFamily(file.name);
        const row = $('file-row').content.firstElementChild.cloneNode(true);
        const item = {
            file, handle, path, root, family, row, status: 'queued',
            url: null, blob: null, outName: null, doneText: '', savedTo: null, doneTarget: null,
        };
        row.querySelector('.file-thumb').file = file;
        row.querySelector('.file-name').textContent = path;
        row.querySelector('.file-name').title = path;
        row.querySelector('.file-meta').textContent =
            FAMILY_LABELS[family] + ' · ' + formatBytes(file.size);
        const select = row.querySelector('.file-target');
        const targets = targetsForFamily(family);
        const preferred = targets.some((t) => t.id === defaultTarget) ? defaultTarget : 'pdf';
        fillTargetSelect(select, targets, preferred);
        select.addEventListener('change', () => {
            if (item.status === 'done' || item.status === 'error') {
                resetResult(item);
                setStatus(item, 'queued', '');
                updateQueueVisibility();
            }
        });
        row.querySelector('.file-convert').addEventListener('click', () => runQueue([item]));
        if (canPickSaveFile) row.querySelector('.file-download').textContent = 'Save…';
        row.querySelector('.file-download').addEventListener('click', (e) => {
            if (!canPickSaveFile || !item.blob) return; // a plain download
            e.preventDefault();
            saveItemAs(item);
        });
        row.querySelector('.file-remove').addEventListener('click', () => {
            if (item.status === 'working') return;
            requested.delete(item);
            resetResult(item);
            items.splice(items.indexOf(item), 1);
            row.remove();
            updateQueueVisibility();
        });
        items.push(item);
        $('files').append(row);
        setStatus(item, 'queued', '');
    }
    updateQueueVisibility();
    // Load the engine early (for the thumbnails and so that it is ready), but convert
    // nothing until the user presses Convert.
    if (supported) engine.start().catch(() => {});
}

function updateQueueVisibility() {
    $('queue').hidden = items.length === 0;
    const pending = items.filter((i) => (i.status === 'queued' || i.status === 'error') &&
                                        !requested.has(i)).length;
    const button = $('convert-all');
    button.disabled = !supported || pending === 0;
    button.textContent = pending > 1 ? 'Convert ' + pending + ' files' : 'Convert';
}

async function convertItem(item) {
    const target = TARGET_BY_ID.get(item.row.querySelector('.file-target').value);
    resetResult(item);
    setStatus(item, 'working', 'Converting…');
    const ext = extensionOf(item.file.name);
    const started = performance.now();
    try {
        const data = await item.file.arrayBuffer();
        const result = await engine.convert(data, item.file.name, target, INPUT_FILTERS[ext]);
        const outName = outputName(item.file.name, target.ext);
        const blob = new Blob([result.data], { type: target.mime || 'application/octet-stream' });
        item.blob = blob;
        item.outName = outName;
        item.url = URL.createObjectURL(blob);
        item.doneTarget = target.id;
        const link = item.row.querySelector('.file-download');
        link.href = item.url;
        link.download = outName;
        link.hidden = false;
        const secs = ((performance.now() - started) / 1000).toFixed(1);
        item.doneText = formatBytes(blob.size) + ' · ' + secs + ' s';
        setStatus(item, 'done', item.doneText);
        if (outDir) await saveToOutDir(item);
        if (result.family && result.family !== item.family) {
            item.family = result.family;
            item.row.querySelector('.file-meta').textContent =
                FAMILY_LABELS[result.family] + ' · ' + formatBytes(item.file.size);
        }
    } catch (e) {
        setStatus(item, 'error', e.message || String(e));
        if (e.family && e.family !== item.family && FAMILY_LABELS[e.family]) {
            // Loaded as something else than guessed: offer the right targets.
            item.family = e.family;
            const select = item.row.querySelector('.file-target');
            fillTargetSelect(select, targetsForFamily(e.family), 'pdf');
            item.row.querySelector('.file-meta').textContent =
                FAMILY_LABELS[e.family] + ' · ' + formatBytes(item.file.size);
        }
    }
}

// Converts the given files (default: all that are waiting or failed earlier), one after
// another.  Can be called while a run is going: the files join the run.  Files that were not
// asked for (e.g. added meanwhile) wait for their own press.
async function runQueue(list = items) {
    for (const item of list) {
        if (items.includes(item) && (item.status === 'queued' || item.status === 'error')) {
            requested.add(item);
            setStatus(item, 'queued', 'Waiting…');
        }
    }
    updateQueueVisibility();
    if (running || !supported) return;
    running = true;
    try {
        for (let item; (item = items.find((i) => i.status === 'queued' && requested.has(i)));) {
            await convertItem(item);
            requested.delete(item);
            syncRowButton(item);
        }
    } finally {
        running = false;
        updateQueueVisibility();
    }
}

$('convert-all').addEventListener('click', () => runQueue());

$('all-target').addEventListener('change', () => {
    const id = $('all-target').value;
    for (const item of items) {
        if (item.status === 'working') continue;
        const select = item.row.querySelector('.file-target');
        if ([...select.options].some((o) => o.value === id) && select.value !== id) {
            select.value = id;
            select.dispatchEvent(new Event('change'));
        }
    }
});

$('clear').addEventListener('click', () => {
    for (const item of [...items]) {
        if (item.status === 'working') continue;
        resetResult(item);
        item.row.remove();
        items.splice(items.indexOf(item), 1);
    }
    updateQueueVisibility();
});

// ---------------------------------------------------------------------------
// Opening files and folders.  With the File System Access API (Chrome, Edge) files keep
// their handles, so results can go next to them; elsewhere <input type=file> is used.
// Inputs are only ever read: results are always written as new files.

function reportError(e) {
    console.error(e);
    const box = $('fs-error');
    box.textContent = e.message || String(e);
    box.hidden = false;
}

async function addEntries(promise, { folder = false } = {}) {
    $('fs-error').hidden = true;
    try {
        const entries = await promise;
        if (entries.length) addFiles(entries);
        else if (folder) reportError(new Error('That folder has no files the converter can open.'));
    } catch (e) {
        reportError(e);
    }
}

function startIn() {
    const last = items.findLast((i) => i.handle);
    return last ? last.handle : undefined;
}

$('file-input').addEventListener('click', (e) => {
    if (!canPickFiles) return;
    e.preventDefault();
    addEntries(openFiles({ startIn: startIn() }));
});

$('file-input').addEventListener('change', (e) => {
    addFiles(entriesFromInput(e.target.files));
    e.target.value = '';
});

$('pick-folder').addEventListener('click', () => {
    if (!canPickDirectory) {
        $('folder-input').click();
        return;
    }
    addEntries(openDirectory({ startIn: startIn() }), { folder: true });
});

$('folder-input').addEventListener('change', (e) => {
    const entries = entriesFromInput(e.target.files);
    e.target.value = '';
    addEntries(Promise.resolve(entries), { folder: true });
});

// Files opened with the installed app ("Open with" in the operating system).
if ('launchQueue' in window) {
    window.launchQueue.setConsumer((params) => {
        if (!params.files || !params.files.length) return;
        addEntries(Promise.all(params.files.filter((h) => h.kind === 'file').map(
            async (handle) => ({ file: await handle.getFile(), handle, path: handle.name }))));
    });
}

// ---------------------------------------------------------------------------
// Saving results.  "Save" asks for a name (never one of the originals); "Save to folder"
// writes every result, now and later, into a folder as new files: when a name is taken,
// " (1)", " (2)", ... is added, so nothing existing (in particular no original) is replaced.

let outDir = null;

function showSaved(item, path) {
    item.savedTo = path;
    setStatus(item, 'done', item.doneText + ' · saved as ' + path);
}

async function saveItemAs(item) {
    const blob = item.blob;
    // The save dialog empties the file the user picks: read the originals now, so that one
    // can be put back if it gets picked.
    const protect = items.filter((i) => i.handle).map((i) => ({
        handle: i.handle,
        data: i.file.arrayBuffer().catch(() => null),
    }));
    for (const p of protect) p.data.catch(() => {});
    try {
        const handle = await saveFileAs(blob, item.outName, { startIn: item.handle || undefined, protect });
        if (handle && item.blob === blob) showSaved(item, handle.name);
    } catch (e) {
        if (item.blob === blob) setStatus(item, 'done', item.doneText + ' · not saved: ' + (e.message || e));
    }
}

// Where in outDir an item's result goes: its folder path is kept, and when outDir is the
// folder it came from, the result lands next to the original.
async function outPathFor(item) {
    let path = outputPath(item.path, TARGET_BY_ID.get(item.doneTarget).ext);
    if (item.root && path.includes('/') && await outDir.isSameEntry(item.root).catch(() => false)) {
        path = path.slice(path.indexOf('/') + 1);
    }
    return path;
}

async function saveToOutDir(item) {
    const dir = outDir;
    const blob = item.blob;
    if (!dir || !blob || item.savedTo || item.saving) return;
    item.saving = true;
    try {
        const { path } = await writeNewFile(dir, await outPathFor(item), blob);
        if (item.blob === blob) showSaved(item, dir.name + '/' + path);
    } catch (e) {
        if (item.blob === blob) setStatus(item, 'done', item.doneText + ' · not saved: ' + (e.message || e));
    } finally {
        item.saving = false;
    }
}

function renderOutDir() {
    $('save-folder').textContent = outDir ? 'Change folder…' : 'Save to folder…';
    $('out-dir').hidden = !outDir;
    $('out-dir-name').textContent = outDir ? outDir.name : '';
}

async function setOutputDirectory(dir) {
    if (dir && !await ensureWritable(dir)) throw new Error('No permission to write to "' + dir.name + '".');
    outDir = dir;
    renderOutDir();
    if (!dir) return;
    for (const item of items) {
        if (item.status === 'done' && item.blob && !item.savedTo) await saveToOutDir(item);
    }
}

$('save-folder').hidden = !canPickDirectory;
$('save-folder').addEventListener('click', async () => {
    $('fs-error').hidden = true;
    try {
        const first = items.find((i) => i.root || i.handle);
        const dir = await pickOutputDirectory({ startIn: (first && (first.root || first.handle)) || undefined });
        if (dir) await setOutputDirectory(dir);
    } catch (e) {
        reportError(e);
    }
});

$('out-dir-stop').addEventListener('click', () => setOutputDirectory(null));

const drop = $('drop');
for (const type of ['dragenter', 'dragover']) {
    document.addEventListener(type, (e) => {
        if (![...e.dataTransfer.types].includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        drop.classList.add('dragging');
    });
}
for (const type of ['dragleave', 'dragend']) {
    document.addEventListener(type, (e) => {
        if (e.relatedTarget === null) drop.classList.remove('dragging');
    });
}
document.addEventListener('drop', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    drop.classList.remove('dragging');
    addEntries(entriesFromDataTransfer(e.dataTransfer));
});

// Expose for automated tests and the browser console.
window.officeConverter = { engine, addFiles, runQueue, items, TARGETS, setOutputDirectory };
