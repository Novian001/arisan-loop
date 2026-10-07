// timeline.mjs — the organizer console's primary surface (§5.11): one article per period
// with state chip, pot, rotation slot, drawn recipient + seed fragment, and inline actions
// (open / collect / draw / cancel / resolve default / override / verify). The enabled button
// is a courtesy; every guard lives server-side — a refused action surfaces as the backend's
// own HTTP error text, never as a silently dead button.
import { el, mount, rp, chip, table } from './dom.mjs';

const fset = (legend, ...children) => el('fieldset', {}, el('legend', { text: legend }), ...children);

// Field ids must be UNIQUE per rendered period form (many periods on one page), while the
// name attribute stays stable — that is what the submit handlers read, scoped to their form.
let uid = 0;
const fieldId = (base) => `${base}-${++uid}`;

function selectField(base, label, options, { valueKey = 'id', labelKey = 'display_name', required = true } = {}) {
  const id = fieldId(base);
  const sel = el('select', { id, name: base, required });
  for (const o of options) sel.append(el('option', { value: o[valueKey], text: o[labelKey] }));
  return el('div', {}, el('label', { for: id, text: label }), sel);
}

function textField(base, label, props = {}) {
  const id = fieldId(base);
  return el('div', {}, el('label', { for: id, text: label }), el('input', { id, name: base, ...props }));
}

/** Per-period contribution rows (organizer sees everyone's status; members do not). */
function contributionsTable(p) {
  if (!p.contributions?.length) return null;
  return table(`Contributions — period ${p.seq}`, ['Member', 'Amount', 'Status', 'Paid at', 'Proof note'],
    p.contributions.map((c) => [
      c.display_name, rp(c.amount), chip(c.status), c.paid_at ?? '—', c.proof_note ?? '—',
    ]));
}

function actions(p, role, a) {
  if (role !== 'organizer') return null;
  const out = [];
  if (p.status === 'open') {
    out.push(el('button', { class: 'btn', type: 'button', onclick: (ev) => a.open(p, ev.currentTarget) },
      `Open collection (period ${p.seq})`));
  }
  if (p.status === 'collecting') {
    const members = p.contributions ?? [];
    out.push(el('form', {
      class: 'row', 'aria-label': `Record a payment for period ${p.seq}`,
      onsubmit: (ev) => { ev.preventDefault(); a.pay(p, ev.submitter); },
    },
    selectField('pay-member', 'Member', members.map((c) => ({ id: String(c.member_id), display_name: `${c.display_name} — ${c.status}` }))),
    selectField('pay-status', 'Status', [
      { id: 'paid', display_name: 'paid (money in)' }, { id: 'partial', display_name: 'partial' },
      { id: 'waived', display_name: 'waived' },
    ]),
    textField('pay-note', 'Proof of transfer note', { maxlength: '500', placeholder: 'e.g. BCA 1234 → 0812… 10 Mar' }),
    el('button', { class: 'btn', type: 'submit', text: 'Record' }),
    ));
  }
  if (p.status === 'ready') {
    out.push(el('button', { class: 'btn', type: 'button', onclick: (ev) => a.draw(p, ev.currentTarget) },
      'Draw winner for this period'),
    el('button', { class: 'btn secondary', type: 'button', onclick: (ev) => a.cancel(p, ev.currentTarget) },
      'Cancel back to collecting'));
  }
  if (p.status === 'resolved') {
    out.push(el('button', { class: 'btn', type: 'button', onclick: (ev) => a.draw(p, ev.currentTarget) },
      'Draw winner for this period'));
  }

  // Defaults: record who missed the payment while collecting, then resolve with reason.
  if (p.status === 'collecting' || p.status === 'resolved') {
    const owing = (p.contributions ?? []).filter((c) => c.status === 'due' || c.status === 'partial');
    const openCases = (p.default_cases ?? []).filter((d) => !d.resolution);
    if (owing.length > 0) {
      out.push(el('form', {
        class: 'row', 'aria-label': `Record a default for period ${p.seq}`,
        onsubmit: (ev) => { ev.preventDefault(); a.markDefault(p, ev.submitter); },
      },
      selectField('def-member', 'Member who missed the payment',
        owing.map((c) => ({ id: String(c.member_id), display_name: `${c.display_name} — ${c.status}` }))),
      textField('def-reason', 'Reason', { maxlength: '500', placeholder: 'why did they default?' }),
      el('button', { class: 'btn danger', type: 'submit', text: 'Mark defaulted' }),
      ));
    }
    for (const dc of openCases) {
      out.push(el('form', {
        class: 'row', 'aria-label': `Resolve default case for ${dc.display_name}`,
        onsubmit: (ev) => { ev.preventDefault(); a.resolveDefault(p, dc, ev.submitter); },
      },
      el('p', { class: 'muted', text: `Open case: ${dc.display_name} (recorded ${dc.detected_at})` }),
      selectField('res-path', 'Resolution path', [
        { id: 'early_payout', display_name: 'early payout — waive now, recover from next period' },
        { id: 'redistribute', display_name: 'redistribute — waive, shift rotation' },
      ]),
      textField('res-reason', 'Reason (required)', { maxlength: '500' }),
      el('button', { class: 'btn', type: 'submit', text: 'Resolve case' }),
      ));
    }
  }

  // Override (R7): drawn period, no override yet — redirect the payout, reason required.
  if (p.status === 'drawn' && !p.has_override && p.contributions?.length) {
    const eligible = p.contributions.filter((c) => c.member_id !== p.drawn_recipient);
    if (eligible.length > 0) {
      out.push(el('form', {
        class: 'row', 'aria-label': `Override recipient for period ${p.seq}`,
        onsubmit: (ev) => { ev.preventDefault(); a.override(p, ev.submitter); },
      },
      selectField('ovr-recipient', 'New recipient (draw record stays provable)', eligible.map((c) => ({ id: String(c.member_id), display_name: c.display_name }))),
      textField('ovr-reason', 'Reason (required — empty reason is refused)', { maxlength: '500' }),
      el('button', { class: 'btn danger', type: 'submit', text: 'Override payout' }),
      ));
    }
  }
  if (p.draw_event_id) {
    out.push(el('button', { class: 'btn secondary', type: 'button', onclick: () => a.verify(p) },
      'Verify this draw'));
  }
  return out.length ? el('div', { class: 'row' }, out) : null;
}

export function renderTimeline(host, { periods, role }, a) {
  if (!periods?.length) { mount(host, el('p', { class: 'muted', text: 'No periods yet — create the group first.' })); return; }
  const nodes = periods.map((p) => {
    const lines = [
      el('span', { class: 'seq', text: `Period ${p.seq}` }),
      chip(p.status),
      el('span', {}, `pot ${rp(p.pot)}`),
      el('span', { class: 'muted', text: `rotation → ${p.scheduled_name ?? '—'}` }),
    ];
    if (p.drawn_recipient) {
      lines.push(el('span', {}, `drawn → ${p.drawn_name ?? `#${p.drawn_recipient}`}`));
      if (p.has_override) lines.push(chip('bad'), el('span', { class: 'muted', text: '(overridden — see audit)' }));
    }
    if (p.seed_fragment) lines.push(el('span', { class: 'mono muted', text: `seed ${p.seed_fragment}…` }));
    if (role === 'organizer') lines.push(el('span', { class: 'muted', text: `${p.paid_count}/${p.due_count} paid` }));

    return el('article', { class: 'period', 'aria-label': `Period ${p.seq}` },
      el('div', { class: 'period-head' }, lines),
      contributionsTable(p),
      actions(p, role, a),
    );
  });
  mount(host, ...nodes);
}
