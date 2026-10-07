// app.mjs — bootstrap + view routing + action wiring for the whole single page.
// House rules: every claim on screen comes from a real API response (no fixture, no
// localStorage cache, no optimistic writes — proration applies only after its preview
// round-trip), every failure shows the backend's own message with its real HTTP status, and
// a dead server shows the local-start hint instead of a fake empty state.
import { api, ApiError, describeError } from './api.mjs';
import { el, mount, rp, chip, table } from './dom.mjs';
import { renderTimeline } from './timeline.mjs';
import { renderMemberView } from './member.mjs';
import { renderVerify } from './verify.mjs';

const $ = (sel) => document.querySelector(sel);
const state = { me: null, overview: null, timeline: null, audit: null, statement: null, lastToken: null, preview: null };

// ---------------------------------------------------------------- status & errors
function showStatus(msg) { $('#status').textContent = msg ?? ''; }
function showError(e) { const box = $('#alert'); box.textContent = describeError(e); box.hidden = false; }
function clearError() { const box = $('#alert'); box.hidden = true; box.textContent = ''; }
function localError(msg) { showError(new ApiError(msg, { status: 400 })); }

/** One busy-state wrapper: honest loading, backend wording on failure, refresh on success. */
async function act(busyEl, fn, { refreshAfter = true } = {}) {
  if (busyEl) {
    busyEl.dataset.label ??= busyEl.textContent;
    busyEl.setAttribute('aria-disabled', 'true');
    busyEl.textContent = 'Working…';
  }
  showStatus('Contacting the backend…');
  try {
    const out = await fn();
    clearError();
    if (refreshAfter) await refresh();
    showStatus('');
    return out;
  } catch (e) {
    showError(e);
    showStatus('');
    return null;
  } finally {
    if (busyEl) {
      busyEl.removeAttribute('aria-disabled');
      busyEl.textContent = busyEl.dataset.label;
    }
  }
}

const names = () => Object.fromEntries((state.overview?.members ?? []).map((m) => [m.id, m.display_name]));
// Fields are read by their stable NAME, scoped to their own form (ids are per-render).
const val = (form, key) => form.querySelector(`[name="${key}"]`)?.value
  ?? form.querySelector(`#${key}`)?.value ?? '';
const intVal = (form, key) => Number(val(form, key));
const optInt = (form, key) => (val(form, key) === '' ? undefined : Number(val(form, key)));

// ---------------------------------------------------------------- data loading
async function refresh() {
  if (!state.me) return;
  const gid = state.me.group_id;
  const [overview, timeline, audit] = await Promise.all([
    api.get(`/api/groups/${gid}`),
    api.get(`/api/groups/${gid}/timeline`),
    state.me.role === 'organizer' ? api.get(`/api/groups/${gid}/audit`).catch(() => null) : null,
  ]);
  state.overview = overview;
  state.timeline = timeline;
  state.audit = audit;
  state.preview = null;
  if (state.me.role === 'organizer') renderConsole(); else renderMember();
}

// ---------------------------------------------------------------- session bar
function renderSessionBar() {
  const bar = $('#session-bar');
  if (!state.me) { mount(bar); return; }
  mount(bar,
    el('span', { class: `chip ${state.me.role === 'organizer' ? 'good' : 'open'}` },
      `${state.me.role === 'organizer' ? '⌂' : '○'} ${state.me.role} · ${state.me.display_name}`),
    el('button', {
      class: 'btn secondary small', type: 'button',
      onclick: async (ev) => { await act(ev.currentTarget, () => api.post('/api/auth/logout'), { refreshAfter: false }); await boot(); },
    }, 'Sign out'),
  );
}

// ---------------------------------------------------------------- organizer console
function renderBalance() {
  const b = state.overview.balance;
  mount($('#balance-strip'),
    el('dl', { class: 'strip' },
      el('div', {}, el('dt', { text: 'Money in (collected)' }), el('dd', { text: rp(b.collected) })),
      el('div', {}, el('dt', { text: 'Money out (payouts)' }), el('dd', { text: rp(b.paid_out) })),
      el('div', {}, el('dt', { text: 'Parked (undrawn periods)' }), el('dd', { text: rp(b.parked_collected) })),
      el('div', {}, el('dt', { text: 'Outstanding advances' }),
        el('dd', { text: `${b.outstanding_advances} · ${rp(b.outstanding_amount)}` })),
      el('div', {}, el('dt', { text: 'INV-1 balance' }), el('dd', { text: String(b.inv1) })),
      el('div', {}, el('dt', { text: 'Conservation' }),
        el('dd', {}, b.invariant_ok ? chip('good') : chip('bad'))),
    ),
  );
}

