import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  getKnockoutResult,
  parseStandings,
  type ApiFootballFixture,
  type ApiFootballStanding,
} from '../services/apifootball'

// ─────────────────────────────────────────────────────────────────────────────
// Mock fixtures
// ─────────────────────────────────────────────────────────────────────────────
const makeFixture = (
  status: string,
  homeName: string, awayName: string,
  ftH: number, ftA: number,
  etH: number | null = null, etA: number | null = null,
  penH: number | null = null, penA: number | null = null
): ApiFootballFixture => ({
  fixture: { id: 1, status: { short: status, elapsed: 90 } },
  teams: { home: { name: homeName }, away: { name: awayName } },
  score: {
    halftime:  { home: Math.floor(ftH / 2), away: Math.floor(ftA / 2) },
    fulltime:  { home: ftH, away: ftA },
    extratime: { home: etH, away: etA },
    penalty:   { home: penH, away: penA },
  },
})

// ─────────────────────────────────────────────────────────────────────────────
// getKnockoutResult
// ─────────────────────────────────────────────────────────────────────────────
describe('getKnockoutResult', () => {

  // ── Normal wins ────────────────────────────────────────────────────────────
  it('FT win — home team wins, teamA=home → correct score and winner', () => {
    const f = makeFixture('FT', 'France', 'Brazil', 2, 1)
    const r = getKnockoutResult(f, 'France', 'Brazil')!
    expect(r.score90A).toBe(2)
    expect(r.score90B).toBe(1)
    expect(r.advanceTeam).toBe('France')
  })

  it('FT win — away team wins → correct winner', () => {
    const f = makeFixture('FT', 'France', 'Brazil', 0, 1)
    const r = getKnockoutResult(f, 'France', 'Brazil')!
    expect(r.advanceTeam).toBe('Brazil')
  })

  // ── Reversed teams (our teamA is API's away) ───────────────────────────────
  it('FT win — teams reversed in API → correct score mapping', () => {
    // API has Brazil as home, France as away, but our match has France=teamA
    const f = makeFixture('FT', 'Brazil', 'France', 1, 2)
    const r = getKnockoutResult(f, 'France', 'Brazil')!  // France is teamA but API away
    expect(r.score90A).toBe(2)  // France score (API away)
    expect(r.score90B).toBe(1)  // Brazil score (API home)
    expect(r.advanceTeam).toBe('France')
  })

  // ── Extra time ─────────────────────────────────────────────────────────────
  it('AET — 90min is 1-1, ET winner is France → score90 = 1-1, advance = France', () => {
    const f = makeFixture('AET', 'France', 'Brazil', 1, 1, 2, 1)
    const r = getKnockoutResult(f, 'France', 'Brazil')!
    expect(r.score90A).toBe(1)   // 90-min score, NOT ET score
    expect(r.score90B).toBe(1)
    expect(r.advanceTeam).toBe('France')
  })

  it('AET — ET away team wins', () => {
    const f = makeFixture('AET', 'Spain', 'Germany', 1, 1, 1, 2)
    const r = getKnockoutResult(f, 'Spain', 'Germany')!
    expect(r.score90A).toBe(1)
    expect(r.score90B).toBe(1)
    expect(r.advanceTeam).toBe('Germany')
  })

  // ── Penalties ──────────────────────────────────────────────────────────────
  it('PEN — 2-2 FT, 3-3 ET, penalties 4-2 home wins', () => {
    // WC2022 Final: France vs Argentina
    const f = makeFixture('PEN', 'France', 'Argentina', 2, 2, 3, 3, 2, 4)
    const r = getKnockoutResult(f, 'France', 'Argentina')!
    expect(r.score90A).toBe(2)       // 90-min score
    expect(r.score90B).toBe(2)
    expect(r.advanceTeam).toBe('Argentina')  // Argentina won penalties 4-2
  })

  it('PEN — reversed teams + penalties', () => {
    const f = makeFixture('PEN', 'Argentina', 'France', 2, 2, 3, 3, 4, 2)
    const r = getKnockoutResult(f, 'France', 'Argentina')!  // France=teamA but API away
    expect(r.score90A).toBe(2)   // France (API away) score
    expect(r.score90B).toBe(2)   // Argentina (API home) score
    expect(r.advanceTeam).toBe('Argentina')  // Argentina won 4-2
  })

  it('PEN — home team wins penalty shootout', () => {
    const f = makeFixture('PEN', 'England', 'France', 1, 1, 1, 1, 5, 3)
    const r = getKnockoutResult(f, 'England', 'France')!
    expect(r.advanceTeam).toBe('England')
  })

  // ── Not completed ──────────────────────────────────────────────────────────
  it('match in progress (1H) → returns null', () => {
    const f = makeFixture('1H', 'France', 'Brazil', 0, 0)
    expect(getKnockoutResult(f, 'France', 'Brazil')).toBeNull()
  })

  it('halftime (HT) → returns null', () => {
    const f = makeFixture('HT', 'France', 'Brazil', 1, 0)
    expect(getKnockoutResult(f, 'France', 'Brazil')).toBeNull()
  })

  it('scheduled (NS) → returns null', () => {
    const f = { ...makeFixture('NS', 'France', 'Brazil', 0, 0), score: { halftime: { home: null, away: null }, fulltime: { home: null, away: null }, extratime: { home: null, away: null }, penalty: { home: null, away: null } } }
    expect(getKnockoutResult(f as any, 'France', 'Brazil')).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// parseStandings
// ─────────────────────────────────────────────────────────────────────────────
describe('parseStandings', () => {

  const makeStanding = (rank: number, name: string, pts: number, gd: number, gf: number, group: string): ApiFootballStanding => ({
    rank, team: { id: rank, name }, points: pts, goalsDiff: gd, group: `Group ${group}`,
    all: { played: 3, goals: { for: gf, against: gf - gd } },
  })

  const enToHe: Record<string, string> = {
    'france': 'צרפת', 'brazil': 'ברזיל', 'argentina': 'ארגנטינה', 'germany': 'גרמניה',
    'spain': 'ספרד', 'england': 'אנגליה', 'morocco': 'מרוקו', 'usa': 'ארה"ב',
    'portugal': 'פורטוגל', 'netherlands': 'הולנד', 'belgium': 'בלגיה', 'mexico': 'מקסיקו',
  }

  const groupA = [
    makeStanding(1, 'France',    7, 4,  6, 'A'),
    makeStanding(2, 'Brazil',    6, 2,  5, 'A'),
    makeStanding(3, 'Argentina', 4, -1, 2, 'A'),
    makeStanding(4, 'Germany',   0, -5, 0, 'A'),
  ]

  const groupB = [
    makeStanding(1, 'Spain',     9, 6,  8, 'B'),
    makeStanding(2, 'England',   6, 3,  5, 'B'),
    makeStanding(3, 'Morocco',   3, -1, 1, 'B'),
    makeStanding(4, 'USA',       0, -8, 0, 'B'),
  ]

  it('correctly extracts top 3 per group', () => {
    const { groupQualifiers } = parseStandings([groupA, groupB], enToHe)
    expect(groupQualifiers['A']).toEqual(['צרפת', 'ברזיל', 'ארגנטינה'])
    expect(groupQualifiers['B']).toEqual(['ספרד', 'אנגליה', 'מרוקו'])
  })

  it('translates English names to Hebrew', () => {
    const { groupQualifiers } = parseStandings([groupA], enToHe)
    expect(groupQualifiers['A'][0]).toBe('צרפת')  // France → צרפת
    expect(groupQualifiers['A'][1]).toBe('ברזיל')  // Brazil → ברזיל
  })

  it('unknown team name kept as-is', () => {
    const groupUnknown = [
      makeStanding(1, 'UnknownTeam', 9, 5, 7, 'C'),
      makeStanding(2, 'Brazil', 6, 2, 4, 'C'),
      makeStanding(3, 'France', 3, 0, 2, 'C'),
      makeStanding(4, 'Germany', 0, -7, 0, 'C'),
    ]
    const { groupQualifiers } = parseStandings([groupUnknown], enToHe)
    expect(groupQualifiers['C'][0]).toBe('UnknownTeam')  // not in map → keep as-is
  })

  it('best 8 third place teams sorted correctly', () => {
    // Create 12 groups with different 3rd place teams
    const groups = ['A','B','C','D','E','F','G','H','I','J','K','L'].map((g, i) => [
      makeStanding(1, `Team1${g}`, 9, 5, 7, g),
      makeStanding(2, `Team2${g}`, 6, 2, 4, g),
      makeStanding(3, `Third${g}`, 3 - (i % 3), i, 3, g),  // varying points
      makeStanding(4, `Team4${g}`, 0, -7, 0, g),
    ])
    const { best8Thirds } = parseStandings(groups, {})
    expect(best8Thirds).toHaveLength(8)
  })

  it('best 8 thirds — teams with more points rank higher', () => {
    const groups = [
      [makeStanding(1,'T1A',9,5,7,'A'), makeStanding(2,'T2A',6,2,4,'A'), makeStanding(3,'ThirdA',5,3,5,'A'), makeStanding(4,'T4A',0,-10,0,'A')],
      [makeStanding(1,'T1B',9,5,7,'B'), makeStanding(2,'T2B',6,2,4,'B'), makeStanding(3,'ThirdB',1,-3,1,'B'), makeStanding(4,'T4B',0,-10,0,'B')],
    ]
    const { best8Thirds } = parseStandings(groups, {})
    expect(best8Thirds[0]).toBe('ThirdA')  // 5pts > 1pt
  })

  it('empty standings → empty result', () => {
    const { groupQualifiers, best8Thirds } = parseStandings([], enToHe)
    expect(Object.keys(groupQualifiers)).toHaveLength(0)
    expect(best8Thirds).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// fetchAllFixtures — mock fetch
// ─────────────────────────────────────────────────────────────────────────────
describe('fetchAllFixtures (mocked)', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('returns fixtures on success', async () => {
    const mockFixtures = [makeFixture('FT', 'France', 'Brazil', 2, 1)]
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: mockFixtures }),
    } as any)

    const { fetchAllFixtures } = await import('../services/apifootball')
    const result = await fetchAllFixtures()
    expect(result).toHaveLength(1)
    expect(result[0].teams.home.name).toBe('France')
  })

  it('throws on API error', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 429 } as any)
    const { fetchAllFixtures } = await import('../services/apifootball')
    await expect(fetchAllFixtures()).rejects.toThrow('API-Football error: 429')
  })

  it('handles empty response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ response: [] }),
    } as any)
    const { fetchAllFixtures } = await import('../services/apifootball')
    const result = await fetchAllFixtures()
    expect(result).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// fetchFixtureEvents — mock fetch
// ─────────────────────────────────────────────────────────────────────────────
describe('fetchFixtureEvents (mocked)', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('detects red card in events', async () => {
    const events = [
      { time: { elapsed: 55, extra: null }, team: { name: 'France' }, player: { name: 'Giroud' }, type: 'Card', detail: 'Red Card' },
      { time: { elapsed: 30, extra: null }, team: { name: 'Brazil' }, player: { name: 'Neymar' }, type: 'Card', detail: 'Yellow Card' },
    ]
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ response: events }),
    } as any)

    const { fetchFixtureEvents } = await import('../services/apifootball')
    const result = await fetchFixtureEvents(999)
    const hasRed = result.some(e => e.type === 'Card' && e.detail === 'Red Card')
    expect(hasRed).toBe(true)
  })

  it('no red cards in clean match', async () => {
    const events = [
      { time: { elapsed: 22, extra: null }, team: { name: 'France' }, player: { name: 'Giroud' }, type: 'Goal', detail: 'Normal Goal' },
    ]
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ response: events }),
    } as any)

    const { fetchFixtureEvents } = await import('../services/apifootball')
    const result = await fetchFixtureEvents(999)
    const hasRed = result.some(e => e.type === 'Card' && e.detail === 'Red Card')
    expect(hasRed).toBe(false)
  })
})
