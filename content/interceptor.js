/**
 * FANOUT_QUERIES — page-world interceptor (MAIN world, document_start).
 *
 * Observes fetch / XMLHttpRequest / WebSocket traffic and forwards interesting
 * payloads to the isolated-world relay via CustomEvent.
 *
 * PRIME DIRECTIVE: never alter page behavior. Every observation path is
 * wrapped in try/catch, reads only from `response.clone()`, never touches the
 * original body, and returns the page's original values untouched. If anything
 * here throws, the page must still work.
 *
 * This file cannot be an ES module (content scripts aren't), so it is a
 * self-contained IIFE with no imports.
 */
(() => {
  'use strict';

  const FLAG = '__fq_interceptor_installed__';
  if (window[FLAG]) return;
  Object.defineProperty(window, FLAG, { value: true, enumerable: false });

  const CAPTURE_EVENT = '__fq_capture';
  const CONFIG_EVENT = '__fq_config';

  /** Hard cap on bytes read per response, so a huge download can't balloon memory. */
  const MAX_BODY_BYTES = 10 * 1024 * 1024;
  /** Request bodies are small (prompts); cap defensively anyway. */
  const MAX_REQ_BYTES = 512 * 1024;

  // Stash originals immediately — page code may patch these later.
  const origFetch = window.fetch;
  const OrigXHR = window.XMLHttpRequest;
  const OrigWebSocket = window.WebSocket;
  const xhrOpen = OrigXHR && OrigXHR.prototype.open;
  const xhrSend = OrigXHR && OrigXHR.prototype.send;

  /**
   * URL substrings worth capturing when the response isn't SSE.
   * Broad built-in defaults so capture works before remote rules arrive;
   * the relay pushes the rules-driven list in via CONFIG_EVENT.
   */
  let urlPatterns = [
    '/backend-api/conversation',
    '/backend-api/f/conversation',
    '/api/organizations/',
    '/completion',
    '/rest/sse/',
    'perplexity_ask',
    'batchexecute',
    'udm=50',
    '/async/',
    '/search?',
  ];

  document.addEventListener(CONFIG_EVENT, (event) => {
    try {
      const config = JSON.parse(event.detail);
      if (Array.isArray(config.urlPatterns) && config.urlPatterns.length) {
        // Union with defaults: a bad rules push must never blind the interceptor.
        urlPatterns = Array.from(new Set([...urlPatterns, ...config.urlPatterns]));
      }
    } catch (_) {
      /* ignore malformed config */
    }
  });

  let captureSeq = 0;
  const nextId = () => `c${Date.now().toString(36)}${(captureSeq++).toString(36)}`;

  /** Emit one capture envelope to the isolated world. */
  function emit(payload) {
    try {
      document.dispatchEvent(
        new CustomEvent(CAPTURE_EVENT, { detail: JSON.stringify(payload) }),
      );
    } catch (_) {
      /* never let emission break the page */
    }
  }

  function matchesPattern(url) {
    if (typeof url !== 'string') return false;
    for (const pattern of urlPatterns) {
      if (url.indexOf(pattern) !== -1) return true;
    }
    return false;
  }

  /** SSE is the main fan-out transport, so capture it regardless of URL. */
  function isStreamingContentType(contentType) {
    return typeof contentType === 'string' && contentType.indexOf('text/event-stream') !== -1;
  }

  function isTextualContentType(contentType) {
    return (
      contentType.indexOf('json') !== -1 ||
      contentType.indexOf('text/') !== -1 ||
      contentType.indexOf('javascript') !== -1
    );
  }

  function shouldCapture(url, contentType) {
    if (isStreamingContentType(contentType)) return true;
    if (!matchesPattern(url)) return false;
    // Matched URL: take it if it looks textual (or the type is unknown).
    return !contentType || isTextualContentType(contentType);
  }

  function absolute(url) {
    try {
      return new URL(url, location.href).href;
    } catch (_) {
      return String(url);
    }
  }

  // ---------------------------------------------------------------- fetch ---

  /**
   * Pull method/url/body out of fetch's polymorphic arguments.
   * A Request body must be cloned synchronously, before fetch consumes it.
   */
  function describeRequest(input, init) {
    let url = '';
    let method = 'GET';
    let bodyPromise = null;

    try {
      if (typeof input === 'string' || input instanceof URL) {
        url = String(input);
        method = (init && init.method) || 'GET';
        const body = init && init.body;
        if (typeof body === 'string') {
          bodyPromise = Promise.resolve(body);
        } else if (body instanceof URLSearchParams) {
          bodyPromise = Promise.resolve(body.toString());
        } else if (body) {
          // FormData / Blob / ArrayBuffer / TypedArray — Response normalizes them.
          try {
            bodyPromise = new Response(body).text();
          } catch (_) {
            bodyPromise = null;
          }
        }
      } else if (input && typeof input === 'object' && typeof input.url === 'string') {
        url = input.url;
        method = input.method || 'GET';
        try {
          bodyPromise = input.clone().text();
        } catch (_) {
          bodyPromise = null;
        }
      }
    } catch (_) {
      /* fall through with whatever we managed to read */
    }

    return { url: absolute(url), method, bodyPromise };
  }

  /** Drain a cloned ReadableStream, emitting text chunks as they arrive. */
  async function drainStream(stream, base) {
    let reader;
    try {
      reader = stream.getReader();
    } catch (_) {
      return;
    }
    const decoder = new TextDecoder('utf-8');
    let total = 0;
    let seq = 0;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > MAX_BODY_BYTES) {
          try {
            await reader.cancel();
          } catch (_) {
            /* ignore */
          }
          break;
        }
        const text = decoder.decode(value, { stream: true });
        if (text) emit({ ...base, phase: 'chunk', seq: seq++, body: text });
      }
      const tail = decoder.decode();
      if (tail) emit({ ...base, phase: 'chunk', seq: seq++, body: tail });
    } catch (_) {
      /* stream aborted — nothing to do */
    }
    emit({ ...base, phase: 'end', seq });
  }

  window.fetch = function fetch(input, init) {
    const info = describeRequest(input, init);
    const promise = origFetch.apply(this, arguments);

    try {
      promise
        .then((response) => {
          try {
            if (!response) return;
            const contentType = response.headers && response.headers.get('content-type');
            if (!shouldCapture(info.url, contentType)) return;

            const id = nextId();
            const base = {
              id,
              url: info.url,
              method: info.method,
              transport: 'fetch',
              contentType: contentType || null,
              ts: Date.now(),
            };

            // Request body first — prompts usually live there.
            if (info.bodyPromise) {
              info.bodyPromise
                .then((text) => {
                  if (text) {
                    emit({ ...base, phase: 'request', body: String(text).slice(0, MAX_REQ_BYTES) });
                  }
                })
                .catch(() => {});
            }

            let clone;
            try {
              clone = response.clone();
            } catch (_) {
              return; // opaque or already-disturbed response
            }

            if (clone.body) {
              drainStream(clone.body, base);
            } else {
              clone
                .text()
                .then((text) => {
                  if (text) emit({ ...base, phase: 'chunk', seq: 0, body: text.slice(0, MAX_BODY_BYTES) });
                  emit({ ...base, phase: 'end', seq: 1 });
                })
                .catch(() => {});
            }
          } catch (_) {
            /* observation failure must not surface to the page */
          }
        })
        .catch(() => {}); // the page owns the real rejection; swallow ours
    } catch (_) {
      /* ignore */
    }

    return promise;
  };

  // ------------------------------------------------------------------ XHR ---
  // Google and Gemini stream batched RPC payloads over chunked XHR, so read
  // incrementally from progress events rather than waiting for load.

  if (xhrOpen && xhrSend) {
    OrigXHR.prototype.open = function open(method, url) {
      try {
        this.__fq = { method: String(method || 'GET'), url: absolute(url), id: nextId() };
      } catch (_) {
        /* ignore */
      }
      return xhrOpen.apply(this, arguments);
    };

    OrigXHR.prototype.send = function send(body) {
      try {
        const meta = this.__fq;
        if (meta) {
          meta.offset = 0;
          meta.seq = 0;
          meta.emitted = false;

          const base = () => ({
            id: meta.id,
            url: meta.url,
            method: meta.method,
            transport: 'xhr',
            contentType: meta.contentType || null,
            ts: Date.now(),
          });

          const ready = () => {
            if (meta.emitted) return true;
            let contentType = null;
            try {
              contentType = this.getResponseHeader('content-type');
            } catch (_) {
              /* headers unavailable */
            }
            meta.contentType = contentType;
            if (!shouldCapture(meta.url, contentType)) {
              meta.skip = true;
              return false;
            }
            meta.emitted = true;
            if (body) {
              let text = null;
              if (typeof body === 'string') text = body;
              else if (body instanceof URLSearchParams) text = body.toString();
              if (text) {
                emit({ ...base(), phase: 'request', body: text.slice(0, MAX_REQ_BYTES) });
              }
            }
            return true;
          };

          const pump = () => {
            try {
              if (meta.skip) return;
              // responseText throws for non-text responseTypes; that's a skip.
              let text;
              try {
                text = this.responseText;
              } catch (_) {
                meta.skip = true;
                return;
              }
              if (typeof text !== 'string') return;
              if (!ready()) return;
              if (text.length <= meta.offset) return;
              if (meta.offset > MAX_BODY_BYTES) return;
              const slice = text.slice(meta.offset);
              meta.offset = text.length;
              emit({ ...base(), phase: 'chunk', seq: meta.seq++, body: slice });
            } catch (_) {
              /* ignore */
            }
          };

          this.addEventListener('progress', pump);
          this.addEventListener('load', () => {
            pump();
            if (meta.emitted) emit({ ...base(), phase: 'end', seq: meta.seq });
          });
          this.addEventListener('error', () => {
            if (meta.emitted) emit({ ...base(), phase: 'end', seq: meta.seq });
          });
        }
      } catch (_) {
        /* ignore */
      }
      return xhrSend.apply(this, arguments);
    };
  }

  // ------------------------------------------------------------ WebSocket ---
  // Perplexity carries both the prompt (send) and results (message) over WS.

  if (OrigWebSocket) {
    const wsSend = OrigWebSocket.prototype.send;

    function PatchedWebSocket(url, protocols) {
      const socket =
        protocols === undefined
          ? new OrigWebSocket(url)
          : new OrigWebSocket(url, protocols);
      try {
        const meta = { id: nextId(), url: absolute(url), seq: 0 };
        socket.__fq = meta;
        socket.addEventListener('message', (event) => {
          try {
            if (typeof event.data !== 'string') return;
            if (event.data.length > MAX_BODY_BYTES) return;
            emit({
              id: meta.id,
              url: meta.url,
              method: 'WS',
              transport: 'ws',
              contentType: null,
              phase: 'chunk',
              seq: meta.seq++,
              body: event.data,
              ts: Date.now(),
            });
          } catch (_) {
            /* ignore */
          }
        });
      } catch (_) {
        /* ignore */
      }
      return socket;
    }

    PatchedWebSocket.prototype = OrigWebSocket.prototype;
    PatchedWebSocket.CONNECTING = OrigWebSocket.CONNECTING;
    PatchedWebSocket.OPEN = OrigWebSocket.OPEN;
    PatchedWebSocket.CLOSING = OrigWebSocket.CLOSING;
    PatchedWebSocket.CLOSED = OrigWebSocket.CLOSED;

    try {
      window.WebSocket = PatchedWebSocket;
    } catch (_) {
      /* ignore */
    }

    if (wsSend) {
      OrigWebSocket.prototype.send = function send(data) {
        try {
          const meta = this.__fq;
          if (meta && typeof data === 'string' && data.length <= MAX_REQ_BYTES) {
            emit({
              id: meta.id,
              url: meta.url,
              method: 'WS',
              transport: 'ws',
              contentType: null,
              phase: 'request',
              body: data,
              ts: Date.now(),
            });
          }
        } catch (_) {
          /* ignore */
        }
        return wsSend.apply(this, arguments);
      };
    }
  }
})();
