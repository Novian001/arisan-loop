// member.mjs — phone-first, one column (§5.11): MY iuran, MY giliran, the last draw with a
// verify link. Reads only routes a member is allowed to call: own statement (server refuses
// anyone else's with 403) + group timeline (no per-member rows in it for members). Nothing
// here hides data the server would send — scoping is the server's job, this is just honest
// rendering of it.
import { el, mount, rp, chipWithNote, table, emptyState, statusLabel } from './dom.mjs';

const STATUS_NOTE = {
  due: 'wajib bayar periode ini', partial: 'dibayar sebagian', paid: 'sudah masuk kas',
  waived: 'dibebaskan — tidak perlu bayar',
};
const FREQ = { weekly: 'mingguan', monthly: 'bulanan', daily: 'harian' };

export function renderMemberView(host, { me, overview, statement, periods, names }, actions) {
  const myId = me.member_id;
  const paid = statement?.statement ?? { paid: 0, received: 0, net: 0 };
  const myRows = statement?.contributions ?? [];
  const lastDrawn = [...(periods ?? [])].filter((p) => p.drawn_recipient).pop();
  const myNextTurn = (periods ?? []).find((p) => p.scheduled_recipient === myId && !p.drawn_recipient);

  mount(host,
    el('h2', { text: `Halo, ${me.display_name}` }),
    el('p', { class: 'muted', text: `Kelompok “${overview.group.name}” · ${rp(overview.group.amount)} iuran · ${FREQ[overview.group.frequency] ?? overview.group.frequency}` }),

    el('h3', { text: 'Ringkasan saya' }),
    el('dl', { class: 'metric-list' },
      el('div', {}, el('dt', { text: 'Sudah saya bayar' }), el('dd', { text: rp(paid.paid) })),
      el('div', {}, el('dt', { text: 'Sudah saya terima' }), el('dd', { text: rp(paid.received) })),
      el('div', {}, el('dt', { text: 'Selisih saya' }), el('dd', {
        class: paid.net === 0 ? '' : (paid.net > 0 ? 'lead' : 'net-bad'),
        text: rp(paid.net),
      })),
    ),

    el('h3', { text: 'Pembayaran saya' }),
    myRows.length
      ? table('Iuran saya — satu baris per periode', ['Periode', 'Iuran', 'Status', 'Dibayar', 'Catatan'],
        myRows.map((c) => [`#${c.seq}`, rp(c.amount),
          chipWithNote(c.status, STATUS_NOTE[c.status] ?? ''),
          c.paid_at ? el('span', { class: 'ts', text: c.paid_at.slice(0, 16) }) : '—',
          c.proof_note ?? '—']))
      : emptyState('Belum ada baris iuran — tunggu bendahara membuka periode pertama.'),

    el('h3', { text: 'Giliran saya' }),
    myNextTurn
      ? el('p', {}, `Anda dapat giliran di periode ${myNextTurn.seq} — ${statusLabel(myNextTurn.status)}. `,
        el('span', { class: 'muted', text: 'Urutan giliran bersifat terbuka; nominal anggota lain tidak ditampilkan.' }))
      : el('p', { class: 'muted', text: periods?.some((p) => p.drawn_recipient && p.scheduled_recipient === myId)
        ? 'Semua slot giliran Anda sudah terundi — giliran selesai.' 
        : 'Belum ada slot giliran terjadwal di rotasi sekarang.' }),

    el('h3', { text: 'Undian terakhir' }),
    lastDrawn
      ? el('p', {},
        `Periode ${lastDrawn.seq} jatuh ke ${lastDrawn.drawn_name ?? `#${lastDrawn.drawn_recipient}`}. `,
        el('button', {
          class: 'btn secondary small', type: 'button',
          onclick: () => actions.verify(lastDrawn),
        }, 'Verifikasi ulang di browser saya'))
      : emptyState('Belum ada undian.' ),
    el('div', { id: 'member-verify' }),
  );
}