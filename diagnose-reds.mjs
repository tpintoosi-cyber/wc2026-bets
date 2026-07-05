// diagnose-reds.mjs
// מאתר מאיפה מגיע מספר האדומים ולמה הוא ירד מ-12 ל-10 אחרי הסנכרון.
// קורא: admin/liveStats (הערך שמוצג), admin/results (בונוס + אדומים בשלב הבתים),
//        admin/knockout (אדומים בנוקאאוט). לא כותב כלום.
//
// הרצה:  node diagnose-reds.mjs

import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const sa = require('/Users/tomerp/wc2026-bets/serviceAccount.json')
initializeApp({ credential: cert(sa) })
const db = getFirestore()

async function main() {
  const [liveSnap, resSnap, koSnap] = await Promise.all([
    db.doc('admin/liveStats').get(),
    db.doc('admin/results').get(),
    db.doc('admin/knockout').get(),
  ])

  console.log('\n===== admin/liveStats (הערך שמוצג בתצוגה) =====')
  if (liveSnap.exists) {
    const d = liveSnap.data()
    console.log('totalRedCards_num :', d.totalRedCards_num)
    console.log('totalRedCards     :', d.totalRedCards)
    // הצג כל שדה שקשור לאדומים
    for (const [k, v] of Object.entries(d)) {
      if (/red/i.test(k) && k !== 'totalRedCards' && k !== 'totalRedCards_num') console.log(`${k} :`, v)
    }
  } else console.log('❌ אין admin/liveStats')

  console.log('\n===== בונוס אדומים ב-admin/results =====')
  if (resSnap.exists) {
    const bonus = resSnap.data().bonus ?? {}
    const redKeys = Object.keys(bonus).filter(k => /red|אדומ/i.test(k))
    if (redKeys.length) redKeys.forEach(k => console.log(`${k} :`, bonus[k]))
    else {
      console.log('(לא זוהה מפתח אדומים בשם. כל תשובות הבונוס:)')
      for (const [k, v] of Object.entries(bonus)) console.log(`  ${k} :`, v)
    }
  } else console.log('❌ אין admin/results')

  // ספירה בפועל: כמה משחקים סומנו hadRedCard
  console.log('\n===== אדומים פר-משחק (hadRedCard + redCardCount) =====')
  const groupMatches = resSnap.exists ? (resSnap.data().matches ?? {}) : {}
  const koMatches = koSnap.exists ? (koSnap.data().matches ?? {}) : {}

  let groupCards = 0, koCards = 0
  const line = (id, m) => {
    const n = m.redCardCount ?? (m.hadRedCard ? '?(רק בוליאני, בלי מספר)' : 0)
    console.log(`  #${id} ${m.teamA ?? ''} נגד ${m.teamB ?? ''}: ${n} אדומים`)
  }
  console.log('-- שלב הבתים --')
  for (const [id, m] of Object.entries(groupMatches)) {
    if (m?.hadRedCard === true || (m?.redCardCount ?? 0) > 0) { line(id, m); groupCards += (m.redCardCount ?? 1) }
  }
  console.log('-- נוקאאוט --')
  for (const [id, m] of Object.entries(koMatches)) {
    if (m?.hadRedCard === true || (m?.redCardCount ?? 0) > 0) { line(id, m); koCards += (m.redCardCount ?? 1) }
  }
  console.log(`\nסה"כ אדומים לפי redCardCount:  בתים=${groupCards}  נוקאאוט=${koCards}  =>  ${groupCards + koCards}`)
  console.log('(אם רואים "?(רק בוליאני)" -> המשחק סומן לפני התיקון. הרץ סנכרון מחדש כדי לאכלס redCardCount)')

  console.log('\n===== פרשנות =====')
  console.log('- אם 10 = totalRedCards_num אבל תשובת הבונוס הידנית הייתה 12 ->')
  console.log('  הסנכרון דרס את התשובה הידנית עם ספירה חיה חלקית. צריך לתקן את קוד הסנכרון')
  console.log('  שלא יגע ב-totalRedCards אם הוזן ידנית (או שיוסיף במקום להחליף).')
  console.log('- אם ספירת hadRedCard = 10 אבל בפועל היו 12 אדומים -> חלק מהמשחקים לא סומנו hadRedCard.')
  console.log('- שים לב: "כמות אדומים" (סה"כ כרטיסים) שונה מ"מספר משחקים עם אדום" (יכול להיות >1 למשחק).')
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
