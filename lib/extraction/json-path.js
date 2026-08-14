/**
 * FANOUT_QUERIES — JSONPath-lite.
 *
 * A deliberately tiny path evaluator, sized for the extraction rules and
 * nothing more. Supported syntax:
 *
 *   $                 root of the response payload
 *   $req              root of the request payload
 *   .key / ['key']    property access
 *   [0]               array index
 *   [*]               all elements of an array (or all values of an object)
 *   ..                recursive descent
 *   [?key]            keep only the current nodes that are objects owning `key`
 *
 * `[?key]` filters the current node set rather than descending on its own, so
 * it composes predictably: `$..[?input]` matches each owner of `input` exactly
 * once, and `$.content[*][?input]` filters that array's elements.
 *
 * Deep scan (`..`) is the drift-resistance workhorse: when a site renests its
 * payload, `$..search_queries[*].q` keeps working where a literal path breaks.
 */

/**
 * Split a path string into tokens.
 * @param {string} path
 * @returns {Array<{type: string, value?: string|number}>}
 */
function tokenize(path) {
  const tokens = [];
  let i = 0;

  // Leading root marker.
  if (path.startsWith('$req')) {
    tokens.push({ type: 'root', value: 'request' });
    i = 4;
  } else if (path.startsWith('$')) {
    tokens.push({ type: 'root', value: 'response' });
    i = 1;
  } else {
    tokens.push({ type: 'root', value: 'response' });
  }

  while (i < path.length) {
    const char = path[i];

    if (char === '.') {
      if (path[i + 1] === '.') {
        tokens.push({ type: 'descend' });
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (char === '[') {
      const close = path.indexOf(']', i);
      if (close === -1) break;
      const inner = path.slice(i + 1, close);
      i = close + 1;

      if (inner === '*') {
        tokens.push({ type: 'wildcard' });
      } else if (inner.startsWith('?')) {
        tokens.push({ type: 'hasKey', value: inner.slice(1).trim() });
      } else if (/^-?\d+$/.test(inner)) {
        tokens.push({ type: 'index', value: Number(inner) });
      } else {
        tokens.push({ type: 'key', value: inner.replace(/^['"]|['"]$/g, '') });
      }
      continue;
    }

    // Bare property name up to the next delimiter.
    let end = i;
    while (end < path.length && path[end] !== '.' && path[end] !== '[') end += 1;
    const name = path.slice(i, end);
    if (name) tokens.push({ type: 'key', value: name });
    i = end;
  }

  return tokens;
}

/** Collect a node and every node beneath it. */
function collectDescendants(node, out, depth) {
  if (depth > 40 || node === null || typeof node !== 'object') return;
  out.push(node);
  if (Array.isArray(node)) {
    for (const child of node) collectDescendants(child, out, depth + 1);
  } else {
    for (const key of Object.keys(node)) collectDescendants(node[key], out, depth + 1);
  }
}

/**
 * Evaluate a path against a payload.
 * @param {string} path
 * @param {{response?: unknown, request?: unknown}} roots
 * @returns {unknown[]} every matching value (empty when nothing matches)
 */
export function query(path, roots) {
  if (typeof path !== 'string' || !path) return [];

  const tokens = tokenize(path);
  if (!tokens.length) return [];

  let current;
  const rootToken = tokens[0];
  if (rootToken.type === 'root') {
    current = rootToken.value === 'request' ? roots.request : roots.response;
  } else {
    current = roots.response;
  }
  if (current === undefined) return [];

  let nodes = [current];

  for (let t = 1; t < tokens.length; t += 1) {
    const token = tokens[t];
    const next = [];

    for (const node of nodes) {
      if (node === null || node === undefined) continue;

      switch (token.type) {
        case 'key': {
          // A key directly after `..` should match at any depth; tokenize emits
          // `descend` then `key`, and `descend` already expanded the node set.
          if (typeof node === 'object' && token.value in node) {
            next.push(node[token.value]);
          }
          break;
        }
        case 'index': {
          if (Array.isArray(node)) {
            const idx = token.value < 0 ? node.length + token.value : token.value;
            if (idx >= 0 && idx < node.length) next.push(node[idx]);
          }
          break;
        }
        case 'wildcard': {
          if (Array.isArray(node)) {
            next.push(...node);
          } else if (typeof node === 'object') {
            next.push(...Object.values(node));
          }
          break;
        }
        case 'descend': {
          collectDescendants(node, next, 0);
          break;
        }
        case 'hasKey': {
          if (typeof node === 'object' && !Array.isArray(node) && token.value in node) {
            next.push(node);
          }
          break;
        }
        default:
          break;
      }
    }

    nodes = next;
    if (!nodes.length) return [];
  }

  return nodes.filter((node) => node !== undefined);
}

/**
 * Evaluate several paths in order, returning the first non-empty result.
 * @param {string[]} paths
 * @param {{response?: unknown, request?: unknown}} roots
 * @returns {unknown[]}
 */
export function queryFirst(paths, roots) {
  if (!Array.isArray(paths)) return [];
  for (const path of paths) {
    const found = query(path, roots);
    if (found.length) return found;
  }
  return [];
}

/**
 * Evaluate several paths and concatenate every match.
 * @param {string[]} paths
 * @param {{response?: unknown, request?: unknown}} roots
 * @returns {unknown[]}
 */
export function queryAll(paths, roots) {
  if (!Array.isArray(paths)) return [];
  const out = [];
  for (const path of paths) out.push(...query(path, roots));
  return out;
}
