import { useState, useEffect } from 'react'
import { collection, getDocs, doc, getDoc } from 'firebase/firestore'
import { db } from '../firebase'
import { useAuth } from '../hooks/useAuth'
import { MATCHES, GROUPS_TEAMS, BONUS_QUESTIONS, FLAGS } from '../data/matches'
import { MatchPrediction, GroupPrediction, BonusPredictions, Group, Match, UserScore } from '../types'
import { calc1X2Points, calcScorePoints, calcRedCardPoints, calcGroupPoints, calcBonusPoints } from '../scoring'

const GROUPS = 'ABCDEFGHIJKL'.split('') as Group[]

interface UserData {
  userId: string
  userName: string
  matches: Record<number, MatchPrediction>
  groups: Record<Group, GroupPrediction>
  bonus: Partial<BonusPredictions>
}

type Tab = 'matches' | 'groups' | 'bonus'

function PtsBadge({ pts, played }: { pts: number; played: boolean }) {
  if (!played) return null
  const bg = pts > 0 ? '#1a7a44' : '#aaa'
  return (
    <span style={{
      background: bg, color: '#fff', fontWeight: 700, fontSize: 12,
      padding: '2px 8px', borderRadius: 20, whiteSpace: 'nowrap', minWidth: 32,
      textAlign: 'center', display: 'inline-block'
    }}>
      {pts > 0 ? `+${pts}` : '0'} נק׳
    </span>
  )
}

