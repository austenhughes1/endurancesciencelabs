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
    intensity at which you burn fat fastest. Plan for
    <strong>45–60 minutes</strong> from warm-up to the last sample — most
    tests land at the longer end.
  </p>

  <h3 class="esml-modal-h3">What you need (both sports)</h3>
  <ul class="esml-checklist">
    <li>Handheld lactate meter, strips, lancets, alcohol wipes, gauze — see the <a href="#" data-howto-measure style="color:var(--cyan)">measurement protocol</a></li>
    <li>Stopwatch or structured workout file on your bike computer / treadmill</li>
    <li>Fan running at full speed</li>
    <li>Towel — fingertip moisture skews readings</li>
    <li>A partner / spotter ideal (handles sampling while you keep moving)</li>
    <li>45–60 minutes uninterrupted</li>
  </ul>

  <div class="warn" style="margin-bottom:18px">
    ⚠ <strong>No carbs or electrolytes during the test.</strong> Sports drinks,
    gels, chews, and electrolyte mixes will skew your lactate readings via the
    glucose pathway — even a few sips throws the curve off. Small sips of plain
    water are fine if you need them. Be hydrated coming in, not parched.
  </div>

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
    You'll do <strong>5 to 9 stages</strong> total — usually toward the longer
    end. Stop the test when one of two things happens:
  </p>
  <ul class="esml-checklist">
    <li>You can't complete the 5-minute stage at the prescribed effort, or</li>
    <li>Your post-stage lactate exceeds <strong>10.0 mmol/L</strong></li>
  </ul>
  <p class="esml-modal-p">
    Either of those means you've collected enough data. For a clean fit you
    need at least 3 stages below threshold and at least one stage in the
    <strong>7–10 mmol/L</strong> range to anchor the upper end of the curve.
  </p>
`;

const CYCLING_PROTOCOL = `
  <h3 class="esml-modal-h3">Cycling — setup</h3>
  <ul class="esml-checklist">
    <li>Smart trainer or ergometer with a power meter accurate to ±2%</li>
    <li>ERG mode if your trainer supports it — eliminates drift</li>
    <li>Cooling fan at full speed</li>
    <li>Lactate kit + towel + alcohol on a stable surface within arm's reach</li>
    <li>Plain water in small sips only — no sports drinks, gels, or electrolytes</li>
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
        <li style="padding:4px 0;color:var(--text)">• <strong>+30 W per stage</strong> until you're one or two stages below your estimated FTP</li>
        <li style="padding:4px 0;color:var(--text)">• <strong>+15 W per stage</strong> from there — finer resolution where the curve matters most</li>
      </ul>
      Novices with FTP below ~200 W can use +20 W early and +10 W near threshold if 30 W feels too aggressive.
    </li>
    <li>Repeat until you hit one of the stop criteria below.</li>
  </ol>

  <h3 class="esml-modal-h3">Cycling — when to stop</h3>
  <ul class="esml-checklist">
    <li>You can't complete the 5-minute stage at the target power, <strong>or</strong></li>
    <li>Post-stage lactate exceeds <strong>10.0 mmol/L</strong></li>
  </ul>
  <p class="esml-modal-p">
    Your final stage should land in the <strong>7–10 mmol/L</strong> range.
    Without that upper anchor the fit under-estimates VO₂max and MLSS.
  </p>

  <h3 class="esml-modal-h3">Cycling — worked example</h3>
  <p class="esml-modal-p">
    A 9-stage test for a trained cyclist with an estimated FTP around 280 W.
    The increment shrinks from 30 W to 15 W once they're one or two stages
    below FTP.
  </p>
  <div style="background:var(--panel2);border:1px solid var(--border);border-radius:10px;padding:14px 16px;font-family:var(--mono);font-size:12px;line-height:1.85;color:var(--text)">
    <div style="color:var(--muted2);margin-bottom:6px">10–15 min warm-up at easy spinning</div>
    <div style="color:var(--gold)">↳ Resting lactate sample</div>
    <div style="color:var(--muted)">────────</div>
    <div>Stage 1 &nbsp;·&nbsp; 5 min @ <strong>150 W</strong></div>
    <div style="color:var(--gold)">↳ 1 min easy spin, sample immediately upon stopping</div>
    <div>Stage 2 &nbsp;·&nbsp; 5 min @ <strong>180 W</strong> &nbsp;<span style="color:var(--muted2)">(+30 W)</span></div>
    <div style="color:var(--gold)">↳ 1 min easy spin, sample</div>
    <div>Stage 3 &nbsp;·&nbsp; 5 min @ <strong>210 W</strong> &nbsp;<span style="color:var(--muted2)">(+30 W)</span></div>
    <div style="color:var(--gold)">↳ 1 min easy spin, sample</div>
    <div>Stage 4 &nbsp;·&nbsp; 5 min @ <strong>240 W</strong> &nbsp;<span style="color:var(--muted2)">(+30 W)</span></div>
    <div style="color:var(--gold)">↳ 1 min easy spin, sample</div>
    <div>Stage 5 &nbsp;·&nbsp; 5 min @ <strong>270 W</strong> &nbsp;<span style="color:var(--muted2)">(+30 W — closing on FTP)</span></div>
    <div style="color:var(--gold)">↳ 1 min easy spin, sample</div>
    <div style="color:var(--muted)">─── shift to 15 W increments ───</div>
    <div>Stage 6 &nbsp;·&nbsp; 5 min @ <strong>285 W</strong> &nbsp;<span style="color:var(--muted2)">(+15 W)</span></div>
    <div style="color:var(--gold)">↳ 1 min easy spin, sample</div>
    <div>Stage 7 &nbsp;·&nbsp; 5 min @ <strong>300 W</strong> &nbsp;<span style="color:var(--muted2)">(+15 W)</span></div>
    <div style="color:var(--gold)">↳ 1 min easy spin, sample</div>
    <div>Stage 8 &nbsp;·&nbsp; 5 min @ <strong>315 W</strong> &nbsp;<span style="color:var(--muted2)">(+15 W)</span></div>
    <div style="color:var(--gold)">↳ 1 min easy spin, sample</div>
    <div>Stage 9 &nbsp;·&nbsp; 5 min @ <strong>330 W</strong> &nbsp;<span style="color:var(--muted2)">(+15 W)</span></div>
    <div style="color:var(--gold)">↳ Final sample → done</div>
  </div>
  <p class="esml-modal-p" style="font-size:13px;color:var(--muted2);margin-top:10px">
    Your numbers will be different — start around 50–60% of <em>your</em>
    estimated FTP, increment by 30 W until you're a stage or two below FTP,
    then drop to 15 W as the curve gets interesting. ERG mode on a smart
    trainer makes the small increments hold rock-steady.
  </p>