function renderMembers() {
  const rows = state.overview.members.map((m) => [
    `${m.display_name}${m.is_organizer ? ' ⌂' : ''}`,
    chip(m.status),
    String(m.sort_order),
    m.joined_seq ? `#${m.joined_seq}` : '—',
    m.left_seq ? `#${m.left_seq}` : '—',
    el('div', { class: 'row' },
      state.me.role === 'organizer' && m.status !== 'left' && !m.is_organizer
        ? el('button', {
          class: 'btn secondary small', type: 'button',
          onclick: (ev) => previewLeave(ev.currentTarget, m),
        }, 'Leave…')
        : null,
      state.me.role === 'organizer'
        ? el('button', {
          class: 'btn secondary small', type: 'button',
          onclick: (ev) => issueToken(ev.currentTarget, m),
        }, 'Issue token')
        : null,
    ),
  ]);
  const tree = [table('Members (rotation order)',
    ['Member', 'Status', 'Slot', 'Joined from', 'Left from', 'Actions'], rows)];
  if (state.lastToken) {
    tree.push(el('div', { class: 'warnbox' },
      el('p', { text: `Signed group token for ${state.lastToken.name} — shown once, read-only, valid 365 days:` }),
      el('p', { class: 'passbox', text: state.lastToken.token }),
      el('p', { class: 'hint', text: 'The member pastes it in “Sign in → member token”.' }),
    ));
  }
  mount($('#members-table'), ...tree);
}

function renderStatements() {
  const host = $('#statements');
  const s = state.overview.statements;
  if (!s) { mount(host, el('p', { class: 'muted', text: 'Statements are organizer-only.' })); return; }
  const closed = s.group_status === 'closed';
  mount(host,
    el('p', {}, s.group_net === 0
      ? el('span', { class: 'net-zero', text: `✔ group net = 0 (${s.group_status})` })
      : el('span', { role: 'alert', class: 'net-bad', text: `✗ group net = ${rp(s.group_net)} (${s.group_status})` })),
    table('Statements — paid in / received / net', ['Member', 'Paid in', 'Received', 'Net'],
      s.members.map((m) => [m.display_name, rp(m.paid), rp(m.received),
        el('span', { class: m.net === 0 ? '' : (m.net > 0 ? 'net-zero' : 'net-bad'), text: rp(m.net) })])),
    el('button', {
      class: closed ? 'btn secondary' : 'btn danger', type: 'button', id: 'btn-close',
      onclick: (ev) => closeGroup(ev.currentTarget),
    }, closed ? 'Group already closed (final)' : 'Close group (zero-net check)'),
  );
}

/** §5.7 case 8: a 422 closure refusal renders the exact per-member / per-period breakdown. */
function renderImbalance(detail) {
  if (!detail?.members) return;
  const host = $('#statements');
  host.prepend(el('div', { class: 'alert' },
    el('p', { text: `Closure refused: net ${detail.net ?? '?'} ≠ 0 (INV-1 ${detail.inv1 ?? '?'}). Where the money is off:` }),
    table('Per member', ['Member', 'Paid in', 'Received', 'Net'],
      detail.members.map((m) => [m.display_name, rp(m.paid), rp(m.received), rp(m.net)])),
    table('Per period', ['Period', 'Seq', 'Status', 'Collected', 'Paid out', 'Net'],
      detail.periods.map((p) => [String(p.period_id), String(p.seq), p.status,
        rp(p.collected), rp(p.paid_out), rp(p.net)])),
  ));
}

