import { createRequire } from "module";
const require = createRequire(import.meta.url);
const admin = require("firebase-admin");
const fs = require("fs");
admin.initializeApp({ credential: admin.credential.cert(require("./serviceAccountKey.json")) });
const db = admin.firestore();

const users = JSON.parse(fs.readFileSync(new URL("./sim_users_data.json", import.meta.url)));

async function run() {
  console.log(`מכניס ${users.length} משתמשים עם 72 משחקים כל אחד...\n`);
  for (const u of users) {
    await db.collection("predictions").doc(u.id).set({
      userId: u.id, userName: u.name, isLocked: true,
      lastUpdated: Date.now(), matches: u.matches, groups: u.groups, bonus: u.bonus
    });
    console.log(`✓ ${u.name} (${u.style})`);
  }
  console.log(`\n✅ הוכנסו ${users.length} משתמשים.`);
  console.log("📋 עכשיו בדוק את האפליקציה לפני הזנת תוצאות.");
  console.log("🎯 לאחר הבדיקה — הרץ step3-insert-results.js");
  process.exit(0);
}
run().catch(e => { console.error(e); process.exit(1); });
