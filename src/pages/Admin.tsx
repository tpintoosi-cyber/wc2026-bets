import { useState, useEffect } from 'react'
import { doc, getDoc, setDoc, collection, getDocs, writeBatch, query, where, updateDoc, deleteDoc } from 'firebase/firestore'
import { db } from '../firebase'
import { MATCHES, GROUPS_TEAMS, TEAM_EN, BONUS_QUESTIONS, KNOCKOUT_MATCHES, KNOCKOUT_BRACKET, KNOCKOUT_ROUND_LABELS, ALL_TEAMS, TEAM_FIFA_POINTS, calcCategory, calcCategoryByRound } from '../data/matches'
import { computeUserScore } from '../scoring'
import { Match, Group, GroupPrediction, BonusPredictions, MatchPrediction, KnockoutMatch } from '../types'
import { fetchGroupStageMatches, fetchKnockoutMatches, toIsraelTime } from '../services/wc2026api'
import { fetchAllFixtures, fetchFixtureEvents, fetchStandings, getKnockoutResult, parseStandings, isConfigured as isApiFootballConfigured, type ApiFootballFixture } from '../services/apifootball'
import { populateR32Teams } from '../utils/syncLogic'
import AdminTestPanel from './AdminTestPanel'

const GROUPS = 'ABCDEFGHIJKL'.split('') as Group[]

