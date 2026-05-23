/*
 * Sprint VLamax Test — UI controller.
 *
 * Page layout:
 *   1. Title + lede + "How to measure lactate" trigger (opens modal)
 *   2. Your Sprint Sessions panel
 *        - empty state: explanatory copy + "Start your first session" CTA
 *        - populated:  ordered list of cards, latest highlighted
 *        - inline "New Session" form expands above when [+ New Session] clicked
 *
 * Storage:
 *   users/{uid}.esmetlab.vlamax         → latest session, what Lactate Step
 *                                         Test reads. Kept for compatibility.
 *   users/{uid}.esmetlab.sprintSessions → array of all sessions, newest last.
 */

import { computeVLamax } from '../js/lib/mader/sprint.js';
import { showHowToMeasureModal, wireHowToMeasureTriggers } from '../js/ui/how-to-measure.js';
import { showSprintProtocolModal, wireSprintProtocolTriggers } from '../js/ui/how-to-sprint-test.js';

const $ = (sel) => document.querySelector(sel);

const db = firebase.firestore();

const state = {
  sessions: [],          // newest-last
  newFormOpen: false,
};

/* ───────── Helpers ───────── */

function fmtDate(ts) {
  if (!ts) return '—';
  let d;
  if (ts.toDate) d = ts.toDate();
  else d = new Date(ts);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function phenotype(v) {
  if (v < 0.30) return { cls: 'low',  text: 'aerobic-dominant' };
  if (v < 0.55) return { cls: 'mid',  text: 'balanced' };
  return                { cls: 'high', text: 'glycolytic-dominant' };
}

function generateId() {
  return 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/* ───────── Firestore: load + save ───────── */

async function loadSessions(user) {
  try {
    const doc = await db.collection('users').doc(user.uid).get();
    const data = doc.exists ? doc.data() : null;
    const esml = (data && data.esmetlab) || {};

    let sessions = Array.isArray(esml.sprintSessions) ? esml.sprintSessions.slice() : [];

    // Back-compat: if there's a legacy single .vlamax saved but no sessions
    // array, surface it as the one historical session.
    if (sessions.length === 0 && esml.vlamax && typeof esml.vlamax.value === 'number') {
      sessions = [{
        id:           'legacy-' + ((esml.vlamax.measured_at && esml.vlamax.measured_at.seconds) || Date.now()),
        value:        esml.vlamax.value,
        measured_at:  esml.vlamax.measured_at || null,
        inputs:       esml.vlamax.inputs || null,
      }];
    }

    state.sessions = sessions;
    render();
  } catch (e) {
    console.error('Sessions load failed:', e);
    state.sessions = [];
    render();
  }
}

async function saveSession(value, inputs) {
  const user = window.__esml && window.__esml.user;
  if (!user) throw new Error('Sign in required.');

  const measured_at = firebase.firestore.Timestamp.now();
  const session = {
    id: generateId(),
    value,
    measured_at,
    inputs,
  };

  // newest-last for chronological ordering; render flips visually
  const newSessions = [...state.sessions, session];

  await db.collection('users').doc(user.uid).set({
    esmetlab: {
      vlamax: {
        value,
        measured_at: firebase.firestore.FieldValue.serverTimestamp(),
        inputs,
      },
      sprintSessions: newSessions,
    },
  }, { merge: true });

  state.sessions = newSessions;
  state.newFormOpen = false;
  render();
}

/* ───────── New-session form (inline) ───────── */

function newFormHTML() {
  // Prefill from the latest existing session if available
  const latest = state.sessions[state.sessions.length - 1];
  const inp = (latest && latest.inputs) || { La_pre: 1.4, La_peak_post: 11.0, duration_s: 15 };

  return `
    <div class="new-session-card" id="new-session-card">
      <div class="new-session-h">
        <div class="h-title">◈ New sprint session</div>
        <button type="button" class="btn ghost" id="ns-cancel" style="padding:7px 14px;font-size:12px">Cancel</button>
      </div>
      <p class="new-session-sub">
        Warm up at least 10 minutes. Take a pre-sprint lactate sample.
        Perform an all-out 15-second sprint. Sample
        <strong>immediately upon finishing</strong>, then at
        <strong>1, 2, and 3 minutes</strong>, then every 2 minutes — but only
        if lactate is still rising. The moment a reading drops below the
        previous one, you've passed peak: enter the highest reading.
        <a href="#" data-howto-sprint-protocol style="color:var(--cyan)">Full protocol →</a> &nbsp;·&nbsp;
        <a href="#" data-howto-measure style="color:var(--cyan)">How do I measure lactate? →</a>
      </p>
      <div class="grid-3">
        <label class="field">
          <span class="lab">Pre-sprint lactate (mmol/L)</span>
          <input type="number" id="ns-la-pre" step="0.1" min="0" max="5" value="${inp.La_pre}">
          <span class="hint">Typical resting / warmup: 0.8–1.8</span>
        </label>
        <label class="field">
          <span class="lab">Peak post-sprint lactate (mmol/L)</span>
          <input type="number" id="ns-la-post" step="0.1" min="2" max="30" value="${inp.La_peak_post}">
          <span class="hint">Highest reading across your post-sprint samples</span>
        </label>
        <label class="field">
          <span class="lab">Sprint duration (s)</span>
          <input type="number" id="ns-dur" step="1" min="10" max="30" value="${inp.duration_s}">
          <span class="hint">Standard protocol: 15 s</span>
        </label>
      </div>
      <div class="new-session-result" id="ns-result"></div>
      <div class="new-session-actions">
        <button type="button" class="btn primary" id="ns-save">Save session</button>
      </div>
    </div>
  `;
}

function wireNewForm() {
  const liveRecalc = () => {
    const inputs = {
      La_pre:       +$('#ns-la-pre').value,
      La_peak_post: +$('#ns-la-post').value,
      duration_s:   +$('#ns-dur').value,
      // t_PCr_s left at the library default — not exposed in the UI
    };
    const r = computeVLamax(inputs);
    if (!isFinite(r.VLamax) || r.glycolytic_time_s <= 0) {
      $('#ns-result').innerHTML = '<div class="vlc-result-empty" style="font-family:var(--mono);font-size:12px;color:var(--muted2);padding:12px 14px;background:var(--panel2);border-radius:8px;border:1px dashed var(--border2)">Enter all three values to see your VLamax.</div>';
      return;
    }
    const ph = phenotype(r.VLamax);
    const warnHtml = r.warnings.length
      ? '<div style="font-size:12px;color:var(--gold);margin-top:8px">⚠ ' + r.warnings.join(' ') + '</div>'
      : '';
    $('#ns-result').innerHTML = `
      <div class="new-session-result-box">
        <div class="new-session-result-label">YOUR VLAMAX</div>
        <div class="new-session-result-val">${r.VLamax.toFixed(3)}<span class="unit">mmol·L⁻¹·s⁻¹</span></div>
        <div style="font-size:12px;color:var(--muted2);margin-top:6px">${ph.text} profile</div>
        ${warnHtml}
      </div>
    `;
  };

  ['ns-la-pre', 'ns-la-post', 'ns-dur'].forEach((id) =>
    $('#' + id).addEventListener('input', liveRecalc)
  );

  $('#ns-cancel').addEventListener('click', () => {
    state.newFormOpen = false;
    render();
  });

  $('#ns-save').addEventListener('click', async () => {
    const inputs = {
      La_pre:       +$('#ns-la-pre').value,
      La_peak_post: +$('#ns-la-post').value,
      duration_s:   +$('#ns-dur').value,
    };
    const r = computeVLamax(inputs);
    if (!isFinite(r.VLamax) || r.glycolytic_time_s <= 0) {
      alert('Enter valid pre/post lactate values and a sprint duration above 3.5 seconds.');
      return;
    }
    const btn = $('#ns-save');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await saveSession(r.VLamax, inputs);
    } catch (e) {
      console.error(e);
      alert('Save failed: ' + e.message);
      btn.disabled = false; btn.textContent = 'Save session';
    }
  });

  // Wire the inline "Full protocol" + "How do I measure lactate?" links
  wireHowToMeasureTriggers();
  wireSprintProtocolTriggers();

  // Initial render of the result
  liveRecalc();
}

/* ───────── Sessions list render ───────── */

function sessionCardHTML(s, isLatest) {
  const inp = s.inputs || {};
  const inputsLine = (inp.La_pre != null && inp.La_peak_post != null && inp.duration_s != null)
    ? `Pre ${inp.La_pre} → Peak ${inp.La_peak_post} mmol/L · ${inp.duration_s}s sprint`
    : '';
  const latestPill = isLatest ? '<span class="latest-pill">Latest · active</span>' : '';
  return `
    <div class="sess-card ${isLatest ? 'latest' : ''}">
      <div>
        <div class="sess-card-date">${fmtDate(s.measured_at)} ${latestPill}</div>
      </div>
      <div class="sess-card-val">${(+s.value).toFixed(3)}<span class="unit">mmol·L⁻¹·s⁻¹</span></div>
      ${inputsLine ? `<div class="sess-card-meta">${inputsLine}</div>` : ''}
    </div>
  `;
}

function sessionsPanelHTML() {
  const sessions = state.sessions;
  if (sessions.length === 0) {
    return `
      <div class="panel">
        <div class="sess-panel-h">
          <div class="panel-h">Your sprint sessions</div>
        </div>
        <div class="sess-empty">
          <p>You haven't saved a sprint session yet. Run your first one to see your
          VLamax and unlock the full Lactate Step Test.</p>
          <button type="button" class="btn primary" id="open-new-session">+ Start your first session</button>
        </div>
      </div>
    `;
  }

  // Newest first in the visible list
  const reversed = [...sessions].reverse();
  const latestId = sessions[sessions.length - 1].id;

  return `
    <div class="panel">
      <div class="sess-panel-h">
        <div class="panel-h">Your sprint sessions</div>
        <button type="button" class="btn primary" id="open-new-session" style="padding:9px 18px;font-size:13px">+ New session</button>
      </div>
      <div class="sess-list">
        ${reversed.map((s) => sessionCardHTML(s, s.id === latestId)).join('')}
      </div>
      <div class="sess-foot">The most recent session is what the Lactate Step Test uses as your active VLamax.</div>
    </div>
  `;
}

/* ───────── Top-level render ───────── */

function render() {
  const root = $('#sprint-root');
  let html = '';
  if (state.newFormOpen) html += newFormHTML();
  html += sessionsPanelHTML();
  root.innerHTML = html;

  if (state.newFormOpen) wireNewForm();

  const openBtn = $('#open-new-session');
  if (openBtn) {
    openBtn.addEventListener('click', () => {
      state.newFormOpen = true;
      render();
      // Scroll the new form into view smoothly
      const card = $('#new-session-card');
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
}

/* ───────── Init ───────── */

// Wire the page-level protocol buttons
wireHowToMeasureTriggers();
wireSprintProtocolTriggers();

// Load sessions once auth is ready
window.addEventListener('esml-auth', (ev) => loadSessions(ev.detail.user));
if (window.__esml && window.__esml.user) loadSessions(window.__esml.user);

// First paint — empty list shell so something appears before auth resolves
render();
