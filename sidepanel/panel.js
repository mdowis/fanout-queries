/**
 * FANOUT_QUERIES — side panel controller.
 *
 * Connects to the service worker over a long-lived port, renders the live
 * session for the active tab, browses the archive, and drives exports.
 *
 * Everything captured is untrusted page content, so all of it is rendered with
 * textContent and href assignment guarded by an http(s) check. No innerHTML is
 * used with captured data anywhere in this file.
 */

import { toJson, toCsv, exportFilename } from '../lib/export.js';
import { STRATEGY_BADGE } from '../lib/types.js';

const port = chrome.runtime.connect({ name: 'sidepanel' });

/** @type {{sites: Array<{siteId: string, label: string}>, index: Array<object>, session: object|null, rules: object|null, health: object|null}} */
let state = { sites: [], index: [], session: null, rules: null, health: null };

/** Sessions expanded in the archive, and their loaded contents. */
const expanded = new Map();

let activeTabId = null;

// ------------------------------------------------------------ DOM helpers ---

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/** Only ever link to real web URLs — captured hrefs are untrusted input. */
function safeHref(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}

function relativeTime(ts) {
  if (!ts) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function shortDate(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  return `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${String(
    date.getHours(),
  ).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// --------------------------------------------------------------- rendering ---

/** Site status LEDs. Health data arrives in a later phase; until then, standby. */
function renderHealth() {
  const strip = $('health-strip');
  strip.replaceChildren();

  for (const site of state.sites) {
    const health = state.health && state.health.sites ? state.health.sites[site.siteId] : null;
    const status = (health && health.status) || 'idle';
    const activeStrategy = health && health.activeOrder ? health.activeOrder[0] : null;

    const row = el('li', 'health-row');
    row.append(el('span', `led ${status}`), el('span', 'health-site', site.label));

    const meta =
      status === 'idle'
        ? 'STANDBY'
        : `${(activeStrategy || '').toUpperCase()} · ${relativeTime(health && health.lastCaptureAt)}`;
    row.append(el('span', 'health-meta', meta));

    row.addEventListener('click', () => toggleHealthDetail(site, health));
    strip.append(row);
  }
}

function toggleHealthDetail(site, health) {
  const panel = $('health-detail');
  if (!panel.hidden && panel.dataset.siteId === site.siteId) {
    panel.hidden = true;
    return;
  }

  panel.dataset.siteId = site.siteId;
  panel.replaceChildren();

  if (!health) {
    panel.append(el('p', null, `No captures yet for ${site.label}.`));
  } else {
    const table = el('table');
    const header = el('tr');
    for (const label of ['STRATEGY', 'LAST OK', 'HITS', 'MISSES']) header.append(el('th', null, label));
    table.append(header);

    for (const [name, strategy] of Object.entries(health.strategies || {})) {
      const row = el('tr');
      const nameCell = el('td', null, name);
      if (health.activeOrder && health.activeOrder[0] === name) nameCell.className = 'active-strategy';
      row.append(
        nameCell,
        el('td', null, relativeTime(strategy.lastSuccess)),
        el('td', null, strategy.successCount),
        el('td', null, strategy.missStreak),
      );
      table.append(row);
    }
    panel.append(table);
  }

  if (state.rules) {
    const rulesLine = el(
      'p',
      null,
      `Rules v${state.rules.version} (${state.rules.source})` +
        (state.rules.lastError ? ` · last error: ${state.rules.lastError}` : ''),
    );
    panel.append(rulesLine);
  }

  const refetch = el('button', 'ghost-btn', 'REFETCH RULES');
  refetch.addEventListener('click', () => {
    refetch.textContent = 'FETCHING…';
    port.postMessage({ type: 'refetch-rules', tabId: activeTabId });
  });
  panel.append(refetch);

  panel.hidden = false;
}

/**
 * Render one turn: prompt, query chips, and sources grouped by attribution.
 * @param {object} turn
 * @returns {HTMLElement}
 */
function renderTurn(turn) {
  const node = el('div', 'turn');

  if (turn.prompt) node.append(el('p', 'turn-prompt', turn.prompt));

  if (turn.queries.length) {
    const chips = el('div', 'query-chips');
    for (const query of turn.queries) {
      const chip = el('span', 'query-chip');
      const badge = el('span', `strategy-badge ${(STRATEGY_BADGE[query.strategy] || '?').toLowerCase()}`);
      badge.textContent = STRATEGY_BADGE[query.strategy] || '?';
      chip.append(badge, document.createTextNode(query.text));
      chips.append(chip);
    }
    node.append(chips);
  }

  // Group sources under the query that found them; anything unattributed goes
  // in a trailing bucket rather than being dropped.
  const grouped = new Map();
  const ungrouped = [];
  for (const source of turn.sources || []) {
    if (source.queryText) {
      if (!grouped.has(source.queryText)) grouped.set(source.queryText, []);
      grouped.get(source.queryText).push(source);
    } else {
      ungrouped.push(source);
    }
  }

  for (const [queryText, sources] of grouped) {
    const group = el('div', 'source-group');
    group.append(el('p', 'source-group-label', `↳ ${queryText}`));
    for (const source of sources) group.append(renderSource(source));
    node.append(group);
  }

  if (ungrouped.length) {
    const group = el('div', 'source-group');
    if (grouped.size) group.append(el('p', 'source-group-label', '↳ other sources'));
    for (const source of ungrouped) group.append(renderSource(source));
    node.append(group);
  }

  if (!turn.queries.length && !(turn.sources || []).length) {
    node.append(el('p', 'source-group-label', 'no fan-out detected for this turn'));
  }

  return node;
}

function renderSource(source) {
  const row = el('div', 'source-row');
  row.append(el('span', 'src-domain', domainOf(source.url)));

  const href = safeHref(source.url);
  if (href) {
    const link = el('a', null, source.title || source.url);
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.title = source.snippet || source.url;
    row.append(link);
  } else {
    row.append(el('span', null, source.title || ''));
  }

  return row;
}

function renderSession(session, container) {
  container.replaceChildren();
  for (const turn of session.turns || []) container.append(renderTurn(turn));
}

function renderLive() {
  const empty = $('live-empty');
  const view = $('live-session');

  if (!state.session || !(state.session.turns || []).length) {
    empty.hidden = false;
    view.hidden = true;
    return;
  }

  empty.hidden = true;
  view.hidden = false;
  renderSession(state.session, view);
}

function pulseLive() {
  const panel = $('live-panel');
  panel.classList.remove('pulse');
  // Force a reflow so the animation restarts on consecutive captures.
  void panel.offsetWidth;
  panel.classList.add('pulse');
}

function renderHistory() {
  const list = $('history-list');
  const empty = $('history-empty');
  list.replaceChildren();

  if (!state.index.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  const labels = new Map(state.sites.map((site) => [site.siteId, site.label]));

  for (const entry of state.index) {
    const item = el('li', 'history-item');

    const head = el('div', 'history-head');
    head.append(
      el('span', 'history-site-tag', labels.get(entry.siteId) || entry.siteId),
      el('span', 'history-prompt', entry.firstPrompt || `${entry.queryCount} queries`),
      el('span', 'history-date', shortDate(entry.updatedAt)),
    );

    const del = el('button', 'history-del', '✕');
    del.title = 'Delete this session';
    del.addEventListener('click', (event) => {
      event.stopPropagation();
      expanded.delete(entry.id);
      port.postMessage({ type: 'delete-session', sessionId: entry.id, tabId: activeTabId });
    });
    head.append(del);

    const body = el('div', 'history-body');
    body.hidden = !expanded.has(entry.id);
    if (expanded.has(entry.id)) {
      const session = expanded.get(entry.id);
      if (session) renderSession(session, body);
      else body.append(el('p', 'source-group-label', 'loading…'));
    }

    head.addEventListener('click', () => {
      if (expanded.has(entry.id)) {
        expanded.delete(entry.id);
        renderHistory();
        return;
      }
      expanded.set(entry.id, null);
      port.postMessage({ type: 'get-session', sessionId: entry.id });
      renderHistory();
    });

    item.append(head, body);
    list.append(item);
  }
}

function renderRulesBadge() {
  const badge = $('rules-badge');
  if (!state.rules) {
    badge.textContent = 'RULES v—';
    return;
  }
  badge.textContent = `RULES v${state.rules.version} ${state.rules.source === 'remote' ? '⇅' : '·'}`;
  badge.title =
    `Extraction rules version ${state.rules.version} (${state.rules.source})` +
    (state.rules.fetchedAt ? `\nFetched ${relativeTime(state.rules.fetchedAt)}` : '') +
    (state.rules.lastError ? `\nLast error: ${state.rules.lastError}` : '');
  badge.classList.toggle('stale', Boolean(state.rules.lastError));
}

function renderAll() {
  renderHealth();
  renderLive();
  renderHistory();
  renderRulesBadge();
}

// ----------------------------------------------------------------- exports ---

async function collectExportSessions(scope) {
  if (scope === 'live') return state.session ? [state.session] : [];

  // Full archive: request each session the index knows about.
  const ids = state.index.map((entry) => entry.id);
  const sessions = await Promise.all(ids.map((id) => requestSession(id)));
  return sessions.filter(Boolean);
}

const pendingSessionRequests = new Map();

function requestSession(sessionId) {
  return new Promise((resolve) => {
    const waiting = pendingSessionRequests.get(sessionId) || [];
    waiting.push(resolve);
    pendingSessionRequests.set(sessionId, waiting);
    port.postMessage({ type: 'get-session', sessionId });
  });
}

function resolveSessionRequest(sessionId, session) {
  const waiting = pendingSessionRequests.get(sessionId);
  if (!waiting) return;
  pendingSessionRequests.delete(sessionId);
  for (const resolve of waiting) resolve(session);
}

async function runExport(format) {
  const scope = $('export-scope').value;
  const sessions = await collectExportSessions(scope);

  if (!sessions.length) {
    flashButton(format === 'json' ? $('export-json') : $('export-csv'), 'NO DATA');
    return;
  }

  const text =
    format === 'json'
      ? toJson(sessions, {
          extensionVersion: chrome.runtime.getManifest().version,
          rulesVersion: state.rules ? state.rules.version : null,
        })
      : toCsv(sessions);

  const blob = new Blob([text], {
    type: format === 'json' ? 'application/json' : 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);

  chrome.downloads.download(
    { url, filename: exportFilename(format), saveAs: true },
    () => {
      void chrome.runtime.lastError; // a cancelled save dialog is not an error
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
  );
}

function flashButton(button, message) {
  const original = button.textContent;
  button.textContent = message;
  setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

// ------------------------------------------------------------------ wiring ---

port.onMessage.addListener((message) => {
  if (!message || typeof message !== 'object') return;

  switch (message.type) {
    case 'state':
      state = { ...state, ...message };
      renderAll();
      break;

    case 'session-update':
      // Only the active tab's session drives the live view.
      if (message.tabId === activeTabId) {
        state.session = message.session;
        renderLive();
        pulseLive();
      }
      // A newer session may need to move up the archive list.
      port.postMessage({ type: 'get-state', tabId: activeTabId });
      break;

    case 'session-detail': {
      const session = message.session;
      if (session) {
        if (expanded.has(session.id)) {
          expanded.set(session.id, session);
          renderHistory();
        }
        resolveSessionRequest(session.id, session);
      }
      break;
    }

    case 'health-update':
      state.health = message.health;
      renderHealth();
      break;

    case 'rules-status':
      if (message.outcome && message.outcome.updated) flashButton($('rules-badge'), 'RULES UPDATED');
      break;

    default:
      break;
  }
});

async function bindActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = tab ? tab.id : null;
  } catch (_) {
    activeTabId = null;
  }
  port.postMessage({ type: 'get-state', tabId: activeTabId });
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  activeTabId = tabId;
  state.session = null;
  renderLive();
  port.postMessage({ type: 'get-state', tabId });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === activeTabId && changeInfo.status === 'complete') {
    port.postMessage({ type: 'get-state', tabId });
  }
});

$('export-json').addEventListener('click', () => runExport('json'));
$('export-csv').addEventListener('click', () => runExport('csv'));

$('clear-history').addEventListener('click', () => {
  const button = $('clear-history');
  if (button.dataset.armed !== 'true') {
    button.dataset.armed = 'true';
    button.textContent = 'CONFIRM?';
    setTimeout(() => {
      button.dataset.armed = 'false';
      button.textContent = 'PURGE';
    }, 3000);
    return;
  }
  button.dataset.armed = 'false';
  button.textContent = 'PURGE';
  expanded.clear();
  port.postMessage({ type: 'clear-sessions', tabId: activeTabId });
});

renderAll();
bindActiveTab();
