import {
    ACCEPT, FAMILY_LABELS, INPUT_FILTERS, OfficeEngine, TARGETS, TARGET_BY_ID,
    canPickDirectory, ensureWritable, entriesFromDataTransfer, entriesFromInput, extensionOf,
    guessFamily, listDirectory, outputName, outputPath, recallHandle, relativePath, rememberHandle,
    targetsForFamily, watchDirectory, writeNewFile,
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
// Returns the new queue items.
function addFiles(list) {
    const entries = [...list].map((x) => (x instanceof Blob ? { file: x, path: x.name } : x));
    const added = [];
    if (!entries.length) return added;
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
        row.querySelector('.file-remove').addEventListener('click', () => {
            if (item.status === 'working') return;
            requested.delete(item);
            resetResult(item);
            items.splice(items.indexOf(item), 1);
            row.remove();
            updateQueueVisibility();
        });
        items.push(item);
        added.push(item);
        $('files').append(row);
        setStatus(item, 'queued', '');
    }
    updateQueueVisibility();
    // Load the engine early (for the thumbnails and so that it is ready), but convert
    // nothing until the user presses Convert.
    if (supported) engine.start().catch(() => {});
    return added;
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
// Opening files.  Choosing and dropping files are plain browser features: no permission is
// asked and results are downloaded.  The File System Access API (Chrome, Edge) is only used
// for the three things that need it, each started on purpose and explained first:
// converting a whole folder, saving results straight into a folder, and watching a folder.
// Even then, files are only read, and results are always written as new files.

function showError(box, e) {
    console.error(e);
    box.textContent = e.message || String(e);
    box.hidden = false;
}
const reportError = (e) => showError($('fs-error'), e);
const reportFolderError = (e) => {
    $('folder-tools-details').open = true;
    showError($('folder-error'), e);
};

function clearErrors() {
    $('fs-error').hidden = true;
    $('folder-error').hidden = true;
}

async function addEntries(promise, { folder = false } = {}) {
    clearErrors();
    try {
        const entries = await promise;
        for (const entry of entries) if (entry.root) entry.root = await canonicalRoot(entry.root);
        if (entries.length) addFiles(entries);
        else if (folder) reportError(new Error('That folder has no files the converter can open.'));
        return entries;
    } catch (e) {
        reportError(e);
        return [];
    }
}

$('file-input').addEventListener('change', (e) => {
    addFiles(entriesFromInput(e.target.files));
    e.target.value = '';
});

// Files opened with the installed app ("Open with" in the operating system): the user chose
// them there, so the browser asks nothing more.
if ('launchQueue' in window) {
    window.launchQueue.setConsumer((params) => {
        if (!params.files || !params.files.length) return;
        addEntries(Promise.all(params.files.filter((h) => h.kind === 'file').map(
            async (handle) => ({ file: await handle.getFile(), handle, path: handle.name }))));
    });
}

// ---------------------------------------------------------------------------
// Before anything that makes the browser ask for access to a folder, say what is about to
// happen, what the browser will ask and what the converter will (and will not) do.

const SKIP_KEY = 'office-converter-skip-explanations';

function skipped() {
    try {
        return JSON.parse(localStorage.getItem(SKIP_KEY)) || [];
    } catch {
        return [];
    }
}

/**
 * Shows the explanation dialog; resolves true when the user presses Continue.  The click on
 * Continue counts as the user gesture the browser's folder picker needs.
 * @param {{key: string, title: string, points: string[], ok: string, skippable?: boolean}} what
 */
function explain({ key, title, points, ok, skippable = true }) {
    if (skippable && skipped().includes(key)) return Promise.resolve(true);
    const dialog = $('fs-dialog');
    $('fs-dialog-title').textContent = title;
    $('fs-dialog-body').replaceChildren(...points.map((text) => {
        const li = document.createElement('li');
        li.textContent = text;
        return li;
    }));
    $('fs-dialog-ok').textContent = ok;
    $('fs-dialog-skip').checked = false;
    $('fs-dialog-skip-label').hidden = !skippable;
    dialog.returnValue = '';
    dialog.showModal();
    return new Promise((resolve) => {
        dialog.addEventListener('close', () => {
            const yes = dialog.returnValue === 'ok';
            if (yes && $('fs-dialog-skip').checked) {
                try {
                    localStorage.setItem(SKIP_KEY, JSON.stringify([...skipped(), key]));
                } catch { /* private mode: ask again next time */ }
            }
            resolve(yes);
        }, { once: true });
    });
}

function targetLabel() {
    return TARGET_BY_ID.get($('all-target').value).label;
}

// Asks the browser for a folder.  Resolves with null when the user cancels.
async function pickFolder(mode, startIn) {
    try {
        return await window.showDirectoryPicker({ id: 'office-converter-' + mode, mode, startIn });
    } catch (e) {
        if (e.name === 'AbortError') return null;
        throw e;
    }
}

// ---------------------------------------------------------------------------
// Converting a whole folder: all documents in it and its subfolders are added to the list.

$('pick-folder').addEventListener('click', async () => {
    clearErrors();
    if (!canPickDirectory) {
        const go = await explain({
            key: 'folder-input',
            title: 'Convert a whole folder',
            points: [
                'Next, pick a folder. Every document in it and in its subfolders is added to the list.',
                'Your browser may then ask whether to “upload” the files to this site. That is just the ' +
                    'browser’s standard wording for letting a page read files: nothing is sent anywhere, ' +
                    'the files are converted here, on this device.',
                'The files are only read. Results are downloaded, as usual.',
            ],
            ok: 'Pick a folder',
        });
        if (go) $('folder-input').click();
        return;
    }
    const go = await explain({
        key: 'folder-read',
        title: 'Convert a whole folder',
        points: [
            'Next, pick a folder. Every document in it and in its subfolders is added to the list.',
            'Your browser will then ask whether this page may view the files in that folder. Allow it, ' +
                'or the converter can’t read them.',
            'The files are only read: nothing in the folder is changed, and nothing is uploaded. ' +
                'Results are downloaded, as usual.',
            'The permission is for this tab only; it ends when you close it.',
        ],
        ok: 'Pick a folder',
    });
    if (!go) return;
    try {
        const dir = await pickFolder('read');
        if (dir) await addEntries(listDirectory(dir), { folder: true });
    } catch (e) {
        reportError(e);
    }
});

$('folder-input').addEventListener('change', (e) => {
    const entries = entriesFromInput(e.target.files);
    e.target.value = '';
    addEntries(Promise.resolve(entries), { folder: true });
});

// ---------------------------------------------------------------------------
// Saving results straight into a folder: every result, now and later, is written there as a
// new file.  When a name is taken, " (1)", " (2)", ... is added, so nothing existing (in
// particular no original) is ever replaced.

let outDir = null;
// The folder is remembered (handles can be kept in IndexedDB), but only offered again after a
// reload, never used without asking: the browser wants the permission confirmed anyway.
let rememberedOutDir = null;

function showSaved(item, path) {
    item.savedTo = path;
    setStatus(item, 'done', item.doneText + ' · saved as ' + path);
}

// Is the file at `path` under `dir` the original itself (same size and modification time)?
async function isOriginalAt(dir, path, file) {
    try {
        let d = dir;
        const parts = path.split('/');
        const name = parts.pop();
        for (const part of parts) d = await d.getDirectoryHandle(part);
        const found = await (await d.getFileHandle(name)).getFile();
        return found.size === file.size && found.lastModified === file.lastModified;
    } catch {
        return false;
    }
}

// Where in outDir an item's result goes: next to the original when that is inside outDir,
// otherwise in the original's folder path (e.g. "Reports/2025/") under outDir.
async function outPathFor(item) {
    const ext = TARGET_BY_ID.get(item.doneTarget).ext;
    let inside = item.handle && await relativePath(outDir, item.handle);
    if (!inside && item.path.includes('/')) {
        // Files of a dropped folder have no handle: if outDir is that folder, the original
        // is found in it under the rest of its path.
        const [first, ...rest] = item.path.split('/');
        if (first === outDir.name && await isOriginalAt(outDir, rest.join('/'), item.file)) inside = rest.join('/');
    }
    return outputPath(inside || item.path, ext);
}

async function saveToOutDir(item) {
    const dir = outDir;
    const blob = item.blob;
    if (!dir || !blob || item.savedTo || item.saving) return;
    item.saving = true;
    try {
        const { path, handle } = await writeNewFile(dir, await outPathFor(item), blob);
        await noteWritten(handle);
        if (item.blob === blob) showSaved(item, dir.name + '/' + path);
    } catch (e) {
        if (item.blob === blob) setStatus(item, 'done', item.doneText + ' · not saved: ' + (e.message || e));
    } finally {
        item.saving = false;
    }
}

function renderFolderTools() {
    $('save-folder').textContent = outDir ? 'Save into another folder…' : 'Save results into a folder…';
    $('out-dir').hidden = !outDir;
    $('out-dir-name').textContent = outDir ? outDir.name : '';
    $('out-dir-resume-bar').hidden = !!outDir || !rememberedOutDir;
    $('out-dir-resume-name').textContent = rememberedOutDir ? rememberedOutDir.name : '';
    $('watches').hidden = !watches.length;
    // While the converter works with a folder, say so where it can be seen.
    if (outDir || watches.length) $('folder-tools-details').open = true;
}

async function setOutputDirectory(dir) {
    if (dir && !await ensureWritable(dir)) {
        throw new Error('The browser did not allow saving into “' + dir.name + '”, so results are downloaded as usual.');
    }
    outDir = dir;
    if (dir) rememberedOutDir = dir;
    rememberHandle('out-dir', dir).catch(() => {});
    renderFolderTools();
    if (!dir) return;
    for (const item of items) {
        if (item.status === 'done' && item.blob && !item.savedTo) await saveToOutDir(item);
    }
}

function explainSaving(folderName) {
    return explain({
        key: 'folder-write',
        skippable: false,
        title: folderName ? 'Save into “' + folderName + '” again' : 'Save results straight into a folder',
        points: [
            folderName
                ? 'Your browser will ask again whether this page may save files in “' + folderName + '”.'
                : 'Next, pick a folder. Your browser will then ask whether this page may view and save ' +
                  'files in it: allow it, or the results can’t be saved there.',
            'Every result, the ones that are done and the ones that follow, is written into that folder ' +
                'as a new file, keeping the folder structure of what you converted. Pick the folder your ' +
                'originals are in to get the results next to them.',
            'Nothing that is already in the folder is ever changed, replaced or deleted, including your ' +
                'originals. When a name is taken, the result gets “(1)”, “(2)”, … added to its name, and a ' +
                'DOCX converted to DOCX is called “… (converted).docx”.',
            'Nothing is uploaded: your browser writes the files on this device.',
            'It lasts until you press “Stop saving there” or close this tab. Download buttons keep working.',
        ],
        ok: folderName ? 'Allow saving' : 'Pick a folder',
    });
}

$('save-folder').addEventListener('click', async () => {
    clearErrors();
    if (!await explainSaving()) return;
    try {
        const first = items.find((i) => i.root || i.handle);
        const dir = await pickFolder('readwrite', (first && (first.root || first.handle)) || undefined);
        if (dir) await setOutputDirectory(dir);
    } catch (e) {
        reportFolderError(e);
    }
});

$('out-dir-stop').addEventListener('click', () => setOutputDirectory(null));

$('out-dir-resume').addEventListener('click', async () => {
    clearErrors();
    if (!await explainSaving(rememberedOutDir.name)) return;
    setOutputDirectory(rememberedOutDir).catch(reportFolderError);
});

// ---------------------------------------------------------------------------
// Watching a folder: files that appear in it or change are added and converted (and saved,
// if a folder to save into is chosen).  The app's own results are ignored, so a folder can
// be both watched and saved into.

const watches = []; // { dir, row, watcher, ignored: Set<path> }

// The same folder picked twice gives two handles: use the first one, so that a watch can
// match the files to the queue.
async function canonicalRoot(dir) {
    for (const w of watches) if (w.dir === dir || await w.dir.isSameEntry(dir)) return w.dir;
    for (const i of items) if (i.root && (i.root === dir || await i.root.isSameEntry(dir))) return i.root;
    return dir;
}

async function noteWritten(handle) {
    for (const w of watches) {
        const rel = await relativePath(w.dir, handle);
        if (rel) w.ignored.add(w.dir.name + '/' + rel);
    }
}

function renderWatch(watch) {
    watch.row.querySelector('.watch-name').textContent = watch.dir.name;
    watch.row.querySelector('.watch-target').textContent = targetLabel();
    watch.row.querySelector('.watch-polling').hidden = watch.watcher.observed;
}

$('all-target').addEventListener('change', () => watches.forEach(renderWatch));

async function startWatching(dir) {
    dir = await canonicalRoot(dir);
    if (watches.some((w) => w.dir === dir)) return;
    const row = $('watch-row').content.firstElementChild.cloneNode(true);
    const watch = { dir, row, watcher: null, ignored: new Set() };
    watch.watcher = await watchDirectory(dir, onWatchedChange, {
        ignore: (path) => watch.ignored.has(path),
        onError: reportFolderError,
    });
    watches.push(watch);
    row.querySelector('.watch-stop').addEventListener('click', () => {
        watch.watcher.stop();
        watches.splice(watches.indexOf(watch), 1);
        row.remove();
        renderFolderTools();
    });
    renderWatch(watch);
    $('watches').append(row);
    renderFolderTools();
}

$('watch-folder').addEventListener('click', async () => {
    clearErrors();
    const go = await explain({
        key: 'folder-watch',
        skippable: false,
        title: 'Watch a folder',
        points: [
            'Next, pick a folder. Your browser will then ask whether this page may view the files in it: ' +
                'allow it, or the converter can’t see new files.',
            'The documents already in the folder are added to the list; they are converted when you ' +
                'press Convert, as usual.',
            'Documents that are later added to the folder, or changed, are converted automatically to ' +
                'the default output format (now ' + targetLabel() + ').',
            'The folder is only read. The results appear in the list to download, or are saved as new ' +
                'files if you also chose a folder to save into. Nothing is uploaded.',
            'Watching lasts until you press “Stop watching” or close this tab.',
        ],
        ok: 'Pick a folder',
    });
    if (!go) return;
    try {
        const dir = await pickFolder('read');
        if (!dir) return;
        await addEntries(listDirectory(dir));
        await startWatching(dir);
    } catch (e) {
        reportFolderError(e);
    }
});

function onWatchedChange(entries) {
    const fresh = [];
    const added = [];
    for (const entry of entries) {
        const item = items.find((i) => i.root === entry.root && i.path === entry.path && i.status !== 'working');
        if (!item) {
            added.push(entry);
            continue;
        }
        // A new version of a listed file: convert it again (into a new result file).
        requested.delete(item);
        resetResult(item);
        item.file = entry.file;
        item.handle = entry.handle;
        item.row.querySelector('.file-thumb').file = entry.file;
        item.row.querySelector('.file-meta').textContent =
            FAMILY_LABELS[item.family] + ' · ' + formatBytes(entry.file.size);
        setStatus(item, 'queued', '');
        fresh.push(item);
    }
    fresh.push(...addFiles(added));
    runQueue(fresh);
}

if (canPickDirectory) {
    $('folder-tools').hidden = false;
    recallHandle('out-dir').then((dir) => {
        if (!dir || outDir) return;
        rememberedOutDir = dir;
        renderFolderTools();
    }).catch(() => {});
}

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
    // Plain files only: dropping needs no access to the folders on disk.
    addEntries(entriesFromDataTransfer(e.dataTransfer, { handles: false }));
});

// Expose for automated tests and the browser console.
window.officeConverter = {
    engine, addFiles, addEntries, runQueue, items, TARGETS, setOutputDirectory, startWatching, watches,
};
