import { useState, useEffect, useCallback, useRef } from 'react'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { db } from '../firebase'
import { useAuth, isAppOpen } from '../hooks/useAuth'
import { MATCHES, GROUPS_TEAMS, BONUS_QUESTIONS, FLAGS, MATCH_SCHEDULE } from '../data/matches'
import { MatchPrediction, GroupPrediction, BonusPredictions, Group, Category } from '../types'
import { calc1X2Points, calcOverUnder } from '../scoring'

const MAX_RED_CARDS = 6
const GROUPS = 'ABCDEFGHIJKL'.split('') as Group[]

type Tab = 'matches' | 'groups' | 'bonus'

function calcMaxPoints(
  pred: MatchPrediction,
  category: Category,
  fifaPointsA: number,
  fifaPointsB: number
): { total: number; breakdown: string[] } {
  if (!pred.prediction1X2) return { total: 0, breakdown: [] }
  const breakdown: string[] = []
  const catIdx = ({ A: 0, B: 1, C: 2, D: 3 } as Record<string, number>)[category]
  const aIsFav = fifaPointsA >= fifaPointsB

  let pts1x2 = 0
  if (pred.prediction1X2 === 'X') {
    pts1x2 = [1, 1, 2, 3][catIdx]
  } else {
    const predFavWins =
      (pred.prediction1X2 === '1' && aIsFav) ||
      (pred.prediction1X2 === '2' && !aIsFav)
    pts1x2 = predFavWins ? 1 : [1, 2, 3, 4][catIdx]
  }
  breakdown.push(`1X2: ${pts1x2}`)

  let ptsScore = 0
  if (pred.scoreA !== null && pred.scoreA !== undefined &&
      pred.scoreB !== null && pred.scoreB !== undefined) {
    const total = (pred.scoreA ?? 0) + (pred.scoreB ?? 0)
    const isOverUnder = calcOverUnder(total, category)
    if (isOverUnder) {
      const ouLabel = total <= (category === 'A' || category === 'B' ? 1 : 2) ? 'אנדר: 1' : 'אובר: 1'
      ptsScore = 4
      breakdown.push(`תוצאה מדויקת: 2 (הפרש: 1) | ${ouLabel}`)
    } else {
      ptsScore = 3
      breakdown.push('תוצאה מדויקת: 2 (הפרש: 1)')
    }
  }

  let ptsRed = 0
  if (pred.redCard) {
    ptsRed = 1
    breakdown.push('כרטיס אדום: 1')
  }

  return { total: pts1x2 + ptsScore + ptsRed, breakdown }
}

// FIFA ranking from tournament teams
const ALL_FIFA: { team: string; pts: number }[] = []
const seenTeams = new Set<string>()
for (const m of MATCHES) {
  if (!seenTeams.has(m.teamA)) { ALL_FIFA.push({ team: m.teamA, pts: m.fifaPointsA }); seenTeams.add(m.teamA) }
  if (!seenTeams.has(m.teamB)) { ALL_FIFA.push({ team: m.teamB, pts: m.fifaPointsB }); seenTeams.add(m.teamB) }
}
ALL_FIFA.sort((a, b) => b.pts - a.pts)
const FIFA_RANK: Record<string, number> = {}
ALL_FIFA.forEach((t, i) => { FIFA_RANK[t.team] = i + 1 })

const CAT_INFO: Record<string, { label: string; color: string; bg: string; desc: string; overUnder: string }> = {
  A: { label: 'קטגוריה A — מאוזן',         color: '#0a6640', bg: '#e1f5ee', desc: 'כל תוצאה = 1 נק׳',       overUnder: 'אנדר: 0–1 | אובר: 4+ שערים' },
  B: { label: 'קטגוריה B — יתרון קל',      color: '#0c447c', bg: '#e6f1fb', desc: 'הפתעה = 2 נק׳',          overUnder: 'אנדר: 0–1 | אובר: 4+ שערים' },
  C: { label: 'קטגוריה C — מועדפת ברורה', color: '#633806', bg: '#faeeda', desc: 'תיקו=2 | הפתעה=3 נק׳',   overUnder: 'אנדר: 0–2 | אובר: 5+ שערים' },
  D: { label: 'קטגוריה D — פער גדול',      color: '#4a1b0c', bg: '#faece7', desc: 'תיקו=3 | הפתעה=4 נק׳',   overUnder: 'אנדר: 0–2 | אובר: 5+ שערים' },
}

