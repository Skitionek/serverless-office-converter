/* Extra --pre-js for soffice.js (passed via EMSCRIPTEN_EXTRA_SOFFICE_PRE_JS).
 *
 * The headless build does not export the Emscripten FS object, but the
 * converter needs it on the main runtime thread to put input documents into,
 * and fetch the converted results out of, the in-memory file system. */
(Module.preRun = Module.preRun || []).push(function () {
    Module.FS = FS;
});
