import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  processGroupMatches,
  processKnockoutMatches,
  applyApiFootballFixtures,
  applyRedCards,
  processStandings,
} from '../utils/syncLogic'
import type { Match } from '../types'
import type { ApiMatch } from '../services/wc2026api'
import type { ApiFootballFixture, ApiFootballStanding } from '../services/apifootball'

// ── Shared test data ─────────────────────────────────────────────────────────
const ALIASES: Record<string, string> = {
  'korea republic': 'south korea',
  "côte d'ivoire": 'ivory coast',
}

const EN_TO_HE: Record<string, string> = {
  france: 'צרפת', brazil: 'ברזיל', argentina: 'ארגנטינה',
  germany: 'גרמניה', spain: 'ספרד', england: 'אנגליה',
  mexico: 'מקסיקו', 'south africa': 'דרום אפריקה',
  morocco: 'מרוקו', portugal: 'פורטוגל',
}

const TEAM_EN: Record<string, string> = {
  'צרפת': 'France', 'ברזיל': 'Brazil', 'ארגנטינה': 'Argentina',
  'גרמניה': 'Germany', 'ספרד': 'Spain', 'אנגליה': 'England',
  'מקסיקו': 'Mexico', 'דרום אפריקה': 'South Africa',
  'מרוקו': 'Morocco', 'פורטוגל': 'Portugal',
}

const makeOurMatch = (id: number, teamA: string, teamB: string): Match => ({
  id, group: 'A', round: 1, teamA, teamB,
  category: 'A', fifaPointsA: 1877, fifaPointsB: 1761,
})

const makeApiMatch = (home: string, away: string, status: string, hScore: number | null, aScore: number | null, kickoff = '2026-06-11T19:00:00.000Z'): ApiMatch => ({
  id: 1, match_number: 1, round: 'group', group_name: 'A',
  home_team: home, away_team: away, stadium: 'Stadium',
  kickoff_utc: kickoff, status: status as any,
  home_score: hScore, away_score: aScore,
})

const makeFixture = (status: string, homeName: string, awayName: string, ftH: number, ftA: number, etH: number | null = null, etA: number | null = null, penH: number | null = null, penA: number | null = null): ApiFootballFixture => ({
  fixture: { id: 999, status: { short: status, elapsed: 90 } },
  teams: { home: { name: homeName }, away: { name: awayName } },
  score: {
    halftime: { home: 0, away: 0 },
    fulltime: { home: ftH, away: ftA },
    extratime: { home: etH, away: etA },
    penalty: { home: penH, away: penA },
  },
})

