// Zafronix World Cup API client
// Free tier: 250 requests/day, no card required
// API Key: zwc_free_a7e415db810aa0e7fb424586

const API_BASE = 'https://api.zafronix.com/fifa/worldcup/v1'
const API_KEY  = 'zwc_free_a7e415db810aa0e7fb424586'

const headers = { 'X-API-Key': API_KEY }

export interface ZafronixGoal {
  minute: number
  team: 'home' | 'away'
  scorer: string
  type?: string   // 'own_goal', 'penalty', etc.
  assist?: string
}

export interface ZafronixCard {
  minute: number
  team: 'home' | 'away'
  player: string
  color: 'yellow' | 'red'
  addedMinute?: number
}

export interface ZafronixMatch {
  id: string          // "2026-001"
  matchNo: number
  homeTeam: string | null
  awayTeam: string | null
  homeScore: number | null
  awayScore: number | null
  status: string      // "finished", "scheduled", etc.
  goals?: ZafronixGoal[]
  cards?: ZafronixCard[]
}

export interface ZafronixMatchesResponse {
  year: number
  count: number
  data: ZafronixMatch[]
}

// Fetch all WC 2026 matches with goals and cards
export async function fetchZafronixMatches(): Promise<ZafronixMatch[]> {
  const res = await fetch(`${API_BASE}/matches?year=2026`, { headers })
  if (!res.ok) throw new Error(`Zafronix API error: ${res.status}`)
  const data: ZafronixMatchesResponse = await res.json()
  return data.data ?? []
}

// Team name normalization — Zafronix uses English names, we need to map to our Hebrew names
// Zafronix name → our Hebrew name (via TEAM_EN reverse lookup with aliases)
export const ZAFRONIX_TO_HE: Record<string, string> = {
  'Mexico': 'מקסיקו',
  'South Africa': 'דרום אפריקה',
  'Korea Republic': 'קוריאה הדרומית',
  'South Korea': 'קוריאה הדרומית',
  'Czechia': 'צ׳כיה',
  'Czech Republic': 'צ׳כיה',
  'Canada': 'קנדה',
  'Bosnia and Herzegovina': 'בוסניה',
  'Bosnia': 'בוסניה',
  'USA': 'ארה"ב',
  'United States': 'ארה"ב',
  'Paraguay': 'פרגוואי',
  'Australia': 'אוסטרליה',
  'Türkiye': 'טורקיה',
  'Turkey': 'טורקיה',
  'Qatar': 'קטר',
  'Switzerland': 'שווייץ',
  'Brazil': 'ברזיל',
  'Morocco': 'מרוקו',
  'Haiti': 'האיטי',
  'Scotland': 'סקוטלנד',
  'Germany': 'גרמניה',
  'Curaçao': 'קוראסאו',
  'Netherlands': 'הולנד',
  'Japan': 'יפן',
  "Côte d'Ivoire": 'חוף השנהב',
  'Ivory Coast': 'חוף השנהב',
  'Ecuador': 'אקוודור',
  'Sweden': 'שוודיה',
  'Tunisia': 'תוניסיה',
  'Spain': 'ספרד',
  'Cabo Verde': 'כף ורדה',
  'Cape Verde': 'כף ורדה',
  'Saudi Arabia': 'סעודיה',
  'Uruguay': 'אורוגוואי',
  'Belgium': 'בלגיה',
  'Egypt': 'מצרים',
  'IR Iran': 'איראן',
  'Iran': 'איראן',
  'New Zealand': 'ניו זילנד',
  'France': 'צרפת',
  'Senegal': 'סנגל',
  'Iraq': 'עיראק',
  'Norway': 'נורווגיה',
  'Argentina': 'ארגנטינה',
  'Algeria': 'אלג׳יריה',
  'Austria': 'אוסטריה',
  'Jordan': 'ירדן',
  'Portugal': 'פורטוגל',
  'Congo DR': 'קונגו',
  'DR Congo': 'קונגו',
  'England': 'אנגליה',
  'Croatia': 'קרואטיה',
  'Ghana': 'גאנה',
  'Panama': 'פנמה',
  'Uzbekistan': 'אוזבקיסטן',
  'Colombia': 'קולומביה',
}

// Build top scorers list from match goals data
export function buildTopScorers(matches: ZafronixMatch[]): { name: string; goals: number; team: string }[] {
  const scorerMap: Record<string, { goals: number; team: string }> = {}

  for (const match of matches) {
    if (!match.goals) continue
    for (const goal of match.goals) {
      if (goal.type === 'own_goal') continue  // skip own goals
      const name = goal.scorer
      const team = goal.team === 'home' ? (match.homeTeam ?? '') : (match.awayTeam ?? '')
      const heTeam = ZAFRONIX_TO_HE[team] ?? team
      if (!scorerMap[name]) scorerMap[name] = { goals: 0, team: heTeam }
      scorerMap[name].goals++
    }
  }

  return Object.entries(scorerMap)
    .map(([name, data]) => ({ name, goals: data.goals, team: data.team }))
    .sort((a, b) => b.goals - a.goals)
}

// Count total red cards from match cards data
export function countRedCards(matches: ZafronixMatch[]): number {
  let total = 0
  for (const match of matches) {
    if (!match.cards) continue
    total += match.cards.filter(c => c.color === 'red').length
  }
  return total
}
