import Flag from '../components/Flag'
import { useState, useEffect, useMemo } from 'react'
import { collection, getDocs, doc, getDoc } from 'firebase/firestore'
import { db } from '../firebase'
import { useAuth } from '../hooks/useAuth'
import { Lang, T } from '../i18n'
import StatsCharts from './StatsCharts'
import { MATCHES, GROUPS_TEAMS, BONUS_QUESTIONS, FLAGS, MATCH_SCHEDULE, KNOCKOUT_MATCHES, KNOCKOUT_ROUND_LABELS, KNOCKOUT_BRACKET } from '../data/matches'
import { MatchPrediction, GroupPrediction, BonusPredictions, Group, Match, KnockoutMatchPrediction } from '../types'
import { calc1X2Points, calcScorePoints, calcRedCardPoints, calcGroupPoints, calcBonusPoints, calcAdvancePoints, calc1X2KnockoutPoints, calcScoreKnockoutPoints, calcOUPoints } from '../scoring'
import { TEAM_FIFA_POINTS, calcCategoryByRound } from '../data/matches'

const GROUPS = 'ABCDEFGHIJKL'.split('') as Group[]

interface UserData {
  userId: string; userName: string; nickname?: string
  matches: Record<number, MatchPrediction>
  groups: Record<Group, GroupPrediction>
  bonus: Partial<BonusPredictions>
  knockout?: Record<number, KnockoutMatchPrediction>
  knockoutRedCards?: { R32?: number[]; R16?: number[]; QF?: number[] }
}

type MainTab = 'user' | 'match' | 'stats'
type UserTab = 'matches' | 'groups' | 'bonus'

// Module-level helper — usable in all sub-components
function getDisplayName(u: UserData) { return u.userName }

// ── Helpers ──────────────────────────────────────────────────────
function getBestMatchId(fullSchedule: Record<number | string, string>, mockNow?: number): number {
  const now = mockNow ?? Date.now()
  const TWO_HOURS = 2 * 60 * 60 * 1000
  let nextId = 1, nextTime = Infinity
  let recentId: number | null = null, recentTime = -Infinity
  for (const [idStr, timeStr] of Object.entries(fullSchedule)) {
    try {
      const [datePart, timePart] = timeStr.split(' ')
      const [day, month] = datePart.split('/').map(Number)
      const [hour, minute] = (timePart ?? '00:00').split(':').map(Number)
      const matchTime = new Date(2026, month - 1, day, hour, minute).getTime()
      const diff = matchTime - now
      if (diff <= 0 && diff > -TWO_HOURS) {
        if (matchTime > recentTime) { recentTime = matchTime; recentId = Number(idStr) }
      } else if (diff > 0 && diff < nextTime) {
        nextTime = diff; nextId = Number(idStr)
      }
    } catch { /* skip */ }
  }
  return recentId ?? nextId
}

