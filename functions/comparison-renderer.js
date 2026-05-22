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

const { jsPDF } = require("jspdf");
const {
  PHASE_DEFS,
  METRIC_ROWS,
  isRelevant,
  metricSideLabel,
  makeHelpers,
  pdfDrawFooter,
  pdfCheckPage,
} = require("./report-renderer");

function cmpSevRank(issue) {
  if (!issue || !issue.detected) return 0;
  if (issue.severity === "mild") return 1;
  if (issue.severity === "notable") return 2;
  return 0;
}

function cmpSevText(issue) {
  if (!issue || !issue.detected) return "Clear";
  if (issue.severity === "notable") return "Notable";
  if (issue.severity === "mild") return "Mild";
  return "Clear";
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
 * @returns {Buffer} PDF bytes
 */
function renderComparisonReport(input) {
  const dA = input.dA || {};
  const dB = input.dB || {};
  const issuesA = dA.issues || {};
  const issuesB = dB.issues || {};
  // The delta-colouring helper uses 'mid' phase ranges for direction.
  // Either session's sex is fine; default to A's, fall back to B's.
  const selectedSex = dA.sex === "male" || dA.sex === "female"
    ? dA.sex
    : (dB.sex === "male" || dB.sex === "female" ? dB.sex : null);
  const { getRange } = makeHelpers(input.liveRanges || {}, selectedSex);

  const doc = new jsPDF({ unit: "mm", format: "letter" });
  const pageW = 215.9;
  const pageH = 279.4;
  const margins = { top: 20, bottom: 20, left: 20, right: 20 };
  const contentW = pageW - margins.left - margins.right;
  let y = margins.top;

  const accentR = 0, accentG = 137, accentB = 123;
  const bodyR = 51, bodyG = 51, bodyB = 51;
  const mutedR = 119, mutedG = 119, mutedB = 119;
  const goodR = 34, goodG = 199, goodB = 138;
  const warnR = 239, warnG = 108, warnB = 0;
  const badR = 216, badG = 67, badB = 21;

  const dateStr = new Date().toISOString().slice(0, 10);

  // ====== PAGE 1: Cover + Issue Comparison ======

  doc.setFillColor(accentR, accentG, accentB);
  doc.roundedRect(margins.left, y, 16, 16, 3, 3, "F");
  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(255, 255, 255);
  doc.text("ESL", margins.left + 8, y + 10, { align: "center" });

  doc.setTextColor(bodyR, bodyG, bodyB);
  doc.setFontSize(18);
  doc.text("Endurance Science Labs", margins.left + 20, y + 7);
  doc.setFontSize(12);
  doc.setTextColor(accentR, accentG, accentB);
  doc.text("esFormLab", margins.left + 20, y + 14);
  y += 22;

  doc.setDrawColor(accentR, accentG, accentB);
  doc.setLineWidth(0.5);
  doc.line(margins.left, y, pageW - margins.right, y);
  y += 8;

  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(bodyR, bodyG, bodyB);
  doc.text("Session comparison report", margins.left, y);
  y += 6;
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(mutedR, mutedG, mutedB);
  doc.text("Generated " + dateStr, margins.left, y);
  y += 10;

  // Session cards side by side
  const cardW = (contentW - 8) / 2;
  const cardH = 18;

  doc.setFillColor(245, 248, 252);
  doc.setDrawColor(210, 215, 225);
  doc.setLineWidth(0.2);
  doc.roundedRect(margins.left, y, cardW, cardH, 2, 2, "FD");
  doc.setFontSize(8);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(accentR, accentG, accentB);
  doc.text("SESSION A", margins.left + 4, y + 5);
  doc.setFontSize(11);
  doc.setTextColor(bodyR, bodyG, bodyB);
  doc.text(dA.name || "Untitled", margins.left + 4, y + 11);
  doc.setFontSize(9);
  doc.setTextColor(mutedR, mutedG, mutedB);
  doc.text((dA.date || "") + (dA.sex ? "  --  " + dA.sex : ""), margins.left + 4, y + 15);

  const cardBx = margins.left + cardW + 8;
  doc.setFillColor(245, 248, 252);
  doc.roundedRect(cardBx, y, cardW, cardH, 2, 2, "FD");
  doc.setFontSize(8);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(accentR, accentG, accentB);
  doc.text("SESSION B", cardBx + 4, y + 5);
  doc.setFontSize(11);
  doc.setTextColor(bodyR, bodyG, bodyB);
  doc.text(dB.name || "Untitled", cardBx + 4, y + 11);
  doc.setFontSize(9);
  doc.setTextColor(mutedR, mutedG, mutedB);
  doc.text((dB.date || "") + (dB.sex ? "  --  " + dB.sex : ""), cardBx + 4, y + 15);

  y += cardH + 12;

  // Issue comparison table
  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(accentR, accentG, accentB);
  doc.text("Issue comparison", margins.left, y);
  y += 8;

  const issueKeys = [
    { key: "overstriding", title: "Overstriding" },
    { key: "hipDrop", title: "Hip drop" },
    { key: "armsCrossing", title: "Arms crossing midline" },
    { key: "torsoPosition", title: "Torso position" },
    { key: "armAngle", title: "Arm angle" },
    { key: "kneeValgus", title: "Knee valgus" },
  ];

  const colIssueW = 40, colAW = 38, colBW = 38;
  const colDirW = contentW - colIssueW - colAW - colBW;
  const headerRowH = 14;
  const rowH = 10;
  const tblX = margins.left;

  doc.setFillColor(240, 240, 240);
  doc.rect(tblX, y, contentW, headerRowH, "F");
  doc.setDrawColor(204, 204, 204);
  doc.setLineWidth(0.2);
  doc.line(tblX, y, tblX + contentW, y);
  doc.line(tblX, y + headerRowH, tblX + contentW, y + headerRowH);

  doc.setFontSize(7);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(bodyR, bodyG, bodyB);
  doc.text("Issue", tblX + 3, y + 6);
  const hdrNameA = doc.splitTextToSize(dA.name || "A", colAW - 4);
  const hdrNameB = doc.splitTextToSize(dB.name || "B", colBW - 4);
  doc.text(hdrNameA, tblX + colIssueW + 2, y + 5);
  doc.text(hdrNameB, tblX + colIssueW + colAW + 2, y + 5);
  doc.text("Change", tblX + colIssueW + colAW + colBW + 3, y + 6);

  doc.line(tblX + colIssueW, y, tblX + colIssueW, y + headerRowH);
  doc.line(tblX + colIssueW + colAW, y, tblX + colIssueW + colAW, y + headerRowH);
  doc.line(tblX + colIssueW + colAW + colBW, y, tblX + colIssueW + colAW + colBW, y + headerRowH);
  doc.line(tblX, y, tblX, y + headerRowH);
  doc.line(tblX + contentW, y, tblX + contentW, y + headerRowH);

  y += headerRowH;

  issueKeys.forEach((ik) => {
    const a = issuesA[ik.key], b = issuesB[ik.key];
    const rA = cmpSevRank(a), rB = cmpSevRank(b);
    const dir = rB < rA ? "Improved" : rB === rA ? "No change" : "Worsened";
    const sevA = cmpSevText(a), sevB = cmpSevText(b);

    doc.setDrawColor(204, 204, 204);
    doc.setLineWidth(0.2);
    doc.line(tblX, y + rowH, tblX + contentW, y + rowH);

    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(bodyR, bodyG, bodyB);
    doc.text(ik.title, tblX + 3, y + 7);

    if (rA === 2) doc.setTextColor(badR, badG, badB);
    else if (rA === 1) doc.setTextColor(warnR, warnG, warnB);
    else doc.setTextColor(goodR, goodG, goodB);
    doc.setFont("helvetica", "bold");
    doc.text(sevA, tblX + colIssueW + 3, y + 7);

    if (rB === 2) doc.setTextColor(badR, badG, badB);
    else if (rB === 1) doc.setTextColor(warnR, warnG, warnB);
    else doc.setTextColor(goodR, goodG, goodB);
    doc.text(sevB, tblX + colIssueW + colAW + 3, y + 7);

    if (dir === "Improved") doc.setTextColor(goodR, goodG, goodB);
    else if (dir === "Worsened") doc.setTextColor(badR, badG, badB);
    else doc.setTextColor(mutedR, mutedG, mutedB);
    doc.text(dir, tblX + colIssueW + colAW + colBW + 3, y + 7);

    doc.setDrawColor(204, 204, 204);
    doc.line(tblX, y, tblX, y + rowH);
    doc.line(tblX + colIssueW, y, tblX + colIssueW, y + rowH);
    doc.line(tblX + colIssueW + colAW, y, tblX + colIssueW + colAW, y + rowH);
    doc.line(tblX + colIssueW + colAW + colBW, y, tblX + colIssueW + colAW + colBW, y + rowH);
    doc.line(tblX + contentW, y, tblX + contentW, y + rowH);

    y += rowH;
  });

  doc.line(tblX, y, tblX + contentW, y);

  pdfDrawFooter(doc, margins);

  // ====== PAGE 2: Understanding Your Stride ======
  doc.addPage();
  pdfDrawFooter(doc, margins);
  y = margins.top;

  doc.setFontSize(18);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(accentR, accentG, accentB);
  doc.text("How to read your stride", margins.left, y);
  y += 8;
  doc.setDrawColor(accentR, accentG, accentB);
  doc.setLineWidth(0.4);
  doc.line(margins.left, y, pageW - margins.right, y);
  y += 8;

  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(accentR, accentG, accentB);
  const cmpReadRegardless = doc.splitTextToSize(
    "Optimize for these -- even if no issues were flagged. The four principles below are universal: every runner benefits from optimizing for them, regardless of which issues were flagged above, or whether any were flagged at all. Whether your analysis came back clean or flagged a long list, this section is the lens for interpreting your numbers, the framework for separating signal from noise, and where you will figure out what to actually work on.",
    contentW
  );
  doc.text(cmpReadRegardless, margins.left, y);
  y += cmpReadRegardless.length * 4 + 6;

  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(bodyR, bodyG, bodyB);
  const cmpIntro1 = doc.splitTextToSize(
    "Every runner's stride is highly individual, shaped by body proportions, joint mobility, sporting history, injury history, age, and many other factors. What is optimal for one person may be quite different for another -- whether that is stride length, knee angle at toe-off, or any of the dozens of metrics that can be analyzed. There is no single \"perfect\" number for any of these.",
    contentW
  );
  doc.text(cmpIntro1, margins.left, y);
  y += cmpIntro1.length * 4 + 4;

  const cmpIntro2 = doc.splitTextToSize(
    "That said, there are a handful of principles that -- optimized within what is natural for your gait -- will make almost anyone a more efficient, more resilient athlete. Think of them less as a checklist and more as a feedback loop: getting one closer to optimal almost always moves the others in the right direction on its own. The four below are where the highest leverage usually lives, and they are what the cards above are trying to point you toward.",
    contentW
  );
  doc.text(cmpIntro2, margins.left, y);
  y += cmpIntro2.length * 4 + 6;

  const cmpPrinciples = [
    { title: "Stride length should come from push-off, not from reaching ahead", desc: "When stride length is generated by pushing strongly off the back foot to create vertical force, rather than by reaching forward with the lead leg, three things tend to happen at once: your foot lands more underneath your body instead of out in front (less braking, less knee load), ground contact time drops (less load on muscles and tendons), and vertical oscillation goes up -- but productively, because the extra airtime is what is lengthening your stride and allows more time for you to move through the gait cycle efficiently. Reaching with the lead leg lengthens the stride on paper but adds braking force and loads the knee." },
    { title: "A cadence that fits your body", desc: "Not too low (heavy, plodding steps) and not too high (spinning or scuffing without covering ground). Most runners do well somewhere in the 165-185 range, but taller runners may naturally settle lower. Cadence rarely needs to be a direct target on its own -- when push-off improves and stride length lengthens, cadence often improves as well. For one runner, improvement might be an increase in cadence, as they are now landing more underneath the body rather than reaching out in front; for another, it might be a drop in cadence, as they now have enough time for the leg to move through the full gait cycle, without rushing to get the lead foot back on the ground." },
    { title: "Forward lean, from the ankles", desc: "A slight forward lean from the ankles -- not from the waist -- lets you work with gravity rather than against it. This should run through the body as a single line: lean at ankles, neutral pelvis (neither tipped forward into a lower-back arch nor tucked under), ribs stacked over the hips (not flared out), head over the shoulders. When the lean bends at the waist, or the back is arched, you lose the gravity assist and load up the lower back." },
    { title: "Relaxed, compact arms -- without forcing them tight", desc: "Arm carriage affects shoulder tension, breathing, and how much rotational drag your trunk has to absorb every step. Aim for compact, efficient, and relaxed: shoulders dropped (not pulled back), shoulder blades not squeezed together." },
  ];
  cmpPrinciples.forEach((sp) => {
    y = pdfCheckPage(doc, y, 14, margins);
    doc.setFillColor(accentR, accentG, accentB);
    doc.circle(margins.left + 2, y - 1, 1.2, "F");
    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(bodyR, bodyG, bodyB);
    doc.text(sp.title, margins.left + 6, y);
    y += 4;
    doc.setFont("helvetica", "normal");
    doc.setTextColor(mutedR, mutedG, mutedB);
    const dLines = doc.splitTextToSize(sp.desc, contentW - 6);
    doc.text(dLines, margins.left + 6, y);
    y += dLines.length * 4 + 4;
  });

  y = pdfCheckPage(doc, y, 30, margins);
  y += 4;
  doc.setFontSize(13);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(bodyR, bodyG, bodyB);
  doc.text("Tracking your progress with wearable data", margins.left, y);
  y += 6;

  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(bodyR, bodyG, bodyB);
  const cmpTrackingText = doc.splitTextToSize(
    "If you have a running watch or wearable that measures stride length, ground contact time, and vertical oscillation, those numbers are how you will know whether a form change is actually working. (Many heart rate straps measure this accurately, such as the Garmin Pro+). A real improvement to metrics discussed above, for example, should show up as a longer stride length, a lower ground contact time, and a stable or improving vertical ratio (vertical oscillation divided by stride length). The data does not have to move on every metric every time, but the direction should match the cue. If you make a change you think is helping and the data flatly does not move -- or moves the wrong way -- it is probably not the right change for your body, and worth trying something else rather than forcing it.",
    contentW
  );
  doc.text(cmpTrackingText, margins.left, y);
  y += cmpTrackingText.length * 4 + 6;

  y = pdfCheckPage(doc, y, 45, margins);
  doc.setFontSize(13);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(bodyR, bodyG, bodyB);
  doc.text("Why small changes add up", margins.left, y);
  y += 6;

  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(bodyR, bodyG, bodyB);
  const cmpSmallChanges = doc.splitTextToSize(
    "When a form change strengthens push-off, lengthens stride, or shifts cadence closer to your optimal range, the cumulative effect over an hour of running can be surprisingly large. Consider these examples:",
    contentW
  );
  doc.text(cmpSmallChanges, margins.left, y);
  y += cmpSmallChanges.length * 4 + 5;

  const cmpBoxW = (contentW - 6) / 2;
  const cmpBoxH = 22;
  const cmpBoxY = y;

  doc.setFillColor(245, 248, 252);
  doc.roundedRect(margins.left, cmpBoxY, cmpBoxW, cmpBoxH, 2, 2, "F");
  doc.setDrawColor(210, 215, 225);
  doc.setLineWidth(0.2);
  doc.roundedRect(margins.left, cmpBoxY, cmpBoxW, cmpBoxH, 2, 2, "S");
  doc.setFontSize(8);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(accentR, accentG, accentB);
  doc.text("EXAMPLE A: HIGH CADENCE RUNNER", margins.left + 4, cmpBoxY + 5);
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(mutedR, mutedG, mutedB);
  doc.text("Cadence: 190 to 185 spm", margins.left + 4, cmpBoxY + 11);
  doc.text("Ground contact: 230 to 225 ms", margins.left + 4, cmpBoxY + 15);

  const cmpBoxBx = margins.left + cmpBoxW + 6;
  doc.setFillColor(245, 248, 252);
  doc.roundedRect(cmpBoxBx, cmpBoxY, cmpBoxW, cmpBoxH, 2, 2, "F");
  doc.setDrawColor(210, 215, 225);
  doc.roundedRect(cmpBoxBx, cmpBoxY, cmpBoxW, cmpBoxH, 2, 2, "S");
  doc.setFontSize(8);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(accentR, accentG, accentB);
  doc.text("EXAMPLE B: LOW CADENCE RUNNER", cmpBoxBx + 4, cmpBoxY + 5);
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(mutedR, mutedG, mutedB);
  doc.text("Cadence: 165 to 170 spm", cmpBoxBx + 4, cmpBoxY + 11);
  doc.text("Ground contact: 250 to 230 ms", cmpBoxBx + 4, cmpBoxY + 15);

  y = cmpBoxY + cmpBoxH + 6;

  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(bodyR, bodyG, bodyB);
  const cmpPunchline = doc.splitTextToSize(
    "Both of these scenarios result in over 2 minutes less ground contact time per hour of running. That is 2 fewer minutes of your body needing to stabilize while the foot is planted, with load going through your muscles and tendons -- and 2 more minutes spent in the air, traveling forward without exerting force into the ground. While not a linear relationship (e.g., a 3% improvement in flight time like the examples above doesn't necessarily mean exactly 3% faster or 3% less energy used), efficiency improvements and injury risk reduction from that kind of shift can be meaningful.",
    contentW
  );
  doc.text(cmpPunchline, margins.left, y);
  y += cmpPunchline.length * 4 + 4;

  // ====== PAGE 3+: Angle Comparison Table ======
  doc.addPage();
  pdfDrawFooter(doc, margins);
  y = margins.top;

  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(accentR, accentG, accentB);
  doc.text("Angle measurement comparison", margins.left, y);
  y += 8;
  doc.setDrawColor(accentR, accentG, accentB);
  doc.setLineWidth(0.4);
  doc.line(margins.left, y, pageW - margins.right, y);
  y += 8;

  doc.setFillColor(245, 248, 252);
  doc.setDrawColor(210, 215, 225);
  doc.setLineWidth(0.3);
  const cmpDiscLines = doc.splitTextToSize(
    "Values highlighted in green moved closer to the elite reference range center. Values in amber moved further away. Small changes (under 0.5 degrees) are shown in grey. Large deviations may be due to measurement errors or suboptimal frame selection. These comparisons are informational -- not every change needs action.",
    contentW - 12
  );
  const cmpDiscH = cmpDiscLines.length * 4 + 8;
  doc.roundedRect(margins.left, y, contentW, cmpDiscH, 2, 2, "FD");
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(mutedR, mutedG, mutedB);
  doc.text(cmpDiscLines, margins.left + 6, y + 5);
  y += cmpDiscH + 8;

  const cmpColPhase = 26, cmpColMetric = 20;
  const cmpColVal = 28, cmpColDelta = 22;
  const cmpCellH = 7;
  const cmpTblX = margins.left;
  const cmpTblW = contentW;
  const cmpHdrH = 14;

  doc.setFillColor(240, 240, 240);
  doc.rect(cmpTblX, y, cmpTblW, cmpHdrH, "F");
  doc.setDrawColor(204, 204, 204);
  doc.setLineWidth(0.2);
  doc.line(cmpTblX, y, cmpTblX + cmpTblW, y);
  doc.line(cmpTblX, y + cmpHdrH, cmpTblX + cmpTblW, y + cmpHdrH);

  doc.setFontSize(6.5);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(bodyR, bodyG, bodyB);
  doc.text("Phase", cmpTblX + 2, y + 5);
  doc.text("Metric", cmpTblX + cmpColPhase + 2, y + 5);
  const cmpHdrA = doc.splitTextToSize(dA.name || "A", cmpColVal - 4);
  const cmpHdrB = doc.splitTextToSize(dB.name || "B", cmpColVal - 4);
  doc.text(cmpHdrA, cmpTblX + cmpColPhase + cmpColMetric + 2, y + 4);
  doc.text(cmpHdrB, cmpTblX + cmpColPhase + cmpColMetric + cmpColVal + 2, y + 4);
  doc.text("Change", cmpTblX + cmpColPhase + cmpColMetric + cmpColVal * 2 + 2, y + 5);

  const cmpCols = [
    0,
    cmpColPhase,
    cmpColPhase + cmpColMetric,
    cmpColPhase + cmpColMetric + cmpColVal,
    cmpColPhase + cmpColMetric + cmpColVal * 2,
    cmpTblW,
  ];
  cmpCols.forEach((cx) => {
    doc.line(cmpTblX + cx, y, cmpTblX + cx, y + cmpHdrH);
  });

  y += cmpHdrH;

  const cmpSidePhases = ["l_foot", "r_foot", "l_toe", "r_toe", "mid"];

  function pdfCompareRow(pLabel, metricLabel, vA, vB, metricKey) {
    y = pdfCheckPage(doc, y, cmpCellH + 1, margins);
    const sampleRow = METRIC_ROWS.find((r) => r.key === metricKey) || METRIC_ROWS[0];
    const fA = vA != null ? sampleRow.fmt(vA) : "--";
    const fB = vB != null ? sampleRow.fmt(vB) : "--";
    let delta = "";
    let deltaR2 = mutedR, deltaG2 = mutedG, deltaB2 = mutedB;
    if (vA != null && vB != null) {
      const diff = vB - vA;
      delta = (diff > 0 ? "+" : "") + diff.toFixed(1);
      const rng = getRange("mid", metricKey);
      const center = (rng.green[0] + rng.green[1]) / 2;
      if (Math.abs(diff) < 0.5) { deltaR2 = 180; deltaG2 = 180; deltaB2 = 180; }
      else if (Math.abs(vB - center) < Math.abs(vA - center)) { deltaR2 = goodR; deltaG2 = goodG; deltaB2 = goodB; }
      else { deltaR2 = warnR; deltaG2 = warnG; deltaB2 = warnB; }
    }
    doc.setDrawColor(204, 204, 204);
    doc.setLineWidth(0.15);
    doc.line(cmpTblX, y + cmpCellH, cmpTblX + cmpTblW, y + cmpCellH);

    doc.setFontSize(7.5);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(bodyR, bodyG, bodyB);
    doc.text(pLabel.slice(0, 14), cmpTblX + 2, y + 5);
    doc.text(metricLabel, cmpTblX + cmpColPhase + 2, y + 5);
    doc.setFont("courier", "normal");
    doc.setFontSize(7.5);
    doc.text(fA, cmpTblX + cmpColPhase + cmpColMetric + 2, y + 5);
    doc.text(fB, cmpTblX + cmpColPhase + cmpColMetric + cmpColVal + 2, y + 5);
    doc.setFont("courier", "bold");
    doc.setTextColor(deltaR2, deltaG2, deltaB2);
    doc.text(delta, cmpTblX + cmpColPhase + cmpColMetric + cmpColVal * 2 + 2, y + 5);
    cmpCols.forEach((cx) => {
      doc.setDrawColor(204, 204, 204);
      doc.line(cmpTblX + cx, y, cmpTblX + cx, y + cmpCellH);
    });
    y += cmpCellH;
  }

  cmpSidePhases.forEach((pk) => {
    const phA = dA.phases ? dA.phases[pk] : null;
    const phB = dB.phases ? dB.phases[pk] : null;
    const mA = phA ? phA.metrics : null;
    const mB = phB ? phB.metrics : null;
    const pDef = PHASE_DEFS.find((d) => d.key === pk);
    const pLabel = pDef ? pDef.label : pk;

    METRIC_ROWS.forEach((r) => {
      if (!isRelevant(pk, r.key)) return;
      const vA = mA ? mA[r.key] : null;
      const vB = mB ? mB[r.key] : null;
      if (vA == null && vB == null) return;
      const slA = metricSideLabel(r.key, mA);
      const slB = metricSideLabel(r.key, mB);
      const sl = slA || slB;
      pdfCompareRow(pLabel, r.label + sl, vA, vB, r.key);
    });
  });

  doc.setDrawColor(204, 204, 204);
  doc.setLineWidth(0.2);
  doc.line(cmpTblX, y, cmpTblX + cmpTblW, y);

  // ====== Update all page footers with total page count ======
  const cmpTotalPages = doc.internal.getNumberOfPages();
  for (let cp = 1; cp <= cmpTotalPages; cp++) {
    doc.setPage(cp);
    doc.setFontSize(8);
    doc.setTextColor(mutedR, mutedG, mutedB);
    doc.setFillColor(255, 255, 255);
    doc.rect(pageW - margins.right - 30, pageH - 11, 30, 6, "F");
    doc.text("Page " + cp + " of " + cmpTotalPages, pageW - margins.right, pageH - 8, { align: "right" });
  }

  return Buffer.from(doc.output("arraybuffer"));
}

module.exports = { renderComparisonReport };
