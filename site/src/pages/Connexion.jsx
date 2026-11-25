// Connexion et inscription (Supabase Auth). Le mot de passe n'est jamais géré par notre code.
// À l'inscription, le rôle, le nom… sont envoyés avec le compte : le trigger creer_profil crée le profil.
import { useEffect, useState } from 'react'
import { supabase } from '../supabase'

const TRADUCTIONS = [
  [/invalid login credentials/i, 'E-mail ou mot de passe incorrect.'],
  [/email not confirmed/i, 'Confirmez votre adresse e-mail (lien reçu par e-mail), puis reconnectez-vous.'],
  [/already registered/i, 'Un compte existe déjà avec cette adresse e-mail.'],
  [/password should be at least/i, 'Le mot de passe doit contenir au moins 6 caractères.'],
  [/database error saving new user/i, 'Inscription refusée : vérifiez les champs obligatoires.'],
  [/rate limit|too many/i, 'Trop de tentatives. Patientez quelques minutes.'],
]
const traduire = (message) => (TRADUCTIONS.find(([motif]) => motif.test(message)) || [null, message])[1]

const champ = 'w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-principal focus:outline-none'

export default function Connexion() {
  const [mode, setMode] = useState('connexion')
  const [form, setForm] = useState({ role: 'candidat', prenom: '', nom: '', lieu_residence: '', entreprise: '', site_web: '', email: '', mdp: '' })
  const [lieux, setLieux] = useState([])
  const [erreur, setErreur] = useState('')
  const [info, setInfo] = useState('')
  const [chargement, setChargement] = useState(false)

  // Les suggestions de lieux de résidence (la liste qui se déroule)
  useEffect(() => {
    supabase.from('lieux_residence').select('nom').order('nom').then(({ data }) => setLieux(data || []))
  }, [])

  const changer = (cle) => (e) => setForm({ ...form, [cle]: e.target.value })

  async function envoyer(e) {
    e.preventDefault()
    setErreur(''); setInfo(''); setChargement(true)
    if (mode === 'connexion') {
      const { error } = await supabase.auth.signInWithPassword({ email: form.email.trim(), password: form.mdp })
      if (error) setErreur(traduire(error.message))
    } else {
      const { data, error } = await supabase.auth.signUp({
        email: form.email.trim(),
        password: form.mdp,
        options: {
          data: {
            role: form.role, prenom: form.prenom, nom: form.nom, lieu_residence: form.lieu_residence,
            entreprise: form.role === 'recruteur' ? form.entreprise : '',
            site_web: form.role === 'recruteur' ? form.site_web : '',
          },
        },
      })
      if (error) setErreur(traduire(error.message))
      else if (!data.session) setInfo('Compte créé ! Confirmez votre adresse e-mail (lien reçu par e-mail), puis connectez-vous.')
    }
    setChargement(false)
  }

  return (
    <div className="mx-auto max-w-md px-4 py-12">
      <h1 className="text-center text-3xl font-bold text-principal-fonce">RecrutSmart</h1>
      <p className="mt-2 text-center text-slate-600">Le recrutement intelligent : déposez votre CV, ou trouvez le bon profil.</p>

      <div className="mt-8 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-6 grid grid-cols-2 rounded-lg bg-slate-100 p-1 text-sm font-medium">
          {['connexion', 'inscription'].map((m) => (
            <button key={m} onClick={() => { setMode(m); setErreur(''); setInfo('') }}
              className={`rounded-md py-2 ${mode === m ? 'bg-white shadow-sm' : 'text-slate-500'}`}>
              {m === 'connexion' ? 'Se connecter' : "S'inscrire"}
            </button>
          ))}
        </div>

        <form onSubmit={envoyer} className="space-y-4">
          {mode === 'inscription' && (
            <>
              <div className="grid grid-cols-2 gap-2 text-sm">
                {[['candidat', 'Je suis candidat'], ['recruteur', 'Je recrute']].map(([role, texte]) => (
                  <label key={role} className={`cursor-pointer rounded-lg border px-3 py-2 text-center ${form.role === role ? 'border-principal bg-blue-50 font-medium text-principal' : 'border-slate-300'}`}>
                    <input type="radio" name="role" value={role} checked={form.role === role} onChange={changer('role')} className="hidden" />
                    {texte}
                  </label>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <input required placeholder="Prénom" value={form.prenom} onChange={changer('prenom')} className={champ} />
                <input required placeholder="Nom" value={form.nom} onChange={changer('nom')} className={champ} />
              </div>
              <input required list="lieux" placeholder="Lieu de résidence (ex. une commune, une ville)" value={form.lieu_residence} onChange={changer('lieu_residence')} className={champ} />
              <datalist id="lieux">{lieux.map((l) => <option key={l.nom} value={l.nom} />)}</datalist>
              {form.role === 'recruteur' && (
                <>
                  <input required placeholder="Entreprise" value={form.entreprise} onChange={changer('entreprise')} className={champ} />
                  <input placeholder="Site web de l'entreprise (facultatif)" value={form.site_web} onChange={changer('site_web')} className={champ} />
                </>
              )}
            </>
          )}
          <input required type="email" placeholder="Adresse e-mail" value={form.email} onChange={changer('email')} className={champ} />
          <input required type="password" minLength={6} placeholder="Mot de passe (6 caractères minimum)" value={form.mdp} onChange={changer('mdp')} className={champ} />

          {erreur && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{erreur}</p>}
          {info && <p className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{info}</p>}

          <button disabled={chargement} className="w-full rounded-lg bg-principal py-2.5 font-medium text-white hover:bg-principal-fonce disabled:opacity-60">
            {chargement ? 'Un instant…' : mode === 'connexion' ? 'Se connecter' : 'Créer mon compte'}
          </button>
        </form>
      </div>
    </div>
  )
}
