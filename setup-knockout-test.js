import { createRequire } from "module";
const require = createRequire(import.meta.url);
const admin = require("firebase-admin");
const fs = require("fs");

admin.initializeApp({ credential: admin.credential.cert(require("./serviceAccountKey.json")) });
const db = admin.firestore();

const data = JSON.parse(fs.readFileSync(new URL("./knockout_test_data.json", import.meta.url)));

async function run() {
  console.log("📋 שלב 1: שמירת תוצאות שלב הבתים (72 משחקים)...");
  await db.collection("admin").doc("results").set({
    matches: data.results,
    groups: data.actualGroups,
    bonus: {}
  }, { merge: true });
  console.log("✓ תוצאות נשמרו");

  console.log("\n🏆 שלב 2: הגדרת נבחרות R32...");
  const koMatches = {};
  for (const [mid, teamA, teamB] of data.r32_pairs) {
    koMatches[String(mid)] = {
      id: mid,
      round: "R32",
      teamA,
      teamB,
      isPlayed: false
    };
    console.log(`  #${mid}: ${teamA} vs ${teamB}`);
  }
  await db.collection("admin").doc("knockout").set({ matches: koMatches });
  console.log("✓ נבחרות R32 נשמרו");

  console.log("\n🔓 שלב 3: פתיחת חלון R32...");
  const deadline = Date.now() + (3 * 24 * 60 * 60 * 1000); // 3 days
  await db.collection("settings").doc("app").set({
    knockoutOpen: true,
    knockoutDeadline: deadline,
  }, { merge: true });
  console.log(`✓ חלון פתוח עד ${new Date(deadline).toLocaleString('he-IL')}`);

  console.log("\n✅ הכל מוכן! עכשיו:");
  console.log("1. חשב ניקוד באדמין (שלב בתים)");
  console.log("2. כנס לאפליקציה → טאב 🏆 נוקאאוט → מלא R32");
  process.exit(0);
}
run().catch(e => { console.error(e); process.exit(1); });