// ─────────────────────────────────────────────────────────────────────────────
// processGroupMatches
// ─────────────────────────────────────────────────────────────────────────────
describe('processGroupMatches', () => {
  const ourMatches = [makeOurMatch(1, 'צרפת', 'ברזיל')]
  const currentMatches: Record<number, Match> = {}

  it('completed match updates resultA, resultB, isPlayed', () => {
    const api = [makeApiMatch('France', 'Brazil', 'completed', 2, 1)]
    const { updatedMatches, results } = processGroupMatches(api, currentMatches, ourMatches, ALIASES, EN_TO_HE)
    expect(results).toBe(1)
    expect(updatedMatches[1].resultA).toBe(2)
    expect(updatedMatches[1].resultB).toBe(1)
    expect(updatedMatches[1].isPlayed).toBe(true)
  })

  it('reversed API order — scores are correctly mapped', () => {
    // API has Brazil as home, France as away, but our match has France=teamA
    const api = [makeApiMatch('Brazil', 'France', 'completed', 1, 2)]
    const { updatedMatches } = processGroupMatches(api, currentMatches, ourMatches, ALIASES, EN_TO_HE)
    expect(updatedMatches[1].resultA).toBe(2)  // France (teamA) scored 2
    expect(updatedMatches[1].resultB).toBe(1)  // Brazil (teamB) scored 1
  })

  it('scheduled match — no result update', () => {
    const api = [makeApiMatch('France', 'Brazil', 'scheduled', null, null)]
    const { updatedMatches, results } = processGroupMatches(api, currentMatches, ourMatches, ALIASES, EN_TO_HE)
    expect(results).toBe(0)
    expect(updatedMatches[1]?.isPlayed).toBeFalsy()
  })

  it('unknown team — logs warning, skips', () => {
    const api = [makeApiMatch('UnknownTeam', 'Brazil', 'completed', 1, 0)]
    const { updatedMatches, log } = processGroupMatches(api, currentMatches, ourMatches, ALIASES, EN_TO_HE)
    expect(log.some(l => l.includes('⚠️'))).toBe(true)
    expect(Object.keys(updatedMatches)).toHaveLength(0)
  })

  it('alias resolution — Korea Republic → South Korea', () => {
    const ourM = [makeOurMatch(5, 'קוריאה הדרומית', 'ברזיל')]
    const localEnToHe = { ...EN_TO_HE, 'south korea': 'קוריאה הדרומית' }
    const api = [makeApiMatch('Korea Republic', 'Brazil', 'completed', 0, 2)]
    const { updatedMatches, results } = processGroupMatches(api, currentMatches, ourM, ALIASES, localEnToHe)
    expect(results).toBe(1)
    expect(updatedMatches[5].resultA).toBe(0)
    expect(updatedMatches[5].resultB).toBe(2)
  })

  it('multiple matches — all processed', () => {
    const ourM = [makeOurMatch(1, 'צרפת', 'ברזיל'), makeOurMatch(2, 'ספרד', 'גרמניה')]
    const api = [
      makeApiMatch('France', 'Brazil', 'completed', 2, 1),
      makeApiMatch('Spain', 'Germany', 'completed', 1, 0),
    ]
    const { results } = processGroupMatches(api, currentMatches, ourM, ALIASES, EN_TO_HE)
    expect(results).toBe(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// processKnockoutMatches
// ─────────────────────────────────────────────────────────────────────────────
describe('processKnockoutMatches', () => {
  const currentKnockout = {
    73: { id: 73, round: 'R32', teamA: 'צרפת', teamB: 'ברזיל', category: 'A' }
  }

  it('completed R32 match — sets result and advanceTeam', () => {
    const api = [{ ...makeApiMatch('France', 'Brazil', 'completed', 2, 1), round: 'knockout' as const }]
    const { updatedKnockout, updated } = processKnockoutMatches(api, currentKnockout, ALIASES, EN_TO_HE)
    expect(updated).toBe(1)
    expect(updatedKnockout[73].resultA).toBe(2)
    expect(updatedKnockout[73].resultB).toBe(1)
    expect(updatedKnockout[73].isPlayed).toBe(true)
    expect(updatedKnockout[73].advanceTeam).toBe('צרפת')
  })

  it('draw at 90 min — counts as penalty match, no advanceTeam set', () => {
    const api = [{ ...makeApiMatch('France', 'Brazil', 'completed', 1, 1), round: 'knockout' as const }]
    const { penalties, updatedKnockout } = processKnockoutMatches(api, currentKnockout, ALIASES, EN_TO_HE)
    expect(penalties).toBe(1)
    expect(updatedKnockout[73].advanceTeam).toBeUndefined()
  })

  it('manualScore flag — skips update', () => {
    const koWithManual = { 73: { ...currentKnockout[73], manualScore: true, resultA: 1, resultB: 0 } }
    const api = [{ ...makeApiMatch('France', 'Brazil', 'completed', 3, 2), round: 'knockout' as const }]
    const { updatedKnockout } = processKnockoutMatches(api, koWithManual, ALIASES, EN_TO_HE)
    expect(updatedKnockout[73].resultA).toBe(1)  // not overwritten
  })

  it('away team wins — advanceTeam is teamB', () => {
    const api = [{ ...makeApiMatch('France', 'Brazil', 'completed', 0, 2), round: 'knockout' as const }]
    const { updatedKnockout } = processKnockoutMatches(api, currentKnockout, ALIASES, EN_TO_HE)
    expect(updatedKnockout[73].advanceTeam).toBe('ברזיל')
  })

  it('reversed API order — advanceTeam still correct', () => {
    const api = [{ ...makeApiMatch('Brazil', 'France', 'completed', 0, 2), round: 'knockout' as const }]
    const { updatedKnockout } = processKnockoutMatches(api, currentKnockout, ALIASES, EN_TO_HE)
    // France (teamA) scored 2 even though API has them as away
    expect(updatedKnockout[73].resultA).toBe(2)
    expect(updatedKnockout[73].advanceTeam).toBe('צרפת')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// applyApiFootballFixtures
// ─────────────────────────────────────────────────────────────────────────────
describe('applyApiFootballFixtures', () => {
  const ourMatch = makeOurMatch(1, 'צרפת', 'ברזיל')
  const matchPlayed: Record<number, Match> = {
    1: { ...ourMatch, resultA: 3, resultB: 2, isPlayed: true }  // initial from wc2026api (may include ET)
  }
  const knockoutPlayed = {
    73: { id: 73, round: 'R32', teamA: 'ספרד', teamB: 'אנגליה', isPlayed: true }
  }

  it('corrects 90-min score from API-Football fulltime', () => {
    // wc2026api returned 3-2 (ET included), API-Football fulltime says 1-1
    const fixtures = [makeFixture('AET', 'France', 'Brazil', 1, 1, 2, 1)]
    const { updatedMatches, scoresFixed } = applyApiFootballFixtures(fixtures, matchPlayed, {}, [ourMatch], TEAM_EN)
    expect(scoresFixed).toBe(1)
    expect(updatedMatches[1].resultA).toBe(1)  // 90-min score
    expect(updatedMatches[1].resultB).toBe(1)
  })

  it('knockout: AET — sets 90-min score and advanceTeam', () => {
    const fixtures = [makeFixture('AET', 'Spain', 'England', 1, 1, 2, 1)]
    const { updatedKnockout, advanceFixed } = applyApiFootballFixtures(fixtures, {}, knockoutPlayed, [], TEAM_EN)
    expect(advanceFixed).toBe(1)
    expect(updatedKnockout[73].resultA).toBe(1)
    expect(updatedKnockout[73].advanceTeam).toBe('ספרד')
  })

  it('knockout: PEN — advanceTeam from penalty result', () => {
    const fixtures = [makeFixture('PEN', 'Spain', 'England', 1, 1, 1, 1, 5, 3)]
    const { updatedKnockout } = applyApiFootballFixtures(fixtures, {}, knockoutPlayed, [], TEAM_EN)
    expect(updatedKnockout[73].advanceTeam).toBe('ספרד')  // Spain won 5-3 on pens
  })

  it('FT match — no fixture found for unplayed match', () => {
    const unplayed: Record<number, Match> = { 1: { ...ourMatch, isPlayed: false } }
    const fixtures = [makeFixture('FT', 'France', 'Brazil', 2, 1)]
    const { scoresFixed } = applyApiFootballFixtures(fixtures, unplayed, {}, [ourMatch], TEAM_EN)
    expect(scoresFixed).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// applyRedCards
// ─────────────────────────────────────────────────────────────────────────────
describe('applyRedCards', () => {
  const matches: Record<number, Match> = {
    1: makeOurMatch(1, 'צרפת', 'ברזיל'),
  }
  const knockout = {
    73: { id: 73, teamA: 'ספרד', teamB: 'אנגליה' }
  }

  it('sets hadRedCard=true on group match', () => {
    const { updatedMatches } = applyRedCards(1, false, true, matches, knockout)
    expect(updatedMatches[1].hadRedCard).toBe(true)
  })

  it('sets hadRedCard=false on group match', () => {
    const { updatedMatches } = applyRedCards(1, false, false, { ...matches, 1: { ...matches[1], hadRedCard: true } }, knockout)
    expect(updatedMatches[1].hadRedCard).toBe(false)
  })

  it('sets hadRedCard on knockout match', () => {
    const { updatedKnockout } = applyRedCards(73, true, true, matches, knockout)
    expect(updatedKnockout[73].hadRedCard).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// processStandings
// ─────────────────────────────────────────────────────────────────────────────
describe('processStandings', () => {
  const makeStanding = (rank: number, name: string, pts: number, gd: number, gf: number, group: string): ApiFootballStanding => ({
    rank, team: { id: rank, name }, points: pts, goalsDiff: gd, group: `Group ${group}`,
    all: { played: 3, goals: { for: gf, against: gf - gd } },
  })

  const enToHe = { 'france': 'צרפת', 'brazil': 'ברזיל', 'argentina': 'ארגנטינה', 'germany': 'גרמניה' }

  const groupA = [
    makeStanding(1, 'France', 9, 4, 6, 'A'),
    makeStanding(2, 'Brazil', 6, 2, 4, 'A'),
    makeStanding(3, 'Argentina', 3, -1, 2, 'A'),
    makeStanding(4, 'Germany', 0, -5, 0, 'A'),
  ]

  it('returns qualifiers for each group', () => {
    const { groupQualifiers } = processStandings([groupA], enToHe)
    expect(groupQualifiers['A']).toEqual(['צרפת', 'ברזיל', 'ארגנטינה'])
  })

  it('empty standings → empty result with log', () => {
    const { groupQualifiers, log } = processStandings([], enToHe)
    expect(Object.keys(groupQualifiers)).toHaveLength(0)
    expect(log.length).toBeGreaterThan(0)
  })

  it('12 groups — best 8 third place selected', () => {
    const groups = 'ABCDEFGHIJKL'.split('').map((g, i) => [
      makeStanding(1, `T1${g}`, 9, 5, 7, g),
      makeStanding(2, `T2${g}`, 6, 2, 4, g),
      makeStanding(3, `T3${g}`, 3 - (i % 3), i, 3, g),
      makeStanding(4, `T4${g}`, 0, -7, 0, g),
    ])
    const { best8 } = processStandings(groups, {})
    expect(best8).toHaveLength(8)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Full end-to-end flow simulation
// ─────────────────────────────────────────────────────────────────────────────
describe('Full sync flow — end to end', () => {
  it('group stage: 3 matches sync → scores + knockout auto-advance', () => {
    const ourMatches = [
      makeOurMatch(1, 'צרפת', 'ברזיל'),
      makeOurMatch(2, 'ספרד', 'גרמניה'),
      makeOurMatch(3, 'ארגנטינה', 'פורטוגל'),
    ]
    const apiMatches = [
      makeApiMatch('France', 'Brazil', 'completed', 2, 1),
      makeApiMatch('Spain', 'Germany', 'completed', 0, 0),
      makeApiMatch('Portugal', 'Argentina', 'completed', 0, 2),  // reversed
    ]
    const { updatedMatches, results } = processGroupMatches(apiMatches, {}, ourMatches, ALIASES, EN_TO_HE)

    expect(results).toBe(3)
    expect(updatedMatches[1].resultA).toBe(2)  // France
    expect(updatedMatches[2].resultA).toBe(0)  // Spain
    expect(updatedMatches[2].resultB).toBe(0)  // Germany
    expect(updatedMatches[3].resultA).toBe(2)  // Argentina (was away in API but is teamA for us)
    expect(updatedMatches[3].resultB).toBe(0)  // Portugal
  })

  it('knockout: FT → AET → PEN chain correctly determines winner', () => {
    const knockout = {
      73: { id: 73, round: 'R32', teamA: 'ספרד', teamB: 'פורטוגל', isPlayed: true }
    }

    // Scenario: Spain vs Portugal, goes to penalties, Portugal wins
    const fixtures = [makeFixture('PEN', 'Spain', 'Portugal', 1, 1, 1, 1, 3, 5)]
    const { updatedKnockout } = applyApiFootballFixtures(fixtures, {}, knockout, [], TEAM_EN)

    expect(updatedKnockout[73].resultA).toBe(1)   // 90-min score
    expect(updatedKnockout[73].resultB).toBe(1)
    expect(updatedKnockout[73].advanceTeam).toBe('פורטוגל')  // won 5-3 on pens
  })

  it('sync preserves manually set scores', () => {
    const knockout = {
      73: { id: 73, round: 'QF', teamA: 'ספרד', teamB: 'פורטוגל', isPlayed: true, manualScore: true, resultA: 1, resultB: 0, advanceTeam: 'ספרד' }
    }
    const apiMatches = [{ ...makeApiMatch('Spain', 'Portugal', 'completed', 3, 2), round: 'knockout' as const }]
    const { updatedKnockout } = processKnockoutMatches(apiMatches, knockout, ALIASES, EN_TO_HE)

    expect(updatedKnockout[73].resultA).toBe(1)  // NOT overwritten
    expect(updatedKnockout[73].advanceTeam).toBe('ספרד')  // NOT overwritten
  })

  it('red cards correctly tracked per match', () => {
    const matches: Record<number, Match> = {
      1: { ...makeOurMatch(1, 'צרפת', 'ברזיל'), isPlayed: true },
      2: { ...makeOurMatch(2, 'ספרד', 'גרמניה'), isPlayed: true },
    }
    // Match 1 had red card, match 2 did not
    let m = applyRedCards(1, false, true, matches, {}).updatedMatches
    m = applyRedCards(2, false, false, m, {}).updatedMatches

    expect(m[1].hadRedCard).toBe(true)
    expect(m[2].hadRedCard).toBe(false)
  })
})
