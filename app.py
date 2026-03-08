"""
FabBoard v1.0 — Application Flask principale
Tableau de bord TV pour Fablab
Phase 1.5 : Système de slides configurable
"""

from flask import Flask, render_template, request, jsonify, send_file
from jinja2 import TemplateNotFound
from werkzeug.utils import secure_filename
from models import (
    get_db, init_db, migrate_db,
    get_all_slides, get_slide_by_id, get_all_layouts, get_all_widgets_disponibles,
    get_theme, update_theme
)
from datetime import datetime, timedelta
import os
import json
import secrets
import re
import logging
import requests
from html import unescape
from urllib.parse import quote, urlparse, urljoin
from sync_worker import start_sync_worker, stop_sync_worker

app = Flask(__name__)

# Logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

# Configuration
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, 'data')
UPLOAD_DIR = os.path.join(BASE_DIR, 'static', 'uploads')
os.makedirs(UPLOAD_DIR, exist_ok=True)
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'}
ALLOWED_VIDEO_EXTENSIONS = {'mp4', 'webm', 'ogg'}
PORT = int(os.environ.get('FABBOARD_PORT', 5580))

# Limite de taille des uploads (16 Mo)
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024

# Cache statique : 1 heure pour les fichiers CSS/JS/images
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 3600

# Cache mémoire pour météo Open-Meteo (pas besoin de clé API)
_meteo_cache = {}  # {ville: {data, expires_at}}

# Cache mémoire pour la résolution des URLs GIF distantes
_gif_resolve_cache = {}  # {url: {resolved_url, expires_at}}

# ── Clé secrète : générée aléatoirement au premier lancement, persistée ──
_SECRET_KEY_PATH = os.path.join(DATA_DIR, 'secret_key.txt')


def _load_or_generate_secret_key():
    """Charge la clé secrète depuis le fichier, ou en génère une nouvelle."""
    os.makedirs(DATA_DIR, exist_ok=True)
    if os.path.exists(_SECRET_KEY_PATH):
        with open(_SECRET_KEY_PATH, 'r', encoding='utf-8') as f:
            key = f.read().strip()
            if len(key) >= 32:
                return key
    key = secrets.token_hex(32)
    with open(_SECRET_KEY_PATH, 'w', encoding='utf-8') as f:
        f.write(key)
    return key


app.secret_key = os.environ.get('FLASK_SECRET_KEY') or _load_or_generate_secret_key()

# Démarrer le sync worker au démarrage de l'app
try:
    print('[App] Démarrage du sync worker au startup...')
    start_sync_worker(poll_interval=10)
    print('[App] Sync worker démarré!')
except Exception as e:
    print(f'[App] Erreur démarrage worker: {e}')

# ============================================================
# ERROR HANDLERS
# ============================================================

@app.errorhandler(404)
def page_not_found(e):
    if request.path.startswith('/api/'):
        return jsonify({'error': 'Ressource introuvable'}), 404
    return render_template('base.html'), 404

@app.errorhandler(500)
def internal_error(e):
    logger.error('Erreur interne: %s', e)
    if request.path.startswith('/api/'):
        return jsonify({'error': 'Erreur interne du serveur'}), 500
    return render_template('base.html'), 500

@app.errorhandler(413)
def too_large(e):
    return jsonify({'success': False, 'error': 'Fichier trop volumineux (max 16 Mo)'}), 413

# ============================================================
# INIT
# ============================================================

_db_initialized = False

@app.before_request
def ensure_db():
    global _db_initialized
    if not _db_initialized:
        init_db()
        migrate_db()
        _auto_bootstrap_sources()
        _db_initialized = True


def _auto_bootstrap_sources():
    """
    Auto-détecte et crée automatiquement les sources connues au premier lancement.
    Ne crée que si aucune source de ce type n'existe déjà.
    """
    db = get_db()
    try:
        # ── Auto-détection Fabtrack ──
        existing_fabtrack = db.execute(
            "SELECT COUNT(*) as n FROM sources WHERE type = 'fabtrack'"
        ).fetchone()['n']

        if existing_fabtrack == 0:
            fabtrack_url = os.environ.get('FABTRACK_URL', 'http://localhost:5555').rstrip('/')
            actif = 0  # Inactif par défaut

            # Tester si Fabtrack est joignable
            try:
                resp = requests.get(f"{fabtrack_url}/api/stats/summary", timeout=3)
                if resp.status_code == 200:
                    actif = 1
                    print(f'[Bootstrap] Fabtrack détecté à {fabtrack_url} ✓')
                else:
                    print(f'[Bootstrap] Fabtrack trouvé mais erreur HTTP {resp.status_code}')
            except requests.RequestException:
                print(f'[Bootstrap] Fabtrack non disponible à {fabtrack_url} — source créée inactive')

            db.execute(
                '''INSERT INTO sources (nom, type, url, credentials_json, sync_interval_sec, actif)
                   VALUES (?, ?, ?, '{}', 30, ?)''',
                ('Fabtrack', 'fabtrack', fabtrack_url, actif)
            )
            db.commit()

    except Exception as e:
        print(f'[Bootstrap] Erreur auto-détection: {e}')
    finally:
        db.close()


# ============================================================
# HELPERS
# ============================================================

def row_to_dict(row):
    """Convertit une Row SQLite en dictionnaire."""
    return dict(row) if row else None

def rows_to_list(rows):
    """Convertit une liste de Row SQLite en liste de dictionnaires."""
    return [dict(r) for r in rows]

def get_cached_source_data(source_id):
    """
    Récupère les données en cache pour une source.
    
    Returns:
        dict ou None si pas de cache valide
    """
    db = get_db()
    try:
        row = db.execute(
            'SELECT data_json, expires_at FROM sources_cache WHERE source_id = ?',
            (source_id,)
        ).fetchone()
        
        if not row:
            return None
        
        # Retourner les données même si le cache est expiré (stale-while-revalidate)
        # Le sync_worker renouvellera le cache en tâche de fond
        return json.loads(row['data_json'])
    except Exception as e:
        print(f'[Cache] Erreur lecture cache source {source_id}: {e}')
        return None
    finally:
        db.close()


def _normalize_base_url(url):
    """Normalise une URL de base en supprimant le slash final."""
    if not url:
        return ''
    return url.strip().rstrip('/')


def _get_active_source_url(source_type):
    """Retourne l'URL d'une source active par type, sinon chaîne vide."""
    db = get_db()
    try:
        row = db.execute(
            'SELECT url FROM sources WHERE type = ? AND actif = 1 ORDER BY id LIMIT 1',
            (source_type,),
        ).fetchone()
        return _normalize_base_url(row['url']) if row else ''
    finally:
        db.close()


def _resolve_fabtrack_base_url():
    """Résout l'URL de Fabtrack via sources DB puis variable d'environnement."""
    from_db = _get_active_source_url('fabtrack')
    if from_db:
        return from_db
    from_env = os.environ.get('FABTRACK_URL', 'http://localhost:5555')
    return _normalize_base_url(from_env)


