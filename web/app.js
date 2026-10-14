import {
    ACCEPT, FAMILY_LABELS, INPUT_FILTERS, OfficeEngine, TARGETS, TARGET_BY_ID,
    extensionOf, guessFamily, targetsForFamily,
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
}

function resetResult(item) {
    if (item.url) URL.revokeObjectURL(item.url);
    item.url = null;
    const link = item.row.querySelector('.file-download');
    link.hidden = true;
    link.removeAttribute('href');
}

function addFiles(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    const defaultTarget = $('all-target').value;
    for (const file of files) {
        const family = guessFamily(file.name);
        const row = $('file-row').content.firstElementChild.cloneNode(true);
        const item = { file, family, row, status: 'queued', url: null, doneTarget: null };
        row.querySelector('.file-thumb').file = file;
        row.querySelector('.file-name').textContent = file.name;
        row.querySelector('.file-name').title = file.name;
        row.querySelector('.file-meta').textContent =
            FAMILY_LABELS[family] + ' · ' + formatBytes(file.size);
        const select = row.querySelector('.file-target');
        const targets = targetsForFamily(family);
        const preferred = targets.some((t) => t.id === defaultTarget) ? defaultTarget : 'pdf';
        fillTargetSelect(select, targets, preferred);
        select.addEventListener('change', () => {
            if (item.status === 'done' || item.status === 'error') {
                resetResult(item);
                setStatus(item, 'queued', 'Waiting…');
                runQueue();
            }
        });
        row.querySelector('.file-remove').addEventListener('click', () => {
            if (item.status === 'working') return;
            resetResult(item);
            items.splice(items.indexOf(item), 1);
            row.remove();
            updateQueueVisibility();
        });
        items.push(item);
        $('files').append(row);
        setStatus(item, 'queued', 'Waiting…');
    }
    updateQueueVisibility();
    if (supported) {
        engine.start().catch(() => {});
        if (api.autoConvert) runQueue();
    }
}

function updateQueueVisibility() {
    $('queue').hidden = items.length === 0;
    // Conversion starts by itself; the button only offers a retry after errors.
    $('convert-all').hidden = running || !items.some((i) => i.status === 'error');
    $('convert-all').textContent = 'Retry failed';
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
        const dot = item.file.name.lastIndexOf('.');
        const stem = dot > 0 ? item.file.name.slice(0, dot) : item.file.name;
        const outName = stem + '.' + target.ext;
        const blob = new Blob([result.data], { type: target.mime || 'application/octet-stream' });
        item.url = URL.createObjectURL(blob);
        item.doneTarget = target.id;
        const link = item.row.querySelector('.file-download');
        link.href = item.url;
        link.download = outName;
        link.hidden = false;
        const secs = ((performance.now() - started) / 1000).toFixed(1);
        setStatus(item, 'done', formatBytes(blob.size) + ' · ' + secs + ' s');
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

async function runQueue() {
    if (running || !supported) return;
    running = true;
    updateQueueVisibility();
    try {
        for (let item; (item = items.find((i) => i.status === 'queued'));) {
            await convertItem(item);
        }
    } finally {
        running = false;
        updateQueueVisibility();
    }
}

$('convert-all').addEventListener('click', () => {
    for (const item of items) {
        if (item.status === 'error') setStatus(item, 'queued', 'Waiting…');
    }
    runQueue();
});

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

$('file-input').addEventListener('change', (e) => {
    addFiles(e.target.files);
    e.target.value = '';
});

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
    addFiles(e.dataTransfer.files);
});

// Expose for automated tests and the browser console.
const api = window.officeConverter = { engine, addFiles, runQueue, items, TARGETS, autoConvert: true };
