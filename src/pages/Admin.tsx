import { useState, useEffect } from 'react'
import { doc, getDoc, setDoc, collection, getDocs, writeBatch } from 'firebase/firestore'
import { db } from '../firebase'
import { MATCHES, GROUPS_TEAMS } from '../data/matches'
import { computeUserScore } from '../scoring'
import { Match, Group, GroupPrediction, BonusPredictions, MatchPrediction } from '../types'

const GROUPS = 'ABCDEFGHIJKL'.split('') as Group[]

export default function Admin() {
  const [matches, setMatches] = useState<Record<number, Match>>({})
  const [actualGroups, setActualGroups] = useState<Record<string, [string, string, string]>>({})
  const [actualBonus, setActualBonus] = useState<Partial<BonusPredictions>>({})
  const [settings, setSettings] = useState({ isOpen: true, deadline: '' })
  const [scoring, setScoring] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    ;(async () => {
      // Load match results
      const snap = await getDoc(doc(db, 'admin', 'results'))
      if (snap.exists()) {
        setMatches(snap.data().matches ?? {})
        setActualGroups(snap.data().groups ?? {})
        setActualBonus(snap.data().bonus ?? {})
      }
      // Load settings
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

  const recalcAllScores = async () => {
    setScoring(true)
    setMsg('מחשב ניקוד לכל המשתמשים...')
    try {
      const usersSnap = await getDocs(collection(db, 'predictions'))
      const playedMatches = MATCHES.map(m => ({ ...m, ...(matches[m.id] ?? {}) })).filter(m => m.isPlayed)
      const batch = writeBatch(db)

      for (const userDoc of usersSnap.docs) {
        const data = userDoc.data()
        const score = computeUserScore(
          userDoc.id,
          data.userName ?? 'Unknown',
          (data.matches ?? {}) as Record<number, MatchPrediction>,
          (data.groups ?? {}) as Record<Group, GroupPrediction>,
          data.bonus ?? {},
          playedMatches,
          actualGroups,
          actualBonus
        )
        batch.set(doc(db, 'scores', userDoc.id), score)
      }
      await batch.commit()
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
          <label>דדליין (תאריך + שעה):&nbsp;
            <input type="datetime-local" value={settings.deadline}
              onChange={e => setSettings(s => ({ ...s, deadline: e.target.value }))} />
          </label>
        </div>
        <button className="btn-primary" onClick={saveSettings}>שמור הגדרות</button>
      </section>

      {/* Match results */}
      <section className="admin-section">
        <h2>תוצאות משחקים</h2>
        <p className="hint">מלא תוצאה וסמן "הושלם" כדי שהמשחק ייכנס לחישוב הניקוד</p>
        {[1, 2, 3].map(round => (
          <div key={round}>
            <h3>סיבוב {round}</h3>
            {MATCHES.filter(m => m.round === round).map(match => {
              const r = matches[match.id] ?? match
              return (
                <div key={match.id} className="admin-match-row">
                  <span className="admin-match-teams">{match.teamA} — {match.teamB}</span>
                  <span className={`cat-badge cat-${match.category.toLowerCase()}`}>{match.category}</span>
                  <input className="score-input" type="number" min="0" max="20" placeholder="A"
                    value={r.resultA ?? ''} onChange={e => updateMatchResult(match.id, 'resultA', parseInt(e.target.value) || 0)} />
                  <span>–</span>
                  <input className="score-input" type="number" min="0" max="20" placeholder="B"
                    value={r.resultB ?? ''} onChange={e => updateMatchResult(match.id, 'resultB', parseInt(e.target.value) || 0)} />
                  <label title="היה כרטיס אדום">
                    <input type="checkbox" checked={r.hadRedCard ?? false}
                      onChange={e => updateMatchResult(match.id, 'hadRedCard', e.target.checked)} />
                    &nbsp;🟥
                  </label>
                  <label title="משחק הושלם">
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

      {/* Actual group standings */}
      <section className="admin-section">
        <h2>סיום שלב הבתים — נבחרות עולות בפועל</h2>
        <div className="groups-grid">
          {GROUPS.map(group => (
            <div key={group} className="group-card">
              <div className="group-card-title">בית {group}</div>
              {[0, 1, 2].map(idx => (
                <div key={idx} className="group-slot">
                  <span className="slot-num">{idx + 1}.</span>
                  <select
                    value={actualGroups[group]?.[idx] ?? ''}
                    onChange={e => {
                      setActualGroups(prev => {
                        const cur = [...(prev[group] ?? ['', '', ''])] as [string, string, string]
                        cur[idx] = e.target.value
                        return { ...prev, [group]: cur }
                      })
                    }}
                  >
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
        <h2>חישוב ניקוד</h2>
        <p className="hint">לחץ לאחר עדכון תוצאות. מחשב ניקוד לכל המשתמשים.</p>
        <button className="btn-primary btn-lg" onClick={recalcAllScores} disabled={scoring}>
          {scoring ? 'מחשב...' : '⚡ חשב ניקוד לכולם'}
        </button>
      </section>
    </div>
  )
}
