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

/**
 * @param {Object} opts
 * @param {string} opts.id              element id for the <input>
 * @param {number} [opts.meters]        initial value as meters (formatted into current unit)
 * @param {string} [opts.value]         literal string to put in the input (overrides meters)
 * @param {Object} [opts.placeholders]  { m: '100', mi: '0.062' } — picked based on current unit
 * @param {string} [opts.unit]          initial unit for this input (defaults to the user's last-used)
 * @param {string} [opts.extraAttrs]    raw attribute string appended to the input
 *
 * Renders a text input with an inline two-button pill toggle on the right
 * showing BOTH unit options (m and mi) with the active one highlighted.
 * Each input is independent — flipping one doesn't affect any others.
 */
export function distanceInputHTML(opts) {
  const unit = opts.unit || getDefaultDistanceUnit();
  const value = (opts.value != null)
    ? opts.value
    : (opts.meters != null ? metersToDistanceString(+opts.meters, unit) : '');
  const ph = (opts.placeholders && opts.placeholders[unit]) || '';
  const extraAttrs = opts.extraAttrs || '';
  const phData =
    'data-placeholder-m="' + ((opts.placeholders && opts.placeholders.m) || '') + '"' +
    ' data-placeholder-mi="' + ((opts.placeholders && opts.placeholders.mi) || '') + '"';
  return `
    <div class="pace-input distance-input">
      <input type="text" id="${opts.id}" class="pace-text" data-unit="${unit}" value="${value}" placeholder="${ph}" inputmode="decimal" autocomplete="off" ${phData} ${extraAttrs}>
      <div class="unit-toggle-inline" role="group" aria-label="Distance unit">
        <button type="button" data-dist-set="m"  class="${unit === 'm'  ? 'active' : ''}" aria-pressed="${unit === 'm'  ? 'true' : 'false'}">m</button>
        <button type="button" data-dist-set="mi" class="${unit === 'mi' ? 'active' : ''}" aria-pressed="${unit === 'mi' ? 'true' : 'false'}">mi</button>
      </div>
    </div>
  `;
}

/**
 * Wire all distance-input pill clicks. Per-input only — no cross-input
 * sync, so each field can carry its own unit. Idempotent.
 *
 * @param {Function} [onUnitChange]  optional callback (field-scoped: receives
 *                                   newUnit AND the affected wrapper element)
 */
export function wireDistanceInputs(onUnitChange) {
  document.querySelectorAll('.distance-input').forEach((wrap) => {
    if (wrap.dataset.distWired === '1') return;
    wrap.dataset.distWired = '1';
    const input = wrap.querySelector('input');
    if (!input) return;
    wrap.querySelectorAll('[data-dist-set]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const newUnit = btn.dataset.distSet;
        const oldUnit = input.dataset.unit || 'mi';
        if (newUnit === oldUnit) return;

        // Convert the value into the new unit
        const meters = parseDistanceMeters(input.value, oldUnit);
        input.dataset.unit = newUnit;
        input.value = isFinite(meters) ? metersToDistanceString(meters, newUnit) : input.value;

        // Update placeholder for the new unit
        const phSwap = input.getAttribute('data-placeholder-' + newUnit) || '';
        if (phSwap) input.setAttribute('placeholder', phSwap);

        // Update active highlight on this wrap's two pill buttons only
        wrap.querySelectorAll('[data-dist-set]').forEach((b) => {
          const isActive = b.dataset.distSet === newUnit;
          b.classList.toggle('active', isActive);
          b.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        });

        // Remember the most recently chosen unit so the next fresh form
        // opens with what the user last used (per-input still independent
        // for editing).
        setDefaultDistanceUnit(newUnit);

        if (typeof onUnitChange === 'function') {
          try { onUnitChange(newUnit, wrap); } catch (e) { console.warn(e); }
        }
      });
    });
  });
}

/** Read one distance-input's value as meters using its current data-unit. */
export function readDistanceMeters(input) {
  if (!input) return NaN;
  return parseDistanceMeters(input.value, input.dataset.unit || getDefaultDistanceUnit());
}
