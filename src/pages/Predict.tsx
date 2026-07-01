import Flag, { flagToIso } from '../components/Flag'
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { db } from '../firebase'
import { useAuth, isAppOpen } from '../hooks/useAuth'
import { MATCHES, GROUPS_TEAMS, BONUS_QUESTIONS, FLAGS, MATCH_SCHEDULE, TEAM_EN, KNOCKOUT_MATCHES, KNOCKOUT_ROUND_LABELS, ALL_TEAMS, KNOCKOUT_BRACKET, TEAM_FIFA_POINTS, calcCategory, calcCategoryByRound } from '../data/matches'
import { MatchPrediction, GroupPrediction, BonusPredictions, Group, Category, KnockoutMatchPrediction, Result1X2 } from '../types'
import { calc1X2Points, calcOverUnder, calcAdvancePoints, getOUType } from '../scoring'
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
        <span className="ranking-fifa" style={{ color }}><Flag emoji={FLAGS[teamA] ?? ''} size={18} /> {tn(teamA)} <strong>#{rankA}</strong></span>
        <span className="ranking-arrow" style={{ color }}>
          {t.favoriteLabel}: <Flag emoji={FLAGS[favTeam] ?? ''} size={16} /> <strong>{tn(favTeam)}</strong>
        </span>
        <span className="ranking-fifa" style={{ color }}><Flag emoji={FLAGS[teamB] ?? ''} size={18} /> {tn(teamB)} <strong>#{rankB}</strong></span>
      </div>
      <div className="ranking-gap-ou" style={{ color }}>{ou}</div>
    </div>
  )
}

