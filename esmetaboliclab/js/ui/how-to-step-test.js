/*
 * Reusable "How to run a lactate step test" modal.
 *
 * Two protocols (Cycling / Running) selected via tab at the top. Content is
 * grounded in the standard Heck/Mader 5-minute step-test family with the
 * Jones & Doust (1996) 1% treadmill-grade convention.
 *
 * Trigger any element with `data-howto-step-test` via wireStepTestTriggers().
 *
 * References:
 *   Heck H, Mader A, Hess G, et al. — Justification of the 4-mmol/L lactate
 *     threshold. Int J Sports Med 1985;6:117–130.
 *   Mader A, Heck H. — A theory of the metabolic origin of the anaerobic
 *     threshold. Int J Sports Med 1986;7 Suppl 1:45–65.
 *   Faude O, Kindermann W, Meyer T. — Lactate threshold concepts. Sports
 *     Med 2009;39:469–490.
 *   Jones AM, Doust JH. — A 1% treadmill grade most accurately reflects the
 *     energetic cost of outdoor running. J Sports Sci 1996;14:321–327.
 */

const MODAL_ID = 'esml-howto-step-test-modal-root';

const SHARED_HEAD = `
  <div class="section-label" style="margin-bottom:18px">◉ Test protocol</div>
  <h2 class="esml-modal-title">How to run a lactate step test</h2>
  <p class="esml-modal-lede">
    A lactate step test maps how your blood lactate climbs as your effort
    increases — from easy to all-out. The shape of that curve is what
    locates your aerobic threshold, your sustainable ceiling, and the
    intensity at which you burn fat fastest. Plan for <strong>35–50 minutes</strong>
    from warm-up to the last sample.
  </p>

  <h3 class="esml-modal-h3">What you need (both sports)</h3>
  <ul class="esml-checklist">
    <li>Handheld lactate meter, strips, lancets, alcohol wipes, gauze — see the <a href="#" data-howto-measure style="color:var(--cyan)">measurement protocol</a></li>
    <li>Stopwatch or structured workout file on your bike computer / treadmill</li>
    <li>Fan running at full speed; water within arm's reach</li>
    <li>Towel — fingertip moisture skews readings</li>
    <li>A partner / spotter ideal (handles sampling while you keep moving)</li>
    <li>35–50 minutes uninterrupted</li>
  </ul>

  <div class="warn" style="margin-bottom:18px">
    ⚠ Read the <a href="#" data-howto-measure style="color:inherit;text-decoration:underline">blood-lactate measurement protocol</a>
    first. Sweat or water on the lancing site, or a strip touching skin
    instead of the drop, will produce readings that look real but aren't.
  </div>

  <h3 class="esml-modal-h3">The universal rhythm: 5 minutes on, 1 minute sample</h3>
  <p class="esml-modal-p">
    Each stage is <strong>5 minutes</strong> at a fixed intensity — long enough
    that your blood lactate approaches a near-steady-state value at that
    effort. The <strong>1-minute break</strong> between stages is for sampling:
    wipe and lance the fingertip, capture the reading, and step back in.
  </p>
  <p class="esml-modal-p">
    You'll do <strong>4 to 6 stages</strong> total. The test ends when your
    post-stage lactate climbs above roughly <strong>6 mmol/L</strong>, OR
    you can't hold the next intensity for the full 5 minutes. To produce a
    clean fit, you need at least 3 stages below threshold AND at least one
    stage that's clearly above 4 mmol/L to anchor the upper end.
  </p>
`;

