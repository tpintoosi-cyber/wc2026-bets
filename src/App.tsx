import React, { useState, useEffect } from 'react'
import { HashRouter, Routes, Route, Navigate, Link, useLocation } from 'react-router-dom'
import { doc, onSnapshot } from 'firebase/firestore'
import { db } from './firebase'
import { useAuth } from './hooks/useAuth'
import Login from './pages/Login'
import Predict from './pages/Predict'
import Leaderboard from './pages/Leaderboard'
import Admin from './pages/Admin'
import AllPredictions from './pages/AllPredictions'
import Simulator from './pages/Simulator'
import Rules from './pages/Rules'
import { Lang, T } from './i18n'
import './styles/global.css'

function MaintenancePage({ logout, lang }: { logout: () => void; lang: Lang }) {
  return (
    <div className="center-screen" style={{ flexDirection: 'column', gap: 20, textAlign: 'center', padding: 32 }}>
      <div style={{ fontSize: 64 }}>🔧</div>
      <h2 style={{ margin: 0, fontSize: 22 }}>
        {lang === 'he' ? 'האפליקציה בתחזוקה רגעית' : 'Down for maintenance'}
      </h2>
      <p style={{ color: 'var(--text-secondary)', maxWidth: 320, margin: 0, fontSize: 15 }}>
        {lang === 'he'
          ? 'אנחנו מבצעים עדכונים קצרים. נחזור בקרוב 🙏'
          : 'We\'re making some updates. Be back shortly 🙏'}
      </p>
      <button className="btn-secondary" onClick={logout} style={{ marginTop: 8 }}>
        {lang === 'he' ? 'התנתק' : 'Sign out'}
      </button>
    </div>
  )
}

function Nav({ dark, toggleDark, lang, toggleLang }: {
  dark: boolean; toggleDark: () => void
  lang: Lang; toggleLang: () => void
}) {
  const { user, isAdmin, logout } = useAuth()
  const loc = useLocation()
  if (!user) return null
  return (
    <nav className="nav">
      <div className="nav-logo">⚽ <span className="nav-label">WC2026</span></div>
      <div className="nav-links">
        <Link className={loc.pathname === '/predict' ? 'active' : ''} to="/predict">
          🎯 <span className="nav-label">{lang === 'he' ? 'הימורים' : 'My Bets'}</span>
        </Link>
        <Link className={loc.pathname === '/all' ? 'active' : ''} to="/all">
          👥 <span className="nav-label">{lang === 'he' ? 'כולם' : 'All Bets'}</span>
        </Link>
        <Link className={loc.pathname === '/leaderboard' ? 'active' : ''} to="/leaderboard">
          🏆 <span className="nav-label">{lang === 'he' ? 'טבלה' : 'Board'}</span>
        </Link>
        {isAdmin && <Link className={loc.pathname === '/admin' ? 'active' : ''} to="/admin">⚙️</Link>}
        {isAdmin && <Link className={loc.pathname === '/sim' ? 'active' : ''} to="/sim">🧪</Link>}
        <Link className={loc.pathname === '/rules' ? 'active' : ''} to="/rules" title={lang === 'he' ? 'תקנון' : 'Rules'}>📖</Link>
      </div>
      <div className="nav-controls">
        <button className="nav-btn" onClick={toggleLang} title="Change language">
          {lang === 'he' ? 'EN' : 'עב'}
        </button>
        <button className="nav-btn" onClick={toggleDark} title={dark ? 'Light mode' : 'Dark mode'}>
          {dark ? '☀️' : '🌙'}
        </button>
        <button className="btn-ghost" onClick={logout}>
          <span className="nav-logout-name">{user.displayName?.split(' ')[0]} </span>↩
        </button>
      </div>
    </nav>
  )
}

function PendingApproval({ logout, lang }: { logout: () => void; lang: Lang }) {
  const t = T[lang]
  return (
    <div className="center-screen" style={{ flexDirection: 'column', gap: 16, textAlign: 'center', padding: 32 }}>
      <div style={{ fontSize: 48 }}>⏳</div>
      <h2 style={{ margin: 0 }}>{t.pendingTitle}</h2>
      <p style={{ color: 'var(--text-secondary)', maxWidth: 320, margin: 0 }}>{t.pendingMsg}</p>
      <button className="btn-secondary" onClick={logout} style={{ marginTop: 8 }}>
        {lang === 'he' ? 'התנתק' : 'Sign out'}
      </button>
    </div>
  )
}

function RequireAuth({ children, lang }: { children: React.ReactNode; lang: Lang }) {
  const { user, isApproved, isAdmin, loading, logout } = useAuth()
  const [maintenance, setMaintenance] = useState(false)

  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'admin', 'settings'), snap => {
      setMaintenance(snap.exists() ? (snap.data().maintenanceMode ?? false) : false)
    })
    return unsub
  }, [])

  if (loading) return <div className="center-screen">{lang === 'he' ? 'טוען...' : 'Loading...'}</div>
  if (!user) return <Navigate to="/login" replace />
  if (!isApproved) return <PendingApproval logout={logout} lang={lang} />
  if (maintenance && !isAdmin) return <MaintenancePage logout={logout} lang={lang} />
  return <>{children}</>
}

function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { isAdmin, loading } = useAuth()
  if (loading) return <div className="center-screen">טוען...</div>
  if (!isAdmin) return <Navigate to="/" replace />
  return <>{children}</>
}

export default function App() {
  const [dark, setDark] = useState(() => localStorage.getItem('darkMode') === 'true')
  const [lang, setLang] = useState<Lang>(() => (localStorage.getItem('lang') as Lang) || 'he')

  useEffect(() => {
    document.body.classList.toggle('dark', dark)
    localStorage.setItem('darkMode', String(dark))
  }, [dark])

  const toggleLang = () => {
    const next: Lang = lang === 'he' ? 'en' : 'he'
    setLang(next)
    localStorage.setItem('lang', next)
  }

  return (
    <HashRouter>
      <Nav dark={dark} toggleDark={() => setDark(d => !d)} lang={lang} toggleLang={toggleLang} />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/predict" element={<RequireAuth lang={lang}><Predict lang={lang} /></RequireAuth>} />
        <Route path="/all" element={<RequireAuth lang={lang}><AllPredictions lang={lang} /></RequireAuth>} />
        <Route path="/leaderboard" element={<RequireAuth lang={lang}><Leaderboard /></RequireAuth>} />
        <Route path="/admin" element={<RequireAdmin><Admin /></RequireAdmin>} />
        <Route path="/sim" element={<RequireAdmin><Simulator /></RequireAdmin>} />
        <Route path="/rules" element={<RequireAuth lang={lang}><Rules /></RequireAuth>} />
        <Route path="*" element={<Navigate to="/predict" replace />} />
      </Routes>
    </HashRouter>
  )
}
