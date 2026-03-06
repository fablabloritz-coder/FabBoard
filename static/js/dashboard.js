/**
 * DASHBOARD.JS v3.0 — Shared Data Store + Slides
 * Un seul fetch centralisé alimente tous les widgets.
 */

// ========== STATE ==========
let slides = [];
let currentSlideIndex = 0;
let slideTimer = null;
let clockTimer = null;

// ========== SHARED DATA STORE ==========
const FabBoardStore = {
    /** Données issues de /api/dashboard/data */
    data: null,
    /** Données par source : { sourceId: data } */
    sourceData: {},
    /** Données météo par ville : { ville: data } */
    meteoData: {},
    /** Intervalle de rafraîchissement (secondes) */
    refreshInterval: 30,
    /** IDs de sources utilisées par les widgets courants */
    _sourceIds: new Set(),
    /** Villes météo utilisées par les widgets courants */
    _meteoVilles: new Set(),
    _timer: null,

    /** Initialise le store : charge le refresh_interval puis fetch tout. */
    async init() {
        try {
            const resp = await fetch('/api/parametres');
            const params = await resp.json();
            if (params.refresh_interval) {
                this.refreshInterval = Math.max(10, parseInt(params.refresh_interval) || 30);
            }
        } catch (e) { /* default 30s */ }

        await this.fetchAll();
        this._startLoop();
    },

    /** Enregistre un source_id à pré-charger. */
    registerSource(id) { if (id) this._sourceIds.add(id); },

    /** Enregistre une ville météo à pré-charger. */
    registerMeteo(ville) { if (ville) this._meteoVilles.add(ville); },

    /** Collecte les source_ids et villes depuis les widgets de toutes les slides. */
    collectFromSlides(allSlides) {
        this._sourceIds.clear();
        this._meteoVilles.clear();
        for (const slide of allSlides) {
            for (const w of (slide.widgets || [])) {
                const cfg = JSON.parse(w.config_json || '{}');
                if (cfg.source_id) this._sourceIds.add(cfg.source_id);
                if (w.widget_code === 'meteo') {
                    this._meteoVilles.add(cfg.ville || 'Nancy, FR');
                }
            }
        }
    },

    /** Charge toutes les données en une seule passe. */
    async fetchAll() {
        const promises = [];

        // 1) Données dashboard principales
        promises.push(
            fetch('/api/dashboard/data')
                .then(r => r.json())
                .then(d => { this.data = d; })
                .catch(e => console.error('Store: erreur dashboard/data', e))
        );

        // 2) Données par source
        for (const sid of this._sourceIds) {
            promises.push(
                fetch('/api/widget-data/' + sid)
                    .then(r => r.json())
                    .then(result => {
                        if (result.success && result.data) {
                            this.sourceData[sid] = result.data;
                        }
                    })
                    .catch(e => console.error('Store: erreur source', sid, e))
            );
        }

        // 3) Météo par ville
        for (const ville of this._meteoVilles) {
            promises.push(
                fetch('/api/meteo?ville=' + encodeURIComponent(ville))
                    .then(r => r.json())
                    .then(result => {
                        if (result.success && result.data) {
                            this.meteoData[ville] = result.data;
                        }
                    })
                    .catch(e => console.error('Store: erreur meteo', ville, e))
            );
        }

        await Promise.all(promises);

        // Notifier tous les widgets
        document.dispatchEvent(new CustomEvent('fabboard:refresh'));
    },

    /** Raccourci : clé depuis data principale. */
    get(key) { return this.data ? this.data[key] : null; },

    /** Raccourci : données d'une source. */
    getSource(sid) { return this.sourceData[sid] || null; },

    /** Raccourci : données météo d'une ville. */
    getMeteo(ville) { return this.meteoData[ville] || null; },

    _startLoop() {
        if (this._timer) clearInterval(this._timer);
        this._timer = setInterval(() => this.fetchAll(), this.refreshInterval * 1000);
    }
};
window.FabBoardStore = FabBoardStore;

// ========== INIT ==========
document.addEventListener('DOMContentLoaded', async () => {
    // Démarrer l'horloge globale
    startClockTimer();

    // Charger le thème
    await loadThemeSettings();

    // Charger les slides
    await loadSlides();

    if (slides.length > 0) {
        // Collecter les sources nécessaires et initialiser le store
        FabBoardStore.collectFromSlides(slides);
        await FabBoardStore.init();

        // Démarrer le cycle de slides
        await startSlideCycle();
    } else {
        showEmptyState();
    }
});

function startClockTimer() {
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = setInterval(updateClock, 1000);
}

