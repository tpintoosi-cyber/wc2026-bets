import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const sa = require('/Users/tomerp/wc2026-bets/serviceAccount.json')
initializeApp({ credential: cert(sa) })
const db = getFirestore()

// קרא את כל השמות הנכונים מ-users
const usersSnap = await db.collection('users').get()
const uidToName = {}
for (const doc of usersSnap.docs) {
  uidToName[doc.id] = doc.data().name
}

// עדכן userName ב-predictions
const predsSnap = await db.collection('predictions').get()
let fixed = 0
for (const doc of predsSnap.docs) {
  const uid = doc.id
  const correctName = uidToName[uid]
  if (correctName && doc.data().userName !== correctName) {
    await doc.ref.update({ userName: correctName })
    console.log(`✅ ${doc.data().userName} → ${correctName}`)
    fixed++
  }
}
console.log(`\nתוקנו ${fixed} רשומות`)
