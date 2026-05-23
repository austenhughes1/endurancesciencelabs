/*
 * Reusable distance input: a text box with a m · mi unit toggle at the
 * right edge. Used for the Power/Pace-only Profile's max-effort fields,
 * where the natural input is "how far did you cover in this time" rather
 * than pace. Track athletes report meters; GPS athletes report miles.
 *
 * Mirrors pace-input.js in shape and toggle behaviour. Default unit: mi.
 * Toggling syncs every distance-input on the page and persists the choice
 * in localStorage.
 */

const STORAGE_KEY = 'esml-distance-unit';
const METERS_PER_MILE = 1609.344;

export function getDefaultDistanceUnit() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'm' ? 'm' : 'mi';
  } catch (e) { return 'mi'; }
}
export function setDefaultDistanceUnit(unit) {
  try { localStorage.setItem(STORAGE_KEY, unit === 'm' ? 'm' : 'mi'); } catch (e) {}
}

/** Parse a distance string in given unit ('m' | 'mi') into meters. */
export function parseDistanceMeters(raw, unit) {
  if (raw == null) return NaN;
  const s = String(raw).trim();
  if (!s) return NaN;
  const f = parseFloat(s);
  if (!isFinite(f) || f <= 0) return NaN;
  return unit === 'mi' ? f * METERS_PER_MILE : f;
}

/** Format meters as a string in the given unit. Empty string on bad input. */
export function metersToDistanceString(m, unit) {
  if (!isFinite(m) || m <= 0) return '';
  if (unit === 'mi') {
    const mi = m / METERS_PER_MILE;
    // 3 decimals, trimming trailing zeros so 0.062 mi reads cleanly
    return mi.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  }
  return String(Math.round(m));
}

function labelFor(unit) { return unit; /* 'm' or 'mi' */ }

/**
 * @param {Object} opts
 * @param {string} opts.id              element id for the <input>
 * @param {number} [opts.meters]        initial value as meters (formatted into current unit)
 * @param {string} [opts.value]         literal string to put in the input (overrides meters)
 * @param {Object} [opts.placeholders]  { m: '100', mi: '0.062' } — picked based on current unit
 * @param {string} [opts.unit]          override saved/default unit
 * @param {string} [opts.extraAttrs]    raw attribute string appended to the input
 */
export function distanceInputHTML(opts) {
  const unit = opts.unit || getDefaultDistanceUnit();
  const value = (opts.value != null)
    ? opts.value
    : (opts.meters != null ? metersToDistanceString(+opts.meters, unit) : '');
  const ph = (opts.placeholders && opts.placeholders[unit]) || '';
  const extraAttrs = opts.extraAttrs || '';
  // Stash both placeholders on the element so the toggle can flip them
  const phData =
    'data-placeholder-m="' + ((opts.placeholders && opts.placeholders.m) || '') + '"' +
    ' data-placeholder-mi="' + ((opts.placeholders && opts.placeholders.mi) || '') + '"';
  return `
    <div class="pace-input distance-input">
      <input type="text" id="${opts.id}" class="pace-text" data-unit="${unit}" value="${value}" placeholder="${ph}" inputmode="decimal" autocomplete="off" ${phData} ${extraAttrs}>
      <button type="button" class="pace-unit-toggle" data-distance-unit-toggle aria-label="Toggle distance unit">${labelFor(unit)}</button>
    </div>
  `;
}

/**
 * Wire all distance-unit toggles on the page. Idempotent.
 * @param {Function} [onUnitChange]
 */
export function wireDistanceInputs(onUnitChange) {
  document.querySelectorAll('[data-distance-unit-toggle]').forEach((btn) => {
    if (btn.dataset.distWired === '1') return;
    btn.dataset.distWired = '1';
    btn.addEventListener('click', () => {
      const wrap = btn.closest('.distance-input');
      if (!wrap) return;
      const me = wrap.querySelector('input');
      const oldUnit = me.dataset.unit || 'mi';
      const newUnit = oldUnit === 'mi' ? 'm' : 'mi';

      document.querySelectorAll('.distance-input input[data-unit]').forEach((inp) => {
        const from = inp.dataset.unit || 'mi';
        if (from === newUnit) return;
        const meters = parseDistanceMeters(inp.value, from);
        inp.dataset.unit = newUnit;
        inp.value = isFinite(meters) ? metersToDistanceString(meters, newUnit) : inp.value;
        // Swap placeholder
        const phSwap = inp.getAttribute('data-placeholder-' + newUnit) || '';
        if (phSwap) inp.setAttribute('placeholder', phSwap);
      });
      document.querySelectorAll('[data-distance-unit-toggle]').forEach((b) => {
        b.textContent = labelFor(newUnit);
      });

      setDefaultDistanceUnit(newUnit);
      if (typeof onUnitChange === 'function') {
        try { onUnitChange(newUnit); } catch (e) { console.warn(e); }
      }
    });
  });
}

/** Read one distance-input's value as meters using its current data-unit. */
export function readDistanceMeters(input) {
  if (!input) return NaN;
  return parseDistanceMeters(input.value, input.dataset.unit || getDefaultDistanceUnit());
}
