/*
 * Reusable "Request an in-person test" modal.
 *
 * Triggered from anywhere with `data-in-person-request` (e.g. the
 * "Request an in-person session" CTA inside the How-to-Measure modal,
 * or a "Request a session →" button on the in-person landing page).
 *
 * On submit, creates a Firestore notification doc that lands in the
 * admin notification panel (same schema as coaching/feedback notifs).
 * The message carries everything the form collects, tagged [Paid] /
 * [Not paid] (an in-person payment in the last 14 days) — in-person is
 * pay-first (D7), so an unpaid request is flagged rather than blocked.
 */

import { pushModal, closeModal } from './modal-stack.js';

const PAID_WINDOW_DAYS = 14;   // same window the in-person page uses for its paid view
const MODAL_ID = 'esml-inperson-modal-root';
const ADMIN_UID = '2z9Z3K5ZwShvadUuqZmwMv0s1Od2';

const MODAL_HTML = `
<div class="esml-modal-overlay">
  <div class="esml-modal" role="dialog" aria-modal="true" aria-labelledby="ipm-title">
    <button class="esml-modal-close" type="button" aria-label="Close">×</button>
    <div class="esml-modal-body">
      <div class="section-label" style="margin-bottom:18px">▷ In-person test</div>
      <h2 class="esml-modal-title" id="ipm-title">Request an in-person test session</h2>
      <p class="esml-modal-lede">
        Tell us how to reach you and we'll follow up to schedule. Sessions are
        held in Broomfield, CO.
      </p>

      <form id="ipm-form">
        <div class="grid-2">
          <label class="field">
            <span class="lab">Your name</span>
            <input type="text" id="ipm-name" required>
          </label>
          <label class="field">
            <span class="lab">Email</span>
            <input type="email" id="ipm-email" required>
          </label>
        </div>
        <div class="grid-2">
          <label class="field">
            <span class="lab">Phone (optional)</span>
            <input type="tel" id="ipm-phone">
          </label>
          <div class="field">
            <span class="lab">Sport</span>
            <div class="radio-row">
              <label><input type="radio" name="ipm-sport" value="running" checked><span>Running</span></label>
              <label><input type="radio" name="ipm-sport" value="cycling"><span>Cycling</span></label>
              <label><input type="radio" name="ipm-sport" value="both"><span>Both</span></label>
            </div>
          </div>
        </div>
        <div class="field">
          <span class="lab">Where are you?</span>
          <div class="radio-row">
            <label><input type="radio" name="ipm-area" value="boulder" checked><span>Boulder area</span></label>
            <label><input type="radio" name="ipm-area" value="denver"><span>Denver area</span></label>
            <label><input type="radio" name="ipm-area" value="other"><span>Elsewhere</span></label>
          </div>
        </div>
        <label class="field" id="ipm-area-other-row" style="display:none">
          <span class="lab">Where, specifically?</span>
          <input type="text" id="ipm-area-other" placeholder="City, state — or as much as you'd like to share">
          <span class="hint">Required when you select Elsewhere — helps us tell you if travel's feasible.</span>
        </label>
        <label class="field">
          <span class="lab">Preferred window (optional)</span>
          <input type="text" id="ipm-timing" placeholder="e.g. weekday mornings, next 2–3 weeks">
        </label>
        <label class="field">
          <span class="lab">Anything else we should know? (optional)</span>
          <textarea id="ipm-notes" rows="4"></textarea>
          <span class="hint">Goals, current training, any health considerations, scheduling constraints…</span>
        </label>

        <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-top:8px">
          <button type="submit" class="btn primary" id="ipm-submit">Send request →</button>
          <button type="button" class="btn ghost"   id="ipm-close">Cancel</button>
        </div>
        <div id="ipm-status" hidden style="margin-top:14px"></div>
      </form>
    </div>
  </div>
</div>
`;

// True when the signed-in account has an in-person payment in the last 14 days.
function hasRecentInPersonPayment() {
  try {
    const p = window.esLabs && window.esLabs.getPassState ? window.esLabs.getPassState() : null;
    const t = p && p.metlab && p.metlab.inPersonLatest;
    return !!t && (Math.floor(Date.now() / 1000) - t) < PAID_WINDOW_DAYS * 86400;
  } catch (e) { return false; }
}

