"""
RecrutSmart : le service IA (FastAPI), le chef d'orchestre
- se connecte à Supabase (avec la clé de service) et à Groq (l'IA)
- routes :
    /sante        vérifie que le serveur, Supabase et Groq répondent
    /preparer-cv  le site envoie le texte d'un CV déposé ; l'IA prépare la fiche (rien n'est enregistré)
    /publier-cv   le candidat a cliqué sur « Publier mon CV » : tout est enregistré (analyse.py)
    /rechercher   la recherche des recruteurs, avec l'agent qui affine (recherche.py)
"""
import json
import os
import re
import time

from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from openai import OpenAI
from pydantic import BaseModel
from supabase import create_client

import analyse
import recherche

# ─── Les clés, lues dans le fichier .env (jamais écrites dans le code) ───
load_dotenv()

supabase = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"])

groq = OpenAI(api_key=os.environ["GROQ_API_KEY"], base_url="https://api.groq.com/openai/v1")
MODELE = "openai/gpt-oss-20b"           # le modèle principal
MODELE_SECOURS = "qwen/qwen3.8-27b"     # prend le relais si le quota du principal est épuisé


def _attente_demandee(erreur) -> float:
    """Le temps d'attente demandé par Groq quand le quota de la minute est atteint (5 s par défaut, 20 s au plus)."""
    try:
        return min(float(erreur.response.headers.get("retry-after")), 20.0)
    except Exception:
        m = re.search(r"try again in ([\d.]+)s", str(erreur))
        return min(float(m.group(1)), 20.0) if m else 5.0


def demander_ia(messages: list, max_tokens: int = 4000, modele: str = MODELE) -> dict:
    """
    Envoie une demande à l'IA et rend sa réponse en JSON.
    Réponse inutilisable ou quota atteint : second essai, puis modèle de secours,
    puis, si le secours est aussi saturé, on attend le temps demandé par Groq et on réessaie une dernière fois.
    """
    essais = (modele, modele, MODELE_SECOURS, modele)
    for numero, modele_essai in enumerate(essais):
        try:
            reponse = groq.chat.completions.create(
                model=modele_essai,
                messages=messages,
                max_tokens=max_tokens,
                temperature=0.1,
                response_format={"type": "json_object"},
            )
            texte = reponse.choices[0].message.content or ""
            return json.loads(texte[texte.find("{"): texte.rfind("}") + 1])
        except Exception as erreur:
            message = str(erreur).lower()
            quota = any(m in message for m in ("429", "413", "503", "rate limit", "over capacity"))
            json_rate = isinstance(erreur, json.JSONDecodeError) or "validate json" in message
            if not (quota or json_rate) or numero == len(essais) - 1:
                raise
            if quota and modele_essai == MODELE_SECOURS:
                attente = _attente_demandee(erreur)
                print(f"[IA] Quota de la minute atteint : attente de {attente:.0f} s")
                time.sleep(attente)
            else:
                print(f"[IA] Réponse inutilisable ou quota atteint → nouvel essai ({str(erreur)[:100]})")


def utilisateur_connecte(authorization: str | None) -> str:
    """Rend l'identifiant de l'utilisateur à partir du jeton envoyé par le site (Supabase Auth)."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Connexion requise.")
    try:
        reponse = supabase.auth.get_user(authorization.split(" ", 1)[1])
        return reponse.user.id
    except Exception:
        raise HTTPException(status_code=401, detail="Session invalide ou expirée.")


# ─── L'application ───
app = FastAPI(title="RecrutSmart IA")

# Le site (sur une autre adresse) a le droit d'appeler ce serveur
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class DemandePreparation(BaseModel):
    texte: str              # le texte du CV, extrait par le site


class DemandePublication(BaseModel):
    cv_id: int
    fiche: dict             # la fiche relue (et corrigée) par le candidat


class DemandeRecherche(BaseModel):
    messages: list[str]     # la demande du recruteur, puis ses précisions successives


@app.get("/sante")
def sante():
    """Vérifie que tout répond : le serveur, Supabase et Groq (aucun token consommé)."""
    lieux = supabase.table("lieux_residence").select("id", count="exact").limit(1).execute()
    modeles = [m.id for m in groq.models.list().data]
    return {
        "serveur": "ok",
        "supabase": f"ok : {lieux.count} lieux de résidence",
        "groq": "ok" if MODELE in modeles else f"le modèle {MODELE} est introuvable",
    }


def candidat_connecte(authorization: str | None) -> str:
    """L'utilisateur connecté, s'il est candidat (sinon : refus)."""
    candidat_id = utilisateur_connecte(authorization)
    profil = supabase.table("profils").select("role").eq("id", candidat_id).maybe_single().execute()
    if not profil or not profil.data or profil.data["role"] != "candidat":
        raise HTTPException(status_code=403, detail="Réservé aux candidats.")
    return candidat_id


@app.post("/preparer-cv")
def preparer_cv(demande: DemandePreparation, authorization: str | None = Header(default=None)):
    """
    Le candidat vient de déposer son CV : le site envoie le texte, l'IA prépare la fiche.
    RIEN n'est enregistré : la fiche est seulement rendue au site, pour que le candidat la relise.
    """
    candidat_connecte(authorization)
    try:
        return {"fiche": analyse.preparer_fiche(demande.texte, demander_ia)}
    except ValueError as erreur:
        raise HTTPException(status_code=422, detail=str(erreur))


@app.post("/publier-cv")
def publier_cv(demande: DemandePublication, authorization: str | None = Header(default=None)):
    """
    Le candidat a cliqué sur « Publier mon CV » : le site a rangé le fichier et créé la ligne du CV (inactive).
    1. vérifie que le CV appartient bien au candidat connecté
    2. analyse.py enregistre la fiche et les passages, supprime l'ancien CV, puis active le nouveau
    """
    candidat_id = candidat_connecte(authorization)
    cv = supabase.table("cvs").select("id, candidat_id").eq("id", demande.cv_id).maybe_single().execute()
    if not cv or not cv.data or cv.data["candidat_id"] != candidat_id:
        raise HTTPException(status_code=404, detail="CV introuvable.")
    return {"fiche": analyse.publier_cv(demande.cv_id, candidat_id, demande.fiche, supabase)}


@app.post("/rechercher")
def rechercher(demande: DemandeRecherche, authorization: str | None = Header(default=None)):
    """
    La recherche d'un recruteur, en langage naturel.
    Le site envoie la demande et les précisions (la conversation avec l'agent, gardée dans le navigateur).
    """
    recruteur_id = utilisateur_connecte(authorization)
    profil = supabase.table("profils").select("role").eq("id", recruteur_id).maybe_single().execute()
    if not profil or not profil.data or profil.data["role"] != "recruteur":
        raise HTTPException(status_code=403, detail="La recherche est réservée aux recruteurs.")
    messages = [m.strip()[:500] for m in demande.messages if m.strip()][-10:]
    if not messages:
        raise HTTPException(status_code=422, detail="Écrivez ce que vous recherchez.")
    return recherche.rechercher(messages, supabase, demander_ia)
