/* Client for the in-browser LibreOffice engine.
 *
 * LibreOffice (WebAssembly) runs in a hidden same-origin iframe, `engine.html`
 * under `base`, which has to be cross-origin isolated (see README).  Jobs are
 * run one at a time, most important first, so background work such as
 * thumbnails never delays a conversion the user asked for.
 */

const READY_TEXT = 'Ready. Everything stays on this device.';

export class OfficeEngine extends EventTarget {
    /**
     * @param {object} [options]
     * @param {string|URL} [options.base] Directory that serves engine.html (default: the page's base URL).
     * @param {number} [options.timeoutMs] Abort and restart the engine when one job takes longer.
     */
    constructor({ base = document.baseURI, timeoutMs = 5 * 60 * 1000 } = {}) {
        super();
        this.engineUrl = new URL('engine.html', base).href;
        this.origin = new URL(this.engineUrl).origin;
        this.timeoutMs = timeoutMs;
        this.state = 'idle';
        this.frame = null;
        this.ready = null;
        this.pending = new Map(); // running jobs by id
        this.queue = [];
        this.running = false;
        this.nextId = 1;
        this.seq = 0;
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
        frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
        frame.src = this.engineUrl;
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
        if (event.origin !== this.origin || !this.frame || event.source !== this.frame.contentWindow) {
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
            this.setState('ready', READY_TEXT, 'Started in ' + secs + ' s.');
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
            this.stop(msg.message);
            this.setState('error', 'The engine stopped.', msg.message);
            break;
        }
    }

    /**
     * Converts a document.
     * @param {ArrayBuffer} data Input bytes (transferred, so pass a copy you don't need).
     * @param {string} name Input file name (its extension helps format detection).
     * @param {object} target `{ ext, label, filters, filterOptions?, filterData? }`, see formats.js.
     * @param {{filter?: string, options?: string}} [input] Forced import filter.
     * @param {{priority?: number, quiet?: boolean}} [opts] Higher priority runs first;
     *   quiet jobs do not change the engine's 'busy' state (use for background work).
     * @returns {Promise<{data: ArrayBuffer, family: string, filter: string, ms: number}>}
     */
    convert(data, name, target, input, { priority = 0, quiet = false } = {}) {
        return new Promise((resolve, reject) => {
            this.queue.push({ data, name, target, input, quiet, priority, seq: this.seq++, resolve, reject });
            this.pump();
        });
    }

    async pump() {
        if (this.running) return;
        this.running = true;
        try {
            while (this.queue.length) {
                this.queue.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
                const job = this.queue.shift();
                try {
                    job.resolve(await this.runJob(job));
                } catch (e) {
                    job.reject(e);
                }
            }
        } finally {
            this.running = false;
            if (this.state === 'busy') this.setState('ready', READY_TEXT);
        }
    }

    async runJob({ data, name, target, input, quiet }) {
        await this.start();
        if (!quiet) this.setState('busy', 'Converting…');
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.stop('Conversion timed out.');
                this.setState('error', 'The engine was restarted after a timeout.');
            }, this.timeoutMs);
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
            }, this.origin, [data]);
        });
    }
}