export function showInPersonRequestModal() {
  if (document.getElementById(MODAL_ID)) return;
  if (!window.firebase) { console.warn('Firebase not available'); return; }

  const root = document.createElement('div');
  root.id = MODAL_ID;
  root.innerHTML = MODAL_HTML;
  document.body.appendChild(root);

  const overlay  = root.querySelector('.esml-modal-overlay');
  const closeBtn = root.querySelector('.esml-modal-close');
  const cancelBtn = root.querySelector('#ipm-close');
  const form     = root.querySelector('#ipm-form');
  const statusEl = root.querySelector('#ipm-status');
  const close = () => closeModal(root, 'cancel');

  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const $f = (id) => root.querySelector('#' + id);

  // Prefill from the (effective) signed-in user; both stay editable.
  const u = window.__esml && window.__esml.user;
  if (u) {
    if (u.displayName) $f('ipm-name').value = u.displayName;
    if (u.email) $f('ipm-email').value = u.email;
  }

  pushModal(root, { initialFocus: closeBtn });

  // "Elsewhere" radio toggles a required free-text location field
  const otherRow = $f('ipm-area-other-row');
  root.querySelectorAll('input[name="ipm-area"]').forEach((r) => {
    r.addEventListener('change', () => {
      const sel = root.querySelector('input[name="ipm-area"]:checked');
      otherRow.style.display = (sel && sel.value === 'other') ? 'block' : 'none';
    });
  });

  const showError = (msg) => {
    statusEl.className = 'esl-callout esl-callout--bad';
    statusEl.setAttribute('role', 'alert');
    statusEl.textContent = msg;
    statusEl.hidden = false;
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const radio = (name) => {
      const el = root.querySelector('input[name="' + name + '"]:checked');
      return el ? el.value : '';
    };

    const area = radio('ipm-area');
    const areaOther = $f('ipm-area-other').value.trim();
    const paid = hasRecentInPersonPayment();
    const payload = {
      name:       $f('ipm-name').value.trim(),
      email:      $f('ipm-email').value.trim(),
      phone:      $f('ipm-phone').value.trim() || null,
      sport:      radio('ipm-sport'),
      area:       area,
      area_other: area === 'other' ? (areaOther || null) : null,
      timing:     $f('ipm-timing').value.trim() || null,
      notes:      $f('ipm-notes').value.trim() || null,
      paid:       paid,
      source:     location.pathname,
    };

    ['ipm-name', 'ipm-email', 'ipm-area-other'].forEach((id) => $f(id).removeAttribute('aria-invalid'));
    if (!payload.name || !payload.email) {
      if (!payload.name) $f('ipm-name').setAttribute('aria-invalid', 'true');
      if (!payload.email) $f('ipm-email').setAttribute('aria-invalid', 'true');
      showError('Name and email are required.');
      return;
    }
    if (area === 'other' && !areaOther) {
      $f('ipm-area-other').setAttribute('aria-invalid', 'true');
      showError('Please tell us where you are when selecting "Elsewhere".');
      return;
    }

    const btn = $f('ipm-submit');
    btn.disabled = true; btn.textContent = 'Sending…';
    statusEl.hidden = true;

    const sender = (window.__esml && window.__esml.user) ? window.__esml.user : null;
    const areaLabel = payload.area === 'other' && payload.area_other
                    ? 'other: ' + payload.area_other
                    : payload.area;
    const notes = payload.notes ? (payload.notes.length > 120 ? payload.notes.slice(0, 120).trimEnd() + '…' : payload.notes) : '';
    const summary = (paid ? '[Paid] ' : '[Not paid] ')
                  + '[In-person test] ' + payload.name + ' (' + payload.sport + ', ' + areaLabel + ') — ' + payload.email
                  + (payload.phone ? ' · ' + payload.phone : '') + (payload.timing ? ' · When: ' + payload.timing : '')
                  + (notes ? ' · ' + notes : '');

    try {
      await firebase.firestore().collection('notifications').add({
        recipientUid: ADMIN_UID,
        senderUid:    sender ? sender.uid : 'anonymous',
        type:         'in_person_request',
        message:      summary,
        payload:      payload,
        read:         false,
        createdAt:    firebase.firestore.FieldValue.serverTimestamp(),
      });
      // Success stays on screen until the user closes it.
      form.hidden = true;
      const ok = document.createElement('div');
      ok.className = 'esl-callout esl-callout--good';
      ok.setAttribute('role', 'status');
      ok.tabIndex = -1;
      ok.innerHTML = '<p class="esl-callout-title">✓ Request sent</p><p>We’ll reach out by email within a few days. If you don’t hear back, email <a href="mailto:austen@endurancesciencelabs.com">austen@endurancesciencelabs.com</a>.</p>'
                   + '<p style="margin-top:14px"><button type="button" class="btn primary" id="ipm-done">Done</button></p>';
      form.insertAdjacentElement('afterend', ok);
      ok.focus();
      ok.querySelector('#ipm-done').addEventListener('click', () => closeModal(root, 'done'));
      window.dispatchEvent(new CustomEvent('esml-inperson-sent'));
    } catch (err) {
      console.error('In-person request submit failed:', err);
      showError('We couldn’t send that. Please try again, or email austen@endurancesciencelabs.com.');
      btn.disabled = false; btn.textContent = 'Send request →';
    }
  });
}

/** Wire any element with data-in-person-request to open the modal. */
export function wireInPersonRequestTriggers() {
  document.querySelectorAll('[data-in-person-request]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      showInPersonRequestModal();
    });
  });
}
