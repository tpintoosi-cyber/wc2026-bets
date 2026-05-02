import { useState, useEffect } from 'react'
import { doc, getDoc, setDoc, collection, getDocs, writeBatch } from 'firebase/firestore'
import { db } from '../firebase'
import { MATCHES, GROUPS_TEAMS, TEAM_EN } from '../data/matches'
import { computeUserScore } from '../scoring'
import { Match, Group, GroupPrediction, BonusPredictions, MatchPrediction } from '../types'
import { fetchGroupStageMatches, toIsraelTime } from '../services/wc2026api'

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
  const [settings, setSettings] = useState({ isOpen: true, deadline: '' })
  const [scoring, setScoring] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [msg, setMsg] = useState('')
  const [syncLog, setSyncLog] = useState<string[]>([])

  useEffect(() => {
    ;(async () => {
      const snap = await getDoc(doc(db, 'admin', 'results'))
      if (snap.exists()) {
        setMatches(snap.data().matches ?? {})
        setActualGroups(snap.data().groups ?? {})
        setActualBonus(snap.data().bonus ?? {})
      }
      const s = await getDoc(doc(db, 'settings', 'app'))
      if (s.exists()) {
        const d = s.data()
        setSettings({
          isOpen: d.isOpen ?? true,
          deadline: d.deadline ? new Date(d.deadline).toISOString().slice(0, 16) : '',
        })
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
      const apiMatches = await fetchGroupStageMatches()
      log.push(`✅ התקבלו ${apiMatches.length} משחקים מה-API`)
      setSyncLog([...log])
      const updatedMatches = { ...matches }
      let updatedSchedule = 0
      let updatedResults = 0
      for (const apiMatch of apiMatches) {
        const normHome = API_ALIASES[apiMatch.home_team?.toLowerCase()] ?? apiMatch.home_team?.toLowerCase()
        const normAway = API_ALIASES[apiMatch.away_team?.toLowerCase()] ?? apiMatch.away_team?.toLowerCase()
        const homeHe = EN_TO_HE_MAP[normHome] ?? apiMatch.home_team
        const awayHe = EN_TO_HE_MAP[normAway] ?? apiMatch.away_team
        const ourMatch = MATCHES.find(m =>
          (m.teamA === homeHe && m.teamB === awayHe) ||
          (m.teamA === awayHe && m.teamB === homeHe)
        )
        if (!ourMatch) {
          log.push(`⚠️ לא נמצא: ${apiMatch.home_team} vs ${apiMatch.away_team}`)
          continue
        }
        const current = updatedMatches[ourMatch.id] ?? { ...ourMatch }
        const isReversed = ourMatch.teamA === awayHe
        if (apiMatch.kickoff_utc) {
          (current as any).scheduleIL = toIsraelTime(apiMatch.kickoff_utc)
          updatedSchedule++
        }
        if (apiMatch.status === 'completed' &&
            apiMatch.home_score !== null && apiMatch.away_score !== null) {
          current.resultA = isReversed ? apiMatch.away_score : apiMatch.home_score
          current.resultB = isReversed ? apiMatch.home_score : apiMatch.away_score
          current.isPlayed = true
          updatedResults++
        }
        updatedMatches[ourMatch.id] = current as Match
      }
      setMatches(updatedMatches)
      log.push(`📅 עודכנו ${updatedSchedule} שעות משחק`)
      log.push(`⚽ עודכנו ${updatedResults} תוצאות`)
      await setDoc(doc(db, 'admin', 'results'), {
        matches: updatedMatches, groups: actualGroups, bonus: actualBonus,
      }, { merge: true })
      const scheduleMap: Record<number, string> = {}
      for (const [id, m] of Object.entries(updatedMatches)) {
        if ((m as any).scheduleIL) scheduleMap[Number(id)] = (m as any).scheduleIL
      }
      await setDoc(doc(db, 'admin', 'schedule'), { schedule: scheduleMap })
      log.push('💾 נשמר ב-Firestore')
      if (updatedResults > 0) {
        log.push('🔄 מחשב ניקוד...')
        setSyncLog([...log])
        await recalcAllScores(updatedMatches)
        log.push('🏆 ניקוד עודכן!')
      }
      log.push('✅ סנכרון הושלם!')
      setMsg(`✓ סנכרון הצליח — ${updatedResults} תוצאות, ${updatedSchedule} שעות`)
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
      const score = computeUserScore(
        userDoc.id, d.userName ?? 'Unknown',
        (d.matches ?? {}) as Record<number, MatchPrediction>,
        (d.groups ?? {}) as Record<Group, GroupPrediction>,
        d.bonus ?? {}, playedMatches, actualGroups, actualBonus
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

  const saveSettings = async () => {
    await setDoc(doc(db, 'settings', 'app'), {
      isOpen: settings.isOpen,
      deadline: settings.deadline ? new Date(settings.deadline).getTime() : null,
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

  return (
    <div className="page admin-page">
      <h1>פאנל אדמין</h1>
      {msg && <div className="admin-msg">{msg}</div>}

      {/* API Sync */}
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
          <label>דדליין:&nbsp;
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
                    value={r.resultA ?? 0}
                    onChange={e => updateMatchResult(match.id, 'resultA', parseInt(e.target.value) || 0)} />
                  <span>–</span>
                  <input className="score-input" type="number" min="0" max="20" placeholder="0"
                    value={r.resultB ?? 0}
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

      {/* Recalculate */}
      <section className="admin-section">
        <h2>חישוב ניקוד ידני</h2>
        <button className="btn-primary btn-lg" onClick={recalcScoresBtn} disabled={scoring}>
          {scoring ? 'מחשב...' : '⚡ חשב ניקוד לכולם'}
        </button>
      </section>
    </div>
  )
}
