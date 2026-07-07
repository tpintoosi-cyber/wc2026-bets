import { useState, useEffect } from 'react'
import { doc, getDoc, setDoc, collection, getDocs, writeBatch, updateDoc, deleteDoc } from 'firebase/firestore'
import { db } from '../firebase'
import { MATCHES, GROUPS_TEAMS, TEAM_EN, BONUS_QUESTIONS, KNOCKOUT_MATCHES, KNOCKOUT_BRACKET, KNOCKOUT_ROUND_LABELS, ALL_TEAMS, TEAM_FIFA_POINTS, calcCategoryByRound } from '../data/matches'
import { computeUserScore } from '../scoring'
import { Match, Group, GroupPrediction, BonusPredictions, MatchPrediction, KnockoutMatch } from '../types'
import { fetchGroupStageMatches, fetchKnockoutMatches, fetchAllMatches, toIsraelTime } from '../services/wc2026api'
import { fetchAllFixtures, fetchStandings, getKnockoutResult, parseStandings, isConfigured as isApiFootballConfigured, type ApiFootballFixture } from '../services/apifootball'
import { fetchZafronixMatches, buildTopScorers, buildTopAssists, countRedCards, getRegulationScore, ZAFRONIX_TO_HE } from '../services/zafronix'
import { populateR32Teams } from '../utils/syncLogic'
import AdminTestPanel from './AdminTestPanel'

const GROUPS = 'ABCDEFGHIJKL'.split('') as Group[]

const EN_TO_HE_MAP: Record<string, string> = {}
for (const [he, en] of Object.entries(TEAM_EN)) {
  EN_TO_HE_MAP[en.toLowerCase()] = he
}
for (const [en, he] of Object.entries(ZAFRONIX_TO_HE)) {
  EN_TO_HE_MAP[en.toLowerCase()] = he
}

// Propagate advanceTeam winners into the next round's team slots via KNOCKOUT_BRACKET.
// Used both by the manual "save knockout" action and automatically at the end of a sync,
// so QF/SF/F teams fill in as soon as the feeding round has an advanceTeam.
function propagateKnockout(input: Record<number, any>): Record<number, any> {
  const propagated: Record<number, any> = { ...input }
  for (const [id] of Object.entries(propagated)) {
    const m = propagated[Number(id)] as any
    if (!m?.advanceTeam) continue
    const b = KNOCKOUT_BRACKET[Number(id)]
    if (!b) continue
    for (const [nextId] of Object.entries(propagated)) {
      const nb = KNOCKOUT_BRACKET[Number(nextId)]
      if (!nb) continue
      if (nb.feederA === Number(id)) propagated[Number(nextId)] = { ...propagated[Number(nextId)], teamA: m.advanceTeam, fifaPointsA: TEAM_FIFA_POINTS[m.advanceTeam] ?? 1500 }
      if (nb.feederB === Number(id)) propagated[Number(nextId)] = { ...propagated[Number(nextId)], teamB: m.advanceTeam, fifaPointsB: TEAM_FIFA_POINTS[m.advanceTeam] ?? 1500 }
      if (nb.feederA === -Number(id)) { const loser = m.teamA === m.advanceTeam ? m.teamB : m.teamA; if (loser) propagated[Number(nextId)] = { ...propagated[Number(nextId)], teamA: loser, fifaPointsA: TEAM_FIFA_POINTS[loser] ?? 1500 } }
      if (nb.feederB === -Number(id)) { const loser = m.teamA === m.advanceTeam ? m.teamB : m.teamA; if (loser) propagated[Number(nextId)] = { ...propagated[Number(nextId)], teamB: loser, fifaPointsB: TEAM_FIFA_POINTS[loser] ?? 1500 } }
    }
  }
  return propagated
}

const API_ALIASES: Record<string, string> = {
  'korea republic': 'south korea',
  'bosnia-herzegovina': 'bosnia',
  "côte d'ivoire": 'ivory coast',
  'cabo verde': 'cape verde',
  'ir iran': 'iran',
  'congo dr': 'dr congo',
  'czechia': 'czech republic',
}

