import { createRequire } from "module";
const require = createRequire(import.meta.url);
const admin = require("firebase-admin");
admin.initializeApp({ credential: admin.credential.cert(require("./serviceAccountKey.json")) });
const db = admin.firestore();

const results = {
  "1": {
    "resultA": 2,
    "resultB": 0,
    "hadRedCard": false,
    "isPlayed": true
  },
  "2": {
    "resultA": 1,
    "resultB": 2,
    "hadRedCard": false,
    "isPlayed": true
  },
  "3": {
    "resultA": 1,
    "resultB": 1,
    "hadRedCard": true,
    "isPlayed": true
  },
  "7": {
    "resultA": 3,
    "resultB": 2,
    "hadRedCard": false,
    "isPlayed": true
  },
  "9": {
    "resultA": 4,
    "resultB": 0,
    "hadRedCard": true,
    "isPlayed": true
  },
  "13": {
    "resultA": 3,
    "resultB": 0,
    "hadRedCard": false,
    "isPlayed": true
  },
  "17": {
    "resultA": 1,
    "resultB": 0,
    "hadRedCard": true,
    "isPlayed": true
  },
  "22": {
    "resultA": 2,
    "resultB": 2,
    "hadRedCard": false,
    "isPlayed": true
  },
  "23": {
    "resultA": 1,
    "resultB": 1,
    "hadRedCard": false,
    "isPlayed": true
  }
};

async function run() {
  console.log("⚽ מזין תוצאות ל-9 משחקים...\n");

  // Load existing results and merge
  const snap = await db.collection("admin").doc("results").get();
  const existing = snap.exists ? (snap.data().matches || {}) : {};
  const merged = { ...existing, ...results };

  await db.collection("admin").doc("results").set({
    matches: merged,
    groups: {},
    bonus: {},
  }, { merge: true });

  console.log("✓ תוצאות נשמרו:");
  const scenarios = [
    "#1  מקסיקו 2-0 ד.אפ   — מועדף מנצח",
    "#2  קוריאה 1-2 צ׳כיה  — הפתעה",
    "#3  קנדה 1-1 בוסניה   — תיקו + כרטיס אדום 🟥",
    "#7  ברזיל 3-2 מרוקו   — מועדף + אובר שערים",
    "#9  גרמניה 4-0 קוראסאו — ניצחון כבד + כרטיס אדום 🟥",
    "#13 ספרד 3-0 כף ורדה  — מועדף",
    "#17 צרפת 1-0 סנגל     — מועדף + כרטיס אדום 🟥",
    "#22 אנגליה 2-2 קרואטיה — תיקו",
    "#23 גאנה 1-1 פנמה     — תיקו",
  ];
  scenarios.forEach(s => console.log("  " + s));

  console.log("\n⚡ עכשיו היכנס לאדמין ולחץ \'חשב ניקוד לכולם\'");
  process.exit(0);
}
run().catch(e => { console.error(e); process.exit(1); });