export default function AllPredictions() {
  const { user, isAdmin } = useAuth()
  const [users, setUsers] = useState<UserData[]>([])
  const [selectedUser, setSelectedUser] = useState<string | null>(null)
  const [isOpen, setIsOpen] = useState(true)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('matches')
  const [adminResults, setAdminResults] = useState<Record<number, Match>>({})
  const [actualGroups, setActualGroups] = useState<Record<string, [string, string, string]>>({})
  const [actualBonus, setActualBonus] = useState<Partial<BonusPredictions>>({})

  useEffect(() => {
    ;(async () => {
      const settings = await getDoc(doc(db, 'settings', 'app'))
      const open = settings.exists() ? (settings.data().isOpen ?? true) : true
      const deadline = settings.exists() ? settings.data().deadline : null
      const isClosed = !open || (deadline && Date.now() > deadline)
      setIsOpen(!isClosed)

      // Load admin results
      const resultsSnap = await getDoc(doc(db, 'admin', 'results'))
      if (resultsSnap.exists()) {
        setAdminResults(resultsSnap.data().matches ?? {})
        setActualGroups(resultsSnap.data().groups ?? {})
        setActualBonus(resultsSnap.data().bonus ?? {})
      }

      if (isClosed || isAdmin) {
        const snap = await getDocs(collection(db, 'predictions'))
        const data: UserData[] = snap.docs.map(d => ({
          userId: d.id,
          userName: d.data().userName ?? 'משתמש',
          matches: d.data().matches ?? {},
          groups: d.data().groups ?? {},
          bonus: d.data().bonus ?? {},
        }))
        setUsers(data)
        if (data.length > 0) {
          const me = data.find(u => u.userId === user?.uid)
          setSelectedUser(me ? me.userId : data[0].userId)
        }
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

  // Calculate points for a match prediction
  function matchPts(matchId: number, pred: MatchPrediction | undefined): number {
    if (!pred) return 0
    const result = adminResults[matchId]
    if (!result?.isPlayed || result.resultA === undefined || result.resultA === null) return 0
    if (result.resultB === undefined || result.resultB === null) return 0
    const match = MATCHES.find(m => m.id === matchId)!
    const rA = Number(result.resultA), rB = Number(result.resultB)
    const p1 = calc1X2Points(pred.prediction1X2, rA, rB, match.fifaPointsA, match.fifaPointsB, match.category)
    const ps = pred.scoreA !== null && pred.scoreA !== undefined && pred.scoreB !== null && pred.scoreB !== undefined
      ? calcScorePoints(Number(pred.scoreA), Number(pred.scoreB), rA, rB, match.category)
      : 0
    const pr = calcRedCardPoints(pred.redCard, result.hadRedCard ?? false)
    return p1 + ps + pr
  }

  // Calculate group points for a single group
  function groupPts(group: Group): number {
    const pred = current?.groups[group]
    const actual = actualGroups[group]
    if (!pred || !actual || !actual[0]) return 0
    return calcGroupPoints(pred.advancing, actual)
  }

  // Calculate bonus points for a single question
  function bonusPts(qId: string): number {
    const pred = (current?.bonus as any)?.[qId]
    const actual = (actualBonus as any)?.[qId]
    if (!pred || !actual) return 0
    return pred.trim().toLowerCase() === actual.trim().toLowerCase()
      ? calcBonusPoints({ [qId]: pred }, { [qId]: actual })
      : 0
  }

  const hasAnyResult = Object.values(adminResults).some(m => m.isPlayed)
  const hasAnyGroupResult = Object.values(actualGroups).some(g => g?.[0])
  const hasAnyBonusResult = Object.values(actualBonus as any).some(v => v)

  return (
    <div className="page">
      <h1>הימורי כולם {isAdmin && isOpen && <span className="badge badge-red">מצב אדמין</span>}</h1>

      <div className="user-selector">
        {users.map(u => (
          <button
            key={u.userId}
            className={`user-btn ${u.userId === selectedUser ? 'active' : ''} ${u.userId === user?.uid ? 'me' : ''}`}
            onClick={() => setSelectedUser(u.userId)}
          >
            {u.userName}{u.userId === user?.uid ? ' (אני)' : ''}
          </button>
        ))}
      </div>

      {current && (
        <>
          <div className="tabs" style={{ marginTop: 12 }}>
            <button className={tab === 'matches' ? 'tab active' : 'tab'} onClick={() => setTab('matches')}>משחקים</button>
            <button className={tab === 'groups' ? 'tab active' : 'tab'} onClick={() => setTab('groups')}>עולים מהבית</button>
            <button className={tab === 'bonus' ? 'tab active' : 'tab'} onClick={() => setTab('bonus')}>בונוס</button>
          </div>

          {/* ── MATCHES ── */}
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
                          const result = adminResults[match.id]
                          const played = result?.isPlayed ?? false
                          const pts = matchPts(match.id, p)

                          // Determine result tag
                          const getResultTag = () => {
                            if (!played || !p) return null
                            const rA = Number(result.resultA ?? 0)
                            const rB = Number(result.resultB ?? 0)
                            const pA = p.scoreA !== null && p.scoreA !== undefined ? Number(p.scoreA) : null
                            const pB = p.scoreB !== null && p.scoreB !== undefined ? Number(p.scoreB) : null
                            const actual1x2 = rA > rB ? '1' : rA < rB ? '2' : 'X'
                            const correct1x2 = p.prediction1X2 === actual1x2
                            const exact = pA !== null && pB !== null && pA === rA && pB === rB
                            const marginOk = pA !== null && pB !== null && (pA - pB) === (rA - rB)

                            if (exact && correct1x2) return { label: '✓ מדויק', bg: '#EAF3DE', color: '#3B6D11' }
                            if (correct1x2 && marginOk) return { label: '1X2 + הפרש', bg: '#EAF3DE', color: '#3B6D11' }
                            if (correct1x2) return { label: '✓ 1X2 נכון', bg: '#EAF3DE', color: '#3B6D11' }
                            if (marginOk) return { label: 'הפרש נכון', bg: '#E6F1FB', color: '#185FA5' }
                            return { label: '✗ שגוי', bg: '#FCEBEB', color: '#A32D2D' }
                          }
                          const tag = getResultTag()
                          const borderColor = !played ? 'transparent' : pts > 0 ? '#3B6D11' : '#ddd'
                          const predWinner = p?.prediction1X2 === '1' ? match.teamA : p?.prediction1X2 === '2' ? match.teamB : 'תיקו'

                          if (!p) return (
                            <div key={match.id} className="match-row" style={{ borderRight: `3px solid ${played ? '#ddd' : 'transparent'}` }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: played ? 8 : 0 }}>
                                <span className="match-num">#{match.id}</span>
                                <span className={`cat-badge cat-${match.category.toLowerCase()}`}>{match.category}</span>
                                <span style={{ fontSize: 13 }}>{FLAGS[match.teamA]} {match.teamA}</span>
                                <span style={{ color: 'var(--color-text-muted, #aaa)', fontSize: 13 }}>נגד</span>
                                <span style={{ fontSize: 13 }}>{match.teamB} {FLAGS[match.teamB]}</span>
                                <span style={{ marginRight: 'auto', fontSize: 12, color: '#bbb' }}>לא מולא</span>
                                {played && <PtsBadge pts={0} played={true} />}
                              </div>
                              {played && (
                                <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#888', paddingTop: 6, borderTop: '1px solid #f0f0f0' }}>
                                  <span style={{ fontWeight: 600, minWidth: 52, color: '#aaa' }}>בפועל</span>
                                  <span style={{ fontWeight: 600, color: '#555' }}>{result.resultA ?? 0} – {result.resultB ?? 0}</span>
                                  {result.hadRedCard && <span style={{ fontSize: 12, background: '#FCEBEB', color: '#A32D2D', padding: '1px 6px', borderRadius: 10 }}>🟥 כרטיס</span>}
                                </div>
                              )}
                            </div>
                          )

                          return (
                            <div key={match.id} className="match-row" style={{ borderRight: `3px solid ${borderColor}` }}>
                              {/* Header row */}
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                                <span className="match-num">#{match.id}</span>
                                <span className={`cat-badge cat-${match.category.toLowerCase()}`}>{match.category}</span>
                                <span style={{ fontSize: 13, fontWeight: 500 }}>{FLAGS[match.teamA]} {match.teamA}</span>
                                <span style={{ color: 'var(--color-text-muted,#aaa)', fontSize: 12 }}>נגד</span>
                                <span style={{ fontSize: 13, fontWeight: 500 }}>{match.teamB} {FLAGS[match.teamB]}</span>
                                <span style={{ marginRight: 'auto' }} />
                                {played && <PtsBadge pts={pts} played={true} />}
                              </div>

                              {/* Pred vs Actual */}
                              <div style={{ display: 'flex', alignItems: 'center', gap: 0, borderTop: '1px solid #f0f0f0', paddingTop: 8 }}>
                                {/* MY PRED */}
                                <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
                                  <span style={{ fontSize: 11, color: '#aaa', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.5px', minWidth: 52 }}>ניחוש שלי</span>
                                  <span style={{ fontSize: 14, fontWeight: 600, color: '#1a1a2e' }}>
                                    {p.scoreA ?? '?'} – {p.scoreB ?? '?'}
                                  </span>
                                  <span style={{ fontSize: 12, background: '#f0f0f0', color: '#555', padding: '2px 8px', borderRadius: 20 }}>
                                    {predWinner}
                                  </span>
                                  {p.redCard && <span style={{ fontSize: 11, background: '#FCEBEB', color: '#A32D2D', padding: '1px 6px', borderRadius: 10 }}>🟥</span>}
                                </div>

                                {/* Divider */}
                                {played && <div style={{ width: 1, height: 28, background: '#e5e5e5', margin: '0 12px', flexShrink: 0 }} />}

                                {/* ACTUAL RESULT */}
                                {played && (
                                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <span style={{ fontSize: 11, color: '#aaa', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.5px', minWidth: 40 }}>בפועל</span>
                                    <span style={{ fontSize: 14, fontWeight: 600, color: '#555' }}>
                                      {result.resultA ?? 0} – {result.resultB ?? 0}
                                    </span>
                                    {result.hadRedCard && <span style={{ fontSize: 11, background: '#FCEBEB', color: '#A32D2D', padding: '1px 6px', borderRadius: 10 }}>🟥</span>}
                                    {tag && <span style={{ fontSize: 12, fontWeight: 600, padding: '2px 8px', borderRadius: 20, background: tag.bg, color: tag.color }}>{tag.label}</span>}
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

          {/* ── GROUPS ── */}
          {tab === 'groups' && (
            <div className="groups-section">
              {hasAnyGroupResult && (
                <div className="hint" style={{ marginBottom: 12, color: '#185FA5', fontWeight: 600 }}>
                  🏆 ניקוד מקום מדויק = 2 נק׳ | נבחרת נכונה מקום שגוי = 1 נק׳
                </div>
              )}
              <div className="groups-grid">
                {GROUPS.map(group => {
                  const gp = current.groups[group]
                  const actual = actualGroups[group]
                  const hasResult = actual?.[0]
                  const pts = groupPts(group)

                  return (
                    <div key={group} className="group-card" style={hasResult && pts > 0 ? { borderColor: '#1a7a44', borderWidth: 2 } : {}}>
                      <div className="group-card-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
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
                            <span style={{
                              fontSize: 13,
                              fontWeight: isExact ? 700 : 400,
                              color: isExact ? '#1a7a44' : isCorrectWrongPos ? '#185FA5' : isWrong ? '#c00' : '#333',
                              flex: 1
                            }}>
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
                            <div key={idx} style={{ fontSize: 12, color: '#555' }}>
                              {idx + 1}. {FLAGS[actual[idx]] ?? ''} {actual[idx]}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* ── BONUS ── */}
          {tab === 'bonus' && (
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
                      <span>
                        {q.label}
                        <span className="pts-badge" style={{ marginRight: 6 }}>{q.points} נק׳</span>
                      </span>
                      {hasResult && <PtsBadge pts={bonusPts(q.id)} played={true} />}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <span style={{
                        fontSize: 14,
                        color: isCorrect ? '#1a7a44' : isWrong ? '#c00' : predVal ? '#1a1a2e' : '#ccc',
                        fontWeight: isCorrect ? 700 : 400
                      }}>
                        {isCorrect && '✓ '}
                        {isWrong && '✗ '}
                        {predVal || 'לא מולא'}
                      </span>
                      {hasResult && !isCorrect && (
                        <span style={{ fontSize: 12, color: '#888' }}>
                          (בפועל: {actualVal})
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}
