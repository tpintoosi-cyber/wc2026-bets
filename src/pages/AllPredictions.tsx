import { useState, useEffect } from 'react'
import { collection, getDocs, doc, getDoc } from 'firebase/firestore'
import { db } from '../firebase'
import { useAuth } from '../hooks/useAuth'
import { MATCHES, GROUPS_TEAMS, BONUS_QUESTIONS, FLAGS, MATCH_SCHEDULE, KNOCKOUT_MATCHES, KNOCKOUT_ROUND_LABELS, KNOCKOUT_BRACKET } from '../data/matches'
import { MatchPrediction, GroupPrediction, BonusPredictions, Group, Match, KnockoutMatchPrediction } from '../types'
import { calc1X2Points, calcScorePoints, calcRedCardPoints, calcGroupPoints, calcBonusPoints, calcAdvancePoints } from '../scoring'

const GROUPS = 'ABCDEFGHIJKL'.split('') as Group[]

interface UserData {
  userId: string; userName: string; nickname?: string
  matches: Record<number, MatchPrediction>
  groups: Record<Group, GroupPrediction>
  bonus: Partial<BonusPredictions>
  knockout?: Record<number, KnockoutMatchPrediction>
}

type MainTab = 'user' | 'match' | 'stats' | 'knockout'
type UserTab = 'matches' | 'groups' | 'bonus'

// Module-level helper — usable in all sub-components
function getDisplayName(u: UserData) { return u.nickname || u.userName }

// ── Helpers ──────────────────────────────────────────────────────
function getNextMatchId(): number {
  const now = new Date()
  const israelNow = new Date(now.getTime() + 3 * 60 * 60 * 1000)
  let closestId = 1, closestDiff = Infinity, firstPast = 1
  for (const [idStr, timeStr] of Object.entries(MATCH_SCHEDULE)) {
    const [datePart, timePart] = timeStr.split(' ')
    const [day, month] = datePart.split('/').map(Number)
    const [hour, minute] = timePart.split(':').map(Number)
    const matchDate = new Date(2026, month - 1, day, hour, minute)
    const diff = matchDate.getTime() - israelNow.getTime()
    if (diff > 0 && diff < closestDiff) { closestDiff = diff; closestId = Number(idStr) }
    if (diff <= 0) firstPast = Number(idStr)
  }
  return closestDiff === Infinity ? firstPast : closestId
}

function PtsBadge({ pts, played }: { pts: number; played: boolean }) {
  if (!played) return null
  return <span style={{ background: pts > 0 ? '#1a7a44' : '#888', color: '#fff', fontWeight: 700, fontSize: 12, padding: '2px 8px', borderRadius: 20, whiteSpace: 'nowrap', display: 'inline-block' }}>
    {pts > 0 ? `+${pts}` : '0'} נק׳
  </span>
}

function ResultTag({ label, type }: { label: string; type: 'ok' | 'warn' | 'bad' }) {
  const s = { ok: { bg: '#EAF3DE', color: '#3B6D11' }, warn: { bg: '#E6F1FB', color: '#185FA5' }, bad: { bg: '#FCEBEB', color: '#A32D2D' } }[type]
  return <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 10, background: s.bg, color: s.color }}>{label}</span>
}

// Tooltip with user names on hover
function HoverTooltip({ names, children }: { names: string[]; children: React.ReactNode }) {
  const [pos, setPos] = useState<{x:number,y:number}|null>(null)
  return (
    <span style={{ position: 'relative', cursor: 'pointer' }}
      onMouseMove={e => setPos({x: e.clientX, y: e.clientY})}
      onMouseLeave={() => setPos(null)}>
      {children}
      {pos && names.length > 0 && (
        <div style={{
          position: 'fixed', zIndex: 9999,
          left: pos.x + 12, top: pos.y - 8,
          background: '#1a1a2e', color: '#fff', borderRadius: 8, padding: '8px 12px',
          fontSize: 12, whiteSpace: 'nowrap', boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
          pointerEvents: 'none',
        }}>
          {names.map((n, i) => <div key={i} style={{ padding: '2px 0' }}>{n}</div>)}
        </div>
      )}
    </span>
  )
}

