// L'espace candidat, sur une seule page. Rien n'est enregistré tant que le candidat n'a pas publié.
//   1. il dépose son CV (PDF ou Word) : le texte est extrait ici, dans le navigateur (extraction.js)
//   2. le serveur IA prépare la fiche (/preparer-cv) : RIEN n'est enregistré, la fiche est seulement affichée
//   3. le candidat relit, corrige, puis clique sur « Publier mon CV » :
//        le fichier va dans le stockage privé, la ligne du CV est créée, puis le serveur (/publier-cv)
//        enregistre la fiche et les passages, supprime l'ancien CV et rend le nouveau visible des recruteurs
//   4. ensuite : « Modifier ma fiche » ou « Mettre à jour mon CV » (un nouveau dépôt remplace l'ancien à la publication)
import { useEffect, useState } from 'react'
import { appelerServeur, ouvrirCv, supabase } from '../supabase'
import { extraireTexte, TAILLE_MAX_MO, typeDuFichier } from '../extraction'

const champ = 'w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-principal focus:outline-none'

// Une durée en années → « 4 mois », « 1 an », « 3 ans et 2 mois »
export function dureeLisible(annees) {
  const total = Math.round(Number(annees) * 12)
  const ans = Math.floor(total / 12), mois = total % 12
  const morceaux = []
  if (ans) morceaux.push(`${ans} an${ans > 1 ? 's' : ''}`)
  if (mois || !ans) morceaux.push(`${mois} mois`)
  return morceaux.join(' et ')
}

// La période d'une expérience ou d'une formation, en phrase claire
function periodeLisible(x) {
  if (x.periode) return x.periode                       // telle qu'écrite dans le CV
  if (x.debut && x.fin) return `${x.debut} – ${x.fin}`
  if (x.debut) return `Depuis ${x.debut} (date de fin non précisée dans le CV)`
  return 'Dates non mentionnées dans le CV'
}

function texteExperience(fiche) {
  if (fiche.annees_experience == null) {
    return "Durée d'expérience non calculée : les dates des expériences ne sont pas mentionnées dans le CV."
  }
  const sansDates = (fiche.experiences || []).some((x) => !x.debut)
  return `${dureeLisible(fiche.annees_experience)} d'expérience, calculés à partir des dates du CV.`
    + (sansDates ? ' Les expériences sans dates ne sont pas comptées.' : '')
}

function Bloc({ titre, children }) {
  return (
    <section className="mt-6">
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">{titre}</h3>
      {children}
    </section>
  )
}

