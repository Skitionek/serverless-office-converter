/* Client for the in-browser LibreOffice engine.
 *
 * LibreOffice (WebAssembly) runs in a dedicated Web Worker (`engine-worker.js`
 * under `base`), so conversions never block the page.  The page has to be
 * cross-origin isolated (see README).  Jobs are run one at a time, most
 * important first, so background work such as thumbnails never delays a
 * conversion the user asked for.
 *
 * Documents are untrusted.  By default (`isolateNetwork`) the engine has no
 * network: a file crafted to take over LibreOffice can't send anything anywhere
 * (see lockdown.js and service-worker.js).  Optionally (`isolateDocuments`),
 * each document also gets a fresh engine, so such a file can't see or alter
 * the documents converted after it; jobs for the same document (e.g. its
 * thumbnail and its conversion) share one.
 */

import { outputName } from './file-system.js';
import { INPUT_FILTERS, TARGET_BY_ID, extensionOf } from './formats.js';

// Errors that mean the WebAssembly runtime itself is corrupted (not that the document is bad):
// once one has happened, every later job on that worker tends to fail too.
const ENGINE_FAULT = /table index is out of bounds|memory access out of bounds|unreachable|RuntimeError|Aborted|stack overflow/i;

const READY_TEXT = 'Ready. Everything stays on this device.';

// The document of every job while documents are not isolated.
const SHARED = Symbol('shared engine');

export class OfficeEngine extends EventTarget {
    /**
     * @param {object} [options]
     * @param {string|URL} [options.base] Directory that serves engine-worker.js and lo/
     *   (default: the directory this module is loaded from).
     * @param {string|URL} [options.workerUrl] URL of engine-worker.js if it is not directly under `base`.
     * @param {number} [options.timeoutMs] Abort and restart the engine when one job takes longer.
     * @param {number} [options.startTimeoutMs] Give up on an engine that makes no progress for this
     *   long while starting (no download progress, no message from it); default 2 min.
     * @param {boolean} [options.isolateNetwork] Keep the engine off the network (default true;
     *   no cost: conversions never need it).
     * @param {boolean} [options.isolateDocuments] Start a fresh engine for each document (default
     *   false; costs about 1.5 s per document once the engine is cached).
     * Both can be changed at any time (`engine.isolateNetwork`, `engine.isolateDocuments`); they
     * apply from the next job on.
     */
    constructor({
        base = new URL('./', import.meta.url), workerUrl, timeoutMs = 5 * 60 * 1000,
        startTimeoutMs = 2 * 60 * 1000, isolateNetwork = true, isolateDocuments = false,
    } = {}) {
        super();
        this.base = new URL(base, document.baseURI).href;
        this.workerUrl = new URL(workerUrl || 'engine-worker.js', this.base).href;
        this.timeoutMs = timeoutMs;
        this.startTimeoutMs = startTimeoutMs;
        this.isolateNetwork = isolateNetwork;
        this.isolateDocuments = isolateDocuments;
        this.document = undefined; // the document the current worker has opened (or SHARED)
        this.network = false; // whether the current worker may use the network
        this.state = 'idle';
        this.worker = null;
        this.ready = null;
        this.pending = new Map(); // running jobs by id
        this.queue = [];
        this.running = false;
        this.nextId = 1;
        this.seq = 0;
    }

    setState(state, text, detail) {
        this.state = state;
        this.dispatchEvent(new CustomEvent('state', { detail: { state, text, detail } }));
    }

    start({ quiet = false } = {}) {
        if (this.ready) return this.ready;
        this.startedAt = performance.now();
        this.quietStart = quiet;
        this.document = undefined;
        this.network = !this.isolateNetwork;
        if (!quiet) this.setState('loading', '');
        this.ready = new Promise((resolve, reject) => {
            this.resolveReady = resolve;
            this.rejectReady = reject;
        });
        // Avoid an unhandled rejection when nobody awaits a failed start.
        this.ready.catch(() => {});
        const url = new URL(this.workerUrl);
        if (this.network) url.searchParams.set('network', '');
        const worker = new Worker(url);
        worker.onmessage = (event) => this.onMessage(worker, event.data || {});
        worker.onerror = (event) => {
            event.preventDefault();
            this.fail(worker, event.message || 'The engine worker could not be started.');
        };
        this.worker = worker;
        this.watchStart(worker);
        return this.ready;
    }