def _request_json(base_url, path, timeout=4):
    """Exécute une requête GET JSON et retourne (ok, data, erreur)."""
    url = f"{_normalize_base_url(base_url)}{path}"
    try:
        response = requests.get(url, timeout=timeout)
        response.raise_for_status()
        return True, response.json(), ''
    except requests.ConnectionError:
        return False, None, 'Service non disponible'
    except requests.Timeout:
        return False, None, 'Délai de réponse dépassé'
    except requests.RequestException as e:
        return False, None, str(e)


def _extract_fabtrack_payload(base_url):
    """Agrège les données nécessaires au dashboard depuis Fabtrack."""
    ok_summary, summary, err_summary = _request_json(base_url, '/api/stats/summary')
    ok_conso, conso, err_conso = _request_json(base_url, '/api/consommations?per_page=5&page=1')
    ok_ref, reference, _ = _request_json(base_url, '/api/reference')

    if not ok_summary and not ok_conso:
        return None, f"Fabtrack indisponible: {err_summary or err_conso}"

    summary = summary or {}
    conso = conso or {}
    reference = reference or {}

    machines = []
    if ok_ref and isinstance(reference, dict):
        for machine in (reference.get('machines') or []):
            machines.append({
                'id': machine.get('id'),
                'nom': machine.get('nom', 'Machine'),
                'statut': machine.get('statut', 'inconnu'),
                'actif': machine.get('actif', 1),
            })

    compteurs = {
        'interventions_total': summary.get('total_interventions', 0),
        'impression_3d_grammes': summary.get('total_3d_grammes', 0),
        'decoupe_m2': summary.get('total_decoupe_m2', 0),
        'papier_feuilles': summary.get('total_papier_feuilles', 0),
    }

    return {
        'compteurs': compteurs,
        'fabtrack_stats': summary,
        'activites': conso.get('data', []),
        'machines': machines,
        'source_url': base_url,
    }, ''


SUPPORTED_SOURCE_TYPES = {
    'fabtrack': {
        'label': 'Fabtrack',
        'description': 'Statistiques et consommations depuis Fabtrack',
        'default_url': 'http://localhost:5555',
    },
    'repetier': {
        'label': 'Repetier Server',
        'description': 'Etat des imprimantes 3D via API Repetier',
        'default_url': 'http://localhost:3344',
    },
    'nextcloud_caldav': {
        'label': 'Nextcloud CalDAV',
        'description': 'Evenements calendrier depuis Nextcloud',
        'default_url': 'https://cloud.exemple.fr/remote.php/dav/calendars/user/calendrier',
    },
    'prusalink': {
        'label': 'PrusaLink',
        'description': 'Etat des imprimantes Prusa via PrusaLink',
        'default_url': 'http://localhost:8080',
    },
    'openweathermap': {
        'label': 'OpenWeatherMap',
        'description': 'Donnees meteo pour widget meteo',
        'default_url': 'https://api.openweathermap.org',
    },
    'rss': {
        'label': 'Flux RSS',
        'description': 'Flux RSS/Atom externe',
        'default_url': 'https://example.com/feed.xml',
    },
    'http': {
        'label': 'HTTP/REST',
        'description': 'Endpoint HTTP generique',
        'default_url': 'https://api.example.com/data',
    },
}


def _decode_source_credentials(credentials_json):
    """Decode credentials JSON safely."""
    if not credentials_json:
        return {}
    try:
        parsed = json.loads(credentials_json)
        return parsed if isinstance(parsed, dict) else {}
    except (TypeError, ValueError):
        return {}


def _serialize_source_public(source_row):
    """Return a safe public source object without secrets."""
    source = dict(source_row)
    credentials = _decode_source_credentials(source.get('credentials_json'))
    has_credentials = any(str(v).strip() for v in credentials.values())

    source['credentials_json'] = '***' if has_credentials else '{}'
    source['has_credentials'] = has_credentials

    if source.get('derniere_erreur'):
        source['status'] = 'error'
    elif source.get('derniere_sync'):
        source['status'] = 'ok'
    else:
        source['status'] = 'never'

    return source


def _coerce_source_payload(data, existing=None):
    """Validate and normalize source payload for create/update."""
    if not isinstance(data, dict):
        return None, 'Payload JSON invalide'

    payload = {}

    if existing is None or 'nom' in data:
        nom = str(data.get('nom', '')).strip()
        if not nom:
            return None, "Le champ 'nom' est requis"
        payload['nom'] = nom
    else:
        payload['nom'] = existing['nom']

    if existing is None or 'type' in data:
        source_type = str(data.get('type', '')).strip().lower()
        if source_type not in SUPPORTED_SOURCE_TYPES:
            allowed = ', '.join(sorted(SUPPORTED_SOURCE_TYPES.keys()))
            return None, f"Type invalide. Types autorises: {allowed}"
        payload['type'] = source_type
    else:
        payload['type'] = existing['type']

    if existing is None or 'url' in data:
        url = _normalize_base_url(str(data.get('url', '')).strip())
        if not url:
            return None, "Le champ 'url' est requis"
        if not (url.startswith('http://') or url.startswith('https://')):
            return None, "L'URL doit commencer par http:// ou https://"
        payload['url'] = url
    else:
        payload['url'] = existing['url']

    raw_interval = data.get('sync_interval_sec', existing['sync_interval_sec'] if existing else 60)
    try:
        sync_interval = int(raw_interval)
    except (TypeError, ValueError):
        return None, "'sync_interval_sec' doit etre un entier"

    if sync_interval < 10 or sync_interval > 3600:
        return None, "'sync_interval_sec' doit etre compris entre 10 et 3600"
    payload['sync_interval_sec'] = sync_interval

    raw_actif = data.get('actif', existing['actif'] if existing else 1)
    if isinstance(raw_actif, bool):
        payload['actif'] = 1 if raw_actif else 0
    else:
        try:
            payload['actif'] = 1 if int(raw_actif) == 1 else 0
        except (TypeError, ValueError):
            payload['actif'] = 0

    if 'credentials' in data:
        credentials = data.get('credentials') or {}
        if not isinstance(credentials, dict):
            return None, "Le champ 'credentials' doit etre un objet JSON"
    elif existing:
        credentials = _decode_source_credentials(existing.get('credentials_json'))
    else:
        credentials = {}

    payload['credentials_json'] = json.dumps(credentials)
    return payload, ''


# ============================================================
# PAGES
# ============================================================

@app.route('/')
def dashboard():
    """Page principale : dashboard TV plein écran."""
    return render_template('dashboard.html', page='dashboard')

@app.route('/slides')
def slides():
    """Page de configuration des slides (Phase 1.5)."""
    return render_template('slides.html', page='slides')

@app.route('/test-api')
def test_api():
    """Page de test des API."""
    return render_template('test_api.html')

@app.route('/parametres')
def parametres():
    """Page de configuration."""
    return render_template('parametres.html', page='parametres')

@app.route('/medias')
def medias():
    """Page de gestion des médias (images et vidéos)."""
    return render_template('medias.html', page='medias')


# ============================================================
# API — DASHBOARD
# ============================================================

