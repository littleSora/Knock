// Block and report, for every place a person's profile shows up (call card, chat card, profile page, group info).
//
//   safetyActions(p, relation, { context, onChange })  -> the small "Block · Report" row to drop under a profile
//   openReport(p, { context, alreadyBlocked, onBlocked }) -> the multi-step report dialog
//   confirmBlock(p)                                    -> asks, blocks, resolves true when the block went through
//
// p is { id, display_name, handle? }. context says where the report comes from so the server can attach evidence:
//   { type: 'dm' } | { type: 'group', id } | { type: 'call', id: <session code> } | null (plain profile)
import { api, h, icon, errText, toast, openModal, confirmDialog } from './common.js';
import { REPORT_CATEGORIES } from './report-categories.js';

export async function confirmBlock(p) {
  const ok = await confirmDialog({
    title: `Block ${p.display_name}?`,
    body: 'They won’t be able to message you, send you friend requests, find your profile or join a call you’re in. If you’re friends, you’ll be unfriended. They won’t be told you blocked them.',
    confirmText: 'Block',
  });
  if (!ok) return false;
  try {
    await api(`/api/blocks/${encodeURIComponent(p.id)}`, { method: 'POST' });
    toast(`Blocked ${p.display_name}`);
    return true;
  } catch (err) {
    toast(errText(err));
    return false;
  }
}

export function safetyActions(p, relation, { context = null, onChange } = {}) {
  const alreadyBlocked = relation === 'blocked';
  return h('div', { class: 'safety-actions' },
    alreadyBlocked ? null : h('button', { class: 'link-btn danger', type: 'button', onclick: async () => { if (await confirmBlock(p)) onChange?.('blocked'); } }, icon('ban', 14), 'Block'),
    h('button', { class: 'link-btn danger', type: 'button', onclick: () => openReport(p, { context, alreadyBlocked, onBlocked: () => onChange?.('blocked') }) }, icon('flag', 14), 'Report'));
}

export function openReport(p, { context = null, alreadyBlocked = false, onBlocked } = {}) {
  let step = 'category'; // category -> reason (if the category has reasons) -> details -> done
  let cat = null;
  let reason = null;
  let blockedNow = alreadyBlocked;

  const back = h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Back', onclick: () => goBack() }, icon('back', 18));
  const closeBtn = h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Close', onclick: () => m.close() }, icon('x', 16));
  const body = h('div', { class: 'report-body' });
  const m = openModal({ label: `Report ${p.display_name}`, wide: true },
    h('div', { class: 'report-head' }, back, h('h2', {}, 'Report'), closeBtn), body);

  function goBack() {
    if (step === 'details') { step = cat.reasons ? 'reason' : 'category'; reason = null; }
    else if (step === 'reason') { step = 'category'; cat = null; }
    render();
  }

  function render() {
    back.style.visibility = step === 'category' || step === 'done' ? 'hidden' : 'visible';
    body.replaceChildren(...({ category: stepCategory, reason: stepReason, details: stepDetails, done: stepDone })[step]());
    (body.querySelector('[data-first]') || closeBtn).focus();
  }

  const options = (items, onPick) =>
    h('ul', { class: 'report-list' }, items.map((it, i) => h('li', {},
      h('button', { class: 'report-opt', type: 'button', ...(i === 0 ? { 'data-first': '' } : {}), onclick: () => onPick(it) }, h('span', {}, it.label), icon('chevron', 18)))));

  function stepCategory() {
    return [h('p', { class: 'report-q' }, `Why are you reporting ${p.display_name}?`),
      options(REPORT_CATEGORIES, (c) => { cat = c; step = c.reasons ? 'reason' : 'details'; render(); })];
  }

  function stepReason() {
    return [h('p', { class: 'report-q' }, cat.label), h('p', { class: 'hint' }, 'What best describes the problem?'),
      options(cat.reasons, (r) => { reason = r; step = 'details'; render(); })];
  }

  function stepDetails() {
    const required = cat.details === 'required';
    const box = h('textarea', { id: 'rpDetails', rows: '4', maxlength: '500', 'data-first': '', placeholder: required ? 'Tell us what happened' : 'Anything else we should know? (optional)' });
    const check = h('input', { type: 'checkbox', id: 'rpBlock' });
    const err = h('p', { class: 'error', role: 'alert' });
    const send = h('button', { class: 'btn primary', type: 'submit' }, 'Submit report');
    const form = h('form', { onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      if (required && box.value.trim().length < 3) { err.textContent = errText({ code: 'details_required' }); box.focus(); return; }
      send.disabled = true;
      try {
        await api('/api/reports', { method: 'POST', body: { userId: p.id, category: cat.id, reason: reason?.id, details: box.value, context, alsoBlock: !blockedNow && check.checked } });
        if (!blockedNow && check.checked) { blockedNow = true; onBlocked?.(); }
        step = 'done';
        render();
      } catch (ex) { err.textContent = errText(ex); send.disabled = false; }
    } },
      h('p', { class: 'report-q' }, reason ? `${cat.label}: ${reason.label}` : cat.label),
      cat.note ? h('p', { class: 'report-note', role: 'note' }, cat.note) : null,
      h('label', { for: 'rpDetails' }, required ? 'What happened?' : 'Add details'), box,
      context?.type === 'dm' || context?.type === 'group'
        ? h('p', { class: 'hint' }, `The latest messages in this ${context.type === 'dm' ? 'chat' : 'group'} are included so our team can see what happened.`)
        : null,
      alreadyBlocked ? null : h('label', { class: 'report-check', for: 'rpBlock' }, check, h('span', {}, `Also block ${p.display_name}`)),
      h('p', { class: 'hint' }, `${p.display_name} won’t be told that you reported them.`),
      err,
      h('div', { class: 'dialog-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancel'), send));
    return [form];
  }

  function stepDone() {
    return [h('div', { class: 'report-done' },
      h('span', { class: 'report-done-ic' }, icon('check', 28)),
      h('h3', {}, 'Thanks for letting us know'),
      h('p', { class: 'hint' }, `Our team will review your report. ${p.display_name} won’t be told it was you.`),
      blockedNow
        ? h('p', { class: 'friend-state' }, icon('ban', 16), `You blocked ${p.display_name}`)
        : h('div', { class: 'report-next' },
          h('p', { class: 'hint' }, 'Don’t want to hear from them while we look into it?'),
          h('button', { class: 'btn sm', type: 'button', onclick: async () => { if (await confirmBlock(p)) { blockedNow = true; onBlocked?.(); render(); } } }, `Block ${p.display_name}`)),
      h('div', { class: 'dialog-actions' }, h('button', { class: 'btn primary', type: 'button', 'data-first': '', onclick: () => m.close() }, 'Done')))];
  }

  render(); // last, so every helper above is defined before the first paint
}
