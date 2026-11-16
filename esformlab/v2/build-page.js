#!/usr/bin/env node
'use strict';
// Builds esformlab/v2/index.html from esformlab/index.html.
//
//   node esformlab/v2/build-page.js           write v2/index.html
//   node esformlab/v2/build-page.js --check   exit 1 if v2/index.html is not what this script makes
//
// The v2 page is the current esFormLab page with the same markup, styles, copy
// and inline script. It loads the same shared modules from ../, plus the v2
// detection scripts listed below, which load after the inline script and
// replace the scan and pose functions. It is not linked from anywhere and asks
// search engines not to index it. To pick up later changes to the main page,
// run this script again. `npm test` runs it with --check.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SRC = path.join(__dirname, '..', 'index.html');
const OUT = path.join(__dirname, 'index.html');

// The v2 scripts, in load order. They run after the inline script has
// declared its functions and before initModel() starts. Each is loaded with
// ?v=<hash of its content>, so a changed script is never served stale; after
// editing one, run this script again.
const V2_SCRIPTS = ['gait-events.js', 'pose-v2.js', 'scan-v2.js'];

// The main page's own modules, loaded from ../ by the v2 page.
const V1_MODULES = ['frame-store', 'report-render', 'saved-analyses', 'auth-paywall', 'gait-data', 'gait-engine'];

// scan-v2.js replaces autoScanAll with a copy of the main page's body in which
// only the sampling and detection core changed. When the main page's
// autoScanAll changes, this hash stops matching and the build fails until the
// copy in scan-v2.js has been brought up to date; then put the new hash here.
const AUTO_SCAN_ALL_SHA = '1030104c5e6fc7da';

// Names in the v2 scripts' /* global */ comments that are not the main page's.
const NOT_V1_GLOBALS = ['EslPoseV2', 'EslGaitEvents', 'EslScanV2', 'tf', 'poseDetection'];

// Each edit must match exactly `count` times, so a change to the main page
// that moves one of these spots fails loudly here instead of producing a
// half-converted page.
const EDITS = [
  {
    what: 'tab title and noindex',
    find: '<title>esFormLab — Endurance Science Labs</title>',
    replace: '<title>esFormLab v2 — Endurance Science Labs</title>\n<meta name="robots" content="noindex, nofollow">',
    count: 1,
  },
  {
    what: 'page stylesheet',
    find: 'href="esformlab.css?',
    replace: 'href="../esformlab.css?',
    count: 1,
  },
  {
    what: 'shared esFormLab modules',
    find: new RegExp('<script src="(' + V1_MODULES.join('|') + ')\\.js', 'g'),
    replace: '<script src="../$1.js',
    count: V1_MODULES.length,
  },
  {
    what: 'helper image paths',
    find: 'src="../images/gait-helpers/',
    replace: 'src="/images/gait-helpers/',
    count: 2,
  },
  {
    // phase_labels is shared with the main page: v2's labels say which detector picked the frame
    what: 'phase label provenance',
    find: '    isCorrect: !!isCorrect,\n',
    replace: '    isCorrect: !!isCorrect,\n    detector: \'v2\',\n',
    count: 1,
  },
  {
    what: 'v2 scripts before the model starts loading',
    find: '\ninitModel();\n</script>\n</body>',
    replace: function (v2) {
      return '\n</script>\n' +
        '<!-- esFormLab v2: detection scripts (see v2/README.md). Built by v2/build-page.js. -->\n' +
        V2_SCRIPTS.map(function (s) { return '<script src="' + s + '?v=' + sha(v2[s]) + '"></script>\n'; }).join('') +
        '<script>initModel();</script>\n</body>';
    },
    count: 1,
  },
];

function sha(text) { return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16); }

// v1's `async function autoScanAll(){ ... }` (up to the first closing brace in column 0), or null.
function autoScanAllOf(src) {
  const a = src.indexOf('\nasync function autoScanAll(){');
  if (a < 0) return null;
  const e = src.indexOf('\n}\n', a + 1);
  return e < 0 ? null : src.slice(a + 1, e + 2);
}

// The names the v2 scripts list in their /* global */ comments, less their own.
function v2Globals(v2) {
  const names = new Set();
  V2_SCRIPTS.forEach(function (f) {
    const re = /\/\*\s*global\s+([\s\S]*?)\*\//g;
    let m;
    while ((m = re.exec(v2[f]))) m[1].split(/[\s,]+/).filter(Boolean).forEach(function (n) { names.add(n); });
  });
  NOT_V1_GLOBALS.forEach(function (n) { names.delete(n); });
  return Array.from(names);
}

