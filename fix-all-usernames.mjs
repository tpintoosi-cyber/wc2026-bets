import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const sa = require('/Users/tomerp/wc2026-bets/serviceAccount.json')
initializeApp({ credential: cert(sa) })
const db = getFirestore()

const usersSnap = await db.collection('users').get()
const nameMap = {}
usersSnap.docs.forEach(d => { if (d.data().name) nameMap[d.id] = d.data().name })
console.log(`נטענו ${Object.keys(nameMap).length} שמות`)

const predsSnap = await db.collection('predictions').get()
let fixed = 0
for (const doc of predsSnap.docs) {
  const correctName = nameMap[doc.id]
  if (!correctName) { console.log(`⚠️ לא נמצא: ${doc.id}`); continue }
  if (doc.data().userName !== correctName) {
    await doc.ref.update({ userName: correctName })
    console.log(`✅ ${doc.data().userName} → ${correctName}`)
    fixed++
  }
}

const scoresSnap = await db.collection('scores').get()
let fixedScores = 0
for (const doc of scoresSnap.docs) {
  const correctName = nameMap[doc.id]
  if (correctName && doc.data().userName !== correctName) {
    await doc.ref.update({ userName: correctName })
    fixedScores++
  }
}

console.log(`\nתוקנו ${fixed} predictions, ${fixedScores} scores`)