@app.route('/api/dashboard/data')
def api_dashboard_data():
    """
    Retourne les données agrégées pour le dashboard TV.
    Phase 3 : Lit depuis le cache sync_worker, avec fallback direct.
    """
    db = get_db()
    try:
        # ── Fabtrack : chercher dans le cache d'abord ──
        fabtrack_source = db.execute(
            'SELECT id, url FROM sources WHERE type = ? AND actif = 1 ORDER BY id LIMIT 1',
            ('fabtrack',)
        ).fetchone()

        fabtrack_data = None
        fabtrack_error = ''
        fabtrack_url = ''

        if fabtrack_source:
            fabtrack_url = _normalize_base_url(fabtrack_source['url'])
            cached = get_cached_source_data(fabtrack_source['id'])
            if cached:
                fabtrack_data = cached
            else:
                # Fallback : appel direct (le cache n'est peut-être pas encore prêt)
                payload, err = _extract_fabtrack_payload(fabtrack_url)
                if payload:
                    fabtrack_data = {
                        'summary': payload.get('fabtrack_stats', {}),
                        'consommations': payload.get('activites', []),
                        'machines': payload.get('machines', []),
                    }
                else:
                    fabtrack_error = err
        else:
            # Pas de source configurée, essayer l'URL env
            base_url = _resolve_fabtrack_base_url()
            fabtrack_url = base_url
            payload, err = _extract_fabtrack_payload(base_url)
            if payload:
                fabtrack_data = {
                    'summary': payload.get('fabtrack_stats', {}),
                    'consommations': payload.get('activites', []),
                    'machines': payload.get('machines', []),
                }
            else:
                fabtrack_error = err

        # Normaliser les données Fabtrack
        summary = (fabtrack_data or {}).get('summary', {})
        activites = (fabtrack_data or {}).get('consommations', [])
        machines = (fabtrack_data or {}).get('machines', [])
        compteurs = {
            'interventions_total': summary.get('total_interventions', 0),
            'impression_3d_grammes': summary.get('total_3d_grammes', 0),
            'decoupe_m2': summary.get('total_decoupe_m2', 0),
            'papier_feuilles': summary.get('total_papier_feuilles', 0),
        }

        # ── Calendrier : depuis le cache CalDAV (avec fallback direct) ──
        evenements = []
        caldav_source = db.execute(
            'SELECT id, url, credentials_json FROM sources WHERE type = ? AND actif = 1 ORDER BY id LIMIT 1',
            ('nextcloud_caldav',)
        ).fetchone()
        if caldav_source:
            cal_cached = get_cached_source_data(caldav_source['id'])
            if cal_cached and isinstance(cal_cached, dict):
                evenements = cal_cached.get('events', [])
            else:
                # Fallback : appel direct si le cache n'est pas encore prêt
                try:
                    from sync_worker import SyncWorker
                    creds = json.loads(caldav_source['credentials_json'] or '{}')
                    cal_data, cal_err = SyncWorker._fetch_caldav_static(
                        caldav_source['url'], creds
                    )
                    if cal_data:
                        evenements = cal_data.get('events', [])
                    elif cal_err:
                        print(f'[CalDAV fallback] {cal_err}')
                except Exception as e:
                    print(f'[CalDAV fallback] Erreur: {e}')

        # ── Imprimantes : depuis le cache Repetier/PrusaLink ──
        imprimantes = []
        for ptype in ('repetier', 'prusalink'):
            printer_source = db.execute(
                'SELECT id FROM sources WHERE type = ? AND actif = 1 ORDER BY id LIMIT 1',
                (ptype,)
            ).fetchone()
            if printer_source:
                pr_cached = get_cached_source_data(printer_source['id'])
                if pr_cached and isinstance(pr_cached, dict):
                    imprimantes.extend(pr_cached.get('printers', []))

        return jsonify({
            'activites': activites,
            'compteurs': compteurs,
            'evenements': evenements,
            'fabtrack_stats': summary,
            'imprimantes': imprimantes,
            'machines': machines,
            'fabtrack_url': fabtrack_url,
            'fabtrack_error': fabtrack_error,
            'timestamp': datetime.now().isoformat(),
        })
    finally:
        db.close()


@app.route('/api/sources/by-type/<source_type>')
def api_sources_by_type(source_type):
    """Liste les sources actives d'un type donné (pour les sélecteurs de widgets)."""
    db = get_db()
    try:
        rows = db.execute(
            'SELECT id, nom, type, url, actif, derniere_sync, derniere_erreur FROM sources WHERE type = ? ORDER BY actif DESC, nom',
            (source_type,)
        ).fetchall()
        sources = [dict(r) for r in rows]
        return jsonify({'success': True, 'data': sources})
    finally:
        db.close()


# ============================================================
# API — PARAMÈTRES
# ============================================================

@app.route('/api/parametres')
def api_get_parametres():
    """Retourne tous les paramètres."""
    db = get_db()
    try:
        params = rows_to_list(db.execute('SELECT * FROM parametres').fetchall())
        # Convertir en dictionnaire {cle: valeur}
        return jsonify({p['cle']: p['valeur'] for p in params})
    finally:
        db.close()


@app.route('/api/parametres/<cle>', methods=['PUT'])
def api_update_parametre(cle):
    """Modifier un paramètre."""
    db = get_db()
    try:
        data = request.get_json()
        valeur = data.get('valeur', '')
        
        db.execute('''
            INSERT INTO parametres (cle, valeur) VALUES (?, ?)
            ON CONFLICT(cle) DO UPDATE SET valeur = ?
        ''', (cle, valeur, valeur))
        
        db.commit()
        return jsonify({'success': True, 'cle': cle, 'valeur': valeur})
    except Exception as e:
        db.rollback()
        return jsonify({'error': str(e)}), 500
    finally:
        db.close()


# ============================================================
# API — SOURCES DE DONNÉES
# ============================================================

@app.route('/api/sources')
def api_get_sources():
    """Liste toutes les sources de données configurées."""
    db = get_db()
    try:
        rows = db.execute('SELECT * FROM sources ORDER BY actif DESC, nom').fetchall()
        sources = [_serialize_source_public(row) for row in rows]
        return jsonify({'success': True, 'data': sources})
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        db.close()


@app.route('/api/sources/types', methods=['GET'])
def api_get_source_types():
    """Liste les types de sources supportés et leurs métadonnées."""
    data = [
        {
            'code': code,
            'label': meta['label'],
            'description': meta['description'],
            'default_url': meta['default_url'],
        }
        for code, meta in SUPPORTED_SOURCE_TYPES.items()
    ]
    return jsonify({'success': True, 'data': data})


@app.route('/api/sources', methods=['POST'])
def api_create_source():
    """Créer une nouvelle source de données."""
    db = get_db()
    try:
        data = request.get_json() or {}
        payload, error = _coerce_source_payload(data)
        if error:
            return jsonify({'error': error}), 400
        
        cursor = db.execute('''
            INSERT INTO sources (nom, type, url, credentials_json, sync_interval_sec, actif)
            VALUES (?, ?, ?, ?, ?, ?)
        ''', (
            payload['nom'],
            payload['type'],
            payload['url'],
            payload['credentials_json'],
            payload['sync_interval_sec'],
            payload['actif']
        ))
        
        db.commit()
        source_id = cursor.lastrowid
        
        source = db.execute('SELECT * FROM sources WHERE id = ?', (source_id,)).fetchone()
        return jsonify({'success': True, 'data': _serialize_source_public(source)}), 201
    except Exception as e:
        db.rollback()
        return jsonify({'error': str(e)}), 500
    finally:
        db.close()


