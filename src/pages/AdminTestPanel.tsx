import { useState } from 'react'
import { doc, setDoc, deleteDoc } from 'firebase/firestore'
import { db } from '../firebase'
import { MATCHES, GROUPS_TEAMS, BONUS_QUESTIONS, KNOCKOUT_MATCHES, KNOCKOUT_BRACKET, TEAM_FIFA_POINTS, calcCategoryByRound } from '../data/matches'
import { computeUserScore } from '../scoring'
import { populateR32Teams } from '../utils/syncLogic'
import { Match, KnockoutMatchPrediction } from '../types'

const TEST_UID  = 'BEvfh1GfqFULcDeSu84G1qkbEew2'
const TEST_NAME = 'Test User'

// ── helpers ─────────────────────────────────────────────────────────────────
function genGroupResults(): Record<number, Partial<Match>> {
  const out: Record<number, Partial<Match>> = {}
  for (const m of MATCHES) {
    const mod = m.id % 6
    const [rA, rB] =
      mod === 0 ? [1,0] : mod === 1 ? [5,0] : mod === 2 ? [0,0] :
      mod === 3 ? [0,2] : mod === 4 ? [2,1] : [4,0]
    out[m.id] = { id: m.id, resultA: rA, resultB: rB, isPlayed: true, hadRedCard: m.id % 3 === 0 }
  }
  return out
}

function computeQualifiers(results: Record<number, Partial<Match>>): Record<string, [string,string,string]> {
  const pts: Record<string, Record<string, number>> = {}
  for (const m of MATCHES) {
    const r = results[m.id]; if (!r || !m.teamA || !m.teamB) continue
    const g = m.group
    if (!pts[g]) pts[g] = {}
    if (!pts[g][m.teamA]) pts[g][m.teamA] = 0
    if (!pts[g][m.teamB]) pts[g][m.teamB] = 0
    if ((r.resultA??0) > (r.resultB??0)) pts[g][m.teamA] += 3
    else if ((r.resultA??0) < (r.resultB??0)) pts[g][m.teamB] += 3
    else { pts[g][m.teamA]++; pts[g][m.teamB]++ }
  }
  const out: Record<string, [string,string,string]> = {}
  for (const [g, teams] of Object.entries(pts)) {
    const s = Object.entries(teams).sort((a,b)=>b[1]-a[1]).map(([t])=>t)
    out[g] = [s[0]??'', s[1]??'', s[2]??''] as [string,string,string]
  }
  return out
}

function computeBest8(groups: Record<string, [string,string,string]>, results: Record<number, Partial<Match>>) {
  return Object.entries(groups).map(([g, teams]) => {
    const third = teams[2]; if (!third) return null
    let pts = 0, gd = 0, gf = 0
    for (const m of MATCHES.filter(m=>m.group===g)) {
      const r = results[m.id]; if (!r) continue
      const isA = m.teamA===third, isB = m.teamB===third; if (!isA&&!isB) continue
      const [rA,rB] = [r.resultA??0, r.resultB??0]
      if (rA>rB) { if(isA){pts+=3;gd+=rA-rB;gf+=rA}else{gd-=rA-rB;gf+=rB} }
      else if(rB>rA){if(isB){pts+=3;gd+=rB-rA;gf+=rB}else{gd-=rB-rA;gf+=rA}}
      else { pts++; gf+=isA?rA:rB }
    }
    return { team: third, pts, gd, gf }
  }).filter(Boolean).sort((a:any,b:any)=>b.pts-a.pts||b.gd-a.gd||b.gf-a.gf).slice(0,8).map((t:any)=>t.team)
}

// Random prediction (correct ~40% of the time)
function randomPred(actual1x2: '1'|'X'|'2', scoreA: number, scoreB: number, id: number) {
  const seed = (id * 7 + 13) % 5
  if (seed < 2) return { x: actual1x2, sA: scoreA, sB: scoreB }  // correct
  if (seed === 2) return { x: 'X' as const, sA: 1, sB: 1 }        // draw guess
  const flip = (id % 2 === 0) ? '1' : '2'
  return { x: flip as '1'|'2', sA: 2, sB: 1 }                      // wrong pick
}

