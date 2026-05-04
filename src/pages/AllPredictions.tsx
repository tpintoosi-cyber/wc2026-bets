import { useState, useEffect } from 'react'
import { collection, getDocs, doc, getDoc } from 'firebase/firestore'
import { db } from '../firebase'
import { useAuth } from '../hooks/useAuth'
import { MATCHES, GROUPS_TEAMS, BONUS_QUESTIONS, FLAGS } from '../data/matches'
import { MatchPrediction, GroupPrediction, BonusPredictions, Group, Match } from '../types'
import { calc1X2Points, calcScorePoints, calcRedCardPoints, calcGroupPoints, calcBonusPoints } from '../scoring'

const GROUPS = 'ABCDEFGHIJKL'.split('') as Group[]

interface UserData {
  userId: string
  userName: string
  matches: Record<number, MatchPrediction>
  groups: Record<Group, GroupPrediction>
  bonus: Partial<BonusPredictions>
}

type MainTab = 'user' | 'match' | 'stats' | 'consensus' | 'ranking'
type UserTab = 'matches' | 'groups' | 'bonus'

function PtsBadge({ pts, played }: { pts: number; played: boolean }) {
  if (!played) return null
  const bg = pts > 0 ? '#1a7a44' : '#888'
  return (
    <span style={{ background: bg, color: '#fff', fontWeight: 700, fontSize: 12,
      padding: '2px 8px', borderRadius: 20, whiteSpace: 'nowrap', display: 'inline-block' }}>
      {pts > 0 ? `+${pts}` : '0'} נק׳
    </span>
  )
}

function ResultTag({ label, type }: { label: string; type: 'ok' | 'warn' | 'bad' | 'gray' }) {
  const styles = {
    ok:   { background: '#EAF3DE', color: '#3B6D11' },
    warn: { background: '#E6F1FB', color: '#185FA5' },
    bad:  { background: '#FCEBEB', color: '#A32D2D' },
    gray: { background: '#f0f0f0', color: '#888' },
  }
  return <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 10, ...styles[type] }}>{label}</span>
}

