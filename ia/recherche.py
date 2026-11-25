"""
RecrutSmart : la recherche des recruteurs, en langage naturel.

La démarche :
  1. l'IA découpe la demande du recruteur (et ses précisions, s'il affine avec l'agent) en critères
  2. Python vérifie ce qui se calcule : les années d'expérience, l'âge, le lieu de résidence
  3. pour tout le reste (métier, compétence, loisir…) :
       - la recherche par le sens (pgvector) trouve les passages de CV les plus proches de chaque critère
       - l'IA relit ces passages sur les meilleurs candidats et répond pour chaque critère :
         trouvé, en partie ou non mentionné, avec la phrase exacte du CV comme preuve
       - Python vérifie que la preuve est bien écrite dans le CV
  4. Python calcule le score : trouvé = 1, en partie = 0,5, non mentionné = 0 (tous les critères comptent pareil)
"""
import json
import re
import unicodedata
from datetime import date

from analyse import calculer_embeddings

NB_PASSAGES_PAR_CRITERE = 40   # passages proches demandés à la base, pour chaque critère
PASSAGES_PAR_CANDIDAT = 2      # passages gardés par candidat et par critère, envoyés à l'IA
NB_CANDIDATS_VERIFIES = 15     # l'IA ne vérifie que les candidats les plus prometteurs
CANDIDATS_PAR_APPEL = 5        # candidats vérifiés en un seul appel à l'IA
NB_RESULTATS = 20
TYPES = ("experience_min", "age_min", "age_max", "lieu", "texte")
POINTS = {"trouve": 1.0, "partiel": 0.5, "absent": 0.0}

PROMPT_CRITERES = """Tu aides un recruteur à trouver des candidats dans une base de CV.
Tu reçois sa demande, puis éventuellement ses précisions successives : la dernière est la plus récente.
Écris la liste complète et à jour des critères recherchés : un critère par idée, sans en oublier et sans en inventer.
Pour chaque critère, donne :
- "critere" : le critère en quelques mots, en français courant, tel que le recruteur l'entend (jamais le nom du type) ;
- "type" : "experience_min" (un nombre minimum d'années d'expérience), "age_min" (un âge minimum), "age_max" (un âge maximum), "lieu" (l'endroit où vit le candidat) ou "texte" (tout le reste : métier, compétence, outil, diplôme, langue, loisir, habitude, qualité…) ;
- "valeur" : le nombre pour experience_min, age_min et age_max ; la liste des lieux acceptés pour lieu ; null pour texte.
Si une précision retire ou remplace un critère, applique-la.
Écris aussi "message" : une phrase courte qui dit au recruteur ce que tu vas rechercher.
Réponds uniquement en JSON : {"criteres": [{"critere": "...", "type": "...", "valeur": null}], "message": "..."}"""

PROMPT_VERIFICATION = """Tu vérifies si des candidats correspondent aux critères d'un recruteur.
Pour chaque candidat, tu reçois des passages de son CV. Pour chaque critère, réponds :
- "statut" : "trouve" si un passage montre clairement le critère, "partiel" s'il le montre en partie ou indirectement, "absent" si les passages n'en parlent pas ;
- "preuve" : la phrase du passage qui justifie ta réponse, recopiée mot pour mot, ou null si le statut est "absent".
Ne te fie qu'aux passages et n'invente rien.
Réponds uniquement en JSON : {"candidats": [{"cv_id": 0, "criteres": [{"critere": "...", "statut": "...", "preuve": null}]}]}"""


def normaliser(texte) -> str:
    """Minuscules, sans accents ni espaces en trop : « Yopougon, Abidjan » = « yopougon, abidjan »."""
    texte = unicodedata.normalize("NFD", str(texte or "").lower())
    texte = "".join(c for c in texte if unicodedata.category(c) != "Mn")
    return re.sub(r"\s+", " ", texte).strip()


# ─── 1. L'IA découpe la demande en critères ───────────────────────────────────

