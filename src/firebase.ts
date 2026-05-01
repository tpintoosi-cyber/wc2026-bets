import { initializeApp } from 'firebase/app'
import { getAuth, GoogleAuthProvider } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'

const firebaseConfig = {
  apiKey:            "AIzaSyCcCeOt1e3r0J6YUcSSxMR6cHCpOscKcdM",
  authDomain:        "worldcup-2026-9cfb9.firebaseapp.com",
  projectId:         "worldcup-2026-9cfb9",
  storageBucket:     "worldcup-2026-9cfb9.firebasestorage.app",
  messagingSenderId: "1040569187587",
  appId:             "1:1040569187587:web:e4c8188feb1fdb04f33d36",
}

const app = initializeApp(firebaseConfig)

export const auth = getAuth(app)
export const db   = getFirestore(app)
export const googleProvider = new GoogleAuthProvider()