function RankingGap({ teamA, teamB, fifaA, fifaB, category }: {
  teamA: string; teamB: string; fifaA: number; fifaB: number; category: Category
}) {
  const info = CAT_INFO[category]
  const rankA = FIFA_RANK[teamA] ?? '?'
  const rankB = FIFA_RANK[teamB] ?? '?'
  const favTeam = fifaA >= fifaB ? teamA : teamB
  const favRank = fifaA >= fifaB ? rankA : rankB

  return (
    <div className="ranking-gap" style={{ background: info.bg, borderColor: info.color + '33' }}>
      <div className="ranking-gap-top">
        <span className="ranking-gap-label" style={{ color: info.color }}>{info.label}</span>
        <span className="ranking-gap-desc" style={{ color: info.color }}>{info.desc}</span>
      </div>
      <div className="ranking-gap-bottom">
        <span className="ranking-fifa" style={{ color: info.color }}>{FLAGS[teamA]} {teamA} <strong>#{rankA}</strong></span>
        <span className="ranking-arrow" style={{ color: info.color }}>מועדפת: {FLAGS[favTeam]} {favTeam} (#{favRank})</span>
        <span className="ranking-fifa" style={{ color: info.color }}>{FLAGS[teamB]} {teamB} <strong>#{rankB}</strong></span>
      </div>
      <div className="ranking-gap-ou" style={{ color: info.color }}>{info.overUnder}</div>
    </div>
  )
}

export default function Predict() {
  const { user } = useAuth()
  const [tab, setTab] = useState<Tab>('matches')
  const [isOpen, setIsOpen] = useState(true)
  const [saving, setSaving] = useState(false)
  const [lastSaved, setLastSaved] = useState<Date | null>(null)
  const [matchPreds, setMatchPreds] = useState<Record<number, MatchPrediction>>({})
  const [groupPreds, setGroupPreds] = useState<Record<Group, GroupPrediction>>({} as any)
  const [bonus, setBonus] = useState<Partial<BonusPredictions>>({})
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const redCardCount = Object.values(matchPreds).filter(p => p.redCard).length

  useEffect(() => {
    if (!user) return
    ;(async () => {
      const open = await isAppOpen()
      setIsOpen(open)
      const snap = await getDoc(doc(db, 'predictions', user.uid))
      if (snap.exists()) {
        const data = snap.data()
        setMatchPreds(data.matches ?? {})
        setGroupPreds(data.groups ?? {})
        setBonus(data.bonus ?? {})
      }
    })()
  }, [user])

  const scheduleSave = useCallback((
    mp: Record<number, MatchPrediction>,
    gp: Record<Group, GroupPrediction>,
    bn: Partial<BonusPredictions>
  ) => {
    if (!user || !isOpen) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      setSaving(true)
      await setDoc(doc(db, 'predictions', user.uid), {
        userId: user.uid, userName: user.displayName,
        matches: mp, groups: gp, bonus: bn, lastUpdated: Date.now(),
      }, { merge: true })
      setSaving(false)
      setLastSaved(new Date())
    }, 1500)
  }, [user, isOpen])

  const updateMatch = (id: number, field: keyof MatchPrediction, value: unknown) => {
    if (!isOpen) return
    setMatchPreds(prev => {
      const updated = {
        ...prev,
        [id]: { ...(prev[id] ?? { matchId: id, prediction1X2: '1' as const, scoreA: null, scoreB: null, redCard: false }), [field]: value } as MatchPrediction
      }
      if (field === 'redCard' && value === true) {
        const newCount = Object.values(updated).filter(p => p.redCard).length
        if (newCount > MAX_RED_CARDS) return prev
      }
      scheduleSave(updated, groupPreds, bonus)
      return updated
    })
  }

  const updateGroup = (group: Group, idx: number, team: string) => {
    if (!isOpen) return
    setGroupPreds(prev => {
      const current = prev[group] ?? { group, advancing: ['', '', ''] as [string, string, string] }
      const adv = [...current.advancing] as [string, string, string]
      const dupIdx = adv.indexOf(team)
      if (dupIdx !== -1 && dupIdx !== idx) adv[dupIdx] = ''
      adv[idx] = team
      const updated = { ...prev, [group]: { group, advancing: adv } }
      scheduleSave(matchPreds, updated, bonus)
      return updated
    })
  }

  const updateBonus = (key: keyof BonusPredictions, val: string) => {
    if (!isOpen) return
    setBonus(prev => {
      const updated = { ...prev, [key]: val }
      scheduleSave(matchPreds, groupPreds, updated)
      return updated
    })
  }

  const matchProgress = Object.values(matchPreds).filter(p => p.prediction1X2).length

  return (
    <div className="page">
      <div className="status-bar">
        {!isOpen && <span className="badge badge-red">ההגשות נסגרו</span>}
        {isOpen && saving && <span className="text-muted">שומר...</span>}
        {isOpen && !saving && lastSaved && <span className="text-muted">נשמר {lastSaved.toLocaleTimeString('he-IL')}</span>}
        <span className="text-muted">משחקים: {matchProgress}/72 • כרטיסים אדומים: {redCardCount}/{MAX_RED_CARDS}</span>
      </div>

      <div className="tabs">
        <button className={tab === 'matches' ? 'tab active' : 'tab'} onClick={() => setTab('matches')}>
          משחקים <span className="badge">{matchProgress}/72</span>
        </button>
        <button className={tab === 'groups' ? 'tab active' : 'tab'} onClick={() => setTab('groups')}>
          עולים מהבית
        </button>
        <button className={tab === 'bonus' ? 'tab active' : 'tab'} onClick={() => setTab('bonus')}>
          בונוס
        </button>
      </div>

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
                      const p: MatchPrediction = matchPreds[match.id] ?? { matchId: match.id, prediction1X2: '1' as const, scoreA: null, scoreB: null, redCard: false }
                      const { total: maxPts, breakdown } = calcMaxPoints(p, match.category, match.fifaPointsA, match.fifaPointsB)
                      return (
                        <div key={match.id} className="match-row">
                          <div className="match-header">
                            <span className="match-datetime">
                              📅 {MATCH_SCHEDULE[match.id] ?? '—'} שעון ישראל
                            </span>
                            <span className="match-num">#{match.id}</span>
                          </div>

                          <RankingGap
                            teamA={match.teamA} teamB={match.teamB}
                            fifaA={match.fifaPointsA} fifaB={match.fifaPointsB}
                            category={match.category}
                          />

                          <div className="match-body">
                            <span className="team-name">
                              <span className="team-flag">{FLAGS[match.teamA] ?? '🏳️'}</span>
                              {match.teamA}
                            </span>
                            <div className="score-inputs">
                              <input className="score-input" type="number" min="0" max="20"
                                value={p.scoreA ?? ''} placeholder="0" disabled={!isOpen}
                                onFocus={e => e.target.select()}
                                onChange={e => updateMatch(match.id, 'scoreA', e.target.value === '' ? null : parseInt(e.target.value))}
                              />
                              <span className="score-sep">–</span>
                              <input className="score-input" type="number" min="0" max="20"
                                value={p.scoreB ?? ''} placeholder="0" disabled={!isOpen}
                                onFocus={e => e.target.select()}
                                onChange={e => updateMatch(match.id, 'scoreB', e.target.value === '' ? null : parseInt(e.target.value))}
                              />
                            </div>
                            <span className="team-name team-name-b">
                              {match.teamB}
                              <span className="team-flag">{FLAGS[match.teamB] ?? '🏳️'}</span>
                            </span>
                          </div>

                          <div className="match-1x2-row">
                            <div className="btn-group-1x2">
                              {(['1', 'X', '2'] as const).map(opt => (
                                <button key={opt}
                                  className={`btn-1x2 ${p.prediction1X2 === opt ? 'selected' : ''}`}
                                  disabled={!isOpen}
                                  onClick={() => updateMatch(match.id, 'prediction1X2', opt)}
                                >
                                  {opt === '1'
                                    ? `${FLAGS[match.teamA] ?? ''} ${match.teamA.slice(0,4)}`
                                    : opt === '2'
                                    ? `${match.teamB.slice(0,4)} ${FLAGS[match.teamB] ?? ''}`
                                    : '✖ תיקו'}
                                </button>
                              ))}
                            </div>
                            <label className={`red-card-label ${p.redCard ? 'checked' : ''} ${!isOpen ? 'disabled' : ''} ${!p.redCard && redCardCount >= MAX_RED_CARDS ? 'maxed' : ''}`}>
                              <input type="checkbox" checked={p.redCard ?? false}
                                disabled={!isOpen || (!p.redCard && redCardCount >= MAX_RED_CARDS)}
                                onChange={e => updateMatch(match.id, 'redCard', e.target.checked)}
                              />
                              🟥 כרטיס אדום
                            </label>
                          </div>

                          {p.prediction1X2 && (
                            <div className="max-pts-bar">
                              <div className="max-pts-bar-top">
                                <span className="max-pts-label">מקסימום אפשרי:</span>
                                <span className="max-pts-value">{maxPts} נק׳</span>
                              </div>
                              <div className="max-pts-breakdown">
                                {breakdown.map((b, i) => <span key={i} className="max-pts-item">{b}</span>)}
                              </div>
                            </div>
                          )}
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

      {tab === 'groups' && (
        <div className="groups-section">
          <p className="hint">בחר 3 נבחרות עולות מכל בית לפי הסדר (1=ראשון, 2=שני, 3=שלישי)</p>
          <p className="hint">מקום מדויק = 2 נק׳ | נבחרת נכונה מקום שגוי = 1 נק׳</p>
          <div className="groups-grid">
            {GROUPS.map(group => {
              const teams = GROUPS_TEAMS[group]
              const gp = groupPreds[group] ?? { group, advancing: ['', '', ''] }
              return (
                <div key={group} className="group-card">
                  <div className="group-card-title">בית {group}</div>
                  {[0, 1, 2].map(idx => (
                    <div key={idx} className="group-slot">
                      <span className="slot-num">{idx + 1}.</span>
                      <select value={gp.advancing[idx] ?? ''} disabled={!isOpen}
                        onChange={e => updateGroup(group, idx, e.target.value)}>
                        <option value="">— בחר —</option>
                        {teams.map(t => <option key={t} value={t}>{FLAGS[t] ?? ''} {t}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {tab === 'bonus' && (
        <div className="bonus-section">
          <p className="hint">שאלות בונוס — ממלאים פעם אחת לפני הטורניר</p>
          {BONUS_QUESTIONS.map(q => (
            <div key={q.id} className="bonus-row">
              <div className="bonus-label">
                {q.label}
                <span className="pts-badge">{q.points} נק׳</span>
                {q.note && <span className="bonus-note">{q.note}</span>}
              </div>
              <BonusInput q={q} value={(bonus as any)[q.id] ?? ''} disabled={!isOpen}
                onChange={val => updateBonus(q.id as keyof BonusPredictions, val)} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function BonusInput({ q, value, disabled, onChange }: {
  q: typeof BONUS_QUESTIONS[number]; value: string; disabled: boolean; onChange: (v: string) => void
}) {
  const allTeams = Object.values(GROUPS_TEAMS).flat()
  if (q.type === 'team') return (
    <select value={value} disabled={disabled} onChange={e => onChange(e.target.value)}>
      <option value="">— בחר נבחרת —</option>
      {[...allTeams].sort().map(t => <option key={t} value={t}>{FLAGS[t] ?? ''} {t}</option>)}
    </select>
  )
  if (q.type === 'group') return (
    <select value={value} disabled={disabled} onChange={e => onChange(e.target.value)}>
      <option value="">— בחר בית —</option>
      {'ABCDEFGHIJKL'.split('').map(g => <option key={g} value={g}>בית {g}</option>)}
    </select>
  )
  if (q.type === 'number') return (
    <input type="number" min="0" max="200" value={value} placeholder="הכנס מספר..."
      disabled={disabled} onFocus={e => e.target.select()} onChange={e => onChange(e.target.value)} />
  )
  return (
    <input type="text" placeholder="שם שחקן..." value={value}
      disabled={disabled} onChange={e => onChange(e.target.value)} />
  )
}
