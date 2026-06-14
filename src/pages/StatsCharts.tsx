import Flag, { getFlagUrl, flagToIso } from '../components/Flag'

// ── Custom SVG arc helper ─────────────────────────────────────────────────
function arcPath(cx: number, cy: number, ir: number, or: number, sa: number, ea: number): string {
  // SVG arc can't draw a full 360° circle — split into two semicircles
  if (ea - sa >= 359.9) {
    const top = `${cx},${cy - or}`, bot = `${cx},${cy + or}`
    const outer = `M${top} A${or},${or} 0 1 1 ${bot} A${or},${or} 0 1 1 ${top} Z`
    if (ir <= 0) return outer
    const it = `${cx},${cy - ir}`, ib = `${cx},${cy + ir}`
    return `${outer} M${it} A${ir},${ir} 0 1 0 ${ib} A${ir},${ir} 0 1 0 ${it} Z`
  }
  const r = (a: number) => (a - 90) * Math.PI / 180
  const pt = (radius: number, a: number) => `${cx + radius * Math.cos(r(a))},${cy + radius * Math.sin(r(a))}`
  const large = ea - sa > 180 ? 1 : 0
  if (ir <= 0) return `M${cx},${cy} L${pt(or,sa)} A${or},${or} 0 ${large} 1 ${pt(or,ea)} Z`
  return `M${pt(or,sa)} A${or},${or} 0 ${large} 1 ${pt(or,ea)} L${pt(ir,ea)} A${ir},${ir} 0 ${large} 0 ${pt(ir,sa)} Z`
}

interface ArcSlice { team: string|null; count: number; pct: number; sa: number; ea: number; key: string }

function buildArcs(items: {team: string|null; count: number; key: string}[], total: number): ArcSlice[] {
  let angle = 0
  return items.map(item => {
    const span = total > 0 ? (item.count / total) * 360 : 0
    const slice = { ...item, pct: Math.round(item.count / total * 100), sa: angle, ea: angle + span }
    angle += span
    return slice
  }).filter(s => s.ea - s.sa > 0.5)
}

function FlagRing({ cx, cy, ir, or: outerR, slices, id, showPct }: {
  cx: number; cy: number; ir: number; or: number
  slices: ArcSlice[]; id: string; showPct: boolean
}) {
  const toRad = (a: number) => (a - 90) * Math.PI / 180

  return (
    <g>
      <defs>
        {slices.map((s, i) => (
          <clipPath key={i} id={`cp-${id}-${i}`}>
            <path d={arcPath(cx, cy, ir, outerR, s.sa, s.ea)} />
          </clipPath>
        ))}
      </defs>
      {slices.map((s, i) => {
        const path  = arcPath(cx, cy, ir, outerR, s.sa, s.ea)
        const iso   = s.team ? flagToIso(FLAGS[s.team] ?? '') : ''
        const span  = s.ea - s.sa   // degrees

        // Slice centroid — where the flag is centered
        const midA = (s.sa + s.ea) / 2
        const midR = ir <= 0 ? outerR * 0.60 : (ir + outerR) / 2
        const lx   = cx + midR * Math.cos(toRad(midA))
        const ly   = cy + midR * Math.sin(toRad(midA))

        // Minimum bbox to cover every corner of the slice from the centroid.
        // The farthest point is the outer-arc corner at half-span from mid-angle.
        const halfSpanRad = ((s.ea - s.sa) / 2) * Math.PI / 180
        const dCorner = Math.sqrt(
          midR * midR + outerR * outerR - 2 * midR * outerR * Math.cos(halfSpanRad)
        )
        const dCenter  = ir <= 0 ? midR : 0        // pie center matters for full-pie slices
        const maxDist  = Math.max(dCorner, dCenter) * 1.12   // 12% safety

        // Use flag's natural 3:2 ratio for the bbox → full flag shown, no zoom
        // Half-diagonal of a 3:2 rect = 0.601 × width → width = maxDist / 0.601 × 2
        const imgW = (maxDist / 0.601) * 1.0
        const imgH = imgW * (2 / 3)

        return (
          <g key={i}>
            <path d={path} fill="#d8d8d8" />

            {iso && (
              <>
                <image
                  href={`https://flagcdn.com/w320/${iso}.png`}
                  x={lx - imgW / 2} y={ly - imgH / 2}
                  width={imgW} height={imgH}
                  clipPath={`url(#cp-${id}-${i})`}
                  preserveAspectRatio="xMidYMid slice"
                />
                <path d={path} fill="rgba(0,0,0,0.10)" stroke="white" strokeWidth={3} />
              </>
            )}
            {!iso && <path d={path} fill="none" stroke="white" strokeWidth={3} />}

            {showPct && s.pct >= 5 && (
              <text x={lx} y={ly}
                textAnchor="middle" dominantBaseline="central"
                style={{ fontSize: Math.max(13, Math.min(19, outerR * 0.13)),
                  fontWeight: 900, fill: '#fff',
                  stroke: 'rgba(0,0,0,0.75)', strokeWidth: 4.5,
                  paintOrder: 'stroke fill' }}>
                {s.pct}%
              </text>
            )}
          </g>
        )
      })}
    </g>
  )
}