function renderAudit() {
  const wrap = $('#audit-wrap');
  if (!state.audit) { wrap.hidden = true; return; }
  wrap.hidden = false;
  mount($('#audit'),
    el('details', {}, el('summary', { text: `Audit log (${state.audit.audit.length} actions, newest first)` }),
      table('Action', ['When', 'Action', 'Entity', 'Actor', 'Reason'],
        state.audit.audit.map((a) => [a.created_at, a.action, `${a.entity} #${a.entity_id}`,
          a.actor_id ?? 'system', a.reason ?? '—']))),
    el('details', {}, el('summary', { text: `Draw events (${state.audit.draw_events.length})` }),
      table('Draws', ['Period', 'Algo', 'Seed', 'Drawn at'],
        state.audit.draw_events.map((d) => [String(d.period_id), d.algo,
          el('span', { class: 'mono', text: d.seed }), d.drawn_at]))),
    el('details', {}, el('summary', { text: `Overrides (${state.audit.overrides.length})` }),
      state.audit.overrides.length
        ? table('Overrides', ['Period', 'New recipient', 'Reason', 'When'],
          state.audit.overrides.map((o) => [String(o.period_id), `#${o.recipient_member_id}`, o.reason, o.created_at]))
        : el('p', { class: 'muted', text: 'No overrides — every payout follows its draw.' })),
  );
}

function renderConsole() {
  $('#view-console').hidden = false;
  for (const id of ['#view-member', '#view-setup', '#view-signin']) $(id).hidden = true;
  const g = state.overview.group;
  mount($('#console-head'),
    el('h2', { text: g.name }),
    el('p', {}, `${rp(g.amount)} per period · ${g.frequency} · ${chip(g.status)} · next period: `,
      state.overview.next_period
        ? `#${state.overview.next_period.seq} (${state.overview.next_period.status})`
        : 'none — every period is drawn'),
  );
  renderBalance();
  renderMembers();
  renderPreview(); // a confirmed/cancelled delta must not linger across a refresh
  renderTimeline($('#timeline'), state.timeline, timelineActions());
  renderStatements();
  renderAudit();
}

// ---------------------------------------------------------------- member view
async function loadMemberStatement() {
  state.statement = await api.get(`/api/members/${state.me.member_id}/statement?group=${state.me.group_id}`);
}

function renderMember() {
  $('#view-member').hidden = false;
  for (const id of ['#view-console', '#view-setup', '#view-signin']) $(id).hidden = true;
  const me = {
    ...state.me,
    display_name: state.overview.members.find((m) => m.id === state.me.member_id)?.display_name ?? state.me.display_name,
  };
  renderMemberView($('#view-member'), {
    me, overview: state.overview, statement: state.statement,
    periods: state.timeline?.periods, names: names(),
  }, { verify: (p) => doVerify(p, '#member-verify') });
}

