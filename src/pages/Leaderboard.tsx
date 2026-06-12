import { useState, useEffect, useRef } from 'react'
import { collection, onSnapshot, query, orderBy, getDocs } from 'firebase/firestore'
import { db } from '../firebase'
import { useAuth } from '../hooks/useAuth'
import { UserScore } from '../types'
import { FLAGS } from '../data/matches'

function Flag({ emoji, size = 16 }: { emoji: string; size?: number }) {
  if (!emoji) return null
  return <span style={{ fontSize: size, lineHeight: 1 }}>{emoji}</span>
}

export default function Leaderboard() {
  const { user } = useAuth()
  const [scores,    setScores]    = useState<UserScore[]>([])
  const [nicknames, setNicknames] = useState<Record<string, string>>({})
  const [bonusPreds, setBonusPreds] = useState<Record<string, Record<string, string>>>({})
  const [loading,   setLoading]   = useState(true)
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('lb_hidden_cols') || '[]')) }
    catch { return new Set() }
  })
  const [showColSettings, setShowColSettings] = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  const [filters, setFilters] = useState({
    champion: '', runnerUp: '', third: '', scorer: '', assists: '', topN: 0,
  })
  const setFilter = (k: keyof typeof filters, v: string | number) =>
    setFilters(f => ({ ...f, [k]: v }))
  const clearFilters = () => setFilters({ champion: '', runnerUp: '', third: '', scorer: '', assists: '', topN: 0 })

  const toggleCol = (key: string) => {
    setHiddenCols(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      localStorage.setItem('lb_hidden_cols', JSON.stringify([...next]))
      return next
    })
  }

  useEffect(() => {
    getDocs(collection(db, 'predictions')).then(snap => {
      const nicks: Record<string, string> = {}
      const bonus: Record<string, Record<string, string>> = {}
      snap.docs.forEach(d => {
        if (d.data().nickname) nicks[d.id] = d.data().nickname
        if (d.data().bonus) bonus[d.id] = d.data().bonus
      })
      setNicknames(nicks)
      setBonusPreds(bonus)
    })

    const q = query(collection(db, 'scores'), orderBy('total', 'desc'))
    return onSnapshot(q, snap => {
      const newScores = snap.docs.map(d => ({ ...d.data() } as UserScore & { prevTotal?: number; prevRank?: number }))
      setScores(newScores)
      setLoading(false)
    })
  }, [])

  const displayName = (s: UserScore) => s.userName

  const lbRef = useRef<HTMLDivElement>(null)
  const [exporting, setExporting] = useState(false)

  if (loading) return <div className="center-screen">טוען טבלה...</div>
  if (!scores.length) return (
    <div className="page">
      <div className="empty-state">
        <div style={{ fontSize: 48 }}>🏆</div>
        <p>הטבלה תתעדכן לאחר תחילת המשחקים</p>
      </div>
    </div>
  )

  const exportImage = async () => {
    setExporting(true)
    try {
      if (!(window as any).html2canvas) {
        await new Promise<void>((resolve, reject) => {
          const s = document.createElement('script')
          s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js'
          s.onload = () => resolve(); s.onerror = () => reject(new Error()); document.head.appendChild(s)
        })
      }

      const el = document.createElement('div')
      el.style.cssText = 'position:fixed;left:-9999px;top:0;width:430px;font-family:Arial,sans-serif;direction:rtl;background:#fff;'

      // Only active score columns
      const COL_CFG: Record<string, { label: string; header: string; body: string }> = {
        match: { label:'בתים',   header:'#5B9BD5', body:'#DDEEFF' },
        group: { label:'עולות',  header:'#70AD47', body:'#E2EFDA' },
        koR16: { label:'שמינית', header:'#ED7D31', body:'#FCE4D6' },
        koQF:  { label:'רבע',   header:'#E2473E', body:'#FFD7D4' },
        koSF:  { label:'חצי',   header:'#FFC000', body:'#FFF2CC' },
        koF:   { label:'גמר',   header:'#FF5E00', body:'#FFE6D0' },
        bonus: { label:'בונוס', header:'#9B59B6', body:'#F0E6FA' },
      }
      const SCORE_COLS = ['match','group','koR16','koQF','koSF','koF','bonus'].filter(k => filteredScores.some(s => colVal(s,k) > 0))
      const dateStr = new Date().toLocaleDateString('he-IL', { day:'numeric', month:'long' })

      const colW = SCORE_COLS.length > 0 ? Math.min(38, Math.floor(120 / SCORE_COLS.length)) : 38

      const thScore = SCORE_COLS.map(k =>
        `<th style="background:${COL_CFG[k].header};color:#fff;font-size:10px;font-weight:700;padding:6px 1px;text-align:center;border:1px solid rgba(255,255,255,0.2);width:${colW}px">${COL_CFG[k].label}</th>`
      ).join('')

      const rows = filteredScores.map((s, i) => {
        const sExt = s as UserScore & { prevTotal?: number; prevRank?: number }
        const rd = sExt.prevRank != null && sExt.prevRank !== (i+1) ? sExt.prevRank-(i+1) : null
        const pd = sExt.prevTotal != null && sExt.prevTotal !== s.total ? s.total-sExt.prevTotal : null
        const medal = i===0?'🥇':i===1?'🥈':i===2?'🥉':`${i+1}`
        const bg = i%2===0?'#fff':'#f7f7f7'
        const rdHtml = rd!=null&&rd!==0 ? `<div style="font-size:10px;font-weight:800;color:${rd>0?'#1a7a44':'#cc0000'}">${rd>0?'▲':'▼'}${Math.abs(rd)}</div>` : ''
        const pdHtml = pd!=null&&pd!==0 ? `<span style="color:${pd>0?'#1a7a44':'#cc0000'};font-size:11px;font-weight:800">${pd>0?'+':''}${pd}</span>` : `<span style="color:#ccc;font-size:10px">0</span>`
        const bp = bonusPreds[s.userId] ?? {}
        const flags = [
          bp.q105 && FLAGS[bp.q105] ? `${FLAGS[bp.q105]}🏆` : '',
          bp.q106 && FLAGS[bp.q106] ? `${FLAGS[bp.q106]}🥈` : '',
          bp.q107 && FLAGS[bp.q107] ? `${FLAGS[bp.q107]}🥉` : '',
        ].filter(Boolean).join(' ')
        const scorer  = bp.q108 ? bp.q108.split(' ').slice(-1)[0] : ''
        const assists = bp.q110 ? bp.q110.split(' ').slice(-1)[0] : ''
        const picks = [flags, scorer?`⚽${scorer}`:'', assists?`👟${assists}`:''].filter(Boolean).join('  ')
        const tdScore = SCORE_COLS.map(k => {
          const v = colVal(s,k)
          return `<td style="background:${COL_CFG[k].body};text-align:center;font-size:12px;font-weight:${v>0?'700':'400'};color:${v>0?'#222':'#bbb'};padding:4px 1px;border:1px solid rgba(0,0,0,0.06);width:${colW}px">${v>0?v:'—'}</td>`
        }).join('')

        return `<tr>
          <td style="text-align:center;font-size:${i<3?'15':'11'}px;font-weight:800;padding:4px 3px;border:1px solid #eee;width:26px;background:${bg}">${medal}</td>
          <td style="text-align:center;padding:4px 2px;border:1px solid #eee;width:30px;background:${bg}">
            <div style="font-size:11px;font-weight:800;color:#1a1a2e">${i+1}</div>
            ${rdHtml}
          </td>
          <td style="text-align:right;padding:4px 6px;border:1px solid #eee;background:${bg}">
            <div style="font-size:${i<3?'14':'12'}px;font-weight:${i<3?'800':'600'};color:#1a1a2e">${s.userName}</div>
          </td>
          <td style="text-align:right;padding:4px 5px;border:1px solid #eee;background:${bg};white-space:nowrap">
            <div style="font-size:10px;color:#555">${picks}</div>
          </td>
          ${tdScore}
          <td style="text-align:center;font-size:${i<3?'15':'13'}px;font-weight:900;color:${i<3?'#B8860B':'#1a1a2e'};padding:4px 3px;border:1px solid #eee;width:34px;background:${bg}">${s.total}</td>
          <td style="text-align:center;padding:4px 2px;border:1px solid #eee;width:30px;background:${bg}">${pdHtml}</td>
        </tr>`
      }).join('')

      el.innerHTML = `
        <div style="background:#1a1a2e;padding:9px 12px;display:flex;justify-content:space-between;align-items:center">
          <span style="color:#aac4ff;font-size:10px">${filteredScores.length} משתתפים</span>
          <span style="color:#fff;font-size:14px;font-weight:900">⚽ WC2026 — ניקוד</span>
          <span style="color:#aac4ff;font-size:10px">${dateStr}</span>
        </div>
        <table style="width:100%;border-collapse:collapse;table-layout:fixed">
          <thead><tr>
            <th style="background:#1a1a2e;color:#fff;font-size:10px;padding:5px 2px;text-align:center;border:1px solid #2d2d5e;width:26px">#</th>
            <th style="background:#1a1a2e;color:#aac4ff;font-size:9px;padding:5px 2px;text-align:center;border:1px solid #2d2d5e;width:30px">±מקום</th>
            <th style="background:#1a1a2e;color:#fff;font-size:10px;padding:5px 6px;text-align:right;border:1px solid #2d2d5e">שם</th>
            <th style="background:#1a1a2e;color:#aac4ff;font-size:10px;padding:5px 5px;text-align:right;border:1px solid #2d2d5e">הימורים</th>
            ${thScore}
            <th style="background:#1a1a2e;color:#fff;font-size:11px;font-weight:800;padding:5px 2px;text-align:center;border:1px solid #2d2d5e;width:34px">סה"כ</th>
            <th style="background:#1a1a2e;color:#aac4ff;font-size:9px;padding:5px 2px;text-align:center;border:1px solid #2d2d5e;width:30px">±נק׳</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>`

      document.body.appendChild(el)
      const canvas = await (window as any).html2canvas(el, { backgroundColor:'#fff', scale:2, useCORS:true, width:430, windowWidth:430 })
      document.body.removeChild(el)
      const link = document.createElement('a')
      link.download = `leaderboard-${new Date().toLocaleDateString('he-IL').replace(/\//g,'-')}.png`
      link.href = canvas.toDataURL('image/png')
      link.click()
    } catch (e) { alert('שגיאה בייצוא תמונה'); console.error(e) }
    setExporting(false)
  }

  const COLS: { key: string; label: string; hint: string; sub?: boolean }[] = [
    { key: 'match',    label: 'בתים',      hint: '1X2 + תוצאה + 🟥' },
    { key: 'group',    label: 'עולות',     hint: 'עולות מהבתים' },
    { key: 'koR32',    label: '×32',       hint: 'שלב ה-32 האחרונות',  sub: true },
    { key: 'koR16',    label: 'שמינית',    hint: 'שמינית גמר',         sub: true },
    { key: 'koQF',     label: 'רבע',       hint: 'רבע גמר',            sub: true },
    { key: 'koSF',     label: 'חצי',       hint: 'חצי גמר',            sub: true },
    { key: 'koSF3P',   label: '3P',        hint: 'מקום שלישי',         sub: true },
    { key: 'koF',      label: 'גמר',       hint: 'גמר',                sub: true },
    { key: 'bonus',    label: 'בונוס',     hint: 'שאלות בונוס' },
  ]
  const colVal = (s: UserScore, key: string) => {
    if (key === 'match')    return (s.matchPoints ?? 0) + (s.redCardPoints ?? 0)
    if (key === 'group')    return s.groupPoints ?? 0
    if (key === 'koR32')    return s.koR32 ?? 0
    if (key === 'koR16')    return s.koR16 ?? 0
    if (key === 'koQF')     return s.koQF  ?? 0
    if (key === 'koSF')     return s.koSF  ?? 0
    if (key === 'koSF3P')   return s.ko3P  ?? 0
    if (key === 'koF')      return s.koF   ?? 0
    if (key === 'bonus')    return s.bonusPoints ?? 0
    return 0
  }

  const visibleCols = COLS.filter(c => !hiddenCols.has(c.key))

  // Build unique option lists from bonus predictions
  const uniq = (key: string) => [...new Set(
    Object.values(bonusPreds).map(b => b[key]).filter(Boolean)
  )].sort()
  const champOptions   = uniq('q105')
  const runnerOptions  = uniq('q106')
  const thirdOptions   = uniq('q107')
  const scorerOptions  = uniq('q108')
  const assistsOptions = uniq('q110')

  // Apply filters (topN applied after sort so it takes top N of full list)
  const filteredScores = scores.filter((s, i) => {
    if (filters.topN > 0 && i >= filters.topN) return false
    const b = bonusPreds[s.userId] ?? {}
    if (filters.champion && b.q105 !== filters.champion) return false
    if (filters.runnerUp && b.q106 !== filters.runnerUp) return false
    if (filters.third    && b.q107 !== filters.third)    return false
    if (filters.scorer   && b.q108 !== filters.scorer)   return false
    if (filters.assists  && b.q110 !== filters.assists)  return false
    return true
  })
  const activeFilterCount = Object.entries(filters).filter(([k, v]) => k === 'topN' ? (v as number) > 0 : !!v).length

  return (
    <div className="page" style={{ paddingBottom: 40 }}>
      <style>{`
        @keyframes popIn {
          0%   { transform: scale(0.5) translateY(-6px); opacity: 0 }
          65%  { transform: scale(1.2) translateY(0);    opacity: 1 }
          100% { transform: scale(1)   translateY(0);    opacity: 1 }
        }
        .delta-badge { animation: popIn 0.4s cubic-bezier(.34,1.56,.64,1) both; display: inline-block; }
        .lb-row-bar {
          position: absolute; top: 0; right: 0; bottom: 0;
          border-radius: 10px; opacity: 0.07; pointer-events: none;
          background: linear-gradient(to left, #1a1a2e, transparent);
          transition: width 0.8s ease;
        }
        .lb-me .lb-row-bar { opacity: 0.11; background: linear-gradient(to left, #185FA5, transparent); }
      `}</style>

      <h1 style={{ marginBottom: 12 }}>🏆 טבלת ניקוד</h1>

      {/* ── Personal status card ── */}
      {myScore && tournamentStarted && (
        <div style={{
          background: 'linear-gradient(135deg, #1a1a2e 0%, #2d2d5e 100%)',
          color: '#fff', borderRadius: 14, padding: '16px 20px',
          marginBottom: 20, display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'center',
          boxShadow: '0 4px 20px rgba(26,26,46,0.25)',
        }}>
          <div style={{ textAlign: 'center', minWidth: 56 }}>
            <div style={{ fontSize: 32, lineHeight: 1 }}>
              {myIdx === 0 ? '🥇' : myIdx === 1 ? '🥈' : myIdx === 2 ? '🥉' : `#${myIdx + 1}`}
            </div>
            <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>מתוך {scores.length}</div>
          </div>

          <div style={{ width: 1, background: 'rgba(255,255,255,0.1)', alignSelf: 'stretch' }} />

          <div>
            <div style={{ fontSize: 11, color: '#aaa', marginBottom: 2 }}>הניקוד שלי</div>
            <div style={{ fontSize: 32, fontWeight: 800, color: '#7EC8E3', lineHeight: 1 }}>
              {myScore.total}
              {(() => { const ms = myScore as typeof myScore & { prevTotal?: number }; const d = ms.prevTotal != null && ms.prevTotal !== myScore.total ? myScore.total - ms.prevTotal : null; return d != null && d !== 0 ? (
                <span className="delta-badge" style={{
                  fontSize: 14, marginRight: 8, padding: '2px 8px', borderRadius: 20,
                  background: '#EAF3DE', color: '#1a7a44', fontWeight: 800,
                }}>
                  {d > 0 ? `+${d}` : d}
                </span>
              ) : null })()}
            </div>
            <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>נקודות</div>
          </div>

          {myIdx > 0 && (
            <>
              <div style={{ width: 1, background: 'rgba(255,255,255,0.1)', alignSelf: 'stretch' }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontSize: 12, color: '#ccc' }}>
                  <span style={{ marginLeft: 4 }}>🥇</span>
                  <span style={{ color: '#aaa' }}>עד ראשון: </span>
                  <span style={{ color: '#FF6B6B', fontWeight: 700 }}>-{leader.total - myScore.total}</span>
                </div>
                {myIdx > 0 && (
                  <div style={{ fontSize: 12, color: '#ccc' }}>
                    <span style={{ marginLeft: 4 }}>⬆️</span>
                    <span style={{ color: '#aaa' }}>עד המקום מעלי: </span>
                    <span style={{ color: '#FF6B6B', fontWeight: 700 }}>-{scores[myIdx - 1].total - myScore.total}</span>
                  </div>
                )}
                {myIdx < scores.length - 1 && (
                  <div style={{ fontSize: 12, color: '#ccc' }}>
                    <span style={{ marginLeft: 4 }}>⬇️</span>
                    <span style={{ color: '#aaa' }}>הפרש ממקום תחתי: </span>
                    <span style={{ color: '#51CF66', fontWeight: 700 }}>+{myScore.total - scores[myIdx + 1].total}</span>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {!tournamentStarted && (
        <div className="lb-pre-tournament" style={{ marginBottom: 16 }}>
          ⏳ הטורניר טרם התחיל — הטבלה תתעדכן אוטומטית לאחר המשחק הראשון ב-12/6/2026
        </div>
      )}

      {/* ── Filters ── */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: showFilters ? 8 : 0 }}>
          <button onClick={exportImage} disabled={exporting} style={{
            fontSize: 12, padding: '4px 12px', borderRadius: 16,
            border: '1px solid #1a1a2e', background: '#1a1a2e', color: '#fff',
            cursor: exporting ? 'wait' : 'pointer', fontFamily: 'inherit',
          }}>
            {exporting ? '⏳ מייצא...' : '📸 שתף טבלה'}
          </button>
          <button onClick={() => setShowFilters(v => !v)}
            style={{ fontSize: 12, padding: '4px 12px', borderRadius: 16, border: `1px solid ${showFilters || activeFilterCount > 0 ? '#1a7a44' : '#ddd'}`,
              background: showFilters ? '#1a7a44' : activeFilterCount > 0 ? '#EAF3DE' : '#fff',
              color: showFilters ? '#fff' : activeFilterCount > 0 ? '#1a7a44' : '#555',
              cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 }}>
            🔍 פילטרים{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
          </button>
          {activeFilterCount > 0 && (
            <button onClick={clearFilters}
              style={{ fontSize: 11, padding: '3px 10px', borderRadius: 16, border: '1px solid #ddd',
                background: '#fff', color: '#888', cursor: 'pointer', fontFamily: 'inherit' }}>
              ✕ נקה הכל
            </button>
          )}
          {activeFilterCount > 0 && (
            <span style={{ fontSize: 12, color: '#1a7a44', fontWeight: 600 }}>
              מציג {filteredScores.length} מתוך {scores.length}
            </span>
          )}
        </div>
        {showFilters && (
          <div style={{ background: '#f8f9fc', border: '1px solid #e8e8f0', borderRadius: 12, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {/* Row 1: Team picks */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: '#888', minWidth: 60 }}>ניחושי קבוצות:</span>
              {[
                { key: 'champion', label: '🏆 זוכה', options: champOptions },
                { key: 'runnerUp', label: '🥈 סגנית', options: runnerOptions },
                { key: 'third',    label: '🥉 שלישית', options: thirdOptions },
              ].map(({ key, label, options }) => (
                <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                  <span style={{ color: '#555' }}>{label}</span>
                  <select value={filters[key as keyof typeof filters] as string}
                    onChange={e => setFilter(key as keyof typeof filters, e.target.value)}
                    style={{ fontSize: 11, border: `1px solid ${filters[key as keyof typeof filters] ? '#1a7a44' : '#ddd'}`,
                      borderRadius: 8, padding: '2px 6px', background: filters[key as keyof typeof filters] ? '#EAF3DE' : '#fff',
                      color: filters[key as keyof typeof filters] ? '#1a7a44' : '#333', cursor: 'pointer', fontFamily: 'inherit' }}>
                    <option value="">הכל</option>
                    {options.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </label>
              ))}
            </div>
            {/* Row 2: Player picks */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: '#888', minWidth: 60 }}>שחקנים:</span>
              {[
                { key: 'scorer',  label: '⚽ מלך שערים', options: scorerOptions },
                { key: 'assists', label: '👟 מלך בישולים', options: assistsOptions },
              ].map(({ key, label, options }) => (
                <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                  <span style={{ color: '#555' }}>{label}</span>
                  <select value={filters[key as keyof typeof filters] as string}
                    onChange={e => setFilter(key as keyof typeof filters, e.target.value)}
                    style={{ fontSize: 11, border: `1px solid ${filters[key as keyof typeof filters] ? '#1a7a44' : '#ddd'}`,
                      borderRadius: 8, padding: '2px 6px', background: filters[key as keyof typeof filters] ? '#EAF3DE' : '#fff',
                      color: filters[key as keyof typeof filters] ? '#1a7a44' : '#333', cursor: 'pointer', fontFamily: 'inherit' }}>
                    <option value="">הכל</option>
                    {options.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </label>
              ))}
            </div>
            {/* Row 3: Top N */}
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: '#888' }}>הצג:</span>
              {[0, 3, 5, 10, 20].map(n => (
                <button key={n} onClick={() => setFilter('topN', n)}
                  style={{ fontSize: 11, padding: '3px 10px', borderRadius: 16, cursor: 'pointer', fontFamily: 'inherit',
                    border: `1px solid ${filters.topN === n ? '#1a1a2e' : '#ddd'}`,
                    background: filters.topN === n ? '#1a1a2e' : '#fff',
                    color: filters.topN === n ? '#fff' : '#555', fontWeight: filters.topN === n ? 700 : 400 }}>
                  {n === 0 ? 'הכל' : `Top ${n}`}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <button onClick={() => setShowColSettings(v => !v)}
          style={{ fontSize: 12, padding: '4px 12px', borderRadius: 16, border: '1px solid #ddd', flexShrink: 0,
            background: showColSettings ? '#1a1a2e' : '#fff', color: showColSettings ? '#fff' : '#555',
            cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 }}>
          ⚙️ עמודות
        </button>
        {showColSettings && (
          <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 2, flex: 1 }}>
            {COLS.map(c => (
              <button key={c.key} onClick={() => toggleCol(c.key)}
                style={{ fontSize: 11, padding: '3px 10px', borderRadius: 16, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0,
                  border: `1px solid ${hiddenCols.has(c.key) ? '#ddd' : '#1a7a44'}`,
                  background: hiddenCols.has(c.key) ? '#f5f5f5' : '#EAF3DE',
                  color: hiddenCols.has(c.key) ? '#aaa' : '#1a7a44', fontWeight: 600 }}>
                {hiddenCols.has(c.key) ? '○' : '✓'} {c.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Table ── */}
      <div ref={lbRef} className="leaderboard" style={{ overflowX: 'auto' }}>

        {/* Header */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: `52px 1fr ${visibleCols.map(() => '54px').join(' ')} 76px`,
          background: '#1a1a2e', color: '#fff', borderRadius: '10px 10px 0 0',
          padding: '10px 12px', alignItems: 'center', gap: 0,
          fontSize: 12, fontWeight: 600, letterSpacing: 0.3,
        }}>
          <span style={{ textAlign: 'center' }}>#</span>
          <span style={{ paddingRight: 4 }}>שחקן</span>
          {visibleCols.map(c => (
            <span key={c.key} title={c.hint} style={{
              textAlign: 'center',
              color: c.sub ? '#93A8CC' : '#fff',
              fontSize: c.sub ? 11 : 12,
            }}>
              {c.label}
            </span>
          ))}
          <span style={{ textAlign: 'center' }}>סה"כ</span>
        </div>

        {filteredScores.map((s, i) => {
          const isMe  = s.userId === user?.uid
          const pct   = maxTotal > 0 ? (s.total / maxTotal) * 100 : 0
          const sExt  = s as UserScore & { prevTotal?: number; prevRank?: number }
          const ptsDelta  = sExt.prevTotal != null && sExt.prevTotal !== s.total ? s.total - sExt.prevTotal : null
          const rankDelta = sExt.prevRank  != null && sExt.prevRank  !== (i + 1)  ? sExt.prevRank - (i + 1) : null
          const rank  = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1

          const rowContent = (
            <div style={{
              display: 'grid',
              gridTemplateColumns: `52px 1fr ${visibleCols.map(() => '54px').join(' ')} 76px`,
              alignItems: 'center',
              gap: 0,
              padding: '10px 12px',
              borderBottom: '1px solid #f0f0f0',
              background: isMe
                ? 'linear-gradient(to left, #EDF5FF, #f5f9ff)'
                : i % 2 === 0 ? '#fff' : '#fafafa',
              position: 'relative',
              overflow: 'hidden',
            }}>
              {/* Progress bar */}
              {tournamentStarted && (
                <div style={{
                  position: 'absolute', top: 0, right: 0, height: '100%',
                  width: `${pct}%`, background: isMe ? 'rgba(24,95,165,0.06)' : 'rgba(26,26,46,0.03)',
                  pointerEvents: 'none',
                }} />
              )}

              {/* Rank */}
              <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                <span style={{ fontWeight: 800, fontSize: typeof rank === 'number' ? 15 : 20, lineHeight: 1 }}>
                  {rank}
                </span>
                {rankDelta != null && rankDelta !== 0 && (
                  <span style={{
                    fontSize: 10, fontWeight: 800, padding: '2px 5px', borderRadius: 10,
                    background: rankDelta > 0 ? '#EAF3DE' : '#FCEBEB',
                    color: rankDelta > 0 ? '#1a7a44' : '#c0392b',
                    lineHeight: 1.2,
                  }}>
                    {rankDelta > 0 ? `▲${rankDelta}` : `▼${Math.abs(rankDelta)}`}
                  </span>
                )}
              </div>

              {/* Name */}
              <div style={{ paddingRight: 4, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2 }}>
                  <span style={{ fontWeight: isMe ? 800 : 600, fontSize: 14, color: '#1a1a2e' }}>
                    {displayName(s)}
                  </span>
                  {isMe && <span style={{ fontSize: 10, color: '#185FA5', background: '#EDF5FF', padding: '1px 6px', borderRadius: 8, fontWeight: 600 }}>אני</span>}
                </div>
                {bonusPreds[s.userId] && (() => {
                  const b = bonusPreds[s.userId]
                  const teams = [
                    b.q105 && { icon: '🏆', flag: FLAGS[b.q105] ?? '', title: b.q105 },
                    b.q106 && { icon: '🥈', flag: FLAGS[b.q106] ?? '', title: b.q106 },
                    b.q107 && { icon: '🥉', flag: FLAGS[b.q107] ?? '', title: b.q107 },
                  ].filter(Boolean) as { icon: string; flag: string; title: string }[]
                  const players = [
                    b.q108 && { icon: '⚽', name: b.q108 },
                    b.q110 && { icon: '👟', name: b.q110 },
                  ].filter(Boolean) as { icon: string; name: string }[]
                  if (!teams.length && !players.length) return null
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      {teams.length > 0 && (
                        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                          {teams.map((item, idx) => (
                            <span key={idx} title={item.title} style={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 13 }}>
                              {item.flag ? <Flag emoji={item.flag} size={16} /> : '—'}
                              <span style={{ fontSize: 10 }}>{item.icon}</span>
                            </span>
                          ))}
                        </div>
                      )}
                      {players.length > 0 && (
                        <div style={{ display: 'flex', gap: 6, fontSize: 10, color: '#aaa' }}>
                          {players.map((item, idx) => (
                            <span key={idx} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                              <span>{item.icon}</span>
                              <span style={{ maxWidth: 70, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {item.name}
                              </span>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })()}
              </div>

              {/* Score columns */}
              {visibleCols.map(c => {
                const val = colVal(s, c.key)
                return (
                  <div key={c.key} style={{ textAlign: 'center' }}>
                    <span style={{
                      fontSize: val > 0 ? 15 : 13,
                      fontWeight: val > 0 ? 700 : 400,
                      color: val === 0 ? '#ddd' : c.sub ? '#4A6FA5' : '#1a1a2e',
                    }}>
                      {val > 0 ? val : '—'}
                    </span>
                  </div>
                )
              })}

              {/* Total */}
              <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                <span style={{ fontSize: 20, fontWeight: 900, color: isMe ? '#185FA5' : '#1a1a2e', lineHeight: 1 }}>
                  {s.total}
                </span>
                {ptsDelta != null && ptsDelta !== 0 && (
                  <span style={{
                    fontSize: 11, fontWeight: 800, padding: '2px 7px', borderRadius: 12,
                    background: ptsDelta > 0 ? '#EAF3DE' : '#FCEBEB',
                    color: ptsDelta > 0 ? '#1a7a44' : '#c0392b',
                  }}>
                    {ptsDelta > 0 ? `+${ptsDelta}` : ptsDelta}
                  </span>
                )}
              </div>
            </div>
          )

          return (
            <div key={s.userId}>
              {/* Desktop row */}
              <div className={`lb-row-desktop ${isMe ? 'lb-me' : ''}`}>
                {rowContent}
              </div>

              {/* Mobile card */}
              <div className={`lb-row-mobile ${isMe ? 'lb-me' : ''}`}
                style={{ position: 'relative', overflow: 'hidden' }}>
                {tournamentStarted && (
                  <div className="lb-row-bar" style={{ width: `${pct}%` }} />
                )}
                {/* Top row: rank | name + bonus | total */}
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <div style={{ minWidth: 36, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, paddingTop: 2 }}>
                    <span style={{ fontWeight: 800, fontSize: typeof rank === 'number' ? 18 : 22, lineHeight: 1 }}>{rank}</span>
                    {rankDelta != null && rankDelta !== 0 && (
                      <span style={{
                        fontSize: 12, fontWeight: 900, padding: '3px 7px', borderRadius: 10,
                        background: rankDelta > 0 ? '#EAF3DE' : '#FCEBEB',
                        color: rankDelta > 0 ? '#1a7a44' : '#c0392b',
                        lineHeight: 1.2,
                      }}>
                        {rankDelta > 0 ? `▲${rankDelta}` : `▼${Math.abs(rankDelta)}`}
                      </span>
                    )}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: isMe ? 700 : 500, fontSize: 14 }}>
                      {displayName(s)}
                      {isMe && <span style={{ fontSize: 11, color: '#185FA5', marginRight: 4 }}>(אני)</span>}
                    </div>
                    {/* Bonus flags on mobile */}
                    {bonusPreds[s.userId] && (() => {
                      const b = bonusPreds[s.userId]
                      const teams = [
                        b.q105 && { icon: '🏆', flag: FLAGS[b.q105] ?? '', title: b.q105 },
                        b.q106 && { icon: '🥈', flag: FLAGS[b.q106] ?? '', title: b.q106 },
                        b.q107 && { icon: '🥉', flag: FLAGS[b.q107] ?? '', title: b.q107 },
                      ].filter(Boolean) as { icon: string; flag: string; title: string }[]
                      const players = [
                        b.q108 && { icon: '⚽', name: b.q108 },
                        b.q110 && { icon: '👟', name: b.q110 },
                      ].filter(Boolean) as { icon: string; name: string }[]
                      return (
                        <div style={{ marginTop: 3, display: 'flex', flexDirection: 'column', gap: 1 }}>
                          {teams.length > 0 && (
                            <div style={{ display: 'flex', gap: 4 }}>
                              {teams.map((item, idx) => (
                                <span key={idx} title={item.title} style={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                  {item.flag ? <Flag emoji={item.flag} size={16} /> : '—'}
                                  <span style={{ fontSize: 10 }}>{item.icon}</span>
                                </span>
                              ))}
                            </div>
                          )}
                          {players.length > 0 && (
                            <div style={{ display: 'flex', gap: 6, fontSize: 10, color: '#999' }}>
                              {players.map((item, idx) => (
                                <span key={idx}>{item.icon} {item.name}</span>
                              ))}
                            </div>
                          )}
                        </div>
                      )
                    })()}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                    <span style={{ fontWeight: 800, fontSize: 22 }}>{s.total}</span>
                    {ptsDelta != null && ptsDelta !== 0 && (
                      <span style={{
                        fontSize: 11, fontWeight: 800, padding: '1px 6px', borderRadius: 20,
                        background: ptsDelta > 0 ? '#EAF3DE' : '#FCEBEB',
                        color: ptsDelta > 0 ? '#1a7a44' : '#c0392b',
                      }}>
                        {ptsDelta > 0 ? `+${ptsDelta}` : ptsDelta}
                      </span>
                    )}
                  </div>
                </div>
                {/* Breakdown row */}
                <div style={{ display: 'flex', gap: 10, marginTop: 6, paddingRight: 36, flexWrap: 'wrap' }}>
                  {[
                    { label: 'בתים',    val: colVal(s, 'match') },
                    { label: 'עולות',   val: colVal(s, 'group') },
                    { label: 'נוקאאוט', val: s.knockoutPoints ?? 0 },
                    { label: 'בונוס',   val: colVal(s, 'bonus') },
                  ].map(item => (
                    <span key={item.label} style={{ fontSize: 12, color: item.val === 0 && tournamentStarted ? '#ccc' : '#888' }}>
                      {item.label} <b style={{ color: item.val === 0 && tournamentStarted ? '#ccc' : 'var(--text, #1a1a2e)' }}>{item.val}</b>
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <div style={{ display: 'flex', gap: 14, marginTop: 12, flexWrap: 'wrap', fontSize: 12, color: '#999' }}>
        {COLS.map(c => (
          <span key={c.key}><b style={{ color: '#555' }}>{c.label}:</b> {c.hint}</span>
        ))}
      </div>
    </div>
  )
}