const EN_TO_HE_MAP: Record<string, string> = {}
for (const [he, en] of Object.entries(TEAM_EN)) {
  EN_TO_HE_MAP[en.toLowerCase()] = he
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
  const [matches, setMatches] = useState<Record<number, Match>>({})
  const [actualGroups, setActualGroups] = useState<Record<string, [string, string, string]>>({})
  const [actualBonus, setActualBonus] = useState<Partial<BonusPredictions>>({})
  const [settings, setSettings] = useState({
    isOpen: true, deadline: '',
    knockoutOpen: false, knockoutDeadline: '',
    r16Deadline: '', qfDeadline: '', sfDeadline: '', p3Deadline: '', finalDeadline: '',
  })
  const [scoring, setScoring] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [msg, setMsg] = useState('')
  const [syncLog, setSyncLog] = useState<string[]>([])
  const [knockoutMatches, setKnockoutMatches] = useState<Record<number, KnockoutMatch>>({})
  const [adminTab, setAdminTab] = useState<'group' | 'knockout' | 'users' | 'test'>('group')
  const [pendingUsers, setPendingUsers] = useState<{ uid: string; displayName: string; email: string; requestedAt: number; status: string }[]>([])
  const [usersLoading, setUsersLoading] = useState(false)

  useEffect(() => {
    ;(async () => {
      const [resultsSnap, settingsSnap, koSnap] = await Promise.all([
        getDoc(doc(db, 'admin', 'results')),
        getDoc(doc(db, 'settings', 'app')),
        getDoc(doc(db, 'admin', 'knockout')),
      ])
      if (resultsSnap.exists()) {
        const stored = resultsSnap.data().matches ?? {}
        // Always use fresh category + fifaPoints from MATCHES array
        // Only take result fields (resultA/B, isPlayed, hadRedCard) from Firestore
        const fresh: Record<number, Match> = {}
        for (const m of MATCHES) {
          const s = stored[m.id]
          fresh[m.id] = {
            ...m,  // fresh team data, category, fifaPoints from MATCHES
            ...(s ? {
              resultA:    s.resultA,
              resultB:    s.resultB,
              isPlayed:   s.isPlayed,
              hadRedCard: s.hadRedCard,
            } : {})
          }
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
        })
      }
      if (koSnap.exists()) {
        setKnockoutMatches(koSnap.data().matches ?? {})
      }
    })()
  }, [])

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

      // ── Group stage ─────────────────────────────────────────────────
      // Always initialize from MATCHES to guarantee fresh category/fifaPoints
      const updatedMatches: Record<number, Match> = {}
      for (const m of MATCHES) {
        updatedMatches[m.id] = { ...m, ...(matches[m.id] ? {
          resultA: matches[m.id].resultA, resultB: matches[m.id].resultB,
          isPlayed: matches[m.id].isPlayed, hadRedCard: matches[m.id].hadRedCard,
        } : {}) }
      }
      let updatedSchedule = 0
      let updatedResults = 0
      for (const apiMatch of apiGroupMatches) {
        const normHome = API_ALIASES[apiMatch.home_team?.toLowerCase()] ?? apiMatch.home_team?.toLowerCase()
        const normAway = API_ALIASES[apiMatch.away_team?.toLowerCase()] ?? apiMatch.away_team?.toLowerCase()
        const homeHe = EN_TO_HE_MAP[normHome] ?? apiMatch.home_team
        const awayHe = EN_TO_HE_MAP[normAway] ?? apiMatch.away_team
        const ourMatch = MATCHES.find(m =>
          (m.teamA === homeHe && m.teamB === awayHe) ||
          (m.teamA === awayHe && m.teamB === homeHe)
        )
        if (!ourMatch) { log.push(`⚠️ לא נמצא: ${apiMatch.home_team} vs ${apiMatch.away_team}`); continue }
        const current = updatedMatches[ourMatch.id] ?? { ...ourMatch }
        const isReversed = ourMatch.teamA === awayHe
        if (apiMatch.kickoff_utc) { (current as any).scheduleIL = toIsraelTime(apiMatch.kickoff_utc); updatedSchedule++ }
        if (apiMatch.status === 'completed' && apiMatch.home_score !== null && apiMatch.away_score !== null) {
          current.resultA = isReversed ? apiMatch.away_score : apiMatch.home_score
          current.resultB = isReversed ? apiMatch.home_score : apiMatch.away_score
          current.isPlayed = true
          updatedResults++
        }
        updatedMatches[ourMatch.id] = current as Match
      }

      // ── Knockout stage ───────────────────────────────────────────────
      let updatedKnockout = { ...knockoutMatches }
      let koUpdated = 0
      let koPenalties = 0
      for (const apiMatch of apiKnockoutMatches) {
        if (apiMatch.status !== 'completed') continue
        if (apiMatch.home_score === null || apiMatch.away_score === null) continue
        const normHome = API_ALIASES[apiMatch.home_team?.toLowerCase()] ?? apiMatch.home_team?.toLowerCase()
        const normAway = API_ALIASES[apiMatch.away_team?.toLowerCase()] ?? apiMatch.away_team?.toLowerCase()
        const homeHe = EN_TO_HE_MAP[normHome] ?? apiMatch.home_team
        const awayHe = EN_TO_HE_MAP[normAway] ?? apiMatch.away_team
        const entry = Object.entries(updatedKnockout).find(([, km]: [string, any]) =>
          (km.teamA === homeHe && km.teamB === awayHe) ||
          (km.teamA === awayHe && km.teamB === homeHe)
        )
        if (!entry) { log.push(`⚠️ נוקאאוט לא נמצא: ${apiMatch.home_team} vs ${apiMatch.away_team}`); continue }
        const km = { ...entry[1] } as any
        if (km.manualScore) continue // don't overwrite manual corrections
        const isReversed = km.teamA === awayHe
        km.resultA = isReversed ? apiMatch.away_score : apiMatch.home_score
        km.resultB = isReversed ? apiMatch.home_score : apiMatch.away_score
        km.isPlayed = true
        // Auto-set fifaPoints + category when teams are known
        if (km.teamA && km.teamB) {
          const ptA = TEAM_FIFA_POINTS[km.teamA] ?? 1500
          const ptB = TEAM_FIFA_POINTS[km.teamB] ?? 1500
          km.fifaPointsA = ptA
          km.fifaPointsB = ptB
          km.category = calcCategoryByRound(ptA, ptB, km.round)
        }
        // Auto-set advanceTeam only when result is not a draw (no penalties needed)
        if (km.resultA !== km.resultB && !km.advanceTeam) {
          km.advanceTeam = km.resultA > km.resultB ? km.teamA : km.teamB
        } else if (km.resultA === km.resultB) {
          koPenalties++
        }
        updatedKnockout[Number(entry[0])] = km
        koUpdated++
      }

      setMatches(updatedMatches)
      setKnockoutMatches(updatedKnockout)

      log.push(`📅 עודכנו ${updatedSchedule} שעות משחק`)
      log.push(`⚽ עודכנו ${updatedResults} תוצאות שלב בתים`)
      log.push(`🏆 עודכנו ${koUpdated} תוצאות נוקאאוט`)
      if (koPenalties > 0) log.push(`⚠️ ${koPenalties} משחק(ים) תיקו — יש להגדיר "מי עלה" ידנית`)

      await setDoc(doc(db, 'admin', 'results'), { matches: updatedMatches, groups: actualGroups, bonus: actualBonus }, { merge: true })
      await setDoc(doc(db, 'admin', 'knockout'), { matches: updatedKnockout })
      const scheduleMap: Record<number, string> = {}
      for (const [id, m] of Object.entries(updatedMatches)) {
        if ((m as any).scheduleIL) scheduleMap[Number(id)] = (m as any).scheduleIL
      }
      await setDoc(doc(db, 'admin', 'schedule'), { schedule: scheduleMap })
      log.push('💾 נשמר ב-Firestore')

      // ── API-Football: red cards + 90-min scores + standings + advanceTeam ──
      if (isApiFootballConfigured()) {
        log.push('🔄 מושך נתונים מ-API-Football...')
        setSyncLog([...log])
        try {
          const [fixtures, standings] = await Promise.all([
            fetchAllFixtures(),
            fetchStandings(),
          ])

          // Build name → fixture map for completed matches
          const fixtureByTeams: Record<string, ApiFootballFixture> = {}
          for (const f of fixtures) {
            const s = f.fixture.status.short
            if (['FT', 'AET', 'PEN'].includes(s)) {
              fixtureByTeams[`${f.teams.home.name}|${f.teams.away.name}`] = f
              fixtureByTeams[`${f.teams.away.name}|${f.teams.home.name}`] = f
            }
          }

          // EN→HE map for team name conversion
          const enToHe: Record<string, string> = {}
          for (const [he, en] of Object.entries(TEAM_EN)) {
            enToHe[en.toLowerCase()] = he
            enToHe[en] = he
          }

          let redCards = 0, scoresFix = 0, advanceFix = 0

          // ── Group stage: 90-min scores + red cards ──────────────────
          for (const match of MATCHES) {
            if (!updatedMatches[match.id]?.isPlayed) continue
            const teamAen = TEAM_EN[match.teamA] ?? match.teamA
            const teamBen = TEAM_EN[match.teamB] ?? match.teamB
            const fixture = fixtureByTeams[`${teamAen}|${teamBen}`]
            if (!fixture) continue

            const ft = fixture.score.fulltime
            if (ft.home !== null && ft.away !== null) {
              const isRev = fixture.teams.home.name !== teamAen
              updatedMatches[match.id].resultA = isRev ? ft.away : ft.home
              updatedMatches[match.id].resultB = isRev ? ft.home : ft.away
              scoresFix++
            }

            // Red cards from events
            const events = await fetchFixtureEvents(fixture.fixture.id)
            const hasRed = events.some(e => e.type === 'Card' && e.detail === 'Red Card')
            updatedMatches[match.id].hadRedCard = hasRed
            if (hasRed) redCards++
          }

          // ── Knockout: 90-min scores + advanceTeam + red cards ───────
          for (const km of KNOCKOUT_MATCHES) {
            const kd = updatedKnockout[km.id] as any
            if (!kd?.isPlayed || kd.manualScore) continue
            const teamAen = TEAM_EN[kd.teamA] ?? kd.teamA ?? ''
            const teamBen = TEAM_EN[kd.teamB] ?? kd.teamB ?? ''
            if (!teamAen || !teamBen) continue

            const fixture = fixtureByTeams[`${teamAen}|${teamBen}`]
            if (!fixture) continue

            const result = getKnockoutResult(fixture, kd.teamA, kd.teamB)
            if (result) {
              kd.resultA = result.score90A
              kd.resultB = result.score90B
              kd.advanceTeam = result.advanceTeam
              // Auto category
              const ptA = TEAM_FIFA_POINTS[kd.teamA] ?? 1500
              const ptB = TEAM_FIFA_POINTS[kd.teamB] ?? 1500
              kd.fifaPointsA = ptA
              kd.fifaPointsB = ptB
              kd.category = calcCategoryByRound(ptA, ptB, kd.round)
              advanceFix++
            }

            // Red cards (R32 + R16 only)
            if (km.round === 'R32' || km.round === 'R16') {
              const events = await fetchFixtureEvents(fixture.fixture.id)
              const hasRed = events.some(e => e.type === 'Card' && e.detail === 'Red Card')
              kd.hadRedCard = hasRed
              if (hasRed) redCards++
            }
            updatedKnockout[km.id] = kd
          }

          // ── Group qualifiers from standings ─────────────────────────
          if (standings.length > 0) {
            const { groupQualifiers, best8Thirds } = parseStandings(standings, enToHe)
            const hasData = Object.keys(groupQualifiers).length > 0
            if (hasData) {
              // Merge with existing — don't overwrite if already set
              for (const [g, teams] of Object.entries(groupQualifiers)) {
                if (teams[0]) setActualGroups(prev => ({ ...prev, [g]: teams }))
              }
              await setDoc(doc(db, 'admin', 'results'), {
                matches: updatedMatches,
                groups: { ...actualGroups, ...groupQualifiers },
                bonus: actualBonus,
              }, { merge: true })
              log.push(`🏅 עודכנו עולות מהבתים (${Object.keys(groupQualifiers).length} בתים)`)

              // Auto-populate R32 teams from group results
              const { updatedKnockout: koWithR32, populated, log: r32Log } =
                populateR32Teams(groupQualifiers, best8Thirds, updatedKnockout, TEAM_FIFA_POINTS, calcCategoryByRound)
              if (populated > 0) {
                updatedKnockout = koWithR32
                r32Log.forEach(l => log.push(l))
              }
            }
          }

          // Save updated knockout
          setMatches({ ...updatedMatches })
          setKnockoutMatches({ ...updatedKnockout })
          await setDoc(doc(db, 'admin', 'results'), { matches: updatedMatches, groups: actualGroups, bonus: actualBonus }, { merge: true })
          await setDoc(doc(db, 'admin', 'knockout'), { matches: updatedKnockout })

          log.push(`⏱️ תוצאות 90 דקות: ${scoresFix} משחקים`)
          log.push(`🟥 כרטיסים אדומים: ${redCards}`)
          log.push(`🏆 מי עלה הלאה: ${advanceFix} משחקים`)

        } catch (e) {
          log.push(`⚠️ API-Football: ${(e as Error).message}`)
        }
      } else {
        log.push('ℹ️ API-Football לא מוגדר')
      }
      if (updatedResults > 0 || koUpdated > 0) {
        log.push('🔄 מחשב ניקוד...')
        setSyncLog([...log])
        await recalcAllScores(updatedMatches)
        log.push('🏆 ניקוד עודכן!')
      }
      log.push('✅ סנכרון הושלם!')
      setMsg(`✓ סנכרון הצליח — ${updatedResults} תוצאות בתים, ${koUpdated} נוקאאוט`)
    } catch (e) {
      log.push(`❌ שגיאה: ${(e as Error).message}`)
      setMsg('שגיאה בסנכרון: ' + (e as Error).message)
    }
    setSyncLog([...log])
    setSyncing(false)
    setTimeout(() => setMsg(''), 5000)
  }

  const loadPendingUsers = async () => {
    setUsersLoading(true)
    const snap = await getDocs(collection(db, 'pendingUsers'))
    const users = snap.docs.map(d => d.data() as { uid: string; displayName: string; email: string; requestedAt: number; status: string })
    users.sort((a, b) => a.requestedAt - b.requestedAt)
    setPendingUsers(users)
    setUsersLoading(false)
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
    if (!confirm('להסיר משתמש זה לגמרי מהמערכת?')) return
    await deleteDoc(doc(db, 'pendingUsers', uid))
    try { await deleteDoc(doc(db, 'users', uid)) } catch {}
    setPendingUsers(prev => prev.filter(u => u.uid !== uid))
  }

  const removeAllRejected = async () => {
    const rejected = pendingUsers.filter(u => u.status === 'rejected')
    if (rejected.length === 0) return
    if (!confirm(`להסיר ${rejected.length} משתמשים נדחים לגמרי?`)) return
    await Promise.all(rejected.map(async u => {
      await deleteDoc(doc(db, 'pendingUsers', u.uid))
      try { await deleteDoc(doc(db, 'users', u.uid)) } catch {}
    }))
    setPendingUsers(prev => prev.filter(u => u.status !== 'rejected'))
  }

  const recalcAllScores = async (matchData?: Record<number, Match>) => {
    const data = matchData ?? matches
    const usersSnap = await getDocs(collection(db, 'predictions'))
    const playedMatches = MATCHES.map(m => ({ ...m, ...(data[m.id] ?? {}) })).filter(m => m.isPlayed)

    // Read current scores before computing new ones (for delta tracking)
    const currentScoresSnap = await getDocs(collection(db, 'scores'))
    const currentTotals: Record<string, number> = {}
    const currentRanks: Record<string, number> = {}
    const sortedCurrent = currentScoresSnap.docs
      .map(d => ({ userId: d.id, total: (d.data().total ?? 0) as number,
        prevTotal: d.data().prevTotal as number | undefined,
        prevRank:  d.data().prevRank  as number | undefined }))
      .sort((a, b) => b.total - a.total)
    sortedCurrent.forEach((s, i) => {
      currentTotals[s.userId] = s.total
      currentRanks[s.userId] = i + 1
    })

    // Compute new scores
    const newScores: { userId: string; score: ReturnType<typeof computeUserScore> }[] = []
    for (const userDoc of usersSnap.docs) {
      const d = userDoc.data()
      const playedKO = KNOCKOUT_MATCHES.map(km => ({ ...km, ...(knockoutMatches[km.id] ?? {}) })).filter(km => km.isPlayed)
      const score = computeUserScore(
        userDoc.id, d.userName ?? 'Unknown',
        (d.matches ?? {}) as Record<number, MatchPrediction>,
        (d.groups ?? {}) as Record<Group, GroupPrediction>,
        d.bonus ?? {}, playedMatches, actualGroups, actualBonus,
        d.knockout ?? {}, playedKO, d.knockoutRedCards ?? { R32: [], R16: [], QF: [] }
      )
      newScores.push({ userId: userDoc.id, score })
    }

    // Sort to compute new ranks
    const sorted = [...newScores].sort((a, b) => b.score.total - a.score.total)

    const batch = writeBatch(db)
    sorted.forEach(({ userId, score }, i) => {
      const newRank = i + 1
      const prevTotal = currentTotals[userId] ?? score.total
      const prevRank  = currentRanks[userId]  ?? newRank
      const changed   = score.total !== prevTotal
      const existingPrev = sortedCurrent.find(s => s.userId === userId)
      batch.set(doc(db, 'scores', userId), {
        ...score,
        // Only update prev fields when score actually changed (avoid wiping delta on double-click)
        prevTotal: changed ? prevTotal : (existingPrev?.prevTotal ?? prevTotal),
        prevRank:  changed ? prevRank  : (existingPrev?.prevRank  ?? newRank),
      })
    })
    await batch.commit()
  }

  const saveResults = async () => {
    await setDoc(doc(db, 'admin', 'results'), { matches, groups: actualGroups, bonus: actualBonus })
    setMsg('✓ תוצאות נשמרו')
    setTimeout(() => setMsg(''), 3000)
  }

  const saveKnockout = async () => {
    // Propagate advanceTeam → next round teamA/teamB automatically
    const propagated: Record<number, any> = { ...knockoutMatches }
    for (const [id, km] of Object.entries(propagated)) {
      const m = km as any
      if (!m?.advanceTeam) continue
      const b = KNOCKOUT_BRACKET[Number(id)]
      if (!b) continue
      for (const [nextId] of Object.entries(propagated)) {
        const nb = KNOCKOUT_BRACKET[Number(nextId)]
        if (!nb) continue
        if (nb.feederA === Number(id)) {
          propagated[Number(nextId)] = { ...propagated[Number(nextId)], teamA: m.advanceTeam, fifaPointsA: TEAM_FIFA_POINTS[m.advanceTeam] ?? 1500 }
        }
        if (nb.feederB === Number(id)) {
          propagated[Number(nextId)] = { ...propagated[Number(nextId)], teamB: m.advanceTeam, fifaPointsB: TEAM_FIFA_POINTS[m.advanceTeam] ?? 1500 }
        }
        // 3P match uses losers
        if (nb.feederA === -Number(id)) {
          const loser = m.teamA === m.advanceTeam ? m.teamB : m.teamA
          if (loser) propagated[Number(nextId)] = { ...propagated[Number(nextId)], teamA: loser, fifaPointsA: TEAM_FIFA_POINTS[loser] ?? 1500 }
        }
        if (nb.feederB === -Number(id)) {
          const loser = m.teamA === m.advanceTeam ? m.teamB : m.teamA
          if (loser) propagated[Number(nextId)] = { ...propagated[Number(nextId)], teamB: loser, fifaPointsB: TEAM_FIFA_POINTS[loser] ?? 1500 }
        }
      }
    }
    await setDoc(doc(db, 'admin', 'knockout'), { matches: propagated })
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
    } catch (e) {
      setMsg('שגיאה: ' + (e as Error).message)
    }
    setScoring(false)
  }

  const updateMatchResult = (id: number, field: string, value: unknown) => {
    setMatches(prev => ({ ...prev, [id]: { ...(prev[id] ?? MATCHES.find(m => m.id === id)!), [field]: value } as Match }))
  }

  const updateKnockoutMatch = (id: number, field: string, value: unknown) => {
    setKnockoutMatches(prev => {
      const base = prev[id] ?? KNOCKOUT_MATCHES.find(m => m.id === id)!
      const updated = { ...base, [field]: value } as any
      // Auto-calculate fifaPoints + category when teamA or teamB is set
      if ((field === 'teamA' || field === 'teamB') && updated.teamA && updated.teamB) {
        const ptA = TEAM_FIFA_POINTS[updated.teamA] ?? 1500
        const ptB = TEAM_FIFA_POINTS[updated.teamB] ?? 1500
        updated.fifaPointsA = ptA
        updated.fifaPointsB = ptB
        updated.category = calcCategoryByRound(ptA, ptB, updated.round)
      }
      return { ...prev, [id]: updated }
    })
  }

  return (
    <div className="page admin-page">
      <h1>פאנל אדמין</h1>
      {msg && <div className="admin-msg">{msg}</div>}

      {/* Tab switcher */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, background: '#f8f9fa', borderRadius: 10, padding: 4 }}>
        <button onClick={() => setAdminTab('group')} style={{
          flex: 1, padding: '8px', borderRadius: 8, border: 'none', cursor: 'pointer',
          fontFamily: 'inherit', fontWeight: 600, fontSize: 13,
          background: adminTab === 'group' ? '#1a1a2e' : 'transparent',
          color: adminTab === 'group' ? '#fff' : '#666',
        }}>⚽ שלב בתים</button>
        <button onClick={() => setAdminTab('knockout')} style={{
          flex: 1, padding: '8px', borderRadius: 8, border: 'none', cursor: 'pointer',
          fontFamily: 'inherit', fontWeight: 600, fontSize: 13,
          background: adminTab === 'knockout' ? '#1a1a2e' : 'transparent',
          color: adminTab === 'knockout' ? '#fff' : '#666',
        }}>🏆 נוקאאוט</button>
        <button onClick={() => { setAdminTab('users'); loadPendingUsers() }} style={{
          flex: 1, padding: '8px', borderRadius: 8, border: 'none', cursor: 'pointer',
          fontFamily: 'inherit', fontWeight: 600, fontSize: 13,
          background: adminTab === 'users' ? '#1a1a2e' : 'transparent',
          color: adminTab === 'users' ? '#fff' : '#666',
        }}>👥 משתמשים</button>
        <button onClick={() => setAdminTab('test')} style={{
          flex: 1, padding: '8px', borderRadius: 8, border: 'none', cursor: 'pointer',
          fontFamily: 'inherit', fontWeight: 600, fontSize: 13,
          background: adminTab === 'test' ? '#1a1a2e' : 'transparent',
          color: adminTab === 'test' ? '#fff' : '#666',
        }}>🧪 בדיקות</button>
      </div>

      {/* API Sync */}
      {adminTab === 'group' && <>
      {/* Quick access buttons at top of tab */}
      <div style={{ display: 'flex', gap: 8, padding: '8px 0', borderBottom: '1px solid #eee', marginBottom: 8 }}>
        <button className="btn-primary btn-lg" onClick={recalcScoresBtn} disabled={scoring} style={{ flex: 1 }}>
          {scoring ? 'מחשב...' : '⚡ חשב ניקוד לכולם'}
        </button>
        <button className="btn-primary" onClick={saveResults} style={{ flex: 1 }}>💾 שמור תוצאות</button>
      </div>

      <section className="admin-section api-sync-section">
        <h2>🔄 סנכרון מ-API</h2>
        <p className="hint">מושך שעות ותוצאות אוטומטית מ-wc2026api.com</p>
        <button className="btn-primary btn-lg btn-sync" onClick={syncFromApi} disabled={syncing}>
          {syncing ? '⏳ מסנכרן...' : '🔄 סנכרן עכשיו'}
        </button>
        {syncLog.length > 0 && (
          <div className="sync-log">
            {syncLog.map((line, i) => <div key={i}>{line}</div>)}
          </div>
        )}
      </section>

      {/* Settings */}
      <section className="admin-section">
        <h2>הגדרות</h2>
        <div className="admin-row">
          <label>
            <input type="checkbox" checked={settings.isOpen}
              onChange={e => setSettings(s => ({ ...s, isOpen: e.target.checked }))} />
            &nbsp;ממשק פתוח להגשות
          </label>
        </div>
        <div className="admin-row">
          <label>דדליין שלב בתים:&nbsp;
            <input type="datetime-local" value={settings.deadline}
              onChange={e => setSettings(s => ({ ...s, deadline: e.target.value }))} />
          </label>
        </div>
        <button className="btn-primary" onClick={saveSettings}>שמור הגדרות</button>
      </section>

      {/* Match results */}
      <section className="admin-section">
        <h2>תוצאות משחקים (ידני)</h2>
        <p className="hint">ניתן גם לסנכרן אוטומטית מה-API למעלה</p>
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
                  <input className="score-input" type="number" min="0" max="20" placeholder="0"
                    value={r.resultA ?? ''}
                    onChange={e => updateMatchResult(match.id, 'resultA', parseInt(e.target.value) || 0)} />
                  <span style={{ color: '#aaa', fontWeight: 300 }}>–</span>
                  <input className="score-input" type="number" min="0" max="20" placeholder="0"
                    value={r.resultB ?? ''}
                    onChange={e => updateMatchResult(match.id, 'resultB', parseInt(e.target.value) || 0)} />
                  <span className="admin-match-team admin-match-team-b">{match.teamB}</span>
                  <label title="היה כרטיס אדום">
                    <input type="checkbox" checked={r.hadRedCard ?? false}
                      onChange={e => updateMatchResult(match.id, 'hadRedCard', e.target.checked)} />
                    &nbsp;🟥
                  </label>
                  <label title="הושלם">
                    <input type="checkbox" checked={r.isPlayed ?? false}
                      onChange={e => updateMatchResult(match.id, 'isPlayed', e.target.checked)} />
                    &nbsp;✓
                  </label>
                </div>
              )
            })}
          </div>
        ))}
        <button className="btn-primary" onClick={saveResults}>שמור תוצאות</button>
      </section>

      {/* Group standings */}
      <section className="admin-section">
        <h2>נבחרות עולות בפועל</h2>
        <div className="groups-grid">
          {GROUPS.map(group => (
            <div key={group} className="group-card">
              <div className="group-card-title">בית {group}</div>
              {[0, 1, 2].map(idx => (
                <div key={idx} className="group-slot">
                  <span className="slot-num">{idx + 1}.</span>
                  <select value={actualGroups[group]?.[idx] ?? ''}
                    onChange={e => {
                      setActualGroups(prev => {
                        const cur = [...(prev[group] ?? ['', '', ''])] as [string, string, string]
                        cur[idx] = e.target.value
                        return { ...prev, [group]: cur }
                      })
                    }}>
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

      {/* Bonus answers */}
      <section className="admin-section">
        <h2>תשובות בונוס בפועל</h2>
        <p className="hint">מלא את התשובות הנכונות לאחר סיום הטורניר</p>
        {BONUS_QUESTIONS.map(q => (
          <div key={q.id} className="admin-row" style={{ alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <label style={{ fontSize: 13, flex: 1 }}>
              <span style={{ fontWeight: 600 }}>{q.label}</span>
              <span style={{ color: '#888', fontSize: 12, marginRight: 6 }}>({q.points} נק׳)</span>
            </label>
            <input
              type="text"
              value={(actualBonus as any)[q.id] ?? ''}
              onChange={e => setActualBonus(prev => ({ ...prev, [q.id]: e.target.value }))}
              placeholder="תשובה..."
              style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 13, width: 160 }}
            />
          </div>
        ))}
        <button className="btn-primary" onClick={saveResults}>שמור בונוס</button>
      </section>

      {/* Recalculate */}
      <section className="admin-section">
        <h2>חישוב ניקוד ידני</h2>
        <button className="btn-primary btn-lg" onClick={recalcScoresBtn} disabled={scoring}>
          {scoring ? 'מחשב...' : '⚡ חשב ניקוד לכולם'}
        </button>
      </section>
      </>}

      {/* ── KNOCKOUT TAB ─────────────────────────────────── */}
      {adminTab === 'knockout' && <>
      {/* Quick access buttons at top of knockout tab */}
      <div style={{ display: 'flex', gap: 8, padding: '8px 0', borderBottom: '1px solid #eee', marginBottom: 8 }}>
        <button className="btn-primary btn-lg" onClick={recalcScoresBtn} disabled={scoring} style={{ flex: 1 }}>
          {scoring ? 'מחשב...' : '⚡ חשב ניקוד לכולם'}
        </button>
        <button className="btn-primary" onClick={saveKnockout} style={{ flex: 1 }}>💾 שמור נוקאאוט</button>
      </div>

        {/* Knockout settings */}
        <section className="admin-section">
          <h2>הגדרות נוקאאוט</h2>

          <div className="admin-row">
            <label>
              <input type="checkbox" checked={settings.knockoutOpen}
                onChange={e => setSettings(s => ({ ...s, knockoutOpen: e.target.checked }))} />
              &nbsp;חלון נוקאאוט פתוח (משתמשים יכולים למלא)
            </label>
          </div>

          <table style={{ borderCollapse: 'collapse', width: '100%', marginTop: 10 }}>
            <thead>
              <tr style={{ background: '#f5f5f5' }}>
                <th style={{ textAlign: 'right', padding: '6px 10px', fontSize: 12, fontWeight: 700, borderBottom: '1px solid #e0e0e0' }}>שלב</th>
                <th style={{ textAlign: 'right', padding: '6px 10px', fontSize: 12, fontWeight: 700, borderBottom: '1px solid #e0e0e0' }}>דדליין (נועל לפני תחילת השלב)</th>
              </tr>
            </thead>
            <tbody>
              {([
                ['שלב 32 (R32)', 'knockoutDeadline'],
                ['שמינית גמר + עץ (R16)', 'r16Deadline'],
                ['רבע גמר (QF)', 'qfDeadline'],
                ['חצי גמר (SF)', 'sfDeadline'],
                ['מקום שלישי (3P)', 'p3Deadline'],
                ['גמר (F)', 'finalDeadline'],
              ] as [string, keyof typeof settings][]).map(([label, key]) => (
                <tr key={key} style={{ borderBottom: '1px solid #f0f0f0' }}>
                  <td style={{ padding: '8px 10px', fontSize: 13, fontWeight: key === 'knockoutDeadline' ? 700 : 400 }}>{label}</td>
                  <td style={{ padding: '6px 10px' }}>
                    <input type="datetime-local" value={settings[key] as string}
                      onChange={e => setSettings(s => ({ ...s, [key]: e.target.value }))}
                      style={{ fontSize: 13, padding: '3px 6px', borderRadius: 6, border: '1px solid #ddd' }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
            <button className="btn-primary" onClick={saveSettings}>שמור הגדרות</button>
            <button
              onClick={async () => {
                if (!confirm('לאפס את כל הדדליינים ולסגור את חלון הנוקאאוט?')) return
                const reset = {
                  knockoutOpen: false,
                  knockoutDeadline: null,
                  r16Deadline: null,
                  qfDeadline: null,
                  sfDeadline: null,
                  p3Deadline: null,
                  finalDeadline: null,
                }
                const { doc: fbDoc, setDoc: fbSet } = await import('firebase/firestore')
                const { db: fbDb } = await import('../firebase')
                await fbSet(fbDoc(fbDb, 'admin', 'settings'), reset, { merge: true })
                setSettings(s => ({
                  ...s,
                  knockoutOpen: false,
                  knockoutDeadline: '',
                  r16Deadline: '',
                  qfDeadline: '',
                  sfDeadline: '',
                  p3Deadline: '',
                  finalDeadline: '',
                }))
              }}
              style={{
                padding: '8px 16px', borderRadius: 8, border: '1.5px solid #c0392b',
                background: '#fff5f5', color: '#c0392b', fontWeight: 600, fontSize: 13,
                cursor: 'pointer', fontFamily: 'inherit',
              }}>
              🔄 אפס לוחות זמנים
            </button>
          </div>
        </section>

        {/* Knockout match management */}
        {(['R32', 'R16', 'QF', 'SF', '3P', 'F'] as const).map(round => {
          const roundMatches = KNOCKOUT_MATCHES.filter(m => m.round === round)
          return (
            <section key={round} className="admin-section">
              <h2>{KNOCKOUT_ROUND_LABELS[round]}</h2>
              {roundMatches.map(km => {
                const r = knockoutMatches[km.id] ?? km
                const ptA = r.teamA ? (TEAM_FIFA_POINTS[r.teamA] ?? 1500) : 1500
                const ptB = r.teamB ? (TEAM_FIFA_POINTS[r.teamB] ?? 1500) : 1500
                const dynCat = (r.teamA && r.teamB) ? calcCategoryByRound(ptA, ptB, km.round) : km.category
                return (
                  <div key={km.id} className="admin-match-row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                    <span className={`cat-badge cat-${dynCat.toLowerCase()}`}>{dynCat}</span>
                    <span className="match-num">#{km.id}</span>

                    {/* Team A selector */}
                    <select value={r.teamA ?? ''}
                      onChange={e => updateKnockoutMatch(km.id, 'teamA', e.target.value)}
                      style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #ddd', fontSize: 13 }}>
                      <option value="">— נבחרת A —</option>
                      {ALL_TEAMS.sort().map(t => <option key={t} value={t}>{t}</option>)}
                    </select>

                    {/* Scores */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ fontSize: 10, color: '#aaa' }}>90′</span>
                      <input className="score-input" type="number" min="0" max="20" placeholder="0"
                        value={r.resultA ?? ''}
                        onChange={e => updateKnockoutMatch(km.id, 'resultA', parseInt(e.target.value) || 0)}
                        style={{ width: 46, height: 38, fontSize: 18 }} />
                      <span>–</span>
                      <input className="score-input" type="number" min="0" max="20" placeholder="0"
                        value={r.resultB ?? ''}
                        onChange={e => updateKnockoutMatch(km.id, 'resultB', parseInt(e.target.value) || 0)}
                        style={{ width: 46, height: 38, fontSize: 18 }} />
                    </div>

                    {/* Team B selector */}
                    <select value={r.teamB ?? ''}
                      onChange={e => updateKnockoutMatch(km.id, 'teamB', e.target.value)}
                      style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #ddd', fontSize: 13 }}>
                      <option value="">— נבחרת B —</option>
                      {ALL_TEAMS.sort().map(t => <option key={t} value={t}>{t}</option>)}
                    </select>

                    {/* Advance team (who actually won, could differ from 90min result) */}
                    <select value={r.advanceTeam ?? ''}
                      onChange={e => updateKnockoutMatch(km.id, 'advanceTeam', e.target.value)}
                      style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #ddd', fontSize: 13, background: '#EAF3DE' }}>
                      <option value="">— מי עלה? —</option>
                      {[r.teamA, r.teamB].filter(Boolean).map(t => <option key={t} value={t!}>{t}</option>)}
                    </select>

                    {/* Red card (R32+R16 only) */}
                    {(round === 'R32' || round === 'R16') && (
                      <label title="כרטיס אדום">
                        <input type="checkbox" checked={r.hadRedCard ?? false}
                          onChange={e => updateKnockoutMatch(km.id, 'hadRedCard', e.target.checked)} />
                        &nbsp;🟥
                      </label>
                    )}

                    {/* Played */}
                    <label title="הושלם">
                      <input type="checkbox" checked={r.isPlayed ?? false}
                        onChange={e => updateKnockoutMatch(km.id, 'isPlayed', e.target.checked)} />
                      &nbsp;✓
                    </label>
                  </div>
                )
              })}
            </section>
          )
        })}

        <section className="admin-section">
          <button className="btn-primary" onClick={saveKnockout}>💾 שמור נוקאאוט</button>
          &nbsp;
          <button className="btn-primary btn-lg" onClick={recalcScoresBtn} disabled={scoring} style={{ marginTop: 8 }}>
            {scoring ? 'מחשב...' : '⚡ חשב ניקוד לכולם'}
          </button>
        </section>
      </>}

      {adminTab === 'users' && (
        <section className="admin-section">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h3 style={{ margin: 0 }}>👥 ניהול משתמשים</h3>
            <button className="btn-secondary" onClick={loadPendingUsers} disabled={usersLoading}>
              {usersLoading ? 'טוען...' : '🔄 רענן'}
            </button>
          </div>

          {pendingUsers.length === 0 && !usersLoading && (
            <p style={{ color: '#888', textAlign: 'center', padding: 24 }}>אין בקשות כרגע</p>
          )}

          {['pending', 'approved', 'rejected'].map(status => {
            const group = pendingUsers.filter(u => u.status === status)
            if (group.length === 0) return null
            const label = status === 'pending' ? '⏳ ממתינים לאישור' : status === 'approved' ? '✅ מאושרים' : '❌ נדחו'
            return (
              <div key={status} style={{ marginBottom: 24 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: '#888' }}>{label}</div>
                  {status === 'rejected' && group.length > 1 && (
                    <button onClick={removeAllRejected} style={{
                      fontSize: 11, padding: '3px 10px', borderRadius: 6,
                      border: '1px solid #e0a0a0', background: '#fff5f5',
                      color: '#c0392b', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600,
                    }}>🗑 הסר כל הנדחים ({group.length})</button>
                  )}
                </div>
                {group.map(u => (
                  <div key={u.uid} style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '10px 14px', borderRadius: 10,
                    background: status === 'pending' ? '#fffdf0' : status === 'approved' ? '#f0faf4' : '#fff5f5',
                    border: `1px solid ${status === 'pending' ? '#f0e68c' : status === 'approved' ? '#b7e4c7' : '#ffc0b5'}`,
                    marginBottom: 8,
                  }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>{u.displayName || 'ללא שם'}</div>
                      <div style={{ fontSize: 12, color: '#888' }}>{u.email}</div>
                      <div style={{ fontSize: 11, color: '#aaa' }}>
                        {new Date(u.requestedAt).toLocaleString('he-IL')}
                      </div>
                    </div>
                    {status === 'pending' && (
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button
                          onClick={() => approveUser(u.uid, u.displayName, u.email)}
                          style={{ padding: '6px 14px', borderRadius: 8, border: 'none', background: '#1a7a44', color: '#fff', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                          אשר
                        </button>
                        <button
                          onClick={() => rejectUser(u.uid)}
                          style={{ padding: '6px 14px', borderRadius: 8, border: 'none', background: '#c0392b', color: '#fff', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                          דחה
                        </button>
                      </div>
                    )}
                    {status === 'approved' && (
                      <button
                        onClick={() => rejectUser(u.uid)}
                        style={{ padding: '4px 10px', borderRadius: 8, border: '1px solid #ddd', background: '#fff', color: '#888', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>
                        בטל אישור
                      </button>
                    )}
                    {status === 'rejected' && (
                      <button
                        onClick={() => removeUser(u.uid)}
                        style={{ padding: '4px 10px', borderRadius: 8, border: '1px solid #e0a0a0', background: '#fff5f5', color: '#c0392b', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 }}>
                        🗑 הסר
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )
          })}
        </section>
      )}

      {adminTab === 'test' && (
        <section className="admin-section">
          <h3>🧪 פאנל בדיקות</h3>
          <AdminTestPanel />
        </section>
      )}
    </div>
  )
}
