// Pure sync logic — no Firebase, no React state
// Extracted so it can be unit tested independently

import type { Match } from '../types'
import type { ApiMatch } from '../services/wc2026api'
import type { ApiFootballFixture, ApiFootballStanding } from '../services/apifootball'
import { getKnockoutResult, parseStandings } from '../services/apifootball'
import { logger } from './logger'

export interface SyncResult {
  updatedMatches: Record<number, Match>
  updatedKnockout: Record<number, any>
  updatedGroups: Record<string, [string, string, string]>
  log: string[]
  stats: {
    schedulesUpdated: number
    groupResultsUpdated: number
    knockoutUpdated: number
    penaltyMatches: number
    redCardsFound: number
    scoresFixed: number
    advanceFixed: number
    groupsPopulated: number
  }
}

// ── Process group stage matches from wc2026api ───────────────────────────────
export function processGroupMatches(
  apiMatches: ApiMatch[],
  currentMatches: Record<number, Match>,
  ourMatches: Match[],
  aliases: Record<string, string>,
  enToHe: Record<string, string>,
  toIsraelTimeFn?: (utc: string) => string
): { updatedMatches: Record<number, Match>; schedules: number; results: number; log: string[] } {
  const updated = { ...currentMatches }
  let schedules = 0, results = 0
  const log: string[] = []

  for (const apiMatch of apiMatches) {
    const normHome = aliases[apiMatch.home_team?.toLowerCase()] ?? apiMatch.home_team?.toLowerCase()
    const normAway = aliases[apiMatch.away_team?.toLowerCase()] ?? apiMatch.away_team?.toLowerCase()
    const homeHe = enToHe[normHome] ?? apiMatch.home_team
    const awayHe = enToHe[normAway] ?? apiMatch.away_team

    const ourMatch = ourMatches.find(m =>
      (m.teamA === homeHe && m.teamB === awayHe) ||
      (m.teamA === awayHe && m.teamB === homeHe)
    )
    if (!ourMatch) {
      log.push(`⚠️ לא נמצא: ${apiMatch.home_team} vs ${apiMatch.away_team}`)
      logger.warn(`Match not found in our data`, { home: apiMatch.home_team, away: apiMatch.away_team })
      continue
    }

    const current = { ...(updated[ourMatch.id] ?? ourMatch) }
    const isReversed = ourMatch.teamA === awayHe

    if (apiMatch.kickoff_utc && toIsraelTimeFn) {
      ;(current as any).scheduleIL = toIsraelTimeFn(apiMatch.kickoff_utc)
      schedules++
    }

    if (apiMatch.status === 'completed' && apiMatch.home_score !== null && apiMatch.away_score !== null) {
      current.resultA = isReversed ? apiMatch.away_score : apiMatch.home_score
      current.resultB = isReversed ? apiMatch.home_score : apiMatch.away_score
      current.isPlayed = true
      results++
      logger.success(`Group match result: ${ourMatch.teamA} ${current.resultA}-${current.resultB} ${ourMatch.teamB}`)
    }

    updated[ourMatch.id] = current as Match
  }

  return { updatedMatches: updated, schedules, results, log }
}

// ── Process knockout matches from wc2026api ──────────────────────────────────
export function processKnockoutMatches(
  apiMatches: ApiMatch[],
  currentKnockout: Record<number, any>,
  aliases: Record<string, string>,
  enToHe: Record<string, string>
): { updatedKnockout: Record<number, any>; updated: number; penalties: number; log: string[] } {
  const knockout = { ...currentKnockout }
  let updated = 0, penalties = 0
  const log: string[] = []

  for (const apiMatch of apiMatches) {
    if (apiMatch.status !== 'completed') continue
    if (apiMatch.home_score === null || apiMatch.away_score === null) continue

    const normHome = aliases[apiMatch.home_team?.toLowerCase()] ?? apiMatch.home_team?.toLowerCase()
    const normAway = aliases[apiMatch.away_team?.toLowerCase()] ?? apiMatch.away_team?.toLowerCase()
    const homeHe = enToHe[normHome] ?? apiMatch.home_team
    const awayHe = enToHe[normAway] ?? apiMatch.away_team

    const entry = Object.entries(knockout).find(([, km]: [string, any]) =>
      (km.teamA === homeHe && km.teamB === awayHe) ||
      (km.teamA === awayHe && km.teamB === homeHe)
    )
    if (!entry) {
      log.push(`⚠️ נוקאאוט לא נמצא: ${apiMatch.home_team} vs ${apiMatch.away_team}`)
      logger.warn(`Knockout match not found`, { home: apiMatch.home_team, away: apiMatch.away_team })
      continue
    }

    const km = { ...entry[1] } as any
    if (km.manualScore) {
      logger.debug(`Skipping manual score for match`, { teamA: km.teamA, teamB: km.teamB })
      continue
    }

    const isReversed = km.teamA === awayHe
    km.resultA = isReversed ? apiMatch.away_score : apiMatch.home_score
    km.resultB = isReversed ? apiMatch.home_score : apiMatch.away_score
    km.isPlayed = true

    if (km.resultA !== km.resultB && !km.advanceTeam) {
      km.advanceTeam = km.resultA > km.resultB ? km.teamA : km.teamB
      logger.success(`Knockout advance: ${km.advanceTeam} advances from ${km.teamA} vs ${km.teamB}`)
    } else if (km.resultA === km.resultB) {
      penalties++
      logger.warn(`Penalty match detected — manual advanceTeam required`, { teamA: km.teamA, teamB: km.teamB })
      log.push(`⚠️ פנדלים: ${km.teamA} vs ${km.teamB} — יש להגדיר מי עלה ידנית`)
    }

    knockout[Number(entry[0])] = km
    updated++
  }

  return { updatedKnockout: knockout, updated, penalties, log }
}

// ── Process API-Football fixtures for 90-min scores + red cards ──────────────
export function applyApiFootballFixtures(
  fixtures: ApiFootballFixture[],
  currentMatches: Record<number, Match>,
  currentKnockout: Record<number, any>,
  ourMatches: Match[],
  teamEN: Record<string, string>
): {
  updatedMatches: Record<number, Match>
  updatedKnockout: Record<number, any>
  redCardsMap: Record<number, boolean>  // fixtureId → hasRedCard
  scoresFixed: number
  advanceFixed: number
  log: string[]
} {
  const matches = { ...currentMatches }
  const knockout = { ...currentKnockout }
  const redCardsMap: Record<number, boolean> = {}
  let scoresFixed = 0, advanceFixed = 0
  const log: string[] = []

  // Build fixture lookup by team names
  const fixtureByTeams: Record<string, ApiFootballFixture> = {}
  for (const f of fixtures) {
    const s = f.fixture.status.short
    if (['FT', 'AET', 'PEN'].includes(s)) {
      fixtureByTeams[`${f.teams.home.name}|${f.teams.away.name}`] = f
      fixtureByTeams[`${f.teams.away.name}|${f.teams.home.name}`] = f
    }
  }

  // EN→HE reverse map
  const enToHe: Record<string, string> = {}
  for (const [he, en] of Object.entries(teamEN)) {
    enToHe[en.toLowerCase()] = he
    enToHe[en] = he
  }

  // Fix group stage 90-min scores
  for (const match of ourMatches) {
    if (!matches[match.id]?.isPlayed) continue
    const teamAen = teamEN[match.teamA] ?? match.teamA
    const fixture = fixtureByTeams[`${teamAen}|${teamEN[match.teamB] ?? match.teamB}`]
    if (!fixture) continue

    const ft = fixture.score.fulltime
    if (ft.home !== null && ft.away !== null) {
      const isRev = fixture.teams.home.name !== teamAen
      matches[match.id] = {
        ...matches[match.id],
        resultA: isRev ? ft.away! : ft.home!,
        resultB: isRev ? ft.home! : ft.away!,
      }
      scoresFixed++
      logger.debug(`90-min score fixed: ${match.teamA} ${matches[match.id].resultA}-${matches[match.id].resultB} ${match.teamB}`)
    }

    // Track fixture ID for red card lookup
    redCardsMap[fixture.fixture.id] = false  // default false, updated by events
  }

  // Fix knockout 90-min scores + advance team
  for (const [idStr, km] of Object.entries(knockout)) {
    if (!km.isPlayed || km.manualScore) continue
    const teamAen = teamEN[km.teamA] ?? km.teamA ?? ''
    const teamBen = teamEN[km.teamB] ?? km.teamB ?? ''
    if (!teamAen || !teamBen) continue

    const fixture = fixtureByTeams[`${teamAen}|${teamBen}`]
    if (!fixture) continue

    const result = getKnockoutResult(fixture, teamAen, teamBen)
    if (result) {
      // Convert EN advance team back to Hebrew
      const advanceHe = enToHe[result.advanceTeam.toLowerCase()] ?? enToHe[result.advanceTeam] ?? result.advanceTeam
      knockout[Number(idStr)] = {
        ...km,
        resultA: result.score90A,
        resultB: result.score90B,
        advanceTeam: advanceHe,
      }
      advanceFixed++
      logger.success(`Knockout result: ${km.teamA} ${result.score90A}-${result.score90B} ${km.teamB} → ${advanceHe} advances`)
    }

    redCardsMap[fixture.fixture.id] = false
  }

  return { updatedMatches: matches, updatedKnockout: knockout, redCardsMap, scoresFixed, advanceFixed, log }
}

// ── Apply red cards from events ──────────────────────────────────────────────
export function applyRedCards(
  matchId: number,
  isKnockout: boolean,
  hasRedCard: boolean,
  currentMatches: Record<number, Match>,
  currentKnockout: Record<number, any>
): { updatedMatches: Record<number, Match>; updatedKnockout: Record<number, any> } {
  if (isKnockout) {
    return {
      updatedMatches: currentMatches,
      updatedKnockout: {
        ...currentKnockout,
        [matchId]: { ...currentKnockout[matchId], hadRedCard: hasRedCard }
      }
    }
  }
  return {
    updatedMatches: {
      ...currentMatches,
      [matchId]: { ...currentMatches[matchId], hadRedCard: hasRedCard }
    },
    updatedKnockout: currentKnockout
  }
}

// ── Process standings ─────────────────────────────────────────────────────────
export function processStandings(
  standings: ApiFootballStanding[][],
  enToHe: Record<string, string>
): { groupQualifiers: Record<string, [string, string, string]>; best8: string[]; log: string[] } {
  const log: string[] = []
  if (!standings.length) {
    log.push('ℹ️ אין נתוני טבלה עדיין')
    return { groupQualifiers: {}, best8: [], log }
  }

  const { groupQualifiers, best8Thirds } = parseStandings(standings, enToHe)
  const groupCount = Object.keys(groupQualifiers).length

  if (groupCount > 0) {
    logger.success(`Standings parsed: ${groupCount} groups, ${best8Thirds.length} best 3rd place teams`)
    log.push(`🏅 עולות מהבתים: ${groupCount} בתים`)
    if (best8Thirds.length === 8) {
      log.push(`🎯 8 הטובות ב-3: ${best8Thirds.join(', ')}`)
    }
  }

  return { groupQualifiers, best8: best8Thirds, log }
}

