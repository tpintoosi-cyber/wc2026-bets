import { useState, useEffect } from 'react'
import { collection, onSnapshot, query, orderBy, getDocs } from 'firebase/firestore'
import { db } from '../firebase'
import { useAuth } from '../hooks/useAuth'
import { UserScore } from '../types'

export default function Leaderboard() {
  const { user } = useAuth()
  const [scores, setScores] = useState<UserScore[]>([])
  const [nicknames, setNicknames] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Load nicknames from predictions
    getDocs(collection(db, 'predictions')).then(snap => {
      const nicks: Record<string, string> = {}
      snap.docs.forEach(d => { if (d.data().nickname) nicks[d.id] = d.data().nickname })
      setNicknames(nicks)
    })

    const q = query(collection(db, 'scores'), orderBy('total', 'desc'))
    return onSnapshot(q, snap => {
      setScores(snap.docs.map(d => d.data() as UserScore))
      setLoading(false)
    })
  }, [])

  const displayName = (score: UserScore) => nicknames[score.userId] || score.userName

  if (loading) return <div className="center-screen">טוען טבלה...</div>
  if (!scores.length) return (
    <div className="page">
      <div className="empty-state">
        <div style={{ fontSize: 48 }}>🏆</div>
        <p>הטבלה תתעדכן לאחר תחילת המשחקים</p>
      </div>
    </div>
  )

  const tournamentStarted = scores.some(s => s.total > 0)

  return (
    <div className="page">
      <h1>טבלת ניקוד</h1>

      {!tournamentStarted && (
        <div className="lb-pre-tournament">
          ⏳ הטורניר טרם התחיל — הטבלה תתעדכן אוטומטית לאחר המשחק הראשון ב-12/6/2026
        </div>
      )}
      <div className="leaderboard">
        <div className="lb-header">
          <span className="lb-rank">#</span>
          <span className="lb-name">שחקן</span>
          <span className="lb-pts">משחקים</span>
          <span className="lb-pts">בתים</span>
          <span className="lb-pts">בונוס</span>
          <span className="lb-pts">נוקאאוט</span>
          <span className="lb-total">סה"כ</span>
        </div>
        {scores.map((s, i) => (
          <div key={s.userId} className={`lb-row ${s.userId === user?.uid ? 'lb-me' : ''}`}>
            <span className="lb-rank">
              {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1}
            </span>
            <span className="lb-name">{displayName(s)}</span>
            <span className="lb-pts">{s.matchPoints + s.redCardPoints}</span>
            <span className="lb-pts">{s.groupPoints}</span>
            <span className="lb-pts">{s.bonusPoints}</span>
            <span className="lb-pts">{s.knockoutPoints ?? 0}</span>
            <span className="lb-total">{s.total}</span>
          </div>
        ))}
      </div>
      <p className="hint" style={{ marginTop: 16 }}>
        עמודת "משחקים" כוללת ניקוד 1X2 + תוצאה מדויקת + כרטיסים אדומים
      </p>
    </div>
  )
}
