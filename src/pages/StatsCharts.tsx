import { useState, useMemo } from 'react'
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Legend,
  RadarChart, PolarGrid, PolarAngleAxis, Radar,
} from 'recharts'
import { MATCHES, BONUS_QUESTIONS, FLAGS } from '../data/matches'
import { Match } from '../types'

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
  currentUserId?: string
  getDisplayName: (u: UserData) => string
}

type ChartTab = 'distribution' | 'scores' | 'champion' | 'consensus' | 'myposition'

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

export default function StatsCharts({ users, adminResults, actualBonus, scoreBreakdown, currentUserId, getDisplayName }: Props) {
  const [tab, setTab]               = useState<ChartTab>('distribution')
  const [selectedMatchId, setSelectedMatchId] = useState<number>(MATCHES[0]?.id ?? 1)

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
    const sorted = Object.entries(scoreBreakdown).sort((a, b) => b[1].total - a[1].total)
    const idx = sorted.findIndex(([uid]) => uid === currentUserId)
    return idx >= 0 ? idx + 1 : null
  }, [currentUserId, scoreBreakdown])

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
            style={{ marginBottom: 16, width: '100%', maxWidth: 360, padding: '8px 12px', borderRadius: 8, border: '1px solid #ddd', fontFamily: 'inherit', fontSize: 13 }}>
            {MATCHES.map(m => (
              <option key={m.id} value={m.id}>
                #{m.id} {m.teamA} נגד {m.teamB}{adminResults[m.id]?.isPlayed ? ' ✓' : ''}
              </option>
            ))}
          </select>

          {distributionData && (
            <>
              {distributionData.actual && (
                <div style={{ marginBottom: 12, padding: '8px 14px', background: '#EAF3DE', borderRadius: 8, fontSize: 13, color: '#27500A', fontWeight: 600, display: 'inline-block' }}>
                  בפועל: {adminResults[selectedMatchId].resultA}:{adminResults[selectedMatchId].resultB}
                  {' → '}{distributionData.actual === '1' ? distributionData.match.teamA : distributionData.actual === '2' ? distributionData.match.teamB : 'תיקו'}
                </div>
              )}

              <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
                <ResponsiveContainer width={220} height={220}>
                  <PieChart>
                    <Pie data={distributionData.pie} cx="50%" cy="50%" innerRadius={55} outerRadius={90}
                      dataKey="value" paddingAngle={3}>
                      {distributionData.pie.map((_, i) => (
                        <Cell key={i} fill={PIE_COLORS[i]} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(v: any) => [`${v} מהמרים (${Math.round(v / distributionData.totalPreds * 100)}%)`, '']} />
                  </PieChart>
                </ResponsiveContainer>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {distributionData.pie.map((d, i) => {
                    const pct = Math.round(d.value / distributionData.totalPreds * 100)
                    const isWinner = d.key === distributionData.actual
                    return (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={{ width: 12, height: 12, borderRadius: 3, background: PIE_COLORS[i], flexShrink: 0 }} />
                        <div style={{ minWidth: 140, fontSize: 13, fontWeight: isWinner ? 700 : 400, color: isWinner ? '#1a7a44' : '#333' }}>
                          {d.name} {isWinner && '✓'}
                        </div>
                        <div style={{ width: 120, height: 8, background: '#f0f0f0', borderRadius: 4, overflow: 'hidden' }}>
                          <div style={{ width: `${pct}%`, height: 8, background: PIE_COLORS[i], borderRadius: 4 }} />
                        </div>
                        <div style={{ fontSize: 13, color: '#555', minWidth: 60 }}>{pct}% ({d.value})</div>
                      </div>
                    )
                  })}
                  <div style={{ fontSize: 12, color: '#aaa', marginTop: 4 }}>{distributionData.totalPreds} מהמרים</div>
                </div>
              </div>
            </>
          )}
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
                  ✓ האלוף בפועל: {FLAGS[actualBonus.q105] ?? ''} {actualBonus.q105}
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
                    { label: 'פער מהמוביל', value: Math.max(0, (Object.values(scoreBreakdown)[0]?.total ?? 0) - (scoreBreakdown[currentUserId]?.total ?? 0)), color: '#c0392b' },
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
    </div>
  )
}
