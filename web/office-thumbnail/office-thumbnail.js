/* <office-thumbnail>: preview image of an office document, rendered in the
 * browser by LibreOffice (WebAssembly) through an OfficeEngine.
 *
 *   import { OfficeEngine } from 'serverless-office-converter';
 *   import { OfficeThumbnail } from 'serverless-office-thumbnail';
 *   OfficeThumbnail.engine = new OfficeEngine({ base: '/office-converter/' });
 *
 *   <office-thumbnail src="report.docx"></office-thumbnail>
 *   el.file = fileFromInput;               // or set a File/Blob directly
 *
 * Plain images (png, jpg, gif, webp, svg, bmp) are shown directly, without the
 * engine.  Everything else is converted asynchronously, at low priority, so it
 * never delays conversions the page itself requests.
 */

const extensionOf = (name) => {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

const NATIVE_IMAGE_TYPES = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
};
const BACKGROUND_PRIORITY = -10;
// One conversion per file object, however many elements show it.
const renderings = new WeakMap();

const template = document.createElement('template');
template.innerHTML = `
<style>
    :host {
        display: inline-block;
        width: var(--office-thumbnail-width, 64px);
        aspect-ratio: var(--office-thumbnail-aspect, 4 / 5);
        vertical-align: middle;
        contain: content;
    }
    .frame {
        position: relative;
        width: 100%;
        height: 100%;
        overflow: hidden;
        box-sizing: border-box;
        border: 1px solid var(--office-thumbnail-border, #d9dee4);
        border-radius: var(--office-thumbnail-radius, 6px);
        background: var(--office-thumbnail-background, #fff);
    }
    img {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
        object-position: top center;
        opacity: 0;
        transition: opacity .2s;
    }
    :host([state="ready"]) img { opacity: 1; }
    .placeholder {
        position: absolute;
        inset: 0;
        display: grid;
        place-items: center;
        font: 600 .7rem/1 system-ui, sans-serif;
        letter-spacing: .04em;
        text-transform: uppercase;
        color: var(--office-thumbnail-color, #5b6470);
        background: var(--office-thumbnail-placeholder, #eef1f4);
    }
    :host([state="ready"]) .placeholder { display: none; }
    :host([state="waiting"]) .placeholder,
    :host([state="loading"]) .placeholder {
        animation: pulse 1.4s ease-in-out infinite;
    }
    @keyframes pulse { 50% { opacity: .55; } }
    @media (prefers-reduced-motion: reduce) { .placeholder { animation: none !important; } }
</style>
<div class="frame" part="frame">
    <span class="placeholder" part="placeholder"></span>
    <img part="image" alt="" decoding="async">
</div>`;

export class OfficeThumbnail extends HTMLElement {
    /** The OfficeEngine (from serverless-office-converter) used for documents that are not plain images. */
    static engine = null;

    static observedAttributes = ['src', 'name', 'max-size'];

    #file = null;
    #url = null;
    #token = 0;
    #observer = null;
    #visible = false;

    constructor() {
        super();
        this.attachShadow({ mode: 'open' }).append(template.content.cloneNode(true));
        this.setAttribute('state', 'empty');
    }