def decouper_criteres(messages: list, demander_ia) -> tuple:
    """Les messages du recruteur (la demande, puis ses précisions) → (critères vérifiés, message de l'agent)."""
    texte = "\n".join(
        (f"Demande : {m}" if i == 0 else f"Précision {i} : {m}") for i, m in enumerate(messages)
    )
    reponse = demander_ia([{"role": "system", "content": PROMPT_CRITERES}, {"role": "user", "content": texte}],
                          max_tokens=2000)
    criteres = []
    for c in reponse.get("criteres") or []:
        if not isinstance(c, dict) or not str(c.get("critere") or "").strip():
            continue
        type_critere = c.get("type") if c.get("type") in TYPES else "texte"
        valeur = c.get("valeur")
        if type_critere in ("experience_min", "age_min", "age_max"):
            try:
                valeur = float(valeur)
            except (TypeError, ValueError):
                type_critere, valeur = "texte", None     # pas de nombre utilisable : on cherche dans le texte
        elif type_critere == "lieu":
            valeur = [str(v).strip() for v in (valeur if isinstance(valeur, list) else [valeur]) if str(v or "").strip()]
            if not valeur:
                type_critere, valeur = "texte", None
        else:
            valeur = None
        nom = str(c["critere"]).strip()
        # Expérience et âge : toujours un nom précis (« Au moins 2 ans d'expérience ») ;
        # lieu : le nom de l'IA, sauf si elle a recopié le nom du type
        if type_critere in ("experience_min", "age_min", "age_max") \
                or normaliser(nom).replace(" ", "_") in TYPES or len(nom) < 3:
            nom = nom_lisible(type_critere, valeur) or nom
        criteres.append({"critere": nom, "type": type_critere, "valeur": valeur})
    return criteres, str(reponse.get("message") or "").strip()


def nom_lisible(type_critere: str, valeur) -> str | None:
    """Un nom de critère en français courant, pour les critères calculés."""
    if type_critere == "experience_min":
        return f"Au moins {_ans(valeur)} d'expérience"
    if type_critere == "age_min":
        return f"Au moins {_nombre(valeur)} ans"
    if type_critere == "age_max":
        return f"{_nombre(valeur)} ans au plus"
    if type_critere == "lieu":
        return "Vit à " + " ou ".join(valeur)
    return None


# ─── 2. Python vérifie ce qui se calcule ──────────────────────────────────────

def _age(date_naissance) -> int | None:
    try:
        naissance = date.fromisoformat(str(date_naissance))
    except (TypeError, ValueError):
        return None
    aujourd_hui = date.today()
    return aujourd_hui.year - naissance.year - ((aujourd_hui.month, aujourd_hui.day) < (naissance.month, naissance.day))


def _nombre(n: float) -> str:
    return f"{n:g}".replace(".", ",")


def _ans(n: float) -> str:
    """« 1 an », « 2 ans », « 1,5 an »."""
    return f"{_nombre(n)} an" + ("s" if n >= 2 else "")


def duree_lisible(annees) -> str:
    """Une durée en années → « 4 mois », « 1 an », « 3 ans et 2 mois » (jamais « 0,3 an »)."""
    mois_total = round(float(annees) * 12)
    ans, mois = divmod(mois_total, 12)
    morceaux = []
    if ans:
        morceaux.append(f"{ans} an" + ("s" if ans > 1 else ""))
    if mois or not ans:
        morceaux.append(f"{mois} mois")
    return " et ".join(morceaux)


def verifier_par_calcul(critere: dict, candidat: dict, villes: dict) -> dict:
    """
    Vérifie un critère qui se calcule (expérience, âge, lieu) à partir de la fiche et du profil.
    villes : commune → ville (ex. « yopougon » → « abidjan »), d'après la table lieux_residence.
    """
    fiche, type_critere, valeur = candidat["fiche"], critere["type"], critere["valeur"]
    resultat = {"critere": critere["critere"], "statut": "absent", "preuve": None}

    if type_critere == "experience_min":
        annees = fiche.get("annees_experience")
        if annees is None:
            resultat["preuve"] = "Années d'expérience impossibles à calculer : dates absentes du CV."
        else:
            annees = float(annees)
            resultat["statut"] = "trouve" if annees >= valeur else "absent"
            resultat["preuve"] = f"{duree_lisible(annees)} d'expérience, calculés à partir des dates du CV."

    elif type_critere in ("age_min", "age_max"):
        age = _age(fiche.get("date_naissance"))
        if age is None:
            resultat["preuve"] = "Date de naissance non mentionnée dans le CV."
        else:
            ok = age >= valeur if type_critere == "age_min" else age <= valeur
            resultat["statut"] = "trouve" if ok else "absent"
            resultat["preuve"] = f"{age} ans (né(e) le {date.fromisoformat(str(fiche['date_naissance'])).strftime('%d/%m/%Y')})."

    elif type_critere == "lieu":
        lieux_candidat = [l for l in (candidat["profil"].get("lieu_residence"), fiche.get("localisation")) if l]
        for lieu in lieux_candidat:
            texte_lieu = normaliser(lieu)
            for voulu in valeur:
                v = normaliser(voulu)
                # le lieu est écrit tel quel, ou le candidat vit dans une commune de la ville demandée
                commune_de_la_ville = any(ville == v and re.search(rf"\b{re.escape(commune)}\b", texte_lieu)
                                          for commune, ville in villes.items())
                if v and (re.search(rf"\b{re.escape(v)}\b", texte_lieu) or commune_de_la_ville):
                    resultat["statut"], resultat["preuve"] = "trouve", f"Lieu de résidence : {lieu}"
                    return resultat
        resultat["preuve"] = f"Lieu de résidence : {lieux_candidat[0]}" if lieux_candidat else None
    return resultat


