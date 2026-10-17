/*
 * Shared upload-access gate.
 *
 * When a signed-in user lands on an upload-gated tool without an active
 * entitlement, send them straight to the pricing page rather than showing
 * an intermediary "you need upload access" card that just bounces them
 * there with an extra click. Admins always pass through.
 *
 * Usage:
 *   import { wireUploadPaywall } from '../js/ui/upload-paywall.js';
 *   wireUploadPaywall({
 *     toolName: 'Sprint VLamax Test',
 *     appEl:    '#app',
 *     paywallEl:'#esml-paywall',
 *   });
 *
 * Reads entitlement live via esLabs.onPassChange. Reveals #app when access
 * lands; redirects to /esmetaboliclab/pricing/ when it doesn't.
 */

const PRICING_URL = '/esmetaboliclab/pricing/';

// Has the account's access state finished loading? site.js exposes
// entitlementsLoaded (user doc + payments + subscriptions each delivered
// once); older builds only had subscriptionsLoaded.
function accessKnown(pass) {
  if (!pass) return false;
  return ('entitlementsLoaded' in pass) ? !!pass.entitlementsLoaded : !!pass.subscriptionsLoaded;
}

export function wireUploadPaywall(opts) {
  opts = opts || {};
  const appSel     = opts.appEl     || '#app';
  const paywallSel = opts.paywallEl || '#esml-paywall';

  const paywall = document.querySelector(paywallSel);
  const app     = document.querySelector(appSel);
  if (!paywall || !app) {
    console.warn('upload-paywall: missing paywall or app element');
    return;
  }

  let redirectTimer = null;
  let lastState = null;
  // Lapsed access: opts.readOnlyCheck(user) → Promise<boolean> (e.g. "has
  // saved tests"). When true the tool opens read-only instead of redirecting.
  let roUid = null, roResult = null;   // null = not asked, 'pending', true/false
  function setReadOnly(on) {
    window.__esml = window.__esml || {};
    if (!!window.__esml.readOnly === on) return;
    window.__esml.readOnly = on;
    window.dispatchEvent(new CustomEvent('esml-readonly', { detail: { readOnly: on } }));
  }
  function render() {
    const user = window.esLabs.user;
    const pass = window.esLabs.getPassState();
    // isAdmin() checks the real signed-in account, so the admin keeps
    // upload access while acting as an athlete (esLabs.user is the
    // stand-in user in that case and wouldn't match ADMIN_UID).
    const isAdmin = window.esLabs.isAdmin();
    const hasAccess = isAdmin || (pass && pass.metlab && pass.metlab.uploadAccess);

    let next;
    if (!user)                   next = 'gate';      // gate handles its own UI
    else if (hasAccess)          next = 'app';
    else if (!accessKnown(pass)) next = 'checking';  // never redirect a slow-loading payer
    else                         next = 'redirect';

    if (next === 'redirect' && typeof opts.readOnlyCheck === 'function') {
      if (roUid !== user.uid) { roUid = user.uid; roResult = null; }
      if (roResult === null) {
        roResult = 'pending';
        Promise.resolve().then(() => opts.readOnlyCheck(user))
          .then((v) => { roResult = !!v; }, () => { roResult = false; })
          .then(render);
      }
      if (roResult === 'pending') next = 'checking';
      else if (roResult === true) next = 'readonly';
    }
    setReadOnly(next === 'readonly');

    if (next !== 'redirect' && redirectTimer) {
      clearTimeout(redirectTimer);
      redirectTimer = null;
    }
    if (next === lastState) return;
    lastState = next;

    // NOTE: must use 'block' (not '') because the host page has a CSS rule
    // `#app { display: none; }` in its <style> block that overrides an
    // empty inline declaration. Setting an explicit value beats the CSS.
    if (next === 'app' || next === 'readonly') {
      paywall.style.display = 'none';
      app.style.display = 'block';
    } else if (next === 'checking' || next === 'redirect') {
      app.style.display = 'none';
      paywall.style.display = 'block';
      paywall.innerHTML = '<div class="page"><div class="esl-loading" role="status"><span class="esl-spin" aria-hidden="true"></span>Checking your access…</div></div>';
      if (next === 'redirect' && !redirectTimer) {
        // Without the payments-loaded flag keep a longer grace after subscriptions load.
        const grace = ('entitlementsLoaded' in pass) ? 600 : 2500;
        redirectTimer = setTimeout(function () {
          window.location.replace(PRICING_URL + '?from=' + encodeURIComponent(opts.from || 'tool'));
        }, grace);
      }
    } else {
      app.style.display = 'none';
      paywall.style.display = 'none';
    }
  }

  window.esLabs.onAuthChange(render);
  window.esLabs.onPassChange(render);
}
