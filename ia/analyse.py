"""
RecrutSmart : l'analyse d'un CV, faite une seule fois, juste après le dépôt.

La démarche :
  1. le site a déjà extrait le texte du CV (JavaScript) et l'a rangé dans cvs.texte_complet
  2. l'IA lit le texte et remplit la fiche : identité, métier, résumé, expériences, compétences…
  3. Python vérifie ce qui doit être exact :
       - les liens, l'e-mail et le téléphone doivent être écrits dans le CV (sinon ils sont retirés)
       - les dates doivent apparaître dans le CV ; les années d'expérience sont CALCULÉES par Python
  4. le texte est découpé en passages, chacun avec son embedding (pour la recherche par le sens)
  5. tout est enregistré : fiches_cv, cv_morceaux, et le CV passe au statut « analyse »
"""
import re
from datetime import date, datetime, timezone

from fastembed import TextEmbedding

# Le modèle d'embeddings : il comprend le français et produit 384 nombres par passage
NOM_MODELE_EMBEDDINGS = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
_modele_embeddings = None

LONGUEUR_MIN_TEXTE = 50       # en dessous, le CV est considéré comme vide (PDF scanné, par exemple)
LONGUEUR_MAX_TEXTE = 15000    # au-delà, la fin du texte n'est pas envoyée à l'IA (limite de tokens)
TAILLE_PASSAGE = 500          # nombre de caractères visé pour chaque passage

PROMPT_FICHE = """Tu lis le texte d'un CV, extrait d'un fichier PDF ou Word. La mise en page est perdue : les colonnes peuvent être mélangées, et le signe « | » sépare deux textes placés côte à côte sur la même ligne (souvent deux colonnes, ou un intitulé et ses dates).
Remplis la fiche du candidat.

Règles :
- Recopie uniquement ce qui est écrit dans le CV. Si une information n'y est pas, mets null ou une liste vide. N'invente rien et ne devine rien.
- Garde les noms des entreprises, des écoles, des outils et des technologies comme ils sont écrits.
- "debut" et "fin" sont au format AAAA-MM, ou AAAA si le mois n'est pas écrit ; convertis les mois écrits en lettres. Pour un poste ou une formation en cours, "fin" vaut "aujourd'hui". Si la fin n'est pas écrite, "fin" vaut null.
- "periode" : la période recopiée telle qu'elle est écrite dans le CV, ou null si aucune date n'est écrite.
- "date_naissance" est au format AAAA-MM-JJ, seulement si elle est écrite dans le CV.
- "titre" : le métier principal du candidat.
- "resume" : deux ou trois phrases à la troisième personne qui présentent son métier, son expérience et ses points forts, uniquement à partir du CV.
- "autres_infos" : toutes les informations qui ne rentrent dans aucune autre case (loisirs, centres d'intérêt, qualités, situation familiale, permis, disponibilité, et tout le reste), chacune en une phrase courte, fidèle au CV.

Réponds uniquement en JSON :
{"nom": texte ou null, "prenom": texte ou null, "date_naissance": texte ou null, "email": texte ou null, "telephone": texte ou null,
 "localisation": texte ou null, "titre": texte ou null, "resume": texte,
 "experiences": [{"poste": texte, "entreprise": texte ou null, "debut": texte ou null, "fin": texte ou null, "periode": texte ou null, "missions": [texte]}],
 "formations": [{"diplome": texte, "ecole": texte ou null, "debut": texte ou null, "fin": texte ou null, "periode": texte ou null}],
 "competences": [texte], "langues": [texte], "certifications": [texte],
 "projets": [{"nom": texte, "description": texte ou null, "technologies": [texte], "lien": texte ou null}],
 "autres_infos": [texte]}"""


# ─── Les contrôles Python ─────────────────────────────────────────────────────

MOTIF_LIEN = re.compile(
    r"(?:https?://|www\.)[^\s,;()<>\"'|]+"
    r"|(?<![@\w.])(?:[\w-]+\.)+(?:com|net|org|io|dev|app|ci|fr|me|site|tech|info)(?:/[^\s,;()<>\"'|]*)?",
    re.IGNORECASE,
)
MOTIF_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
MOTIF_TELEPHONE = re.compile(r"\+?\d[\d\s.\-()]{6,}\d")


def _chiffres(texte: str) -> str:
    return re.sub(r"\D", "", texte or "")


def liens_du_cv(texte: str) -> list:
    """Les liens écrits dans le CV (trouvés par Python, jamais inventés), avec leur type."""
    liens, vus = [], set()
    for brut in MOTIF_LIEN.findall(texte):
        url = brut.rstrip(".,;:!?")
        cle = re.sub(r"^(https?://)?(www\.)?", "", url.lower()).rstrip("/")
        if cle in vus:
            continue
        vus.add(cle)
        if "github.com" in cle:
            type_lien = "github"
        elif "gitlab.com" in cle:
            type_lien = "gitlab"
        elif "linkedin.com" in cle:
            type_lien = "linkedin"
        else:
            type_lien = "site"
        liens.append({"type": type_lien, "url": url if url.lower().startswith("http") else "https://" + url})
    return liens