// ========== THÈME ==========
async function loadThemeSettings() {
    try {
        const response = await apiCall('/api/theme');
        const theme = response.data;
        
        // Appliquer le mode (clair/sombre)
        if (theme.mode === 'light') {
            document.body.classList.add('light-mode');
        }
        
        // Appliquer les couleurs personnalisées
        const root = document.documentElement;
        root.style.setProperty('--primary-color', theme.couleur_primaire);
        root.style.setProperty('--secondary-color', theme.couleur_secondaire);
        root.style.setProperty('--success-color', theme.couleur_succes);
        root.style.setProperty('--danger-color', theme.couleur_danger);
        root.style.setProperty('--warning-color', theme.couleur_warning);
        root.style.setProperty('--info-color', theme.couleur_info);
        
    } catch (error) {
        console.error('Erreur chargement thème:', error);
    }

    // Charger les paramètres (police, etc.)
    try {
        const params = await fetch('/api/parametres').then(r => r.json());
        const police = params.police_dashboard || 'inter';
        document.body.classList.add('font-' + police);
    } catch (e) { /* default Inter */ }
}

// ========== SLIDES ==========
async function loadSlides() {
    try {
        const response = await apiCall('/api/slides');
        slides = response.data.filter(s => s.actif === 1);
        
        if (slides.length === 0) {
            console.warn('Aucune slide active trouvée');
        }
    } catch (error) {
        console.error('Erreur chargement slides:', error);
        showToast('Impossible de charger les slides', 'error');
    }
}

function showEmptyState() {
    const container = document.getElementById('dashboard-container');
    container.innerHTML = `
        <div class="empty-state">
            <i class="bi bi-tv" style="font-size: 4rem; color: var(--primary-color);"></i>
            <h2>Aucune slide configurée</h2>
            <p>Rendez-vous dans <a href="/slides">Configuration → Slides</a> pour créer votre première slide</p>
        </div>
    `;
}

// ========== CYCLE DES SLIDES ==========
async function startSlideCycle() {
    await displayCurrentSlide();
    
    // Si une seule slide, pas de cycle automatique
    if (slides.length === 1) return;
    
    // Démarrer le cycle automatique
    const currentSlide = slides[currentSlideIndex];
    slideTimer = setTimeout(() => {
        nextSlide();
    }, currentSlide.temps_affichage * 1000);
}

async function nextSlide() {
    if (slideTimer) clearTimeout(slideTimer);
    
    currentSlideIndex = (currentSlideIndex + 1) % slides.length;
    
    const container = document.getElementById('dashboard-container');
    container.classList.add('slide-transition');
    
    setTimeout(async () => {
        await displayCurrentSlide();
        container.classList.remove('slide-transition');
        
        const currentSlide = slides[currentSlideIndex];
        slideTimer = setTimeout(() => {
            nextSlide();
        }, currentSlide.temps_affichage * 1000);
    }, 500);
}

// ========== AFFICHAGE DE LA SLIDE ==========
async function displayCurrentSlide() {
    const slide = slides[currentSlideIndex];
    const container = document.getElementById('dashboard-container');
    
    // Appliquer le fond de slide
    container.classList.remove('slide-bg-color', 'slide-bg-image');
    container.style.removeProperty('background-color');
    container.style.removeProperty('background-image');
    container.style.removeProperty('background');
    
    const fondType = slide.fond_type || 'defaut';
    const fondValeur = slide.fond_valeur || '';
    if (fondType === 'couleur' && fondValeur) {
        container.classList.add('slide-bg-color');
        container.style.backgroundColor = fondValeur;
    } else if (fondType === 'image' && fondValeur) {
        container.classList.add('slide-bg-image');
        container.style.backgroundImage = 'url(' + fondValeur + ')';
    }
    
    // Parser la grille layout
    const grille = JSON.parse(slide.grille_json);
    
    // Style CSS Grid
    const gridStyle = `
        grid-template-columns: repeat(${slide.colonnes}, 1fr);
        grid-template-rows: repeat(${slide.lignes}, 1fr);
        gap: 0.8rem;
        padding: 0.8rem;
    `;
    
    // Afficher les placeholders loading
    container.innerHTML = `
        <div class="dashboard-grid" style="${gridStyle}">
            ${grille.map((pos, index) => {
                const style = `
                    grid-column: ${pos.x + 1} / span ${pos.w};
                    grid-row: ${pos.y + 1} / span ${pos.h};
                `;
                return `
                    <div class="dashboard-widget" style="${style}" data-position="${index}">
                        <div class="spinner-border text-primary" role="status"></div>
                    </div>
                `;
            }).join('')}
        </div>
        
        <!-- Indicateur de slide -->
        <div class="slide-indicator">
            ${slides.map((s, i) => `
                <span class="slide-dot ${i === currentSlideIndex ? 'active' : ''}"></span>
            `).join('')}
        </div>
    `;
    
    // Rendre chaque widget de manière asynchrone
    for (let index = 0; index < grille.length; index++) {
        const widgetData = slide.widgets.find(w => w.position === index);
        const widgetElement = container.querySelector(`[data-position="${index}"]`);
        
        if (widgetData) {
            // Appliquer l'échelle du widget
            const cfg = JSON.parse(widgetData.config_json || '{}');
            const echelle = cfg.echelle || '1';
            if (echelle !== '1') {
                const scaleClass = 'widget-scale-' + echelle.replace('.', '-');
                widgetElement.classList.add(scaleClass);
            }

            const widgetHTML = await renderWidget(widgetData, slide.id, index);
            injectWidgetHtml(widgetElement, widgetHTML);
        } else {
            // Emplacement vide → transparent
            widgetElement.classList.add('widget-slot-empty');
            widgetElement.innerHTML = '';
        }
    }
    
    // Mettre à jour l'horloge immédiatement
    updateClock();
}

