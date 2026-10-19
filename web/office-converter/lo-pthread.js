/* Script of LibreOffice's own threads (Emscripten pthreads, started by soffice.js in
 * engine-worker.js).  They only ever compute: no network, no storage (see lockdown.js). */
'use strict';
importScripts('lockdown.js');
self.lockDownEngineWorker();
importScripts('lo/soffice.js');