@app.route('/api/sources/<int:id>', methods=['PUT'])
def api_update_source(id):
    """Modifier une source de données."""
    db = get_db()
    try:
        data = request.get_json() or {}
        
        existing = db.execute('SELECT * FROM sources WHERE id = ?', (id,)).fetchone()
        if not existing:
            return jsonify({'error': 'Source non trouvée'}), 404

        existing = dict(existing)
        payload, error = _coerce_source_payload(data, existing=existing)
        if error:
            return jsonify({'error': error}), 400
        
        db.execute('''
            UPDATE sources SET
                nom = ?, type = ?, url = ?, credentials_json = ?,
                sync_interval_sec = ?, actif = ?
            WHERE id = ?
        ''', (
            payload['nom'],
            payload['type'],
            payload['url'],
            payload['credentials_json'],
            payload['sync_interval_sec'],
            payload['actif'],
            id
        ))
        
        db.commit()
        
        source = db.execute('SELECT * FROM sources WHERE id = ?', (id,)).fetchone()
        return jsonify({'success': True, 'data': _serialize_source_public(source)})
    except Exception as e:
        db.rollback()
        return jsonify({'error': str(e)}), 500
    finally:
        db.close()


@app.route('/api/sources/<int:id>', methods=['DELETE'])
def api_delete_source(id):
    """Supprimer une source de données."""
    db = get_db()
    try:
        result = db.execute('DELETE FROM sources WHERE id = ?', (id,))
        db.commit()
        
        if result.rowcount == 0:
            return jsonify({'error': 'Source non trouvée'}), 404
        
        return jsonify({'success': True})
    except Exception as e:
        db.rollback()
        return jsonify({'error': str(e)}), 500
    finally:
        db.close()


@app.route('/api/sources/<int:id>/test', methods=['POST'])
def api_test_source(id):
    """Teste la connectivité d'une source configurée."""
    db = get_db()
    try:
        source = db.execute('SELECT * FROM sources WHERE id = ?', (id,)).fetchone()
        if not source:
            return jsonify({'error': 'Source non trouvée'}), 404

        source = dict(source)
        base_url = _normalize_base_url(source.get('url', ''))
        credentials = _decode_source_credentials(source.get('credentials_json'))

        def _mark_test_result(success, error_message=''):
            if success:
                db.execute(
                    "UPDATE sources SET derniere_sync = datetime('now','localtime'), derniere_erreur = '' WHERE id = ?",
                    (id,),
                )
            else:
                db.execute(
                    "UPDATE sources SET derniere_erreur = ? WHERE id = ?",
                    (error_message[:500], id),
                )
            db.commit()

        if source['type'] == 'fabtrack':
            ok, data, err = _request_json(base_url, '/api/stats/summary')
            if not ok:
                _mark_test_result(False, err)
                return jsonify({'success': False, 'error': err, 'url': base_url}), 400

            _mark_test_result(True)
            return jsonify({
                'success': True,
                'url': base_url,
                'summary': {
                    'total_interventions': data.get('total_interventions', 0),
                    'total_3d_grammes': data.get('total_3d_grammes', 0),
                    'total_decoupe_m2': data.get('total_decoupe_m2', 0),
                },
            })

        if source['type'] == 'openweathermap':
            apikey = credentials.get('apikey') or credentials.get('api_key')
            city = str(credentials.get('city') or 'Nancy,FR').strip()

            if not apikey:
                error = "Credential manquant: apikey requis pour OpenWeatherMap"
                _mark_test_result(False, error)
                return jsonify({'success': False, 'error': error}), 400

            path = f"/data/2.5/weather?q={quote(city)}&appid={quote(str(apikey))}&units=metric&lang=fr"
            ok, data, err = _request_json(base_url, path)
            if not ok:
                _mark_test_result(False, err)
                return jsonify({'success': False, 'error': err, 'url': base_url}), 400

            _mark_test_result(True)
            return jsonify({
                'success': True,
                'url': base_url,
                'summary': {
                    'city': data.get('name', city),
                    'temperature': data.get('main', {}).get('temp'),
                    'conditions': (data.get('weather') or [{}])[0].get('description', ''),
                },
            })

        # Test HTTP générique pour les autres types
        headers = {}
        if credentials.get('apikey'):
            headers['Authorization'] = f"Bearer {credentials['apikey']}"

        auth_user = credentials.get('username') or credentials.get('user')
        auth_pass = credentials.get('password') or credentials.get('pass')
        auth = (auth_user, auth_pass) if auth_user and auth_pass else None

        try:
            response = requests.get(
                base_url,
                timeout=6,
                headers=headers or None,
                auth=auth,
            )
            if response.status_code >= 400:
                err = f"HTTP {response.status_code}"
                _mark_test_result(False, err)
                return jsonify({'success': False, 'error': err, 'url': base_url}), 400

            _mark_test_result(True)
            return jsonify({
                'success': True,
                'url': base_url,
                'summary': {
                    'status_code': response.status_code,
                    'type': source['type'],
                },
            })
        except requests.RequestException as e:
            err = str(e)
            _mark_test_result(False, err)
            return jsonify({'success': False, 'error': err, 'url': base_url}), 400

    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        db.close()


@app.route('/api/sources/<int:id>/resync', methods=['POST'])
def api_resync_source(id):
    """Force une re-synchronisation immédiate d'une source."""
    db = get_db()
    try:
        source = db.execute('SELECT id FROM sources WHERE id = ?', (id,)).fetchone()
        if not source:
            return jsonify({'error': 'Source non trouvée'}), 404

        # Réinitialiser derniere_sync pour forcer le sync_worker à rafraîchir
        db.execute(
            "UPDATE sources SET derniere_sync = NULL WHERE id = ?",
            (id,),
        )
        # Supprimer le cache pour forcer un fetch frais
        db.execute('DELETE FROM sources_cache WHERE source_id = ?', (id,))
        db.commit()
        return jsonify({'success': True})
    except Exception as e:
        db.rollback()
        return jsonify({'error': str(e)}), 500
    finally:
        db.close()


# ============================================================
# API — CACHE ET WORKER (Phase 3)
# ============================================================

