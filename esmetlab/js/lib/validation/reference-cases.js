/*
 * Published reference cases. Each is the smallest, most defensible test
 * the implementation should pass before any UI work.
 *
 * Tolerances reflect what's reasonable given the published-figure precision.
 */

export const REFERENCE_CASES = [

  // ── Hauser et al. 2014 ─────────────────────────────────────────
  // "Reliability of Maximal Lactate-Steady-State" — Int J Sports Med 34(3):196–199.
  // A 75 kg male cyclist with VO2max = 60 mL/min/kg and VLamax = 0.5 mmol/L/s
  // should yield MLSS ≈ 270 W (±5 W) per Mader-model implementations.
  {
    id: 'hauser-2014-cycling',
    title: 'Hauser 2014 — 75kg cyclist, VO₂max=60, VLamax=0.5',
    inputs: {
      sport: 'cycling',
      sex: 'M',
      bodyMass: 75,
      bodyFatPct: 12,
      VLamax: 0.5,
      VO2max: 60,
      steps: [],
    },
    expected: {
      MLSS_W: { value: 270, tol: 5 },
    },
  },

  // ── INSCYD validation page Figure 5 (their own example) ────────
  // Cyclist 75kg / 10.5% BF / VO2max=60 / VLamax=0.5. Their published curve
  // crosses ~4 mmol/L at ~300 W and shows MLSS in the 270–285 W band.
  {
    id: 'inscyd-fig5-cycling',
    title: 'INSCYD Fig 5 — 75kg cyclist, VO₂max=60, VLamax=0.5',
    inputs: {
      sport: 'cycling',
      sex: 'M',
      bodyMass: 75,
      bodyFatPct: 10.5,
      VLamax: 0.5,
      VO2max: 60,
      steps: [],
    },
    expected: {
      MLSS_W: { value: 275, tol: 15 },
      // 4 mmol/L crossover should be just above MLSS, in the 285–310 W band
      // (looser tolerance — depends heavily on KM_ELIM tuning).
    },
  },

  // ── Higher VLamax cyclist — sprinter type ──────────────────────
  // Same VO2max but VLamax doubled should push MLSS down significantly,
  // because glycolytic production saturates the elimination capacity at
  // a lower [ADP].
  {
    id: 'high-vlamax-cyclist',
    title: 'Sprinter-type — 75kg, VO₂max=60, VLamax=0.9',
    inputs: {
      sport: 'cycling',
      sex: 'M',
      bodyMass: 75,
      bodyFatPct: 12,
      VLamax: 0.9,
      VO2max: 60,
      steps: [],
    },
    expected: {
      // Higher VLamax → MLSS happens at lower ADP → lower intensity
      MLSS_relative_lower_than: 0.74,   // x_MLSS should be below 74% VO2max
    },
  },

  // ── Aerobic endurance type — low VLamax ────────────────────────
  // Diesel — high VO2max, low VLamax. MLSS should be a higher fraction
  // of VO2max (the model's prediction of why an aerobic-dominant cyclist
  // can sit close to their VO2max ceiling).
  {
    id: 'low-vlamax-cyclist',
    title: 'Diesel-type — 70kg, VO₂max=68, VLamax=0.3',
    inputs: {
      sport: 'cycling',
      sex: 'M',
      bodyMass: 70,
      bodyFatPct: 9,
      VLamax: 0.3,
      VO2max: 68,
      steps: [],
    },
    expected: {
      MLSS_relative_higher_than: 0.80,
    },
  },
];

/**
 * Kinetic-function unit tests (Section 5.2 of the spec).
 * Each returns { ok: boolean, msg: string, value: number, expected: number }.
 */
export function unitChecks(eng) {
  const { vLass, vO2ss, MADER } = eng;
  const checks = [];

  // vLass at ADP=0 → 0
  checks.push({
    name: 'vLass(0, 0.5) = 0',
    ok: vLass(0, 0.5) === 0,
    actual: vLass(0, 0.5),
    expected: 0,
  });

  // vLass at very high ADP → VLamax
  checks.push({
    name: 'vLass(10, 0.5) ≈ 0.5',
    ok: Math.abs(vLass(10, 0.5) - 0.5) < 0.01,
    actual: vLass(10, 0.5).toFixed(4),
    expected: '0.5000',
  });

  // vLass at ADP=K2 → VLamax/2
  checks.push({
    name: 'vLass(K2, 0.5) = 0.25',
    ok: Math.abs(vLass(MADER.K2, 0.5) - 0.25) < 1e-9,
    actual: vLass(MADER.K2, 0.5).toFixed(6),
    expected: '0.250000',
  });

  // vO2ss at ADP=K1 → VO2max/2
  checks.push({
    name: 'vO2ss(K1, 60) = 30',
    ok: Math.abs(vO2ss(MADER.K1, 60) - 30) < 1e-9,
    actual: vO2ss(MADER.K1, 60).toFixed(4),
    expected: '30.0000',
  });

  // Monotonic in ADP
  let mono = true;
  let prevL = -1, prevO = -1;
  for (let i = 1; i <= 100; i++) {
    const a = i / 50;
    const L = vLass(a, 0.5);
    const O = vO2ss(a, 60);
    if (L < prevL - 1e-12 || O < prevO - 1e-12) { mono = false; break; }
    prevL = L; prevO = O;
  }
  checks.push({ name: 'vLass and vO2ss are monotone in ADP', ok: mono, actual: mono, expected: true });

  return checks;
}
