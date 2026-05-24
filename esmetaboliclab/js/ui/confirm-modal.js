/*
 * Reusable confirm modal. Returns a Promise that resolves to true (confirmed)
 * or false (cancelled / dismissed). Matches the site's modal styling so it
 * doesn't look like a browser-default dialog.
 *
 *   const ok = await showConfirmModal({
 *     title: 'Delete this session?',
 *     body: 'This cannot be undone.',
 *     confirmLabel: 'Delete',
 *     cancelLabel: 'Keep it',
 *     danger: true,
 *   });
 */

const MODAL_ID = 'esml-confirm-modal-root';

export function showConfirmModal(opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    // Don't stack multiple confirm modals
    if (document.getElementById(MODAL_ID)) { resolve(false); return; }

    const title        = opts.title || 'Are you sure?';
    const body         = opts.body || '';
    const confirmLabel = opts.confirmLabel || 'Confirm';
    const cancelLabel  = opts.cancelLabel  || 'Cancel';
    const isDanger     = !!opts.danger;
    const okClass      = isDanger ? 'danger' : 'primary';

    const root = document.createElement('div');
    root.id = MODAL_ID;
    root.innerHTML =
      '<div class="esml-modal-overlay">' +
        '<div class="esml-modal" role="dialog" aria-modal="true" style="max-width:480px">' +
          '<div class="esml-modal-body">' +
            '<h2 class="esml-modal-title" style="font-size:22px;margin-bottom:10px">' + title + '</h2>' +
            (body ? '<p class="esml-modal-lede" style="margin-bottom:0">' + body + '</p>' : '') +
            '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:24px;flex-wrap:wrap">' +
              '<button type="button" class="btn ghost" data-confirm-cancel>' + cancelLabel + '</button>' +
              '<button type="button" class="btn ' + okClass + '" data-confirm-ok>' + confirmLabel + '</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(root);

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const teardown = (result) => {
      root.remove();
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
      resolve(!!result);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') teardown(false);
      else if (e.key === 'Enter') teardown(true);
    };
    window.addEventListener('keydown', onKey);

    root.querySelector('[data-confirm-cancel]').addEventListener('click', () => teardown(false));
    root.querySelector('[data-confirm-ok]').addEventListener('click',     () => teardown(true));
    const overlay = root.querySelector('.esml-modal-overlay');
    overlay.addEventListener('click', (e) => { if (e.target === overlay) teardown(false); });

    // Keyboard focus on cancel by default — safer for destructive actions
    root.querySelector('[data-confirm-cancel]').focus({ preventScroll: true });
  });
}
