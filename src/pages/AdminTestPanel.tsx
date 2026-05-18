import { useState, useEffect } from 'react'
import { doc, setDoc, deleteDoc, collection, getDocs, updateDoc } from 'firebase/firestore'
import { db } from '../firebase'
import {
  MATCHES, GROUPS_TEAMS, BONUS_QUESTIONS, KNOCKOUT_MATCHES,
  KNOCKOUT_BRACKET, TEAM_FIFA_POINTS, calcCategoryByRound,
} from '../data/matches'
import { computeUserScore } from '../scoring'
import { populateR32Teams } from '../utils/syncLogic'
import { Match, KnockoutMatchPrediction } from '../types'

// ── helpers ─────────────────────────────────────────────────────────────────

function genGroupResults(): Record<number, Partial<Match>> {
  const out: Record<number, Partial<Match>> = {}
  for (const m of MATCHES) {
    const mod = m.id % 6
    const [rA, rB] =
      mod === 0 ? [1, 0] : mod === 1 ? [5, 0] : mod === 2 ? [0, 0] :
      mod === 3 ? [0, 2] : mod === 4 ? [2, 1] : [4, 0]
    out[m.id] = { id: m.id, resultA: rA, resultB: rB, isPlayed: true, hadRedCard: m.id % 3 === 0 }
  }
  return out
}

function computeQualifiers(
  results: Record<number, Partial<Match>>
): Record<string, [string, string, string]> {
  const pts: Record<string, Record<string, number>> = {}
  for (const m of MATCHES) {
    const r = results[m.id]; if (!r || !m.teamA || !m.teamB) continue
    const g = m.group
    if (!pts[g]) pts[g] = {}
    if (!pts[g][m.teamA]) pts[g][m.teamA] = 0
    if (!pts[g][m.teamB]) pts[g][m.teamB] = 0
    if ((r.resultA ?? 0) > (r.resultB ?? 0)) pts[g][m.teamA] += 3
    else if ((r.resultA ?? 0) < (r.resultB ?? 0)) pts[g][m.teamB] += 3
    else { pts[g][m.teamA]++; pts[g][m.teamB]++ }
  }
  const out: Record<string, [string, string, string]> = {}
  for (const [g, teams] of Object.entries(pts)) {
    const s = Object.entries(teams).sort((a, b) => b[1] - a[1]).map(([t]) => t)
    out[g] = [s[0] ?? '', s[1] ?? '', s[2] ?? ''] as [string, string, string]
  }
  return out
}

function computeBest8(
  groups: Record<string, [string, string, string]>,
  results: Record<number, Partial<Match>>
): string[] {
  return Object.entries(groups).map(([g, teams]) => {
    const third = teams[2]; if (!third) return null
    let pts = 0, gd = 0, gf = 0
    for (const m of MATCHES.filter(m => m.group === g)) {
      const r = results[m.id]; if (!r) continue
      const isA = m.teamA === third, isB = m.teamB === third; if (!isA && !isB) continue
      const [rA, rB] = [r.resultA ?? 0, r.resultB ?? 0]
      if (rA > rB) { if (isA) { pts += 3; gd += rA - rB; gf += rA } else { gd -= rA - rB; gf += rB } }
      else if (rB > rA) { if (isB) { pts += 3; gd += rB - rA; gf += rB } else { gd -= rB - rA; gf += rA } }
      else { pts++; gf += isA ? rA : rB }
    }
    return { team: third, pts, gd, gf }
  }).filter(Boolean)
    .sort((a: any, b: any) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf)
    .slice(0, 8)
    .map((t: any) => t.team)
}

// Random prediction (correct ~40% of the time)
function randomPred(actual1x2: '1' | 'X' | '2', scoreA: number, scoreB: number, id: number) {
  const seed = (id * 7 + 13) % 5
  if (seed < 2) return { x: actual1x2, sA: scoreA, sB: scoreB }   // correct
  if (seed === 2) return { x: 'X' as const, sA: 1, sB: 1 }         // draw guess
  const flip = (id % 2 === 0) ? '1' : '2'
  return { x: flip as '1' | '2', sA: 2, sB: 1 }                    // wrong pick
}

