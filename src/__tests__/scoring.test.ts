import { describe, it, expect } from 'vitest'
import {
  calc1X2Points,
  calcScorePoints,
  calcOUPoints,
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
    ['R32', 'A', 1], ['R32', 'B', 2], ['R32', 'C', 3], ['R32', 'D', 3],
    ['R16', 'A', 2], ['R16', 'B', 3], ['R16', 'C', 4], ['R16', 'D', 4],
    ['QF',  'A', 3], ['QF',  'B', 4], ['QF',  'C', 5], ['QF',  'D', 5],
    ['SF',  'A', 4], ['SF',  'B', 5], ['SF',  'C', 6], ['SF',  'D', 6],
    ['3P',  'A', 2], ['3P',  'B', 3], ['3P',  'C', 4], ['3P',  'D', 4],
    ['F',   'A', 5], ['F',   'B', 6], ['F',   'C', 7], ['F',   'D', 7],
  ]
  cases.forEach(([round, cat, expected]) => {
    it(`${round} Cat ${cat} → ${expected}pt`, () => {
      expect(calcAdvancePoints('France', 'France', round, cat, 1200, 1500, 'France', 'Brazil')).toBe(expected)
    })
  })

  it('wrong prediction → 0pt', () => {
    expect(calcAdvancePoints('France', 'Brazil', 'QF', 'A', 1877, 1877, 'France', 'Brazil')).toBe(0)
  })
  it('empty prediction → 0pt', () => {
    expect(calcAdvancePoints('', 'Brazil', 'R32', 'B', 1877, 1700, 'France', 'Brazil')).toBe(0)
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

// ─────────────────────────────────────────────────────────────────────────────
// calcOUPoints — independent OU bonus for non-exact predictions
// Rules:
//   - Both predicted total AND actual total must share the same OU type
//   - Exact scores return 0 (OU already bundled in calcScorePoints)
//   - A/B: under = <2 goals, over = >3 goals
//   - C/D: under = <3 goals, over = >4 goals
//   - Points: group/R32/R16/3P = 1pt, QF/SF/F = 2pt
// ─────────────────────────────────────────────────────────────────────────────
describe('calcOUPoints', () => {

  // ── Exact score → 0 (avoid double-counting with calcScorePoints) ──────────
  it('exact score → 0pt (OU already counted in calcScorePoints)', () => {
    expect(calcOUPoints(1, 0, 1, 0, 'A')).toBe(0)
  })
  it('exact score 0-0 Cat B → 0pt', () => {
    expect(calcOUPoints(0, 0, 0, 0, 'B')).toBe(0)
  })

  // ── Cat A/B: under (<2 goals) ─────────────────────────────────────────────
  it('pred 0-0 (under A), actual 1-0 (under A), non-exact → 1pt', () => {
    expect(calcOUPoints(0, 0, 1, 0, 'A')).toBe(1)
  })
  it('pred 0-0 (under B), actual 0-1 (under B), non-exact → 1pt', () => {
    expect(calcOUPoints(0, 0, 0, 1, 'B')).toBe(1)
  })
  it('pred 1-0 (under A), actual 0-0 (under A) → 1pt', () => {
    expect(calcOUPoints(1, 0, 0, 0, 'A')).toBe(1)
  })

  // ── Cat A/B: over (>3 goals) ──────────────────────────────────────────────
  it('pred 3-1 (over A), actual 4-0 (over A), non-exact → 1pt', () => {
    expect(calcOUPoints(3, 1, 4, 0, 'A')).toBe(1)
  })
  it('pred 2-3 (over A), actual 5-0 (over A), non-exact → 1pt', () => {
    expect(calcOUPoints(2, 3, 5, 0, 'A')).toBe(1)
  })

  // ── Cat C/D: under (<3 goals) ─────────────────────────────────────────────
  it('pred 0-2 (under C), actual 1-0 (under C), non-exact → 1pt', () => {
    expect(calcOUPoints(0, 2, 1, 0, 'C')).toBe(1)
  })
  it('pred 1-0 (under D), actual 0-1 (under D), non-exact → 1pt', () => {
    expect(calcOUPoints(1, 0, 0, 1, 'D')).toBe(1)
  })

  // ── Cat C/D: over (>4 goals) ──────────────────────────────────────────────
  it('pred 3-2 (over D, 5 goals), actual 4-2 (over D, 6 goals), non-exact → 1pt', () => {
    expect(calcOUPoints(3, 2, 4, 2, 'D')).toBe(1)
  })
  it('pred 4-1 (over C), actual 5-0 (over C), non-exact → 1pt', () => {
    expect(calcOUPoints(4, 1, 5, 0, 'C')).toBe(1)
  })

  // ── Neither (between thresholds) → 0pt ───────────────────────────────────
  it('Cat A: pred 2-0 (neither), actual 2-1 (neither) → 0pt', () => {
    expect(calcOUPoints(2, 0, 2, 1, 'A')).toBe(0)  // 2 and 3 goals = neither
  })
  it('Cat A: pred 3-0 (neither), actual 3-1 (neither) → 0pt', () => {
    expect(calcOUPoints(3, 0, 3, 1, 'A')).toBe(0)  // 3 and 4 goals = neither
  })
  it('Cat C: pred 3-0 (neither), actual 4-0 (neither) → 0pt', () => {
    expect(calcOUPoints(3, 0, 4, 0, 'C')).toBe(0)  // 3 and 4 goals = neither for C/D
  })

  // ── Type mismatch → 0pt ───────────────────────────────────────────────────
  it('pred under A, actual over A → 0pt', () => {
    expect(calcOUPoints(0, 0, 2, 3, 'A')).toBe(0)  // pred=0 under, actual=5 over
  })
  it('pred over A, actual under A → 0pt', () => {
    expect(calcOUPoints(3, 2, 0, 1, 'A')).toBe(0)
  })
  it('pred neither, actual under → 0pt', () => {
    expect(calcOUPoints(2, 1, 0, 0, 'A')).toBe(0)  // pred=3 neither, actual=0 under
  })
  it('pred under, actual neither → 0pt', () => {
    expect(calcOUPoints(0, 0, 1, 1, 'A')).toBe(0)  // pred=0 under, actual=2 neither
  })

  // ── Knockout rounds: higher OU points ─────────────────────────────────────
  it('R32: non-exact under Cat A → 1pt', () => {
    expect(calcOUPoints(0, 0, 1, 0, 'A', 'R32')).toBe(1)
  })
  it('R16: non-exact under Cat B → 1pt', () => {
    expect(calcOUPoints(0, 0, 0, 1, 'B', 'R16')).toBe(1)
  })
  it('QF: non-exact under Cat A → 2pt', () => {
    expect(calcOUPoints(0, 0, 0, 1, 'A', 'QF')).toBe(2)
  })
  it('SF: non-exact over Cat A → 2pt', () => {
    expect(calcOUPoints(3, 2, 2, 3, 'A', 'SF')).toBe(2)
  })
  it('F: non-exact under Cat A → 2pt', () => {
    expect(calcOUPoints(0, 0, 1, 0, 'A', 'F')).toBe(2)
  })
  it('3P: non-exact under Cat C → 1pt', () => {
    expect(calcOUPoints(1, 0, 0, 2, 'C', '3P')).toBe(1)  // pred=1 under C, actual=2 under C
  })

  // ── No round (group stage) ────────────────────────────────────────────────
  it('group stage (no round): non-exact under → 1pt', () => {
    expect(calcOUPoints(0, 0, 1, 0, 'A', undefined)).toBe(1)
  })
  it('group stage (no round): non-exact over Cat D → 1pt', () => {
    expect(calcOUPoints(3, 2, 4, 2, 'D', undefined)).toBe(1)
  })
})
