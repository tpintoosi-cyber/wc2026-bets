import { useState, useEffect } from 'react'
import { doc, getDoc, setDoc, collection, getDocs, writeBatch } from 'firebase/firestore'
import { db } from '../firebase'
import { MATCHES, GROUPS_TEAMS, TEAM_EN, BONUS_QUESTIONS, KNOCKOUT_MATCHES, KNOCKOUT_ROUND_LABELS, ALL_TEAMS } from '../data/matches'
import { computeUserScore } from '../scoring'
import { Match, Group, GroupPrediction, BonusPredictions, MatchPrediction, KnockoutMatch } from '../types'
import { fetchGroupStageMatches, fetchKnockoutMatches, toIsraelTime } from '../services/wc2026api'
import { fetchAllFixtures, fetchFixtureEvents, isConfigured as isApiFootballConfigured } from '../services/apifootball'

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
  const [settings, setSettings] = useState({ isOpen: true, deadline: '', knockoutOpen: false, knockoutDeadline: '' })
  const [scoring, setScoring] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [msg, setMsg] = useState('')
  const [syncLog, setSyncLog] = useState<string[]>([])
  const [knockoutMatches, setKnockoutMatches] = useState<Record<number, KnockoutMatch>>({})
  const [adminTab, setAdminTab] = useState<'group' | 'knockout'>('group')

  useEffect(() => {
    ;(async () => {
      const [resultsSnap, settingsSnap, koSnap] = await Promise.all([
        getDoc(doc(db, 'admin', 'results')),
        getDoc(doc(db, 'settings', 'app')),
        getDoc(doc(db, 'admin', 'knockout')),
      ])
      if (resultsSnap.exists()) {
        setMatches(resultsSnap.data().matches ?? {})
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
      const updatedMatches = { ...matches }
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
      const updatedKnockout = { ...knockoutMatches }
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

      // ── API-Football: red cards + 90-min period scores ──────────────
      if (isApiFootballConfigured()) {
        log.push('🟥 מושך כרטיסים אדומים מ-API-Football...')
        setSyncLog([...log])
        try {
          const fixtures = await fetchAllFixtures()
          // Build map: team names → fixture ID, for completed matches
          const fixtureMap: Record<string, number> = {}
          for (const f of fixtures) {
            if (f.fixture.status.short === 'FT' || f.fixture.status.short === 'AET' || f.fixture.status.short === 'PEN') {
              const key = `${f.teams.home.name}|${f.teams.away.name}`
              fixtureMap[key] = f.fixture.id
            }
          }

          // Find our matches that need red card check (played, no hadRedCard set yet)
          const matchesToCheck = [
            ...MATCHES.filter(m => updatedMatches[m.id]?.isPlayed),
            ...KNOCKOUT_MATCHES.filter(km => (updatedKnockout[km.id] as any)?.isPlayed),
          ]

          let redCardUpdates = 0
          let periodScoreUpdates = 0

          for (const m of matchesToCheck) {
            // Find matching fixture by team names (EN)
            const teamAen = TEAM_EN[('teamA' in m ? m.teamA : (updatedKnockout[(m as any).id] as any)?.teamA)] ?? ''
            const teamBen = TEAM_EN[('teamB' in m ? m.teamB : (updatedKnockout[(m as any).id] as any)?.teamB)] ?? ''
            if (!teamAen || !teamBen) continue

            const fixtureId = fixtureMap[`${teamAen}|${teamBen}`] ?? fixtureMap[`${teamBen}|${teamAen}`]
            if (!fixtureId) continue

            // Find the API fixture for period scores
            const apiFixture = fixtures.find(f => f.fixture.id === fixtureId)

            // Get period scores — use fulltime (90 min) instead of final
            if (apiFixture?.score.fulltime.home !== null && 'id' in m && m.id <= 72) {
              const ft = apiFixture.score.fulltime
              const isReversed = TEAM_EN[(m as any).teamB] === apiFixture.teams.home.name
              const r90A = isReversed ? ft.away! : ft.home!
              const r90B = isReversed ? ft.home! : ft.away!
              if (updatedMatches[m.id]) {
                updatedMatches[m.id].resultA = r90A
                updatedMatches[m.id].resultB = r90B
                periodScoreUpdates++
              }
            }

            // Fetch events for red cards
            const events = await fetchFixtureEvents(fixtureId)
            const hasRedCard = events.some(e => e.type === 'Card' && e.detail === 'Red Card')

            if ('id' in m && m.id <= 72) {
              if (updatedMatches[m.id] && updatedMatches[m.id].hadRedCard !== hasRedCard) {
                updatedMatches[m.id].hadRedCard = hasRedCard
                if (hasRedCard) redCardUpdates++
              }
            } else {
              const koId = (m as any).id
              if (updatedKnockout[koId] && (updatedKnockout[koId] as any).hadRedCard !== hasRedCard) {
                (updatedKnockout[koId] as any).hadRedCard = hasRedCard
                if (hasRedCard) redCardUpdates++
              }
            }
          }

          // Save updated red cards + period scores
          await setDoc(doc(db, 'admin', 'results'), { matches: updatedMatches, groups: actualGroups, bonus: actualBonus }, { merge: true })
          await setDoc(doc(db, 'admin', 'knockout'), { matches: updatedKnockout })
          setMatches({ ...updatedMatches })
          setKnockoutMatches({ ...updatedKnockout })
          log.push(`🟥 עודכנו ${redCardUpdates} כרטיסים אדומים`)
          if (periodScoreUpdates > 0) log.push(`⏱️ עודכנו ${periodScoreUpdates} תוצאות 90 דקות מדויקות`)
        } catch (e) {
          log.push(`⚠️ API-Football: ${(e as Error).message}`)
        }
      } else {
        log.push('ℹ️ API-Football לא מוגדר — כרטיסים אדומים ידניים')
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

  const recalcAllScores = async (matchData?: Record<number, Match>) => {
    const data = matchData ?? matches
    const usersSnap = await getDocs(collection(db, 'predictions'))
    const playedMatches = MATCHES.map(m => ({ ...m, ...(data[m.id] ?? {}) })).filter(m => m.isPlayed)
    const batch = writeBatch(db)
    for (const userDoc of usersSnap.docs) {
      const d = userDoc.data()
      const playedKO = KNOCKOUT_MATCHES.map(km => ({ ...km, ...(knockoutMatches[km.id] ?? {}) })).filter(km => km.isPlayed)
      const score = computeUserScore(
        userDoc.id, d.userName ?? 'Unknown',
        (d.matches ?? {}) as Record<number, MatchPrediction>,
        (d.groups ?? {}) as Record<Group, GroupPrediction>,
        d.bonus ?? {}, playedMatches, actualGroups, actualBonus,
        d.knockout ?? {}, playedKO
      )
      batch.set(doc(db, 'scores', userDoc.id), score)
    }
    await batch.commit()
  }

  const saveResults = async () => {
    await setDoc(doc(db, 'admin', 'results'), { matches, groups: actualGroups, bonus: actualBonus })
    setMsg('✓ תוצאות נשמרו')
    setTimeout(() => setMsg(''), 3000)
  }

  const saveKnockout = async () => {
    await setDoc(doc(db, 'admin', 'knockout'), { matches: knockoutMatches })
    setMsg('✓ נוקאאוט נשמר')
    setTimeout(() => setMsg(''), 3000)
  }

  const saveSettings = async () => {
    await setDoc(doc(db, 'settings', 'app'), {
      isOpen: settings.isOpen,
      deadline: settings.deadline ? new Date(settings.deadline).getTime() : null,
      knockoutOpen: settings.knockoutOpen,
      knockoutDeadline: settings.knockoutDeadline ? new Date(settings.knockoutDeadline).getTime() : null,
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
      return { ...prev, [id]: { ...base, [field]: value } as KnockoutMatch }
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
      </div>

      {/* API Sync */}
      {adminTab === 'group' && <>
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

        {/* Knockout settings */}
        <section className="admin-section">
          <h2>הגדרות נוקאאוט</h2>
          <div className="admin-row">
            <label>
              <input type="checkbox" checked={settings.knockoutOpen}
                onChange={e => setSettings(s => ({ ...s, knockoutOpen: e.target.checked }))} />
              &nbsp;חלון R32 פתוח (משתמשים יכולים למלא)
            </label>
          </div>
          <div className="admin-row">
            <label>דדליין נוקאאוט:&nbsp;
              <input type="datetime-local" value={settings.knockoutDeadline}
                onChange={e => setSettings(s => ({ ...s, knockoutDeadline: e.target.value }))} />
            </label>
          </div>
          <button className="btn-primary" onClick={saveSettings}>שמור הגדרות</button>
        </section>

        {/* Knockout match management */}
        {(['R32', 'R16', 'QF', 'SF', '3P', 'F'] as const).map(round => {
          const roundMatches = KNOCKOUT_MATCHES.filter(m => m.round === round)
          return (
            <section key={round} className="admin-section">
              <h2>{KNOCKOUT_ROUND_LABELS[round]}</h2>
              {roundMatches.map(km => {
                const r = knockoutMatches[km.id] ?? km
                return (
                  <div key={km.id} className="admin-match-row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                    <span className={`cat-badge cat-${km.category.toLowerCase()}`}>{km.category}</span>
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
    </div>
  )
}
