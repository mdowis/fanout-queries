/**
 * FANOUT_QUERIES — service worker.
 *
 * The hub: rules in, page traffic through the extraction engine, sessions out
 * to storage and to the side panel.
 *
 * MV3 evicts this worker aggressively, so nothing authoritative lives in
 * memory. Per-request decode state is inherently ephemeral (a stream in flight
 * cannot survive eviction anyway), but every extracted result is written
 * through to storage immediately, so an eviction costs at most the tail of one
 * in-flight response.
 */

import { resolveRules, refetchRules, collectUrlPatterns, siteForHostname, readMeta } from '../lib/rules-manager.js';
import {
  CaptureContext,
  ingestRequest,
  ingestChunk,
  finishCapture,
  matchesEndpoint,
  normalizeDomCapture,
} from '../lib/extraction/engine.js';
import { createSession, mergeResult, inferAttribution } from '../lib/sessions.js';
import {
  readSession,
  writeSession,
  readIndex,
  deleteSession,
  clearSessions,
  readHealth,
  writeHealth,
} from '../lib/store.js';
import {
  siteHealth,
  recordTurn,
  recordSuccess,
  expireOpenTurn,
  shouldEscalate,
  resetForNewRules,
} from '../lib/health.js';
import { strategyOrderFor } from '../lib/extraction/registry.js';

const RULES_ALARM = 'fq:refetch-rules';
const SWEEP_ALARM = 'fq:sweep-contexts';

/** Abandoned decode contexts are dropped after this long. */
const CONTEXT_TTL_MS = 5 * 60 * 1000;

/** In-flight decode state, keyed `${tabId}:${captureId}`. Ephemeral by design. */
const contexts = new Map();

/** Cached rules for this worker's lifetime. */
let rulesPromise = null;

/** Side panel connections. */
const panelPorts = new Set();

// ---------------------------------------------------------------- rules ---

function getRules() {
  if (!rulesPromise) {
    rulesPromise = resolveRules().catch((err) => {
      console.error('[fq] rules resolution failed:', err);
      rulesPromise = null;
      throw err;
    });
  }
  return rulesPromise;
}

/** Drop the cached rules so the next read re-resolves them. */
function invalidateRules() {
  rulesPromise = null;
}

/** Push the current URL patterns to a tab's relay. */
async function sendConfigToTab(tabId) {
  try {
    const { rules } = await getRules();
    await chrome.tabs.sendMessage(tabId, {
      type: 'config',
      config: { urlPatterns: collectUrlPatterns(rules), sites: rules.sites },
    });
  } catch (_) {
    // The tab may have navigated away or have no relay; nothing to do.
  }
}

/** Push updated rules to every tab currently running a relay. */
async function broadcastConfig() {
  const { rules } = await getRules();
  const hosts = [];
  for (const site of Object.values(rules.sites || {})) hosts.push(...(site.hosts || []));

  try {
    const tabs = await chrome.tabs.query({ url: hosts.map((host) => `https://*.${host}/*`) });
    await Promise.all(tabs.map((tab) => sendConfigToTab(tab.id)));
  } catch (_) {
    /* tab query can fail during shutdown */
  }
}

// ---------------------------------------------------------------- health ---

/**
 * Apply a change to a site's health record and tell the panel about it.
 *
 * Health is read-modify-written per event rather than held in memory, because
 * the worker can be evicted between any two events.
 *
 * @param {string} siteId
 * @param {(site: object) => void} mutate
 */
async function updateHealth(siteId, mutate) {
  const { rules } = await getRules();
  const site = rules.sites[siteId];
  const health = await readHealth();
  const record = siteHealth(health, siteId, strategyOrderFor(site));

  mutate(record);

  await writeHealth(health);
  broadcastToPanels({ type: 'health-update', health });

  if (shouldEscalate(record)) await escalate(siteId);
}

/**
 * Adopt freshly fetched rules: reload them, push the new patterns to every
 * relay, and give each site a clean trial.
 *
 * Health is reset because the counters that made a site look broken were
 * earned by the *old* rules; judging new rules on them would either mask a
 * repair or re-escalate immediately.
 *
 * @param {object} outcome Result from refetchRules.
 */
async function applyNewRules(outcome) {
  invalidateRules();
  const { rules } = await getRules();

  const health = await readHealth();
  for (const siteId of Object.keys(rules.sites || {})) {
    const site = siteHealth(health, siteId, strategyOrderFor(rules.sites[siteId]));
    resetForNewRules(site, strategyOrderFor(rules.sites[siteId]));
  }
  await writeHealth(health);

  await broadcastConfig();
  broadcastToPanels({ type: 'health-update', health });
  broadcastToPanels({ type: 'rules-status', outcome });
}

/**
 * A site has been failing: ask the remote rules for a repair.
 *
 * This is where the two self-healing mechanisms meet — the layered fallbacks
 * have done what they can, so the remote config is asked for a fix. The
 * refetch is throttled inside rules-manager, so repeated red states cannot
 * hammer the network.
 *
 * @param {string} siteId
 */
