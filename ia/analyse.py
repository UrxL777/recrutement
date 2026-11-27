"""
RecrutSmart : l'analyse d'un CV, en deux temps. Rien n'est enregistré tant que le candidat n'a pas publié.

1. PRÉPARER (route /preparer-cv) : rien n'est écrit en base
     - le site a extrait le texte du CV (JavaScript) et l'envoie
     - l'IA lit le texte brut et range tout ce qu'il contient : identité, métier, expériences,
       puis une rubrique par sorte d'information (formations, projets, compétences… selon le CV)
     - Python vérifie ce qui doit être exact : liens, e-mail, téléphone, dates, âge ; il CALCULE les années d'expérience
     - la fiche est rendue au site, qui l'affiche au candidat : s'il n'est pas d'accord, il redépose son CV
2. PUBLIER (route /publier-cv) : le candidat a cliqué sur « Publier mon CV »
     - Python refait tous ses contrôles à partir du texte du CV (rien n'est pris tel quel du site)
     - l'ancien CV du candidat est entièrement supprimé (fichier, fiche, passages)
     - la fiche est enregistrée ; le texte est découpé en passages avec leurs embeddings (recherche par le sens)
     - le CV devient actif : les recruteurs peuvent le trouver
"""
import re
from datetime import date, datetime, timezone

from fastembed import TextEmbedding

# Le modèle d'embeddings : il comprend le français et produit 384 nombres par passage
NOM_MODELE_EMBEDDINGS = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
_modele_embeddings = None

MODELE_ANALYSE = "openai/gpt-oss-120b"   # le grand modèle : plus précis sur les mises en page compliquées
LONGUEUR_MIN_TEXTE = 50       # en dessous, le CV est considéré comme vide (PDF scanné, par exemple)
LONGUEUR_MAX_TEXTE = 15000    # au-delà, la fin du texte n'est pas envoyée à l'IA (limite de tokens)
TAILLE_PASSAGE = 500          # nombre de caractères visé pour chaque passage

PROMPT_FICHE = """Tu lis le texte brut d'un CV, extrait d'un fichier PDF ou Word. La mise en page est perdue : les colonnes se suivent, et des éléments écrits à droite ou en petit (dates, outils) peuvent être regroupés ailleurs dans le texte, souvent au début.
Les dates regroupées à part appartiennent, dans l'ordre où elles apparaissent, aux expériences puis aux formations, dans l'ordre où celles-ci apparaissent : rattache chaque date à son élément d'après cet ordre et le sens (une date « en cours » va à un élément en cours).
Le titre d'une partie peut être séparé de son contenu : une liste de mots isolés, souvent à la fin du texte (qualités, atouts, loisirs…), appartient à la partie dont le titre est resté vide plus haut ; ne la laisse pas de côté.
Chaque CV est écrit différemment : comprends chaque partie d'après son contenu, quel que soit son titre (« domaine », « métier », « atouts », « savoir-être »…).
Écris tout en français.

Règles :
- N'invente rien et ne devine rien : seulement ce qui est écrit dans le CV. Une information absente vaut null ou une liste vide.
- N'oublie rien : chaque information utile du CV doit se retrouver dans la fiche (identité, expériences ou rubriques).
- "nom" : le nom de famille ; "prenom" : tous les prénoms, tels qu'ils sont écrits.
- "titre" : le métier du candidat, comme sur une offre d'emploi : un nom de métier qui désigne la personne, jamais un statut (étudiant, apprenant, stagiaire), jamais un simple domaine. S'il y a un intitulé en tête du CV, le titre s'écrit « nom de métier + domaines » : le nom de métier se forme à partir du mot d'action écrit dans l'intitulé (développement → développeur, analyse → analyste, gestion → gestionnaire, conseil → conseiller…), et non d'après tes propres déductions ; puis viennent tous les domaines de l'intitulé, sans en oublier aucun et sans répéter le mot du métier. Sans intitulé, déduis le métier de l'ensemble du CV.
- "date_naissance" au format AAAA-MM-JJ, seulement si elle est écrite. "age" : un nombre, seulement si l'âge est écrit (« 25 ans »).
- "experiences" : les emplois et les stages. "debut" et "fin" au format AAAA-MM, ou AAAA si le mois n'est pas écrit ; "fin" vaut "aujourd'hui" pour un poste en cours, null si elle n'est pas écrite. "periode" : la période recopiée telle qu'elle est écrite, ou null.
- "rubriques" : tout le reste du CV, rangé par sorte d'information, dans cet ordre quand elles existent : formations, diplômes, certifications, projets, compétences, langues, qualités, centres d'intérêt, puis tout ce qui reste (disponibilité, permis, situation familiale, habitudes, religion, et toute autre information). Ne crée une rubrique que si le CV en parle.
  "titre" : le nom court de la rubrique (« Formations », « Projets », « Compétences »…).
  "contenu" : une seule ligne, tous les éléments de la rubrique séparés par des virgules, chacun en quelques mots, avec la précision utile entre parenthèses (école, organisme, dates écrites comme dans le CV ou « en cours », niveau, outil).
  La rubrique « Compétences » rassemble tous les langages, outils, logiciels et savoir-faire cités n'importe où dans le CV (y compris dans les expériences et les projets), chacun une seule fois.
  Ne mets pas dans les rubriques le nom, le métier, le contact, les liens ni les expériences : ils ont déjà leur place.

Réponds uniquement en JSON :
{"nom": texte ou null, "prenom": texte ou null, "date_naissance": texte ou null, "age": nombre ou null,
 "email": texte ou null, "telephone": texte ou null, "localisation": texte ou null, "titre": texte ou null,
 "experiences": [{"poste": texte, "entreprise": texte ou null, "debut": texte ou null, "fin": texte ou null, "periode": texte ou null}],
 "rubriques": [{"titre": texte, "contenu": texte}]}"""


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
    return round(total / 12, 2)


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


