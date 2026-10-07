// member.mjs — phone-first, one column (§5.11): MY payments, MY turn, the last draw with a
// verify link. Reads only routes a member is allowed to call: own statement (server refuses
// anyone else's with 403) + group timeline (no per-member rows in it for members). Nothing
// here hides data the server would send — scoping is the server's job, this is just honest
// rendering of it.
import { el, mount, rp, chip, table } from './dom.mjs';

const STATUS_NOTE = {
  due: 'not paid yet', partial: 'partially paid', paid: 'paid', waived: 'waived (no payment needed)',
};

export function renderMemberView(host, { me, overview, statement, periods, names }, actions) {
  const myId = me.member_id;
  const paid = statement?.statement ?? { paid: 0, received: 0, net: 0 };
  const myRows = statement?.contributions ?? [];
  const lastDrawn = [...(periods ?? [])].filter((p) => p.drawn_recipient).pop();
  const myNextTurn = (periods ?? []).find((p) => p.scheduled_recipient === myId && !p.drawn_recipient);

  mount(host,
    el('h2', { text: `Member view — ${me.display_name}` }),
    el('p', { class: 'muted', text: `Group “${overview.group.name}” · ${rp(overview.group.amount)} per period · ${overview.group.frequency}` }),

    el('h3', { text: 'My balance' }),
    el('dl', { class: 'strip' },
      el('div', {}, el('dt', { text: 'I paid in' }), el('dd', { text: rp(paid.paid) })),
      el('div', {}, el('dt', { text: 'I received' }), el('dd', { text: rp(paid.received) })),
      el('div', {}, el('dt', { text: 'My net' }), el('dd', {
        class: paid.net === 0 ? '' : (paid.net > 0 ? 'net-zero' : 'net-bad'),
        text: rp(paid.net),
      })),
    ),

    el('h3', { text: 'My payments' }),
    myRows.length
      ? table('Per period (own rows only)', ['Period', 'Amount', 'Status', 'Paid at', 'Note'],
        myRows.map((c) => [`#${c.seq}`, rp(c.amount),
          [chip(c.status), ` ${STATUS_NOTE[c.status] ?? ''}`],
          c.paid_at ?? '—', c.proof_note ?? '—']))
      : el('p', { class: 'muted', text: 'No contribution rows yet — open the first collection from the organizer console.' }),

    el('h3', { text: 'My turn' }),
    myNextTurn
      ? el('p', {}, `Next up for you: period ${myNextTurn.seq} (${myNextTurn.status}). `,
        el('span', { class: 'muted', text: 'Rotation order is public; amounts of others are not shown to you.' }))
      : el('p', { class: 'muted', text: periods?.some((p) => p.drawn_recipient && p.scheduled_recipient === myId)
        ? 'All your scheduled slots are already drawn — your turn is done in this schedule.'
        : 'No upcoming scheduled slot found in the current rotation.' }),

    el('h3', { text: 'Last draw' }),
    lastDrawn
      ? el('p', {},
        `Period ${lastDrawn.seq} was drawn to ${lastDrawn.drawn_name ?? `#${lastDrawn.drawn_recipient}`}. `,
        el('button', {
          class: 'btn secondary', type: 'button',
          onclick: () => actions.verify(lastDrawn),
        }, 'Re-verify it in my browser'))
      : el('p', { class: 'muted', text: 'No draw has happened yet.' }),
    el('div', { id: 'member-verify' }),
  );
}
