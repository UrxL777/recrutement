// L'espace recruteur, sur une seule page :
//   1. la barre de recherche : le recruteur écrit ce qu'il cherche, en langage naturel
//   2. le serveur IA (/rechercher) rend les candidats classés : score, critères avec preuves, fiche d'identité
//   3. « Voir le CV » ouvre le fichier d'origine (lien temporaire)
//   4. la case « Affiner » : la précision est ajoutée à la conversation, l'agent refait la recherche
// La conversation est gardée dans le navigateur (sessionStorage), le temps de la visite.
import { useEffect, useState } from 'react'
import { appelerServeur, ouvrirCv } from '../supabase'
import { dureeLisible, FicheIdentite } from './EspaceCandidat'

const CLE = 'recherche_recrutsmart'
const ICONES = { trouve: '✅', partiel: '🟡', absent: '⬜' }
const champ = 'w-full rounded-lg border border-slate-300 px-4 py-3 focus:border-principal focus:outline-none'

function lireMemoire() {
  try { return JSON.parse(sessionStorage.getItem(CLE)) || null } catch { return null }
}

function CarteCandidat({ r, nbCriteres, onErreur }) {
  const [ficheOuverte, setFicheOuverte] = useState(false)
  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">{r.prenom} {r.nom}</h3>
          <p className="text-slate-600">
            {r.titre || 'Métier non précisé'} · {r.lieu_residence}
            {r.age != null && ` · ${r.age} ans`}
            {r.annees_experience != null && ` · ${dureeLisible(r.annees_experience)} d'expérience`}
          </p>
          {r.valide_par_candidat && <span className="mt-1 inline-block text-xs font-medium text-green-700">✓ Fiche vérifiée par le candidat</span>}
        </div>
        <div className="text-right">
          <p className="text-3xl font-bold text-principal">{r.score} %</p>
          <p className="text-xs text-slate-500">{r.nb_trouves} critère(s) sur {nbCriteres}</p>
        </div>
      </div>

      <ul className="mt-4 space-y-1.5 text-sm">
        {r.criteres.map((c) => (
          <li key={c.critere}>
            <span className="mr-1">{ICONES[c.statut]}</span>
            <span className="font-medium">{c.critere}</span>
            <span className="text-slate-500"> : {c.preuve ? `« ${c.preuve} »` : 'non mentionné dans le CV'}</span>
          </li>
        ))}
      </ul>


      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button onClick={() => ouvrirCv(r.chemin_stockage).catch((e) => onErreur(e.message))}
          className="rounded-lg bg-principal px-4 py-2 text-sm font-medium text-white hover:bg-principal-fonce">
          Voir le CV
        </button>
        <button onClick={() => setFicheOuverte(!ficheOuverte)}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50">
          {ficheOuverte ? 'Masquer la fiche' : 'Voir la fiche'}
        </button>
        {r.liens.map((l) => (
          <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="rounded-full bg-blue-50 px-3 py-1 text-xs text-principal">
            {l.url.replace(/^https?:\/\//, '')}
          </a>
        ))}
      </div>
      {ficheOuverte && <div className="mt-4"><FicheIdentite fiche={r.fiche} profil={{ nom: r.nom, prenom: r.prenom, lieu_residence: r.lieu_residence }} /></div>}
    </article>
  )
}

export default function EspaceRecruteur() {
  const memoire = lireMemoire()
  const [messages, setMessages] = useState(memoire?.messages || [])       // la demande, puis les précisions
  const [echanges, setEchanges] = useState(memoire?.echanges || [])       // la conversation affichée
  const [resultat, setResultat] = useState(memoire?.resultat || null)
  const [saisie, setSaisie] = useState('')
  const [precision, setPrecision] = useState('')
  const [chargement, setChargement] = useState(false)
  const [erreur, setErreur] = useState('')

  // La recherche reste affichée si on recharge la page (pas si on ferme l'onglet)
  useEffect(() => {
    try { sessionStorage.setItem(CLE, JSON.stringify({ messages, echanges, resultat })) } catch { /* stockage indisponible */ }
  }, [messages, echanges, resultat])

  async function chercher(texte, nouvelle) {
    if (!texte.trim() || chargement) return
    const suite = nouvelle ? [texte.trim()] : [...messages, texte.trim()]
    setErreur(''); setChargement(true)
    try {
      const reponse = await appelerServeur('/rechercher', { messages: suite })
      setMessages(suite)
      setResultat(reponse)
      setEchanges([...(nouvelle ? [] : echanges), { role: 'recruteur', texte: texte.trim() }, { role: 'agent', texte: reponse.message }])
      setSaisie(''); setPrecision('')
    } catch (e) {
      setErreur(e.message)
    }
    setChargement(false)
  }

  function recommencer() {
    setMessages([]); setEchanges([]); setResultat(null); setSaisie(''); setPrecision(''); setErreur('')
  }

  return (
    <div>
      <h1 className="text-2xl font-bold">Trouver un candidat</h1>
      <p className="mt-1 text-slate-600">Décrivez le profil recherché, avec vos mots : métier, compétences, expérience, lieu, et tout autre critère.</p>

      {/* 1. La barre de recherche */}
      <form onSubmit={(e) => { e.preventDefault(); chercher(saisie, true) }} className="mt-6 flex flex-col gap-3 md:flex-row">
        <input value={saisie} onChange={(e) => setSaisie(e.target.value)} className={champ}
          placeholder="Décrivez le profil recherché…" />
        <button disabled={chargement || !saisie.trim()} className="shrink-0 rounded-lg bg-principal px-6 py-3 font-medium text-white hover:bg-principal-fonce disabled:opacity-50">
          {chargement && !resultat ? 'Recherche…' : 'Rechercher'}
        </button>
      </form>

      {erreur && <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{erreur}</p>}

      {resultat && (
        <>
          {/* 2. La conversation avec l'agent, et la case pour affiner */}
          <div className="mt-8 rounded-2xl border border-blue-100 bg-blue-50/50 p-4">
            <div className="space-y-2">
              {echanges.map((m, i) => (
                <p key={i} className={`text-sm ${m.role === 'agent' ? 'text-principal-fonce' : 'text-slate-700'}`}>
                  <span className="font-semibold">{m.role === 'agent' ? 'Agent : ' : 'Vous : '}</span>{m.texte}
                </p>
              ))}
            </div>
            <form onSubmit={(e) => { e.preventDefault(); chercher(precision, false) }} className="mt-3 flex gap-2">
              <input value={precision} onChange={(e) => setPrecision(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-principal focus:outline-none"
                placeholder="Affiner la recherche (ajouter, retirer ou changer un critère)…" />
              <button disabled={chargement || !precision.trim()} className="shrink-0 rounded-lg bg-principal px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                {chargement ? '…' : 'Affiner'}
              </button>
              <button type="button" onClick={recommencer} className="shrink-0 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm">
                Nouvelle recherche
              </button>
            </form>
          </div>

          {/* 3. Les résultats (avec un avertissement si l'IA n'a pas pu lire certains CV) */}
          {resultat.avertissement && (
            <p className="mt-6 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{resultat.avertissement}</p>
          )}
          <h2 className="mt-8 text-lg font-semibold">
            {resultat.resultats.length ? `${resultat.resultats.length} candidat(s) trouvé(s)` : 'Aucun candidat ne correspond à ces critères pour le moment.'}
          </h2>
          <div className="mt-4 space-y-4">
            {resultat.resultats.map((r) => (
              <CarteCandidat key={r.cv_id} r={r} nbCriteres={resultat.criteres.length} onErreur={setErreur} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