@app.route('/api/worker/status', methods=['GET'])
def api_worker_status():
    """Retourne l'état du sync worker et des caches sources."""
    from sync_worker import get_sync_worker, start_sync_worker
    
    try:
        worker = get_sync_worker()
        
        # Si le worker n'existe pas encore, le démarrer
        if not worker:
            worker = start_sync_worker(poll_interval=10)
        
        db = get_db()
        
        # Récupérer l'état de toutes les sources
        sources = db.execute('SELECT id, nom, type, actif, sync_interval_sec, derniere_sync, derniere_erreur FROM sources ORDER BY id').fetchall()
        
        sources_status = []
        for source in sources:
            source_dict = dict(source)
            
            # Récupérer l'info cache
            cache_row = db.execute(
                'SELECT expires_at, fetched_at FROM sources_cache WHERE source_id = ?',
                (source['id'],)
            ).fetchone()
            
            source_dict['cache_valid'] = cache_row is not None
            if cache_row:
                source_dict['cache_expires_at'] = cache_row['expires_at']
                source_dict['cache_fetched_at'] = cache_row['fetched_at']
            
            sources_status.append(source_dict)
        
        db.close()
        
        worker_info = 'None'
        worker_running = False
        worker_poll_interval = None
        
        if worker:
            worker_running = worker.running
            worker_poll_interval = worker.poll_interval
            worker_info = f'<SyncWorker running={worker_running}>'
        
        return jsonify({
            'success': True,
            'worker_running': worker_running,
            'worker_poll_interval': worker_poll_interval,
            '_debug_worker': worker_info,
            'sources': sources_status,
        })
    except Exception as e:
        import traceback
        return jsonify({
            'error': str(e),
            'traceback': traceback.format_exc()
        }), 500


@app.route('/api/cache/<int:source_id>', methods=['GET'])
def api_get_cache(source_id):
    """Récupère les données en cache pour une source."""
    try:
        data = get_cached_source_data(source_id)
        
        if data is None:
            return jsonify({'error': 'Pas de cache valide pour cette source'}), 404
        
        return jsonify({'success': True, 'data': data})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/cache', methods=['DELETE'])
