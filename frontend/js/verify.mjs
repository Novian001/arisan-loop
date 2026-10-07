// verify.mjs — §5.4 step 8 / §5.10 differentiation: re-run the draw in the BROWSER from the
// served artifacts alone (crypto.subtle, no server trust). Mirrors backend draw.js sampleIndex:
// index = BigInt(sha256_hex(algo ‖ seed ‖ join(ids, ','))) % n — BigInt, not parseInt, because
// a 256-bit hex exceeds double precision and the two sides must land on the same index.
import { el, mount, chip } from './dom.mjs';

export async function recomputeDraw({ seed, algo, inputs }) {
  const bytes = new TextEncoder().encode(`${algo}${seed}${inputs.join(',')}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const index = Number(BigInt(`0x${hex}`) % BigInt(inputs.length));
  return { index, member_id: inputs[index] };
}

/**
 * Render the verification panel: stored artifacts, browser-side recompute, and the verdict.
 * `names` maps member id -> display name for readable output. The verdict is text+symbol.
 */
export async function renderVerify(sel, artifacts, names = {}) {
  const host = typeof sel === 'string' ? document.querySelector(sel) : sel;
  if (!artifacts) { mount(host, el('p', { class: 'muted', text: 'No draw selected yet.' })); return; }
  const mine = await recomputeDraw(artifacts);
  const match = mine.member_id === artifacts.drawn_recipient;
  const winnerName = (id) => names[id] ?? `member #${id}`;

  mount(host,
    el('p', { class: 'hint', text: 'Stored artifacts below are re-hashed in YOUR browser with Web Crypto — no server trust involved.' }),
    el('dl', { class: 'strip' },
      el('div', {}, el('dt', { text: 'algo' }), el('dd', { class: 'mono', text: artifacts.algo })),
      el('div', {}, el('dt', { text: 'seed (sha256)' }), el('dd', { class: 'mono', text: artifacts.seed })),
      el('div', {}, el('dt', { text: 'inputs (ordered ids)' }), el('dd', { class: 'mono', text: artifacts.inputs.join(',') })),
    ),
    el('p', {},
      el('strong', { text: 'Browser recompute: ' }),
      `index ${mine.index} → ${winnerName(mine.member_id)} (#${mine.member_id})`,
    ),
    el('p', {},
      el('strong', { text: 'Server draw: ' }),
      `${winnerName(artifacts.drawn_recipient)} (#${artifacts.drawn_recipient})`,
    ),
    match
      ? el('p', {}, chip('good'), ' MATCH — the served winner reproduces from the artifacts alone.')
      : el('p', { role: 'alert' }, chip('bad'), ' MISMATCH — do NOT trust this draw; artifacts and winner disagree.'),
  );
}
