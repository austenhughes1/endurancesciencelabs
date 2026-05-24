/*
 * Shared "upload access required" paywall.
 *
 * Rendered in place of the tool UI when a signed-in user does NOT have an
 * active upload entitlement (single / yearly / lifetime). Admins always
 * pass through.
 *
 * Usage:
 *   import { wireUploadPaywall } from '../js/ui/upload-paywall.js';
 *   wireUploadPaywall({
 *     toolName: 'Sprint VLamax Test',
 *     appEl:    '#app',
 *     paywallEl:'#esml-paywall',
 *   });
 *
 * Reads entitlement live via esLabs.onPassChange. Shows the paywall card
 * when no access; hides it and reveals #app when access is granted (or the
 * user is admin).
 */

const PAYWALL_HTML = `
<nav class="eslabs-nav" data-paywall-nav></nav>
<div class="page">
  <p style="margin-bottom:12px"><a href="/esmetaboliclab/">← All tools</a></p>
  <div class="paywall-card">
    <div class="section-label" style="margin-bottom:18px">◆ Upload access required</div>
    <h1 class="paywall-h">Lab-level metabolic profiling — <em>without the lab</em>.</h1>
    <p>Upload your own blood-lactate data and get the full picture: VO₂max,
       VLamax, MLSS, LT1, Fatmax, training zones, and a fueling strategy in
       g/min — same Mader / Heck model used by INSCYD and the sports-science
       labs, pinned to your actual physiology. Upload access powers
       <em>{{TOOL}}</em> and is a paid feature.</p>
    <div class="paywall-tiers">
      <span class="paywall-tier-chip"><strong>$30</strong> single session · 7-day window</span>
      <span class="paywall-tier-chip"><strong>$60/yr</strong> unlimited uploads · auto-renew</span>
      <span class="paywall-tier-chip"><strong>$90</strong> lifetime · pays for itself in year 2</span>
    </div>
    <p>Pick a tier on the pricing page — or, if you'd rather a coach run the
       full protocol with you in person (we bring the meter), book the $145
       in-person session.</p>
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:22px">
      <a class="btn primary" href="/esmetaboliclab/pricing/">See pricing →</a>
      <a class="btn" href="/esmetaboliclab/power-profile/">Try the free power-only profile instead →</a>
    </div>
  </div>
</div>
`;

export function wireUploadPaywall(opts) {
  opts = opts || {};
  const toolName  = opts.toolName  || 'this tool';
  const appSel    = opts.appEl     || '#app';
  const paywallSel= opts.paywallEl || '#esml-paywall';

  const paywall = document.querySelector(paywallSel);
  const app     = document.querySelector(appSel);
  if (!paywall || !app) {
    console.warn('upload-paywall: missing paywall or app element');
    return;
  }

  paywall.innerHTML = PAYWALL_HTML.replace('{{TOOL}}', escapeHtml(toolName));
  paywall.style.display = 'none';
  // Mount nav into the paywall's nav slot
  const navEl = paywall.querySelector('[data-paywall-nav]');
  if (navEl) {
    const navHost = document.createElement('div');
    navHost.id = 'esml-paywall-nav';
    navEl.replaceWith(navHost);
    window.esLabs.mountNav('#esml-paywall-nav', { active: 'esmetlab' });
  }

  let lastState = null;
  function render() {
    const user = window.esLabs.user;
    const pass = window.esLabs.getPassState();
    const isAdmin = !!(user && user.uid === window.esLabs.ADMIN_UID);
    const hasAccess = isAdmin || (pass && pass.metlab && pass.metlab.uploadAccess);

    let next;
    if (!user)            next = 'gate';      // gate handles its own UI
    else if (hasAccess)   next = 'app';
    else                  next = 'paywall';

    if (next === lastState) return;
    lastState = next;

    // NOTE: must use 'block' (not '') because the host page has a CSS rule
    // `#app { display: none; }` in its <style> block that overrides an
    // empty inline declaration. Setting an explicit value beats the CSS.
    if (next === 'app') {
      app.style.display = 'block';
      paywall.style.display = 'none';
    } else if (next === 'paywall') {
      app.style.display = 'none';
      paywall.style.display = 'block';
    } else {
      app.style.display = 'none';
      paywall.style.display = 'none';
    }
  }

  window.esLabs.onAuthChange(render);
  window.esLabs.onPassChange(render);
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