// ── R32 Auto-population ───────────────────────────────────────────────────────

// Official FIFA WC2026 bracket structure for R32 (matches 73-88)
// Source: Official FIFA schedule (MLS Soccer / NBC Sports confirmed)
const R32_BRACKET = [
  { id: 73, a: { g:'A', p:2 }, b: { g:'B', p:2 } },
  { id: 74, a: { g:'E', p:1 }, b: { p:3, ok:['A','B','C','D','F'] } },
  { id: 75, a: { g:'F', p:1 }, b: { g:'C', p:2 } },
  { id: 76, a: { g:'C', p:1 }, b: { g:'F', p:2 } },
  { id: 77, a: { g:'I', p:1 }, b: { p:3, ok:['C','D','F','G','H'] } },
  { id: 78, a: { g:'E', p:2 }, b: { g:'I', p:2 } },
  { id: 79, a: { g:'A', p:1 }, b: { p:3, ok:['C','E','F','H','I'] } },
  { id: 80, a: { g:'L', p:1 }, b: { p:3, ok:['E','H','I','J','K'] } },
  { id: 81, a: { g:'D', p:1 }, b: { p:3, ok:['B','E','F','I','J'] } },
  { id: 82, a: { g:'G', p:1 }, b: { p:3, ok:['A','E','H','I','J'] } },
  { id: 83, a: { g:'K', p:2 }, b: { g:'L', p:2 } },
  { id: 84, a: { g:'B', p:1 }, b: { p:3, ok:['E','F','G','I','J'] } },
  { id: 85, a: { g:'H', p:1 }, b: { g:'J', p:2 } },
  { id: 86, a: { g:'J', p:1 }, b: { g:'H', p:2 } },
  { id: 87, a: { g:'K', p:1 }, b: { p:3, ok:['D','E','I','J','L'] } },
  { id: 88, a: { g:'D', p:2 }, b: { g:'G', p:2 } },
] as const

