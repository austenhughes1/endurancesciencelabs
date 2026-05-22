/*
 * Reusable "How to measure blood lactate" modal.
 *
 * Used on any esMetabolicLab page that needs to explain the protocol
 * (Sprint VLamax Test, Lactate Step Test, etc.). Open via `showHowToMeasureModal()`.
 *
 * The modal injects itself into <body>, locks body scroll while open,
 * and tears itself down on close (Escape, backdrop click, or X button).
 */

const MODAL_ID = 'esml-howto-modal-root';

const MODAL_HTML = `
<div class="esml-modal-overlay">
  <div class="esml-modal" role="dialog" aria-labelledby="esml-howto-title" aria-modal="true">
    <button class="esml-modal-close" type="button" aria-label="Close">×</button>
    <div class="esml-modal-body">
      <div class="section-label" style="margin-bottom:18px">◆ Protocol guide</div>
      <h2 id="esml-howto-title" class="esml-modal-title">How to measure blood lactate</h2>
      <p class="esml-modal-lede">
        A handheld lactate meter reads a small drop of blood from your fingertip,
        similar to a glucometer. Each sample takes about 15 seconds. The drop you
        use is tiny — barely visible — and most athletes find the lance feels like
        a quick pinch.
      </p>

      <h3 class="esml-modal-h3">What you'll need</h3>
      <ul class="esml-checklist">
        <li>A handheld lactate meter — we recommend the Lactate Plus</li>
        <li>Test strips compatible with your meter</li>
        <li>A lancing device and sterile single-use lancets</li>
        <li>Alcohol wipes</li>
        <li>Gauze or clean tissue</li>
      </ul>
      <a class="btn primary" href="https://lactateplusmeter.store/?product=lactate-plus-blood-lactate-measuring-meter"
         target="_blank" rel="noopener">Buy a Lactate Plus meter →</a>

      <h3 class="esml-modal-h3">Protocol — per sample</h3>
      <div class="warn" style="margin-bottom:14px">
        ⚠ <strong>The lancing site must be completely dry.</strong> Any sweat
        or water on the skin can dramatically skew the reading. If you're
        testing mid-session or just warmed up, towel off and wipe with alcohol
        before drawing the sample — and let the alcohol fully evaporate too.
      </div>
      <ol class="esml-steps">
        <li>Wipe your fingertip thoroughly with alcohol and let it air-dry. Confirm there's no remaining sweat, alcohol, or moisture before continuing.</li>
        <li>Lance the side of the fingertip — it's less sensitive than the pad and stays usable across multiple samples.</li>
        <li>Wipe the first drop away with gauze; surface fluid can throw off the reading. Encourage a fresh second drop by gently milking the finger.</li>
        <li>Touch <em>only</em> the tip of the test strip to the blood drop — never let the strip contact your skin. The strip wicks the blood up on its own.</li>
        <li>Wait for the reading — typically about 13 seconds on a Lactate Plus.</li>
      </ol>

      <div class="esml-modal-callout">
        <h3 class="esml-modal-h3" style="margin-top:0">Prefer to do this in person?</h3>
        <p class="esml-modal-p">
          If you're in the Boulder or Denver area, the Endurance Science Labs coaches
          can run the protocol with you — equipment, technique, and a walk-through
          of your results, all in one session.
        </p>
        <a class="btn primary" href="/coaching/">Request an in-person session →</a>
      </div>

      <p class="esml-modal-foot">
        Not medical advice. The protocols here are for educational and athletic
        training purposes only. If you take blood thinners or have a clotting
        condition, consult a healthcare professional before fingertip sampling.
      </p>
    </div>
  </div>
</div>
`;

/**
 * Open the How-to-measure modal. Idempotent — calling while open is a no-op.
 */
export function showHowToMeasureModal() {
  if (document.getElementById(MODAL_ID)) return;

  const root = document.createElement('div');
  root.id = MODAL_ID;
  root.innerHTML = MODAL_HTML;
  document.body.appendChild(root);

  const overlay = root.querySelector('.esml-modal-overlay');
  const closeBtn = root.querySelector('.esml-modal-close');

  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';

  const close = () => {
    root.remove();
    document.body.style.overflow = prevOverflow;
    window.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  window.addEventListener('keydown', onKey);
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    // Only close on backdrop click — not click bubbling from inside the modal card
    if (e.target === overlay) close();
  });

  // Move keyboard focus to the close button for accessibility
  closeBtn.focus({ preventScroll: true });
}

/**
 * Wire any element with `data-howto-measure` (e.g. a button) to open the modal.
 * Call once on page init.
 */
export function wireHowToMeasureTriggers() {
  document.querySelectorAll('[data-howto-measure]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      showHowToMeasureModal();
    });
  });
}
