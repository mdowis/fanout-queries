// FANOUT_QUERIES side panel controller.
// Phase 1 scaffold: static shell + placeholder health rows.
// Live wiring (port protocol, session rendering, history, export) lands in later phases.

const SITES = [
  { id: 'chatgpt', label: 'ChatGPT' },
  { id: 'claude', label: 'Claude' },
  { id: 'perplexity', label: 'Perplexity' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'google', label: 'Google AI' },
];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderHealthPlaceholder() {
  const strip = document.getElementById('health-strip');
  strip.replaceChildren();
  for (const site of SITES) {
    const row = el('li', 'health-row');
    row.append(
      el('span', 'led idle'),
      el('span', 'health-site', site.label),
      el('span', 'health-meta', 'STANDBY'),
    );
    strip.append(row);
  }
}

renderHealthPlaceholder();
