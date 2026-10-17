// ════════════════════════════════════════════════════════════════
//  Server-side PDF renderer for the esFormLab comparison report.
//
//  Node port of the in-browser downloadComparisonPDF previously in
//  esformlab/index.html. Same motivation as report-renderer.js:
//  the renderer must live server-side so the pass-status check
//  cannot be bypassed from DevTools.
//
//  Pure jsPDF (text/line/rect/circle); reuses constants and helpers
//  from report-renderer.js so the two stay aligned.
// ════════════════════════════════════════════════════════════════

const {
  PAGE_W,
  PHASE_DEFS,
  METRIC_ROWS,
  isRelevant,
  metricSideLabel,
  makeHelpers,
  PDF_COLORS,
  makePdfDoc,
  fmtDate,
  pdfSetText,
  pdfH1,
  pdfFitLines,
  pdfCallout,
  pdfDrawMasthead,
  pdfDrawFooter,
  pdfDrawPageNumbers,
  pdfCheckPage,
  pdfDrawPrinciples,
} = require("./report-renderer");

function cmpSevRank(issue) {
  if (!issue || !issue.detected) return 0;
  if (issue.severity === "mild") return 1;
  if (issue.severity === "notable") return 2;
  return 0;
}

// Missing data never reads "Clear"; a detected torso flag says which way.
function cmpSevText(issue, key) {
  if (issue == null) return "Not measured";
  if (!issue.detected) return "Clear";
  let sev = issue.severity === "notable" ? "Notable" : issue.severity === "mild" ? "Mild" : "Clear";
  if (key === "torsoPosition" && sev !== "Clear") sev += " · " + (issue.cueKey === "torsoLean" ? "lean" : "upright");
  return sev;
}

/**
 * @param {object} input
 * @param {object} input.dA   Saved-analysis data blob for session A
 *                            ({ name, date, sex, issues, phases })
 * @param {object} input.dB   Saved-analysis data blob for session B
 * @param {object} input.liveRanges  { male, female, combined } from
 *                                   Firestore computed_ranges; used
 *                                   only to anchor the per-metric
 *                                   "moved closer to center" colour.
 * @param {string} [input.generatedISO]  YYYY-MM-DD in the caller's local time
 * @returns {Buffer} PDF bytes
 */