    /** The document to preview (File or Blob); alternative to the `src` attribute. */
    get file() { return this.#file; }
    set file(value) {
        this.#file = value || null;
        this.#render();
    }

    /** Engine for this element only (defaults to OfficeThumbnail.engine). */
    engine = null;

    /** Maximum input size in bytes that is rendered (attribute: max-size). */
    get maxSize() { return Number(this.getAttribute('max-size')) || 25 * 1024 * 1024; }

    connectedCallback() {
        // Properties set before the element was upgraded (e.g. on a clone of a <template>)
        // are plain own properties that shadow the accessors; re-apply them.
        for (const prop of ['file', 'engine']) {
            if (Object.hasOwn(this, prop)) {
                const value = this[prop];
                delete this[prop];
                this[prop] = value;
            }
        }
        // Render only what is (about to be) on screen.
        this.#observer = new IntersectionObserver((entries) => {
            const visible = entries.some((e) => e.isIntersecting);
            if (visible && !this.#visible) {
                this.#visible = true;
                this.#render();
            }
        }, { rootMargin: '200px' });
        this.#observer.observe(this);
        this.#render();
    }

    disconnectedCallback() {
        this.#observer?.disconnect();
        this.#observer = null;
        this.#visible = false;
        this.#token++;
        this.#revoke();
    }

    attributeChangedCallback(name, oldValue, newValue) {
        if (oldValue !== newValue && this.isConnected) this.#render();
    }

    get #name() {
        return this.getAttribute('name') || this.#file?.name || this.#srcName() || '';
    }

    #srcName() {
        const src = this.getAttribute('src');
        if (!src) return '';
        try {
            return decodeURIComponent(new URL(src, document.baseURI).pathname.split('/').pop());
        } catch {
            return '';
        }
    }

    #setState(state, detail) {
        this.setAttribute('state', state);
        if (state === 'ready') {
            this.dispatchEvent(new CustomEvent('thumbnail-ready', { detail, bubbles: true }));
        } else if (state === 'error') {
            this.title = detail?.message ? 'No preview: ' + detail.message : '';
            this.dispatchEvent(new CustomEvent('thumbnail-error', { detail, bubbles: true }));
        }
    }

    #revoke() {
        if (this.#url) URL.revokeObjectURL(this.#url);
        this.#url = null;
    }

    async #render() {
        const token = ++this.#token;
        this.#revoke();
        const img = this.shadowRoot.querySelector('img');
        img.removeAttribute('src');
        this.title = '';
        const ext = extensionOf(this.#name);
        this.shadowRoot.querySelector('.placeholder').textContent = ext.slice(0, 4);

        const hasSource = this.#file || this.getAttribute('src');
        if (!hasSource) {
            this.#setState('empty');
            return;
        }
        if (!this.#visible) {
            this.#setState('waiting');
            return;
        }
        this.#setState('loading');
        try {
            const blob = await this.#thumbnailBlob(ext);
            if (token !== this.#token) return; // replaced or removed meanwhile
            this.#url = URL.createObjectURL(blob);
            await new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = () => reject(new Error('The preview image could not be displayed.'));
                img.src = this.#url;
            });
            if (token === this.#token) this.#setState('ready', { url: this.#url, blob });
        } catch (error) {
            if (token === this.#token) this.#setState('error', error);
        }
    }

    async #source() {
        if (this.#file) return this.#file;
        const response = await fetch(this.getAttribute('src'));
        if (!response.ok) throw new Error('Could not load the document (' + response.status + ').');
        return response.blob();
    }

    async #thumbnailBlob(ext) {
        const source = await this.#source();
        if (source.size > this.maxSize) throw new Error('The document is too large for a preview.');
        if (ext in NATIVE_IMAGE_TYPES) {
            return source.type ? source : source.slice(0, source.size, NATIVE_IMAGE_TYPES[ext]);
        }
        const engine = this.engine || OfficeThumbnail.engine;
        if (!engine) throw new Error('No OfficeEngine configured (set OfficeThumbnail.engine).');
        // Share one conversion between elements showing the same File/Blob.
        let promise = renderings.get(source);
        if (!promise) {
            promise = this.#convert(engine, source);
            renderings.set(source, promise);
            promise.catch(() => renderings.delete(source));
        }
        return promise;
    }

    async #convert(engine, source) {
        const { blob } = await engine.convertFile(source, 'png', {
            name: this.#name || 'document', priority: BACKGROUND_PRIORITY, quiet: true,
        });
        return blob;
    }
}

if (!customElements.get('office-thumbnail')) {
    customElements.define('office-thumbnail', OfficeThumbnail);
}