export default function AdminTestPanel() {
  const [log, setLog] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<Set<string>>(new Set())

  const addLog = (msg: string) => setLog(p => [...p, msg])
  const markDone = (key: string) => setDone(p => new Set([...p, key]))
  const wrap = async (key: string, fn: () => Promise<void>) => {
    setBusy(true)
    try { await fn(); markDone(key); addLog(`✅ ${key}`) }
    catch(e: any) { addLog(`❌ ${key}: ${e.message}`) }
    finally { setBusy(false) }
  }

  // ── pre-compute tournament data ──────────────────────────────────────────
  const gsResults  = genGroupResults()
  const groups     = computeQualifiers(gsResults)
  const best8      = computeBest8(groups, gsResults)
  const { updatedKnockout: r32base } = populateR32Teams(groups as any, best8, {}, TEAM_FIFA_POINTS, calcCategoryByRound)

  // Build full KO match tree — propagate results round by round in topological order
  const allKo = KNOCKOUT_MATCHES.slice().sort((a,b)=>a.id-b.id)
  const koMatches: Record<number, any> = {}
  // Init all matches from base data
  for (const km of allKo) koMatches[km.id] = { ...km }
  // Apply R32 teams from group qualifiers (via populateR32Teams)
  for (const [id, km] of Object.entries(r32base)) {
    const n = Number(id)
    if (koMatches[n]) koMatches[n] = { ...koMatches[n], ...(km as any) }
  }
  // Simulate each round in order, propagate winners/losers forward
  const ROUND_ORDER = ['R32','R16','QF','SF','3P','F']
  for (const round of ROUND_ORDER) {
    for (const km of allKo.filter(k=>k.round===round)) {
      const m = koMatches[km.id]
      if (!m?.teamA || !m?.teamB) continue
      const aIsFav = (TEAM_FIFA_POINTS[m.teamA]??1500) >= (TEAM_FIFA_POINTS[m.teamB]??1500)
      const mod = km.id % 4
      let rA: number, rB: number
      if      (mod === 0) { rA = aIsFav?2:0; rB = aIsFav?0:2 }  // fav wins
      else if (mod === 1) { rA = aIsFav?1:0; rB = aIsFav?0:1 }  // fav narrow win
      else if (mod === 2) { rA = 1;           rB = 1           }  // draw → fav advances
      else                { rA = aIsFav?0:1;  rB = aIsFav?1:0 }  // upset
      const advanceTeam = rA > rB ? m.teamA : rB > rA ? m.teamB : (aIsFav ? m.teamA : m.teamB)
      const loserTeam   = advanceTeam === m.teamA ? m.teamB : m.teamA
      koMatches[km.id]  = { ...m, resultA: rA, resultB: rB, isPlayed: true, advanceTeam, hadRedCard: km.id%5===0 }
      // Propagate to next-round matches via bracket
      for (const next of allKo) {
        const b = KNOCKOUT_BRACKET[next.id]; if (!b) continue
        if (b.feederA === km.id)
          koMatches[next.id] = { ...koMatches[next.id], teamA: advanceTeam, fifaPointsA: TEAM_FIFA_POINTS[advanceTeam]??1500 }
        if (b.feederB === km.id)
          koMatches[next.id] = { ...koMatches[next.id], teamB: advanceTeam, fifaPointsB: TEAM_FIFA_POINTS[advanceTeam]??1500 }
        // 3P match uses losers (negative feeder IDs)
        if (b.feederA === -km.id)
          koMatches[next.id] = { ...koMatches[next.id], teamA: loserTeam, fifaPointsA: TEAM_FIFA_POINTS[loserTeam]??1500 }
        if (b.feederB === -km.id)
          koMatches[next.id] = { ...koMatches[next.id], teamB: loserTeam, fifaPointsB: TEAM_FIFA_POINTS[loserTeam]??1500 }
      }
    }
  }

  // Build user knockout predictions (partially correct)
  // Helper: get team that user's bracket predicts for a given match slot
  function getBracketTeam(matchId: number, side: 'A'|'B', preds: Record<number, any>): string | undefined {
    const b = KNOCKOUT_BRACKET[matchId]
    if (!b) return undefined
    const feederId = side === 'A' ? b.feederA : b.feederB
    if (feederId === null) return koMatches[matchId]?.[side === 'A' ? 'teamA' : 'teamB']
    if (feederId < 0) return undefined // 3P losers handled separately
    if (feederId >= 73 && feederId <= 88) return (r32base as any)[feederId]?.[side === 'A' ? 'teamA' : 'teamB']
    return preds[feederId]?.advance
  }

  const koPreds: Record<number, KnockoutMatchPrediction> = {}
  for (const km of allKo) {
    const actual = koMatches[km.id]
    if (!actual?.teamA || !actual?.teamB) continue
    const aIsFav = (TEAM_FIFA_POINTS[actual.teamA]??1500) >= (TEAM_FIFA_POINTS[actual.teamB]??1500)
    const actual1x2 = actual.resultA > actual.resultB ? '1' : actual.resultA < actual.resultB ? '2' : 'X'
    const { x, sA, sB } = randomPred(actual1x2 as any, actual.resultA??0, actual.resultB??0, km.id)

    // For QF/SF/F: advance pick must use bracket-consistent teams, not actual results
    let advTeam: string | undefined
    if (km.round === 'R32' || km.round === 'R16') {
      advTeam = (actual.id % 3 === 0) ? actual.advanceTeam : (aIsFav ? actual.teamA : actual.teamB)
    } else {
      // QF/SF/F: pick from bracket-predicted teams
      const btA = getBracketTeam(km.id, 'A', koPreds)
      const btB = getBracketTeam(km.id, 'B', koPreds)
      advTeam = btA ? (km.id % 2 === 0 ? btA : (btB ?? btA)) : actual.advanceTeam
    }
    koPreds[km.id] = { matchId: km.id, prediction1X2: x as any, scoreA: sA, scoreB: sB, advance: advTeam }
  }

  // Build user match predictions (partially correct)
  const matchPreds: Record<number, any> = {}
  for (const m of MATCHES) {
    const r = gsResults[m.id]; if (!r) continue
    const actual1x2 = (r.resultA!>r.resultB!?'1':r.resultA!<r.resultB!?'2':'X') as '1'|'X'|'2'
    const { x, sA, sB } = randomPred(actual1x2, r.resultA??0, r.resultB??0, m.id)
    matchPreds[m.id] = { matchId: m.id, prediction1X2: x, scoreA: sA, scoreB: sB, redCard: m.id%4===0 }
  }

  // Group preds (partially correct)
  const groupPreds: Record<string, any> = {}
  for (const [g, [t1,t2,t3]] of Object.entries(groups)) {
    const swap = g.charCodeAt(0) % 2 === 0
    groupPreds[g] = { group: g, advancing: swap ? [t2,t1,t3] : [t1,t2,t3] }
  }

  // Bonus preds
  const bonusPreds: Record<string, string> = {}
  const allTeams = Object.values(GROUPS_TEAMS).flat()
  BONUS_QUESTIONS.forEach((q, i) => {
    if (q.type === 'team') bonusPreds[q.id] = allTeams[i % allTeams.length]
    else if (q.type === 'number') bonusPreds[q.id] = String((i * 3 + 5) % 20)
    else bonusPreds[q.id] = 'שחקן לדוגמה'
  })

  // KO red card picks
  const koRedCards = { R32: [74,79], R16: [89,92], QF: [97] }

  const GROUPS_IMPORT = Object.keys(groups)

  // ── Actions ─────────────────────────────────────────────────────────────
  // Helper: build match map up to a given round, plus team stubs for the next round
  const ROUND_ORDER_KO = ['R32','R16','QF','SF','3P','F']
  function buildMatchMap(throughRound: string): Record<number,any> {
    const idx = ROUND_ORDER_KO.indexOf(throughRound)
    const map: Record<number,any> = {}
    for (const km of allKo) {
      const kmIdx = ROUND_ORDER_KO.indexOf(km.round)
      if (kmIdx <= idx) {
        map[km.id] = koMatches[km.id]  // full data with results
      } else if (kmIdx === idx + 1) {
        // Next round: include team stubs (no results yet)
        const m = koMatches[km.id]
        if (m?.teamA || m?.teamB) {
          map[km.id] = { id: km.id, round: km.round, teamA: m.teamA, teamB: m.teamB,
            fifaPointsA: m.fifaPointsA, fifaPointsB: m.fifaPointsB, category: m.category,
            isPlayed: false }
        }
      }
    }
    return map
  }

  const steps = [
    {
      key: 'fill-gs-preds',
      label: '✏️ מלא ניחושי שלב הבתים',
      sub: 'שלב הבתים — ניחושים',
      action: () => wrap('fill-gs-preds', async () => {
        await setDoc(doc(db,'predictions',TEST_UID), { matches: matchPreds, groups: groupPreds, bonus: bonusPreds }, { merge: true })
        await setDoc(doc(db,'users',TEST_UID), { userId: TEST_UID, userName: TEST_NAME })
        addLog(`  → ${Object.keys(matchPreds).length} משחקים, ${Object.keys(groupPreds).length} בתים, ${Object.keys(bonusPreds).length} בונוס`)
      }),
    },
    {
      key: 'set-gs-results',
      label: '📊 הכנס תוצאות שלב הבתים',
      sub: 'שלב הבתים — תוצאות',
      action: () => wrap('set-gs-results', async () => {
        await setDoc(doc(db,'admin','results'), { matches: gsResults, groups, bonus: {} })
        // Populate R32 teams immediately from group qualifiers
        const r32teams: Record<number,any> = {}
        for (const [id, km] of Object.entries(r32base)) r32teams[Number(id)] = km
        await setDoc(doc(db,'admin','knockout'), { matches: r32teams })
        addLog(`  → ${GROUPS_IMPORT.length} בתים, ${Object.keys(gsResults).length} תוצאות`)
        addLog(`  → נבחרות R32 הוכנסו אוטומטית לברקט`)
      }),
    },
    {
      key: 'fill-r32-preds',
      label: '✏️ מלא ניחושי שלב ה-32',
      sub: 'שלב ה-32 — ניחושים',
      action: () => wrap('fill-r32-preds', async () => {
        const r32preds: Record<number,any> = {}
        for (const km of allKo.filter(k=>k.round==='R32')) r32preds[km.id] = koPreds[km.id]
        await setDoc(doc(db,'predictions',TEST_UID), { knockout: r32preds, knockoutRedCards: koRedCards }, { merge: true })
        addLog(`  → ${Object.keys(r32preds).length} משחקי R32`)
      }),
    },
    {
      key: 'set-r32-results',
      label: '📊 הכנס תוצאות שלב ה-32',
      sub: 'שלב ה-32 — תוצאות',
      action: () => wrap('set-r32-results', async () => {
        const r32map: Record<number,any> = {}
        for (const km of allKo.filter(k=>k.round==='R32')) r32map[km.id] = koMatches[km.id]
        await setDoc(doc(db,'admin','knockout'), { matches: r32map }, { merge: true })
        addLog(`  → ${Object.keys(r32map).length} תוצאות R32`)
      }),
    },
    {
      key: 'fill-r16-preds',
      label: '✏️ מלא עץ + ניחושי שמינית גמר',
      sub: 'שמינית גמר — ניחושים + עץ',
      action: () => wrap('fill-r16-preds', async () => {
        const preds: Record<number,any> = {}
        for (const km of allKo) {
          if (km.round === 'R16') {
            preds[km.id] = koPreds[km.id]  // full prediction for R16
          } else if (km.round !== 'R32') {
            // QF/SF/3P/F: only advance pick (bracket tree) — no 1X2/score yet
            preds[km.id] = { matchId: km.id, advance: koPreds[km.id]?.advance }
          }
        }
        await setDoc(doc(db,'predictions',TEST_UID), { knockout: preds }, { merge: true })
        addLog(`  → R16: ניחושים מלאים | QF/SF/F: עולה בלבד`)
      }),
    },
    {
      key: 'set-r16-results',
      label: '📊 הכנס תוצאות שמינית גמר',
      sub: 'שמינית גמר — תוצאות',
      action: () => wrap('set-r16-results', async () => {
        await setDoc(doc(db,'admin','knockout'), { matches: buildMatchMap('R16') })
        addLog('  → R16 תוצאות + נבחרות QF')
      }),
    },
    {
      key: 'fill-qf-preds',
      label: '✏️ מלא ניחושי רבע גמר',
      sub: 'רבע גמר — ניחושים',
      action: () => wrap('fill-qf-preds', async () => {
        const preds: Record<number,any> = {}
        for (const km of allKo.filter(k=>k.round==='QF')) preds[km.id] = koPreds[km.id]
        await setDoc(doc(db,'predictions',TEST_UID), { knockout: preds }, { merge: true })
      }),
    },
    {
      key: 'set-qf-results',
      label: '📊 הכנס תוצאות רבע גמר',
      sub: 'רבע גמר — תוצאות',
      action: () => wrap('set-qf-results', async () => {
        await setDoc(doc(db,'admin','knockout'), { matches: buildMatchMap('QF') })
        addLog('  → QF תוצאות + נבחרות SF')
      }),
    },
    {
      key: 'fill-sf-preds',
      label: '✏️ מלא ניחושי חצי גמר',
      sub: 'חצי גמר + מקום 3 — ניחושים',
      action: () => wrap('fill-sf-preds', async () => {
        const preds: Record<number,any> = {}
        for (const km of allKo.filter(k=>k.round==='SF'||k.round==='3P')) preds[km.id] = koPreds[km.id]
        await setDoc(doc(db,'predictions',TEST_UID), { knockout: preds }, { merge: true })
      }),
    },
    {
      key: 'set-sf-results',
      label: '📊 הכנס תוצאות חצי גמר + מקום 3',
      sub: 'חצי גמר + מקום 3 — תוצאות',
      action: () => wrap('set-sf-results', async () => {
        const map3P = buildMatchMap('SF')
        // Also include 3P
        const km3P = allKo.find(k=>k.round==='3P')
        if (km3P) map3P[km3P.id] = koMatches[km3P.id]
        await setDoc(doc(db,'admin','knockout'), { matches: map3P })
        addLog('  → SF + מקום 3 תוצאות + נבחרות גמר')
      }),
    },
    {
      key: 'fill-f-preds',
      label: '✏️ מלא ניחושי גמר',
      sub: 'גמר — ניחושים',
      action: () => wrap('fill-f-preds', async () => {
        const preds: Record<number,any> = {}
        for (const km of allKo.filter(k=>k.round==='F')) preds[km.id] = koPreds[km.id]
        await setDoc(doc(db,'predictions',TEST_UID), { knockout: preds }, { merge: true })
      }),
    },
    {
      key: 'set-f-results',
      label: '📊 הכנס תוצאות גמר',
      sub: 'גמר — תוצאות',
      action: () => wrap('set-f-results', async () => {
        const allMap: Record<number,any> = {}
        for (const km of allKo) allMap[km.id] = koMatches[km.id]
        await setDoc(doc(db,'admin','knockout'), { matches: allMap })
        addLog(`  → טורניר מלא! 🏆 ${koMatches[104]?.advanceTeam ?? '?'}`)
      }),
    },
    {
      key: 'calc-score',
      label: '🧮 חשב ניקוד',
      sub: 'חישוב ניקוד',
      action: () => wrap('calc-score', async () => {
        const { getDoc, collection, getDocs } = await import('firebase/firestore')
        const adminRes = (await getDoc(doc(db,'admin','results'))).data()
        const adminKo  = (await getDoc(doc(db,'admin','knockout'))).data()
        const predDoc  = (await getDoc(doc(db,'predictions',TEST_UID))).data()
        if (!predDoc) { addLog('  ⚠️ אין נתוני ניחוש'); return }
        const koArr = Object.values(adminKo?.matches ?? {}) as any[]
        const score = computeUserScore(
          TEST_UID, TEST_NAME,
          predDoc.matches ?? {}, predDoc.groups ?? {}, predDoc.bonus ?? {},
          MATCHES, adminRes?.groups ?? {}, adminRes?.bonus ?? {},
          predDoc.knockout ?? {}, koArr, predDoc.knockoutRedCards ?? {}
        )
        await setDoc(doc(db,'scores',TEST_UID), score)
        addLog(`  → ניקוד: ${score.total} נק' (בתים:${score.matchPoints} עולות:${score.groupPoints} KO:${score.knockoutPoints} בונוס:${score.bonusPoints})`)
      }),
    },
    {
      key: 'clear-all',
      label: '🗑️ נקה הכל',
      sub: 'מחיקה',
      danger: true,
      action: () => wrap('clear-all', async () => {
        await Promise.all([
          deleteDoc(doc(db,'predictions',TEST_UID)).catch(()=>{}),
          deleteDoc(doc(db,'scores',TEST_UID)).catch(()=>{}),
          deleteDoc(doc(db,'users',TEST_UID)).catch(()=>{}),
          setDoc(doc(db,'admin','results'), {}),
          setDoc(doc(db,'admin','knockout'), {}),
        ])
        setDone(new Set())
        addLog('  → הכל נמחק')
      }),
    },
  ]

  return (
    <div style={{ fontFamily: 'inherit', direction: 'rtl' }}>
      <div style={{ background: '#fffbe6', border: '1px solid #f0c040', borderRadius: 10, padding: '10px 14px', marginBottom: 16, fontSize: 13 }}>
        <b>🧪 מצב בדיקות</b> — UID: <code style={{ fontSize: 11 }}>{TEST_UID}</code>
        <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>הכפתורים פועלים על המשתמש "{TEST_NAME}" בלבד ולא משפיעים על נתונים אחרים</div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
        {steps.map(step => (
          <button key={step.key} disabled={busy}
            onClick={step.action}
            style={{
              padding: '10px 14px', borderRadius: 9, border: '1.5px solid',
              borderColor: step.danger ? '#c0392b' : done.has(step.key) ? '#1a7a44' : '#ddd',
              background: step.danger ? '#fff5f5' : done.has(step.key) ? '#f0fbf4' : '#fff',
              color: step.danger ? '#c0392b' : done.has(step.key) ? '#1a7a44' : '#1a1a2e',
              cursor: busy ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit', fontSize: 13, fontWeight: 600, textAlign: 'right',
              opacity: busy ? 0.6 : 1,
            }}>
            {done.has(step.key) ? '✓ ' : ''}{step.label}
            <div style={{ fontSize: 11, fontWeight: 400, color: '#888', marginTop: 2 }}>{step.sub}</div>
          </button>
        ))}
      </div>

      {log.length > 0 && (
        <div style={{ background: '#f8f9ff', border: '1px solid #e0e0f0', borderRadius: 8, padding: '10px 14px', maxHeight: 200, overflowY: 'auto', fontSize: 12, fontFamily: 'monospace', direction: 'ltr' }}>
          {log.map((l,i) => <div key={i}>{l}</div>)}
        </div>
      )}
    </div>
  )
}
