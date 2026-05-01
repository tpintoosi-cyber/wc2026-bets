import { useState, useEffect } from 'react'
import { HashRouter, Routes, Route, Navigate, Link, useLocation } from 'react-router-dom'
import { useAuth } from './hooks/useAuth'
import Login from './pages/Login'
import Predict from './pages/Predict'
import Leaderboard from './pages/Leaderboard'
import Admin from './pages/Admin'
import AllPredictions from './pages/AllPredictions'
import './styles/global.css'

function Nav({ dark, toggleDark }: { dark: boolean; toggleDark: () => void }) {
  const { user, isAdmin, logout } = useAuth()
  const loc = useLocation()
  if (!user) return null
  return (
    <nav className="nav">
      <div className="nav-logo">⚽ WC2026</div>
      <div className="nav-links">
        <Link className={loc.pathname === '/predict' ? 'active' : ''} to="/predict">הימורים שלי</Link>
        <Link className={loc.pathname === '/all' ? 'active' : ''} to="/all">הימורי כולם</Link>
        <Link className={loc.pathname === '/leaderboard' ? 'active' : ''} to="/leaderboard">טבלה</Link>
        {isAdmin && <Link className={loc.pathname === '/admin' ? 'active' : ''} to="/admin">אדמין</Link>}
      </div>
      <button className="dark-toggle" onClick={toggleDark} title="מצב כהה">
        {dark ? '☀️' : '🌙'}
      </button>
      <button className="btn-ghost" onClick={logout}>
        {user.displayName?.split(' ')[0]} ↩
      </button>
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

  useEffect(() => {
    document.body.classList.toggle('dark', dark)
    localStorage.setItem('darkMode', String(dark))
  }, [dark])

  return (
    <HashRouter>
      <Nav dark={dark} toggleDark={() => setDark(d => !d)} />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/predict" element={<RequireAuth><Predict /></RequireAuth>} />
        <Route path="/all" element={<RequireAuth><AllPredictions /></RequireAuth>} />
        <Route path="/leaderboard" element={<RequireAuth><Leaderboard /></RequireAuth>} />
        <Route path="/admin" element={<RequireAdmin><Admin /></RequireAdmin>} />
        <Route path="*" element={<Navigate to="/predict" replace />} />
      </Routes>
    </HashRouter>
  )
}
