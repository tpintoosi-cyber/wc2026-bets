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
