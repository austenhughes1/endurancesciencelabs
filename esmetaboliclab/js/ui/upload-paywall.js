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
// Grace period before redirecting a no-access user. Firestore's payment
// and subscription snapshots can take ~hundreds of ms to deliver, and a
// paying user briefly looks no-access on first paint. If access arrives
// within this window we cancel the redirect.
const REDIRECT_GRACE_MS = 1500;

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
  // The paywall slot is no longer rendered into; just keep it hidden in
  // case existing CSS reserves space for it.
  paywall.style.display = 'none';

  let redirectTimer = null;
  let lastState = null;
  function render() {
    const user = window.esLabs.user;
    const pass = window.esLabs.getPassState();
    const isAdmin = !!(user && user.uid === window.esLabs.ADMIN_UID);
    const hasAccess = isAdmin || (pass && pass.metlab && pass.metlab.uploadAccess);

    let next;
    if (!user)          next = 'gate';   // gate handles its own UI
    else if (hasAccess) next = 'app';
    else                next = 'redirect';

    if (next !== 'redirect' && redirectTimer) {
      clearTimeout(redirectTimer);
      redirectTimer = null;
    }
    if (next === lastState) return;
    lastState = next;

    // NOTE: must use 'block' (not '') because the host page has a CSS rule
    // `#app { display: none; }` in its <style> block that overrides an
    // empty inline declaration. Setting an explicit value beats the CSS.
    if (next === 'app') {
      app.style.display = 'block';
    } else if (next === 'redirect') {
      app.style.display = 'none';
      if (!redirectTimer) {
        redirectTimer = setTimeout(function() {
          window.location.replace(PRICING_URL);
        }, REDIRECT_GRACE_MS);
      }
    } else {
      app.style.display = 'none';
    }
  }

  window.esLabs.onAuthChange(render);
  window.esLabs.onPassChange(render);
}
