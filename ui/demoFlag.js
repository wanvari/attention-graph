// Tells newtab.js and audit.js to skip their live boot paths: the demo drives
// those surfaces itself against a recorded store. A separate file because the
// extension CSP (script-src 'self') forbids inline scripts.
globalThis.__CT_DEMO__ = true;
