# ⚽ WC2026 Betting App

אפליקציית הימורים למונדיאל 2026 — חינמית לחלוטין עם GitHub Pages + Firebase.

## הגדרה מהירה (15 דקות)

### שלב 1 — Firebase

1. היכנס ל-[console.firebase.google.com](https://console.firebase.google.com)
2. **Create project** → שם לפי בחירתך
3. הפעל **Authentication** → Sign-in methods → **Google**
4. הפעל **Firestore Database** → Start in production mode → בחר region `europe-west1`
5. הפעל **Firestore rules** → העתק את התוכן מ-`firestore.rules`
6. **Project Settings** → Web app → העתק את ה-config

### שלב 2 — הגדרת הפרויקט

```bash
# שבט את הריפו
git clone https://github.com/YOUR_USERNAME/wc2026-bets.git
cd wc2026-bets
npm install
```

פתח `src/firebase.ts` והחלף את ה-config בשלך:
```ts
const firebaseConfig = {
  apiKey: "...",
  authDomain: "...",
  projectId: "...",
  // ...
}
```

### שלב 3 — הגדרת GitHub Pages

1. `vite.config.ts` — ודא ש-`base` תואם לשם הריפו שלך:
   ```ts
   base: '/wc2026-bets/'  // ← שנה אם שם הריפו שונה
   ```
2. GitHub → Settings → Pages → Source: **GitHub Actions**
3. דחוף ל-main → האפליקציה תיפרס אוטומטית

### שלב 4 — הגדרת אדמין

1. היכנס לאפליקציה עם חשבון Google שלך
2. בFirestore console, עבור ל-`settings/app` → צור document:
   ```json
   {
     "isOpen": true,
     "deadline": null,
     "adminUids": ["ה-UID שלך מ-Authentication → Users"]
   }
   ```

---

## מבנה הפרויקט

```
src/
├── data/matches.ts     ← 72 משחקים + נתוני FIFA
├── scoring.ts          ← מנוע ניקוד מלא
├── types.ts            ← TypeScript types
├── firebase.ts         ← Firebase config (⚠️ שנה!)
├── hooks/useAuth.ts    ← Google login + admin check
├── pages/
│   ├── Login.tsx       ← דף כניסה
│   ├── Predict.tsx     ← טופס הימורים (3 tabs)
│   ├── Leaderboard.tsx ← טבלת ניקוד חיה
│   └── Admin.tsx       ← ממשק אדמין
└── styles/global.css   ← כל ה-CSS
```

## מערכת הניקוד

### לכל משחק
| מרכיב | נקודות |
|-------|--------|
| 1X2 נכון — מועדף | 1 |
| 1X2 נכון — תיקו Cat C | 2 |
| 1X2 נכון — תיקו Cat D | 3 |
| 1X2 נכון — הפתעה Cat B | 2 |
| 1X2 נכון — הפתעה Cat C | 3 |
| 1X2 נכון — הפתעה Cat D | 4 |
| תוצאה מדויקת | 2 + 1 בונוס = 3 |
| הפרש נכון בלבד | 1 |
| כרטיס אדום נכון | +1 |

### נבחרות עולות
- מקום מדויק: 2 נק׳
- נבחרת נכונה מקום שגוי: 1 נק׳

### בונוס
אלוף העולם: 17-20 | מלך השערים: 8 | ועוד

## תזרים עבודה אדמין

1. לוחצים **⚡ חשב ניקוד** → טבלה מתעדכנת אוטומטית
2. הדדליין נסגר אוטומטית לפי timestamp

## פיתוח מקומי

```bash
npm run dev
```
