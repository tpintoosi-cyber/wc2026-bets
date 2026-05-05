import { useState, useEffect } from 'react'
import { HashRouter, Routes, Route, Navigate, Link, useLocation } from 'react-router-dom'
import { useAuth } from './hooks/useAuth'
import Login from './pages/Login'
import Predict from './pages/Predict'
import Leaderboard from './pages/Leaderboard'
import Admin from './pages/Admin'
import AllPredictions from './pages/AllPredictions'
import { Lang } from './i18n'
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

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) return <div className="center-screen">טוען...</div>
  if (!user) return <Navigate to="/login" replace />
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
        <Route path="/predict" element={<RequireAuth><Predict lang={lang} /></RequireAuth>} />
        <Route path="/all" element={<RequireAuth><AllPredictions /></RequireAuth>} />
        <Route path="/leaderboard" element={<RequireAuth><Leaderboard /></RequireAuth>} />
        <Route path="/admin" element={<RequireAdmin><Admin /></RequireAdmin>} />
        <Route path="*" element={<Navigate to="/predict" replace />} />
      </Routes>
    </HashRouter>
  )
}