export default function Admin() {
  const stripUndefined = (obj: Record<string, any>): Record<string, any> =>
    Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined))
  const sanitizeMatches = (m: Record<number | string, any>): Record<number, any> => {
    const out: Record<number, any> = {}
    for (const [id, v] of Object.entries(m)) out[Number(id)] = stripUndefined(v as Record<string, any>)
    return out
  }

  const [matches, setMatches] = useState<Record<number, Match>>({})
  const [actualGroups, setActualGroups] = useState<Record<string, [string, string, string]>>({})
  const [actualBonus, setActualBonus] = useState<Partial<BonusPredictions>>({})
  const [liveStats, setLiveStats] = useState<{ topScorer?: string; topScorerGoals?: string; topAssist?: string; totalRedCards?: string }>({})
  const [settings, setSettings] = useState({
    isOpen: true, deadline: '',
    knockoutOpen: false, knockoutDeadline: '',
    r16Deadline: '', qfDeadline: '', sfDeadline: '', p3Deadline: '', finalDeadline: '',
    mockNow: '', liveMode: false, maintenanceMode: false,
  })
  const [blindfoldUsers, setBlindfoldUsers] = useState<string[]>([])
  const [allUsersList, setAllUsersList] = useState<{uid: string, name: string}[]>([])
  const [scoring, setScoring] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [msg, setMsg] = useState('')
  const [apiDebug, setApiDebug] = useState('')
  const [syncLog, setSyncLog] = useState<string[]>([])
  const [knockoutMatches, setKnockoutMatches] = useState<Record<number, KnockoutMatch>>({})
  const [adminTab, setAdminTab] = useState<'group' | 'knockout' | 'users' | 'test'>('group')
  const [pendingUsers, setPendingUsers] = useState<{ uid: string; displayName: string; email: string; requestedAt: number; status: string }[]>([])
  const [usersLoading, setUsersLoading] = useState(false)
  const [koCompletion, setKoCompletion] = useState<{ userId: string; userName: string; missing1x2: number; missingAdvance: number; missingTotal: number }[]>([])
  const [koCompLoading, setKoCompLoading] = useState(false)

  useEffect(() => {
    ;(async () => {
      const [resultsSnap, settingsSnap, koSnap, liveSnap] = await Promise.all([
        getDoc(doc(db, 'admin', 'results')),
        getDoc(doc(db, 'settings', 'app')),
        getDoc(doc(db, 'admin', 'knockout')),
        getDoc(doc(db, 'admin', 'liveStats')),
      ])
      if (resultsSnap.exists()) {
        const stored = resultsSnap.data().matches ?? {}
        const fresh: Record<number, Match> = {}
        for (const m of MATCHES) {
          const s = stored[m.id]
          fresh[m.id] = { ...m, ...(s ? { resultA: s.resultA, resultB: s.resultB, isPlayed: s.isPlayed, hadRedCard: s.hadRedCard } : {}) }
        }
        setMatches(fresh)
        setActualGroups(resultsSnap.data().groups ?? {})
        setActualBonus(resultsSnap.data().bonus ?? {})
      }
      if (settingsSnap.exists()) {
        const d = settingsSnap.data()
        setSettings({
          isOpen: d.isOpen ?? true,
          deadline: d.deadline ? new Date(d.deadline).toISOString().slice(0, 16) : '',
          knockoutOpen: d.knockoutOpen ?? false,
          knockoutDeadline: d.knockoutDeadline ? new Date(d.knockoutDeadline).toISOString().slice(0, 16) : '',
          r16Deadline:   d.r16Deadline   ? new Date(d.r16Deadline).toISOString().slice(0, 16)   : '',
          qfDeadline:    d.qfDeadline    ? new Date(d.qfDeadline).toISOString().slice(0, 16)    : '',
          sfDeadline:    d.sfDeadline    ? new Date(d.sfDeadline).toISOString().slice(0, 16)    : '',
          p3Deadline:    d.p3Deadline    ? new Date(d.p3Deadline).toISOString().slice(0, 16)    : '',
          finalDeadline: d.finalDeadline ? new Date(d.finalDeadline).toISOString().slice(0, 16) : '',
          mockNow:       d.mockNow       ? new Date(d.mockNow).toISOString().slice(0, 16)       : '',
          liveMode: d.liveMode ?? false,
          maintenanceMode: d.maintenanceMode ?? false,
        })
        setBlindfoldUsers(d.blindfoldUsers ?? [])
      }
      // טען רשימת משתמשים
      const usersListSnap = await getDocs(collection(db, 'users'))
      setAllUsersList(usersListSnap.docs.map(d => ({ uid: d.id, name: d.data().name ?? d.id })))
      if (koSnap.exists()) setKnockoutMatches(koSnap.data().matches ?? {})
      if (liveSnap.exists()) setLiveStats(liveSnap.data() ?? {})
    })()
  }, [])

  // ── Debug helpers ─────────────────────────────────────────────────────────
  const checkKnockoutApi = async () => {
    setApiDebug('⏳ מושך מ-wc2026api...')
    try {
      const all = await fetchAllMatches()
      const rounds = [...new Set(all.map((m: any) => String(m.round)))]
      const ko = all.filter((m: any) => m.round !== 'group')
      const completed = ko.filter((m: any) => m.status === 'completed')
      const scheduled = ko.find((m: any) => m.status !== 'completed')
      let debug = `=== wc2026api ===\nסה"כ: ${all.length} | נוקאאוט: ${ko.length} | completed: ${completed.length}\nrounds: ${rounds.join(', ')}`
      if (completed.length > 0) debug += `\n\nדוגמה completed:\n${JSON.stringify(completed[0], null, 2)}`
      if (scheduled) debug += `\n\nדוגמה scheduled:\n${JSON.stringify(scheduled, null, 2)}`
      setApiDebug(debug)
    } catch (e) { setApiDebug(`שגיאה wc2026api: ${(e as Error).message}`) }
  }

  const checkApiFootball = async () => {
    setApiDebug(prev => prev + '\n\n⏳ מושך מ-API-Football...')
    try {
      const fixtures = await fetchAllFixtures()
      const completed = fixtures.filter((f: any) => ['FT', 'AET', 'PEN'].includes(f.fixture.status.short))
      const koFixtures = completed.filter((f: any) => !((f.league?.round ?? '').toLowerCase().includes('group')))
      let debug = `=== API-Football ===\nסה"כ: ${fixtures.length} | completed: ${completed.length} | נוקאאוט: ${koFixtures.length}`
      if (koFixtures.length > 0) {
        debug += `\n\nדוגמה:\n${JSON.stringify({ home: koFixtures[0].teams.home.name, away: koFixtures[0].teams.away.name, status: koFixtures[0].fixture.status.short, round: (koFixtures[0] as any).league?.round, score: koFixtures[0].score }, null, 2)}`
      }
      setApiDebug(prev => prev + '\n\n' + debug)
    } catch (e) { setApiDebug(prev => prev + `\n\nשגיאה: ${(e as Error).message}`) }
  }

  const checkZafronix = async () => {
    setApiDebug(prev => prev + '\n\n⏳ מושך מ-Zafronix...')
    try {
      const zMatches = await fetchZafronixMatches()
      const finished = zMatches.filter(m => m.status === 'finished')
      const scorers = buildTopScorers(zMatches).slice(0, 3)
      const assists = buildTopAssists(zMatches).slice(0, 3)
      const reds = countRedCards(zMatches)
      let debug = `=== Zafronix ===\nסה"כ: ${zMatches.length} | finished: ${finished.length} | אדומים (גולמי, כל 2026): ${reds}`
      debug += `\n\nמלך שערים: ${scorers.map(s => `${s.name} (${s.goals})`).join(', ')}`
      debug += `\nמלך בישולים: ${assists.map(a => `${a.name} (${a.assists})`).join(', ')}`
      // Show sample finished match with cards
      const withCards = finished.find(m => m.cards && m.cards.length > 0)
      if (withCards) debug += `\n\nדוגמה עם קלפים (matchNo=${withCards.matchNo}):\nhome=${withCards.homeTeam} away=${withCards.awayTeam}\ncards=${JSON.stringify(withCards.cards)}`
      setApiDebug(prev => prev + '\n\n' + debug)
    } catch (e) { setApiDebug(prev => prev + `\n\nשגיאה Zafronix: ${(e as Error).message}`) }
  }

  // ── Main sync ─────────────────────────────────────────────────────────────
  const syncFromApi = async () => {
    setSyncing(true)
    setSyncLog([])
    const log: string[] = []
    try {
      log.push('⏳ מושך נתונים מ-wc2026api.com...')
      setSyncLog([...log])

      const [apiGroupMatches, apiKnockoutMatches] = await Promise.all([
        fetchGroupStageMatches(),
        fetchKnockoutMatches(),
      ])
      log.push(`✅ התקבלו ${apiGroupMatches.length} משחקי בתים + ${apiKnockoutMatches.length} משחקי נוקאאוט`)
      setSyncLog([...log])

      // ── Group stage ──────────────────────────────────────────────
      const updatedMatches: Record<number, Match> = {}
      for (const m of MATCHES) {
        updatedMatches[m.id] = { ...m, ...(matches[m.id] ? {
          resultA: matches[m.id].resultA, resultB: matches[m.id].resultB,
          isPlayed: matches[m.id].isPlayed, hadRedCard: matches[m.id].hadRedCard,
        } : {}) }
      }
      let updatedSchedule = 0, updatedResults = 0
      for (const apiMatch of apiGroupMatches) {
        const normHome = API_ALIASES[apiMatch.home_team?.toLowerCase()] ?? apiMatch.home_team?.toLowerCase()
        const normAway = API_ALIASES[apiMatch.away_team?.toLowerCase()] ?? apiMatch.away_team?.toLowerCase()
        const homeHe = EN_TO_HE_MAP[normHome] ?? apiMatch.home_team
        const awayHe = EN_TO_HE_MAP[normAway] ?? apiMatch.away_team
        const ourMatch = MATCHES.find(m => (m.teamA === homeHe && m.teamB === awayHe) || (m.teamA === awayHe && m.teamB === homeHe))
        if (!ourMatch) continue
        const current = updatedMatches[ourMatch.id] ?? { ...ourMatch }
        const isReversed = ourMatch.teamA === awayHe
        if (apiMatch.kickoff_utc) { (current as any).scheduleIL = toIsraelTime(apiMatch.kickoff_utc); updatedSchedule++ }
        if (apiMatch.status === 'completed' && apiMatch.home_score !== null && apiMatch.away_score !== null) {
          if ((matches[ourMatch.id] as any)?.manualScore) { log.push(`🔒 #${ourMatch.id} — נשמר ידנית`) }
          else {
            current.resultA = isReversed ? apiMatch.away_score : apiMatch.home_score
            current.resultB = isReversed ? apiMatch.home_score : apiMatch.away_score
            current.isPlayed = true
            updatedResults++
          }
        }
        updatedMatches[ourMatch.id] = current as Match
      }

      // ── Knockout results ─────────────────────────────────────────
      let updatedKnockout = { ...knockoutMatches }
      let koUpdated = 0, koPenalties = 0
      for (const apiMatch of apiKnockoutMatches) {
        if (apiMatch.status !== 'completed') continue
        if (apiMatch.home_score === null || apiMatch.away_score === null) continue
        const normHome = API_ALIASES[apiMatch.home_team?.toLowerCase()] ?? apiMatch.home_team?.toLowerCase()
        const normAway = API_ALIASES[apiMatch.away_team?.toLowerCase()] ?? apiMatch.away_team?.toLowerCase()
        const homeHe = EN_TO_HE_MAP[normHome] ?? apiMatch.home_team
        const awayHe = EN_TO_HE_MAP[normAway] ?? apiMatch.away_team
        // Match by team names, not by ID
        const entry = Object.entries(updatedKnockout).find(([, km]: [string, any]) =>
          (km.teamA === homeHe && km.teamB === awayHe) || (km.teamA === awayHe && km.teamB === homeHe)
        )
        if (!entry) { log.push(`⚠️ נוקאאוט לא נמצא: ${homeHe} vs ${awayHe}`); continue }
        const km = { ...entry[1] } as any
        if (km.manualScore) continue
        const isReversed = km.teamA === awayHe
        km.resultA = isReversed ? apiMatch.away_score : apiMatch.home_score
        km.resultB = isReversed ? apiMatch.home_score : apiMatch.away_score
        if ((apiMatch as any).home_pen != null && (apiMatch as any).away_pen != null) {
          km.penA = isReversed ? (apiMatch as any).away_pen : (apiMatch as any).home_pen
          km.penB = isReversed ? (apiMatch as any).home_pen : (apiMatch as any).away_pen
        }
        km.isPlayed = true
        if (km.teamA && km.teamB) {
          const ptA = TEAM_FIFA_POINTS[km.teamA] ?? 1500
          const ptB = TEAM_FIFA_POINTS[km.teamB] ?? 1500
          km.fifaPointsA = ptA; km.fifaPointsB = ptB
          km.category = calcCategoryByRound(ptA, ptB, km.round)
        }
        if (!km.advanceTeam) {
          if ((apiMatch as any).home_pen != null && (apiMatch as any).away_pen != null) {
            const penWinnerIsHome = (apiMatch as any).home_pen > (apiMatch as any).away_pen
            km.advanceTeam = isReversed ? (penWinnerIsHome ? km.teamB : km.teamA) : (penWinnerIsHome ? km.teamA : km.teamB)
          } else if (km.resultA !== km.resultB) {
            km.advanceTeam = km.resultA > km.resultB ? km.teamA : km.teamB
          } else { koPenalties++ }
        }
        updatedKnockout[Number(entry[0])] = km
        koUpdated++
      }

      log.push(`📅 עודכנו ${updatedSchedule} שעות משחק`)
      log.push(`⚽ עודכנו ${updatedResults} תוצאות שלב בתים`)
      log.push(`🏆 עודכנו ${koUpdated} תוצאות נוקאאוט`)
      if (koPenalties > 0) log.push(`⚠️ ${koPenalties} תיקו — יש להגדיר "מי עלה" ידנית`)

      // ── Zafronix: red cards + live stats ────────────────────────
      // NOTE: stats go to admin/liveStats only — NOT to actualBonus.
      // Bonus scoring happens only when admin manually sets bonus answers after tournament ends.
      log.push('🔄 מושך נתונים מ-Zafronix...')
      setSyncLog([...log])
      let redCardsUpdated = 0
      const newLiveStats: typeof liveStats = {}
      try {
        const zMatches = await fetchZafronixMatches()

        // Red cards — match by team names (not matchNo, which differs between APIs).
        // The loop UPDATES the per-match count from the feed (a match can have several
        // reds, e.g. 3). The tournament total is computed AFTER the loop from the
        // accumulated per-match data (see below) — NOT from this snapshot — so a red that
        // was recorded in an earlier sync is never lost if the feed later drops it.
        for (const zm of zMatches) {
          if (zm.status !== 'finished' || !zm.cards) continue
          const redCount = zm.cards.filter(c => c.color === 'red').length
          if (redCount === 0) continue

          const homeHe = ZAFRONIX_TO_HE[zm.homeTeam ?? ''] ?? zm.homeTeam ?? ''
          const awayHe = ZAFRONIX_TO_HE[zm.awayTeam ?? ''] ?? zm.awayTeam ?? ''

          // Group stage (match by team names)
          const groupMatch = MATCHES.find(m =>
            (m.teamA === homeHe && m.teamB === awayHe) || (m.teamA === awayHe && m.teamB === homeHe)
          )
          if (groupMatch) {
            const cur = updatedMatches[groupMatch.id]
            // Never lower a count that's already stored (guards against a flaky feed
            // that temporarily reports fewer/zero reds for a match).
            const newCount = Math.max(redCount, cur?.redCardCount ?? 0)
            if (cur && (cur.hadRedCard !== true || cur.redCardCount !== newCount)) {
              cur.hadRedCard = true
              cur.redCardCount = newCount
              redCardsUpdated++
            }
            continue
          }

          // Knockout (match by team names) — only for played matches
          const koEntry = Object.entries(updatedKnockout).find(([, km]: [string, any]) =>
            (km.teamA === homeHe && km.teamB === awayHe) || (km.teamA === awayHe && km.teamB === homeHe)
          )
          if (koEntry) {
            const km = koEntry[1] as any
            if (km.isPlayed) {
              const newCount = Math.max(redCount, km.redCardCount ?? 0)
              if (km.hadRedCard !== true || km.redCardCount !== newCount) {
                km.hadRedCard = true
                km.redCardCount = newCount
                redCardsUpdated++
              }
              updatedKnockout[Number(koEntry[0])] = km
            }
          }
        }

        // ── Knockout 90-minute (regulation) scores from Zafronix ──────
        // wc2026api reports the final post-ET score as "FT" (e.g. #86 Argentina–Cabo
        // Verde shows 3-2 though the 90' result was 1-1), so ET matches were stored with
        // their 120' score. The 1X2 and exact-score bets are judged on the 90' result;
        // advanceTeam (the eventual winner) is left untouched. Zafronix has a minute per
        // goal, so getRegulationScore counts goals scored in the first 90 minutes.
        let ko90Fixed = 0
        for (const zm of zMatches) {
          if (zm.status !== 'finished') continue
          const homeHe = ZAFRONIX_TO_HE[zm.homeTeam ?? ''] ?? zm.homeTeam ?? ''
          const awayHe = ZAFRONIX_TO_HE[zm.awayTeam ?? ''] ?? zm.awayTeam ?? ''
          const koEntry = Object.entries(updatedKnockout).find(([, km]: [string, any]) =>
            (km.teamA === homeHe && km.teamB === awayHe) || (km.teamA === awayHe && km.teamB === homeHe)
          )
          if (!koEntry) continue
          const km = koEntry[1] as any
          if (!km.isPlayed || km.manualScore) continue
          const reg = getRegulationScore(zm)
          if (!reg) continue
          const isRev = km.teamA === awayHe
          const r90A = isRev ? reg.away : reg.home
          const r90B = isRev ? reg.home : reg.away
          if (km.resultA !== r90A || km.resultB !== r90B) {
            km.resultA = r90A
            km.resultB = r90B
            updatedKnockout[Number(koEntry[0])] = km
            ko90Fixed++
            log.push(`⏱️ 90' תוקן: ${km.teamA} ${r90A}-${r90B} ${km.teamB} (עלתה: ${km.advanceTeam ?? '—'})`)
          }
        }
        if (ko90Fixed > 0) log.push(`⏱️ סה"כ תוצאות 90 דקות תוקנו מ-Zafronix: ${ko90Fixed}`)

        // Tournament red-card TOTAL — summed from the accumulated per-match data
        // (redCardCount, falling back to hadRedCard=1 for matches marked before counts
        // existed). This union of everything ever recorded is stable and never drops just
        // because the current Zafronix snapshot is missing a match's reds.
        const sumReds = (obj: Record<number, any>) =>
          Object.values(obj).reduce((s, m: any) => s + (m?.redCardCount ?? (m?.hadRedCard ? 1 : 0)), 0)
        const totalReds = sumReds(updatedMatches) + sumReds(updatedKnockout)

        // Live stats — saved separately, NOT used for scoring yet
        const topScorers = buildTopScorers(zMatches)
        const topAssists = buildTopAssists(zMatches)

        if (topScorers.length > 0) {
          newLiveStats.topScorer = topScorers[0].name
          newLiveStats.topScorerGoals = String(topScorers[0].goals)
        }
        if (topAssists.length > 0) newLiveStats.topAssist = topAssists[0].name
        // Keep both fields in sync (display reads totalRedCards_num first).
        newLiveStats.totalRedCards = String(totalReds)
        // Also save full arrays for StatsCharts display
        ;(newLiveStats as any).topScorers = topScorers.slice(0, 10)
        ;(newLiveStats as any).topAssists = topAssists.slice(0, 10)
        ;(newLiveStats as any).totalRedCards_num = totalReds

        log.push(`🟥 כרטיסים אדומים: ${redCardsUpdated} משחקים עודכנו`)
        log.push(`⚽ מלך שערים (לייב): ${topScorers[0]?.name ?? '—'} (${topScorers[0]?.goals ?? 0})`)
        log.push(`🎯 מלך בישולים (לייב): ${topAssists[0]?.name ?? '—'} (${topAssists[0]?.assists ?? 0})`)
        log.push(`🟥 סה"כ אדומים (לייב): ${totalReds}`)
        log.push(`ℹ️ סטטיסטיקות לייב נשמרות בנפרד — ניקוד בונוס יחושב רק בסוף הטורניר`)
      } catch (e) {
        log.push(`⚠️ Zafronix: ${(e as Error).message}`)
      }

      // ── API-Football: standings ──────────────────────────────────
      if (isApiFootballConfigured()) {
        log.push('🔄 standings מ-API-Football...')
        setSyncLog([...log])
        try {
          const standings = await fetchStandings()
          if (standings.length > 0) {
            const { groupQualifiers, best8Thirds } = parseStandings(standings, EN_TO_HE_MAP)
            if (Object.keys(groupQualifiers).length > 0) {
              for (const [g, teams] of Object.entries(groupQualifiers)) {
                if (teams[0]) setActualGroups(prev => ({ ...prev, [g]: teams }))
              }
              const { updatedKnockout: koWithR32, populated, log: r32Log } =
                populateR32Teams(groupQualifiers, best8Thirds, updatedKnockout, TEAM_FIFA_POINTS, calcCategoryByRound)
              if (populated > 0) { updatedKnockout = koWithR32; r32Log.forEach(l => log.push(l)) }
              log.push(`🏅 עודכנו עולות (${Object.keys(groupQualifiers).length} בתים)`)
              await setDoc(doc(db, 'admin', 'results'), {
                matches: sanitizeMatches(updatedMatches),
                groups: { ...actualGroups, ...groupQualifiers },
                bonus: actualBonus,
              }, { merge: true })
            }
          }
        } catch (e) { log.push(`⚠️ API-Football: ${(e as Error).message}`) }
      }

      // ── Save all ─────────────────────────────────────────────────
      // Propagate R16/QF/SF winners into the next round's team slots. Previously this
      // only happened on the manual "save knockout" action, so QF teams stayed empty if
      // a round finished between manual saves (e.g. #98/#99 showed nothing / wrong teams).
      const beforeProp = JSON.stringify(updatedKnockout)
      updatedKnockout = propagateKnockout(updatedKnockout)
      if (JSON.stringify(updatedKnockout) !== beforeProp) log.push('🌳 נבחרות הועברו לשלב הבא (propagation)')

      setMatches({ ...updatedMatches })
      setKnockoutMatches({ ...updatedKnockout })
      setLiveStats(newLiveStats)

      await Promise.all([
        setDoc(doc(db, 'admin', 'results'), { matches: sanitizeMatches(updatedMatches), groups: actualGroups, bonus: actualBonus }, { merge: true }),
        setDoc(doc(db, 'admin', 'knockout'), { matches: updatedKnockout }),
        setDoc(doc(db, 'admin', 'liveStats'), {
          topScorer: newLiveStats.topScorer ?? null,
          topScorerGoals: newLiveStats.topScorerGoals ?? null,
          topAssist: newLiveStats.topAssist ?? null,
          totalRedCards: newLiveStats.totalRedCards ?? null,
          topScorers: (newLiveStats as any).topScorers ?? [],
          topAssists: (newLiveStats as any).topAssists ?? [],
          totalRedCards_num: (newLiveStats as any).totalRedCards_num ?? 0,
          updatedAt: Date.now(),
        }),
      ])

      const scheduleMap: Record<number, string> = {}
      for (const [id, m] of Object.entries(updatedMatches)) {
        if ((m as any).scheduleIL) scheduleMap[Number(id)] = (m as any).scheduleIL
      }
      await setDoc(doc(db, 'admin', 'schedule'), { schedule: scheduleMap })
      log.push('💾 נשמר ב-Firestore')

      // ── Recalc ───────────────────────────────────────────────────
      if (updatedResults > 0 || koUpdated > 0 || redCardsUpdated > 0) {
        log.push('🔄 מחשב ניקוד...')
        setSyncLog([...log])
        await recalcAllScores(updatedMatches, true)
        log.push('🏆 ניקוד עודכן!')
      }
      log.push('✅ סנכרון הושלם!')
      setMsg(`✓ סנכרון הצליח — ${updatedResults} בתים, ${koUpdated} נוקאאוט, ${redCardsUpdated} אדומים`)
    } catch (e) {
      log.push(`❌ שגיאה: ${(e as Error).message}`)
      setMsg('שגיאה: ' + (e as Error).message)
    }
    setSyncLog([...log])
    setSyncing(false)
    setTimeout(() => setMsg(''), 6000)
  }

  // ── Users ─────────────────────────────────────────────────────────────────
  const loadPendingUsers = async () => {
    setUsersLoading(true)
    const snap = await getDocs(collection(db, 'pendingUsers'))
    const users = snap.docs.map(d => d.data() as { uid: string; displayName: string; email: string; requestedAt: number; status: string })
    users.sort((a, b) => a.requestedAt - b.requestedAt)
    setPendingUsers(users)
    setUsersLoading(false)
  }

  const loadKoCompletion = async () => {
    setKoCompLoading(true)
    try {
      const [predsSnap, koSnap] = await Promise.all([
        getDocs(collection(db, 'predictions')),
        getDoc(doc(db, 'admin', 'knockout')),
      ])
      const koMatches = koSnap.exists() ? (koSnap.data().matches ?? {}) : {}
      const openKoIds = KNOCKOUT_MATCHES
        .filter(km => (koMatches[km.id] as any)?.teamA && (koMatches[km.id] as any)?.teamB)
        .map(km => km.id)

      const completion = predsSnap.docs.map(d => {
        const data = d.data()
        const koPreds = data.knockout ?? {}
        const missing1x2 = openKoIds.filter(id => !koPreds[id]?.prediction1X2).length
        const missingAdvance = openKoIds.filter(id => !koPreds[id]?.advance).length
        return {
          userId: d.id,
          userName: data.userName ?? d.id,
          missing1x2,
          missingAdvance,
          missingTotal: missing1x2 + missingAdvance,
        }
      }).filter(u => u.missingTotal > 0)
        .sort((a, b) => b.missingTotal - a.missingTotal)
      setKoCompletion(completion)
    } catch (e) { console.error(e) }
    setKoCompLoading(false)
  }

  const approveUser = async (uid: string, displayName: string, email: string) => {
    await updateDoc(doc(db, 'pendingUsers', uid), { status: 'approved' })
    await setDoc(doc(db, 'users', uid), { name: displayName, email, joinedAt: Date.now() })
    setPendingUsers(prev => prev.map(u => u.uid === uid ? { ...u, status: 'approved' } : u))
  }

  const rejectUser = async (uid: string) => {
    await updateDoc(doc(db, 'pendingUsers', uid), { status: 'rejected' })
    setPendingUsers(prev => prev.map(u => u.uid === uid ? { ...u, status: 'rejected' } : u))
  }

  const removeUser = async (uid: string) => {
    if (!confirm('להסיר משתמש זה לגמרי?')) return
    await deleteDoc(doc(db, 'pendingUsers', uid))
    try { await deleteDoc(doc(db, 'users', uid)) } catch {}
    setPendingUsers(prev => prev.filter(u => u.uid !== uid))
  }

  const removeAllRejected = async () => {
    const rejected = pendingUsers.filter(u => u.status === 'rejected')
    if (rejected.length === 0) return
    if (!confirm(`להסיר ${rejected.length} משתמשים נדחים?`)) return
    await Promise.all(rejected.map(async u => {
      await deleteDoc(doc(db, 'pendingUsers', u.uid))
      try { await deleteDoc(doc(db, 'users', u.uid)) } catch {}
    }))
    setPendingUsers(prev => prev.filter(u => u.status !== 'rejected'))
  }

  // ── Scoring ───────────────────────────────────────────────────────────────
  const recalcAllScores = async (matchData?: Record<number, Match>, hasNewResults = false) => {
    const data = matchData ?? matches
    const usersSnap = await getDocs(collection(db, 'predictions'))
    const playedMatches = MATCHES.map(m => ({ ...m, ...(data[m.id] ?? {}) })).filter(m => m.isPlayed)

    const currentScoresSnap = await getDocs(collection(db, 'scores'))
    const currentTotals: Record<string, number> = {}
    const currentRanks: Record<string, number> = {}
    const currentUserNames: Record<string, string> = {}
    const sortedCurrent = currentScoresSnap.docs
      .map(d => ({ userId: d.id, total: (d.data().total ?? 0) as number,
        prevTotal: d.data().prevTotal as number | undefined,
        prevRank: d.data().prevRank as number | undefined,
        userName: d.data().userName as string | undefined }))
      .sort((a, b) => b.total - a.total)
    sortedCurrent.forEach((s, i) => {
      currentTotals[s.userId] = s.total
      currentRanks[s.userId] = i + 1
      if (s.userName) currentUserNames[s.userId] = s.userName
    })

    const koSnap = await getDoc(doc(db, 'admin', 'knockout'))
    const freshKO: Record<number, KnockoutMatch> = koSnap.exists() ? (koSnap.data().matches ?? {}) : knockoutMatches

    // Use actualBonus from Firestore (set manually by admin at end of tournament)
    const resultsSnap = await getDoc(doc(db, 'admin', 'results'))
    const freshBonus: Partial<BonusPredictions> = resultsSnap.exists() ? (resultsSnap.data().bonus ?? {}) : actualBonus

    const newScores: { userId: string; score: ReturnType<typeof computeUserScore> }[] = []
    for (const userDoc of usersSnap.docs) {
      const d = userDoc.data()
      const playedKO = KNOCKOUT_MATCHES
        .map(km => ({ ...km, ...(freshKO[km.id] ?? {}) }))
        .filter((km: any) => km.isPlayed && km.resultA != null && km.resultB != null)
      const score = computeUserScore(
        userDoc.id, d.userName ?? 'Unknown',
        (d.matches ?? {}) as Record<number, MatchPrediction>,
        (d.groups ?? {}) as Record<Group, GroupPrediction>,
        d.bonus ?? {}, playedMatches, actualGroups, freshBonus,
        d.knockout ?? {}, playedKO, d.knockoutRedCards ?? { R32: [], R16: [], QF: [] }
      )
      newScores.push({ userId: userDoc.id, score })
    }

    const sorted = [...newScores].sort((a, b) => b.score.total - a.score.total)
    const batch = writeBatch(db)
    sorted.forEach(({ userId, score }, i) => {
      const newRank = i + 1
      const prevTotal = currentTotals[userId] ?? score.total
      const prevRank = currentRanks[userId] ?? newRank
      const changed = score.total !== prevTotal
      const existingPrev = sortedCurrent.find(s => s.userId === userId)
      batch.set(doc(db, 'scores', userId), {
        ...score,
        userName: currentUserNames[userId] ?? score.userName,
        prevTotal: changed ? prevTotal : (hasNewResults ? score.total : (existingPrev?.prevTotal ?? prevTotal)),
        prevRank: changed ? prevRank : (hasNewResults ? newRank : (existingPrev?.prevRank ?? newRank)),
      })
    })
    await batch.commit()
  }

  const saveResults = async () => {
    const markedMatches: Record<number, any> = {}
    for (const [id, m] of Object.entries(matches)) {
      const base = (m as any).isPlayed ? { ...m, manualScore: true } : m
      markedMatches[Number(id)] = stripUndefined(base as Record<string, any>)
    }
    await setDoc(doc(db, 'admin', 'results'), { matches: markedMatches, groups: actualGroups, bonus: actualBonus })
    setMsg('✓ תוצאות נשמרו')
    setTimeout(() => setMsg(''), 3000)
  }

  const saveKnockout = async () => {
    const propagated = propagateKnockout(knockoutMatches)
    await setDoc(doc(db, 'admin', 'knockout'), { matches: propagated })
    setKnockoutMatches(propagated)
    setMsg('✓ נוקאאוט נשמר')
    setTimeout(() => setMsg(''), 3000)
  }

  const saveSettings = async () => {
    await setDoc(doc(db, 'settings', 'app'), {
      isOpen: settings.isOpen,
      deadline: settings.deadline ? new Date(settings.deadline).getTime() : null,
      knockoutOpen: settings.knockoutOpen,
      knockoutDeadline: settings.knockoutDeadline ? new Date(settings.knockoutDeadline).getTime() : null,
      r16Deadline:   settings.r16Deadline   ? new Date(settings.r16Deadline).getTime()   : null,
      qfDeadline:    settings.qfDeadline    ? new Date(settings.qfDeadline).getTime()    : null,
      sfDeadline:    settings.sfDeadline    ? new Date(settings.sfDeadline).getTime()    : null,
      p3Deadline:    settings.p3Deadline    ? new Date(settings.p3Deadline).getTime()    : null,
      finalDeadline: settings.finalDeadline ? new Date(settings.finalDeadline).getTime() : null,
      mockNow:       settings.mockNow       ? new Date(settings.mockNow).getTime()       : null,
      liveMode: settings.liveMode ?? false,
      maintenanceMode: settings.maintenanceMode ?? false,
      blindfoldUsers: blindfoldUsers,
    }, { merge: true })
    setMsg('✓ הגדרות נשמרו')
    setTimeout(() => setMsg(''), 3000)
  }

  const recalcScoresBtn = async () => {
    setScoring(true)
    setMsg('מחשב ניקוד...')
    try {
      await recalcAllScores()
      const usersSnap = await getDocs(collection(db, 'predictions'))
      setMsg(`✓ ניקוד חושב ל-${usersSnap.size} משתמשים`)
    } catch (e) { setMsg('שגיאה: ' + (e as Error).message) }
    setScoring(false)
  }

  const updateMatchResult = (id: number, field: string, value: unknown) =>
    setMatches(prev => ({ ...prev, [id]: { ...(prev[id] ?? MATCHES.find(m => m.id === id)!), [field]: value } as Match }))

  const updateKnockoutMatch = (id: number, field: string, value: unknown) => {
    setKnockoutMatches(prev => {
      const base = prev[id] ?? KNOCKOUT_MATCHES.find(m => m.id === id)!
      const updated = { ...base, [field]: value } as any
      if ((field === 'teamA' || field === 'teamB') && updated.teamA && updated.teamB) {
        const ptA = TEAM_FIFA_POINTS[updated.teamA] ?? 1500
        const ptB = TEAM_FIFA_POINTS[updated.teamB] ?? 1500
        updated.fifaPointsA = ptA; updated.fifaPointsB = ptB
        updated.category = calcCategoryByRound(ptA, ptB, updated.round)
      }
      return { ...prev, [id]: updated }
    })
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="page admin-page">
      <h1>פאנל אדמין</h1>
      {msg && <div className="admin-msg">{msg}</div>}

      <div style={{ display: 'flex', gap: 4, marginBottom: 16, background: '#f8f9fa', borderRadius: 10, padding: 4 }}>
        {(['group','knockout','users','test'] as const).map(tab => (
          <button key={tab} onClick={() => { setAdminTab(tab); if (tab === 'users') loadPendingUsers() }}
            style={{ flex: 1, padding: '8px', borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600, fontSize: 13, background: adminTab === tab ? '#1a1a2e' : 'transparent', color: adminTab === tab ? '#fff' : '#666' }}>
            {tab === 'group' ? '⚽ שלב בתים' : tab === 'knockout' ? '🏆 נוקאאוט' : tab === 'users' ? '👥 משתמשים' : '🧪 בדיקות'}
          </button>
        ))}
      </div>

      {/* ── GROUP TAB ── */}
      {adminTab === 'group' && <>
        <div style={{ display: 'flex', gap: 8, padding: '8px 0', borderBottom: '1px solid #eee', marginBottom: 8 }}>
          <button className="btn-primary btn-lg" onClick={recalcScoresBtn} disabled={scoring} style={{ flex: 1 }}>{scoring ? 'מחשב...' : '⚡ חשב ניקוד לכולם'}</button>
          <button className="btn-primary" onClick={saveResults} style={{ flex: 1 }}>💾 שמור תוצאות</button>
        </div>

        <section className="admin-section api-sync-section">
          <h2>🔄 סנכרון מ-API</h2>
          <p className="hint">מושך תוצאות, כרטיסים אדומים וסטטיסטיקות לייב אוטומטית</p>
          <button className="btn-primary btn-lg btn-sync" onClick={syncFromApi} disabled={syncing}>{syncing ? '⏳ מסנכרן...' : '🔄 סנכרן עכשיו'}</button>
          {syncLog.length > 0 && <div className="sync-log">{syncLog.map((line, i) => <div key={i}>{line}</div>)}</div>}
        </section>

        {/* Live stats display */}
        {(liveStats.topScorer || liveStats.totalRedCards) && (
          <section className="admin-section" style={{ background: '#f0fff4', border: '1px solid #b7e4c7' }}>
            <h2 style={{ color: '#1a7a44' }}>📊 סטטיסטיקות לייב (לתצוגה בלבד)</h2>
            <p style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>אלו מתעדכנים אוטומטית — ניקוד בונוס יחושב רק בסוף הטורניר</p>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              {liveStats.topScorer && <div style={{ fontSize: 13 }}>⚽ מלך שערים: <strong>{liveStats.topScorer}</strong> ({liveStats.topScorerGoals})</div>}
              {liveStats.topAssist && <div style={{ fontSize: 13 }}>🎯 מלך בישולים: <strong>{liveStats.topAssist}</strong></div>}
              {liveStats.totalRedCards && <div style={{ fontSize: 13 }}>🟥 סה"כ אדומים: <strong>{liveStats.totalRedCards}</strong></div>}
            </div>
          </section>
        )}

        <section className="admin-section">
          <h2>הגדרות</h2>
          <div className="admin-row"><label><input type="checkbox" checked={settings.isOpen} onChange={e => setSettings(s => ({ ...s, isOpen: e.target.checked }))} />&nbsp;ממשק פתוח להגשות</label></div>
          <div className="admin-row">
            <label style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ position: 'relative', display: 'inline-block' }}>
                <input type="checkbox" checked={settings.liveMode} onChange={e => setSettings(s => ({ ...s, liveMode: e.target.checked }))} style={{ opacity: 0, width: 0, height: 0, position: 'absolute' }} id="liveMode-toggle" />
                <label htmlFor="liveMode-toggle" style={{ display: 'block', width: 48, height: 26, borderRadius: 13, cursor: 'pointer', background: settings.liveMode ? '#2d6a2d' : '#ccc', transition: 'background 0.2s', position: 'relative' }}>
                  <span style={{ position: 'absolute', top: 3, left: settings.liveMode ? 25 : 3, width: 20, height: 20, background: '#fff', borderRadius: '50%', transition: 'left 0.2s' }} />
                </label>
              </div>
              <div>
                <span style={{ fontWeight: 700, fontSize: 14, color: settings.liveMode ? '#2d6a2d' : '#333' }}>{settings.liveMode ? '🟢 ריצה על אמת — פעיל' : '⚪ ריצה על אמת — כבוי'}</span>
                <p style={{ fontSize: 11, color: '#888', marginTop: 2 }}>כשפעיל — גם אדמין לא יראה הימורי משתמשים עד שהדדליין עובר</p>
              </div>
            </label>
          </div>
          <div className="admin-row"><label>דדליין שלב בתים:&nbsp;<input type="datetime-local" value={settings.deadline} onChange={e => setSettings(s => ({ ...s, deadline: e.target.value }))} /></label></div>
          <div className="admin-row" style={{ borderTop: '1px dashed #eee', paddingTop: 10, marginTop: 6 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ position: 'relative', display: 'inline-block' }}>
                <input type="checkbox" checked={settings.maintenanceMode} onChange={e => setSettings(s => ({ ...s, maintenanceMode: e.target.checked }))} style={{ opacity: 0, width: 0, height: 0, position: 'absolute' }} id="maintenance-toggle" />
                <label htmlFor="maintenance-toggle" style={{ display: 'block', width: 48, height: 26, borderRadius: 13, cursor: 'pointer', background: settings.maintenanceMode ? '#c0392b' : '#ccc', transition: 'background 0.2s', position: 'relative' }}>
                  <span style={{ position: 'absolute', top: 3, left: settings.maintenanceMode ? 25 : 3, width: 20, height: 20, background: '#fff', borderRadius: '50%', transition: 'left 0.2s' }} />
                </label>
              </div>
              <div>
                <span style={{ fontWeight: 700, fontSize: 14, color: settings.maintenanceMode ? '#c0392b' : '#333' }}>{settings.maintenanceMode ? '🔧 מצב תחזוקה — פעיל' : '⚪ מצב תחזוקה — כבוי'}</span>
                <p style={{ fontSize: 11, color: '#888', marginTop: 2 }}>כשפעיל — משתמשים רואים דף "אפליקציה בתחזוקה". אדמין נכנס רגיל.</p>
              </div>
            </label>
            {settings.maintenanceMode && <p style={{ fontSize: 11, color: '#c0392b', marginTop: 4, fontWeight: 600 }}>⚠️ המשתמשים חסומים כרגע!</p>}
          </div>
          <div className="admin-row" style={{ borderTop: '1px dashed #eee', paddingTop: 10, marginTop: 6 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13, color: '#888' }}>🧪 תאריך סימולציה:</span>
              <input type="datetime-local" value={settings.mockNow ?? ''} onChange={e => setSettings(s => ({ ...s, mockNow: e.target.value }))} />
              {settings.mockNow && <button onClick={() => setSettings(s => ({ ...s, mockNow: '' }))} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 8, border: '1px solid #ddd', cursor: 'pointer', background: '#fff', fontFamily: 'inherit' }}>✕ נקה</button>}
            </label>
            {settings.mockNow && <p style={{ fontSize: 11, color: '#e67e22', marginTop: 4 }}>⚠️ פעיל</p>}
          </div>
          <button className="btn-primary" onClick={saveSettings}>שמור הגדרות</button>
        </section>

        <section className="admin-section">
          <h3 style={{ marginBottom: 10 }}>🙈 חסימת צפייה בהימורים</h3>
          <p style={{ fontSize: 12, color: '#888', marginBottom: 10 }}>משתמשים ברשימה יוכלו להמר אך לא יראו הימורי אחרים</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {allUsersList.sort((a,b) => a.name.localeCompare(b.name)).map(u => {
              const isBlind = blindfoldUsers.includes(u.uid)
              return (
                <label key={u.uid} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 20, border: `1px solid ${isBlind ? '#c0392b' : '#ddd'}`, background: isBlind ? '#FCEBEB' : '#fafafa', cursor: 'pointer', fontSize: 13 }}>
                  <input type="checkbox" checked={isBlind} onChange={e => {
                    if (e.target.checked) setBlindfoldUsers(prev => [...prev, u.uid])
                    else setBlindfoldUsers(prev => prev.filter(id => id !== u.uid))
                  }} />
                  {u.name}
                </label>
              )
            })}
          </div>
          {blindfoldUsers.length > 0 && <p style={{ fontSize: 12, color: '#c0392b', marginTop: 8, fontWeight: 600 }}>🚫 {blindfoldUsers.length} משתמשים חסומים מצפייה</p>}
          <button className="btn-primary" style={{ marginTop: 10 }} onClick={saveSettings}>שמור</button>
        </section>

        <section className="admin-section">
          <h2>תוצאות משחקים (ידני)</h2>
          <button className="btn-primary" onClick={saveResults} style={{ marginBottom: 12 }}>💾 שמור תוצאות</button>
          {[1, 2, 3].map(round => (
            <div key={round}>
              <h3>סיבוב {round}</h3>
              {MATCHES.filter(m => m.round === round).map(match => {
                const r = matches[match.id] ?? match
                return (
                  <div key={match.id} className="admin-match-row">
                    <span className={`cat-badge cat-${match.category.toLowerCase()}`}>{match.category}</span>
                    <span className="admin-match-team">{match.teamA}</span>
                    <input className="score-input" type="number" min="0" max="20" placeholder="0" value={r.resultA ?? ''} onChange={e => updateMatchResult(match.id, 'resultA', parseInt(e.target.value) || 0)} />
                    <span style={{ color: '#aaa', fontWeight: 300 }}>–</span>
                    <input className="score-input" type="number" min="0" max="20" placeholder="0" value={r.resultB ?? ''} onChange={e => updateMatchResult(match.id, 'resultB', parseInt(e.target.value) || 0)} />
                    <span className="admin-match-team admin-match-team-b">{match.teamB}</span>
                    <label title="היה כרטיס אדום"><input type="checkbox" checked={r.hadRedCard ?? false} onChange={e => updateMatchResult(match.id, 'hadRedCard', e.target.checked)} />&nbsp;🟥</label>
                    <label title="הושלם"><input type="checkbox" checked={r.isPlayed ?? false} onChange={e => updateMatchResult(match.id, 'isPlayed', e.target.checked)} />&nbsp;✓</label>
                  </div>
                )
              })}
            </div>
          ))}
          <button className="btn-primary" onClick={saveResults}>שמור תוצאות</button>
        </section>

        <section className="admin-section">
          <h2>נבחרות עולות בפועל</h2>
          <div className="groups-grid">
            {GROUPS.map(group => (
              <div key={group} className="group-card">
                <div className="group-card-title">בית {group}</div>
                {[0, 1, 2].map(idx => (
                  <div key={idx} className="group-slot">
                    <span className="slot-num">{idx + 1}.</span>
                    <select value={actualGroups[group]?.[idx] ?? ''} onChange={e => { setActualGroups(prev => { const cur = [...(prev[group] ?? ['', '', ''])] as [string, string, string]; cur[idx] = e.target.value; return { ...prev, [group]: cur } }) }}>
                      <option value="">—</option>
                      {GROUPS_TEAMS[group].map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <button className="btn-primary" onClick={saveResults}>שמור עולות</button>
        </section>

        <section className="admin-section">
          <h2>תשובות בונוס בפועל</h2>
          <p className="hint" style={{ color: '#c0392b', fontWeight: 600 }}>⚠️ מלא רק בסוף הטורניר — השמירה כאן תחשב ניקוד בונוס לכולם</p>
          {BONUS_QUESTIONS.map(q => (
            <div key={q.id} className="admin-row" style={{ alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <label style={{ fontSize: 13, flex: 1 }}>
                <span style={{ fontWeight: 600 }}>{q.label}</span>
                <span style={{ color: '#888', fontSize: 12, marginRight: 6 }}>({q.points} נק׳)</span>
              </label>
              <input type="text" value={(actualBonus as any)[q.id] ?? ''} onChange={e => setActualBonus(prev => ({ ...prev, [q.id]: e.target.value }))} placeholder="תשובה..." style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 13, width: 200 }} />
            </div>
          ))}
          <button className="btn-primary" onClick={saveResults}>שמור בונוס</button>
        </section>

        <section className="admin-section">
          <h2>חישוב ניקוד ידני</h2>
          <button className="btn-primary btn-lg" onClick={recalcScoresBtn} disabled={scoring}>{scoring ? 'מחשב...' : '⚡ חשב ניקוד לכולם'}</button>
        </section>
      </>}

      {/* ── KNOCKOUT TAB ── */}
      {adminTab === 'knockout' && <>
        <div style={{ display: 'flex', gap: 8, padding: '8px 0', borderBottom: '1px solid #eee', marginBottom: 8 }}>
          <button className="btn-primary btn-lg" onClick={recalcScoresBtn} disabled={scoring} style={{ flex: 1 }}>{scoring ? 'מחשב...' : '⚡ חשב ניקוד לכולם'}</button>
          <button className="btn-primary" onClick={saveKnockout} style={{ flex: 1 }}>💾 שמור נוקאאוט</button>
        </div>

        <section className="admin-section" style={{ background: '#f0f4ff', border: '1px solid #c0d0ff' }}>
          <h2 style={{ color: '#334' }}>🔍 בדיקת APIs</h2>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            <button onClick={checkKnockoutApi} style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #667', background: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 }}>🌐 wc2026api</button>
            <button onClick={checkApiFootball} style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #667', background: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 }}>⚽ API-Football</button>
            <button onClick={checkZafronix} style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #667', background: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 }}>📊 Zafronix</button>
            <button onClick={() => setApiDebug('')} style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #ddd', background: '#fff', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', color: '#999' }}>נקה</button>
          </div>
          {apiDebug && <pre style={{ fontSize: 11, background: '#fff', padding: 12, borderRadius: 8, border: '1px solid #dde', overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 400, overflowY: 'auto' }}>{apiDebug}</pre>}
        </section>

        <section className="admin-section">
          <h2>הגדרות נוקאאוט</h2>
          <div className="admin-row"><label><input type="checkbox" checked={settings.knockoutOpen} onChange={e => setSettings(s => ({ ...s, knockoutOpen: e.target.checked }))} />&nbsp;חלון נוקאאוט פתוח</label></div>
          <table style={{ borderCollapse: 'collapse', width: '100%', marginTop: 10 }}>
            <thead><tr style={{ background: '#f5f5f5' }}>
              <th style={{ textAlign: 'right', padding: '6px 10px', fontSize: 12, fontWeight: 700, borderBottom: '1px solid #e0e0e0' }}>שלב</th>
              <th style={{ textAlign: 'right', padding: '6px 10px', fontSize: 12, fontWeight: 700, borderBottom: '1px solid #e0e0e0' }}>דדליין</th>
            </tr></thead>
            <tbody>
              {([['שלב 32 (R32)', 'knockoutDeadline'], ['שמינית גמר (R16)', 'r16Deadline'], ['רבע גמר (QF)', 'qfDeadline'], ['חצי גמר (SF)', 'sfDeadline'], ['מקום שלישי (3P)', 'p3Deadline'], ['גמר (F)', 'finalDeadline']] as [string, keyof typeof settings][]).map(([label, key]) => (
                <tr key={key} style={{ borderBottom: '1px solid #f0f0f0' }}>
                  <td style={{ padding: '8px 10px', fontSize: 13 }}>{label}</td>
                  <td style={{ padding: '6px 10px' }}><input type="datetime-local" value={settings[key] as string} onChange={e => setSettings(s => ({ ...s, [key]: e.target.value }))} style={{ fontSize: 13, padding: '3px 6px', borderRadius: 6, border: '1px solid #ddd' }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn-primary" onClick={saveSettings}>שמור הגדרות</button>
            <button onClick={async () => {
              if (!confirm('לאפס את כל הדדליינים?')) return
              const reset = { knockoutOpen: false, knockoutDeadline: null, r16Deadline: null, qfDeadline: null, sfDeadline: null, p3Deadline: null, finalDeadline: null }
              const { doc: fbDoc, setDoc: fbSet } = await import('firebase/firestore')
              const { db: fbDb } = await import('../firebase')
              await fbSet(fbDoc(fbDb, 'admin', 'settings'), reset, { merge: true })
              setSettings(s => ({ ...s, knockoutOpen: false, knockoutDeadline: '', r16Deadline: '', qfDeadline: '', sfDeadline: '', p3Deadline: '', finalDeadline: '' }))
            }} style={{ padding: '8px 16px', borderRadius: 8, border: '1.5px solid #c0392b', background: '#fff5f5', color: '#c0392b', fontWeight: 600, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>🔄 אפס לוחות זמנים</button>
          </div>
        </section>

        {(['R32', 'R16', 'QF', 'SF', '3P', 'F'] as const).map(round => (
          <section key={round} className="admin-section">
            <h2>{KNOCKOUT_ROUND_LABELS[round]}</h2>
            {KNOCKOUT_MATCHES.filter(m => m.round === round).map(km => {
              const r = knockoutMatches[km.id] ?? km
              const ptA = r.teamA ? (TEAM_FIFA_POINTS[r.teamA] ?? 1500) : 1500
              const ptB = r.teamB ? (TEAM_FIFA_POINTS[r.teamB] ?? 1500) : 1500
              const dynCat = (r.teamA && r.teamB) ? calcCategoryByRound(ptA, ptB, km.round) : km.category
              return (
                <div key={km.id} className="admin-match-row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                  <span className={`cat-badge cat-${dynCat.toLowerCase()}`}>{dynCat}</span>
                  <span className="match-num">#{km.id}</span>
                  <select value={r.teamA ?? ''} onChange={e => updateKnockoutMatch(km.id, 'teamA', e.target.value)} style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #ddd', fontSize: 13 }}>
                    <option value="">— נבחרת A —</option>
                    {ALL_TEAMS.sort().map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ fontSize: 10, color: '#aaa' }}>90′</span>
                    <input className="score-input" type="number" min="0" max="20" placeholder="0" value={r.resultA ?? ''} onChange={e => updateKnockoutMatch(km.id, 'resultA', parseInt(e.target.value) || 0)} style={{ width: 46, height: 38, fontSize: 18 }} />
                    <span>–</span>
                    <input className="score-input" type="number" min="0" max="20" placeholder="0" value={r.resultB ?? ''} onChange={e => updateKnockoutMatch(km.id, 'resultB', parseInt(e.target.value) || 0)} style={{ width: 46, height: 38, fontSize: 18 }} />
                  </div>
                  <select value={r.teamB ?? ''} onChange={e => updateKnockoutMatch(km.id, 'teamB', e.target.value)} style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #ddd', fontSize: 13 }}>
                    <option value="">— נבחרת B —</option>
                    {ALL_TEAMS.sort().map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <select value={r.advanceTeam ?? ''} onChange={e => updateKnockoutMatch(km.id, 'advanceTeam', e.target.value)} style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #ddd', fontSize: 13, background: '#EAF3DE' }}>
                    <option value="">— מי עלה? —</option>
                    {[r.teamA, r.teamB].filter(Boolean).map(t => <option key={t} value={t!}>{t}</option>)}
                  </select>
                  {(round === 'R32' || round === 'R16') && (
                    <label title="כרטיס אדום"><input type="checkbox" checked={r.hadRedCard ?? false} onChange={e => updateKnockoutMatch(km.id, 'hadRedCard', e.target.checked)} />&nbsp;🟥</label>
                  )}
                  <label title="הושלם"><input type="checkbox" checked={r.isPlayed ?? false} onChange={e => updateKnockoutMatch(km.id, 'isPlayed', e.target.checked)} />&nbsp;✓</label>
                </div>
              )
            })}
          </section>
        ))}

        <section className="admin-section">
          <button className="btn-primary" onClick={saveKnockout}>💾 שמור נוקאאוט</button>
          &nbsp;
          <button className="btn-primary btn-lg" onClick={recalcScoresBtn} disabled={scoring} style={{ marginTop: 8 }}>{scoring ? 'מחשב...' : '⚡ חשב ניקוד לכולם'}</button>
        </section>
      </>}

      {/* ── USERS TAB ── */}
      {adminTab === 'users' && (
        <section className="admin-section">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h3 style={{ margin: 0 }}>👥 ניהול משתמשים</h3>
            <button className="btn-secondary" onClick={loadPendingUsers} disabled={usersLoading}>{usersLoading ? 'טוען...' : '🔄 רענן'}</button>
          </div>
          {pendingUsers.length === 0 && !usersLoading && <p style={{ color: '#888', textAlign: 'center', padding: 24 }}>אין בקשות כרגע</p>}
          {['pending', 'approved', 'rejected'].map(status => {
            const group = pendingUsers.filter(u => u.status === status)
            if (group.length === 0) return null
            const label = status === 'pending' ? '⏳ ממתינים' : status === 'approved' ? '✅ מאושרים' : '❌ נדחו'
            return (
              <div key={status} style={{ marginBottom: 24 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: '#888' }}>{label}</div>
                  {status === 'rejected' && group.length > 1 && <button onClick={removeAllRejected} style={{ fontSize: 11, padding: '3px 10px', borderRadius: 6, border: '1px solid #e0a0a0', background: '#fff5f5', color: '#c0392b', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 }}>🗑 הסר כל הנדחים ({group.length})</button>}
                </div>
                {group.map(u => (
                  <div key={u.uid} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderRadius: 10, background: status === 'pending' ? '#fffdf0' : status === 'approved' ? '#f0faf4' : '#fff5f5', border: `1px solid ${status === 'pending' ? '#f0e68c' : status === 'approved' ? '#b7e4c7' : '#ffc0b5'}`, marginBottom: 8 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>{u.displayName || 'ללא שם'}</div>
                      <div style={{ fontSize: 12, color: '#888' }}>{u.email}</div>
                      <div style={{ fontSize: 11, color: '#aaa' }}>{new Date(u.requestedAt).toLocaleString('he-IL')}</div>
                    </div>
                    {status === 'pending' && <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={() => approveUser(u.uid, u.displayName, u.email)} style={{ padding: '6px 14px', borderRadius: 8, border: 'none', background: '#1a7a44', color: '#fff', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>אשר</button>
                      <button onClick={() => rejectUser(u.uid)} style={{ padding: '6px 14px', borderRadius: 8, border: 'none', background: '#c0392b', color: '#fff', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>דחה</button>
                    </div>}
                    {status === 'approved' && <button onClick={() => rejectUser(u.uid)} style={{ padding: '4px 10px', borderRadius: 8, border: '1px solid #ddd', background: '#fff', color: '#888', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>בטל אישור</button>}
                    {status === 'rejected' && <button onClick={() => removeUser(u.uid)} style={{ padding: '4px 10px', borderRadius: 8, border: '1px solid #e0a0a0', background: '#fff5f5', color: '#c0392b', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 }}>🗑 הסר</button>}
                  </div>
                ))}
              </div>
            )
          })}
        </section>
      )}

      {/* ── KNOCKOUT COMPLETION (in users tab) ── */}
      {adminTab === 'users' && (
        <section className="admin-section" style={{ marginTop: 24, background: '#fff9f0', border: '1px solid #f0d080' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ margin: 0 }}>📋 מילוי הימורי נוקאאוט</h3>
            <button className="btn-secondary" onClick={loadKoCompletion} disabled={koCompLoading}>
              {koCompLoading ? 'טוען...' : '🔄 בדוק'}
            </button>
          </div>
          {koCompletion.length === 0 && !koCompLoading && (
            <p style={{ color: '#888', fontSize: 13 }}>לחץ "בדוק" לראות מי לא מילא</p>
          )}
          {koCompletion.map(u => (
            <div key={u.userId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 8, background: '#fff', border: '1px solid #f0e0a0', marginBottom: 6 }}>
              <div style={{ flex: 1, fontWeight: 600, fontSize: 13 }}>{u.userName}</div>
              {u.missing1x2 > 0 && <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 6, background: '#fde8a0', color: '#856404', fontWeight: 700 }}>1X2: {u.missing1x2} חסרים</span>}
              {u.missingAdvance > 0 && <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 6, background: '#e0f0ff', color: '#1a5c96', fontWeight: 700 }}>🏆: {u.missingAdvance} חסרים</span>}
            </div>
          ))}
          {koCompletion.length > 0 && <p style={{ fontSize: 12, color: '#888', marginTop: 8 }}>✓ שאר המשתמשים מילאו הכל</p>}
        </section>
      )}

      {/* ── TEST TAB ── */}
      {adminTab === 'test' && (
        <section className="admin-section">
          <h3>🧪 פאנל בדיקות</h3>
          <AdminTestPanel />
        </section>
      )}
    </div>
  )
}
