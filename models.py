"""
FabBoard — Modèles de base de données SQLite
Schéma : activités, sources externes, événements calendrier, paramètres
"""

import sqlite3
import os
from datetime import datetime, timedelta

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'fabboard.db')


def get_db():
    """Retourne une connexion à la base de données avec row_factory."""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    """Initialise la base de données avec le schéma."""
    conn = get_db()
    c = conn.cursor()

    c.executescript('''
    -- PHASE 1.5 : FabBoard est un système d'AFFICHAGE UNIQUEMENT
    -- Les activités sont gérées par Fabtrack, pas par FabBoard
    -- Cette table a été supprimée pour éviter la redondance

    -- Table des sources de données externes
    CREATE TABLE IF NOT EXISTS sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nom TEXT NOT NULL,
        type TEXT NOT NULL,                 -- 'fabtrack', 'repetier', 'nextcloud_caldav', 'prusalink'
        url TEXT NOT NULL,
        credentials_json TEXT DEFAULT '{}', -- {"user": "...", "pass": "...", "apikey": "..."}
        sync_interval_sec INTEGER DEFAULT 60,
        actif INTEGER DEFAULT 1,
        derniere_sync TEXT DEFAULT '',
        derniere_erreur TEXT DEFAULT ''
    );

    -- Table cache des événements calendrier
    CREATE TABLE IF NOT EXISTS evenements_calendrier (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL,
        uid TEXT NOT NULL,                  -- UID iCal unique
        titre TEXT NOT NULL,
        description TEXT DEFAULT '',
        lieu TEXT DEFAULT '',
        date_debut TEXT NOT NULL,
        date_fin TEXT DEFAULT '',
        recurrence INTEGER DEFAULT 0,
        dernier_refresh TEXT DEFAULT (datetime('now','localtime')),
        FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE,
        UNIQUE(source_id, uid)
    );

    -- Table des paramètres (clé-valeur)
    CREATE TABLE IF NOT EXISTS parametres (
        cle TEXT PRIMARY KEY,
        valeur TEXT NOT NULL
    );

    -- Index pour améliorer les performances
    CREATE INDEX IF NOT EXISTS idx_evenements_date_debut ON evenements_calendrier(date_debut);

    -- ========== PHASE 1.5 : SYSTÈME DE SLIDES ==========

    -- Table des gabarits de disposition (layouts)
    CREATE TABLE IF NOT EXISTS layouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,          -- 'small', 'medium', 'large', 'grid_2x2', etc.
        nom TEXT NOT NULL,
        description TEXT DEFAULT '',
        colonnes INTEGER NOT NULL,
        lignes INTEGER NOT NULL,
        grille_json TEXT NOT NULL           -- JSON définissant les positions: [{"x":0,"y":0,"w":1,"h":1}, ...]
    );

    -- Table des slides configurables
    CREATE TABLE IF NOT EXISTS slides (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nom TEXT NOT NULL,
        layout_id INTEGER NOT NULL,
        ordre INTEGER NOT NULL,             -- Ordre d'affichage
        temps_affichage INTEGER DEFAULT 30, -- Durée en secondes
        actif INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime')),
        FOREIGN KEY(layout_id) REFERENCES layouts(id) ON DELETE RESTRICT
    );

    -- Table des widgets disponibles
    CREATE TABLE IF NOT EXISTS widgets_disponibles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,          -- 'compteurs', 'activites', 'fabtrack', 'calendrier', etc.
        nom TEXT NOT NULL,
        description TEXT DEFAULT '',
        icone TEXT DEFAULT '📊',
        categorie TEXT DEFAULT 'general'    -- 'general', 'fabtrack', 'imprimantes', 'calendrier'
    );

    -- Table de placement des widgets dans les slides
    CREATE TABLE IF NOT EXISTS slide_widgets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slide_id INTEGER NOT NULL,
        widget_id INTEGER NOT NULL,
        position INTEGER NOT NULL,          -- Index de position dans le layout (0, 1, 2...)
        config_json TEXT DEFAULT '{}',      -- Configuration spécifique du widget
        FOREIGN KEY(slide_id) REFERENCES slides(id) ON DELETE CASCADE,
        FOREIGN KEY(widget_id) REFERENCES widgets_disponibles(id) ON DELETE RESTRICT,
        UNIQUE(slide_id, position)
    );

    -- Table du thème
    CREATE TABLE IF NOT EXISTS theme (
        id INTEGER PRIMARY KEY CHECK (id = 1), -- Une seule ligne
        mode TEXT DEFAULT 'dark',              -- 'dark' ou 'light'
        couleur_primaire TEXT DEFAULT '#ff6b35',
        couleur_secondaire TEXT DEFAULT '#004e89',
        couleur_succes TEXT DEFAULT '#28a745',
        couleur_danger TEXT DEFAULT '#dc3545',
        couleur_warning TEXT DEFAULT '#ffc107',
        couleur_info TEXT DEFAULT '#17a2b8',
        transition_speed INTEGER DEFAULT 1000  -- Durée transitions en ms
    );

    -- Index
    CREATE INDEX IF NOT EXISTS idx_slides_ordre ON slides(ordre);
    CREATE INDEX IF NOT EXISTS idx_slides_actif ON slides(actif);
    CREATE INDEX IF NOT EXISTS idx_slide_widgets_slide ON slide_widgets(slide_id);
    ''')

    # Insérer les paramètres par défaut si la table est vide
    if c.execute('SELECT COUNT(*) FROM parametres').fetchone()[0] == 0:
        c.executemany('INSERT OR IGNORE INTO parametres (cle, valeur) VALUES (?, ?)', [
            ('refresh_interval', '30'),
            ('theme', 'dark'),
            ('fablab_name', "Loritz'Lab"),
            ('show_fabtrack', '1'),
            ('show_calendar', '1'),
            ('show_printers', '1'),
            ('max_evenements_dashboard', '5'),
        ])

    # ========== Initialiser les layouts (inspirés Windows 11) ==========
    if c.execute('SELECT COUNT(*) FROM layouts').fetchone()[0] == 0:
        import json
        layouts_defaults = [
            # Petit (1×1) - 1 widget
            ('small', 'Petit (1×1)', '1 widget plein écran', 1, 1, 
             json.dumps([{"x": 0, "y": 0, "w": 1, "h": 1}])),
            
            # Moyen horizontal (2×1) - 2 widgets côte à côte
            ('medium_h', 'Moyen (2×1)', '2 widgets horizontaux', 2, 1,
             json.dumps([{"x": 0, "y": 0, "w": 1, "h": 1}, {"x": 1, "y": 0, "w": 1, "h": 1}])),
            
            # Moyen vertical (1×2) - 2 widgets empilés
            ('medium_v', 'Moyen (1×2)', '2 widgets verticaux', 1, 2,
             json.dumps([{"x": 0, "y": 0, "w": 1, "h": 1}, {"x": 0, "y": 1, "w": 1, "h": 1}])),
            
            # Grille 2×2 - 4 widgets égaux
            ('grid_2x2', 'Grille (2×2)', '4 widgets égaux', 2, 2,
             json.dumps([
                 {"x": 0, "y": 0, "w": 1, "h": 1}, {"x": 1, "y": 0, "w": 1, "h": 1},
                 {"x": 0, "y": 1, "w": 1, "h": 1}, {"x": 1, "y": 1, "w": 1, "h": 1}
             ])),
            
            # Grille 3×2 - 6 widgets égaux
            ('grid_3x2', 'Grille (3×2)', '6 widgets égaux', 3, 2,
             json.dumps([
                 {"x": 0, "y": 0, "w": 1, "h": 1}, {"x": 1, "y": 0, "w": 1, "h": 1}, {"x": 2, "y": 0, "w": 1, "h": 1},
                 {"x": 0, "y": 1, "w": 1, "h": 1}, {"x": 1, "y": 1, "w": 1, "h": 1}, {"x": 2, "y": 1, "w": 1, "h": 1}
             ])),
            
            # Grille 2×3 - 6 widgets égaux (vertical)
            ('grid_2x3', 'Grille (2×3)', '6 widgets égaux verticaux', 2, 3,
             json.dumps([
                 {"x": 0, "y": 0, "w": 1, "h": 1}, {"x": 1, "y": 0, "w": 1, "h": 1},
                 {"x": 0, "y": 1, "w": 1, "h": 1}, {"x": 1, "y": 1, "w": 1, "h": 1},
                 {"x": 0, "y": 2, "w": 1, "h": 1}, {"x": 1, "y": 2, "w": 1, "h": 1}
             ])),
            
            # Grand gauche + 2 petits droite
            ('large_left_2right', 'Large gauche + 2 droite', '1 grand + 2 petits', 2, 2,
             json.dumps([
                 {"x": 0, "y": 0, "w": 1, "h": 2},  # Grand à gauche
                 {"x": 1, "y": 0, "w": 1, "h": 1},  # Petit en haut à droite
                 {"x": 1, "y": 1, "w": 1, "h": 1}   # Petit en bas à droite
             ])),
            
            # Grand haut + 2 petits bas
            ('large_top_2bottom', 'Large haut + 2 bas', '1 grand + 2 petits', 2, 2,
             json.dumps([
                 {"x": 0, "y": 0, "w": 2, "h": 1},  # Grand en haut
                 {"x": 0, "y": 1, "w": 1, "h": 1},  # Petit en bas à gauche
                 {"x": 1, "y": 1, "w": 1, "h": 1}   # Petit en bas à droite
             ])),
            
            # Grand haut + 3 petits bas
            ('large_top_3bottom', 'Large haut + 3 bas', '1 grand + 3 petits', 3, 2,
             json.dumps([
                 {"x": 0, "y": 0, "w": 3, "h": 1},  # Grand en haut
                 {"x": 0, "y": 1, "w": 1, "h": 1},  # Petit 1
                 {"x": 1, "y": 1, "w": 1, "h": 1},  # Petit 2
                 {"x": 2, "y": 1, "w": 1, "h": 1}   # Petit 3
             ])),
        ]
        
        c.executemany(
            'INSERT INTO layouts (code, nom, description, colonnes, lignes, grille_json) VALUES (?, ?, ?, ?, ?, ?)',
            layouts_defaults
        )

    # ========== Initialiser les widgets disponibles ==========
    if c.execute('SELECT COUNT(*) FROM widgets_disponibles').fetchone()[0] == 0:
        widgets_defaults = [
            ('compteurs', 'Compteurs Fabtrack', 'Compteurs d\'activités depuis Fabtrack (lecture seule)', '📊', 'fabtrack'),
            ('activites', 'Activités Fabtrack', 'Liste des activités depuis Fabtrack (lecture seule)', '📋', 'fabtrack'),
            ('horloge', 'Horloge', 'Affiche l\'heure actuelle', '🕐', 'general'),
            ('calendrier', 'Événements calendrier', 'Prochains événements CalDAV', '📅', 'calendrier'),
            ('fabtrack_stats', 'Stats Fabtrack', 'Statistiques globales Fabtrack', '📈', 'fabtrack'),
            ('fabtrack_machines', 'État machines', 'État des machines Fabtrack', '🔧', 'fabtrack'),
            ('fabtrack_conso', 'Dernières consommations', 'Dernières consommations Fabtrack', '💰', 'fabtrack'),
            ('imprimantes', 'Imprimantes 3D', 'État des imprimantes 3D', '🖨️', 'imprimantes'),
            ('meteo', 'Météo', 'Météo locale', '🌤️', 'general'),
            ('texte_libre', 'Texte libre', 'Zone de texte personnalisée', '📝', 'general'),
        ]
        
        c.executemany(
            'INSERT INTO widgets_disponibles (code, nom, description, icone, categorie) VALUES (?, ?, ?, ?, ?)',
            widgets_defaults
        )

    # ========== Initialiser le thème par défaut ==========
    if c.execute('SELECT COUNT(*) FROM theme').fetchone()[0] == 0:
        c.execute('''
            INSERT INTO theme (id, mode, couleur_primaire, couleur_secondaire, 
                              couleur_succes, couleur_danger, couleur_warning, couleur_info, transition_speed)
            VALUES (1, 'dark', '#ff6b35', '#004e89', '#28a745', '#dc3545', '#ffc107', '#17a2b8', 1000)
        ''')

    # ========== Créer une slide par défaut ==========
    if c.execute('SELECT COUNT(*) FROM slides').fetchone()[0] == 0:
        # Récupérer l'ID du layout 3×2 (grid_3x2)
        layout_id = c.execute('SELECT id FROM layouts WHERE code = ?', ('grid_3x2',)).fetchone()[0]
        
        c.execute('''
            INSERT INTO slides (nom, layout_id, ordre, temps_affichage, actif)
            VALUES ('Dashboard principal', ?, 1, 30, 1)
        ''', (layout_id,))
        
        slide_id = c.lastrowid
        
        # Ajouter les 6 widgets par défaut
        widget_codes = ['compteurs', 'activites', 'fabtrack_stats', 'imprimantes', 'calendrier', 'fabtrack_conso']
        for idx, widget_code in enumerate(widget_codes):
            widget_id = c.execute('SELECT id FROM widgets_disponibles WHERE code = ?', (widget_code,)).fetchone()[0]
            c.execute('''
                INSERT INTO slide_widgets (slide_id, widget_id, position, config_json)
                VALUES (?, ?, ?, '{}')
            ''', (slide_id, widget_id, idx))

    conn.commit()
    conn.close()
    print(f'[FabBoard] Base de données initialisée : {DB_PATH}')