// ---------------------------------------------------------------- actions
async function doVerify(period, sel) {
  const data = await act(null, () => api.get(`/api/periods/${period.id}/draw/verify`), { refreshAfter: false });
  if (!data) return;
  await renderVerify(sel, data, names());
  $(sel)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function timelineActions() {
  return {
    open: (p, btn) => act(btn, () => api.post(`/api/periods/${p.id}/open`)),
    draw: (p, btn) => act(btn, () => api.post(`/api/periods/${p.id}/draw`)),
    cancel: (p, btn) => act(btn, () => api.post(`/api/periods/${p.id}/cancel`)),
    verify: (p) => doVerify(p, '#verify-panel'),
    pay: (p, btn) => act(btn, () => api.post(`/api/periods/${p.id}/contributions`, {
      member_id: intVal(btn.form, 'pay-member'),
      status: val(btn.form, 'pay-status'),
      proof_note: val(btn.form, 'pay-note') || null,
    })),
    markDefault: (p, btn) => act(btn, () => api.post(`/api/periods/${p.id}/default`, {
      member_id: intVal(btn.form, 'def-member'),
      reason: val(btn.form, 'def-reason') || null,
    })),
    resolveDefault: (p, dc, btn) => act(btn, () => api.post(`/api/periods/${p.id}/default/resolve`, {
      member_id: dc.member_id,
      path: val(btn.form, 'res-path'),
      reason: val(btn.form, 'res-reason'),
    })),
    override: (p, btn) => act(btn, () => api.post(`/api/periods/${p.id}/override`, {
      recipient_id: intVal(btn.form, 'ovr-recipient'),
      reason: val(btn.form, 'ovr-reason'),
    })),
  };
}

async function closeGroup(btn) {
  await act(btn, async () => {
    try {
      return await api.post(`/api/groups/${state.me.group_id}/close`, {});
    } catch (e) {
      if (e.status === 422) renderImbalance(e.detail); // show WHERE before the message
      throw e;
    }
  });
}

async function issueToken(btn, member) {
  await act(btn, async () => {
    const out = await api.post(`/api/groups/${state.me.group_id}/members/${member.id}/token`, {});
    state.lastToken = { name: member.display_name, token: out.token };
    renderMembers();
    return out;
  }, { refreshAfter: false });
}

// ---------------------------------------------------------------- proration preview → confirm
// §5.4 step 3: nothing is written until the delta is shown and explicitly confirmed (R6).
async function previewLeave(btn, member) {
  await act(btn, async () => {
    const preview = await api.post(`/api/groups/${state.me.group_id}/members/${member.id}/leave`, {});
    state.preview = { kind: 'leave', member, ...preview };
    renderPreview();
    $('#proration-preview').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return preview;
  }, { refreshAfter: false });
}

function renderPreview() {
  const host = $('#proration-preview');
  const pv = state.preview;
  if (!pv) { host.hidden = true; mount(host); return; }
  host.hidden = false;
  const d = pv.delta;
  const isJoin = d.kind === 'join';

  const shifts = [
    ...(d.removes ?? []).map((r) => ({ ...r, what: 'leaves the rotation' })),
    ...(d.shifts ?? []).map((s) => ({ ...s, what: 'shifts' })),
  ];

  mount(host,
    el('fieldset', {},
      el('legend', { text: `Confirm ${d.kind} — exact previewed delta` }),
      el('p', {},
        isJoin
          ? `${d.display_name} joins at slot ${d.sort_order} from seq ${d.effective_seq} — owed ${rp(d.total_owed)} total (${rp(d.amount_per_period)} × open periods).`
          : `${d.display_name} leaves from seq ${d.effective_seq} — ${rp(d.amount_released)} released, ${rp(d.retained_amount)} retained (paid rows keep their draw eligibility).`),
      el('p', { class: 'hint', text: `Next undrawn period: seq ${d.next_undrawn_seq} of ${d.total_periods}.` }),
      shifts.length
        ? table('Position shifts', ['Member', 'From slot', 'To slot', 'Effect'],
          shifts.map((s) => [`#${s.member_id}`, String(s.from), String(s.to), s.what]))
        : null,
      table(isJoin ? 'Owed per period' : 'Effect per period',
        isJoin ? ['Seq', 'Status', 'Joiner owes'] : ['Seq', 'Status', 'Released', 'Retained', 'Eligibility'],
        d.periods.map((p) => isJoin
          ? [`#${p.seq}`, p.status, p.joiner_owed === null ? 'n/a (already collecting/drawn)' : rp(p.joiner_owed)]
          : [`#${p.seq}`, p.status, rp(p.released_amount), rp(p.retained_amount), p.eligibility])),
      el('div', { class: 'row' },
        el('button', {
          class: 'btn', type: 'button',
          onclick: (ev) => confirmPreview(ev.currentTarget),
        }, isJoin ? 'Confirm — add member now' : 'Confirm — apply leave now'),
        el('button', {
          class: 'btn secondary', type: 'button',
          onclick: () => { state.preview = null; renderPreview(); },
        }, 'Cancel (writes nothing)'),
      ),
    ),
  );
}

async function confirmPreview(btn) {
  const pv = state.preview;
  if (!pv) return;
  const path = pv.kind === 'join'
    ? `/api/groups/${state.me.group_id}/members`
    : `/api/groups/${state.me.group_id}/members/${pv.member.id}/leave/confirm`;
  await act(btn, () => api.post(path, {
    membership_change_id: pv.membership_change_id,
    preview_token: pv.preview_token,
    delta: pv.delta, // exact snapshot — a drifted delta is refused with 409 (R6)
  }));
}

// ---------------------------------------------------------------- setup / sign-in
let setupRow = 0;
function addSetupMember(name = '', isOrg = false) {
  const i = ++setupRow;
  const row = el('div', { class: 'row' },
    el('div', {}, el('label', { for: `su-name-${i}`, text: 'Display name' }),
      el('input', { id: `su-name-${i}`, class: 'su-name', required: true, maxlength: '60', value: name })),
    el('div', {}, el('label', { for: `su-org-${i}`, text: 'Organizer?' }),
      el('input', { type: 'radio', name: 'su-org', id: `su-org-${i}`, class: 'su-org', checked: isOrg })),
    el('div', {}, el('label', { text: 'Action' }),
      el('button', {
        class: 'btn secondary small', type: 'button',
        onclick: (ev) => { ev.currentTarget.closest('.row').remove(); },
      }, 'Remove')),
  );
  $('#setup-members').append(row);
}

function wireSetupForm() {
  addSetupMember('', true);
  addSetupMember('');
  $('#btn-add-member-row').addEventListener('click', () => addSetupMember(''));
  $('#setup-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const form = ev.target;
    const members = [...form.querySelectorAll('.row')].filter((r) => r.querySelector('.su-name'))
      .map((r) => ({
        display_name: r.querySelector('.su-name').value.trim(),
        is_organizer: r.querySelector('.su-org').checked ? 1 : 0,
      }));
    const orgs = members.filter((m) => m.is_organizer === 1).length;
    if (orgs !== 1) { localError('Flag exactly one member as the organizer (radio next to their name).'); return; }
    await act(ev.submitter, async () => {
      const out = await api.post('/api/groups', {
        name: val(form, 'su-name-group'),
        amount: Number(val(form, 'su-amount')),
        frequency: val(form, 'su-frequency'),
        period_count: optInt(form, 'su-periods'),
        organizer_passphrase: val(form, 'su-pass') || undefined,
        members,
      });
      renderSetupResult(out);
      return out;
    }, { refreshAfter: false });
  });
}

