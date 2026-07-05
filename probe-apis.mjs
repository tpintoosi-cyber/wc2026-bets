// probe-apis.mjs
// בודק ישירות מול שני ה-APIs אילו שדות יש למשחק נוקאאוט,
// ובמיוחד אם קיימת תוצאת 90 דקות (רגולציה) נפרדת מהתוצאה הסופית (120').
//
// הרצה:  node probe-apis.mjs                 (מראה משחק completed ראשון מכל API)
//        node probe-apis.mjs "Argentina"     (מסנן למשחקים שמכילים את השם הזה)

const filter = (process.argv[2] ?? '').toLowerCase()

// ── wc2026api ──────────────────────────────────────────────
const WC_BASE = 'https://api.wc2026api.com'
const WC_KEY  = 'wc26_6zPBmrp9gE9oeXxePePbUj'

// ── API-Football ───────────────────────────────────────────
const AF_BASE = 'https://v3.football.api-sports.io'
const AF_KEY  = '20d83edc75998775f2f3d9cc402c92c9'

async function probeWc() {
  console.log('\n========== wc2026api ==========')
  try {
    const res = await fetch(`${WC_BASE}/matches`, { headers: { Authorization: `Bearer ${WC_KEY}` } })
    if (!res.ok) { console.log('❌ HTTP', res.status); return }
    const data = await res.json()
    const all = Array.isArray(data) ? data : (data.data ?? data.matches ?? [])
    const ko = all.filter(m => m.round !== 'group')
    const completed = ko.filter(m => m.status === 'completed')
    console.log(`סה"כ: ${all.length} | נוקאאוט: ${ko.length} | completed: ${completed.length}`)

    let sample = completed
    if (filter) sample = completed.filter(m =>
      (m.home_team ?? '').toLowerCase().includes(filter) || (m.away_team ?? '').toLowerCase().includes(filter))

    const m = sample[0] ?? completed[0]
    if (m) {
      console.log('\n--- דוגמת משחק completed (כל השדות) ---')
      console.log(JSON.stringify(m, null, 2))
      console.log('\n🔑 מפתחות זמינים:', Object.keys(m).join(', '))
    } else {
      console.log('אין משחק תואם')
    }
  } catch (e) { console.log('❌', e.message) }
}

async function probeAf() {
  console.log('\n\n========== API-Football (league=1 season=2026) ==========')
  try {
    const res = await fetch(`${AF_BASE}/fixtures?league=1&season=2026`, { headers: { 'x-apisports-key': AF_KEY } })
    if (!res.ok) { console.log('❌ HTTP', res.status); return }
    const data = await res.json()
    const fixtures = data.response ?? []
    console.log(`סה"כ fixtures: ${fixtures.length}`)
    if (data.errors && Object.keys(data.errors).length) console.log('errors:', JSON.stringify(data.errors))

    const completed = fixtures.filter(f => ['FT','AET','PEN'].includes(f.fixture?.status?.short))
    const ko = completed.filter(f => !((f.league?.round ?? '').toLowerCase().includes('group')))
    console.log(`completed: ${completed.length} | נוקאאוט: ${ko.length}`)

    let sample = ko
    if (filter) sample = ko.filter(f =>
      (f.teams?.home?.name ?? '').toLowerCase().includes(filter) || (f.teams?.away?.name ?? '').toLowerCase().includes(filter))

    // עדיפות למשחק שהגיע להארכה/פנדלים (שם 90' שונה מ-120')
    const et = sample.find(f => ['AET','PEN'].includes(f.fixture?.status?.short)) ?? sample[0]
    if (et) {
      console.log('\n--- דוגמת נוקאאוט (שמות + סטטוס + פירוק תוצאה) ---')
      console.log(JSON.stringify({
        home: et.teams?.home?.name,
        away: et.teams?.away?.name,
        status: et.fixture?.status?.short,
        goals: et.goals,               // סופי (אחרי הארכה, בלי פנדלים)
        score: et.score,               // halftime / fulltime(90') / extratime / penalty
        round: et.league?.round,
      }, null, 2))
    } else {
      console.log('אין משחק נוקאאוט תואם')
    }

    // רשימת כל שמות הנבחרות בנוקאאוט (לאיתור אי-התאמות שמות מול העברית)
    const names = [...new Set(ko.flatMap(f => [f.teams?.home?.name, f.teams?.away?.name]))].filter(Boolean).sort()
    console.log('\n🌐 שמות נבחרות בנוקאאוט ב-API-Football:\n', names.join(', '))
  } catch (e) { console.log('❌', e.message) }
}

await probeWc()
await probeAf()