const CYCLING_PROTOCOL = `
  <h3 class="esml-modal-h3">Cycling — setup</h3>
  <ul class="esml-checklist">
    <li>Smart trainer or ergometer with a power meter accurate to ±2%</li>
    <li>ERG mode if your trainer supports it — eliminates drift</li>
    <li>Cooling fan at full speed and a bottle within reach</li>
    <li>Lactate kit + towel + alcohol on a stable surface within arm's reach</li>
  </ul>

  <h3 class="esml-modal-h3">Cycling — warm-up</h3>
  <ol class="esml-steps">
    <li>10–15 minutes easy spinning at ~100–150 W (whatever your typical recovery wattage is).</li>
    <li>3 × 30 seconds at a moderate effort (180–220 W), with 30 seconds easy between each. These "activations" prime your lactate system without fatiguing you.</li>
    <li>Take your resting lactate sample <strong>after</strong> the warm-up, seated and recovered for 1–2 minutes. This is your baseline.</li>
  </ol>

  <h3 class="esml-modal-h3">Cycling — the stages</h3>
  <ol class="esml-steps">
    <li><strong>Starting power.</strong> Begin at roughly 50–60% of your estimated MLSS, or about 80–100 W below your typical hard-tempo wattage. For most trained cyclists, <strong>150–180 W</strong>. Untrained: 100–120 W. Untrained athletes are better off starting on the low side; you can always cut the test if you reach threshold too early.</li>
    <li><strong>Hold each stage for 5 minutes</strong> at a steady cadence.</li>
    <li><strong>During the last 30 seconds</strong> of each stage, your partner preps the sampling site.</li>
    <li><strong>At the stage end</strong>, take a lactate sample within 30–60 seconds. Keep spinning easily (50–100 W) during the break so your legs don't lock up.</li>
    <li><strong>Step up by:</strong>
      <ul style="margin-top:8px;padding-left:0;list-style:none">
        <li style="padding:4px 0;color:var(--text)">• <strong>+30 W</strong> if FTP &gt; 250 W (fit / well-trained)</li>
        <li style="padding:4px 0;color:var(--text)">• <strong>+25 W</strong> if FTP 200–250 W</li>
        <li style="padding:4px 0;color:var(--text)">• <strong>+20 W</strong> if FTP &lt; 200 W (novice)</li>
      </ul>
    </li>
    <li>Repeat until you hit one of the stop criteria below.</li>
  </ol>

  <h3 class="esml-modal-h3">Cycling — when to stop</h3>
  <ul class="esml-checklist">
    <li>Post-stage lactate &gt; 6 mmol/L (you've crossed the upper anchor; you have what we need)</li>
    <li>You can't maintain the target power for the full 5 minutes</li>
    <li>Heart rate exceeds ~95% of max</li>
    <li>You've completed 6 stages</li>
  </ul>
  <p class="esml-modal-p">
    Your final stage should clearly exceed 4 mmol/L. Without that upper anchor
    the fit under-estimates VO₂max and MLSS.
  </p>
`;

const RUNNING_PROTOCOL = `
  <h3 class="esml-modal-h3">Running — setup</h3>
  <ul class="esml-checklist">
    <li>Treadmill with adjustable speed AND incline</li>
    <li><strong>Set incline to 1%</strong> for the entire test — mimics outdoor air resistance (Jones &amp; Doust 1996, the standard lab-physiology correction)</li>
    <li>Cooling fan at full speed and water within reach</li>
    <li>Lactate kit + towel + alcohol on a stable surface within arm's reach</li>
    <li>A partner is strongly recommended — sampling while you straddle the treadmill is fiddly solo</li>
  </ul>

  <h3 class="esml-modal-h3">Running — warm-up</h3>
  <ol class="esml-steps">
    <li>10 minutes easy jogging at ~6–8 km/h (≈ 7:30–10:00 per km, or 12:00–16:00 per mile).</li>
    <li>3 × 30 seconds at a moderate pace (1–2 km/h faster than easy), with 30 seconds easy between each.</li>
    <li>Take your resting lactate sample <strong>after</strong> the warm-up, walking or standing still for 1–2 minutes. This is your baseline.</li>
  </ol>

  <h3 class="esml-modal-h3">Running — the stages</h3>
  <ol class="esml-steps">
    <li><strong>Starting speed.</strong> Begin at a conversational pace — typically <strong>8–10 km/h</strong> (6:00–7:30/km) for trained runners. Slower for less trained. The first stage should feel almost too easy.</li>
    <li><strong>Hold each stage for 5 minutes</strong> at the set speed, on the 1% grade.</li>
    <li><strong>During the last 30 seconds</strong>, your partner preps the sampling site.</li>
    <li><strong>At the stage end</strong>, grip the handrails, straddle the belt (or use a quick-stop if your treadmill has one), and take a lactate sample within 30–60 seconds. Climb back on for the next stage.</li>
    <li><strong>Step up by:</strong>
      <ul style="margin-top:8px;padding-left:0;list-style:none">
        <li style="padding:4px 0;color:var(--text)">• <strong>+1.0 km/h</strong> for most runners</li>
        <li style="padding:4px 0;color:var(--text)">• <strong>+0.5 km/h</strong> for advanced / elite runners (gives more data points near threshold)</li>
      </ul>
      Keep the incline at 1%.
    </li>
    <li>Repeat until you hit one of the stop criteria below.</li>
  </ol>

  <h3 class="esml-modal-h3">Running — when to stop</h3>
  <ul class="esml-checklist">
    <li>Post-stage lactate &gt; 6 mmol/L</li>
    <li>You can't maintain the speed for the full 5 minutes</li>
    <li>Heart rate exceeds ~95% of max</li>
    <li>You've completed 6 stages</li>
  </ul>
  <p class="esml-modal-p">
    Your final stage should clearly exceed 4 mmol/L. Without that upper anchor
    the fit under-estimates VO₂max and MLSS.
  </p>
`;