function renderSetupResult(out) {
  const host = $('#setup-result');
  host.hidden = false;
  mount(host,
    el('div', { class: 'warnbox' },
      el('p', {}, el('strong', { text: `Group #${out.group.id} “${out.group.name}” created — ${out.periods.length} periods, ${out.members.length} members.` })),
      out.organizer_passphrase_generated
        ? el('p', {}, 'Organizer passphrase (generated, shown ONCE — store it now): ',
          el('span', { class: 'passbox', text: out.organizer_passphrase }))
        : el('p', { text: 'Passphrase stored (hashed) — sign in with it below.' }),
      el('button', {
        class: 'btn', type: 'button',
        onclick: () => {
          $('#login-group').value = String(out.group.id);
          $('#login-form').querySelector('input[type="password"]').focus();
          $('#view-signin').scrollIntoView({ behavior: 'smooth' });
        },
      }, 'Go to sign-in'),
    ),
  );
}

function wireSigninForms() {
  $('#login-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const ok = await act(ev.submitter, () => api.post('/api/auth/login', {
      group_id: Number(val(ev.target, 'login-group')),
      passphrase: val(ev.target, 'login-pass'),
    }), { refreshAfter: false });
    if (ok) await boot(); // a refused login keeps its 401 message on screen
  });
  $('#token-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const ok = await act(ev.submitter, () => api.post('/api/auth/token', {
      token: val(ev.target, 'token-input').trim(),
    }), { refreshAfter: false });
    if (ok) { ev.target.reset(); await boot(); }
  });
}

function wireAddMemberForm() {
  $('#add-member-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    await act(ev.submitter, async () => {
      const preview = await api.post(`/api/groups/${state.me.group_id}/members`, {
        display_name: val(ev.target, 'new-name').trim(),
        sort_order: optInt(ev.target, 'new-sort'),
        effective_seq: optInt(ev.target, 'new-eff'),
      });
      state.preview = { kind: 'join', ...preview };
      renderPreview();
      $('#proration-preview').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return preview;
    }, { refreshAfter: false });
  });
}

// ---------------------------------------------------------------- boot
function showGuest() {
  for (const id of ['#view-console', '#view-member']) $(id).hidden = true;
  $('#view-setup').hidden = false;
  $('#view-signin').hidden = false;
}

async function boot() {
  clearError();
  try {
    state.me = await api.get('/api/auth/me');
  } catch (e) {
    state.me = null;
    if (e.status !== 401) showError(e); // 401 = signed out (normal); anything else is real
  }
  renderSessionBar();
  if (!state.me) { showGuest(); return; }
  try {
    if (state.me.role !== 'organizer') await loadMemberStatement();
    await refresh();
  } catch (e) { showError(e); }
}

wireSetupForm();
wireSigninForms();
wireAddMemberForm();
boot();
