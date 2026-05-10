import { Category, Match, MatchPrediction, GroupPrediction, BonusPredictions, UserScore, MatchScore, KnockoutMatch, KnockoutMatchPrediction, KnockoutRound, KnockoutRedCardPicks } from './types'

// ── GROUP STAGE 1X2 ───────────────────────────────────────────────────────────
// Favorite wins → 1pt always
// Draw: A=1, B=1, C=2, D=3
// Underdog wins: A=1, B=2, C=3, D=4
export function calc1X2Points(
  prediction: '1' | 'X' | '2',
  resultA: number,
  resultB: number,
  fifaPointsA: number,
  fifaPointsB: number,
  category: Category
): number {
  const actualResult = resultA > resultB ? '1' : resultA < resultB ? '2' : 'X'
  if (prediction !== actualResult) return 0

  const catBonus = { A: 0, B: 1, C: 2, D: 3 }[category]

  if (actualResult === 'X') {
    return 1 + Math.max(0, catBonus - 1)  // A=1, B=1, C=2, D=3
  }

  const aIsFavorite = fifaPointsA >= fifaPointsB
  const favoriteWon =
    (actualResult === '1' && aIsFavorite) ||
    (actualResult === '2' && !aIsFavorite)

  if (favoriteWon) return 1
  return 1 + catBonus  // underdog: A=1, B=2, C=3, D=4
}

// ── KNOCKOUT 1X2 ─────────────────────────────────────────────────────────────
// Base scales up by round: R32/R16=1, QF/3P=2, SF/F=3
// Favorite wins → base
// Draw → base + max(0, catBonus-1)
// Underdog → base + catBonus
// Cat A: catBonus=0 | B: +1 | C: +2 | D: +3 (D only in R32/R16)
export function calc1X2KnockoutPoints(
  prediction: '1' | 'X' | '2',
  resultA: number,
  resultB: number,
  fifaPointsA: number,
  fifaPointsB: number,
  category: Category,
  round: KnockoutRound
): number {
  const actualResult = resultA > resultB ? '1' : resultA < resultB ? '2' : 'X'
  if (prediction !== actualResult) return 0

  const base = ({ R32: 1, R16: 1, QF: 2, SF: 3, '3P': 2, F: 3 } as Record<KnockoutRound, number>)[round]
  const catBonus = { A: 0, B: 1, C: 2, D: 3 }[category]

  if (actualResult === 'X') {
    return base + Math.max(0, catBonus - 1)
  }

  const aIsFavorite = fifaPointsA >= fifaPointsB
  const favoriteWon =
    (actualResult === '1' && aIsFavorite) ||
    (actualResult === '2' && !aIsFavorite)

  if (favoriteWon) return base
  return base + catBonus
}

// ── GROUP STAGE OVER/UNDER ───────────────────────────────────────────────────
export function calcOverUnder(total: number, category: Category): boolean {
  if (category === 'A' || category === 'B') return total <= 1 || total >= 4
  return total <= 2 || total >= 5
}

// ── KNOCKOUT OVER/UNDER ───────────────────────────────────────────────────────
// Points: R32/R16/3P=1, QF/SF/F=2
// Thresholds:
//   R32/R16/QF/SF: same as group stage by category
//   3P: ≤2 or ≥5 (C/D thresholds for all)
//   Final: under=0-0 only, over=≥4
export function calcOverUnderKnockout(
  total: number,
  category: Category,
  round: KnockoutRound
): { qualifies: boolean; points: number } {
  const points = ({ R32: 1, R16: 1, QF: 2, SF: 2, '3P': 1, F: 2 } as Record<KnockoutRound, number>)[round]

  let qualifies: boolean
  if (round === 'F') {
    qualifies = total === 0 || total >= 4
  } else if (round === '3P') {
    qualifies = total <= 2 || total >= 5
  } else {
    qualifies = calcOverUnder(total, category)
  }

  return { qualifies, points }
}

// ── GROUP STAGE SCORE ─────────────────────────────────────────────────────────
export function calcScorePoints(
  predA: number,
  predB: number,
  resultA: number,
  resultB: number,
  category: Category
): number {
  if (predA === resultA && predB === resultB) {
    const total = resultA + resultB
    const overUnder = calcOverUnder(total, category) ? 1 : 0
    return 2 + overUnder
  }
  if ((predA - predB) === (resultA - resultB)) return 1
  return 0
}