def api_cleanup_cache():
    """Nettoie les caches expirés."""
    try:
        db = get_db()
        
        # Supprimer les caches expirés
        from datetime import datetime
        result = db.execute(
            'DELETE FROM sources_cache WHERE expires_at < ?',
            (datetime.now().isoformat(),)
        )
        db.commit()
        
        count = result.rowcount
        db.close()
        
        return jsonify({
            'success': True,
            'cleaned': count,
            'message': f'Supprimé {count} cache(s) expiré(s)'
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/cache/<int:source_id>/refresh', methods=['POST'])
def api_refresh_cache(source_id):
    """Force la synchronisation d'une source (très bientôt)."""
    try:
        from sync_worker import get_sync_worker
        
        db = get_db()
        source = db.execute('SELECT * FROM sources WHERE id = ?', (source_id,)).fetchone()
        db.close()
        
        if not source:
            return jsonify({'error': 'Source non trouvée'}), 404
        
        worker = get_sync_worker()
        if not worker or not worker.running:
            return jsonify({
                'error': 'Worker non actif',
                'hint': 'Le worker de sync n\'est pas actif. Les caches seront mis à jour lors du prochain cycle de polling.'
            }), 503
        
        # Forcer la synchronisation en réinitialisant derniere_sync et le cache
        db = get_db()
        db.execute('UPDATE sources SET derniere_sync = NULL WHERE id = ?', (source_id,))
        db.execute('DELETE FROM sources_cache WHERE source_id = ?', (source_id,))
        db.commit()
        db.close()
        
        return jsonify({
            'success': True,
            'message': 'Sync forcée demandée pour la prochaine pollarisation'
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ============================================================
# API — SLIDES (Phase 1.5)
# ============================================================

@app.route('/api/slides', methods=['GET'])
def api_get_slides():
    """Liste toutes les slides."""
    try:
        include_inactive = request.args.get('include_inactive', 'false').lower() == 'true'
        slides = get_all_slides(include_inactive)
        return jsonify({'success': True, 'data': slides})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/slides/<int:id>', methods=['GET'])
def api_get_slide(id):
    """Récupère une slide par ID."""
    try:
        slide = get_slide_by_id(id)
        if not slide:
            return jsonify({'error': 'Slide non trouvée'}), 404
        return jsonify({'success': True, 'data': slide})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/slides', methods=['POST'])
def api_create_slide():
    """Crée une nouvelle slide."""
    db = get_db()
    try:
        data = request.get_json()
        
        # Validation
        if not data.get('nom') or not data.get('layout_id'):
            return jsonify({'error': 'Nom et layout_id requis'}), 400
        
        # Trouver le prochain ordre
        max_ordre = db.execute('SELECT MAX(ordre) as max FROM slides').fetchone()['max']
        ordre = (max_ordre or 0) + 1
        
        cursor = db.execute('''
            INSERT INTO slides (nom, layout_id, ordre, temps_affichage, actif, fond_type, fond_valeur)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        ''', (
            data['nom'],
            data['layout_id'],
            ordre,
            data.get('temps_affichage', 30),
            data.get('actif', 1),
            data.get('fond_type', 'defaut'),
            data.get('fond_valeur', '')
        ))
        
        slide_id = cursor.lastrowid
        
        # Ajouter les widgets si fournis
        if 'widgets' in data and isinstance(data['widgets'], list):
            for widget_data in data['widgets']:
                db.execute('''
                    INSERT INTO slide_widgets (slide_id, widget_id, position, config_json)
                    VALUES (?, ?, ?, ?)
                ''', (
                    slide_id,
                    widget_data['widget_id'],
                    widget_data['position'],
                    json.dumps(widget_data.get('config', {}))
                ))
        
        db.commit()
        
        # Retourner la slide créée
        slide = get_slide_by_id(slide_id)
        return jsonify({'success': True, 'data': slide}), 201
    except Exception as e:
        db.rollback()
        return jsonify({'error': str(e)}), 500
    finally:
        db.close()


@app.route('/api/slides/<int:id>', methods=['PUT'])
def api_update_slide(id):
    """Met à jour une slide."""
    db = get_db()
    try:
        data = request.get_json()
        
        existing = db.execute('SELECT * FROM slides WHERE id = ?', (id,)).fetchone()
        if not existing:
            return jsonify({'error': 'Slide non trouvée'}), 404
        
        # Mettre à jour la slide
        db.execute('''
            UPDATE slides SET
                nom = ?, layout_id = ?, temps_affichage = ?, actif = ?,
                fond_type = ?, fond_valeur = ?,
                updated_at = datetime('now','localtime')
            WHERE id = ?
        ''', (
            data.get('nom', existing['nom']),
            data.get('layout_id', existing['layout_id']),
            data.get('temps_affichage', existing['temps_affichage']),
            data.get('actif', existing['actif']),
            data.get('fond_type', existing['fond_type'] or 'defaut'),
            data.get('fond_valeur', existing['fond_valeur'] or ''),
            id
        ))
        
        # Mettre à jour les widgets si fournis
        if 'widgets' in data and isinstance(data['widgets'], list):
            # Valider : dédupliquer par position (garder le dernier)
            layout = db.execute('SELECT grille_json FROM layouts WHERE id = ?',
                                (data.get('layout_id', existing['layout_id']),)).fetchone()
            max_positions = len(json.loads(layout['grille_json'])) if layout else 999
            
            seen_positions = {}
            for widget_data in data['widgets']:
                pos = widget_data['position']
                if pos < max_positions:
                    seen_positions[pos] = widget_data
            
            # Supprimer les anciens widgets
            db.execute('DELETE FROM slide_widgets WHERE slide_id = ?', (id,))
            
            # Ajouter les nouveaux (dédupliqués, positions valides)
            for widget_data in seen_positions.values():
                db.execute('''
                    INSERT INTO slide_widgets (slide_id, widget_id, position, config_json)
                    VALUES (?, ?, ?, ?)
                ''', (
                    id,
                    widget_data['widget_id'],
                    widget_data['position'],
                    json.dumps(widget_data.get('config', {}))
                ))
        
        db.commit()
        
        # Retourner la slide mise à jour
        slide = get_slide_by_id(id)
        return jsonify({'success': True, 'data': slide})
    except Exception as e:
        db.rollback()
        return jsonify({'error': str(e)}), 500
    finally:
        db.close()


@app.route('/api/slides/<int:id>', methods=['DELETE'])
def api_delete_slide(id):
    """Supprime une slide."""
    db = get_db()
    try:
        result = db.execute('DELETE FROM slides WHERE id = ?', (id,))
        db.commit()
        
        if result.rowcount == 0:
            return jsonify({'error': 'Slide non trouvée'}), 404
        
        return jsonify({'success': True})
    except Exception as e:
        db.rollback()
        return jsonify({'error': str(e)}), 500
    finally:
        db.close()


@app.route('/api/slides/reorder', methods=['PATCH'])
def api_reorder_slides():
    """Réordonne les slides."""
    db = get_db()
    try:
        data = request.get_json()
        
        if not data.get('order') or not isinstance(data['order'], list):
            return jsonify({'error': 'Format invalide, attendu : {"order": [id1, id2, ...]}'}), 400
        
        # Mettre à jour l'ordre de chaque slide
        for index, slide_id in enumerate(data['order']):
            db.execute('UPDATE slides SET ordre = ? WHERE id = ?', (index + 1, slide_id))
        
        db.commit()
        return jsonify({'success': True})
    except Exception as e:
        db.rollback()
        return jsonify({'error': str(e)}), 500
    finally:
        db.close()


@app.route('/api/slides/all', methods=['DELETE'])
def api_delete_all_slides():
    """Supprime toutes les slides et leurs widgets associés."""
    db = get_db()
    try:
        db.execute('DELETE FROM slide_widgets')
        db.execute('DELETE FROM slides')
        db.commit()
        return jsonify({'success': True})
    except Exception as e:
        db.rollback()
        return jsonify({'error': str(e)}), 500
    finally:
        db.close()


# ============================================================
# API — LAYOUTS & WIDGETS
# ============================================================

@app.route('/api/layouts', methods=['GET'])
def api_get_layouts():
    """Liste tous les layouts disponibles."""
    try:
        layouts = get_all_layouts()
        return jsonify({'success': True, 'data': layouts})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/widgets', methods=['GET'])
def api_get_widgets():
    """Liste tous les widgets disponibles."""
    try:
        widgets = get_all_widgets_disponibles()
        return jsonify({'success': True, 'data': widgets})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ============================================================
# API — RENDU DES WIDGETS (Phase 1)
# ============================================================

@app.route('/api/widgets/<code>/render', methods=['POST'])
def api_render_widget(code):
    """
    Rend le template HTML d'un widget avec sa configuration.
    Body JSON: { "config": {...}, "source_id": 123, "widget_id": "slide1-pos0" }
    """
    try:
        data = request.get_json() or {}
        config = data.get('config', {})
        source_id = data.get('source_id')
        widget_id = str(data.get('widget_id') or f"{code}-{int(datetime.now().timestamp() * 1000)}")
        
        # Vérifier que le widget existe
        db = get_db()
        try:
            widget = db.execute(
                'SELECT * FROM widgets_disponibles WHERE code = ?',
                (code,)
            ).fetchone()
            
            if not widget:
                return jsonify({'error': f'Widget {code} non trouvé'}), 404
            
            # Rendre le template
            html = render_template(
                f'widgets/{code}.html',
                config=config,
                source_id=source_id,
                widget_id=widget_id,
                widget=dict(widget)
            )
            
            return jsonify({'success': True, 'html': html})
        finally:
            db.close()

    except TemplateNotFound:
        return jsonify({'error': f"Template manquant pour le widget '{code}'"}), 404
            
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/widget-data/<int:source_id>')
def api_get_widget_data(source_id):
    """
    Récupère les données cachées d'une source pour un widget.
    Phase 3 : Lecture depuis sources_cache (alimenté par sync_worker).
    """
    db = get_db()
    try:
        # Vérifier que la source existe
        source = db.execute('SELECT id, type, nom, url FROM sources WHERE id = ?', (source_id,)).fetchone()
        if not source:
            return jsonify({'error': 'Source non trouvée'}), 404

        # Lire le cache
        cached = get_cached_source_data(source_id)
        if cached is not None:
            return jsonify({
                'success': True,
                'data': cached,
                'source_type': source['type'],
                'source_nom': source['nom'],
            })

        # Pas de cache valide
        return jsonify({
            'success': False,
            'error': 'Pas de données en cache. Vérifiez que la source est active et synchronisée.',
            'source_type': source['type'],
            'source_nom': source['nom'],
        }), 404

    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        db.close()


# ============================================================
# API — UPLOAD D'IMAGES
# ============================================================

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


def allowed_video_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_VIDEO_EXTENSIONS


@app.route('/api/upload', methods=['POST'])
def api_upload():
    """Upload une image pour les widgets ou les fonds de slide."""
    if 'file' not in request.files:
        return jsonify({'error': 'Aucun fichier envoyé'}), 400

    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'Nom de fichier vide'}), 400

    if not allowed_file(file.filename):
        return jsonify({'error': 'Type de fichier non autorisé. Extensions acceptées : ' + ', '.join(ALLOWED_EXTENSIONS)}), 400

    # Nom unique pour éviter les collisions
    ext = secure_filename(file.filename).rsplit('.', 1)[1].lower()
    unique_name = f"{secrets.token_hex(8)}.{ext}"
    filepath = os.path.join(UPLOAD_DIR, unique_name)
    file.save(filepath)

    url = f"/static/uploads/{unique_name}"
    return jsonify({'success': True, 'url': url, 'filename': unique_name})


@app.route('/api/upload-video', methods=['POST'])
def api_upload_video():
    """Upload une vidéo pour le widget vidéo."""
    if 'file' not in request.files:
        return jsonify({'error': 'Aucun fichier envoyé'}), 400

    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'Nom de fichier vide'}), 400

    if not allowed_video_file(file.filename):
        return jsonify({'error': 'Type de fichier non autorisé. Extensions acceptées : ' + ', '.join(ALLOWED_VIDEO_EXTENSIONS)}), 400

    ext = secure_filename(file.filename).rsplit('.', 1)[1].lower()
    unique_name = f"{secrets.token_hex(8)}.{ext}"
    filepath = os.path.join(UPLOAD_DIR, unique_name)
    file.save(filepath)

    url = f"/static/uploads/{unique_name}"
    return jsonify({'success': True, 'url': url, 'filename': unique_name})