def reset_db():
    """Réinitialise la base de données (ATTENTION : supprime toutes les données)."""
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)
    init_db()
    print('[FabBoard] Base de données réinitialisée')


# ========== PHASE 1.5 : FONCTIONS SLIDES ==========

def get_all_slides(include_inactive=False):
    """
    Retourne toutes les slides avec leurs widgets.
    
    Args:
        include_inactive (bool): Inclure les slides inactives
        
    Returns:
        list: Liste de dict avec structure complète des slides
    """
    conn = get_db()
    
    query = '''
        SELECT s.*, l.code as layout_code, l.nom as layout_nom, 
               l.colonnes, l.lignes, l.grille_json
        FROM slides s
        JOIN layouts l ON s.layout_id = l.id
        WHERE s.actif = 1
        ORDER BY s.ordre
    ''' if not include_inactive else '''
        SELECT s.*, l.code as layout_code, l.nom as layout_nom,
               l.colonnes, l.lignes, l.grille_json
        FROM slides s
        JOIN layouts l ON s.layout_id = l.id
        ORDER BY s.ordre
    '''
    
    slides = []
    for row in conn.execute(query).fetchall():
        slide = dict(row)
        
        # Charger les widgets associés
        widgets_query = '''
            SELECT sw.*, w.code as widget_code, w.nom as widget_nom, 
                   w.icone, w.categorie, w.description
            FROM slide_widgets sw
            JOIN widgets_disponibles w ON sw.widget_id = w.id
            WHERE sw.slide_id = ?
            ORDER BY sw.position
        '''
        
        slide['widgets'] = [dict(w) for w in conn.execute(widgets_query, (slide['id'],)).fetchall()]
        slides.append(slide)
    
    conn.close()
    return slides


