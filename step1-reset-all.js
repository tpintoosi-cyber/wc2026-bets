import { createRequire } from "module";
const require = createRequire(import.meta.url);
const admin = require("firebase-admin");
admin.initializeApp({ credential: admin.credential.cert(require("./serviceAccountKey.json")) });
const db = admin.firestore();

async function run() {
  console.log("🧹 מנקה את כל הנתונים...\n");

  const collections = ["predictions", "scores"];
  for (const col of collections) {
    const snap = await db.collection(col).get();
    for (const d of snap.docs) {
      await d.ref.delete();
    }
    console.log(`✓ נמחק ${col} (${snap.size} docs)`);
  }

  await db.collection("admin").doc("results").delete();
  console.log("✓ נמחק admin/results");

  await db.collection("admin").doc("schedule").delete();
  console.log("✓ נמחק admin/schedule");

  console.log("\n✅ הכל נוקה. עכשיו הרץ step2-insert-users.js");
  process.exit(0);
}
run().catch(e => { console.error(e); process.exit(1); });
