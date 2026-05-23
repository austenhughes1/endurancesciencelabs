/*
 * Reusable pace input: a text box with a min/mi · min/km unit toggle at
 * the right edge. Stores the user's preferred unit in localStorage so it
 * persists across visits and across forms. Default unit: min/mi.
 *
 * Public API:
 *   paceInputHTML({ id, value, placeholder, unit, extraAttrs })
 *     → HTML string for one input + toggle pair.
 *
 *   wirePaceInputs(onUnitChange)
 *     → call after rendering. Sets up the toggle clicks; converts values
 *       cleanly when the unit flips; syncs every other pace-input on the
 *       page to the same unit; saves the choice to localStorage.
 *
 *   readPaceMps(input)
 *     → read one input's current value and return it in m/s, interpreting
 *       the input.dataset.unit. Returns NaN if the value is empty or unparseable.
 *
 *   getDefaultPaceUnit() / setDefaultPaceUnit(unit)
 *     → 'mi' | 'km'. Used by other modules that want to honor the user's pref.
 */

const STORAGE_KEY = 'esml-pace-unit';
const METERS_PER_MILE = 1609.344;

export function getDefaultPaceUnit() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'km' ? 'km' : 'mi';
  } catch (e) { return 'mi'; }
}
export function setDefaultPaceUnit(unit) {
  try { localStorage.setItem(STORAGE_KEY, unit === 'km' ? 'km' : 'mi'); } catch (e) {}
}

/**
 * Parse a pace string in given unit ('mi' | 'km') into m/s.
 * Accepts "m:ss" / "m:ss.f" / a plain m/s float.
 */
export function paceStringToMps(raw, unit) {
  if (raw == null) return NaN;
  const s = String(raw).trim();
  if (!s) return NaN;
  const m = s.match(/^(\d+):(\d+(?:\.\d+)?)$/);
  if (m) {
    const minPer = parseInt(m[1], 10) + parseFloat(m[2]) / 60;
    if (!isFinite(minPer) || minPer <= 0) return NaN;
    const sec_per_unit = minPer * 60;
    return unit === 'mi' ? METERS_PER_MILE / sec_per_unit : 1000 / sec_per_unit;
  }
  // Allow a bare number as m/s for power users
  const f = parseFloat(s);
  return isFinite(f) ? f : NaN;
}

/**
 * Format m/s as a "m:ss" pace string in the given unit. Empty string on bad input.
 */
export function mpsToPaceString(v_mps, unit) {
  if (!isFinite(v_mps) || v_mps <= 0) return '';
  const sec_per_unit = unit === 'mi' ? METERS_PER_MILE / v_mps : 1000 / v_mps;
  const min = Math.floor(sec_per_unit / 60);
  let sec = Math.round(sec_per_unit - min * 60);
  if (sec === 60) return (min + 1) + ':00';
  return min + ':' + (sec < 10 ? '0' : '') + sec;
}

function labelFor(unit) { return unit === 'mi' ? 'min/mi' : 'min/km'; }

/**
 * @param {Object} opts
 * @param {string}  opts.id          element id for the <input>
 * @param {number}  [opts.mps]       initial value as m/s (formatted into the current unit)
 * @param {string}  [opts.value]     literal string to put in the input (overrides mps)
 * @param {string}  [opts.placeholder]
 * @param {string}  [opts.unit]      override the saved/default unit
 * @param {string}  [opts.extraAttrs]  raw attribute string appended to the input
 */
export function paceInputHTML(opts) {
  const unit = opts.unit || getDefaultPaceUnit();
  const value = (opts.value != null)
    ? opts.value
    : (opts.mps != null ? mpsToPaceString(+opts.mps, unit) : '');
  const placeholder = opts.placeholder || '';
  const extraAttrs = opts.extraAttrs || '';
  return `
    <div class="pace-input">
      <input type="text" id="${opts.id}" class="pace-text" data-unit="${unit}" value="${value}" placeholder="${placeholder}" inputmode="numeric" autocomplete="off" ${extraAttrs}>
      <button type="button" class="pace-unit-toggle" data-pace-unit-toggle aria-label="Toggle pace unit">${labelFor(unit)}</button>
    </div>
  `;
}

/**
 * Wire all pace-unit toggles on the page. Idempotent — safe to call after re-renders.
 * @param {Function} [onUnitChange]  called with the new unit ('mi'|'km') after a flip.
 */
export function wirePaceInputs(onUnitChange) {
  document.querySelectorAll('[data-pace-unit-toggle]').forEach((btn) => {
    if (btn.dataset.paceWired === '1') return;
    btn.dataset.paceWired = '1';
    btn.addEventListener('click', () => {
      const wrap = btn.closest('.pace-input');
      if (!wrap) return;
      const me = wrap.querySelector('input');
      const oldUnit = me.dataset.unit || 'mi';
      const newUnit = oldUnit === 'mi' ? 'km' : 'mi';

      // Sync every pace input on the page to the new unit, converting values.
      document.querySelectorAll('.pace-input input[data-unit]').forEach((inp) => {
        const fromUnit = inp.dataset.unit || 'mi';
        if (fromUnit === newUnit) return;
        const mps = paceStringToMps(inp.value, fromUnit);
        inp.dataset.unit = newUnit;
        inp.value = isFinite(mps) ? mpsToPaceString(mps, newUnit) : inp.value;
      });
      document.querySelectorAll('[data-pace-unit-toggle]').forEach((b) => {
        b.textContent = labelFor(newUnit);
      });

      setDefaultPaceUnit(newUnit);
      if (typeof onUnitChange === 'function') {
        try { onUnitChange(newUnit); } catch (e) { console.warn(e); }
      }
    });
  });
}

/** Read one pace-input's value as m/s using its current data-unit attribute. */
export function readPaceMps(input) {
  if (!input) return NaN;
  return paceStringToMps(input.value, input.dataset.unit || getDefaultPaceUnit());
}