export default function AllPredictions() {
  const { user, isAdmin } = useAuth()
  const [users, setUsers] = useState<UserData[]>([])
  const [selectedUser, setSelectedUser] = useState<string | null>(null)
  const [selectedMatchId, setSelectedMatchId] = useState<number>(1)
  const [isOpen, setIsOpen] = useState(true)
  const [loading, setLoading] = useState(true)
  const [mainTab, setMainTab] = useState<MainTab>('user')
  const [userTab, setUserTab] = useState<UserTab>('matches')
  const [adminResults, setAdminResults] = useState<Record<number, Match>>({})
  const [actualGroups, setActualGroups] = useState<Record<string, [string, string, string]>>({})
  const [actualBonus, setActualBonus] = useState<Partial<BonusPredictions>>({})
  const [scores, setScores] = useState<Record<string, number>>({})

  useEffect(() => {
    ;(async () => {
      const settings = await getDoc(doc(db, 'settings', 'app'))
      const open = settings.exists() ? (settings.data().isOpen ?? true) : true
      const deadline = settings.exists() ? settings.data().deadline : null
      const isClosed = !open || (deadline && Date.now() > deadline)
      setIsOpen(!isClosed)

      const resultsSnap = await getDoc(doc(db, 'admin', 'results'))
      if (resultsSnap.exists()) {
        setAdminResults(resultsSnap.data().matches ?? {})
        setActualGroups(resultsSnap.data().groups ?? {})
        setActualBonus(resultsSnap.data().bonus ?? {})
      }

      if (isClosed || isAdmin) {
        const snap = await getDocs(collection(db, 'predictions'))
        const data: UserData[] = snap.docs.map(d => ({
          userId: d.id, userName: d.data().userName ?? 'משתמש',
          matches: d.data().matches ?? {}, groups: d.data().groups ?? {}, bonus: d.data().bonus ?? {},
        }))
        setUsers(data)
        if (data.length > 0) {
          const me = data.find(u => u.userId === user?.uid)
          setSelectedUser(me ? me.userId : data[0].userId)
        }

        const scoresSnap = await getDocs(collection(db, 'scores'))
        const sc: Record<string, number> = {}
        scoresSnap.docs.forEach(d => { sc[d.id] = d.data().total ?? 0 })
        setScores(sc)
      }
      setLoading(false)
    })()
  }, [isAdmin])

  // ── Scoring helpers ──────────────────────────────────────────────
  function getMatchPts(matchId: number, pred: MatchPrediction | undefined): number {
    if (!pred) return 0
    const result = adminResults[matchId]
    if (!result?.isPlayed || result.resultA == null || result.resultB == null) return 0
    const match = MATCHES.find(m => m.id === matchId)!
    const rA = Number(result.resultA), rB = Number(result.resultB)
    const p1 = calc1X2Points(pred.prediction1X2, rA, rB, match.fifaPointsA, match.fifaPointsB, match.category)
    const ps = pred.scoreA != null && pred.scoreB != null ? calcScorePoints(Number(pred.scoreA), Number(pred.scoreB), rA, rB, match.category) : 0
    const pr = calcRedCardPoints(pred.redCard, result.hadRedCard ?? false)
    return p1 + ps + pr
  }

  function getBreakdown(matchId: number, pred: MatchPrediction | undefined): { label: string }[] {
    if (!pred) return []
    const result = adminResults[matchId]
    if (!result?.isPlayed || result.resultA == null || result.resultB == null) return []
    const match = MATCHES.find(m => m.id === matchId)!
    const rA = Number(result.resultA), rB = Number(result.resultB)
    const pA = pred.scoreA != null ? Number(pred.scoreA) : null
    const pB = pred.scoreB != null ? Number(pred.scoreB) : null
    const items: { label: string }[] = []
    const p1 = calc1X2Points(pred.prediction1X2, rA, rB, match.fifaPointsA, match.fifaPointsB, match.category)
    if (p1 > 0) items.push({ label: `1X2: +${p1}` })
    if (pA !== null && pB !== null) {
      if (pA === rA && pB === rB) {
        items.push({ label: 'מדויק: +2' })
        const total = rA + rB
        const isOU = (match.category === 'A' || match.category === 'B') ? (total <= 1 || total >= 4) : (total <= 2 || total >= 5)
        if (isOU) items.push({ label: (total <= ((match.category === 'A' || match.category === 'B') ? 1 : 2) ? 'אנדר' : 'אובר') + ': +1' })
      } else if ((pA - pB) === (rA - rB)) {
        items.push({ label: 'הפרש: +1' })
      }
    }
    const pr = calcRedCardPoints(pred.redCard, result.hadRedCard ?? false)
    if (pr > 0) items.push({ label: '🟥: +2' })
    return items
  }

  function getTag(matchId: number, pred: MatchPrediction | undefined, pts: number): { label: string; type: 'ok' | 'warn' | 'bad' | 'gray' } | null {
    if (!pred) return null
    const result = adminResults[matchId]
    if (!result?.isPlayed) return null
    const rA = Number(result.resultA ?? 0), rB = Number(result.resultB ?? 0)
    const pA = pred.scoreA != null ? Number(pred.scoreA) : null
    const pB = pred.scoreB != null ? Number(pred.scoreB) : null
    if (pts === 0) return { label: '✗ שגוי', type: 'bad' }
    const exact = pA === rA && pB === rB
    const actual1x2 = rA > rB ? '1' : rA < rB ? '2' : 'X'
    const correct1x2 = pred.prediction1X2 === actual1x2
    const marginOk = pA !== null && pB !== null && (pA - pB) === (rA - rB)
    if (exact && correct1x2) return { label: '✓ מדויק', type: 'ok' }
    if (correct1x2 && marginOk) return { label: '1X2 + הפרש', type: 'ok' }
    if (correct1x2) return { label: '✓ 1X2 נכון', type: 'ok' }
    if (marginOk) return { label: 'הפרש נכון', type: 'warn' }
    return { label: '+נק׳ נוספות', type: 'warn' }
  }

  // ── Guards ───────────────────────────────────────────────────────
  if (loading) return <div className="center-screen">טוען...</div>
  if (isOpen && !isAdmin) return (
    <div className="page"><div className="empty-state">
      <div style={{ fontSize: 48 }}>🔒</div>
      <h2>ההימורים עוד פתוחים</h2>
      <p>ניתן לראות את ההימורים של כולם רק לאחר סגירת ההגשות</p>
    </div></div>
  )
  if (!users.length) return (
    <div className="page"><div className="empty-state">
      <div style={{ fontSize: 48 }}>📋</div><p>אין הימורים עדיין</p>
    </div></div>
  )

  const current = users.find(u => u.userId === selectedUser)
  const playedMatches = MATCHES.filter(m => adminResults[m.id]?.isPlayed)

  const TAB_LABELS: { id: MainTab; label: string }[] = [
    { id: 'user',      label: '👤 לפי משתמש' },
    { id: 'match',     label: '⚽ לפי משחק' },
    { id: 'stats',     label: '📊 סטטיסטיקות' },
    { id: 'consensus', label: '🤝 הסכמה' },
    { id: 'ranking',   label: '🏆 דירוג' },
  ]

  return (
    <div className="page">
      <h1>הימורי כולם {isAdmin && isOpen && <span className="badge badge-red">מצב אדמין</span>}</h1>

      {/* Main tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 14, background: 'var(--bg-card, #fff)', borderRadius: 12, padding: 4, border: '1px solid var(--border, #e5e5e5)', flexWrap: 'wrap' }}>
        {TAB_LABELS.map(t => (
          <button key={t.id} onClick={() => setMainTab(t.id)} style={{
            flex: 1, minWidth: 80, padding: '8px 6px', borderRadius: 9, border: 'none', cursor: 'pointer',
            fontSize: 12, fontWeight: 500, fontFamily: 'inherit',
            background: mainTab === t.id ? '#1a1a2e' : 'transparent',
            color: mainTab === t.id ? '#fff' : '#666',
          }}>{t.label}</button>
        ))}
      </div>

      {/* ═══════════════════════════════════════════════════════════
          TAB 1: לפי משתמש
      ═══════════════════════════════════════════════════════════ */}
      {mainTab === 'user' && (
        <>
          <div className="user-selector">
            {users.map(u => (
              <button key={u.userId}
                className={`user-btn ${u.userId === selectedUser ? 'active' : ''} ${u.userId === user?.uid ? 'me' : ''}`}
                onClick={() => setSelectedUser(u.userId)}>
                {u.userName}{u.userId === user?.uid ? ' (אני)' : ''}
              </button>
            ))}
          </div>

          {current && (
            <>
              <div className="tabs" style={{ marginTop: 12 }}>
                <button className={userTab === 'matches' ? 'tab active' : 'tab'} onClick={() => setUserTab('matches')}>משחקים</button>
                <button className={userTab === 'groups' ? 'tab active' : 'tab'} onClick={() => setUserTab('groups')}>עולים מהבית</button>
                <button className={userTab === 'bonus' ? 'tab active' : 'tab'} onClick={() => setUserTab('bonus')}>בונוס</button>
              </div>

              {userTab === 'matches' && (
                <div>
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
                              const result = adminResults[match.id]
                              const played = result?.isPlayed ?? false
                              const pts = getMatchPts(match.id, p)
                              const breakdown = played ? getBreakdown(match.id, p) : []
                              const tag = getTag(match.id, p, pts)
                              const borderColor = !played ? 'transparent' : pts > 0 ? '#3B6D11' : '#ddd'

                              if (!p) return (
                                <div key={match.id} className="match-row" style={{ borderRight: `3px solid ${played ? '#ddd' : 'transparent'}` }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <span className="match-num">#{match.id}</span>
                                    <span className={`cat-badge cat-${match.category.toLowerCase()}`}>{match.category}</span>
                                    <span style={{ fontSize: 13 }}>{FLAGS[match.teamA]} {match.teamA}</span>
                                    <span style={{ color: '#aaa', fontSize: 12 }}>נגד</span>
                                    <span style={{ fontSize: 13 }}>{match.teamB} {FLAGS[match.teamB]}</span>
                                    <span style={{ marginRight: 'auto', fontSize: 12, color: '#ccc' }}>לא מולא</span>
                                    {played && <PtsBadge pts={0} played={true} />}
                                  </div>
                                </div>
                              )

                              return (
                                <div key={match.id} className="match-row" style={{ borderRight: `3px solid ${borderColor}` }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                                    <span className="match-num">#{match.id}</span>
                                    <span className={`cat-badge cat-${match.category.toLowerCase()}`}>{match.category}</span>
                                    <span style={{ fontSize: 13, fontWeight: 500 }}>{FLAGS[match.teamA]} {match.teamA}</span>
                                    <span style={{ color: '#aaa', fontSize: 12 }}>נגד</span>
                                    <span style={{ fontSize: 13, fontWeight: 500 }}>{match.teamB} {FLAGS[match.teamB]}</span>
                                    <span style={{ marginRight: 'auto' }} />
                                    {played && <PtsBadge pts={pts} played={true} />}
                                  </div>
                                  <div style={{ borderTop: '1px solid #f0f0f0', paddingTop: 8, display: 'flex', gap: 0, alignItems: 'stretch' }}>
                                    <div style={{ flex: 1 }}>
                                      <div style={{ fontSize: 11, color: '#aaa', fontWeight: 600, marginBottom: 5 }}>ניחוש שלי</div>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                        <span style={{ fontSize: 13, fontWeight: 600 }}>{match.teamB}</span>
                                        <span style={{ fontSize: 15, fontWeight: 700 }}>{p.scoreB ?? '?'}</span>
                                        <span style={{ color: '#aaa' }}>–</span>
                                        <span style={{ fontSize: 15, fontWeight: 700 }}>{p.scoreA ?? '?'}</span>
                                        <span style={{ fontSize: 13, fontWeight: 600 }}>{match.teamA}</span>
                                        <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: '#1a1a2e', color: '#fff' }}>
                                          {p.prediction1X2 === '1' ? match.teamA : p.prediction1X2 === '2' ? match.teamB : 'תיקו'}
                                        </span>
                                        {p.redCard && <span style={{ fontSize: 11, background: '#FCEBEB', color: '#A32D2D', padding: '1px 6px', borderRadius: 10 }}>🟥</span>}
                                      </div>
                                    </div>
                                    {played && <div style={{ width: 1, background: '#e5e5e5', margin: '0 14px', flexShrink: 0 }} />}
                                    {played && (
                                      <div style={{ flex: 1 }}>
                                        <div style={{ fontSize: 11, color: '#aaa', fontWeight: 600, marginBottom: 5, display: 'flex', justifyContent: 'space-between' }}>
                                          <span>בפועל</span>
                                          {tag && <ResultTag label={tag.label} type={tag.type} />}
                                        </div>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                          <span style={{ fontSize: 13, fontWeight: 600, color: '#555' }}>{match.teamB}</span>
                                          <span style={{ fontSize: 15, fontWeight: 700, color: '#555' }}>{result.resultB ?? 0}</span>
                                          <span style={{ color: '#aaa' }}>–</span>
                                          <span style={{ fontSize: 15, fontWeight: 700, color: '#555' }}>{result.resultA ?? 0}</span>
                                          <span style={{ fontSize: 13, fontWeight: 600, color: '#555' }}>{match.teamA}</span>
                                          {result.hadRedCard && <span style={{ fontSize: 11, background: '#FCEBEB', color: '#A32D2D', padding: '1px 6px', borderRadius: 10 }}>🟥</span>}
                                        </div>
                                        {breakdown.length > 0 && (
                                          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
                                            {breakdown.map((b, i) => (
                                              <span key={i} style={{ fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 10, background: '#EAF3DE', color: '#3B6D11' }}>{b.label}</span>
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                    )}
                                  </div>
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

              {userTab === 'groups' && (
                <div className="groups-section">
                  <div className="groups-grid">
                    {GROUPS.map(group => {
                      const gp = current.groups[group]
                      const actual = actualGroups[group]
                      const hasResult = actual?.[0]
                      const pts = hasResult && gp ? calcGroupPoints(gp.advancing, actual) : 0
                      return (
                        <div key={group} className="group-card" style={hasResult && pts > 0 ? { borderColor: '#1a7a44', borderWidth: 2 } : {}}>
                          <div className="group-card-title" style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span>בית {group}</span>
                            {hasResult && <PtsBadge pts={pts} played={true} />}
                          </div>
                          {[0, 1, 2].map(idx => {
                            const predTeam = gp?.advancing[idx]
                            const actualTeam = actual?.[idx]
                            const isExact = predTeam && actualTeam && predTeam === actualTeam
                            const isCorrectWrongPos = predTeam && actual && actual.includes(predTeam) && !isExact
                            const isWrong = predTeam && actual?.[0] && !actual.includes(predTeam)
                            return (
                              <div key={idx} className="group-slot">
                                <span className="slot-num">{idx + 1}.</span>
                                <span style={{ fontSize: 13, flex: 1, fontWeight: isExact ? 700 : 400, color: isExact ? '#1a7a44' : isCorrectWrongPos ? '#185FA5' : isWrong ? '#c00' : '#333' }}>
                                  {predTeam ? `${FLAGS[predTeam] ?? ''} ${predTeam}` : <span style={{ color: '#ccc' }}>—</span>}
                                </span>
                                {isExact && <span style={{ fontSize: 11 }}>✓✓</span>}
                                {isCorrectWrongPos && <span style={{ fontSize: 11 }}>✓</span>}
                                {isWrong && hasResult && <span style={{ fontSize: 11, color: '#c00' }}>✗</span>}
                              </div>
                            )
                          })}
                          {hasResult && (
                            <div style={{ marginTop: 8, borderTop: '1px solid #f0f0f0', paddingTop: 6 }}>
                              <div style={{ fontSize: 11, color: '#888', marginBottom: 3 }}>בפועל:</div>
                              {[0, 1, 2].map(idx => (
                                <div key={idx} style={{ fontSize: 12, color: '#555' }}>{idx + 1}. {FLAGS[actual[idx]] ?? ''} {actual[idx]}</div>
                              ))}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {userTab === 'bonus' && (
                <div className="bonus-section">
                  {BONUS_QUESTIONS.map(q => {
                    const predVal = (current.bonus as any)?.[q.id]
                    const actualVal = (actualBonus as any)?.[q.id]
                    const hasResult = !!actualVal
                    const isCorrect = hasResult && predVal?.trim().toLowerCase() === actualVal?.trim().toLowerCase()
                    const isWrong = hasResult && predVal && !isCorrect
                    return (
                      <div key={q.id} className="bonus-row" style={isCorrect ? { borderColor: '#1a7a44', borderWidth: 2 } : {}}>
                        <div className="bonus-label" style={{ justifyContent: 'space-between' }}>
                          <span>{q.label}<span className="pts-badge" style={{ marginRight: 6 }}>{q.points} נק׳</span></span>
                          {hasResult && <PtsBadge pts={isCorrect ? parseInt(q.points) : 0} played={true} />}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 14, color: isCorrect ? '#1a7a44' : isWrong ? '#c00' : predVal ? '#1a1a2e' : '#ccc', fontWeight: isCorrect ? 700 : 400 }}>
                            {isCorrect && '✓ '}{isWrong && '✗ '}{predVal || 'לא מולא'}
                          </span>
                          {hasResult && !isCorrect && <span style={{ fontSize: 12, color: '#888' }}>(בפועל: {actualVal})</span>}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════
          TAB 2: לפי משחק
      ═══════════════════════════════════════════════════════════ */}
      {mainTab === 'match' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
            <label style={{ fontSize: 13, color: '#666' }}>בחר משחק:</label>
            <select value={selectedMatchId} onChange={e => setSelectedMatchId(Number(e.target.value))}
              style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 13, fontFamily: 'inherit', flex: 1 }}>
              {MATCHES.map(m => (
                <option key={m.id} value={m.id}>
                  #{m.id} {m.teamA} נגד {m.teamB} ({m.category})
                  {adminResults[m.id]?.isPlayed ? ' ✓' : ''}
                </option>
              ))}
            </select>
          </div>

          {(() => {
            const match = MATCHES.find(m => m.id === selectedMatchId)!
            const result = adminResults[selectedMatchId]
            const played = result?.isPlayed ?? false
            return (
              <div className="match-row">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <span className={`cat-badge cat-${match.category.toLowerCase()}`}>{match.category}</span>
                  <span style={{ fontSize: 15, fontWeight: 600 }}>{FLAGS[match.teamA]} {match.teamA}</span>
                  <span style={{ color: '#aaa' }}>נגד</span>
                  <span style={{ fontSize: 15, fontWeight: 600 }}>{match.teamB} {FLAGS[match.teamB]}</span>
                  {played && (
                    <span style={{ marginRight: 'auto', fontSize: 13, background: '#f5f5f5', padding: '4px 10px', borderRadius: 8, fontWeight: 600 }}>
                      בפועל: {match.teamA} {result.resultA ?? 0} – {result.resultB ?? 0} {match.teamB}
                      {result.hadRedCard ? ' 🟥' : ''}
                    </span>
                  )}
                </div>

                <div style={{ borderTop: '1px solid #f0f0f0', paddingTop: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontSize: 11, color: '#aaa', fontWeight: 600 }}>
                    <span style={{ minWidth: 100 }}>משתמש</span>
                    <span style={{ minWidth: 80, textAlign: 'center' }}>ניחוש</span>
                    <span style={{ minWidth: 80, textAlign: 'center' }}>1X2</span>
                    <span style={{ minWidth: 30, textAlign: 'center' }}>🟥</span>
                    {played && <span style={{ marginRight: 'auto', minWidth: 50, textAlign: 'center' }}>נק׳</span>}
                    {played && <span style={{ minWidth: 80, textAlign: 'center' }}>תוצאה</span>}
                  </div>
                  {users.map(u => {
                    const p = u.matches[selectedMatchId]
                    const pts = played ? getMatchPts(selectedMatchId, p) : 0
                    const tag = played ? getTag(selectedMatchId, p, pts) : null
                    return (
                      <div key={u.userId} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 0', borderBottom: '1px solid #f5f5f5',
                        background: u.userId === user?.uid ? '#f8f9ff' : 'transparent' }}>
                        <span style={{ minWidth: 100, fontSize: 13, fontWeight: u.userId === user?.uid ? 700 : 400 }}>
                          {u.userName}{u.userId === user?.uid ? ' (אני)' : ''}
                        </span>
                        {p ? <>
                          <span style={{ minWidth: 80, textAlign: 'center', fontSize: 13, fontWeight: 600, direction: 'ltr', display: 'inline-block' }}>
                            {p.scoreA ?? '?'} – {p.scoreB ?? '?'}
                          </span>
                          <span style={{ minWidth: 80, textAlign: 'center' }}>
                            <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 10, background: '#f0f0f0', color: '#333' }}>
                              {p.prediction1X2 === '1' ? match.teamA : p.prediction1X2 === '2' ? match.teamB : 'תיקו'}
                            </span>
                          </span>
                          <span style={{ minWidth: 30, textAlign: 'center', fontSize: 13 }}>{p.redCard ? '🟥' : '—'}</span>
                        </> : <span style={{ fontSize: 12, color: '#ccc', minWidth: 190 }}>לא מולא</span>}
                        {played && <PtsBadge pts={pts} played={true} />}
                        {played && tag && <ResultTag label={tag.label} type={tag.type} />}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })()}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════
          TAB 3: סטטיסטיקות
      ═══════════════════════════════════════════════════════════ */}
      {mainTab === 'stats' && (
        <div>
          {/* Summary stats */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, marginBottom: 16 }}>
            {[
              { label: 'משתתפים', value: users.length },
              { label: 'משחקים שהוחלטו', value: playedMatches.length },
              { label: 'ניחושים מדויקים', value: (() => {
                let count = 0
                users.forEach(u => playedMatches.forEach(m => {
                  const p = u.matches[m.id], r = adminResults[m.id]
                  if (p?.scoreA != null && p?.scoreB != null && r?.resultA != null)
                    if (Number(p.scoreA) === Number(r.resultA) && Number(p.scoreB) === Number(r.resultB)) count++
                }))
                return count
              })() },
              { label: 'כרטיסים שניחשו', value: (() => {
                let count = 0
                users.forEach(u => playedMatches.forEach(m => {
                  const p = u.matches[m.id], r = adminResults[m.id]
                  if (p?.redCard && r?.hadRedCard) count++
                }))
                return count
              })() },
            ].map((s, i) => (
              <div key={i} style={{ background: '#f8f9fa', borderRadius: 10, padding: 12, textAlign: 'center', border: '1px solid #e5e5e5' }}>
                <div style={{ fontSize: 24, fontWeight: 700, color: '#1a1a2e' }}>{s.value}</div>
                <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{s.label}</div>
              </div>
            ))}
          </div>

          {/* Per match 1X2 distribution */}
          <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 10, color: '#444' }}>התפלגות ניחושי 1X2 לפי משחק</h2>
          {playedMatches.slice(0, 10).map(match => {
            const preds = users.map(u => u.matches[match.id]?.prediction1X2).filter(Boolean)
            const total = preds.length || 1
            const count1 = preds.filter(p => p === '1').length
            const countX = preds.filter(p => p === 'X').length
            const count2 = preds.filter(p => p === '2').length
            const result = adminResults[match.id]
            const actual = result?.resultA != null ? (Number(result.resultA) > Number(result.resultB) ? '1' : Number(result.resultA) < Number(result.resultB) ? '2' : 'X') : null
            return (
              <div key={match.id} className="match-row" style={{ marginBottom: 8, padding: '10px 12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                  <span className="match-num">#{match.id}</span>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{FLAGS[match.teamA]} {match.teamA}</span>
                  <span style={{ color: '#aaa', fontSize: 12 }}>נגד</span>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{match.teamB} {FLAGS[match.teamB]}</span>
                  <span style={{ marginRight: 'auto', fontSize: 12, color: '#888' }}>
                    בפועל: {result.resultA} – {result.resultB}
                    {actual && <span style={{ marginRight: 6, fontSize: 11, fontWeight: 600, padding: '1px 7px', borderRadius: 10, background: '#EAF3DE', color: '#3B6D11' }}>
                      {actual === '1' ? match.teamA : actual === '2' ? match.teamB : 'תיקו'}
                    </span>}
                  </span>
                </div>
                {[
                  { label: match.teamA, count: count1, x2: '1' },
                  { label: 'תיקו', count: countX, x2: 'X' },
                  { label: match.teamB, count: count2, x2: '2' },
                ].map(row => {
                  const pct = Math.round((row.count / total) * 100)
                  const isWinner = row.x2 === actual
                  return (
                    <div key={row.x2} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 12, minWidth: 70, color: isWinner ? '#1a7a44' : '#555', fontWeight: isWinner ? 700 : 400 }}>{row.label}</span>
                      <div style={{ flex: 1, background: '#f0f0f0', borderRadius: 4, height: 10, overflow: 'hidden' }}>
                        <div style={{ height: 10, borderRadius: 4, width: `${pct}%`, background: isWinner ? '#1a7a44' : '#bbb', transition: 'width 0.3s' }} />
                      </div>
                      <span style={{ fontSize: 12, minWidth: 45, color: isWinner ? '#1a7a44' : '#888', fontWeight: isWinner ? 700 : 400 }}>{pct}% ({row.count})</span>
                    </div>
                  )
                })}
              </div>
            )
          })}
          {playedMatches.length === 0 && <div className="hint">אין משחקים שהוחלטו עדיין</div>}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════
          TAB 4: הסכמה
      ═══════════════════════════════════════════════════════════ */}
      {mainTab === 'consensus' && (
        <div>
          <p className="hint" style={{ marginBottom: 12 }}>משחקים שמוין לפי רמת הסכמה — אחוז גבוה = כולם הימרו אותו דבר</p>

          {MATCHES.map(match => {
            const preds = users.map(u => u.matches[match.id]?.prediction1X2).filter(Boolean)
            if (preds.length < 2) return null
            const total = preds.length
            const count1 = preds.filter(p => p === '1').length
            const countX = preds.filter(p => p === 'X').length
            const count2 = preds.filter(p => p === '2').length
            const max = Math.max(count1, countX, count2)
            const pct = Math.round((max / total) * 100)
            const topPred = max === count1 ? match.teamA : max === count2 ? match.teamB : 'תיקו'
            const played = adminResults[match.id]?.isPlayed ?? false
            const result = adminResults[match.id]
            const actual = played && result?.resultA != null ? (Number(result.resultA) > Number(result.resultB) ? '1' : Number(result.resultA) < Number(result.resultB) ? '2' : 'X') : null
            const consensusWon = actual && ((actual === '1' && max === count1) || (actual === '2' && max === count2) || (actual === 'X' && max === countX))

            return { match, pct, topPred, played, consensusWon, count1, countX, count2, total }
          }).filter(Boolean)
            .sort((a: any, b: any) => b.pct - a.pct)
            .map((item: any) => (
              <div key={item.match.id} className="match-row" style={{ padding: '8px 12px', marginBottom: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="match-num">#{item.match.id}</span>
                  <span style={{ fontSize: 13 }}>{FLAGS[item.match.teamA]} {item.match.teamA} נגד {item.match.teamB} {FLAGS[item.match.teamB]}</span>
                  <span style={{ marginRight: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 12, color: '#888' }}>{item.pct}% הימרו</span>
                    <span style={{ fontSize: 12, fontWeight: 600, padding: '2px 8px', borderRadius: 10,
                      background: item.pct >= 80 ? '#EAF3DE' : item.pct >= 60 ? '#E6F1FB' : '#FAEEDA',
                      color: item.pct >= 80 ? '#3B6D11' : item.pct >= 60 ? '#185FA5' : '#633806' }}>
                      {item.topPred}
                    </span>
                    {item.played && (
                      item.consensusWon
                        ? <span style={{ fontSize: 11, background: '#EAF3DE', color: '#3B6D11', padding: '2px 7px', borderRadius: 10 }}>✓ כולם צדקו</span>
                        : <span style={{ fontSize: 11, background: '#FCEBEB', color: '#A32D2D', padding: '2px 7px', borderRadius: 10 }}>✗ כולם טעו</span>
                    )}
                  </span>
                </div>
              </div>
            ))}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════
          TAB 5: דירוג מהיר
      ═══════════════════════════════════════════════════════════ */}
      {mainTab === 'ranking' && (
        <div>
          <p className="hint" style={{ marginBottom: 12 }}>דירוג לפי ניקוד כולל עד כה</p>
          <div className="leaderboard">
            <div className="lb-header">
              <span>#</span><span>שם</span>
              <span className="lb-pts" style={{ textAlign: 'center' }}>ניקוד</span>
              <span className="lb-pts" style={{ textAlign: 'center' }}>מדויקים</span>
              <span className="lb-pts" style={{ textAlign: 'center' }}>הפרשים</span>
              <span className="lb-total">סה"כ</span>
            </div>
            {users
              .map(u => ({
                ...u,
                total: scores[u.userId] ?? 0,
                exactCount: playedMatches.filter(m => {
                  const p = u.matches[m.id], r = adminResults[m.id]
                  return p?.scoreA != null && r?.resultA != null && Number(p.scoreA) === Number(r.resultA) && Number(p.scoreB) === Number(r.resultB)
                }).length,
                marginCount: playedMatches.filter(m => {
                  const p = u.matches[m.id], r = adminResults[m.id]
                  if (!p?.scoreA != null || !r?.resultA != null) return false
                  const pA = Number(p?.scoreA), pB = Number(p?.scoreB), rA = Number(r?.resultA), rB = Number(r?.resultB)
                  return pA !== rA && (pA - pB) === (rA - rB)
                }).length,
              }))
              .sort((a, b) => b.total - a.total)
              .map((u, i) => (
                <div key={u.userId} className={`lb-row ${u.userId === user?.uid ? 'lb-me' : ''}`}>
                  <span className="lb-rank">{i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1}</span>
                  <span>{u.userName}{u.userId === user?.uid ? ' (אני)' : ''}</span>
                  <span className="lb-pts">{u.exactCount} מדויק</span>
                  <span className="lb-pts">{u.marginCount} הפרש</span>
                  <span className="lb-pts">—</span>
                  <span className="lb-total">{u.total}</span>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  )
}
