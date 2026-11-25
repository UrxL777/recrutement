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

async function textePdf(contenu) {
  const document = await pdfjs.getDocument({ data: contenu }).promise
  const lignes = []
  for (let numero = 1; numero <= document.numPages; numero++) {
    const page = await document.getPage(numero)
    const { items } = await page.getTextContent()
    let ligne = ''
    for (const item of items) {
      if (item.str) ligne += (ligne && !ligne.endsWith(' ') && !item.str.startsWith(' ') ? ' ' : '') + item.str
      if (item.hasEOL) { lignes.push(ligne); ligne = '' }
    }
    if (ligne) lignes.push(ligne)
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