function FlagPieChart({ matchId, teamA, teamB, users, adminResult, isKO, koAdminResult }: {
  matchId: number; teamA: string; teamB: string
  users: UserData[]; adminResult?: any; isKO: boolean; koAdminResult?: any
}) {
  const SIZE = 380, cx = 190, cy = 190
  const title = `${teamA} — ${teamB}`

  // 1X2 data
  const preds1x2 = users.map(u => isKO ? u.knockout?.[matchId]?.prediction1X2 : u.matches[matchId]?.prediction1X2).filter(Boolean)
  const c1 = preds1x2.filter(x => x === '1').length
  const c2 = preds1x2.filter(x => x === '2').length
  const cX = preds1x2.filter(x => x === 'X').length
  const total1x2 = preds1x2.length || 1

  const played = (isKO ? koAdminResult : adminResult)?.isPlayed ?? false
  const rA = played ? Number((isKO ? koAdminResult : adminResult).resultA ?? 0) : null
  const rB = played ? Number((isKO ? koAdminResult : adminResult).resultB ?? 0) : null
  const actual1x2 = rA !== null && rB !== null ? (rA > rB ? '1' : rA < rB ? '2' : 'X') : null
  const actualAdv = isKO ? koAdminResult?.advanceTeam : null

  const slices1x2 = buildArcs([
    { key: '1', team: teamA, count: c1 },
    { key: 'X', team: null,  count: cX },
    { key: '2', team: teamB, count: c2 },
  ], total1x2)

  // Advance data (knockout only)
  let slicesAdv: ArcSlice[] = []
  if (isKO) {
    const predsAdv = users.map(u => u.knockout?.[matchId]?.advance)
    const cA = predsAdv.filter(x => x === teamA).length
    const cB = predsAdv.filter(x => x === teamB).length
    const cNone = users.length - cA - cB
    slicesAdv = buildArcs([
      { key: 'A', team: teamA, count: cA },
      { key: 'B', team: teamB, count: cB },
      { key: 'none', team: null, count: cNone },
    ], users.length)
  }

  const outerR = isKO ? 125 : 175
  const innerR = isKO ? 55  : 0
  const advInnerR = 132, advOuterR = 178

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: '#1a1a2e', textAlign: 'center' }}>{title}</div>

      {played && actual1x2 && (
        <div style={{ fontSize: 12, padding: '4px 12px', borderRadius: 20, background: '#EAF3DE', color: '#27500A', fontWeight: 600 }}>
          בפועל: {rA}:{rB} → {actual1x2==='1' ? teamA : actual1x2==='2' ? teamB : 'תיקו'}
          {actualAdv && ` | עולה: ${actualAdv}`}
        </div>
      )}

      <svg width={SIZE} height={SIZE} style={{ overflow: 'visible' }}>
        <FlagRing cx={cx} cy={cy} ir={innerR} or={outerR} slices={slices1x2} id={`r1-${matchId}`} showPct={true} />
        {isKO && slicesAdv.length > 0 && (
          <FlagRing cx={cx} cy={cy} ir={advInnerR} or={advOuterR} slices={slicesAdv} id={`r2-${matchId}`} showPct={true} />
        )}
        {/* Center hole label for KO */}
        {isKO && innerR > 0 && (
          <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central"
            style={{ fontSize: 11, fill: '#888', fontWeight: 600 }}>1X2</text>
        )}
      </svg>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', justifyContent: 'center', fontSize: 13 }}>
        {[
          { team: teamA, label: teamA, count: c1, total: total1x2, correct: actual1x2 === '1' },
          { team: null,  label: 'תיקו',  count: cX, total: total1x2, correct: actual1x2 === 'X' },
          { team: teamB, label: teamB, count: c2, total: total1x2, correct: actual1x2 === '2' },
        ].map((item, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: item.correct ? 700 : 400, color: item.correct ? '#1a7a44' : '#444' }}>
            {item.team ? <Flag emoji={FLAGS[item.team]??''} size={18} /> : <span style={{ fontSize: 16 }}>🤝</span>}
            <span>{item.label}</span>
            <span style={{ color: '#888', fontWeight: 400 }}>{Math.round(item.count/item.total*100)}% ({item.count})</span>
            {item.correct && <span>✓</span>}
          </div>
        ))}
      </div>

      {isKO && (
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', justifyContent: 'center', fontSize: 12, color: '#888' }}>
          <span style={{ fontWeight: 600, color: '#555' }}>עולה:</span>
          {[teamA, teamB].map(team => {
            const predsAdv = users.map(u => u.knockout?.[matchId]?.advance)
            const count = predsAdv.filter(x => x === team).length
            const pct = Math.round(count / users.length * 100)
            const correct = actualAdv === team
            return (
              <span key={team} style={{ display: 'flex', alignItems: 'center', gap: 4, fontWeight: correct ? 700 : 400, color: correct ? '#1a7a44' : '#555' }}>
                <Flag emoji={FLAGS[team]??''} size={16} /> {team} {pct}% {correct && '✓'}
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}
import { useState, useMemo, useEffect } from 'react'
import React from 'react'
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Legend,
  RadarChart, PolarGrid, PolarAngleAxis, Radar,
} from 'recharts'
import { MATCHES, BONUS_QUESTIONS, FLAGS, KNOCKOUT_MATCHES, KNOCKOUT_ROUND_LABELS } from '../data/matches'
import { Match } from '../types'
import { getOUType } from '../scoring'

interface UserData {
  userId: string
  userName: string
  nickname?: string
  matches: Record<number, any>
  groups: Record<string, any>
  bonus: Record<string, string>
  knockout?: Record<number, any>
}

interface ScoreBreakdown {
  total: number
  matchPoints: number
  groupPoints: number
  bonusPoints: number
  redCardPoints: number
  knockoutPoints: number
}

interface Props {
  users: UserData[]
  adminResults: Record<number, Match>
  actualBonus: Record<string, string>
  scoreBreakdown: Record<string, ScoreBreakdown>
  knockoutMatches: Record<number, any>
  currentUserId?: string
  getDisplayName: (u: UserData) => string
  playerStats?: {
    topScorers: { name: string; goals: number; team: string }[]
    topAssists: { name: string; assists: number; team: string }[]
    updatedAt?: string
  }
}

type ChartTab = 'distribution' | 'scores' | 'champion' | 'consensus' | 'myposition' | 'bonus'

const COLORS = {
  blue:   '#378ADD',
  green:  '#639922',
  amber:  '#BA7517',
  coral:  '#D85A30',
  purple: '#7F77DD',
  teal:   '#1D9E75',
  gray:   '#888780',
  pink:   '#D4537E',
}

const PIE_COLORS = [COLORS.blue, COLORS.gray, COLORS.coral]

const TABS: { id: ChartTab; label: string }[] = [
  { id: 'distribution', label: '📊 1X2 למשחק' },
  { id: 'scores',       label: '🏅 ניקוד משתתפים' },
  { id: 'champion',     label: '🏆 מי יהיה אלוף' },
  { id: 'consensus',    label: '🤝 הסכמת מהמרים' },
  { id: 'myposition',   label: '🎯 המצב שלי' },
  { id: 'bonus',        label: '🎰 שאלות בונוס' },
]

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: '#1a1a2e', color: '#fff', padding: '8px 12px', borderRadius: 8, fontSize: 12 }}>
      {label && <div style={{ marginBottom: 4, fontWeight: 600 }}>{label}</div>}
      {payload.map((p: any, i: number) => (
        <div key={i} style={{ color: p.color ?? '#fff' }}>{p.name}: {p.value}</div>
      ))}
    </div>
  )
}

