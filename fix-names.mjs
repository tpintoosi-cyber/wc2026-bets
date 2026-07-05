import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const sa = require('/Users/tomerp/wc2026-bets/serviceAccount.json')
initializeApp({ credential: cert(sa) })
const db = getFirestore()

// מיפוי: שם נוכחי → שם קצר
const NAME_MAP = {
  'אמיר דרור': 'Amir',
  'Ido Alon': 'Ido',
  'Pinto (Tomer Pinto)': 'Pinto',
  'Tomer Pinto': 'Pinto',
  'ערן רומנו': 'Romano',
  'Ran Reuven': 'Ran',
  'ליעד בן דוד': 'Liad',
  'Lior Margalit': 'Lior',
  'jonathan slutzker': 'Jonathan',
  'יואב שמלה': 'Yoav',
  'יהל שמלה': 'Yahel',
  'Purple Freedom to wear': 'Oded',
  'David Cohen': 'David',
  'mennykon': 'Menny',
  'אביעד שליין': 'Aviad',
  'Ilya Litmanovich': 'Ilya',
  'לידור וקנין': 'Lidor',
  'רועי גינדי': 'Roy',
  'Omer Shamay': 'Omer',
  'Guy R': 'Rasin',
  'ido yeshurun': 'Yeshurun',
  'יזהר הירש': 'Yizhar',
  'לירון יקיר': 'Liron',
  'dror tibi': 'Dror',
  'lital itzik': 'Lital',
  'Guy Milner': 'Milner',
  'elad dror': 'Elad',
  'tony pullen': 'Tony',
  'Jayden Chen': 'Jayden',
  'Eylon Bar': 'Eylon',
  'תמיר בר אילן': 'Tamir',
  'Esti Yossipof': 'Esti',
  'ארי שמלה': 'Ari',
}

const snapshot = await db.collection('users').get()
let fixed = 0, skipped = 0

for (const doc of snapshot.docs) {
  const data = doc.data()
  const currentName = (data.name || '').trim()
  const newName = NAME_MAP[currentName]
  
  if (newName && newName !== currentName) {
    await doc.ref.update({ name: newName })
    console.log(`✅ ${currentName} → ${newName}`)
    fixed++
  } else if (!newName) {
    console.log(`⏭ לא נמצא מיפוי: "${currentName}"`)
    skipped++
  }
}

console.log(`\nסה"כ: תוקנו ${fixed}, דולגו ${skipped}`)