const SHARED_FOOTER = `
  <h3 class="esml-modal-h3" style="margin-top:30px">Common pitfalls</h3>
  <ul class="esml-checklist">
    <li><strong>Sweaty fingertip.</strong> Towel off and alcohol-wipe each time. Even a trace of sweat can shift the reading by a full mmol/L.</li>
    <li><strong>Strip touching skin.</strong> The strip should touch only the blood drop. The strip wicks the sample up — pressing it to the finger introduces contamination.</li>
    <li><strong>Stages too short.</strong> 3-minute stages can work in a pinch but lactate hasn't reached steady state — numbers look more favourable than reality. 5 minutes is the standard.</li>
    <li><strong>Skipping stages.</strong> Each increment must be small enough that you collect 4–6 useful data points. Jumping intensities to save time leaves the curve under-determined.</li>
    <li><strong>Test cut short.</strong> If your last stage is below 4 mmol/L, the upper-end fit is sloppy. Push through one more stage if you have legs for it.</li>
    <li><strong>Drifting effort.</strong> Cycling: use ERG mode. Running: set the treadmill exactly — don't "feel out" the pace.</li>
  </ul>

  <p class="esml-modal-foot">
    Not medical advice. Maximum-effort exercise testing carries cardiovascular
    risk; consult a physician before performing a maximal exercise test if you
    have any history of cardiac, pulmonary, or metabolic disease. Stop
    immediately if you experience chest pain, dizziness, abnormal shortness of
    breath, or any other unusual symptom.
  </p>
`;

const MODAL_HTML = `
<div class="esml-modal-overlay">
  <div class="esml-modal" role="dialog" aria-modal="true">
    <button class="esml-modal-close" type="button" aria-label="Close">×</button>
    <div class="esml-modal-body">
      ${SHARED_HEAD}

      <div class="esml-tabs" role="tablist" style="margin-top:14px">
        <button class="esml-tab active" type="button" data-tab="cycling" role="tab">⊙ Cycling</button>
        <button class="esml-tab" type="button" data-tab="running" role="tab">▷ Running</button>
      </div>

      <div class="esml-tab-pane active" data-pane="cycling">
        ${CYCLING_PROTOCOL}
      </div>
      <div class="esml-tab-pane" data-pane="running">
        ${RUNNING_PROTOCOL}
      </div>

      ${SHARED_FOOTER}
    </div>
  </div>
</div>
`;

/**
 * Open the step-test protocol modal. Idempotent.
 * @param {string} [preselectSport] 'cycling' | 'running' — initial tab
 */
export function showStepTestModal(preselectSport) {
  if (document.getElementById(MODAL_ID)) return;

  const root = document.createElement('div');
  root.id = MODAL_ID;
  root.innerHTML = MODAL_HTML;
  document.body.appendChild(root);

  // Tabs
  const tabs  = Array.from(root.querySelectorAll('.esml-tab'));
  const panes = Array.from(root.querySelectorAll('.esml-tab-pane'));
  function selectTab(name) {
    tabs.forEach((t)  => t.classList.toggle('active', t.dataset.tab === name));
    panes.forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
  }
  tabs.forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));
  if (preselectSport === 'running' || preselectSport === 'cycling') selectTab(preselectSport);

  // Inline "lactate measurement protocol" links inside this modal should open
  // the OTHER modal. Lazy-load the measure modal so we don't create a cycle.
  root.querySelectorAll('[data-howto-measure]').forEach((el) => {
    el.addEventListener('click', async (e) => {
      e.preventDefault();
      const { showHowToMeasureModal } = await import('./how-to-measure.js');
      showHowToMeasureModal();
    });
  });

  // Close handlers
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
 * Wire any element with `data-howto-step-test` to open the modal.
 * Optional sport selector via data-step-test-sport="cycling"|"running".
 */
export function wireStepTestTriggers() {
  document.querySelectorAll('[data-howto-step-test]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      showStepTestModal(el.dataset.stepTestSport);
    });
  });
}
