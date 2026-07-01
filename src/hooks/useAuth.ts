import { useState, useEffect } from 'react'
import { User, onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { auth, db, googleProvider } from '../firebase'

export function useAuth() {
  const [user, setUser] = useState<User | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const [isApproved, setIsApproved] = useState(false)
  const [loading, setLoading] = useState(true)
  const [firestoreName, setFirestoreName] = useState<string | null>(null)

  useEffect(() => {
    return onAuthStateChanged(auth, async (u) => {
      setUser(u)
      if (u) {
        // Check admin
        const settings = await getDoc(doc(db, 'settings', 'app'))
        const admins: string[] = settings.data()?.adminUids ?? []
        const admin = admins.includes(u.uid)
        setIsAdmin(admin)

        if (admin) {
          // Admins are always approved
          setIsApproved(true)
          // Read admin's Firestore name too
          const userSnap = await getDoc(doc(db, 'users', u.uid))
          if (userSnap.exists()) setFirestoreName(userSnap.data().name ?? null)
        } else {
          // Check approval status
          const pendingRef = doc(db, 'pendingUsers', u.uid)
          const pendingSnap = await getDoc(pendingRef)

          if (!pendingSnap.exists()) {
            // First time — create pending request
            await setDoc(pendingRef, {
              uid: u.uid,
              displayName: u.displayName ?? '',
              email: u.email ?? '',
              photoURL: u.photoURL ?? '',
              requestedAt: Date.now(),
              status: 'pending',
            })
            setIsApproved(false)
          } else {
            const status = pendingSnap.data().status
            setIsApproved(status === 'approved')
          }

          // Create user doc only once approved — then read Firestore name
          if (pendingSnap.data()?.status === 'approved') {
            const userRef = doc(db, 'users', u.uid)
            const userSnap = await getDoc(userRef)
            if (!userSnap.exists()) {
              await setDoc(userRef, { name: u.displayName, email: u.email, joinedAt: Date.now() })
              setFirestoreName(u.displayName)
            } else {
              // ✅ Use the stored short name — never overwrite with Google display name
              setFirestoreName(userSnap.data().name ?? u.displayName)
            }
          }
        }
      } else {
        setIsAdmin(false)
        setIsApproved(false)
        setFirestoreName(null)
      }
      setLoading(false)
    })
  }, [])

  const login = () => signInWithPopup(auth, googleProvider)
  const logout = () => signOut(auth)

  return { user, isAdmin, isApproved, loading, login, logout, firestoreName }
}

export async function isAppOpen(): Promise<boolean> {
  const snap = await getDoc(doc(db, 'settings', 'app'))
  if (!snap.exists()) return true
  const data = snap.data()
  if (!data.isOpen) return false
  if (data.deadline && Date.now() > data.deadline) return false
  return true
}
