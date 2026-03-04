# FabBoard

> ⚠️ **Projet en développement actif** — Phase 1.5 en cours

**Application Web d'affichage de données sous forme de slides paramétrables**

---

## 📋 Description

FabBoard est un tableau de bord TV pour Fablab permettant d'afficher des informations en temps réel via un système de slides configurables.

### Phase actuelle : 1.5 - Système de slides
- ✅ Éditeur de slides avec drag & drop
- ✅ Layouts configurables (grilles Windows 11-like)
- ✅ Widgets paramétrables
- ✅ Mode clair/sombre
- ✅ Interface de configuration

### Phases à venir
- **Phase 2** : Intégration Fabtrack (lecture seule)
- **Phase 3** : Intégration CalDAV (événements)
- **Phase 4** : Intégration Repetier Server (imprimantes 3D)

---

## 🚀 Démarrage rapide

### Prérequis
- Python 3.9+
- pip

### Installation

```bash
# Cloner le projet
git clone https://github.com/fablabloritz-coder/FabBoard.git
cd FabBoard

# Installer les dépendances
pip install -r requirements.txt

# Lancer l'application
python start.py
```

L'application sera accessible sur **http://localhost:5580**

---

## 📦 Structure du projet

```
fabboard/
├── app.py              # Application Flask principale
├── models.py           # Modèles et base de données
├── start.py           # Script de démarrage
├── templates/         # Templates Jinja2
├── static/            # CSS, JS, images
└── data/              # Base de données SQLite
```

---

## 🎨 Fonctionnalités actuelles

### Éditeur de slides
- Créer/modifier des slides personnalisées
- Choisir un layout (1×1, 2×1, 2×2, 3×2, etc.)
- Ajouter des widgets par drag & drop
- Définir le temps d'affichage de chaque slide

### Widgets disponibles
- 📊 Compteurs Fabtrack (à venir Phase 2)
- 📋 Activités Fabtrack (à venir Phase 2)
- 🕐 Horloge
- 📅 Calendrier CalDAV (à venir Phase 3)
- 🖨️ Imprimantes 3D (à venir Phase 4)
- 📝 Texte libre
- 🌤️ Météo

---

## 🛠️ Technologies

- **Backend** : Flask 3.1, SQLite
- **Frontend** : Bootstrap 5.3, JavaScript ES6
- **Drag & Drop** : SortableJS
- **API** : REST JSON

---

## 📝 Licence

Ce projet est développé pour le Fablab Loritz.

---

## 👥 Contributeurs

- Fablab Loritz Team

---

**Note** : Ce projet est en développement actif. Les fonctionnalités et l'API peuvent changer.
# Éditer .env avec vos URLs et clés API

# Démarrer avec Docker Compose
docker-compose up -d
```

FabBoard sera accessible sur `http://localhost:5580`

### Installation manuelle (développement)

```bash
# Créer un environnement virtuel
python -m venv .venv
source .venv/bin/activate  # Linux/Mac
.venv\Scripts\activate      # Windows

# Installer les dépendances
pip install -r requirements.txt

# Lancer l'application
python app.py
```

---

## 📊 Fonctionnalités

### Module Activités
- ✅ Création/modification/suppression d'activités
- ✅ Calcul automatique du niveau d'urgence (basé sur date d'expiration)
- ✅ Statuts : En attente → En cours → Terminé
- ✅ Filtrage par statut, urgence, date
- ✅ Compteurs journaliers et totaux

### Module Calendrier (Nextcloud)
- 📅 Synchronisation CalDAV automatique
- 📅 Affichage des N prochains événements
- 📅 Support récurrence

### Module Imprimantes 3D
- 🖨️ Repetier Server : état, progression, températures
- 🖨️ PrusaLink (à venir) : monitoring Prusa i3/XL
- 🖨️ Cartes visuelles par imprimante

### Module Fabtrack
- 📈 Statistiques du jour (interventions, poids 3D, surface découpe)
- 🔧 État des machines (disponible/réparation/HS)
- 📜 Dernières consommations

### Dashboard TV
- 🖥️ Affichage plein écran optimisé 1920×1080
- 🔄 Auto-refresh configurable (30-60s)
- 🌙 Mode sombre natif
- 📱 PWA mobile pour saisie rapide

---

## 🔌 API REST

### Activités

```
GET    /api/activites              Liste des activités (filtres: statut, urgence)
POST   /api/activites              Créer une activité
PUT    /api/activites/<id>         Modifier une activité
DELETE /api/activites/<id>         Supprimer une activité
PATCH  /api/activites/<id>/statut  Changer le statut rapidement
GET    /api/activites/compteurs    Compteurs (en_attente, en_cours, terminé)
```

### Dashboard

```
GET    /api/dashboard/data         Toutes les données agrégées pour le dashboard
GET    /api/sources                Liste des sources de données configurées
PUT    /api/sources/<id>           Modifier une source de données
```

---

## 🗄️ Modèle de données