def email_du_cv(propose: str | None, texte: str) -> str | None:
    """L'e-mail de l'IA s'il est écrit dans le CV, sinon le premier e-mail trouvé par Python."""
    trouves = MOTIF_EMAIL.findall(texte)
    if propose and propose.lower() in texte.lower():
        return propose
    return trouves[0] if trouves else None


def telephone_du_cv(propose: str | None, texte: str) -> str | None:
    """Le téléphone de l'IA si ses chiffres sont dans le CV, sinon le premier numéro trouvé par Python."""
    chiffres_texte = _chiffres(texte)
    if propose and len(_chiffres(propose)) >= 8 and _chiffres(propose) in chiffres_texte:
        return propose.strip()
    for numero in MOTIF_TELEPHONE.findall(texte):
        if 8 <= len(_chiffres(numero)) <= 15:
            return numero.strip()
    return None


def _mois(valeur, texte: str, aujourd_hui: date) -> int | None:
    """« 2022-03 » ou « 2022 » → numéro de mois ; « aujourd'hui » → ce mois-ci. None si absent du CV."""
    if valeur is None:
        return None
    v = str(valeur).strip().lower()
    if v in ("aujourd'hui", "aujourd’hui", "present", "présent", "en cours", "actuel"):
        return aujourd_hui.year * 12 + aujourd_hui.month - 1
    m = re.match(r"^(\d{4})(?:-(\d{1,2}))?", v)
    if not m or m.group(1) not in texte:      # une année qui n'est pas dans le CV est refusée
        return None
    annee, mois = int(m.group(1)), int(m.group(2) or 1)
    if not (1950 <= annee <= aujourd_hui.year) or not (1 <= mois <= 12):
        return None
    return annee * 12 + mois - 1


def annees_experience(experiences: list, texte: str, aujourd_hui: date | None = None) -> float | None:
    """
    Calculées par Python à partir des dates des expériences.
    Les périodes qui se chevauchent ne sont comptées qu'une fois. None si aucune date n'est utilisable.
    """
    aujourd_hui = aujourd_hui or date.today()
    periodes = []
    for exp in experiences:
        debut = _mois(exp.get("debut"), texte, aujourd_hui)
        fin = _mois(exp.get("fin"), texte, aujourd_hui) if exp.get("fin") else debut
        if debut is not None and fin is not None and fin >= debut:
            periodes.append((debut, fin + 1))      # +1 : le mois de fin est compté
    if not periodes:
        return None
    periodes.sort()
    total, (debut_cours, fin_cours) = 0, periodes[0]
    for debut, fin in periodes[1:]:
        if debut <= fin_cours:                     # chevauchement : on prolonge la période en cours
            fin_cours = max(fin_cours, fin)
        else:
            total += fin_cours - debut_cours
            debut_cours, fin_cours = debut, fin
    total += fin_cours - debut_cours
    return round(total / 12, 1)


def date_naissance_du_cv(proposee: str | None, texte: str) -> str | None:
    """Gardée seulement si c'est une vraie date, écrite dans le CV, et plausible (16 à 80 ans)."""
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", str(proposee or "").strip())
    if not m or m.group(1) not in texte:
        return None
    try:
        naissance = date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None
    age = (date.today() - naissance).days / 365.25
    return naissance.isoformat() if 16 <= age <= 80 else None


def _liste_textes(valeur) -> list:
    """Une liste de textes propres, sans doublon (l'IA ne renvoie pas toujours exactement une liste)."""
    if not isinstance(valeur, list):
        return []
    propres, vus = [], set()
    for v in valeur:
        t = str(v).strip() if v is not None else ""
        if t and t.lower() not in vus:
            vus.add(t.lower())
            propres.append(t)
    return propres


def _texte(valeur) -> str | None:
    t = str(valeur).strip() if valeur is not None else ""
    return t or None


def _periode(valeur, texte: str) -> str | None:
    """La période telle qu'écrite dans le CV ; retirée si elle n'y est pas (l'IA l'aurait inventée)."""
    periode = _texte(valeur)
    return periode if periode and _normaliser_espaces(periode) in _normaliser_espaces(texte) else None


def _normaliser_espaces(t: str) -> str:
    return re.sub(r"\s+", " ", (t or "").lower()).replace("–", "-").replace("—", "-")


