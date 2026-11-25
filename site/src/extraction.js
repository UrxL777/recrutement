// L'extraction du texte d'un CV, dans le navigateur : pdf.js pour les PDF, mammoth pour les Word (.docx)
// Le texte est ensuite nettoyé (puces, symboles, espaces en trop) : il ne reste que du texte simple.
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import mammoth from 'mammoth/mammoth.browser'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export const TAILLE_MAX_MO = 5

// « pdf », « docx », ou null si le format n'est pas accepté
export function typeDuFichier(fichier) {
  const extension = fichier.name.split('.').pop().toLowerCase()
  return ['pdf', 'docx'].includes(extension) ? extension : null
}

// Les morceaux de texte d'un PDF ne sont pas rangés dans l'ordre de lecture : on reconstruit les lignes
// d'après leur position sur la page (même hauteur = même ligne, de gauche à droite).
// Ainsi, un poste et ses dates alignées à droite restent sur la même ligne, comme à l'écran.
const TOLERANCE_LIGNE = 3     // écart de hauteur toléré pour deux morceaux de la même ligne
const ECART_COLONNE = 20      // au-delà, deux morceaux d'une ligne sont séparés par « | » (deux colonnes)

async function textePdf(contenu) {
  const document = await pdfjs.getDocument({ data: contenu }).promise
  const lignes = []
  for (let numero = 1; numero <= document.numPages; numero++) {
    const page = await document.getPage(numero)
    const { items } = await page.getTextContent()
    const morceaux = items
      .filter((item) => item.str && item.str.trim())
      .map((item) => ({ texte: item.str, x: item.transform[4], y: item.transform[5], largeur: item.width }))
    // Regrouper par hauteur (y), du haut vers le bas de la page
    const groupes = []
    for (const m of morceaux.sort((a, b) => b.y - a.y)) {
      const groupe = groupes.find((g) => Math.abs(g.y - m.y) <= TOLERANCE_LIGNE)
      if (groupe) groupe.morceaux.push(m)
      else groupes.push({ y: m.y, morceaux: [m] })
    }
    for (const groupe of groupes.sort((a, b) => b.y - a.y)) {
      let ligne = '', finPrecedente = null
      for (const m of groupe.morceaux.sort((a, b) => a.x - b.x)) {
        if (finPrecedente !== null) {
          const ecart = m.x - finPrecedente
          ligne += ecart > ECART_COLONNE ? ' | ' : (ligne.endsWith(' ') || m.texte.startsWith(' ') || ecart < 1 ? '' : ' ')
        }
        ligne += m.texte
        finPrecedente = m.x + m.largeur
      }
      lignes.push(ligne)
    }
  }
  return lignes.join('\n')
}

async function texteDocx(contenu) {
  const resultat = await mammoth.extractRawText({ arrayBuffer: contenu })
  return resultat.value
}

// Retire les puces et les symboles décoratifs, et les espaces en trop ; garde une information par ligne
export function nettoyerTexte(texte) {
  return texte
    .replace(/[•▪●■□◆◇○◦➢➤►▶✓✔☐☑★☆→⇒➔✦✧❖]/g, ' ')
    .split('\n')
    .map((ligne) => ligne.replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

export async function extraireTexte(fichier) {
  const type = typeDuFichier(fichier)
  const contenu = await fichier.arrayBuffer()
  const brut = type === 'pdf' ? await textePdf(contenu) : await texteDocx(contenu)
  return nettoyerTexte(brut)
}
