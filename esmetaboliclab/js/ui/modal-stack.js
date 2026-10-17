/*
 * One modal manager for every esMetabolicLab dialog (how-to guides, the
 * in-person request, confirms). A thin adapter over esLabs.openDialog
 * (shared/site.js), which owns the dialog semantics, the Tab trap and
 * focus return; this file adds the stack:
 *   - Escape closes only the top modal (each overlay handles its own key);
 *   - body scroll is locked while any modal is open and restored only when
 *     the last one closes;
 *   - closeModal(root, reason) removes the modal and reports why it closed.
 * Falls back to a local Tab trap / Escape handler if site.js is missing.
 *
 *   const entry = pushModal(root, { initialFocus, onClose: (reason) => … });
 *   closeModal(root, 'cancel');
 */

const stack = [];
let savedOverflow = '';
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function hasSharedDialogs() {
  return !!(window.esLabs && typeof window.esLabs.openDialog === 'function');
}

// Fallback only (no site.js): Escape + Tab trap for the top modal.
function onFallbackKey(e) {
  const top = stack[stack.length - 1];
  if (!top) return;
  if (e.key === 'Escape' && top.dismissable !== false) {
    e.preventDefault(); e.stopPropagation();
    closeModal(top.root, 'escape');
    return;
  }
  if (e.key !== 'Tab') return;
  const f = [...top.panel.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1], a = document.activeElement;
  if (!top.panel.contains(a)) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && a === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
}

/**
 * Register a modal that is already in the DOM.
 * @param {HTMLElement} root   element appended to <body> (removed on close)
 * @param {Object} [opts]
 * @param {HTMLElement} [opts.initialFocus]
 * @param {Function}    [opts.onClose]      called with the close reason
 * @param {boolean}     [opts.dismissable]  false = Escape does nothing
 */
export function pushModal(root, { initialFocus, onClose, dismissable } = {}) {
  const overlay = root.matches('.esml-modal-overlay') ? root : (root.querySelector('.esml-modal-overlay') || root);
  const panel = overlay.querySelector('.esml-modal') || overlay;
  if (!stack.length) {
    savedOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    if (!hasSharedDialogs()) document.addEventListener('keydown', onFallbackKey, true);
  }
  const opener = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
  const entry = { root, overlay, panel, opener, onClose, dismissable };
  stack.push(entry);
  if (hasSharedDialogs()) {
    window.esLabs.openDialog(overlay, {
      trigger: opener,
      initialFocus,
      dismissable: dismissable !== false,
      onClose: () => closeModal(root, 'escape'),
    });
  } else {
    const target = initialFocus || panel.querySelector(FOCUSABLE);
    if (target) target.focus({ preventScroll: true });
  }
  return entry;
}

/** Close (and remove) a modal registered with pushModal. */
export function closeModal(root, reason) {
  const i = stack.findIndex((e) => e.root === root);
  if (i < 0) return;
  const [entry] = stack.splice(i, 1);
  if (hasSharedDialogs()) window.esLabs.closeDialog(entry.overlay);   // returns focus to the trigger
  else if (entry.opener && document.contains(entry.opener)) entry.opener.focus({ preventScroll: true });
  root.remove();
  if (!stack.length) {
    document.body.style.overflow = savedOverflow;
    document.removeEventListener('keydown', onFallbackKey, true);
  }
  if (typeof entry.onClose === 'function') {
    try { entry.onClose(reason); } catch (e) { console.error(e); }
  }
}
