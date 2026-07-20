import { Category, Match, MatchPrediction, GroupPrediction, BonusPredictions, UserScore, MatchScore, KnockoutMatch, KnockoutMatchPrediction, KnockoutRound, KnockoutRedCardPicks } from './types'
import { KNOCKOUT_BRACKET, calcCategoryByRound } from './data/matches'

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

// ── OVER/UNDER ───────────────────────────────────────────────────────────────
// Universal thresholds (all matches, all categories, all rounds):
//   Under = total ≤ 1 (0 or 1 goals)
//   Over  = total ≥ 4 (4+ goals)
//   2-3 goals = neither
const OU_UNDER = 1  // total <= OU_UNDER → under
const OU_OVER  = 4  // total >= OU_OVER  → over

export function calcOverUnder(total: number, _category?: Category): boolean {
  return total <= OU_UNDER || total >= OU_OVER
}

export function calcOverUnderKnockout(
  total: number,
  _category: Category,
  round: KnockoutRound
): { qualifies: boolean; points: number } {
  const points = ({ R32: 1, R16: 1, QF: 2, SF: 2, '3P': 1, F: 2 } as Record<KnockoutRound, number>)[round]
  return { qualifies: total <= OU_UNDER || total >= OU_OVER, points }
}

export function getOUType(total: number, _category?: Category, _round?: KnockoutRound): 'under' | 'over' | null {
  return total <= OU_UNDER ? 'under' : total >= OU_OVER ? 'over' : null
}

export function calcOUPoints(
  predA: number, predB: number,
  actualA: number, actualB: number,
  _category?: Category,
  round?: KnockoutRound
): number {
  if (predA === actualA && predB === actualB) return 0  // exact → handled by calcScorePoints
  const predType = getOUType(predA + predB)
  const actType  = getOUType(actualA + actualB)
  if (!predType || predType !== actType) return 0
  return round && ['QF', 'SF', 'F'].includes(round) ? 2 : 1
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
  actual: [string, string, string],
  qualifiedThirds?: string[]
): number {
  let pts = 0
  for (let i = 0; i < 3; i++) {
    if (!predictions[i]) continue
    // For 3rd place: only score if the actual 3rd-place team qualified to R32
    if (i === 2 && qualifiedThirds && !qualifiedThirds.includes(actual[2])) continue
    if (predictions[i] === actual[i]) pts += 2
    else if (actual.includes(predictions[i])) pts += 1
  }
  return pts
}

// ── BONUS ─────────────────────────────────────────────────────────────────────
const BONUS_POINTS: Record<string, number> = {
  q105: 30, q106: 8, q107: 4, q108: 8, q109: 4,
  q110: 6, q111: 5, q112: 5, q113: 5, q114: 5,
  q115: 5, q116: 4, q117: 3, q118: 5,
}
const REDUCED_CHAMPION = ['צרפת', 'ספרד', 'אנגליה']            // 20 pts
const MEDIUM_CHAMPION  = ['ארגנטינה', 'ברזיל', 'פורטוגל', 'גרמניה'] // 24 pts
const REDUCED_RUNNER   = ['צרפת', 'ספרד', 'אנגליה']            // 6 pts

