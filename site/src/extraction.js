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

// Le texte brut du PDF, dans l'ordre où il est rangé dans le fichier (colonne par colonne) : on ne refait pas la mise en page.
// Un seul correctif : un court élément écrit à droite d'une ligne (une date, un outil) est souvent rangé ailleurs
// dans le fichier ; on le recolle au bout de sa ligne, sinon on ne saurait plus à quel poste appartient une date.
const LONGUEUR_COURTE = 40    // un élément « court » : une date, un outil
const TOLERANCE_HAUTEUR = 3   // même hauteur sur la page = même ligne

function lignesDeLaPage(items) {
  const lignes = []
  let courante = null
  for (const item of items) {
    if (!courante) courante = { texte: '', x: item.transform[4], y: item.transform[5], fin: 0 }
    courante.texte += item.str
    courante.fin = Math.max(courante.fin, item.transform[4] + item.width)
    if (item.hasEOL) { lignes.push(courante); courante = null }
  }
  if (courante) lignes.push(courante)
  return lignes.filter((l) => l.texte.trim())
}

const aDuTexte = (l) => /[\p{L}\p{N}]/u.test(l.texte)
const estUnTitre = (l) => /\p{L}{2}/u.test(l.texte) && l.texte === l.texte.toUpperCase()   // « FORMATION », « PROJETS »

function recollerLesElementsCourts(lignes) {
  lignes.forEach((l, i) => { l.rang = i })
  for (const courte of lignes) {
    if (courte.texte.trim().length > LONGUEUR_COURTE || !aDuTexte(courte) || estUnTitre(courte)) continue
    // Sa ligne : à la même hauteur, juste à sa gauche, et rangée APRÈS elle dans le fichier
    // (un élément rangé à sa place normale, dans l'ordre de lecture, n'est pas déplacé)
    const voisines = lignes.filter((l) => l !== courte && !l.recollee && aDuTexte(l) && l.rang > courte.rang
      && Math.abs(l.y - courte.y) <= TOLERANCE_HAUTEUR && l.fin <= courte.x + 2)
    if (!voisines.length) continue
    const voisine = voisines.reduce((a, b) => (b.fin > a.fin ? b : a))   // la plus proche à gauche
    voisine.texte += ` — ${courte.texte.trim()}`
    courte.recollee = true
  }
  return lignes.filter((l) => !l.recollee).map((l) => l.texte)
}

async function textePdf(contenu) {
  const document = await pdfjs.getDocument({ data: contenu }).promise
  const lignes = []
  const liensCaches = []
  for (let numero = 1; numero <= document.numPages; numero++) {
    const page = await document.getPage(numero)
    const { items } = await page.getTextContent()
    lignes.push(...recollerLesElementsCourts(lignesDeLaPage(items)))
    // Les liens cliquables cachés derrière un mot (ex. « GitHub ») : on ajoute leur adresse au texte
    for (const annotation of await page.getAnnotations()) {
      const url = annotation.url || annotation.unsafeUrl
      if (url && /^https?:/i.test(url) && !liensCaches.includes(url)) liensCaches.push(url)
    }
  }
  if (liensCaches.length) lignes.push(`Liens : ${liensCaches.join(' ')}`)
  return lignes.join('\n')
}

async function texteDocx(contenu) {
  const resultat = await mammoth.extractRawText({ arrayBuffer: contenu.slice(0) })
  // Les liens cliquables cachés derrière un mot : on ajoute leur adresse au texte
  const html = (await mammoth.convertToHtml({ arrayBuffer: contenu })).value
  const liens = [...new Set([...html.matchAll(/href="(https?:[^"]+)"/gi)].map((m) => m[1]))]
  return resultat.value + (liens.length ? `\nLiens : ${liens.join(' ')}` : '')
}

// Retire les puces, les emojis et les symboles décoratifs, et les espaces en trop ; garde une information par ligne
export function nettoyerTexte(texte) {
  return texte
    .replace(/[•▪●■□◆◇○◦‣▸▹➢➤►▶✓✔☐☑★☆→⇒➔✦✧❖]/g, ' ')
    .replace(/\p{Extended_Pictographic}\uFE0F?/gu, ' ')     // les emojis (📍 📞 ✉️…)
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
