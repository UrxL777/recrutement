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

// Le profil n'a pas pu être lu : on dit pourquoi, et on permet de réessayer ou de se déconnecter
function ErreurProfil({ texte, onReessayer }) {
  return (
    <div className="mx-auto max-w-md py-24 text-center">
      <p className="text-slate-700">{texte}</p>
      <div className="mt-6 flex justify-center gap-3">
        <button onClick={onReessayer} className="rounded-lg bg-principal px-4 py-2 text-white">Réessayer</button>
        <button onClick={() => supabase.auth.signOut()} className="rounded-lg border border-slate-300 px-4 py-2">Se déconnecter</button>
      </div>
    </div>
  )
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
  const [essai, setEssai] = useState(0)

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
      .then(({ data, error }) => {
        if (error) setErreurProfil(`Votre profil n'a pas pu être lu : ${error.message}`)
        else if (!data) setErreurProfil('Profil introuvable pour ce compte. Déconnectez-vous, puis reconnectez-vous.')
        else setProfil(data)
      })
  }, [session, essai])

  if (session === undefined) return <Chargement />
  if (!session) {
    return (
      <Routes>
        <Route path="/" element={<Connexion />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    )
  }
  if (erreurProfil) return <ErreurProfil texte={erreurProfil} onReessayer={() => setEssai(essai + 1)} />
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
