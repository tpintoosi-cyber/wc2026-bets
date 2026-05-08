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


// ── Component ─────────────────────────────────────────────────────────────────
export default function Simulator() {
  const [running, setRunning] = useState<string | null>(null)
  const [results, setResults] = useState<ScenarioResult[] | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [resetting, setResetting] = useState(false)
  const [activeScenario, setActiveScenario] = useState<string | null>(null)
  const [r32Result, setR32Result] = useState<Record<number,any> | null>(null)
  const [koResults, setKoResults] = useState<ScenarioResult[] | null>(null)

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

      {/* Scenario cards */}
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
            <div style={{ fontSize: 11, color: '#aaa', marginBottom: 10 }}>
              {s.results.length} משחקים · {s.users.length} משתמשים
              {s.groupResults ? ` · ${Object.keys(s.groupResults).length} בתים` : ''}
            </div>
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
              5 משחקי נוקאאוט (R32/R16/QF) עם FT, AET, upset ·  3 משתמשים עם advance picks שונים + כרטיסי אדום
            </div>
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