def get_slide_by_id(slide_id):
    """Retourne une slide avec tous ses détails."""
    conn = get_db()
    
    slide = conn.execute('''
        SELECT s.*, l.code as layout_code, l.nom as layout_nom,
               l.colonnes, l.lignes, l.grille_json
        FROM slides s
        JOIN layouts l ON s.layout_id = l.id
        WHERE s.id = ?
    ''', (slide_id,)).fetchone()
    
    if not slide:
        conn.close()
        return None
    
    slide = dict(slide)
    
    # Charger les widgets
    widgets_query = '''
        SELECT sw.*, w.code as widget_code, w.nom as widget_nom,
               w.icone, w.categorie, w.description
        FROM slide_widgets sw
        JOIN widgets_disponibles w ON sw.widget_id = w.id
        WHERE sw.slide_id = ?
        ORDER BY sw.position
    '''
    
    slide['widgets'] = [dict(w) for w in conn.execute(widgets_query, (slide_id,)).fetchall()]
    
    conn.close()
    return slide


def get_all_layouts():
    """Retourne tous les layouts disponibles."""
    conn = get_db()
    layouts = [dict(row) for row in conn.execute('SELECT * FROM layouts ORDER BY id').fetchall()]
    conn.close()
    return layouts


def get_all_widgets_disponibles():
    """Retourne tous les widgets disponibles."""
    conn = get_db()
    widgets = [dict(row) for row in conn.execute('SELECT * FROM widgets_disponibles ORDER BY categorie, nom').fetchall()]
    conn.close()
    return widgets


def get_theme():
    """Retourne la configuration du thème."""
    conn = get_db()
    theme = conn.execute('SELECT * FROM theme WHERE id = 1').fetchone()
    conn.close()
    return dict(theme) if theme else None


def update_theme(mode=None, couleur_primaire=None, couleur_secondaire=None, transition_speed=None):
    """Met à jour le thème."""
    conn = get_db()
    
    updates = []
    params = []
    
    if mode:
        updates.append('mode = ?')
        params.append(mode)
    if couleur_primaire:
        updates.append('couleur_primaire = ?')
        params.append(couleur_primaire)
    if couleur_secondaire:
        updates.append('couleur_secondaire = ?')
        params.append(couleur_secondaire)
    if transition_speed is not None:
        updates.append('transition_speed = ?')
        params.append(transition_speed)
    
    if updates:
        query = f'UPDATE theme SET {", ".join(updates)} WHERE id = 1'
        conn.execute(query, params)
        conn.commit()
    
    conn.close()


if __name__ == '__main__':
    # Test : initialiser la base
    init_db()