export default function Predict({ lang }: { lang: Lang }) {
  const { user, firestoreName } = useAuth()
  const t = T[lang]
  const [tab, setTab] = useState<Tab>('matches')
  // Auto-switch to knockout tab on first load once knockout window opens
  const tabInitializedRef = useRef(false)
  const [showGroupSummary, setShowGroupSummary] = useState(false)
  const [bonusStandingsOpen, setBonusStandingsOpen] = useState(false)
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
  // Master switch only — per-round locking handled in updateKnockout and isRoundLocked
  const isKoOpen = knockoutOpen
  const [r16Deadline, setR16Deadline] = useState<number | null>(null)
  const [p3Deadline, setP3Deadline] = useState<number | null>(null)
  const [qfDeadline, setQfDeadline] = useState<number | null>(null)
  const [sfDeadline, setSfDeadline] = useState<number | null>(null)
  const [finalDeadline, setFinalDeadline] = useState<number | null>(null)
  const [knockoutMatches, setKnockoutMatches] = useState<Record<number, any>>({})
  const [knockoutView, setKnockoutView] = useState<'bracket' | 'form'>('bracket')

  // Auto-switch to form view when bracket tab isn't available yet (R32 window)
  useEffect(() => {
    if (r16Deadline == null) setKnockoutView('form')
  }, [r16Deadline])

  // Auto-switch to knockout tab on first load only when group stage is closed and knockout is open
  useEffect(() => {
    if (!tabInitializedRef.current && knockoutOpen && !isOpen) {
      setTab('knockout')
      tabInitializedRef.current = true
    }
  }, [knockoutOpen, isOpen])

  const goToMatch = (matchId: number) => {
    setTab('matches')
    setTooltipGroup(null)
    setTimeout(() => document.getElementById(`match-${matchId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 120)
  }

  // Accordion state: which rounds are open in form view
  const [openRounds, setOpenRounds] = useState<Set<string>>(new Set(['R32']))
  const toggleRound = (round: string) =>
    setOpenRounds(prev => { const s = new Set(prev); s.has(round) ? s.delete(round) : s.add(round); return s })

  // Compute active round (first with deadline that hasn't passed, or last available)
  const activeKoRound = useMemo(() => {
    const rounds = ['R32', 'R16', 'QF', 'SF', '3P', 'F'] as const
    const deadlines: Record<string, number | null> = {
      R32: knockoutDeadline, R16: r16Deadline, QF: qfDeadline,
      SF: sfDeadline, '3P': p3Deadline ?? finalDeadline, F: finalDeadline,
    }
    const now = Date.now()
    for (const r of rounds) {
      const dl = deadlines[r]
      if (dl !== null && now <= dl) return r
    }
    // All locked — return last round with a deadline set
    for (const r of [...rounds].reverse()) {
      if (deadlines[r] !== null) return r
    }
    return 'R32'
  }, [knockoutDeadline, r16Deadline, qfDeadline, sfDeadline, p3Deadline, finalDeadline])

  // Auto-open active round when it changes
  useEffect(() => {
    setOpenRounds(new Set([activeKoRound]))
  }, [activeKoRound])
  const [focusMatchId, setFocusMatchId] = useState<number | null>(null)
  const [tooltipGroup, setTooltipGroup] = useState<string | null>(null)
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 })

  const showTooltip = (key: string, e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setTooltipPos({ x: rect.left + rect.width / 2, y: rect.bottom + window.scrollY + 6 })
    setTooltipGroup(key)
  }
  const hideTooltip = () => setTooltipGroup(null)
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
          setP3Deadline(d.p3Deadline ?? null)
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
    if (!user || (!isOpen && !knockoutOpen)) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      setSaving(true)
      await setDoc(doc(db, 'predictions', user.uid), {
        userId: user.uid, userName: firestoreName ?? user.displayName,
        matches: mp, groups: gp, bonus: bn,
        ...(ko !== undefined ? { knockout: ko } : {}),
        ...(koRed !== undefined ? { knockoutRedCards: koRed } : {}),
        lastUpdated: Date.now(),
      }, { merge: true })
      setSaving(false)
      setLastSaved(new Date())
    }, 1500)
  }, [user, isOpen, knockoutOpen])

  const updateMatch = (id: number, field: keyof MatchPrediction, value: unknown) => {
    if (!isOpen) return
    setMatchPreds(prev => {
      const base = prev[id] ?? { matchId: id, scoreA: 0, scoreB: 0, redCard: false }
      const entry = { ...base, [field]: value } as MatchPrediction
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
    if (!knockoutOpen) return
    // Per-round deadline check
    const km = KNOCKOUT_MATCHES.find(m => m.id === id)
    const round = km?.round ?? 'R32'
    // Advance picks deadline:
    // - R32 matches → knockoutDeadline (R32 bracket window)
    // - R16/QF/SF/F bracket tree → r16Deadline (bracket filled during R16 window)
    // - 1X2/score → per-round deadline
    const effectiveDeadline = field === 'advance'
      ? (round === 'R32' ? knockoutDeadline : r16Deadline)
      : ({ R32: knockoutDeadline, R16: r16Deadline, QF: qfDeadline,
           SF: sfDeadline, '3P': p3Deadline ?? finalDeadline, F: finalDeadline } as Record<string, number|null>)[round] ?? null
    if (effectiveDeadline && Date.now() > effectiveDeadline) return

    setKnockoutPreds(prev => {
      const base = prev[id] ?? { matchId: id, scoreA: 0, scoreB: 0 }
      const entry = { ...base, [field]: value } as KnockoutMatchPrediction
      if (field === 'scoreA' && (entry.scoreB === null || entry.scoreB === undefined)) entry.scoreB = 0
      if (field === 'scoreB' && (entry.scoreA === null || entry.scoreA === undefined)) entry.scoreA = 0
      const updated = { ...prev, [id]: entry }
      scheduleSave(matchPreds, groupPreds, bonus, updated, knockoutRedCards)
      return updated
    })
  }

  const toggleKnockoutRedCard = (round: 'R32' | 'R16' | 'QF', matchId: number) => {
    if (!knockoutOpen) return
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
    if (!deadline) return { label: t.deadlineOpen, color: '#1a7a44', icon: '🟢' }
    const diff = deadline - now
    if (diff <= 0) return { label: t.deadlineLocked, color: '#c0392b', icon: '🔒' }
    const d = Math.floor(diff / 86400000)
    const h = Math.floor((diff % 86400000) / 3600000)
    const m = Math.floor((diff % 3600000) / 60000)
    const s = Math.floor((diff % 60000) / 1000)
    if (d > 0) return { label: `${t.deadlineRemains} ${d} ${t.deadlineDays} ${h} ${t.deadlineHours}`, color: '#1a7a44', icon: '🟢' }
    if (h > 0) return { label: `${t.deadlineRemains} ${h} ${t.deadlineHours} ${m} ${t.deadlineMinutes}`, color: h < 3 ? '#e67e22' : '#1a7a44', icon: h < 3 ? '🟠' : '🟢' }
    return { label: `${t.deadlineRemains} ${m}:${String(s).padStart(2, '0')} ${t.deadlineMinutes}`, color: '#c0392b', icon: '🔴' }
  }

  const DeadlineBanner = ({ deadline, locked }: { deadline: number | null; locked: boolean }) => {
    const { label, color, icon } = locked
      ? { label: t.deadlineLocked, color: '#c0392b', icon: '🔒' }
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
            {t.deadlineUntil} {new Date(deadline).toLocaleString(lang === 'en' ? 'en-IL' : 'he-IL', { dateStyle: 'short', timeStyle: 'short' })}
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
          {/* Group stage progress — only on matches tab */}
          {tab === 'matches' && (
            <span
              title={lang === 'he'
                ? `מילאת ${matchProgress} מתוך 72 משחקים בשלב הבתים`
                : `Filled ${matchProgress} of 72 group stage matches`}
              style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, cursor: 'default' }}>
              <span style={{
                padding: '2px 8px', borderRadius: 10,
                background: matchProgress === 72 ? '#EAF3DE' : '#f0f0f0',
                color: matchProgress === 72 ? '#1a7a44' : '#555',
                fontWeight: 600,
              }}>
                {matchProgress === 72 ? '✓' : `${matchProgress}/72`} {lang === 'he' ? 'משחקים' : 'matches'}
              </span>
            </span>
          )}
          {/* Red cards — group stage only on matches tab */}
          {tab === 'matches' && (
            <span
              title={lang === 'he'
                ? `בחרת ${Math.min(redCardCount, MAX_RED_CARDS)} מתוך ${MAX_RED_CARDS} משחקים עם כרטיס אדום (שלב הבתים)`
                : `Picked ${Math.min(redCardCount, MAX_RED_CARDS)} of ${MAX_RED_CARDS} red card matches (group stage)`}
              style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, cursor: 'default' }}>
              <span style={{
                padding: '2px 8px', borderRadius: 10,
                background: redCardCount > 0 ? '#FCEBEB' : '#f0f0f0',
                color: redCardCount > 0 ? '#A32D2D' : '#aaa',
                fontWeight: 600,
              }}>
                <span style={{ direction: 'ltr', display: 'inline-block' }}>
                  🟥 {Math.min(redCardCount, MAX_RED_CARDS)}/{MAX_RED_CARDS}
                </span>
              </span>
            </span>
          )}
          {/* Knockout red cards summary — only on knockout tab */}
          {tab === 'knockout' && knockoutOpen && (() => {
            const r32 = knockoutRedCards.R32?.length ?? 0
            const r16 = knockoutRedCards.R16?.length ?? 0
            const qf  = knockoutRedCards.QF?.length ?? 0
            const total = r32 + r16 + qf
            if (total === 0) return null
            return (
              <span
                title={lang === 'he'
                  ? `אדומים נוקאאוט: R32 ${r32}/3 · R16 ${r16}/2 · QF ${qf}/1`
                  : `Knockout reds: R32 ${r32}/3 · R16 ${r16}/2 · QF ${qf}/1`}
                style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, cursor: 'default' }}>
                <span style={{ padding: '2px 8px', borderRadius: 10, background: '#FCEBEB', color: '#A32D2D', fontWeight: 600 }}>
                  <span style={{ direction: 'ltr', display: 'inline-block' }}>🟥 {total}/6</span>
                </span>
              </span>
            )
          })()}
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
                placeholder={t.displayNamePlaceholder}
                style={{ fontSize: 12, padding: '3px 8px', borderRadius: 6, border: '1px solid #1a1a2e', outline: 'none', width: 120 }}
                autoFocus />
              <button onClick={saveNickname} style={{ fontSize: 12, background: '#1a1a2e', color: '#fff', border: 'none', borderRadius: 6, padding: '3px 8px', cursor: 'pointer' }}>{t.save}</button>
              <button onClick={() => setEditingNick(false)} style={{ fontSize: 12, background: 'none', border: '1px solid #ddd', borderRadius: 6, padding: '3px 8px', cursor: 'pointer' }}>{t.cancel}</button>
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
        {(isKoOpen || Object.keys(knockoutPreds).length > 0) && (
          <button className={tab === 'knockout' ? 'tab active' : 'tab'} onClick={() => setTab('knockout')}>
            {t.tabKnockout}
            {knockoutOpen && !(knockoutDeadline && Date.now() > knockoutDeadline) && <span className="badge" style={{ background: '#EAF3DE', color: '#3B6D11' }}>{t.deadlineOpen}</span>}
          </button>
        )}
      </div>

      {/* ── Completion checker ── */}
      {user && (() => {
        const RED_CARD_QUOTA = 6
        const missing1x2 = MATCHES.filter(m => !matchPreds[m.id]?.prediction1X2).length
        const redCardTotal = MATCHES.filter(m => matchPreds[m.id]?.redCard).length
        const missingGroups = GROUPS.filter(g => !groupPreds[g] || groupPreds[g].advancing.filter(Boolean).length < 3)
        const bonusTotal = BONUS_QUESTIONS.length
        const bonusFilled = BONUS_QUESTIONS.filter(q => bonus[q.id as keyof BonusPredictions]).length
        const koOpen = KNOCKOUT_MATCHES.filter(km => (knockoutMatches[km.id] as any)?.teamA && (knockoutMatches[km.id] as any)?.teamB)
        const koMissing1x2 = koOpen.filter(km => !knockoutPreds[km.id]?.prediction1X2).length
        const koMissingAdvance = koOpen.filter(km => !knockoutPreds[km.id]?.advance).length
        const koRoundDls: Record<string, number | null> = { R32: knockoutDeadline, R16: r16Deadline, QF: qfDeadline }
        const koRedCardMissing = (Object.entries({ R32: 3, R16: 2, QF: 1 }) as [string, number][])
          .filter(([round, quota]) => { const dl = koRoundDls[round]; return dl && Date.now() > dl && (knockoutRedCards[round as 'R32'|'R16'|'QF']?.length ?? 0) < quota })
          .map(([round, quota]) => { const f = knockoutRedCards[round as 'R32'|'R16'|'QF']?.length ?? 0; return ({ R32:'שלב 32', R16:'שמינית', QF:'רבע' })[round]+` ${f}/${quota}` })

        const groupItems = tab !== 'knockout' ? [
          isOpen && missing1x2 > 0 && { icon: '1X2', label: `${missing1x2} משחקים ללא 1X2`, go: () => setTab('matches') },
          isOpen && missingGroups.length > 0 && { icon: '🏠', label: `בתים ללא עולות: ${missingGroups.join(', ')}`, go: () => setTab('groups') },
          isOpen && bonusFilled < bonusTotal && { icon: '🎯', label: `${bonusTotal - bonusFilled} שאלות בונוס לא מולאו`, go: () => setTab('bonus') },
          isOpen && redCardTotal < RED_CARD_QUOTA && { icon: '🟥', label: `${redCardTotal}/${RED_CARD_QUOTA} כרטיסים אדומים`, go: () => setTab('matches') },
        ].filter(Boolean) as {icon:string;label:string;go:()=>void}[] : []
        const koItems = tab === 'knockout' ? [
          koMissing1x2 > 0 && { icon: '1X2', label: `${koMissing1x2} משחקים ללא 1X2`, go: null },
          koMissingAdvance > 0 && { icon: '🏆', label: `${koMissingAdvance} משחקים ללא "מי עולה"`, go: null },
          koRedCardMissing.length > 0 && { icon: '🟥', label: `כרטיסים: ${koRedCardMissing.join(' | ')}`, go: null },
        ].filter(Boolean) as {icon:string;label:string;go:null|(()=>void)}[] : []
        const items = [...groupItems, ...koItems]
        if (!items.length) return null
        return (
          <div style={{ margin: '0 0 10px', border: '1px solid #f0c050', borderRadius: 10, background: '#fffbea', padding: '10px 14px' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#856404', marginBottom: 6 }}>📋 מה עוד צריך למלא?</div>
            {items.map((item, i) => (
              <button key={i} onClick={item.go ?? undefined}
                style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none',
                  width: '100%', cursor: item.go ? 'pointer' : 'default', fontFamily: 'inherit', padding: '4px 0',
                  borderTop: i > 0 ? '1px solid rgba(0,0,0,0.05)' : 'none' }}>
                <span style={{ fontSize: 11, background: '#fde8a0', color: '#856404', padding: '1px 7px', borderRadius: 6, fontWeight: 700, flexShrink: 0 }}>{item.icon}</span>
                <span style={{ fontSize: 12, color: '#555', flex: 1, textAlign: 'right' }}>{item.label}</span>
                {item.go && <span style={{ fontSize: 11, color: '#aaa' }}>←</span>}
              </button>
            ))}
          </div>
        )
      })()}

      {tab === 'matches' && (
        <div className="matches-section">
          <DeadlineBanner deadline={groupDeadline} locked={!isOpen} />

          {/* Sticky mini group standings toggle */}
          <div style={{ position: 'sticky', top: 0, zIndex: 40, background: '#fff', borderBottom: '1px solid #eee', marginBottom: 8 }}>
            <button
              onClick={() => setShowGroupSummary(v => !v)}
              style={{
                width: '100%', padding: '7px 14px', border: 'none', background: 'transparent',
                cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
                color: '#1a1a2e', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              }}>
              📊 {lang === 'he' ? 'מצב הבתים לפי ניחושיי' : 'My predicted standings'}
              <span style={{ fontSize: 11, color: '#888' }}>{showGroupSummary ? '▲' : '▼'}</span>
            </button>
            {showGroupSummary && (
              <div style={{ padding: '0 8px 10px', overflowX: 'auto' }}>
                <div style={{ display: 'flex', gap: 8, minWidth: 'max-content' }}>
                  {GROUPS.map(group => {
                    const teams = GROUPS_TEAMS[group]
                    const groupMatches = MATCHES.filter(m => m.group === group)
                    const standings = teams.map(team => {
                      let pts = 0, gf = 0, ga = 0
                      groupMatches.forEach(m => {
                        const pred = matchPreds[m.id]
                        if (pred?.scoreA == null || pred?.scoreB == null) return
                        const isA = m.teamA === team, isB = m.teamB === team
                        if (!isA && !isB) return
                        const rA = Number(pred.scoreA), rB = Number(pred.scoreB)
                        if (isA) { gf += rA; ga += rB; pts += rA > rB ? 3 : rA === rB ? 1 : 0 }
                        else     { gf += rB; ga += rA; pts += rB > rA ? 3 : rA === rB ? 1 : 0 }
                      })
                      return { team, pts, gd: gf - ga }
                    }).sort((a, b) => b.pts - a.pts || b.gd - a.gd)
                    return (
                      <div key={group} style={{ minWidth: 110, fontSize: 11, position: 'relative', cursor: 'pointer' }}
                        onMouseEnter={e => showTooltip(`mini-${group}`, e)}
                        onMouseLeave={hideTooltip}
                        onClick={e => tooltipGroup === `mini-${group}` ? hideTooltip() : showTooltip(`mini-${group}`, e)}
                      >
                        <div style={{ border: '1px solid #e8e8e8', borderRadius: 8, overflow: 'hidden' }}>
                        <div style={{ background: '#1a1a2e', color: '#fff', fontWeight: 700, fontSize: 11, padding: '3px 8px', textAlign: 'center' }}>
                          {t.group} {group}
                        </div>
                        {standings.map((s, i) => (
                          <div key={s.team} style={{
                            display: 'flex', alignItems: 'center', gap: 4, padding: '3px 6px',
                            background: i < 2 ? (i === 0 ? '#EAF3DE' : '#EDF5FF') : '#fff',
                            borderBottom: i < standings.length - 1 ? '1px solid #f0f0f0' : 'none',
                          }}>
                            <span style={{ fontWeight: 700, color: i < 2 ? '#1a7a44' : '#bbb', minWidth: 10 }}>{i + 1}</span>
                            <Flag emoji={FLAGS[s.team] ?? ''} size={13} />
                            <span style={{ flex: 1, fontWeight: i < 2 ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tn(s.team)}</span>
                            <span style={{ fontWeight: 700, color: '#333', fontSize: 12 }}>{s.pts}</span>
                          </div>
                        ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
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
                        <div key={match.id} id={`match-${match.id}`} className="match-row">
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
                              <span className="team-flag"><Flag emoji={FLAGS[match.teamA] ?? ''} size={24} /></span>
                              {tn(match.teamA)}
                            </span>
                            <div className="score-inputs">
                              <input
                                id={`score-a-${match.id}`}
                                className="score-input" type="number" min="0" max="20"
                                value={p.scoreA ?? 0} placeholder="0" disabled={!isOpen}
                                onFocus={e => e.target.select()}
                                onChange={e => updateMatch(match.id, 'scoreA', e.target.value === '' ? 0 : parseInt(e.target.value))}
                                onKeyDown={e => {
                                  if (/^[0-9]$/.test(e.key))
                                    setTimeout(() => document.getElementById(`score-b-${match.id}`)?.focus(), 30)
                                }}
                              />
                              <span className="score-sep">–</span>
                              <input
                                id={`score-b-${match.id}`}
                                className="score-input" type="number" min="0" max="20"
                                value={p.scoreB ?? 0} placeholder="0" disabled={!isOpen}
                                onFocus={e => e.target.select()}
                                onChange={e => updateMatch(match.id, 'scoreB', e.target.value === '' ? 0 : parseInt(e.target.value))}
                              />
                            </div>
                            <span className="team-name team-name-b">
                              <span className="team-flag"><Flag emoji={FLAGS[match.teamB] ?? ''} size={24} /></span>
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
                                    ? <><Flag emoji={FLAGS[match.teamA] ?? ''} size={20} /> {tn(match.teamA).slice(0,5)}</>
                                    : opt === '2'
                                    ? <>{tn(match.teamB).slice(0,5)} <Flag emoji={FLAGS[match.teamB] ?? ''} size={20} /></>
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
                              <span className="max-pts-label">{t.maxLabel}:</span>
                              <span className="max-pts-value">{maxPts}</span>
                              <span className="max-pts-label">נק׳</span>
                              <div className="max-pts-breakdown">
                                {breakdown.map((b, i) => <span key={i} className="max-pts-item">{b}</span>)}
                              </div>
                            </div>
                          ) : (
                            <div className="max-pts-bar" style={{ opacity: 0.45 }}>
                              <span className="max-pts-label">{t.select1x2}</span>
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
          {/* Sticky next-unfilled button for group stage */}
          {isOpen && (() => {
            // Find first unfilled in display order (round 1→3, then groups A→L)
            let firstUnfilled = null
            outer: for (const round of [1, 2, 3]) {
              for (const group of GROUPS) {
                const ms = MATCHES.filter(m => m.round === round && m.group === group)
                const unf = ms.find(m => !matchPreds[m.id]?.prediction1X2)
                if (unf) { firstUnfilled = unf; break outer }
              }
            }
            if (!firstUnfilled) return null
            return (
              <div style={{ position: 'sticky', bottom: 12, zIndex: 50, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
                <button
                  onClick={() => {
                    // Must be synchronous within user gesture for mobile keyboard to open
                    // Browser also auto-scrolls focused element into view
                    document.getElementById(`score-a-${firstUnfilled!.id}`)?.focus()
                  }}
                  style={{
                    pointerEvents: 'all', padding: '9px 20px', borderRadius: 24,
                    border: 'none', background: '#1a1a2e', color: '#fff',
                    fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
                    boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
                  }}>
                  ↓ {lang === 'he' ? 'משחק הבא שלא מולא' : 'Next unfilled match'}
                </button>
              </div>
            )
          })()}
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
              // Compute mini standings from user's match predictions
              const groupMatches = MATCHES.filter(m => m.group === group)
              const standings = teams.map(team => {
                let pts = 0, gf = 0, ga = 0, played = 0
                groupMatches.forEach(m => {
                  const pred = matchPreds[m.id]
                  if (pred?.scoreA == null || pred?.scoreB == null) return
                  const isA = m.teamA === team, isB = m.teamB === team
                  if (!isA && !isB) return
                  played++
                  const rA = Number(pred.scoreA), rB = Number(pred.scoreB)
                  if (isA) { gf += rA; ga += rB; pts += rA > rB ? 3 : rA === rB ? 1 : 0 }
                  else     { gf += rB; ga += rA; pts += rB > rA ? 3 : rA === rB ? 1 : 0 }
                })
                return { team, pts, gd: gf - ga, gf, played }
              }).sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf)
              const hasData = standings.some(s => s.played > 0)
              return (
                <div key={group} className="group-card" style={{ position: 'relative', overflow: 'visible' }}
                  onMouseEnter={e => showTooltip(group, e)}
                  onMouseLeave={hideTooltip}
                  onClick={e => tooltipGroup === group ? hideTooltip() : showTooltip(group, e)}
                >
                  <div className="group-card-title">{t.group} {group}</div>

                  {/* Caption explaining the standings are based on user predictions */}
                  {hasData && (
                    <div style={{ fontSize: 10, color: '#888', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span>📊</span>
                      <span>{lang === 'he' ? 'על פי ניחושי המשחקים שלך:' : 'Based on your match predictions:'}</span>
                    </div>
                  )}
                  {/* Mini standings based on user's match predictions */}
                  {hasData && (
                    <div style={{ marginBottom: 10, borderRadius: 8, overflow: 'hidden', border: '1px solid #e8e8e8', fontSize: 12 }}>
                      {standings.map((s, i) => (
                        <div key={s.team} style={{
                          display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px',
                          background: i === 0 ? '#EAF3DE' : i === 1 ? '#EDF5FF' : '#FFF4F4',
                          borderBottom: i < standings.length - 1 ? '1px solid #eee' : 'none',
                        }}>
                          <span style={{ fontWeight: 700, fontSize: 11, color: i < 2 ? '#1a7a44' : '#c00', minWidth: 12 }}>{i + 1}</span>
                          <Flag emoji={FLAGS[s.team] ?? ''} size={15} />
                          <span style={{ flex: 1, fontWeight: i < 2 ? 600 : 400, color: i < 2 ? '#1a1a2e' : '#888' }}>{tn(s.team)}</span>
                          <span style={{ fontWeight: 700, color: '#1a1a2e', minWidth: 20, textAlign: 'center' }}>{s.pts}</span>
                          <span style={{ color: '#aaa', fontSize: 11, minWidth: 28, textAlign: 'center' }}>
                            {s.gd > 0 ? '+' : ''}{s.gd}
                          </span>
                          <span style={{ fontSize: 10, color: '#bbb' }}>{s.played}/{groupMatches.length}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {!hasData && (
                    <div style={{ fontSize: 11, color: '#bbb', marginBottom: 8, textAlign: 'center', padding: '6px 0' }}>
                      {lang === 'he' ? 'מלא תוצאות שלב הבתים לסיוע' : 'Fill group stage results for guidance'}
                    </div>
                  )}

                  {[0, 1, 2].map(idx => (
                    <div key={idx} className="group-slot">
                      <span className="slot-num">{idx + 1}.</span>
                      <select value={gp.advancing[idx] ?? ''} disabled={!isOpen}
                        onChange={e => updateGroup(group, idx, e.target.value)}>
                        <option value="">{t.selectPlaceholder}</option>
                        {teams.map(tm => <option key={tm} value={tm}>{FLAGS[tm] ?? ''} {tn(tm)}</option>)}
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

          {/* Collapsible group standings reference */}
          {MATCHES.some(m => { const p = matchPreds[m.id]; return p?.scoreA != null && p?.scoreB != null }) && (
            <div style={{ marginBottom: 16, border: '1px solid #e8e8e8', borderRadius: 10, overflow: 'hidden' }}>
              <button onClick={() => setBonusStandingsOpen(o => !o)}
                style={{ width: '100%', padding: '10px 14px', background: '#f8f9ff', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'inherit', fontWeight: 600, fontSize: 13, color: '#1a1a2e' }}>
                <span style={{ fontSize: 16 }}>📊</span>
                <span>{lang === 'he' ? 'טבלאות בתים לפי הימוריי' : 'Group standings from my predictions'}</span>
                <span style={{ marginRight: 'auto', color: '#888', fontSize: 12 }}>{bonusStandingsOpen ? '▲' : '▼'}</span>
              </button>
              {bonusStandingsOpen && (
                <div style={{ padding: '12px 14px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 10 }}>
                  {GROUPS.map(group => {
                    const teams = GROUPS_TEAMS[group]
                    const groupMatches = MATCHES.filter(m => m.group === group)
                    const standings = teams.map(team => {
                      let pts = 0, gf = 0, ga = 0, played = 0
                      groupMatches.forEach(m => {
                        const pred = matchPreds[m.id]
                        if (pred?.scoreA == null || pred?.scoreB == null) return
                        const isA = m.teamA === team, isB = m.teamB === team
                        if (!isA && !isB) return
                        played++
                        const rA = Number(pred.scoreA), rB = Number(pred.scoreB)
                        if (isA) { gf += rA; ga += rB; pts += rA > rB ? 3 : rA === rB ? 1 : 0 }
                        else     { gf += rB; ga += rA; pts += rB > rA ? 3 : rA === rB ? 1 : 0 }
                      })
                      return { team, pts, gd: gf - ga, played }
                    }).sort((a, b) => b.pts - a.pts || b.gd - a.gd)
                    if (standings.every(s => s.played === 0)) return null
                    return (
                      <div key={group} style={{ fontSize: 12, position: 'relative', cursor: 'pointer' }}
                        onMouseEnter={e => showTooltip(`bonus-${group}`, e)}
                        onMouseLeave={hideTooltip}
                        onClick={e => tooltipGroup === `bonus-${group}` ? hideTooltip() : showTooltip(`bonus-${group}`, e)}
                      >
                        <div style={{ borderRadius: 8, overflow: 'hidden', border: '1px solid #e8e8e8' }}>
                        <div style={{ background: '#1a1a2e', color: '#fff', padding: '4px 8px', fontWeight: 700, fontSize: 11 }}>{lang === 'he' ? 'בית' : 'Group'} {group}</div>
                        {standings.map((s, i) => (
                          <div key={s.team} style={{
                            display: 'flex', alignItems: 'center', gap: 5, padding: '4px 7px',
                            background: i === 0 ? '#EAF3DE' : i === 1 ? '#EDF5FF' : '#FFF4F4',
                            borderBottom: i < standings.length - 1 ? '1px solid #eee' : 'none',
                          }}>
                            <span style={{ fontWeight: 700, fontSize: 10, color: i < 2 ? '#1a7a44' : '#c00', minWidth: 10 }}>{i + 1}</span>
                            <Flag emoji={FLAGS[s.team] ?? ''} size={13} />
                            <span style={{ flex: 1, fontSize: 11, fontWeight: i < 2 ? 600 : 400, color: i < 2 ? '#1a1a2e' : '#888', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tn(s.team)}</span>
                            <span style={{ fontWeight: 700, color: '#1a1a2e', fontSize: 11 }}>{s.pts}</span>
                            <span style={{ color: '#aaa', fontSize: 10, minWidth: 24, textAlign: 'right' }}>{s.gd > 0 ? '+' : ''}{s.gd}</span>
                          </div>
                        ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
          {BONUS_QUESTIONS.map(q => (
            <div key={q.id} className="bonus-row">
              <div className="bonus-label">
                {lang === 'en' ? (BONUS_QUESTIONS_EN[q.id] ?? q.label) : q.label}
                <span className="pts-badge">{q.points} {t.pts}</span>
                {q.note && lang === 'he' && <span className="bonus-note">{q.note}</span>}
              </div>
              <BonusInput q={q} value={(bonus as any)[q.id] ?? ''} disabled={!isOpen} t={t} lang={lang}
                onChange={val => updateBonus(q.id as keyof BonusPredictions, val)} />
            </div>
          ))}
        </div>
      )}

      {/* ── KNOCKOUT TAB ─────────────────────────────────────────────── */}
      {tab === 'knockout' && (
        <div>
          {/* Status banner — only when bracket is fully locked (no more predictions possible) */}
          {knockoutOpen && knockoutDeadline && Date.now() > knockoutDeadline && finalDeadline && Date.now() > finalDeadline && (
            <div className="lb-pre-tournament" style={{ marginBottom: 12 }}>
              🔒 {t.koLocked}
            </div>
          )}

          {/* View toggle — bracket tab shown only from R16 window onward */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 12, background: '#f8f9fa', borderRadius: 10, padding: 4 }}>
            {r16Deadline != null && (
              <button onClick={() => setKnockoutView('bracket')} style={{
                flex: 1, padding: '7px', borderRadius: 8, border: 'none', cursor: 'pointer',
                fontFamily: 'inherit', fontWeight: 600, fontSize: 13,
                background: knockoutView === 'bracket' ? '#1a1a2e' : 'transparent',
                color: knockoutView === 'bracket' ? '#fff' : '#666',
              }}>{t.koBracketView}</button>
            )}
            <button onClick={() => { setKnockoutView('form'); setFocusMatchId(null) }} style={{
              flex: 1, padding: '7px', borderRadius: 8, border: 'none', cursor: 'pointer',
              fontFamily: 'inherit', fontWeight: 600, fontSize: 13,
              background: knockoutView === 'form' ? '#1a1a2e' : 'transparent',
              color: knockoutView === 'form' ? '#fff' : '#666',
            }}>{t.koFormView}</button>
          </div>

          {(() => {
            const now = Date.now()
            // Bracket is locked when r16Deadline passes (tree filled during R16 window)
            // R32 advance picks locked when knockoutDeadline passes
            const isLocked = !knockoutOpen || (r16Deadline != null && now > r16Deadline)

            // Per-round locking: bracket+R32 use isLocked; later rounds have own deadlines
            const isRoundLocked = (round: string): boolean => {
              if (!knockoutOpen) return true
              switch (round) {
                case 'R32': return knockoutDeadline == null || now > knockoutDeadline
                case 'R16': return r16Deadline == null  || now > r16Deadline
                case 'QF':  return qfDeadline  == null  || now > qfDeadline
                case 'SF':  return sfDeadline   == null || now > sfDeadline
                case '3P':  return (p3Deadline ?? finalDeadline) == null || now > (p3Deadline ?? finalDeadline)!
                case 'F':   return finalDeadline == null || now > finalDeadline
                default:    return true
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
                // R32 feeders (73-88): ACTUAL advance team — user fills bracket based on real R32 results
                if (feederId >= 73 && feederId <= 88) {
                  return (knockoutMatches[feederId] as any)?.advanceTeam ?? undefined
                }
                return knockoutPreds[feederId]?.advance
              } catch { return undefined }
            }

            // Traces actual results through bracket (for comparison with user's predictions)
            const getActualTeam = (matchId: number, side: 'A' | 'B'): string | undefined => {
              try {
                const bracket = KNOCKOUT_BRACKET[matchId]
                if (!bracket) return undefined
                const feederId = side === 'A' ? bracket.feederA : bracket.feederB
                if (feederId === null) {
                  return side === 'A' ? (knockoutMatches[matchId] as any)?.teamA : (knockoutMatches[matchId] as any)?.teamB
                }
                if (feederId < 0) {
                  const sfId = Math.abs(feederId)
                  const sfMatch = knockoutMatches[sfId] as any
                  if (!sfMatch?.advanceTeam) return undefined
                  return sfMatch.teamA === sfMatch.advanceTeam ? sfMatch.teamB : sfMatch.teamA
                }
                // Always use actual advance team, regardless of round
                return (knockoutMatches[feederId] as any)?.advanceTeam ?? undefined
              } catch { return undefined }
            }

            // Form view: show actual teams from API when available, fallback to user predictions
            const getFormTeam = (matchId: number, side: 'A' | 'B'): string | undefined => {
              const actual = knockoutMatches[matchId] as any
              if (actual?.teamA && actual?.teamB) {
                return side === 'A' ? actual.teamA : actual.teamB
              }
              return getTeamSafe(matchId, side)
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
                // Open the accordion for this round (in case it's collapsed)
                const km = KNOCKOUT_MATCHES.find(m => m.id === id)
                if (km) setOpenRounds(prev => new Set([...prev, km.round]))
                setTimeout(() => {
                  const el = document.getElementById(`ko-match-${id}`)
                  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
                }, 200)
              }

              const MatchCard = ({ id, compact = false, variant = 'normal' }: { id: number; compact?: boolean; variant?: 'normal' | 'final' | 'third' }) => {
                const tA = getTeamSafe(id, 'A')
                const tB = getTeamSafe(id, 'B')
                const actualTeamA = getActualTeam(id, 'A')
                const actualTeamB = getActualTeam(id, 'B')
                const actualDiffersA = actualTeamA && tA && actualTeamA !== tA
                const actualDiffersB = actualTeamB && tB && actualTeamB !== tB
                const pred = knockoutPreds[id]
                const km = KNOCKOUT_MATCHES.find(m => m.id === id)
                // QF+ = rounds where bracket prediction ≠ necessarily actual teams
                const isQFPlus = !!(km && !['R32', 'R16'].includes(km.round))
                const actual = knockoutMatches[id] as (typeof knockoutMatches)[number] & { resultA?: number; resultB?: number; advanceTeam?: string; hadRedCard?: boolean; isPlayed?: boolean } | undefined

                const ptA = tA ? (TEAM_FIFA_POINTS[tA] ?? 1500) : 1500
                const ptB = tB ? (TEAM_FIFA_POINTS[tB] ?? 1500) : 1500

                // For QF+: category and favorite must use ACTUAL match teams, not bracket-predicted ones
                // This is critical for correct scoring (catBonus, underdog detection)
                const catTeamA = isQFPlus ? (actualTeamA ?? tA) : tA
                const catTeamB = isQFPlus ? (actualTeamB ?? tB) : tB
                const catPtA = catTeamA ? (TEAM_FIFA_POINTS[catTeamA] ?? 1500) : ptA
                const catPtB = catTeamB ? (TEAM_FIFA_POINTS[catTeamB] ?? 1500) : ptB
                const dynCat = km ? calcCategoryByRound(catPtA, catPtB, km.round) : 'A'
                const catIdx = { A: 0, B: 1, C: 2, D: 3 }[dynCat]
                const aIsFav = catPtA >= catPtB

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
                let pts1x2 = 0, ptsScore = 0, ptsAdv = 0, ptsRedCard = 0, ptsOU = 0
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
                    // Score: exact=2, right diff=1
                    if (pA === actualA && pB === actualB) ptsScore = 2
                    else if ((pA - pB) === (actualA! - actualB!)) ptsScore = 1
                    // OU: independent — both predicted AND actual total must match same type
                    const ouPts = ({ R32: 1, R16: 1, QF: 2, SF: 2, '3P': 1, F: 2 } as Record<string, number>)[km.round]
                    const ouType = (total: number) => catIdx <= 1 ? (total < 2 ? 'under' : total > 3 ? 'over' : null) : (total < 3 ? 'under' : total > 4 ? 'over' : null)
                    const predOUType = ouType(pA + pB)
                    const actOUType  = ouType((actualA ?? 0) + (actualB ?? 0))
                    if (predOUType && predOUType === actOUType) ptsOU = ouPts
                  }
                  if (pred?.advance && actualAdvance) {
                    if (pred.advance === actualAdvance) {
                      const pickedUnderdog = (pred.advance === tA && !aIsFav) || (pred.advance === tB && aIsFav)
                      const base = ({ R32: 1, R16: 2, QF: 3, SF: 4, '3P': 2, F: 5 } as Record<string, number>)[km.round]
                      const catBonus = { A: 0, B: 1, C: 2, D: 2 }[dynCat] ?? 0
                      ptsAdv = base + (pickedUnderdog ? catBonus : 0)
                    }
                  }

                // Bracket validity for QF+: advance pick must be one of bracket-predicted teams
                // (computed after advPicked is declared below)
                  // Red card points
                  if (pickedRedCard) {
                    ptsRedCard = actual?.hadRedCard ? 2 : 0
                  }
                }

                // Prediction OU label (based on user's predicted total)
                let predOuLabel: string | null = null
                if (hasScore && km && pred!.scoreA !== null && pred!.scoreB !== null) {
                  const goalTotal = Number(pred!.scoreA) + Number(pred!.scoreB)
                  const ouT = getOUType(goalTotal, dynCat as Category, km.round)
                  if (ouT) predOuLabel = ouT === 'under' ? t.under : t.over
                }

                // Advance pick
                const advPicked = pred?.advance
                const advA = advPicked === tA && tA
                const advB = advPicked === tB && tB
                const advCorrect = isPlayed && advPicked && advPicked === actualAdvance
                const advWrong = isPlayed && advPicked && advPicked !== actualAdvance
                const isLockedAdvance = !!(km && km.round !== 'R32')
                const advTeamInMatch = !advPicked || advPicked === tA || advPicked === tB
                const advNotInMatch = !!(advPicked && tA && tB && !advTeamInMatch)

                // Bracket validity: for QF+, advance pick must be one of bracket-predicted teams
                const advBracketValid = !km || km.round === 'R32' || km.round === 'R16'
                  || advPicked === tA || advPicked === tB
                if (!advBracketValid) ptsAdv = 0

                // For QF+: recursive bracket check — prevents showing potential
                // for eliminated teams even when SF/Final team stubs aren't set yet
                const canTeamReachMatch = (team: string, matchId: number, s: 'A' | 'B', depth = 0): boolean => {
                  if (depth > 8 || !team) return true
                  const b = KNOCKOUT_BRACKET[matchId]
                  if (!b) return true
                  const feederId = s === 'A' ? b.feederA : b.feederB
                  if (feederId === null) return true
                  if (feederId < 0) {
                    const sfId = Math.abs(feederId)
                    const sfBracket = KNOCKOUT_BRACKET[sfId]
                    if (!sfBracket) return true
                    const canBeA = canTeamReachMatch(team, sfId, 'A', depth + 1)
                    const canBeB = canTeamReachMatch(team, sfId, 'B', depth + 1)
                    if (!canBeA && !canBeB) return false
                    const sfKm = knockoutMatches[sfId]
                    if (sfKm?.isPlayed && sfKm?.advanceTeam) return sfKm.advanceTeam !== team
                    return true
                  }
                  if (feederId === 0) return true
                  const feederKm = knockoutMatches[feederId]
                  if (!feederKm || (!feederKm.teamA && !feederKm.teamB)) {
                    const fb = KNOCKOUT_BRACKET[feederId]
                    if (!fb) return true
                    const canA = fb.feederA !== null && fb.feederA > 0 ? canTeamReachMatch(team, feederId, 'A', depth + 1) : true
                    const canB = fb.feederB !== null && fb.feederB > 0 ? canTeamReachMatch(team, feederId, 'B', depth + 1) : true
                    return canA || canB
                  }
                  if (feederKm.isPlayed && feederKm.advanceTeam) return feederKm.advanceTeam === team
                  const fA = feederKm.teamA, fB = feederKm.teamB
                  if (fA && fB && fA !== team && fB !== team) return false
                  if (fA === team) return canTeamReachMatch(team, feederId, 'A', depth + 1)
                  if (fB === team) return canTeamReachMatch(team, feederId, 'B', depth + 1)
                  const fb2 = KNOCKOUT_BRACKET[feederId]
                  const predA2 = fb2?.feederA && fb2.feederA > 0 ? knockoutPreds[fb2.feederA]?.advance : undefined
                  const predB2 = fb2?.feederB && fb2.feederB > 0 ? knockoutPreds[fb2.feederB]?.advance : undefined
                  if (predA2 === team) return canTeamReachMatch(team, feederId, 'A', depth + 1)
                  if (predB2 === team) return canTeamReachMatch(team, feederId, 'B', depth + 1)
                  return true
                }

                const advInActualMatch = !isQFPlus || !advPicked
                  ? true
                  : canTeamReachMatch(advPicked, id, 'A') || canTeamReachMatch(advPicked, id, 'B')

                // Potential advance points (pre-match)
                const potentialAdvPts = (() => {
                  if (!km || !advPicked || advNotInMatch) return 0
                  const base = ({ R32: 1, R16: 2, QF: 3, SF: 4, '3P': 2, F: 5 } as Record<string, number>)[km.round]
                  const catBonus = { A: 0, B: 1, C: 2, D: 2 }[dynCat]
                  const pickedUnderdog = (advPicked === tA && !aIsFav) || (advPicked === tB && aIsFav)
                  return base + (pickedUnderdog ? catBonus : 0)
                })()

                // 1X2 display label — for QF+ use ACTUAL teams (user filled 1X2 seeing actual teams)
                const label1A = isQFPlus ? (actualTeamA ?? tA) : tA
                const label1B = isQFPlus ? (actualTeamB ?? tB) : tB
                const pred1x2Label = predResult === '1' ? (label1A ? tn(label1A) : '1') : predResult === '2' ? (label1B ? tn(label1B) : '2') : predResult === 'X' ? t.draw : null
                const pred1x2Flag = predResult === '1' ? (label1A ? FLAGS[label1A] ?? '' : '') : predResult === '2' ? (label1B ? FLAGS[label1B] ?? '' : '') : null

                const safeTotal = (pts1x2 || 0) + (ptsScore || 0) + (ptsOU || 0) + (ptsAdv || 0) + (ptsRedCard || 0)

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

                const headerLabel = isFinal ? ('🏆 '+t.shortF) : isThird ? ('🥉 '+t.short3P) : km
                  ? ({ R32: t.shortR32, R16: t.shortR16, QF: t.shortQF, SF: t.shortSF, '3P': t.short3P, F: t.shortF } as Record<string, string>)[km.round]
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
                          title={t.goToPrediction}
                          style={{
                            fontSize: 10, lineHeight: 1, padding: '1px 5px', borderRadius: 4,
                            background: 'rgba(255,255,255,0.15)', color: '#fff',
                            border: '1px solid rgba(255,255,255,0.3)',
                            cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600,
                          }}>✏️</button>
                      </div>
                    </div>

                    {/* ━━ SECTION 1: BRACKET PREDICTION ━━━━━━━━━━━━━━━━━━━━━━━━ */}
                    {isQFPlus && (
                      <div style={{ fontSize: 10, fontWeight: 700, color: '#444', background: '#EBF4FF',
                        padding: '2px 8px', letterSpacing: 0.3, borderBottom: '1px solid #d0e4f8' }}>
                        {lang === 'he' ? 'א. ניחוש ברקט 🔒' : 'A. Bracket pick 🔒'}
                      </div>
                    )}
                    {([['A', tA, advA], ['B', tB, advB]] as [string, string|undefined, string|false|undefined][]).map(([side, team, isAdv]) => {
                      const predScore = side === 'A' ? pred?.scoreA : pred?.scoreB
                      const hasThisScore = predScore !== null && predScore !== undefined
                      const roundLocked = km
                        ? (km.round === 'R32'
                            ? (knockoutDeadline != null && now > knockoutDeadline)
                            : isLocked)
                        : true
                      // Recursive chain check — traces the ENTIRE bracket path back.
                      // canTeamReachMatch defined above (before advInActualMatch)
                      const eliminated = isQFPlus && !!team && !canTeamReachMatch(team, id, side as 'A' | 'B')
                      return (
                        <div key={side}
                          onClick={() => !roundLocked && team && updateKnockout(id, 'advance', team)}
                          style={{
                            display: 'flex', alignItems: 'center',
                            padding: '5px 7px', gap: 5,
                            borderBottom: side === 'A' ? '1px solid #ebebeb' : 'none',
                            background: isAdv ? '#DBEAFE' : 'transparent',
                            cursor: (!roundLocked && team) ? 'pointer' : 'default',
                            opacity: eliminated ? 0.55 : 1,
                          }}>
                          <span style={{ lineHeight: 1, flexShrink: 0, filter: eliminated ? 'grayscale(80%)' : 'none' }}>
                            {team ? <Flag emoji={FLAGS[team] ?? ''} size={22} /> : ''}
                          </span>
                          <span style={{
                            flex: 1,
                            fontSize: compact ? 11 : 12, fontWeight: isAdv ? 700 : 500,
                            color: eliminated ? '#999' : isAdv ? '#1a4fa8' : team ? '#222' : '#ccc',
                            fontStyle: team ? 'normal' : 'italic',
                            textDecoration: eliminated ? 'line-through' : 'none',
                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                          }}>{team ? tn(team) : '...'}</span>
                          {/* Score shown inline only for R32/R16 where bracket = actual match */}
                          {hasThisScore && !isQFPlus && (
                            <span style={{ fontSize: 14, fontWeight: 700, color: isAdv ? '#1a4fa8' : '#555', minWidth: 16, textAlign: 'right' }}>
                              {predScore}
                            </span>
                          )}
                          {isAdv && !eliminated && <span style={{ fontSize: 11, color: '#2563EB', fontWeight: 700, marginRight: 2 }}>●</span>}
                          {eliminated && <span style={{ fontSize: 10, color: '#cc4444' }}>✕</span>}
                        </div>
                      )
                    })}

                    {/* ━━ SECTION 2: ACTUAL MATCH RESULT ━━━━━━━━━━━━━━━━━━━━━━━
                        For QF+: always show when teams are known (played or unplayed).
                        For R32/R16: show only when played (no diff between bracket & actual). */}
                    {isQFPlus && (actualTeamA || actualTeamB) && (
                      <div style={{ borderTop: '1.5px solid #ddd' }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: '#555', background: '#f0f0f0',
                          padding: '2px 8px', letterSpacing: 0.3 }}>
                          {lang === 'he' ? 'ב. תוצאה בפועל' : 'B. Actual result'}
                        </div>
                        <div style={{
                          padding: '5px 8px', background: '#f0f0f0',
                          display: 'flex', alignItems: 'center', gap: 4, fontSize: 11,
                        }}>
                        <span style={{
                          fontWeight: 600,
                          color: (isPlayed && actualAdvance === actualTeamA) ? '#1a5c30' : '#333',
                          display: 'flex', alignItems: 'center', gap: 3,
                        }}>
                          {actualTeamA
                            ? <><Flag emoji={FLAGS[actualTeamA] ?? ''} size={15} /> {tn(actualTeamA)}</>
                            : <span style={{ color: '#bbb', fontStyle: 'italic' }}>?</span>}
                        </span>
                        {isPlayed
                          ? <span style={{ fontWeight: 800, color: '#333', margin: '0 3px' }}>
                              {lang === 'he' ? `${actualB ?? 0}:${actualA ?? 0}` : `${actualA ?? 0}:${actualB ?? 0}`}
                            </span>
                          : <span style={{ color: '#aaa', margin: '0 4px' }}>vs</span>}
                        <span style={{
                          fontWeight: 600,
                          color: (isPlayed && actualAdvance === actualTeamB) ? '#1a5c30' : '#333',
                          display: 'flex', alignItems: 'center', gap: 3,
                        }}>
                          {actualTeamB
                            ? <>{tn(actualTeamB)} <Flag emoji={FLAGS[actualTeamB] ?? ''} size={15} /></>
                            : <span style={{ color: '#bbb', fontStyle: 'italic' }}>?</span>}
                        </span>
                        {actualAdvance && isPlayed && (
                          <span style={{ color: '#1a5c30', fontWeight: 700, marginRight: 'auto', fontSize: 10 }}>
                            → <Flag emoji={FLAGS[actualAdvance] ?? ''} size={14} />
                          </span>
                        )}
                        </div>
                      </div>
                    )}
                    {/* R32/R16: simplified result bar (bracket = actual, no separate section 2 needed) */}
                    {!isQFPlus && isPlayed && (
                      <div style={{
                        padding: '4px 7px', borderTop: '2px solid #d0d0d0', background: '#f0f0f0',
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4,
                      }}>
                        <span style={{ fontSize: 10, color: '#666', fontWeight: 600 }}>{t.actualResult}</span>
                        <span style={{ fontSize: 12, fontWeight: 800, color: '#333' }}>
                          {lang === 'he' ? `${actualB ?? 0}:${actualA ?? 0}` : `${actualA ?? 0}:${actualB ?? 0}`}
                        </span>
                        {actualAdvance && (
                          <span style={{ fontSize: 10, color: '#333', fontWeight: 600, flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: 4 }}>
                            <Flag emoji={FLAGS[actualAdvance] ?? ''} size={18} /> {tn(actualAdvance)} →
                          </span>
                        )}
                      </div>
                    )}

                    {/* ━━ SECTION 3: USER'S MATCH BET (QF+ only) ━━━━━━━━━━━━━━━━━━
                        Always shown for QF+ when user has a prediction (hasSomePred).
                        Uses ACTUAL teams (what was really played), not bracket teams. */}
                    {isQFPlus && pred?.prediction1X2 && (() => {
                      const x = pred?.prediction1X2
                      const winA = x === '1', winB = x === '2'
                      const sA = pred?.scoreA, sB = pred?.scoreB
                      const showTeamA = actualTeamA ?? tA
                      const showTeamB = actualTeamB ?? tB
                      return (
                        <div style={{ borderTop: '1.5px solid #ddd' }}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: '#555', background: '#f5f5fa',
                            padding: '2px 8px', letterSpacing: 0.3 }}>
                            {lang === 'he' ? 'ג. הימור שלך על המשחק' : 'C. Your match bet'}
                          </div>
                          <div style={{ padding: '5px 8px', background: '#f5f5fa', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontWeight: winA ? 800 : 400, color: winA ? '#1a4fa8' : '#777' }}>
                              {showTeamA && <Flag emoji={FLAGS[showTeamA] ?? ''} size={18} />}
                              {showTeamA ? tn(showTeamA) : '?'}
                            </span>
                            {sA !== undefined && sB !== undefined
                              ? <span style={{ fontWeight: 800, color: '#333', padding: '0 3px' }}>
                                  {lang === 'he' ? `${sB}:${sA}` : `${sA}:${sB}`}
                                </span>
                              : <span style={{ color: '#bbb' }}>–</span>}
                            <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontWeight: winB ? 800 : 400, color: winB ? '#1a4fa8' : '#777' }}>
                              {showTeamB ? tn(showTeamB) : '?'}
                              {showTeamB && <Flag emoji={FLAGS[showTeamB] ?? ''} size={18} />}
                            </span>
                            {x === 'X' && (
                              <span style={{ fontSize: 10, background: '#E6F1FB', color: '#0C447C', padding: '1px 5px', borderRadius: 4, fontWeight: 600 }}>
                                {lang === 'he' ? 'תיקו' : 'Draw'}
                              </span>
                            )}
                          </div>
                        </div>
                      )
                    })()}

                    {/* ━━ SECTION 4: SCORING GRID ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                        Clean rows per scoring category, one item per row.
                        Replaces the cramped flexWrap layout. */}
                    {hasSomePred && (() => {
                      const advBV = !km || km.round === 'R32' || km.round === 'R16'
                        || advPicked === tA || advPicked === tB

                      // Each scoring row: { label, flag, ok (true/false/null=pending), pts, warn, potential }
                      const rows: Array<{
                        key: string
                        labelText: string
                        flag?: string
                        lock?: boolean
                        ok: boolean | null  // null = not played yet
                        pts: number
                        warn?: boolean
                        potential?: number
                        special?: string   // emoji suffix
                      }> = []

                      // 1X2 row
                      if (pred1x2Label) {
                        const prefix1x2 = predResult === '1' ? '1: ' : predResult === '2' ? '2: ' : 'X: '
                        rows.push({
                          key: '1x2',
                          labelText: `${prefix1x2}${pred1x2Label}`,
                          flag: pred1x2Flag ?? undefined,
                          ok: isPlayed ? pts1x2 > 0 : null,
                          pts: pts1x2,
                          potential: !isPlayed ? (() => {
                            if (!km) return 0
                            const base = ({ R32: 1, R16: 1, QF: 2, SF: 3, '3P': 2, F: 3 } as Record<string,number>)[km.round]
                            const catBonus = { A: 0, B: 1, C: 2, D: 3 }[dynCat] ?? 0
                            if (predResult === 'X') return base + Math.max(0, catBonus - 1)
                            const pickIsFav = (predResult === '1' && aIsFav) || (predResult === '2' && !aIsFav)
                            return pickIsFav ? base : base + catBonus
                          })() : undefined,
                        })
                      }

                      // Score row — only show pre-match when 1X2 is also filled
                      if (hasScore && (isPlayed || pred?.prediction1X2)) {
                        if (isPlayed) {
                          const scoreBase = ptsScore === 2 || ptsScore === 3
                            ? t.exactScore
                            : ptsScore === 1 ? (lang === 'he' ? 'הפרש נכון' : 'Right diff')
                            : t.exactScore
                          // For exact scores: OU is bundled in ptsScore (=3), show suffix inline
                          // For non-exact: show score row alone, OU gets its own row below
                          const exactHasOU = ptsScore > 2  // calcScorePoints returns 3 = 2+OU
                          const ouSuffix = exactHasOU && predOuLabel ? ` (${predOuLabel})` : ''
                          rows.push({
                            key: 'score',
                            labelText: `${scoreBase}${ouSuffix}`,
                            ok: ptsScore > 0,
                            pts: ptsScore,  // ptsScore already includes OU for exact scores
                          })
                          // Independent OU row — only for non-exact predictions
                          if (ptsOU > 0 && predOuLabel && !exactHasOU) {
                            rows.push({
                              key: 'ou',
                              labelText: predOuLabel,  // "אנדר" or "אובר"
                              ok: true,
                              pts: ptsOU,
                            })
                          }
                        } else {
                          const sA = pred?.scoreA, sB = pred?.scoreB
                          const scoreStr = (sA !== undefined && sB !== undefined) ? (lang === 'he' ? `${sB}:${sA}` : `${sA}:${sB}`) : '?'
                          const ouPts = km ? ({ R32: 1, R16: 1, QF: 2, SF: 2, '3P': 1, F: 2 } as Record<string,number>)[km.round] : 1
                          const ouSuffix = predOuLabel ? ` (${predOuLabel})` : ''
                          rows.push({
                            key: 'score',
                            labelText: `${t.exactScore} ${scoreStr}${ouSuffix}`,
                            ok: null,
                            pts: 0,
                            potential: 2 + (predOuLabel ? ouPts : 0),
                          })
                        }
                      }

                      // Advance pick row — prefix "עולה: "
                      if (advPicked) {
                        const advPrefix = lang === 'he' ? 'עולה: ' : 'Adv: '
                        rows.push({
                          key: 'adv',
                          labelText: `${advPrefix}${tn(advPicked)}`,
                          flag: FLAGS[advPicked] ?? undefined,
                          lock: isLockedAdvance,
                          ok: isPlayed ? (advCorrect && advBV) : null,
                          pts: ptsAdv,
                          warn: !isPlayed && isQFPlus && !advInActualMatch,
                          potential: (!isPlayed && advBV && advInActualMatch) ? potentialAdvPts : undefined,
                          special: isSpecial && !isPlayed ? (isFinal ? '🏆' : '🥉') : undefined,
                        })
                      }

                      // Red card row
                      if (pickedRedCard) {
                        rows.push({
                          key: 'red',
                          labelText: lang === 'he' ? 'כרטיס אדום' : 'Red card',
                          flag: '🟥',
                          ok: isPlayed ? ptsRedCard > 0 : null,
                          pts: ptsRedCard,
                          potential: !isPlayed ? 2 : undefined,
                        })
                      }

                      if (rows.length === 0) return null

                      return (
                        <div style={{ borderTop: '1.5px solid #e8e8f0' }}>
                          {rows.map(row => (
                            <div key={row.key} style={{
                              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                              padding: '4px 8px',
                              borderBottom: '1px solid #f0f0f8',
                              background: row.ok === true ? '#f0fbf4' : row.ok === false ? '#fff5f5' : '#fff',
                            }}>
                              {/* Right side: label */}
                              <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontWeight: 600, fontSize: 11,
                                color: row.warn ? '#B45309' : row.ok === true ? '#1a5c30' : row.ok === false ? '#8b1f1f' : '#444' }}>
                                {row.flag && row.key !== 'red' && <Flag emoji={row.flag} size={16} />}
                                {row.key === 'red' && <span style={{ fontSize: 13 }}>🟥</span>}
                                {row.key === 'ou' && <span style={{ fontSize: 11 }}>⚽</span>}
                                {row.labelText}
                                {row.lock && <span style={{ fontSize: 9, opacity: 0.45, marginRight: 2 }}>🔒</span>}
                                {row.special && <span>{row.special}</span>}
                              </span>
                              {/* Left side: result indicator + points */}
                              <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontWeight: 700, fontSize: 11 }}>
                                {row.warn && (
                                  <span style={{ color: '#B45309', fontSize: 10 }}>⚠️ לא הגיעה</span>
                                )}
                                {!row.warn && row.ok === true && (
                                  <>
                                    <span style={{ color: '#1a7a44' }}>✓</span>
                                    <span style={{ color: '#1a7a44' }}>+{row.pts}</span>
                                  </>
                                )}
                                {!row.warn && row.ok === false && (
                                  <span style={{ color: '#cc3333' }}>✗</span>
                                )}
                                {!row.warn && row.ok === null && row.potential !== undefined && (
                                  <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 4, fontWeight: 700,
                                    background: '#e8f5e9', color: '#1a5c30' }}>
                                    +{row.potential}
                                  </span>
                                )}
                              </span>
                            </div>
                          ))}
                        </div>
                      )
                    })()}
                    {!advPicked && tA && tB && !isQFPlus && (
                      <div style={{ padding: '4px 7px', borderTop: '1px solid #f0f0f0', background: '#fafafa' }}>
                        <span style={{ fontSize: 10, color: '#aaa' }}>{t.clickToAdvance}</span>
                      </div>
                    )}


                    {/* ── TOTAL POINTS (when played) ── */}
                    {isPlayed && hasSomePred && (() => {
                      const safeTotal = (pts1x2 || 0) + (ptsScore || 0) + (ptsOU || 0) + (ptsAdv || 0) + (ptsRedCard || 0)
                      return safeTotal > 0 ? (
                        <div style={{
                          padding: '3px 7px', background: '#1a7a44',
                          display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 4,
                        }}>
                          <span style={{ fontSize: 11, color: '#fff', fontWeight: 800 }}>{t.totalPts}: +{safeTotal} {t.pts}</span>
                        </div>
                      ) : (
                        <div style={{
                          padding: '3px 7px', background: '#e8e8e8',
                          display: 'flex', justifyContent: 'center',
                        }}>
                          <span style={{ fontSize: 10, color: '#888' }}>{t.zeroPtsMatch}</span>
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
                        const advInMatch = !tA || !tB || pred.advance === tA || pred.advance === tB
                        if (advInMatch) {
                          const advBase = { R32: 1, R16: 2, QF: 3, SF: 4, '3P': 2, F: 5 }[km.round]
                          const advCatBonus = { A: 0, B: 1, C: 2, D: 2 }[dynCat] ?? 0
                          const pickedUnd = (pred.advance === tA && !aIsFav) || (pred.advance === tB && aIsFav)
                          maxPtsAdv += advBase + (pickedUnd ? advCatBonus : 0)
                        }
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
                            <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>{t.maxIfCorrect}</div>
                            {maxTotal > 0 ? (
                              <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                                <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 5, background: '#E6F1FB', color: '#0C447C', fontWeight: 600 }}>1X2: {maxPts1x2}</span>
                                <span style={{ fontSize: 10, color: '#ccc' }}>+</span>
                                <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 5, background: '#EAF3DE', color: '#27500A', fontWeight: 600 }}>תוצאה: {maxPtsScore}</span>
                                <span style={{ fontSize: 10, color: '#ccc' }}>+</span>
                                <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 5, background: '#FAEEDA', color: '#633806', fontWeight: 600 }}>עולה: {maxPtsAdv}</span>
                                {maxPtsRC > 0 && <>
                                  <span style={{ fontSize: 10, color: '#ccc' }}>+</span>
                                  <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 5, background: '#FCEBEB', color: '#791F1F', fontWeight: 600 }}>כרטיס: {maxPtsRC}</span>
                                </>}
                                <span style={{ fontSize: 13, fontWeight: 700, color: '#555' }}>≈{maxTotal}</span>
                              </div>
                            ) : <span style={{ fontSize: 14, color: '#aaa' }}>—</span>}
                          </div>

                          {hasActual && <>
                            <div style={{ width: 1, background: '#e0e0e0', alignSelf: 'stretch' }} />

                            {/* Actual earned */}
                            <div style={{ flex: 1, minWidth: 180 }}>
                              <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>{t.actualEarned}</div>
                              <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                                <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 5, background: '#E6F1FB', color: '#0C447C', fontWeight: 600 }}>1X2: {actPts1x2}</span>
                                <span style={{ fontSize: 10, color: '#ccc' }}>+</span>
                                <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 5, background: '#EAF3DE', color: '#27500A', fontWeight: 600 }}>תוצאה: {actPtsScore}</span>
                                <span style={{ fontSize: 10, color: '#ccc' }}>+</span>
                                <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 5, background: '#FAEEDA', color: '#633806', fontWeight: 600 }}>עולה: {actPtsAdv}</span>
                                {(actPtsRC > 0 || maxPtsRC > 0) && <>
                                  <span style={{ fontSize: 10, color: '#ccc' }}>+</span>
                                  <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 5, background: '#FCEBEB', color: '#791F1F', fontWeight: 600 }}>כרטיס: {actPtsRC}</span>
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

                  {/* CENTER — Final + Third side by side.
                      Both come from the SF results, so they sit together between the two SF cards. */}
                  <div style={{ margin: '4px 0' }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#1a1a2e', textAlign: 'center', padding: '4px 8px', letterSpacing: '0.02em', background: 'linear-gradient(to right, transparent, #f0f0fa, transparent)', borderTop: '1.5px solid #d0d0e8', borderBottom: '1.5px solid #d0d0e8', marginBottom: 6 }}>
                      {t.roundF} &nbsp;·&nbsp; {t.round3P}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <MatchCard id={104} variant="final" />
                      <MatchCard id={103} variant="third" />
                    </div>
                  </div>

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
            // Compute first unfilled match across all open rounds for sticky button
            const allOpenRounds = (['R32', 'R16', 'QF', 'SF', '3P', 'F'] as const).filter(r => !isRoundLocked(r))
            const firstUnfilledId = (() => {
              for (const r of allOpenRounds) {
                const needsAdv = r === 'R32' || r === 'R16'
                for (const km of KNOCKOUT_MATCHES.filter(m => m.round === r)) {
                  const tA = getFormTeam(km.id, 'A'), tB = getFormTeam(km.id, 'B')
                  if (!tA || !tB) continue
                  const p = knockoutPreds[km.id]
                  if (!p?.prediction1X2 || p?.scoreA == null || p?.scoreB == null) return km.id
                  if (needsAdv && !p?.advance) return km.id
                }
              }
              return null
            })()

            const jumpToNext = () => {
              if (!firstUnfilledId) return
              // Open the round accordion if closed
              const km = KNOCKOUT_MATCHES.find(m => m.id === firstUnfilledId)
              if (km) setOpenRounds(prev => new Set([...prev, km.round]))
              setTimeout(() => {
                document.getElementById(`ko-match-${firstUnfilledId}`)
                  ?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
              }, 80)
            }

            return (<>
              {(['R32', 'R16', 'QF', 'SF', '3P', 'F'] as const).map(round => {
              const roundMatches = KNOCKOUT_MATCHES.filter(m => m.round === round)
              const redCardRounds = { R32: 3, R16: 2, QF: 1 } as Record<string, number>
              const maxRedCards = redCardRounds[round]
              const redCardPicks = maxRedCards ? (knockoutRedCards[round as 'R32' | 'R16' | 'QF'] ?? []) : []
              const hasRedCard = round === 'R32' || round === 'R16'
              const roundLocked = isRoundLocked(round)

              // Deadline for this round
              const roundDeadlineTs: number | null =
                round === 'R32' ? knockoutDeadline :
                round === 'R16' ? r16Deadline :
                round === 'QF'  ? qfDeadline :
                round === 'SF' ? sfDeadline :
                round === '3P' ? (p3Deadline ?? finalDeadline) :
                round === 'F'   ? finalDeadline : null

              // Hide rounds with no deadline yet — they're future rounds not yet opened
              if (roundDeadlineTs === null) return null

              // Completion count: how many matches have a full prediction
              const needsAdvance = round === 'R32' || round === 'R16'
              const availableMatches = roundMatches.filter(km => {
                const tA = getFormTeam(km.id, 'A'), tB = getFormTeam(km.id, 'B')
                return !!(tA && tB)
              })
              const filledMatches = availableMatches.filter(km => {
                const p = knockoutPreds[km.id]
                if (!p?.prediction1X2) return false
                if (p?.scoreA === null || p?.scoreA === undefined) return false
                if (p?.scoreB === null || p?.scoreB === undefined) return false
                if (needsAdvance && !p?.advance) return false
                return true
              })
              const filled = filledMatches.length
              const total = availableMatches.length
              const allFilled = total > 0 && filled === total
              const isActive = round === activeKoRound
              const isOpen = openRounds.has(round)

              const roundLabel = KNOCKOUT_ROUND_LABELS[round]

              return (
                <div key={round} style={{ marginBottom: 8, borderRadius: 12, overflow: 'hidden',
                  border: `1.5px solid ${isActive ? '#1a7a44' : roundLocked ? '#e0e0e0' : '#d0d0e8'}`,
                  boxShadow: isActive ? '0 2px 8px rgba(26,122,68,0.12)' : 'none',
                }}>
                  {/* Accordion Header */}
                  <div
                    onClick={() => toggleRound(round)}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '10px 14px', cursor: 'pointer', userSelect: 'none',
                      background: isActive ? '#f0fbf4'
                        : allFilled ? '#f8fffe'
                        : roundLocked ? '#fafafa' : '#fff',
                    }}>
                    {/* Right: label + status */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 14, fontWeight: 700,
                        color: isActive ? '#1a5c30' : roundLocked ? '#999' : '#1a1a2e' }}>
                        {roundLabel}
                      </span>
                      {isActive && !roundLocked && (
                        <span style={{ fontSize: 11, background: '#1a7a44', color: '#fff',
                          borderRadius: 6, padding: '1px 7px', fontWeight: 600 }}>
                          {lang === 'he' ? 'פתוח' : 'Open'}
                        </span>
                      )}
                      {roundLocked && (
                        <span style={{ fontSize: 12, color: '#bbb' }}>🔒</span>
                      )}
                    </div>
                    {/* Left: progress + chevron */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      {total > 0 && (
                        <span style={{
                          fontSize: 12, fontWeight: 600,
                          color: allFilled ? '#1a7a44' : filled > 0 ? '#B45309' : '#bbb',
                        }}>
                          {allFilled ? '✓ ' : ''}{filled}/{total}
                        </span>
                      )}
                      <span style={{ fontSize: 12, color: '#999', fontWeight: 700, transition: 'transform 0.2s',
                        display: 'inline-block', transform: isOpen ? 'rotate(180deg)' : 'none' }}>
                        ▼
                      </span>
                    </div>
                  </div>

                  {/* Accordion Body */}
                  {isOpen && (
                    <div style={{ borderTop: `1px solid ${isActive ? '#c0e8d0' : '#eee'}` }}>
                      <DeadlineBanner deadline={roundDeadlineTs} locked={roundLocked} />

                      {/* Jump button now handled by sticky bar below — just mark matches with IDs */}

                      {/* Red card picks — per round */}
                      {maxRedCards && (
                        <div style={{ margin: '0 0 12px', padding: '10px 14px', background: '#fff5f5', border: '1px solid #fdd', borderRadius: 10 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: '#A32D2D', marginBottom: 8 }}>
                            {maxRedCards === 1 ? t.redCard : `🟥 ${t.redCards}`}
                            <span style={{ fontWeight: 400, color: '#999', marginRight: 6 }}>({redCardPicks.length}/{maxRedCards} נבחרו | 2 נק׳ לכל ניחוש נכון)</span>
                          </div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            {roundMatches.map(km => {
                              const tA = getFormTeam(km.id, 'A')
                              const tB = getFormTeam(km.id, 'B')
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
                                  <><Flag emoji={FLAGS[tA] ?? ''} size={22} /> {tn(tA)} vs <Flag emoji={FLAGS[tB] ?? ''} size={22} /> {tn(tB)}</>
                                  {isPicked && ' 🟥'}
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      )}
                  {roundMatches.map(km => {
                    const teamA = getFormTeam(km.id, 'A')
                    const teamB = getFormTeam(km.id, 'B')
                    const pred = knockoutPreds[km.id]
                    const teamsReady = !!(teamA && teamB)
                    const isFocused = focusMatchId === km.id

                    // For QF+: what the user predicted from bracket (may differ from actual)
                    const bracketTeamA = km.round !== 'R32' && km.round !== 'R16' ? getTeamSafe(km.id, 'A') : undefined
                    const bracketTeamB = km.round !== 'R32' && km.round !== 'R16' ? getTeamSafe(km.id, 'B') : undefined
                    const bracketDiffersFromActual = bracketTeamA && teamA && bracketTeamA !== teamA

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
                              <><Flag emoji={FLAGS[teamA!] ?? ''} size={22} /> {tn(teamA)} {t.versus} {tn(teamB)} <Flag emoji={FLAGS[teamB!] ?? ''} size={22} /></>
                            </span>
                          ) : (
                            <span style={{ fontSize: 12, color: '#bbb' }}>
                              {round === 'R32' ? t.koPendingAdmin : t.koPendingPrev}
                            </span>
                          )}
                          {r16Deadline != null && (
                            <button
                              onClick={() => {
                                setKnockoutView('bracket')
                                setTimeout(() => {
                                  document.getElementById(`bracket-match-${km.id}`)
                                    ?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
                                }, 150)
                              }}
                              title={lang === 'he' ? 'עבור לעץ' : 'Go to bracket'}
                              style={{
                                marginRight: 'auto', fontSize: 12, padding: '2px 7px',
                                borderRadius: 6, border: '1px solid #ccc',
                                background: '#f8f8f8', color: '#555',
                                cursor: 'pointer', fontFamily: 'inherit',
                              }}>
                              🌳
                            </button>
                          )}
                        </div>

                        {/* Match header with date — same style as group stage */}
                        <div className="match-header">
                          <span className="match-datetime">
                            🗓 {MATCH_SCHEDULE[km.id] ?? '—'}
                          </span>
                          <span style={{ fontSize: 12, color: '#888', fontWeight: 500 }}>
                            {tn(teamA ?? '?')} {lang === 'he' ? 'נגד' : 'vs'} {tn(teamB ?? '?')}
                          </span>
                        </div>
                        {teamsReady && (
                          <div style={{ padding: '12px 14px' }}>
                            {/* FIFA rank lookup */}
                            {(() => {
                              const sortedTeams = Object.entries(TEAM_FIFA_POINTS).sort((a,b)=>b[1]-a[1])
                              const rankOf = (t: string) => { const i = sortedTeams.findIndex(([n])=>n===t); return i >= 0 ? i+1 : null }
                              const rankA = teamA ? rankOf(teamA) : null
                              const rankB = teamB ? rankOf(teamB) : null
                              return (
                            <div className="match-body">
                              <div className="team-name">
                                <span className="team-flag"><Flag emoji={FLAGS[teamA!] ?? ''} size={24} /></span>
                                <span>{teamA}</span>
                                {rankA && <span style={{ fontSize: 10, color: '#aaa', display: 'block', textAlign: 'center' }}>FIFA #{rankA}</span>}
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
                                {rankB && <span style={{ fontSize: 10, color: '#aaa', display: 'block', textAlign: 'center' }}>FIFA #{rankB}</span>}
                                <span className="team-flag"><Flag emoji={FLAGS[teamB!] ?? ''} size={24} /></span>
                              </div>
                            </div>
                              )
                            })()}

                            <div className="match-1x2-row">
                              <div className="btn-group-1x2">
                                {([['1', teamA!], ['X', t.draw.replace('✖ ','')], ['2', teamB!]] as [Result1X2, string][]).map(([val, label]) => (
                                  <button key={val}
                                    className={`btn-1x2 ${pred?.prediction1X2 === val ? 'selected' : ''}`}
                                    disabled={roundLocked}
                                    onClick={() => updateKnockout(km.id, 'prediction1X2', val)}>
                                    <>{FLAGS[label] ? <><Flag emoji={FLAGS[label]} size={20} /> {tn(label)}</> : label}</>
                                  </button>
                                ))}
                              </div>
                            </div>

                            {/* Advance picker — only for R32/R16 (not bracket rounds) */}
                            {!bracketTeamA && (
                              <div style={{ padding: '8px 14px', borderTop: '1px solid #f0f0f0' }}>
                                <div style={{ fontSize: 11, color: '#888', marginBottom: 5 }}>{t.koWhoAdvanceQ}</div>
                                <div style={{ display: 'flex', gap: 6 }}>
                                  {([teamA!, teamB!] as string[]).map(team => {
                                    const isSelected = pred?.advance === team
                                    return (
                                      <button key={team}
                                        disabled={roundLocked}
                                        onClick={() => !roundLocked && updateKnockout(km.id, 'advance', team)}
                                        style={{
                                          flex: 1, padding: '7px 6px',
                                          border: isSelected ? '2px solid #1a7a44' : '1px solid #ddd',
                                          borderRadius: 8,
                                          background: isSelected ? '#EAF3DE' : '#fff',
                                          color: isSelected ? '#1a7a44' : '#555',
                                          fontWeight: isSelected ? 700 : 400,
                                          fontSize: 12, cursor: roundLocked ? 'default' : 'pointer',
                                          fontFamily: 'inherit', opacity: roundLocked ? 0.6 : 1,
                                        }}>
                                        <><Flag emoji={FLAGS[team] ?? ''} size={20} /> {tn(team)}</>
                                      </button>
                                    )
                                  })}
                                </div>
                              </div>
                            )}

                            {/* QF+ bracket prediction — locked section */}
                            {bracketTeamA && (
                              <div style={{
                                borderTop: '2px solid #e8e8f0', margin: '0 -14px',
                                padding: '10px 14px', background: '#f5f5fa',
                              }}>
                                <div style={{ fontSize: 11, color: '#666', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 5 }}>
                                  <span>🔒</span>
                                  <span style={{ fontWeight: 600 }}>{lang === 'he' ? 'ניחוש העץ שלך' : 'Your bracket prediction'}</span>
                                  <span style={{ color: '#aaa', fontWeight: 400 }}>{lang === 'he' ? '(לא ניתן לשינוי)' : '(locked)'}</span>
                                </div>
                                {/* Predicted matchup */}
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                                  <span style={{ fontSize: 13, color: bracketTeamA !== teamA ? '#B45309' : '#333', fontWeight: 600 }}>
                                    <Flag emoji={FLAGS[bracketTeamA] ?? ''} size={20} /> {tn(bracketTeamA)}
                                  </span>
                                  <span style={{ color: '#bbb', fontSize: 12 }}>{t.versus}</span>
                                  <span style={{ fontSize: 13, color: bracketTeamB !== teamB ? '#B45309' : '#333', fontWeight: 600 }}>
                                    <Flag emoji={FLAGS[bracketTeamB ?? ''] ?? ''} size={20} /> {tn(bracketTeamB ?? '')}
                                  </span>
                                  {bracketDiffersFromActual && (
                                    <span style={{ fontSize: 11, color: '#B45309', marginRight: 'auto' }}>
                                      ≠ {lang === 'he' ? 'מהמשחק בפועל' : 'differs from actual'}
                                    </span>
                                  )}
                                </div>
                                {/* Predicted advance pick */}
                                {pred?.advance && (() => {
                                  const advInMatch = pred.advance === teamA || pred.advance === teamB
                                  return (
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                      <span style={{ fontSize: 11, color: '#888' }}>{t.koWhoAdvanceQ}</span>
                                      <span style={{
                                        padding: '3px 10px', borderRadius: 20, fontSize: 12, fontWeight: 700,
                                        background: advInMatch ? '#EAF3DE' : '#FEF3C7',
                                        color: advInMatch ? '#1a7a44' : '#92400E',
                                        opacity: 0.85,
                                      }}>
                                        <Flag emoji={FLAGS[pred.advance] ?? ''} size={16} /> {tn(pred.advance)}
                                        {!advInMatch && <span style={{ fontSize: 10, marginRight: 4 }}>⚠️ {lang === 'he' ? 'לא הגיעה' : 'did not reach'} — 0 נק׳</span>}
                                      </span>
                                    </div>
                                  )
                                })()}
                              </div>
                            )}

                            <div style={{ padding: '10px 14px', background: '#f8f9ff', borderTop: '1px solid #f0f0f0' }}>
                              {!pred?.prediction1X2 ? (
                                <div style={{ background: '#FAEEDA', borderRadius: 8, padding: '7px 10px', fontSize: 12, color: '#633806', display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <span>⚠️</span> {t.warning1x2}
                                </div>
                              ) : (() => {
                                const catIdx = { A: 0, B: 1, C: 2, D: 3 }[dynCat]
                                const isFav = (pred.prediction1X2 === '1' && aIsFavForm) || (pred.prediction1X2 === '2' && !aIsFavForm)
                                const roundBase = { R32: 1, R16: 1, QF: 2, SF: 3, '3P': 2, F: 3 }[km.round]
                                const catBonus = { A: 0, B: 1, C: 2, D: 3 }[dynCat]
                                const p1x2 = pred.prediction1X2 === 'X'
                                  ? roundBase + Math.max(0, catBonus - 1)
                                  : isFav ? roundBase : roundBase + catBonus
                                const breakdown: React.ReactNode[] = [`1X2: ${p1x2}`]
                                let total = p1x2

                                if (pred.scoreA !== null && pred.scoreA !== undefined) {
                                  const goalTotal = Number(pred.scoreA) + Number(pred.scoreB ?? 0)
                                  const ouPts = { R32: 1, R16: 1, QF: 2, SF: 2, '3P': 1, F: 2 }[km.round]
                                  const ouT = getOUType(goalTotal, dynCat as any, km.round)
                                  if (ouT) {
                                    const ouLabel = ouT === 'under' ? t.under : t.over
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
                                  breakdown.push(`${t.redCard}: 2`)
                                  total += 2
                                }

                                if (pred.advance) {
                                  const advInMatch = !bracketTeamA || pred.advance === teamA || pred.advance === teamB
                                  if (advInMatch) {
                                    const advBase = ({ R32: 1, R16: 2, QF: 3, SF: 4, '3P': 2, F: 5 } as Record<string, number>)[km.round]
                                    const advCatBonus = { A: 0, B: 1, C: 2, D: 2 }[dynCat]
                                    const pickedUnderdog = (pred.advance === teamA && !aIsFavForm) || (pred.advance === teamB && aIsFavForm)
                                    const advPts = advBase + (pickedUnderdog ? advCatBonus : 0)
                                    const advEmoji = pred.advance === teamA ? (FLAGS[teamA!] ?? '') : (FLAGS[teamB!] ?? '')
                                    breakdown.push(<span key="adv">{t.koAdvance} (<Flag emoji={advEmoji} size={14} /> {pred.advance}): {advPts}</span>)
                                    total += advPts
                                  } else {
                                    breakdown.push(<span key="adv" style={{ color: '#B45309' }}>{t.koAdvance} (<Flag emoji={FLAGS[pred.advance] ?? ''} size={14} /> {pred.advance}): 0 ⚠️</span>)
                                  }
                                }

                                return (
                                  <div className="max-pts-bar">
                                    <span className="max-pts-label">{t.maxLabel}:</span>
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
                  )}
                </div>
              )
            })}

              {/* Sticky "next unfilled" button — always visible at bottom of form */}
              {firstUnfilledId && (
                <div style={{
                  position: 'sticky', bottom: 12, zIndex: 50,
                  display: 'flex', justifyContent: 'center',
                  pointerEvents: 'none',
                }}>
                  <button
                    onClick={jumpToNext}
                    style={{
                      pointerEvents: 'all',
                      padding: '9px 20px', borderRadius: 24,
                      border: 'none', background: '#1a1a2e',
                      color: '#fff', fontSize: 13, fontWeight: 700,
                      cursor: 'pointer', fontFamily: 'inherit',
                      boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
                      display: 'flex', alignItems: 'center', gap: 6,
                    }}>
                    ↓ {lang === 'he' ? 'משחק הבא שלא מולא' : 'Next unfilled match'}
                  </button>
                </div>
              )}
            </>)
          })()}
        </div>
      )}

      {/* ── TOOLTIP PORTAL — renders outside all overflow containers ── */}
      {tooltipGroup && (() => {
        const key = tooltipGroup
        const groupKey = key.replace(/^(mini-|bonus-)/, '')
        const gMatches = MATCHES.filter(m => m.group === groupKey)
        return createPortal(
          <div
            style={{
              position: 'absolute', top: tooltipPos.y, left: tooltipPos.x,
              transform: 'translateX(-50%)', zIndex: 9999,
              background: '#fff', border: '1px solid #ddd', borderRadius: 10,
              boxShadow: '0 4px 20px rgba(0,0,0,0.18)', padding: '10px 12px',
              minWidth: 240, pointerEvents: 'auto',
            }}
            onMouseEnter={() => setTooltipGroup(key)}
            onMouseLeave={hideTooltip}
          >
            <div style={{ fontSize: 11, fontWeight: 700, color: '#666', marginBottom: 8 }}>
              {lang === 'he' ? `משחקי בית ${groupKey}` : `Group ${groupKey} matches`}
            </div>
            {gMatches.map(m => {
              const pred = matchPreds[m.id]
              const hasScore = pred?.scoreA != null && pred?.scoreB != null
              return (
                <div key={m.id} onClick={() => goToMatch(m.id)} style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px',
                  borderRadius: 6, cursor: 'pointer', marginBottom: 2,
                }}
                onMouseEnter={e => (e.currentTarget.style.background = '#f5f5f5')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <Flag emoji={FLAGS[m.teamA] ?? ''} size={14} />
                  <span style={{ fontSize: 12, color: '#333', flex: 1 }}>{tn(m.teamA)}</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: hasScore ? '#1a1a2e' : '#ccc', minWidth: 36, textAlign: 'center' }}>
                    {hasScore ? `${pred.scoreA}–${pred.scoreB}` : '–'}
                  </span>
                  <span style={{ fontSize: 12, color: '#333', flex: 1, textAlign: 'right' }}>{tn(m.teamB)}</span>
                  <Flag emoji={FLAGS[m.teamB] ?? ''} size={14} />
                </div>
              )
            })}
          </div>,
          document.body
        )
      })()}
    </div>
  )
}

function BonusInput({ q, value, disabled, onChange, t, lang }: {
  q: typeof BONUS_QUESTIONS[number]; value: string; disabled: boolean
  onChange: (v: string) => void; t: Translations; lang: Lang
}) {
  const allTeams = Object.values(GROUPS_TEAMS).flat()
  const tnLocal = (name: string) => lang === 'en' ? (TEAM_EN[name] ?? name) : name
  if (q.type === 'team') return (
    <select value={value} disabled={disabled} onChange={e => onChange(e.target.value)}>
      <option value="">{t.selectTeam}</option>
      {[...allTeams].sort().map(tm => <option key={tm} value={tm}>{FLAGS[tm] ?? ''} {tnLocal(tm)}</option>)}
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
