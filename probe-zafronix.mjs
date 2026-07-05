// probe-zafronix.mjs
// בודק את מבנה הגולים ב-Zafronix - במיוחד את הדקות - כדי לוודא שאפשר
// לשחזר את תוצאת ה-90' (לספור גולים עד דקה 90) עבור משחקי הארכה.
//
// הרצה:  node probe-zafronix.mjs Argentina
//        node probe-zafronix.mjs            (מראה משחקים עם הרבה גולים)

const filter = (process.argv[2] ?? '').toLowerCase()
const BASE = 'https://api.zafronix.com/fifa/worldcup/v1'
const KEY  = 'zwc_free_a7e415db810aa0e7fb424586'

const res = await fetch(`${BASE}/matches?year=2026`, { headers: { 'X-API-Key': KEY } })
if (!res.ok) { console.log('❌ HTTP', res.status); process.exit(1) }
const data = await res.json()
const all = data.data ?? []
const finished = all.filter(m => m.status === 'finished')
console.log(`סה"כ: ${all.length} | finished: ${finished.length}`)

let sample = finished
if (filter) sample = finished.filter(m =>
  (m.homeTeam ?? '').toLowerCase().includes(filter) || (m.awayTeam ?? '').toLowerCase().includes(filter))

// עדיפות למשחקים עם גולים אחרי דקה 90 (סימן להארכה)
sample.sort((a, b) => {
  const late = m => (m.goals ?? []).filter(g => g.minute > 90).length
  return late(b) - late(a)
})

for (const m of sample.slice(0, 4)) {
  const goals = (m.goals ?? []).slice().sort((a, b) => a.minute - b.minute)
  const reg = { home: 0, away: 0 }, full = { home: 0, away: 0 }
  for (const g of goals) {
    full[g.team]++
    if (g.minute <= 90) reg[g.team]++
  }
  console.log(`\n=== ${m.homeTeam} נגד ${m.awayTeam}  (matchNo=${m.matchNo ?? m.match_number ?? '?'}) ===`)
  console.log(`homeScore/awayScore (מה-API): ${m.homeScore}-${m.awayScore}`)
  console.log(`דקות גולים: ${goals.map(g => `${g.minute}'(${g.team})`).join(', ') || '—'}`)
  console.log(`תוצאה עד 90':  ${reg.home}-${reg.away}`)
  console.log(`תוצאה כולל 90<:  ${full.home}-${full.away}`)
  if (reg.home !== full.home || reg.away !== full.away) console.log('⬆️  יש גולים אחרי דקה 90 - כאן ההפרש חשוב!')
}

// דוגמה גולמית אחת מלאה כדי לראות את כל השדות של גול
const withGoals = sample.find(m => (m.goals ?? []).length > 0)
if (withGoals) {
  console.log('\n--- דוגמת אובייקט גול גולמי ---')
  console.log(JSON.stringify(withGoals.goals[0], null, 2))
}
