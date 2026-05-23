/*
 * Reusable "Request an in-person test" modal.
 *
 * Triggered from anywhere with `data-in-person-request` (e.g. the
 * "Request an in-person session" CTA inside the How-to-Measure modal,
 * or a "Request a session →" button on the in-person landing page).
 *
 * On submit, creates a Firestore notification doc that lands in the
 * admin notification panel (same schema as coaching/feedback notifs).
 */

const MODAL_ID = 'esml-inperson-modal-root';
const ADMIN_UID = '2z9Z3K5ZwShvadUuqZmwMv0s1Od2';

const MODAL_HTML = `
<div class="esml-modal-overlay">
  <div class="esml-modal" role="dialog" aria-modal="true">
    <button class="esml-modal-close" type="button" aria-label="Close">×</button>
    <div class="esml-modal-body">
      <div class="section-label" style="margin-bottom:18px">▷ In-person test</div>
      <h2 class="esml-modal-title">Request an in-person test session</h2>
      <p class="esml-modal-lede">
        Tell us how to reach you and we'll follow up to schedule. Sessions are
        typically held in the Boulder area; Denver-area travel by arrangement.
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
        <label class="field">
          <span class="lab">Preferred window (optional)</span>
          <input type="text" id="ipm-timing" placeholder="e.g. weekday mornings, next 2–3 weeks">
        </label>
        <label class="field">
          <span class="lab">Anything else we should know? (optional)</span>
          <textarea id="ipm-notes" rows="4" style="width:100%;padding:10px 14px;background:var(--panel2);border:1px solid var(--border2);border-radius:8px;color:var(--text);font-family:var(--body);font-size:15px;resize:vertical"></textarea>
          <span class="hint">Goals, current training, any health considerations, scheduling constraints…</span>
        </label>

        <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-top:8px">
          <button type="submit" class="btn primary" id="ipm-submit">Send request →</button>
          <button type="button" class="btn ghost"   id="ipm-close">Cancel</button>
        </div>
        <div id="ipm-status" style="display:none;padding:12px 16px;border-radius:10px;font-size:14px;margin-top:14px;line-height:1.55"></div>
      </form>
    </div>
  </div>
</div>
`;

function teardown(root, onKey, prevOverflow) {
  root.remove();
  document.body.style.overflow = prevOverflow;
  window.removeEventListener('keydown', onKey);
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

  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  const onKey = (e) => { if (e.key === 'Escape') teardown(root, onKey, prevOverflow); };
  window.addEventListener('keydown', onKey);
  closeBtn.addEventListener('click',  () => teardown(root, onKey, prevOverflow));
  cancelBtn.addEventListener('click', () => teardown(root, onKey, prevOverflow));
  overlay.addEventListener('click',   (e) => { if (e.target === overlay) teardown(root, onKey, prevOverflow); });
  closeBtn.focus({ preventScroll: true });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const radio = (name) => {
      const el = root.querySelector('input[name="' + name + '"]:checked');
      return el ? el.value : '';
    };
    const $f = (id) => root.querySelector('#' + id);

    const payload = {
      name:   $f('ipm-name').value.trim(),
      email:  $f('ipm-email').value.trim(),
      phone:  $f('ipm-phone').value.trim() || null,
      sport:  radio('ipm-sport'),
      area:   radio('ipm-area'),
      timing: $f('ipm-timing').value.trim() || null,
      notes:  $f('ipm-notes').value.trim() || null,
    };
    if (!payload.name || !payload.email) {
      statusEl.style.display = 'block';
      statusEl.style.background = 'rgba(255,81,99,.10)';
      statusEl.style.border = '1px solid rgba(255,81,99,.30)';
      statusEl.style.color = 'var(--bad)';
      statusEl.textContent = 'Name and email are required.';
      return;
    }

    const btn = $f('ipm-submit');
    btn.disabled = true; btn.textContent = 'Sending…';

    const sender = (window.__esml && window.__esml.user) ? window.__esml.user : null;
    const summary = '[In-person test] ' + payload.name + ' (' + payload.sport + ', ' + payload.area + ')'
                  + ' — ' + payload.email
                  + (payload.notes ? ' · ' + payload.notes.slice(0, 120) : '');

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
      statusEl.style.display = 'block';
      statusEl.style.background = 'rgba(34,199,138,.10)';
      statusEl.style.border = '1px solid rgba(34,199,138,.30)';
      statusEl.style.color = 'var(--good)';
      statusEl.innerHTML = '<strong>Request sent.</strong> Your coach will reach out by email within a few days. If you don\'t hear back, send a follow-up to <a href="mailto:austen.hughes@finalforms.com" style="color:inherit;text-decoration:underline">austen.hughes@finalforms.com</a>.';
      form.reset();
      btn.textContent = 'Sent ✓';
      setTimeout(() => teardown(root, onKey, prevOverflow), 4000);
    } catch (err) {
      console.error('In-person request submit failed:', err);
      statusEl.style.display = 'block';
      statusEl.style.background = 'rgba(255,81,99,.10)';
      statusEl.style.border = '1px solid rgba(255,81,99,.30)';
      statusEl.style.color = 'var(--bad)';
      statusEl.textContent = 'Send failed: ' + (err.message || err) + '. Please try again, or email directly.';
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
