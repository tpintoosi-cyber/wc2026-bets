import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const sa = require('/Users/tomerp/wc2026-bets/serviceAccount.json')
initializeApp({ credential: cert(sa) })
const db = getFirestore()

const BRACKET = {
  73:{feederA:null,feederB:null},74:{feederA:null,feederB:null},
  75:{feederA:null,feederB:null},76:{feederA:null,feederB:null},
  77:{feederA:null,feederB:null},78:{feederA:null,feederB:null},
  79:{feederA:null,feederB:null},80:{feederA:null,feederB:null},
  81:{feederA:null,feederB:null},82:{feederA:null,feederB:null},
  83:{feederA:null,feederB:null},84:{feederA:null,feederB:null},
  85:{feederA:null,feederB:null},86:{feederA:null,feederB:null},
  87:{feederA:null,feederB:null},88:{feederA:null,feederB:null},
  89:{feederA:74,feederB:77}, 90:{feederA:73,feederB:75},
  91:{feederA:83,feederB:85}, 92:{feederA:81,feederB:82},
  93:{feederA:76,feederB:78}, 94:{feederA:79,feederB:80},
  95:{feederA:86,feederB:88}, 96:{feederA:84,feederB:87},
  97:{feederA:89,feederB:90}, 98:{feederA:91,feederB:92},
  99:{feederA:93,feederB:94}, 100:{feederA:95,feederB:96},
  101:{feederA:97,feederB:98}, 102:{feederA:99,feederB:100},
  103:{feederA:-101,feederB:-102}, 104:{feederA:101,feederB:102}
}
const ROUNDS = {
  89:'R16',90:'R16',91:'R16',92:'R16',
  93:'R16',94:'R16',95:'R16',96:'R16',
  97:'QF',98:'QF',99:'QF',100:'QF',
  101:'SF',102:'SF',103:'3P',104:'F'
}

const d = await db.collection('admin').doc('knockout').get()
const existing = d.data().matches
const merged = {...existing}

for (const id of [89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104]) {
  merged[id] = { id, round: ROUNDS[id], fifaPointsA:0, fifaPointsB:0 }
}
for (let id=73; id<=88; id++) { if (existing[id]) merged[id] = existing[id] }

for (const [id] of Object.entries(merged)) {
  const m = merged[+id]
  if (!m || !m.advanceTeam) continue
  const b = BRACKET[+id]
  if (!b) continue
  for (const [nid] of Object.entries(merged)) {
    const nb = BRACKET[+nid]
    if (!nb) continue
    if (nb.feederA === +id) merged[+nid] = {...merged[+nid], teamA: m.advanceTeam}
    if (nb.feederB === +id) merged[+nid] = {...merged[+nid], teamB: m.advanceTeam}
  }
}

console.log('TOP:')
for (const id of [89,90,91,92]) console.log(' ', id, merged[id].teamA || '?', 'vs', merged[id].teamB || '?')
console.log('BOTTOM:')
for (const id of [93,94,95,96]) console.log(' ', id, merged[id].teamA || '?', 'vs', merged[id].teamB || '?')

await db.collection('admin').doc('knockout').set({matches: merged})
console.log('נשמר!')
