// L'espace candidat, sur une seule page. Rien n'est enregistré tant que le candidat n'a pas publié.
//   1. la zone de dépôt reste toujours en haut : on peut déposer, ou redéposer, à tout moment
//   2. le texte est extrait ici, dans le navigateur (extraction.js), puis l'IA l'analyse (/preparer-cv) :
//      RIEN n'est enregistré, la fiche est seulement affichée sous la zone de dépôt
//   3. si le candidat est d'accord, il clique sur « Publier mon CV » :
//        le fichier va dans le stockage privé, la ligne du CV est créée, puis le serveur (/publier-cv)
//        enregistre la fiche et les passages, supprime l'ancien CV et rend le nouveau visible des recruteurs
//      s'il n'est pas d'accord, il redépose son CV (l'analyse recommence) ou il annule
//   4. une fois publié : « Voir mon CV » et « Mettre à jour mon CV » (redéposer)
import { useEffect, useRef, useState } from 'react'
import { appelerServeur, ouvrirCv, supabase } from '../supabase'
import { extraireTexte, TAILLE_MAX_MO, typeDuFichier } from '../extraction'

const bouton = 'rounded-lg bg-principal px-5 py-2.5 font-medium text-white hover:bg-principal-fonce'
const boutonClair = 'rounded-lg border border-slate-300 px-5 py-2.5 hover:bg-slate-50'

// Une durée en années → « 4 mois », « 1 an », « 3 ans et 2 mois »
export function dureeLisible(annees) {
  const total = Math.round(Number(annees) * 12)
  const ans = Math.floor(total / 12), mois = total % 12
  const morceaux = []
  if (ans) morceaux.push(`${ans} an${ans > 1 ? 's' : ''}`)
  if (mois || !ans) morceaux.push(`${mois} mois`)
  return morceaux.join(' et ')
}

// L'âge : calculé à partir de la date de naissance, sinon l'âge écrit dans le CV
export function ageDe(fiche) {
  if (fiche.date_naissance) {
    const naissance = new Date(fiche.date_naissance), jour = new Date()
    let age = jour.getFullYear() - naissance.getFullYear()
    if (jour < new Date(jour.getFullYear(), naissance.getMonth(), naissance.getDate())) age -= 1
    return age
  }
  return fiche.age ?? null
}

// « Conseiller Clientèle chez Prudential Belife (4 mois) »
function texteExperience(x) {
  let texte = x.poste + (x.entreprise ? ` chez ${x.entreprise}` : '')
  if (x.duree != null) texte += ` (${dureeLisible(x.duree)})`
  else if (x.periode) texte += ` (${x.periode})`
  return texte
}

function Ligne({ titre, children }) {
  return (
    <p className="py-1.5">
      <span className="font-semibold">{titre} : </span>
      <span className="text-slate-700">{children}</span>
    </p>
  )
}

