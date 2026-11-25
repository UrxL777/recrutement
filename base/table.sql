-- ════════════════════════════════════════════════════════════════
--  RECRUTEMENT : la base de données (Supabase, PostgreSQL)
-- ════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════
--  Partie 1 : les lieux de résidence et les profils
-- ════════════════════════════════════════════════════════════════

-- pgvector : ranger les embeddings (le « sens » des passages de CV) pour la recherche sémantique
create extension if not exists vector;

-- ─── Les suggestions de lieux de résidence (la liste qui se déroule sur le site) ───
-- L'utilisateur peut aussi taper un autre lieu : cette liste ne sert qu'à proposer
-- et à savoir dans quelle ville se trouve une commune (ex. Yopougon → Abidjan).
create table public.lieux_residence (
  id     serial primary key,
  nom    text not null unique,
  ville  text not null
);

insert into public.lieux_residence (nom, ville) values
  -- Les communes d'Abidjan
  ('Abobo', 'Abidjan'), ('Adjamé', 'Abidjan'), ('Attécoubé', 'Abidjan'), ('Cocody', 'Abidjan'),
  ('Koumassi', 'Abidjan'), ('Marcory', 'Abidjan'), ('Plateau', 'Abidjan'), ('Port-Bouët', 'Abidjan'),
  ('Treichville', 'Abidjan'), ('Yopougon', 'Abidjan'), ('Anyama', 'Abidjan'), ('Bingerville', 'Abidjan'),
  ('Songon', 'Abidjan'),
  -- Les principales villes
  ('Bouaké', 'Bouaké'), ('Yamoussoukro', 'Yamoussoukro'), ('Daloa', 'Daloa'), ('San-Pédro', 'San-Pédro'),
  ('Korhogo', 'Korhogo'), ('Man', 'Man'), ('Danané', 'Danané'), ('Gagnoa', 'Gagnoa'),
  ('Abengourou', 'Abengourou'), ('Divo', 'Divo'), ('Soubré', 'Soubré'), ('Grand-Bassam', 'Grand-Bassam'),
  ('Dabou', 'Dabou'), ('Agboville', 'Agboville'), ('Bondoukou', 'Bondoukou'), ('Odienné', 'Odienné'),
  ('Séguéla', 'Séguéla'), ('Ferkessédougou', 'Ferkessédougou'), ('Duékoué', 'Duékoué'), ('Sassandra', 'Sassandra');

