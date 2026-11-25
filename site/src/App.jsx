// Le plan du site : la connexion, l'espace candidat et l'espace recruteur.
// Démarche : 1. qui est connecté ? (Supabase Auth)  2. son profil (rôle)  3. la bonne page
import { useEffect, useState } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { supabase } from './supabase'
import Connexion from './pages/Connexion'
import EspaceCandidat from './pages/EspaceCandidat'
import EspaceRecruteur from './pages/EspaceRecruteur'

function Chargement({ texte = 'Chargement…' }) {
  return <p className="py-24 text-center text-slate-500">{texte}</p>
}

function Entete({ profil }) {
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
        <span className="text-xl font-bold text-principal-fonce">RecrutSmart</span>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-slate-600">
            {profil.prenom} {profil.nom} · {profil.role === 'recruteur' ? 'Recruteur' : 'Candidat'}
          </span>
          <button onClick={() => supabase.auth.signOut()} className="rounded-lg border border-slate-300 px-3 py-1.5 hover:bg-slate-100">
            Déconnexion
          </button>
        </div>
      </div>
    </header>
  )
}

export default function App() {
  const [session, setSession] = useState(undefined)   // undefined = on ne sait pas encore
  const [profil, setProfil] = useState(null)
  const [erreurProfil, setErreurProfil] = useState('')

  // 1. Qui est connecté ? (et être prévenu à chaque connexion ou déconnexion)
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((_evenement, nouvelle) => setSession(nouvelle))
    return () => data.subscription.unsubscribe()
  }, [])

  // 2. Son profil : le rôle décide de la page affichée
  useEffect(() => {
    setProfil(null)
    setErreurProfil('')
    if (!session) return
    supabase.from('profils').select('*').eq('id', session.user.id).maybeSingle()
      .then(({ data }) => (data ? setProfil(data) : setErreurProfil('Profil introuvable pour ce compte.')))
  }, [session])

  if (session === undefined) return <Chargement />
  if (!session) {
    return (
      <Routes>
        <Route path="/" element={<Connexion />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    )
  }
  if (erreurProfil) return <Chargement texte={erreurProfil} />
  if (!profil) return <Chargement />

  // 3. La bonne page selon le rôle
  const accueil = profil.role === 'recruteur' ? '/recruteur' : '/candidat'
  return (
    <>
      <Entete profil={profil} />
      <main className="mx-auto max-w-5xl px-4 py-8">
        <Routes>
          {profil.role === 'candidat' && <Route path="/candidat" element={<EspaceCandidat profil={profil} />} />}
          {profil.role === 'recruteur' && <Route path="/recruteur" element={<EspaceRecruteur />} />}
          <Route path="*" element={<Navigate to={accueil} />} />
        </Routes>
      </main>
    </>
  )
}