// Annex C lookup: sorted 8-group key → { matchId: group }
// Columns: 1A=m79, 1B=m84, 1D=m81, 1E=m74, 1G=m82, 1I=m77, 1K=m87, 1L=m80
const ANNEX_C: Record<string, Record<number, string>> = {
  'ABCDEFGH': {74: 'C', 77: 'F', 79: 'H', 80: 'E', 81: 'B', 82: 'A', 84: 'G', 87: 'D'},
  'ABCDEFGI': {74: 'D', 77: 'F', 79: 'C', 80: 'I', 81: 'B', 82: 'A', 84: 'G', 87: 'E'},
  'ABCDEFGJ': {74: 'D', 77: 'F', 79: 'C', 80: 'J', 81: 'B', 82: 'A', 84: 'G', 87: 'E'},
  'ABCDEFGK': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'B', 82: 'A', 84: 'G', 87: 'E'},
  'ABCDEFGL': {74: 'D', 77: 'F', 79: 'C', 80: 'E', 81: 'B', 82: 'A', 84: 'G', 87: 'L'},
  'ABCDEFHI': {74: 'C', 77: 'F', 79: 'H', 80: 'I', 81: 'B', 82: 'A', 84: 'E', 87: 'D'},
  'ABCDEFHJ': {74: 'C', 77: 'F', 79: 'H', 80: 'E', 81: 'B', 82: 'A', 84: 'J', 87: 'D'},
  'ABCDEFHK': {74: 'C', 77: 'F', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'E', 87: 'D'},
  'ABCDEFHL': {74: 'C', 77: 'D', 79: 'H', 80: 'E', 81: 'B', 82: 'A', 84: 'F', 87: 'L'},
  'ABCDEFIJ': {74: 'D', 77: 'F', 79: 'C', 80: 'I', 81: 'B', 82: 'A', 84: 'J', 87: 'E'},
  'ABCDEFIK': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'B', 82: 'A', 84: 'E', 87: 'I'},
  'ABCDEFIL': {74: 'D', 77: 'F', 79: 'C', 80: 'I', 81: 'B', 82: 'A', 84: 'E', 87: 'L'},
  'ABCDEFJK': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'E'},
  'ABCDEFJL': {74: 'D', 77: 'F', 79: 'C', 80: 'E', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABCDEFKL': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'B', 82: 'A', 84: 'E', 87: 'L'},
  'ABCDEGHI': {74: 'C', 77: 'D', 79: 'H', 80: 'I', 81: 'B', 82: 'A', 84: 'G', 87: 'E'},
  'ABCDEGHJ': {74: 'C', 77: 'D', 79: 'H', 80: 'J', 81: 'B', 82: 'A', 84: 'G', 87: 'E'},
  'ABCDEGHK': {74: 'C', 77: 'D', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'G', 87: 'E'},
  'ABCDEGHL': {74: 'C', 77: 'D', 79: 'H', 80: 'E', 81: 'B', 82: 'A', 84: 'G', 87: 'L'},
  'ABCDEGIJ': {74: 'C', 77: 'D', 79: 'E', 80: 'J', 81: 'B', 82: 'A', 84: 'G', 87: 'I'},
  'ABCDEGIK': {74: 'C', 77: 'D', 79: 'E', 80: 'K', 81: 'B', 82: 'A', 84: 'G', 87: 'I'},
  'ABCDEGIL': {74: 'C', 77: 'D', 79: 'E', 80: 'I', 81: 'B', 82: 'A', 84: 'G', 87: 'L'},
  'ABCDEGJK': {74: 'C', 77: 'D', 79: 'E', 80: 'K', 81: 'B', 82: 'A', 84: 'G', 87: 'J'},
  'ABCDEGJL': {74: 'C', 77: 'D', 79: 'E', 80: 'J', 81: 'B', 82: 'A', 84: 'G', 87: 'L'},
  'ABCDEGKL': {74: 'C', 77: 'D', 79: 'E', 80: 'K', 81: 'B', 82: 'A', 84: 'G', 87: 'L'},
  'ABCDEHIJ': {74: 'C', 77: 'D', 79: 'H', 80: 'I', 81: 'B', 82: 'A', 84: 'J', 87: 'E'},
  'ABCDEHIK': {74: 'C', 77: 'D', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'E', 87: 'I'},
  'ABCDEHIL': {74: 'C', 77: 'D', 79: 'H', 80: 'I', 81: 'B', 82: 'A', 84: 'E', 87: 'L'},
  'ABCDEHJK': {74: 'C', 77: 'D', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'E'},
  'ABCDEHJL': {74: 'C', 77: 'D', 79: 'H', 80: 'E', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABCDEHKL': {74: 'C', 77: 'D', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'E', 87: 'L'},
  'ABCDEIJK': {74: 'C', 77: 'D', 79: 'E', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'I'},
  'ABCDEIJL': {74: 'C', 77: 'D', 79: 'E', 80: 'I', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABCDEIKL': {74: 'C', 77: 'D', 79: 'E', 80: 'K', 81: 'B', 82: 'A', 84: 'I', 87: 'L'},
  'ABCDEJKL': {74: 'C', 77: 'D', 79: 'E', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABCDFGHI': {74: 'C', 77: 'F', 79: 'H', 80: 'I', 81: 'B', 82: 'A', 84: 'G', 87: 'D'},
  'ABCDFGHJ': {74: 'C', 77: 'F', 79: 'H', 80: 'J', 81: 'B', 82: 'A', 84: 'G', 87: 'D'},
  'ABCDFGHK': {74: 'C', 77: 'F', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'G', 87: 'D'},
  'ABCDFGHL': {74: 'D', 77: 'F', 79: 'C', 80: 'H', 81: 'B', 82: 'A', 84: 'G', 87: 'L'},
  'ABCDFGIJ': {74: 'D', 77: 'F', 79: 'C', 80: 'J', 81: 'B', 82: 'A', 84: 'G', 87: 'I'},
  'ABCDFGIK': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'B', 82: 'A', 84: 'G', 87: 'I'},
  'ABCDFGIL': {74: 'D', 77: 'F', 79: 'C', 80: 'I', 81: 'B', 82: 'A', 84: 'G', 87: 'L'},
  'ABCDFGJK': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'B', 82: 'A', 84: 'G', 87: 'J'},
  'ABCDFGJL': {74: 'D', 77: 'F', 79: 'C', 80: 'J', 81: 'B', 82: 'A', 84: 'G', 87: 'L'},
  'ABCDFGKL': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'B', 82: 'A', 84: 'G', 87: 'L'},
  'ABCDFHIJ': {74: 'C', 77: 'F', 79: 'H', 80: 'I', 81: 'B', 82: 'A', 84: 'J', 87: 'D'},
  'ABCDFHIK': {74: 'C', 77: 'D', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'F', 87: 'I'},
  'ABCDFHIL': {74: 'C', 77: 'D', 79: 'H', 80: 'I', 81: 'B', 82: 'A', 84: 'F', 87: 'L'},
  'ABCDFHJK': {74: 'C', 77: 'F', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'D'},
  'ABCDFHJL': {74: 'D', 77: 'F', 79: 'C', 80: 'H', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABCDFHKL': {74: 'C', 77: 'D', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'F', 87: 'L'},
  'ABCDFIJK': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'I'},
  'ABCDFIJL': {74: 'D', 77: 'F', 79: 'C', 80: 'I', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABCDFIKL': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'B', 82: 'A', 84: 'I', 87: 'L'},
  'ABCDFJKL': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABCDGHIJ': {74: 'C', 77: 'D', 79: 'H', 80: 'J', 81: 'B', 82: 'A', 84: 'G', 87: 'I'},
  'ABCDGHIK': {74: 'C', 77: 'D', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'G', 87: 'I'},
  'ABCDGHIL': {74: 'C', 77: 'D', 79: 'H', 80: 'I', 81: 'B', 82: 'A', 84: 'G', 87: 'L'},
  'ABCDGHJK': {74: 'C', 77: 'D', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'G', 87: 'J'},
  'ABCDGHJL': {74: 'C', 77: 'D', 79: 'H', 80: 'J', 81: 'B', 82: 'A', 84: 'G', 87: 'L'},
  'ABCDGHKL': {74: 'C', 77: 'D', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'G', 87: 'L'},
  'ABCDGIJK': {74: 'D', 77: 'G', 79: 'C', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'I'},
  'ABCDGIJL': {74: 'D', 77: 'G', 79: 'C', 80: 'I', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABCDGIKL': {74: 'C', 77: 'D', 79: 'I', 80: 'K', 81: 'B', 82: 'A', 84: 'G', 87: 'L'},
  'ABCDGJKL': {74: 'D', 77: 'G', 79: 'C', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABCDHIJK': {74: 'C', 77: 'D', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'I'},
  'ABCDHIJL': {74: 'C', 77: 'D', 79: 'H', 80: 'I', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABCDHIKL': {74: 'C', 77: 'D', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'I', 87: 'L'},
  'ABCDHJKL': {74: 'C', 77: 'D', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABCDIJKL': {74: 'C', 77: 'D', 79: 'I', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABCEFGHI': {74: 'C', 77: 'F', 79: 'H', 80: 'I', 81: 'B', 82: 'A', 84: 'G', 87: 'E'},
  'ABCEFGHJ': {74: 'C', 77: 'F', 79: 'H', 80: 'J', 81: 'B', 82: 'A', 84: 'G', 87: 'E'},
  'ABCEFGHK': {74: 'C', 77: 'F', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'G', 87: 'E'},
  'ABCEFGHL': {74: 'C', 77: 'F', 79: 'H', 80: 'E', 81: 'B', 82: 'A', 84: 'G', 87: 'L'},
  'ABCEFGIJ': {74: 'C', 77: 'F', 79: 'E', 80: 'J', 81: 'B', 82: 'A', 84: 'G', 87: 'I'},
  'ABCEFGIK': {74: 'C', 77: 'F', 79: 'E', 80: 'K', 81: 'B', 82: 'A', 84: 'G', 87: 'I'},
  'ABCEFGIL': {74: 'C', 77: 'F', 79: 'E', 80: 'I', 81: 'B', 82: 'A', 84: 'G', 87: 'L'},
  'ABCEFGJK': {74: 'C', 77: 'F', 79: 'E', 80: 'K', 81: 'B', 82: 'A', 84: 'G', 87: 'J'},
  'ABCEFGJL': {74: 'C', 77: 'F', 79: 'E', 80: 'J', 81: 'B', 82: 'A', 84: 'G', 87: 'L'},
  'ABCEFGKL': {74: 'C', 77: 'F', 79: 'E', 80: 'K', 81: 'B', 82: 'A', 84: 'G', 87: 'L'},
  'ABCEFHIJ': {74: 'C', 77: 'F', 79: 'H', 80: 'I', 81: 'B', 82: 'A', 84: 'J', 87: 'E'},
  'ABCEFHIK': {74: 'C', 77: 'F', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'E', 87: 'I'},
  'ABCEFHIL': {74: 'C', 77: 'F', 79: 'H', 80: 'I', 81: 'B', 82: 'A', 84: 'E', 87: 'L'},
  'ABCEFHJK': {74: 'C', 77: 'F', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'E'},
  'ABCEFHJL': {74: 'C', 77: 'F', 79: 'H', 80: 'E', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABCEFHKL': {74: 'C', 77: 'F', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'E', 87: 'L'},
  'ABCEFIJK': {74: 'C', 77: 'F', 79: 'E', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'I'},
  'ABCEFIJL': {74: 'C', 77: 'F', 79: 'E', 80: 'I', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABCEFIKL': {74: 'C', 77: 'F', 79: 'E', 80: 'K', 81: 'B', 82: 'A', 84: 'I', 87: 'L'},
  'ABCEFJKL': {74: 'C', 77: 'F', 79: 'E', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABCEGHIJ': {74: 'C', 77: 'G', 79: 'H', 80: 'I', 81: 'B', 82: 'A', 84: 'J', 87: 'E'},
  'ABCEGHIK': {74: 'C', 77: 'H', 79: 'E', 80: 'K', 81: 'B', 82: 'A', 84: 'G', 87: 'I'},
  'ABCEGHIL': {74: 'C', 77: 'H', 79: 'E', 80: 'I', 81: 'B', 82: 'A', 84: 'G', 87: 'L'},
  'ABCEGHJK': {74: 'C', 77: 'G', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'E'},
  'ABCEGHJL': {74: 'C', 77: 'G', 79: 'H', 80: 'E', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABCEGHKL': {74: 'C', 77: 'H', 79: 'E', 80: 'K', 81: 'B', 82: 'A', 84: 'G', 87: 'L'},
  'ABCEGIJK': {74: 'C', 77: 'G', 79: 'E', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'I'},
  'ABCEGIJL': {74: 'C', 77: 'G', 79: 'E', 80: 'I', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABCEGIKL': {74: 'A', 77: 'C', 79: 'E', 80: 'K', 81: 'B', 82: 'I', 84: 'G', 87: 'L'},
  'ABCEGJKL': {74: 'C', 77: 'G', 79: 'E', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABCEHIJK': {74: 'C', 77: 'H', 79: 'E', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'I'},
  'ABCEHIJL': {74: 'C', 77: 'H', 79: 'E', 80: 'I', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABCEHIKL': {74: 'C', 77: 'H', 79: 'E', 80: 'K', 81: 'B', 82: 'A', 84: 'I', 87: 'L'},
  'ABCEHJKL': {74: 'C', 77: 'H', 79: 'E', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABCEIJKL': {74: 'A', 77: 'C', 79: 'E', 80: 'K', 81: 'B', 82: 'I', 84: 'J', 87: 'L'},
  'ABCFGHIJ': {74: 'C', 77: 'F', 79: 'H', 80: 'J', 81: 'B', 82: 'A', 84: 'G', 87: 'I'},
  'ABCFGHIK': {74: 'C', 77: 'F', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'G', 87: 'I'},
  'ABCFGHIL': {74: 'C', 77: 'F', 79: 'H', 80: 'I', 81: 'B', 82: 'A', 84: 'G', 87: 'L'},
  'ABCFGHJK': {74: 'C', 77: 'F', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'G', 87: 'J'},
  'ABCFGHJL': {74: 'C', 77: 'F', 79: 'H', 80: 'J', 81: 'B', 82: 'A', 84: 'G', 87: 'L'},
  'ABCFGHKL': {74: 'C', 77: 'F', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'G', 87: 'L'},
  'ABCFGIJK': {74: 'F', 77: 'G', 79: 'C', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'I'},
  'ABCFGIJL': {74: 'F', 77: 'G', 79: 'C', 80: 'I', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABCFGIKL': {74: 'C', 77: 'F', 79: 'I', 80: 'K', 81: 'B', 82: 'A', 84: 'G', 87: 'L'},
  'ABCFGJKL': {74: 'F', 77: 'G', 79: 'C', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABCFHIJK': {74: 'C', 77: 'F', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'I'},
  'ABCFHIJL': {74: 'C', 77: 'F', 79: 'H', 80: 'I', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABCFHIKL': {74: 'C', 77: 'F', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'I', 87: 'L'},
  'ABCFHJKL': {74: 'C', 77: 'F', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABCFIJKL': {74: 'C', 77: 'F', 79: 'I', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABCGHIJK': {74: 'C', 77: 'G', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'I'},
  'ABCGHIJL': {74: 'C', 77: 'G', 79: 'H', 80: 'I', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABCGHIKL': {74: 'C', 77: 'H', 79: 'I', 80: 'K', 81: 'B', 82: 'A', 84: 'G', 87: 'L'},
  'ABCGHJKL': {74: 'C', 77: 'G', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABCGIJKL': {74: 'C', 77: 'G', 79: 'I', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABCHIJKL': {74: 'C', 77: 'H', 79: 'I', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABDEFGHI': {74: 'D', 77: 'F', 79: 'H', 80: 'I', 81: 'B', 82: 'A', 84: 'G', 87: 'E'},
  'ABDEFGHJ': {74: 'D', 77: 'F', 79: 'H', 80: 'J', 81: 'B', 82: 'A', 84: 'G', 87: 'E'},
  'ABDEFGHK': {74: 'D', 77: 'F', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'G', 87: 'E'},
  'ABDEFGHL': {74: 'D', 77: 'F', 79: 'H', 80: 'E', 81: 'B', 82: 'A', 84: 'G', 87: 'L'},
  'ABDEFGIJ': {74: 'D', 77: 'F', 79: 'E', 80: 'J', 81: 'B', 82: 'A', 84: 'G', 87: 'I'},
  'ABDEFGIK': {74: 'D', 77: 'F', 79: 'E', 80: 'K', 81: 'B', 82: 'A', 84: 'G', 87: 'I'},
  'ABDEFGIL': {74: 'D', 77: 'F', 79: 'E', 80: 'I', 81: 'B', 82: 'A', 84: 'G', 87: 'L'},
  'ABDEFGJK': {74: 'D', 77: 'F', 79: 'E', 80: 'K', 81: 'B', 82: 'A', 84: 'G', 87: 'J'},
  'ABDEFGJL': {74: 'D', 77: 'F', 79: 'E', 80: 'J', 81: 'B', 82: 'A', 84: 'G', 87: 'L'},
  'ABDEFGKL': {74: 'D', 77: 'F', 79: 'E', 80: 'K', 81: 'B', 82: 'A', 84: 'G', 87: 'L'},
  'ABDEFHIJ': {74: 'D', 77: 'F', 79: 'H', 80: 'I', 81: 'B', 82: 'A', 84: 'J', 87: 'E'},
  'ABDEFHIK': {74: 'D', 77: 'F', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'E', 87: 'I'},
  'ABDEFHIL': {74: 'D', 77: 'F', 79: 'H', 80: 'I', 81: 'B', 82: 'A', 84: 'E', 87: 'L'},
  'ABDEFHJK': {74: 'D', 77: 'F', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'E'},
  'ABDEFHJL': {74: 'D', 77: 'F', 79: 'H', 80: 'E', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABDEFHKL': {74: 'D', 77: 'F', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'E', 87: 'L'},
  'ABDEFIJK': {74: 'D', 77: 'F', 79: 'E', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'I'},
  'ABDEFIJL': {74: 'D', 77: 'F', 79: 'E', 80: 'I', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABDEFIKL': {74: 'D', 77: 'F', 79: 'E', 80: 'K', 81: 'B', 82: 'A', 84: 'I', 87: 'L'},
  'ABDEFJKL': {74: 'D', 77: 'F', 79: 'E', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABDEGHIJ': {74: 'D', 77: 'G', 79: 'H', 80: 'I', 81: 'B', 82: 'A', 84: 'J', 87: 'E'},
  'ABDEGHIK': {74: 'D', 77: 'H', 79: 'E', 80: 'K', 81: 'B', 82: 'A', 84: 'G', 87: 'I'},
  'ABDEGHIL': {74: 'D', 77: 'H', 79: 'E', 80: 'I', 81: 'B', 82: 'A', 84: 'G', 87: 'L'},
  'ABDEGHJK': {74: 'D', 77: 'G', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'E'},
  'ABDEGHJL': {74: 'D', 77: 'G', 79: 'H', 80: 'E', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABDEGHKL': {74: 'D', 77: 'H', 79: 'E', 80: 'K', 81: 'B', 82: 'A', 84: 'G', 87: 'L'},
  'ABDEGIJK': {74: 'D', 77: 'G', 79: 'E', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'I'},
  'ABDEGIJL': {74: 'D', 77: 'G', 79: 'E', 80: 'I', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABDEGIKL': {74: 'A', 77: 'D', 79: 'E', 80: 'K', 81: 'B', 82: 'I', 84: 'G', 87: 'L'},
  'ABDEGJKL': {74: 'D', 77: 'G', 79: 'E', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABDEHIJK': {74: 'D', 77: 'H', 79: 'E', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'I'},
  'ABDEHIJL': {74: 'D', 77: 'H', 79: 'E', 80: 'I', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABDEHIKL': {74: 'D', 77: 'H', 79: 'E', 80: 'K', 81: 'B', 82: 'A', 84: 'I', 87: 'L'},
  'ABDEHJKL': {74: 'D', 77: 'H', 79: 'E', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABDEIJKL': {74: 'A', 77: 'D', 79: 'E', 80: 'K', 81: 'B', 82: 'I', 84: 'J', 87: 'L'},
  'ABDFGHIJ': {74: 'D', 77: 'F', 79: 'H', 80: 'J', 81: 'B', 82: 'A', 84: 'G', 87: 'I'},
  'ABDFGHIK': {74: 'D', 77: 'F', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'G', 87: 'I'},
  'ABDFGHIL': {74: 'D', 77: 'F', 79: 'H', 80: 'I', 81: 'B', 82: 'A', 84: 'G', 87: 'L'},
  'ABDFGHJK': {74: 'D', 77: 'F', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'G', 87: 'J'},
  'ABDFGHJL': {74: 'D', 77: 'F', 79: 'H', 80: 'J', 81: 'B', 82: 'A', 84: 'G', 87: 'L'},
  'ABDFGHKL': {74: 'D', 77: 'F', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'G', 87: 'L'},
  'ABDFGIJK': {74: 'D', 77: 'G', 79: 'F', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'I'},
  'ABDFGIJL': {74: 'D', 77: 'G', 79: 'F', 80: 'I', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABDFGIKL': {74: 'D', 77: 'F', 79: 'I', 80: 'K', 81: 'B', 82: 'A', 84: 'G', 87: 'L'},
  'ABDFGJKL': {74: 'D', 77: 'G', 79: 'F', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABDFHIJK': {74: 'D', 77: 'F', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'I'},
  'ABDFHIJL': {74: 'D', 77: 'F', 79: 'H', 80: 'I', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABDFHIKL': {74: 'D', 77: 'F', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'I', 87: 'L'},
  'ABDFHJKL': {74: 'D', 77: 'F', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABDFIJKL': {74: 'D', 77: 'F', 79: 'I', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABDGHIJK': {74: 'D', 77: 'G', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'I'},
  'ABDGHIJL': {74: 'D', 77: 'G', 79: 'H', 80: 'I', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABDGHIKL': {74: 'D', 77: 'H', 79: 'I', 80: 'K', 81: 'B', 82: 'A', 84: 'G', 87: 'L'},
  'ABDGHJKL': {74: 'D', 77: 'G', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABDGIJKL': {74: 'D', 77: 'G', 79: 'I', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABDHIJKL': {74: 'D', 77: 'H', 79: 'I', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABEFGHIJ': {74: 'F', 77: 'G', 79: 'H', 80: 'I', 81: 'B', 82: 'A', 84: 'J', 87: 'E'},
  'ABEFGHIK': {74: 'F', 77: 'H', 79: 'E', 80: 'K', 81: 'B', 82: 'A', 84: 'G', 87: 'I'},
  'ABEFGHIL': {74: 'F', 77: 'H', 79: 'E', 80: 'I', 81: 'B', 82: 'A', 84: 'G', 87: 'L'},
  'ABEFGHJK': {74: 'F', 77: 'G', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'E'},
  'ABEFGHJL': {74: 'F', 77: 'G', 79: 'H', 80: 'E', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABEFGHKL': {74: 'F', 77: 'H', 79: 'E', 80: 'K', 81: 'B', 82: 'A', 84: 'G', 87: 'L'},
  'ABEFGIJK': {74: 'F', 77: 'G', 79: 'E', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'I'},
  'ABEFGIJL': {74: 'F', 77: 'G', 79: 'E', 80: 'I', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABEFGIKL': {74: 'A', 77: 'F', 79: 'E', 80: 'K', 81: 'B', 82: 'I', 84: 'G', 87: 'L'},
  'ABEFGJKL': {74: 'F', 77: 'G', 79: 'E', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABEFHIJK': {74: 'F', 77: 'H', 79: 'E', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'I'},
  'ABEFHIJL': {74: 'F', 77: 'H', 79: 'E', 80: 'I', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABEFHIKL': {74: 'F', 77: 'H', 79: 'E', 80: 'K', 81: 'B', 82: 'A', 84: 'I', 87: 'L'},
  'ABEFHJKL': {74: 'F', 77: 'H', 79: 'E', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABEFIJKL': {74: 'A', 77: 'F', 79: 'E', 80: 'K', 81: 'B', 82: 'I', 84: 'J', 87: 'L'},
  'ABEGHIJK': {74: 'A', 77: 'G', 79: 'E', 80: 'K', 81: 'B', 82: 'H', 84: 'J', 87: 'I'},
  'ABEGHIJL': {74: 'A', 77: 'G', 79: 'E', 80: 'I', 81: 'B', 82: 'H', 84: 'J', 87: 'L'},
  'ABEGHIKL': {74: 'A', 77: 'H', 79: 'E', 80: 'K', 81: 'B', 82: 'I', 84: 'G', 87: 'L'},
  'ABEGHJKL': {74: 'A', 77: 'G', 79: 'E', 80: 'K', 81: 'B', 82: 'H', 84: 'J', 87: 'L'},
  'ABEGIJKL': {74: 'A', 77: 'G', 79: 'E', 80: 'K', 81: 'B', 82: 'I', 84: 'J', 87: 'L'},
  'ABEHIJKL': {74: 'A', 77: 'H', 79: 'E', 80: 'K', 81: 'B', 82: 'I', 84: 'J', 87: 'L'},
  'ABFGHIJK': {74: 'F', 77: 'G', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'I'},
  'ABFGHIJL': {74: 'F', 77: 'G', 79: 'H', 80: 'I', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABFGHIKL': {74: 'A', 77: 'F', 79: 'H', 80: 'K', 81: 'B', 82: 'I', 84: 'G', 87: 'L'},
  'ABFGHJKL': {74: 'F', 77: 'G', 79: 'H', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABFGIJKL': {74: 'F', 77: 'G', 79: 'I', 80: 'K', 81: 'B', 82: 'A', 84: 'J', 87: 'L'},
  'ABFHIJKL': {74: 'A', 77: 'F', 79: 'H', 80: 'K', 81: 'B', 82: 'I', 84: 'J', 87: 'L'},
  'ABGHIJKL': {74: 'A', 77: 'G', 79: 'H', 80: 'K', 81: 'B', 82: 'I', 84: 'J', 87: 'L'},
  'ACDEFGHI': {74: 'C', 77: 'F', 79: 'H', 80: 'I', 81: 'E', 82: 'A', 84: 'G', 87: 'D'},
  'ACDEFGHJ': {74: 'C', 77: 'F', 79: 'H', 80: 'E', 81: 'J', 82: 'A', 84: 'G', 87: 'D'},
  'ACDEFGHK': {74: 'C', 77: 'F', 79: 'H', 80: 'K', 81: 'E', 82: 'A', 84: 'G', 87: 'D'},
  'ACDEFGHL': {74: 'C', 77: 'D', 79: 'H', 80: 'E', 81: 'F', 82: 'A', 84: 'G', 87: 'L'},
  'ACDEFGIJ': {74: 'D', 77: 'F', 79: 'C', 80: 'I', 81: 'J', 82: 'A', 84: 'G', 87: 'E'},
  'ACDEFGIK': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'E', 82: 'A', 84: 'G', 87: 'I'},
  'ACDEFGIL': {74: 'D', 77: 'F', 79: 'C', 80: 'I', 81: 'E', 82: 'A', 84: 'G', 87: 'L'},
  'ACDEFGJK': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'J', 82: 'A', 84: 'G', 87: 'E'},
  'ACDEFGJL': {74: 'D', 77: 'F', 79: 'C', 80: 'E', 81: 'J', 82: 'A', 84: 'G', 87: 'L'},
  'ACDEFGKL': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'E', 82: 'A', 84: 'G', 87: 'L'},
  'ACDEFHIJ': {74: 'C', 77: 'F', 79: 'H', 80: 'I', 81: 'E', 82: 'A', 84: 'J', 87: 'D'},
  'ACDEFHIK': {74: 'C', 77: 'D', 79: 'H', 80: 'K', 81: 'F', 82: 'A', 84: 'E', 87: 'I'},
  'ACDEFHIL': {74: 'C', 77: 'D', 79: 'H', 80: 'I', 81: 'F', 82: 'A', 84: 'E', 87: 'L'},
  'ACDEFHJK': {74: 'C', 77: 'F', 79: 'H', 80: 'K', 81: 'E', 82: 'A', 84: 'J', 87: 'D'},
  'ACDEFHJL': {74: 'C', 77: 'D', 79: 'H', 80: 'E', 81: 'F', 82: 'A', 84: 'J', 87: 'L'},
  'ACDEFHKL': {74: 'C', 77: 'D', 79: 'H', 80: 'K', 81: 'F', 82: 'A', 84: 'E', 87: 'L'},
  'ACDEFIJK': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'E', 82: 'A', 84: 'J', 87: 'I'},
  'ACDEFIJL': {74: 'D', 77: 'F', 79: 'C', 80: 'I', 81: 'E', 82: 'A', 84: 'J', 87: 'L'},
  'ACDEFIKL': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'I', 82: 'A', 84: 'E', 87: 'L'},
  'ACDEFJKL': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'E', 82: 'A', 84: 'J', 87: 'L'},
  'ACDEGHIJ': {74: 'C', 77: 'D', 79: 'H', 80: 'I', 81: 'J', 82: 'A', 84: 'G', 87: 'E'},
  'ACDEGHIK': {74: 'C', 77: 'D', 79: 'H', 80: 'K', 81: 'E', 82: 'A', 84: 'G', 87: 'I'},
  'ACDEGHIL': {74: 'C', 77: 'D', 79: 'H', 80: 'I', 81: 'E', 82: 'A', 84: 'G', 87: 'L'},
  'ACDEGHJK': {74: 'C', 77: 'D', 79: 'H', 80: 'K', 81: 'J', 82: 'A', 84: 'G', 87: 'E'},
  'ACDEGHJL': {74: 'C', 77: 'D', 79: 'H', 80: 'E', 81: 'J', 82: 'A', 84: 'G', 87: 'L'},
  'ACDEGHKL': {74: 'C', 77: 'D', 79: 'H', 80: 'K', 81: 'E', 82: 'A', 84: 'G', 87: 'L'},
  'ACDEGIJK': {74: 'C', 77: 'D', 79: 'E', 80: 'K', 81: 'J', 82: 'A', 84: 'G', 87: 'I'},
  'ACDEGIJL': {74: 'C', 77: 'D', 79: 'E', 80: 'I', 81: 'J', 82: 'A', 84: 'G', 87: 'L'},
  'ACDEGIKL': {74: 'C', 77: 'D', 79: 'E', 80: 'K', 81: 'I', 82: 'A', 84: 'G', 87: 'L'},
  'ACDEGJKL': {74: 'C', 77: 'D', 79: 'E', 80: 'K', 81: 'J', 82: 'A', 84: 'G', 87: 'L'},
  'ACDEHIJK': {74: 'C', 77: 'D', 79: 'H', 80: 'K', 81: 'E', 82: 'A', 84: 'J', 87: 'I'},
  'ACDEHIJL': {74: 'C', 77: 'D', 79: 'H', 80: 'I', 81: 'E', 82: 'A', 84: 'J', 87: 'L'},
  'ACDEHIKL': {74: 'C', 77: 'D', 79: 'H', 80: 'K', 81: 'I', 82: 'A', 84: 'E', 87: 'L'},
  'ACDEHJKL': {74: 'C', 77: 'D', 79: 'H', 80: 'K', 81: 'E', 82: 'A', 84: 'J', 87: 'L'},
  'ACDEIJKL': {74: 'C', 77: 'D', 79: 'E', 80: 'K', 81: 'I', 82: 'A', 84: 'J', 87: 'L'},
  'ACDFGHIJ': {74: 'C', 77: 'F', 79: 'H', 80: 'I', 81: 'J', 82: 'A', 84: 'G', 87: 'D'},
  'ACDFGHIK': {74: 'C', 77: 'D', 79: 'H', 80: 'K', 81: 'F', 82: 'A', 84: 'G', 87: 'I'},
  'ACDFGHIL': {74: 'C', 77: 'D', 79: 'H', 80: 'I', 81: 'F', 82: 'A', 84: 'G', 87: 'L'},
  'ACDFGHJK': {74: 'C', 77: 'F', 79: 'H', 80: 'K', 81: 'J', 82: 'A', 84: 'G', 87: 'D'},
  'ACDFGHJL': {74: 'D', 77: 'F', 79: 'C', 80: 'H', 81: 'J', 82: 'A', 84: 'G', 87: 'L'},
  'ACDFGHKL': {74: 'C', 77: 'D', 79: 'H', 80: 'K', 81: 'F', 82: 'A', 84: 'G', 87: 'L'},
  'ACDFGIJK': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'J', 82: 'A', 84: 'G', 87: 'I'},
  'ACDFGIJL': {74: 'D', 77: 'F', 79: 'C', 80: 'I', 81: 'J', 82: 'A', 84: 'G', 87: 'L'},
  'ACDFGIKL': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'I', 82: 'A', 84: 'G', 87: 'L'},
  'ACDFGJKL': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'J', 82: 'A', 84: 'G', 87: 'L'},
  'ACDFHIJK': {74: 'C', 77: 'D', 79: 'H', 80: 'K', 81: 'F', 82: 'A', 84: 'J', 87: 'I'},
  'ACDFHIJL': {74: 'C', 77: 'D', 79: 'H', 80: 'I', 81: 'F', 82: 'A', 84: 'J', 87: 'L'},
  'ACDFHIKL': {74: 'C', 77: 'D', 79: 'H', 80: 'K', 81: 'I', 82: 'A', 84: 'F', 87: 'L'},
  'ACDFHJKL': {74: 'C', 77: 'D', 79: 'H', 80: 'K', 81: 'F', 82: 'A', 84: 'J', 87: 'L'},
  'ACDFIJKL': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'I', 82: 'A', 84: 'J', 87: 'L'},
  'ACDGHIJK': {74: 'C', 77: 'D', 79: 'H', 80: 'K', 81: 'J', 82: 'A', 84: 'G', 87: 'I'},
  'ACDGHIJL': {74: 'C', 77: 'D', 79: 'H', 80: 'I', 81: 'J', 82: 'A', 84: 'G', 87: 'L'},
  'ACDGHIKL': {74: 'C', 77: 'D', 79: 'H', 80: 'K', 81: 'I', 82: 'A', 84: 'G', 87: 'L'},
  'ACDGHJKL': {74: 'C', 77: 'D', 79: 'H', 80: 'K', 81: 'J', 82: 'A', 84: 'G', 87: 'L'},
  'ACDGIJKL': {74: 'C', 77: 'D', 79: 'I', 80: 'K', 81: 'J', 82: 'A', 84: 'G', 87: 'L'},
  'ACDHIJKL': {74: 'C', 77: 'D', 79: 'H', 80: 'K', 81: 'I', 82: 'A', 84: 'J', 87: 'L'},
  'ACEFGHIJ': {74: 'C', 77: 'F', 79: 'H', 80: 'I', 81: 'J', 82: 'A', 84: 'G', 87: 'E'},
  'ACEFGHIK': {74: 'C', 77: 'F', 79: 'H', 80: 'K', 81: 'E', 82: 'A', 84: 'G', 87: 'I'},
  'ACEFGHIL': {74: 'C', 77: 'F', 79: 'H', 80: 'I', 81: 'E', 82: 'A', 84: 'G', 87: 'L'},
  'ACEFGHJK': {74: 'C', 77: 'F', 79: 'H', 80: 'K', 81: 'J', 82: 'A', 84: 'G', 87: 'E'},
  'ACEFGHJL': {74: 'C', 77: 'F', 79: 'H', 80: 'E', 81: 'J', 82: 'A', 84: 'G', 87: 'L'},
  'ACEFGHKL': {74: 'C', 77: 'F', 79: 'H', 80: 'K', 81: 'E', 82: 'A', 84: 'G', 87: 'L'},
  'ACEFGIJK': {74: 'C', 77: 'F', 79: 'E', 80: 'K', 81: 'J', 82: 'A', 84: 'G', 87: 'I'},
  'ACEFGIJL': {74: 'C', 77: 'F', 79: 'E', 80: 'I', 81: 'J', 82: 'A', 84: 'G', 87: 'L'},
  'ACEFGIKL': {74: 'C', 77: 'F', 79: 'E', 80: 'K', 81: 'I', 82: 'A', 84: 'G', 87: 'L'},
  'ACEFGJKL': {74: 'C', 77: 'F', 79: 'E', 80: 'K', 81: 'J', 82: 'A', 84: 'G', 87: 'L'},
  'ACEFHIJK': {74: 'C', 77: 'F', 79: 'H', 80: 'K', 81: 'E', 82: 'A', 84: 'J', 87: 'I'},
  'ACEFHIJL': {74: 'C', 77: 'F', 79: 'H', 80: 'I', 81: 'E', 82: 'A', 84: 'J', 87: 'L'},
  'ACEFHIKL': {74: 'C', 77: 'F', 79: 'H', 80: 'K', 81: 'I', 82: 'A', 84: 'E', 87: 'L'},
  'ACEFHJKL': {74: 'C', 77: 'F', 79: 'H', 80: 'K', 81: 'E', 82: 'A', 84: 'J', 87: 'L'},
  'ACEFIJKL': {74: 'C', 77: 'F', 79: 'E', 80: 'K', 81: 'I', 82: 'A', 84: 'J', 87: 'L'},
  'ACEGHIJK': {74: 'C', 77: 'H', 79: 'E', 80: 'K', 81: 'J', 82: 'A', 84: 'G', 87: 'I'},
  'ACEGHIJL': {74: 'C', 77: 'H', 79: 'E', 80: 'I', 81: 'J', 82: 'A', 84: 'G', 87: 'L'},
  'ACEGHIKL': {74: 'C', 77: 'H', 79: 'E', 80: 'K', 81: 'I', 82: 'A', 84: 'G', 87: 'L'},
  'ACEGHJKL': {74: 'C', 77: 'H', 79: 'E', 80: 'K', 81: 'J', 82: 'A', 84: 'G', 87: 'L'},
  'ACEGIJKL': {74: 'C', 77: 'G', 79: 'E', 80: 'K', 81: 'I', 82: 'A', 84: 'J', 87: 'L'},
  'ACEHIJKL': {74: 'C', 77: 'H', 79: 'E', 80: 'K', 81: 'I', 82: 'A', 84: 'J', 87: 'L'},
  'ACFGHIJK': {74: 'C', 77: 'F', 79: 'H', 80: 'K', 81: 'J', 82: 'A', 84: 'G', 87: 'I'},
  'ACFGHIJL': {74: 'C', 77: 'F', 79: 'H', 80: 'I', 81: 'J', 82: 'A', 84: 'G', 87: 'L'},
  'ACFGHIKL': {74: 'C', 77: 'F', 79: 'H', 80: 'K', 81: 'I', 82: 'A', 84: 'G', 87: 'L'},
  'ACFGHJKL': {74: 'C', 77: 'F', 79: 'H', 80: 'K', 81: 'J', 82: 'A', 84: 'G', 87: 'L'},
  'ACFGIJKL': {74: 'C', 77: 'F', 79: 'I', 80: 'K', 81: 'J', 82: 'A', 84: 'G', 87: 'L'},
  'ACFHIJKL': {74: 'C', 77: 'F', 79: 'H', 80: 'K', 81: 'I', 82: 'A', 84: 'J', 87: 'L'},
  'ACGHIJKL': {74: 'C', 77: 'G', 79: 'H', 80: 'K', 81: 'I', 82: 'A', 84: 'J', 87: 'L'},
  'ADEFGHIJ': {74: 'D', 77: 'F', 79: 'H', 80: 'I', 81: 'J', 82: 'A', 84: 'G', 87: 'E'},
  'ADEFGHIK': {74: 'D', 77: 'F', 79: 'H', 80: 'K', 81: 'E', 82: 'A', 84: 'G', 87: 'I'},
  'ADEFGHIL': {74: 'D', 77: 'F', 79: 'H', 80: 'I', 81: 'E', 82: 'A', 84: 'G', 87: 'L'},
  'ADEFGHJK': {74: 'D', 77: 'F', 79: 'H', 80: 'K', 81: 'J', 82: 'A', 84: 'G', 87: 'E'},
  'ADEFGHJL': {74: 'D', 77: 'F', 79: 'H', 80: 'E', 81: 'J', 82: 'A', 84: 'G', 87: 'L'},
  'ADEFGHKL': {74: 'D', 77: 'F', 79: 'H', 80: 'K', 81: 'E', 82: 'A', 84: 'G', 87: 'L'},
  'ADEFGIJK': {74: 'D', 77: 'F', 79: 'E', 80: 'K', 81: 'J', 82: 'A', 84: 'G', 87: 'I'},
  'ADEFGIJL': {74: 'D', 77: 'F', 79: 'E', 80: 'I', 81: 'J', 82: 'A', 84: 'G', 87: 'L'},
  'ADEFGIKL': {74: 'D', 77: 'F', 79: 'E', 80: 'K', 81: 'I', 82: 'A', 84: 'G', 87: 'L'},
  'ADEFGJKL': {74: 'D', 77: 'F', 79: 'E', 80: 'K', 81: 'J', 82: 'A', 84: 'G', 87: 'L'},
  'ADEFHIJK': {74: 'D', 77: 'F', 79: 'H', 80: 'K', 81: 'E', 82: 'A', 84: 'J', 87: 'I'},
  'ADEFHIJL': {74: 'D', 77: 'F', 79: 'H', 80: 'I', 81: 'E', 82: 'A', 84: 'J', 87: 'L'},
  'ADEFHIKL': {74: 'D', 77: 'F', 79: 'H', 80: 'K', 81: 'I', 82: 'A', 84: 'E', 87: 'L'},
  'ADEFHJKL': {74: 'D', 77: 'F', 79: 'H', 80: 'K', 81: 'E', 82: 'A', 84: 'J', 87: 'L'},
  'ADEFIJKL': {74: 'D', 77: 'F', 79: 'E', 80: 'K', 81: 'I', 82: 'A', 84: 'J', 87: 'L'},
  'ADEGHIJK': {74: 'D', 77: 'H', 79: 'E', 80: 'K', 81: 'J', 82: 'A', 84: 'G', 87: 'I'},
  'ADEGHIJL': {74: 'D', 77: 'H', 79: 'E', 80: 'I', 81: 'J', 82: 'A', 84: 'G', 87: 'L'},
  'ADEGHIKL': {74: 'D', 77: 'H', 79: 'E', 80: 'K', 81: 'I', 82: 'A', 84: 'G', 87: 'L'},
  'ADEGHJKL': {74: 'D', 77: 'H', 79: 'E', 80: 'K', 81: 'J', 82: 'A', 84: 'G', 87: 'L'},
  'ADEGIJKL': {74: 'D', 77: 'G', 79: 'E', 80: 'K', 81: 'I', 82: 'A', 84: 'J', 87: 'L'},
  'ADEHIJKL': {74: 'D', 77: 'H', 79: 'E', 80: 'K', 81: 'I', 82: 'A', 84: 'J', 87: 'L'},
  'ADFGHIJK': {74: 'D', 77: 'F', 79: 'H', 80: 'K', 81: 'J', 82: 'A', 84: 'G', 87: 'I'},
  'ADFGHIJL': {74: 'D', 77: 'F', 79: 'H', 80: 'I', 81: 'J', 82: 'A', 84: 'G', 87: 'L'},
  'ADFGHIKL': {74: 'D', 77: 'F', 79: 'H', 80: 'K', 81: 'I', 82: 'A', 84: 'G', 87: 'L'},
  'ADFGHJKL': {74: 'D', 77: 'F', 79: 'H', 80: 'K', 81: 'J', 82: 'A', 84: 'G', 87: 'L'},
  'ADFGIJKL': {74: 'D', 77: 'F', 79: 'I', 80: 'K', 81: 'J', 82: 'A', 84: 'G', 87: 'L'},
  'ADFHIJKL': {74: 'D', 77: 'F', 79: 'H', 80: 'K', 81: 'I', 82: 'A', 84: 'J', 87: 'L'},
  'ADGHIJKL': {74: 'D', 77: 'G', 79: 'H', 80: 'K', 81: 'I', 82: 'A', 84: 'J', 87: 'L'},
  'AEFGHIJK': {74: 'F', 77: 'H', 79: 'E', 80: 'K', 81: 'J', 82: 'A', 84: 'G', 87: 'I'},
  'AEFGHIJL': {74: 'F', 77: 'H', 79: 'E', 80: 'I', 81: 'J', 82: 'A', 84: 'G', 87: 'L'},
  'AEFGHIKL': {74: 'F', 77: 'H', 79: 'E', 80: 'K', 81: 'I', 82: 'A', 84: 'G', 87: 'L'},
  'AEFGHJKL': {74: 'F', 77: 'H', 79: 'E', 80: 'K', 81: 'J', 82: 'A', 84: 'G', 87: 'L'},
  'AEFGIJKL': {74: 'F', 77: 'G', 79: 'E', 80: 'K', 81: 'I', 82: 'A', 84: 'J', 87: 'L'},
  'AEFHIJKL': {74: 'F', 77: 'H', 79: 'E', 80: 'K', 81: 'I', 82: 'A', 84: 'J', 87: 'L'},
  'AEGHIJKL': {74: 'A', 77: 'G', 79: 'E', 80: 'K', 81: 'I', 82: 'H', 84: 'J', 87: 'L'},
  'AFGHIJKL': {74: 'F', 77: 'G', 79: 'H', 80: 'K', 81: 'I', 82: 'A', 84: 'J', 87: 'L'},
  'BCDEFGHI': {74: 'D', 77: 'F', 79: 'C', 80: 'I', 81: 'B', 82: 'H', 84: 'G', 87: 'E'},
  'BCDEFGHJ': {74: 'C', 77: 'F', 79: 'H', 80: 'E', 81: 'B', 82: 'J', 84: 'G', 87: 'D'},
  'BCDEFGHK': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'B', 82: 'H', 84: 'G', 87: 'E'},
  'BCDEFGHL': {74: 'D', 77: 'F', 79: 'C', 80: 'E', 81: 'B', 82: 'H', 84: 'G', 87: 'L'},
  'BCDEFGIJ': {74: 'D', 77: 'F', 79: 'C', 80: 'I', 81: 'B', 82: 'J', 84: 'G', 87: 'E'},
  'BCDEFGIK': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'B', 82: 'E', 84: 'G', 87: 'I'},
  'BCDEFGIL': {74: 'D', 77: 'F', 79: 'C', 80: 'I', 81: 'B', 82: 'E', 84: 'G', 87: 'L'},
  'BCDEFGJK': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'B', 82: 'J', 84: 'G', 87: 'E'},
  'BCDEFGJL': {74: 'D', 77: 'F', 79: 'C', 80: 'E', 81: 'B', 82: 'J', 84: 'G', 87: 'L'},
  'BCDEFGKL': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'B', 82: 'E', 84: 'G', 87: 'L'},
  'BCDEFHIJ': {74: 'D', 77: 'F', 79: 'C', 80: 'I', 81: 'B', 82: 'H', 84: 'J', 87: 'E'},
  'BCDEFHIK': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'B', 82: 'H', 84: 'E', 87: 'I'},
  'BCDEFHIL': {74: 'D', 77: 'F', 79: 'C', 80: 'I', 81: 'B', 82: 'H', 84: 'E', 87: 'L'},
  'BCDEFHJK': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'B', 82: 'H', 84: 'J', 87: 'E'},
  'BCDEFHJL': {74: 'D', 77: 'F', 79: 'C', 80: 'E', 81: 'B', 82: 'H', 84: 'J', 87: 'L'},
  'BCDEFHKL': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'B', 82: 'H', 84: 'E', 87: 'L'},
  'BCDEFIJK': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'B', 82: 'E', 84: 'J', 87: 'I'},
  'BCDEFIJL': {74: 'D', 77: 'F', 79: 'C', 80: 'I', 81: 'B', 82: 'E', 84: 'J', 87: 'L'},
  'BCDEFIKL': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'B', 82: 'I', 84: 'E', 87: 'L'},
  'BCDEFJKL': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'B', 82: 'E', 84: 'J', 87: 'L'},
  'BCDEGHIJ': {74: 'C', 77: 'D', 79: 'H', 80: 'I', 81: 'B', 82: 'J', 84: 'G', 87: 'E'},
  'BCDEGHIK': {74: 'C', 77: 'D', 79: 'E', 80: 'K', 81: 'B', 82: 'H', 84: 'G', 87: 'I'},
  'BCDEGHIL': {74: 'C', 77: 'D', 79: 'E', 80: 'I', 81: 'B', 82: 'H', 84: 'G', 87: 'L'},
  'BCDEGHJK': {74: 'C', 77: 'D', 79: 'H', 80: 'K', 81: 'B', 82: 'J', 84: 'G', 87: 'E'},
  'BCDEGHJL': {74: 'C', 77: 'D', 79: 'H', 80: 'E', 81: 'B', 82: 'J', 84: 'G', 87: 'L'},
  'BCDEGHKL': {74: 'C', 77: 'D', 79: 'E', 80: 'K', 81: 'B', 82: 'H', 84: 'G', 87: 'L'},
  'BCDEGIJK': {74: 'C', 77: 'D', 79: 'E', 80: 'K', 81: 'B', 82: 'J', 84: 'G', 87: 'I'},
  'BCDEGIJL': {74: 'C', 77: 'D', 79: 'E', 80: 'I', 81: 'B', 82: 'J', 84: 'G', 87: 'L'},
  'BCDEGIKL': {74: 'C', 77: 'D', 79: 'E', 80: 'K', 81: 'B', 82: 'I', 84: 'G', 87: 'L'},
  'BCDEGJKL': {74: 'C', 77: 'D', 79: 'E', 80: 'K', 81: 'B', 82: 'J', 84: 'G', 87: 'L'},
  'BCDEHIJK': {74: 'C', 77: 'D', 79: 'E', 80: 'K', 81: 'B', 82: 'H', 84: 'J', 87: 'I'},
  'BCDEHIJL': {74: 'C', 77: 'D', 79: 'E', 80: 'I', 81: 'B', 82: 'H', 84: 'J', 87: 'L'},
  'BCDEHIKL': {74: 'C', 77: 'D', 79: 'E', 80: 'K', 81: 'B', 82: 'H', 84: 'I', 87: 'L'},
  'BCDEHJKL': {74: 'C', 77: 'D', 79: 'E', 80: 'K', 81: 'B', 82: 'H', 84: 'J', 87: 'L'},
  'BCDEIJKL': {74: 'C', 77: 'D', 79: 'E', 80: 'K', 81: 'B', 82: 'I', 84: 'J', 87: 'L'},
  'BCDFGHIJ': {74: 'C', 77: 'F', 79: 'H', 80: 'I', 81: 'B', 82: 'J', 84: 'G', 87: 'D'},
  'BCDFGHIK': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'B', 82: 'H', 84: 'G', 87: 'I'},
  'BCDFGHIL': {74: 'D', 77: 'F', 79: 'C', 80: 'I', 81: 'B', 82: 'H', 84: 'G', 87: 'L'},
  'BCDFGHJK': {74: 'C', 77: 'F', 79: 'H', 80: 'K', 81: 'B', 82: 'J', 84: 'G', 87: 'D'},
  'BCDFGHJL': {74: 'D', 77: 'F', 79: 'C', 80: 'J', 81: 'B', 82: 'H', 84: 'G', 87: 'L'},
  'BCDFGHKL': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'B', 82: 'H', 84: 'G', 87: 'L'},
  'BCDFGIJK': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'B', 82: 'J', 84: 'G', 87: 'I'},
  'BCDFGIJL': {74: 'D', 77: 'F', 79: 'C', 80: 'I', 81: 'B', 82: 'J', 84: 'G', 87: 'L'},
  'BCDFGIKL': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'B', 82: 'I', 84: 'G', 87: 'L'},
  'BCDFGJKL': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'B', 82: 'J', 84: 'G', 87: 'L'},
  'BCDFHIJK': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'B', 82: 'H', 84: 'J', 87: 'I'},
  'BCDFHIJL': {74: 'D', 77: 'F', 79: 'C', 80: 'I', 81: 'B', 82: 'H', 84: 'J', 87: 'L'},
  'BCDFHIKL': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'B', 82: 'H', 84: 'I', 87: 'L'},
  'BCDFHJKL': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'B', 82: 'H', 84: 'J', 87: 'L'},
  'BCDFIJKL': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'B', 82: 'I', 84: 'J', 87: 'L'},
  'BCDGHIJK': {74: 'C', 77: 'D', 79: 'H', 80: 'K', 81: 'B', 82: 'J', 84: 'G', 87: 'I'},
  'BCDGHIJL': {74: 'C', 77: 'D', 79: 'H', 80: 'I', 81: 'B', 82: 'J', 84: 'G', 87: 'L'},
  'BCDGHIKL': {74: 'C', 77: 'D', 79: 'H', 80: 'K', 81: 'B', 82: 'I', 84: 'G', 87: 'L'},
  'BCDGHJKL': {74: 'C', 77: 'D', 79: 'H', 80: 'K', 81: 'B', 82: 'J', 84: 'G', 87: 'L'},
  'BCDGIJKL': {74: 'C', 77: 'D', 79: 'I', 80: 'K', 81: 'B', 82: 'J', 84: 'G', 87: 'L'},
  'BCDHIJKL': {74: 'C', 77: 'D', 79: 'H', 80: 'K', 81: 'B', 82: 'I', 84: 'J', 87: 'L'},
  'BCEFGHIJ': {74: 'C', 77: 'F', 79: 'H', 80: 'I', 81: 'B', 82: 'J', 84: 'G', 87: 'E'},
  'BCEFGHIK': {74: 'C', 77: 'F', 79: 'E', 80: 'K', 81: 'B', 82: 'H', 84: 'G', 87: 'I'},
  'BCEFGHIL': {74: 'C', 77: 'F', 79: 'E', 80: 'I', 81: 'B', 82: 'H', 84: 'G', 87: 'L'},
  'BCEFGHJK': {74: 'C', 77: 'F', 79: 'H', 80: 'K', 81: 'B', 82: 'J', 84: 'G', 87: 'E'},
  'BCEFGHJL': {74: 'C', 77: 'F', 79: 'H', 80: 'E', 81: 'B', 82: 'J', 84: 'G', 87: 'L'},
  'BCEFGHKL': {74: 'C', 77: 'F', 79: 'E', 80: 'K', 81: 'B', 82: 'H', 84: 'G', 87: 'L'},
  'BCEFGIJK': {74: 'C', 77: 'F', 79: 'E', 80: 'K', 81: 'B', 82: 'J', 84: 'G', 87: 'I'},
  'BCEFGIJL': {74: 'C', 77: 'F', 79: 'E', 80: 'I', 81: 'B', 82: 'J', 84: 'G', 87: 'L'},
  'BCEFGIKL': {74: 'C', 77: 'F', 79: 'E', 80: 'K', 81: 'B', 82: 'I', 84: 'G', 87: 'L'},
  'BCEFGJKL': {74: 'C', 77: 'F', 79: 'E', 80: 'K', 81: 'B', 82: 'J', 84: 'G', 87: 'L'},
  'BCEFHIJK': {74: 'C', 77: 'F', 79: 'E', 80: 'K', 81: 'B', 82: 'H', 84: 'J', 87: 'I'},
  'BCEFHIJL': {74: 'C', 77: 'F', 79: 'E', 80: 'I', 81: 'B', 82: 'H', 84: 'J', 87: 'L'},
  'BCEFHIKL': {74: 'C', 77: 'F', 79: 'E', 80: 'K', 81: 'B', 82: 'H', 84: 'I', 87: 'L'},
  'BCEFHJKL': {74: 'C', 77: 'F', 79: 'E', 80: 'K', 81: 'B', 82: 'H', 84: 'J', 87: 'L'},
  'BCEFIJKL': {74: 'C', 77: 'F', 79: 'E', 80: 'K', 81: 'B', 82: 'I', 84: 'J', 87: 'L'},
  'BCEGHIJK': {74: 'C', 77: 'G', 79: 'E', 80: 'K', 81: 'B', 82: 'H', 84: 'J', 87: 'I'},
  'BCEGHIJL': {74: 'C', 77: 'G', 79: 'E', 80: 'I', 81: 'B', 82: 'H', 84: 'J', 87: 'L'},
  'BCEGHIKL': {74: 'C', 77: 'H', 79: 'E', 80: 'K', 81: 'B', 82: 'I', 84: 'G', 87: 'L'},
  'BCEGHJKL': {74: 'C', 77: 'G', 79: 'E', 80: 'K', 81: 'B', 82: 'H', 84: 'J', 87: 'L'},
  'BCEGIJKL': {74: 'C', 77: 'G', 79: 'E', 80: 'K', 81: 'B', 82: 'I', 84: 'J', 87: 'L'},
  'BCEHIJKL': {74: 'C', 77: 'H', 79: 'E', 80: 'K', 81: 'B', 82: 'I', 84: 'J', 87: 'L'},
  'BCFGHIJK': {74: 'C', 77: 'F', 79: 'H', 80: 'K', 81: 'B', 82: 'J', 84: 'G', 87: 'I'},
  'BCFGHIJL': {74: 'C', 77: 'F', 79: 'H', 80: 'I', 81: 'B', 82: 'J', 84: 'G', 87: 'L'},
  'BCFGHIKL': {74: 'C', 77: 'F', 79: 'H', 80: 'K', 81: 'B', 82: 'I', 84: 'G', 87: 'L'},
  'BCFGHJKL': {74: 'C', 77: 'F', 79: 'H', 80: 'K', 81: 'B', 82: 'J', 84: 'G', 87: 'L'},
  'BCFGIJKL': {74: 'C', 77: 'F', 79: 'I', 80: 'K', 81: 'B', 82: 'J', 84: 'G', 87: 'L'},
  'BCFHIJKL': {74: 'C', 77: 'F', 79: 'H', 80: 'K', 81: 'B', 82: 'I', 84: 'J', 87: 'L'},
  'BCGHIJKL': {74: 'C', 77: 'G', 79: 'H', 80: 'K', 81: 'B', 82: 'I', 84: 'J', 87: 'L'},
  'BDEFGHIJ': {74: 'D', 77: 'F', 79: 'H', 80: 'I', 81: 'B', 82: 'J', 84: 'G', 87: 'E'},
  'BDEFGHIK': {74: 'D', 77: 'F', 79: 'E', 80: 'K', 81: 'B', 82: 'H', 84: 'G', 87: 'I'},
  'BDEFGHIL': {74: 'D', 77: 'F', 79: 'E', 80: 'I', 81: 'B', 82: 'H', 84: 'G', 87: 'L'},
  'BDEFGHJK': {74: 'D', 77: 'F', 79: 'H', 80: 'K', 81: 'B', 82: 'J', 84: 'G', 87: 'E'},
  'BDEFGHJL': {74: 'D', 77: 'F', 79: 'H', 80: 'E', 81: 'B', 82: 'J', 84: 'G', 87: 'L'},
  'BDEFGHKL': {74: 'D', 77: 'F', 79: 'E', 80: 'K', 81: 'B', 82: 'H', 84: 'G', 87: 'L'},
  'BDEFGIJK': {74: 'D', 77: 'F', 79: 'E', 80: 'K', 81: 'B', 82: 'J', 84: 'G', 87: 'I'},
  'BDEFGIJL': {74: 'D', 77: 'F', 79: 'E', 80: 'I', 81: 'B', 82: 'J', 84: 'G', 87: 'L'},
  'BDEFGIKL': {74: 'D', 77: 'F', 79: 'E', 80: 'K', 81: 'B', 82: 'I', 84: 'G', 87: 'L'},
  'BDEFGJKL': {74: 'D', 77: 'F', 79: 'E', 80: 'K', 81: 'B', 82: 'J', 84: 'G', 87: 'L'},
  'BDEFHIJK': {74: 'D', 77: 'F', 79: 'E', 80: 'K', 81: 'B', 82: 'H', 84: 'J', 87: 'I'},
  'BDEFHIJL': {74: 'D', 77: 'F', 79: 'E', 80: 'I', 81: 'B', 82: 'H', 84: 'J', 87: 'L'},
  'BDEFHIKL': {74: 'D', 77: 'F', 79: 'E', 80: 'K', 81: 'B', 82: 'H', 84: 'I', 87: 'L'},
  'BDEFHJKL': {74: 'D', 77: 'F', 79: 'E', 80: 'K', 81: 'B', 82: 'H', 84: 'J', 87: 'L'},
  'BDEFIJKL': {74: 'D', 77: 'F', 79: 'E', 80: 'K', 81: 'B', 82: 'I', 84: 'J', 87: 'L'},
  'BDEGHIJK': {74: 'D', 77: 'G', 79: 'E', 80: 'K', 81: 'B', 82: 'H', 84: 'J', 87: 'I'},
  'BDEGHIJL': {74: 'D', 77: 'G', 79: 'E', 80: 'I', 81: 'B', 82: 'H', 84: 'J', 87: 'L'},
  'BDEGHIKL': {74: 'D', 77: 'H', 79: 'E', 80: 'K', 81: 'B', 82: 'I', 84: 'G', 87: 'L'},
  'BDEGHJKL': {74: 'D', 77: 'G', 79: 'E', 80: 'K', 81: 'B', 82: 'H', 84: 'J', 87: 'L'},
  'BDEGIJKL': {74: 'D', 77: 'G', 79: 'E', 80: 'K', 81: 'B', 82: 'I', 84: 'J', 87: 'L'},
  'BDEHIJKL': {74: 'D', 77: 'H', 79: 'E', 80: 'K', 81: 'B', 82: 'I', 84: 'J', 87: 'L'},
  'BDFGHIJK': {74: 'D', 77: 'F', 79: 'H', 80: 'K', 81: 'B', 82: 'J', 84: 'G', 87: 'I'},
  'BDFGHIJL': {74: 'D', 77: 'F', 79: 'H', 80: 'I', 81: 'B', 82: 'J', 84: 'G', 87: 'L'},
  'BDFGHIKL': {74: 'D', 77: 'F', 79: 'H', 80: 'K', 81: 'B', 82: 'I', 84: 'G', 87: 'L'},
  'BDFGHJKL': {74: 'D', 77: 'F', 79: 'H', 80: 'K', 81: 'B', 82: 'J', 84: 'G', 87: 'L'},
  'BDFGIJKL': {74: 'D', 77: 'F', 79: 'I', 80: 'K', 81: 'B', 82: 'J', 84: 'G', 87: 'L'},
  'BDFHIJKL': {74: 'D', 77: 'F', 79: 'H', 80: 'K', 81: 'B', 82: 'I', 84: 'J', 87: 'L'},
  'BDGHIJKL': {74: 'D', 77: 'G', 79: 'H', 80: 'K', 81: 'B', 82: 'I', 84: 'J', 87: 'L'},
  'BEFGHIJK': {74: 'F', 77: 'G', 79: 'E', 80: 'K', 81: 'B', 82: 'H', 84: 'J', 87: 'I'},
  'BEFGHIJL': {74: 'F', 77: 'G', 79: 'E', 80: 'I', 81: 'B', 82: 'H', 84: 'J', 87: 'L'},
  'BEFGHIKL': {74: 'F', 77: 'H', 79: 'E', 80: 'K', 81: 'B', 82: 'I', 84: 'G', 87: 'L'},
  'BEFGHJKL': {74: 'F', 77: 'G', 79: 'E', 80: 'K', 81: 'B', 82: 'H', 84: 'J', 87: 'L'},
  'BEFGIJKL': {74: 'F', 77: 'G', 79: 'E', 80: 'K', 81: 'B', 82: 'I', 84: 'J', 87: 'L'},
  'BEFHIJKL': {74: 'F', 77: 'H', 79: 'E', 80: 'K', 81: 'B', 82: 'I', 84: 'J', 87: 'L'},
  'BEGHIJKL': {74: 'B', 77: 'G', 79: 'E', 80: 'K', 81: 'I', 82: 'H', 84: 'J', 87: 'L'},
  'BFGHIJKL': {74: 'F', 77: 'G', 79: 'H', 80: 'K', 81: 'B', 82: 'I', 84: 'J', 87: 'L'},
  'CDEFGHIJ': {74: 'D', 77: 'F', 79: 'C', 80: 'I', 81: 'J', 82: 'H', 84: 'G', 87: 'E'},
  'CDEFGHIK': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'E', 82: 'H', 84: 'G', 87: 'I'},
  'CDEFGHIL': {74: 'D', 77: 'F', 79: 'C', 80: 'I', 81: 'E', 82: 'H', 84: 'G', 87: 'L'},
  'CDEFGHJK': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'J', 82: 'H', 84: 'G', 87: 'E'},
  'CDEFGHJL': {74: 'D', 77: 'F', 79: 'C', 80: 'E', 81: 'J', 82: 'H', 84: 'G', 87: 'L'},
  'CDEFGHKL': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'E', 82: 'H', 84: 'G', 87: 'L'},
  'CDEFGIJK': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'E', 82: 'J', 84: 'G', 87: 'I'},
  'CDEFGIJL': {74: 'D', 77: 'F', 79: 'C', 80: 'I', 81: 'E', 82: 'J', 84: 'G', 87: 'L'},
  'CDEFGIKL': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'E', 82: 'I', 84: 'G', 87: 'L'},
  'CDEFGJKL': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'E', 82: 'J', 84: 'G', 87: 'L'},
  'CDEFHIJK': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'E', 82: 'H', 84: 'J', 87: 'I'},
  'CDEFHIJL': {74: 'D', 77: 'F', 79: 'C', 80: 'I', 81: 'E', 82: 'H', 84: 'J', 87: 'L'},
  'CDEFHIKL': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'I', 82: 'H', 84: 'E', 87: 'L'},
  'CDEFHJKL': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'E', 82: 'H', 84: 'J', 87: 'L'},
  'CDEFIJKL': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'E', 82: 'I', 84: 'J', 87: 'L'},
  'CDEGHIJK': {74: 'C', 77: 'D', 79: 'E', 80: 'K', 81: 'J', 82: 'H', 84: 'G', 87: 'I'},
  'CDEGHIJL': {74: 'C', 77: 'D', 79: 'E', 80: 'I', 81: 'J', 82: 'H', 84: 'G', 87: 'L'},
  'CDEGHIKL': {74: 'C', 77: 'D', 79: 'E', 80: 'K', 81: 'I', 82: 'H', 84: 'G', 87: 'L'},
  'CDEGHJKL': {74: 'C', 77: 'D', 79: 'E', 80: 'K', 81: 'J', 82: 'H', 84: 'G', 87: 'L'},
  'CDEGIJKL': {74: 'C', 77: 'D', 79: 'E', 80: 'K', 81: 'I', 82: 'J', 84: 'G', 87: 'L'},
  'CDEHIJKL': {74: 'C', 77: 'D', 79: 'E', 80: 'K', 81: 'I', 82: 'H', 84: 'J', 87: 'L'},
  'CDFGHIJK': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'J', 82: 'H', 84: 'G', 87: 'I'},
  'CDFGHIJL': {74: 'D', 77: 'F', 79: 'C', 80: 'I', 81: 'J', 82: 'H', 84: 'G', 87: 'L'},
  'CDFGHIKL': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'I', 82: 'H', 84: 'G', 87: 'L'},
  'CDFGHJKL': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'J', 82: 'H', 84: 'G', 87: 'L'},
  'CDFGIJKL': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'I', 82: 'J', 84: 'G', 87: 'L'},
  'CDFHIJKL': {74: 'D', 77: 'F', 79: 'C', 80: 'K', 81: 'I', 82: 'H', 84: 'J', 87: 'L'},
  'CDGHIJKL': {74: 'C', 77: 'D', 79: 'H', 80: 'K', 81: 'I', 82: 'J', 84: 'G', 87: 'L'},
  'CEFGHIJK': {74: 'C', 77: 'F', 79: 'E', 80: 'K', 81: 'J', 82: 'H', 84: 'G', 87: 'I'},
  'CEFGHIJL': {74: 'C', 77: 'F', 79: 'E', 80: 'I', 81: 'J', 82: 'H', 84: 'G', 87: 'L'},
  'CEFGHIKL': {74: 'C', 77: 'F', 79: 'E', 80: 'K', 81: 'I', 82: 'H', 84: 'G', 87: 'L'},
  'CEFGHJKL': {74: 'C', 77: 'F', 79: 'E', 80: 'K', 81: 'J', 82: 'H', 84: 'G', 87: 'L'},
  'CEFGIJKL': {74: 'C', 77: 'F', 79: 'E', 80: 'K', 81: 'I', 82: 'J', 84: 'G', 87: 'L'},
  'CEFHIJKL': {74: 'C', 77: 'F', 79: 'E', 80: 'K', 81: 'I', 82: 'H', 84: 'J', 87: 'L'},
  'CEGHIJKL': {74: 'C', 77: 'G', 79: 'E', 80: 'K', 81: 'I', 82: 'H', 84: 'J', 87: 'L'},
  'CFGHIJKL': {74: 'C', 77: 'F', 79: 'H', 80: 'K', 81: 'I', 82: 'J', 84: 'G', 87: 'L'},
  'DEFGHIJK': {74: 'D', 77: 'F', 79: 'E', 80: 'K', 81: 'J', 82: 'H', 84: 'G', 87: 'I'},
  'DEFGHIJL': {74: 'D', 77: 'F', 79: 'E', 80: 'I', 81: 'J', 82: 'H', 84: 'G', 87: 'L'},
  'DEFGHIKL': {74: 'D', 77: 'F', 79: 'E', 80: 'K', 81: 'I', 82: 'H', 84: 'G', 87: 'L'},
  'DEFGHJKL': {74: 'D', 77: 'F', 79: 'E', 80: 'K', 81: 'J', 82: 'H', 84: 'G', 87: 'L'},
  'DEFGIJKL': {74: 'D', 77: 'F', 79: 'E', 80: 'K', 81: 'I', 82: 'J', 84: 'G', 87: 'L'},
  'DEFHIJKL': {74: 'D', 77: 'F', 79: 'E', 80: 'K', 81: 'I', 82: 'H', 84: 'J', 87: 'L'},
  'DEGHIJKL': {74: 'D', 77: 'G', 79: 'E', 80: 'K', 81: 'I', 82: 'H', 84: 'J', 87: 'L'},
  'DFGHIJKL': {74: 'D', 77: 'F', 79: 'H', 80: 'K', 81: 'I', 82: 'J', 84: 'G', 87: 'L'},
  'EFGHIJKL': {74: 'F', 77: 'G', 79: 'E', 80: 'K', 81: 'I', 82: 'H', 84: 'J', 87: 'L'},
}