async function escalate(siteId) {
  const { rules } = await getRules();
  const outcome = await refetchRules(rules, { force: true });
  if (!outcome.updated) return;

  await applyNewRules(outcome);
  console.info(`[fq] rules updated to v${outcome.version} after ${siteId} degraded`);
}

// -------------------------------------------------------------- sessions ---

/**
 * Remember which session a tab is currently writing to. chrome.storage.session
 * outlives service-worker eviction, so a mid-conversation restart keeps
 * appending to the same session instead of splitting it.
 * @param {number} tabId
 * @returns {Promise<string|null>}
 */
async function readTabSession(tabId) {
  const key = `tab:${tabId}`;
  const stored = await chrome.storage.session.get(key);
  return stored[key] || null;
}

async function writeTabSession(tabId, sessionId) {
  await chrome.storage.session.set({ [`tab:${tabId}`]: sessionId });
}

/**
 * Fold an extraction result into the right session and persist it.
 * @param {import('../lib/types.js').ExtractionResult} result
 * @param {{siteId: string, tabId: number, tabUrl: string, conversationKey?: string|null}} context
 */
async function persistResult(result, context) {
  const now = Date.now();

  // A conversation key is the stable identity; without one, fall back to the
  // session already bound to this tab.
  let sessionId = context.conversationKey
    ? `${context.siteId}:${context.conversationKey}`
    : await readTabSession(context.tabId);

  let session = sessionId ? await readSession(sessionId) : null;

  if (!session) {
    session = createSession({
      siteId: context.siteId,
      conversationKey: context.conversationKey,
      tabUrl: context.tabUrl,
      tabId: context.tabId,
      now,
    });
    sessionId = session.id;
  }

  if (context.tabUrl) session.tabUrl = context.tabUrl;

  // Most chunks after the first carry only duplicates; skipping those avoids a
  // storage write and a panel broadcast per chunk of every stream.
  const { turn, addedQueries, addedSources, changed } = mergeResult(session, result, { now });
  if (!changed) return;

  inferAttribution(turn);
  await writeSession(session);
  await writeTabSession(context.tabId, session.id);

  broadcastToPanels({ type: 'session-update', session, tabId: context.tabId });

  // Credit the strategy that produced this — only real findings count, so a
  // turn that yields nothing but a prompt still reads as a miss.
  if (addedQueries || addedSources) {
    await updateHealth(context.siteId, (site) => recordSuccess(site, result.strategy, now));
  }
}

// ------------------------------------------------------------- capturing ---

/**
 * @param {Array<object>} captures
 * @param {chrome.runtime.MessageSender} sender
 */
async function handleRawCapture(message, sender) {
  const captures = Array.isArray(message.captures) ? message.captures : [];
  if (!captures.length || !sender.tab) return;

  const { rules } = await getRules();
  const tabId = sender.tab.id;

  let hostname;
  try {
    hostname = new URL(message.href).hostname;
  } catch (_) {
    return;
  }

  const match = siteForHostname(rules, hostname);
  if (!match) return;

  for (const capture of captures) {
    const key = `${tabId}:${capture.id}`;
    let context = contexts.get(key);

    if (!context) {
      // Only build a context for endpoints this site cares about — SSE from
      // anywhere else is noise.
      const relevant =
        matchesEndpoint(capture.url, match.site) || capture.transport === 'ws';
      if (!relevant) continue;
      context = new CaptureContext(match.siteId, match.site, capture.url);
      contexts.set(key, context);
    }

    let result = null;
    if (capture.phase === 'request') {
      // The prompt usually lives here; it surfaces with the first chunk.
      ingestRequest(context, capture.body || '');
    } else if (capture.phase === 'chunk') {
      result = ingestChunk(context, capture.body || '');
    } else if (capture.phase === 'end') {
      result = finishCapture(context);
      contexts.delete(key);
    }

    if (result) {
      await persistResult(result, {
        siteId: match.siteId,
        tabId,
        tabUrl: message.href,
        conversationKey: context.conversationKey,
      });
    }
  }
}

/**
 * Structured DOM scrape from the relay (strategy layer 2).
 */
async function handleDomCapture(message, sender) {
  if (!sender.tab) return;
  const { rules } = await getRules();

  let hostname;
  try {
    hostname = new URL(message.href || sender.tab.url).hostname;
  } catch (_) {
    return;
  }

  const match = siteForHostname(rules, hostname);
  if (!match) return;

  const result = normalizeDomCapture(message.capture, match.site);
  if (!result) return;

  await persistResult(result, {
    siteId: match.siteId,
    tabId: sender.tab.id,
    tabUrl: message.href || sender.tab.url,
    conversationKey: null,
  });
}

/**
 * The user asked something. This is the denominator the health monitor needs:
 * without it, a quiet session and a broken capture look identical.
 */
async function handleTurnObserved(message, sender) {
  if (!sender.tab) return;
  const { rules } = await getRules();

  let hostname;
  try {
    hostname = new URL(message.href || sender.tab.url).hostname;
  } catch (_) {
    return;
  }

  const match = siteForHostname(rules, hostname);
  if (!match) return;

  await updateHealth(match.siteId, (site) => recordTurn(site, message.ts || Date.now()));
}

