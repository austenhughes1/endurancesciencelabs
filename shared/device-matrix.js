// ════════════════════════════════════════════════════════════════
// shared/device-matrix.js
//
// Which running-form metrics each common device can capture, so the
// Run Dynamics tool can hide metrics a runner's device cannot produce
// (and flag the ones that need a chest strap / running pod).
//
// Capability codes per metric:  N native · S needs chest strap ·
//   P needs foot/waist pod · - not available in any configuration.
// One accessory toggle (chest strap OR pod) upgrades S and P to native.
//
// Exposed as window.RunDevices. Compiled from the device-capability
// matrix (mid-2026); approximate and for relative gating only.
// ════════════════════════════════════════════════════════════════
(function () {
'use strict';

// caps order key: cadence, gct, gctBalance, vo, vratio, stride
function caps(cadence, gct, gctBalance, vo, vratio, stride) {
  return { cadence: cadence, gct: gct, gctBalance: gctBalance, vo: vo, vratio: vratio, stride: stride };
}

var G_WRIST_RD = caps('N','N','S','N','N','N');   // Garmin wrist running-dynamics watches (balance needs strap)
var COROS_RD   = caps('N','N','P','N','N','N');   // COROS native wrist RD (balance/strike needs POD)
var STRYD_DEP  = caps('N','P','P','P','P','P');   // cadence native; full gait only via Stryd pod (Polar/Suunto)
var APPLE_RD   = caps('N','N','-','N','-','N');   // Apple: no GCT balance, no vertical ratio
var CAD_ONLY   = caps('N','-','-','-','-','-');   // lifestyle watches: cadence/HR/pace only

var LIST = [
  // Garmin
  { id:'garmin_fr165',   brand:'Garmin', label:'Forerunner 165 / 165 Music', caps: caps('N','S','S','S','S','S') },
  { id:'garmin_fr255',   brand:'Garmin', label:'Forerunner 255 / 255S',      caps: G_WRIST_RD },
  { id:'garmin_fr265',   brand:'Garmin', label:'Forerunner 265 / 265S',      caps: G_WRIST_RD },
  { id:'garmin_fr570',   brand:'Garmin', label:'Forerunner 570',             caps: G_WRIST_RD },
  { id:'garmin_fr955',   brand:'Garmin', label:'Forerunner 955 / 955 Solar', caps: G_WRIST_RD },
  { id:'garmin_fr965',   brand:'Garmin', label:'Forerunner 965',             caps: G_WRIST_RD },
  { id:'garmin_fr970',   brand:'Garmin', label:'Forerunner 970',             caps: G_WRIST_RD },
  { id:'garmin_fenix8',  brand:'Garmin', label:'Fenix 8 series',             caps: G_WRIST_RD },
  { id:'garmin_fenix7',  brand:'Garmin', label:'Fenix 7 / 7 Pro series',     caps: G_WRIST_RD },
  { id:'garmin_epix2',   brand:'Garmin', label:'Epix Gen 2 / Pro',           caps: G_WRIST_RD },
  { id:'garmin_venu3',   brand:'Garmin', label:'Venu 3 / Vivoactive 5',      caps: CAD_ONLY },
  // COROS
  { id:'coros_pace3',    brand:'COROS',  label:'PACE 3',                     caps: COROS_RD },
  { id:'coros_pace4',    brand:'COROS',  label:'PACE 4',                     caps: COROS_RD },
  { id:'coros_pacepro',  brand:'COROS',  label:'PACE Pro',                   caps: COROS_RD },
  { id:'coros_apex2',    brand:'COROS',  label:'APEX 2 / 2 Pro',             caps: COROS_RD },
  { id:'coros_vertix2',  brand:'COROS',  label:'VERTIX 2 / 2S',              caps: COROS_RD },
  // Apple
  { id:'apple_s10',      brand:'Apple',  label:'Apple Watch Series 10 / 11', caps: APPLE_RD },
  { id:'apple_ultra',    brand:'Apple',  label:'Apple Watch Ultra 2 / 3',    caps: APPLE_RD },
  { id:'apple_se',       brand:'Apple',  label:'Apple Watch SE',             caps: CAD_ONLY },
  // Polar (gait via Stryd)
  { id:'polar_v3',       brand:'Polar',  label:'Vantage V3',                 caps: STRYD_DEP },
  { id:'polar_m3',       brand:'Polar',  label:'Vantage M3',                 caps: STRYD_DEP },
  { id:'polar_gritx2',   brand:'Polar',  label:'Grit X2 Pro',                caps: STRYD_DEP },
  { id:'polar_pacer',    brand:'Polar',  label:'Pacer / Pacer Pro',          caps: STRYD_DEP },
  // Suunto (gait via Stryd)
  { id:'suunto_race',    brand:'Suunto', label:'Race / Race S',              caps: STRYD_DEP },
  { id:'suunto_vertical',brand:'Suunto', label:'Vertical',                   caps: STRYD_DEP },
];

var BY_ID = {};
LIST.forEach(function (d) { BY_ID[d.id] = d; });

function byId(id) { return BY_ID[id] || null; }

// status(needs, deviceId, hasAccessory) → 'native' | 'accessory' | 'none'
//   needs: a caps key ('gct','vo','vratio','stride','gctBalance') or falsy (always-available metric)
//   No device selected (or unknown) → assume native (don't hide anything).
function status(needs, deviceId, hasAccessory) {
  if (!needs) return 'native';
  var dev = byId(deviceId);
  if (!dev) return 'native';
  var code = dev.caps[needs];
  if (!code || code === 'N') return 'native';
  if (code === '-') return 'none';
  return hasAccessory ? 'native' : 'accessory';   // 'S' or 'P'
}

// Human-readable note for a non-native metric.
function reason(needs, deviceId, hasAccessory) {
  var st = status(needs, deviceId, hasAccessory);
  if (st === 'native') return null;
  if (st === 'none') return 'not captured by this device';
  return 'needs a chest strap or running pod';
}

window.RunDevices = { LIST: LIST, byId: byId, status: status, reason: reason };

})();