`;

const RUNNING_PROTOCOL = `
  <h3 class="esml-modal-h3">Running — setup</h3>
  <ul class="esml-checklist">
    <li>Treadmill with adjustable speed AND incline</li>
    <li>
      <strong>Incline:</strong>
      <ul style="margin-top:6px;padding-left:0;list-style:none">
        <li style="padding:3px 0">• <strong>1%</strong> for tests at altitudes below ~5,000 ft (1,500 m) — mimics outdoor air resistance (Jones &amp; Doust 1996, the standard lab-physiology correction)</li>
        <li style="padding:3px 0">• <strong>0%</strong> at altitudes above ~5,000 ft — the thinner air provides less resistance and the 1% correction over-states it</li>
      </ul>
    </li>
    <li>Cooling fan at full speed</li>
    <li>Lactate kit + towel + alcohol on a stable surface within arm's reach</li>
    <li>Plain water in small sips only — no sports drinks, gels, or electrolytes</li>
    <li>A partner is strongly recommended — sampling while you straddle the treadmill is fiddly solo</li>
  </ul>

  <h3 class="esml-modal-h3">Running — warm-up</h3>
  <ol class="esml-steps">
    <li>10 minutes easy jogging at your usual easy-day pace.</li>
    <li>3 × 30 seconds at a moderate pace (a notch faster than easy), with 30 seconds easy between each.</li>
    <li>Take your resting lactate sample <strong>after</strong> the warm-up, walking or standing still for 1–2 minutes. This is your baseline.</li>
  </ol>

  <h3 class="esml-modal-h3">Running — the stages</h3>
  <ol class="esml-steps">
    <li>
      <strong>Starting pace.</strong> Begin
      <strong>about 30 seconds per mile (or 20 seconds per km) slower than
      your typical easy-day pace</strong>. The first stage should feel
      comfortable — like you could chat through the whole thing.
    </li>
    <li><strong>Hold each stage for 5 minutes</strong> at the set speed, on the chosen grade.</li>
    <li><strong>During the last 30 seconds</strong>, your partner preps the sampling site.</li>
    <li><strong>At the stage end</strong>, grip the handrails, straddle the belt (or use a quick-stop if your treadmill has one), and take a lactate sample within 30–60 seconds. Climb back on for the next stage.</li>
    <li>
      <strong>Step up by:</strong>
      <ul style="margin-top:8px;padding-left:0;list-style:none">
        <li style="padding:4px 0;color:var(--text)">• <strong>30 seconds per mile</strong> (about 20 seconds per kilometer) until you're one or two stages below your <strong>marathon pace</strong></li>
        <li style="padding:4px 0;color:var(--text)">• <strong>15 seconds per mile</strong> (about 10 seconds per kilometer) from marathon pace onward — finer resolution where it matters most</li>
      </ul>
      Keep the incline constant.
    </li>
    <li>Repeat until you hit one of the stop criteria below.</li>
  </ol>

  <h3 class="esml-modal-h3">Running — when to stop</h3>
  <ul class="esml-checklist">
    <li>You can't complete the 5-minute stage at the target pace, <strong>or</strong></li>
    <li>Post-stage lactate exceeds <strong>10.0 mmol/L</strong></li>
  </ul>
  <p class="esml-modal-p">
    Your final stage should land in the <strong>7–10 mmol/L</strong> range.
    Without that upper anchor the fit under-estimates VO₂max and MLSS.
  </p>

  <h3 class="esml-modal-h3">Running — worked example</h3>
  <p class="esml-modal-p">
    A 9-stage test for a runner whose easy-day pace is around 8:30/mile and
    marathon pace is around 5:45/mile. Note the increment shrinks from
    30 seconds to 15 seconds once they cross marathon pace.
  </p>
  <div style="background:var(--panel2);border:1px solid var(--border);border-radius:10px;padding:14px 16px;font-family:var(--mono);font-size:12px;line-height:1.85;color:var(--text)">
    <div style="color:var(--muted2);margin-bottom:6px">10–15 min warm-up at easy pace</div>
    <div style="color:var(--gold)">↳ Resting lactate sample</div>
    <div style="color:var(--muted)">────────</div>
    <div>Stage 1 &nbsp;·&nbsp; 5 min @ <strong>8:00/mile</strong></div>
    <div style="color:var(--gold)">↳ 1 min standing rest, sample immediately upon stopping</div>
    <div>Stage 2 &nbsp;·&nbsp; 5 min @ <strong>7:30/mile</strong> &nbsp;<span style="color:var(--muted2)">(+30 s/mi)</span></div>
    <div style="color:var(--gold)">↳ 1 min standing rest, sample</div>
    <div>Stage 3 &nbsp;·&nbsp; 5 min @ <strong>7:00/mile</strong> &nbsp;<span style="color:var(--muted2)">(+30 s/mi)</span></div>
    <div style="color:var(--gold)">↳ 1 min standing rest, sample</div>
    <div>Stage 4 &nbsp;·&nbsp; 5 min @ <strong>6:30/mile</strong> &nbsp;<span style="color:var(--muted2)">(+30 s/mi)</span></div>
    <div style="color:var(--gold)">↳ 1 min standing rest, sample</div>
    <div>Stage 5 &nbsp;·&nbsp; 5 min @ <strong>6:00/mile</strong> &nbsp;<span style="color:var(--muted2)">(+30 s/mi — closing on marathon pace)</span></div>
    <div style="color:var(--gold)">↳ 1 min standing rest, sample</div>
    <div style="color:var(--muted)">─── shift to 15 s/mile increments ───</div>
    <div>Stage 6 &nbsp;·&nbsp; 5 min @ <strong>5:45/mile</strong> &nbsp;<span style="color:var(--muted2)">(+15 s/mi)</span></div>
    <div style="color:var(--gold)">↳ 1 min standing rest, sample</div>
    <div>Stage 7 &nbsp;·&nbsp; 5 min @ <strong>5:30/mile</strong> &nbsp;<span style="color:var(--muted2)">(+15 s/mi)</span></div>
    <div style="color:var(--gold)">↳ 1 min standing rest, sample</div>
    <div>Stage 8 &nbsp;·&nbsp; 5 min @ <strong>5:15/mile</strong> &nbsp;<span style="color:var(--muted2)">(+15 s/mi)</span></div>
    <div style="color:var(--gold)">↳ 1 min standing rest, sample</div>
    <div>Stage 9 &nbsp;·&nbsp; 5 min @ <strong>5:00/mile</strong> &nbsp;<span style="color:var(--muted2)">(+15 s/mi)</span></div>
    <div style="color:var(--gold)">↳ Final sample → done</div>
  </div>
  <p class="esml-modal-p" style="font-size:13px;color:var(--muted2);margin-top:10px">
    Your numbers will be different — start ~30 s/mile slower than <em>your</em>
    easy-day pace, and shift to 15 s/mile increments once you reach <em>your</em>
    marathon pace. The shape is what matters: bigger steps in the aerobic zone,
    finer steps as you approach threshold.
  </p>
`;

const SHARED_FOOTER = `
  <h3 class="esml-modal-h3" style="margin-top:30px">Common pitfalls</h3>
  <ul class="esml-checklist">
    <li><strong>Sweaty fingertip.</strong> Towel off and alcohol-wipe each time. Even a trace of sweat can shift the reading by a full mmol/L.</li>
    <li><strong>Strip touching skin.</strong> The strip should touch only the blood drop. The strip wicks the sample up — pressing it to the finger introduces contamination.</li>
    <li><strong>Stages too short.</strong> 3-minute stages can work in a pinch but lactate hasn't reached steady state — numbers look more favourable than reality. 5 minutes is the standard.</li>
    <li><strong>Skipping stages.</strong> Each increment must be small enough that you collect 4–6 useful data points. Jumping intensities to save time leaves the curve under-determined.</li>
    <li><strong>Test cut short.</strong> If your last stage didn't get into the 7–10 mmol/L range, the upper-end fit is sloppy. Push through one more stage if you have legs for it.</li>
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