function BonusStatusTab({ users, adminResults, playerStats, getDisplayName }: {
  users: UserData[]
  adminResults: Record<number, Match>
  playerStats?: {
    topScorers: { name: string; goals: number; team: string }[]
    topAssists: { name: string; assists: number; team: string }[]
    totalRedCards?: number
    updatedAt?: string
  }
  getDisplayName: (u: UserData) => string
}) {
  // Compute group stats from adminResults
  const groupGoals: Record<string, number> = {}
  const teamGoalsFor: Record<string, number> = {}
  const teamGoalsAgainst: Record<string, number> = {}
  const teamPoints: Record<string, number> = {}

  // Initialize all teams that have played with 0 points
  for (const match of MATCHES) {
    const r = adminResults[match.id]
    if (!r?.isPlayed || r.resultA == null || r.resultB == null) continue
    if (!(match.teamA in teamPoints)) teamPoints[match.teamA] = 0
    if (!(match.teamB in teamPoints)) teamPoints[match.teamB] = 0
  }

  for (const match of MATCHES) {
    const r = adminResults[match.id]
    if (!r?.isPlayed || r.resultA == null || r.resultB == null) continue
    const g = match.group
    groupGoals[g] = (groupGoals[g] ?? 0) + r.resultA + r.resultB
    teamGoalsFor[match.teamA] = (teamGoalsFor[match.teamA] ?? 0) + r.resultA
    teamGoalsFor[match.teamB] = (teamGoalsFor[match.teamB] ?? 0) + r.resultB
    teamGoalsAgainst[match.teamA] = (teamGoalsAgainst[match.teamA] ?? 0) + r.resultB
    teamGoalsAgainst[match.teamB] = (teamGoalsAgainst[match.teamB] ?? 0) + r.resultA
    // Points: win=3, draw=1, loss=0
    if (r.resultA > r.resultB) {
      teamPoints[match.teamA] = (teamPoints[match.teamA] ?? 0) + 3
    } else if (r.resultA < r.resultB) {
      teamPoints[match.teamB] = (teamPoints[match.teamB] ?? 0) + 3
    } else {
      teamPoints[match.teamA] = (teamPoints[match.teamA] ?? 0) + 1
      teamPoints[match.teamB] = (teamPoints[match.teamB] ?? 0) + 1
    }
  }

  const sortedGroups = Object.entries(groupGoals).sort((a, b) => b[1] - a[1])
  const mostGoalsGroup  = sortedGroups[0]
  const leastGoalsGroup = sortedGroups[sortedGroups.length - 1]

  // Sort by: points → goal diff → goals for
  const sortedByPoints = Object.entries(teamPoints).sort((a, b) => {
    const pts = b[1] - a[1]
    if (pts !== 0) return pts
    const gd = (teamGoalsFor[b[0]] ?? 0) - (teamGoalsAgainst[b[0]] ?? 0) -
               ((teamGoalsFor[a[0]] ?? 0) - (teamGoalsAgainst[a[0]] ?? 0))
    if (gd !== 0) return gd
    return (teamGoalsFor[b[0]] ?? 0) - (teamGoalsFor[a[0]] ?? 0)
  })

  // Find all teams tied at top (best) and bottom (worst)
  const bestTeams: string[] = sortedByPoints.length > 0 ? (() => {
    const top = sortedByPoints[0]
    return sortedByPoints.filter(t =>
      t[1] === top[1] &&
      ((teamGoalsFor[t[0]] ?? 0) - (teamGoalsAgainst[t[0]] ?? 0)) ===
      ((teamGoalsFor[top[0]] ?? 0) - (teamGoalsAgainst[top[0]] ?? 0)) &&
      (teamGoalsFor[t[0]] ?? 0) === (teamGoalsFor[top[0]] ?? 0)
    ).map(t => t[0])
  })() : []

  const worstTeams: string[] = sortedByPoints.length > 0 ? (() => {
    const bot = sortedByPoints[sortedByPoints.length - 1]
    return sortedByPoints.filter(t =>
      t[1] === bot[1] &&
      ((teamGoalsFor[t[0]] ?? 0) - (teamGoalsAgainst[t[0]] ?? 0)) ===
      ((teamGoalsFor[bot[0]] ?? 0) - (teamGoalsAgainst[bot[0]] ?? 0)) &&
      (teamGoalsFor[t[0]] ?? 0) === (teamGoalsFor[bot[0]] ?? 0)
    ).map(t => t[0])
  })() : []

  const sortedByDefense = Object.entries(teamGoalsAgainst).sort((a, b) => a[1] - b[1])
  const bestDefense = sortedByDefense[0]

  const sortedByAttack = Object.entries(teamGoalsFor).sort((a, b) => b[1] - a[1])
  const bestAttack = sortedByAttack[0]

  const playedCount = MATCHES.filter(m => adminResults[m.id]?.isPlayed).length
  const groupStageDone = playedCount >= 48

  const topScorer  = playerStats?.topScorers?.[0]
  const topAssist  = playerStats?.topAssists?.[0]

  // Count total red cards across all played matches
  // Use Zafronix total red cards if available, fallback to hadRedCard count
  const totalRedCards = playerStats?.totalRedCards != null
    ? playerStats.totalRedCards
    : MATCHES.reduce((sum, m) => sum + (adminResults[m.id]?.redCardCount ?? (adminResults[m.id]?.hadRedCard ? 1 : 0)), 0)

  const statusBadge = (label: string, value: string | undefined, extra?: string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: '#f0f7ff', borderRadius: 8, marginTop: 6, fontSize: 13 }}>
      <span style={{ fontWeight: 600, color: '#1a1a2e' }}>{label}:</span>
      {value
        ? <span style={{ color: '#1a7a44', fontWeight: 700 }}>{value}{extra ? ` (${extra})` : ''}</span>
        : <span style={{ color: '#aaa' }}>עדיין לא ידוע</span>
      }
    </div>
  )

  const section = (title: string, children: React.ReactNode) => (
    <div style={{ marginBottom: 20, background: '#fff', borderRadius: 12, border: '1px solid #eee', padding: '14px 16px' }}>
      <div style={{ fontWeight: 700, fontSize: 14, color: '#1a1a2e', marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  )

  return (
    <div style={{ direction: 'rtl' }}>
      {playerStats?.updatedAt && (
        <div style={{ fontSize: 11, color: '#aaa', marginBottom: 12, textAlign: 'left' }}>
          עודכן: {new Date(playerStats.updatedAt).toLocaleString('he-IL')}
        </div>
      )}

      {section('🏆 שאלות גמר', <>
        {statusBadge('אלוף העולם', undefined)}
        {statusBadge('סגן האלוף', undefined)}
        {statusBadge('מקום שלישי', undefined)}
        <div style={{ fontSize: 11, color: '#aaa', marginTop: 6 }}>יתעדכן בסיום הטורניר</div>
      </>)}

      {section('⚽ מלך השערים', <>
        {statusBadge('מוביל כרגע', topScorer ? `${topScorer.name} (${topScorer.team})` : undefined, topScorer ? `${topScorer.goals} שערים` : undefined)}
        {statusBadge('כמה שערים יבקיע', topScorer ? `${topScorer.goals} עד כה` : undefined)}
        {playerStats?.topScorers?.slice(0, 5).map((s, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '4px 0', borderBottom: '1px solid #f0f0f0' }}>
            <span>{i + 1}. {s.name} <span style={{ color: '#aaa' }}>({s.team})</span></span>
            <span style={{ fontWeight: 600 }}>{s.goals} ⚽</span>
          </div>
        ))}
        {!playerStats && <div style={{ fontSize: 12, color: '#aaa' }}>יתעדכן אחרי הסנכרון הבא</div>}
      </>)}

      {section('🎯 מלך הבישולים', <>
        {statusBadge('מוביל כרגע', topAssist ? `${topAssist.name} (${topAssist.team})` : undefined, topAssist ? `${topAssist.assists} בישולים` : undefined)}
        {playerStats?.topAssists?.slice(0, 5).map((s, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '4px 0', borderBottom: '1px solid #f0f0f0' }}>
            <span>{i + 1}. {s.name} <span style={{ color: '#aaa' }}>({s.team})</span></span>
            <span style={{ fontWeight: 600 }}>{s.assists} 🎯</span>
          </div>
        ))}
        {playerStats?.topAssists?.length === 0 && <div style={{ fontSize: 12, color: '#aaa' }}>עדיין אין בישולים מתועדים</div>}
        {!playerStats && <div style={{ fontSize: 12, color: '#aaa' }}>יתעדכן אחרי הסנכרון הבא</div>}
      </>)}

      {section('🏅 נבחרת טובה/גרועה בבתים', <>
        {statusBadge('הטובה ביותר כרגע', bestTeams.length > 0 ? bestTeams.join(' / ') : undefined,
          bestTeams.length > 0 ? `${teamPoints[bestTeams[0]]} נק׳, הפרש ${(teamGoalsFor[bestTeams[0]]??0)-(teamGoalsAgainst[bestTeams[0]]??0)}` : undefined)}
        {statusBadge('הגרועה ביותר כרגע', worstTeams.length > 0 ? worstTeams.join(' / ') : undefined,
          worstTeams.length > 0 ? `${teamPoints[worstTeams[0]]} נק׳, הפרש ${(teamGoalsFor[worstTeams[0]]??0)-(teamGoalsAgainst[worstTeams[0]]??0)}` : undefined)}
        {!groupStageDone && <div style={{ fontSize: 11, color: '#aaa', marginTop: 6 }}>שלב הבתים לא הסתיים ({playedCount}/48 משחקים)</div>}
      </>)}

      {section('📊 בית עם הכי הרבה/מעט שערים', <>
        {statusBadge('הכי הרבה שערים', mostGoalsGroup ? `בית ${mostGoalsGroup[0]} (${mostGoalsGroup[1]} שערים)` : undefined)}
        {statusBadge('הכי מעט שערים', leastGoalsGroup && leastGoalsGroup[0] !== mostGoalsGroup?.[0] ? `בית ${leastGoalsGroup[0]} (${leastGoalsGroup[1]} שערים)` : undefined)}
      </>)}

      {section('🛡️ ההגנה הטובה / ההתקפה הטובה', <>
        {statusBadge('הגנה הטובה ביותר', bestDefense ? `${bestDefense[0]} (${bestDefense[1]} ספיגות)` : undefined)}
        {statusBadge('התקפה הטובה ביותר', bestAttack ? `${bestAttack[0]} (${bestAttack[1]} שערים)` : undefined)}
        {!groupStageDone && <div style={{ fontSize: 11, color: '#aaa', marginTop: 6 }}>שלב הבתים לא הסתיים</div>}
      </>)}

      {section('🟥 כרטיסים אדומים בטורניר', <>
        {statusBadge('עד כה', `${totalRedCards} כרטיסים אדומים ב-${playedCount} משחקים`)}
        <div style={{ fontSize: 11, color: '#aaa', marginTop: 6 }}>השאלה: כמה סה״כ בכל 64 משחקי הטורניר</div>
      </>)}
    </div>
  )
}

