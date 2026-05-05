import { describe, it, expect } from 'vitest'
import {
  calc1X2Points,
  calcScorePoints,
  calcOverUnder,
  calcRedCardPoints,
  calcGroupPoints,
  calcBonusPoints,
  calcAdvancePoints,
  computeUserScore,
} from '../scoring'
import type { Category, KnockoutRound } from '../types'

// ─────────────────────────────────────────────────────────────────────────────
// calc1X2Points
// ─────────────────────────────────────────────────────────────────────────────
describe('calc1X2Points', () => {
  // Favorite wins → always 1pt regardless of category
  it('favorite wins — Cat A → 1pt', () => {
    expect(calc1X2Points('1', 2, 0, 1800, 1400, 'A')).toBe(1)
  })
  it('favorite wins — Cat D → still 1pt', () => {
    expect(calc1X2Points('1', 3, 1, 1800, 1300, 'D')).toBe(1)
  })

  // Underdog wins → scales with category
  it('underdog wins — Cat A → 1pt', () => {
    expect(calc1X2Points('2', 0, 1, 1800, 1400, 'A')).toBe(1)
  })
  it('underdog wins — Cat B → 2pt', () => {
    expect(calc1X2Points('2', 0, 1, 1700, 1600, 'B')).toBe(2)
  })
  it('underdog wins — Cat C → 3pt', () => {
    expect(calc1X2Points('2', 0, 1, 1750, 1500, 'C')).toBe(3)
  })
  it('underdog wins — Cat D → 4pt', () => {
    expect(calc1X2Points('2', 0, 1, 1800, 1300, 'D')).toBe(4)
  })

  // Draw → scales with category
  it('draw — Cat A → 1pt', () => {
    expect(calc1X2Points('X', 1, 1, 1750, 1600, 'A')).toBe(1)
  })
  it('draw — Cat B → 1pt', () => {
    expect(calc1X2Points('X', 1, 1, 1750, 1600, 'B')).toBe(1)
  })
  it('draw — Cat C → 2pt', () => {
    expect(calc1X2Points('X', 1, 1, 1750, 1500, 'C')).toBe(2)
  })
  it('draw — Cat D → 3pt', () => {
    expect(calc1X2Points('X', 1, 1, 1800, 1300, 'D')).toBe(3)
  })

  // Wrong prediction → 0
  it('wrong prediction → 0pt', () => {
    expect(calc1X2Points('1', 0, 2, 1800, 1400, 'A')).toBe(0)
  })
  it('predicted draw but team A won → 0pt', () => {
    expect(calc1X2Points('X', 2, 0, 1800, 1400, 'A')).toBe(0)
  })

  // Edge: equal FIFA points (teamA is "favorite")
  it('equal FIFA points — teamA wins, predicted 1 → 1pt (favorite)', () => {
    expect(calc1X2Points('1', 1, 0, 1650, 1650, 'B')).toBe(1)
  })
  it('equal FIFA points — teamB wins, predicted 2 → underdog Cat B → 2pt', () => {
    expect(calc1X2Points('2', 0, 1, 1650, 1650, 'B')).toBe(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// calcOverUnder
// ─────────────────────────────────────────────────────────────────────────────
describe('calcOverUnder', () => {
  it('Cat A/B: 0 goals → under ✓', () => expect(calcOverUnder(0, 'A')).toBe(true))
  it('Cat A/B: 1 goal → under ✓', () => expect(calcOverUnder(1, 'B')).toBe(true))
  it('Cat A/B: 2 goals → neither ✗', () => expect(calcOverUnder(2, 'A')).toBe(false))
  it('Cat A/B: 3 goals → neither ✗', () => expect(calcOverUnder(3, 'B')).toBe(false))
  it('Cat A/B: 4 goals → over ✓', () => expect(calcOverUnder(4, 'A')).toBe(true))
  it('Cat A/B: 5 goals → over ✓', () => expect(calcOverUnder(5, 'B')).toBe(true))

  it('Cat C/D: 2 goals → under ✓', () => expect(calcOverUnder(2, 'C')).toBe(true))
  it('Cat C/D: 3 goals → neither ✗', () => expect(calcOverUnder(3, 'D')).toBe(false))
  it('Cat C/D: 4 goals → neither ✗', () => expect(calcOverUnder(4, 'C')).toBe(false))
  it('Cat C/D: 5 goals → over ✓', () => expect(calcOverUnder(5, 'D')).toBe(true))
})

// ─────────────────────────────────────────────────────────────────────────────
// calcScorePoints
// ─────────────────────────────────────────────────────────────────────────────
describe('calcScorePoints', () => {
  it('exact score — no over/under → 2pt', () => {
    expect(calcScorePoints(2, 1, 2, 1, 'A')).toBe(2)
  })
  it('exact score + under bonus (Cat A, 1-0) → 3pt', () => {
    expect(calcScorePoints(1, 0, 1, 0, 'A')).toBe(3)
  })
  it('exact score + over bonus (Cat A, 3-1 = 4 goals) → 3pt', () => {
    expect(calcScorePoints(3, 1, 3, 1, 'A')).toBe(3)
  })
  it('exact score + under bonus (Cat C, 1-0) → 3pt', () => {
    expect(calcScorePoints(1, 0, 1, 0, 'C')).toBe(3)
  })
  it('correct margin (2-1 pred, 3-2 actual, diff=1) → 1pt', () => {
    expect(calcScorePoints(2, 1, 3, 2, 'B')).toBe(1)
  })
  it('correct margin draw (0-0 pred, 1-1 actual) → 1pt', () => {
    expect(calcScorePoints(0, 0, 1, 1, 'C')).toBe(1)
  })
  it('wrong score → 0pt', () => {
    expect(calcScorePoints(2, 0, 1, 2, 'A')).toBe(0)
  })
  it('correct 1X2 but wrong margin → 0pt', () => {
    expect(calcScorePoints(3, 0, 1, 0, 'A')).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// calcRedCardPoints
// ─────────────────────────────────────────────────────────────────────────────
describe('calcRedCardPoints', () => {
  it('predicted red, had red → 2pt', () => {
    expect(calcRedCardPoints(true, true)).toBe(2)
  })
  it('predicted red, no red → 0pt', () => {
    expect(calcRedCardPoints(true, false)).toBe(0)
  })
  it('no prediction, had red → 0pt', () => {
    expect(calcRedCardPoints(false, true)).toBe(0)
  })
  it('no prediction, no red → 0pt', () => {
    expect(calcRedCardPoints(false, false)).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// calcGroupPoints
// ─────────────────────────────────────────────────────────────────────────────
describe('calcGroupPoints', () => {
  const actual: [string, string, string] = ['France', 'Brazil', 'Argentina']

  it('all three exact positions → 6pt', () => {
    expect(calcGroupPoints(['France', 'Brazil', 'Argentina'], actual)).toBe(6)
  })
  it('correct teams, all wrong positions → 3pt', () => {
    expect(calcGroupPoints(['Brazil', 'Argentina', 'France'], actual)).toBe(3)
  })
  it('one correct position, one correct wrong pos, one wrong → 3pt', () => {
    expect(calcGroupPoints(['France', 'Argentina', 'Germany'], actual)).toBe(3)
  })
  it('two exact, one wrong → 4pt', () => {
    expect(calcGroupPoints(['France', 'Brazil', 'Germany'], actual)).toBe(4)
  })
  it('all wrong teams → 0pt', () => {
    expect(calcGroupPoints(['Germany', 'Spain', 'Portugal'], actual)).toBe(0)
  })
  it('empty predictions → 0pt', () => {
    expect(calcGroupPoints(['', '', ''], actual)).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// calcBonusPoints
// ─────────────────────────────────────────────────────────────────────────────
describe('calcBonusPoints', () => {
  it('world champion France → 17pt (reduced)', () => {
    expect(calcBonusPoints({ q105: 'צרפת' }, { q105: 'צרפת' })).toBe(17)
  })
  it('world champion Spain → 17pt (reduced)', () => {
    expect(calcBonusPoints({ q105: 'ספרד' }, { q105: 'ספרד' })).toBe(17)
  })
  it('world champion England → 17pt (reduced)', () => {
    expect(calcBonusPoints({ q105: 'אנגליה' }, { q105: 'אנגליה' })).toBe(17)
  })
  it('world champion Brazil → 20pt (full)', () => {
    expect(calcBonusPoints({ q105: 'ברזיל' }, { q105: 'ברזיל' })).toBe(20)
  })
  it('runner-up correct → 6pt', () => {
    expect(calcBonusPoints({ q106: 'ארגנטינה' }, { q106: 'ארגנטינה' })).toBe(6)
  })
  it('top scorer correct → 8pt', () => {
    expect(calcBonusPoints({ q108: 'מבאפה' }, { q108: 'מבאפה' })).toBe(8)
  })
  it('case-insensitive comparison', () => {
    expect(calcBonusPoints({ q108: 'Mbappe' }, { q108: 'mbappe' })).toBe(8)
  })
  it('wrong answer → 0pt', () => {
    expect(calcBonusPoints({ q105: 'גרמניה' }, { q105: 'ברזיל' })).toBe(0)
  })
  it('missing prediction → 0pt', () => {
    expect(calcBonusPoints({}, { q105: 'ברזיל' })).toBe(0)
  })
  it('multiple correct answers → sum', () => {
    expect(calcBonusPoints(
      { q105: 'ברזיל', q106: 'ארגנטינה', q108: 'מבאפה' },
      { q105: 'ברזיל', q106: 'ארגנטינה', q108: 'מבאפה' }
    )).toBe(20 + 6 + 8)  // 34
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// calcAdvancePoints
// ─────────────────────────────────────────────────────────────────────────────
describe('calcAdvancePoints', () => {
  const cases: [KnockoutRound, Category, number][] = [
    ['R32', 'A', 2], ['R32', 'B', 3], ['R32', 'C', 4], ['R32', 'D', 4],
    ['R16', 'A', 3], ['R16', 'B', 4], ['R16', 'C', 5], ['R16', 'D', 5],
    ['QF',  'A', 4], ['QF',  'B', 5], ['QF',  'C', 6], ['QF',  'D', 6],
    ['SF',  'A', 5], ['SF',  'B', 6], ['SF',  'C', 7], ['SF',  'D', 7],
    ['3P',  'A', 4], ['3P',  'B', 5], ['3P',  'C', 6], ['3P',  'D', 6],
    ['F',   'A', 5], ['F',   'B', 6], ['F',   'C', 7], ['F',   'D', 7],
  ]
  cases.forEach(([round, cat, expected]) => {
    it(`${round} Cat ${cat} → ${expected}pt`, () => {
      expect(calcAdvancePoints('France', 'France', round, cat)).toBe(expected)
    })
  })

  it('wrong prediction → 0pt', () => {
    expect(calcAdvancePoints('France', 'Brazil', 'QF', 'A')).toBe(0)
  })
  it('empty prediction → 0pt', () => {
    expect(calcAdvancePoints('', 'Brazil', 'R32', 'B')).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// computeUserScore — integration
// ─────────────────────────────────────────────────────────────────────────────
describe('computeUserScore', () => {
  const match = {
    id: 1, group: 'A' as const, round: 1 as const,
    teamA: 'France', teamB: 'Brazil',
    category: 'A' as Category,
    fifaPointsA: 1877, fifaPointsB: 1761,
    resultA: 2, resultB: 1, hadRedCard: true, isPlayed: true,
  }

  it('correct 1X2 + exact score + red card → correct total', () => {
    const score = computeUserScore(
      'u1', 'Test User',
      { 1: { matchId: 1, prediction1X2: '1', scoreA: 2, scoreB: 1, redCard: true } },
      {}, {}, [match], {}, {}
    )
    // 1X2: 1pt (favorite Cat A) + exact: 2pt + under(3 goals Cat A): 1pt + red: 2pt = 6
    expect(score.matchPoints).toBe(3)  // 1X2 + exact + under (no red in matchPoints)
    expect(score.redCardPoints).toBe(2)
    expect(score.total).toBe(5)
  })

  it('correct 1X2 only → 1pt', () => {
    const score = computeUserScore(
      'u1', 'Test User',
      { 1: { matchId: 1, prediction1X2: '1', scoreA: 0, scoreB: 0, redCard: false } },
      {}, {}, [match], {}, {}
    )
    expect(score.matchPoints).toBe(1)
    expect(score.redCardPoints).toBe(0)
  })

  it('unplayed match → 0pt', () => {
    const unplayed = { ...match, isPlayed: false, resultA: undefined, resultB: undefined }
    const score = computeUserScore(
      'u1', 'Test',
      { 1: { matchId: 1, prediction1X2: '1', scoreA: 2, scoreB: 1, redCard: false } },
      {}, {}, [unplayed as any], {}, {}
    )
    expect(score.total).toBe(0)
  })

  it('knockout advance points are counted', async () => {
    const { KNOCKOUT_MATCHES } = await import('../data/matches')
    const km = { ...KNOCKOUT_MATCHES[0], teamA: 'France', teamB: 'Brazil', isPlayed: true, resultA: 2, resultB: 1, advanceTeam: 'France' }
    const score = computeUserScore(
      'u1', 'Test',
      {}, {}, {},
      [], {}, {},
      { 73: { matchId: 73, prediction1X2: '1', scoreA: 2, scoreB: 1, advance: 'France' } },
      [km]
    )
    expect(score.knockoutPoints).toBeGreaterThan(0)
  })

  it('group points are counted', () => {
    const score = computeUserScore(
      'u1', 'Test',
      {}, {}, {},
      [], { A: ['France', 'Brazil', 'Argentina'] }, {},
      undefined, undefined
    )
    // No predictions → 0
    expect(score.groupPoints).toBe(0)
  })
})
