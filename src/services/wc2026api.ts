// wc2026api.com client
// API Key: wc26_6zPBmrp9gE9oeXxePePbUj

const API_BASE = 'https://api.wc2026api.com'
const API_KEY  = 'wc26_6zPBmrp9gE9oeXxePePbUj'

const headers = {
  'Authorization': `Bearer ${API_KEY}`,
  'Content-Type': 'application/json',
}

export interface ApiMatch {
  id: number
  match_number: number
  round: 'group' | 'knockout'
  group_name: string | null   // "A" .. "L"
  home_team: string
  away_team: string
  stadium: string
  kickoff_utc: string         // ISO 8601
  status: 'scheduled' | 'live' | 'completed'
  home_score: number | null
  away_score: number | null
  home_score_ht?: number | null
  away_score_ht?: number | null
  // Knockout-specific fields (if API provides them)
  knockout_round?: string     // e.g. "R32", "R16", "QF", "SF", "3P", "F"
}

export async function fetchAllMatches(): Promise<ApiMatch[]> {
  const res = await fetch(`${API_BASE}/matches`, { headers })
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  const data = await res.json()
  return Array.isArray(data) ? data : (data.data ?? data.matches ?? [])
}

export async function fetchGroupStageMatches(): Promise<ApiMatch[]> {
  const all = await fetchAllMatches()
  return all.filter(m => m.round === 'group')
}

export async function fetchKnockoutMatches(): Promise<ApiMatch[]> {
  const all = await fetchAllMatches()
  return all.filter(m => m.round === 'knockout')
}

// Convert UTC ISO string to Israel time string "d/M HH:MM"
export function toIsraelTime(utcIso: string): string {
  const date = new Date(utcIso)
  // Israel Summer Time = UTC+3
  const il = new Date(date.getTime() + 3 * 60 * 60 * 1000)
  const d = il.getUTCDate()
  const mo = il.getUTCMonth() + 1
  const h = String(il.getUTCHours()).padStart(2, '0')
  const min = String(il.getUTCMinutes()).padStart(2, '0')
  return `${d}/${mo} ${h}:${min}`
}

