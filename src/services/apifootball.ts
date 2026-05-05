// api-football.com (api-sports.io) client
// Free plan: 100 requests/day, no credit card
// Register at: https://api-sports.io
// World Cup 2026: league=1, season=2026

const API_BASE = 'https://v3.football.api-sports.io'
const API_KEY = '20d83edc75998775f2f3d9cc402c92c9'

const headers = { 'x-apisports-key': API_KEY }

export interface ApiFootballFixture {
  fixture: {
    id: number
    status: { short: string; elapsed: number | null }  // FT, AET, PEN, 1H, 2H, HT...
  }
  teams: {
    home: { name: string }
    away: { name: string }
  }
  score: {
    halftime:  { home: number | null; away: number | null }
    fulltime:  { home: number | null; away: number | null }  // always 90-min score
    extratime: { home: number | null; away: number | null }  // null if no ET
    penalty:   { home: number | null; away: number | null }  // null if no penalties
  }
}

export interface ApiFootballEvent {
  time: { elapsed: number; extra: number | null }
  team: { name: string }
  player: { name: string }
  type: string    // "Card", "Goal", "subst"
  detail: string  // "Red Card", "Yellow Card", "Normal Goal", etc.
}

export interface ApiFootballStanding {
  rank: number
  team: { id: number; name: string }
  points: number
  goalsDiff: number
  group: string   // "Group A" .. "Group L"
  all: { played: number; goals: { for: number; against: number } }
}

// Fetch all WC 2026 fixtures with scores
export async function fetchAllFixtures(): Promise<ApiFootballFixture[]> {
  const res = await fetch(`${API_BASE}/fixtures?league=1&season=2026`, { headers })
  if (!res.ok) throw new Error(`API-Football error: ${res.status}`)
  const data = await res.json()
  return data.response ?? []
}

// Fetch events (goals, cards) for a specific fixture ID
export async function fetchFixtureEvents(fixtureId: number): Promise<ApiFootballEvent[]> {
  const res = await fetch(`${API_BASE}/fixtures/events?fixture=${fixtureId}`, { headers })
  if (!res.ok) throw new Error(`API-Football events error: ${res.status}`)
  const data = await res.json()
  return data.response ?? []
}

// Fetch group standings
export async function fetchStandings(): Promise<ApiFootballStanding[][]> {
  const res = await fetch(`${API_BASE}/standings?league=1&season=2026`, { headers })
  if (!res.ok) throw new Error(`API-Football standings error: ${res.status}`)
  const data = await res.json()
  // Returns array of groups, each group is array of team standings
  return data.response?.[0]?.league?.standings ?? []
}

// Determine who advanced from a knockout match based on API fixture data
// Returns: { score90A, score90B, advanceTeam }
export function getKnockoutResult(
  fixture: ApiFootballFixture,
  teamA: string,  // our teamA (home or away depends on API)
  teamB: string
): { score90A: number; score90B: number; advanceTeam: string } | null {
  const status = fixture.fixture.status.short
  const isCompleted = ['FT', 'AET', 'PEN'].includes(status)
  if (!isCompleted) return null

  const ft = fixture.score.fulltime
  const et = fixture.score.extratime
  const pen = fixture.score.penalty
  if (ft.home === null || ft.away === null) return null

  const apiHome = fixture.teams.home.name
  const isReversed = teamA !== apiHome  // our teamA maps to API away

  const score90A = isReversed ? ft.away : ft.home
  const score90B = isReversed ? ft.home : ft.away

  // Determine winner
  let winnerApiSide: 'home' | 'away'
  if (status === 'PEN' && pen.home !== null && pen.away !== null) {
    winnerApiSide = pen.home > pen.away ? 'home' : 'away'
  } else if (status === 'AET' && et.home !== null && et.away !== null) {
    winnerApiSide = et.home > et.away ? 'home' : 'away'
  } else {
    winnerApiSide = ft.home! > ft.away! ? 'home' : 'away'
  }

  const advanceTeam = isReversed
    ? (winnerApiSide === 'home' ? teamB : teamA)
    : (winnerApiSide === 'home' ? teamA : teamB)

  return { score90A: score90A!, score90B: score90B!, advanceTeam }
}

// Parse standings into our format:
// Returns { groupQualifiers, best8Thirds }
export function parseStandings(
  standings: ApiFootballStanding[][],
  enToHe: Record<string, string>
): {
  groupQualifiers: Record<string, [string, string, string]>
  best8Thirds: string[]
} {
  const groupQualifiers: Record<string, [string, string, string]> = {}
  const thirds: { name: string; points: number; gd: number; gf: number; group: string }[] = []

  for (const group of standings) {
    if (!group.length) continue
    const groupLetter = group[0].group.replace('Group ', '') // "A".."L"
    const sorted = [...group].sort((a, b) => a.rank - b.rank)

    const toHe = (en: string) => enToHe[en.toLowerCase()] ?? en
    const top3 = sorted.slice(0, 3).map(t => toHe(t.team.name)) as [string, string, string]
    groupQualifiers[groupLetter] = top3

    // 3rd place team
    if (sorted[2]) {
      thirds.push({
        name: toHe(sorted[2].team.name),
        points: sorted[2].points,
        gd: sorted[2].goalsDiff,
        gf: sorted[2].all.goals.for,
        group: groupLetter,
      })
    }
  }

  // Best 8 third-place teams
  const best8 = thirds
    .sort((a, b) => b.points - a.points || b.gd - a.gd || b.gf - a.gf)
    .slice(0, 8)
    .map(t => t.name)

  return { groupQualifiers, best8Thirds: best8 }
}

// Check if API key is configured
export function isConfigured(): boolean {
  return API_KEY.length > 10
}