// ── BRACKET TEAM RESOLVER ─────────────────────────────────────────────────────
// Resolves what the USER's bracket predicts for a given match slot.
// Uses user's advance picks (preds) — NOT actual results.
//   feederId > 0 : winner of that match = preds[feederId].advance
//   feederId < 0 : loser  of that match = the team in that match that is NOT the winner
//   feederId === null : team set by admin (from koMatches)
function resolveBracketTeam(
  matchId: number,
  side: 'A' | 'B',
  preds: Record<number, KnockoutMatchPrediction>,
  koMatches: Record<number, any>
): string | undefined {
  const b = KNOCKOUT_BRACKET[matchId]
  if (!b) return undefined
  const feederId = side === 'A' ? b.feederA : b.feederB

  if (feederId === null) {
    // Admin-set team (R32 level)
    return side === 'A' ? koMatches[matchId]?.teamA : koMatches[matchId]?.teamB
  }

  if (feederId > 0) {
    // Winner of feeder match = that match's user advance pick
    return preds[feederId]?.advance
  }

  // feederId < 0 → loser of Math.abs(feederId) SF match
  const sfId = Math.abs(feederId)
  const sfBracket = KNOCKOUT_BRACKET[sfId]
  if (!sfBracket) return undefined
  const sfTeamA = sfBracket.feederA !== null && sfBracket.feederA > 0
    ? preds[sfBracket.feederA]?.advance : undefined
  const sfTeamB = sfBracket.feederB !== null && sfBracket.feederB > 0
    ? preds[sfBracket.feederB]?.advance : undefined
  const sfWinner = preds[sfId]?.advance
  if (!sfWinner) return sfTeamA ?? sfTeamB
  if (sfWinner === sfTeamA) return sfTeamB
  if (sfWinner === sfTeamB) return sfTeamA
  return undefined
}