function getNextMatchId(): number {
  return getBestMatchId(MATCH_SCHEDULE)
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
function ScoreGroupTable({ matchId, users, teamA, teamB, adminResult, lang = "he" as Lang }: {
  matchId: number; users: UserData[]; teamA: string; teamB: string; lang?: Lang; adminResult?: Match
}) {
  const t = T[lang]
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
    if (a === t.notFilled) return 1
    if (b === t.notFilled) return -1
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
          { label: t.draw, x2: 'X', color: '#444', bg: '#f0f0f0' },
          { label: teamB, x2: '2', color: '#444', bg: '#f0f0f0' },
        ].map(col => {
          // Filter scores for this 1X2 outcome
          const colScores = sorted.filter(([score]) => {
            if (score === t.notFilled) return col.x2 === 'X' // show "not filled" under draw
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
              <div style={{ border: `1px solid ${col.color}30`, borderTop: 'none', borderRadius: '0 0 8px 8px' }}>
                {colScores.length === 0 && (
                  <div style={{ padding: '10px', fontSize: 12, color: '#ccc', textAlign: 'center' }}>{t.noPredictions}</div>
                )}
                {colScores.map(([score, scoreUsers], idx) => {
                  const [sA, sB] = score === t.notFilled ? [null, null] : score.split('-').map(Number)
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
                          {score === t.notFilled ? '—' : `${sB}-${sA}`}
                        </span>
                        {isExact && <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 5px', borderRadius: 8, background: '#EAF3DE', color: '#3B6D11' }}>✓</span>}
                        {isMargin && <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 5px', borderRadius: 8, background: '#E6F1FB', color: '#185FA5' }}>~</span>}
                        <span style={{ fontSize: 11, color: '#aaa', marginRight: 'auto' }}>({scoreUsers.length})</span>
                      </div>
                      {/* Names */}
                      <div style={{ fontSize: 12, color: '#555', lineHeight: 1.6, display: 'flex', flexWrap: 'wrap', gap: '2px 0' }}>
                        {scoreUsers.map((u, i) => (
                          <span key={u.userId} style={{ whiteSpace: 'nowrap' }}>
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

// Knockout score distribution — same 3-col layout as ScoreGroupTable
function ScoreKnockoutTable({ matchId, users, teamA, teamB, adminResult, lang = 'he' as Lang }: {
  matchId: number; users: UserData[]; teamA: string; teamB: string; lang?: Lang; adminResult?: any
}) {
  const t = T[lang]
  const played = adminResult?.isPlayed ?? false
  const rA = played ? Number(adminResult.resultA ?? 0) : null
  const rB = played ? Number(adminResult.resultB ?? 0) : null
  const groups: Record<string, UserData[]> = {}
  users.forEach(u => {
    const p = u.knockout?.[matchId]
    if (!p || p.scoreA == null || p.scoreB == null) {
      groups[t.notFilled] = groups[t.notFilled] ?? []; groups[t.notFilled].push(u)
    } else {
      const key = `${p.scoreA}-${p.scoreB}`
      groups[key] = groups[key] ?? []; groups[key].push(u)
    }
  })
  const sorted = Object.entries(groups).sort(([a], [b]) => {
    if (a === t.notFilled) return 1; if (b === t.notFilled) return -1
    const [aA, aB] = a.split('-').map(Number); const [bA, bB] = b.split('-').map(Number)
    return (bA + bB) - (aA + aB) || aA - bA
  })
  const advanceCounts: Record<string, string[]> = {}
  users.forEach(u => {
    const adv = u.knockout?.[matchId]?.advance
    if (adv) { advanceCounts[adv] = advanceCounts[adv] ?? []; advanceCounts[adv].push(getDisplayName(u)) }
  })
  const totalUsers = users.filter(u => u.knockout?.[matchId]?.prediction1X2).length || 1
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10, color: '#1a1a2e', borderBottom: '2px solid #1a1a2e', paddingBottom: 6, display: 'flex', justifyContent: 'space-between' }}>
        <span>פילוח לפי ניחוש — {teamB} נגד {teamA}</span>
        <span style={{ fontSize: 12, fontWeight: 400, color: '#888' }}>{Object.values(groups).reduce((s, a) => s + a.length, 0)} הימורים</span>
      </div>
      <div className="score-3col" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 12 }}>
        {[{ label: teamA, x2: '1' }, { label: t.draw, x2: 'X' }, { label: teamB, x2: '2' }].map(col => {
          const colScores = sorted.filter(([score]) => {
            if (score === t.notFilled) return col.x2 === 'X'
            const [sA, sB] = score.split('-').map(Number)
            if (col.x2 === '1') return sA > sB; if (col.x2 === '2') return sB > sA; return sA === sB
          })
          const total = colScores.reduce((s, [, u]) => s + u.length, 0)
          return (
            <div key={col.x2}>
              <div style={{ background: '#f0f0f0', color: '#444', fontWeight: 700, fontSize: 13, padding: '6px 10px', borderRadius: '8px 8px 0 0', textAlign: 'center', borderBottom: '2px solid #444' }}>
                {col.label} <span style={{ fontWeight: 400, fontSize: 11, opacity: 0.8 }}>({total})</span>
              </div>
              <div style={{ border: '1px solid rgba(68,68,68,0.18)', borderTop: 'none', borderRadius: '0 0 8px 8px', overflow: 'hidden' }}>
                {colScores.length === 0 && <div style={{ padding: 10, fontSize: 12, color: '#ccc', textAlign: 'center' }}>{t.noPredictions}</div>}
                {colScores.map(([score, scoreUsers], idx) => {
                  const [sA, sB] = score === t.notFilled ? [null, null] : score.split('-').map(Number)
                  const isExact = played && sA !== null && sA === rA && sB === rB
                  const isMargin = played && sA !== null && !isExact && (sA! - sB!) === (rA! - rB!)
                  return (
                    <div key={score} style={{ borderBottom: idx < colScores.length - 1 ? '1px solid #f0f0f0' : 'none', background: isExact ? '#f0fbf4' : isMargin ? '#f0f6fb' : idx % 2 === 0 ? '#fafafa' : '#fff', padding: '7px 10px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                        <span style={{ fontSize: 15, fontWeight: 800, direction: 'ltr', display: 'inline-block', color: isExact ? '#3B6D11' : isMargin ? '#185FA5' : '#1a1a2e' }}>
                          {score === t.notFilled ? '—' : `${sA}-${sB}`}
                        </span>
                        {isExact && <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 5px', borderRadius: 8, background: '#EAF3DE', color: '#3B6D11' }}>✓</span>}
                        {isMargin && <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 5px', borderRadius: 8, background: '#E6F1FB', color: '#185FA5' }}>~</span>}
                        <span style={{ fontSize: 11, color: '#aaa', marginRight: 'auto' }}>({scoreUsers.length})</span>
                      </div>
                      <div style={{ fontSize: 12, color: '#555', lineHeight: 1.6 }}>
                        {scoreUsers.map((u, i) => (
                          <span key={u.userId}>{getDisplayName(u)}{i < scoreUsers.length - 1 && <span style={{ color: '#ddd', margin: '0 5px' }}>·</span>}</span>
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
      {Object.keys(advanceCounts).length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#888', marginBottom: 6 }}>{t.koWhoAdvanceQ}</div>
          {[teamA, teamB].map(team => {
            const names = advanceCounts[team] ?? []
            const isCorrect = played && adminResult?.advanceTeam === team
            return (
              <div key={team} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                <span style={{ fontSize: 13, minWidth: 100, display: 'flex', alignItems: 'center', gap: 5, fontWeight: isCorrect ? 700 : 400, color: isCorrect ? '#1a7a44' : '#444' }}>
                  <Flag emoji={FLAGS[team]??''} size={20} /> {team} {isCorrect && '✓'}
                </span>
                <div style={{ flex: 1, background: '#f0f0f0', borderRadius: 4, height: 10, overflow: 'hidden' }}>
                  <div style={{ height: 10, borderRadius: 4, width: `${Math.round(names.length / totalUsers * 100)}%`, background: isCorrect ? '#1a7a44' : '#b3d4f0' }} />
                </div>
                <span style={{ fontSize: 12, minWidth: 60, color: isCorrect ? '#1a7a44' : '#888' }}>{Math.round(names.length / totalUsers * 100)}% ({names.length})</span>
                <span style={{ fontSize: 12, color: '#aaa' }}>{names.join(' · ')}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// Group predictions table for Groups tab
function GroupPredTable({ group, users, actualResult, lang = "he" as Lang }: {
  group: Group; users: UserData[]; lang?: Lang; actualResult?: [string, string, string]
}) {
  const t = T[lang]
  const teams = GROUPS_TEAMS[group]
  const total = users.filter(u => u.groups[group]).length

  // Build matrix: team → position → users[]
  const matrix: Record<string, UserData[][]> = {}
  teams.forEach(team => { matrix[team] = [[], [], []] })
  users.forEach(u => {
    const gp = u.groups[group]
    if (!gp) return
    gp.advancing.forEach((team, idx) => {
      if (team && matrix[team] && idx < 3) matrix[team][idx].push(u)
    })
  })

  // Sort teams by total picks descending
  const sortedTeams = [...teams].sort((a, b) =>
    (matrix[b][0].length + matrix[b][1].length + matrix[b][2].length) -
    (matrix[a][0].length + matrix[a][1].length + matrix[a][2].length)
  )

  const maxCount = Math.max(1, ...teams.flatMap(t => [0, 1, 2].map(i => matrix[t][i].length)))

  const cellBg = (count: number, pos: number, team: string) => {
    const isActual = actualResult?.[pos] === team
    if (isActual) return '#c8f0d0'
    if (count === 0) return '#fafafa'
    const intensity = Math.round(30 + (count / maxCount) * 160)
    return `rgba(26, 122, 68, ${(count / maxCount) * 0.55 + 0.05})`
  }

  return (
    <div style={{ marginTop: 10, overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr>
            <th style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 600, color: '#888', fontSize: 11, borderBottom: '2px solid #eee' }}>
              נבחרת
            </th>
            {['🥇 1', '🥈 2', '🥉 3'].map((label, i) => (
              <th key={i} style={{ padding: '6px 10px', textAlign: 'center', fontWeight: 600, color: '#888', fontSize: 11, borderBottom: '2px solid #eee', minWidth: 90 }}>
                {label}
                {actualResult?.[i] && (
                  <div style={{ fontSize: 10, color: '#1a7a44', fontWeight: 700 }}>({actualResult[i]})</div>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedTeams.map((team, rowIdx) => {
            const actualPos = actualResult?.indexOf(team)
            const inActual = actualPos !== undefined && actualPos >= 0
            return (
              <tr key={team} style={{ borderBottom: '1px solid #f0f0f0' }}>
                <td style={{ padding: '6px 10px', fontWeight: 600, whiteSpace: 'nowrap',
                  background: inActual ? '#f0faf4' : rowIdx % 2 === 0 ? '#fafafa' : '#fff' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <Flag emoji={FLAGS[team] ?? ''} size={16} />
                    {team}
                    {inActual && <span style={{ fontSize: 10, background: '#EAF3DE', color: '#3B6D11', padding: '1px 5px', borderRadius: 8 }}>#{actualPos! + 1}</span>}
                  </span>
                </td>
                {[0, 1, 2].map(pos => {
                  const cellUsers = matrix[team][pos]
                  const count = cellUsers.length
                  const bg = cellBg(count, pos, team)
                  const isActual = actualResult?.[pos] === team
                  return (
                    <td key={pos} style={{ padding: '5px 8px', textAlign: 'center', background: bg,
                      border: isActual ? '2px solid #1a7a44' : '1px solid #f0f0f0' }}>
                      {count > 0 ? (
                        <>
                          <div style={{ fontWeight: 700, fontSize: 14, color: isActual ? '#1a7a44' : '#1a1a2e' }}>{count}</div>
                          <div style={{ fontSize: 10, color: '#555', lineHeight: 1.3, marginTop: 2 }}>
                            {cellUsers.map(u => getDisplayName(u)).join(', ')}
                          </div>
                        </>
                      ) : (
                        <span style={{ color: '#ddd', fontSize: 12 }}>—</span>
                      )}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
        <tfoot>
          <tr>
            <td style={{ padding: '4px 10px', fontSize: 11, color: '#aaa' }}>סה״כ {total} הימורים</td>
            {[0, 1, 2].map(pos => {
              const topTeam = sortedTeams.reduce((best, t) =>
                matrix[t][pos].length > matrix[best][pos].length ? t : best, sortedTeams[0])
              const topCount = matrix[topTeam]?.[pos]?.length ?? 0
              return (
                <td key={pos} style={{ padding: '4px 8px', textAlign: 'center', fontSize: 11, color: '#888' }}>
                  {topCount > 0 ? `${topTeam} (${topCount})` : '—'}
                </td>
              )
            })}
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

// Group bonus answers table
function BonusPredTable({ qId, users, actualVal, lang = "he" as Lang }: {
  qId: string; users: UserData[]; lang?: Lang; actualVal?: string
}) {
  const t = T[lang]
  const groups: Record<string, UserData[]> = {}
  users.forEach(u => {
    const val = (u.bonus as any)?.[qId] ?? 'לא מולא'
    groups[val] = groups[val] ?? []
    groups[val].push(u)
  })

  return (
    <div style={{ border: '1px solid #e5e5e5', borderRadius: 8, overflow: 'hidden', marginTop: 8 }}>
      {Object.entries(groups).sort(([a], [b]) => a === t.notFilled ? 1 : b === t.notFilled ? -1 : a.localeCompare(b)).map(([val, valUsers], idx, arr) => {
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

export default function AllPredictions({ lang = 'he' as Lang }) {
  const t = T[lang]
  const { user, isAdmin, loading: authLoading } = useAuth()
  const [users, setUsers] = useState<UserData[]>([])
  const [selectedUser, setSelectedUser] = useState<string | null>(null)
  const [selectedMatchId, setSelectedMatchId] = useState<number>(() => getNextMatchId())
  const [isOpen, setIsOpen] = useState(true)
  const [liveMode, setLiveMode] = useState(false)
  const [loading, setLoading] = useState(true)
  const [koDeadlines, setKoDeadlines] = useState<Record<string, number | null>>({})
  const now = Date.now()
  const [mainTab, setMainTab] = useState<MainTab>('user')
  const [userTab, setUserTab] = useState<UserTab>('matches')
  const [adminResults, setAdminResults] = useState<Record<number, Match>>({})
  const [actualGroups, setActualGroups] = useState<Record<string, [string, string, string]>>({})
  const [actualBonus, setActualBonus] = useState<Partial<BonusPredictions>>({})
  const [scores, setScores] = useState<Record<string, number>>({})
  const [scoreBreakdown, setScoreBreakdown] = useState<Record<string, {
    total: number; matchPoints: number; groupPoints: number;
    bonusPoints: number; redCardPoints: number; knockoutPoints: number
  }>>({})
  const [knockoutScores, setKnockoutScores] = useState<Record<string, number>>({})
  const [knockoutAdminMatches, setKnockoutAdminMatches] = useState<Record<number, any>>({})
  const [adminSchedule, setAdminSchedule] = useState<Record<number, string>>({})
  const [mockNow, setMockNow] = useState<number | undefined>(undefined)
  const [koSubTab, setKoSubTab] = useState<'byUser' | 'byMatch'>('byUser')
  const [statsSubTab, setStatsSubTab] = useState<'overview' | 'matches' | 'groups' | 'bonus'>('overview')
  const [userSubTab, setUserSubTab] = useState<'matches' | 'groups' | 'bonus' | 'knockout'>('matches')
  const [refreshKey, setRefreshKey] = useState(0)
  const [openKoRounds, setOpenKoRounds] = useState<Set<string>>(new Set(['R32', 'R16', 'QF', 'SF', '3P', 'F']))

  const isMobile = typeof window !== 'undefined' && window.innerWidth < 520

  // A knockout round is visible only when its deadline has passed (betting closed)
  // Admins can always see everything
  const isRoundVisible = (round: string) => {
    if (isAdmin && !liveMode) return true
    const dl = koDeadlines[round]
    return dl != null && now > dl
  }

  // FIFA rank map (sorted by points descending)
  const fifaRankMap = useMemo(() => {
    const sorted = Object.entries(TEAM_FIFA_POINTS).sort((a, b) => b[1] - a[1])
    const map: Record<string, number> = {}
    sorted.forEach(([team], i) => { map[team] = i + 1 })
    return map
  }, [])

  const toggleKoRound = (round: string) =>
    setOpenKoRounds(prev => { const s = new Set(prev); s.has(round) ? s.delete(round) : s.add(round); return s })

  useEffect(() => {
    if (authLoading) return
    ;(async () => {
      const settings = await getDoc(doc(db, 'settings', 'app'))
      const open = settings.exists() ? (settings.data().isOpen ?? true) : true
      const deadline = settings.exists() ? settings.data().deadline : null
      const isClosed = !open || (deadline && Date.now() > deadline)
      const live = settings.exists() ? (settings.data().liveMode ?? false) : false
      setIsOpen(!isClosed)
      setLiveMode(live)

      // Load knockout round deadlines for visibility filtering
      if (settings.exists()) {
        const d = settings.data()
        setKoDeadlines({
          R32: d.knockoutDeadline ?? null,
          R16: d.r16Deadline    ?? null,
          QF:  d.qfDeadline     ?? null,
          SF:  d.sfDeadline     ?? null,
          '3P': d.p3Deadline ?? d.finalDeadline ?? null,
          F:   d.finalDeadline  ?? null,
        })
        if (d.mockNow) setMockNow(d.mockNow)
      }

      // When liveMode is ON, even admins can't see predictions until closed
      const canSeePreds = isClosed || (isAdmin && !live)
      const [resultsSnap, predsSnap, scoresSnap, koSnap, schedSnap] = await Promise.all([
        getDoc(doc(db, 'admin', 'results')),
        canSeePreds ? getDocs(collection(db, 'predictions')) : Promise.resolve(null),
        canSeePreds ? getDocs(collection(db, 'scores')) : Promise.resolve(null),
        getDoc(doc(db, 'admin', 'knockout')),
        getDoc(doc(db, 'admin', 'schedule')),
      ])

      if (resultsSnap.exists()) {
        setAdminResults(resultsSnap.data().matches ?? {})
        setActualGroups(resultsSnap.data().groups ?? {})
        setActualBonus(resultsSnap.data().bonus ?? {})
      }
      if (koSnap.exists()) {
        const raw = koSnap.data().matches ?? {}
        const normalized: Record<number, any> = {}
        for (const [k, v] of Object.entries(raw)) {
          normalized[Number(k)] = v
        }
        setKnockoutAdminMatches(normalized)
      }
      if (schedSnap.exists()) {
        const raw = schedSnap.data().schedule ?? {}
        const normalized: Record<number, string> = {}
        for (const [k, v] of Object.entries(raw)) normalized[Number(k)] = v as string
        setAdminSchedule(normalized)
      }

      if (predsSnap) {
        const data: UserData[] = predsSnap.docs.map(d => ({
          userId: d.id, userName: d.data().userName ?? 'משתמש',
          nickname: d.data().nickname ?? '',
          matches: d.data().matches ?? {}, groups: d.data().groups ?? {}, bonus: d.data().bonus ?? {},
          knockout: d.data().knockout ?? {},
          knockoutRedCards: d.data().knockoutRedCards ?? { R32: [], R16: [], QF: [] },
        }))
        setUsers(data)
        if (data.length > 0) {
          const me = data.find(u => u.userId === user?.uid)
          setSelectedUser(me ? me.userId : data[0].userId)
        }
      }

      if (scoresSnap) {
        const sc: Record<string, number> = {}
        const koSc: Record<string, number> = {}
        const breakdown: Record<string, any> = {}
        scoresSnap.docs.forEach(d => {
          const data = d.data()
          sc[d.id] = data.total ?? 0
          koSc[d.id] = data.knockoutPoints ?? 0
          breakdown[d.id] = {
            total:          data.total          ?? 0,
            matchPoints:    data.matchPoints     ?? 0,
            groupPoints:    data.groupPoints     ?? 0,
            bonusPoints:    data.bonusPoints     ?? 0,
            redCardPoints:  data.redCardPoints   ?? 0,
            knockoutPoints: data.knockoutPoints  ?? 0,
          }
        })
        setScores(sc)
        setKnockoutScores(koSc)
        setScoreBreakdown(breakdown)
      }
      setLoading(false)
    })()
  }, [isAdmin, authLoading, refreshKey])

  // Re-compute best match when full schedule (incl. knockout) loads
  useEffect(() => {
    const fullSchedule = { ...MATCH_SCHEDULE, ...adminSchedule }
    const best = getBestMatchId(fullSchedule, mockNow)
    setSelectedMatchId(best)
  }, [adminSchedule, mockNow])
  function getMatchPts(matchId: number, pred: MatchPrediction | undefined) {
    if (!pred) return 0
    const result = adminResults[matchId]
    if (!result?.isPlayed || result.resultA == null || result.resultB == null) return 0
    const match = MATCHES.find(m => m.id === matchId)!
    const rA = Number(result.resultA), rB = Number(result.resultB)
    const p1 = calc1X2Points(pred.prediction1X2, rA, rB, match.fifaPointsA, match.fifaPointsB, match.category)
    const psBase = pred.scoreA != null && pred.scoreB != null ? calcScorePoints(Number(pred.scoreA), Number(pred.scoreB), rA, rB, match.category) : 0
    const psOU   = pred.scoreA != null && pred.scoreB != null ? calcOUPoints(Number(pred.scoreA), Number(pred.scoreB), rA, rB, match.category) : 0
    const ps = psBase + psOU
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
      // Use scoring.ts getOUType for consistency (group stage has no round override)
      const ouTypeOf = (t: number) => {
        return t <= 1 ? 'under' : t >= 4 ? 'over' : null
      }
      if (pA === rA && pB === rB) {
        const total = rA + rB
        const ouT = ouTypeOf(total)
        const ouLabel = ouT === 'under' ? 'אנדר' : ouT === 'over' ? 'אובר' : null
        // For exact: show OU inline in מדויק chip only (no separate chip)
        items.push(`מדויק: +2${ouLabel ? ` (${ouLabel})` : ''}`)
      } else {
        if ((pA - pB) === (rA - rB)) items.push('הפרש: +1')
        // Non-exact OU: show separate chip
        const predOU = ouTypeOf(pA + pB), actOU = ouTypeOf(rA + rB)
        if (predOU && predOU === actOU) {
          items.push((predOU === 'under' ? 'אנדר' : 'אובר') + ': +1')
        }
      }
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
    if (pts === 0) return { label: t.resultWrong, type: 'bad' as const }
    const actual1x2 = rA > rB ? '1' : rA < rB ? '2' : 'X'
    const correct1x2 = pred.prediction1X2 === actual1x2
    const exact = pA === rA && pB === rB
    const marginOk = pA !== null && pB !== null && (pA - pB) === (rA - rB)
    if (exact && correct1x2) return { label: t.resultExact, type: 'ok' }
    if (correct1x2 && marginOk) return { label: t.result1x2ok+' + '+t.resultMargin, type: 'ok' }
    if (correct1x2) return { label: t.result1x2ok, type: 'ok' }
    if (marginOk) return { label: t.resultMargin, type: 'warn' }
    return { label: `+${pts} נק׳`, type: 'warn' }
  }

  // Display name: always use userName
  const displayName = (u: UserData) => u.userName
  const adminDisplayName = (u: UserData) => u.userName

  const downloadReport = () => {
    const now = new Date()
    const stamp = now.toLocaleString('he-IL', { dateStyle: 'full', timeStyle: 'medium' })
    const filename = `wc2026-bets-${now.toISOString().slice(0,16).replace('T','-')}.html`

    const userRows = users.map(u => {
      const name = adminDisplayName(u)
      const totalScore = scores[u.userId] ?? 0

      // Group stage match predictions
      const matchRows = MATCHES.map(m => {
        const p = u.matches[m.id]
        if (!p) return ''
        const res = adminResults[m.id]
        const flag = (t: string) => FLAGS[t] ?? ''
        const actual = res?.isPlayed ? `${res.resultB}:${res.resultA}` : '—'
        const pred1x2 = p.prediction1X2 ?? '—'
        const predScore = (p.scoreA != null && p.scoreB != null) ? `${p.scoreB}:${p.scoreA}` : '—'
        const rc = p.redCard ? '🟥' : ''
        return `<tr><td>${m.id}</td><td>${flag(m.teamA)}${m.teamA} נ׳ ${flag(m.teamB)}${m.teamB}</td><td>${pred1x2}</td><td>${predScore}</td><td>${rc}</td><td>${actual}</td></tr>`
      }).filter(Boolean).join('')

      // Group qualifiers
      const groupRows = GROUPS.map(g => {
        const gp = u.groups?.[g]
        if (!gp) return ''
        const teams = GROUPS_TEAMS[g] ?? []
        const adv = gp.advancing ?? []
        return `<tr><td>בית ${g}</td><td>${adv.map((t, i) => `${i+1}. ${FLAGS[t]??''}${t}`).join(' | ')}</td></tr>`
      }).filter(Boolean).join('')

      // Bonus
      const bonusRows = BONUS_QUESTIONS.map(q => {
        const val = (u.bonus as any)?.[q.id]
        if (!val) return ''
        return `<tr><td>${q.label}</td><td>${val}</td></tr>`
      }).filter(Boolean).join('')

      // Knockout
      const koRows = KNOCKOUT_MATCHES.map(km => {
        const p = u.knockout?.[km.id]
        if (!p) return ''
        const pred1x2 = p.prediction1X2 ?? '—'
        const predScore = (p.scoreA != null && p.scoreB != null) ? `${p.scoreA}:${p.scoreB}` : '—'
        const adv = p.advance ?? '—'
        return `<tr><td>${km.id}</td><td>${KNOCKOUT_ROUND_LABELS[km.round]}</td><td>${pred1x2}</td><td>${predScore}</td><td>${adv}</td></tr>`
      }).filter(Boolean).join('')

      return `
        <div class="user-block" id="user-${u.userId}">
          <div class="user-header">
            ${name} <span class="score-badge">${totalScore} נק׳</span>
            <a href="#toc" class="back-link">↑ חזור לרשימה</a>
          </div>
          ${matchRows ? `
            <h4>שלב הבתים</h4>
            <table><thead><tr><th>#</th><th>משחק</th><th>1X2</th><th>תוצאה</th><th>🟥</th><th>בפועל</th></tr></thead>
            <tbody>${matchRows}</tbody></table>` : ''}
          ${groupRows ? `
            <h4>עולות מהבתים</h4>
            <table><thead><tr><th>בית</th><th>בחירה</th></tr></thead>
            <tbody>${groupRows}</tbody></table>` : ''}
          ${bonusRows ? `
            <h4>שאלות בונוס</h4>
            <table><thead><tr><th>שאלה</th><th>תשובה</th></tr></thead>
            <tbody>${bonusRows}</tbody></table>` : ''}
          ${koRows ? `
            <h4>נוקאאוט</h4>
            <table><thead><tr><th>#</th><th>שלב</th><th>1X2</th><th>תוצאה</th><th>עולה</th></tr></thead>
            <tbody>${koRows}</tbody></table>` : ''}
        </div>`
    }).join('')

    const sortedUsers = [...users].sort((a, b) => (scores[b.userId] ?? 0) - (scores[a.userId] ?? 0))

    const tocRows = sortedUsers.map((u, i) => {
      const name = adminDisplayName(u)
      const total = scores[u.userId] ?? 0
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}.`
      return `<tr>
        <td style="font-weight:700;font-size:15px">${medal}</td>
        <td><a href="#user-${u.userId}" style="color:#1a1a2e;font-weight:600;text-decoration:none">${name}</a></td>
        <td style="text-align:center"><span style="background:#1a7a44;color:#fff;padding:2px 10px;border-radius:12px;font-weight:700;font-size:13px">${total}</span></td>
      </tr>`
    }).join('')

    const html = `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
<meta charset="UTF-8">
<title>דוח הימורים WC2026 — ${stamp}</title>
<style>
  body { font-family: Arial, sans-serif; direction: rtl; background: #f5f5f5; color: #222; margin: 0; padding: 20px; }
  .report-header { background: #1a1a2e; color: #fff; padding: 18px 24px; border-radius: 10px; margin-bottom: 24px; }
  .report-header h1 { margin: 0 0 6px; font-size: 22px; }
  .report-header .stamp { font-size: 13px; color: #aaa; }
  .report-header .warning { margin-top: 10px; font-size: 12px; background: rgba(255,200,0,0.15); border: 1px solid rgba(255,200,0,0.3); border-radius: 6px; padding: 6px 10px; color: #ffd966; }
  .toc { background: #fff; border-radius: 10px; padding: 16px 20px; margin-bottom: 24px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  .toc h2 { margin: 0 0 12px; font-size: 15px; color: #1a1a2e; }
  .toc table { width: auto; min-width: 300px; }
  .toc td { padding: 7px 10px; border-bottom: 1px solid #f5f5f5; }
  .toc tr:last-child td { border-bottom: none; }
  .toc tr:hover td { background: #f8f9ff; }
  .user-block { background: #fff; border-radius: 10px; padding: 16px 20px; margin-bottom: 20px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); page-break-inside: avoid; }
  .user-header { font-size: 17px; font-weight: 700; margin-bottom: 12px; color: #1a1a2e; border-bottom: 2px solid #e0e0f0; padding-bottom: 8px; display: flex; align-items: center; gap: 10px; }
  .score-badge { background: #1a7a44; color: #fff; font-size: 13px; padding: 2px 10px; border-radius: 12px; font-weight: 700; }
  .back-link { margin-right: auto; font-size: 12px; color: #888; text-decoration: none; padding: 3px 8px; border: 1px solid #ddd; border-radius: 6px; }
  .back-link:hover { background: #f0f0f8; }
  h4 { margin: 14px 0 6px; font-size: 13px; color: #555; border-bottom: 1px solid #eee; padding-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 8px; }
  th { background: #f0f0f8; text-align: right; padding: 5px 8px; font-weight: 600; color: #444; }
  td { padding: 4px 8px; border-bottom: 1px solid #f0f0f0; }
  tr:last-child td { border-bottom: none; }
  @media print { body { padding: 0; } .user-block { box-shadow: none; border: 1px solid #ddd; } .toc { display: none; } }
</style>
</head>
<body>
<div class="report-header">
  <h1>⚽ דוח הימורים — גביע העולם 2026</h1>
  <div class="stamp">הופק: ${stamp}</div>
  <div class="stamp">${users.length} משתתפים</div>
  <div class="warning">⚠️ מסמך זה מייצג את מצב ההימורים בזמן ההורדה. שמור אותו כהוכחה שלא בוצעו שינויים לאחר נעילת השלב.</div>
</div>

<div class="toc" id="toc">
  <h2>📋 רשימת משתתפים — לחץ לדילוג ישיר</h2>
  <table>
    <thead><tr><th style="width:40px"></th><th>שם</th><th style="width:80px;text-align:center">נקודות</th></tr></thead>
    <tbody>${tocRows}</tbody>
  </table>
</div>

${userRows}
</body>
</html>`

    const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }
  if (isOpen && !isAdmin) return (
    <div className="page"><div className="empty-state">
      <div style={{ fontSize: 48 }}>🔒</div>
      <h2>ההימורים עוד פתוחים</h2>
      <p>ניתן לראות את ההימורים של כולם רק לאחר סגירת ההגשות</p>
    </div></div>
  )
  if (!users.length) return <div className="page"><div className="empty-state"><p>{t.noPredictions}</p></div></div>

  const current = users.find(u => u.userId === selectedUser)
  const playedMatches = MATCHES.filter(m => adminResults[m.id]?.isPlayed)

  const TAB_LABELS: { id: MainTab; label: string }[] = [
    { id: 'user',  label: '👤 לפי משתמש' },
    { id: 'match', label: '⚽ לפי משחק' },
    { id: 'stats', label: '📊 סטטיסטיקות' },
  ]

  return (
    <div className="page">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <h1 style={{ margin: 0 }}>הימורי כולם {isAdmin && isOpen && !liveMode && <span className="badge badge-red">{t.adminMode}</span>}{isAdmin && liveMode && <span className="badge" style={{ background: '#2d6a2d', color: '#fff' }}>🟢 ריצה על אמת</span>}</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={downloadReport} style={{
            padding: '6px 12px', borderRadius: 8, border: '1px solid #1a7a44',
            background: '#EAF3DE', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit',
            color: '#1a5c30', fontWeight: 600,
          }} title="הורד דוח HTML עם כל ההימורים כהוכחה לזמן הנעילה">{t.downloadReport}</button>
          <button onClick={() => { setLoading(true); setRefreshKey(k => k + 1) }} style={{
            padding: '6px 12px', borderRadius: 8, border: '1px solid #ddd',
            background: '#fff', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit',
            color: '#555',
          }} title="טוען מחדש את כל ההימורים והתוצאות מהשרת">{t.refresh}</button>
        </div>
      </div>

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
                { adminDisplayName(u) }{u.userId === user?.uid ? ` ${t.itsMe}` : ''}
              </button>
            ))}
          </div>
          {current && (
            <>
              <div className="tabs" style={{ marginTop: 12 }}>
                {([
                  { id: 'matches',  label: `⚽ ${t.tabMatches}` },
                  { id: 'groups',   label: `🏠 ${t.tabGroups}` },
                  { id: 'bonus',    label: `🎯 ${t.tabBonus}` },
                  { id: 'knockout', label: `🏆 ${t.roundF.slice(0,0)}${t.tabKnockout.replace('🏆 ','')}` },
                ] as const).map(t => (
                  <button key={t.id}
                    className={userSubTab === t.id ? 'tab active' : 'tab'}
                    onClick={() => setUserSubTab(t.id)}>
                    {t.label}
                  </button>
                ))}
              </div>

              {/* Matches */}
              {userSubTab === 'matches' && (() => {
                const currentMatchId = getBestMatchId({ ...MATCH_SCHEDULE, ...adminSchedule }, mockNow)
                return (<>
                  {/* Sticky button to jump to current/upcoming match */}
                  <div style={{ position: 'sticky', top: 0, zIndex: 30, background: 'var(--color-background-primary, #fff)', borderBottom: '1px solid #eee', padding: '6px 0', marginBottom: 6, display: 'flex', justifyContent: 'center' }}>
                    <button onClick={() => {
                      document.getElementById(`user-match-${currentMatchId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                    }} style={{
                      fontSize: 12, fontWeight: 600, padding: '5px 16px', borderRadius: 20,
                      border: '1px solid #1a1a2e', background: '#1a1a2e', color: '#fff',
                      cursor: 'pointer', fontFamily: 'inherit',
                    }}>
                      ↓ {lang === 'he' ? 'קפוץ למשחק הנוכחי' : 'Jump to current match'} #{currentMatchId}
                    </button>
                  </div>
                  {[1,2,3].map(round => (
                <div key={round}>
                  <h2 className="round-title">{t.round} {round}</h2>
                  {GROUPS.map(group => {
                    const ms = MATCHES.filter(m => m.round === round && m.group === group)
                    if (!ms.length) return null
                    return <div key={group} className="group-block">
                      <div className="group-label">{t.group} {group}</div>
                      {ms.map(match => {
                        const p = current.matches[match.id]
                        const result = adminResults[match.id]
                        const played = result?.isPlayed ?? false
                        const pts = getMatchPts(match.id, p)
                        const breakdown = played ? getBreakdown(match.id, p) : []
                        const tag = getTag(match.id, p, pts)
                        const borderColor = !played ? 'transparent' : pts > 0 ? '#3B6D11' : '#ddd'
                        const predTeamLabel = p?.prediction1X2 === '1' ? match.teamA : p?.prediction1X2 === '2' ? match.teamB : p?.prediction1X2 === 'X' ? (lang === 'he' ? 'תיקו' : 'Draw') : null

                        if (!p) return (
                          <div key={match.id} style={{ border: '1px solid #eee', borderRadius: 8, marginBottom: 6, overflow: 'hidden' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 10px', background: '#f8f8fc' }}>
                              <span style={{ fontSize: 12, color: '#ccc' }}>לא מולא</span>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <span className={`cat-badge cat-${match.category.toLowerCase()}`}>{match.category}</span>
                                <span style={{ fontSize: 12, color: '#888' }}>
                                  <Flag emoji={FLAGS[match.teamA]??''} size={16} /> {match.teamA} נגד <Flag emoji={FLAGS[match.teamB]??''} size={16} /> {match.teamB}
                                </span>
                                <span className="match-num">#{match.id}</span>
                              </div>
                            </div>
                          </div>
                        )

                        const rA = result?.resultA ?? null, rB = result?.resultB ?? null
                        const p1x2pts = (played && p?.prediction1X2)
                          ? calc1X2Points(p.prediction1X2, rA!, rB!, match.fifaPointsA ?? 1500, match.fifaPointsB ?? 1500, match.category)
                          : 0
                        const pRedPts = (played && p?.redCard && result?.hadRedCard) ? 2 : 0

                        return (
                          <div key={match.id} id={`user-match-${match.id}`} style={{ border: `1px solid ${played ? (pts > 0 ? '#c0e0cc' : '#e8d0d0') : '#e0e0e8'}`, borderRadius: 8, marginBottom: 6, overflow: 'hidden' }}>
                            {/* Header */}
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 10px', background: played ? (pts > 0 ? '#f5fbf2' : '#fdf5f5') : '#f8f8fc' }}>
                              {/* Match info with date */}
                              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                  <span className={`cat-badge cat-${match.category.toLowerCase()}`}>{match.category}</span>
                                  <span style={{ fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 3 }}>{match.teamA}<Flag emoji={FLAGS[match.teamA]??''} size={18}/></span>
                                  <span style={{ fontWeight: 800, fontSize: 14 }}>{p.scoreA ?? '?'}</span>
                                  <span style={{ color: '#aaa' }}>–</span>
                                <span style={{ fontWeight: 800, fontSize: 14 }}>{p.scoreB ?? '?'}</span>
                                <span style={{ fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 3 }}><Flag emoji={FLAGS[match.teamB]??''} size={18}/>{match.teamB}</span>
                                <span className="match-num">#{match.id}</span>
                              </div>
                              {(adminSchedule[match.id] || MATCH_SCHEDULE[match.id]) && (
                                <span style={{ fontSize: 10, color: '#aaa', marginTop: 1 }}>
                                  📅 {adminSchedule[match.id] || MATCH_SCHEDULE[match.id]}
                                </span>
                              )}
                              </div>
                              {/* Pts + prediction badges with color feedback */}
                              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                {played && <PtsBadge pts={pts} played={true} />}
                                {predTeamLabel && (
                                  <span style={{
                                    fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10,
                                    display: 'flex', alignItems: 'center', gap: 3,
                                    ...(played
                                      ? p1x2pts > 0
                                        ? { background: '#d4edda', color: '#1a7a44', border: '1px solid #a8d5b7' }
                                        : { background: '#fdf0f0', color: '#A32D2D', border: '1px solid #f5c2c2' }
                                      : { background: '#1a1a2e', color: '#fff' }
                                    )
                                  }}>
                                    {p.prediction1X2 !== 'X' && <Flag emoji={FLAGS[predTeamLabel]??''} size={13} />}
                                    {predTeamLabel}
                                    {played && <span style={{ fontSize: 10, marginRight: 1 }}>{p1x2pts > 0 ? '✓' : '✗'}</span>}
                                  </span>
                                )}
                                {p.redCard && (
                                  <span style={{
                                    fontSize: 11, padding: '1px 7px', borderRadius: 10, fontWeight: 700,
                                    ...(played
                                      ? pRedPts > 0
                                        ? { background: '#d4edda', color: '#1a7a44', border: '1px solid #a8d5b7' }
                                        : { background: '#fdf0f0', color: '#A32D2D', border: '1px solid #f5c2c2' }
                                      : { background: '#FCEBEB', color: '#A32D2D' }
                                    )
                                  }}>
                                    {played ? (pRedPts > 0 ? '✓' : '✗') : ''} 🟥
                                  </span>
                                )}
                              </div>
                            </div>

                            {/* בפועל + breakdown */}
                            {played && (() => {
                              const rAv = rA ?? 0, rBv = rB ?? 0
                              const pA = Number(p.scoreA ?? 0), pB = Number(p.scoreB ?? 0)
                              const isExact = pA === rAv && pB === rBv
                              const isDiff  = !isExact && (pA - pB) === (rAv - rBv)
                              const ouOf    = (t: number) => t <= 1 ? 'אנדר' : t >= 4 ? 'אובר' : null
                              const predOU  = ouOf(pA + pB), actOU = ouOf(rAv + rBv)
                              const ouBonus = predOU && predOU === actOU ? 1 : 0
                              return (<>
                                {/* בפועל — same 5-child approach */}
                                <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 10px', fontSize: 12, color: '#555', background: '#fff', borderTop: '1px solid #eee' }}>
                                  <span style={{ color: '#aaa', fontSize: 11 }}>בפועל:</span>
                                  <span style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 3 }}>{match.teamA}<Flag emoji={FLAGS[match.teamA]??''} size={14}/></span>
                                  <span style={{ fontWeight: 700 }}>{rAv}</span>
                                  <span style={{ color: '#aaa' }}>:</span>
                                  <span style={{ fontWeight: 700 }}>{rBv}</span>
                                  <span style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 3 }}><Flag emoji={FLAGS[match.teamB]??''} size={14}/>{match.teamB}</span>
                                  {result.hadRedCard && <span>🟥</span>}
                                </div>
                                {/* Breakdown — identical to knockout */}
                                <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', borderTop: '1px solid #eee', fontSize: 11, flexWrap: 'wrap', background: '#fff' }}>
                                  <span style={{ color: p1x2pts>0?'#1a7a44':'#cc3333', fontWeight: 600 }}>{p1x2pts>0?'✓':'✗'} 1X2{p1x2pts>0?` +${p1x2pts}`:''}</span>
                                  <span style={{ color: '#ddd' }}>|</span>
                                  <span style={{ color: (isExact||isDiff)?'#1a7a44':'#cc3333', fontWeight: 600 }}>
                                    {isExact ? `✓ תוצאה +2` : isDiff ? `✓ הפרש +1` : '✗ תוצאה'}
                                  </span>
                                  {ouBonus > 0 && <><span style={{ color: '#ddd' }}>|</span>
                                    <span style={{ color: '#1a7a44', fontWeight: 600 }}>✓ {predOU} +1</span></>}
                                  {p.redCard && <><span style={{ color: '#ddd' }}>|</span>
                                    <span style={{ color: pRedPts>0?'#A32D2D':'#cc3333', fontWeight: 600 }}>{pRedPts>0?'✓':'✗'} 🟥{pRedPts>0?' +2':''}</span></>}
                                </div>
                              </>)
                            })()}
                          </div>
                        )
                      })}
                    </div>
                  })}
                </div>
              ))}</>)
              })()}

              {/* ── עולות מהבתים ── */}
              {userSubTab === 'groups' && <div style={{ marginTop: 8 }}>
                <div className="groups-grid">
                  {GROUPS.map(group => {
                    const gp = current.groups[group]
                    const actual = actualGroups[group]
                    const hasResult = actual?.[0]
                    const pts = hasResult && gp ? calcGroupPoints(gp.advancing, actual) : 0
                    return (
                      <div key={group} className="group-card" style={hasResult && pts > 0 ? { borderColor: '#1a7a44', borderWidth: 2 } : {}}>
                        <div className="group-card-title" style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span>{t.group} {group}</span>
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
                                {predTeam ? <><Flag emoji={FLAGS[predTeam]??''} size={22} /> {predTeam}</> : <span style={{ color: '#ccc' }}>—</span>}
                              </span>
                              {isExact && '✓✓'}{isCorrectWrongPos && '✓'}{(isWrong && hasResult) && <span style={{ color: '#c00' }}>✗</span>}
                            </div>
                          )
                        })}
                        {hasResult && (
                          <div style={{ marginTop: 8, borderTop: '1px solid rgba(128,128,128,0.15)', paddingTop: 6 }}>
                            <div style={{ fontSize: 11, color: '#888', marginBottom: 3 }}>{t.actual}:</div>
                            {[0,1,2].map(idx => <div key={idx} style={{ fontSize: 12, color: '#555' }}>{idx+1}. <><Flag emoji={FLAGS[actual[idx]]??''} size={22} /> {actual[idx]}</></div>)}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>}

              {/* ── בונוס ── */}
              {userSubTab === 'bonus' && <div style={{ marginTop: 8 }}>
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
                    </div>
                  )
                })}
              </div>}
            </>
          )}

          {/* ── KNOCKOUT section inside user tab ── */}
          {current && userSubTab === 'knockout' && (() => {
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
            const hasKO = KNOCKOUT_MATCHES.some(km => current.knockout?.[km.id]?.prediction1X2)
            if (!hasKO) return <div style={{ color: '#aaa', fontSize: 13, padding: '12px 0' }}>{t.koNoPreds}</div>
            return (
              <div style={{ marginTop: 24 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, paddingTop: 16, borderTop: '2px solid #e8e8e8' }}>
                  <span style={{ fontSize: 15, fontWeight: 700 }}>🏆 נוקאאוט</span>
                  {knockoutScores[current.userId] > 0 && (
                    <span style={{ fontSize: 13, padding: '2px 10px', borderRadius: 10, background: '#EAF3DE', color: '#1a7a44', fontWeight: 700 }}>
                      {knockoutScores[current.userId]} נק׳
                    </span>
                  )}
                </div>
                {/* Sticky jump to current knockout match */}
                {(() => {
                  const fullSched = { ...MATCH_SCHEDULE, ...adminSchedule }
                  const bestId = getBestMatchId(fullSched, mockNow)
                  const isKoMatch = KNOCKOUT_MATCHES.some(km => km.id === bestId)
                  if (!isKoMatch) return null
                  return (
                    <div style={{ position: 'sticky', top: 0, zIndex: 20, display: 'flex', justifyContent: 'center', padding: '4px 0 8px', background: 'var(--color-background-primary,#fff)' }}>
                      <button onClick={() => {
                        document.getElementById(`ko-user-match-${bestId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                      }} style={{ fontSize: 12, fontWeight: 600, padding: '5px 16px', borderRadius: 20, border: '1px solid #1a1a2e', background: '#1a1a2e', color: '#fff', cursor: 'pointer', fontFamily: 'inherit' }}>
                        ↓ {lang === 'he' ? `קפוץ למשחק הנוכחי #${bestId}` : `Jump to current match #${bestId}`}
                      </button>
                    </div>
                  )
                })()}
                {(['R32', 'R16', 'QF', 'SF', '3P', 'F'] as const).map(round => {
                  if (!isRoundVisible(round)) return null
                  const roundMatches = KNOCKOUT_MATCHES.filter(m => m.round === round)
                  const hasAny = roundMatches.some(km => current.knockout?.[km.id]?.prediction1X2)
                  const redRound = round as 'R32' | 'R16' | 'QF'
                  const redPicks: number[] = current.knockoutRedCards?.[redRound] ?? []
                  const maxRed = ({ R32: 3, R16: 2, QF: 1 } as Record<string, number>)[round] ?? 0
                  const hasRedSection = maxRed > 0 && redPicks.length > 0
                  if (!hasAny && !hasRedSection) return null

                  const isRoundOpen = openKoRounds.has(round)
                  const filled = roundMatches.filter(km => current.knockout?.[km.id]?.prediction1X2).length
                  const playedInRound = roundMatches.filter(km => knockoutAdminMatches[km.id]?.isPlayed).length
                  const correctInRound = roundMatches.filter(km => {
                    const pred = current.knockout?.[km.id]
                    if (!pred?.prediction1X2) return false
                    const akm = knockoutAdminMatches[km.id]
                    if (!akm?.isPlayed || akm.resultA == null) return false
                    const act = akm.resultA > akm.resultB ? '1' : akm.resultA < akm.resultB ? '2' : 'X'
                    return pred.prediction1X2 === act
                  }).length

                  return (
                    <div key={round} style={{ marginBottom: 8, borderRadius: 10, border: '1px solid #e8e8f0', overflow: 'hidden' }}>
                      <div onClick={() => toggleKoRound(round)} style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: '8px 12px', cursor: 'pointer', background: '#fafbff',
                        borderBottom: isRoundOpen ? '1px solid #e8e8f0' : 'none',
                      }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: '#1a1a2e' }}>{KNOCKOUT_ROUND_LABELS[round]}</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          {playedInRound > 0 && <span style={{ fontSize: 11, color: '#1a7a44', fontWeight: 600 }}>✓ {correctInRound}/{playedInRound}</span>}
                          {filled > 0 && playedInRound === 0 && <span style={{ fontSize: 11, color: '#888' }}>{filled} ניחושים</span>}
                          {hasRedSection && <span style={{ fontSize: 11 }}>🟥 {redPicks.length}/{maxRed}</span>}
                          <span style={{ fontSize: 11, color: '#bbb', display: 'inline-block', transform: isRoundOpen ? 'rotate(180deg)' : 'none' }}>▼</span>
                        </div>
                      </div>

                      {isRoundOpen && (
                        <div style={{ padding: '8px 12px' }}>
                          {roundMatches.map(km => {
                            const pred = current.knockout?.[km.id]
                            if (!pred?.prediction1X2) return null
                            const tA = getTeam(km.id, 'A')
                            const tB = getTeam(km.id, 'B')
                            const adminKm = knockoutAdminMatches[km.id]
                            const isPlayed = !!(adminKm?.isPlayed && adminKm?.resultA != null)
                            const actualTeamA = adminKm?.teamA ?? tA
                            const actualTeamB = adminKm?.teamB ?? tB
                            const ptA = actualTeamA ? (TEAM_FIFA_POINTS[actualTeamA] ?? 1500) : 1500
                            const ptB = actualTeamB ? (TEAM_FIFA_POINTS[actualTeamB] ?? 1500) : 1500
                            const cat = calcCategoryByRound(ptA, ptB, km.round) as any
                            const rA = isPlayed ? Number(adminKm!.resultA) : null
                            const rB = isPlayed ? Number(adminKm!.resultB) : null
                            const actual1x2 = rA != null ? (rA > rB! ? '1' : rA < rB! ? '2' : 'X') : null
                            const correct1x2 = !!(actual1x2 && pred.prediction1X2 === actual1x2)
                            const correctAdvance = !!(isPlayed && adminKm?.advanceTeam && pred.advance === adminKm.advanceTeam)
                            const p1x2 = isPlayed ? calc1X2KnockoutPoints(pred.prediction1X2, rA!, rB!, ptA, ptB, cat, km.round) : 0
                            const pScore = (isPlayed && pred.scoreA != null)
                                    ? calcScoreKnockoutPoints(Number(pred.scoreA), Number(pred.scoreB ?? 0), rA!, rB!, cat, km.round)
                                      + calcOUPoints(Number(pred.scoreA), Number(pred.scoreB ?? 0), rA!, rB!, cat, km.round)
                                    : 0
                            const pAdv = (isPlayed && pred.advance && adminKm?.advanceTeam) ? calcAdvancePoints(pred.advance, adminKm.advanceTeam, km.round, cat, ptA, ptB, actualTeamA ?? '', actualTeamB ?? '') : 0
                            // Knockout red card — stored as array of match IDs per round
                            const redRoundKey = km.round as 'R32' | 'R16' | 'QF'
                            const pickedRedCard = ['R32','R16','QF'].includes(km.round) &&
                              (current.knockoutRedCards?.[redRoundKey] ?? []).includes(km.id)
                            const pRed = isPlayed && pickedRedCard && adminKm?.hadRedCard ? 2 : 0
                            const total = p1x2 + pScore + pAdv + pRed
                            const pred1x2Label = pred.prediction1X2 === '1' ? (actualTeamA ?? '1') : pred.prediction1X2 === '2' ? (actualTeamB ?? '2') : 'תיקו'
                            const pred1x2Flag = pred.prediction1X2 === '1' ? (FLAGS[actualTeamA ?? ''] ?? '') : pred.prediction1X2 === '2' ? (FLAGS[actualTeamB ?? ''] ?? '') : null
                            return (
                              <div key={km.id} id={`ko-user-match-${km.id}`} style={{ border: `1px solid ${isPlayed ? (total > 0 ? '#c0e0cc' : '#e8d0d0') : '#e0e0e8'}`, borderRadius: 8, marginBottom: 6, overflow: 'hidden' }}>
                                <div style={{ display: 'flex', alignItems: 'center', padding: '6px 8px', gap: 6, flexWrap: 'wrap', background: '#fafbff' }}>
                                  <span style={{ fontSize: 10, color: '#bbb' }}>#{km.id}</span>
                                  <span className={`cat-badge cat-${cat?.toLowerCase?.() ?? 'a'}`}>{cat}</span>
                                  <span style={{ fontWeight: 600, fontSize: 12 }}>{actualTeamA ? <><Flag emoji={FLAGS[actualTeamA]??''} size={18} /> {actualTeamA}{fifaRankMap[actualTeamA] ? <span style={{ fontSize: 10, color: '#aaa', marginRight: 2 }}>#{fifaRankMap[actualTeamA]}</span> : ''}</> : '?'}</span>
                                  <span style={{ fontSize: 12, fontWeight: 700, color: '#555' }}>{pred.scoreA ?? '?'}–{pred.scoreB ?? '?'}</span>
                                  <span style={{ fontWeight: 600, fontSize: 12 }}>{actualTeamB ? <>{actualTeamB}{fifaRankMap[actualTeamB] ? <span style={{ fontSize: 10, color: '#aaa', marginLeft: 2 }}>#{fifaRankMap[actualTeamB]}</span> : ''} <Flag emoji={FLAGS[actualTeamB]??''} size={18} /></> : '?'}</span>
                                  <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, marginRight: 'auto', background: correct1x2 ? '#EAF3DE' : isPlayed ? '#FCEBEB' : '#f0f0f0', color: correct1x2 ? '#1a7a44' : isPlayed ? '#A32D2D' : '#666', fontWeight: 600 }}>
                                    {pred1x2Flag && <Flag emoji={pred1x2Flag} size={14} />} {pred1x2Label}
                                  </span>
                                  {adminSchedule[km.id] && <span style={{ fontSize: 10, color: '#aaa' }}>📅 {adminSchedule[km.id]}</span>}
                                  {isPlayed && <span style={{ fontSize: 12, fontWeight: 700, color: total > 0 ? '#1a7a44' : '#999', background: total > 0 ? '#EAF3DE' : '#f5f5f5', padding: '1px 6px', borderRadius: 8 }}>{total > 0 ? `+${total}` : '0'} נק׳</span>}
                                </div>
                                {isPlayed && rA != null && (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 8px', background: '#f2f2f2', borderTop: '1px solid #eee', fontSize: 11 }}>
                                    <span style={{ color: '#888', fontWeight: 600 }}>בפועל:</span>
                                    <span style={{ fontWeight: 600, color: adminKm?.advanceTeam === actualTeamA ? '#1a5c30' : '#333', display: 'flex', alignItems: 'center', gap: 3 }}><Flag emoji={FLAGS[actualTeamA??'']??''} size={16}/>{actualTeamA}</span>
                                    <span style={{ fontWeight: 800 }}>{lang === 'he' ? `${rB}:${rA}` : `${rA}:${rB}`}</span>
                                    <span style={{ fontWeight: 600, color: adminKm?.advanceTeam === actualTeamB ? '#1a5c30' : '#333', display: 'flex', alignItems: 'center', gap: 3 }}>{actualTeamB}<Flag emoji={FLAGS[actualTeamB??'']??''} size={16}/></span>
                                    {adminKm?.advanceTeam && <span style={{ color: '#1a5c30', fontWeight: 700, marginRight: 'auto', display: 'flex', alignItems: 'center', gap: 2 }}>→ <Flag emoji={FLAGS[adminKm.advanceTeam]??''} size={16}/>{adminKm.advanceTeam}</span>}
                                  </div>
                                )}
                                {isPlayed && (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', borderTop: '1px solid #eee', fontSize: 11, flexWrap: 'wrap', background: '#fff' }}>
                                    <span style={{ color: p1x2>0?'#1a7a44':'#cc3333', fontWeight: 600 }}>{p1x2>0?'✓':'✗'} 1X2{p1x2>0?` +${p1x2}`:''}</span>
                                    <span style={{ color: '#ddd' }}>|</span>
                                    {(() => {
                                      // Separate score vs OU for clear display
                                      const pA = Number(pred.scoreA), pB = Number(pred.scoreB ?? 0)
                                      const isExact = pA === rA && pB === rB
                                      const isDiff = !isExact && (pA - pB) === (rA! - rB!)
                                      const ouType = (t: number) => t <= 1 ? 'אנדר' : t >= 4 ? 'אובר' : null
                                      const predOuType = pred.scoreA != null ? ouType(pA + pB) : null
                                      const actOuType  = ouType((rA ?? 0) + (rB ?? 0))
                                      const ouBonus = predOuType && predOuType === actOuType
                                        ? ({ R32: 1, R16: 1, QF: 2, SF: 2, '3P': 1, F: 2 } as Record<string,number>)[km.round] : 0
                                      return <>
                                        <span style={{ color: (isExact||isDiff)?'#1a7a44':'#cc3333', fontWeight: 600 }}>
                                          {isExact ? `✓ תוצאה +2` : isDiff ? `✓ הפרש +1` : '✗ תוצאה'}
                                        </span>
                                        {ouBonus > 0 && <><span style={{ color: '#ddd' }}>|</span>
                                          <span style={{ color: '#1a7a44', fontWeight: 600 }}>✓ {predOuType} +{ouBonus}</span></>}
                                      </>
                                    })()}
                                    {pred.advance && <><span style={{ color: '#ddd' }}>|</span><span style={{ display:'flex', alignItems:'center', gap:2, color: pAdv>0?'#1a7a44':'#cc3333', fontWeight:600 }}>{pAdv>0?'✓':'✗'} עולה:<Flag emoji={FLAGS[pred.advance]??''} size={13}/>{pAdv>0?` +${pAdv}`:''}{!correctAdvance && adminKm?.advanceTeam && <span style={{color:'#aaa',fontWeight:400}}> (עלה: {adminKm.advanceTeam})</span>}</span></>}
                                    {pickedRedCard && isPlayed && <><span style={{ color: '#ddd' }}>|</span>
                                      <span style={{ color: pRed>0?'#A32D2D':'#cc3333', fontWeight:600 }}>{pRed>0?'✓':'✗'} 🟥{pRed>0?` +${pRed}`:''}</span></>}
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })()}
        </>
      )}

      {/* ══════════════════════════════════════════
          TAB 2: לפי משחק
      ══════════════════════════════════════════ */}
      {mainTab === 'match' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
            <label style={{ fontSize: 13, color: '#666' }}>{t.selectMatch}</label>
            <select value={selectedMatchId} onChange={e => setSelectedMatchId(Number(e.target.value))}
              style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid #ddd', fontSize: 13, fontFamily: 'inherit', flex: 1 }}>
              <optgroup label={t.matchesGroupStage}>
                {MATCHES.map(m => (
                  <option key={m.id} value={m.id}>
                    #{m.id} {m.teamA} נגד {m.teamB} ({m.category}) {MATCH_SCHEDULE[m.id] ? `— ${MATCH_SCHEDULE[m.id]}` : ''}
                    {adminResults[m.id]?.isPlayed ? ' ✓' : ''}
                  </option>
                ))}
              </optgroup>
              {(['R32','R16','QF','SF','3P','F'] as const).map(round => {
                  if (!isRoundVisible(round)) return null
                const roundMatches = KNOCKOUT_MATCHES.filter(km => km.round === round)
                const hasAny = roundMatches.some(km => knockoutAdminMatches[km.id]?.teamA || adminSchedule[km.id])
                if (!hasAny) return null
                return (
                  <optgroup key={round} label={KNOCKOUT_ROUND_LABELS[round]}>
                    {roundMatches.map(km => {
                      const actual = knockoutAdminMatches[km.id]
                      const tA = actual?.teamA ?? '?'
                      const tB = actual?.teamB ?? '?'
                      const sched = adminSchedule[km.id] ? ` — ${adminSchedule[km.id]}` : ''
                      return (
                        <option key={km.id} value={km.id}>
                          #{km.id} {tA} נגד {tB}{sched}{actual?.isPlayed ? ' ✓' : ''}
                        </option>
                      )
                    })}
                  </optgroup>
                )
              })}
            </select>
          </div>
          {(() => {
            const isKO = selectedMatchId > 72
            if (isKO) {
              const km = KNOCKOUT_MATCHES.find(m => m.id === selectedMatchId)
              const actual = knockoutAdminMatches[selectedMatchId]
              const tA = actual?.teamA ?? km?.teamA ?? '?'
              const tB = actual?.teamB ?? km?.teamB ?? '?'
              const played = actual?.isPlayed ?? false
              const hasRed = km && ['R32','R16','QF'].includes(km.round)

              // Rank map from scores
              const koRankMap: Record<string, number> = {}
              ;[...users].sort((a, b) => (scores[b.userId] ?? 0) - (scores[a.userId] ?? 0))
                .forEach((u, i) => { koRankMap[u.userId] = i + 1 })

              return (
                <>
                  <div className="match-row-view">
                    {/* Header — same style as group stage */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12, padding: '2px 7px', borderRadius: 10, background: '#E6F1FB', color: '#0C447C', fontWeight: 700 }}>{km?.round}</span>
                      <span style={{ fontSize: 15, fontWeight: 600 }}>
                        <Flag emoji={FLAGS[tA]??''} size={20}/> {tA} {lang==='he'?'נגד':'vs'} {tB} <Flag emoji={FLAGS[tB]??''} size={20}/>
                      </span>
                      {adminSchedule[selectedMatchId] && (
                        <span style={{ fontSize: 12, color: '#888' }}>📅 {adminSchedule[selectedMatchId]}</span>
                      )}
                      {played && (
                        <span style={{ marginRight: 'auto', fontSize: 13, border: '1px solid rgba(128,128,128,0.25)', padding: '4px 10px', borderRadius: 8, fontWeight: 600 }}>
                          בפועל: <Flag emoji={FLAGS[tA]??''} size={14}/> {tA} {actual.resultA}–{actual.resultB} <Flag emoji={FLAGS[tB]??''} size={14}/> {tB}
                          {actual.advanceTeam && <> → <Flag emoji={FLAGS[actual.advanceTeam]??''} size={14}/> {actual.advanceTeam}</>}
                          {actual.hadRedCard && ' 🟥'}
                        </span>
                      )}
                    </div>

                    {/* Table — columns: name | 1X2 | תוצאה | א/ע | עולה | [🟥] | pts */}
                    <div style={{ borderTop: '1px solid rgba(128,128,128,0.15)', paddingTop: 8 }}>
                      {/* Grid header — desktop only */}
                      {!isMobile && (
                        <div style={{
                          display: 'grid',
                          gridTemplateColumns: `1fr 80px 100px 46px 80px${hasRed ? ' 36px' : ''}${played ? ' 54px' : ''}`,
                          alignItems: 'center', gap: '0 6px',
                          marginBottom: 6, fontSize: 11, color: '#aaa', fontWeight: 600, padding: '0 4px',
                        }}>
                          <span>{lang==='he'?'משתמש':'User'}</span>
                          <span style={{ textAlign: 'center' }}>1X2</span>
                          <span style={{ textAlign: 'center' }}>{lang==='he'?'תוצאה':'Score'}</span>
                          <span style={{ textAlign: 'center' }}>א/ע</span>
                          <span style={{ textAlign: 'center' }}>{t.koAdvance}</span>
                          {hasRed && <span style={{ textAlign: 'center' }}>🟥</span>}
                          {played && <span style={{ textAlign: 'center' }}>נק׳</span>}
                        </div>
                      )}

                      {users.map(u => {
                        const p = u.knockout?.[selectedMatchId]
                        const rA = actual?.resultA ?? null
                        const rB = actual?.resultB ?? null
                        const pA = p?.scoreA != null ? Number(p.scoreA) : null
                        const pB = p?.scoreB != null ? Number(p.scoreB) : null

                        // 1X2
                        const label1x2 = p?.prediction1X2 === '1' ? tA : p?.prediction1X2 === '2' ? tB : p?.prediction1X2 === 'X' ? 'תיקו' : '—'
                        const actual1x2 = rA != null ? (rA > rB! ? '1' : rA < rB! ? '2' : 'X') : null
                        const correct1x2 = played && p?.prediction1X2 && actual1x2 ? p.prediction1X2 === actual1x2 : null

                        // Score color
                        const isExact = played && pA != null && rA != null && pA === rA && pB === rB
                        const isDiff  = played && !isExact && pA != null && rA != null && (pA - pB!) === (rA - rB!)
                        const scoreBg = !played || pA == null ? 'transparent' : isExact ? '#d4edda' : isDiff ? '#fff3cd' : '#fdf0f0'
                        const scoreColor = !played || pA == null ? 'inherit' : isExact ? '#1a7a44' : isDiff ? '#856404' : '#A32D2D'

                        // OU
                        const cat = km ? calcCategoryByRound(TEAM_FIFA_POINTS[tA]??1500, TEAM_FIFA_POINTS[tB]??1500, km.round) : 'C'
                        const ouOf = (s: number) => s <= 1 ? 'אנדר' : s >= 4 ? 'אובר' : null
                        const predOU = pA != null ? ouOf(pA + pB!) : null
                        const actOU = (played && rA != null) ? ouOf(rA + rB!) : null
                        const ouHit = played && predOU === actOU && predOU != null

                        // Advance
                        const correctAdv = played && p?.advance && p.advance === actual?.advanceTeam

                        // Red card
                        const redKey = km?.round as 'R32'|'R16'|'QF'
                        const userReds = (u.knockoutRedCards?.[redKey] ?? []) as number[]
                        const userPredRed = hasRed && userReds.includes(km!.id)
                        const redCorrect = userPredRed && actual?.hadRedCard
                        const redBg = !played ? 'transparent' : redCorrect ? '#d4edda' : userPredRed ? '#fdf0f0' : 'transparent'

                        // Pts
                        const ptA = TEAM_FIFA_POINTS[tA] ?? 1500
                        const ptB = TEAM_FIFA_POINTS[tB] ?? 1500
                        const pts = played && p ? (() => {
                          const p1x2 = p.prediction1X2 ? calc1X2KnockoutPoints(p.prediction1X2, Number(rA), Number(rB), ptA, ptB, cat as any, km!.round) : 0
                          const pSc = pA != null ? calcScoreKnockoutPoints(pA, pB??0, Number(rA), Number(rB), cat as any, km!.round) + calcOUPoints(pA, pB??0, Number(rA), Number(rB), cat as any, km!.round) : 0
                          const pAdv = p.advance ? calcAdvancePoints(p.advance, actual.advanceTeam, km!.round, cat as any, ptA, ptB, tA, tB) : 0
                          const pRed = redCorrect ? 2 : 0
                          return p1x2 + pSc + pAdv + pRed
                        })() : 0

                        const rank = koRankMap[u.userId]

                        return (
                          <div key={u.userId} style={{
                            padding: '5px 4px', borderBottom: '1px solid rgba(128,128,128,0.15)',
                            background: u.userId === user?.uid ? 'rgba(26,122,68,0.12)' : 'transparent',
                          }}>
                            {isMobile ? (
                              /* ── Mobile: 2 rows ── */
                              <>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 }}>
                                  <span style={{ fontSize: 13, fontWeight: u.userId===user?.uid ? 700 : 400, display: 'flex', alignItems: 'center', gap: 5 }}>
                                    {koRankMap[u.userId] && <span style={{ fontSize: 11, fontWeight: 600, minWidth: 20,
                                      color: koRankMap[u.userId]===1?'#B8860B':koRankMap[u.userId]===2?'#888':koRankMap[u.userId]===3?'#CD7F32':'#999' }}>
                                      {koRankMap[u.userId]<=3?['🥇','🥈','🥉'][koRankMap[u.userId]-1]:`#${koRankMap[u.userId]}`}
                                    </span>}
                                    {adminDisplayName(u)}{u.userId===user?.uid ? ` ${t.itsMe}` : ''}
                                  </span>
                                  {played && <PtsBadge pts={pts} played={true} />}
                                </div>
                                {p ? (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                                    <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 10,
                                      background: correct1x2===true?'#EAF3DE':correct1x2===false?'#FCEBEB':'#f0f0f0',
                                      color: correct1x2===true?'#1a7a44':correct1x2===false?'#A32D2D':'#333' }}>{label1x2}</span>
                                    <span style={{ borderRadius: 6, padding: '2px 5px', background: scoreBg, color: scoreColor,
                                      display: 'flex', alignItems: 'center', gap: 2, fontSize: 12, fontWeight: 700 }}>
                                      <Flag emoji={FLAGS[tA]??''} size={13}/><span>{pA??'?'}</span>
                                      <span style={{ color:'#aaa',fontWeight:400 }}>:</span>
                                      <span>{pB??'?'}</span><Flag emoji={FLAGS[tB]??''} size={13}/>
                                    </span>
                                    {predOU && <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 5px', borderRadius: 8,
                                      background: ouHit?'#EAF3DE':played?'#fdf0f0':'#f0f0f5',
                                      color: ouHit?'#1a7a44':played?'#A32D2D':'#666' }}>
                                      {played?(ouHit?'✓ ':'✗ '):''}{predOU}
                                    </span>}
                                    {p.advance && <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 5px', borderRadius: 10,
                                      background: correctAdv?'#EAF3DE':played?'#FCEBEB':'#f0f0fb',
                                      color: correctAdv?'#1a7a44':played?'#A32D2D':'#333',
                                      display:'flex',alignItems:'center',gap:2 }}>
                                      <Flag emoji={FLAGS[p.advance]??''} size={13}/>
                                      <span style={{maxWidth:55,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{p.advance}</span>
                                    </span>}
                                    {hasRed && userPredRed && <span style={{ borderRadius: 6, padding: '2px 4px', background: redBg }}>
                                      {!played?<span>🟥</span>:actual?.hadRedCard
                                        ?<span style={{color:'#1a7a44',fontSize:11,fontWeight:700}}>✓ 🟥</span>
                                        :<span style={{color:'#A32D2D',fontSize:11,fontWeight:700}}>✗ 🟥</span>}
                                    </span>}
                                  </div>
                                ) : <span style={{ fontSize: 11, color: '#ccc' }}>לא מולא</span>}
                              </>
                            ) : (
                              /* ── Desktop: grid ── */
                              <div style={{
                                display: 'grid',
                                gridTemplateColumns: `1fr 80px 100px 46px 80px${hasRed ? ' 36px' : ''}${played ? ' 54px' : ''}`,
                                alignItems: 'center', gap: '0 6px',
                              }}>
                                <span style={{ fontSize: 13, fontWeight: u.userId===user?.uid ? 700 : 400, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', display:'flex', alignItems:'center', gap: 5 }}>
                                  {koRankMap[u.userId] && <span style={{ fontSize: 11, fontWeight: 600, minWidth: 20,
                                    color: koRankMap[u.userId]===1?'#B8860B':koRankMap[u.userId]===2?'#888':koRankMap[u.userId]===3?'#CD7F32':'#999' }}>
                                    {koRankMap[u.userId]<=3?['🥇','🥈','🥉'][koRankMap[u.userId]-1]:`#${koRankMap[u.userId]}`}
                                  </span>}
                                  {adminDisplayName(u)}{u.userId===user?.uid ? ` ${t.itsMe}` : ''}
                                </span>
                                {p ? <>
                                  <span style={{ textAlign: 'center' }}>
                                    <span style={{ fontSize: 11, fontWeight: 600, padding: '4px 8px', borderRadius: 10,
                                      background: correct1x2===true?'#EAF3DE':correct1x2===false?'#FCEBEB':'#f0f0f0',
                                      color: correct1x2===true?'#1a7a44':correct1x2===false?'#A32D2D':'#333' }}>{label1x2}</span>
                                  </span>
                                  <span style={{ textAlign:'center', borderRadius: 6, padding: '2px 4px', background: scoreBg, color: scoreColor,
                                    display:'flex', alignItems:'center', justifyContent:'center', gap: 2, fontSize: 12, fontWeight: 700 }}>
                                    <Flag emoji={FLAGS[tA]??''} size={13}/><span>{pA??'?'}</span>
                                    <span style={{color:'#aaa',fontWeight:400}}>:</span>
                                    <span>{pB??'?'}</span><Flag emoji={FLAGS[tB]??''} size={13}/>
                                  </span>
                                  <span style={{ textAlign: 'center' }}>
                                    {predOU ? <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 5px', borderRadius: 8,
                                      background: ouHit?'#EAF3DE':played?'#fdf0f0':'#f0f0f5',
                                      color: ouHit?'#1a7a44':played?'#A32D2D':'#666' }}>
                                      {played?(ouHit?'✓ ':'✗ '):''}{predOU}
                                    </span> : <span style={{color:'#ccc',fontSize:12}}>—</span>}
                                  </span>
                                  <span style={{ textAlign: 'center', overflow: 'hidden' }}>
                                    {p.advance ? <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 4px', borderRadius: 10,
                                      background: correctAdv?'#EAF3DE':played?'#FCEBEB':'#f0f0fb',
                                      color: correctAdv?'#1a7a44':played?'#A32D2D':'#333',
                                      display:'flex', alignItems:'center', gap: 2, justifyContent:'center', whiteSpace:'nowrap', overflow:'hidden' }}>
                                      <Flag emoji={FLAGS[p.advance]??''} size={13}/>
                                      <span style={{overflow:'hidden',textOverflow:'ellipsis',maxWidth:55}}>{p.advance}</span>
                                    </span> : <span style={{color:'#ccc',fontSize:12}}>—</span>}
                                  </span>
                                  {hasRed && <span style={{ textAlign:'center', borderRadius:6, padding:'2px 2px', background:redBg }}>
                                    {!userPredRed?<span style={{color:'#ccc',fontSize:12}}>—</span>
                                      :!played?<span>🟥</span>
                                      :actual?.hadRedCard?<span style={{color:'#1a7a44',fontSize:11,fontWeight:700}}>✓ 🟥</span>
                                      :<span style={{color:'#A32D2D',fontSize:11,fontWeight:700}}>✗ 🟥</span>}
                                  </span>}
                                </> : (
                                  <span style={{fontSize:12,color:'#ccc',gridColumn:`span ${4+(hasRed?1:0)}`,textAlign:'center'}}>לא מולא</span>
                                )}
                                {played && <PtsBadge pts={pts} played={true} />}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>

                  {/* Distribution stats — below the table */}
                  <ScoreKnockoutTable matchId={selectedMatchId} users={users} teamA={tA} teamB={tB} adminResult={actual} lang={lang} />
                </>
              )
            }
            const match = MATCHES.find(m => m.id === selectedMatchId)
            if (!match) return null
            const result = adminResults[selectedMatchId]
            const played = result?.isPlayed ?? false
            // Rank map: sort users by total score
            const rankMap: Record<string, number> = {}
            ;[...users].sort((a, b) => (scores[b.userId] ?? 0) - (scores[a.userId] ?? 0))
              .forEach((u, i) => { rankMap[u.userId] = i + 1 })
            return (
              <>
                <div className="match-row-view">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <span className={`cat-badge cat-${match.category.toLowerCase()}`}>{match.category}</span>
                    <span style={{ fontSize: 15, fontWeight: 600 }}><><Flag emoji={FLAGS[match.teamA]??''} size={22} /> {match.teamA}</> נגד <Flag emoji={FLAGS[match.teamB]??''} size={22} /> {match.teamB}</span>
                    <span style={{ fontSize: 12, color: '#888' }}>{MATCH_SCHEDULE[match.id]}</span>
                    {played && <span style={{ marginRight: 'auto', fontSize: 13, border: '1px solid rgba(128,128,128,0.25)', padding: '4px 10px', borderRadius: 8, fontWeight: 600 }}>
                      בפועל: {match.teamA} {result.resultA??0}–{result.resultB??0} {match.teamB}{result.hadRedCard?' 🟥':''}
                    </span>}
                  </div>
                  <div style={{ borderTop: '1px solid rgba(128,128,128,0.15)', paddingTop: 8 }}>
                    {/* Grid header — desktop only */}
                    {!isMobile && (
                      <div style={{
                        display: 'grid',
                        gridTemplateColumns: `1fr 80px 100px 46px 36px${played ? ' 54px' : ''}`,
                        alignItems: 'center', gap: '0 6px',
                        marginBottom: 6, fontSize: 11, color: '#aaa', fontWeight: 600,
                        padding: '0 4px',
                      }}>
                        <span>{lang === 'he' ? 'משתמש' : 'User'}</span>
                        <span style={{ textAlign: 'center' }}>1X2</span>
                        <span style={{ textAlign: 'center' }}>{lang === 'he' ? 'תוצאה' : 'Score'}</span>
                        <span style={{ textAlign: 'center' }}>א/ע</span>
                        <span style={{ textAlign: 'center' }}>🟥</span>
                        {played && <span style={{ textAlign: 'center' }}>נק׳</span>}
                      </div>
                    )}
                    {users.map(u => {
                      const p = u.matches[selectedMatchId]
                      const pts = played ? getMatchPts(selectedMatchId, p) : 0

                      // Score result analysis
                      const pA = p ? Number(p.scoreA ?? 0) : null
                      const pB = p ? Number(p.scoreB ?? 0) : null
                      const rA = result?.resultA ?? null
                      const rB = result?.resultB ?? null
                      const isExact = played && pA != null && rA != null && pA === rA && pB === rB
                      const isDiff  = played && !isExact && pA != null && rA != null && (pA - pB!) === (rA - rB!)
                      const scoreBg = !played || !p || pA == null ? 'transparent'
                        : isExact ? '#d4edda' : isDiff ? '#fff3cd' : '#fdf0f0'
                      const scoreColor = !played || !p || pA == null ? '#333'
                        : isExact ? '#1a7a44' : isDiff ? '#856404' : '#A32D2D'

                      // 1X2 analysis
                      const actual1x2 = played && rA != null ? (rA > rB! ? '1' : rA < rB! ? '2' : 'X') : null
                      const correct1x2 = played && p?.prediction1X2 && actual1x2 ? p.prediction1X2 === actual1x2 : null
                      const label1x2 = p?.prediction1X2 === '1' ? match.teamA : p?.prediction1X2 === '2' ? match.teamB : p?.prediction1X2 === 'X' ? 'תיקו' : '—'

                      // Red card
                      const redBg = !played ? 'transparent'
                        : p?.redCard && result?.hadRedCard ? '#d4edda'
                        : p?.redCard && !result?.hadRedCard ? '#fdf0f0'
                        : 'transparent'
                      const redContent = !p?.redCard ? <span style={{ color: '#ccc', fontSize: 12 }}>—</span>
                        : !played ? <span>🟥</span>
                        : result?.hadRedCard
                          ? <span style={{ color: '#1a7a44', fontSize: 11, fontWeight: 700 }}>✓ 🟥</span>
                          : <span style={{ color: '#A32D2D', fontSize: 11, fontWeight: 700 }}>✗ 🟥</span>

                      const ouOf = (s: number) => s <= 1 ? 'אנדר' : s >= 4 ? 'אובר' : null
                      const predOU = pA != null ? ouOf(pA + (pB ?? 0)) : null
                      const actOU  = (played && rA != null) ? ouOf(rA + (rB ?? 0)) : null
                      const ouHit  = !!(predOU && predOU === actOU)

                      return (
                        <div key={u.userId} style={{
                          background: u.userId === user?.uid ? 'rgba(26,122,68,0.12)' : 'transparent',
                        }}>
                          {isMobile ? (
                            /* ── Mobile: 2 rows ── */
                            <>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                                <span style={{ fontSize: 13, fontWeight: u.userId === user?.uid ? 700 : 400, display: 'flex', alignItems: 'center', gap: 5 }}>
                                  {rankMap[u.userId] != null && (
                                    <span style={{ fontSize: 11, fontWeight: 600, minWidth: 20, color:
                                      rankMap[u.userId] === 1 ? '#B8860B' : rankMap[u.userId] === 2 ? '#888' : rankMap[u.userId] === 3 ? '#CD7F32' : '#999' }}>
                                      {rankMap[u.userId] <= 3 ? ['🥇','🥈','🥉'][rankMap[u.userId]-1] : `#${rankMap[u.userId]}`}
                                    </span>
                                  )}
                                  {adminDisplayName(u)}{u.userId === user?.uid ? ` ${t.itsMe}` : ''}
                                </span>
                                {played && <PtsBadge pts={pts} played={true} />}
                              </div>
                              {p ? (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                  <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 10,
                                    background: correct1x2 === true ? '#EAF3DE' : correct1x2 === false ? '#FCEBEB' : '#f0f0f0',
                                    color: correct1x2 === true ? '#1a7a44' : correct1x2 === false ? '#A32D2D' : '#333' }}>
                                    {label1x2}
                                  </span>
                                  <span style={{ borderRadius: 6, padding: '2px 6px', background: scoreBg, color: scoreColor,
                                    display: 'flex', alignItems: 'center', gap: 2, fontSize: 12, fontWeight: 700 }}>
                                    <Flag emoji={FLAGS[match.teamA]??''} size={13}/>
                                    <span>{pA ?? '?'}</span>
                                    <span style={{ color: '#aaa', fontWeight: 400 }}>:</span>
                                    <span>{pB ?? '?'}</span>
                                    <Flag emoji={FLAGS[match.teamB]??''} size={13}/>
                                  </span>
                                  {predOU && (
                                    <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 5px', borderRadius: 8,
                                      background: ouHit ? '#EAF3DE' : played ? '#fdf0f0' : '#f0f0f5',
                                      color: ouHit ? '#1a7a44' : played ? '#A32D2D' : '#666' }}>
                                      {played ? (ouHit ? '✓ ' : '✗ ') : ''}{predOU}
                                    </span>
                                  )}
                                  {p.redCard && (
                                    <span style={{ borderRadius: 6, padding: '2px 4px', background: redBg }}>{redContent}</span>
                                  )}
                                </div>
                              ) : (
                                <span style={{ fontSize: 11, color: '#ccc' }}>לא מולא</span>
                              )}
                            </>
                          ) : (
                            /* ── Desktop: grid ── */
                            <div style={{
                              display: 'grid',
                              gridTemplateColumns: `1fr 80px 100px 46px 36px${played ? ' 54px' : ''}`,
                              alignItems: 'center', gap: '0 6px',
                            }}>
                              <span style={{ fontSize: 13, fontWeight: u.userId === user?.uid ? 700 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 5 }}>
                                {rankMap[u.userId] != null && (
                                  <span style={{ fontSize: 11, fontWeight: 600, minWidth: 20, color:
                                    rankMap[u.userId] === 1 ? '#B8860B' : rankMap[u.userId] === 2 ? '#888' : rankMap[u.userId] === 3 ? '#CD7F32' : '#999' }}>
                                    {rankMap[u.userId] <= 3 ? ['🥇','🥈','🥉'][rankMap[u.userId]-1] : `#${rankMap[u.userId]}`}
                                  </span>
                                )}
                                {adminDisplayName(u)}{u.userId === user?.uid ? ` ${t.itsMe}` : ''}
                              </span>
                              {p ? <>
                                <span style={{ textAlign: 'center' }}>
                                  <span style={{ fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 10,
                                    background: correct1x2 === true ? '#EAF3DE' : correct1x2 === false ? '#FCEBEB' : '#f0f0f0',
                                    color: correct1x2 === true ? '#1a7a44' : correct1x2 === false ? '#A32D2D' : '#333' }}>
                                    {label1x2}
                                  </span>
                                </span>
                                <span style={{ textAlign: 'center', borderRadius: 6, padding: '2px 4px', background: scoreBg, color: scoreColor,
                                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2, fontSize: 12, fontWeight: 700 }}>
                                  <Flag emoji={FLAGS[match.teamA]??''} size={13}/>
                                  <span>{pA ?? '?'}</span>
                                  <span style={{ color: '#aaa', fontWeight: 400 }}>:</span>
                                  <span>{pB ?? '?'}</span>
                                  <Flag emoji={FLAGS[match.teamB]??''} size={13}/>
                                </span>
                                {(() => {
                                  if (!predOU) return <span style={{ textAlign: 'center', fontSize: 11, color: '#ccc' }}>—</span>
                                  return (
                                    <span style={{ textAlign: 'center' }}>
                                      <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 5px', borderRadius: 8,
                                        background: ouHit ? '#EAF3DE' : played ? '#fdf0f0' : '#f0f0f5',
                                        color: ouHit ? '#1a7a44' : played ? '#A32D2D' : '#666' }}>
                                        {played ? (ouHit ? '✓ ' : '✗ ') : ''}{predOU}
                                      </span>
                                    </span>
                                  )
                                })()}
                                <span style={{ textAlign: 'center', borderRadius: 6, padding: '2px 2px', background: redBg }}>{redContent}</span>
                              </> : <>
                                <span style={{ fontSize: 12, color: '#ccc', gridColumn: 'span 4', textAlign: 'center' }}>לא מולא</span>
                              </>}
                              {played && <PtsBadge pts={pts} played={true} />}
                            </div>
                          )}
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
          {/* ── Sub-tabs ── */}
          <div className="tabs" style={{ marginBottom: 16 }}>
            {([
              { id: 'overview', label: '📋 סקירה' },
              { id: 'matches',  label: '⚽ 1X2' },
              { id: 'groups',   label: `🏠 ${t.tabGroups}` },
              { id: 'bonus',    label: `🎯 ${t.tabBonus}` },
            ] as const).map(t => (
              <button key={t.id}
                className={statsSubTab === t.id ? 'tab active' : 'tab'}
                onClick={() => setStatsSubTab(t.id)}>
                {t.label}
              </button>
            ))}
          </div>

          {/* ── סקירה כללית ── */}
          {statsSubTab === 'overview' && (
            <StatsCharts
              users={users}
              adminResults={adminResults}
              actualBonus={actualBonus as Record<string, string>}
              scoreBreakdown={scoreBreakdown}
              knockoutMatches={knockoutAdminMatches}
              currentUserId={user?.uid}
              getDisplayName={getDisplayName}
            />
          )}

          {/* ── התפלגות 1X2 ── */}
          {statsSubTab === 'matches' && (
            <div>
              <div id="chart-matches" style={{ marginBottom: 20 }} />

              {/* ── שלב הבתים ── */}
              <div style={{ fontSize: 13, fontWeight: 700, color: '#888', marginBottom: 10, paddingBottom: 6, borderBottom: '1px solid #e8e8e8', letterSpacing: '0.04em' }}>
                {t.matchesGroupStage}
              </div>
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
                      <span style={{ fontSize: 13, fontWeight: 500 }}><><Flag emoji={FLAGS[match.teamA]??''} size={22} /> {match.teamA}</> נגד <Flag emoji={FLAGS[match.teamB]??''} size={22} /> {match.teamB}</span>
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
                      { label: t.draw, x2: 'X' },
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

              {/* ── נוקאאוט ── */}
              {(['R32','R16','QF','SF','3P','F'] as const).map(round => {
                  if (!isRoundVisible(round)) return null
                const roundMatches = KNOCKOUT_MATCHES.filter(km => {
                  const adminKm = knockoutAdminMatches[km.id]
                  return adminKm?.teamA && users.some(u => u.knockout?.[km.id]?.prediction1X2)
                })
                  .filter(km => km.round === round)
                if (roundMatches.length === 0) return null
                return (
                  <div key={round}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#888', margin: '20px 0 10px', paddingBottom: 6, borderBottom: '1px solid #e8e8e8', letterSpacing: '0.04em' }}>
                      {KNOCKOUT_ROUND_LABELS[round]}
                    </div>
                    {roundMatches.map(km => {
                      const adminKm = knockoutAdminMatches[km.id]
                      const tA = adminKm?.teamA ?? '?'
                      const tB = adminKm?.teamB ?? '?'
                      const preds = users.map(u => ({
                        x2: u.knockout?.[km.id]?.prediction1X2,
                        name: getDisplayName(u),
                        scoreA: u.knockout?.[km.id]?.scoreA,
                        scoreB: u.knockout?.[km.id]?.scoreB,
                      })).filter(p => p.x2)
                      if (preds.length === 0) return null
                      const total = preds.length
                      const played = adminKm?.isPlayed ?? false
                      const rA = played ? Number(adminKm.resultA??0) : null
                      const rB = played ? Number(adminKm.resultB??0) : null
                      const actual = rA !== null && rB !== null ? (rA > rB ? '1' : rA < rB ? '2' : 'X') : null
                      return (
                        <div key={km.id} className="match-row-view" style={{ marginBottom: 8, padding: '10px 12px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                            <span className="match-num">#{km.id}</span>
                            <span style={{ fontSize: 13, fontWeight: 500 }}>
                              <Flag emoji={FLAGS[tA]??''} size={22} /> {tA} נגד <Flag emoji={FLAGS[tB]??''} size={22} /> {tB}
                            </span>
                            <span style={{ marginRight: 'auto', fontSize: 12 }}>
                              {played && actual ? (
                                <>
                                  <span style={{ color: '#888' }}>בפועל: {rA}–{rB} → </span>
                                  <span style={{ fontSize: 11, fontWeight: 600, padding: '1px 7px', borderRadius: 10, background: '#EAF3DE', color: '#3B6D11' }}>
                                    {adminKm.advanceTeam}
                                  </span>
                                </>
                              ) : <span style={{ fontSize: 11, color: '#bbb' }}>טרם שוחק</span>}
                            </span>
                          </div>
                          {[{ label: tA, x2: '1' }, { label: t.draw, x2: 'X' }, { label: tB, x2: '2' }].map(row => {
                            const rowPreds = preds.filter(p => p.x2 === row.x2)
                            const pct = Math.round((rowPreds.length / total) * 100)
                            const isWinner = played && row.x2 === actual
                            return (
                              <div key={row.x2} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                                <span style={{ fontSize: 12, minWidth: 70, color: isWinner ? '#1a7a44' : '#555', fontWeight: isWinner ? 700 : 400 }}>{row.label}</span>
                                <div style={{ flex: 1, background: '#f0f0f0', borderRadius: 4, height: 12, overflow: 'hidden' }}>
                                  <div style={{ height: 12, borderRadius: 4, width: `${pct}%`, background: isWinner ? '#1a7a44' : '#bbb' }} />
                                </div>
                                <HoverTooltip names={rowPreds.map(p => `${p.name}: ${p.scoreA??'?'}-${p.scoreB??'?'}`)}>
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
                )
              })}
            </div>
          )}

          {/* ── עולות מהבתים ── */}
          {statsSubTab === 'groups' && (
            <div style={{ paddingBottom: 32 }}>
              <div id="chart-groups" style={{ marginBottom: 20 }} />
              {GROUPS.map(group => (
                <div key={group} style={{ marginBottom: 16 }}>
                  <div className="group-label">{t.group} {group}</div>
                  <GroupPredTable group={group} users={users} actualResult={actualGroups[group]} />
                </div>
              ))}
            </div>
          )}

          {/* ── שאלות בונוס ── */}
          {statsSubTab === 'bonus' && (
            <div style={{ paddingBottom: 40 }}>
              <div id="chart-bonus" style={{ marginBottom: 20 }} />
              {BONUS_QUESTIONS.map(q => {
                const actualVal = (actualBonus as any)?.[q.id]
                return (
                  <div key={q.id} className="bonus-row">
                    <div className="bonus-label">
                      <span>{q.label}</span>
                      <span className="pts-badge">{q.points} נק׳</span>
                      {actualVal && <span style={{ fontSize: 12, color: '#1a7a44', fontWeight: 600, marginRight: 8 }}>✓ {actualVal}</span>}
                    </div>
                    <BonusPredTable qId={q.id} users={users} actualVal={actualVal} />
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