def age_du_cv(propose, texte: str) -> int | None:
    """L'âge, gardé seulement s'il est écrit dans le CV (« 25 ans », jamais « 3 ans d'expérience ») et plausible."""
    try:
        age = int(propose)
    except (TypeError, ValueError):
        return None
    if not 16 <= age <= 80:
        return None
    for m in re.finditer(rf"(?<!\d){age}\s*ans\b(?!\s*(d['’]|de\s|en\s))", texte, re.IGNORECASE):
        return age
    return None


def _texte(valeur) -> str | None:
    t = str(valeur).strip() if valeur is not None else ""
    return t or None


def _prenom(valeur) -> str | None:
    """« ANGE URIEL » → « Ange Uriel » (un prénom écrit tout en majuscules est remis en forme)."""
    prenom = _texte(valeur)
    return prenom.title() if prenom and prenom.isupper() else prenom


MOIS = ["janv.", "fév.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."]


def _dates_lisibles(texte: str) -> str:
    """« 2025-02 » → « fév. 2025 » (une date au format technique n'est pas affichée telle quelle)."""
    return re.sub(r"\b(\d{4})-(0[1-9]|1[0-2])\b", lambda m: f"{MOIS[int(m.group(2)) - 1]} {m.group(1)}", texte)


def _sans_repetition(titre: str | None) -> str | None:
    """« Développeur Data, IA, développement web » → « Développeur Data, IA, web » (le métier n'est pas répété)."""
    if not titre or " " not in titre:
        return titre
    premier, reste = titre.split(" ", 1)
    racine = premier.lower()[:6]
    mots = reste.split(" ")
    gardes = [m for i, m in enumerate(mots)
              # le mot répété est retiré, sauf s'il est suivi de « de », « des »… (« analyse de risques » reste entier)
              if not (m.lower().startswith(racine) and i + 1 < len(mots)
                      and mots[i + 1].lower() not in ("de", "des", "du", "d'", "en", "et"))]
    return f"{premier} {' '.join(gardes)}".strip()


def _majuscule(texte: str | None) -> str | None:
    return texte[0].upper() + texte[1:] if texte else texte


def _periode(valeur, texte: str) -> str | None:
    """La période telle qu'écrite dans le CV ; retirée si elle n'y est pas (l'IA l'aurait inventée)."""
    periode = _texte(valeur)
    return periode if periode and _normaliser_espaces(periode) in _normaliser_espaces(texte) else None


def _normaliser_espaces(t: str) -> str:
    return re.sub(r"\s+", " ", (t or "").lower()).replace("–", "-").replace("—", "-")