    // A worker that stops making progress before it is ready would otherwise keep every job
    // waiting forever: after startTimeoutMs without a sign of life (download progress from the
    // service worker, any message from the worker), it is discarded as a fault.
    watchStart(worker) {
        let timer = null;
        const progress = new BroadcastChannel('lo-assets');
        const poke = () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                done();
                const secs = Math.round(this.startTimeoutMs / 1000);
                this.fail(worker, 'The engine stopped starting (no progress for ' + secs + ' s).');
            }, this.startTimeoutMs);
        };
        const done = () => {
            clearTimeout(timer);
            progress.close();
            worker.removeEventListener('message', poke);
        };
        progress.onmessage = poke;
        worker.addEventListener('message', poke);
        this.ready.then(done, done);
        poke();
    }

    stop(reason, { fault = false } = {}) {
        if (this.worker) this.worker.terminate();
        this.worker = null;
        if (this.ready && this.rejectReady) {
            this.rejectReady(Object.assign(new Error(reason), { engineFault: fault }));
        }
        this.ready = null;
        for (const { reject, timer } of this.pending.values()) {
            clearTimeout(timer);
            reject(Object.assign(new Error(reason), { engineFault: fault }));
        }
        this.pending.clear();
    }

    fail(worker, message) {
        if (worker !== this.worker) return;
        this.stop(message, { fault: true });
        this.setState('error', 'The engine stopped.', message);
    }

    onMessage(worker, msg) {
        if (worker !== this.worker) return; // a worker that has been discarded
        switch (msg.type) {
        case 'status':
            if (this.state === 'loading') this.setState('loading', '', msg.text);
            break;
        case 'ready': {
            const secs = ((performance.now() - this.startedAt) / 1000).toFixed(1);
            this.rejectReady = null;
            this.resolveReady();
            if (!this.quietStart) this.setState('ready', READY_TEXT, 'Started in ' + secs + ' s.');
            break;
        }
        case 'result': {
            const job = this.pending.get(msg.id);
            if (!job) break;
            this.pending.delete(msg.id);
            clearTimeout(job.timer);
            if (msg.ok) job.resolve(msg);
            else job.reject(Object.assign(new Error(msg.error), { family: msg.family }));
            break;
        }
        case 'fatal':
            this.fail(worker, msg.message);
            break;
        }
    }

    /**
     * Converts a document.
     * @param {ArrayBuffer} data Input bytes.
     * @param {string} name Input file name (its extension helps format detection).
     * @param {object} target `{ ext, label, filters, filterOptions?, filterData? }`, see formats.js.
     * @param {{filter?: string, options?: string}} [input] Forced import filter.
     * @param {{priority?: number, quiet?: boolean, key?: *}} [opts] Higher priority runs first;
     *   quiet jobs do not change the engine's 'busy' state (use for background work).  Jobs
     *   with the same `key` (e.g. the File) are the same document and share an engine when
     *   `isolateDocuments` is on; without one, the job then gets an engine of its own.
     * @returns {Promise<{data: ArrayBuffer, family: string, filter: string, ms: number}>}
     */
    convert(data, name, target, input, { priority = 0, quiet = false, key } = {}) {
        if (key === undefined) key = Symbol(name);
        return new Promise((resolve, reject) => {
            this.queue.push({
                data, name, target, input, quiet, priority, key, seq: this.seq++, resolve, reject,
            });
            this.pump();
        });
    }

    /**
     * Converts a File/Blob (or a FileSystemFileHandle, which is only read) to one of the
     * targets in formats.js (e.g. 'pdf', 'docx', 'png').
     * Picks the import filter from the file name's extension.
     * @param {Blob|FileSystemFileHandle} file
     * @param {string} targetId Key of TARGET_BY_ID, e.g. 'pdf'.
     * @param {{name?: string, priority?: number, quiet?: boolean, key?: *}} [opts] `key`
     *   defaults to `file`: jobs for the same File (or handle) share an engine.
     * @returns {Promise<{blob: Blob, filename: string, family: string, filter: string, ms: number}>}
     */
    async convertFile(file, targetId, { name, key = file, ...opts } = {}) {
        opts.key = key;
        if (typeof file.getFile === 'function') file = await file.getFile();
        if (!name) name = file.name || 'document';
        const target = TARGET_BY_ID.get(targetId);
        if (!target) throw new Error('Unknown target format: ' + targetId);
        const result = await this.convert(
            await file.arrayBuffer(), name, target, INPUT_FILTERS[extensionOf(name)], opts);
        return {
            blob: new Blob([result.data], { type: target.mime || 'application/octet-stream' }),
            filename: outputName(name, target.ext),
            family: result.family,
            filter: result.filter,
            ms: result.ms,
        };
    }

    async pump() {
        if (this.running) return;
        this.running = true;
        try {
            while (this.queue.length) {
                // Jobs for the document the engine already has open come first: they need no
                // restart (when isolating documents, any other one does).
                const other = (job) => (this.isolateDocuments && job.key === this.document ? 0 : 1);
                this.queue.sort((a, b) => other(a) - other(b) || b.priority - a.priority || a.seq - b.seq);
                const job = this.queue.shift();
                try {
                    job.resolve(await this.runJob(job));
                } catch (e) {
                    if ((e.engineFault || ENGINE_FAULT.test(e.message)) && !job.retried) {
                        // The runtime is in a bad state: start a fresh worker and try once more.
                        console.warn('OfficeEngine: restarting after engine fault:', e.message);
                        this.stop('Engine restarted after a fault.', { fault: true });
                        job.retried = true;
                        this.queue.push(job);
                    } else {
                        if (ENGINE_FAULT.test(e.message)) this.stop(e.message, { fault: true });
                        job.reject(e);
                    }
                }
            }
        } finally {
            this.running = false;
            if (this.state === 'busy') this.setState('ready', READY_TEXT);
        }
    }

    async runJob({ data, name, target, input, quiet, key }) {
        const doc = this.isolateDocuments ? key : SHARED;
        if (this.worker && ((this.document !== undefined && this.document !== doc)
                            || this.network === this.isolateNetwork)) {
            // The engine has opened another document, or the network setting changed.
            this.stop('Restarted for the next document.');
            this.start({ quiet: true });
        }
        await this.start();
        this.document = doc;
        if (!quiet) this.setState('busy', 'Converting…');
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.stop('Conversion timed out.');
                this.setState('error', 'The engine was restarted after a timeout.');
            }, this.timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.worker.postMessage({
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
            }); // the buffer is copied, not transferred, so the job can be retried
        });
    }
}