def controler_fiche(brute: dict, texte: str) -> dict:
    """Remet la fiche de l'IA en forme et vérifie ce qui doit être exact."""
    experiences = [
        {"poste": _texte(e.get("poste")), "entreprise": _texte(e.get("entreprise")),
         "debut": _texte(e.get("debut")), "fin": _texte(e.get("fin")),
         "periode": _periode(e.get("periode"), texte), "missions": _liste_textes(e.get("missions"))}
        for e in brute.get("experiences") or [] if isinstance(e, dict) and _texte(e.get("poste"))
    ]
    formations = [
        {"diplome": _texte(f.get("diplome")), "ecole": _texte(f.get("ecole")),
         "debut": _texte(f.get("debut")), "fin": _texte(f.get("fin")), "periode": _periode(f.get("periode"), texte)}
        for f in brute.get("formations") or [] if isinstance(f, dict) and _texte(f.get("diplome"))
    ]
    liens = liens_du_cv(texte)
    urls = {re.sub(r"^(https?://)?(www\.)?", "", l["url"].lower()).rstrip("/"): l["url"] for l in liens}
    projets = []
    for p in brute.get("projets") or []:
        if not isinstance(p, dict) or not _texte(p.get("nom")):
            continue
        lien = _texte(p.get("lien"))
        cle = re.sub(r"^(https?://)?(www\.)?", "", (lien or "").lower()).rstrip("/")
        projets.append({"nom": _texte(p.get("nom")), "description": _texte(p.get("description")),
                        "technologies": _liste_textes(p.get("technologies")),
                        "lien": urls.get(cle) if cle else None})   # un lien absent du CV est retiré
    return {
        "nom": _texte(brute.get("nom")),
        "prenom": _texte(brute.get("prenom")),
        "date_naissance": date_naissance_du_cv(brute.get("date_naissance"), texte),
        "email": email_du_cv(_texte(brute.get("email")), texte),
        "telephone": telephone_du_cv(_texte(brute.get("telephone")), texte),
        "localisation": _texte(brute.get("localisation")),
        "titre": _texte(brute.get("titre")),
        "resume": _texte(brute.get("resume")) or "",
        "experiences": experiences,
        "annees_experience": annees_experience(experiences, texte),
        "formations": formations,
        "competences": _liste_textes(brute.get("competences")),
        "langues": _liste_textes(brute.get("langues")),
        "certifications": _liste_textes(brute.get("certifications")),
        "projets": projets,
        "liens": liens,
        "autres_infos": _liste_textes(brute.get("autres_infos")),
    }


# ─── Les passages et leurs embeddings ─────────────────────────────────────────

def decouper_en_passages(texte: str) -> list:
    """
    Découpe le texte du CV en passages d'environ TAILLE_PASSAGE caractères, sans couper une ligne.
    Les passages gardent les mots exacts du CV : ils serviront de preuves dans la recherche.
    """
    lignes = [l.strip() for l in texte.splitlines() if l.strip()]
    passages, courant = [], []
    for ligne in lignes:
        if courant and sum(len(l) + 1 for l in courant) + len(ligne) > TAILLE_PASSAGE:
            passages.append("\n".join(courant))
            courant = []
        courant.append(ligne)
    if courant:
        passages.append("\n".join(courant))
    return passages


def calculer_embeddings(textes: list) -> list:
    """Le « sens » de chaque texte : une liste de 384 nombres (le modèle est chargé une seule fois)."""
    global _modele_embeddings
    if _modele_embeddings is None:
        _modele_embeddings = TextEmbedding(NOM_MODELE_EMBEDDINGS)
    return [[round(float(x), 6) for x in vecteur] for vecteur in _modele_embeddings.embed(textes)]


# ─── L'analyse complète ───────────────────────────────────────────────────────

def analyser_texte(texte: str, demander_ia) -> tuple:
    """Le texte d'un CV → (la fiche vérifiée, les passages avec leurs embeddings). N'écrit rien en base."""
    texte = texte.strip()
    if len(texte) < LONGUEUR_MIN_TEXTE:
        raise ValueError("Le texte du CV est vide ou presque : c'est peut-être un PDF scanné (une image).")
    brute = demander_ia([
        {"role": "system", "content": PROMPT_FICHE},
        {"role": "user", "content": texte[:LONGUEUR_MAX_TEXTE]},
    ])
    fiche = controler_fiche(brute, texte)
    passages = decouper_en_passages(texte)
    embeddings = calculer_embeddings(passages)
    return fiche, list(zip(passages, embeddings))


def analyser_cv(cv_id: int, supabase, demander_ia) -> dict:
    """Analyse le CV n° cv_id et enregistre tout. Rend la fiche (affichée au candidat)."""
    cv = supabase.table("cvs").select("texte_complet").eq("id", cv_id).single().execute()
    try:
        fiche, passages = analyser_texte(cv.data.get("texte_complet") or "", demander_ia)
        supabase.table("fiches_cv").upsert(
            {"cv_id": cv_id, **fiche, "valide_par_candidat": False, "analyse_le": datetime.now(timezone.utc).isoformat()},
            on_conflict="cv_id",
        ).execute()
        supabase.table("cv_morceaux").delete().eq("cv_id", cv_id).execute()
        if passages:
            supabase.table("cv_morceaux").insert(
                [{"cv_id": cv_id, "contenu": contenu, "embedding": vecteur} for contenu, vecteur in passages]
            ).execute()
        supabase.table("cvs").update({"statut": "analyse", "erreur": None}).eq("id", cv_id).execute()
        print(f"[ANALYSE] ✓ CV {cv_id} : {len(passages)} passages, {fiche['annees_experience']} an(s) d'expérience")
        return fiche
    except Exception as erreur:
        supabase.table("cvs").update({"statut": "erreur", "erreur": str(erreur)[:500]}).eq("id", cv_id).execute()
        print(f"[ANALYSE] ✗ CV {cv_id} : {erreur}")
        raise