# ─── 3. Recherche par le sens, puis vérification par l'IA ─────────────────────

def _liste_de_dicts(valeur, cle: str) -> list:
    """
    L'IA ne renvoie pas toujours exactement la forme demandée : une liste d'objets,
    ou un objet {identifiant: {…}}. On remet tout sous forme de liste d'objets.
    """
    if isinstance(valeur, dict):
        return [{cle: k, **v} for k, v in valeur.items() if isinstance(v, dict)]
    return [v for v in valeur or [] if isinstance(v, dict)] if isinstance(valeur, list) else []


def verifier_par_ia(criteres: list, a_verifier: list, passages: dict, demander_ia) -> dict:
    """
    L'IA vérifie les critères « texte » sur les candidats choisis, à partir de leurs passages.
    Rend {cv_id: {critère: {statut, preuve}}}. Une preuve absente du CV est retirée.
    """
    resultats = {}
    noms = [c["critere"] for c in criteres]
    groupes = [a_verifier[d:d + CANDIDATS_PAR_APPEL] for d in range(0, len(a_verifier), CANDIDATS_PAR_APPEL)]
    deja_redemande = False
    while groupes:
        groupe = groupes.pop(0)
        entree = {"criteres": noms, "candidats": [
            {"cv_id": c["cv_id"], "passages": list(dict.fromkeys(
                p for nom in noms for p in passages.get(c["cv_id"], {}).get(nom, [])))}
            for c in groupe]}
        reponse = demander_ia([{"role": "system", "content": PROMPT_VERIFICATION},
                               {"role": "user", "content": json.dumps(entree, ensure_ascii=False)}])
        textes_cv = {c["cv_id"]: normaliser(c["texte_complet"]) for c in groupe}
        for r in _liste_de_dicts(reponse.get("candidats"), "cv_id"):
            try:
                cv_id = int(r.get("cv_id"))
            except (TypeError, ValueError):
                continue
            if cv_id not in textes_cv:
                continue
            for v in _liste_de_dicts(r.get("criteres"), "critere"):
                if v.get("critere") not in noms:
                    continue
                statut = v.get("statut") if v.get("statut") in POINTS else "absent"
                preuve = str(v.get("preuve") or "").strip(" -•*·\t\n") or None
                # Contrôle Python : la preuve doit être écrite dans le CV
                if statut != "absent" and (not preuve or normaliser(preuve) not in textes_cv[cv_id]):
                    statut, preuve = ("partiel" if statut == "trouve" else "absent"), None
                resultats.setdefault(cv_id, {})[v["critere"]] = {"statut": statut, "preuve": preuve}
        # Un candidat oublié par l'IA dans sa réponse lui est redemandé une fois
        oublies = [c for c in groupe if c["cv_id"] not in resultats]
        if oublies and not deja_redemande:
            deja_redemande = True
            groupes.append(oublies)
    return resultats