def controler_fiche(brute: dict, texte: str) -> dict:
    """Remet la fiche de l'IA en forme et vérifie ce qui doit être exact."""
    aujourd_hui = date.today()
    experiences = []
    for e in brute.get("experiences") or []:
        if not isinstance(e, dict) or not _texte(e.get("poste")):
            continue
        exp = {"poste": _texte(e.get("poste")), "entreprise": _texte(e.get("entreprise")),
               "debut": _texte(e.get("debut")), "fin": _texte(e.get("fin")), "periode": _periode(e.get("periode"), texte)}
        exp["duree"] = annees_experience([exp], texte, aujourd_hui)   # la durée de ce poste, calculée par Python
        experiences.append(exp)
    rubriques = []
    for r in brute.get("rubriques") or []:
        if isinstance(r, dict) and _texte(r.get("titre")) and _texte(r.get("contenu")):
            rubriques.append({"titre": _texte(r.get("titre")), "contenu": _dates_lisibles(_texte(r.get("contenu")))})
    date_naissance = date_naissance_du_cv(brute.get("date_naissance"), texte)
    return {
        "nom": _texte(brute.get("nom")),
        "prenom": _prenom(brute.get("prenom")),
        "date_naissance": date_naissance,
        # l'âge écrit n'est gardé que s'il n'y a pas de date de naissance (sinon l'âge est calculé à partir d'elle)
        "age": None if date_naissance else age_du_cv(brute.get("age"), texte),
        "email": email_du_cv(_texte(brute.get("email")), texte),
        "telephone": telephone_du_cv(_texte(brute.get("telephone")), texte),
        "localisation": _texte(brute.get("localisation")),
        "titre": _sans_repetition(_majuscule(_texte(brute.get("titre")))),
        "experiences": experiences,
        "annees_experience": annees_experience(experiences, texte, aujourd_hui),
        "liens": liens_du_cv(texte),
        "rubriques": rubriques,
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


# ─── 1. Préparer : la fiche, sans rien enregistrer ────────────────────────────

def preparer_fiche(texte: str, demander_ia) -> dict:
    """Le texte d'un CV → la fiche vérifiée, rendue au site. N'écrit rien en base."""
    texte = texte.strip()
    if len(texte) < LONGUEUR_MIN_TEXTE:
        raise ValueError("Le texte du CV est vide ou presque : c'est peut-être un PDF scanné (une image).")
    consigne = PROMPT_FICHE + f"\n\nNous sommes le {date.today().strftime('%d/%m/%Y')}."   # pour savoir ce qui est passé ou en cours
    for _ in range(2):
        brute = demander_ia([
            {"role": "system", "content": consigne},
            {"role": "user", "content": texte[:LONGUEUR_MAX_TEXTE]},
        ], max_tokens=8000, modele=MODELE_ANALYSE)
        fiche = controler_fiche(brute, texte)
        if fiche["rubriques"]:            # une fiche sans aucune rubrique est incomplète : on redemande une fois
            return fiche
    return fiche


# ─── 2. Publier : l'enregistrement, quand le candidat a validé ────────────────



def supprimer_anciens_cv(candidat_id: str, cv_garde: int, supabase) -> int:
    """Supprime tous les autres CV du candidat : les fichiers du stockage, puis les lignes (fiches et passages suivent)."""
    anciens = supabase.table("cvs").select("id, chemin_stockage").eq("candidat_id", candidat_id) \
        .neq("id", cv_garde).execute().data or []
    if anciens:
        supabase.storage.from_("cvs").remove([a["chemin_stockage"] for a in anciens])
        supabase.table("cvs").delete().in_("id", [a["id"] for a in anciens]).execute()
    return len(anciens)


def publier_cv(cv_id: int, candidat_id: str, fiche_relue: dict, supabase) -> dict:
    """
    Enregistre le CV n° cv_id avec la fiche que le candidat a lue et acceptée, et supprime son ancien CV.
    La fiche repasse par tous les contrôles Python, à partir du texte du CV.
    """
    cv = supabase.table("cvs").select("texte_complet, chemin_stockage, actif").eq("id", cv_id).single().execute().data
    texte = cv.get("texte_complet") or ""
    fiche = controler_fiche(fiche_relue, texte)
    try:
        supabase.table("fiches_cv").upsert(
            {"cv_id": cv_id, **fiche, "valide_par_candidat": True, "analyse_le": datetime.now(timezone.utc).isoformat()},
            on_conflict="cv_id",
        ).execute()
        # Les passages ne sont calculés qu'une fois par CV
        deja = supabase.table("cv_morceaux").select("id", count="exact").eq("cv_id", cv_id).limit(1).execute()
        if not deja.count:
            passages = decouper_en_passages(texte)
            supabase.table("cv_morceaux").insert(
                [{"cv_id": cv_id, "contenu": c, "embedding": v} for c, v in zip(passages, calculer_embeddings(passages))]
            ).execute()
        # Tout est prêt : l'ancien CV est supprimé, puis le nouveau devient actif (visible des recruteurs)
        nb_supprimes = supprimer_anciens_cv(candidat_id, cv_id, supabase)
        supabase.table("cvs").update({"statut": "analyse", "erreur": None, "actif": True}).eq("id", cv_id).execute()
        print(f"[PUBLIER] ✓ CV {cv_id} publié ({nb_supprimes} ancien(s) CV supprimé(s))")
        return {**fiche, "cv_id": cv_id, "valide_par_candidat": True}
    except Exception as erreur:
        # Rien ne doit rester à moitié : un nouveau CV qui n'a pas pu être publié est retiré
        if not cv.get("actif"):
            supabase.storage.from_("cvs").remove([cv["chemin_stockage"]])
            supabase.table("cvs").delete().eq("id", cv_id).execute()
        print(f"[PUBLIER] ✗ CV {cv_id} : {erreur}")
        raise
