// La connexion à Supabase (clé publique) et l'appel au serveur IA (Python)
import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
)

const API_URL = import.meta.env.VITE_API_URL

// Appelle une route du serveur IA, avec le jeton de l'utilisateur connecté (le serveur vérifie qui appelle)
export async function appelerServeur(route, corps) {
  const { data: { session } } = await supabase.auth.getSession()
  let reponse
  try {
    reponse = await fetch(`${API_URL}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify(corps),
    })
  } catch {
    throw new Error('Le serveur IA ne répond pas. Est-il bien lancé ?')
  }
  const donnees = await reponse.json().catch(() => ({}))
  if (!reponse.ok) throw new Error(donnees.detail || 'Le serveur a rencontré une erreur.')
  return donnees
}

// Ouvre un CV du stockage privé avec un lien temporaire (valable 10 minutes)
export async function ouvrirCv(chemin) {
  const fenetre = window.open('', '_blank')   // ouverte tout de suite, sinon le navigateur la bloque
  const { data, error } = await supabase.storage.from('cvs').createSignedUrl(chemin, 600)
  if (error) { fenetre?.close(); throw new Error("Impossible d'ouvrir le CV.") }
  if (fenetre) fenetre.location = data.signedUrl
}