# ============================================================
# API — GESTION DES MÉDIAS
# ============================================================

@app.route('/api/medias')
def api_list_medias():
    """Liste tous les fichiers uploadés (images et vidéos)."""
    medias = []
    if os.path.isdir(UPLOAD_DIR):
        for fname in sorted(os.listdir(UPLOAD_DIR)):
            fpath = os.path.join(UPLOAD_DIR, fname)
            if not os.path.isfile(fpath):
                continue
            ext = fname.rsplit('.', 1)[-1].lower() if '.' in fname else ''
            if ext in ALLOWED_EXTENSIONS:
                media_type = 'image'
            elif ext in ALLOWED_VIDEO_EXTENSIONS:
                media_type = 'video'
            else:
                continue
            size = os.path.getsize(fpath)
            medias.append({
                'filename': fname,
                'url': f'/static/uploads/{fname}',
                'type': media_type,
                'size': size,
            })
    return jsonify({'success': True, 'data': medias})


@app.route('/api/medias/<filename>', methods=['DELETE'])
def api_delete_media(filename):
    """Supprime un fichier uploadé."""
    safe_name = secure_filename(filename)
    fpath = os.path.join(UPLOAD_DIR, safe_name)
    if not os.path.isfile(fpath):
        return jsonify({'error': 'Fichier non trouvé'}), 404
    os.remove(fpath)
    return jsonify({'success': True})


# ============================================================
# API — MISSIONS (Kanban)
# ============================================================

@app.route('/api/missions')
def api_get_missions():
    """Liste toutes les missions."""
    db = get_db()
    try:
        rows = db.execute('SELECT * FROM missions ORDER BY statut, ordre, id').fetchall()
        return jsonify({'success': True, 'data': [dict(r) for r in rows]})
    finally:
        db.close()


@app.route('/api/missions', methods=['POST'])
def api_create_mission():
    """Crée une nouvelle mission."""
    data = request.get_json()
    if not data or not data.get('titre', '').strip():
        return jsonify({'error': "Le titre est requis"}), 400

    db = get_db()
    try:
        c = db.execute(
            '''INSERT INTO missions (titre, description, statut, priorite, ordre)
               VALUES (?, ?, ?, ?, ?)''',
            (
                data['titre'].strip(),
                data.get('description', '').strip(),
                data.get('statut', 'a_faire'),
                int(data.get('priorite', 0)),
                int(data.get('ordre', 0)),
            )
        )
        db.commit()
        mission = db.execute('SELECT * FROM missions WHERE id = ?', (c.lastrowid,)).fetchone()
        return jsonify({'success': True, 'data': dict(mission)}), 201
    finally:
        db.close()


@app.route('/api/missions/<int:mission_id>', methods=['PUT'])
def api_update_mission(mission_id):
    """Met à jour une mission."""
    data = request.get_json()
    if not data:
        return jsonify({'error': 'Payload JSON requis'}), 400

    db = get_db()
    try:
        existing = db.execute('SELECT * FROM missions WHERE id = ?', (mission_id,)).fetchone()
        if not existing:
            return jsonify({'error': 'Mission non trouvée'}), 404

        titre = data.get('titre', existing['titre']).strip()
        description = data.get('description', existing['description']).strip()
        statut = data.get('statut', existing['statut'])
        priorite = int(data.get('priorite', existing['priorite']))
        ordre = int(data.get('ordre', existing['ordre']))

        if statut not in ('a_faire', 'en_cours', 'termine'):
            return jsonify({'error': "Statut invalide"}), 400

        db.execute(
            '''UPDATE missions
               SET titre = ?, description = ?, statut = ?, priorite = ?, ordre = ?,
                   updated_at = datetime('now','localtime')
               WHERE id = ?''',
            (titre, description, statut, priorite, ordre, mission_id)
        )
        db.commit()
        mission = db.execute('SELECT * FROM missions WHERE id = ?', (mission_id,)).fetchone()
        return jsonify({'success': True, 'data': dict(mission)})
    finally:
        db.close()


@app.route('/api/missions/<int:mission_id>', methods=['DELETE'])
def api_delete_mission(mission_id):
    """Supprime une mission."""
    db = get_db()
    try:
        existing = db.execute('SELECT id FROM missions WHERE id = ?', (mission_id,)).fetchone()
        if not existing:
            return jsonify({'error': 'Mission non trouvée'}), 404
        db.execute('DELETE FROM missions WHERE id = ?', (mission_id,))
        db.commit()
        return jsonify({'success': True})
    finally:
        db.close()


# ============================================================
# API — MÉTÉO GRATUITE (Open-Meteo, sans clé API)
# ============================================================

@app.route('/api/meteo')
def api_meteo():
    """
    Retourne la météo pour une ville via Open-Meteo (gratuit, sans clé API).
    Params: ?ville=Nancy,FR  ou  ?lat=48.69&lon=6.18
    """
    ville = request.args.get('ville', '').strip()
    lat = request.args.get('lat', '').strip()
    lon = request.args.get('lon', '').strip()

    if not ville and not (lat and lon):
        return jsonify({'error': 'Paramètre ville ou lat/lon requis'}), 400

    cache_key = ville or f"{lat},{lon}"
    now = datetime.now()

    # Vérifier le cache mémoire (15 minutes)
    cached = _meteo_cache.get(cache_key)
    if cached and cached['expires_at'] > now:
        return jsonify({'success': True, 'data': cached['data'], 'cached': True})

    try:
        # Étape 1 : Géocodage si on a une ville
        if ville and not (lat and lon):
            city_name = ville.split(',')[0].strip()
            geo_resp = requests.get(
                'https://geocoding-api.open-meteo.com/v1/search',
                params={'name': city_name, 'count': 1, 'language': 'fr'},
                timeout=5
            )
            geo_resp.raise_for_status()
            geo_data = geo_resp.json()
            results = geo_data.get('results', [])
            if not results:
                return jsonify({'error': f'Ville non trouvée: {ville}'}), 404
            lat = str(results[0]['latitude'])
            lon = str(results[0]['longitude'])
            resolved_name = results[0].get('name', city_name)
            country = results[0].get('country', '')
        else:
            resolved_name = ville or 'Position'
            country = ''

        # Étape 2 : Météo actuelle via Open-Meteo
        weather_resp = requests.get(
            'https://api.open-meteo.com/v1/forecast',
            params={
                'latitude': lat,
                'longitude': lon,
                'current': 'temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m',
                'timezone': 'auto',
            },
            timeout=5
        )
        weather_resp.raise_for_status()
        weather = weather_resp.json()

        current = weather.get('current', {})

        # Mapping WMO weather codes → description + icône emoji
        wmo_code = current.get('weather_code', 0)
        desc, icon = _wmo_to_description(wmo_code)

        meteo_data = {
            'temperature': round(current.get('temperature_2m', 0)),
            'humidity': current.get('relative_humidity_2m', 0),
            'wind_speed': round(current.get('wind_speed_10m', 0)),
            'description': desc,
            'icon': icon,
            'ville': resolved_name,
            'pays': country,
            'weather_code': wmo_code,
        }

        # Cacher 15 minutes
        _meteo_cache[cache_key] = {
            'data': meteo_data,
            'expires_at': now + timedelta(minutes=15),
        }

        return jsonify({'success': True, 'data': meteo_data})

    except requests.RequestException as e:
        return jsonify({'error': f'Erreur météo: {str(e)}'}), 502


