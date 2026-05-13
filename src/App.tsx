import React, { useState, useEffect } from 'react'
import { HashRouter, Routes, Route, Navigate, Link, useLocation } from 'react-router-dom'
import { useAuth } from './hooks/useAuth'
import Login from './pages/Login'
import Predict from './pages/Predict'
import Leaderboard from './pages/Leaderboard'
import Admin from './pages/Admin'
import AllPredictions from './pages/AllPredictions'
import Simulator from './pages/Simulator'
import { Lang, T } from './i18n'
import './styles/global.css'

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
      </div>
      <div className="nav-controls">
        <button className="nav-btn" onClick={toggleLang} title="Change language">
          {lang === 'he' ? 'EN' : 'עב'}
        </button>
        <button className="nav-btn" onClick={toggleDark} title={dark ? 'Light mode' : 'Dark mode'}>
          {dark ? '☀️' : '🌙'}
        </button>
        <button className="btn-ghost" onClick={logout}>
          {user.displayName?.split(' ')[0]} ↩
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
  const { user, isApproved, loading, logout } = useAuth()
  if (loading) return <div className="center-screen">{lang === 'he' ? 'טוען...' : 'Loading...'}</div>
  if (!user) return <Navigate to="/login" replace />
  if (!isApproved) return <PendingApproval logout={logout} lang={lang} />
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
        <Route path="/all" element={<RequireAuth lang={lang}><AllPredictions /></RequireAuth>} />
        <Route path="/leaderboard" element={<RequireAuth lang={lang}><Leaderboard /></RequireAuth>} />
        <Route path="/admin" element={<RequireAdmin><Admin /></RequireAdmin>} />
        <Route path="/sim" element={<RequireAdmin><Simulator /></RequireAdmin>} />
        <Route path="*" element={<Navigate to="/predict" replace />} />
      </Routes>
    </HashRouter>
  )
}
