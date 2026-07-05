// diagnose-ko.mjs
// בדיקה מקיפה: למה שלב השמינית (R16) לא מנוקד?
// משווה את הרשומות של R32 (עובד) מול R16 (שבור) במסמך admin/knockout,
// ובודק אם ה-scores כולל נקודות נוקאאוט.
//
// הרצה:  node diagnose-ko.mjs
// דורש service account. עדכן את הנתיב ל-key שלך אם שונה.

import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const sa = require('/Users/tomerp/wc2026-bets/serviceAccount.json')
initializeApp({ credential: cert(sa) })
const db = getFirestore()

// טווחי ה-id בפרויקט: R32=73-88, R16=89-96, QF=97-100, SF=101-102, 3P=103, F=104
const ROUNDS = {
  R32: range(73, 88),
  R16: range(89, 96),
  QF:  range(97, 100),
  SF:  range(101, 102),
  '3P': [103],
  F:   [104],
}
function range(a, b) { const r = []; for (let i = a; i <= b; i++) r.push(i); return r }

// שדות קריטיים לניקוד. אם אחד מהם חסר -> אין ניקוד למשחק הזה.
const REQUIRED = ['isPlayed', 'resultA', 'resultB', 'advanceTeam']

function fieldState(m, f) {
  if (!m || !(f in m) || m[f] === null || m[f] === undefined || m[f] === '') return '❌ חסר'
  return `✓ ${JSON.stringify(m[f])}`
}

function isScorable(m) {
  return !!(m && m.isPlayed === true && m.resultA != null && m.resultB != null)
}

async function main() {
  const koSnap = await db.doc('admin/knockout').get()
  if (!koSnap.exists) { console.log('❌ אין מסמך admin/knockout'); return }
  const matches = koSnap.data().matches ?? {}

  console.log('\n===== מצב הרשומות ב-admin/knockout =====\n')
  for (const [round, ids] of Object.entries(ROUNDS)) {
    const present = ids.filter(id => matches[id] || matches[String(id)])
    if (present.length === 0) continue
    console.log(`\n--- ${round} ---`)
    for (const id of present) {
      const m = matches[id] ?? matches[String(id)]
      const teams = `${m.teamA ?? '?'} נגד ${m.teamB ?? '?'}`
      const ok = isScorable(m)
      console.log(`#${id} ${teams}  =>  ${ok ? '🟢 מנוקד' : '🔴 לא מנוקד'}`)
      for (const f of REQUIRED) console.log(`      ${f.padEnd(12)}: ${fieldState(m, f)}`)
      if (['R32','R16','QF'].includes(round)) console.log(`      ${'hadRedCard'.padEnd(12)}: ${fieldState(m, 'hadRedCard')}`)
    }
  }

  // סיכום: מי שבור
  console.log('\n===== סיכום =====')
  for (const [round, ids] of Object.entries(ROUNDS)) {
    const present = ids.map(id => matches[id] ?? matches[String(id)]).filter(Boolean)
    if (present.length === 0) continue
    const scorable = present.filter(isScorable).length
    const brokenIds = ids.filter(id => {
      const m = matches[id] ?? matches[String(id)]
      return m && (m.teamA || m.resultA != null) && !isScorable(m)
    })
    console.log(`${round}: ${scorable}/${present.length} מנוקדים` +
      (brokenIds.length ? `  |  שבורים (יש נתונים חלקיים): ${brokenIds.map(i => '#' + i).join(', ')}` : ''))
  }

  // בדיקת scores: האם בכלל יש נקודות נוקאאוט למישהו
  console.log('\n===== scores collection (knockoutPoints) =====')
  const scoresSnap = await db.collection('scores').get()
  let withKo = 0, maxKo = 0
  scoresSnap.forEach(d => {
    const kp = d.data().knockoutPoints ?? 0
    if (kp > 0) withKo++
    if (kp > maxKo) maxKo = kp
  })
  console.log(`סה"כ משתמשים: ${scoresSnap.size} | עם knockoutPoints>0: ${withKo} | מקסימום: ${maxKo}`)
  console.log('(אם R16 שבור אבל יש knockoutPoints>0 -> אלו נקודות R32 בלבד; אחרי תיקון והרצת recalc המספר אמור לעלות)')
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
