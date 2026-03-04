"""
FabBoard v1.0 — Application Flask principale
Tableau de bord TV pour Fablab
Phase 1.5 : Système de slides configurable
"""

from flask import Flask, render_template, request, jsonify, send_file
from models import (
    get_db, init_db,
    get_all_slides, get_slide_by_id, get_all_layouts, get_all_widgets_disponibles,
    get_theme, update_theme
)
from datetime import datetime
import os
import json

app = Flask(__name__)
app.secret_key = os.environ.get('FABBOARD_SECRET', 'fabboard-secret-2026')

# Configuration
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get('FABBOARD_PORT', 5580))


# ============================================================
# INIT
# ============================================================

_db_initialized = False

@app.before_request
def ensure_db():
    global _db_initialized
    if not _db_initialized:
        init_db()
        _db_initialized = True


# ============================================================
# HELPERS
# ============================================================

def row_to_dict(row):
    """Convertit une Row SQLite en dictionnaire."""
    return dict(row) if row else None

def rows_to_list(rows):
    """Convertit une liste de Row SQLite en liste de dictionnaires."""
    return [dict(r) for r in rows]


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


# ============================================================
# API — DASHBOARD
# ============================================================

@app.route('/api/dashboard/data')
def api_dashboard_data():
    """
    Retourne les données agrégées pour le dashboard TV.
    
    Note: Les données proviennent des sources externes configurées :
    - Activités → Fabtrack (Phase 2)
    - Événements → CalDAV (Phase 3)
    - Imprimantes → Repetier/PrusaLink (Phase 4)
    """
    return jsonify({
        'activites': [],  # TODO Phase 2: Depuis Fabtrack
        'compteurs': {    # TODO Phase 2: Depuis Fabtrack
            'en_attente': 0,
            'en_cours': 0,
            'termine': 0
        },
        'evenements': [],  # TODO Phase 3: Depuis CalDAV
        'fabtrack_stats': {},  # TODO Phase 2: Depuis Fabtrack
        'imprimantes': [],  # TODO Phase 4: Depuis Repetier
        'timestamp': datetime.now().isoformat()
    })


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
        sources = rows_to_list(db.execute('SELECT * FROM sources ORDER BY nom').fetchall())
        # Masquer les credentials pour la sécurité
        for s in sources:
            s['credentials_json'] = '***'
        return jsonify({'data': sources})
    finally:
        db.close()


@app.route('/api/sources', methods=['POST'])
def api_create_source():
    """Créer une nouvelle source de données."""
    db = get_db()
    try:
        data = request.get_json()
        
        cursor = db.execute('''
            INSERT INTO sources (nom, type, url, credentials_json, sync_interval_sec, actif)
            VALUES (?, ?, ?, ?, ?, ?)
        ''', (
            data.get('nom', ''),
            data.get('type', ''),
            data.get('url', ''),
            json.dumps(data.get('credentials', {})),
            data.get('sync_interval_sec', 60),
            data.get('actif', 1)
        ))
        
        db.commit()
        source_id = cursor.lastrowid
        
        source = row_to_dict(db.execute('SELECT * FROM sources WHERE id = ?', (source_id,)).fetchone())
        return jsonify({'success': True, 'data': source}), 201
    finally:
        db.close()


@app.route('/api/sources/<int:id>', methods=['PUT'])
def api_update_source(id):
    """Modifier une source de données."""
    db = get_db()
    try:
        data = request.get_json()
        
        existing = db.execute('SELECT * FROM sources WHERE id = ?', (id,)).fetchone()
        if not existing:
            return jsonify({'error': 'Source non trouvée'}), 404
        
        db.execute('''
            UPDATE sources SET
                nom = ?, type = ?, url = ?, credentials_json = ?,
                sync_interval_sec = ?, actif = ?
            WHERE id = ?
        ''', (
            data.get('nom', existing['nom']),
            data.get('type', existing['type']),
            data.get('url', existing['url']),
            json.dumps(data.get('credentials', json.loads(existing['credentials_json']))),
            data.get('sync_interval_sec', existing['sync_interval_sec']),
            data.get('actif', existing['actif']),
            id
        ))
        
        db.commit()
        
        source = row_to_dict(db.execute('SELECT * FROM sources WHERE id = ?', (id,)).fetchone())
        return jsonify({'success': True, 'data': source})
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
    finally:
        db.close()


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
            INSERT INTO slides (nom, layout_id, ordre, temps_affichage, actif)
            VALUES (?, ?, ?, ?, ?)
        ''', (
            data['nom'],
            data['layout_id'],
            ordre,
            data.get('temps_affichage', 30),
            data.get('actif', 1)
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
                updated_at = datetime('now','localtime')
            WHERE id = ?
        ''', (
            data.get('nom', existing['nom']),
            data.get('layout_id', existing['layout_id']),
            data.get('temps_affichage', existing['temps_affichage']),
            data.get('actif', existing['actif']),
            id
        ))
        
        # Mettre à jour les widgets si fournis
        if 'widgets' in data and isinstance(data['widgets'], list):
            # Supprimer les anciens widgets
            db.execute('DELETE FROM slide_widgets WHERE slide_id = ?', (id,))
            
            # Ajouter les nouveaux
            for widget_data in data['widgets']:
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

if __name__ == '__main__':
    print(f'[FabBoard] Démarrage sur http://localhost:{PORT}')
    app.run(host='0.0.0.0', port=PORT, debug=True)
