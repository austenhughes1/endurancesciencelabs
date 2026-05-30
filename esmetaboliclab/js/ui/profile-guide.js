/*
 * Plain-English guide to the five headline metrics, shown prominently at the
 * top of the results / Active profile. Minimal, low-jargon: each row says what
 * the number is and how to actually train with it. The lab term is kept small
 * after the everyday name so people can connect it to the cards below.
 *
 * Shared by both the lactate-anchored profile (profile/) and the power/pace
 * estimate (power-profile/) — the metrics mean the same thing either way, so
 * the explanation is identical. Styles live in css/esmetaboliclab.css
 * (.profile-guide / .pg-*). The PDF equivalent is drawPlainGuide() in
 * js/ui/pdf-report.js.
 */

export function profileGuideHtml(sport) {
  const longEffort = sport === 'cycling' ? 'long-ride' : 'long-run';
  const rows = [
    { name: 'Aerobic engine', tech: 'VO₂max',
      what: 'The size of your endurance engine — the most oxygen your body can use.',
      use:  'Your fitness ceiling. Watch this climb as your training pays off.' },
    { name: 'Sprint power', tech: 'VLamax',
      what: 'How fast you fire up your sprint gears (the ones that burn sugar, not fat).',
      use:  'A big one means a strong kick — but it drains fuel fast. Endurance work tames it.' },
    { name: 'Race redline', tech: 'MLSS / threshold',
      what: 'The hardest pace you can hold for about an hour without blowing up.',
      use:  'Your long-race pace. Tempo and threshold workouts belong right here.' },
    { name: 'Easy-day limit', tech: 'LT1',
      what: 'The fastest your easy days should ever feel.',
      use:  'Keep most of your week below this — easy days truly easy is what makes you faster.' },
    { name: 'Fat-burning sweet spot', tech: 'Fatmax',
      what: 'The effort where you burn the most fat for fuel.',
      use:  `Your ${longEffort} / base pace — builds endurance and saves limited carbs for race day.` },
  ];
  const items = rows.map((r) =>
    '<li>' +
      '<span class="pg-name">' + r.name + ' <em>· ' + r.tech + '</em></span>' +
      '<span class="pg-what">' + r.what + '</span>' +
      '<span class="pg-use">↳ ' + r.use + '</span>' +
    '</li>').join('');
  return '' +
    '<div class="profile-guide">' +
      '<div class="profile-guide-eyebrow">★ Your numbers, in plain English</div>' +
      '<h3>What your profile tells you — and how to train with it</h3>' +
      '<ul class="pg-list">' + items + '</ul>' +
    '</div>';
}