def _extract_gif_url_from_html(html_text, base_url=''):
    """Extrait une URL GIF directe depuis du HTML (og:image, twitter:image, media.tenor.com)."""
    if not html_text:
        return ''

    patterns = [
        r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']',
        r'<meta[^>]+name=["\']twitter:image["\'][^>]+content=["\']([^"\']+)["\']',
        r'https://media\.tenor\.com/[^"\'\s>]+?\.gif(?:\?[^"\'\s>]*)?',
        r'https://[^"\'\s>]+?\.gif(?:\?[^"\'\s>]*)?',
    ]

    for pattern in patterns:
        m = re.search(pattern, html_text, flags=re.IGNORECASE)
        if not m:
            continue

        raw_url = m.group(1) if m.lastindex else m.group(0)
        candidate = unescape(raw_url).strip()
        if not candidate:
            continue

        if base_url:
            candidate = urljoin(base_url, candidate)

        parsed = urlparse(candidate)
        if parsed.scheme in ('http', 'https') and '.gif' in candidate.lower():
            return candidate

    return ''


@app.route('/api/gif/resolve')
def api_resolve_gif_url():
    """Résout une URL (page/shortlink) vers une URL GIF directe utilisable par le widget."""
    raw_url = (request.args.get('url') or '').strip()
    if not raw_url:
        return jsonify({'success': False, 'error': 'Paramètre url requis'}), 400

    parsed = urlparse(raw_url)
    if parsed.scheme not in ('http', 'https'):
        return jsonify({'success': False, 'error': 'URL invalide (http/https requis)'}), 400

    now = datetime.utcnow()
    cached = _gif_resolve_cache.get(raw_url)
    if cached and cached.get('expires_at') and cached['expires_at'] > now:
        return jsonify({'success': True, 'url': cached['resolved_url'], 'cached': True})

    headers = {
        'User-Agent': 'Mozilla/5.0 (FabBoard GIF Resolver)'
    }

    try:
        # 1) Tentative directe (suivre redirects)
        resp = requests.get(raw_url, headers=headers, timeout=8, allow_redirects=True)
        final_url = resp.url
        content_type = (resp.headers.get('Content-Type') or '').lower()

        if 'image/gif' in content_type or final_url.lower().endswith('.gif'):
            _gif_resolve_cache[raw_url] = {
                'resolved_url': final_url,
                'expires_at': now + timedelta(hours=24),
            }
            return jsonify({'success': True, 'url': final_url, 'resolved': final_url != raw_url})

        # 2) Si page HTML, extraire une vraie URL GIF
        html_text = resp.text if 'text/html' in content_type else ''
        extracted = _extract_gif_url_from_html(html_text, final_url)
        if extracted:
            _gif_resolve_cache[raw_url] = {
                'resolved_url': extracted,
                'expires_at': now + timedelta(hours=24),
            }
            return jsonify({'success': True, 'url': extracted, 'resolved': True})

        # 3) Fallback : HEAD sur URL finale (quelques serveurs renvoient un type valide uniquement en HEAD)
        head = requests.head(final_url, headers=headers, timeout=5, allow_redirects=True)
        head_type = (head.headers.get('Content-Type') or '').lower()
        if 'image/gif' in head_type or head.url.lower().endswith('.gif'):
            _gif_resolve_cache[raw_url] = {
                'resolved_url': head.url,
                'expires_at': now + timedelta(hours=24),
            }
            return jsonify({'success': True, 'url': head.url, 'resolved': True})

        return jsonify({
            'success': False,
            'error': 'URL non résolue en GIF direct. Utilisez un lien se terminant par .gif (ex: media.tenor.com/.../tenor.gif).',
            'url': raw_url,
        }), 422

    except requests.RequestException as e:
        return jsonify({'success': False, 'error': f'Erreur réseau: {str(e)}', 'url': raw_url}), 502


# ============================================================
# API — TENOR (Proxy GIF)
# ============================================================

@app.route('/api/tenor/search')
def api_tenor_search():
    """Endpoint désactivé - Tenor n'est plus disponible."""
    return jsonify({'error': 'L\'API Tenor n\'est plus disponible. Utilisez un GIF local ou une URL directe.'}), 410


def _wmo_to_description(code):
    """Convertit un code météo WMO en description française et emoji."""
    mapping = {
        0: ('Ciel dégagé', '☀️'),
        1: ('Peu nuageux', '🌤️'),
        2: ('Partiellement nuageux', '⛅'),
        3: ('Couvert', '☁️'),
        45: ('Brouillard', '🌫️'),
        48: ('Brouillard givrant', '🌫️'),
        51: ('Bruine légère', '🌦️'),
        53: ('Bruine modérée', '🌦️'),
        55: ('Bruine forte', '🌧️'),
        61: ('Pluie légère', '🌦️'),
        63: ('Pluie modérée', '🌧️'),
        65: ('Pluie forte', '🌧️'),
        71: ('Neige légère', '🌨️'),
        73: ('Neige modérée', '❄️'),
        75: ('Neige forte', '❄️'),
        80: ('Averses légères', '🌦️'),
        81: ('Averses modérées', '🌧️'),
        82: ('Averses violentes', '🌧️'),
        85: ('Averses de neige', '🌨️'),
        95: ('Orage', '⛈️'),
        96: ('Orage avec grêle', '⛈️'),
        99: ('Orage violent avec grêle', '⛈️'),
    }
    return mapping.get(code, ('Inconnu', '🌤️'))


# ============================================================
# API — THÈME (Phase 1.5)
# ============================================================

@app.route('/api/theme', methods=['GET'])
def api_get_theme():
    """Récupère la configuration du thème."""
    try:
        theme = get_theme()
        if not theme:
            return jsonify({'error': 'Thème non trouvé'}), 404
        return jsonify({'success': True, 'data': theme})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/theme', methods=['PUT'])
def api_update_theme():
    """Met à jour le thème."""
    try:
        data = request.get_json()
        
        update_theme(
            mode=data.get('mode'),
            couleur_primaire=data.get('couleur_primaire'),
            couleur_secondaire=data.get('couleur_secondaire'),
            transition_speed=data.get('transition_speed')
        )
        
        theme = get_theme()
        return jsonify({'success': True, 'data': theme})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ============================================================
# MAIN
# ============================================================

@app.teardown_appcontext
def shutdown_sync_worker(exception=None):
    """Arrête le worker au shutdown de l'app."""
    stop_sync_worker()

if __name__ == '__main__':
    print(f'[FabBoard] Démarrage sur http://localhost:{PORT}')
    debug_mode = os.environ.get('FLASK_DEBUG', '1').lower() in ('1', 'true', 'yes')
    app.run(host='0.0.0.0', port=PORT, debug=debug_mode)