// Is name declared at the top level (column 0) of the main page's source: a function, or a
// var/let/const (also later in a comma list on the same line)?
function declares(src, name) {
  const re = new RegExp('^(?:(?:async\\s+)?function\\s+' + name + '\\s*\\(|(?:var|let|const)\\s+(?:[^;\\n]*,\\s*)?' + name + '\\s*[=,;])', 'm');
  return re.test(src);
}

// src, href and url() values in the built page that would resolve under /esformlab/v2/ but are
// not v2 files (the main page's relative paths that no edit rewrote).
function strayRelativeUrls(html) {
  const out = [];
  const ok = /^(?:\.\.\/|\/|[a-z][a-z0-9+.-]*:|#|$)/i;
  const re = /\b(?:src|href)\s*=\s*(["'])(.*?)\1|url\(\s*(["']?)([^"')]*)\3\s*\)/g;
  let m;
  while ((m = re.exec(html))) {
    const v = (m[2] != null ? m[2] : m[4]).trim();
    if (ok.test(v) || /['"+]/.test(v)) continue;   // absolute, or JS string building inside the inline script
    if (V2_SCRIPTS.indexOf(v.split('?')[0]) >= 0) continue;
    out.push(v);
  }
  return out;
}

function countMatches(text, find) {
  if (typeof find === 'string') return text.split(find).length - 1;
  return (text.match(new RegExp(find.source, 'g')) || []).length;
}

// src: esformlab/index.html. v2: {file name: content} of V2_SCRIPTS. modules: the text of the
// main page's modules (V1_MODULES), searched with src for the globals the v2 scripts use.
// Throws when the main page no longer matches what the v2 scripts were written against.
function build(src, v2, modules) {
  const missingFiles = V2_SCRIPTS.filter(function (f) { return typeof v2[f] !== 'string'; });
  if (missingFiles.length) throw new Error('build-page: missing v2 script(s): ' + missingFiles.join(', '));
  const asa = autoScanAllOf(src);
  if (!asa) throw new Error('build-page: esformlab/index.html no longer declares async function autoScanAll(){');
  if (sha(asa) !== AUTO_SCAN_ALL_SHA) {
    throw new Error('build-page: autoScanAll in esformlab/index.html changed (hash ' + sha(asa) + '). scan-v2.js holds a copy of its body: ' +
      'bring that copy up to date, then set AUTO_SCAN_ALL_SHA in esformlab/v2/build-page.js to the new hash.');
  }
  const v1All = [src].concat(modules || []).join('\n');
  const missing = v2Globals(v2).filter(function (n) { return !declares(v1All, n); });
  if (missing.length) {
    throw new Error('build-page: the v2 scripts use globals the main page no longer declares at top level: ' + missing.join(', '));
  }
  let out = src;
  for (const e of EDITS) {
    const n = countMatches(out, e.find);
    if (n !== e.count) {
      throw new Error('build-page: "' + e.what + '" matched ' + n + ' times in esformlab/index.html, expected ' + e.count);
    }
    const rep = typeof e.replace === 'function' ? e.replace(v2) : e.replace;
    out = typeof e.find === 'string' ? out.split(e.find).join(rep) : out.replace(e.find, rep);
  }
  const stray = strayRelativeUrls(out);
  if (stray.length) {
    throw new Error('build-page: relative path(s) that would load from /esformlab/v2/: ' + stray.join(', ') +
      '. Add them to an edit in esformlab/v2/build-page.js.');
  }
  const banner = '<!-- GENERATED by esformlab/v2/build-page.js from esformlab/index.html. Do not edit by hand. -->\n';
  return out.replace('<!DOCTYPE html>\n', '<!DOCTYPE html>\n' + banner);
}

// The inputs build() takes, read from disk.
function readInputs() {
  const v2 = {};
  V2_SCRIPTS.forEach(function (f) { v2[f] = fs.readFileSync(path.join(__dirname, f), 'utf8'); });
  const modules = V1_MODULES.map(function (m) { return fs.readFileSync(path.join(__dirname, '..', m + '.js'), 'utf8'); });
  return { src: fs.readFileSync(SRC, 'utf8'), v2: v2, modules: modules };
}

module.exports = { build, readInputs, strayRelativeUrls, declares, v2Globals, autoScanAllOf, sha, SRC, OUT, V2_SCRIPTS, V1_MODULES, AUTO_SCAN_ALL_SHA };

if (require.main === module) {
  const inp = readInputs();
  const want = build(inp.src, inp.v2, inp.modules);
  if (process.argv.includes('--check')) {
    const have = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (have !== want) {
      console.error('esformlab/v2/index.html is out of date: run node esformlab/v2/build-page.js');
      process.exit(1);
    }
    console.log('esformlab/v2/index.html matches esformlab/index.html');
  } else {
    fs.writeFileSync(OUT, want);
    console.log('wrote', path.relative(process.cwd(), OUT));
  }
}
