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
  extraTime?: boolean
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

// Build top assists list from match goals data
export function buildTopAssists(matches: ZafronixMatch[]): { name: string; assists: number; team: string }[] {
  const assistMap: Record<string, { assists: number; team: string }> = {}

  for (const match of matches) {
    if (!match.goals) continue
    for (const goal of match.goals) {
      if (goal.type === 'own_goal' || !goal.assist) continue
      const name = goal.assist
      // Assist team = same team as scorer
      const team = goal.team === 'home' ? (match.homeTeam ?? '') : (match.awayTeam ?? '')
      const heTeam = ZAFRONIX_TO_HE[team] ?? team
      if (!assistMap[name]) assistMap[name] = { assists: 0, team: heTeam }
      assistMap[name].assists++
    }
  }

  return Object.entries(assistMap)
    .map(([name, data]) => ({ name, assists: data.assists, team: data.team }))
    .sort((a, b) => b.assists - a.assists)
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

// Regulation (90-minute) score from goal minutes.
// wc2026api reports the final post-extra-time score as "FT", so a knockout match that
// went to ET is stored with its 120' score. Zafronix gives a minute for every goal, so
// we count only goals scored in the first 90 minutes (stoppage-time goals are recorded
// as <=90; genuine extra-time goals come back as 91+).
//
// The goals list is only trusted when it reconciles with a known FINAL score. Prefer the
// caller-supplied expectedFinal (the authoritative wc2026api final the app already stores)
// over Zafronix's own homeScore/awayScore, because that field is sometimes wrong — e.g.
// Argentina–Switzerland came back as "0-0" while the goals (10', 67', 112', 120') clearly
// describe a 3-1 ET result with a 1-1 score at 90'. Returns null when it can't be trusted,
// so the caller keeps the existing value.
export function getRegulationScore(
  match: ZafronixMatch,
  expectedFinal?: { home: number; away: number }
): { home: number; away: number } | null {
  const goals = match.goals
  const finalHome = expectedFinal ? expectedFinal.home : match.homeScore
  const finalAway = expectedFinal ? expectedFinal.away : match.awayScore
  if (!goals || goals.length === 0) {
    if (finalHome === 0 && finalAway === 0) return { home: 0, away: 0 }
    return null
  }
  let fullHome = 0, fullAway = 0, regHome = 0, regAway = 0
  for (const g of goals) {
    if (g.team === 'home') { fullHome++; if (g.minute <= 90) regHome++ }
    else if (g.team === 'away') { fullAway++; if (g.minute <= 90) regAway++ }
  }
  // Integrity check: the goals list must add up to the known final score.
  if (finalHome != null && finalAway != null &&
      (fullHome !== finalHome || fullAway !== finalAway)) {
    return null
  }
  return { home: regHome, away: regAway }
}
