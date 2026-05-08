import { useState } from 'react'
import { doc, setDoc, writeBatch } from 'firebase/firestore'
import { db } from '../firebase'
import { computeUserScore } from '../scoring'
import { MATCHES, TEAM_FIFA_POINTS, calcCategoryByRound } from '../data/matches'
import { populateR32Teams } from '../utils/syncLogic'
import type { Match, MatchPrediction, GroupPrediction, KnockoutMatch, KnockoutMatchPrediction, KnockoutRedCardPicks } from '../types'

// ── Types ─────────────────────────────────────────────────────────────────────
interface SimUser {
  uid: string
  name: string
  description: string
  predictions: Record<number, MatchPrediction>
  groupPredictions: Record<string, GroupPrediction>
}

interface KnockoutSimUser {
  uid: string
  name: string
  description: string
  knockoutPreds: Record<number, KnockoutMatchPrediction>
  redCards: KnockoutRedCardPicks
}

interface ScenarioResult {
  uid: string
  name: string
  matchPoints: number
  redCardPoints: number
  groupPoints: number
  total: number
  breakdown: string[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const pred = (
  matchId: number,
  x: '1'|'X'|'2',
  scoreA: number|null = null,
  scoreB: number|null = null,
  redCard = false
): MatchPrediction => ({
  matchId, prediction1X2: x as any,
  scoreA: scoreA as any, scoreB: scoreB as any, redCard,
})

// ── Scenarios ─────────────────────────────────────────────────────────────────
//
// Match reference (Round 1):
//  7 : Brazil(A) vs Morocco(A)         Cat A  aIsFav=true  (1761>1756 barely)
//  2 : S.Korea   vs Czechia            Cat A  aIsFav=true  (1589>1501)
// 14 : Belgium   vs Egypt              Cat B  aIsFav=true  (1735>1563)
//  3 : Canada    vs Bosnia             Cat B  aIsFav=true  (1556>1386)
//  1 : Mexico    vs S.Africa           Cat C  aIsFav=true  (1681>1430)
//  8 : Haiti     vs Scotland           Cat C  aIsFav=false (1292<1498)
//  9 : Germany   vs Curaçao            Cat D  aIsFav=true  (1730>1295)
// 13 : Spain     vs Cape Verde         Cat D  aIsFav=true  (1876>1366)
// 15 : S.Arabia  vs Uruguay            Cat C  aIsFav=false (1421<1673)
// 17 : France    vs Senegal            Cat B  aIsFav=true  (1877>1689)
// 10 : Netherlands vs Japan            Cat A  aIsFav=true  (1758>1660)
//  4 : USA       vs Paraguay           Cat B  aIsFav=true  (1673>1504)

const SCENARIOS: {
  id: string
  name: string
  description: string
  icon: string
  details: string[]
  results: Partial<Match>[]
  users: SimUser[]
  groupResults?: Record<string, [string,string,string]>
}[] = [

  // ── Scenario 1: 1X2 across all categories ────────────────────────────────
  {
    id: 'cat-1x2',
    name: 'קטגוריות ו-1X2',
    icon: '🎯',
    description: 'בודק ניקוד 1X2 לכל 4 הקטגוריות: מועדף מנצח, אנדרדוג מנצח, תיקו',
    details: [
      '📋 משחקים בשימוש:',
      '  #7 ברזיל vs מרוקו — Cat A (FIFA: 1761 vs 1756) — ברזיל מנצח 2:0',
      '  #2 קוריאה הדרומית vs צ׳כיה — Cat A (1589 vs 1501) — צ׳כיה מנצח (קטגוריה A, עדיין 1נק)',
      '  #14 בלגיה vs מצרים — Cat B (1735 vs 1563) — בלגיה מנצח 2:1',
      '  #3 קנדה vs בוסניה — Cat B (1556 vs 1386) — בוסניה מנצח (אנדרדוג Cat B = 2נק)',
      '  #1 מקסיקו vs דרום אפריקה — Cat C (1681 vs 1430) — מקסיקו מנצח 2:0',
      '  #8 האיטי vs סקוטלנד — Cat C (1292 vs 1498) — האיטי מנצח (אנדרדוג Cat C = 3נק)',
      '  #9 גרמניה vs קוראסאו — Cat D (1730 vs 1295) — גרמניה מנצח 3:0',
      '  #13 ספרד vs כף ורדה — Cat D (1876 vs 1366) — כף ורדה מנצח (אנדרדוג Cat D = 4נק)',
      '👤 "מועדפים תמיד" — בוחר מועדף: ✓ 4 פעמים × 1נק = 4נק',
      '👤 "מפתיעים תמיד" — בוחר אנדרדוג: Cat A=1, Cat B=2, Cat C=3, Cat D=4 = 10נק',
      '👤 "תיקו תמיד" — בוחר X: 0נק (אין תיקו בתוצאות)',
      '👤 "הכל שגוי" — הפוך מהתוצאה: ~0נק',
      '✅ ציפייה: מפתיעים (10) > מועדפים (4) > תיקו (0)',
    ],
    results: [
      // Cat A: Brazil wins (favorite)
      { id: 7,  resultA: 2, resultB: 0, isPlayed: true },
      // Cat A: Czechia wins (slight upset — A category so still 1pt)
      { id: 2,  resultA: 0, resultB: 1, isPlayed: true },
      // Cat B: Belgium wins (favorite)
      { id: 14, resultA: 2, resultB: 1, isPlayed: true },
      // Cat B: Bosnia wins (underdog → 2pts)
      { id: 3,  resultA: 0, resultB: 1, isPlayed: true },
      // Cat C: Mexico wins (favorite → 1pt)
      { id: 1,  resultA: 2, resultB: 0, isPlayed: true },
      // Cat C: Haiti wins over Scotland (underdog → 3pts)
      { id: 8,  resultA: 1, resultB: 0, isPlayed: true },
      // Cat D: Germany wins (favorite → 1pt)
      { id: 9,  resultA: 3, resultB: 0, isPlayed: true },
      // Cat D: Cape Verde beats Spain (huge upset → 4pts)
      { id: 13, resultA: 0, resultB: 1, isPlayed: true },
    ],
    users: [
      {
        uid: 'sim-u1', name: 'מועדפים תמיד', description: 'בוחר תמיד את הנבחרת החזקה יותר',
        groupPredictions: {},
        predictions: {
          7: pred(7,'1'), 2: pred(2,'1'), 14: pred(14,'1'), 3: pred(3,'1'),
          1: pred(1,'1'), 8: pred(8,'2'), 9: pred(9,'1'), 13: pred(13,'1'),
        }
        // Expected: 7✓(1), 2✗(0), 14✓(1), 3✗(0), 1✓(1), 8✗(0), 9✓(1), 13✗(0) = 4pts
      },
      {
        uid: 'sim-u2', name: 'מפתיעים תמיד', description: 'בוחר תמיד את הנבחרת החלשה יותר',
        groupPredictions: {},
        predictions: {
          7: pred(7,'2'), 2: pred(2,'2'), 14: pred(14,'2'), 3: pred(3,'2'),
          1: pred(1,'2'), 8: pred(8,'1'), 9: pred(9,'2'), 13: pred(13,'2'),
        }
        // Expected: 7✗(0), 2✓cat-A(1), 14✗(0), 3✓cat-B(2), 1✗(0), 8✓cat-C(3), 9✗(0), 13✓cat-D(4) = 10pts
      },
      {
        uid: 'sim-u3', name: 'תיקו תמיד', description: 'בוחר תמיד X (תיקו)',
        groupPredictions: {},
        predictions: {
          7: pred(7,'X'), 2: pred(2,'X'), 14: pred(14,'X'), 3: pred(3,'X'),
          1: pred(1,'X'), 8: pred(8,'X'), 9: pred(9,'X'), 13: pred(13,'X'),
        }
        // Expected: all 0pts (no draws in results)
      },
      {
        uid: 'sim-u4', name: 'הכל שגוי', description: 'כל הניחושים הפוכים',
        groupPredictions: {},
        predictions: {
          7: pred(7,'2'), 2: pred(2,'1'), 14: pred(14,'2'), 3: pred(3,'1'),
          1: pred(1,'2'), 8: pred(8,'2'), 9: pred(9,'2'), 13: pred(13,'1'),
        }
        // Expected: 0pts for 1X2, but 2 also picks upset winners...
        // Actually 2: aIsFav=true, result=B wins → underdog → '2' is correct = 1pt
        // and 3: Bosnia wins, '1'=Canada=wrong. etc.
        // "הכל שגוי" designed to be maximally wrong, may get some accidentally
      },
    ],
  },

  // ── Scenario 2: Score bonuses (exact + O/U) ───────────────────────────────
  {
    id: 'score-bonus',
    name: 'תוצאה ו-O/U בונוס',
    icon: '⚽',
    description: 'בודק ניקוד תוצאה מדויקת (2נק), מרווח נכון (1נק), ובונוס אנדר/אובר',
    details: [
      '📋 משחקים בשימוש:',
      '  #7 ברזיל vs מרוקו — Cat A — תוצאה 1:0 (סה"כ 1 שער = Under ✓ Cat A/B: ≤1)',
      '  #17 צרפת vs סנגל — Cat B — תוצאה 4:1 (סה"כ 5 שערים = Over ✓ Cat A/B: ≥4)',
      '  #1 מקסיקו vs דרום אפריקה — Cat C — תוצאה 3:0 (סה"כ 3 שערים = אין בונוס Cat C/D: ≤2 או ≥5)',
      '  #9 גרמניה vs קוראסאו — Cat D — תוצאה 5:0 (סה"כ 5 שערים = Over ✓ Cat C/D: ≥5)',
      '  #10 הולנד vs יפן — Cat A — תיקו 0:0 (סה"כ 0 שערים = Under ✓)',
      '👤 "תוצאה מדויקת" — מנחש בדיוק: 1X2(1) + תוצאה(2) + O/U(1) = 4נק לרוב',
      '    ציפייה: 4+4+3+4+4 = 19נק',
      '👤 "מרווח נכון" — מנחש מרווח נכון אבל לא תוצאה: 1X2(1) + מרווח(1) = 2נק לרוב',
      '    ציפייה: ~9נק',
      '👤 "1X2 בלבד" — רק 1X2, בלי תוצאה: 1נק למשחק',
      '    ציפייה: 5נק',
      '✅ כלל חשוב: O/U בונוס ניתן רק על תוצאה מדויקת!',
    ],
    results: [
      // Cat A: 1:0 → 1 goal → Under bonus ✓ (Cat A/B: ≤1 goal)
      { id: 7, resultA: 1, resultB: 0, isPlayed: true },
      // Cat B: 4:1 → 5 goals → Over bonus ✓ (Cat A/B: ≥4 goals)
      { id: 17, resultA: 4, resultB: 1, isPlayed: true },
      // Cat C: 3:0 → 3 goals → NO bonus (Cat C/D: ≤2 or ≥5)
      { id: 1, resultA: 3, resultB: 0, isPlayed: true },
      // Cat D: 5:0 → 5 goals → Over bonus ✓ (Cat C/D: ≥5)
      { id: 9, resultA: 5, resultB: 0, isPlayed: true },
      // Cat A draw: 0:0 → Under bonus (≤1 goal total)
      { id: 10, resultA: 0, resultB: 0, isPlayed: true },
    ],
    users: [
      {
        uid: 'sim-u1', name: 'תוצאה מדויקת', description: 'מנחש את התוצאה המדויקת + 1X2 נכון',
        groupPredictions: {},
        predictions: {
          7:  pred(7,  '1', 1, 0),  // exact 1:0 Cat A fav → 1+2+1(OU)=4pts
          17: pred(17, '1', 4, 1),  // exact 4:1 Cat B fav → 1+2+1(OU)=4pts
          1:  pred(1,  '1', 3, 0),  // exact 3:0 Cat C fav → 1+2+0=3pts (no OU)
          9:  pred(9,  '1', 5, 0),  // exact 5:0 Cat D fav → 1+2+1(OU)=4pts
          10: pred(10, 'X', 0, 0),  // exact 0:0 Cat A draw → 1+2+1(OU)=4pts
        }
        // Total expected: 4+4+3+4+4 = 19pts
      },
      {
        uid: 'sim-u2', name: 'מרווח נכון', description: 'מנחש 1X2 + מרווח נכון, תוצאה שונה',
        groupPredictions: {},
        predictions: {
          7:  pred(7,  '1', 2, 1),  // Cat A fav ✓, score 2:1≠1:0 but margin=1=1 → 1+1=2pts (wait, margin is |2-1|=1 vs |1-0|=1, same → 1pt)
          17: pred(17, '1', 3, 0),  // Cat B fav ✓, score 3:0≠4:1 but margin=3≠3... 4-1=3, 3-0=3 → same margin → 1pt; 1+1=2pts (but no OU: 3 goals≠bonus range for B)
          1:  pred(1,  '1', 2, 1),  // Cat C fav ✓, actual 3:0 margin=3, pred 2:1 margin=1 → no margin match → just 1pt
          9:  pred(9,  '1', 4, 1),  // Cat D fav ✓, actual 5:0 margin=5, pred 4:1 margin=3 → no → just 1pt (no OU: 5 goals total pred is 5 → wait no prediction is 4+1=5 → over ✓) → 1+1(OU)=2pts... 
          10: pred(10, 'X', 1, 1),  // Cat A draw ✓, score 1:1≠0:0, margin 0=0 → 1pt margin; 1+1=2pts (but 2 goals=no OU for A/B)
        }
        // Approx expected: 2+2+1+2+2 = 9pts
      },
      {
        uid: 'sim-u3', name: '1X2 בלבד', description: 'רק מנחש 1X2, ללא תוצאה',
        groupPredictions: {},
        predictions: {
          7: pred(7,'1'), 17: pred(17,'1'), 1: pred(1,'1'), 9: pred(9,'1'), 10: pred(10,'X'),
        }
        // Expected: 1+1+1+1+1 = 5pts (Cat A draw=1pt)
      },
    ],
  },

  // ── Scenario 3: Red cards ─────────────────────────────────────────────────
  {
    id: 'red-cards',
    name: 'כרטיסי אדום',
    icon: '🟥',
    description: 'בודק ניקוד כרטיס אדום: חיזוי נכון (+2נק), חיזוי שגוי (0)',
    details: [
      '📋 משחקים בשימוש:',
      '  #9 גרמניה vs קוראסאו — היה כרטיס אדום ✓',
      '  #14 בלגיה vs מצרים — לא היה כרטיס אדום ✗',
      '  #1 מקסיקו vs דרום אפריקה — היה כרטיס אדום ✓',
      '👤 "כרטיס נכון" — מסמן כרטיס רק לאלו שהיה: +2 × 2 = 4נק מכרטיסים',
      '    ציפייה: 1X2(3) + כרטיסים(4) = 7נק',
      '👤 "כרטיס שגוי" — מסמן הפוך (כרטיס כשלא היה, ולא מסמן כשהיה): 0נק מכרטיסים',
      '    ציפייה: 1X2(3) + כרטיסים(0) = 3נק',
      '👤 "כרטיס לכולם" — מסמן כרטיס לכל משחק: +2 × 2 (שני הנכונים) = 4נק',
      '    ציפייה: 7נק (זהה ל"כרטיס נכון" כי אין קנס על סימון שגוי)',
      '✅ כלל חשוב: כרטיס אדום שגוי לא מוריד נקודות — רק כרטיס נכון מוסיף',
    ],
    results: [
      { id: 9,  resultA: 3, resultB: 0, isPlayed: true, hadRedCard: true  }, // red card occurred
      { id: 14, resultA: 2, resultB: 1, isPlayed: true, hadRedCard: false }, // no red card
      { id: 1,  resultA: 1, resultB: 0, isPlayed: true, hadRedCard: true  }, // red card occurred
    ],
    users: [
      {
        uid: 'sim-u1', name: 'כרטיס נכון', description: 'מסמן כרטיס אדום לכל המשחקים עם כרטיס',
        groupPredictions: {},
        predictions: {
          9:  pred(9,  '1', null, null, true),   // red ✓ → +2
          14: pred(14, '1', null, null, false),  // no red ✓ → 0
          1:  pred(1,  '1', null, null, true),   // red ✓ → +2
        }
        // Expected: 1(1X2)+2(red) + 1(1X2)+0 + 1(1X2)+2(red) = 7pts
      },
      {
        uid: 'sim-u2', name: 'כרטיס שגוי', description: 'מסמן כרטיס אדום כשלא היה ולא מסמן כשהיה',
        groupPredictions: {},
        predictions: {
          9:  pred(9,  '1', null, null, false),  // no red pred, but was red → 0 red
          14: pred(14, '1', null, null, true),   // red pred, but wasn't → 0 red
          1:  pred(1,  '1', null, null, false),  // no red pred, but was red → 0 red
        }
        // Expected: 1+0 + 1+0 + 1+0 = 3pts
      },
      {
        uid: 'sim-u3', name: 'כרטיס לכולם', description: 'מסמן כרטיס אדום לכל המשחקים',
        groupPredictions: {},
        predictions: {
          9:  pred(9,  '1', null, null, true),  // ✓ red
          14: pred(14, '1', null, null, true),  // ✗ red (wasn't)
          1:  pred(1,  '1', null, null, true),  // ✓ red
        }
        // Expected: 1+2 + 1+0 + 1+2 = 7pts (same as user1 since no-red match doesn't penalize)
      },
    ],
  },

  // ── Scenario 4: Group qualifiers ──────────────────────────────────────────
  {
    id: 'groups',
    name: 'עולות מהבתים',
    icon: '🏅',
    description: 'בודק ניקוד עולות: מקום מדויק (2נק), קבוצה נכונה מקום שגוי (1נק)',
    details: [
      '📋 תוצאות עולות שנקבעו:',
      '  בית A: מקסיקו 1ה, קוריאה הדרומית 2ה, צ׳כיה 3ה',
      '  בית B: קנדה 1ה, שווייץ 2ה, בוסניה 3ה',
      '👤 "קבוצות מדויק" — מקום מדויק לשתי הקבוצות: 2נק × 2 × 2 בתים = 8נק',
      '👤 "קבוצות הפוכות" — קבוצות נכונות אבל מקום הפוך (1ה↔2ה): 1נק × 2 × 2 = 4נק',
      '👤 "קבוצה אחת נכונה" — מנחש נכון רק את ה-1ה: 2נק × 2 בתים = 4נק',
      '👤 "הכל שגוי" — קבוצות שלא עלו כלל: 0נק',
      '✅ ציפייה: מדויק(8) > הפוכות(4) = קבוצה אחת(4) > שגוי(0)',
      '📌 הגיון: ניחוש נכון של 1ה במדויק (2נק) = ניחוש שתי קבוצות בהפוכות (1+1)',
    ],
    results: [
      { id: 1, resultA: 3, resultB: 0, isPlayed: true },
      { id: 2, resultA: 2, resultB: 1, isPlayed: true },
    ],
    groupResults: {
      A: ['מקסיקו', 'קוריאה הדרומית', 'צ׳כיה'],
      B: ['קנדה', 'שווייץ', 'בוסניה'],
    },
    users: [
      {
        uid: 'sim-u1', name: 'קבוצות מדויק', description: 'מנחש מיקום מדויק לשתי הקבוצות',
        predictions: { 1: pred(1,'1'), 2: pred(2,'1') },
        groupPredictions: {
          A: { group: 'A' as any, advancing: ['מקסיקו', 'קוריאה הדרומית', 'צ׳כיה'] }, // exact → 2+2=4pts
          B: { group: 'B' as any, advancing: ['קנדה', 'שווייץ', 'בוסניה'] },           // exact → 2+2=4pts
        },
      },
      {
        uid: 'sim-u2', name: 'קבוצות הפוכות', description: 'הקבוצות נכונות אבל מקום הפוך',
        predictions: { 1: pred(1,'1'), 2: pred(2,'1') },
        groupPredictions: {
          A: { group: 'A' as any, advancing: ['קוריאה הדרומית', 'מקסיקו', 'צ׳כיה'] }, // right teams wrong order → 1+1=2pts
          B: { group: 'B' as any, advancing: ['שווייץ', 'קנדה', 'בוסניה'] },           // right teams wrong order → 1+1=2pts
        },
      },
      {
        uid: 'sim-u3', name: 'קבוצה אחת נכונה', description: 'מנחש רק את הראשון נכון',
        predictions: { 1: pred(1,'1'), 2: pred(2,'1') },
        groupPredictions: {
          A: { group: 'A' as any, advancing: ['מקסיקו', 'בוסניה', 'ברזיל'] }, // 1st exact(2), 2nd wrong(0) = 2pts
          B: { group: 'B' as any, advancing: ['קנדה', 'בוסניה', 'ברזיל'] },   // 1st exact(2), 2nd wrong(0) = 2pts
        },
      },
      {
        uid: 'sim-u4', name: 'הכל שגוי', description: 'שתי קבוצות לא נכונות לכל בת',
        predictions: { 1: pred(1,'1'), 2: pred(2,'1') },
        groupPredictions: {
          A: { group: 'A' as any, advancing: ['ברזיל', 'צרפת', 'גרמניה'] }, // both wrong → 0pts
          B: { group: 'B' as any, advancing: ['ברזיל', 'צרפת', 'גרמניה'] }, // both wrong → 0pts
        },
      },
    ],
  },

  // ── Scenario 5: Draws ────────────────────────────────────────────────────
  {
    id: 'draws',
    name: 'תיקו לפי קטגוריה',
    icon: '🤝',
    description: 'בודק ניקוד תיקו: Cat A/B=1נק, Cat C=2נק, Cat D=3נק',
    details: [
      '📋 כל 4 המשחקים מסתיימים בתיקו:',
      '  #10 הולנד vs יפן — Cat A תיקו → X = 1נק',
      '  #4 ארה"ב vs פרגוואי — Cat B תיקו → X = 1נק',
      '  #1 מקסיקו vs דרום אפריקה — Cat C תיקו → X = 2נק',
      '  #9 גרמניה vs קוראסאו — Cat D תיקו → X = 3נק',
      '👤 "תיקו לכולם" — בוחר X לכל המשחקים: 1+1+2+3 = 7נק',
      '👤 "1X2 רגיל" — בוחר מועדף לנצח (1): 0נק (כולם הסתיימו בתיקו)',
      '✅ ציפייה: תיקו(7) >> 1X2(0)',
      '📌 הגיון: תיקו שווה יותר נקודות ככל שהקטגוריה גבוהה יותר (הפתעה גדולה יותר)',
    ],
    results: [
      { id: 10, resultA: 1, resultB: 1, isPlayed: true }, // Cat A draw
      { id: 4,  resultA: 0, resultB: 0, isPlayed: true }, // Cat B draw
      { id: 1,  resultA: 2, resultB: 2, isPlayed: true }, // Cat C draw
      { id: 9,  resultA: 1, resultB: 1, isPlayed: true }, // Cat D draw
    ],
    users: [
      {
        uid: 'sim-u1', name: 'תיקו לכולם', description: 'מנחש X לכל המשחקים',
        groupPredictions: {},
        predictions: {
          10: pred(10,'X'), 4: pred(4,'X'), 1: pred(1,'X'), 9: pred(9,'X'),
        }
        // Cat A=1, Cat B=1, Cat C=2, Cat D=3 → 7pts
      },
      {
        uid: 'sim-u2', name: '1X2 רגיל', description: 'מנחש את המועדף לנצח',
        groupPredictions: {},
        predictions: {
          10: pred(10,'1'), 4: pred(4,'1'), 1: pred(1,'1'), 9: pred(9,'1'),
        }
        // All wrong (draws occurred) → 0pts
      },
    ],
  },

]

// ── Knockout test data ────────────────────────────────────────────────────────
// Realistic knockout matches with teams and results for scoring tests

// Spain(1876) vs Mexico(1681) → Cat B (|ln|=0.108), Spain fav, Spain wins 1:0 FT
const KM_73: KnockoutMatch = {
  id: 73, round: 'R32', teamA: 'ספרד', teamB: 'מקסיקו',
  category: 'B', fifaPointsA: 1876.40, fifaPointsB: 1681.03,
  resultA: 1, resultB: 0, isPlayed: true, advanceTeam: 'ספרד',
}

// Germany(1730) vs Haiti(1292) → Cat D (|ln|=0.29), Germany fav, Haiti wins (big upset)
const KM_74: KnockoutMatch = {
  id: 74, round: 'R32', teamA: 'גרמניה', teamB: 'האיטי',
  category: 'D', fifaPointsA: 1730.37, fifaPointsB: 1291.71,
  resultA: 0, resultB: 1, isPlayed: true, advanceTeam: 'האיטי', hadRedCard: true,
}

// Brazil(1761) vs Australia(1581) → Cat B (|ln|=0.108), Brazil fav, draw → AET, Australia advances
const KM_75: KnockoutMatch = {
  id: 75, round: 'R32', teamA: 'ברזיל', teamB: 'אוסטרליה',
  category: 'B', fifaPointsA: 1761.16, fifaPointsB: 1580.67,
  resultA: 1, resultB: 1, isPlayed: true, advanceTeam: 'אוסטרליה', // AET: underdog advances
}

// France(1877) vs Colombia(1693) → Cat B (|ln|=0.103), France fav, France wins 2:1 FT → R16
const KM_89: KnockoutMatch = {
  id: 89, round: 'R16', teamA: 'צרפת', teamB: 'קולומביה',
  category: 'B', fifaPointsA: 1877.32, fifaPointsB: 1693.09,
  resultA: 2, resultB: 1, isPlayed: true, advanceTeam: 'צרפת',
}

// Argentina(1875) vs Belgium(1735) → Cat A (|ln|=0.077), Argentina fav, Belgium wins (Cat A upset)
const KM_97: KnockoutMatch = {
  id: 97, round: 'QF', teamA: 'ארגנטינה', teamB: 'בלגיה',
  category: 'A', fifaPointsA: 1874.81, fifaPointsB: 1734.71,
  resultA: 0, resultB: 2, isPlayed: true, advanceTeam: 'בלגיה',
}

const KNOCKOUT_PLAYED = [KM_73, KM_74, KM_75, KM_89, KM_97]

// Users with knockout predictions
const KO_USERS: KnockoutSimUser[] = [
  {
    uid: 'ko-u1', name: 'מועדפים נוקאאוט', description: 'בוחר מועדפים, עם advance pick נכון לכולם',
    redCards: { R32: [], R16: [], QF: [] },
    knockoutPreds: {
      73: { matchId: 73, prediction1X2: '1', scoreA: 1, scoreB: 0, advance: 'ספרד' },  // 1X2✓+exact✓+OU✓+advance✓
      74: { matchId: 74, prediction1X2: '1', scoreA: 2, scoreB: 0, advance: 'גרמניה' }, // 1X2✗+advance✗ (Haiti wins)
      75: { matchId: 75, prediction1X2: '1', scoreA: 2, scoreB: 0, advance: 'ברזיל' },  // 1X2✗+advance✗ (draw/AET)
      89: { matchId: 89, prediction1X2: '1', scoreA: 2, scoreB: 1, advance: 'צרפת' },   // 1X2✓+exact✓+advance✓
      97: { matchId: 97, prediction1X2: '1', scoreA: 1, scoreB: 0, advance: 'ארגנטינה' }, // 1X2✗+advance✗
    },
  },
  {
    uid: 'ko-u2', name: 'מפתיעים נוקאאוט', description: 'בוחר אנדרדוגים וניחושים מפתיעים',
    redCards: { R32: [74], R16: [], QF: [] }, // R32 red card pick: match 74 ✓
    knockoutPreds: {
      73: { matchId: 73, prediction1X2: '2', scoreA: 0, scoreB: 1, advance: 'מקסיקו' }, // 1X2✗ (Spain wins)
      74: { matchId: 74, prediction1X2: '2', scoreA: 0, scoreB: 1, advance: 'האיטי' },   // 1X2✓ Cat D=1+exact+advance Cat D und=4
      75: { matchId: 75, prediction1X2: 'X', scoreA: 1, scoreB: 1, advance: 'אוסטרליה' }, // 1X2✓ draw Cat B=1+exact+advance und Cat B=3
      89: { matchId: 89, prediction1X2: '2', scoreA: 1, scoreB: 2, advance: 'קולומביה' }, // 1X2✗
      97: { matchId: 97, prediction1X2: '2', scoreA: 0, scoreB: 2, advance: 'בלגיה' },   // 1X2✓ Cat A=1+exact+advance Cat A=2
    },
  },
  {
    uid: 'ko-u3', name: 'ניחוש X תמיד', description: 'מנחש תיקו לכל משחק + כרטיסי אדום לכולם',
    redCards: { R32: [73, 74, 75], R16: [89, 96], QF: [97] },
    knockoutPreds: {
      73: { matchId: 73, prediction1X2: 'X', scoreA: null, scoreB: null, advance: 'ספרד' },
      74: { matchId: 74, prediction1X2: 'X', scoreA: null, scoreB: null, advance: 'גרמניה' },
      75: { matchId: 75, prediction1X2: 'X', scoreA: 1, scoreB: 1, advance: 'ברזיל' }, // X correct! Cat B draw R32 base=1
      89: { matchId: 89, prediction1X2: 'X', scoreA: null, scoreB: null, advance: 'צרפת' },
      97: { matchId: 97, prediction1X2: 'X', scoreA: null, scoreB: null, advance: 'ארגנטינה' },
    },
  },
]

// Full 12-group standings for R32 population test
const FULL_GROUP_QUALIFIERS: Record<string, [string,string,string]> = {
  A: ['מקסיקו',       'קוריאה הדרומית', 'דרום אפריקה'],
  B: ['שווייץ',       'קנדה',           'בוסניה'],
  C: ['ברזיל',        'האיטי',          'מרוקו'],
  D: ['ארה"ב',        'פרגוואי',        'קטר'],
  E: ['ספרד',         'בלגיה',          'מצרים'],
  F: ['פורטוגל',      'אנגליה',         'גאנה'],
  G: ['גרמניה',       'הולנד',          'כף ורדה'],
  H: ['צרפת',         'איראן',          'עיראק'],
  I: ['ארה"ב',        'אוסטרליה',       'נורווגיה'],
  J: ['ברזיל',        'קולומביה',       'פנמה'],
  K: ['יפן',          'קוריאה הדרומית', 'ירדן'],
  L: ['אורוגוואי',    'שוודיה',         'בוסניה'],
}
// Best 8 thirds: groups C,F,G,H,I,J,K,L (Annex C row 1 → CFGHIJKL)
const BEST_8_THIRDS = ['מרוקו','גאנה','כף ורדה','עיראק','נורווגיה','פנמה','ירדן','בוסניה']


// ── Full Group Stage Simulation data ─────────────────────────────────────────
// 10 matches covering ALL rules simultaneously:
// Cat A/B/C/D × fav/upset/draw × exact/margin × O/U bonus × red card × groups

const FULL_GS_MATCHES: Partial<Match>[] = [
  // Cat A: Brazil wins 1:0 FT — fav win, exact, Under(1 goal ≤1) ✓
  { id: 7,  resultA: 1, resultB: 0, isPlayed: true, hadRedCard: false },
  // Cat A: draw 0:0 — Cat A draw=1pt, exact, Under ✓, has red card
  { id: 2,  resultA: 0, resultB: 0, isPlayed: true, hadRedCard: true },
  // Cat B: Belgium wins 4:1 — fav, Over(5 goals ≥4) ✓, no exact
  { id: 14, resultA: 4, resultB: 1, isPlayed: true, hadRedCard: false },
  // Cat B: Bosnia wins 1:0 — upset Cat B=2pt, Under(1 goal ≤1) ✓
  { id: 3,  resultA: 0, resultB: 1, isPlayed: true, hadRedCard: true },
  // Cat C: Mexico wins 2:0 — fav, exact, Under(2 goals ≤2) ✓
  { id: 1,  resultA: 2, resultB: 0, isPlayed: true, hadRedCard: false },
  // Cat C: Haiti wins 1:0 over Scotland — upset Cat C=3pt, Under ✓
  { id: 8,  resultA: 1, resultB: 0, isPlayed: true, hadRedCard: false },
  // Cat D: Germany wins 5:0 — fav, exact, Over(5 goals ≥5) ✓
  { id: 9,  resultA: 5, resultB: 0, isPlayed: true, hadRedCard: false },
  // Cat D: Cape Verde wins 1:0 over Spain — massive upset Cat D=4pt, Under ✓
  { id: 13, resultA: 0, resultB: 1, isPlayed: true, hadRedCard: false },
  // Cat A draw: Netherlands vs Japan 1:1 — draw Cat A=1pt, no O/U (2 goals)
  { id: 10, resultA: 1, resultB: 1, isPlayed: true, hadRedCard: false },
  // Cat B: France wins 2:1 over Senegal — fav, correct margin, no O/U
  { id: 17, resultA: 2, resultB: 1, isPlayed: true, hadRedCard: false },
]

const FULL_GS_GROUPS: Record<string, [string,string,string]> = {
  A: ['ברזיל',   'קוריאה הדרומית', 'צ׳כיה'],
  B: ['בלגיה',   'בוסניה',         'קנדה'],
  C: ['האיטי',   'מקסיקו',         'סקוטלנד'],
}

const p = (matchId: number, x: '1'|'X'|'2', sA: number|null = null, sB: number|null = null, rc = false): MatchPrediction =>
  ({ matchId, prediction1X2: x as any, scoreA: sA as any, scoreB: sB as any, redCard: rc })

const FULL_GS_USERS: SimUser[] = [
  {
    uid: 'full-u1', name: '🏆 המנצח המלא', description: 'מנחש הכל נכון — 1X2, תוצאה מדויקת, כרטיסים, קבוצות',
    predictions: {
      7:  p(7,  '1', 1, 0, false),  // Cat A fav✓ + exact✓ + Under✓ = 1+2+1=4
      2:  p(2,  'X', 0, 0, true),   // Cat A draw✓ + exact✓ + Under✓ + red✓ = 1+2+1+2=6
      14: p(14, '1', 4, 1, false),  // Cat B fav✓ + exact✓ + Over✓ = 1+2+1=4
      3:  p(3,  '2', 0, 1, true),   // Cat B upset✓ + exact✓ + Under✓ + red✓ = 2+2+1+2=7
      1:  p(1,  '1', 2, 0, false),  // Cat C fav✓ + exact✓ + Under✓ = 1+2+1=4
      8:  p(8,  '1', 1, 0, false),  // Cat C upset✓ + exact✓ + Under✓ = 3+2+1=6
      9:  p(9,  '1', 5, 0, false),  // Cat D fav✓ + exact✓ + Over✓ = 1+2+1=4
      13: p(13, '2', 0, 1, false),  // Cat D upset✓ + exact✓ + Under✓ = 4+2+1=7
      10: p(10, 'X', 1, 1, false),  // Cat A draw✓ + exact✓ no-OU(2 goals) = 1+2=3
      17: p(17, '1', 2, 1, false),  // Cat B fav✓ + exact✓ no-OU = 1+2=3
    },
    // Groups: all correct positions
    groupPredictions: {
      A: { group: 'A' as any, advancing: ['ברזיל',  'קוריאה הדרומית', 'צ׳כיה'] },   // 2+2=4
      B: { group: 'B' as any, advancing: ['בלגיה',  'בוסניה', 'קנדה'] },             // 2+2=4
      C: { group: 'C' as any, advancing: ['האיטי',  'מקסיקו', 'סקוטלנד'] },         // 2+2=4
    },
    // Expected: matches=4+6+4+7+4+6+4+7+3+3=48 + groups=4+4+4=12 = 60נק
  },
  {
    uid: 'full-u2', name: '⚽ משתמש ממוצע', description: '1X2 נכון תמיד, חצי תוצאות, אין כרטיסים, קבוצות חלקי',
    predictions: {
      7:  p(7,  '1', 2, 0, false),  // 1X2✓, wrong score (2:0≠1:0) margin=2≠1 → just 1
      2:  p(2,  'X', 0, 0, false),  // 1X2✓, exact✓ Under✓, no red = 1+2+1=4 (missed red)
      14: p(14, '1', 2, 0, false),  // 1X2✓, score 2:0≠4:1, margin 2≠3 → just 1
      3:  p(3,  '2', 0, 1, false),  // 1X2✓, exact✓ Under✓, no red = 2+2+1=5 (missed red)
      1:  p(1,  '1', 2, 0, false),  // 1X2✓ + exact✓ + Under✓ = 1+2+1=4
      8:  p(8,  '1', 2, 0, false),  // 1X2✓, 2:0≠1:0 margin=2≠1 → just 3
      9:  p(9,  '1', 3, 0, false),  // 1X2✓, 3:0≠5:0 margin=3≠5 → just 1
      13: p(13, '2', 0, 2, false),  // 1X2✓, 0:2≠0:1 margin=2≠1 → just 4
      10: p(10, 'X', 1, 1, false),  // 1X2✓ + exact✓ = 1+2=3
      17: p(17, '1', 3, 1, false),  // 1X2✓, 3:1≠2:1 margin=2=1? No → just 1
    },
    groupPredictions: {
      A: { group: 'A' as any, advancing: ['ברזיל', 'צ׳כיה', 'קוריאה הדרומית'] },     // 1st exact(2), 2nd wrong order(1) = 3
      B: { group: 'B' as any, advancing: ['בלגיה', 'קנדה', 'בוסניה'] },               // 1st exact(2), 2nd wrong(0) = 2
      C: { group: 'C' as any, advancing: ['מקסיקו', 'האיטי', 'סקוטלנד'] },           // 1st wrong pos(1), 2nd wrong pos(1) = 2
    },
    // Expected: ~1+4+1+5+4+3+1+4+3+1=27 + groups=3+2+2=7 = ~34נק
  },
  {
    uid: 'full-u3', name: '💥 מחפש אנדרדוגים', description: 'בוחר אנדרדוגים ותיקו, גם כרטיסים',
    predictions: {
      7:  p(7,  '2', 0, 1, false),  // Cat A — Brazil wins, wrong = 0
      2:  p(2,  'X', 0, 0, true),   // Cat A draw✓ + exact✓ + Under✓ + red✓ = 1+2+1+2=6
      14: p(14, '2', 1, 4, false),  // Cat B — Belgium wins, wrong = 0
      3:  p(3,  '2', 0, 1, true),   // Cat B upset✓ + exact✓ + Under✓ + red✓ = 2+2+1+2=7
      1:  p(1,  '2', 0, 2, false),  // Cat C — Mexico wins, wrong = 0
      8:  p(8,  '1', 1, 0, false),  // Cat C upset✓ + exact✓ + Under✓ = 3+2+1=6
      9:  p(9,  '2', 0, 5, false),  // Cat D — Germany wins, wrong = 0
      13: p(13, '2', 0, 1, false),  // Cat D upset✓ + exact✓ + Under✓ = 4+2+1=7
      10: p(10, 'X', 1, 1, false),  // Cat A draw✓ + exact✓ = 1+2=3
      17: p(17, '2', 1, 2, false),  // Cat B — France wins, wrong = 0
    },
    groupPredictions: {
      A: { group: 'A' as any, advancing: ['צ׳כיה', 'ברזיל', 'קוריאה הדרומית'] },     // 1st wrong pos(1), 2nd wrong pos(1) = 2
      B: { group: 'B' as any, advancing: ['בוסניה', 'בלגיה', 'קנדה'] },               // 1st wrong pos(1), 2nd wrong pos(1) = 2
      C: { group: 'C' as any, advancing: ['האיטי', 'מקסיקו', 'סקוטלנד'] },           // 2+2=4
    },
    // Expected: 0+6+0+7+0+6+0+7+3+0=29 + groups=2+2+4=8 = ~37נק
  },
  {
    uid: 'full-u4', name: '📊 מועדפים בלבד', description: '1X2 מועדף תמיד, ללא תוצאות, ללא כרטיסים',
    predictions: {
      7:  p(7,  '1'),   // Cat A fav✓ = 1
      2:  p(2,  '1'),   // Cat A draw, picks fav = 0
      14: p(14, '1'),   // Cat B fav✓ = 1
      3:  p(3,  '1'),   // Cat B upset, picks fav = 0
      1:  p(1,  '1'),   // Cat C fav✓ = 1
      8:  p(8,  '2'),   // Cat C upset, picks fav (Scotland) = 0 (Haiti won)
      9:  p(9,  '1'),   // Cat D fav✓ = 1
      13: p(13, '1'),   // Cat D upset, picks fav (Spain) = 0
      10: p(10, '1'),   // Cat A draw, picks fav = 0
      17: p(17, '1'),   // Cat B fav✓ = 1
    },
    groupPredictions: {
      A: { group: 'A' as any, advancing: ['ברזיל', 'קוריאה הדרומית', 'צ׳כיה'] },  // exact = 4
      B: { group: 'B' as any, advancing: ['בלגיה', 'קנדה', 'בוסניה'] },            // wrong order = 1+0=1
      C: { group: 'C' as any, advancing: ['מקסיקו', 'ספרד', 'ברזיל'] },           // 0
    },
    // Expected: 1+0+1+0+1+0+1+0+0+1=5 + groups=4+1+0=5 = 10נק
  },
]

// ── Full Knockout Simulation data ─────────────────────────────────────────────
// 10 matches: R32(4) + R16(2) + QF(2) + SF(1) + Final(1)
// Covers: FT, AET/PEN, all categories, advance picks all rounds, red cards all pools

// R32 results
const FKM_73: KnockoutMatch = { // Cat B, Spain fav, Spain wins FT 1:0, Under✓
  id: 73, round: 'R32', teamA: 'ספרד', teamB: 'מקסיקו',
  category: 'B', fifaPointsA: 1876.40, fifaPointsB: 1681.03,
  resultA: 1, resultB: 0, isPlayed: true, advanceTeam: 'ספרד',
}
const FKM_74: KnockoutMatch = { // Cat D, Germany fav, Haiti wins (upset 4pt), red card
  id: 74, round: 'R32', teamA: 'גרמניה', teamB: 'האיטי',
  category: 'D', fifaPointsA: 1730.37, fifaPointsB: 1291.71,
  resultA: 0, resultB: 1, isPlayed: true, advanceTeam: 'האיטי', hadRedCard: true,
}
const FKM_75: KnockoutMatch = { // Cat B, Brazil fav, draw→AET→Australia (upset Cat B=3pt advance)
  id: 75, round: 'R32', teamA: 'ברזיל', teamB: 'אוסטרליה',
  category: 'B', fifaPointsA: 1761.16, fifaPointsB: 1580.67,
  resultA: 1, resultB: 1, isPlayed: true, advanceTeam: 'אוסטרליה',
}
const FKM_76: KnockoutMatch = { // Cat B, France fav, PEN→France (0:0 FT, PEN advance)
  id: 76, round: 'R32', teamA: 'צרפת', teamB: 'אקוודור',
  category: 'B', fifaPointsA: 1877.32, fifaPointsB: 1594.78,
  resultA: 0, resultB: 0, isPlayed: true, advanceTeam: 'צרפת',
}
// R16 results
const FKM_89: KnockoutMatch = { // Cat B, Spain fav, Spain wins 2:0 R16, Under Cat R16 ✓
  id: 89, round: 'R16', teamA: 'ספרד', teamB: 'האיטי',
  category: 'C', fifaPointsA: 1876.40, fifaPointsB: 1291.71,
  resultA: 2, resultB: 0, isPlayed: true, advanceTeam: 'ספרד', hadRedCard: true,
}
const FKM_90: KnockoutMatch = { // Cat B, France vs Australia, France wins 3:1, Over R16 ✓
  id: 90, round: 'R16', teamA: 'צרפת', teamB: 'אוסטרליה',
  category: 'B', fifaPointsA: 1877.32, fifaPointsB: 1580.67,
  resultA: 3, resultB: 1, isPlayed: true, advanceTeam: 'צרפת',
}
// QF results
const FKM_97: KnockoutMatch = { // Cat A, Spain vs France, France wins 2:1 (tiny upset, base=2)
  id: 97, round: 'QF', teamA: 'ספרד', teamB: 'צרפת',
  category: 'A', fifaPointsA: 1876.40, fifaPointsB: 1877.32,
  resultA: 1, resultB: 2, isPlayed: true, advanceTeam: 'צרפת',
}
const FKM_98: KnockoutMatch = { // Cat B QF, Portugal vs Argentina, Argentina wins (fav)
  id: 98, round: 'QF', teamA: 'ארגנטינה', teamB: 'פורטוגל',
  category: 'A', fifaPointsA: 1874.81, fifaPointsB: 1763.83,
  resultA: 2, resultB: 0, isPlayed: true, advanceTeam: 'ארגנטינה',
}
// SF result
const FKM_101: KnockoutMatch = { // Cat A SF base=3, France vs Argentina, France wins
  id: 101, round: 'SF', teamA: 'צרפת', teamB: 'ארגנטינה',
  category: 'A', fifaPointsA: 1877.32, fifaPointsB: 1874.81,
  resultA: 2, resultB: 1, isPlayed: true, advanceTeam: 'צרפת',
}
// Final result
const FKM_104: KnockoutMatch = { // Cat A Final base=3, France vs Portugal, France wins
  id: 104, round: 'F', teamA: 'צרפת', teamB: 'פורטוגל',
  category: 'A', fifaPointsA: 1877.32, fifaPointsB: 1763.83,
  resultA: 1, resultB: 0, isPlayed: true, advanceTeam: 'צרפת',
}

const FULL_KO_PLAYED = [FKM_73, FKM_74, FKM_75, FKM_76, FKM_89, FKM_90, FKM_97, FKM_98, FKM_101, FKM_104]

const kp = (matchId: number, x: '1'|'X'|'2', sA: number|null, sB: number|null, adv?: string): KnockoutMatchPrediction =>
  ({ matchId, prediction1X2: x as any, scoreA: sA, scoreB: sB, advance: adv })

const FULL_KO_USERS: KnockoutSimUser[] = [
  {
    uid: 'fko-u1', name: '🏆 מנצח נוקאאוט', description: 'הכל נכון: 1X2, advance, תוצאות, כרטיסים',
    redCards: { R32: [74], R16: [89], QF: [] }, // correct red card picks
    knockoutPreds: {
      73:  kp(73,  '1', 1, 0, 'ספרד'),      // 1X2✓+exact✓+Under✓+adv Cat B fav = 1+2+1+2=6
      74:  kp(74,  '2', 0, 1, 'האיטי'),      // 1X2✓+exact✓+Under✓+adv Cat D und=4+red✓ = 1+2+1+4+2=10
      75:  kp(75,  'X', 1, 1, 'אוסטרליה'),   // 1X2✓+exact✓+adv Cat B und=3 = 1+2+3=6
      76:  kp(76,  'X', 0, 0, 'צרפת'),       // 1X2✓+exact✓+adv Cat B fav=2 = 1+2+2=5
      89:  kp(89,  '1', 2, 0, 'ספרד'),       // R16: 1X2✓+exact+Under✓+adv Cat C fav=3+red✓ = 1+2+1+3+2=9
      90:  kp(90,  '1', 3, 1, 'צרפת'),       // R16: 1X2✓+exact✓+Over✓+adv Cat B fav=3 = 1+2+1+3=7
      97:  kp(97,  '2', 1, 2, 'צרפת'),       // QF: 1X2✓+exact✓+adv Cat A und=4 = 2+2+4=8 (base=2 for QF)
      98:  kp(98,  '1', 2, 0, 'ארגנטינה'),   // QF: 1X2✓+exact✓+adv Cat A fav=4 = 2+2+4=8
      101: kp(101, '1', 2, 1, 'צרפת'),       // SF: 1X2✓+exact✓+adv Cat A und=5 = 3+2+5=10 (base=3)
      104: kp(104, '1', 1, 0, 'צרפת'),       // F:  1X2✓+exact✓+Under✓+adv Cat A fav=5 = 3+2+2+5=12
    },
    // Expected total: ~81נק
  },
  {
    uid: 'fko-u2', name: '📊 מועדפים נוקאאוט', description: '1X2 מועדף תמיד + advance מועדף, ללא תוצאות',
    redCards: { R32: [], R16: [], QF: [] },
    knockoutPreds: {
      73:  kp(73,  '1', null, null, 'ספרד'),   // 1X2✓+adv fav=2
      74:  kp(74,  '1', null, null, 'גרמניה'), // 1X2✗ (Haiti won), adv✗
      75:  kp(75,  '1', null, null, 'ברזיל'),  // 1X2✗ (draw/AET), adv✗
      76:  kp(76,  '1', null, null, 'צרפת'),   // 1X2✓(picks fav=France? Wait X was result) No: PEN result = France advances from 0:0
      89:  kp(89,  '1', null, null, 'ספרד'),   // 1X2✓+adv fav=3 R16
      90:  kp(90,  '1', null, null, 'צרפת'),   // 1X2✓+adv fav=3 R16
      97:  kp(97,  '1', null, null, 'ספרד'),   // 1X2✗ (France won)
      98:  kp(98,  '1', null, null, 'ארגנטינה'),// 1X2✓+adv fav=4 QF
      101: kp(101, '1', null, null, 'צרפת'),   // 1X2✓+adv fav=5 SF
      104: kp(104, '1', null, null, 'צרפת'),   // 1X2✓+adv fav=5 Final
    },
    // Expected: ~30-35נק
  },
  {
    uid: 'fko-u3', name: '💥 מפתיעים נוקאאוט', description: 'בוחר אנדרדוגים + כרטיסי אדום בכל pool',
    redCards: { R32: [73, 74, 75], R16: [89, 90], QF: [97] }, // picks all pools, some correct
    knockoutPreds: {
      73:  kp(73,  '2', 0, 1, 'מקסיקו'),     // 1X2✗, adv und Cat B = would be 2 if right
      74:  kp(74,  '2', 0, 1, 'האיטי'),       // 1X2✓+exact✓+Under✓+adv Cat D und=4+red✓ = 10
      75:  kp(75,  'X', 1, 1, 'אוסטרליה'),    // 1X2✓+exact✓+adv Cat B und=3 = 1+2+3=6
      76:  kp(76,  '2', 1, 0, 'אקוודור'),     // 1X2✗, adv✗
      89:  kp(89,  '2', 0, 2, 'האיטי'),       // 1X2✗ (Spain won), no adv, no red(89 has red but not in picks)
      90:  kp(90,  '2', 1, 3, 'אוסטרליה'),   // 1X2✗ (France won)
      97:  kp(97,  '2', 1, 2, 'צרפת'),        // 1X2✓+exact✓+adv Cat A und=4, QF base=2 = 2+2+4=8
      98:  kp(98,  '2', 0, 2, 'פורטוגל'),    // 1X2✗ (Argentina won)
      101: kp(101, '2', 1, 2, 'ארגנטינה'),   // 1X2✗ (France won)
      104: kp(104, '2', 0, 1, 'פורטוגל'),    // 1X2✗ (France won)
    },
    // Expected: ~10+6+8+red✓(74)=2+red✓(97? not in QF picks since 97 is QF)
    // red: R32 picks [73,74,75] → 74 had red✓=2. R16 picks [89,90] → 89 had red✓=2. QF picks [97] → 97 no red=0
    // Total: 0+10+6+0+0+0+8+0+0+0 + reds=2+2=4 = ~30נק
  },
]

// ── Component ─────────────────────────────────────────────────────────────────
export default function Simulator() {
  const [running, setRunning] = useState<string | null>(null)
  const [results, setResults] = useState<ScenarioResult[] | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [resetting, setResetting] = useState(false)
  const [activeScenario, setActiveScenario] = useState<string | null>(null)
  const [r32Result, setR32Result] = useState<Record<number,any> | null>(null)
  const [koResults, setKoResults] = useState<ScenarioResult[] | null>(null)
  const [fullGsResults, setFullGsResults] = useState<ScenarioResult[] | null>(null)
  const [fullKoResults, setFullKoResults] = useState<ScenarioResult[] | null>(null)

  const addLog = (msg: string) => setLog(prev => [...prev, msg])

  const resetAll = async () => {
    setResetting(true)
    setResults(null)
    setLog([])
    setActiveScenario(null)
    try {
      const batch = writeBatch(db)
      // Delete all sim users predictions + scores
      for (let i = 1; i <= 5; i++) {
        const uid = `sim-u${i}`
        batch.delete(doc(db, 'predictions', uid))
        batch.delete(doc(db, 'scores', uid))
        batch.delete(doc(db, 'users', uid))
      }
      // Delete knockout sim users
      for (let i = 1; i <= 3; i++) {
        const uid = `ko-u${i}`
        batch.delete(doc(db, 'predictions', uid))
        batch.delete(doc(db, 'scores', uid))
        batch.delete(doc(db, 'users', uid))
      }
      batch.delete(doc(db, 'admin', 'results'))
      batch.delete(doc(db, 'admin', 'knockout'))
      await batch.commit()
      setR32Result(null)
      setKoResults(null)
      addLog('✅ כל הנתונים נמחקו')
    } catch (e: any) {
      addLog(`❌ שגיאה: ${e.message}`)
    }
    setResetting(false)
  }

  const runScenario = async (scenario: typeof SCENARIOS[0]) => {
    setRunning(scenario.id)
    setResults(null)
    setLog([])
    setActiveScenario(scenario.id)

    try {
      // 1. Build the match map — merge results into MATCHES
      const matchMap: Record<number, Match> = {}
      for (const m of MATCHES) matchMap[m.id] = { ...m }
      for (const r of scenario.results) {
        if (matchMap[r.id!]) {
          matchMap[r.id!] = { ...matchMap[r.id!], ...r }
        }
      }
      addLog(`📋 מוכן ${scenario.results.length} תוצאות`)

      // 2. Save admin/results to Firestore
      await setDoc(doc(db, 'admin', 'results'), {
        matches: matchMap,
        groups: scenario.groupResults ?? {},
        bonus: {},
      })
      addLog('💾 תוצאות נשמרו ב-Firestore')

      // 3. Save users + compute scores
      const scoreResults: ScenarioResult[] = []
      const playedMatches = Object.values(matchMap).filter(m => m.isPlayed)

      for (const user of scenario.users) {
        // Save user doc
        await setDoc(doc(db, 'users', user.uid), {
          name: user.name, email: `${user.uid}@sim.test`, joinedAt: Date.now(),
        })
        // Save predictions
        await setDoc(doc(db, 'predictions', user.uid), {
          matches: user.predictions,
          groups: user.groupPredictions,
          bonus: {},
          userName: user.name,
          lastUpdated: Date.now(),
        })

        // Compute score using scoring engine
        const score = computeUserScore(
          user.uid, user.name,
          user.predictions,
          user.groupPredictions,
          {},
          playedMatches,
          scenario.groupResults ?? {},
          {},
        )

        // Save score
        await setDoc(doc(db, 'scores', user.uid), score)

        // Build breakdown
        const breakdown: string[] = []
        for (const [midStr, detail] of Object.entries(score.matchDetails ?? {})) {
          const mid = Number(midStr)
          const match = matchMap[mid]
          if (!match) continue
          const parts = []
          if ((detail as any).points1X2 > 0) parts.push(`1X2: +${(detail as any).points1X2}`)
          if ((detail as any).pointsScore > 0) parts.push(`תוצאה: +${(detail as any).pointsScore}`)
          if ((detail as any).pointsRedCard > 0) parts.push(`🟥: +${(detail as any).pointsRedCard}`)
          breakdown.push(`משחק ${mid} (${match.teamA} vs ${match.teamB}): ${parts.join(', ')} [סה"כ: ${(detail as any).total}]`)
        }
        if (score.groupPoints > 0) breakdown.push(`עולות מהבתים: +${score.groupPoints}`)

        scoreResults.push({
          uid: user.uid,
          name: user.name,
          matchPoints: score.matchPoints,
          redCardPoints: score.redCardPoints,
          groupPoints: score.groupPoints,
          total: score.total,
          breakdown,
        })
        addLog(`✅ ${user.name}: ${score.total} נק' (משחקים: ${score.matchPoints}, כרטיסים: ${score.redCardPoints}, קבוצות: ${score.groupPoints})`)
      }

      setResults(scoreResults)
      addLog(`🎉 הסימולציה הושלמה!`)
    } catch (e: any) {
      addLog(`❌ שגיאה: ${e.message}`)
    }

    setRunning(null)
  }

  const runFullGroupStage = async () => {
    setRunning('full-gs')
    setLog([])
    setFullGsResults(null)
    try {
      const matchMap: Record<number, Match> = {}
      for (const m of MATCHES) matchMap[m.id] = { ...m }
      for (const r of FULL_GS_MATCHES) matchMap[r.id!] = { ...matchMap[r.id!], ...r }
      await setDoc(doc(db, 'admin', 'results'), { matches: matchMap, groups: FULL_GS_GROUPS, bonus: {} })
      addLog(`💾 תוצאות מלאות נשמרו (${FULL_GS_MATCHES.length} משחקים, ${Object.keys(FULL_GS_GROUPS).length} בתים)`)
      const playedMatches = Object.values(matchMap).filter(m => m.isPlayed)
      const scoreResults: ScenarioResult[] = []
      for (const user of FULL_GS_USERS) {
        await setDoc(doc(db, 'users', user.uid), { name: user.name, email: `${user.uid}@sim.test`, joinedAt: Date.now() })
        await setDoc(doc(db, 'predictions', user.uid), { matches: user.predictions, groups: user.groupPredictions, bonus: {}, userName: user.name, lastUpdated: Date.now() })
        const score = computeUserScore(user.uid, user.name, user.predictions, user.groupPredictions, {}, playedMatches, FULL_GS_GROUPS, {})
        await setDoc(doc(db, 'scores', user.uid), score)
        const breakdown: string[] = []
        for (const [mid, detail] of Object.entries(score.matchDetails ?? {})) {
          const match = matchMap[Number(mid)]
          if (!match) continue
          const parts = []
          if ((detail as any).points1X2 > 0) parts.push(`1X2:+${(detail as any).points1X2}`)
          if ((detail as any).pointsScore > 0) parts.push(`תוצאה:+${(detail as any).pointsScore}`)
          if ((detail as any).pointsRedCard > 0) parts.push(`🟥:+${(detail as any).pointsRedCard}`)
          if (parts.length) breakdown.push(`#${mid}(${match.teamA}vs${match.teamB}): ${parts.join(' ')}=[${(detail as any).total}]`)
        }
        if (score.groupPoints > 0) breakdown.push(`קבוצות: +${score.groupPoints}`)
        scoreResults.push({ uid: user.uid, name: user.name, matchPoints: score.matchPoints, redCardPoints: score.redCardPoints, groupPoints: score.groupPoints, total: score.total, breakdown })
        addLog(`✅ ${user.name}: ${score.total}נק (משחקים:${score.matchPoints} כרטיסים:${score.redCardPoints} קבוצות:${score.groupPoints})`)
      }
      setFullGsResults(scoreResults)
      addLog('🎉 סימולציה מלאה של שלב בתים הושלמה!')
    } catch (e: any) { addLog(`❌ ${e.message}`) }
    setRunning(null)
  }

  const runFullKnockout = async () => {
    setRunning('full-ko')
    setLog([])
    setFullKoResults(null)
    try {
      const knockoutMap: Record<number, KnockoutMatch> = {}
      for (const km of FULL_KO_PLAYED) knockoutMap[km.id] = km
      await setDoc(doc(db, 'admin', 'knockout'), { matches: knockoutMap })
      addLog(`💾 תוצאות נוקאאוט מלאות נשמרו (${FULL_KO_PLAYED.length} משחקים)`)
      const scoreResults: ScenarioResult[] = []
      for (const user of FULL_KO_USERS) {
        await setDoc(doc(db, 'users', user.uid), { name: user.name, email: `${user.uid}@sim.test`, joinedAt: Date.now() })
        await setDoc(doc(db, 'predictions', user.uid), { matches: {}, groups: {}, bonus: {}, knockout: user.knockoutPreds, knockoutRedCards: user.redCards, userName: user.name, lastUpdated: Date.now() })
        const score = computeUserScore(user.uid, user.name, {}, {}, {}, [], {}, {}, user.knockoutPreds, FULL_KO_PLAYED, user.redCards)
        await setDoc(doc(db, 'scores', user.uid), score)
        const breakdown: string[] = []
        for (const km of FULL_KO_PLAYED) {
          const pred = user.knockoutPreds[km.id]
          if (!pred) continue
          const actual = km.resultA! > km.resultB! ? '1' : km.resultA! < km.resultB! ? '2' : 'X'
          const parts: string[] = []
          if (pred.prediction1X2 === actual) parts.push('1X2✓')
          if (pred.advance === km.advanceTeam) parts.push('advance✓')
          if (km.hadRedCard && user.redCards[km.round as 'R32'|'R16'|'QF']?.includes(km.id)) parts.push('🟥✓')
          if (parts.length) breakdown.push(`#${km.id}[${km.round}] ${km.teamA}vs${km.teamB}: ${parts.join(' ')}`)
        }
        if (score.redCardPoints > 0) breakdown.push(`סה"כ כרטיסים: +${score.redCardPoints}`)
        scoreResults.push({ uid: user.uid, name: user.name, matchPoints: score.matchPoints, redCardPoints: score.redCardPoints, groupPoints: 0, total: score.total, breakdown })
        addLog(`✅ ${user.name}: ${score.total}נק (נוקאאוט:${score.knockoutPoints} כרטיסים:${score.redCardPoints})`)
      }
      setFullKoResults(scoreResults)
      addLog('🎉 סימולציה מלאה של נוקאאוט הושלמה!')
    } catch (e: any) { addLog(`❌ ${e.message}`) }
    setRunning(null)
  }

  const runR32Population = async () => {
    setRunning('r32')
    setLog([])
    setR32Result(null)
    try {
      const { updatedKnockout, populated, log: r32Log } = populateR32Teams(
        FULL_GROUP_QUALIFIERS, BEST_8_THIRDS, {}, TEAM_FIFA_POINTS, calcCategoryByRound
      )
      r32Log.forEach(l => addLog(l))
      await setDoc(doc(db, 'admin', 'knockout'), { matches: updatedKnockout })
      setR32Result(updatedKnockout)
      addLog(`✅ R32 אוכלס: ${populated} משחקים נשמרו ב-Firestore`)
    } catch (e: any) { addLog(`❌ ${e.message}`) }
    setRunning(null)
  }

  const runKnockoutScoring = async () => {
    setRunning('ko-scoring')
    setLog([])
    setKoResults(null)
    try {
      // Save knockout admin data
      const knockoutMap: Record<number, KnockoutMatch> = {}
      for (const km of KNOCKOUT_PLAYED) knockoutMap[km.id] = km
      await setDoc(doc(db, 'admin', 'knockout'), { matches: knockoutMap })
      addLog(`💾 תוצאות נוקאאוט נשמרו (${KNOCKOUT_PLAYED.length} משחקים)`)

      const scoreResults: ScenarioResult[] = []
      for (const user of KO_USERS) {
        await setDoc(doc(db, 'users', user.uid), { name: user.name, email: `${user.uid}@sim.test`, joinedAt: Date.now() })
        await setDoc(doc(db, 'predictions', user.uid), {
          matches: {}, groups: {}, bonus: {},
          knockout: user.knockoutPreds,
          knockoutRedCards: user.redCards,
          userName: user.name, lastUpdated: Date.now(),
        })

        const score = computeUserScore(
          user.uid, user.name, {}, {}, {}, [],
          {}, {},
          user.knockoutPreds,
          KNOCKOUT_PLAYED,
          user.redCards,
        )
        await setDoc(doc(db, 'scores', user.uid), score)

        const breakdown: string[] = []
        for (const km of KNOCKOUT_PLAYED) {
          const pred = user.knockoutPreds[km.id]
          if (!pred) continue
          const parts: string[] = []
          // recompute for display
          const aIsFav = (km.fifaPointsA ?? 1500) >= (km.fifaPointsB ?? 1500)
          const predFav = (pred.prediction1X2 === '1' && aIsFav) || (pred.prediction1X2 === '2' && !aIsFav)
          const actual1X2 = km.resultA! > km.resultB! ? '1' : km.resultA! < km.resultB! ? '2' : 'X'
          if (pred.prediction1X2 === actual1X2) parts.push(`1X2✓`)
          if (pred.advance === km.advanceTeam) parts.push(`advance✓`)
          if (km.hadRedCard) parts.push(user.redCards.R32?.includes(km.id) ? '🟥✓' : '🟥✗')
          breakdown.push(`משחק ${km.id} [${km.round}]: ${km.teamA} vs ${km.teamB} → ${parts.join(' ')}`)
        }
        scoreResults.push({
          uid: user.uid, name: user.name,
          matchPoints: score.matchPoints, redCardPoints: score.redCardPoints,
          groupPoints: 0, total: score.total,
          breakdown,
        })
        addLog(`✅ ${user.name}: ${score.total} נק' (נוקאאוט: ${score.knockoutPoints})`)
      }
      setKoResults(scoreResults)
      addLog('🎉 ניקוד נוקאאוט הושלם!')
    } catch (e: any) { addLog(`❌ ${e.message}`) }
    setRunning(null)
  }

  return (
    <div className="page-container" dir="rtl" style={{ maxWidth: 800, margin: '0 auto', padding: 16 }}>
      <h2 style={{ margin: '0 0 4px' }}>🧪 סימולטור בדיקות</h2>
      <p style={{ color: '#888', fontSize: 13, margin: '0 0 20px' }}>
        מריץ תרחישי בדיקה לכיסוי כל מקרי הניקוד. יכתוב נתונים ל-Firestore.
      </p>

      {/* Reset */}
      <button
        onClick={resetAll}
        disabled={resetting || !!running}
        style={{
          padding: '10px 20px', borderRadius: 10, border: '2px solid #c0392b',
          background: resetting ? '#eee' : '#fff5f5', color: '#c0392b',
          fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
          fontSize: 14, marginBottom: 24, display: 'block',
        }}>
        {resetting ? 'מוחק...' : '🗑️ מחק הכל וחזור למצב ריק'}
      </button>

      {/* ── Full Simulations ────────────────────────────────────────────────── */}
      <div style={{ borderTop: '2px solid #1a1a2e', paddingTop: 24, marginTop: 8, marginBottom: 8 }}>
        <h3 style={{ margin: '0 0 4px' }}>🎮 סימולציות מלאות</h3>
        <p style={{ color: '#888', fontSize: 13, margin: '0 0 16px' }}>
          בודק את כל כללי הניקוד יחד בסימולציה אחת מקיפה לכל שלב
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 8 }}>

          {/* Full Group Stage */}
          <div style={{ border: `2px solid ${fullGsResults ? '#1a7a44' : '#1a1a2e'}`, borderRadius: 12, padding: 16, background: fullGsResults ? '#f0faf4' : '#fff' }}>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>⚽ שלב בתים מלא</div>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>
              10 משחקים × 4 קטגוריות × כל סוגי הניקוד + עולות מהבתים
            </div>
            <details style={{ marginBottom: 12 }}>
              <summary style={{ fontSize: 12, color: '#555', cursor: 'pointer', fontWeight: 600, userSelect: 'none' }}>📖 הסבר מפורט</summary>
              <div style={{ marginTop: 8, padding: '8px 10px', background: '#f8f8f8', borderRadius: 8, border: '1px solid #e8e8e8', fontSize: 11, lineHeight: 1.8 }}>
                <div style={{ fontWeight: 700, color: '#333' }}>📋 10 משחקים המכסים:</div>
                <div style={{ color: '#666' }}>Cat A: Brazil 1:0 Morocco (מועדף+Under✓) | S.Korea 0:0 Czechia (תיקו+Under✓+🟥)</div>
                <div style={{ color: '#666' }}>Cat B: Belgium 4:1 Egypt (מועדף+Over✓) | Bosnia 1:0 Canada (אנדרדוג+Under✓+🟥)</div>
                <div style={{ color: '#666' }}>Cat C: Mexico 2:0 S.Africa (מועדף+Under✓) | Haiti 1:0 Scotland (אנדרדוג Cat C=3נק)</div>
                <div style={{ color: '#666' }}>Cat D: Germany 5:0 Curaçao (מועדף+Over✓) | Cape Verde 1:0 Spain (אנדרדוג Cat D=4נק+Under✓)</div>
                <div style={{ color: '#666' }}>Cat A draw: Netherlands 1:1 Japan (תיקו, 2 שערים=ללא O/U)</div>
                <div style={{ color: '#666' }}>Cat B: France 2:1 Senegal (מועדף, מרווח=1)</div>
                <div style={{ fontWeight: 700, color: '#333', marginTop: 4 }}>📋 4 משתמשים:</div>
                <div style={{ color: '#666' }}>🏆 "המנצח המלא" — הכל נכון → צפוי ~60נק</div>
                <div style={{ color: '#666' }}>⚽ "משתמש ממוצע" — 1X2 נכון + חלק תוצאות → צפוי ~34נק</div>
                <div style={{ color: '#666' }}>💥 "מחפש אנדרדוגים" — אפסטים נכון → צפוי ~37נק</div>
                <div style={{ color: '#666' }}>📊 "מועדפים בלבד" — רק 1X2 ומועדפים → צפוי ~10נק</div>
                <div style={{ fontWeight: 700, color: '#1a7a44', marginTop: 4 }}>✅ ציפייה: מנצח(60) {'>'} אנדרדוגים(37) {'>'} ממוצע(34) {'>'} מועדפים(10)</div>
                <div style={{ color: '#0C447C', fontWeight: 600 }}>📌 בדוק: O/U Cat C ≤2 שערים (#1, #8) ≥5 (#9) | Cat A draw=#2(6נק) vs #10(3נק)</div>
              </div>
            </details>
            <button onClick={runFullGroupStage} disabled={!!running}
              style={{ width: '100%', padding: '9px', borderRadius: 8, border: 'none',
                background: running === 'full-gs' ? '#aaa' : '#1a1a2e',
                color: '#fff', fontWeight: 700, cursor: running ? 'default' : 'pointer',
                fontFamily: 'inherit', fontSize: 14 }}>
              {running === 'full-gs' ? '⏳ רץ...' : '▶ הרץ סימולציה מלאה — שלב בתים'}
            </button>
            {fullGsResults && (
              <div style={{ marginTop: 12 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: '#f0f0f0' }}>
                      <th style={{ padding: '6px 8px', textAlign: 'right', border: '1px solid #ddd' }}>משתמש</th>
                      <th style={{ padding: '6px 8px', textAlign: 'center', border: '1px solid #ddd' }}>משחקים</th>
                      <th style={{ padding: '6px 8px', textAlign: 'center', border: '1px solid #ddd' }}>🟥</th>
                      <th style={{ padding: '6px 8px', textAlign: 'center', border: '1px solid #ddd' }}>קבוצות</th>
                      <th style={{ padding: '6px 8px', textAlign: 'center', border: '1px solid #ddd', fontWeight: 700 }}>סה"כ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fullGsResults.sort((a,b) => b.total - a.total).map(r => (
                      <tr key={r.uid}>
                        <td style={{ padding: '6px 8px', border: '1px solid #ddd', fontWeight: 500 }}>{r.name}</td>
                        <td style={{ padding: '6px 8px', border: '1px solid #ddd', textAlign: 'center' }}>{r.matchPoints}</td>
                        <td style={{ padding: '6px 8px', border: '1px solid #ddd', textAlign: 'center' }}>{r.redCardPoints}</td>
                        <td style={{ padding: '6px 8px', border: '1px solid #ddd', textAlign: 'center' }}>{r.groupPoints}</td>
                        <td style={{ padding: '6px 8px', border: '1px solid #ddd', textAlign: 'center', fontWeight: 700, color: '#1a7a44' }}>{r.total}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {fullGsResults.map(r => (
                  <details key={r.uid} style={{ marginTop: 5, background: '#f9f9f9', borderRadius: 6, padding: '5px 10px', border: '1px solid #e0e0e0' }}>
                    <summary style={{ cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>{r.name} — פירוט</summary>
                    <ul style={{ margin: '5px 0 0', paddingRight: 14, fontSize: 10, color: '#555' }}>
                      {r.breakdown.map((b,i) => <li key={i} style={{ marginBottom: 2 }}>{b}</li>)}
                    </ul>
                  </details>
                ))}
              </div>
            )}
          </div>

          {/* Full Knockout */}
          <div style={{ border: `2px solid ${fullKoResults ? '#1a7a44' : '#1a1a2e'}`, borderRadius: 12, padding: 16, background: fullKoResults ? '#f0faf4' : '#fff' }}>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>🏆 נוקאאוט מלא</div>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>
              10 משחקים: R32(4)+R16(2)+QF(2)+SF(1)+גמר(1) — FT/AET/PEN + כל שלבי הניקוד
            </div>
            <details style={{ marginBottom: 12 }}>
              <summary style={{ fontSize: 12, color: '#555', cursor: 'pointer', fontWeight: 600, userSelect: 'none' }}>📖 הסבר מפורט</summary>
              <div style={{ marginTop: 8, padding: '8px 10px', background: '#f8f8f8', borderRadius: 8, border: '1px solid #e8e8e8', fontSize: 11, lineHeight: 1.8 }}>
                <div style={{ fontWeight: 700, color: '#333' }}>📋 R32 (base=1):</div>
                <div style={{ color: '#666' }}>#73 ספרד vs מקסיקו Cat B — ספרד FT 1:0 (Under✓)</div>
                <div style={{ color: '#666' }}>#74 גרמניה vs האיטי Cat D — האיטי (אפסט! adv=4נק) 🟥</div>
                <div style={{ color: '#666' }}>#75 ברזיל vs אוסטרליה Cat B — AET 1:1 → אוסטרליה (adv und=3נק)</div>
                <div style={{ color: '#666' }}>#76 צרפת vs אקוודור Cat B — PEN 0:0 → צרפת (adv fav=2נק)</div>
                <div style={{ fontWeight: 700, color: '#333' }}>📋 R16 (base=1), QF (base=2), SF (base=3), Final (base=3):</div>
                <div style={{ color: '#666' }}>#89 ספרד vs האיטי Cat C R16 — 2:0 (Under✓) 🟥</div>
                <div style={{ color: '#666' }}>#90 צרפת vs אוסטרליה Cat B R16 — 3:1 (Over✓)</div>
                <div style={{ color: '#666' }}>#97 ספרד vs צרפת Cat A QF — צרפת 2:1 (אפסט Cat A, base=2)</div>
                <div style={{ color: '#666' }}>#98 ארגנטינה vs פורטוגל Cat A QF — 2:0 (מועדף, base=2)</div>
                <div style={{ color: '#666' }}>#101 צרפת vs ארגנטינה Cat A SF — 2:1 (base=3)</div>
                <div style={{ color: '#666' }}>#104 צרפת vs פורטוגל Cat A Final — 1:0 (Under✓, base=3)</div>
                <div style={{ fontWeight: 700, color: '#333', marginTop: 4 }}>📋 3 משתמשים:</div>
                <div style={{ color: '#666' }}>🏆 "מנצח נוקאאוט" — הכל נכון → צפוי ~81נק</div>
                <div style={{ color: '#666' }}>📊 "מועדפים נוקאאוט" — רק מועדפים → צפוי ~35נק</div>
                <div style={{ color: '#666' }}>💥 "מפתיעים נוקאאוט" — אנדרדוגים + כרטיסים → צפוי ~30נק</div>
                <div style={{ fontWeight: 700, color: '#1a7a44', marginTop: 4 }}>✅ ציפייה: מנצח {'>'} מועדפים {'>'} מפתיעים</div>
                <div style={{ color: '#0C447C', fontWeight: 600 }}>📌 בדוק: QF base=2 (#97=8נק advance) | SF base=3 (#101) | Final base=3 (#104)</div>
              </div>
            </details>
            <button onClick={runFullKnockout} disabled={!!running}
              style={{ width: '100%', padding: '9px', borderRadius: 8, border: 'none',
                background: running === 'full-ko' ? '#aaa' : '#1a1a2e',
                color: '#fff', fontWeight: 700, cursor: running ? 'default' : 'pointer',
                fontFamily: 'inherit', fontSize: 14 }}>
              {running === 'full-ko' ? '⏳ רץ...' : '▶ הרץ סימולציה מלאה — נוקאאוט'}
            </button>
            {fullKoResults && (
              <div style={{ marginTop: 12 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: '#f0f0f0' }}>
                      <th style={{ padding: '6px 8px', textAlign: 'right', border: '1px solid #ddd' }}>משתמש</th>
                      <th style={{ padding: '6px 8px', textAlign: 'center', border: '1px solid #ddd' }}>נוקאאוט</th>
                      <th style={{ padding: '6px 8px', textAlign: 'center', border: '1px solid #ddd' }}>🟥</th>
                      <th style={{ padding: '6px 8px', textAlign: 'center', border: '1px solid #ddd', fontWeight: 700 }}>סה"כ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fullKoResults.sort((a,b) => b.total - a.total).map(r => (
                      <tr key={r.uid}>
                        <td style={{ padding: '6px 8px', border: '1px solid #ddd', fontWeight: 500 }}>{r.name}</td>
                        <td style={{ padding: '6px 8px', border: '1px solid #ddd', textAlign: 'center' }}>{r.matchPoints}</td>
                        <td style={{ padding: '6px 8px', border: '1px solid #ddd', textAlign: 'center' }}>{r.redCardPoints}</td>
                        <td style={{ padding: '6px 8px', border: '1px solid #ddd', textAlign: 'center', fontWeight: 700, color: '#1a7a44' }}>{r.total}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {fullKoResults.map(r => (
                  <details key={r.uid} style={{ marginTop: 5, background: '#f9f9f9', borderRadius: 6, padding: '5px 10px', border: '1px solid #e0e0e0' }}>
                    <summary style={{ cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>{r.name} — פירוט</summary>
                    <ul style={{ margin: '5px 0 0', paddingRight: 14, fontSize: 10, color: '#555' }}>
                      {r.breakdown.map((b,i) => <li key={i} style={{ marginBottom: 2 }}>{b}</li>)}
                    </ul>
                  </details>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Focused scenarios ──────────────────────────────────────────────── */}
      <h3 style={{ margin: '0 0 4px' }}>🔬 סימולציות ממוקדות — שלב בתים</h3>
      <p style={{ color: '#888', fontSize: 13, margin: '0 0 16px' }}>בודק כל סוג ניקוד בנפרד</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14, marginBottom: 24 }}>
        {SCENARIOS.map(s => (
          <div key={s.id} style={{
            border: `2px solid ${activeScenario === s.id ? '#1a7a44' : '#e0e0e0'}`,
            borderRadius: 12, padding: 16,
            background: activeScenario === s.id ? '#f0faf4' : '#fff',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 15 }}>{s.icon} {s.name}</div>
                <div style={{ fontSize: 12, color: '#888', marginTop: 3 }}>{s.description}</div>
              </div>
            </div>
            <div style={{ fontSize: 11, color: '#aaa', marginBottom: 8 }}>
              {s.results.length} משחקים · {s.users.length} משתמשים
              {s.groupResults ? ` · ${Object.keys(s.groupResults).length} בתים` : ''}
            </div>
            <details style={{ marginBottom: 10 }}>
              <summary style={{ fontSize: 12, color: '#555', cursor: 'pointer', fontWeight: 600, userSelect: 'none' }}>
                📖 הסבר מפורט
              </summary>
              <div style={{ marginTop: 8, padding: '8px 10px', background: '#f8f8f8', borderRadius: 8, border: '1px solid #e8e8e8' }}>
                {s.details.map((line, i) => (
                  <div key={i} style={{
                    fontSize: 11, lineHeight: 1.7,
                    color: line.startsWith('✅') ? '#1a7a44' : line.startsWith('📌') ? '#0C447C' : line.startsWith('📋') ? '#333' : line.startsWith('👤') ? '#444' : '#666',
                    fontWeight: line.startsWith('📋') || line.startsWith('✅') || line.startsWith('📌') ? 600 : 400,
                    whiteSpace: 'pre',
                  }}>{line}</div>
                ))}
              </div>
            </details>
            <button
              onClick={() => runScenario(s)}
              disabled={!!running}
              style={{
                width: '100%', padding: '8px', borderRadius: 8, border: 'none',
                background: running === s.id ? '#aaa' : '#1a1a2e',
                color: '#fff', fontWeight: 600, cursor: running ? 'default' : 'pointer',
                fontFamily: 'inherit', fontSize: 13,
              }}>
              {running === s.id ? '⏳ רץ...' : 'הרץ תרחיש'}
            </button>
          </div>
        ))}
      </div>

      {/* Results */}
      {results && (
        <div style={{ marginBottom: 24 }}>
          <h3 style={{ margin: '0 0 12px' }}>📊 תוצאות</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f5f5f5' }}>
                <th style={{ padding: '8px 12px', textAlign: 'right', border: '1px solid #e0e0e0' }}>משתמש</th>
                <th style={{ padding: '8px 12px', textAlign: 'center', border: '1px solid #e0e0e0' }}>משחקים</th>
                <th style={{ padding: '8px 12px', textAlign: 'center', border: '1px solid #e0e0e0' }}>🟥</th>
                <th style={{ padding: '8px 12px', textAlign: 'center', border: '1px solid #e0e0e0' }}>קבוצות</th>
                <th style={{ padding: '8px 12px', textAlign: 'center', border: '1px solid #e0e0e0', fontWeight: 700 }}>סה"כ</th>
              </tr>
            </thead>
            <tbody>
              {results.sort((a,b) => b.total - a.total).map(r => (
                <tr key={r.uid}>
                  <td style={{ padding: '8px 12px', border: '1px solid #e0e0e0', fontWeight: 500 }}>
                    {r.name}
                  </td>
                  <td style={{ padding: '8px 12px', border: '1px solid #e0e0e0', textAlign: 'center' }}>{r.matchPoints}</td>
                  <td style={{ padding: '8px 12px', border: '1px solid #e0e0e0', textAlign: 'center' }}>{r.redCardPoints}</td>
                  <td style={{ padding: '8px 12px', border: '1px solid #e0e0e0', textAlign: 'center' }}>{r.groupPoints}</td>
                  <td style={{ padding: '8px 12px', border: '1px solid #e0e0e0', textAlign: 'center', fontWeight: 700, color: '#1a7a44' }}>{r.total}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Breakdown per user */}
          <div style={{ marginTop: 16 }}>
            {results.map(r => r.breakdown.length > 0 && (
              <details key={r.uid} style={{ marginBottom: 8, background: '#f9f9f9', borderRadius: 8, padding: '8px 12px', border: '1px solid #e0e0e0' }}>
                <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                  {r.name} — {r.total} נק' (פירוט)
                </summary>
                <ul style={{ margin: '8px 0 0 0', paddingRight: 20, fontSize: 12, color: '#555' }}>
                  {r.breakdown.map((b, i) => <li key={i} style={{ marginBottom: 3 }}>{b}</li>)}
                </ul>
              </details>
            ))}
          </div>
        </div>
      )}

      {/* ── Knockout scenarios ──────────────────────────────────────────── */}
      <div style={{ borderTop: '2px solid #e0e0e0', paddingTop: 24, marginTop: 8 }}>
        <h3 style={{ margin: '0 0 6px' }}>🏆 שלב נוקאאוט</h3>
        <p style={{ color: '#888', fontSize: 13, margin: '0 0 16px' }}>
          בדיקת מעבר לנוקאאוט (R32 population) וניקוד שלב הנוקאאוט
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 20 }}>

          {/* R32 Population */}
          <div style={{ border: `2px solid ${r32Result ? '#1a7a44' : '#e0e0e0'}`, borderRadius: 12, padding: 16, background: r32Result ? '#f0faf4' : '#fff' }}>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>🗂️ מעבר לנוקאאוט</div>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>
              מזין standings ל-12 בתים, מריץ Annex C, ומציג את ה-R32 שנוצר
            </div>
            <details style={{ marginBottom: 10 }}>
              <summary style={{ fontSize: 12, color: '#555', cursor: 'pointer', fontWeight: 600, userSelect: 'none' }}>
                📖 הסבר מפורט
              </summary>
              <div style={{ marginTop: 8, padding: '8px 10px', background: '#f8f8f8', borderRadius: 8, border: '1px solid #e8e8e8', fontSize: 11, lineHeight: 1.8 }}>
                <div style={{ fontWeight: 700, color: '#333' }}>📋 מה הסימולציה בודקת:</div>
                <div style={{ color: '#666' }}>מזין standings מלאים ל-12 בתים עם 1/2/3 לכל בת ו-8 שלישיות מובחרות</div>
                <div style={{ fontWeight: 700, color: '#333', marginTop: 6 }}>📋 שיבוץ שלישיות (Annex C):</div>
                <div style={{ color: '#666' }}>השלישיות מבתים C,F,G,H,I,J,K,L — תואם לשורה 1 בטבלת Annex C</div>
                <div style={{ color: '#666' }}>לפי הטבלה: E1←3F, I1←3G, A1←3C, L1←3K, D1←3I, G1←3H, B1←3J, K1←3L</div>
                <div style={{ fontWeight: 700, color: '#333', marginTop: 6 }}>📋 8 משחקים קבועים (ללא שלישיות):</div>
                <div style={{ color: '#666' }}>#73 A2 vs B2 · #75 F1 vs C2 · #76 C1 vs F2 · #78 E2 vs I2</div>
                <div style={{ color: '#666' }}>#83 K2 vs L2 · #85 H1 vs J2 · #86 J1 vs H2 · #88 D2 vs G2</div>
                <div style={{ fontWeight: 700, color: '#1a7a44', marginTop: 6 }}>✅ ציפייה: 16/16 משחקים מאוכלסים</div>
                <div style={{ color: '#0C447C', fontWeight: 600, marginTop: 4 }}>📌 בדוק שכל קבוצה מופיעה פעם אחת בלבד</div>
              </div>
            </details>
            <div style={{ fontSize: 11, color: '#aaa', marginBottom: 12 }}>
              12 בתים · 8 שלישיות · 495 תרחישי Annex C
            </div>
            <button onClick={runR32Population} disabled={!!running}
              style={{ width: '100%', padding: '8px', borderRadius: 8, border: 'none',
                background: running === 'r32' ? '#aaa' : '#1a1a2e', color: '#fff',
                fontWeight: 600, cursor: running ? 'default' : 'pointer', fontFamily: 'inherit', fontSize: 13 }}>
              {running === 'r32' ? '⏳ רץ...' : 'הרץ R32 Population'}
            </button>

            {r32Result && (
              <div style={{ marginTop: 12, maxHeight: 220, overflowY: 'auto' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#888', marginBottom: 6 }}>תוצאת R32:</div>
                {Object.entries(r32Result).filter(([,km]: any) => km.teamA || km.teamB).map(([id, km]: any) => (
                  <div key={id} style={{ fontSize: 11, padding: '3px 6px', borderRadius: 6,
                    background: km.teamA && km.teamB ? '#EAF3DE' : '#FFF9E6',
                    border: '1px solid ' + (km.teamA && km.teamB ? '#b7e4c7' : '#f0e0a0'),
                    marginBottom: 3, display: 'flex', justifyContent: 'space-between' }}>
                    <span>#{id}: {km.teamA ?? '?'} vs {km.teamB ?? '?'}</span>
                    <span style={{ color: '#888' }}>{km.category}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Knockout Scoring */}
          <div style={{ border: `2px solid ${koResults ? '#1a7a44' : '#e0e0e0'}`, borderRadius: 12, padding: 16, background: koResults ? '#f0faf4' : '#fff' }}>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>⚽ ניקוד נוקאאוט</div>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>
              5 משחקי נוקאאוט (R32/R16/QF) עם FT, AET, upset · 3 משתמשים עם advance picks שונים + כרטיסי אדום
            </div>
            <details style={{ marginBottom: 10 }}>
              <summary style={{ fontSize: 12, color: '#555', cursor: 'pointer', fontWeight: 600, userSelect: 'none' }}>
                📖 הסבר מפורט
              </summary>
              <div style={{ marginTop: 8, padding: '8px 10px', background: '#f8f8f8', borderRadius: 8, border: '1px solid #e8e8e8', fontSize: 11, lineHeight: 1.8 }}>
                <div style={{ fontWeight: 700, color: '#333' }}>📋 משחקים (R32 base=1, R16 base=1, QF base=2):</div>
                <div style={{ color: '#666' }}>#73 ספרד vs מקסיקו — Cat B, FT 1:0, ספרד עולה (Under ✓)</div>
                <div style={{ color: '#666' }}>#74 גרמניה vs האיטי — Cat D, האיטי מנצחת (Cat D upset!) 🟥 כרטיס אדום</div>
                <div style={{ color: '#666' }}>#75 ברזיל vs אוסטרליה — Cat B, תיקו 1:1 → AET → אוסטרליה עולה</div>
                <div style={{ color: '#666' }}>#89 צרפת vs קולומביה — Cat B R16, FT 2:1, צרפת עולה</div>
                <div style={{ color: '#666' }}>#97 ארגנטינה vs בלגיה — Cat A QF, בלגיה מנצחת 2:0 (Cat A upset, base=2)</div>
                <div style={{ fontWeight: 700, color: '#333', marginTop: 6 }}>📋 3 משתמשים:</div>
                <div style={{ color: '#666' }}>👤 "מועדפים" — בוחר מועדף + advance מועדף: צפוי ~12נק</div>
                <div style={{ color: '#666' }}>  1X2✓ ספרד (#73) + exact+OU = +4 | advance ספרד Cat B = +2</div>
                <div style={{ color: '#666' }}>  1X2✓ צרפת (#89) + exact = +3 | advance צרפת Cat B = +3</div>
                <div style={{ color: '#666' }}>👤 "מפתיעים" — בוחר אנדרדוג + advance אנדרדוג: צפוי ~15נק</div>
                <div style={{ color: '#666' }}>  advance האיטי Cat D = +4 | advance אוסטרליה Cat B = +3</div>
                <div style={{ color: '#666' }}>  advance בלגיה Cat A QF = +4 | 🟥 #74 נכון = +2</div>
                <div style={{ color: '#666' }}>👤 "X תמיד" — מנחש תיקו: רק #75 נכון (Cat B R32 draw = +1)</div>
                <div style={{ fontWeight: 700, color: '#1a7a44', marginTop: 6 }}>✅ ציפייה: מפתיעים {'>'} מועדפים {'>'} X תמיד</div>
                <div style={{ color: '#0C447C', fontWeight: 600 }}>📌 בדוק: advance Cat D (#74) = 4נק, QF base (#97) = 2נק</div>
              </div>
            </details>
            <div style={{ fontSize: 11, color: '#aaa', marginBottom: 4 }}>
              <b>R32 (base=1):</b> ספרד-מקסיקו Cat B (FT) · גרמניה-האיטי Cat D upset (🟥) · ברזיל-אוסטרליה Cat B (AET)
            </div>
            <div style={{ fontSize: 11, color: '#aaa', marginBottom: 12 }}>
              <b>R16 (base=1):</b> צרפת-קולומביה Cat B · <b>QF (base=2):</b> ארגנטינה-בלגיה Cat A upset
            </div>
            <button onClick={runKnockoutScoring} disabled={!!running}
              style={{ width: '100%', padding: '8px', borderRadius: 8, border: 'none',
                background: running === 'ko-scoring' ? '#aaa' : '#1a1a2e', color: '#fff',
                fontWeight: 600, cursor: running ? 'default' : 'pointer', fontFamily: 'inherit', fontSize: 13 }}>
              {running === 'ko-scoring' ? '⏳ רץ...' : 'הרץ ניקוד נוקאאוט'}
            </button>

            {koResults && (
              <div style={{ marginTop: 12 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: '#f5f5f5' }}>
                      <th style={{ padding: '5px 8px', textAlign: 'right', border: '1px solid #e0e0e0' }}>משתמש</th>
                      <th style={{ padding: '5px 8px', textAlign: 'center', border: '1px solid #e0e0e0' }}>🟥</th>
                      <th style={{ padding: '5px 8px', textAlign: 'center', border: '1px solid #e0e0e0', fontWeight: 700 }}>סה"כ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {koResults.sort((a,b) => b.total - a.total).map(r => (
                      <tr key={r.uid}>
                        <td style={{ padding: '5px 8px', border: '1px solid #e0e0e0', fontWeight: 500 }}>{r.name}</td>
                        <td style={{ padding: '5px 8px', border: '1px solid #e0e0e0', textAlign: 'center' }}>{r.redCardPoints}</td>
                        <td style={{ padding: '5px 8px', border: '1px solid #e0e0e0', textAlign: 'center', fontWeight: 700, color: '#1a7a44' }}>{r.total}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {koResults.map(r => r.breakdown.length > 0 && (
                  <details key={r.uid} style={{ marginTop: 6, background: '#f9f9f9', borderRadius: 6, padding: '6px 10px', border: '1px solid #e0e0e0' }}>
                    <summary style={{ cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>{r.name} — פירוט</summary>
                    <ul style={{ margin: '6px 0 0 0', paddingRight: 16, fontSize: 11, color: '#555' }}>
                      {r.breakdown.map((b, i) => <li key={i} style={{ marginBottom: 2 }}>{b}</li>)}
                    </ul>
                  </details>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Log */}
      {log.length > 0 && (
        <div style={{ background: '#1a1a2e', borderRadius: 10, padding: 14 }}>
          <div style={{ fontSize: 12, color: '#aaa', marginBottom: 8, fontWeight: 600 }}>לוג</div>
          {log.map((l, i) => (
            <div key={i} style={{ fontSize: 12, color: l.startsWith('❌') ? '#ff6b6b' : '#7bed9f', fontFamily: 'monospace', marginBottom: 2 }}>
              {l}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
