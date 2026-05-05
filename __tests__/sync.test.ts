import { describe, it, expect } from 'vitest'
import { getKnockoutResult, parseStandings } from '../services/apifootball'
import { calc1X2Points, calcScorePoints, calcRedCardPoints, calcAdvancePoints, computeUserScore } from '../scoring'
import type { ApiFootballFixture } from '../services/apifootball'

// ─────────────────────────────────────────────────────────────────────────────
// Full tournament flow simulation
// ─────────────────────────────────────────────────────────────────────────────

const makeFixture = (
  status: string, homeName: string, awayName: string,
  ftH: number, ftA: number,
  etH: number | null = null, etA: number | null = null,
  penH: number | null = null, penA: number | null = null
): ApiFootballFixture => ({
  fixture: { id: 1, status: { short: status, elapsed: null } },
  teams: { home: { name: homeName }, away: { name: awayName } },
  score: {
    halftime:  { home: 0, away: 0 },
    fulltime:  { home: ftH, away: ftA },
    extratime: { home: etH, away: etA },
    penalty:   { home: penH, away: penA },
  },
})

describe('Full sync flow — group stage to final', () => {

  // ── Scenario 1: Normal group stage match ──────────────────────────────────
  it('Group stage: France 3-1 Brazil — user predicted 2-1 France', () => {
    const resultA = 3, resultB = 1
    const fifaA = 1877, fifaB = 1761
    const category = 'A' as const

    // 1X2: France wins (favorite Cat A) → 1pt
    const p1x2 = calc1X2Points('1', resultA, resultB, fifaA, fifaB, category)
    expect(p1x2).toBe(1)

    // Score: 2-1 predicted, 3-1 actual → diff=1 vs diff=2, wrong margin → 0pt
    const pScore = calcScorePoints(2, 1, resultA, resultB, category)
    expect(pScore).toBe(0)

    // Total: 1pt (1X2 only)
    expect(p1x2 + pScore).toBe(1)
  })

  // ── Scenario 2: Exact score with over/under bonus ─────────────────────────
  it('Group stage: Spain 4-0 Cape Verde (Cat D) — exact score → 3pt + over bonus', () => {
    const resultA = 4, resultB = 0
    const category = 'D' as const

    const pScore = calcScorePoints(4, 0, resultA, resultB, category)
    // Exact: 2pt + over (4 goals Cat C/D ≥5? No, 4 is not ≥5) → 2pt
    // Wait: Cat C/D over is ≥5, and 4+0=4 < 5, under threshold for C/D is ≤2. 4 is neither.
    expect(pScore).toBe(2)  // exact only, no over/under bonus for Cat C/D with 4 goals
  })

  it('Group stage: Germany 5-1 Curaçao (Cat D) — exact score + over', () => {
    const resultA = 5, resultB = 1
    const category = 'D' as const
    const pScore = calcScorePoints(5, 1, resultA, resultB, category)
    // Exact: 2pt + over (6 goals ≥5 for Cat C/D) → 3pt
    expect(pScore).toBe(3)
  })

  // ── Scenario 3: Knockout R32 — normal win ─────────────────────────────────
  it('R32: France 2-1 England (FT) — user predicted France wins + exact score', () => {
    const fixture = makeFixture('FT', 'France', 'England', 2, 1)
    const result = getKnockoutResult(fixture, 'France', 'England')!

    expect(result.score90A).toBe(2)
    expect(result.score90B).toBe(1)
    expect(result.advanceTeam).toBe('France')

    // Scoring
    const p1x2 = calc1X2Points('1', 2, 1, 1877, 1769, 'A')
    expect(p1x2).toBe(1)  // France favorite

    const pScore = calcScorePoints(2, 1, 2, 1, 'A')
    expect(pScore).toBe(2)  // exact (1+0=1 goals each — no, 2+1=3 goals Cat A ≠ OU)
    // Actually 3 total goals, Cat A neither ≤1 nor ≥4 → 2pt exact only

    const pAdvance = calcAdvancePoints('France', 'France', 'R32', 'A')
    expect(pAdvance).toBe(2)  // R32 Cat A = 2pt

    expect(p1x2 + pScore + pAdvance).toBe(5)
  })

  // ── Scenario 4: Knockout — penalty shootout ────────────────────────────────
  it('QF: Argentina vs France — 2-2 FT, 3-3 ET, Argentina wins 4-2 on penalties', () => {
    const fixture = makeFixture('PEN', 'France', 'Argentina', 2, 2, 3, 3, 2, 4)
    const result = getKnockoutResult(fixture, 'France', 'Argentina')!

    // Score at 90 min must be 2-2
    expect(result.score90A).toBe(2)
    expect(result.score90B).toBe(2)
    expect(result.advanceTeam).toBe('Argentina')

    // User predicted draw (X) at 90 min and Argentina to advance
    const p1x2 = calc1X2Points('X', 2, 2, 1877, 1874, 'A')
    expect(p1x2).toBe(1)  // draw Cat A = 1pt

    const pAdvance = calcAdvancePoints('Argentina', 'Argentina', 'QF', 'A')
    expect(pAdvance).toBe(4)  // QF Cat A = 4pt
  })

  // ── Scenario 5: Upset prediction ──────────────────────────────────────────
  it('Group stage Cat D: Uruguay beats Spain 1-0 — user correctly predicted upset', () => {
    // Spain (FIFA ~1876) vs Uruguay (FIFA ~1673) — Spain is favorite → Cat D upset
    const p1x2 = calc1X2Points('2', 0, 1, 1876, 1673, 'D')
    expect(p1x2).toBe(4)  // underdog wins Cat D = 4pt
  })

  // ── Scenario 6: Red card prediction ───────────────────────────────────────
  it('Red card: predicted + occurred → 2pt', () => {
    expect(calcRedCardPoints(true, true)).toBe(2)
  })
  it('Red card: NOT predicted but occurred → 0pt (no penalty)', () => {
    expect(calcRedCardPoints(false, true)).toBe(0)
  })
  it('Red card: predicted but NOT occurred → 0pt (no penalty)', () => {
    expect(calcRedCardPoints(true, false)).toBe(0)
  })

  // ── Scenario 7: Max possible score in a single match ─────────────────────
  it('Cat D match: max score = 1X2(4) + exact(2) + OU(1) + red(2) + advance(4) = 13pt', () => {
    // Cat D: underdog wins, exact score ≤2 goals Cat C/D (under), red card, advance correct
    const p1x2 = calc1X2Points('2', 0, 1, 1800, 1300, 'D')  // underdog wins
    const pScore = calcScorePoints(0, 1, 0, 1, 'D')  // exact, 1 goal total ≤2 = under
    const pRed = calcRedCardPoints(true, true)
    const pAdv = calcAdvancePoints('TeamB', 'TeamB', 'R32', 'D')
    expect(p1x2).toBe(4)
    expect(pScore).toBe(3)  // 2 + 1 under
    expect(pRed).toBe(2)
    expect(pAdv).toBe(4)
    expect(p1x2 + pScore + pRed + pAdv).toBe(13)
  })

  // ── Scenario 8: Standings parsing end-to-end ──────────────────────────────
  it('Standings: full 12-group parse returns correct structure', () => {
    const makeGroup = (letter: string, teams: string[]) =>
      teams.map((name, i) => ({
        rank: i + 1, team: { id: i + 1, name },
        points: [9, 6, 3, 0][i], goalsDiff: [4, 1, -2, -3][i],
        group: `Group ${letter}`,
        all: { played: 3, goals: { for: [6, 4, 2, 1][i], against: [2, 3, 4, 4][i] } },
      }))

    const groups = 'ABCDEFGHIJKL'.split('').map(l =>
      makeGroup(l, [`Team1${l}`, `Team2${l}`, `Team3${l}`, `Team4${l}`])
    )

    const { groupQualifiers, best8Thirds } = parseStandings(groups, {})
    expect(Object.keys(groupQualifiers)).toHaveLength(12)
    expect(best8Thirds).toHaveLength(8)
    expect(groupQualifiers['A']).toEqual(['Team1A', 'Team2A', 'Team3A'])
  })

  // ── Scenario 9: Full user score with all components ───────────────────────
  it('Full user score: matches + groups + bonus + knockout', () => {
    const playedMatch = {
      id: 1, group: 'A' as const, round: 1 as const,
      teamA: 'France', teamB: 'Brazil',
      category: 'A' as const, fifaPointsA: 1877, fifaPointsB: 1761,
      resultA: 2, resultB: 1, hadRedCard: false, isPlayed: true,
    }

    const score = computeUserScore(
      'u1', 'Test',
      { 1: { matchId: 1, prediction1X2: '1', scoreA: 2, scoreB: 1, redCard: false } },
      { A: { group: 'A' as const, advancing: ['France', 'Brazil', 'Germany'] } },
      { q105: 'ברזיל', q106: 'ארגנטינה' },
      [playedMatch],
      { A: ['France', 'Brazil', 'Germany'] },
      { q105: 'ברזיל', q106: 'ארגנטינה' },
    )

    expect(score.matchPoints).toBe(3)     // 1X2(1) + exact(2)
    expect(score.groupPoints).toBe(6)     // all 3 exact positions
    expect(score.bonusPoints).toBe(26)    // Brazil champion(20) + runner-up(6)
    expect(score.redCardPoints).toBe(0)
    expect(score.total).toBe(35)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Edge cases
// ─────────────────────────────────────────────────────────────────────────────
describe('Edge cases', () => {

  it('0-0 draw in Cat B → 1pt for draw prediction + 3pt score (0 goals = under)', () => {
    const p1x2 = calc1X2Points('X', 0, 0, 1700, 1650, 'B')
    const pScore = calcScorePoints(0, 0, 0, 0, 'B')
    expect(p1x2).toBe(1)
    expect(pScore).toBe(3)  // exact + under (0 ≤1)
  })

  it('5-5 draw in Cat C → draw prediction + over bonus', () => {
    const p1x2 = calc1X2Points('X', 5, 5, 1750, 1500, 'C')
    const pScore = calcScorePoints(5, 5, 5, 5, 'C')
    expect(p1x2).toBe(2)   // draw Cat C = 2pt
    expect(pScore).toBe(3) // exact + over (10 goals ≥5)
  })

  it('AET match — 90min score differs from final, user predicted 90min correctly', () => {
    const fixture = makeFixture('AET', 'Spain', 'Germany', 1, 1, 2, 1)
    const result = getKnockoutResult(fixture, 'Spain', 'Germany')!
    expect(result.score90A).toBe(1)  // 90 min score, not ET
    expect(result.score90B).toBe(1)
    expect(result.advanceTeam).toBe('Spain')  // won in ET
  })

  it('Knockout advance — same team predicted in R32 gets points in all later rounds', () => {
    // User predicted France from R32 and they made it to the Final
    const rounds = ['R32', 'R16', 'QF', 'SF', 'F'] as const
    const expected = [2, 3, 4, 5, 5] // Cat A points
    rounds.forEach((round, i) => {
      expect(calcAdvancePoints('France', 'France', round, 'A')).toBe(expected[i])
    })
  })

  it('Penalty shootout — same score at FT and ET, only penalty determines winner', () => {
    // 1-1 FT, 1-1 ET (no ET goals), decided by penalties
    const fixture = makeFixture('PEN', 'Portugal', 'Spain', 1, 1, 1, 1, 5, 3)
    const result = getKnockoutResult(fixture, 'Portugal', 'Spain')!
    expect(result.score90A).toBe(1)
    expect(result.score90B).toBe(1)
    expect(result.advanceTeam).toBe('Portugal')
  })
})