/** Drop decode contexts for streams that never delivered an end phase. */
function sweepContexts() {
  const cutoff = Date.now() - CONTEXT_TTL_MS;
  for (const [key, context] of contexts) {
    if (context.lastActivity < cutoff) contexts.delete(key);
  }
}

/**
 * Charge turns that were asked but never answered.
 *
 * Without this, a site that silently stops responding would sit green until
 * the user happened to ask again.
 */
async function sweepOpenTurns() {
  const health = await readHealth();
  const now = Date.now();
  let changed = false;
  const degraded = [];

  for (const [siteId, site] of Object.entries(health.sites || {})) {
    if (expireOpenTurn(site, now)) {
      changed = true;
      if (shouldEscalate(site)) degraded.push([siteId, site]);
    }
  }

  if (!changed) return;
  await writeHealth(health);
  broadcastToPanels({ type: 'health-update', health });

  for (const [siteId] of degraded) await escalate(siteId);
}

// ------------------------------------------------------------ side panel ---

function broadcastToPanels(message) {
  for (const port of panelPorts) {
    try {
      port.postMessage(message);
    } catch (_) {
      panelPorts.delete(port);
    }
  }
}

/** Everything the panel needs to render on connect. */
async function buildPanelState(tabId) {
  const [{ rules, source }, meta, index, health] = await Promise.all([
    getRules(),
    readMeta(),
    readIndex(),
    readHealth(),
  ]);

  const sites = Object.entries(rules.sites || {}).map(([siteId, site]) => ({
    siteId,
    label: site.label || siteId,
  }));

  let session = null;
  if (tabId !== undefined && tabId !== null) {
    const sessionId = await readTabSession(tabId);
    if (sessionId) session = await readSession(sessionId);
  }

  return {
    type: 'state',
    sites,
    index,
    session,
    health,
    rules: {
      version: rules.version,
      source,
      fetchedAt: meta.fetchedAt || 0,
      lastError: meta.lastError || null,
    },
  };
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidepanel') return;
  panelPorts.add(port);

  port.onDisconnect.addListener(() => panelPorts.delete(port));

  port.onMessage.addListener((message) => {
    handlePanelMessage(message, port).catch((err) =>
      console.error('[fq] panel message failed:', err),
    );
  });
});

async function handlePanelMessage(message, port) {
  if (!message || typeof message !== 'object') return;

  switch (message.type) {
    case 'get-state': {
      port.postMessage(await buildPanelState(message.tabId));
      break;
    }
    case 'get-session': {
      const session = await readSession(message.sessionId);
      port.postMessage({ type: 'session-detail', session });
      break;
    }
    case 'delete-session': {
      await deleteSession(message.sessionId);
      port.postMessage(await buildPanelState(message.tabId));
      break;
    }
    case 'clear-sessions': {
      await clearSessions();
      port.postMessage(await buildPanelState(message.tabId));
      break;
    }
    case 'refetch-rules': {
      const { rules } = await getRules();
      const outcome = await refetchRules(rules, { force: true });
      if (outcome.updated) await applyNewRules(outcome);
      port.postMessage({ type: 'rules-status', outcome });
      port.postMessage(await buildPanelState(message.tabId));
      break;
    }
    default:
      break;
  }
}

// --------------------------------------------------------------- wiring ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return undefined;

  switch (message.type) {
    case 'raw-capture':
      handleRawCapture(message, sender).catch((err) =>
        console.error('[fq] raw-capture failed:', err),
      );
      return undefined;

    case 'dom-capture':
      handleDomCapture(message, sender).catch((err) =>
        console.error('[fq] dom-capture failed:', err),
      );
      return undefined;

    case 'turn-observed':
      handleTurnObserved(message, sender).catch((err) =>
        console.error('[fq] turn-observed failed:', err),
      );
      return undefined;

    case 'relay-ready':
      if (sender.tab) sendConfigToTab(sender.tab.id);
      sendResponse({ ok: true });
      return true;

    default:
      return undefined;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error('[fq] sidePanel behavior failed:', err));

  chrome.alarms.create(RULES_ALARM, { periodInMinutes: 360 });
  chrome.alarms.create(SWEEP_ALARM, { periodInMinutes: 5 });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(RULES_ALARM, { periodInMinutes: 360 });
  chrome.alarms.create(SWEEP_ALARM, { periodInMinutes: 5 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SWEEP_ALARM) {
    sweepContexts();
    sweepOpenTurns().catch((err) => console.error('[fq] open-turn sweep failed:', err));
    return;
  }
  if (alarm.name !== RULES_ALARM) return;

  getRules()
    .then(({ rules }) => refetchRules(rules))
    .then(async (outcome) => {
      if (outcome.updated) await applyNewRules(outcome);
    })
    .catch((err) => console.error('[fq] scheduled rules refetch failed:', err));
});

/** Forget a tab's session binding when it closes. */
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`tab:${tabId}`).catch(() => {});
  for (const key of contexts.keys()) {
    if (key.startsWith(`${tabId}:`)) contexts.delete(key);
  }
});
