/*
 * Reusable "How to run a Sprint VLamax test" modal.
 *
 * Protocol grounded in:
 *   Mader A, Heck H. — A theory of the metabolic origin of the "anaerobic
 *     threshold." Int J Sports Med 1986;7 Suppl 1:45–65.
 *   Mader A. — Glycolysis and oxidative phosphorylation as a function of
 *     cytosolic phosphorylation state… Eur J Appl Physiol 2003;88:317–338.
 *   Quittmann OJ, Abel T, Albracht K, Strüder HK. — Reliability of muscular
 *     activation patterns and the determination of vLamax during maximal
 *     sprint cycling. Eur J Appl Physiol 2020;120:1391–1402.
 *   Quittmann et al. — Reliability of power output, maximal rate of capillary
 *     blood lactate accumulation, and phosphagen contribution time following
 *     15-s sprint cycling in amateur cyclists. PMC11116165 (2024).
 *
 * The sampling schedule below (1, 3, 5, 7 min then every 2 min until La
 * drops ≥ 1 mmol/L from the high) is the consensus modern protocol — not
 * the older "3, 5, 7, 9" schedule which can miss athletes whose peak
 * arrives at 1 min.
 */

const MODAL_ID = 'esml-howto-sprint-modal-root';

const MODAL_HTML = `
<div class="esml-modal-overlay">
  <div class="esml-modal" role="dialog" aria-modal="true">
    <button class="esml-modal-close" type="button" aria-label="Close">×</button>
    <div class="esml-modal-body">
      <div class="section-label" style="margin-bottom:18px">◈ Sprint VLamax protocol</div>
      <h2 class="esml-modal-title">How to run a Sprint VLamax test</h2>
      <p class="esml-modal-lede">
        A single 15-second all-out sprint, with a blood-lactate sample before
        and several after, tells us how fast your muscles can pump lactate into
        your bloodstream at maximum glycolytic effort — your VLamax. Plan for
        <strong>30 minutes</strong> from warm-up to the last sample.
      </p>

      <h3 class="esml-modal-h3">What you need</h3>
      <ul class="esml-checklist">
        <li>Handheld lactate meter, strips, lancets, alcohol wipes, gauze — see the <a href="#" data-howto-measure style="color:var(--cyan)">measurement protocol</a></li>
        <li>An effort medium: stationary ergometer for cycling, treadmill or flat track for running</li>
        <li>Stopwatch with a clear 15-second timer (or a partner counting down)</li>
        <li>Fan + water + towel</li>
        <li>A partner is ideal — sampling lactate while you're recovering is much easier with a second person</li>
        <li>30 minutes uninterrupted</li>
      </ul>

      <div class="warn" style="margin-bottom:18px">
        ⚠ Read the <a href="#" data-howto-measure style="color:inherit;text-decoration:underline">measurement protocol</a>
        first. Sweat on the lancing site, or a strip touching skin instead of
        the blood drop, will give you a number that <em>looks</em> real but isn't.
      </div>

      <h3 class="esml-modal-h3">1 — Warm up</h3>
      <ol class="esml-steps">
        <li><strong>10–15 minutes</strong> of easy continuous effort — spinning at low wattage if cycling, easy jogging if running. Goal: get loose and circulated, not fatigued.</li>
        <li>Finish the warm-up with <strong>2–3 short accelerations</strong> (5–10 sec each, building to near-maximal speed, with 30 seconds easy between). These prime your neuromuscular system without depleting glycogen.</li>
        <li>Recover 1–2 minutes at very easy effort, then come to a stop and prepare for the pre-sprint sample.</li>
      </ol>

      <h3 class="esml-modal-h3">2 — Pre-sprint lactate sample</h3>
      <ol class="esml-steps">
        <li><strong>Take a capillary lactate sample</strong> after the warm-up is complete and you've been recovered for 1–2 minutes. Expected range: 0.8–1.8 mmol/L. This is your baseline.</li>
        <li><strong>Do not skip this sample.</strong> Your VLamax is computed as <em>(peak − baseline) / glycolytic time</em>, so the baseline matters directly to the result.</li>
      </ol>

      <h3 class="esml-modal-h3">3 — Pre-prep your sampling finger</h3>
      <div class="warn" style="margin-bottom:14px">
        ⚠ <strong>Do this before the sprint, not after.</strong> Setting up
        sampling gear after the sprint costs you 60+ seconds — long enough to
        miss the peak in rapid-clearance athletes whose peak arrives at the
        end of the sprint or within 30 seconds.
      </div>
      <ol class="esml-steps">
        <li>Choose a different finger from the one you used for the pre-sample.</li>
        <li>Wipe with alcohol; let it fully air-dry; towel off any residual moisture or sweat.</li>
        <li>Load a fresh test strip into the meter; ready a lance and gauze.</li>
        <li>Now perform the sprint.</li>
      </ol>

      <h3 class="esml-modal-h3">4 — The 15-second all-out sprint</h3>
      <ol class="esml-steps">
        <li>Position yourself for the sprint — on the ergometer with appropriate resistance, or at the start of a flat sprint zone (track straight, treadmill at speed already running for a flying start).</li>
        <li>On "go", attack <strong>maximally for exactly 15 seconds</strong>. Effort must be all-out from the first second — not paced. The whole point is to push glycolysis to its ceiling.</li>
        <li>Stop at 15 seconds. <strong>Do not "cool down" actively.</strong> Sit or stand quietly — active recovery accelerates lactate clearance and lowers your measured peak. Walk only if you feel light-headed.</li>
      </ol>

      <h3 class="esml-modal-h3">5 — Post-sprint lactate sampling</h3>
      <div class="warn" style="margin-bottom:14px">
        ⚠ <strong>Take your first sample within 30 seconds of finishing.</strong>
        Some athletes peak essentially at the end of the sprint and fall fast
        — if your first sample is at 1 minute, you may have already missed it.
        This is why step 3 (prepping the sampling finger beforehand) matters.
      </div>
      <p class="esml-modal-p">
        Blood lactate continues to climb after the sprint ends because lactate
        has to diffuse out of muscle into capillary blood — but capillary
        perfusion at the working muscle is at its highest <em>during</em> the
        sprint, so the leading edge of the lactate wave reaches your fingertip
        very quickly in some athletes. The timing of peak varies widely:
      </p>
      <ul class="esml-checklist">
        <li><strong>End of sprint to 1 minute</strong> — athletes with rapid lactate clearance, lower-VLamax phenotypes, or smaller working-muscle mass</li>
        <li><strong>1–3 minutes</strong> — common for trained cyclists and runners with moderate VLamax</li>
        <li><strong>3–5 minutes</strong> — typical for sprint-trained athletes with high VLamax</li>
        <li><strong>5–7 minutes</strong> — occasionally seen, especially with very high muscle mass</li>
      </ul>
      <p class="esml-modal-p">
        Sample at the <strong>end of the sprint (within 30 seconds)</strong>,
        then at <strong>1, 3, 5, and 7 minutes</strong>, then every 2 minutes
        after that. Keep sampling until your latest reading has dropped by at
        least <strong>1 mmol/L</strong> below your highest — only then can you
        be confident you've captured the true peak. <strong>The peak is
        whichever sample is highest</strong>, regardless of when it landed.
      </p>

      <h3 class="esml-modal-h3">6 — Enter your peak</h3>
      <ol class="esml-steps">
        <li>Take the <strong>highest</strong> reading from your post-sprint samples — whether it landed at 30 seconds or 5 minutes.</li>
        <li>Record it as "Peak post-sprint lactate" in the form below.</li>
        <li>Save the session — it becomes your active VLamax for the Lactate Step Test.</li>
      </ol>

      <h3 class="esml-modal-h3">Common pitfalls</h3>
      <ul class="esml-checklist">
        <li><strong>First sample taken too late.</strong> If your first post-sprint sample is at 1 minute or later, you may have already missed the peak — especially if your physiology clears lactate quickly. Pre-prep the finger and take a sample within 30 seconds of finishing.</li>
        <li><strong>Sampling gear not ready before the sprint.</strong> Fumbling with alcohol wipes, strips, and lances after the sprint ends costs you the early-peak window. Prep everything during the warm-up.</li>
        <li><strong>Active cool-down between sprint and sampling.</strong> Even gentle spinning or walking accelerates clearance and lowers the measured peak. Sit or stand still.</li>
        <li><strong>Sprint wasn't truly all-out.</strong> Pacing the 15 seconds defeats the purpose — VLamax requires glycolysis at its ceiling. If your post-sprint lactate barely budges from baseline, the effort wasn't maximal.</li>
        <li><strong>Sweat or moisture on the lancing site.</strong> Towel off and alcohol-wipe before each sample. See the <a href="#" data-howto-measure style="color:var(--cyan)">measurement protocol</a>.</li>
        <li><strong>Stopping sampling too early.</strong> If your latest reading is still climbing or steady, take another. Only stop when you've seen a clear drop of ≥1 mmol/L from the high point.</li>
        <li><strong>Insufficient warm-up.</strong> A cold sprint produces a smaller lactate response. Don't skip the warm-up.</li>
      </ul>

      <p class="esml-modal-foot">
        Not medical advice. Maximum-effort sprinting carries cardiovascular
        risk. Consult a physician before performing a maximal exercise test if
        you have any history of cardiac, pulmonary, or metabolic disease. Stop
        immediately if you experience chest pain, dizziness, abnormal shortness
        of breath, or any other unusual symptom.
      </p>
    </div>
  </div>
</div>
`;

export function showSprintProtocolModal() {
  if (document.getElementById(MODAL_ID)) return;

  const root = document.createElement('div');
  root.id = MODAL_ID;
  root.innerHTML = MODAL_HTML;
  document.body.appendChild(root);

  // Cross-link [data-howto-measure] inside this modal to the other modal
  root.querySelectorAll('[data-howto-measure]').forEach((el) => {
    el.addEventListener('click', async (e) => {
      e.preventDefault();
      const { showHowToMeasureModal } = await import('./how-to-measure.js');
      showHowToMeasureModal();
    });
  });

  const overlay  = root.querySelector('.esml-modal-overlay');
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
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  closeBtn.focus({ preventScroll: true });
}

/**
 * Wire any element with `data-howto-sprint-protocol` to open the modal.
 */
export function wireSprintProtocolTriggers() {
  document.querySelectorAll('[data-howto-sprint-protocol]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      showSprintProtocolModal();
    });
  });
}