def classer(criteres: list, candidats: list, villes: dict, chercher_passages, demander_ia) -> list:
    """
    Classe les candidats selon les critères. Rend les candidats qui remplissent au moins un critère.
    chercher_passages(vecteur) → [{cv_id, contenu, similarite}] : la recherche par le sens dans la base.
    """
    par_id = {c["cv_id"]: c for c in candidats}
    calcules = [c for c in criteres if c["type"] != "texte"]
    textes = [c for c in criteres if c["type"] == "texte"]

    # Les critères calculés, pour tous les candidats
    details = {cv_id: {c["critere"]: verifier_par_calcul(c, cand, villes) for c in calcules}
               for cv_id, cand in par_id.items()}

    # La recherche par le sens, pour chaque critère « texte »
    passages, proximite = {}, {cv_id: 0.0 for cv_id in par_id}
    if textes:
        for critere, vecteur in zip(textes, calculer_embeddings([c["critere"] for c in textes])):
            meilleure = {}
            for ligne in chercher_passages(vecteur):
                cv_id = ligne["cv_id"]
                if cv_id not in par_id:
                    continue
                liste = passages.setdefault(cv_id, {}).setdefault(critere["critere"], [])
                if len(liste) < PASSAGES_PAR_CANDIDAT:
                    liste.append(ligne["contenu"])
                meilleure[cv_id] = max(meilleure.get(cv_id, 0.0), float(ligne["similarite"]))
            for cv_id, sim in meilleure.items():
                proximite[cv_id] += sim

        # Les candidats les plus prometteurs : critères calculés remplis + passages les plus proches
        def promesse(cv_id):
            return sum(POINTS[d["statut"]] for d in details[cv_id].values()) + proximite[cv_id]
        a_verifier = sorted((par_id[i] for i in par_id if i in passages), key=lambda c: -promesse(c["cv_id"]))
        verifies = verifier_par_ia(textes, a_verifier[:NB_CANDIDATS_VERIFIES], passages, demander_ia)
        for cv_id in details:
            for c in textes:
                v = verifies.get(cv_id, {}).get(c["critere"], {"statut": "absent", "preuve": None})
                details[cv_id][c["critere"]] = {"critere": c["critere"], **v}

    # Le score, calculé par Python
    resultats = []
    for cv_id, cand in par_id.items():
        detail = [details[cv_id][c["critere"]] for c in criteres]
        points = sum(POINTS[d["statut"]] for d in detail)
        if points == 0:
            continue
        fiche, profil = cand["fiche"], cand["profil"]
        resultats.append({
            "cv_id": cv_id,
            "candidat_id": cand["candidat_id"],
            "nom": profil.get("nom") or fiche.get("nom"),
            "prenom": profil.get("prenom") or fiche.get("prenom"),
            "titre": fiche.get("titre"),
            "resume": fiche.get("resume"),
            "lieu_residence": profil.get("lieu_residence"),
            "annees_experience": fiche.get("annees_experience"),
            "liens": fiche.get("liens") or [],
            "valide_par_candidat": fiche.get("valide_par_candidat", False),
            "chemin_stockage": cand["chemin_stockage"],
            "score": round(100 * points / len(criteres)),
            "nb_trouves": sum(1 for d in detail if d["statut"] == "trouve"),
            "criteres": detail,
        })
    resultats.sort(key=lambda r: (-r["score"], -r["nb_trouves"]))
    return resultats[:NB_RESULTATS]


# ─── La recherche complète, avec la base ──────────────────────────────────────

def charger_candidats(supabase) -> list:
    """Les CV actifs et analysés, avec leur fiche et le profil du candidat."""
    cvs = supabase.table("cvs").select("id, candidat_id, chemin_stockage, texte_complet") \
        .eq("actif", True).eq("statut", "analyse").execute().data or []
    if not cvs:
        return []
    fiches = supabase.table("fiches_cv").select("*").in_("cv_id", [c["id"] for c in cvs]).execute().data or []
    profils = supabase.table("profils").select("id, nom, prenom, lieu_residence") \
        .in_("id", list({c["candidat_id"] for c in cvs})).execute().data or []
    fiche_par_cv = {f["cv_id"]: f for f in fiches}
    profil_par_id = {p["id"]: p for p in profils}
    return [{"cv_id": c["id"], "candidat_id": c["candidat_id"], "chemin_stockage": c["chemin_stockage"],
             "texte_complet": c["texte_complet"] or "", "fiche": fiche_par_cv[c["id"]],
             "profil": profil_par_id.get(c["candidat_id"], {})}
            for c in cvs if c["id"] in fiche_par_cv]


def rechercher(messages: list, supabase, demander_ia) -> dict:
    """La recherche d'un recruteur : rend le message de l'agent, les critères et les candidats classés."""
    criteres, message = decouper_criteres(messages, demander_ia)
    if not criteres:
        return {"message": message or "Je n'ai pas compris ce que vous recherchez. Pouvez-vous reformuler ?",
                "criteres": [], "resultats": []}
    candidats = charger_candidats(supabase)
    lieux = supabase.table("lieux_residence").select("nom, ville").execute().data or []
    villes = {normaliser(l["nom"]): normaliser(l["ville"]) for l in lieux}

    def chercher_passages(vecteur):
        return supabase.rpc("passages_proches", {"vecteur": vecteur, "nombre": NB_PASSAGES_PAR_CRITERE}).execute().data or []

    resultats = classer(criteres, candidats, villes, chercher_passages, demander_ia)
    print(f"[RECHERCHE] {len(criteres)} critère(s), {len(candidats)} CV, {len(resultats)} résultat(s)")
    return {"message": message, "criteres": criteres, "resultats": resultats}
