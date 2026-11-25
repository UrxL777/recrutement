// L'espace candidat, sur une seule page :
//   1. déposer son CV (PDF ou Word) : le texte est extrait ici, dans le navigateur (extraction.js)
//   2. le fichier va dans le stockage privé, le CV dans la table cvs, puis le serveur IA l'analyse
//   3. la fiche s'affiche : le candidat la relit, la corrige si besoin, et la valide
//   4. « Mettre à jour mon CV » : un nouveau CV devient actif, l'ancien reste dans l'historique
import { useEffect, useState } from 'react'
import { appelerServeur, ouvrirCv, supabase } from '../supabase'
import { extraireTexte, TAILLE_MAX_MO, typeDuFichier } from '../extraction'

const champ = 'w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-principal focus:outline-none'
const CHAMPS_MODIFIABLES = ['prenom', 'nom', 'titre', 'localisation', 'telephone', 'email', 'resume']

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
        <input type="file" accept=".pdf,.docx" className="hidden" onChange={(e) => e.target.files[0] && onFichier(e.target.files[0])} />
      </label>
      {erreur && <p className="mx-auto mt-4 max-w-md rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{erreur}</p>}
    </div>
  )
}

export default function EspaceCandidat({ profil }) {
  const [etat, setEtat] = useState('chargement')   // chargement | depot | analyse | fiche
  const [cv, setCv] = useState(null)
  const [fiche, setFiche] = useState(null)
  const [modifs, setModifs] = useState({})
  const [erreur, setErreur] = useState('')
  const [message, setMessage] = useState('')

  // Au chargement : le CV actif du candidat et sa fiche, s'il en a déjà un
  useEffect(() => {
    async function charger() {
      const { data: actif } = await supabase.from('cvs').select('*').eq('candidat_id', profil.id).eq('actif', true).maybeSingle()
      if (!actif) return setEtat('depot')
      setCv(actif)
      if (actif.statut === 'analyse') {
        const { data } = await supabase.from('fiches_cv').select('*').eq('cv_id', actif.id).maybeSingle()
        if (data) { setFiche(data); setModifs(data); return setEtat('fiche') }
      }
      if (actif.statut === 'erreur') setErreur(`L'analyse de votre CV a échoué : ${actif.erreur || 'erreur inconnue'}. Déposez-le à nouveau.`)
      setEtat('depot')
    }
    charger()
  }, [profil.id])

  async function deposer(fichier) {
    setErreur(''); setMessage('')
    const type = typeDuFichier(fichier)
    if (!type) return setErreur('Format non accepté : déposez un PDF ou un fichier Word (.docx).')
    if (fichier.size > TAILLE_MAX_MO * 1024 * 1024) return setErreur(`Fichier trop lourd : ${TAILLE_MAX_MO} Mo maximum.`)
    setEtat('analyse')
    try {
      // 1. Extraire le texte, ici, dans le navigateur
      const texte = await extraireTexte(fichier)
      if (texte.length < 50) throw new Error("Nous n'avons pas pu lire de texte dans ce fichier. S'il s'agit d'un scan (une image), déposez un PDF texte ou un Word.")

      // 2. Ranger le fichier dans le stockage privé (dans le dossier du candidat)
      const nomPropre = fichier.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '_')
      const chemin = `${profil.id}/${Date.now()}_${nomPropre}`
      const envoi = await supabase.storage.from('cvs').upload(chemin, fichier, { contentType: fichier.type || undefined })
      if (envoi.error) throw new Error("L'envoi du fichier a échoué.")

      // 3. L'ancien CV n'est plus actif, le nouveau est enregistré avec son texte
      await supabase.from('cvs').update({ actif: false }).eq('candidat_id', profil.id).eq('actif', true)
      const { data: nouveau, error } = await supabase.from('cvs').insert({
        candidat_id: profil.id, nom_fichier: fichier.name, type_fichier: type, taille: fichier.size,
        chemin_stockage: chemin, texte_complet: texte,
      }).select().single()
      if (error) throw new Error("L'enregistrement du CV a échoué.")
      setCv(nouveau)

      // 4. Le serveur IA analyse le CV et rend la fiche
      const { fiche: analysee } = await appelerServeur('/analyser-cv', { cv_id: nouveau.id })
      const complete = { ...analysee, cv_id: nouveau.id, valide_par_candidat: false }
      setFiche(complete); setModifs(complete); setEtat('fiche')
    } catch (e) {
      setErreur(e.message); setEtat('depot')
    }
  }

  async function valider() {
    setErreur(''); setMessage('')
    const corrections = Object.fromEntries(CHAMPS_MODIFIABLES.map((c) => [c, modifs[c] || null]))
    corrections.competences = String(modifs.competences_texte ?? (fiche.competences || []).join(', '))
      .split(',').map((c) => c.trim()).filter(Boolean)
    const { error } = await supabase.from('fiches_cv').update({ ...corrections, valide_par_candidat: true }).eq('cv_id', fiche.cv_id)
    if (error) return setErreur("La validation a échoué. Réessayez.")
    const nouvelle = { ...fiche, ...corrections, valide_par_candidat: true }
    setFiche(nouvelle); setModifs(nouvelle)
    setMessage('Votre fiche est validée : les recruteurs verront « Fiche vérifiée par le candidat ».')
  }

  if (etat === 'chargement') return <p className="py-24 text-center text-slate-500">Chargement…</p>
  if (etat === 'analyse') {
    return (
      <div className="rounded-2xl bg-white p-12 text-center shadow-sm">
        <p className="text-lg font-medium">Analyse de votre CV en cours…</p>
        <p className="mt-2 text-slate-500">Lecture du fichier, puis l'IA prépare votre fiche (quelques secondes).</p>
      </div>
    )
  }
  if (etat === 'depot') {
    return (
      <div>
        <h1 className="mb-6 text-2xl font-bold">Bonjour {profil.prenom} 👋</h1>
        <Depot onFichier={deposer} erreur={erreur} />
        {fiche && <button onClick={() => setEtat('fiche')} className="mt-4 text-sm text-principal underline">Revenir à ma fiche</button>}
      </div>
    )
  }

  // La fiche : ce que l'IA a compris du CV, que le candidat relit et valide
  const changer = (cle) => (e) => setModifs({ ...modifs, [cle]: e.target.value })
  return (
    <div className="rounded-2xl bg-white p-6 shadow-sm md:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Voici ce que nous avons compris de votre CV</h1>
          <p className="mt-1 text-slate-500">Relisez, corrigez si besoin, puis validez. C'est ce résumé que verront les recruteurs.</p>
        </div>
        {fiche.valide_par_candidat && <span className="rounded-full bg-green-100 px-3 py-1 text-sm font-medium text-green-800">✓ Fiche validée</span>}
      </div>

      <div className="mt-6 grid gap-3 md:grid-cols-2">
        {[['prenom', 'Prénom'], ['nom', 'Nom'], ['titre', 'Métier'], ['localisation', 'Localisation'], ['telephone', 'Téléphone'], ['email', 'E-mail']].map(([cle, label]) => (
          <label key={cle} className="text-sm text-slate-600">{label}
            <input value={modifs[cle] || ''} onChange={changer(cle)} className={`${champ} mt-1 text-slate-900`} />
          </label>
        ))}
      </div>
      <label className="mt-3 block text-sm text-slate-600">Résumé
        <textarea rows={4} value={modifs.resume || ''} onChange={changer('resume')} className={`${champ} mt-1 text-slate-900`} />
      </label>
      <label className="mt-3 block text-sm text-slate-600">Compétences (séparées par des virgules)
        <input value={modifs.competences_texte ?? (fiche.competences || []).join(', ')} onChange={changer('competences_texte')} className={`${champ} mt-1 text-slate-900`} />
      </label>

      <Bloc titre="Expérience">
        <p className="mb-2 text-slate-700">
          {fiche.annees_experience != null ? `${String(fiche.annees_experience).replace('.', ',')} an(s) d'expérience (calculés à partir des dates de votre CV)` : "Années d'expérience non calculées (dates absentes du CV)"}
        </p>
        <ul className="space-y-2">
          {(fiche.experiences || []).map((x, i) => (
            <li key={i}><span className="font-medium">{x.poste}</span>{x.entreprise && ` · ${x.entreprise}`}
              <span className="text-slate-500"> ({x.debut || '?'} → {x.fin || '?'})</span></li>
          ))}
        </ul>
      </Bloc>
      {(fiche.formations || []).length > 0 && (
        <Bloc titre="Formation">
          <ul className="space-y-1">{fiche.formations.map((f, i) => <li key={i}>{f.diplome}{f.ecole && ` · ${f.ecole}`}</li>)}</ul>
        </Bloc>
      )}
      {(fiche.projets || []).length > 0 && (
        <Bloc titre="Projets">
          <ul className="space-y-1">{fiche.projets.map((p, i) => (
            <li key={i}><span className="font-medium">{p.nom}</span>{p.description && ` : ${p.description}`}
              {p.lien && <> · <a href={p.lien} target="_blank" rel="noreferrer" className="text-principal underline">voir</a></>}</li>
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

      {erreur && <p className="mt-6 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{erreur}</p>}
      {message && <p className="mt-6 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{message}</p>}

      <div className="mt-8 flex flex-wrap gap-3">
        <button onClick={valider} className="rounded-lg bg-principal px-5 py-2.5 font-medium text-white hover:bg-principal-fonce">✓ Valider ma fiche</button>
        {cv && <button onClick={() => ouvrirCv(cv.chemin_stockage).catch((e) => setErreur(e.message))} className="rounded-lg border border-slate-300 px-5 py-2.5 hover:bg-slate-50">Voir mon CV</button>}
        <button onClick={() => { setErreur(''); setMessage(''); setEtat('depot') }} className="rounded-lg border border-slate-300 px-5 py-2.5 hover:bg-slate-50">Mettre à jour mon CV</button>
      </div>
    </div>
  )
}