function renderComparisonReport(input) {
  const dA = input.dA || {};
  const dB = input.dB || {};
  const issuesA = dA.issues || {};
  const issuesB = dB.issues || {};
  // Sex for the reference ranges: A's, else B's.
  const selectedSex = dA.sex === "male" || dA.sex === "female"
    ? dA.sex
    : (dB.sex === "male" || dB.sex === "female" ? dB.sex : null);
  const { getRange } = makeHelpers(input.liveRanges || {}, selectedSex);
  const C = PDF_COLORS;

  const doc = makePdfDoc();
  const pageW = PAGE_W;
  const margins = { top: 20, bottom: 20, left: 20, right: 20 };
  const contentW = pageW - margins.left - margins.right;
  let y = margins.top;

  const genISO = fmtDate(input.generatedISO) ? input.generatedISO : new Date().toISOString().slice(0, 10);

  // ====== PAGE 1: Cover + Issue Comparison ======

  y = pdfDrawMasthead(doc, y, margins);

  pdfSetText(doc, 20, "bold", C.text);
  doc.text("Session comparison report", margins.left, y);
  y += 7.5;
  pdfSetText(doc, 10, "normal", C.muted);
  doc.text("Generated " + fmtDate(genISO), margins.left, y);
  y += 9;

  // Session cards side by side; names wrap to 2 lines, both cards share the taller height.
  const cardW = (contentW - 8) / 2;
  const cap = (s) => (typeof s === "string" && s ? s.charAt(0).toUpperCase() + s.slice(1) : "");
  const cards = [
    { label: "SESSION A", d: dA, x: margins.left },
    { label: "SESSION B", d: dB, x: margins.left + cardW + 8 },
  ].map((c) => {
    pdfSetText(doc, 11, "bold", C.text);
    const rawName = typeof c.d.name === "string" ? c.d.name.trim() : "";
    const nameLines = pdfFitLines(doc, rawName || "Untitled session", cardW - 8, 2);
    const date = fmtDate(c.d.date) || (typeof c.d.date === "string" ? c.d.date : "");
    const meta = [date, cap(c.d.sex)].filter(Boolean).join("  ·  ");
    return Object.assign(c, { nameLines, meta });
  });
  const cardH = 7 + Math.max(...cards.map((c) => c.nameLines.length)) * 4.6 + 6;
  cards.forEach((c) => {
    doc.setFillColor(...C.boxFill);
    doc.setDrawColor(...C.rule);
    doc.setLineWidth(0.2);
    doc.roundedRect(c.x, y, cardW, cardH, 2, 2, "FD");
    pdfSetText(doc, 8, "bold", C.accent);
    doc.text(c.label, c.x + 4, y + 5);
    pdfSetText(doc, 11, "bold", C.text);
    c.nameLines.forEach((line, i) => doc.text(line, c.x + 4, y + 10.5 + i * 4.6));
    if (c.meta) {
      pdfSetText(doc, 9, "normal", C.muted);
      doc.text(c.meta, c.x + 4, y + 10.5 + (c.nameLines.length - 1) * 4.6 + 4.8);
    }
  });
  y += cardH + 12;

  // Issue comparison table
  y = pdfH1(doc, "Issue comparison", y, margins);

  const issueKeys = [
    { key: "overstriding", title: "Overstriding" },
    { key: "hipDrop", title: "Hip drop" },
    { key: "armsCrossing", title: "Arms crossing midline" },
    { key: "torsoPosition", title: "Torso position" },
    { key: "armAngle", title: "Arm angle" },
    { key: "kneeValgus", title: "Knee valgus" },
  ];

  const colIssueW = 40, colAW = 38, colBW = 38;
  const headerRowH = 9;
  const rowH = 10;
  const tblX = margins.left;
  const issueEdges = [0, colIssueW, colIssueW + colAW, colIssueW + colAW + colBW, contentW];

  function drawVerticals(edges, top, h) {
    doc.setLineWidth(0.2);
    doc.setDrawColor(...C.rule);
    for (let i = 1; i < edges.length - 1; i++) doc.line(tblX + edges[i], top, tblX + edges[i], top + h);
    doc.setDrawColor(...C.ruleStrong);
    doc.line(tblX, top, tblX, top + h);
    doc.line(tblX + contentW, top, tblX + contentW, top + h);
  }

  doc.setFillColor(...C.headFill);
  doc.rect(tblX, y, contentW, headerRowH, "F");
  drawVerticals(issueEdges, y, headerRowH);
  doc.setDrawColor(...C.ruleStrong);
  doc.line(tblX, y, tblX + contentW, y);
  doc.line(tblX, y + headerRowH, tblX + contentW, y + headerRowH);
  pdfSetText(doc, 8, "bold", C.text);
  ["Issue", "Session A", "Session B", "Change"].forEach((h, i) => doc.text(h, tblX + issueEdges[i] + 3, y + 5.8));
  y += headerRowH;

  const sevColor = (issue) => {
    const r = cmpSevRank(issue);
    return r === 2 ? C.bad : r === 1 ? C.warn : C.good;
  };

  issueKeys.forEach((ik, idx) => {
    const a = issuesA[ik.key], b = issuesB[ik.key];
    let dir = "";
    let dirColor = C.muted;
    if (a != null && b != null) {
      if (ik.key === "torsoPosition" && a.detected && b.detected && (a.cueKey || null) !== (b.cueKey || null)) {
        dir = "Changed";
      } else {
        const rA = cmpSevRank(a), rB = cmpSevRank(b);
        dir = rB < rA ? "Improved" : rB === rA ? "No change" : "Worsened";
        if (dir === "Improved") dirColor = C.good;
        else if (dir === "Worsened") dirColor = C.bad;
      }
    }

    drawVerticals(issueEdges, y, rowH);
    if (idx > 0) {
      doc.setDrawColor(...C.rule);
      doc.line(tblX, y, tblX + contentW, y);
    }

    pdfSetText(doc, 9, "normal", C.text);
    doc.text(ik.title, tblX + 3, y + 6.5);

    [[a, issueEdges[1]], [b, issueEdges[2]]].forEach(([iss, edge]) => {
      if (iss == null) pdfSetText(doc, 9, "normal", C.muted);
      else pdfSetText(doc, 9, "bold", sevColor(iss));
      doc.text(cmpSevText(iss, ik.key), tblX + edge + 3, y + 6.5);
    });

    if (dir) {
      pdfSetText(doc, 9, "bold", dirColor);
      doc.text(dir, tblX + issueEdges[3] + 3, y + 6.5);
    }
    y += rowH;
  });

  doc.setDrawColor(...C.ruleStrong);
  doc.line(tblX, y, tblX + contentW, y);

  pdfDrawFooter(doc, margins);

  // ====== PAGE 2+: Angle Comparison Table ======
  doc.addPage();
  pdfDrawFooter(doc, margins);
  y = pdfH1(doc, "Angle measurement comparison", margins.top, margins);

  y = pdfCallout(doc, {
    kind: "info",
    body: "Green: moved closer to the center of the reference range. Amber: moved further from it. Grey: a negligible change (under 0.5° for angles, under 0.02 for foot offsets). Large changes can come from frame selection rather than a real form change. These comparisons are informational -- not every change needs action.",
  }, y, margins) + 8;

  // Phase 30 · Metric 34 · A 36 · B 36 · Change 40 (= 176mm content width).
  const angleEdges = [0, 30, 64, 100, 136, contentW];
  const cmpCellH = 7;
  const cmpHdrH = 9;

  function drawAngleHeader() {
    doc.setFillColor(...C.headFill);
    doc.rect(tblX, y, contentW, cmpHdrH, "F");
    drawVerticals(angleEdges, y, cmpHdrH);
    doc.setDrawColor(...C.ruleStrong);
    doc.line(tblX, y, tblX + contentW, y);
    doc.line(tblX, y + cmpHdrH, tblX + contentW, y + cmpHdrH);
    pdfSetText(doc, 8, "bold", C.text);
    ["Phase", "Metric", "Session A", "Session B", "Change"].forEach((h, i) => doc.text(h, tblX + angleEdges[i] + 2, y + 5.8));
    y += cmpHdrH;
  }

  function pdfCompareRow(pk, pLabel, metricLabel, vA, vB, metricKey, firstInGroup) {
    const ny = pdfCheckPage(doc, y, cmpCellH + 1, margins);
    const newPage = ny < y;
    if (newPage) { y = ny; drawAngleHeader(); }
    const sampleRow = METRIC_ROWS.find((r) => r.key === metricKey) || METRIC_ROWS[0];
    const isOffset = /Foot$/.test(metricKey);
    const tiny = isOffset ? 0.02 : 0.5;
    let delta = "";
    let deltaColor = C.muted;
    let deltaBold = false;
    if (vA != null && vB != null) {
      const diff = vB - vA;
      delta = (diff > 0 ? "+" : "") + diff.toFixed(isOffset ? 2 : 1) + (isOffset ? "" : "°");
      const rng = getRange(pk, metricKey);
      const center = (rng.green[0] + rng.green[1]) / 2;
      if (Math.abs(diff) >= tiny) {
        deltaBold = true;
        deltaColor = Math.abs(vB - center) < Math.abs(vA - center) ? C.good : C.warn;
      }
    }

    drawVerticals(angleEdges, y, cmpCellH);
    if (firstInGroup && !newPage) {
      doc.setDrawColor(...C.ruleStrong);
      doc.setLineWidth(0.3);
      doc.line(tblX, y, tblX + contentW, y);
    } else if (!newPage) {
      doc.setDrawColor(...C.rule);
      doc.setLineWidth(0.15);
      doc.line(tblX, y, tblX + contentW, y);
    }

    pdfSetText(doc, 8.5, "normal", C.text);
    if (firstInGroup || newPage) doc.text(pLabel, tblX + angleEdges[0] + 2, y + 4.9);
    doc.text(metricLabel, tblX + angleEdges[1] + 2, y + 4.9);
    [[vA, angleEdges[2]], [vB, angleEdges[3]]].forEach(([v, edge]) => {
      if (v != null) {
        pdfSetText(doc, 8.5, "normal", C.text, "courier");
        doc.text(sampleRow.fmt(v), tblX + edge + 2, y + 4.9);
      } else {
        pdfSetText(doc, 8.5, "normal", C.muted);
        doc.text("–", tblX + edge + 2, y + 4.9);
      }
    });
    if (delta) {
      pdfSetText(doc, 8.5, deltaBold ? "bold" : "normal", deltaColor, "courier");
      doc.text(delta, tblX + angleEdges[4] + 2, y + 4.9);
    }
    y += cmpCellH;
  }

  drawAngleHeader();
  ["l_foot", "r_foot", "l_toe", "r_toe", "mid"].forEach((pk) => {
    const phA = dA.phases ? dA.phases[pk] : null;
    const phB = dB.phases ? dB.phases[pk] : null;
    const mA = phA ? phA.metrics : null;
    const mB = phB ? phB.metrics : null;
    const pDef = PHASE_DEFS.find((d) => d.key === pk);
    const pLabel = pDef ? pDef.label : pk;

    let first = true;
    METRIC_ROWS.forEach((r) => {
      if (!isRelevant(pk, r.key)) return;
      const vA = mA ? mA[r.key] : null;
      const vB = mB ? mB[r.key] : null;
      if (vA == null && vB == null) return;
      const sl = metricSideLabel(r.key, mA) || metricSideLabel(r.key, mB);
      pdfCompareRow(pk, pLabel, r.label + sl, vA, vB, r.key, first);
      first = false;
    });
  });

  doc.setDrawColor(...C.ruleStrong);
  doc.setLineWidth(0.2);
  doc.line(tblX, y, tblX + contentW, y);

  // ====== Appendix: the generic principles, after the session-specific pages ======
  pdfDrawPrinciples(doc, margins, {
    heading: "Appendix: four universal principles",
    flaggedWhere: "in either session",
    pointsBackTo: "issue comparison is",
  });

  pdfDrawPageNumbers(doc, margins);
  return Buffer.from(doc.output("arraybuffer"));
}

module.exports = { renderComparisonReport };
