/* Takes away what a compromised engine could misuse.
 *
 * LibreOffice parses untrusted documents.  Should a crafted file corrupt the WebAssembly
 * memory and take over the engine, its code can call into JavaScript (Embind's emval) with
 * the page's origin.  The service worker gives the engine's workers a Content Security
 * Policy that allows no network except the engine's own files (see service-worker.js);
 * this script removes, from a worker's global scope, the APIs that policy cannot cover:
 * the origin's storage (IndexedDB holds the folder handles of "save into a folder", Cache
 * Storage the engine itself), messaging to other pages, and, once the engine is running,
 * the network APIs too.
 *
 * Classic script: importScripts() it in a worker, then call lockDownEngineWorker().
 */
'use strict';

self.lockDownEngineWorker = function lockDownEngineWorker({ network = true, scripts = false } = {}) {
    const remove = (object, names) => {
        for (const name of names) {
            if (!object || !(name in object)) continue;
            try {
                // Interface members of a worker's global object are configurable own
                // properties; navigator's are getters on its prototype.
                let owner = object;
                while (owner && !Object.prototype.hasOwnProperty.call(owner, name)) {
                    owner = Object.getPrototypeOf(owner);
                }
                if (owner) delete owner[name];
            } catch (e) {
                // Leave it; the Content Security Policy still applies.
            }
        }
    };
    // Storage and other same-origin pages: never needed by the engine.
    remove(self, ['indexedDB', 'caches', 'BroadcastChannel', 'SharedWorker', 'Notification',
                  'cookieStore']);
    remove(self.navigator, ['storage', 'serviceWorker', 'locks', 'storageBuckets']);
    if (network) {
        remove(self, ['fetch', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream',
                      'WebTransport', 'EventSource']);
    }
    if (scripts) remove(self, ['importScripts']);
};
