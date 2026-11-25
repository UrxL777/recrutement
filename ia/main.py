"""
RecrutSmart : le service IA (FastAPI), le chef d'orchestre
- se connecte à Supabase (avec la clé de service) et à Groq (l'IA)
- routes :
    /sante        vérifie que le serveur, Supabase et Groq répondent
    /analyser-cv  appelée par le site juste après le dépôt d'un CV (analyse.py)
    /rechercher   la recherche des recruteurs, avec l'agent qui affine (recherche.py)
"""
import json
import os

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


def demander_ia(messages: list, max_tokens: int = 4000) -> dict:
    """Envoie une demande à l'IA et rend sa réponse en JSON. Passe au modèle de secours si besoin."""
    for modele in (MODELE, MODELE_SECOURS):
        try:
            reponse = groq.chat.completions.create(
                model=modele,
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
            if modele == MODELE and quota:
                print(f"[IA] Modèle principal indisponible → modèle de secours ({str(erreur)[:100]})")
                continue
            raise


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


class DemandeAnalyse(BaseModel):
    cv_id: int


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


@app.post("/analyser-cv")
def analyser_cv(demande: DemandeAnalyse, authorization: str | None = Header(default=None)):
    """
    Appelée par le site juste après le dépôt d'un CV.
    1. vérifie que le CV appartient bien à l'utilisateur connecté
    2. analyse.py : fiche + résumé par l'IA, contrôles Python, passages et embeddings
    3. rend la fiche, que le site affiche au candidat
    """
    candidat_id = utilisateur_connecte(authorization)
    cv = supabase.table("cvs").select("id, candidat_id").eq("id", demande.cv_id).maybe_single().execute()
    if not cv or not cv.data or cv.data["candidat_id"] != candidat_id:
        raise HTTPException(status_code=404, detail="CV introuvable.")
    try:
        fiche = analyse.analyser_cv(demande.cv_id, supabase, demander_ia)
    except ValueError as erreur:
        raise HTTPException(status_code=422, detail=str(erreur))
    return {"fiche": fiche}


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
