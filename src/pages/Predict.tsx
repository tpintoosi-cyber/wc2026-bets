import { useState, useEffect, useCallback, useRef } from 'react'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { db } from '../firebase'
import { useAuth, isAppOpen } from '../hooks/useAuth'
import { MATCHES, GROUPS_TEAMS, BONUS_QUESTIONS, FLAGS, MATCH_SCHEDULE, TEAM_EN, KNOCKOUT_MATCHES, KNOCKOUT_ROUND_LABELS, ALL_TEAMS, KNOCKOUT_BRACKET, TEAM_FIFA_POINTS, calcCategory, calcCategoryByRound } from '../data/matches'
import { MatchPrediction, GroupPrediction, BonusPredictions, Group, Category, KnockoutMatchPrediction, Result1X2 } from '../types'
import { calc1X2Points, calcOverUnder, calcAdvancePoints } from '../scoring'
import { T, Lang, Translations, BONUS_QUESTIONS_EN } from '../i18n'

const MAX_RED_CARDS = 6
const GROUPS = 'ABCDEFGHIJKL'.split('') as Group[]

type Tab = 'matches' | 'groups' | 'bonus' | 'knockout'

function calcMaxPoints(
  pred: MatchPrediction,
  category: Category,
  fifaPointsA: number,
  fifaPointsB: number,
  t: Translations
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
  breakdown.push(`${t.score1x2}: ${pts1x2}`)

  let ptsScore = 0
  if (pred.scoreA !== null && pred.scoreA !== undefined &&
      pred.scoreB !== null && pred.scoreB !== undefined) {
    const total = (pred.scoreA ?? 0) + (pred.scoreB ?? 0)
    const isOverUnder = calcOverUnder(total, category)
    if (isOverUnder) {
      const ouLabel = total <= (category === 'A' || category === 'B' ? 1 : 2)
        ? `${t.under}: 1` : `${t.over}: 1`
      ptsScore = 3
      breakdown.push(`${t.exactScore}: 2 (הפרש: 1) | ${ouLabel}`)
    } else {
      ptsScore = 2
      breakdown.push(`${t.exactScore}: 2 (הפרש: 1)`)
    }
  }

  let ptsRed = 0
  if (pred.redCard) {
    ptsRed = 2
    breakdown.push(`${t.redCard}: 2`)
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

const CAT_COLORS = {
  A: { color: '#0a6640', bg: '#e1f5ee' },
  B: { color: '#0c447c', bg: '#e6f1fb' },
  C: { color: '#633806', bg: '#faeeda' },
  D: { color: '#4a1b0c', bg: '#faece7' },
}

function RankingGap({ teamA, teamB, fifaA, fifaB, category, t, tn }: {
  teamA: string; teamB: string; fifaA: number; fifaB: number; category: Category
  t: Translations; tn: (name: string) => string
}) {
  const { color, bg } = CAT_COLORS[category]
  const rankA = FIFA_RANK[teamA] ?? '?'
  const rankB = FIFA_RANK[teamB] ?? '?'
  const favTeam = fifaA >= fifaB ? teamA : teamB
  const favRank = fifaA >= fifaB ? rankA : rankB
  const label = t[`cat${category}` as keyof Translations] as string
  const desc = t[`catDesc${category}` as keyof Translations] as string
  const ou = (category === 'A' || category === 'B') ? t.ouAB : t.ouCD

  return (
    <div className="ranking-gap" style={{ background: bg, borderColor: color + '33' }}>
      <div className="ranking-gap-top">
        <span className="ranking-gap-label" style={{ color }}>{label}</span>
        <span className="ranking-gap-desc" style={{ color }}>{desc}</span>
      </div>
      <div className="ranking-gap-bottom">
        <span className="ranking-fifa" style={{ color }}>{FLAGS[teamA]} {tn(teamA)} <strong>#{rankA}</strong></span>
        <span className="ranking-arrow" style={{ color }}>{t.favoriteLabel}: {FLAGS[favTeam]} {tn(favTeam)} (#{favRank})</span>
        <span className="ranking-fifa" style={{ color }}>{FLAGS[teamB]} {tn(teamB)} <strong>#{rankB}</strong></span>
      </div>
      <div className="ranking-gap-ou" style={{ color }}>{ou}</div>
    </div>
  )
}

export default function Predict({ lang }: { lang: Lang }) {
  const { user } = useAuth()
  const t = T[lang]
  const [tab, setTab] = useState<Tab>('matches')
  const [isOpen, setIsOpen] = useState(true)
  const [groupDeadline, setGroupDeadline] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [lastSaved, setLastSaved] = useState<Date | null>(null)
  const [matchPreds, setMatchPreds] = useState<Record<number, MatchPrediction>>({})
  const [groupPreds, setGroupPreds] = useState<Record<Group, GroupPrediction>>({} as any)
  const [bonus, setBonus] = useState<Partial<BonusPredictions>>({})
  const [knockoutPreds, setKnockoutPreds] = useState<Record<number, KnockoutMatchPrediction>>({})
  const [knockoutRedCards, setKnockoutRedCards] = useState<{ R32: number[]; R16: number[]; QF: number[] }>({ R32: [], R16: [], QF: [] })
  const [knockoutOpen, setKnockoutOpen] = useState(false)
  const [knockoutDeadline, setKnockoutDeadline] = useState<number | null>(null)
  const [r16Deadline, setR16Deadline] = useState<number | null>(null)
  const [qfDeadline, setQfDeadline] = useState<number | null>(null)
  const [sfDeadline, setSfDeadline] = useState<number | null>(null)
  const [finalDeadline, setFinalDeadline] = useState<number | null>(null)
  const [knockoutMatches, setKnockoutMatches] = useState<Record<number, any>>({})
  const [knockoutView, setKnockoutView] = useState<'bracket' | 'form'>('bracket')
  const [focusMatchId, setFocusMatchId] = useState<number | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Nickname
  const [nickname, setNickname] = useState('')
  const [editingNick, setEditingNick] = useState(false)
  const [nickInput, setNickInput] = useState('')

  const saveNickname = async () => {
    if (!user) return
    const nick = nickInput.trim()
    setNickname(nick)
    setEditingNick(false)
    await setDoc(doc(db, 'predictions', user.uid), { nickname: nick }, { merge: true })
  }

  // Helper: team name in current language
  const tn = (hebrewName: string) => lang === 'en' ? (TEAM_EN[hebrewName] ?? hebrewName) : hebrewName

  // Live schedule from Firestore (synced from API), fallback to static
  const [liveSchedule, setLiveSchedule] = useState<Record<number, string>>({})
  const getMatchTime = (id: number) => liveSchedule[id] ?? MATCH_SCHEDULE[id] ?? '—'

  const redCardCount = Object.values(matchPreds).filter(p => p.redCard).length

  useEffect(() => {
    if (!user) return
    ;(async () => {
      const open = await isAppOpen()
      setIsOpen(open)
      const snap = await getDoc(doc(db, 'predictions', user.uid))
      if (snap.exists()) {
        const data = snap.data()
        setMatchPreds(
          Object.fromEntries(
            Object.entries(data.matches ?? {}).map(([k, m]: [string, any]) => [
              Number(k),
              { ...m, scoreA: m.scoreA ?? 0, scoreB: m.scoreB ?? 0 }
            ])
          )
        )
        setGroupPreds(data.groups ?? {})
        setBonus(data.bonus ?? {})
        if (data.nickname) { setNickname(data.nickname); setNickInput(data.nickname) }
        else setNickInput(user.displayName ?? '')
      } else {
        setNickInput(user.displayName ?? '')
      }
      // Load live schedule from Firestore if available
      try {
        const schedSnap = await getDoc(doc(db, 'admin', 'schedule'))
        if (schedSnap.exists()) {
          setLiveSchedule(schedSnap.data().schedule ?? {})
        }
      } catch {
        // fallback to static schedule
      }
      // Load knockout settings + match data
      try {
        const [koSnap, settingsSnap] = await Promise.all([
          getDoc(doc(db, 'admin', 'knockout')),
          getDoc(doc(db, 'settings', 'app')),
        ])
        if (koSnap.exists()) {
          const raw = koSnap.data().matches ?? {}
          const normalized: Record<number, any> = {}
          for (const [k, v] of Object.entries(raw)) normalized[Number(k)] = v
          setKnockoutMatches(normalized)
        }
        if (settingsSnap.exists()) {
          const d = settingsSnap.data()
          setKnockoutOpen(d.knockoutOpen ?? false)
          setKnockoutDeadline(d.knockoutDeadline ?? null)
          setGroupDeadline(d.deadline ?? null)
          setR16Deadline(d.r16Deadline ?? null)
          setQfDeadline(d.qfDeadline ?? null)
          setSfDeadline(d.sfDeadline ?? null)
          setFinalDeadline(d.finalDeadline ?? null)
        }
      } catch { /* ignore */ }
      // Load saved knockout predictions
      if (snap.exists() && snap.data().knockout) {
        const ko = snap.data().knockout
        setKnockoutPreds(
          Object.fromEntries(
            Object.entries(ko).map(([k, m]: [string, any]) => [
              Number(k),
              { ...m, scoreA: m.scoreA ?? 0, scoreB: m.scoreB ?? 0 }
            ])
          )
        )
      }
      if (snap.exists() && snap.data().knockoutRedCards) {
        setKnockoutRedCards(snap.data().knockoutRedCards)
      }
    })()
  }, [user])

  const scheduleSave = useCallback((
    mp: Record<number, MatchPrediction>,
    gp: Record<Group, GroupPrediction>,
    bn: Partial<BonusPredictions>,
    ko?: Record<number, KnockoutMatchPrediction>,
    koRed?: { R32: number[]; R16: number[]; QF: number[] }
  ) => {
    if (!user || !isOpen) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      setSaving(true)
      await setDoc(doc(db, 'predictions', user.uid), {
        userId: user.uid, userName: user.displayName,
        matches: mp, groups: gp, bonus: bn,
        ...(ko !== undefined ? { knockout: ko } : {}),
        ...(koRed !== undefined ? { knockoutRedCards: koRed } : {}),
        lastUpdated: Date.now(),
      }, { merge: true })
      setSaving(false)
      setLastSaved(new Date())
    }, 1500)
  }, [user, isOpen])

  const updateMatch = (id: number, field: keyof MatchPrediction, value: unknown) => {
    if (!isOpen) return
    setMatchPreds(prev => {
      const base = prev[id] ?? { matchId: id, scoreA: 0, scoreB: 0, redCard: false }
      const entry = { ...base, [field]: value } as MatchPrediction
      // When changing a score, ensure the other score defaults to 0
      if (field === 'scoreA' && (entry.scoreB === null || entry.scoreB === undefined)) entry.scoreB = 0
      if (field === 'scoreB' && (entry.scoreA === null || entry.scoreA === undefined)) entry.scoreA = 0
      const updated = { ...prev, [id]: entry }
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

  const updateKnockout = (id: number, field: keyof KnockoutMatchPrediction, value: unknown) => {
    // Allow advance picks from bracket always (they just update local state for display)
    // Only block score/1x2 inputs when window is closed
    const isAdvancePick = field === 'advance'
    if (!isAdvancePick) {
      if (!knockoutOpen) return
      const koDeadlinePassed = knockoutDeadline && Date.now() > knockoutDeadline
      if (koDeadlinePassed) return
    }
    setKnockoutPreds(prev => {
      const base = prev[id] ?? { matchId: id, scoreA: 0, scoreB: 0 }
      const entry = { ...base, [field]: value } as KnockoutMatchPrediction
      // When changing a score, ensure the other score defaults to 0
      if (field === 'scoreA' && (entry.scoreB === null || entry.scoreB === undefined)) entry.scoreB = 0
      if (field === 'scoreB' && (entry.scoreA === null || entry.scoreA === undefined)) entry.scoreA = 0
      const updated = { ...prev, [id]: entry }
      if (knockoutOpen) scheduleSave(matchPreds, groupPreds, bonus, updated, knockoutRedCards)
      return updated
    })
  }

  const toggleKnockoutRedCard = (round: 'R32' | 'R16' | 'QF', matchId: number) => {
    if (!knockoutOpen) return
    if (knockoutDeadline && Date.now() > knockoutDeadline) return
    const maxPicks = { R32: 3, R16: 2, QF: 1 }[round]
    setKnockoutRedCards(prev => {
      const current = prev[round] ?? []
      let updated: number[]
      if (current.includes(matchId)) {
        updated = current.filter(id => id !== matchId)
      } else if (current.length < maxPicks) {
        updated = [...current, matchId]
      } else {
        return prev // already at max
      }
      const newRed = { ...prev, [round]: updated }
      scheduleSave(matchPreds, groupPreds, bonus, knockoutPreds, newRed)
      return newRed
    })
  }

  const matchProgress = Object.values(matchPreds).filter(p => p.prediction1X2).length

  // Live clock — updates every second
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const formatTimeLeft = (deadline: number | null): { label: string; color: string; icon: string } => {
    if (!deadline) return { label: 'פתוח', color: '#1a7a44', icon: '🟢' }
    const diff = deadline - now
    if (diff <= 0) return { label: 'נעול — לא ניתן לשינוי', color: '#c0392b', icon: '🔒' }
    const d = Math.floor(diff / 86400000)
    const h = Math.floor((diff % 86400000) / 3600000)
    const m = Math.floor((diff % 3600000) / 60000)
    const s = Math.floor((diff % 60000) / 1000)
    if (d > 0) return { label: `נותרו ${d} ימים ו-${h} שעות`, color: '#1a7a44', icon: '🟢' }
    if (h > 0) return { label: `נותרו ${h} שעות ו-${m} דקות`, color: h < 3 ? '#e67e22' : '#1a7a44', icon: h < 3 ? '🟠' : '🟢' }
    return { label: `נותרו ${m}:${String(s).padStart(2, '0')} דקות`, color: '#c0392b', icon: '🔴' }
  }

  const DeadlineBanner = ({ deadline, locked }: { deadline: number | null; locked: boolean }) => {
    const { label, color, icon } = locked
      ? { label: 'נעול — לא ניתן לשינוי', color: '#c0392b', icon: '🔒' }
      : formatTimeLeft(deadline)
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 14px', borderRadius: 10, marginBottom: 12,
        background: locked ? '#FFF5F5' : (deadline && deadline - now < 3600000 ? '#FFF8F0' : '#F0FDF4'),
        border: `1px solid ${locked ? '#FECACA' : (deadline && deadline - now < 3600000 ? '#FED7AA' : '#BBF7D0')}`,
      }}>
        <span style={{ fontSize: 16 }}>{icon}</span>
        <span style={{ fontSize: 13, fontWeight: 600, color }}>{label}</span>
        {!locked && deadline && (
          <span style={{ fontSize: 12, color: '#888', marginRight: 'auto' }}>
            עד {new Date(deadline).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' })}
          </span>
        )}
      </div>
    )
  }

  return (
    <div className="page" dir={lang === 'en' ? 'ltr' : 'rtl'}>
      <div className="status-bar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {!isOpen && <span className="badge badge-red">{t.closed}</span>}
          {isOpen && saving && <span className="text-muted">{t.saving}</span>}
          {isOpen && !saving && lastSaved && <span className="text-muted">{t.saved} {lastSaved.toLocaleTimeString('he-IL')}</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="text-muted">{t.matches}: {matchProgress}/72 • {t.redCards}: {redCardCount}/{MAX_RED_CARDS}</span>
          {/* Nickname editor */}
          {!editingNick ? (
            <button onClick={() => { setNickInput(nickname || user?.displayName || ''); setEditingNick(true) }}
              style={{ fontSize: 12, background: 'none', border: '1px solid #ddd', borderRadius: 6, padding: '2px 8px', cursor: 'pointer', color: '#555', display: 'flex', alignItems: 'center', gap: 4 }}>
              ✏️ {nickname || user?.displayName?.split(' ')[0]}
            </button>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input value={nickInput} onChange={e => setNickInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') saveNickname(); if (e.key === 'Escape') setEditingNick(false) }}
                placeholder="שם תצוגה..."
                style={{ fontSize: 12, padding: '3px 8px', borderRadius: 6, border: '1px solid #1a1a2e', outline: 'none', width: 120 }}
                autoFocus />
              <button onClick={saveNickname} style={{ fontSize: 12, background: '#1a1a2e', color: '#fff', border: 'none', borderRadius: 6, padding: '3px 8px', cursor: 'pointer' }}>שמור</button>
              <button onClick={() => setEditingNick(false)} style={{ fontSize: 12, background: 'none', border: '1px solid #ddd', borderRadius: 6, padding: '3px 8px', cursor: 'pointer' }}>ביטול</button>
            </div>
          )}
        </div>
      </div>

      <div className="tabs">
        <button className={tab === 'matches' ? 'tab active' : 'tab'} onClick={() => setTab('matches')}>
          {t.tabMatches} <span className="badge">{matchProgress}/72</span>
        </button>
        <button className={tab === 'groups' ? 'tab active' : 'tab'} onClick={() => setTab('groups')}>
          {t.tabGroups}
        </button>
        <button className={tab === 'bonus' ? 'tab active' : 'tab'} onClick={() => setTab('bonus')}>
          {t.tabBonus}
        </button>
        {(knockoutOpen || Object.keys(knockoutPreds).length > 0) && (
          <button className={tab === 'knockout' ? 'tab active' : 'tab'} onClick={() => setTab('knockout')}>
            {t.tabKnockout}
            {knockoutOpen && <span className="badge" style={{ background: '#EAF3DE', color: '#3B6D11' }}>פתוח</span>}
          </button>
        )}
      </div>

      {tab === 'matches' && (
        <div className="matches-section">
          <DeadlineBanner deadline={groupDeadline} locked={!isOpen} />
          {[1, 2, 3].map(round => (
            <div key={round}>
              <h2 className="round-title">{t.round} {round}</h2>
              {GROUPS.map(group => {
                const ms = MATCHES.filter(m => m.round === round && m.group === group)
                if (!ms.length) return null
                return (
                  <div key={group} className="group-block">
                    <div className="group-label">{t.group} {group}</div>
                    {ms.map(match => {
                      const p: MatchPrediction = matchPreds[match.id] ?? { matchId: match.id, scoreA: 0, scoreB: 0, redCard: false }
                      const { total: maxPts, breakdown } = p.prediction1X2
                        ? calcMaxPoints(p, match.category, match.fifaPointsA, match.fifaPointsB, t)
                        : { total: 0, breakdown: [] }
                      return (
                        <div key={match.id} className="match-row">
                          <div className="match-header">
                            <span className="match-datetime">
                              🗓 {getMatchTime(match.id) ?? '—'}
                            </span>
                            <span className="match-num">#{match.id}</span>
                          </div>

                          <RankingGap
                            teamA={match.teamA} teamB={match.teamB}
                            fifaA={match.fifaPointsA} fifaB={match.fifaPointsB}
                            category={match.category} t={t} tn={tn}
                          />

                          <div className="match-body">
                            <span className="team-name">
                              <span className="team-flag">{FLAGS[match.teamA] ?? '🏳️'}</span>
                              {tn(match.teamA)}
                            </span>
                            <div className="score-inputs">
                              <input className="score-input" type="number" min="0" max="20"
                                value={p.scoreA ?? 0} placeholder="0" disabled={!isOpen}
                                onFocus={e => e.target.select()}
                                onChange={e => updateMatch(match.id, 'scoreA', e.target.value === '' ? 0 : parseInt(e.target.value))}
                              />
                              <span className="score-sep">–</span>
                              <input className="score-input" type="number" min="0" max="20"
                                value={p.scoreB ?? 0} placeholder="0" disabled={!isOpen}
                                onFocus={e => e.target.select()}
                                onChange={e => updateMatch(match.id, 'scoreB', e.target.value === '' ? 0 : parseInt(e.target.value))}
                              />
                            </div>
                            <span className="team-name team-name-b">
                              <span className="team-flag">{FLAGS[match.teamB] ?? '🏳️'}</span>
                              {tn(match.teamB)}
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
                                    ? `${FLAGS[match.teamA] ?? ''} ${tn(match.teamA).slice(0,5)}`
                                    : opt === '2'
                                    ? `${tn(match.teamB).slice(0,5)} ${FLAGS[match.teamB] ?? ''}`
                                    : t.draw}
                                </button>
                              ))}
                            </div>
                            <label className={`red-card-label ${p.redCard ? 'checked' : ''} ${!isOpen ? 'disabled' : ''} ${!p.redCard && redCardCount >= MAX_RED_CARDS ? 'maxed' : ''}`}>
                              <input type="checkbox" checked={p.redCard ?? false}
                                disabled={!isOpen || (!p.redCard && redCardCount >= MAX_RED_CARDS)}
                                onChange={e => updateMatch(match.id, 'redCard', e.target.checked)}
                              />
                              {t.redCard}
                            </label>
                          </div>

                          {p.prediction1X2 ? (
                            <div className="max-pts-bar">
                              <span className="max-pts-label">מקסימום:</span>
                              <span className="max-pts-value">{maxPts}</span>
                              <span className="max-pts-label">נק׳</span>
                              <div className="max-pts-breakdown">
                                {breakdown.map((b, i) => <span key={i} className="max-pts-item">{b}</span>)}
                              </div>
                            </div>
                          ) : (
                            <div className="max-pts-bar" style={{ opacity: 0.45 }}>
                              <span className="max-pts-label">בחר 1X2 לניקוד</span>
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
          <DeadlineBanner deadline={groupDeadline} locked={!isOpen} />
          <p className="hint">{t.groupsHint1}</p>
          <p className="hint">{t.groupsHint2}</p>
          <div className="groups-grid">
            {GROUPS.map(group => {
              const teams = GROUPS_TEAMS[group]
              const gp = groupPreds[group] ?? { group, advancing: ['', '', ''] }
              return (
                <div key={group} className="group-card">
                  <div className="group-card-title">{t.group} {group}</div>
                  {[0, 1, 2].map(idx => (
                    <div key={idx} className="group-slot">
                      <span className="slot-num">{idx + 1}.</span>
                      <select value={gp.advancing[idx] ?? ''} disabled={!isOpen}
                        onChange={e => updateGroup(group, idx, e.target.value)}>
                        <option value="">{t.selectPlaceholder}</option>
                        {teams.map(tm => <option key={tm} value={tm}>{FLAGS[tm] ?? ''} {tm}</option>)}
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
          <DeadlineBanner deadline={groupDeadline} locked={!isOpen} />
          <p className="hint">{t.bonusHint}</p>
          {BONUS_QUESTIONS.map(q => (
            <div key={q.id} className="bonus-row">
              <div className="bonus-label">
                {lang === 'en' ? (BONUS_QUESTIONS_EN[q.id] ?? q.label) : q.label}
                <span className="pts-badge">{q.points} {t.pts}</span>
                {q.note && lang === 'he' && <span className="bonus-note">{q.note}</span>}
              </div>
              <BonusInput q={q} value={(bonus as any)[q.id] ?? ''} disabled={!isOpen} t={t}
                onChange={val => updateBonus(q.id as keyof BonusPredictions, val)} />
            </div>
          ))}
        </div>
      )}

      {/* ── KNOCKOUT TAB ─────────────────────────────────────────────── */}
      {tab === 'knockout' && (
        <div>
          {/* Status banner */}
          {!knockoutOpen && (
            <div className="lb-pre-tournament" style={{ marginBottom: 12 }}>
              {t.koLocked}
            </div>
          )}
          {knockoutOpen && knockoutDeadline && (
            <div className="lb-pre-tournament" style={{ marginBottom: 12, background: '#EAF3DE', color: '#3B6D11', borderColor: '#b7ddb0' }}>
              {t.koOpen} {new Date(knockoutDeadline).toLocaleString('he-IL')}
            </div>
          )}

          {/* View toggle */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 12, background: '#f8f9fa', borderRadius: 10, padding: 4 }}>
            <button onClick={() => setKnockoutView('bracket')} style={{
              flex: 1, padding: '7px', borderRadius: 8, border: 'none', cursor: 'pointer',
              fontFamily: 'inherit', fontWeight: 600, fontSize: 13,
              background: knockoutView === 'bracket' ? '#1a1a2e' : 'transparent',
              color: knockoutView === 'bracket' ? '#fff' : '#666',
            }}>{t.koBracketView}</button>
            <button onClick={() => { setKnockoutView('form'); setFocusMatchId(null) }} style={{
              flex: 1, padding: '7px', borderRadius: 8, border: 'none', cursor: 'pointer',
              fontFamily: 'inherit', fontWeight: 600, fontSize: 13,
              background: knockoutView === 'form' ? '#1a1a2e' : 'transparent',
              color: knockoutView === 'form' ? '#fff' : '#666',
            }}>{t.koFormView}</button>
          </div>

          {(() => {
            const now = Date.now()
            const isLocked = !knockoutOpen || (knockoutDeadline != null && now > knockoutDeadline)

            // Per-round locking: bracket+R32 use isLocked; later rounds have own deadlines
            const isRoundLocked = (round: string): boolean => {
              if (!knockoutOpen) return true
              switch (round) {
                case 'R32': return knockoutDeadline != null && now > knockoutDeadline
                case 'R16': return r16Deadline != null && now > r16Deadline
                case 'QF':  return qfDeadline  != null && now > qfDeadline
                case 'SF':
                case '3P':  return sfDeadline   != null && now > sfDeadline
                case 'F':   return finalDeadline != null && now > finalDeadline
                default:    return false
              }
            }
            const isFormLocked = isLocked  // kept for bracket advance picks (R32 level)

            const getTeamSafe = (matchId: number, side: 'A' | 'B'): string | undefined => {
              try {
                const bracket = KNOCKOUT_BRACKET[matchId]
                if (!bracket) return undefined
                const feederId = side === 'A' ? bracket.feederA : bracket.feederB
                if (feederId === null) {
                  return side === 'A' ? (knockoutMatches[matchId] as any)?.teamA : (knockoutMatches[matchId] as any)?.teamB
                }
                if (feederId < 0) {
                  const sfId = Math.abs(feederId)
                  const winner = knockoutPreds[sfId]?.advance
                  const sfA = getTeamSafe(sfId, 'A')
                  const sfB = getTeamSafe(sfId, 'B')
                  if (!winner || !sfA || !sfB) return undefined
                  return winner === sfA ? sfB : sfA
                }
                // Prioritize actual result from API/admin sync over user's prediction
                const actualAdv = (knockoutMatches[feederId] as any)?.advanceTeam
                if (actualAdv) return actualAdv
                return knockoutPreds[feederId]?.advance
              } catch { return undefined }
            }

            // ── BRACKET VIEW ────────────────────────────────────────────────
            if (knockoutView === 'bracket') {
              // Bracket half definitions
              // Top: R32 73-80, R16 89-92, QF 97-98, SF 101
              // Bottom: R32 81-88, R16 93-96, QF 99-100, SF 102
              // Center: Final 104, Third 103

              const handleMatchClick = (id: number) => {
                setKnockoutView('form')
                setFocusMatchId(id)
                setTimeout(() => {
                  const el = document.getElementById(`ko-match-${id}`)
                  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
                }, 100)
              }

              const MatchCard = ({ id, compact = false, variant = 'normal' }: { id: number; compact?: boolean; variant?: 'normal' | 'final' | 'third' }) => {
                const tA = getTeamSafe(id, 'A')
                const tB = getTeamSafe(id, 'B')
                const pred = knockoutPreds[id]
                const km = KNOCKOUT_MATCHES.find(m => m.id === id)
                const actual = knockoutMatches[id] as (typeof knockoutMatches)[number] & { resultA?: number; resultB?: number; advanceTeam?: string; hadRedCard?: boolean; isPlayed?: boolean } | undefined

                const ptA = tA ? (TEAM_FIFA_POINTS[tA] ?? 1500) : 1500
                const ptB = tB ? (TEAM_FIFA_POINTS[tB] ?? 1500) : 1500
                const dynCat = km ? calcCategoryByRound(ptA, ptB, km.round) : 'A'
                const catIdx = { A: 0, B: 1, C: 2, D: 3 }[dynCat]
                const aIsFav = ptA >= ptB

                const isPlayed = !!(actual?.isPlayed && actual.resultA !== undefined && actual.resultB !== undefined)
                const actualA = isPlayed ? actual!.resultA! : undefined
                const actualB = isPlayed ? actual!.resultB! : undefined
                const actualAdvance = actual?.advanceTeam
                const actualResult = isPlayed ? (actualA! > actualB! ? '1' : actualA! < actualB! ? '2' : 'X') : undefined
                const actualWinner = actualResult === '1' ? tA : actualResult === '2' ? tB : null

                const hasPred = !!(pred?.prediction1X2)
                const hasScore = pred?.scoreA !== null && pred?.scoreA !== undefined
                const predResult = hasPred ? pred!.prediction1X2 : null

                // Red card pick (needs to be before points calculation)
                const roundKey = km?.round as 'R32' | 'R16' | 'QF' | undefined
                const pickedRedCard = roundKey && ['R32','R16','QF'].includes(roundKey)
                  ? (knockoutRedCards[roundKey as 'R32'|'R16'|'QF'] ?? []).includes(id)
                  : false

                const hasSomePred = hasPred || hasScore || !!(pred?.advance) || pickedRedCard

                // Points earned (only when played)
                let pts1x2 = 0, ptsScore = 0, ptsAdv = 0, ptsRedCard = 0
                if (isPlayed && hasSomePred && km) {
                  if (hasPred) {
                    pts1x2 = (() => {
                      if (!predResult || actualResult === undefined) return 0
                      if (predResult !== actualResult) return 0
                      const base = ({ R32: 1, R16: 1, QF: 2, SF: 3, '3P': 2, F: 3 } as Record<string, number>)[km.round]
                      const catBonus = { A: 0, B: 1, C: 2, D: 3 }[dynCat] ?? 0
                      if (actualResult === 'X') return base + Math.max(0, catBonus - 1)
                      const favWon = (actualResult === '1' && aIsFav) || (actualResult === '2' && !aIsFav)
                      return favWon ? base : base + catBonus
                    })()
                  }
                  if (hasScore && pred!.scoreA !== null && pred!.scoreB !== null) {
                    const pA = Number(pred!.scoreA), pB = Number(pred!.scoreB)
                    if (pA === actualA && pB === actualB) {
                      const total = actualA! + actualB!
                      const ouPts = ({ R32: 1, R16: 1, QF: 2, SF: 2, '3P': 1, F: 2 } as Record<string, number>)[km.round]
                      const ouQ = km.round === 'F' ? (total === 0 || total >= 4) : km.round === '3P' ? (total <= 2 || total >= 5) : catIdx <= 1 ? (total <= 1 || total >= 4) : (total <= 2 || total >= 5)
                      ptsScore = 2 + (ouQ ? ouPts : 0)
                    } else if ((pA - pB) === (actualA! - actualB!)) {
                      ptsScore = 1
                    }
                  }
                  if (pred?.advance && actualAdvance) {
                    if (pred.advance === actualAdvance) {
                      const pickedUnderdog = (pred.advance === tA && !aIsFav) || (pred.advance === tB && aIsFav)
                      const base = ({ R32: 1, R16: 2, QF: 3, SF: 4, '3P': 2, F: 5 } as Record<string, number>)[km.round]
                      const catBonus = { A: 0, B: 1, C: 2, D: 2 }[dynCat] ?? 0
                      ptsAdv = base + (pickedUnderdog ? catBonus : 0)
                    }
                  }
                  // Red card points
                  if (pickedRedCard) {
                    ptsRedCard = actual?.hadRedCard ? 2 : 0
                  }
                }

                // Prediction OU label
                let predOuLabel: string | null = null
                if (hasScore && km && pred!.scoreA !== null && pred!.scoreB !== null) {
                  const goalTotal = Number(pred!.scoreA) + Number(pred!.scoreB)
                  const isOU = km.round === 'F' ? (goalTotal === 0 || goalTotal >= 4) : km.round === '3P' ? (goalTotal <= 2 || goalTotal >= 5) : catIdx <= 1 ? (goalTotal <= 1 || goalTotal >= 4) : (goalTotal <= 2 || goalTotal >= 5)
                  if (isOU) predOuLabel = goalTotal <= (catIdx <= 1 ? 1 : 2) ? t.under : t.over
                }

                // Advance pick
                const advPicked = pred?.advance
                const advA = advPicked === tA && tA
                const advB = advPicked === tB && tB
                const advCorrect = isPlayed && advPicked && advPicked === actualAdvance
                const advWrong = isPlayed && advPicked && advPicked !== actualAdvance

                // Potential advance points (pre-match)
                const potentialAdvPts = (() => {
                  if (!km || !advPicked) return 0
                  const base = ({ R32: 1, R16: 2, QF: 3, SF: 4, '3P': 2, F: 5 } as Record<string, number>)[km.round]
                  const catBonus = { A: 0, B: 1, C: 2, D: 2 }[dynCat]
                  const pickedUnderdog = (advPicked === tA && !aIsFav) || (advPicked === tB && aIsFav)
                  return base + (pickedUnderdog ? catBonus : 0)
                })()

                // 1X2 display label
                const pred1x2Label = predResult === '1' ? (tA ?? '1') : predResult === '2' ? (tB ?? '2') : predResult === 'X' ? t.draw : null
                const pred1x2Flag = predResult === '1' ? (tA ? FLAGS[tA] ?? '' : '') : predResult === '2' ? (tB ? FLAGS[tB] ?? '' : '') : null

                const safeTotal = (pts1x2 || 0) + (ptsScore || 0) + (ptsAdv || 0) + (ptsRedCard || 0)

                const isFinal = variant === 'final'
                const isThird = variant === 'third'
                const isSpecial = isFinal || isThird

                const specialBorder = isFinal
                  ? (isPlayed ? (safeTotal > 0 ? '#B8860B' : '#c0a060') : '#B8860B')
                  : (isPlayed ? (safeTotal > 0 ? '#8B6914' : '#b09060') : '#8B6914')

                const borderColor = isSpecial ? specialBorder
                  : isPlayed ? (safeTotal > 0 ? '#1a7a44' : '#c0c0c0')
                  : (advA || advB ? '#2563EB' : '#d0d0e8')

                const cardBg = isSpecial
                  ? (isFinal ? (isPlayed ? '#FFFDE7' : '#FFFEF5') : (isPlayed ? '#FFF8E1' : '#FFFDF5'))
                  : isPlayed ? (safeTotal > 0 ? '#f2faf5' : '#fafafa')
                  : (advA || advB ? '#EBF4FF' : '#fff')

                const minW = isFinal ? 175 : isThird ? 165 : compact ? 130 : 155
                const maxW = isFinal ? 215 : isThird ? 200 : compact ? 160 : 195

                const headerBg = isSpecial
                  ? (isFinal
                    ? (isPlayed ? 'linear-gradient(135deg, #B8860B, #DAA520)' : 'linear-gradient(135deg, #7a5c00, #B8860B)')
                    : (isPlayed ? 'linear-gradient(135deg, #8B6914, #CD853F)' : 'linear-gradient(135deg, #6b4f00, #8B6914)'))
                  : (isPlayed ? '#1a7a44' : '#4a5568')

                const headerLabel = isFinal ? '🏆 גמר' : isThird ? '🥉 מקום שלישי' : km
                  ? ({ R32: 'שלב 32', R16: 'שמינית', QF: 'רבע', SF: 'חצי', '3P': 'מקום 3', F: 'גמר' } as Record<string, string>)[km.round]
                  : ''

                return (
                  <div
                    id={`bracket-match-${id}`}
                    style={{
                      border: `${isSpecial ? 2.5 : 2}px solid ${borderColor}`,
                      borderRadius: isSpecial ? 12 : 10, overflow: 'hidden',
                      background: cardBg,
                      margin: '2px 3px', flex: 1,
                      minWidth: minW, maxWidth: maxW,
                      boxShadow: isSpecial
                        ? `0 3px 12px rgba(184,134,11,${isPlayed ? '0.25' : '0.15'})`
                        : isPlayed ? '0 1px 4px rgba(0,0,0,0.08)' : 'none',
                    }}
                  >
                    {/* ── HEADER ── */}
                    <div style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: isSpecial ? '5px 9px' : '3px 7px',
                      background: headerBg,
                    }}>
                      <span style={{ fontSize: isSpecial ? 12 : 10, fontWeight: 700, color: '#fff', letterSpacing: 0.5 }}>
                        {headerLabel}
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 4, background: 'rgba(255,255,255,0.2)', color: '#fff', fontWeight: 700 }}>{dynCat}</span>
                        <button
                          onClick={() => handleMatchClick(id)}
                          title="עבור להימור"
                          style={{
                            fontSize: 10, lineHeight: 1, padding: '1px 5px', borderRadius: 4,
                            background: 'rgba(255,255,255,0.15)', color: '#fff',
                            border: '1px solid rgba(255,255,255,0.3)',
                            cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600,
                          }}>✏️</button>
                      </div>
                    </div>

                    {/* ── TEAMS — show my predicted score, click to pick advance ── */}
                    {([['A', tA, advA], ['B', tB, advB]] as [string, string|undefined, string|false|undefined][]).map(([side, team, isAdv]) => {
                      const predScore = side === 'A' ? pred?.scoreA : pred?.scoreB
                      const hasThisScore = predScore !== null && predScore !== undefined
                      return (
                        <div key={side}
                          onClick={() => team && updateKnockout(id, 'advance', team)}
                          style={{
                            display: 'flex', alignItems: 'center',
                            padding: '6px 7px', gap: 5,
                            borderBottom: side === 'A' ? '1px solid #ebebeb' : 'none',
                            background: isAdv ? '#DBEAFE' : 'transparent',
                            cursor: team ? 'pointer' : 'default',
                          }}>
                          <span style={{ fontSize: 15, lineHeight: 1, flexShrink: 0 }}>{team ? (FLAGS[team] ?? '🏳') : ''}</span>
                          <span style={{
                            flex: 1, fontSize: 12, fontWeight: isAdv ? 700 : 500,
                            color: isAdv ? '#1a4fa8' : team ? '#222' : '#ccc',
                            fontStyle: team ? 'normal' : 'italic',
                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                          }}>{team ?? '...'}</span>
                          {hasThisScore && (
                            <span style={{ fontSize: 14, fontWeight: 700, color: isAdv ? '#1a4fa8' : '#555', minWidth: 16, textAlign: 'right' }}>
                              {predScore}
                            </span>
                          )}
                          {isAdv && <span style={{ fontSize: 11, color: '#2563EB', fontWeight: 700, marginRight: 2 }}>●</span>}
                        </div>
                      )
                    })}

                    {/* ── ACTUAL RESULT ROW (when played) ── */}
                    {isPlayed && (
                      <div style={{
                        padding: '4px 7px', borderTop: '2px solid #d0d0d0',
                        background: '#f0f0f0',
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4,
                      }}>
                        <span style={{ fontSize: 10, color: '#666', fontWeight: 600 }}>תוצאה:</span>
                        <span style={{ fontSize: 12, fontWeight: 800, color: '#333' }}>
                          {actualA}:{actualB}
                        </span>
                        {actualAdvance && (
                          <span style={{ fontSize: 10, color: '#333', fontWeight: 600, flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: 4 }}>
                            {FLAGS[actualAdvance] ?? ''} {actualAdvance} →
                          </span>
                        )}
                      </div>
                    )}

                    {/* ── PREDICTION DETAILS (1X2 + O/U + red card) ── */}
                    {hasSomePred && (
                      <div style={{ padding: '4px 7px', display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', background: '#fafbff', borderTop: '1px solid #eeeef8' }}>
                        {pred1x2Label && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                            {isPlayed && (
                              <span style={{ fontSize: 11, color: pts1x2 > 0 ? '#1a7a44' : '#cc3333', fontWeight: 700 }}>
                                {pts1x2 > 0 ? '✓' : '✗'}
                              </span>
                            )}
                            <span style={{ fontSize: 11, padding: '2px 5px', borderRadius: 4, background: '#E6F1FB', color: '#0C447C', fontWeight: 600, whiteSpace: 'nowrap' }}>
                              {pred1x2Flag}{pred1x2Flag ? ' ' : ''}{pred1x2Label}
                            </span>
                            {isPlayed && pts1x2 > 0 && (
                              <span style={{ fontSize: 10, color: '#1a7a44', fontWeight: 700 }}>+{pts1x2}</span>
                            )}
                          </div>
                        )}
                        {predOuLabel && (
                          <span style={{ fontSize: 11, padding: '2px 5px', borderRadius: 4, background: '#F1EFE8', color: '#444', fontWeight: 600 }}>
                            {predOuLabel}
                          </span>
                        )}
                        {isPlayed && hasScore && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                            <span style={{ fontSize: 11, color: ptsScore > 0 ? '#1a7a44' : '#cc3333', fontWeight: 700 }}>
                              {ptsScore > 0 ? '✓' : '✗'} תוצאה
                            </span>
                            {ptsScore > 0 && (
                              <span style={{ fontSize: 10, color: '#1a7a44', fontWeight: 700 }}>+{ptsScore}</span>
                            )}
                          </div>
                        )}
                        {pickedRedCard && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                            {isPlayed && (
                              <span style={{ fontSize: 11, color: ptsRedCard > 0 ? '#1a7a44' : '#cc3333', fontWeight: 700 }}>
                                {ptsRedCard > 0 ? '✓' : '✗'}
                              </span>
                            )}
                            <span style={{ fontSize: 11, padding: '2px 4px', borderRadius: 4, background: '#FCEBEB', color: '#791F1F', fontWeight: 600 }}>🟥</span>
                            {isPlayed && ptsRedCard > 0 && (
                              <span style={{ fontSize: 10, color: '#1a7a44', fontWeight: 700 }}>+{ptsRedCard}</span>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {/* ── ADVANCE PICK ── */}
                    {advPicked ? (() => {
                      const advPickedIsUnderdog = (advPicked === tA && !aIsFav) || (advPicked === tB && aIsFav)
                      const advCorrectWithBonus = advCorrect && advPickedIsUnderdog && ptsAdv > 0
                      const advCorrectBase = advCorrect && !advPickedIsUnderdog && ptsAdv > 0
                      return (
                        <div style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          padding: '4px 7px', gap: 4,
                          background: advCorrect ? '#EAF3DE' : advWrong ? '#FCEBEB' : '#f5f5f5',
                          borderTop: '1px solid #ebebeb',
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            {isPlayed && (
                              <span style={{ fontSize: 12, fontWeight: 700,
                                color: advCorrect ? '#1a7a44' : '#cc3333' }}>
                                {advCorrect ? '✓' : '✗'}
                              </span>
                            )}
                            <span style={{ fontSize: 11, fontWeight: 700,
                              color: advCorrect ? '#1a5c30' : advWrong ? '#8b1f1f' : '#555' }}>
                              {advPicked === tA ? (FLAGS[tA!] ?? '') : (FLAGS[tB!] ?? '')} {advPicked}
                              {isSpecial && advPicked && !isPlayed && (isFinal ? ' 🏆' : ' 🥉')}
                              {isSpecial && advPicked && isPlayed && advCorrect && (isFinal ? ' 🏆' : ' 🥉')}
                            </span>
                          </div>
                          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                            {isPlayed && ptsAdv > 0 && (
                              <span style={{ fontSize: 11, color: '#1a7a44', fontWeight: 700 }}>+{ptsAdv}</span>
                            )}
                            {!isPlayed && (
                              <span style={{ fontSize: 10, padding: '1px 4px', borderRadius: 4,
                                background: advPickedIsUnderdog ? '#DBEAFE' : '#e8f5e9',
                                color: advPickedIsUnderdog ? '#1a4fa8' : '#1a5c30', fontWeight: 700 }}>
                                +{potentialAdvPts}
                              </span>
                            )}
                          </div>
                        </div>
                      )
                    })() : (tA && tB && (
                      <div style={{ padding: '4px 7px', borderTop: '1px solid #f0f0f0', background: '#fafafa' }}>
                        <span style={{ fontSize: 10, color: '#aaa' }}>לחץ לבחירת עולה ←</span>
                      </div>
                    ))}


                    {/* ── TOTAL POINTS (when played) ── */}
                    {isPlayed && hasSomePred && (() => {
                      const safeTotal = (pts1x2 || 0) + (ptsScore || 0) + (ptsAdv || 0) + (ptsRedCard || 0)
                      return safeTotal > 0 ? (
                        <div style={{
                          padding: '3px 7px', background: '#1a7a44',
                          display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 4,
                        }}>
                          <span style={{ fontSize: 11, color: '#fff', fontWeight: 800 }}>סה״כ: +{safeTotal} נק׳</span>
                        </div>
                      ) : (
                        <div style={{
                          padding: '3px 7px', background: '#e8e8e8',
                          display: 'flex', justifyContent: 'center',
                        }}>
                          <span style={{ fontSize: 10, color: '#888' }}>0 נק׳ במשחק זה</span>
                        </div>
                      )
                    })()}
                  </div>
                )
              }

              // RoundSection: groups multiple rows under one bold header
              const RoundSection = ({ label, ids }: { label: string; ids: number[][] }) => (
                <div style={{ margin: '3px 0' }}>
                  <div style={{
                    fontSize: 13, fontWeight: 700, color: '#1a1a2e', textAlign: 'center',
                    padding: '6px 8px', letterSpacing: '0.02em',
                    background: 'linear-gradient(to right, transparent, #f0f0fa, transparent)',
                    borderTop: '1.5px solid #d0d0e8', borderBottom: '1.5px solid #d0d0e8',
                    marginBottom: 4,
                  }}>{label}</div>
                  {ids.map((row, i) => (
                    <div key={i}>
                      {i > 0 && <div style={{ height: 6 }} />}
                      <div style={{ display: 'flex', justifyContent: 'center', flexWrap: 'nowrap', gap: 0, overflowX: 'auto', WebkitOverflowScrolling: 'touch' as any }}>
                        {row.map(id => <MatchCard key={id} id={id} compact={row.length > 4} />)}
                      </div>
                    </div>
                  ))}
                </div>
              )

              const Arrow = ({ dir = 'down' }: { dir?: 'down' | 'up' }) => (
                <div style={{ textAlign: 'center', fontSize: 14, color: '#9090b0', lineHeight: 1, margin: '2px 0', fontWeight: 700 }}>
                  {dir === 'down' ? '↓' : '↑'}
                </div>
              )

              const FinalCard = () => (
                <div style={{ display: 'flex', justifyContent: 'center', margin: '4px 0' }}>
                  <MatchCard id={104} variant="final" />
                </div>
              )

              const ThirdCard = () => (
                <div style={{ display: 'flex', justifyContent: 'center', margin: '3px 0' }}>
                  <MatchCard id={103} variant="third" />
                </div>
              )

              return (
                <div style={{ fontSize: 13, userSelect: 'none' }}>
                  {/* ── Points summary ──────────────────────────────── */}
                  {(() => {
                    // ── MAX POSSIBLE (if all correct) ──
                    let maxPts1x2 = 0, maxPtsScore = 0, maxPtsAdv = 0, maxPtsRC = 0
                    let filledMatches = 0

                    // ── ACTUAL EARNED (played matches only) ──
                    let actPts1x2 = 0, actPtsScore = 0, actPtsAdv = 0, actPtsRC = 0

                    for (const km of KNOCKOUT_MATCHES) {
                      const pred = knockoutPreds[km.id]
                      const tA = getTeamSafe(km.id, 'A')
                      const tB = getTeamSafe(km.id, 'B')
                      if (!tA || !tB) continue

                      const ptA = TEAM_FIFA_POINTS[tA] ?? 1500
                      const ptB = TEAM_FIFA_POINTS[tB] ?? 1500
                      const dynCat = calcCategoryByRound(ptA, ptB, km.round)
                      const catBonus = { A: 0, B: 1, C: 2, D: 3 }[dynCat] ?? 0
                      const roundBase = { R32: 1, R16: 1, QF: 2, SF: 3, '3P': 2, F: 3 }[km.round]
                      const aIsFav = ptA >= ptB
                      const catIdx = { A: 0, B: 1, C: 2, D: 3 }[dynCat]
                      const actual = knockoutMatches[km.id] as any

                      // ── MAX ──
                      if (pred?.prediction1X2) {
                        filledMatches++
                        const predIsX = pred.prediction1X2 === 'X'
                        const pickedFav = (pred.prediction1X2 === '1' && aIsFav) || (pred.prediction1X2 === '2' && !aIsFav)
                        if (predIsX) maxPts1x2 += roundBase + Math.max(0, catBonus - 1)
                        else if (pickedFav) maxPts1x2 += roundBase
                        else maxPts1x2 += roundBase + catBonus

                        if (pred.scoreA !== null && pred.scoreA !== undefined) {
                          const goalTotal = Number(pred.scoreA) + Number(pred.scoreB ?? 0)
                          const ouPts = { R32: 1, R16: 1, QF: 2, SF: 2, '3P': 1, F: 2 }[km.round]
                          const isOU = km.round === 'F' ? (goalTotal === 0 || goalTotal >= 4) : km.round === '3P' ? (goalTotal <= 2 || goalTotal >= 5) : catIdx <= 1 ? (goalTotal <= 1 || goalTotal >= 4) : (goalTotal <= 2 || goalTotal >= 5)
                          maxPtsScore += 2 + (isOU ? ouPts : 0)
                        }
                      }
                      if (pred?.advance) {
                        const advBase = { R32: 1, R16: 2, QF: 3, SF: 4, '3P': 2, F: 5 }[km.round]
                        const advCatBonus = { A: 0, B: 1, C: 2, D: 2 }[dynCat] ?? 0
                        const pickedUnd = (pred.advance === tA && !aIsFav) || (pred.advance === tB && aIsFav)
                        maxPtsAdv += advBase + (pickedUnd ? advCatBonus : 0)
                      }
                      const roundKey = km.round as string
                      if (['R32','R16','QF'].includes(roundKey)) {
                        const picks = knockoutRedCards[roundKey as 'R32'|'R16'|'QF'] ?? []
                        if (picks.includes(km.id)) maxPtsRC += 2
                      }

                      // ── ACTUAL (played only) ──
                      if (!actual?.isPlayed || actual.resultA === undefined) continue
                      const actualA = Number(actual.resultA), actualB = Number(actual.resultB)
                      const actualResult = actualA > actualB ? '1' : actualA < actualB ? '2' : 'X'
                      const actualAdv = actual.advanceTeam

                      if (pred?.prediction1X2 && pred.prediction1X2 === actualResult) {
                        const favWon = (actualResult === '1' && aIsFav) || (actualResult === '2' && !aIsFav)
                        if (actualResult === 'X') actPts1x2 += roundBase + Math.max(0, catBonus - 1)
                        else actPts1x2 += favWon ? roundBase : roundBase + catBonus
                      }
                      if (pred?.scoreA !== null && pred?.scoreA !== undefined && pred?.scoreB !== null) {
                        const pA = Number(pred.scoreA), pB = Number(pred.scoreB)
                        if (pA === actualA && pB === actualB) {
                          const total = actualA + actualB
                          const ouPts = { R32: 1, R16: 1, QF: 2, SF: 2, '3P': 1, F: 2 }[km.round]
                          const isOU = km.round === 'F' ? (total === 0 || total >= 4) : km.round === '3P' ? (total <= 2 || total >= 5) : catIdx <= 1 ? (total <= 1 || total >= 4) : (total <= 2 || total >= 5)
                          actPtsScore += 2 + (isOU ? ouPts : 0)
                        } else if ((pA - pB) === (actualA - actualB)) {
                          actPtsScore += 1
                        }
                      }
                      if (pred?.advance && actualAdv && pred.advance === actualAdv) {
                        const advBase = { R32: 1, R16: 2, QF: 3, SF: 4, '3P': 2, F: 5 }[km.round]
                        const advCatBonus = { A: 0, B: 1, C: 2, D: 2 }[dynCat] ?? 0
                        const pickedUnd = (pred.advance === tA && !aIsFav) || (pred.advance === tB && aIsFav)
                        actPtsAdv += advBase + (pickedUnd ? advCatBonus : 0)
                      }
                      if (['R32','R16','QF'].includes(roundKey)) {
                        const picks = knockoutRedCards[roundKey as 'R32'|'R16'|'QF'] ?? []
                        if (picks.includes(km.id) && actual.hadRedCard) actPtsRC += 2
                      }
                    }

                    const maxTotal = maxPts1x2 + maxPtsScore + maxPtsAdv + maxPtsRC
                    const actTotal = actPts1x2 + actPtsScore + actPtsAdv + actPtsRC
                    const hasActual = actTotal > 0 || Object.values(knockoutMatches).some((m: any) => m?.isPlayed)

                    return (
                      <div style={{ marginBottom: 10, padding: '10px 14px', background: '#f8f9ff', borderRadius: 10, border: '1px solid #e8e8ff' }}>
                        <div style={{ display: 'flex', gap: 12, alignItems: 'stretch', flexWrap: 'wrap' }}>

                          {/* Filled */}
                          <div style={{ minWidth: 80 }}>
                            <div style={{ fontSize: 11, color: '#888', marginBottom: 3 }}>{t.koFilled}</div>
                            <div style={{ fontSize: 18, fontWeight: 700, color: '#1a1a2e' }}>{filledMatches}<span style={{ fontSize: 12, color: '#aaa', fontWeight: 400 }}> / {KNOCKOUT_MATCHES.length}</span></div>
                          </div>

                          <div style={{ width: 1, background: '#e0e0e0', alignSelf: 'stretch' }} />

                          {/* Max possible */}
                          <div style={{ flex: 1, minWidth: 180 }}>
                            <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>מקסימום אם הכל נכון</div>
                            {maxTotal > 0 ? (
                              <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                                <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 5, background: '#E6F1FB', color: '#0C447C', fontWeight: 600 }}>1X2: {maxPts1x2}</span>
                                <span style={{ fontSize: 10, color: '#ccc' }}>+</span>
                                <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 5, background: '#EAF3DE', color: '#27500A', fontWeight: 600 }}>תוצאה: {maxPtsScore}</span>
                                <span style={{ fontSize: 10, color: '#ccc' }}>+</span>
                                <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 5, background: '#FAEEDA', color: '#633806', fontWeight: 600 }}>עולה: {maxPtsAdv}</span>
                                {maxPtsRC > 0 && <>
                                  <span style={{ fontSize: 10, color: '#ccc' }}>+</span>
                                  <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 5, background: '#FCEBEB', color: '#791F1F', fontWeight: 600 }}>🟥 {maxPtsRC}</span>
                                </>}
                                <span style={{ fontSize: 13, fontWeight: 700, color: '#555' }}>≈{maxTotal}</span>
                              </div>
                            ) : <span style={{ fontSize: 14, color: '#aaa' }}>—</span>}
                          </div>

                          {hasActual && <>
                            <div style={{ width: 1, background: '#e0e0e0', alignSelf: 'stretch' }} />

                            {/* Actual earned */}
                            <div style={{ flex: 1, minWidth: 180 }}>
                              <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>נצבר בפועל</div>
                              <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                                <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 5, background: '#E6F1FB', color: '#0C447C', fontWeight: 600 }}>1X2: {actPts1x2}</span>
                                <span style={{ fontSize: 10, color: '#ccc' }}>+</span>
                                <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 5, background: '#EAF3DE', color: '#27500A', fontWeight: 600 }}>תוצאה: {actPtsScore}</span>
                                <span style={{ fontSize: 10, color: '#ccc' }}>+</span>
                                <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 5, background: '#FAEEDA', color: '#633806', fontWeight: 600 }}>עולה: {actPtsAdv}</span>
                                {(actPtsRC > 0 || maxPtsRC > 0) && <>
                                  <span style={{ fontSize: 10, color: '#ccc' }}>+</span>
                                  <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 5, background: '#FCEBEB', color: '#791F1F', fontWeight: 600 }}>🟥 {actPtsRC}</span>
                                </>}
                                <span style={{ fontSize: 14, fontWeight: 800, color: '#1a7a44' }}>= {actTotal}</span>
                              </div>
                            </div>
                          </>}
                        </div>
                      </div>
                    )
                  })()}

                  <div style={{ fontSize: 12, color: '#185FA5', textAlign: 'center', marginBottom: 10, fontWeight: 600, padding: '7px 12px', background: '#EBF4FF', borderRadius: 8, border: '1px solid #d0e8ff' }}>
                    {t.koHint}
                  </div>

                  {/* TOP HALF — converges downward */}
                  <RoundSection label={t.roundR16} ids={[[89,90,91,92]]} />
                  <Arrow dir="down" />
                  <RoundSection label={t.roundQF} ids={[[97,98]]} />
                  <Arrow dir="down" />
                  <RoundSection label={t.roundSF} ids={[[101]]} />
                  <Arrow dir="down" />

                  {/* CENTER */}
                  <FinalCard />
                  <ThirdCard />

                  {/* BOTTOM HALF — converges upward */}
                  <Arrow dir="up" />
                  <RoundSection label={t.roundSF} ids={[[102]]} />
                  <Arrow dir="up" />
                  <RoundSection label={t.roundQF} ids={[[99,100]]} />
                  <Arrow dir="up" />
                  <RoundSection label={t.roundR16} ids={[[93,94,95,96]]} />
                </div>
              )
            }

            // ── FORM VIEW ───────────────────────────────────────────────────
            return (['R32', 'R16', 'QF', 'SF', '3P', 'F'] as const).map(round => {
              const roundMatches = KNOCKOUT_MATCHES.filter(m => m.round === round)
              const redCardRounds = { R32: 3, R16: 2, QF: 1 } as Record<string, number>
              const maxRedCards = redCardRounds[round]
              const redCardPicks = maxRedCards ? (knockoutRedCards[round as 'R32' | 'R16' | 'QF'] ?? []) : []
              const hasRedCard = round === 'R32' || round === 'R16'
              const roundLocked = isRoundLocked(round)

              // Deadline display for this round
              const roundDeadlineTs: number | null =
                round === 'R32' ? knockoutDeadline :
                round === 'R16' ? r16Deadline :
                round === 'QF'  ? qfDeadline :
                (round === 'SF' || round === '3P') ? sfDeadline :
                round === 'F'   ? finalDeadline : null

              return (
                <div key={round}>
                  <h2 className="round-title">{KNOCKOUT_ROUND_LABELS[round]}</h2>
                  <DeadlineBanner deadline={roundDeadlineTs} locked={roundLocked} />

                  {/* Red card picks — per round */}
                  {maxRedCards && (
                    <div style={{ margin: '0 0 12px', padding: '10px 14px', background: '#fff5f5', border: '1px solid #fdd', borderRadius: 10 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: '#A32D2D', marginBottom: 8 }}>
                        🟥 בחר {maxRedCards} {maxRedCards === 1 ? 'משחק' : 'משחקים'} שיהיה בהם כרטיס אדום
                        <span style={{ fontWeight: 400, color: '#999', marginRight: 6 }}>({redCardPicks.length}/{maxRedCards} נבחרו | 2 נק׳ לכל ניחוש נכון)</span>
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {roundMatches.map(km => {
                          const tA = getTeamSafe(km.id, 'A')
                          const tB = getTeamSafe(km.id, 'B')
                          if (!tA || !tB) return null
                          const isPicked = redCardPicks.includes(km.id)
                          const canPick = !roundLocked && (!isPicked ? redCardPicks.length < maxRedCards : true)
                          return (
                            <button key={km.id}
                              onClick={() => !roundLocked && toggleKnockoutRedCard(round as 'R32' | 'R16' | 'QF', km.id)}
                              disabled={roundLocked || (!isPicked && redCardPicks.length >= maxRedCards)}
                              style={{
                                padding: '5px 10px', borderRadius: 8, border: '1.5px solid',
                                borderColor: isPicked ? '#A32D2D' : '#ddd',
                                background: isPicked ? '#FCEBEB' : '#fff',
                                color: isPicked ? '#A32D2D' : '#555',
                                fontWeight: isPicked ? 700 : 400, fontSize: 12,
                                cursor: canPick ? 'pointer' : 'not-allowed',
                                fontFamily: 'inherit', opacity: (!isPicked && redCardPicks.length >= maxRedCards) ? 0.4 : 1,
                              }}>
                              {FLAGS[tA] ?? ''} {tA} vs {FLAGS[tB] ?? ''} {tB}
                              {isPicked && ' 🟥'}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )}
                  {roundMatches.map(km => {
                    const teamA = getTeamSafe(km.id, 'A')
                    const teamB = getTeamSafe(km.id, 'B')
                    const pred = knockoutPreds[km.id]
                    const teamsReady = !!(teamA && teamB)
                    const isFocused = focusMatchId === km.id

                    const ptA = teamA ? (TEAM_FIFA_POINTS[teamA] ?? 1500) : km.fifaPointsA
                    const ptB = teamB ? (TEAM_FIFA_POINTS[teamB] ?? 1500) : km.fifaPointsB
                    const dynCat = (teamA && teamB) ? calcCategoryByRound(ptA, ptB, km.round) : km.category
                    const aIsFavForm = ptA >= ptB

                    return (
                      <div key={km.id} id={`ko-match-${km.id}`} className="match-row"
                        style={{ opacity: !teamsReady ? 0.5 : 1, outline: isFocused ? '2px solid #1a7a44' : 'none', borderRadius: 12 }}>
                        <div className="match-header">
                          <span className="match-num">#{km.id}</span>
                          <span className={`cat-badge cat-${dynCat.toLowerCase()}`}>{dynCat}</span>
                          {teamsReady ? (
                            <span style={{ fontSize: 13, fontWeight: 600 }}>
                              {FLAGS[teamA!] ?? ''} {teamA} נגד {teamB} {FLAGS[teamB!] ?? ''}
                            </span>
                          ) : (
                            <span style={{ fontSize: 12, color: '#bbb' }}>
                              {round === 'R32' ? t.koPendingAdmin : t.koPendingPrev}
                            </span>
                          )}
                        </div>

                        {teamsReady && (
                          <div style={{ padding: '12px 14px' }}>
                            <div className="match-body">
                              <div className="team-name">
                                <span className="team-flag">{FLAGS[teamA!] ?? ''}</span>
                                <span>{teamA}</span>
                              </div>
                              <div className="score-inputs">
                                <input className="score-input" type="number" min="0" max="20" placeholder="0"
                                  value={pred?.scoreA ?? 0} disabled={roundLocked}
                                  onFocus={e => e.target.select()}
                                  onChange={e => updateKnockout(km.id, 'scoreA', e.target.value === '' ? 0 : parseInt(e.target.value))} />
                                <span className="score-sep">–</span>
                                <input className="score-input" type="number" min="0" max="20" placeholder="0"
                                  value={pred?.scoreB ?? 0} disabled={roundLocked}
                                  onFocus={e => e.target.select()}
                                  onChange={e => updateKnockout(km.id, 'scoreB', e.target.value === '' ? 0 : parseInt(e.target.value))} />
                              </div>
                              <div className="team-name team-name-b">
                                <span>{teamB}</span>
                                <span className="team-flag">{FLAGS[teamB!] ?? ''}</span>
                              </div>
                            </div>

                            <div className="match-1x2-row">
                              <div className="btn-group-1x2">
                                {([['1', teamA!], ['X', 'תיקו'], ['2', teamB!]] as [Result1X2, string][]).map(([val, label]) => (
                                  <button key={val}
                                    className={`btn-1x2 ${pred?.prediction1X2 === val ? 'selected' : ''}`}
                                    disabled={roundLocked}
                                    onClick={() => updateKnockout(km.id, 'prediction1X2', val)}>
                                    {FLAGS[label] ? `${FLAGS[label]} ${label}` : label}
                                  </button>
                                ))}
                              </div>
                            </div>

                            {/* Advance picker */}
                            <div style={{ padding: '8px 14px', borderTop: '1px solid #f0f0f0' }}>
                              <div style={{ fontSize: 11, color: '#888', marginBottom: 5 }}>מי עולה?</div>
                              <div style={{ display: 'flex', gap: 6 }}>
                                {([teamA!, teamB!] as string[]).map(team => {
                                  const isSelected = pred?.advance === team
                                  return (
                                    <button key={team}
                                      disabled={roundLocked}
                                      onClick={() => updateKnockout(km.id, 'advance', team)}
                                      style={{
                                        flex: 1, padding: '7px 6px',
                                        border: isSelected ? '2px solid #1a7a44' : '1px solid #ddd',
                                        borderRadius: 8, background: isSelected ? '#EAF3DE' : '#fff',
                                        color: isSelected ? '#1a7a44' : '#555',
                                        fontWeight: isSelected ? 700 : 400,
                                        fontSize: 12, cursor: roundLocked ? 'not-allowed' : 'pointer',
                                        fontFamily: 'inherit', opacity: roundLocked ? 0.5 : 1,
                                      }}>
                                      {FLAGS[team] ?? ''} {team}
                                    </button>
                                  )
                                })}
                              </div>
                            </div>

                            <div style={{ padding: '10px 14px', background: '#f8f9ff', borderTop: '1px solid #f0f0f0' }}>
                              {!pred?.prediction1X2 ? (
                                <div style={{ background: '#FAEEDA', borderRadius: 8, padding: '7px 10px', fontSize: 12, color: '#633806', display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <span>⚠️</span> לא בחרת 1X2 — המשחק לא נספר בסיכום
                                </div>
                              ) : (() => {
                                const catIdx = { A: 0, B: 1, C: 2, D: 3 }[dynCat]
                                const isFav = (pred.prediction1X2 === '1' && aIsFavForm) || (pred.prediction1X2 === '2' && !aIsFavForm)
                                const roundBase = { R32: 1, R16: 1, QF: 2, SF: 3, '3P': 2, F: 3 }[km.round]
                                const catBonus = { A: 0, B: 1, C: 2, D: 3 }[dynCat]
                                const p1x2 = pred.prediction1X2 === 'X'
                                  ? roundBase + Math.max(0, catBonus - 1)
                                  : isFav ? roundBase : roundBase + catBonus
                                const breakdown: string[] = [`1X2: ${p1x2}`]
                                let total = p1x2

                                if (pred.scoreA !== null && pred.scoreA !== undefined) {
                                  const goalTotal = Number(pred.scoreA) + Number(pred.scoreB ?? 0)
                                  const ouPts = { R32: 1, R16: 1, QF: 2, SF: 2, '3P': 1, F: 2 }[km.round]
                                  const isOU = km.round === 'F'
                                    ? (goalTotal === 0 || goalTotal >= 4)
                                    : km.round === '3P'
                                    ? (goalTotal <= 2 || goalTotal >= 5)
                                    : catIdx <= 1 ? (goalTotal <= 1 || goalTotal >= 4) : (goalTotal <= 2 || goalTotal >= 5)
                                  if (isOU) {
                                    const ouLabel = goalTotal <= (catIdx <= 1 ? 1 : 2) ? t.under : t.over
                                    breakdown.push(`${t.exactScore}: 2 (הפרש: 1) | ${ouLabel}: ${ouPts}`)
                                    total += 2 + ouPts
                                  } else {
                                    breakdown.push(`${t.exactScore}: 2 (הפרש: 1)`)
                                    total += 2
                                  }
                                }

                                const isRedCard = (() => {
                                  const rk = km.round as string
                                  if (!['R32','R16','QF'].includes(rk)) return false
                                  return (knockoutRedCards[rk as 'R32'|'R16'|'QF'] ?? []).includes(km.id)
                                })()
                                if (isRedCard) {
                                  breakdown.push(`🟥 ${t.redCard}: 2`)
                                  total += 2
                                }

                                if (pred.advance) {
                                  const advBase = ({ R32: 1, R16: 2, QF: 3, SF: 4, '3P': 2, F: 5 } as Record<string, number>)[km.round]
                                  const advCatBonus = { A: 0, B: 1, C: 2, D: 2 }[dynCat]
                                  const pickedUnderdog = (pred.advance === teamA && !aIsFavForm) || (pred.advance === teamB && aIsFavForm)
                                  const advPts = advBase + (pickedUnderdog ? advCatBonus : 0)
                                  const advFlag = pred.advance === teamA ? (FLAGS[teamA!] ?? '') : (FLAGS[teamB!] ?? '')
                                  breakdown.push(`עולה (${advFlag} ${pred.advance}): ${advPts}`)
                                  total += advPts
                                }

                                return (
                                  <div className="max-pts-bar">
                                    <span className="max-pts-label">מקסימום:</span>
                                    <span className="max-pts-value">{total}</span>
                                    <span className="max-pts-label">נק׳</span>
                                    <div className="max-pts-breakdown">
                                      {breakdown.map((b, i) => <span key={i} className="max-pts-item">{b}</span>)}
                                    </div>
                                  </div>
                                )
                              })()}
                            </div>
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
      )}</div>
  )
}

function BonusInput({ q, value, disabled, onChange, t }: {
  q: typeof BONUS_QUESTIONS[number]; value: string; disabled: boolean
  onChange: (v: string) => void; t: Translations
}) {
  const allTeams = Object.values(GROUPS_TEAMS).flat()
  if (q.type === 'team') return (
    <select value={value} disabled={disabled} onChange={e => onChange(e.target.value)}>
      <option value="">{t.selectTeam}</option>
      {[...allTeams].sort().map(tm => <option key={tm} value={tm}>{FLAGS[tm] ?? ''} {tm}</option>)}
    </select>
  )
  if (q.type === 'group') return (
    <select value={value} disabled={disabled} onChange={e => onChange(e.target.value)}>
      <option value="">{t.selectGroup}</option>
      {'ABCDEFGHIJKL'.split('').map(g => <option key={g} value={g}>{t.group} {g}</option>)}
    </select>
  )
  if (q.type === 'number') return (
    <input type="number" min="0" max="200" value={value} placeholder={t.enterNumber}
      disabled={disabled} onFocus={e => e.target.select()} onChange={e => onChange(e.target.value)} />
  )
  return (
    <input type="text" placeholder={t.playerName} value={value}
      disabled={disabled} onChange={e => onChange(e.target.value)} />
  )
}
