/* Extra --pre-js for soffice.js (passed via EMSCRIPTEN_EXTRA_SOFFICE_PRE_JS).
 *
 * The headless build does not export the Emscripten FS object; web/engine.js
 * uses the global FS (soffice.js is a classic script).  Also expose it as
 * Module.FS for embedders.  With ASSERTIONS, Module.FS is a configurable
 * accessor that aborts when read, so redefine it instead of assigning. */
(Module.preRun = Module.preRun || []).push(function () {
    Object.defineProperty(Module, 'FS', { value: FS, configurable: true, writable: true });
});
