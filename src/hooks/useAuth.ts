import { useState, useEffect } from 'react'
import { User, onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { auth, db, googleProvider } from '../firebase'

export function useAuth() {
  const [user, setUser] = useState<User | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    return onAuthStateChanged(auth, async (u) => {
      setUser(u)
      if (u) {
        // Create user doc if first login
        const ref = doc(db, 'users', u.uid)
        const snap = await getDoc(ref)
        if (!snap.exists()) {
          await setDoc(ref, { name: u.displayName, email: u.email, joinedAt: Date.now() })
        }
        // Check admin
        const settings = await getDoc(doc(db, 'settings', 'app'))
        const admins: string[] = settings.data()?.adminUids ?? []
        setIsAdmin(admins.includes(u.uid))
      } else {
        setIsAdmin(false)
      }
      setLoading(false)
    })
  }, [])

  const login = () => signInWithPopup(auth, googleProvider)
  const logout = () => signOut(auth)

  return { user, isAdmin, loading, login, logout }
}

export async function isAppOpen(): Promise<boolean> {
  const snap = await getDoc(doc(db, 'settings', 'app'))
  if (!snap.exists()) return true
  const data = snap.data()
  if (!data.isOpen) return false
  if (data.deadline && Date.now() > data.deadline) return false
  return true
}
