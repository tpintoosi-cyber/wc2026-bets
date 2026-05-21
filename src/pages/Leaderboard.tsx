import { useState, useEffect } from 'react'
import { collection, onSnapshot, query, orderBy, getDocs } from 'firebase/firestore'
import { db } from '../firebase'
import { useAuth } from '../hooks/useAuth'
import { UserScore } from '../types'
import { FLAGS } from '../data/matches'

function Flag({ emoji, size = 16 }: { emoji: string; size?: number }) {
  if (!emoji) return null
  return <span style={{ fontSize: size, lineHeight: 1 }}>{emoji}</span>
}

export default function Leaderboard() {
  const { user } = useAuth()
  const [scores,    setScores]    = useState<UserScore[]>([])
  const [nicknames, setNicknames] = useState<Record<string, string>>({})
  const [bonusPreds, setBonusPreds] = useState<Record<string, Record<string, string>>>({})
  const [loading,   setLoading]   = useState(true)

  useEffect(() => {
    getDocs(collection(db, 'predictions')).then(snap => {
      const nicks: Record<string, string> = {}
      const bonus: Record<string, Record<string, string>> = {}
      snap.docs.forEach(d => {
        if (d.data().nickname) nicks[d.id] = d.data().nickname
        if (d.data().bonus) bonus[d.id] = d.data().bonus
      })
      setNicknames(nicks)
      setBonusPreds(bonus)
    })

    const q = query(collection(db, 'scores'), orderBy('total', 'desc'))
    return onSnapshot(q, snap => {
      const newScores = snap.docs.map(d => ({ ...d.data() } as UserScore & { prevTotal?: number; prevRank?: number }))
      setScores(newScores)
      setLoading(false)
    })
  }, [])

  const displayName = (s: UserScore) => nicknames[s.userId] || s.userName

  if (loading) return <div className="center-screen">טוען טבלה...</div>
  if (!scores.length) return (
    <div className="page">
      <div className="empty-state">
        <div style={{ fontSize: 48 }}>🏆</div>
        <p>הטבלה תתעדכן לאחר תחילת המשחקים</p>
      </div>
    </div>
  )

  const myIdx   = scores.findIndex(s => s.userId === user?.uid)
  const myScore = myIdx >= 0 ? scores[myIdx] : null
  const leader  = scores[0]
  const maxTotal = leader?.total ?? 1
  const tournamentStarted = scores.some(s => s.total > 0)

  const COLS: { key: string; label: string; hint: string; sub?: boolean }[] = [
    { key: 'match',    label: 'בתים',      hint: '1X2 + תוצאה + 🟥' },
    { key: 'group',    label: 'עולות',     hint: 'עולות מהבתים' },
    { key: 'koR32',    label: '×32',       hint: 'שלב ה-32 האחרונות',  sub: true },
    { key: 'koR16',    label: 'שמינית',    hint: 'שמינית גמר',         sub: true },
    { key: 'koQF',     label: 'רבע',       hint: 'רבע גמר',            sub: true },
    { key: 'koSF',     label: 'חצי',       hint: 'חצי גמר',            sub: true },
    { key: 'koSF3P',   label: '3P',        hint: 'מקום שלישי',         sub: true },
    { key: 'koF',      label: 'גמר',       hint: 'גמר',                sub: true },
    { key: 'bonus',    label: 'בונוס',     hint: 'שאלות בונוס' },
  ]
  const colVal = (s: UserScore, key: string) => {
    if (key === 'match')    return (s.matchPoints ?? 0) + (s.redCardPoints ?? 0)
    if (key === 'group')    return s.groupPoints ?? 0
    if (key === 'koR32')    return s.koR32 ?? 0
    if (key === 'koR16')    return s.koR16 ?? 0
    if (key === 'koQF')     return s.koQF  ?? 0
    if (key === 'koSF')     return s.koSF  ?? 0
    if (key === 'koSF3P')   return s.ko3P  ?? 0
    if (key === 'koF')      return s.koF   ?? 0
    if (key === 'bonus')    return s.bonusPoints ?? 0
    return 0
  }

  return (
    <div className="page" style={{ paddingBottom: 40 }}>
      <style>{`
        @keyframes popIn {
          0%   { transform: scale(0.5) translateY(-6px); opacity: 0 }
          65%  { transform: scale(1.2) translateY(0);    opacity: 1 }
          100% { transform: scale(1)   translateY(0);    opacity: 1 }
        }
        .delta-badge { animation: popIn 0.4s cubic-bezier(.34,1.56,.64,1) both; display: inline-block; }
        .lb-row-bar {
          position: absolute; top: 0; right: 0; bottom: 0;
          border-radius: 10px; opacity: 0.07; pointer-events: none;
          background: linear-gradient(to left, #1a1a2e, transparent);
          transition: width 0.8s ease;
        }
        .lb-me .lb-row-bar { opacity: 0.11; background: linear-gradient(to left, #185FA5, transparent); }
      `}</style>

      <h1 style={{ marginBottom: 12 }}>🏆 טבלת ניקוד</h1>

      {/* ── Personal status card ── */}
      {myScore && tournamentStarted && (
        <div style={{
          background: 'linear-gradient(135deg, #1a1a2e 0%, #2d2d5e 100%)',
          color: '#fff', borderRadius: 14, padding: '16px 20px',
          marginBottom: 20, display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'center',
          boxShadow: '0 4px 20px rgba(26,26,46,0.25)',
        }}>
          <div style={{ textAlign: 'center', minWidth: 56 }}>
            <div style={{ fontSize: 32, lineHeight: 1 }}>
              {myIdx === 0 ? '🥇' : myIdx === 1 ? '🥈' : myIdx === 2 ? '🥉' : `#${myIdx + 1}`}
            </div>
            <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>מתוך {scores.length}</div>
          </div>

          <div style={{ width: 1, background: 'rgba(255,255,255,0.1)', alignSelf: 'stretch' }} />

          <div>
            <div style={{ fontSize: 11, color: '#aaa', marginBottom: 2 }}>הניקוד שלי</div>
            <div style={{ fontSize: 32, fontWeight: 800, color: '#7EC8E3', lineHeight: 1 }}>
              {myScore.total}
              {(() => { const ms = myScore as typeof myScore & { prevTotal?: number }; const d = ms.prevTotal != null && ms.prevTotal !== myScore.total ? myScore.total - ms.prevTotal : null; return d != null && d !== 0 ? (
                <span className="delta-badge" style={{
                  fontSize: 14, marginRight: 8, padding: '2px 8px', borderRadius: 20,
                  background: '#EAF3DE', color: '#1a7a44', fontWeight: 800,
                }}>
                  {d > 0 ? `+${d}` : d}
                </span>
              ) : null })()}
            </div>
            <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>נקודות</div>
          </div>

          {myIdx > 0 && (
            <>
              <div style={{ width: 1, background: 'rgba(255,255,255,0.1)', alignSelf: 'stretch' }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontSize: 12, color: '#ccc' }}>
                  <span style={{ marginLeft: 4 }}>🥇</span>
                  <span style={{ color: '#aaa' }}>עד ראשון: </span>
                  <span style={{ color: '#FF6B6B', fontWeight: 700 }}>-{leader.total - myScore.total}</span>
                </div>
                {myIdx > 0 && (
                  <div style={{ fontSize: 12, color: '#ccc' }}>
                    <span style={{ marginLeft: 4 }}>⬆️</span>
                    <span style={{ color: '#aaa' }}>עד המקום מעלי: </span>
                    <span style={{ color: '#FF6B6B', fontWeight: 700 }}>-{scores[myIdx - 1].total - myScore.total}</span>
                  </div>
                )}
                {myIdx < scores.length - 1 && (
                  <div style={{ fontSize: 12, color: '#ccc' }}>
                    <span style={{ marginLeft: 4 }}>⬇️</span>
                    <span style={{ color: '#aaa' }}>הפרש ממקום תחתי: </span>
                    <span style={{ color: '#51CF66', fontWeight: 700 }}>+{myScore.total - scores[myIdx + 1].total}</span>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {!tournamentStarted && (
        <div className="lb-pre-tournament" style={{ marginBottom: 16 }}>
          ⏳ הטורניר טרם התחיל — הטבלה תתעדכן אוטומטית לאחר המשחק הראשון ב-12/6/2026
        </div>
      )}

      {/* ── Table ── */}
      <div className="leaderboard" style={{ overflowX: 'auto' }}>
        <div className="lb-header">
          <span className="lb-rank">#</span>
          <span className="lb-name">שחקן</span>
          {COLS.map(c => (
            <span key={c.key} className="lb-pts" title={c.hint}
              style={c.sub ? { color: '#93A8CC', fontSize: 11 } : undefined}>
              {c.label}
            </span>
          ))}
          <span className="lb-total">סה"כ</span>
        </div>

        {scores.map((s, i) => {
          const isMe  = s.userId === user?.uid
          const pct   = maxTotal > 0 ? (s.total / maxTotal) * 100 : 0
          const sExt  = s as UserScore & { prevTotal?: number; prevRank?: number }
          const ptsDelta  = sExt.prevTotal != null && sExt.prevTotal !== s.total ? s.total - sExt.prevTotal : null
          const rankDelta = sExt.prevRank  != null && sExt.prevRank  !== (i + 1)  ? sExt.prevRank - (i + 1) : null
          const rank  = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1

          const rowContent = (
            <>
              {tournamentStarted && (
                <div className="lb-row-bar" style={{ width: `${pct}%` }} />
              )}
              <span className="lb-rank" style={{ fontWeight: 800 }}>
                {rank}
                {rankDelta != null && rankDelta !== 0 && (
                  <span style={{ fontSize: 10, marginRight: 2, color: rankDelta > 0 ? '#1a7a44' : '#c0392b' }}>
                    {rankDelta > 0 ? `▲${rankDelta}` : `▼${Math.abs(rankDelta)}`}
                  </span>
                )}
              </span>
              <span className="lb-name" style={{ fontWeight: isMe ? 700 : 400 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    {displayName(s)}
                    {isMe && <span style={{ fontSize: 11, color: '#185FA5', marginRight: 4 }}>(אני)</span>}
                  </div>
                  {bonusPreds[s.userId] && (() => {
                    const b = bonusPreds[s.userId]
                    const items = [
                      b.q105 && { icon: '🏆', val: b.q105, isTeam: true },
                      b.q106 && { icon: '🥈', val: b.q106, isTeam: true },
                      b.q107 && { icon: '🥉', val: b.q107, isTeam: true },
                      b.q108 && { icon: '⚽', val: b.q108, isTeam: false },
                      b.q110 && { icon: '🍳', val: b.q110, isTeam: false },
                    ].filter(Boolean) as { icon: string; val: string; isTeam: boolean }[]
                    if (!items.length) return null
                    return (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {items.map((item, i) => (
                          <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 11, color: '#888' }}>
                            <span>{item.icon}</span>
                            {item.isTeam && <Flag emoji={FLAGS[item.val] ?? ''} size={12} />}
                            <span style={{ maxWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.val}</span>
                          </span>
                        ))}
                      </div>
                    )
                  })()}
                </div>
              </span>
              {COLS.map(c => (
                <span key={c.key} className="lb-pts"
                  style={{ color: colVal(s, c.key) === 0 && tournamentStarted ? '#ccc' : undefined }}>
                  {colVal(s, c.key)}
                </span>
              ))}
              <span className="lb-total" style={{ display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'center' }}>
                <span>{s.total}</span>
                {ptsDelta != null && ptsDelta !== 0 && (
                  <span style={{
                    fontSize: 11, fontWeight: 800, padding: '1px 6px', borderRadius: 20,
                    background: ptsDelta > 0 ? '#EAF3DE' : '#FCEBEB',
                    color:      ptsDelta > 0 ? '#1a7a44' : '#c0392b',
                  }}>
                    {ptsDelta > 0 ? `+${ptsDelta}` : ptsDelta}
                  </span>
                )}
              </span>
            </>
          )

          return (
            <div key={s.userId}>
              {/* Desktop row */}
              <div className={`lb-row lb-row-desktop ${isMe ? 'lb-me' : ''}`}
                style={{ position: 'relative', overflow: 'hidden' }}>
                {rowContent}
              </div>

              {/* Mobile card */}
              <div className={`lb-row-mobile ${isMe ? 'lb-me' : ''}`}
                style={{ position: 'relative', overflow: 'hidden' }}>
                {tournamentStarted && (
                  <div className="lb-row-bar" style={{ width: `${pct}%` }} />
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontWeight: 800, fontSize: 16, minWidth: 28 }}>{rank}</span>
                  <span style={{ flex: 1, fontWeight: isMe ? 700 : 500, fontSize: 14 }}>
                    {displayName(s)}
                    {isMe && <span style={{ fontSize: 11, color: '#185FA5', marginRight: 4 }}>(אני)</span>}
                  </span>
                  <span style={{ fontWeight: 800, fontSize: 20, minWidth: 44, textAlign: 'left' }}>
                    {s.total}
                  </span>
                  {ptsDelta != null && ptsDelta !== 0 && (
                    <span className="delta-badge" style={{
                      fontSize: 11, fontWeight: 800, padding: '1px 6px', borderRadius: 20,
                      background: ptsDelta > 0 ? '#EAF3DE' : '#FCEBEB',
                      color:      ptsDelta > 0 ? '#1a7a44' : '#c0392b',
                    }}>
                      {ptsDelta > 0 ? `+${ptsDelta}` : ptsDelta}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 10, marginTop: 5, paddingRight: 36, flexWrap: 'wrap' }}>
                  {[
                    { label: 'בתים',    val: colVal(s, 'match') },
                    { label: 'עולות',   val: colVal(s, 'group') },
                    { label: 'נוקאאוט', val: s.knockoutPoints ?? 0 },
                    { label: 'בונוס',   val: colVal(s, 'bonus') },
                  ].map(item => (
                    <span key={item.label} style={{ fontSize: 12, color: item.val === 0 && tournamentStarted ? '#ccc' : '#888' }}>
                      {item.label} <b style={{ color: item.val === 0 && tournamentStarted ? '#ccc' : 'var(--text, #1a1a2e)' }}>{item.val}</b>
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <div style={{ display: 'flex', gap: 14, marginTop: 12, flexWrap: 'wrap', fontSize: 12, color: '#999' }}>
        {COLS.map(c => (
          <span key={c.key}><b style={{ color: '#555' }}>{c.label}:</b> {c.hint}</span>
        ))}
      </div>
    </div>
  )
}
