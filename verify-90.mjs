// verify-90.mjs
// מריץ את לוגיקת ה-90' (זהה ל-getRegulationScore) על כל משחקי הנוקאאוט שהסתיימו
// ב-Zafronix, ומציג טבלה לאימות ידני. לא נוגע בקוד או ב-Firestore.
//
// הרצה:  node verify-90.mjs

const BASE = 'https://api.zafronix.com/fifa/worldcup/v1'
const KEY  = 'zwc_free_a7e415db810aa0e7fb424586'

// ── זהה בדיוק ל-getRegulationScore שב-zafronix.ts ──
function getRegulationScore(match) {
  const goals = match.goals
  if (!goals || goals.length === 0) {
    if (match.homeScore === 0 && match.awayScore === 0) return { home: 0, away: 0 }
    return null
  }
  let fullHome = 0, fullAway = 0, regHome = 0, regAway = 0
  for (const g of goals) {
    if (g.team === 'home') { fullHome++; if (g.minute <= 90) regHome++ }
    else if (g.team === 'away') { fullAway++; if (g.minute <= 90) regAway++ }
  }
  if (match.homeScore != null && match.awayScore != null &&
      (fullHome !== match.homeScore || fullAway !== match.awayScore)) {
    return null
  }
  return { home: regHome, away: regAway }
}

// אילו סבבים נחשבים פלייאוף (Zafronix עשוי לתייג round שונה - נזהה גם לפי match_number/date)
const KO_ROUND_HINTS = ['r32', 'r16', 'qf', 'sf', '3', 'final', 'knock', 'round of', 'quarter', 'semi']

const res = await fetch(`${BASE}/matches?year=2026`, { headers: { 'X-API-Key': KEY } })
if (!res.ok) { console.log('❌ HTTP', res.status); process.exit(1) }
const data = await res.json()
const all = data.data ?? []
const finished = all.filter(m => m.status === 'finished')

// Zafronix לא בהכרח מסמן round; נזהה נוקאאוט לפי matchNo >= 73 (כמו במבנה שלנו) או לפי תגית round
const ko = finished.filter(m => {
  const r = String(m.round ?? '').toLowerCase()
  if (KO_ROUND_HINTS.some(h => r.includes(h))) return true
  return (m.matchNo ?? m.match_number ?? 0) >= 73
})

console.log(`סה"כ finished: ${finished.length} | מזוהים כנוקאאוט: ${ko.length}\n`)
console.log('match# | קבוצות                         | Zafronix סופי | דקות גולים                     | 90\' מחושב | סטטוס')
console.log('-'.repeat(120))

let et = 0, nulls = 0
for (const m of ko.sort((a, b) => (a.matchNo ?? 0) - (b.matchNo ?? 0))) {
  const goals = (m.goals ?? []).slice().sort((a, b) => a.minute - b.minute)
  const reg = getRegulationScore(m)
  const mins = goals.map(g => `${g.minute}'${g.team === 'home' ? 'H' : 'A'}`).join(' ') || '—'
  const final = `${m.homeScore}-${m.awayScore}`
  const hasEt = goals.some(g => g.minute > 90)
  let regStr, status
  if (!reg) { regStr = '⚠️ null'; status = 'לא אמין (גולים לא תואמים לסופי)'; nulls++ }
  else {
    regStr = `${reg.home}-${reg.away}`
    if (hasEt) { status = '⬆️ הארכה - 90\' שונה מהסופי'; et++ }
    else status = 'רגיל'
  }
  const teams = `${m.homeTeam} vs ${m.awayTeam}`.padEnd(30)
  console.log(`${String(m.matchNo ?? m.match_number ?? '?').padEnd(6)} | ${teams} | ${final.padEnd(13)} | ${mins.padEnd(30)} | ${regStr.padEnd(9)} | ${status}`)
}

console.log('-'.repeat(120))
console.log(`\nסיכום: ${ko.length} משחקי נוקאאוט | ${et} עם הארכה (90' שונה) | ${nulls} לא אמינים (null - יישארו כפי שהם)`)
console.log('\nעכשיו תשווה ידנית את עמודת "90\' מחושב" מול מקור אמין (למשל אתר רשמי / ויקיפדיה).')
console.log('שים לב במיוחד למשחקים עם "⬆️ הארכה" - אלה שהתיקון משנה.')