function Depot({ onFichier, erreur }) {
  return (
    <div className="rounded-2xl border-2 border-dashed border-slate-300 bg-white p-10 text-center">
      <p className="text-lg font-medium">Déposez votre CV</p>
      <p className="mt-1 text-sm text-slate-500">PDF ou Word (.docx), {TAILLE_MAX_MO} Mo maximum</p>
      <label className="mt-6 inline-block cursor-pointer rounded-lg bg-principal px-5 py-2.5 font-medium text-white hover:bg-principal-fonce">
        Choisir un fichier
        <input type="file" accept=".pdf,.docx" className="hidden" onChange={(e) => { e.target.files[0] && onFichier(e.target.files[0]); e.target.value = '' }} />
      </label>
      {erreur && <p className="mx-auto mt-4 max-w-md rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{erreur}</p>}
    </div>
  )
}

// La fiche : modifiable (aperçu avant publication, ou modification) ou en lecture
function Fiche({ fiche, modifiable, modifs, setModifs }) {
  const changer = (cle) => (e) => setModifs({ ...modifs, [cle]: e.target.value })
  const valeur = (cle) => (modifiable ? modifs[cle] : fiche[cle]) || ''
  return (
    <>
      <div className="mt-6 grid gap-3 md:grid-cols-2">
        {[['prenom', 'Prénom'], ['nom', 'Nom'], ['titre', 'Métier'], ['localisation', 'Localisation'], ['telephone', 'Téléphone'], ['email', 'E-mail']].map(([cle, label]) => (
          <label key={cle} className="text-sm text-slate-600">{label}
            {modifiable
              ? <input value={valeur(cle)} onChange={changer(cle)} className={`${champ} mt-1 text-slate-900`} />
              : <p className="mt-1 text-base text-slate-900">{valeur(cle) || 'Non mentionné dans le CV'}</p>}
          </label>
        ))}
      </div>
      <Bloc titre="Résumé">
        {modifiable
          ? <textarea rows={4} value={valeur('resume')} onChange={changer('resume')} className={champ} />
          : <p className="text-slate-800">{fiche.resume}</p>}
      </Bloc>
      <Bloc titre="Compétences">
        {modifiable
          ? <input value={modifs.competences_texte ?? (fiche.competences || []).join(', ')} onChange={changer('competences_texte')} className={champ} />
          : <div className="flex flex-wrap gap-2">{(fiche.competences || []).map((c) => <span key={c} className="rounded-full bg-slate-100 px-3 py-1 text-sm">{c}</span>)}</div>}
      </Bloc>

      <Bloc titre="Expérience">
        <p className="mb-2 text-slate-700">{texteExperience(fiche)}</p>
        <ul className="space-y-2">
          {(fiche.experiences || []).map((x, i) => (
            <li key={i}><span className="font-medium">{x.poste}</span>{x.entreprise && ` · ${x.entreprise}`}
              <span className="text-slate-500"> · {periodeLisible(x)}</span></li>
          ))}
        </ul>
      </Bloc>
      {(fiche.formations || []).length > 0 && (
        <Bloc titre="Formation">
          <ul className="space-y-1">{fiche.formations.map((f, i) => (
            <li key={i}>{f.diplome}{f.ecole && ` · ${f.ecole}`}<span className="text-slate-500"> · {periodeLisible(f)}</span></li>
          ))}</ul>
        </Bloc>
      )}
      {(fiche.certifications || []).length > 0 && (
        <Bloc titre="Certifications"><ul className="space-y-1">{fiche.certifications.map((c) => <li key={c}>{c}</li>)}</ul></Bloc>
      )}
      {(fiche.projets || []).length > 0 && (
        <Bloc titre="Projets">
          <ul className="space-y-1">{fiche.projets.map((p, i) => (
            <li key={i}><span className="font-medium">{p.nom}</span>{p.description && ` : ${p.description}`}
              {p.lien && <span className="text-principal"> · {p.lien.replace(/^https?:\/\//, '')}</span>}</li>
          ))}</ul>
        </Bloc>
      )}
      {(fiche.liens || []).length > 0 && (
        <Bloc titre="Liens">
          <div className="flex flex-wrap gap-2">{fiche.liens.map((l) => (
            <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="rounded-full bg-blue-50 px-3 py-1 text-sm text-principal">{l.url.replace(/^https?:\/\//, '')}</a>
          ))}</div>
        </Bloc>
      )}
      {(fiche.langues || []).length > 0 && <Bloc titre="Langues"><p>{fiche.langues.join(' · ')}</p></Bloc>}
      {(fiche.autres_infos || []).length > 0 && <Bloc titre="Autres informations"><p>{fiche.autres_infos.join(' · ')}</p></Bloc>}
    </>
  )
}

export default function EspaceCandidat({ profil }) {
  const [etat, setEtat] = useState('chargement')   // chargement | depot | preparation | apercu | publication | publiee
  const [cv, setCv] = useState(null)               // le CV publié (s'il existe)
  const [fichier, setFichier] = useState(null)     // le nouveau fichier déposé, pas encore publié
  const [texte, setTexte] = useState('')           // son texte extrait
  const [fiche, setFiche] = useState(null)
  const [fichePubliee, setFichePubliee] = useState(null)   // la fiche du CV publié, gardée si on annule
  const [modifs, setModifs] = useState({})
  const [modification, setModification] = useState(false)   // modifier une fiche déjà publiée
  const [erreur, setErreur] = useState('')
  const [message, setMessage] = useState('')

  // Au chargement : le CV publié du candidat et sa fiche, s'il en a un
  useEffect(() => {
    async function charger() {
      const { data: actif } = await supabase.from('cvs').select('*').eq('candidat_id', profil.id).eq('actif', true).maybeSingle()
      if (actif) {
        const { data } = await supabase.from('fiches_cv').select('*').eq('cv_id', actif.id).maybeSingle()
        if (data) { setCv(actif); setFiche(data); setFichePubliee(data); return setEtat('publiee') }
      }
      setEtat('depot')
    }
    charger()
  }, [profil.id])

  // 1 et 2. Déposer : extraire le texte, puis l'IA prépare la fiche (rien n'est enregistré)
  async function deposer(nouveau) {
    setErreur(''); setMessage('')
    const type = typeDuFichier(nouveau)
    if (!type) return setErreur('Format non accepté : déposez un PDF ou un fichier Word (.docx).')
    if (nouveau.size > TAILLE_MAX_MO * 1024 * 1024) return setErreur(`Fichier trop lourd : ${TAILLE_MAX_MO} Mo maximum.`)
    setEtat('preparation')
    try {
      const extrait = await extraireTexte(nouveau)
      if (extrait.length < 50) throw new Error("Nous n'avons pas pu lire de texte dans ce fichier. S'il s'agit d'un scan (une image), déposez un PDF texte ou un Word.")
      const { fiche: preparee } = await appelerServeur('/preparer-cv', { texte: extrait })
      setFichier(nouveau); setTexte(extrait)
      setFiche(preparee); setModifs(preparee); setEtat('apercu')
    } catch (e) {
      setErreur(e.message); setEtat('depot')
    }
  }

  // La fiche relue par le candidat, avec ses corrections
  function ficheRelue() {
    const relue = { ...fiche, ...modifs }
    relue.competences = String(modifs.competences_texte ?? (fiche.competences || []).join(', '))
      .split(',').map((c) => c.trim()).filter(Boolean)
    delete relue.competences_texte
    return relue
  }

  // 3. Publier : le fichier, la ligne du CV, puis le serveur enregistre tout et supprime l'ancien CV
  async function publier() {
    setErreur(''); setMessage(''); setEtat('publication')
    try {
      const nomPropre = fichier.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '_')
      const chemin = `${profil.id}/${Date.now()}_${nomPropre}`
      const envoi = await supabase.storage.from('cvs').upload(chemin, fichier, { contentType: fichier.type || undefined })
      if (envoi.error) throw new Error("L'envoi du fichier a échoué.")
      const { data: nouveau, error } = await supabase.from('cvs').insert({
        candidat_id: profil.id, nom_fichier: fichier.name, type_fichier: typeDuFichier(fichier), taille: fichier.size,
        chemin_stockage: chemin, texte_complet: texte, actif: false,
      }).select().single()
      if (error) { await supabase.storage.from('cvs').remove([chemin]); throw new Error("L'enregistrement du CV a échoué.") }
      const { fiche: publiee } = await appelerServeur('/publier-cv', { cv_id: nouveau.id, fiche: ficheRelue() })
      setCv({ ...nouveau, actif: true }); setFiche(publiee); setFichePubliee(publiee); setFichier(null); setTexte('')
      setEtat('publiee'); setMessage('Votre CV est publié : les recruteurs peuvent maintenant vous trouver.')
    } catch (e) {
      setErreur(e.message); setEtat('apercu')
    }
  }

  // 4. Modifier une fiche déjà publiée (le CV ne change pas)
  async function enregistrerModifications() {
    setErreur(''); setMessage('')
    try {
      const { fiche: publiee } = await appelerServeur('/publier-cv', { cv_id: cv.id, fiche: ficheRelue() })
      setFiche(publiee); setFichePubliee(publiee); setModification(false); setMessage('Vos modifications sont enregistrées.')
    } catch (e) {
      setErreur(e.message)
    }
  }

  if (etat === 'chargement') return <p className="py-24 text-center text-slate-500">Chargement…</p>
  if (etat === 'preparation' || etat === 'publication') {
    return (
      <div className="rounded-2xl bg-white p-12 text-center shadow-sm">
        <p className="text-lg font-medium">{etat === 'preparation' ? 'Lecture de votre CV…' : 'Publication de votre CV…'}</p>
        <p className="mt-2 text-slate-500">{etat === 'preparation' ? "L'IA prépare votre fiche (quelques secondes)." : 'Enregistrement de votre fiche.'}</p>
      </div>
    )
  }
  if (etat === 'depot') {
    return (
      <div>
        <h1 className="mb-6 text-2xl font-bold">Bonjour {profil.prenom} 👋</h1>
        <Depot onFichier={deposer} erreur={erreur} />
        {cv && <button onClick={() => { setErreur(''); setEtat('publiee') }} className="mt-4 text-sm text-principal underline">Revenir à mon CV publié</button>}
      </div>
    )
  }

  const enApercu = etat === 'apercu'
  const modifiable = enApercu || modification
  return (
    <div className="rounded-2xl bg-white p-6 shadow-sm md:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{enApercu ? 'Voici ce que nous avons compris de votre CV' : 'Mon CV publié'}</h1>
          <p className="mt-1 text-slate-500">
            {enApercu
              ? "Rien n'est encore enregistré. Relisez, corrigez si besoin, puis publiez : c'est cette fiche que verront les recruteurs."
              : 'Voici la fiche que voient les recruteurs.'}
          </p>
        </div>
        {!enApercu && <span className="rounded-full bg-green-100 px-3 py-1 text-sm font-medium text-green-800">✓ Publié</span>}
      </div>

      <Fiche fiche={fiche} modifiable={modifiable} modifs={modifs} setModifs={setModifs} />

      {erreur && <p className="mt-6 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{erreur}</p>}
      {message && <p className="mt-6 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{message}</p>}

      <div className="mt-8 flex flex-wrap gap-3">
        {enApercu && <>
          <button onClick={publier} className="rounded-lg bg-principal px-5 py-2.5 font-medium text-white hover:bg-principal-fonce">Publier mon CV</button>
          <button onClick={() => { setErreur(''); setFichier(null); setFiche(fichePubliee); setEtat(cv ? 'publiee' : 'depot') }}
            className="rounded-lg border border-slate-300 px-5 py-2.5 hover:bg-slate-50">Annuler</button>
        </>}
        {!enApercu && !modification && <>
          <button onClick={() => { setModifs(fiche); setModification(true); setMessage('') }} className="rounded-lg bg-principal px-5 py-2.5 font-medium text-white hover:bg-principal-fonce">Modifier ma fiche</button>
          <button onClick={() => ouvrirCv(cv.chemin_stockage).catch((e) => setErreur(e.message))} className="rounded-lg border border-slate-300 px-5 py-2.5 hover:bg-slate-50">Voir mon CV</button>
          <button onClick={() => { setErreur(''); setMessage(''); setEtat('depot') }} className="rounded-lg border border-slate-300 px-5 py-2.5 hover:bg-slate-50">Mettre à jour mon CV</button>
        </>}
        {modification && <>
          <button onClick={enregistrerModifications} className="rounded-lg bg-principal px-5 py-2.5 font-medium text-white hover:bg-principal-fonce">Enregistrer les modifications</button>
          <button onClick={() => { setModification(false); setModifs(fiche) }} className="rounded-lg border border-slate-300 px-5 py-2.5 hover:bg-slate-50">Annuler</button>
        </>}
      </div>
    </div>
  )
}