// Look up the official FIFA Annex C assignment for 8 qualified 3rd-place groups
function lookupAnnexC(qualified: string[]): Record<number, string> | null {
  const key = [...qualified].sort().join('')
  return ANNEX_C[key] ?? null
}

export function populateR32Teams(
  groupQualifiers: Record<string, [string, string, string]>,
  best8Thirds: string[],
  currentKnockout: Record<number, any>,
  TEAM_FIFA_POINTS: Record<string, number>,
  calcCategoryByRound: (a: number, b: number, round: string) => string
): { updatedKnockout: Record<number, any>; populated: number; log: string[] } {
  const knockout = { ...currentKnockout }
  const log: string[] = []
  let populated = 0

  // Build group → 3rd-place team map
  const groupOf3rd: Record<string, string> = {}  // team → group
  for (const [g, [, , third]] of Object.entries(groupQualifiers)) {
    if (third) groupOf3rd[third] = g
  }

  // Which 8 groups had a 3rd-place qualifier
  const qualifiedGroups = best8Thirds
    .map(t => groupOf3rd[t])
    .filter((g): g is string => !!g)

  if (qualifiedGroups.length < 8 && Object.keys(groupQualifiers).length < 12) {
    log.push('ℹ️ שלב הבתים לא הסתיים עדיין — R32 יאוכלס כשיהיו כל 12 הבתים')
    // Still populate the fixed (non-3rd-place) matches
  }

  // Solve 3rd-place assignment — only when all 12 groups are done
  // Full assignment from official FIFA Annex C table (all 495 combinations)
  const thirdAssignment = qualifiedGroups.length === 8
    ? lookupAnnexC(qualifiedGroups)
    : null

  // Partial: for each 3rd-place match, if only one valid group is possible → assign it early
  const THIRD_PLACE_SLOTS: Record<number, string[]> = {
    74: ['A','B','C','D','F'], 77: ['C','D','F','G','H'],
    79: ['C','E','F','H','I'], 80: ['E','H','I','J','K'],
    81: ['B','E','F','I','J'], 82: ['A','E','H','I','J'],
    84: ['E','F','G','I','J'], 87: ['D','E','I','J','L'],
  }
  const partialThirdAssignment: Record<number, string> = {}
  if (!thirdAssignment) {
    for (const [matchId, allowed] of Object.entries(THIRD_PLACE_SLOTS)) {
      const candidates = allowed.filter(g => qualifiedGroups.includes(g))
      if (candidates.length === 1) partialThirdAssignment[Number(matchId)] = candidates[0]
    }
  }

  // Resolve team name from (group, position)
  const resolve = (g: string, p: number): string | undefined =>
    groupQualifiers[g]?.[p - 1]

  if (qualifiedGroups.length === 8 && !thirdAssignment) {
    log.push('⚠️ לא ניתן לחשב שיבוץ שלישיות — בדוק נתוני standings')
  }
  for (const m of R32_BRACKET) {
    const km = { ...(knockout[m.id] ?? { id: m.id, round: 'R32' }) }

    // Determine teamA
    let tA: string | undefined
    if ('g' in m.a) {
      tA = resolve(m.a.g, m.a.p)
    }

    // Determine teamB
    let tB: string | undefined
    if ('g' in m.b) {
      tB = resolve((m.b as any).g, (m.b as any).p)
    } else if (thirdAssignment?.[m.id] ?? partialThirdAssignment[m.id]) {
      const g = thirdAssignment?.[m.id] ?? partialThirdAssignment[m.id]
      tB = resolve(g, 3)
    }

    if (!tA && !tB) continue

    let changed = false
    if (tA && km.teamA !== tA) { km.teamA = tA; changed = true }
    if (tB && km.teamB !== tB) { km.teamB = tB; changed = true }

    if (changed) {
      // Update category only when both teams are known
      if (km.teamA && km.teamB) {
        const ptA = TEAM_FIFA_POINTS[km.teamA] ?? 1500
        const ptB = TEAM_FIFA_POINTS[km.teamB] ?? 1500
        km.fifaPointsA = ptA
        km.fifaPointsB = ptB
        km.category = calcCategoryByRound(ptA, ptB, km.round ?? 'R32')
        log.push(`✅ משחק ${m.id}: ${km.teamA} vs ${km.teamB} (${km.category})`)
      } else {
        const known = km.teamA ?? km.teamB
        log.push(`⏳ משחק ${m.id}: ${known} (ממתין לנבחרת השנייה)`)
      }
      knockout[m.id] = km
      populated++
    }
  }

  if (populated > 0) log.push(`🎯 אוכלס R32: ${populated} משחקים`)
  return { updatedKnockout: knockout, populated, log }
}
