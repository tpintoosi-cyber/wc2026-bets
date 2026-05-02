import { Category, Match, MatchPrediction, GroupPrediction, BonusPredictions, UserScore, MatchScore } from './types'

// ── 1X2 ──────────────────────────────────────────────────────────────────────
// Implements the Excel formula exactly:
//   Favorite wins → 1pt always
//   Draw: A=1, B=1, C=2, D=3
//   Underdog wins: A=1, B=2, C=3, D=4
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

  const catIdx = { A: 0, B: 1, C: 2, D: 3 }[category]

  if (actualResult === 'X') {
    return [1, 1, 2, 3][catIdx]
  }

  // Win — is it the favorite?
  const aIsFavorite = fifaPointsA >= fifaPointsB
  const favoriteWon =
    (actualResult === '1' && aIsFavorite) ||
    (actualResult === '2' && !aIsFavorite)

  if (favoriteWon) return 1
  return [1, 2, 3, 4][catIdx] // underdog won
}

// ── EXACT SCORE ───────────────────────────────────────────────────────────────
// Exact: 2pts + 1 bonus margin = 3pts total
// Over/under bonus (per category): extra +1
//   A/B: total goals <=1 or >=4
//   C/D: total goals <=2 or >=5
// Correct margin only: 1pt
// Wrong: 0
export function calcOverUnder(total: number, category: Category): boolean {
  if (category === 'A' || category === 'B') return total <= 1 || total >= 4
  return total <= 2 || total >= 5
}

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

// ── RED CARD ─────────────────────────────────────────────────────────────────
// +1 if predicted red card and match had one; no penalty for wrong prediction
export function calcRedCardPoints(predicted: boolean, hadRedCard: boolean): number {
  return predicted && hadRedCard ? 2 : 0
}

// ── GROUP ADVANCING ──────────────────────────────────────────────────────────
// Exact position: 2pts | Correct team wrong position: 1pt
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
// France, Spain, England get 17 pts instead of 20 for world champion
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

// ── FULL USER SCORE ───────────────────────────────────────────────────────────
export function computeUserScore(
  userId: string,
  userName: string,
  matchPredictions: Record<number, MatchPrediction>,
  groupPredictions: Record<string, GroupPrediction>,
  bonusPredictions: Partial<BonusPredictions>,
  playedMatches: Match[],
  actualGroups: Record<string, [string, string, string]>,
  actualBonus: Partial<BonusPredictions>
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

  return {
    userId,
    userName,
    matchPoints,
    groupPoints,
    bonusPoints,
    redCardPoints,
    total: matchPoints + redCardPoints + groupPoints + bonusPoints,
    matchDetails,
    lastUpdated: Date.now(),
  }
}
