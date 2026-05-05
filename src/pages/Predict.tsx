import { useState, useEffect, useCallback, useRef } from 'react'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { db } from '../firebase'
import { useAuth, isAppOpen } from '../hooks/useAuth'
import { MATCHES, GROUPS_TEAMS, BONUS_QUESTIONS, FLAGS, MATCH_SCHEDULE, TEAM_EN, KNOCKOUT_MATCHES, KNOCKOUT_ROUND_LABELS, ALL_TEAMS, KNOCKOUT_BRACKET } from '../data/matches'
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
      breakdown.push(`${t.exactScore}: 2 | ${ouLabel}`)
    } else {
      ptsScore = 2
      breakdown.push(`${t.exactScore}: 2`)
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
  const [saving, setSaving] = useState(false)
  const [lastSaved, setLastSaved] = useState<Date | null>(null)
  const [matchPreds, setMatchPreds] = useState<Record<number, MatchPrediction>>({})
  const [groupPreds, setGroupPreds] = useState<Record<Group, GroupPrediction>>({} as any)
  const [bonus, setBonus] = useState<Partial<BonusPredictions>>({})
  const [knockoutPreds, setKnockoutPreds] = useState<Record<number, KnockoutMatchPrediction>>({})
  const [knockoutOpen, setKnockoutOpen] = useState(false)
  const [knockoutDeadline, setKnockoutDeadline] = useState<number | null>(null)
  const [knockoutMatches, setKnockoutMatches] = useState<Record<number, any>>({})
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
        setMatchPreds(data.matches ?? {})
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
        if (koSnap.exists()) setKnockoutMatches(koSnap.data().matches ?? {})
        if (settingsSnap.exists()) {
          const d = settingsSnap.data()
          setKnockoutOpen(d.knockoutOpen ?? false)
          setKnockoutDeadline(d.knockoutDeadline ?? null)
        }
      } catch { /* ignore */ }
      // Load saved knockout predictions
      if (snap.exists() && snap.data().knockout) {
        setKnockoutPreds(snap.data().knockout)
      }
    })()
  }, [user])

  const scheduleSave = useCallback((
    mp: Record<number, MatchPrediction>,
    gp: Record<Group, GroupPrediction>,
    bn: Partial<BonusPredictions>,
    ko?: Record<number, KnockoutMatchPrediction>
  ) => {
    if (!user || !isOpen) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      setSaving(true)
      await setDoc(doc(db, 'predictions', user.uid), {
        userId: user.uid, userName: user.displayName,
        matches: mp, groups: gp, bonus: bn,
        ...(ko !== undefined ? { knockout: ko } : {}),
        lastUpdated: Date.now(),
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

  const updateKnockout = (id: number, field: keyof KnockoutMatchPrediction, value: unknown) => {
    if (!knockoutOpen) return
    const koDeadlinePassed = knockoutDeadline && Date.now() > knockoutDeadline
    if (koDeadlinePassed) return
    setKnockoutPreds(prev => {
      const ko = KNOCKOUT_MATCHES.find(m => m.id === id)!
      const updated = {
        ...prev,
        [id]: { ...(prev[id] ?? { matchId: id, prediction1X2: '1' as Result1X2, scoreA: null, scoreB: null }), [field]: value } as KnockoutMatchPrediction
      }
      scheduleSave(matchPreds, groupPreds, bonus, updated)
      return updated
    })
  }

  const matchProgress = Object.values(matchPreds).filter(p => p.prediction1X2).length

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
            🏆 נוקאאוט
            {knockoutOpen && <span className="badge" style={{ background: '#EAF3DE', color: '#3B6D11' }}>פתוח</span>}
          </button>
        )}
      </div>

      {tab === 'matches' && (
        <div className="matches-section">
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
                      const p: MatchPrediction = matchPreds[match.id] ?? { matchId: match.id, prediction1X2: '1' as const, scoreA: null, scoreB: null, redCard: false }
                      const { total: maxPts, breakdown } = calcMaxPoints(p, match.category, match.fifaPointsA, match.fifaPointsB, t)
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

                          {p.prediction1X2 && (
                            <div className="max-pts-bar">
                              <span className="max-pts-label">מקסימום:</span>
                              <span className="max-pts-value">{maxPts}</span>
                              <span className="max-pts-label">נק׳</span>
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
          {!knockoutOpen && (
            <div className="lb-pre-tournament" style={{ marginBottom: 16 }}>
              🔒 חלון הנוקאאוט סגור — ניתן לצפות בהימורים בלבד
            </div>
          )}
          {knockoutOpen && knockoutDeadline && (
            <div className="lb-pre-tournament" style={{ marginBottom: 16, background: '#EAF3DE', color: '#3B6D11', borderColor: '#b7ddb0' }}>
              ⚡ חלון פתוח עד {new Date(knockoutDeadline).toLocaleString('he-IL')}
            </div>
          )}

          {(() => {
            const isLocked = !knockoutOpen || (knockoutDeadline != null && Date.now() > knockoutDeadline)

            // Get team for a match side — cascades from advance picks
            const getTeam = (matchId: number, side: 'A' | 'B'): string | undefined => {
              const bracket = KNOCKOUT_BRACKET[matchId]
              if (!bracket) return undefined
              const feederId = side === 'A' ? bracket.feederA : bracket.feederB
              // R32: admin sets teams
              if (feederId === null) {
                return side === 'A' ? knockoutMatches[matchId]?.teamA : knockoutMatches[matchId]?.teamB
              }
              // SF loser (3rd place match)
              if (feederId < 0) {
                const sfId = Math.abs(feederId)
                const winner = knockoutPreds[sfId]?.advance
                const sfA = getTeam(sfId, 'A')
                const sfB = getTeam(sfId, 'B')
                if (!winner || !sfA || !sfB) return undefined
                return winner === sfA ? sfB : sfA
              }
              // Winner of feeder match
              return knockoutPreds[feederId]?.advance
            }

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
                return knockoutPreds[feederId]?.advance
              } catch { return undefined }
            }

            return (['R32', 'R16', 'QF', 'SF', '3P', 'F'] as const).map(round => {
              const roundMatches = KNOCKOUT_MATCHES.filter(m => m.round === round)
              const hasRedCard = round === 'R32' || round === 'R16'

              return (
                <div key={round}>
                  <h2 className="round-title">{KNOCKOUT_ROUND_LABELS[round]}</h2>
                  {roundMatches.map(km => {
                    const teamA = getTeamSafe(km.id, 'A')
                    const teamB = getTeamSafe(km.id, 'B')
                    const pred = knockoutPreds[km.id]
                    const teamsReady = !!(teamA && teamB)
                    const base = { R32: 2, R16: 3, QF: 4, SF: 5, '3P': 4, F: 5 }[round]
                    const catBonus = { A: 0, B: 1, C: 2, D: 2 }[km.category]
                    const advPts = base + catBonus

                    return (
                      <div key={km.id} className="match-row" style={{ opacity: !teamsReady ? 0.5 : 1 }}>
                        <div className="match-header">
                          <span className="match-num">#{km.id}</span>
                          <span className={`cat-badge cat-${km.category.toLowerCase()}`}>{km.category}</span>
                          {teamsReady ? (
                            <span style={{ fontSize: 13, fontWeight: 600 }}>
                              {FLAGS[teamA!] ?? ''} {teamA} נגד {teamB} {FLAGS[teamB!] ?? ''}
                            </span>
                          ) : (
                            <span style={{ fontSize: 12, color: '#bbb' }}>
                              {round === 'R32' ? 'ממתין להגדרת אדמין' : '← מלא את השלב הקודם כדי לראות'}
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
                                  value={pred?.scoreA ?? ''} disabled={isLocked}
                                  onChange={e => updateKnockout(km.id, 'scoreA', parseInt(e.target.value) || 0)} />
                                <span className="score-sep">–</span>
                                <input className="score-input" type="number" min="0" max="20" placeholder="0"
                                  value={pred?.scoreB ?? ''} disabled={isLocked}
                                  onChange={e => updateKnockout(km.id, 'scoreB', parseInt(e.target.value) || 0)} />
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
                                    disabled={isLocked}
                                    onClick={() => updateKnockout(km.id, 'prediction1X2', val)}>
                                    {FLAGS[label] ? `${FLAGS[label]} ${label}` : label}
                                  </button>
                                ))}
                              </div>
                              {hasRedCard && (
                                <label className={`red-card-label ${pred?.redCard ? 'checked' : ''} ${isLocked ? 'disabled' : ''}`}>
                                  <input type="checkbox" checked={pred?.redCard ?? false} disabled={isLocked}
                                    onChange={e => updateKnockout(km.id, 'redCard', e.target.checked)} />
                                  &nbsp;🟥 כרטיס אדום
                                </label>
                              )}
                            </div>

                            {/* Who advances — every round */}
                            <div style={{ padding: '10px 14px', background: '#f8f9ff', borderTop: '1px solid #f0f0f0' }}>
                              <div style={{ fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 6 }}>
                                {round === 'F' ? '🏆 אלוף העולם' : round === '3P' ? '🥉 מקום שלישי' : 'מי עולה לשלב הבא?'}
                                <span style={{ fontSize: 11, color: '#888', fontWeight: 400, marginRight: 6 }}>
                                  (+{advPts} נק׳ לכל שלב)
                                </span>
                              </div>
                              <div style={{ display: 'flex', gap: 8 }}>
                                {[teamA!, teamB!].map(team => (
                                  <button key={team}
                                    onClick={() => updateKnockout(km.id, 'advance', team)}
                                    disabled={isLocked}
                                    style={{
                                      flex: 1, padding: '9px 8px', border: '2px solid',
                                      borderColor: pred?.advance === team ? '#1a7a44' : '#e0e0e0',
                                      borderRadius: 10,
                                      background: pred?.advance === team ? '#EAF3DE' : '#fff',
                                      color: pred?.advance === team ? '#1a7a44' : '#555',
                                      cursor: isLocked ? 'not-allowed' : 'pointer',
                                      fontWeight: 700, fontSize: 13, fontFamily: 'inherit',
                                    }}>
                                    {FLAGS[team] ?? ''} {team}
                                  </button>
                                ))}
                              </div>
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
      )}
    </div>
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
