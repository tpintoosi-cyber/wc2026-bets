// probe-ko.mjs — בדיקה ממוקדת של משחקי נוקאאוט ב-wc2026api
// מטרה: לראות אם למשחק הארכה יש שדות/תוצאת 90' שלא ראינו, ואם יש endpoint פרטי-משחק.
//
// הרצה:  node probe-ko.mjs

const BASE = 'https://api.wc2026api.com'
const KEY  = 'wc26_6zPBmrp9gE9oeXxePePbUj'
const H = { Authorization: `Bearer ${KEY}` }

const res = await fetch(`${BASE}/matches`, { headers: H })
const data = await res.json()
const all = Array.isArray(data) ? data : (data.data ?? data.matches ?? [])
const ko = all.filter(m => m.round !== 'group')
const completed = ko.filter(m => m.status === 'completed')

// 1) טבלת כל משחקי הנוקאאוט שהסתיימו — id, match_number, phase, תוצאה, פנדלים
console.log('=== משחקי נוקאאוט completed ===')
console.log('id  | match# | round | phase | תוצאה | pens | קבוצות')
for (const m of completed) {
  const pens = (m.home_pen != null || m.away_pen != null) ? `${m.home_pen}-${m.away_pen}` : '—'
  console.log(`${String(m.id).padEnd(3)} | ${String(m.match_number).padEnd(6)} | ${String(m.round).padEnd(5)} | ${String(m.phase ?? '?').padEnd(5)} | ${m.home_score}-${m.away_score} | ${pens.padEnd(5)} | ${m.home_team} vs ${m.away_team}`)
}

// 2) משחקים שהגיעו להארכה/פנדלים (phase != FT) — dump מלא
const etMatches = completed.filter(m => m.phase && m.phase !== 'FT')
console.log(`\n=== משחקי הארכה/פנדלים: ${etMatches.length} ===`)
for (const m of etMatches) {
  console.log(`\n--- #${m.match_number} ${m.home_team} vs ${m.away_team} (phase=${m.phase}) — כל השדות ---`)
  console.log(JSON.stringify(m, null, 2))
}

// 3) נסה endpoint פרטי-משחק לפי id ולפי match_number (אולי מחזיר גולים/90')
const probe = etMatches[0] ?? completed[0]
if (probe) {
  for (const [label, val] of [['id', probe.id], ['match_number', probe.match_number]]) {
    const url = `${BASE}/matches/${val}`
    try {
      const r = await fetch(url, { headers: H })
      console.log(`\n=== GET /matches/${val} (by ${label}) → HTTP ${r.status} ===`)
      if (r.ok) {
        const d = await r.json()
        const obj = d.data ?? d
        console.log('מפתחות:', Object.keys(obj).join(', '))
        if (obj.goals) console.log('goals:', JSON.stringify(obj.goals, null, 2))
        else console.log(JSON.stringify(obj, null, 2).slice(0, 800))
      } else {
        console.log('(אין endpoint כזה או שגיאה)')
      }
    } catch (e) { console.log(`שגיאה: ${e.message}`) }
  }
}