```sql
activites            -- Activités manuelles (cœur du système)
├── id, titre, description, lieu
├── date_debut, date_fin, date_expiration, horaire
├── nature (Tâche, Maintenance, Formation, Événement, Commande)
├── niveau_urgence (auto, critique, urgent, normal, faible)
├── statut (en_attente, en_cours, termine, annule)
└── assignee, created_at, updated_at

sources              -- Configuration sources externes
├── id, nom, type (fabtrack, repetier, nextcloud_caldav, prusalink)
├── url, credentials_json, sync_interval_sec
└── actif, derniere_sync, derniere_erreur

evenements_calendrier -- Cache des événements Nextcloud
├── id, source_id, uid, titre, description, lieu
├── date_debut, date_fin, recurrence
└── dernier_refresh

parametres           -- Paramètres d'affichage
└── cle, valeur (refresh_interval, theme, fablab_name)
```

---

## 🛠️ Stack technique

| Composant | Technologie |
|-----------|------------|
| Backend | Flask 3.1 (Python 3.12) |
| Base de données | SQLite 3 (WAL mode) |
| Frontend | Bootstrap 5.3 + Vanilla JS |
| Graphiques | Chart.js 4.4.7 |
| Sync périodique | APScheduler 3.10 |
| Calendrier | CalDAV (librairie `caldav`) |
| API externe | `requests` |
| PWA | Service Worker + Manifest |
| Conteneurisation | Docker + Docker Compose |

---

## 🔧 Configuration

### Variables d'environnement (.env)

```env
# FabBoard
FABBOARD_PORT=5580
FABBOARD_SECRET=your-secret-here

# Fabtrack (API)
FABTRACK_URL=http://fabtrack:5555

# Repetier Server
REPETIER_URL=http://192.168.x.x:3344
REPETIER_APIKEY=

# Nextcloud CalDAV
NEXTCLOUD_CALDAV_URL=https://votre-nextcloud/remote.php/dav
NEXTCLOUD_USER=fablab
NEXTCLOUD_PASS=motdepasse
NEXTCLOUD_CALENDAR_NAME=fablab

# PrusaLink (optionnel)
PRUSALINK_URLS=http://192.168.x.x1,http://192.168.x.x2
PRUSALINK_APIKEYS=key1,key2
```

---

## 🐳 Docker Compose

Le fichier `docker-compose.yml` à la racine orchestre FabBoard et Fabtrack :

```yaml
services:
  fabtrack:
    build: ./fabtrack
    ports: ["5555:5555"]
    volumes: [fabtrack_data:/app/data]
    
  fabboard:
    build: ./fabboard
    ports: ["5580:5580"]
    volumes: [fabboard_data:/app/data]
    depends_on: [fabtrack]
    environment:
      - FABTRACK_URL=http://fabtrack:5555
```

---

## 📱 PWA (Progressive Web App)

FabBoard est installable sur Android :
1. Ouvrir `http://server-ip:5580` sur votre téléphone
2. Menu Chrome/Firefox → "Ajouter à l'écran d'accueil"
3. L'icône FabBoard apparaît comme une vraie app

Fonctionnalités hors-ligne : formulaire de saisie d'activités en attente de connexion.

---

## 🔒 Sécurité

- **Réseau privé** : Pas d'authentification (réseau Fablab privé)
- **Validation** : Tous les inputs utilisateurs sont validés/échappés
- **Injection SQL** : Requêtes paramétrées exclusivement
- **Sauvegardes** : Export/import base SQLite avec validation
- **CORS** : Activé uniquement pour les sources autorisées

---

## 🎨 Interface TV

Layout optimisé 1920×1080 en grille 3×2 :

```
┌─────────────┬─────────────────────┬──────────────────┐
│  COMPTEURS  │  PROCHAINES TÂCHES  │  CALENDRIER      │
├─────────────┼─────────────────────┼──────────────────┤
│  FABTRACK   │  IMPRIMANTES 3D     │  DERNIÈRES CONSO │
└─────────────┴─────────────────────┴──────────────────┘
```

Navigation :
- `/` — Dashboard TV (plein écran)
- `/activites` — Gestion des activités
- `/parametres` — Configuration sources & affichage

---

## 📝 Roadmap

### Phase 1 (en cours)
- [x] Structure projet & Docker
- [x] Base de données SQLite
- [x] API CRUD activités
- [x] Dashboard TV basique
- [x] Calcul auto urgence

### Phase 2
- [ ] Intégration Fabtrack (stats, état machines)
- [ ] Affichage cartes Fabtrack sur dashboard

### Phase 3
- [ ] Intégration Nextcloud CalDAV
- [ ] Sync événements calendrier

### Phase 4
- [ ] Intégration Repetier Server
- [ ] Cartes imprimantes 3D avec progression

### Phase 5
- [ ] PWA mobile (manifest, service worker)
- [ ] Vue mobile responsive

### Phase 6
- [ ] Support PrusaLink API
- [ ] Notifications push (optionnel)

---

## 📄 Licence

MIT — © 2026 Fablab Loritz

---

## 🤝 Projet lié

[Fabtrack](https://github.com/fablabloritz-coder/Fabtrack) — Application de suivi des consommations Fablab
