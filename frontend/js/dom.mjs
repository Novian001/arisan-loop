// dom.mjs — the smallest element helper that keeps JSX out of a no-build frontend:
// el('button', { class: 'btn', onclick }, 'Label') returns a real node, so render functions
// compose instead of concatenating HTML strings (no escaping bugs, listeners attach directly).
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k in node && k !== 'list' && typeof v !== 'object') node[k] = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function mount(sel, ...children) {
  const host = typeof sel === 'string' ? document.querySelector(sel) : sel;
  host.textContent = '';
  host.append(...children.flat().filter(Boolean));
  return host;
}

export const rp = (n) => `Rp\u2009${Number(n ?? 0).toLocaleString('id-ID')}`;

// State chips carry a symbol AND text — colour is never the only signal (§5.11 a11y).
const CHIP = {
  open: ['○', 'open'], collecting: ['◔', 'collecting'], ready: ['●', 'ready'],
  drawn: ['✔', 'drawn'], settled: ['✔', 'settled'], resolved: ['◑', 'resolved'],
  active: ['●', 'active'], left: ['○', 'left'], defaulted: ['▲', 'defaulted'],
  due: ['○', 'due'], partial: ['◐', 'partial'], paid: ['✔', 'paid'], waived: ['–', 'waived'],
  closed: ['■', 'closed'], open_case: ['▲', 'case open'],
};
export function chip(status) {
  const [sym, label] = CHIP[status] ?? ['•', status];
  return el('span', { class: `chip ${status}`, text: `${sym} ${label}` });
}

export function table(caption, headers, rows) {
  const thead = el('thead', {}, el('tr', {}, headers.map(
    (h) => el('th', { scope: 'col', class: h.num ? 'num' : null }, h.label ?? h),
  )));
  const tbody = el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c, i) =>
    el('td', { class: headers[i]?.num ? 'num' : null }, c)))));
  return el('div', { class: 'table-wrap' }, el('table', {}, el('caption', { text: caption }), thead, tbody));
}