// La carte du CV : une ligne par rubrique, seulement celles qui sont dans le CV
function CarteCv({ fiche, profil }) {
  const age = ageDe(fiche)
  const entete = [fiche.titre, fiche.localisation || profil.lieu_residence, age != null && `${age} ans`].filter(Boolean)
  const contact = [fiche.telephone, fiche.email].filter(Boolean)
  const experiences = fiche.experiences || []
  return (
    <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-xl font-bold">{profil.prenom} {profil.nom}</h2>
      {entete.length > 0 && <p className="text-slate-600">{entete.join(', ')}</p>}
      <div className="mt-4 divide-y divide-slate-100">
        {fiche.resume && <Ligne titre="Résumé">{fiche.resume}</Ligne>}
        {contact.length > 0 && <Ligne titre="Contact">{contact.join(', ')}</Ligne>}
        {(fiche.liens || []).length > 0 && (
          <Ligne titre="Liens">
            {fiche.liens.map((l, i) => (
              <span key={l.url}>{i > 0 && ', '}
                <a href={l.url} target="_blank" rel="noreferrer" className="text-principal underline">{l.url.replace(/^https?:\/\//, '')}</a>
              </span>
            ))}
          </Ligne>
        )}
        {experiences.length > 0 && <Ligne titre="Expériences">{experiences.map(texteExperience).join(', ')}</Ligne>}
        {(fiche.rubriques || []).map((r) => <Ligne key={r.titre} titre={r.titre}>{r.contenu}</Ligne>)}
      </div>
    </div>
  )
}

// La zone de dépôt : un clic ou un glisser-déposer
function Depot({ onFichier, dejaUnCv, occupe, champFichier }) {
  const [survol, setSurvol] = useState(false)
  return (
    <label
      onDragOver={(e) => { e.preventDefault(); setSurvol(true) }}
      onDragLeave={() => setSurvol(false)}
      onDrop={(e) => { e.preventDefault(); setSurvol(false); if (!occupe && e.dataTransfer.files[0]) onFichier(e.dataTransfer.files[0]) }}
      className={`block rounded-2xl border-2 border-dashed p-8 text-center transition ${occupe ? 'cursor-wait opacity-60' : 'cursor-pointer hover:border-principal'} ${survol ? 'border-principal bg-blue-50' : 'border-slate-300 bg-white'}`}>
      <p className="text-lg font-medium">{dejaUnCv ? 'Redéposer mon CV' : 'Déposez votre CV'}</p>
      <p className="mt-1 text-sm text-slate-500">
        {dejaUnCv ? 'Cliquez ici ou glissez un nouveau fichier : il sera analysé à nouveau.' : 'Cliquez ici ou glissez votre fichier.'}
        {` PDF ou Word (.docx), ${TAILLE_MAX_MO} Mo maximum.`}
      </p>
      <input ref={champFichier} type="file" accept=".pdf,.docx" className="hidden" disabled={occupe}
        onChange={(e) => { if (e.target.files[0]) onFichier(e.target.files[0]); e.target.value = '' }} />
    </label>
  )
}

export default function EspaceCandidat({ profil }) {
  const [chargement, setChargement] = useState(true)
  const [cv, setCv] = useState(null)                  // le CV publié (s'il existe)
  const [fichePubliee, setFichePubliee] = useState(null)
  const [apercu, setApercu] = useState(null)          // la fiche du CV déposé, pas encore publiée
  const [fichier, setFichier] = useState(null)        // le fichier déposé, pas encore publié
  const [texte, setTexte] = useState('')              // son texte extrait
  const [occupe, setOccupe] = useState('')            // '' | 'lecture' | 'publication'
  const [erreur, setErreur] = useState('')
  const [message, setMessage] = useState('')
  const champFichier = useRef(null)

  // Au chargement : le CV publié du candidat et sa fiche, s'il en a un
  useEffect(() => {
    async function charger() {
      const { data: actif } = await supabase.from('cvs').select('*').eq('candidat_id', profil.id).eq('actif', true).maybeSingle()
      if (actif) {
        const { data } = await supabase.from('fiches_cv').select('*').eq('cv_id', actif.id).maybeSingle()
        if (data) { setCv(actif); setFichePubliee(data) }
      }
      setChargement(false)
    }
    charger()
  }, [profil.id])

  // Déposer : extraire le texte, puis l'IA analyse le CV (rien n'est enregistré)
  async function deposer(nouveau) {
    setErreur(''); setMessage('')
    if (!typeDuFichier(nouveau)) return setErreur('Format non accepté : déposez un PDF ou un fichier Word (.docx).')
    if (nouveau.size > TAILLE_MAX_MO * 1024 * 1024) return setErreur(`Fichier trop lourd : ${TAILLE_MAX_MO} Mo maximum.`)
    setOccupe('lecture')
    try {
      const extrait = await extraireTexte(nouveau)
      if (extrait.length < 50) throw new Error("Nous n'avons pas pu lire de texte dans ce fichier. S'il s'agit d'un scan (une image), déposez un PDF texte ou un Word.")
      const { fiche } = await appelerServeur('/preparer-cv', { texte: extrait })
      setFichier(nouveau); setTexte(extrait); setApercu(fiche)
    } catch (e) {
      setErreur(e.message)
    }
    setOccupe('')
  }

  // Publier : le fichier, la ligne du CV, puis le serveur enregistre tout et supprime l'ancien CV
  async function publier() {
    setErreur(''); setMessage(''); setOccupe('publication')
    try {
      const nomPropre = fichier.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '_')
      const chemin = `${profil.id}/${Date.now()}_${nomPropre}`
      const envoi = await supabase.storage.from('cvs').upload(chemin, fichier, { contentType: fichier.type || undefined })
      if (envoi.error) throw new Error(`L'envoi du fichier a échoué : ${envoi.error.message}`)
      const { data: nouveau, error } = await supabase.from('cvs').insert({
        candidat_id: profil.id, nom_fichier: fichier.name, type_fichier: typeDuFichier(fichier), taille: fichier.size,
        chemin_stockage: chemin, texte_complet: texte, actif: false,
      }).select().single()
      if (error) { await supabase.storage.from('cvs').remove([chemin]); throw new Error(`L'enregistrement du CV a échoué : ${error.message}`) }
      const { fiche } = await appelerServeur('/publier-cv', { cv_id: nouveau.id, fiche: apercu })
      setCv({ ...nouveau, actif: true }); setFichePubliee(fiche)
      setApercu(null); setFichier(null); setTexte('')
      setMessage('Votre CV est publié : les recruteurs peuvent maintenant vous trouver.')
    } catch (e) {
      setErreur(e.message)
    }
    setOccupe('')
  }

  function annuler() {
    setApercu(null); setFichier(null); setTexte(''); setErreur(''); setMessage('')
  }

  if (chargement) return <p className="py-24 text-center text-slate-500">Chargement…</p>

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Bonjour {profil.prenom}</h1>

      {/* 1. La zone de dépôt, toujours visible */}
      <Depot onFichier={deposer} dejaUnCv={Boolean(cv || apercu)} occupe={Boolean(occupe)} champFichier={champFichier} />

      {occupe && (
        <p className="mt-6 rounded-lg bg-blue-50 px-4 py-3 text-principal-fonce">
          {occupe === 'lecture' ? "Lecture de votre CV : l'IA l'analyse (quelques secondes)…" : 'Publication de votre CV…'}
        </p>
      )}
      {erreur && <p className="mt-6 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{erreur}</p>}
      {message && <p className="mt-6 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-700">{message}</p>}

      {/* 2. Le CV déposé, pas encore publié */}
      {apercu && !occupe && (
        <section className="mt-8">
          <h2 className="text-lg font-semibold">Voici ce que nous avons compris de votre CV</h2>
          <p className="text-sm text-slate-500">
            Rien n'est encore enregistré. Si c'est juste, publiez-le. Sinon, redéposez votre CV : il sera analysé à nouveau.
          </p>
          <CarteCv fiche={apercu} profil={profil} />
          <div className="mt-6 flex flex-wrap gap-3">
            <button onClick={publier} className={bouton}>Publier mon CV</button>
            <button onClick={annuler} className={boutonClair}>Annuler</button>
          </div>
        </section>
      )}

      {/* 3. Le CV publié */}
      {!apercu && cv && fichePubliee && !occupe && (
        <section className="mt-8">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-lg font-semibold">Mon CV publié</h2>
            <span className="rounded-full bg-green-100 px-3 py-1 text-sm font-medium text-green-800">Publié</span>
          </div>
          <p className="text-sm text-slate-500">Les recruteurs vous trouvent grâce à tout le contenu de votre CV.</p>
          <CarteCv fiche={fichePubliee} profil={profil} />
          <div className="mt-6 flex flex-wrap gap-3">
            <button onClick={() => ouvrirCv(cv.chemin_stockage).catch((e) => setErreur(e.message))} className={bouton}>Voir mon CV</button>
            <button onClick={() => champFichier.current?.click()} className={boutonClair}>Mettre à jour mon CV</button>
          </div>
        </section>
      )}
    </div>
  )
}