export default function StatsCharts({ users, adminResults, actualBonus, scoreBreakdown, knockoutMatches, currentUserId, getDisplayName, playerStats }: Props) {
  const [tab, setTab]               = useState<ChartTab>('distribution')
  const [selectedMatchId, setSelectedMatchId] = useState<number>(MATCHES[0]?.id ?? 1)
  const [matchAutoSet, setMatchAutoSet] = useState(false)

  // Auto-select the next upcoming (non-played) match when adminResults loads
  useEffect(() => {
    if (matchAutoSet) return
    if (Object.keys(adminResults).length === 0) return
    const nextMatch = MATCHES.find(m => !adminResults[m.id]?.isPlayed)
    if (nextMatch) setSelectedMatchId(nextMatch.id)
    setMatchAutoSet(true)
  }, [adminResults, matchAutoSet])

  const playedMatches = MATCHES.filter(m => adminResults[m.id]?.isPlayed)

  // ── 1. 1X2 distribution for selected match ──────────────────────
  const distributionData = useMemo(() => {
    const match = MATCHES.find(m => m.id === selectedMatchId)
    if (!match) return null
    const preds = users.map(u => u.matches[selectedMatchId]?.prediction1X2).filter(Boolean)
    const c1 = preds.filter(p => p === '1').length
    const c2 = preds.filter(p => p === '2').length
    const cX = preds.filter(p => p === 'X').length
    const result = adminResults[selectedMatchId]
    const actual = result?.isPlayed
      ? (Number(result.resultA) > Number(result.resultB) ? '1'
        : Number(result.resultA) < Number(result.resultB) ? '2' : 'X')
      : null
    return {
      match,
      actual,
      totalPreds: preds.length,
      pie: [
        { name: `${FLAGS[match.teamA] ?? ''} ${match.teamA}`, value: c1, key: '1' },
        { name: 'תיקו', value: cX, key: 'X' },
        { name: `${FLAGS[match.teamB] ?? ''} ${match.teamB}`, value: c2, key: '2' },
      ].filter(d => d.value > 0),
    }
  }, [selectedMatchId, users, adminResults])

  // ── 1.5 Per-user match stats ─────────────────────────────────────
  const userMatchStats = useMemo(() => {
    const stats: Record<string, { exact: number; margin: number; ou: number }> = {}
    for (const user of users) {
      let exact = 0, margin = 0, ou = 0
      for (const match of MATCHES) {
        const result = adminResults[match.id]
        if (!result?.isPlayed || result.resultA == null || result.resultB == null) continue
        const pred = user.matches[match.id]
        if (!pred || pred.scoreA == null || pred.scoreB == null) continue
        const rA = Number(result.resultA), rB = Number(result.resultB)
        const pA = Number(pred.scoreA), pB = Number(pred.scoreB)
        if (pA === rA && pB === rB) {
          exact++
        } else if ((pA - pB) === (rA - rB)) {
          margin++
        }
        const ouType = getOUType(rA + rB)
        const predOuType = getOUType(pA + pB)
        if (ouType && predOuType === ouType && !(pA === rA && pB === rB)) ou++
      }
      stats[user.userId] = { exact, margin, ou }
    }
    return stats
  }, [users, adminResults])

  // ── 2. Score breakdown ───────────────────────────────────────────
  const scoreData = useMemo(() => {
    return users
      .filter(u => scoreBreakdown[u.userId]?.total > 0)
      .map(u => {
        const bd = scoreBreakdown[u.userId] ?? {} as ScoreBreakdown
        return {
          name: getDisplayName(u),
          uid:  u.userId,
          משחקים:  bd.matchPoints    ?? 0,
          'עולות+בונוס': (bd.groupPoints ?? 0) + (bd.bonusPoints ?? 0),
          נוקאאוט: bd.knockoutPoints ?? 0,
          '🟥':   bd.redCardPoints  ?? 0,
          total:  bd.total           ?? 0,
        }
      })
      .sort((a, b) => b.total - a.total)
  }, [users, scoreBreakdown])

  // ── 3. Champion picks ────────────────────────────────────────────
  const championData = useMemo(() => {
    const counts: Record<string, number> = {}
    users.forEach(u => {
      const pick = u.bonus?.q105
      if (pick) counts[pick] = (counts[pick] ?? 0) + 1
    })
    const actualChamp = actualBonus?.q105
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([team, count]) => ({
        name: `${FLAGS[team] ?? ''} ${team}`,
        ניחושים: count,
        fill: team === actualChamp ? COLORS.green : COLORS.purple,
      }))
  }, [users, actualBonus])

  // ── 4. Match consensus ───────────────────────────────────────────
  const consensusData = useMemo(() => {
    return MATCHES.map(m => {
      const preds = users.map(u => u.matches[m.id]?.prediction1X2).filter(Boolean)
      if (preds.length === 0) return null
      const c1 = preds.filter(p => p === '1').length
      const c2 = preds.filter(p => p === '2').length
      const cX = preds.filter(p => p === 'X').length
      const max = Math.max(c1, c2, cX)
      const pct = Math.round((max / preds.length) * 100)
      const winner = max === c1 ? '1' : max === c2 ? '2' : 'X'
      const result = adminResults[m.id]
      const actual = result?.isPlayed
        ? (Number(result.resultA) > Number(result.resultB) ? '1'
          : Number(result.resultA) < Number(result.resultB) ? '2' : 'X')
        : null
      return {
        name: `#${m.id}`,
        fullName: `${m.teamA} נגד ${m.teamB}`,
        הסכמה: pct,
        fill: actual
          ? (winner === actual ? COLORS.green : COLORS.coral)
          : (pct >= 70 ? COLORS.teal : pct >= 50 ? COLORS.blue : COLORS.gray),
      }
    }).filter(Boolean) as any[]
  }, [users, adminResults])

  // ── 5. My position (radar) ───────────────────────────────────────
  const myPositionData = useMemo(() => {
    if (!currentUserId || !scoreBreakdown[currentUserId]) return null
    const me = scoreBreakdown[currentUserId]
    const others = Object.entries(scoreBreakdown).filter(([uid]) => uid !== currentUserId)
    if (others.length === 0) return null
    const avg = (key: keyof ScoreBreakdown) => {
      const sum = others.reduce((s, [, bd]) => s + (bd[key] ?? 0), 0)
      return Math.round(sum / others.length)
    }
    return [
      { subject: 'משחקים', אני: me.matchPoints, ממוצע: avg('matchPoints') },
      { subject: 'עולות',  אני: me.groupPoints,  ממוצע: avg('groupPoints') },
      { subject: 'בונוס',  אני: me.bonusPoints,  ממוצע: avg('bonusPoints') },
      { subject: 'נוקאאוט',אני: me.knockoutPoints,ממוצע: avg('knockoutPoints') },
      { subject: '🟥',     אני: me.redCardPoints, ממוצע: avg('redCardPoints') },
    ]
  }, [currentUserId, scoreBreakdown])

  const myRank = useMemo(() => {
    if (!currentUserId) return null
    const sorted = [...users].sort((a, b) =>
      (scoreBreakdown[b.userId]?.total ?? 0) - (scoreBreakdown[a.userId]?.total ?? 0) ||
      a.userId.localeCompare(b.userId)
    )
    let rank = 1
    for (let i = 0; i < sorted.length; i++) {
      if (i > 0 && (scoreBreakdown[sorted[i].userId]?.total ?? 0) < (scoreBreakdown[sorted[i-1].userId]?.total ?? 0)) {
        rank = i + 1
      }
      if (sorted[i].userId === currentUserId) return rank
    }
    return null
  }, [currentUserId, scoreBreakdown, users])

  const leaderTotal = useMemo(() =>
    Math.max(0, ...Object.values(scoreBreakdown).map(b => b.total ?? 0))
  , [scoreBreakdown])

  return (
    <div style={{ paddingBottom: 32 }}>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 20, background: '#f5f5f5', borderRadius: 12, padding: 4 }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{
              flex: 1, minWidth: 100, padding: '8px 12px', borderRadius: 9, border: 'none',
              cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600, fontSize: 12,
              background: tab === t.id ? '#1a1a2e' : 'transparent',
              color: tab === t.id ? '#fff' : '#666',
              transition: 'all 0.15s',
            }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── 1X2 Distribution ─────────────────────────────────────── */}
      {tab === 'distribution' && (
        <div>
          <select value={selectedMatchId} onChange={e => setSelectedMatchId(Number(e.target.value))}
            style={{ marginBottom: 20, width: '100%', maxWidth: 400, padding: '8px 12px', borderRadius: 8, border: '1px solid #ddd', fontFamily: 'inherit', fontSize: 13 }}>
            <optgroup label="שלב הבתים">
              {MATCHES.map(m => (
                <option key={m.id} value={m.id}>
                  #{m.id} {m.teamA} נגד {m.teamB}{adminResults[m.id]?.isPlayed ? ' ✓' : ''}
                </option>
              ))}
            </optgroup>
            {(['R32','R16','QF','SF','3P','F'] as const).map(round => {
              const roundMatches = KNOCKOUT_MATCHES.filter(km => {
                const km2 = (knockoutMatches as any)[km.id]
                return km2?.teamA && km2?.teamB
              }).filter(km => km.round === round)
              if (roundMatches.length === 0) return null
              return (
                <optgroup key={round} label={KNOCKOUT_ROUND_LABELS[round]}>
                  {roundMatches.map(km => {
                    const km2 = (knockoutMatches as any)[km.id]
                    return (
                      <option key={km.id} value={km.id}>
                        #{km.id} {km2?.teamA} נגד {km2?.teamB}{km2?.isPlayed ? ' ✓' : ''}
                      </option>
                    )
                  })}
                </optgroup>
              )
            })}
          </select>

          {(() => {
            const isKO = selectedMatchId > 72
            if (isKO) {
              const km = KNOCKOUT_MATCHES.find(m => m.id === selectedMatchId)
              const koAdmin = (knockoutMatches as any)[selectedMatchId]
              if (!koAdmin?.teamA) return <div style={{ color: '#aaa', fontSize: 13 }}>אין נתונים למשחק זה עדיין</div>
              return (
                <FlagPieChart
                  matchId={selectedMatchId}
                  teamA={koAdmin.teamA} teamB={koAdmin.teamB}
                  users={users} isKO={true} koAdminResult={koAdmin}
                />
              )
            }
            const match = MATCHES.find(m => m.id === selectedMatchId)
            if (!match) return null
            return (
              <FlagPieChart
                matchId={selectedMatchId}
                teamA={match.teamA} teamB={match.teamB}
                users={users} adminResult={adminResults[selectedMatchId]}
                isKO={false}
              />
            )
          })()}
        </div>
      )}

      {/* ── Score breakdown ──────────────────────────────────────── */}
      {tab === 'scores' && (
        <div>
          {scoreData.length === 0 ? (
            <div style={{ color: '#aaa', fontSize: 13, textAlign: 'center', padding: '40px 0' }}>אין נתוני ניקוד עדיין</div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, fontSize: 12, color: '#666' }}>
                {[['משחקים', COLORS.blue], ['עולות+בונוס', COLORS.green], ['נוקאאוט', COLORS.amber], ['🟥', COLORS.coral]].map(([l, c]) => (
                  <span key={l} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 2, background: c as string, display: 'inline-block' }} />
                    {l}
                  </span>
                ))}
              </div>
              <ResponsiveContainer width="100%" height={Math.max(280, scoreData.length * 38)}>
                <BarChart data={scoreData} layout="vertical" margin={{ right: 50 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#eee" />
                  <XAxis type="number" tick={{ fontSize: 11, fill: '#888' }} />
                  <YAxis type="category" dataKey="name" width={72} tick={{ fontSize: 12, fill: '#444' }} />
                  <Tooltip content={<CustomTooltip />} />
                  <Bar dataKey="משחקים"      stackId="a" fill={COLORS.blue}   radius={[0,0,0,0]} />
                  <Bar dataKey="עולות+בונוס" stackId="a" fill={COLORS.green}  radius={[0,0,0,0]} />
                  <Bar dataKey="נוקאאוט"     stackId="a" fill={COLORS.amber}  radius={[0,0,0,0]} />
                  <Bar dataKey="🟥"          stackId="a" fill={COLORS.coral}  radius={[0,4,4,0]} />
                </BarChart>
              </ResponsiveContainer>

              {/* Match prediction stats table */}
              {playedMatches.length > 0 && (
                <div style={{ marginTop: 20 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#1a1a2e', marginBottom: 8 }}>סטטיסטיקת ניחושי משחקים</div>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead>
                        <tr style={{ background: '#1a1a2e', color: '#fff' }}>
                          <th style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 600 }}>שם</th>
                          <th style={{ padding: '6px 8px', textAlign: 'center', fontWeight: 600 }}>✓ מדויק</th>
                          <th style={{ padding: '6px 8px', textAlign: 'center', fontWeight: 600 }}>~ הפרש</th>
                          <th style={{ padding: '6px 8px', textAlign: 'center', fontWeight: 600 }}>📊 אנד/אובר</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...users]
                          .filter(u => scoreBreakdown[u.userId]?.total >= 0)
                          .sort((a, b) => {
                            const sa = userMatchStats[a.userId] ?? { exact: 0, margin: 0, ou: 0 }
                            const sb = userMatchStats[b.userId] ?? { exact: 0, margin: 0, ou: 0 }
                            return sb.exact - sa.exact || sb.margin - sa.margin || sb.ou - sa.ou
                          })
                          .map((u, i) => {
                            const s = userMatchStats[u.userId] ?? { exact: 0, margin: 0, ou: 0 }
                            const isMe = u.userId === currentUserId
                            return (
                              <tr key={u.userId} style={{ background: isMe ? '#f0f4ff' : i % 2 === 0 ? '#fff' : '#f9f9f9', fontWeight: isMe ? 700 : 400 }}>
                                <td style={{ padding: '5px 10px', borderBottom: '1px solid #f0f0f0' }}>{getDisplayName(u)}{isMe ? ' ✦' : ''}</td>
                                <td style={{ padding: '5px 8px', textAlign: 'center', borderBottom: '1px solid #f0f0f0', color: s.exact > 0 ? '#1a7a44' : '#bbb', fontWeight: s.exact > 0 ? 700 : 400 }}>{s.exact}</td>
                                <td style={{ padding: '5px 8px', textAlign: 'center', borderBottom: '1px solid #f0f0f0', color: s.margin > 0 ? '#185FA5' : '#bbb', fontWeight: s.margin > 0 ? 700 : 400 }}>{s.margin}</td>
                                <td style={{ padding: '5px 8px', textAlign: 'center', borderBottom: '1px solid #f0f0f0', color: s.ou > 0 ? '#7c3aed' : '#bbb', fontWeight: s.ou > 0 ? 700 : 400 }}>{s.ou}</td>
                              </tr>
                            )
                          })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── Champion picks ───────────────────────────────────────── */}
      {tab === 'champion' && (
        <div>
          {championData.length === 0 ? (
            <div style={{ color: '#aaa', fontSize: 13, textAlign: 'center', padding: '40px 0' }}>לא הוגשו ניחושי אלוף עדיין</div>
          ) : (
            <>
              {actualBonus?.q105 && (
                <div style={{ marginBottom: 12, padding: '8px 14px', background: '#EAF3DE', borderRadius: 8, fontSize: 13, color: '#27500A', fontWeight: 600, display: 'inline-block' }}>
                  ✓ האלוף בפועל: <><Flag emoji={FLAGS[actualBonus.q105]??''} size={22} /> {actualBonus.q105}</>
                </div>
              )}
              <div style={{ fontSize: 12, color: '#aaa', marginBottom: 12 }}>סה״כ {users.filter(u => u.bonus?.q105).length} ניחושים</div>
              <ResponsiveContainer width="100%" height={Math.max(200, championData.length * 44)}>
                <BarChart data={championData} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#eee" />
                  <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: '#888' }} />
                  <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 12, fill: '#444' }} />
                  <Tooltip formatter={(v: any) => [`${v} מהמרים`, 'ניחושים']} />
                  <Bar dataKey="ניחושים" radius={[0, 6, 6, 0]}>
                    {championData.map((d, i) => <Cell key={i} fill={d.fill} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </>
          )}
        </div>
      )}

      {/* ── Match consensus ──────────────────────────────────────── */}
      {tab === 'consensus' && (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, fontSize: 12, color: '#666', flexWrap: 'wrap' }}>
            {[[COLORS.green, 'ניחוש נכון'], [COLORS.coral, 'ניחוש שגוי'], [COLORS.teal, '≥70% הסכמה'], [COLORS.gray, 'מחלוקת']].map(([c, l]) => (
              <span key={l} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: c, display: 'inline-block' }} />
                {l}
              </span>
            ))}
          </div>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={consensusData} margin={{ bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eee" />
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#888' }} interval={5} />
              <YAxis domain={[0, 100]} tickFormatter={v => `${v}%`} tick={{ fontSize: 11, fill: '#888' }} />
              <Tooltip
                formatter={(v: any) => [`${v}%`, 'הסכמה']}
                labelFormatter={(label: any) => {
                  const d = consensusData.find((x: any) => x.name === label)
                  return d?.fullName ?? label
                }}
              />
              <Bar dataKey="הסכמה" radius={[3, 3, 0, 0]}>
                {consensusData.map((d: any, i: number) => <Cell key={i} fill={d.fill} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ── My position ──────────────────────────────────────────── */}
      {tab === 'myposition' && (
        <div>
          {!currentUserId ? (
            <div style={{ color: '#aaa', fontSize: 13, textAlign: 'center', padding: '40px 0' }}>יש להתחבר כדי לראות את המצב שלך</div>
          ) : !myPositionData ? (
            <div style={{ color: '#aaa', fontSize: 13, textAlign: 'center', padding: '40px 0' }}>אין עדיין מספיק נתונים</div>
          ) : (
            <>
              {myRank && (
                <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
                  {[
                    { label: 'מיקום', value: `${myRank} / ${Object.keys(scoreBreakdown).length}`, color: myRank <= 3 ? '#B8860B' : '#1a1a2e' },
                    { label: 'סה״כ נקודות', value: scoreBreakdown[currentUserId]?.total ?? 0, color: '#1a7a44' },
                    { label: 'פער מהמוביל', value: Math.max(0, leaderTotal - (scoreBreakdown[currentUserId]?.total ?? 0)), color: '#c0392b' },
                  ].map((s, i) => (
                    <div key={i} style={{ background: '#f8f9fa', borderRadius: 10, padding: '12px 20px', textAlign: 'center', flex: 1, minWidth: 100 }}>
                      <div style={{ fontSize: 22, fontWeight: 700, color: s.color }}>{s.value}</div>
                      <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{s.label}</div>
                    </div>
                  ))}
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, marginBottom: 12, fontSize: 12, color: '#666' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: COLORS.blue, display: 'inline-block' }} />אני</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: COLORS.gray, display: 'inline-block' }} />ממוצע קבוצה</span>
              </div>

              <ResponsiveContainer width="100%" height={300}>
                <RadarChart data={myPositionData}>
                  <PolarGrid stroke="#e0e0e0" />
                  <PolarAngleAxis dataKey="subject" tick={{ fontSize: 12, fill: '#555' }} />
                  <Radar name="אני" dataKey="אני" stroke={COLORS.blue} fill={COLORS.blue} fillOpacity={0.25} />
                  <Radar name="ממוצע" dataKey="ממוצע" stroke={COLORS.gray} fill={COLORS.gray} fillOpacity={0.15} />
                  <Tooltip content={<CustomTooltip />} />
                </RadarChart>
              </ResponsiveContainer>
            </>
          )}
        </div>
      )}

      {tab === 'bonus' && (
        <BonusStatusTab
          users={users}
          adminResults={adminResults}
          playerStats={playerStats}
          getDisplayName={getDisplayName}
        />
      )}
    </div>
  )
}