-- ─── Les profils : un par compte, candidats et recruteurs dans la même table ───
-- (l'e-mail et le mot de passe sont gérés par Supabase Auth, dans auth.users)
create table public.profils (
  id              uuid primary key references auth.users (id) on delete cascade,
  role            text not null check (role in ('candidat', 'recruteur')),
  nom             text not null,
  prenom          text not null,
  lieu_residence  text not null,       -- choisi dans la liste ou tapé librement
  telephone       text,                -- facultatif, rempli plus tard dans le profil
  entreprise      text,                -- recruteur uniquement
  site_web        text,                -- recruteur uniquement, facultatif
  cree_le         timestamptz not null default now(),
  -- Un recruteur doit indiquer son entreprise
  constraint entreprise_du_recruteur check (role <> 'recruteur' or coalesce(trim(entreprise), '') <> '')
);

-- ─── À l'inscription : le profil est créé automatiquement ───
-- Le site envoie le rôle, le nom, le prénom… avec l'inscription (Supabase Auth) ;
-- ce trigger les range dans profils. S'il manque une information obligatoire, l'inscription est refusée.
create or replace function public.creer_profil()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  infos jsonb := new.raw_user_meta_data;
begin
  insert into public.profils (id, role, nom, prenom, lieu_residence, entreprise, site_web)
  values (
    new.id,
    infos->>'role',
    trim(infos->>'nom'),
    trim(infos->>'prenom'),
    trim(infos->>'lieu_residence'),
    nullif(trim(infos->>'entreprise'), ''),
    nullif(trim(infos->>'site_web'), '')
  );
  return new;
end;
$$;

create trigger trigger_creer_profil
  after insert on auth.users
  for each row execute function public.creer_profil();


-- ════════════════════════════════════════════════════════════════
--  Partie 2 : les CV
-- ════════════════════════════════════════════════════════════════

-- ─── Chaque CV déposé par un candidat ───
create table public.cvs (
  id               bigint generated always as identity primary key,
  candidat_id      uuid not null references public.profils (id) on delete cascade,
  nom_fichier      text not null,
  type_fichier     text not null check (type_fichier in ('pdf', 'docx')),
  taille           int,                            -- en octets
  chemin_stockage  text not null,                  -- où le fichier est rangé dans le stockage Supabase
  texte_complet    text,                           -- tout le texte du CV, extrait du fichier
  statut           text not null default 'en_attente'
                   check (statut in ('en_attente', 'analyse', 'erreur')),
  erreur           text,                           -- la raison, si l'analyse a échoué
  actif            boolean not null default true,  -- le CV actuel du candidat
  cree_le          timestamptz not null default now()
);

-- Un seul CV actif par candidat (les anciens restent dans l'historique)
create unique index un_seul_cv_actif on public.cvs (candidat_id) where actif;

-- ─── La fiche : ce que l'IA a extrait du CV, vérifié par Python ───
create table public.fiches_cv (
  cv_id                bigint primary key references public.cvs (id) on delete cascade,
  -- L'identité trouvée dans le CV
  nom                  text,
  prenom               text,
  date_naissance       date,
  email                text,
  telephone            text,
  localisation         text,
  -- Le profil
  titre                text,                         -- le métier principal
  resume               text,                         -- affiché au candidat ET au recruteur
  experiences          jsonb not null default '[]',  -- [{poste, entreprise, debut, fin, missions}]
  annees_experience    numeric(5, 2),                -- calculées par Python à partir des dates (2 décimales : les mois justes)
  formations           jsonb not null default '[]',  -- [{diplome, ecole, debut, fin}]
  competences          text[] not null default '{}',
  langues              text[] not null default '{}',
  certifications       jsonb not null default '[]',
  projets              jsonb not null default '[]',  -- [{nom, description, technologies, lien}]
  liens                jsonb not null default '[]',  -- [{type, url}] : GitHub, portfolio, LinkedIn…
  autres_infos         jsonb not null default '{}',  -- loisirs, centres d'intérêt, et tout le reste
  valide_par_candidat  boolean not null default false,  -- le candidat a relu et confirmé sa fiche
  analyse_le           timestamptz not null default now()
);

-- ─── Le CV découpé en passages, chacun avec son embedding (recherche par le sens) ───
create table public.cv_morceaux (
  id         bigint generated always as identity primary key,
  cv_id      bigint not null references public.cvs (id) on delete cascade,
  section    text,                 -- ex. experience, projet, formation, loisirs
  contenu    text not null,        -- le passage, tel qu'écrit dans le CV
  embedding  vector(384)           -- le « sens » du passage (modèle multilingual-e5-small)
);

-- Index pour retrouver vite les passages les plus proches d'une demande
create index cv_morceaux_embedding on public.cv_morceaux
  using hnsw (embedding vector_cosine_ops);

  

-- ════════════════════════════════════════════════════════════════
--  Partie 3 : le contact (le recruteur contacte un candidat)
-- ════════════════════════════════════════════════════════════════

-- ─── Chaque prise de contact : un message du recruteur + le suivi de la candidature ───
-- Le message n'est pas un vrai e-mail : il s'affiche dans la page « Mes candidatures » du candidat.
create table public.contacts (
  id              bigint generated always as identity primary key,
  recruteur_id    uuid not null references public.profils (id) on delete cascade,
  candidat_id     uuid not null references public.profils (id) on delete cascade,
  poste           text not null,                 -- ex. Data analyst junior
  message         text not null,                 -- le message du recruteur
  date_entretien  timestamptz,                   -- facultative
  statut          text not null default 'en_attente'
                  check (statut in ('en_attente', 'entretien_planifie', 'accepte', 'refuse')),
  lu              boolean not null default false,  -- le candidat a-t-il ouvert le message ?
  cree_le         timestamptz not null default now(),
  mis_a_jour_le   timestamptz not null default now()  -- dernière modification du statut
);

-- Retrouver vite les contacts d'un candidat (page « Mes candidatures ») et ceux d'un recruteur
create index contacts_du_candidat on public.contacts (candidat_id, cree_le desc);
create index contacts_du_recruteur on public.contacts (recruteur_id, cree_le desc);



-- ════════════════════════════════════════════════════════════════
--  Partie 4 : la sécurité (qui peut lire et modifier quoi)
--  Python utilise la clé de service : il n'est pas concerné par ces règles.
-- ════════════════════════════════════════════════════════════════

-- ─── Deux petites fonctions utilisées par les règles ───
-- Le rôle de l'utilisateur connecté (candidat ou recruteur)
create or replace function public.mon_role()
returns text
language sql stable security definer set search_path = public
as $$ select role from public.profils where id = auth.uid() $$;

-- L'utilisateur connecté est-il un recruteur ?
create or replace function public.est_recruteur()
returns boolean
language sql stable security definer set search_path = public
as $$ select coalesce(public.mon_role() = 'recruteur', false) $$;

-- ─── Activer la sécurité sur toutes les tables ───
alter table public.lieux_residence enable row level security;
alter table public.profils         enable row level security;
alter table public.cvs             enable row level security;
alter table public.fiches_cv       enable row level security;
alter table public.cv_morceaux     enable row level security;  -- aucune règle : seul Python y accède
alter table public.contacts        enable row level security;

-- ─── lieux_residence : tout le monde peut lire la liste ───
create policy "Lire les lieux" on public.lieux_residence
  for select using (true);

-- ─── profils ───
create policy "Lire son profil" on public.profils
  for select using (id = auth.uid());

create policy "Le recruteur lit les profils des candidats" on public.profils
  for select using (public.est_recruteur() and role = 'candidat');

create policy "Le candidat lit les recruteurs qui l'ont contacté" on public.profils
  for select using (
    role = 'recruteur'
    and exists (select 1 from public.contacts c
                where c.recruteur_id = profils.id and c.candidat_id = auth.uid())
  );

create policy "Modifier son profil, sans changer de rôle" on public.profils
  for update using (id = auth.uid())
  with check (id = auth.uid() and role = public.mon_role());

-- ─── cvs ───
create policy "Le candidat lit ses CV" on public.cvs
  for select using (candidat_id = auth.uid());

create policy "Le recruteur lit les CV actifs" on public.cvs
  for select using (public.est_recruteur() and actif);

create policy "Le candidat dépose ses CV" on public.cvs
  for insert with check (candidat_id = auth.uid() and public.mon_role() = 'candidat');

create policy "Le candidat met à jour ses CV" on public.cvs
  for update using (candidat_id = auth.uid()) with check (candidat_id = auth.uid());

-- ─── fiches_cv ───
create policy "Le candidat lit sa fiche" on public.fiches_cv
  for select using (exists (select 1 from public.cvs
                            where cvs.id = fiches_cv.cv_id and cvs.candidat_id = auth.uid()));

create policy "Le recruteur lit les fiches des CV actifs" on public.fiches_cv
  for select using (public.est_recruteur()
                    and exists (select 1 from public.cvs where cvs.id = fiches_cv.cv_id and cvs.actif));

create policy "Le candidat corrige et valide sa fiche" on public.fiches_cv
  for update
  using (exists (select 1 from public.cvs where cvs.id = fiches_cv.cv_id and cvs.candidat_id = auth.uid()))
  with check (exists (select 1 from public.cvs where cvs.id = fiches_cv.cv_id and cvs.candidat_id = auth.uid()));

-- ─── contacts ───
create policy "Le recruteur lit ses contacts" on public.contacts
  for select using (recruteur_id = auth.uid());

create policy "Le candidat lit les contacts qui le concernent" on public.contacts
  for select using (candidat_id = auth.uid());

create policy "Le recruteur contacte un candidat" on public.contacts
  for insert with check (
    recruteur_id = auth.uid() and public.est_recruteur()
    and exists (select 1 from public.profils p where p.id = candidat_id and p.role = 'candidat')
  );

create policy "Le recruteur change le statut de ses contacts" on public.contacts
  for update using (recruteur_id = auth.uid()) with check (recruteur_id = auth.uid());

-- Le candidat peut seulement marquer un message comme lu (il ne peut pas changer le statut)
create or replace function public.marquer_contact_lu(contact_id bigint)
returns void
language sql security definer set search_path = public
as $$ update public.contacts set lu = true where id = contact_id and candidat_id = auth.uid() $$;

-- La date de mise à jour se remplit toute seule à chaque modification d'un contact
create or replace function public.maj_date_contact()
returns trigger
language plpgsql
as $$ begin new.mis_a_jour_le := now(); return new; end; $$;

create trigger trigger_maj_date_contact
  before update on public.contacts
  for each row execute function public.maj_date_contact();

-- ─── Le stockage des CV : un dossier privé « cvs » ───
-- Chaque candidat range ses fichiers dans son propre sous-dossier (son identifiant).
insert into storage.buckets (id, name, public) values ('cvs', 'cvs', false)
on conflict (id) do nothing;

create policy "Le candidat dépose ses fichiers" on storage.objects
  for insert with check (bucket_id = 'cvs' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Le candidat lit ses fichiers" on storage.objects
  for select using (bucket_id = 'cvs' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Le recruteur ouvre les CV" on storage.objects
  for select using (bucket_id = 'cvs' and public.est_recruteur());

-- ════════════════════════════════════════════════════════════════
--  Partie 5 : la recherche par le sens (utilisée seulement par le serveur Python)
-- ════════════════════════════════════════════════════════════════

-- Les passages de CV les plus proches d'une demande (le « sens » le plus proche en premier).
-- Seuls les CV actifs sont cherchés.
create or replace function public.passages_proches(vecteur vector(384), nombre int default 40)
returns table (cv_id bigint, contenu text, similarite double precision)
language sql stable
set search_path = public, extensions
as $$
  select m.cv_id, m.contenu, 1 - (m.embedding <=> vecteur) as similarite
  from public.cv_morceaux m
  join public.cvs c on c.id = m.cv_id
  where c.actif and m.embedding is not null
  order by m.embedding <=> vecteur
  limit nombre;
$$;

-- Réservée au serveur (clé de service) : le site ne peut pas l'appeler
revoke execute on function public.passages_proches(vector, int) from public, anon, authenticated;
grant execute on function public.passages_proches(vector, int) to service_role;


-- ════════════════════════════════════════════════════════════════
--  Mise à jour (déjà incluse plus haut pour une nouvelle base) :
--  les années d'expérience gardent 2 décimales, pour afficher les mois justes (« 4 mois », pas « 0,3 an »).
-- ════════════════════════════════════════════════════════════════
alter table public.fiches_cv alter column annees_experience type numeric(5, 2);