// ── KNOCKOUT SCORE ────────────────────────────────────────────────────────────
export function calcScoreKnockoutPoints(
  predA: number,
  predB: number,
  resultA: number,
  resultB: number,
  category: Category,
  round: KnockoutRound
): number {
  if (predA === resultA && predB === resultB) {
    const total = resultA + resultB
    const { qualifies, points } = calcOverUnderKnockout(total, category, round)
    return 2 + (qualifies ? points : 0)
  }
  if ((predA - predB) === (resultA - resultB)) return 1
  return 0
}

// ── RED CARD ─────────────────────────────────────────────────────────────────
export function calcRedCardPoints(predicted: boolean, hadRedCard: boolean): number {
  return predicted && hadRedCard ? 2 : 0
}

// ── KNOCKOUT RED CARDS ────────────────────────────────────────────────────────
// User picks N match IDs per round that they think will have red cards
// R32: 3 picks, R16: 2 picks, QF: 1 pick, SF/3P/F: none
// 2 pts per correct pick
export function calcKnockoutRedCardPoints(
  picks: KnockoutRedCardPicks,
  playedMatches: KnockoutMatch[]
): number {
  let pts = 0
  const maxPicks: Partial<Record<KnockoutRound, number>> = { R32: 3, R16: 2, QF: 1 }

  for (const [round, max] of Object.entries(maxPicks) as [KnockoutRound, number][]) {
    const roundPicks = picks[round] ?? []
    const valid = roundPicks.slice(0, max)
    for (const matchId of valid) {
      const match = playedMatches.find(m => m.id === matchId)
      if (match?.isPlayed && match.hadRedCard) pts += 2
    }
  }
  return pts
}

// ── GROUP ADVANCING ──────────────────────────────────────────────────────────
export function calcGroupPoints(
  predictions: [string, string, string],
  actual: [string, string, string]
): number {
  let pts = 0
  for (let i = 0; i < 3; i++) {
    if (!predictions[i]) continue
    if (predictions[i] === actual[i]) pts += 2
    else if (actual.includes(predictions[i])) pts += 1
  }
  return pts
}

// ── BONUS ─────────────────────────────────────────────────────────────────────
const BONUS_POINTS: Record<string, number> = {
  q105: 20, q106: 6, q107: 5, q108: 8, q109: 4,
  q110: 6, q111: 5, q112: 5, q113: 5, q114: 5,
  q115: 5, q116: 3, q117: 3,
}
const REDUCED_CHAMPION = ['צרפת', 'ספרד', 'אנגליה']

export function calcBonusPoints(
  predictions: Partial<BonusPredictions>,
  actuals: Partial<BonusPredictions>
): number {
  let pts = 0
  for (const key of Object.keys(BONUS_POINTS) as Array<keyof BonusPredictions>) {
    const pred = predictions[key]
    const actual = actuals[key]
    if (!pred || !actual) continue
    if (pred.trim().toLowerCase() !== actual.trim().toLowerCase()) continue
    let base = BONUS_POINTS[key]
    if (key === 'q105' && REDUCED_CHAMPION.includes(pred)) base = 17
    pts += base
  }
  return pts
}

// ── KNOCKOUT ADVANCE ─────────────────────────────────────────────────────────
// Points for correctly predicting which team advances
// Base points scale by round. Bonus ONLY if you picked the underdog.
// Picking the favorite → always base points (Cat A = no bonus)
// Picking the underdog → base + catBonus
export function calcAdvancePoints(
  predicted: string,
  actual: string,
  round: KnockoutRound,
  category: Category,
  fifaPointsA: number,
  fifaPointsB: number,
  teamA: string,
  teamB: string
): number {
  if (!predicted || !actual || predicted !== actual) return 0
  const base = ({ R32: 1, R16: 2, QF: 3, SF: 4, '3P': 2, F: 5 } as Record<KnockoutRound, number>)[round]
  const catBonus = { A: 0, B: 1, C: 2, D: 2 }[category]
  // Was the predicted team the underdog?
  const aIsFavorite = fifaPointsA >= fifaPointsB
  const pickedUnderdog =
    (predicted === teamA && !aIsFavorite) ||
    (predicted === teamB && aIsFavorite)
  return base + (pickedUnderdog ? catBonus : 0)
}