// ── BUILD SIMULATED TOURNAMENT ────────────────────────────────────────────────
export default function AdminTestPanel() {
  const [log, setLog] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<Set<string>>(new Set())
  const [users, setUsers] = useState<{ uid: string; name: string }[]>([])
  const [selectedUid, setSelectedUid] = useState('')

  // Load users from Firestore on mount
  useEffect(() => {
    getDocs(collection(db, 'users')).then(snap => {
      const list = snap.docs.map(d => ({
        uid: d.id,
        name: d.data().userName ?? d.data().displayName ?? d.data().name ?? d.id,
      }))
      setUsers(list)
      if (list.length > 0) setSelectedUid(list[0].uid)
    }).catch(() => {})
  }, [])

  const selectedUser = users.find(u => u.uid === selectedUid)
  const TEST_UID  = selectedUid
  const TEST_NAME = selectedUser?.name ?? selectedUid

  const addLog = (msg: string) => setLog(p => [...p, msg])
  const markDone = (key: string) => setDone(p => new Set([...p, key]))
  const wrap = async (key: string, fn: () => Promise<void>) => {
    setBusy(true)
    try { await fn(); markDone(key); addLog(`✅ ${key}`) }
    catch (e: any) { addLog(`❌ ${key}: ${e.message}`) }
    finally { setBusy(false) }
  }

  // updateDoc treats dots as nested field paths (setDoc with merge:true does NOT)
  const saveKnockout = async (uid: string, preds: Record<number, Partial<KnockoutMatchPrediction>>) => {
    if (!uid) { addLog('  ⚠️ לא נבחר משתמש'); return }
    const data: Record<string, any> = {}
    for (const [id, pred] of Object.entries(preds)) {
      if (!pred) continue
      for (const [field, val] of Object.entries(pred as Record<string, any>)) {
        if (val !== undefined) data[`knockout.${id}.${field}`] = val
      }
    }
    if (Object.keys(data).length === 0) { addLog('  ⚠️ אין נתונים לשמור'); return }
    try {
      await updateDoc(doc(db, 'predictions', uid), data)
    } catch (e: any) {
      if (e?.code === 'not-found') {
        await setDoc(doc(db, 'predictions', uid), { userId: uid })
        await updateDoc(doc(db, 'predictions', uid), data)
      } else throw e
    }
  }

  // ── Pre-compute tournament data ───────────────────────────────────────────
  const gsResults = genGroupResults()
  const groups    = computeQualifiers(gsResults)
  const best8     = computeBest8(groups, gsResults)
  const { updatedKnockout: r32base } = populateR32Teams(
    groups as any, best8, {}, TEAM_FIFA_POINTS, calcCategoryByRound
  )

  // Simulate full KO tree with actual results
  const allKo = KNOCKOUT_MATCHES.slice().sort((a, b) => a.id - b.id)
  const koMatches: Record<number, any> = {}

  // Init from base
  for (const km of allKo) koMatches[km.id] = { ...km }
  for (const [id, km] of Object.entries(r32base)) {
    const n = Number(id)
    if (koMatches[n]) koMatches[n] = { ...koMatches[n], ...(km as any) }
  }

  // Simulate each round, propagating winners/losers
  const ROUND_ORDER = ['R32', 'R16', 'QF', 'SF', '3P', 'F'] as const
  for (const round of ROUND_ORDER) {
    for (const km of allKo.filter(k => k.round === round)) {
      const m = koMatches[km.id]
      if (!m?.teamA || !m?.teamB) continue
      const aIsFav = (TEAM_FIFA_POINTS[m.teamA] ?? 1500) >= (TEAM_FIFA_POINTS[m.teamB] ?? 1500)
      const mod = km.id % 4
      let rA: number, rB: number
      if      (mod === 0) { rA = aIsFav ? 2 : 0; rB = aIsFav ? 0 : 2 }
      else if (mod === 1) { rA = aIsFav ? 1 : 0; rB = aIsFav ? 0 : 1 }
      else if (mod === 2) { rA = 1; rB = 1 }  // draw → fav advances
      else                { rA = aIsFav ? 0 : 1; rB = aIsFav ? 1 : 0 }  // upset
      const advanceTeam = rA > rB ? m.teamA : rB > rA ? m.teamB : (aIsFav ? m.teamA : m.teamB)
      const loserTeam   = advanceTeam === m.teamA ? m.teamB : m.teamA
      koMatches[km.id]  = {
        ...m, resultA: rA, resultB: rB,
        isPlayed: true, advanceTeam,
        hadRedCard: km.id % 5 === 0,
      }
      // Propagate to next rounds
      for (const next of allKo) {
        const b = KNOCKOUT_BRACKET[next.id]; if (!b) continue
        if (b.feederA === km.id)
          koMatches[next.id] = { ...koMatches[next.id], teamA: advanceTeam, fifaPointsA: TEAM_FIFA_POINTS[advanceTeam] ?? 1500 }
        if (b.feederB === km.id)
          koMatches[next.id] = { ...koMatches[next.id], teamB: advanceTeam, fifaPointsB: TEAM_FIFA_POINTS[advanceTeam] ?? 1500 }
        // 3P match uses losers (negative feeder IDs)
        if (b.feederA === -km.id)
          koMatches[next.id] = { ...koMatches[next.id], teamA: loserTeam, fifaPointsA: TEAM_FIFA_POINTS[loserTeam] ?? 1500 }
        if (b.feederB === -km.id)
          koMatches[next.id] = { ...koMatches[next.id], teamB: loserTeam, fifaPointsB: TEAM_FIFA_POINTS[loserTeam] ?? 1500 }
      }
    }
  }

  // ── Build USER knockout predictions ───────────────────────────────────────
  // Strategy:
  //   R32, R16: full prediction (1X2 + score + advance)
  //   QF, SF, 3P, F: advance pick uses USER's bracket path (not actual results)
  //   QF, SF, 3P, F: 1X2 + score filled later (in their respective windows)
  const koPreds: Record<number, KnockoutMatchPrediction> = {}

  // Process in bracket order so earlier advance picks are available for later ones
  for (const km of allKo) {
    const actual = koMatches[km.id]
    if (!actual?.teamA || !actual?.teamB) continue

    const aIsFav = (TEAM_FIFA_POINTS[actual.teamA] ?? 1500) >= (TEAM_FIFA_POINTS[actual.teamB] ?? 1500)
    const actual1x2 = actual.resultA > actual.resultB ? '1' : actual.resultA < actual.resultB ? '2' : 'X'
    const { x, sA, sB } = randomPred(actual1x2 as any, actual.resultA ?? 0, actual.resultB ?? 0, km.id)

    // Determine advance pick using bracket-predicted teams (not actual)
    let advTeam: string | undefined

    if (km.round === 'R32') {
      // R32: pick from actual R32 teams. Vary: some correct, some wrong
      advTeam = (km.id % 3 === 0) ? actual.advanceTeam : (aIsFav ? actual.teamA : actual.teamB)
    } else if (km.round === 'R16') {
      // R16: teams come from actual R32 results. Pick the favorite
      advTeam = aIsFav ? actual.teamA : actual.teamB
    } else {
      // QF/SF/3P/F: pick from bracket-predicted teams (what user thinks is in this match)
      const bTeamA = resolveBracketTeam(km.id, 'A', koPreds, koMatches)
      const bTeamB = resolveBracketTeam(km.id, 'B', koPreds, koMatches)

      if (bTeamA && bTeamB) {
        // Pick one of the bracket-predicted teams
        advTeam = km.id % 2 === 0 ? bTeamA : bTeamB
      } else if (bTeamA) {
        advTeam = bTeamA
      } else if (bTeamB) {
        advTeam = bTeamB
      } else {
        advTeam = actual.advanceTeam  // fallback
      }
    }

    koPreds[km.id] = {
      matchId: km.id,
      prediction1X2: x as any,
      scoreA: sA,
      scoreB: sB,
      advance: advTeam,
    }
  }

  // ── Build user group stage predictions ───────────────────────────────────
  const matchPreds: Record<number, any> = {}
  for (const m of MATCHES) {
    const r = gsResults[m.id]; if (!r) continue
    const actual1x2 = (r.resultA! > r.resultB! ? '1' : r.resultA! < r.resultB! ? '2' : 'X') as '1' | 'X' | '2'
    const { x, sA, sB } = randomPred(actual1x2, r.resultA ?? 0, r.resultB ?? 0, m.id)
    matchPreds[m.id] = { matchId: m.id, prediction1X2: x, scoreA: sA, scoreB: sB, redCard: m.id % 4 === 0 }
  }

  const groupPreds: Record<string, any> = {}
  for (const [g, [t1, t2, t3]] of Object.entries(groups)) {
    const swap = g.charCodeAt(0) % 2 === 0
    groupPreds[g] = { group: g, advancing: swap ? [t2, t1, t3] : [t1, t2, t3] }
  }

  const bonusPreds: Record<string, string> = {}
  const allTeams = Object.values(GROUPS_TEAMS).flat()
  BONUS_QUESTIONS.forEach((q, i) => {
    if (q.type === 'team') bonusPreds[q.id] = allTeams[i % allTeams.length]
    else if (q.type === 'number') bonusPreds[q.id] = String((i * 3 + 5) % 20)
    else bonusPreds[q.id] = 'שחקן לדוגמה'
  })

  const koRedCards = { R32: [74, 79], R16: [89, 92], QF: [97] }

  // ── Helper: build match map with results up to a given round ──────────────
  // Also includes team stubs (no results) for the NEXT round.
  const ROUND_ORDER_KO = ['R32', 'R16', 'QF', 'SF', '3P', 'F']
  function buildMatchMap(throughRound: string): Record<number, any> {
    const idx = ROUND_ORDER_KO.indexOf(throughRound)
    const map: Record<number, any> = {}
    for (const km of allKo) {
      const kmIdx = ROUND_ORDER_KO.indexOf(km.round)
      if (kmIdx <= idx) {
        map[km.id] = koMatches[km.id]  // full data with results
      } else if (kmIdx === idx + 1) {
        // Next round: include team stubs only (no results yet)
        const m = koMatches[km.id]
        if (m?.teamA || m?.teamB) {
          map[km.id] = {
            id: km.id, round: km.round,
            teamA: m.teamA, teamB: m.teamB,
            fifaPointsA: m.fifaPointsA, fifaPointsB: m.fifaPointsB,
            category: m.category, isPlayed: false,
          }
        }
      }
    }
    return map
  }

  // ── Step definitions ─────────────────────────────────────────────────────
  const steps = [
    {
      key: 'fill-gs-preds',
      label: '✏️ מלא ניחושי שלב הבתים',
      sub: 'שלב הבתים — ניחושים',
      action: () => wrap('fill-gs-preds', async () => {
        await setDoc(doc(db, 'predictions', TEST_UID),
          { matches: matchPreds, groups: groupPreds, bonus: bonusPreds },
          { merge: true }
        )
        await setDoc(doc(db, 'users', TEST_UID), { userId: TEST_UID, userName: TEST_NAME })
        addLog(`  → ${Object.keys(matchPreds).length} משחקים, ${Object.keys(groupPreds).length} בתים`)
      }),
    },
    {
      key: 'set-gs-results',
      label: '📊 הכנס תוצאות שלב הבתים',
      sub: 'שלב הבתים — תוצאות + נבחרות R32',
      action: () => wrap('set-gs-results', async () => {
        await setDoc(doc(db, 'admin', 'results'), { matches: gsResults, groups, bonus: {} })
        // Populate R32 teams from group qualifiers
        const r32teams: Record<number, any> = {}
        for (const [id, km] of Object.entries(r32base)) r32teams[Number(id)] = km
        await setDoc(doc(db, 'admin', 'knockout'), { matches: r32teams })
        addLog(`  → ${Object.keys(gsResults).length} תוצאות, נבחרות R32 הוכנסו`)
      }),
    },
    {
      key: 'fill-r32-preds',
      label: '✏️ מלא ניחושי שלב ה-32',
      sub: 'R32 — 1X2 + תוצאה + עולה + אדומים',
      action: () => wrap('fill-r32-preds', async () => {
        const r32preds: Record<number, any> = {}
        for (const km of allKo.filter(k => k.round === 'R32')) r32preds[km.id] = koPreds[km.id]
        await saveKnockout(TEST_UID, r32preds)
        // knockoutRedCards: only R32 picks now — R16/QF saved in their steps
        await setDoc(doc(db, 'predictions', TEST_UID),
          { knockoutRedCards: { R32: koRedCards.R32, R16: [], QF: [] } },
          { merge: true }
        )
        addLog(`  → ${Object.keys(r32preds).length} משחקי R32`)
      }),
    },
    {
      key: 'set-r32-results',
      label: '📊 הכנס תוצאות שלב ה-32',
      sub: 'R32 — תוצאות + נבחרות R16',
      action: () => wrap('set-r32-results', async () => {
        // R32 results + R16 team stubs
        await setDoc(doc(db, 'admin', 'knockout'), { matches: buildMatchMap('R32') })
        addLog(`  → R32 תוצאות + נבחרות R16 מוכנות`)
      }),
    },
    {
      key: 'fill-r16-preds',
      label: '✏️ מלא עץ R16 + ניחושי שמינית גמר',
      sub: 'R16 — 1X2+תוצאה+עולה | QF/SF/F — עולה בלבד (עץ)',
      action: () => wrap('fill-r16-preds', async () => {
        const preds: Record<number, any> = {}

        // R16: full prediction
        for (const km of allKo.filter(k => k.round === 'R16')) {
          preds[km.id] = koPreds[km.id]
        }

        // QF/SF/3P/F: advance pick only (bracket tree, locked after r16Deadline)
        // Uses user's bracket-derived advance picks (not actual results)
        for (const km of allKo.filter(k => !['R32', 'R16'].includes(k.round))) {
          preds[km.id] = { matchId: km.id, advance: koPreds[km.id]?.advance }
        }

        await saveKnockout(TEST_UID, preds)
        // R16 red card picks
        await updateDoc(doc(db, 'predictions', TEST_UID), { 'knockoutRedCards.R16': koRedCards.R16 })
        addLog(`  → R16: ניחושים מלאים | QF/SF/3P/F: עולה בלבד (ברקט)`)

        // Verify bracket consistency
        const qfExample = preds[97]?.advance
        const r16_89 = preds[89]?.advance
        const r16_90 = preds[90]?.advance
        if (qfExample && (qfExample === r16_89 || qfExample === r16_90)) {
          addLog(`  ✓ ברקט עקבי: QF97 עולה = ${qfExample}`)
        } else {
          addLog(`  ⚠️ ברקט QF97: ${qfExample} (R16-89: ${r16_89}, R16-90: ${r16_90})`)
        }
      }),
    },
    {
      key: 'set-r16-results',
      label: '📊 הכנס תוצאות שמינית גמר',
      sub: 'R16 — תוצאות + נבחרות QF',
      action: () => wrap('set-r16-results', async () => {
        await setDoc(doc(db, 'admin', 'knockout'), { matches: buildMatchMap('R16') })
        addLog('  → R16 תוצאות + נבחרות QF מוכנות')
      }),
    },
    {
      key: 'fill-qf-preds',
      label: '✏️ מלא ניחושי רבע גמר',
      sub: 'QF — 1X2 + תוצאה (ברקט נעול)',
      action: () => wrap('fill-qf-preds', async () => {
        const preds: Record<number, any> = {}
        for (const km of allKo.filter(k => k.round === 'QF')) {
          // Only add 1X2 + score — advance pick already set from R16 window
          const existing = koPreds[km.id]
          preds[km.id] = {
            matchId: km.id,
            prediction1X2: existing.prediction1X2,
            scoreA: existing.scoreA,
            scoreB: existing.scoreB,
            // advance was already saved in fill-r16-preds — don't overwrite
          }
        }
        await saveKnockout(TEST_UID, preds)
        // QF red card pick
        await updateDoc(doc(db, 'predictions', TEST_UID), { 'knockoutRedCards.QF': koRedCards.QF })
        addLog(`  → ${Object.keys(preds).length} ניחושי QF (1X2 + תוצאה בלבד)`)
      }),
    },
    {
      key: 'set-qf-results',
      label: '📊 הכנס תוצאות רבע גמר',
      sub: 'QF — תוצאות + נבחרות SF',
      action: () => wrap('set-qf-results', async () => {
        await setDoc(doc(db, 'admin', 'knockout'), { matches: buildMatchMap('QF') })
        addLog('  → QF תוצאות + נבחרות SF מוכנות')
      }),
    },
    {
      key: 'fill-sf-preds',
      label: '✏️ מלא ניחושי חצי גמר',
      sub: 'SF בלבד — 1X2 + תוצאה',
      action: () => wrap('fill-sf-preds', async () => {
        const preds: Record<number, any> = {}
        for (const km of allKo.filter(k => k.round === 'SF')) {
          const existing = koPreds[km.id]
          preds[km.id] = { matchId: km.id, prediction1X2: existing.prediction1X2, scoreA: existing.scoreA, scoreB: existing.scoreB }
        }
        await saveKnockout(TEST_UID, preds)
        addLog(`  → ${Object.keys(preds).length} ניחושי SF`)
      }),
    },
    {
      key: 'set-sf-results',
      label: '📊 הכנס תוצאות חצי גמר',
      sub: 'SF — תוצאות + נבחרות 3P ו-F',
      action: () => wrap('set-sf-results', async () => {
        // SF results + stubs for BOTH 3P and Final (both teams are now known from SF)
        const sfIdx = ROUND_ORDER_KO.indexOf('SF')
        const map: Record<number, any> = {}
        for (const km of allKo) {
          const kmIdx = ROUND_ORDER_KO.indexOf(km.round)
          if (kmIdx <= sfIdx) {
            map[km.id] = koMatches[km.id]
          } else {
            const m = koMatches[km.id]
            if (m?.teamA || m?.teamB) {
              map[km.id] = { id: km.id, round: km.round, teamA: m.teamA, teamB: m.teamB,
                fifaPointsA: m.fifaPointsA, fifaPointsB: m.fifaPointsB, category: m.category, isPlayed: false }
            }
          }
        }
        await setDoc(doc(db, 'admin', 'knockout'), { matches: map })
        addLog('  → SF תוצאות + נבחרות 3P ו-F מוכנות')
      }),
    },
    {
      key: 'fill-3p-preds',
      label: '✏️ מלא ניחושי מקום שלישי',
      sub: '3P — 1X2 + תוצאה (נבחרות ידועות אחרי SF)',
      action: () => wrap('fill-3p-preds', async () => {
        const preds: Record<number, any> = {}
        for (const km of allKo.filter(k => k.round === '3P')) {
          const existing = koPreds[km.id]
          preds[km.id] = { matchId: km.id, prediction1X2: existing.prediction1X2, scoreA: existing.scoreA, scoreB: existing.scoreB }
        }
        await saveKnockout(TEST_UID, preds)
        addLog(`  → ניחוש מקום 3`)
      }),
    },
    {
      key: 'set-3p-results',
      label: '📊 הכנס תוצאות מקום שלישי',
      sub: '3P — תוצאות',
      action: () => wrap('set-3p-results', async () => {
        const sfIdx = ROUND_ORDER_KO.indexOf('SF')
        const map: Record<number, any> = {}
        for (const km of allKo) {
          const kmIdx = ROUND_ORDER_KO.indexOf(km.round)
          if (kmIdx <= sfIdx || km.round === '3P') {
            map[km.id] = koMatches[km.id]
          } else {
            const m = koMatches[km.id]
            if (m?.teamA || m?.teamB) {
              map[km.id] = { id: km.id, round: km.round, teamA: m.teamA, teamB: m.teamB,
                fifaPointsA: m.fifaPointsA, fifaPointsB: m.fifaPointsB, category: m.category, isPlayed: false }
            }
          }
        }
        await setDoc(doc(db, 'admin', 'knockout'), { matches: map })
        addLog('  → מקום 3 תוצאות + נבחרות גמר מוכנות')
      }),
    },
    {
      key: 'fill-f-preds',
      label: '✏️ מלא ניחושי גמר',
      sub: 'F — 1X2 + תוצאה',
      action: () => wrap('fill-f-preds', async () => {
        const preds: Record<number, any> = {}
        for (const km of allKo.filter(k => k.round === 'F')) {
          const existing = koPreds[km.id]
          preds[km.id] = {
            matchId: km.id,
            prediction1X2: existing.prediction1X2,
            scoreA: existing.scoreA,
            scoreB: existing.scoreB,
          }
        }
        await saveKnockout(TEST_UID, preds)
        addLog(`  → גמר ניחוש: ${koPreds[104]?.advance ?? '?'} יזכה`)
      }),
    },
    {
      key: 'set-f-results',
      label: '📊 הכנס תוצאות גמר',
      sub: 'גמר — תוצאות סופיות',
      action: () => wrap('set-f-results', async () => {
        const allMap: Record<number, any> = {}
        for (const km of allKo) allMap[km.id] = koMatches[km.id]
        await setDoc(doc(db, 'admin', 'knockout'), { matches: allMap })
        addLog(`  → טורניר מלא! 🏆 ${koMatches[104]?.advanceTeam ?? '?'}`)
      }),
    },
    {
      key: 'calc-score',
      label: '🧮 חשב ניקוד',
      sub: 'חישוב ניקוד מלא',
      action: () => wrap('calc-score', async () => {
        const { getDoc } = await import('firebase/firestore')
        const adminRes  = (await getDoc(doc(db, 'admin', 'results'))).data()
        const adminKo   = (await getDoc(doc(db, 'admin', 'knockout'))).data()
        const predDoc   = (await getDoc(doc(db, 'predictions', TEST_UID))).data()
        if (!predDoc) { addLog('  ⚠️ אין נתוני ניחוש'); return }
        const koArr = Object.values(adminKo?.matches ?? {}) as any[]
        const score = computeUserScore(
          TEST_UID, TEST_NAME,
          predDoc.matches ?? {}, predDoc.groups ?? {}, predDoc.bonus ?? {},
          MATCHES, adminRes?.groups ?? {}, adminRes?.bonus ?? {},
          predDoc.knockout ?? {}, koArr, predDoc.knockoutRedCards ?? {}
        )
        await setDoc(doc(db, 'scores', TEST_UID), score)
        addLog(`  → ניקוד: ${score.total} נק' (בתים:${score.matchPoints} | עולות:${score.groupPoints} | KO:${score.knockoutPoints} | בונוס:${score.bonusPoints})`)
        addLog(`  → KO: R32:${score.koR32} R16:${score.koR16} QF:${score.koQF} SF:${score.koSF} 3P:${score.ko3P} F:${score.koF}`)
      }),
    },
    {
      key: 'clear-all',
      label: '🗑️ נקה הכל',
      sub: 'מחיקת כל נתוני הבדיקה',
      danger: true,
      action: () => wrap('clear-all', async () => {
        await Promise.all([
          deleteDoc(doc(db, 'predictions', TEST_UID)).catch(() => {}),
          deleteDoc(doc(db, 'scores', TEST_UID)).catch(() => {}),
          // NOTE: do NOT delete users/{uid} — app hangs on reload without it
          setDoc(doc(db, 'admin', 'results'), {}),
          setDoc(doc(db, 'admin', 'knockout'), {}),
        ])
        setDone(new Set())
        setLog([])
        addLog('  → הכל נמחק')
      }),
    },
  ]

  return (
    <div style={{ fontFamily: 'inherit', direction: 'rtl' }}>
      <div style={{
        background: '#fffbe6', border: '1px solid #f0c040',
        borderRadius: 10, padding: '10px 14px', marginBottom: 16, fontSize: 13,
      }}>
        <b>🧪 מצב בדיקות</b>
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#555' }}>משתמש:</label>
          <select
            value={selectedUid}
            onChange={e => { setSelectedUid(e.target.value); setDone(new Set()); setLog([]) }}
            style={{ flex: 1, fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid #ddd', fontFamily: 'inherit' }}>
            {users.length === 0 && <option value="">טוען משתמשים...</option>}
            {users.map(u => (
              <option key={u.uid} value={u.uid}>{u.name}</option>
            ))}
          </select>
          <button onClick={() => getDocs(collection(db, 'users')).then(snap => {
            const list = snap.docs.map(d => ({ uid: d.id, name: d.data().userName ?? d.data().displayName ?? d.data().name ?? d.id }))
            setUsers(list)
          })} style={{ fontSize: 11, padding: '3px 8px', borderRadius: 6, border: '1px solid #ddd', cursor: 'pointer', background: '#fff' }}>↻</button>
        </div>
        {selectedUid && (
          <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
            UID: <code style={{ fontSize: 10 }}>{selectedUid}</code>
          </div>
        )}
        <div style={{ fontSize: 11, color: '#aaa', marginTop: 4 }}>
          הכפתורים פועלים על המשתמש הנבחר בלבד. שינוי משתמש מאפס את הלוג.
        </div>
        <div style={{ fontSize: 11, color: '#aaa', marginTop: 2 }}>
          סדר מומלץ: fill-gs → set-gs → fill-r32 → set-r32 → fill-r16 → set-r16 → fill-qf → set-qf → fill-sf → set-sf → fill-3p → set-3p → fill-f → set-f → calc
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
        {steps.map(step => (
          <button
            key={step.key}
            disabled={busy}
            onClick={(step as any).action}
            style={{
              padding: '10px 14px', borderRadius: 9, border: '1.5px solid',
              borderColor: (step as any).danger ? '#c0392b' : done.has(step.key) ? '#1a7a44' : '#ddd',
              background: (step as any).danger ? '#fff5f5' : done.has(step.key) ? '#f0fbf4' : '#fff',
              color: (step as any).danger ? '#c0392b' : done.has(step.key) ? '#1a7a44' : '#1a1a2e',
              cursor: busy ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit', fontSize: 13, fontWeight: 600, textAlign: 'right',
              opacity: busy ? 0.6 : 1,
            }}
          >
            {done.has(step.key) ? '✓ ' : ''}{step.label}
            <div style={{ fontSize: 11, fontWeight: 400, color: '#888', marginTop: 2 }}>
              {step.sub}
            </div>
          </button>
        ))}
      </div>

      {log.length > 0 && (
        <div style={{
          background: '#f8f9ff', border: '1px solid #e0e0f0', borderRadius: 8,
          padding: '10px 14px', maxHeight: 220, overflowY: 'auto',
          fontSize: 12, fontFamily: 'monospace', direction: 'ltr',
        }}>
          {log.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}
    </div>
  )
}
