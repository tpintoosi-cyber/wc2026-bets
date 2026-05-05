import { createRequire } from "module";
const require = createRequire(import.meta.url);
const admin = require("firebase-admin");
admin.initializeApp({ credential: admin.credential.cert(require("./serviceAccountKey.json")) });
const db = admin.firestore();

// תוצאות עולות מהבית — מקום 1,2,3 לכל בית
const actualGroups = {
  A: ["מקסיקו", "קוריאה הדרומית", "צ'כיה"],
  B: ["קנדה", "צרפת", "ארה\"ב"],
  C: ["ברזיל", "מרוקו", "סקוטלנד"],
  D: ["ארה\"ב", "פרגוואי", "אוסטרליה"],
  E: ["גרמניה", "הולנד", "חוף השנהב"],
  F: ["הולנד", "יפן", "שוודיה"],
  G: ["בלגיה", "ספרד", "איראן"],
  H: ["ספרד", "אורוגוואי", "סעודיה"],
  I: ["צרפת", "נורווגיה", "סנגל"],
  J: ["ארגנטינה", "אוסטריה", "אלג'יריה"],
  K: ["פורטוגל", "קולומביה", "קונגו"],
  L: ["אנגליה", "קרואטיה", "גאנה"],
};

// תשובות נכונות לשאלות בונוס
const actualBonus = {
  q105: "ברזיל",        // אלופת העולם
  q106: "ארגנטינה",     // גמר
  q107: "גרמניה",       // 3-4
  q108: "מבאפה",        // מלך שערים
  q109: "8",            // נבחרות שעברו בלי הפסד
  q110: "בלינגהאם",     // שחקן הטורניר
  q111: "ברזיל",        // יותר מ-15 שערים
  q112: "כף ורדה",      // הפתעה הגדולה
  q113: "E",            // בית עם הכי הרבה שערים
  q114: "H",            // בית עם הכי פחות שערים
  q115: "צרפת",         // שמירה על 0 הכי הרבה
  q116: "10",           // כרטיסים אדומים בטורניר
  q117: "14",           // ניצחונות מועדף
};

async function run() {
  console.log("🏆 מזין עולות מהבית ותשובות בונוס...\n");

  const snap = await db.collection("admin").doc("results").get();
  const existing = snap.exists ? snap.data() : {};

  await db.collection("admin").doc("results").set({
    ...existing,
    groups: actualGroups,
    bonus: actualBonus,
  }, { merge: true });

  console.log("✓ עולות מהבית (12 בתים):");
  Object.entries(actualGroups).forEach(([g, teams]) =>
    console.log(`  בית ${g}: ${teams.join(" → ")}`)
  );

  console.log("\n✓ תשובות בונוס:");
  Object.entries(actualBonus).forEach(([q, a]) =>
    console.log(`  ${q}: ${a}`)
  );

  console.log("\n⚡ עכשיו היכנס לאדמין → לחץ 'חשב ניקוד לכולם'");
  process.exit(0);
}
run().catch(e => { console.error(e); process.exit(1); });