// ── FULL USER SCORE ───────────────────────────────────────────────────────────
export function computeUserScore(
  userId: string,
  userName: string,
  matchPredictions: Record<number, MatchPrediction>,
  groupPredictions: Record<string, GroupPrediction>,
  bonusPredictions: Partial<BonusPredictions>,
  playedMatches: Match[],
  actualGroups: Record<string, [string, string, string]>,
  actualBonus: Partial<BonusPredictions>,
  knockoutPredictions?: Record<number, KnockoutMatchPrediction>,
  playedKnockout?: KnockoutMatch[],
  knockoutRedCards?: KnockoutRedCardPicks
): UserScore {
  const matchDetails: Record<number, MatchScore> = {}
  let matchPoints = 0
  let redCardPoints = 0

  for (const match of playedMatches) {
    if (match.resultA === undefined || match.resultB === undefined) continue
    const pred = matchPredictions[match.id]
    if (!pred) continue

    const p1x2 = calc1X2Points(
      pred.prediction1X2,
      match.resultA, match.resultB,
      match.fifaPointsA, match.fifaPointsB,
      match.category
    )
    const pScore = calcScorePoints(pred.scoreA, pred.scoreB, match.resultA, match.resultB, match.category)
    const pRed = calcRedCardPoints(pred.redCard, match.hadRedCard ?? false)

    matchDetails[match.id] = { matchId: match.id, points1X2: p1x2, pointsScore: pScore, pointsRedCard: pRed, total: p1x2 + pScore + pRed }
    matchPoints += p1x2 + pScore
    redCardPoints += pRed
  }

  let groupPoints = 0
  for (const [group, actual] of Object.entries(actualGroups)) {
    const pred = groupPredictions[group]
    if (!pred) continue
    groupPoints += calcGroupPoints(pred.advancing, actual)
  }

  const bonusPoints = calcBonusPoints(bonusPredictions, actualBonus)

  // ── Knockout scoring ──────────────────────────────────────────────────────
  let knockoutPoints = 0
  if (knockoutPredictions && playedKnockout) {
    for (const km of playedKnockout) {
      if (!km.isPlayed || km.resultA === undefined || km.resultB === undefined) continue
      const pred = knockoutPredictions[km.id]
      if (!pred) continue

      // 1X2 — round-aware
      if (pred.prediction1X2) {
        knockoutPoints += calc1X2KnockoutPoints(
          pred.prediction1X2, km.resultA, km.resultB,
          km.fifaPointsA, km.fifaPointsB, km.category, km.round
        )
      }

      // Score — round-aware over/under
      if (pred.scoreA !== null && pred.scoreA !== undefined &&
          pred.scoreB !== null && pred.scoreB !== undefined) {
        knockoutPoints += calcScoreKnockoutPoints(
          Number(pred.scoreA), Number(pred.scoreB),
          km.resultA, km.resultB, km.category, km.round
        )
      }

      // Advance
      if (km.advanceTeam) {
        if (km.round === 'R32' && pred.advance) {
          knockoutPoints += calcAdvancePoints(pred.advance, km.advanceTeam, km.round, km.category, km.fifaPointsA ?? 1500, km.fifaPointsB ?? 1500, km.teamA ?? '', km.teamB ?? '')
        }
        if (km.round !== 'R32' && km.teamA && km.teamB) {
          const advancePred = findAdvancePrediction(km.teamA, km.teamB, knockoutPredictions)
          if (advancePred) {
            knockoutPoints += calcAdvancePoints(advancePred, km.advanceTeam, km.round, km.category, km.fifaPointsA ?? 1500, km.fifaPointsB ?? 1500, km.teamA ?? '', km.teamB ?? '')
          }
        }
      }
    }

    // Red cards — per-round picks
    if (knockoutRedCards) {
      knockoutPoints += calcKnockoutRedCardPoints(knockoutRedCards, playedKnockout)
    }
  }

  return {
    userId,
    userName,
    matchPoints,
    groupPoints,
    bonusPoints,
    redCardPoints,
    knockoutPoints,
    total: matchPoints + redCardPoints + groupPoints + bonusPoints + knockoutPoints,
    matchDetails,
    lastUpdated: Date.now(),
  }
}

function findAdvancePrediction(
  teamA: string,
  teamB: string,
  knockoutPreds: Record<number, KnockoutMatchPrediction>
): string | null {
  for (const pred of Object.values(knockoutPreds)) {
    if (pred.advance === teamA || pred.advance === teamB) return pred.advance
  }
  return null
}

