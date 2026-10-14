import {
    ACCEPT, FAMILY_LABELS, INPUT_FILTERS, TARGETS, TARGET_BY_ID,
    extensionOf, guessFamily, targetsForFamily,
} from './formats.js';

const $ = (id) => document.getElementById(id);
const CONVERSION_TIMEOUT_MS = 5 * 60 * 1000;

function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
}

// ---------------------------------------------------------------------------
// Engine: LibreOffice running in a hidden same-origin iframe (engine.html).

class Engine extends EventTarget {
    constructor() {
        super();
        this.state = 'idle';
        this.frame = null;
        this.ready = null;
        this.pending = new Map();
        this.nextId = 1;
        window.addEventListener('message', (e) => this.onMessage(e));
    }

    setState(state, text, detail) {
        this.state = state;
        this.dispatchEvent(new CustomEvent('state', { detail: { state, text, detail } }));
    }

    start() {
        if (this.ready) return this.ready;
        this.startedAt = performance.now();
        this.setState('loading', '');
        this.ready = new Promise((resolve, reject) => {
            this.resolveReady = resolve;
            this.rejectReady = reject;
        });
        // Avoid an unhandled rejection when nobody awaits a failed start.
        this.ready.catch(() => {});
        const frame = document.createElement('iframe');
        frame.className = 'engine-frame';
        frame.title = 'LibreOffice engine';
        frame.tabIndex = -1;
        frame.setAttribute('aria-hidden', 'true');
        frame.src = 'engine.html';
        this.frame = frame;
        document.body.append(frame);
        return this.ready;
    }

    stop(reason) {
        if (this.frame) this.frame.remove();
        this.frame = null;
        if (this.ready && this.rejectReady) this.rejectReady(new Error(reason));
        this.ready = null;
        for (const { reject, timer } of this.pending.values()) {
            clearTimeout(timer);
            reject(new Error(reason));
        }
        this.pending.clear();
    }

    onMessage(event) {
        if (event.origin !== location.origin || !this.frame ||
            event.source !== this.frame.contentWindow) {
            return;
        }
        const msg = event.data || {};
        switch (msg.type) {
        case 'status':
            if (this.state === 'loading') this.setState('loading', '', msg.text);
            break;
        case 'ready': {
            const secs = ((performance.now() - this.startedAt) / 1000).toFixed(1);
            this.rejectReady = null;
            this.resolveReady();
            this.setState('ready', 'Ready. Everything stays on this device.', 'Started in ' + secs + ' s.');
            break;
        }
        case 'result': {
            const job = this.pending.get(msg.id);
            if (!job) break;
            this.pending.delete(msg.id);
            clearTimeout(job.timer);
            if (msg.ok) job.resolve(msg);
            else job.reject(Object.assign(new Error(msg.error), { family: msg.family }));
            if (this.pending.size === 0 && this.state === 'busy') {
                this.setState('ready', 'Ready. Everything stays on this device.');
            }
            break;
        }
        case 'fatal':
            this.stop(msg.message);
            this.setState('error', 'The engine stopped.', msg.message);
            break;
        }
    }

    async convert(data, name, target, input) {
        await this.start();
        const id = this.nextId++;
        this.setState('busy', 'Converting…');
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.stop('Conversion timed out.');
                this.setState('error', 'The engine was restarted after a timeout.');
            }, CONVERSION_TIMEOUT_MS);
            this.pending.set(id, { resolve, reject, timer });
            this.frame.contentWindow.postMessage({
                type: 'convert',
                id,
                name,
                data,
                target: {
                    ext: target.ext,
                    label: target.label,
                    filters: target.filters,
                    filterOptions: target.filterOptions,
                    filterData: target.filterData,
                },
                inputFilter: input && input.filter,
                inputFilterOptions: input && input.options,
            }, location.origin, [data]);
        });
    }
}

const engine = new Engine();

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

fetch('lo/manifest.json', { cache: 'no-cache' })
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
