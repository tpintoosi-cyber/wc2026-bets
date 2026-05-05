// api-football.com (api-sports.io) client
// Free plan: 100 requests/day, no credit card
// Register at: https://api-sports.io
// World Cup 2026: league=1, season=2026

const API_BASE = 'https://v3.football.api-sports.io'
const API_KEY = '20d83edc75998775f2f3d9cc402c92c9'

const headers = {
  'x-apisports-key': API_KEY,
}

export interface ApiFootballFixture {
  fixture: {
    id: number
    status: { short: string; elapsed: number | null }  // FT, ET, PEN, 1H, 2H, HT...
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

// Check if API key is configured
export function isConfigured(): boolean {
  return API_KEY.length > 10
}
