const { initializeApp, cert } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')
const sa = require('/Users/tomerp/wc2026-bets/serviceAccount.json')
initializeApp({ credential: cert(sa) })
const db = getFirestore()

Promise.all([
  db.collection('users').get(),
  db.collection('predictions').get()
]).then(function(results) {
  const userIds = results[0].docs.map(function(d) { return d.id })
  results[1].docs.forEach(function(d) {
    const found = userIds.indexOf(d.id) >= 0
    if (!found) console.log('חסר:', d.id, d.data().userName)
  })
})
