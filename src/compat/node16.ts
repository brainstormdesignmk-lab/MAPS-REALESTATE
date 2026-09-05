// Node 16 compatibility bootstrap.
//
// The ATOM cluster runs Node 16 (max), while this codebase was written against
// Node 18+, where `fetch`, `Headers`, `Request`, `Response`, `FormData` and the
// Web Streams globals are built in. On Node 16 they are absent (verified:
// fetch/ReadableStream/FormData are all undefined on 16.20). This module
// installs the undici implementations into globalThis so the same code runs on
// both.
//
// Import this FIRST in every entry point (src/index.ts, src/tui/run.ts,
// boot_check, scripts/*) — it is a no-op on Node 18+.
//
// groq-sdk's own shim (internal/shims.js) requires exactly this: a global
// `fetch` (and, when streaming, a global `ReadableStream`), and documents
// polyfilling globalThis as the supported path.

import * as undici from 'undici';

// node:stream/web exists on Node 16.5+ and is the same Web Streams
// implementation Node 18 exposes globally. Best-effort: if it is unavailable
// for any reason, streaming-only paths fail loudly later, everything else works.
let streamWeb: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  streamWeb = require('node:stream/web');
} catch {
  streamWeb = null;
}

// Guarded: on Node 18+ these exist natively — leave them alone so native
// behavior (and Node's own keep-alive agent) is preserved.
if (typeof (globalThis as any).fetch !== 'function') {
  const g = globalThis as any;
  g.fetch = (undici as any).fetch;
  g.Headers = (undici as any).Headers;
  g.Request = (undici as any).Request;
  g.Response = (undici as any).Response;
  g.FormData = (undici as any).FormData;
  g.File = g.File ?? (undici as any).File;
  if (streamWeb) {
    g.ReadableStream = g.ReadableStream ?? streamWeb.ReadableStream;
    g.WritableStream = g.WritableStream ?? streamWeb.WritableStream;
    g.TransformStream = g.TransformStream ?? streamWeb.TransformStream;
  }
}

export {};