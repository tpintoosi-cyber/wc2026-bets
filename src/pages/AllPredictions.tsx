import { useState, useEffect } from 'react'
import { collection, getDocs, doc, getDoc } from 'firebase/firestore'
import { db } from '../firebase'
import { useAuth } from '../hooks/useAuth'
import { MATCHES, GROUPS_TEAMS, BONUS_QUESTIONS } from '../data/matches'
import { MatchPrediction, GroupPrediction, BonusPredictions, Group } from '../types'

const GROUPS = 'ABCDEFGHIJKL'.split('') as Group[]

interface UserData {
  userId: string
  userName: string
  matches: Record<number, MatchPrediction>
  groups: Record<Group, GroupPrediction>
  bonus: Partial<BonusPredictions>
  lastUpdated?: number
}

type Tab = 'matches' | 'groups' | 'bonus'

export default function AllPredictions() {
  const { user, isAdmin } = useAuth()
  const [users, setUsers] = useState<UserData[]>([])
  const [selectedUser, setSelectedUser] = useState<string | null>(null)
  const [isOpen, setIsOpen] = useState(true)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('matches')

  useEffect(() => {
    ;(async () => {
      // Check if betting is still open
      const settings = await getDoc(doc(db, 'settings', 'app'))
      const open = settings.exists() ? (settings.data().isOpen ?? true) : true
      const deadline = settings.exists() ? settings.data().deadline : null
      const isClosed = !open || (deadline && Date.now() > deadline)
      setIsOpen(!isClosed)

      // Only load all predictions if closed (or admin)
      if (isClosed || isAdmin) {
        const snap = await getDocs(collection(db, 'predictions'))
        const data: UserData[] = snap.docs.map(d => ({
          userId: d.id,
          userName: d.data().userName ?? 'משתמש',
          matches: d.data().matches ?? {},
          groups: d.data().groups ?? {},
          bonus: d.data().bonus ?? {},
          lastUpdated: d.data().lastUpdated,
        }))
        setUsers(data)
        if (data.length > 0) setSelectedUser(data[0].userId)
      }
      setLoading(false)
    })()
  }, [isAdmin])

  if (loading) return <div className="center-screen">טוען...</div>

  if (isOpen && !isAdmin) {
    return (
      <div className="page">
        <div className="empty-state">
          <div style={{ fontSize: 48 }}>🔒</div>
          <h2>ההימורים עוד פתוחים</h2>
          <p>ניתן לראות את ההימורים של כולם רק לאחר סגירת ההגשות</p>
        </div>
      </div>
    )
  }

  if (!users.length) {
    return (
      <div className="page">
        <div className="empty-state">
          <div style={{ fontSize: 48 }}>📋</div>
          <p>אין הימורים עדיין</p>
        </div>
      </div>
    )
  }

  const current = users.find(u => u.userId === selectedUser)

  return (
    <div className="page">
      <h1>הימורי כולם {isAdmin && isOpen && <span className="badge badge-red">מצב אדמין</span>}</h1>

      {/* User selector */}
      <div className="user-selector">
        {users.map(u => (
          <button
            key={u.userId}
            className={`user-btn ${u.userId === selectedUser ? 'active' : ''} ${u.userId === user?.uid ? 'me' : ''}`}
            onClick={() => setSelectedUser(u.userId)}
          >
            {u.userName}
            {u.userId === user?.uid && ' (אני)'}
          </button>
        ))}
      </div>

      {current && (
        <>
          {/* Tabs */}
          <div className="tabs" style={{ marginTop: 12 }}>
            <button className={tab === 'matches' ? 'tab active' : 'tab'} onClick={() => setTab('matches')}>משחקים</button>
            <button className={tab === 'groups' ? 'tab active' : 'tab'} onClick={() => setTab('groups')}>עולים מהבית</button>
            <button className={tab === 'bonus' ? 'tab active' : 'tab'} onClick={() => setTab('bonus')}>בונוס</button>
          </div>

          {/* Matches */}
          {tab === 'matches' && (
            <div className="matches-section">
              {[1, 2, 3].map(round => (
                <div key={round}>
                  <h2 className="round-title">סיבוב {round}</h2>
                  {GROUPS.map(group => {
                    const ms = MATCHES.filter(m => m.round === round && m.group === group)
                    if (!ms.length) return null
                    return (
                      <div key={group} className="group-block">
                        <div className="group-label">בית {group}</div>
                        {ms.map(match => {
                          const p = current.matches[match.id]
                          if (!p) return (
                            <div key={match.id} className="match-row view-row empty-pred">
                              <span className="match-num">#{match.id}</span>
                              <span className={`cat-badge cat-${match.category.toLowerCase()}`}>{match.category}</span>
                              <span className="team-name">{match.teamA}</span>
                              <span style={{ color: '#aaa', margin: '0 8px' }}>—</span>
                              <span className="team-name">{match.teamB}</span>
                              <span style={{ color: '#ccc', fontSize: 12, marginRight: 'auto' }}>לא מולא</span>
                            </div>
                          )
                          return (
                            <div key={match.id} className="match-row view-row">
                              <span className="match-num">#{match.id}</span>
                              <span className={`cat-badge cat-${match.category.toLowerCase()}`}>{match.category}</span>
                              <span className="team-name">{match.teamA}</span>
                              <span className="view-score">
                                {p.scoreA ?? '?'} – {p.scoreB ?? '?'}
                              </span>
                              <span className="team-name">{match.teamB}</span>
                              <span className={`pred-1x2 pred-${p.prediction1X2?.toLowerCase()}`}>
                                {p.prediction1X2 === '1' ? match.teamA.slice(0, 3) : p.prediction1X2 === '2' ? match.teamB.slice(0, 3) : 'X'}
                              </span>
                              {p.redCard && <span title="ניחש כרטיס אדום">🟥</span>}
                            </div>
                          )
                        })}
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
          )}

          {/* Groups */}
          {tab === 'groups' && (
            <div className="groups-section">
              <div className="groups-grid">
                {GROUPS.map(group => {
                  const gp = current.groups[group]
                  return (
                    <div key={group} className="group-card">
                      <div className="group-card-title">בית {group}</div>
                      {[0, 1, 2].map(idx => (
                        <div key={idx} className="group-slot">
                          <span className="slot-num">{idx + 1}.</span>
                          <span style={{ fontSize: 13 }}>{gp?.advancing[idx] || <span style={{ color: '#ccc' }}>—</span>}</span>
                        </div>
                      ))}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Bonus */}
          {tab === 'bonus' && (
            <div className="bonus-section">
              {BONUS_QUESTIONS.map(q => (
                <div key={q.id} className="bonus-row">
                  <div className="bonus-label">
                    {q.label}
                    <span className="pts-badge">{q.points} נק׳</span>
                  </div>
                  <div style={{ fontSize: 14, color: (current.bonus as any)[q.id] ? '#1a1a2e' : '#ccc' }}>
                    {(current.bonus as any)[q.id] || 'לא מולא'}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