// Group predictions by score table (like the image)
function ScoreGroupTable({ matchId, users, teamA, teamB, adminResult }: {
  matchId: number; users: UserData[]; teamA: string; teamB: string; adminResult?: Match
}) {
  const played = adminResult?.isPlayed ?? false
  const rA = played ? Number(adminResult!.resultA ?? 0) : null
  const rB = played ? Number(adminResult!.resultB ?? 0) : null

  const groups: Record<string, UserData[]> = {}
  users.forEach(u => {
    const p = u.matches[matchId]
    if (!p || p.scoreA === null || p.scoreB === null) {
      const key = 'לא מולא'
      groups[key] = groups[key] ?? []
      groups[key].push(u)
    } else {
      const key = `${p.scoreA}-${p.scoreB}`
      groups[key] = groups[key] ?? []
      groups[key].push(u)
    }
  })

  const sorted = Object.entries(groups).sort(([a], [b]) => {
    if (a === 'לא מולא') return 1
    if (b === 'לא מולא') return -1
    const [aA, aB] = a.split('-').map(Number)
    const [bA, bB] = b.split('-').map(Number)
    return (bA + bB) - (aA + aB) || aA - bA
  })

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10, color: '#1a1a2e', borderBottom: '2px solid #1a1a2e', paddingBottom: 6, display: 'flex', justifyContent: 'space-between' }}>
        <span>פילוח לפי ניחוש — {teamB} נגד {teamA}</span>
        <span style={{ fontSize: 12, fontWeight: 400, color: '#888' }}>{Object.values(groups).reduce((s, a) => s + a.length, 0)} הימורים</span>
      </div>

      {/* 3-column layout: teamA wins | draw | teamB wins */}
      <div className="score-3col" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
        {[
        { label: teamA, x2: '1', color: '#444', bg: '#f0f0f0' },
          { label: 'תיקו', x2: 'X', color: '#444', bg: '#f0f0f0' },
          { label: teamB, x2: '2', color: '#444', bg: '#f0f0f0' },
        ].map(col => {
          // Filter scores for this 1X2 outcome
          const colScores = sorted.filter(([score]) => {
            if (score === 'לא מולא') return col.x2 === 'X' // show "not filled" under draw
            const [sA, sB] = score.split('-').map(Number)
            if (col.x2 === '1') return sA > sB
            if (col.x2 === '2') return sB > sA
            return sA === sB
          })
          const total = colScores.reduce((s, [, u]) => s + u.length, 0)

          return (
            <div key={col.x2}>
              {/* Column header */}
              <div style={{ background: col.bg, color: col.color, fontWeight: 700, fontSize: 13,
                padding: '6px 10px', borderRadius: '8px 8px 0 0', textAlign: 'center', borderBottom: `2px solid ${col.color}` }}>
                {col.label}
                <span style={{ fontWeight: 400, fontSize: 11, marginRight: 5, opacity: 0.8 }}>({total})</span>
              </div>

              {/* Score groups in this column */}
              <div style={{ border: `1px solid ${col.color}30`, borderTop: 'none', borderRadius: '0 0 8px 8px', overflow: 'hidden' }}>
                {colScores.length === 0 && (
                  <div style={{ padding: '10px', fontSize: 12, color: '#ccc', textAlign: 'center' }}>אין הימורים</div>
                )}
                {colScores.map(([score, scoreUsers], idx) => {
                  const [sA, sB] = score === 'לא מולא' ? [null, null] : score.split('-').map(Number)
                  const isExact = played && sA !== null && sA === rA && sB === rB
                  const isMargin = played && sA !== null && !isExact && (sA! - sB!) === (rA! - rB!)
                  return (
                    <div key={score} style={{ borderBottom: idx < colScores.length - 1 ? '1px solid #f0f0f0' : 'none',
                      background: isExact ? '#f0fbf4' : isMargin ? '#f0f6fb' : idx % 2 === 0 ? '#fafafa' : '#fff',
                      padding: '7px 10px' }}>
                      {/* Score badge */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                        <span style={{ fontSize: 15, fontWeight: 800, direction: 'ltr', display: 'inline-block',
                          color: isExact ? '#3B6D11' : isMargin ? '#185FA5' : '#1a1a2e' }}>
                          {score === 'לא מולא' ? '—' : `${sA}-${sB}`}
                        </span>
                        {isExact && <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 5px', borderRadius: 8, background: '#EAF3DE', color: '#3B6D11' }}>✓</span>}
                        {isMargin && <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 5px', borderRadius: 8, background: '#E6F1FB', color: '#185FA5' }}>~</span>}
                        <span style={{ fontSize: 11, color: '#aaa', marginRight: 'auto' }}>({scoreUsers.length})</span>
                      </div>
                      {/* Names */}
                      <div style={{ fontSize: 12, color: '#555', lineHeight: 1.6 }}>
                        {scoreUsers.map((u, i) => (
                          <span key={u.userId}>
                            {getDisplayName(u)}
                            {u.matches[matchId]?.redCard && <span style={{ fontSize: 10, marginRight: 2 }}>🟥</span>}
                            {i < scoreUsers.length - 1 && <span style={{ color: '#ddd', margin: '0 5px' }}>·</span>}
                          </span>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Group predictions table for Groups tab
function GroupPredTable({ group, users, actualResult }: {
  group: Group; users: UserData[]; actualResult?: [string, string, string]
}) {
  const teams = GROUPS_TEAMS[group]
  const positions: Record<string, { pos: number; users: UserData[] }[]> = {}

  teams.forEach(team => { positions[team] = [] })

  users.forEach(u => {
    const gp = u.groups[group]
    if (!gp) return
    gp.advancing.forEach((team, idx) => {
      if (team && positions[team]) {
        const existing = positions[team].find(p => p.pos === idx)
        if (existing) existing.users.push(u)
        else positions[team].push({ pos: idx, users: [u] })
      }
    })
  })

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: '#888', marginBottom: 6 }}>מי הימר על כל נבחרת</div>
      <div style={{ border: '1px solid #e5e5e5', borderRadius: 8, overflow: 'hidden' }}>
        {teams.map((team, idx) => {
          const teamPreds = positions[team] ?? []
          const actualPos = actualResult?.indexOf(team)
          const inActual = actualPos !== undefined && actualPos >= 0
          return (
            <div key={team} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '7px 10px',
              borderBottom: idx < teams.length - 1 ? '1px solid #f0f0f0' : 'none',
              background: inActual ? '#f5fbf2' : 'transparent' }}>
              <span style={{ fontSize: 13, fontWeight: 600, minWidth: 90, display: 'flex', alignItems: 'center', gap: 4 }}>
                {FLAGS[team] ?? ''} {team}
                {inActual && <span style={{ fontSize: 10, background: '#EAF3DE', color: '#3B6D11', padding: '1px 5px', borderRadius: 8 }}>#{actualPos! + 1}</span>}
              </span>
              <span style={{ fontSize: 12, color: '#555', flex: 1 }}>
                {teamPreds.length === 0 ? <span style={{ color: '#ccc' }}>אף אחד</span> :
                  teamPreds.flatMap(({ pos, users: us }) =>
                    us.map((u, i) => (
                      <span key={u.userId + pos}>
                        {getDisplayName(u)}<span style={{ color: '#aaa', fontSize: 11 }}> (#{pos + 1})</span>
                        {i < us.length - 1 || teamPreds.indexOf(teamPreds.find(p => p.pos === pos)!) < teamPreds.length - 1 ? <span style={{ color: '#ddd', margin: '0 4px' }}>|</span> : ''}
                      </span>
                    ))
                  )}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Group bonus answers table
function BonusPredTable({ qId, users, actualVal }: {
  qId: string; users: UserData[]; actualVal?: string
}) {
  const groups: Record<string, UserData[]> = {}
  users.forEach(u => {
    const val = (u.bonus as any)?.[qId] ?? 'לא מולא'
    groups[val] = groups[val] ?? []
    groups[val].push(u)
  })

  return (
    <div style={{ border: '1px solid #e5e5e5', borderRadius: 8, overflow: 'hidden', marginTop: 8 }}>
      {Object.entries(groups).sort(([a], [b]) => a === 'לא מולא' ? 1 : b === 'לא מולא' ? -1 : a.localeCompare(b)).map(([val, valUsers], idx, arr) => {
        const isCorrect = actualVal && val !== 'לא מולא' && val.trim().toLowerCase() === actualVal.trim().toLowerCase()
        return (
          <div key={val} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px',
            borderBottom: idx < arr.length - 1 ? '1px solid #f0f0f0' : 'none',
            background: isCorrect ? '#EAF3DE' : idx % 2 === 0 ? '#fafafa' : '#fff' }}>
            <span style={{ fontSize: 13, fontWeight: 600, minWidth: 100, color: isCorrect ? '#3B6D11' : '#1a1a2e' }}>
              {isCorrect && '✓ '}{val}
              <span style={{ fontSize: 11, color: '#aaa', fontWeight: 400, marginRight: 4 }}>({valUsers.length})</span>
            </span>
            <span style={{ fontSize: 12, color: '#555', flex: 1 }}>
              {valUsers.map((u, i) => (
                <span key={u.userId}>{getDisplayName(u)}{i < valUsers.length - 1 ? <span style={{ color: '#ddd', margin: '0 4px' }}>|</span> : ''}</span>
              ))}
            </span>
          </div>
        )
      })}
    </div>
  )
}

export default function AllPredictions() {
  const { user, isAdmin, loading: authLoading } = useAuth()
  const [users, setUsers] = useState<UserData[]>([])
  const [selectedUser, setSelectedUser] = useState<string | null>(null)
  const [selectedMatchId, setSelectedMatchId] = useState<number>(() => getNextMatchId())
  const [isOpen, setIsOpen] = useState(true)
  const [loading, setLoading] = useState(true)
  const [mainTab, setMainTab] = useState<MainTab>('user')
  const [userTab, setUserTab] = useState<UserTab>('matches')
  const [adminResults, setAdminResults] = useState<Record<number, Match>>({})
  const [actualGroups, setActualGroups] = useState<Record<string, [string, string, string]>>({})
  const [actualBonus, setActualBonus] = useState<Partial<BonusPredictions>>({})
  const [scores, setScores] = useState<Record<string, number>>({})
  const [knockoutAdminMatches, setKnockoutAdminMatches] = useState<Record<number, any>>({})
  const [koSubTab, setKoSubTab] = useState<'byUser' | 'byMatch'>('byUser')

  useEffect(() => {
    if (authLoading) return
    ;(async () => {
      const settings = await getDoc(doc(db, 'settings', 'app'))
      const open = settings.exists() ? (settings.data().isOpen ?? true) : true
      const deadline = settings.exists() ? settings.data().deadline : null
      const isClosed = !open || (deadline && Date.now() > deadline)
      setIsOpen(!isClosed)

      const [resultsSnap, predsSnap, scoresSnap, koSnap] = await Promise.all([
        getDoc(doc(db, 'admin', 'results')),
        (isClosed || isAdmin) ? getDocs(collection(db, 'predictions')) : Promise.resolve(null),
        (isClosed || isAdmin) ? getDocs(collection(db, 'scores')) : Promise.resolve(null),
        getDoc(doc(db, 'admin', 'knockout')),
      ])

      if (resultsSnap.exists()) {
        setAdminResults(resultsSnap.data().matches ?? {})
        setActualGroups(resultsSnap.data().groups ?? {})
        setActualBonus(resultsSnap.data().bonus ?? {})
      }
      if (koSnap.exists()) setKnockoutAdminMatches(koSnap.data().matches ?? {})

      if (predsSnap) {
        const data: UserData[] = predsSnap.docs.map(d => ({
          userId: d.id, userName: d.data().userName ?? 'משתמש',
          nickname: d.data().nickname ?? '',
          matches: d.data().matches ?? {}, groups: d.data().groups ?? {}, bonus: d.data().bonus ?? {},
          knockout: d.data().knockout ?? {},
        }))
        setUsers(data)
        if (data.length > 0) {
          const me = data.find(u => u.userId === user?.uid)
          setSelectedUser(me ? me.userId : data[0].userId)
        }
      }

      if (scoresSnap) {
        const sc: Record<string, number> = {}
        scoresSnap.docs.forEach(d => { sc[d.id] = d.data().total ?? 0 })
        setScores(sc)
      }
      setLoading(false)
    })()
  }, [isAdmin, authLoading])

  // ── Scoring helpers ──────────────────────────────────────────────
  function getMatchPts(matchId: number, pred: MatchPrediction | undefined) {
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

  function getBreakdown(matchId: number, pred: MatchPrediction | undefined) {
    if (!pred) return []
    const result = adminResults[matchId]
    if (!result?.isPlayed || result.resultA == null || result.resultB == null) return []
    const match = MATCHES.find(m => m.id === matchId)!
    const rA = Number(result.resultA), rB = Number(result.resultB)
    const pA = pred.scoreA != null ? Number(pred.scoreA) : null
    const pB = pred.scoreB != null ? Number(pred.scoreB) : null
    const items: string[] = []
    const p1 = calc1X2Points(pred.prediction1X2, rA, rB, match.fifaPointsA, match.fifaPointsB, match.category)
    if (p1 > 0) items.push(`1X2: +${p1}`)
    if (pA !== null && pB !== null) {
      if (pA === rA && pB === rB) {
        items.push('מדויק: +2')
        const total = rA + rB
        const isOU = (match.category === 'A' || match.category === 'B') ? (total <= 1 || total >= 4) : (total <= 2 || total >= 5)
        if (isOU) items.push((total <= ((match.category === 'A' || match.category === 'B') ? 1 : 2) ? 'אנדר' : 'אובר') + ': +1')
      } else if ((pA - pB) === (rA - rB)) items.push('הפרש: +1')
    }
    const pr = calcRedCardPoints(pred.redCard, result.hadRedCard ?? false)
    if (pr > 0) items.push('🟥: +2')
    return items
  }

  function getTag(matchId: number, pred: MatchPrediction | undefined, pts: number): { label: string; type: 'ok' | 'warn' | 'bad' } | null {
    if (!pred) return null
    const result = adminResults[matchId]
    if (!result?.isPlayed) return null
    const rA = Number(result.resultA ?? 0), rB = Number(result.resultB ?? 0)
    const pA = pred.scoreA != null ? Number(pred.scoreA) : null
    const pB = pred.scoreB != null ? Number(pred.scoreB) : null
    if (pts === 0) return { label: '✗ שגוי', type: 'bad' }
    const actual1x2 = rA > rB ? '1' : rA < rB ? '2' : 'X'
    const correct1x2 = pred.prediction1X2 === actual1x2
    const exact = pA === rA && pB === rB
    const marginOk = pA !== null && pB !== null && (pA - pB) === (rA - rB)
    if (exact && correct1x2) return { label: '✓ מדויק', type: 'ok' }
    if (correct1x2 && marginOk) return { label: '1X2 + הפרש', type: 'ok' }
    if (correct1x2) return { label: '✓ 1X2 נכון', type: 'ok' }
    if (marginOk) return { label: 'הפרש נכון', type: 'warn' }
    return { label: `+${pts} נק׳`, type: 'warn' }
  }

  // Display name: nickname if set, else userName. Admin sees both.
  const displayName = (u: UserData) => u.nickname || u.userName
  const adminDisplayName = (u: UserData) => {
    if (!isAdmin) return displayName(u)
    if (u.nickname && u.nickname !== u.userName) return u.nickname + ' (' + u.userName + ')'
    return u.userName
  }

  if (loading || authLoading) return <div className="center-screen">טוען...</div>
  if (isOpen && !isAdmin) return (
    <div className="page"><div className="empty-state">
      <div style={{ fontSize: 48 }}>🔒</div>
      <h2>ההימורים עוד פתוחים</h2>
      <p>ניתן לראות את ההימורים של כולם רק לאחר סגירת ההגשות</p>
    </div></div>
  )
  if (!users.length) return <div className="page"><div className="empty-state"><p>אין הימורים עדיין</p></div></div>

  const current = users.find(u => u.userId === selectedUser)
  const playedMatches = MATCHES.filter(m => adminResults[m.id]?.isPlayed)

  const TAB_LABELS: { id: MainTab; label: string }[] = [
    { id: 'user', label: '👤 לפי משתמש' },
    { id: 'match', label: '⚽ לפי משחק' },
    { id: 'stats', label: '📊 סטטיסטיקות' },
    { id: 'knockout', label: '🏆 נוקאאוט' },
  ]

  return (
    <div className="page">
      <h1>הימורי כולם {isAdmin && isOpen && <span className="badge badge-red">מצב אדמין</span>}</h1>

      <div style={{ display: 'flex', gap: 4, marginBottom: 14, background: 'var(--bg-card,#fff)', borderRadius: 12, padding: 4, border: '1px solid var(--border,#e5e5e5)' }}>
        {TAB_LABELS.map(t => (
          <button key={t.id} onClick={() => setMainTab(t.id)} style={{
            flex: 1, padding: '9px 8px', borderRadius: 9, border: 'none', cursor: 'pointer',
            fontSize: 13, fontWeight: 500, fontFamily: 'inherit',
            background: mainTab === t.id ? '#1a1a2e' : 'transparent',
            color: mainTab === t.id ? '#fff' : '#666',
          }}>{t.label}</button>
        ))}
      </div>

      {/* ══════════════════════════════════════════
          TAB 1: לפי משתמש
      ══════════════════════════════════════════ */}
      {mainTab === 'user' && (
        <>
          <div className="user-selector">
            {users.map(u => (
              <button key={u.userId}
                className={`user-btn ${u.userId === selectedUser ? 'active' : ''} ${u.userId === user?.uid ? 'me' : ''}`}
                onClick={() => setSelectedUser(u.userId)}>
                { adminDisplayName(u) }{u.userId === user?.uid ? ' (אני)' : ''}
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

              {/* Matches */}
              {userTab === 'matches' && [1,2,3].map(round => (
                <div key={round}>
                  <h2 className="round-title">סיבוב {round}</h2>
                  {GROUPS.map(group => {
                    const ms = MATCHES.filter(m => m.round === round && m.group === group)
                    if (!ms.length) return null
                    return <div key={group} className="group-block">
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
                          <div key={match.id} className="match-row-view" style={{ borderRight: `3px solid ${played ? '#ddd' : 'transparent'}` }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span className="match-num">#{match.id}</span>
                              <span className={`cat-badge cat-${match.category.toLowerCase()}`}>{match.category}</span>
                              <span style={{ fontSize: 13 }}>{FLAGS[match.teamA]} {match.teamA} נגד {match.teamB} {FLAGS[match.teamB]}</span>
                              <span style={{ marginRight: 'auto', fontSize: 12, color: '#ccc' }}>לא מולא</span>
                              {played && <PtsBadge pts={0} played={true} />}
                            </div>
                          </div>
                        )
                        return (
                          <div key={match.id} className="match-row-view" style={{ borderRight: `3px solid ${borderColor}` }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                              <span className="match-num">#{match.id}</span>
                              <span className={`cat-badge cat-${match.category.toLowerCase()}`}>{match.category}</span>
                              <span style={{ fontSize: 13, fontWeight: 500 }}>{FLAGS[match.teamA]} {match.teamA} נגד {match.teamB} {FLAGS[match.teamB]}</span>
                              <span style={{ marginRight: 'auto' }} />
                              {played && <PtsBadge pts={pts} played={true} />}
                            </div>
                            <div style={{ borderTop: '1px solid #f0f0f0', paddingTop: 8, display: 'flex', gap: 0 }}>
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
                              {played && <div style={{ width: 1, background: '#e5e5e5', margin: '0 14px' }} />}
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
                                      {breakdown.map((b, i) => <span key={i} style={{ fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 10, background: '#EAF3DE', color: '#3B6D11' }}>{b}</span>)}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  })}
                </div>
              ))}

              {/* Groups */}
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
                          {[0,1,2].map(idx => {
                            const predTeam = gp?.advancing[idx]
                            const actualTeam = actual?.[idx]
                            const isExact = predTeam && actualTeam && predTeam === actualTeam
                            const isCorrectWrongPos = predTeam && actual && actual.includes(predTeam) && !isExact
                            const isWrong = predTeam && actual?.[0] && !actual.includes(predTeam)
                            return (
                              <div key={idx} className="group-slot">
                                <span className="slot-num">{idx+1}.</span>
                                <span style={{ fontSize: 13, flex: 1, fontWeight: isExact ? 700 : 400, color: isExact ? '#1a7a44' : isCorrectWrongPos ? '#185FA5' : isWrong ? '#c00' : '#333' }}>
                                  {predTeam ? `${FLAGS[predTeam]??''} ${predTeam}` : <span style={{ color: '#ccc' }}>—</span>}
                                </span>
                                {isExact && '✓✓'}{isCorrectWrongPos && '✓'}{(isWrong && hasResult) && <span style={{ color: '#c00' }}>✗</span>}
                              </div>
                            )
                          })}
                          {hasResult && <div style={{ marginTop: 8, borderTop: '1px solid #f0f0f0', paddingTop: 6 }}>
                            <div style={{ fontSize: 11, color: '#888', marginBottom: 3 }}>בפועל:</div>
                            {[0,1,2].map(idx => <div key={idx} style={{ fontSize: 12, color: '#555' }}>{idx+1}. {FLAGS[actual[idx]]??''} {actual[idx]}</div>)}
                          </div>}
                        </div>
                      )
                    })}
                  </div>
                  {/* Group pred table per group */}
                  <h2 className="round-title" style={{ marginTop: 20 }}>קיבוץ לפי ניחוש — כל הבתים</h2>
                  {GROUPS.map(group => (
                    <div key={group} style={{ marginBottom: 16 }}>
                      <div className="group-label">בית {group}</div>
                      <GroupPredTable group={group} users={users} actualResult={actualGroups[group]} />
                    </div>
                  ))}
                </div>
              )}

              {/* Bonus */}
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
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
                          <span style={{ fontSize: 14, color: isCorrect ? '#1a7a44' : isWrong ? '#c00' : predVal ? '#1a1a2e' : '#ccc', fontWeight: isCorrect ? 700 : 400 }}>
                            {isCorrect && '✓ '}{isWrong && '✗ '}{predVal || 'לא מולא'}
                          </span>
                          {hasResult && !isCorrect && <span style={{ fontSize: 12, color: '#888' }}>(בפועל: {actualVal})</span>}
                        </div>
                        <BonusPredTable qId={q.id} users={users} actualVal={actualVal} />
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* ══════════════════════════════════════════
          TAB 2: לפי משחק
      ══════════════════════════════════════════ */}
      {mainTab === 'match' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
            <label style={{ fontSize: 13, color: '#666' }}>בחר משחק:</label>
            <select value={selectedMatchId} onChange={e => setSelectedMatchId(Number(e.target.value))}
              style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 13, fontFamily: 'inherit', flex: 1 }}>
              {MATCHES.map(m => (
                <option key={m.id} value={m.id}>
                  #{m.id} {m.teamA} נגד {m.teamB} ({m.category}) {MATCH_SCHEDULE[m.id] ? `— ${MATCH_SCHEDULE[m.id]}` : ''}
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
              <>
                <div className="match-row-view">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <span className={`cat-badge cat-${match.category.toLowerCase()}`}>{match.category}</span>
                    <span style={{ fontSize: 15, fontWeight: 600 }}>{FLAGS[match.teamA]} {match.teamA} נגד {match.teamB} {FLAGS[match.teamB]}</span>
                    <span style={{ fontSize: 12, color: '#888' }}>{MATCH_SCHEDULE[match.id]}</span>
                    {played && <span style={{ marginRight: 'auto', fontSize: 13, background: '#f5f5f5', padding: '4px 10px', borderRadius: 8, fontWeight: 600 }}>
                      בפועל: {match.teamA} {result.resultA??0}–{result.resultB??0} {match.teamB}{result.hadRedCard?' 🟥':''}
                    </span>}
                  </div>
                  <div style={{ borderTop: '1px solid #f0f0f0', paddingTop: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontSize: 11, color: '#aaa', fontWeight: 600 }}>
                      <span style={{ flex: 1 }}>משתמש</span>
                      <span style={{ minWidth: 56, textAlign: 'center' }}>ניחוש</span>
                      <span style={{ minWidth: 68, textAlign: 'center' }}>1X2</span>
                      <span style={{ minWidth: 22, textAlign: 'center' }}>🟥</span>
                      {played && <span style={{ minWidth: 44 }}>נק׳</span>}
                    </div>
                    {users.map(u => {
                      const p = u.matches[selectedMatchId]
                      const pts = played ? getMatchPts(selectedMatchId, p) : 0
                      const tag = played ? getTag(selectedMatchId, p, pts) : null
                      return (
                        <div key={u.userId} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 0',
                          borderBottom: '1px solid #f5f5f5', flexWrap: 'wrap',
                          background: u.userId === user?.uid ? '#f8f9ff' : 'transparent' }}>
                          <span style={{ flex: 1, fontSize: 13, fontWeight: u.userId === user?.uid ? 700 : 400, minWidth: 70 }}>
                            { adminDisplayName(u) }{u.userId === user?.uid ? ' (אני)' : ''}
                          </span>
                          {p ? <>
                            <span style={{ minWidth: 56, textAlign: 'center', fontSize: 13, fontWeight: 600, direction: 'ltr', display: 'inline-block' }}>{p.scoreA??'?'}–{p.scoreB??'?'}</span>
                            <span style={{ minWidth: 68, textAlign: 'center' }}>
                              <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 6px', borderRadius: 10, background: '#f0f0f0', color: '#333' }}>
                                {p.prediction1X2==='1' ? match.teamA : p.prediction1X2==='2' ? match.teamB : 'תיקו'}
                              </span>
                            </span>
                            <span style={{ minWidth: 22, textAlign: 'center', fontSize: 12 }}>{p.redCard?'🟥':'—'}</span>
                          </> : <span style={{ fontSize: 12, color: '#ccc', flex: 1 }}>לא מולא</span>}
                          {played && <PtsBadge pts={pts} played={true} />}
                          {played && tag && <ResultTag label={tag.label} type={tag.type} />}
                        </div>
                      )
                    })}
                  </div>
                </div>
                <ScoreGroupTable matchId={selectedMatchId} users={users} teamA={match.teamA} teamB={match.teamB} adminResult={result} />
              </>
            )
          })()}
        </div>
      )}

      {/* ══════════════════════════════════════════
          TAB 3: סטטיסטיקות
      ══════════════════════════════════════════ */}
      {mainTab === 'stats' && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, marginBottom: 16 }}>
            {[
              { label: 'משתתפים', value: users.length },
              { label: 'משחקים שהוחלטו', value: playedMatches.length },
              { label: playedMatches.length > 0 ? 'ניחושים מדויקים' : 'הימורים שהוגשו',
                value: playedMatches.length > 0
                  ? (() => { let c=0; users.forEach(u=>playedMatches.forEach(m=>{const p=u.matches[m.id],r=adminResults[m.id]; if(p?.scoreA!=null&&r?.resultA!=null&&Number(p.scoreA)===Number(r.resultA)&&Number(p.scoreB)===Number(r.resultB))c++})); return c })()
                  : users.filter(u => Object.keys(u.matches).length > 0).length },
              { label: playedMatches.length > 0 ? 'כרטיסים שניחשו' : 'כרטיסי אדום שסומנו',
                value: (() => { let c=0; users.forEach(u=>{ if(playedMatches.length > 0) { playedMatches.forEach(m=>{const p=u.matches[m.id],r=adminResults[m.id]; if(p?.redCard&&r?.hadRedCard)c++}) } else { Object.values(u.matches).forEach((p:any)=>{if(p?.redCard)c++}) } }); return c })() },
            ].map((s,i) => (
              <div key={i} style={{ background: '#f8f9fa', borderRadius: 10, padding: 12, textAlign: 'center', border: '1px solid #e5e5e5' }}>
                <div style={{ fontSize: 24, fontWeight: 700, color: '#1a1a2e' }}>{s.value}</div>
                <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{s.label}</div>
              </div>
            ))}
          </div>

          <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 10, color: '#444' }}>התפלגות ניחושי 1X2 לפי משחק</h2>
          {MATCHES.map(match => {
            const preds = users.map(u => ({
              x2: u.matches[match.id]?.prediction1X2,
              name: getDisplayName(u),
              scoreA: u.matches[match.id]?.scoreA,
              scoreB: u.matches[match.id]?.scoreB,
            })).filter(p => p.x2)
            if (preds.length === 0) return null
            const total = preds.length || 1
            const result = adminResults[match.id]
            const played = result?.isPlayed ?? false
            const rA = played ? Number(result.resultA??0) : null
            const rB = played ? Number(result.resultB??0) : null
            const actual = rA !== null && rB !== null ? (rA > rB ? '1' : rA < rB ? '2' : 'X') : null
            return (
              <div key={match.id} className="match-row-view" style={{ marginBottom: 8, padding: '10px 12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                  <span className="match-num">#{match.id}</span>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{FLAGS[match.teamA]} {match.teamA} נגד {match.teamB} {FLAGS[match.teamB]}</span>
                  <span style={{ marginRight: 'auto', fontSize: 12 }}>
                    {played && actual ? (
                      <>
                        <span style={{ color: '#888' }}>בפועל: {rA}–{rB} </span>
                        <span style={{ fontSize: 11, fontWeight: 600, padding: '1px 7px', borderRadius: 10, background: '#EAF3DE', color: '#3B6D11' }}>
                          {actual==='1'?match.teamA:actual==='2'?match.teamB:'תיקו'}
                        </span>
                      </>
                    ) : (
                      <span style={{ fontSize: 11, color: '#bbb' }}>טרם הוחלט</span>
                    )}
                  </span>
                </div>
                {[
                  { label: match.teamA, x2: '1' },
                  { label: 'תיקו', x2: 'X' },
                  { label: match.teamB, x2: '2' },
                ].map(row => {
                  const rowPreds = preds.filter(p => p.x2 === row.x2)
                  const pct = Math.round((rowPreds.length / total) * 100)
                  const isWinner = played && row.x2 === actual
                  const names = rowPreds.map(p => `${p.name}: ${p.scoreA ?? '?'}-${p.scoreB ?? '?'}`)
                  return (
                    <div key={row.x2} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 12, minWidth: 70, color: isWinner ? '#1a7a44' : '#555', fontWeight: isWinner ? 700 : 400 }}>{row.label}</span>
                      <div style={{ flex: 1, background: '#f0f0f0', borderRadius: 4, height: 12, overflow: 'hidden' }}>
                        <div style={{ height: 12, borderRadius: 4, width: `${pct}%`, background: isWinner ? '#1a7a44' : '#bbb' }} />
                      </div>
                      <HoverTooltip names={names}>
                        <span style={{ fontSize: 12, minWidth: 55, color: isWinner ? '#1a7a44' : '#888', fontWeight: isWinner ? 700 : 400, cursor: rowPreds.length > 0 ? 'pointer' : 'default', textDecoration: rowPreds.length > 0 ? 'underline dotted' : 'none' }}>
                          {pct}% ({rowPreds.length})
                        </span>
                      </HoverTooltip>
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      )}

      {/* ── KNOCKOUT TAB ────────────────────────────────────────────── */}
      {mainTab === 'knockout' && (
        <div>
          <div style={{ display: 'flex', gap: 4, marginBottom: 12, background: '#f8f9fa', borderRadius: 10, padding: 4 }}>
            <button onClick={() => setKoSubTab('byUser')} style={{
              flex: 1, padding: '7px', borderRadius: 8, border: 'none', cursor: 'pointer',
              fontFamily: 'inherit', fontWeight: 600, fontSize: 13,
              background: koSubTab === 'byUser' ? '#1a1a2e' : 'transparent',
              color: koSubTab === 'byUser' ? '#fff' : '#666',
            }}>👤 לפי משתמש</button>
            <button onClick={() => setKoSubTab('byMatch')} style={{
              flex: 1, padding: '7px', borderRadius: 8, border: 'none', cursor: 'pointer',
              fontFamily: 'inherit', fontWeight: 600, fontSize: 13,
              background: koSubTab === 'byMatch' ? '#1a1a2e' : 'transparent',
              color: koSubTab === 'byMatch' ? '#fff' : '#666',
            }}>⚽ לפי משחק</button>
          </div>

          {koSubTab === 'byUser' && (
            <div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                {users.map(u => (
                  <button key={u.userId} onClick={() => setSelectedUser(u.userId)} style={{
                    padding: '5px 12px', borderRadius: 20, border: '1px solid',
                    borderColor: selectedUser === u.userId ? '#1a1a2e' : '#ddd',
                    background: selectedUser === u.userId ? '#1a1a2e' : '#fff',
                    color: selectedUser === u.userId ? '#fff' : '#555',
                    fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
                  }}>{displayName(u)}</button>
                ))}
              </div>

              {current && (() => {
                const getTeam = (matchId: number, side: 'A' | 'B'): string | undefined => {
                  try {
                    const bracket = KNOCKOUT_BRACKET[matchId]
                    if (!bracket) return undefined
                    const feederId = side === 'A' ? bracket.feederA : bracket.feederB
                    if (feederId === null) return side === 'A' ? knockoutAdminMatches[matchId]?.teamA : knockoutAdminMatches[matchId]?.teamB
                    if (feederId < 0) {
                      const sfId = Math.abs(feederId)
                      const winner = current.knockout?.[sfId]?.advance
                      const sfA = getTeam(sfId, 'A'), sfB = getTeam(sfId, 'B')
                      if (!winner || !sfA || !sfB) return undefined
                      return winner === sfA ? sfB : sfA
                    }
                    return current.knockout?.[feederId]?.advance
                  } catch { return undefined }
                }

                return (['R32', 'R16', 'QF', 'SF', '3P', 'F'] as const).map(round => {
                  const roundMatches = KNOCKOUT_MATCHES.filter(m => m.round === round)
                  const hasAny = roundMatches.some(km => current.knockout?.[km.id]?.prediction1X2)
                  if (!hasAny) return null

                  return (
                    <div key={round} style={{ marginBottom: 16 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: '#888', marginBottom: 6, letterSpacing: '0.04em' }}>{KNOCKOUT_ROUND_LABELS[round]}</div>
                      {roundMatches.map(km => {
                        const pred = current.knockout?.[km.id]
                        if (!pred?.prediction1X2) return null
                        const tA = getTeam(km.id, 'A')
                        const tB = getTeam(km.id, 'B')
                        const adminKm = knockoutAdminMatches[km.id]
                        const isPlayed = adminKm?.isPlayed
                        const actual1x2 = isPlayed && adminKm?.resultA != null
                          ? (adminKm.resultA > adminKm.resultB ? '1' : adminKm.resultA < adminKm.resultB ? '2' : 'X') : null
                        const correct1x2 = actual1x2 && pred.prediction1X2 === actual1x2
                        const correctAdvance = isPlayed && adminKm?.advanceTeam && pred.advance === adminKm.advanceTeam

                        return (
                          <div key={km.id} style={{ border: '1px solid #e8e8e8', borderRadius: 10, marginBottom: 6, overflow: 'hidden' }}>
                            <div style={{ display: 'flex', alignItems: 'center', padding: '7px 10px', gap: 8, flexWrap: 'wrap' }}>
                              <span style={{ fontSize: 12, color: '#aaa' }}>#{km.id}</span>
                              <span style={{ fontWeight: 600, fontSize: 13 }}>{tA ? `${FLAGS[tA] ?? ''} ${tA}` : '?'}</span>
                              <span style={{ fontSize: 13, fontWeight: 700, color: '#333' }}>{pred.scoreA ?? '?'}–{pred.scoreB ?? '?'}</span>
                              <span style={{ fontWeight: 600, fontSize: 13 }}>{tB ? `${FLAGS[tB] ?? ''} ${tB}` : '?'}</span>
                              <span style={{
                                fontSize: 11, padding: '2px 8px', borderRadius: 10,
                                background: correct1x2 ? '#EAF3DE' : isPlayed ? '#FCEBEB' : '#f0f0f0',
                                color: correct1x2 ? '#1a7a44' : isPlayed ? '#A32D2D' : '#666', fontWeight: 600,
                              }}>
                                {pred.prediction1X2 === '1' ? (tA ?? '1') : pred.prediction1X2 === '2' ? (tB ?? '2') : 'תיקו'}
                              </span>
                              {(round === 'R32' || round === 'R16') && pred.redCard && <span>🟥</span>}
                            </div>
                            {pred.advance && (
                              <div style={{
                                padding: '5px 10px', borderTop: '1px solid #f0f0f0', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6,
                                background: correctAdvance ? '#EAF3DE' : isPlayed && adminKm?.advanceTeam ? '#FCEBEB' : '#f8f9ff',
                              }}>
                                <span style={{ color: '#888' }}>מעלה:</span>
                                <span style={{ fontWeight: 700, color: correctAdvance ? '#1a7a44' : isPlayed && adminKm?.advanceTeam ? '#A32D2D' : '#333' }}>
                                  {FLAGS[pred.advance] ?? ''} {pred.advance}
                                </span>
                                {correctAdvance && <span style={{ color: '#1a7a44' }}>✓</span>}
                                {isPlayed && adminKm?.advanceTeam && !correctAdvance && (
                                  <span style={{ color: '#A32D2D', fontSize: 11 }}>(עלה: {FLAGS[adminKm.advanceTeam] ?? ''} {adminKm.advanceTeam})</span>
                                )}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )
                })
              })()}
            </div>
          )}

          {koSubTab === 'byMatch' && (
            <div>
              {(['R32', 'R16', 'QF', 'SF', '3P', 'F'] as const).map(round => {
                const roundMatches = KNOCKOUT_MATCHES.filter(m => m.round === round)
                const anyHasTeams = roundMatches.some(km => knockoutAdminMatches[km.id]?.teamA)
                if (!anyHasTeams) return null
                return (
                  <div key={round} style={{ marginBottom: 20 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#888', marginBottom: 8, letterSpacing: '0.04em' }}>{KNOCKOUT_ROUND_LABELS[round]}</div>
                    {roundMatches.map(km => {
                      const adminKm = knockoutAdminMatches[km.id]
                      if (!adminKm?.teamA || !adminKm?.teamB) return null
                      const tA = adminKm.teamA, tB = adminKm.teamB
                      const isPlayed = adminKm.isPlayed
                      const actual1x2 = isPlayed && adminKm.resultA != null
                        ? (adminKm.resultA > adminKm.resultB ? '1' : adminKm.resultA < adminKm.resultB ? '2' : 'X') : null
                      const preds = users.map(u => ({ name: displayName(u), pred: u.knockout?.[km.id] })).filter(x => x.pred?.prediction1X2)
                      const total = preds.length
                      if (total === 0) return (
                        <div key={km.id} style={{ padding: '8px 10px', borderRadius: 8, background: '#f8f9fa', marginBottom: 6, fontSize: 12, color: '#888' }}>
                          {FLAGS[tA] ?? ''} {tA} נגד {FLAGS[tB] ?? ''} {tB} — אין הימורים
                        </div>
                      )
                      return (
                        <div key={km.id} style={{ border: '1px solid #e8e8e8', borderRadius: 10, marginBottom: 8, overflow: 'hidden' }}>
                          <div style={{ padding: '8px 12px', background: '#f8f9fa', fontWeight: 700, fontSize: 13, display: 'flex', gap: 8, alignItems: 'center' }}>
                            <span>#{km.id}</span>
                            <span>{FLAGS[tA] ?? ''} {tA}</span>
                            {isPlayed ? <span style={{ fontWeight: 700 }}>{adminKm.resultA}–{adminKm.resultB}</span> : <span style={{ color: '#aaa', fontSize: 11 }}>טרם שוחק</span>}
                            <span>{FLAGS[tB] ?? ''} {tB}</span>
                          </div>
                          <div style={{ padding: '8px 12px' }}>
                            {[['1', tA], ['X', 'תיקו'], ['2', tB]].map(([x2, label]) => {
                              const group = preds.filter(p => p.pred?.prediction1X2 === x2)
                              const pct = Math.round((group.length / total) * 100)
                              const isWinner = actual1x2 === x2
                              return (
                                <div key={x2} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                                  <span style={{ fontSize: 12, minWidth: 72, color: isWinner ? '#1a7a44' : '#555', fontWeight: isWinner ? 700 : 400 }}>{FLAGS[label] ?? ''} {label}</span>
                                  <div style={{ flex: 1, background: '#f0f0f0', borderRadius: 4, height: 10, overflow: 'hidden' }}>
                                    <div style={{ height: 10, borderRadius: 4, width: `${pct}%`, background: isWinner ? '#1a7a44' : '#bbb' }} />
                                  </div>
                                  <HoverTooltip names={group.map(p => `${p.name}: ${p.pred?.scoreA ?? '?'}–${p.pred?.scoreB ?? '?'}`)}>
                                    <span style={{ fontSize: 12, minWidth: 55, color: isWinner ? '#1a7a44' : '#888', textDecoration: group.length > 0 ? 'underline dotted' : 'none', cursor: group.length > 0 ? 'pointer' : 'default' }}>
                                      {pct}% ({group.length})
                                    </span>
                                  </HoverTooltip>
                                </div>
                              )
                            })}
                            <div style={{ marginTop: 8, borderTop: '1px solid #f0f0f0', paddingTop: 6 }}>
                              <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>מי עולה?</div>
                              {[tA, tB].map(team => {
                                const group = preds.filter(p => p.pred?.advance === team)
                                const pct = Math.round((group.length / total) * 100)
                                const isCorrect = isPlayed && adminKm?.advanceTeam === team
                                return (
                                  <div key={team} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                                    <span style={{ fontSize: 12, minWidth: 72, color: isCorrect ? '#1a7a44' : '#555', fontWeight: isCorrect ? 700 : 400 }}>{FLAGS[team] ?? ''} {team}</span>
                                    <div style={{ flex: 1, background: '#f0f0f0', borderRadius: 4, height: 8, overflow: 'hidden' }}>
                                      <div style={{ height: 8, borderRadius: 4, width: `${pct}%`, background: isCorrect ? '#1a7a44' : '#b3d4f0' }} />
                                    </div>
                                    <HoverTooltip names={group.map(p => p.name)}>
                                      <span style={{ fontSize: 12, minWidth: 55, color: isCorrect ? '#1a7a44' : '#888', textDecoration: group.length > 0 ? 'underline dotted' : 'none', cursor: group.length > 0 ? 'pointer' : 'default' }}>
                                        {pct}% ({group.length})
                                      </span>
                                    </HoverTooltip>
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}