export function calcBonusPoints(
  predictions: Partial<BonusPredictions>,
  actuals: Partial<BonusPredictions>
): number {
  let pts = 0
  for (const key of Object.keys(BONUS_POINTS) as Array<keyof BonusPredictions>) {
    const pred = predictions[key]
    const actual = actuals[key]
    if (!pred || !actual) continue
    // Support multiple correct answers separated by comma: "Spain,Germany"
    const actualValues = actual.split(',').map(v => v.trim().toLowerCase())
    const predNorm = pred.trim().toLowerCase()
    if (!actualValues.includes(predNorm)) continue
    let base = BONUS_POINTS[key]
    if (key === 'q105') {
      if (REDUCED_CHAMPION.includes(pred)) base = 20
      else if (MEDIUM_CHAMPION.includes(pred)) base = 24
    }
    if (key === 'q106' && REDUCED_RUNNER.includes(pred)) base = 6
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

// Resolves which team a user routed into a given side of a knockout match, per their bracket.
// Positive feeder = the team the user predicted to WIN that feeder match.
// Negative feeder = the team the user predicted to LOSE match |feeder| (the 3rd-place feeders).
function resolveBracketTeam(
  matchId: number,
  side: 'A' | 'B',
  kp: Record<number, KnockoutMatchPrediction>
): string | undefined {
  const b = KNOCKOUT_BRACKET[matchId]
  if (!b) return undefined
  const feederId = side === 'A' ? b.feederA : b.feederB
  if (feederId === null) return undefined
  if (feederId < 0) {
    const sfId = Math.abs(feederId)
    const winner = kp[sfId]?.advance
    const sfA = resolveBracketTeam(sfId, 'A', kp)
    const sfB = resolveBracketTeam(sfId, 'B', kp)
    if (!winner || !sfA || !sfB) return undefined
    return winner === sfA ? sfB : sfA
  }
  return kp[feederId]?.advance
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
  knockoutRedCards?: KnockoutRedCardPicks,
  qualifiedThirds?: string[]
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
    const pOU = calcOUPoints(pred.scoreA, pred.scoreB, match.resultA, match.resultB, match.category)
    const pRed = calcRedCardPoints(pred.redCard, match.hadRedCard ?? false)

    matchDetails[match.id] = { matchId: match.id, points1X2: p1x2, pointsScore: pScore, pointsRedCard: pRed, total: p1x2 + pScore + pOU + pRed }
    matchPoints += p1x2 + pScore + pOU
    redCardPoints += pRed
  }

  let groupPoints = 0
  for (const [group, actual] of Object.entries(actualGroups)) {
    const pred = groupPredictions[group]
    if (!pred) continue
    groupPoints += calcGroupPoints(pred.advancing, actual, qualifiedThirds)
  }

  const bonusPoints = calcBonusPoints(bonusPredictions, actualBonus)

  // ── Knockout scoring ──────────────────────────────────────────────────────
  let knockoutPoints = 0
  const koByRound: Record<string, number> = { R32: 0, R16: 0, QF: 0, SF: 0, '3P': 0, F: 0 }
  if (knockoutPredictions && playedKnockout) {
    for (const km of playedKnockout) {
      if (!km.isPlayed || km.resultA === undefined || km.resultB === undefined) continue
      const pred = knockoutPredictions[km.id]
      if (!pred) continue
      let matchPts = 0

      // Category is computed from FIFA + round at scoring time rather than trusting the
      // stored km.category. Propagated late-round matches (QF/SF/3P/F) get their teams and
      // FIFA points updated on propagation but NOT their category, so a stored category can
      // be stale, wrong, or missing. FIFA points are always current, so this is authoritative.
      const kmCat = calcCategoryByRound(km.fifaPointsA ?? 1500, km.fifaPointsB ?? 1500, km.round) as Category

      if (pred.prediction1X2) {
        matchPts += calc1X2KnockoutPoints(
          pred.prediction1X2, km.resultA, km.resultB,
          km.fifaPointsA, km.fifaPointsB, kmCat, km.round
        )
      }
      if (pred.scoreA !== null && pred.scoreA !== undefined &&
          pred.scoreB !== null && pred.scoreB !== undefined) {
        matchPts += calcScoreKnockoutPoints(
          Number(pred.scoreA), Number(pred.scoreB),
          km.resultA, km.resultB, kmCat, km.round
        )
      }
      if (km.advanceTeam && pred.advance) {
        // For QF/SF/F: advance pick must be bracket-valid (user must have predicted this team to reach this stage)
        // For R32/R16: advance pick is always valid (user picks directly)
        let advanceValid = true
        if (km.round !== 'R32' && km.round !== 'R16') {
          const b = KNOCKOUT_BRACKET[km.id]
          if (b) {
            const bracketA = resolveBracketTeam(km.id, 'A', knockoutPredictions)
            const bracketB = resolveBracketTeam(km.id, 'B', knockoutPredictions)
            advanceValid = pred.advance === bracketA || pred.advance === bracketB
          }
        }
        if (advanceValid) {
          matchPts += calcAdvancePoints(pred.advance, km.advanceTeam, km.round, kmCat, km.fifaPointsA ?? 1500, km.fifaPointsB ?? 1500, km.teamA ?? '', km.teamB ?? '')
        }
      }
      koByRound[km.round] = (koByRound[km.round] ?? 0) + matchPts
      knockoutPoints += matchPts
    }

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
    koR32: koByRound['R32'] ?? 0,
    koR16: koByRound['R16'] ?? 0,
    koQF:  koByRound['QF']  ?? 0,
    koSF:  koByRound['SF']  ?? 0,
    ko3P:  koByRound['3P']  ?? 0,
    koF:   koByRound['F']   ?? 0,
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
