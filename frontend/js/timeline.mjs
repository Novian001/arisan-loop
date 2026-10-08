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
  return table(`Iuran — periode ${p.seq}`, ['Anggota', 'Iuran', 'Status', 'Dibayar', 'Catatan'],
    p.contributions.map((c) => [
      c.display_name, rp(c.amount), chip(c.status),
      c.paid_at ? el('span', { class: 'ts', text: c.paid_at.slice(0, 16) }) : '—',
      c.proof_note ?? '—',
    ]));
}

function actions(p, role, a) {
  if (role !== 'organizer') return null;
  const out = [];
  if (p.status === 'open') {
    out.push(el('button', { class: 'btn', type: 'button', onclick: (ev) => a.open(p, ev.currentTarget) },
      `Buka iuran (periode ${p.seq})`));
  }
  if (p.status === 'collecting') {
    const members = p.contributions ?? [];
    out.push(el('form', {
      class: 'row', 'aria-label': `Catat pembayaran periode ${p.seq}`,
      onsubmit: (ev) => { ev.preventDefault(); a.pay(p, ev.submitter); },
    },
    selectField('pay-member', 'Anggota', members.map((c) => ({ id: String(c.member_id), display_name: `${c.display_name} — ${c.status}` }))),
    selectField('pay-status', 'Status', [
      { id: 'paid', display_name: 'lunas (uang masuk)' }, { id: 'partial', display_name: 'sebagian' },
      { id: 'waived', display_name: 'dilepas' },
    ]),
    textField('pay-note', 'Catatan bukti transfer', { maxlength: '500', placeholder: 'mis. BCA 1234 → 0812… 10 Mar' }),
    el('button', { class: 'btn', type: 'submit', text: 'Catat' }),
    ));
  }
  if (p.status === 'ready') {
    out.push(el('button', { class: 'btn', type: 'button', onclick: (ev) => a.draw(p, ev.currentTarget) },
      'Undi pemenang periode ini'),
    el('button', { class: 'btn secondary', type: 'button', onclick: (ev) => a.cancel(p, ev.currentTarget) },
      'Batal, kembali ke kumpul iuran'));
  }
  if (p.status === 'resolved') {
    out.push(el('button', { class: 'btn', type: 'button', onclick: (ev) => a.draw(p, ev.currentTarget) },
      'Undi pemenang periode ini'));
  }

  // Defaults: record who missed the payment while collecting, then resolve with reason.
  if (p.status === 'collecting' || p.status === 'resolved') {
    const owing = (p.contributions ?? []).filter((c) => c.status === 'due' || c.status === 'partial');
    const openCases = (p.default_cases ?? []).filter((d) => !d.resolution);
    if (owing.length > 0) {
      out.push(el('form', {
        class: 'row', 'aria-label': `Catat tunggakan periode ${p.seq}`,
        onsubmit: (ev) => { ev.preventDefault(); a.markDefault(p, ev.submitter); },
      },
      selectField('def-member', 'Anggota yang belum bayar',
        owing.map((c) => ({ id: String(c.member_id), display_name: `${c.display_name} — ${c.status}` }))),
      textField('def-reason', 'Alasan', { maxlength: '500', placeholder: 'kenapa tidak bayar?' }),
      el('button', { class: 'btn danger', type: 'submit', text: 'Tandai ingkar' }),
      ));
    }
    for (const dc of openCases) {
      out.push(el('form', {
        class: 'row', 'aria-label': `Selesaikan kasus tunggakan ${dc.display_name}`,
        onsubmit: (ev) => { ev.preventDefault(); a.resolveDefault(p, dc, ev.submitter); },
      },
      el('p', { class: 'muted', text: `Kasus terbuka: ${dc.display_name} (dicatat ${dc.detected_at})` }),
      selectField('res-path', 'Jalur penyelesaian', [
        { id: 'early_payout', display_name: 'bayar lebih awal — lepas sekarang, ganti periode berikutnya' },
        { id: 'redistribute', display_name: 'redistribusi — lepas, geser rotasi' },
      ]),
      textField('res-reason', 'Alasan (wajib)', { maxlength: '500' }),
      el('button', { class: 'btn', type: 'submit', text: 'Selesaikan kasus' }),
      ));
    }
  }

  // Override (R7): drawn period, no override yet — redirect the payout, reason required.
  if (p.status === 'drawn' && !p.has_override && p.contributions?.length) {
    const eligible = p.contributions.filter((c) => c.member_id !== p.drawn_recipient);
    if (eligible.length > 0) {
      out.push(el('form', {
        class: 'row', 'aria-label': `Alihkan penerima periode ${p.seq}`,
        onsubmit: (ev) => { ev.preventDefault(); a.override(p, ev.submitter); },
      },
      selectField('ovr-recipient', 'Penerima baru (rekaman undian tetap terbukti)', eligible.map((c) => ({ id: String(c.member_id), display_name: c.display_name }))),
      textField('ovr-reason', 'Alasan (wajib — alasan kosong ditolak)', { maxlength: '500' }),
      el('button', { class: 'btn danger', type: 'submit', text: 'Alihkan payout' }),
      ));
    }
  }
  if (p.draw_event_id) {
    out.push(el('button', { class: 'btn secondary', type: 'button', onclick: () => a.verify(p) },
      'Verifikasi undian ini'));
  }
  return out.length ? el('div', { class: 'row' }, out) : null;
}

export function renderTimeline(host, { periods, role }, a) {
  if (!periods?.length) { mount(host, el('p', { class: 'muted', text: 'Belum ada periode — buat kelompok dulu.' })); return; }
  const nodes = periods.map((p) => {
    const lines = [
      el('span', { class: 'seq', text: `Periode ${p.seq}` }),
      chip(p.status),
    ];
    const potLine = el('div', { class: 'pot-row' },
      el('span', {}, 'Pot: ', el('b', { text: rp(p.pot) })),
      el('span', {}, 'Giliran: ', el('b', { text: p.scheduled_name ?? '—' })),
      p.drawn_recipient
        ? el('span', {}, 'Terundi → ', el('b', { text: p.drawn_name ?? `#${p.drawn_recipient}` }))
        : null,
      p.has_override ? el('span', { class: 'badge', text: '⚠ override — lihat audit' }) : null,
      role === 'organizer' && p.due_count
        ? el('span', { class: 'muted', text: `${p.paid_count}/${p.due_count} lunas` })
        : null,
    );
    if (p.seed_fragment) lines.push(el('span', { class: 'mono muted', text: `seed ${p.seed_fragment}…` }));

    return el('article', { class: 'period', 'aria-label': `Periode ${p.seq}` },
      el('div', { class: 'period-head' }, lines),
      potLine,
      contributionsTable(p),
      actions(p, role, a),
    );
  });
  mount(host, ...nodes);
}