function renderEmptyWidget(position) {
    return `
        <div class="widget-empty">
            <i class="bi bi-inbox"></i>
            <p>Position ${position + 1}</p>
            <small>Aucun widget assigné</small>
        </div>
    `;
}

// ========== RENDU DES WIDGETS ==========
async function renderWidget(widgetData, slideId, position) {
    const widgetCode = widgetData.widget_code;
    const config = JSON.parse(widgetData.config_json || '{}');
    const sourceId = config.source_id || null;
    const widgetId = `slide-${slideId}-pos-${position}-wid-${widgetData.id || widgetCode}`;
    
    try {
        // Récupérer le HTML du widget depuis le serveur
        const response = await fetch(`/api/widgets/${widgetCode}/render`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ config, source_id: sourceId, widget_id: widgetId })
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const result = await response.json();
        
        if (result.success) {
            return result.html;
        } else {
            return renderWidgetError(widgetData, result.error);
        }
    } catch (error) {
        console.error(`Erreur rendu widget ${widgetCode}:`, error);
        return renderWidgetError(widgetData, error.message);
    }
}

function injectWidgetHtml(container, html) {
    container.innerHTML = html;

    // Les scripts dans innerHTML ne s'executent pas automatiquement.
    const scripts = container.querySelectorAll('script');
    scripts.forEach((scriptEl) => {
        const executable = document.createElement('script');

        for (const attr of scriptEl.attributes) {
            executable.setAttribute(attr.name, attr.value);
        }

        executable.textContent = scriptEl.textContent;
        scriptEl.parentNode.replaceChild(executable, scriptEl);
    });
}

function renderWidgetError(widgetData, errorMsg) {
    return `
        <div class="widget-error">
            <i class="bi bi-exclamation-triangle" style="font-size: 2rem; color: #fbbf24;"></i>
            <p><strong>${widgetData.widget_nom}</strong></p>
            <small>${escapeHtml(errorMsg)}</small>
        </div>
    `;
}

// ========== RAFRAÎCHISSEMENT DES WIDGETS ==========
// Le FabBoardStore gère le refresh périodique et dispatch 'fabboard:refresh'.

// ========== HORLOGE GLOBALE ==========
function updateClock() {
    // Mettre à jour tous les widgets horloge présents sur la slide.
    const horloges = document.querySelectorAll('.widget-horloge-time, .horloge-heure');
    
    horloges.forEach(el => {
        const now = new Date();
        const timeStr = now.toLocaleTimeString('fr-FR', { 
            hour: '2-digit', 
            minute: '2-digit', 
            second: '2-digit' 
        });
        el.textContent = timeStr;
    });
    
    // Mettre à jour les dates
    const dates = document.querySelectorAll('.widget-horloge-date, .horloge-date');
    
    dates.forEach(el => {
        const now = new Date();
        const dateStr = now.toLocaleDateString('fr-FR', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            year: 'numeric'
        });
        el.textContent = dateStr.charAt(0).toUpperCase() + dateStr.slice(1);
    });
}

// ========== HELPER : API CALL ==========
async function apiCall(endpoint, options = {}) {
    try {
        const response = await fetch(endpoint, {
            headers: { 'Content-Type': 'application/json' },
            ...options
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        const data = await response.json();
        
        if (!data.success && data.error) {
            throw new Error(data.error);
        }
        
        return data;
    } catch (error) {
        console.error(`Erreur API ${endpoint}:`, error);
        throw error;
    }
}

// ========== HELPER : ESCAPE HTML ==========
function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return String(unsafe)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// ========== HELPER : TOAST ==========
function showToast(message, type = 'info') {
    console.log(`[${type.toUpperCase()}] ${message}`);
    // TODO Phase 2 : Intégrer Bootstrap Toasts
}
