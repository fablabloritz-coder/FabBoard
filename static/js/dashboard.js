/**
 * DASHBOARD.JS — Phase 1.5 : Système de slides configurables
 * Affichage TV avec cycle automatique des slides
 */

// ========== STATE ==========
let slides = [];
let currentSlideIndex = 0;
let slideTimer = null;
let widgetRefreshTimer = null;

// ========== INIT ==========
document.addEventListener('DOMContentLoaded', async () => {
    // Charger le thème
    await loadThemeSettings();
    
    // Charger les slides
    await loadSlides();
    
    // Démarrer le cycle
    if (slides.length > 0) {
        startSlideCycle();
    } else {
        showEmptyState();
    }
    
    // Horloge
    updateClock();
    setInterval(updateClock, 1000);
});

// ========== THÈME ==========
async function loadThemeSettings() {
    try {
        const response = await apiCall('/api/theme');
        const theme = response.data;
        
        // Appliquer le mode (clair/sombre)
        if (theme.mode === 'light') {
            document.body.classList.add('light-mode');
        }
        
        // Appliquer les couleurs
        document.documentElement.style.setProperty('--primary-color', theme.couleur_primaire);
        document.documentElement.style.setProperty('--secondary-color', theme.couleur_secondaire);
        document.documentElement.style.setProperty('--success-color', theme.couleur_succes);
        document.documentElement.style.setProperty('--danger-color', theme.couleur_danger);
        document.documentElement.style.setProperty('--warning-color', theme.couleur_warning);
        document.documentElement.style.setProperty('--info-color', theme.couleur_info);
        
    } catch (error) {
        console.error('Erreur chargement thème:', error);
    }
}

// ========== SLIDES ==========
async function loadSlides() {
    try {
        const response = await apiCall('/api/slides');
        slides = response.data.filter(s => s.actif === 1); // Que les actives
        
        if (slides.length === 0) {
            console.warn('Aucune slide active');
        }
    } catch (error) {
        console.error('Erreur chargement slides:', error);
        showToast('Erreur de chargement des slides', 'error');
    }
}

function showEmptyState() {
    const container = document.getElementById('dashboard-container');
    container.innerHTML = `
        <div class="empty-state">
            <i class="bi bi-tv"></i>
            <h2>Aucune slide configurée</h2>
            <p>Allez dans <a href="/slides">Configuration → Slides</a> pour créer votre première slide</p>
        </div>
    `;
}

// ========== CYCLE DES SLIDES ==========
function startSlideCycle() {
    displayCurrentSlide();
    
    // Si une seule slide, pas besoin de cycle
    if (slides.length === 1) {
        startWidgetRefresh();
        return;
    }
    
    // Cycle automatique
    const currentSlide = slides[currentSlideIndex];
    slideTimer = setTimeout(() => {
        nextSlide();
    }, currentSlide.temps_affichage * 1000);
    
    startWidgetRefresh();
}

function nextSlide() {
    // Arrêter les timers
    if (slideTimer) clearTimeout(slideTimer);
    if (widgetRefreshTimer) clearInterval(widgetRefreshTimer);
    
    // Passer à la slide suivante
    currentSlideIndex = (currentSlideIndex + 1) % slides.length;
    
    // Transition
    const container = document.getElementById('dashboard-container');
    container.classList.add('slide-transition');
    
    setTimeout(() => {
        displayCurrentSlide();
        container.classList.remove('slide-transition');
        
        // Relancer le cycle
        const currentSlide = slides[currentSlideIndex];
        slideTimer = setTimeout(() => {
            nextSlide();
        }, currentSlide.temps_affichage * 1000);
        
        startWidgetRefresh();
    }, 500); // Durée de la transition
}

function startWidgetRefresh() {
    // Rafraîchir les widgets toutes les 10 secondes
    if (widgetRefreshTimer) clearInterval(widgetRefreshTimer);
    
    widgetRefreshTimer = setInterval(() => {
        refreshCurrentSlideWidgets();
    }, 10000);
}

// ========== AFFICHAGE DE LA SLIDE ==========
function displayCurrentSlide() {
    const slide = slides[currentSlideIndex];
    const container = document.getElementById('dashboard-container');
    
    // Parser la grille
    const grille = JSON.parse(slide.grille_json);
    
    // Construire le style de la grille
    const gridStyle = `
        grid-template-columns: repeat(${slide.colonnes}, 1fr);
        grid-template-rows: repeat(${slide.lignes}, 1fr);
    `;
    
    // Construire les widgets
    const widgetsHTML = grille.map((pos, index) => {
        const widgetData = slide.widgets.find(w => w.position === index);
        
        const style = `
            grid-column: ${pos.x + 1} / span ${pos.w};
            grid-row: ${pos.y + 1} / span ${pos.h};
        `;
        
        return `
            <div class="dashboard-widget" style="${style}" data-position="${index}">
                ${widgetData ? renderWidget(widgetData) : renderEmptyWidget(index)}
            </div>
        `;
    }).join('');
    
    container.innerHTML = `
        <div class="dashboard-grid" style="${gridStyle}">
            ${widgetsHTML}
        </div>
        
        <!-- Indicateur slide -->
        <div class="slide-indicator">
            ${slides.map((s, i) => `
                <span class="slide-dot ${i === currentSlideIndex ? 'active' : ''}"></span>
            `).join('')}
        </div>
    `;
    
    // Charger les données des widgets
    refreshCurrentSlideWidgets();
}

function renderEmptyWidget(position) {
    return `
        <div class="widget-empty">
            <i class="bi bi-inbox"></i>
            <p>Position ${position + 1}</p>
        </div>
    `;
}

// ========== RENDU DES WIDGETS ==========
function renderWidget(widgetData) {
    const widgetCode = widgetData.widget_code;
    
    switch (widgetCode) {
        case 'compteurs':
            return renderWidgetCompteurs();
        case 'activites':
            return renderWidgetActivites();
        case 'horloge':
            return renderWidgetHorloge();
        case 'calendrier':
            return renderWidgetCalendrier();
        case 'fabtrack_stats':
            return renderWidgetFabtrackStats();
        case 'fabtrack_machines':
            return renderWidgetFabtrackMachines();
        case 'fabtrack_conso':
            return renderWidgetFabtrackConso();
        case 'imprimantes':
            return renderWidgetImprimantes();
        case 'meteo':
            return renderWidgetMeteo();
        case 'texte_libre':
            return renderWidgetTexteLibre(widgetData);
        default:
            return `<div class="widget-placeholder">${widgetData.icone} ${widgetData.widget_nom}</div>`;
    }
}

function renderWidgetCompteurs() {
    return `
        <div class="widget-compteurs">
            <h3><i class="bi bi-bar-chart"></i> Activités</h3>
            <div class="compteurs-grid" id="widget-compteurs-data">
                <div class="spinner-border" role="status"></div>
            </div>
        </div>
    `;
}

function renderWidgetActivites() {
    return `
        <div class="widget-activites">
            <h3><i class="bi bi-list-check"></i> Activités en cours</h3>
            <div class="activites-list" id="widget-activites-data">
                <div class="spinner-border" role="status"></div>
            </div>
        </div>
    `;
}

function renderWidgetHorloge() {
    return `
        <div class="widget-horloge">
            <div class="horloge-time" id="widget-horloge-time">--:--:--</div>
            <div class="horloge-date" id="widget-horloge-date">--</div>
        </div>
    `;
}

function renderWidgetCalendrier() {
    return `
        <div class="widget-calendrier">
            <h3><i class="bi bi-calendar"></i> Événements à venir</h3>
            <div class="calendrier-list" id="widget-calendrier-data">
                <div class="spinner-border" role="status"></div>
            </div>
        </div>
    `;
}

function renderWidgetFabtrackStats() {
    return `
        <div class="widget-fabtrack-stats">
            <h3><i class="bi bi-graph-up"></i> Fabtrack</h3>
            <div class="fabtrack-stats-grid" id="widget-fabtrack-stats-data">
                <div class="spinner-border" role="status"></div>
            </div>
        </div>
    `;
}

function renderWidgetFabtrackMachines() {
    return `
        <div class="widget-fabtrack-machines">
            <h3><i class="bi bi-tools"></i> Machines</h3>
            <div class="machines-grid" id="widget-fabtrack-machines-data">
                <div class="spinner-border" role="status"></div>
            </div>
        </div>
    `;
}

function renderWidgetFabtrackConso() {
    return `
        <div class="widget-fabtrack-conso">
            <h3><i class="bi bi-receipt"></i> Dernières consommations</h3>
            <div class="conso-list" id="widget-fabtrack-conso-data">
                <div class="spinner-border" role="status"></div>
            </div>
        </div>
    `;
}

function renderWidgetImprimantes() {
    return `
        <div class="widget-imprimantes">
            <h3><i class="bi bi-printer"></i> Imprimantes 3D</h3>
            <div class="imprimantes-grid" id="widget-imprimantes-data">
                <div class="spinner-border" role="status"></div>
            </div>
        </div>
    `;
}

function renderWidgetMeteo() {
    return `
        <div class="widget-meteo">
            <h3><i class="bi bi-cloud-sun"></i> Météo</h3>
            <div id="widget-meteo-data">
                <p class="text-muted">À venir</p>
            </div>
        </div>
    `;
}

function renderWidgetTexteLibre(widgetData) {
    const config = JSON.parse(widgetData.config_json || '{}');
    return `
        <div class="widget-texte-libre">
            <h3>${config.titre || 'Information'}</h3>
            <div class="texte-content">
                ${config.texte || 'Texte personnalisé'}
            </div>
        </div>
    `;
}

// ========== RAFRAÎCHISSEMENT DES DONNÉES ==========
async function refreshCurrentSlideWidgets() {
    const slide = slides[currentSlideIndex];
    
    for (const widgetData of slide.widgets) {
        await refreshWidget(widgetData.widget_code);
    }
}

async function refreshWidget(widgetCode) {
    try {
        switch (widgetCode) {
            case 'compteurs':
                await refreshWidgetCompteurs();
                break;
            case 'activites':
                await refreshWidgetActivites();
                break;
            case 'horloge':
                refreshWidgetHorloge();
                break;
            case 'calendrier':
                await refreshWidgetCalendrier();
                break;
            case 'fabtrack_stats':
                await refreshWidgetFabtrackStats();
                break;
            case 'imprimantes':
                await refreshWidgetImprimantes();
                break;
        }
    } catch (error) {
        console.error(`Erreur rafraîchissement widget ${widgetCode}:`, error);
    }
}

async function refreshWidgetCompteurs() {
    const el = document.getElementById('widget-compteurs-data');
    if (!el) return;
    
    try {
        const data = await apiCall('/api/dashboard/data');
        const compteurs = data.compteurs || {};
        
        el.innerHTML = `
            <div class="compteur-item">
                <div class="compteur-value">${compteurs.en_attente_total || 0}</div>
                <div class="compteur-label">Par faire</div>
            </div>
            <div class="compteur-item">
                <div class="compteur-value">${compteurs.en_cours_total || 0}</div>
                <div class="compteur-label">En cours</div>
            </div>
            <div class="compteur-item">
                <div class="compteur-value">${compteurs.termine_jour || 0}</div>
                <div class="compteur-label">Terminées (aujourd'hui)</div>
            </div>
        `;
    } catch (error) {
        el.innerHTML = '<p class="text-muted">Erreur chargement</p>';
    }
}

async function refreshWidgetActivites() {
    const el = document.getElementById('widget-activites-data');
    if (!el) return;
    
    try {
        const activites = await apiCall('/api/activites?statut=en_cours&limit=5');
        
        if (activites.length === 0) {
            el.innerHTML = '<p class="text-muted">Aucune activité en cours</p>';
            return;
        }
        
        el.innerHTML = activites.map(a => `
            <div class="activite-item">
                <div class="activite-titre">${escapeHtml(a.titre)}</div>
                <div class="activite-meta">
                    <span class="badge ${getBadgeClassUrgence(a.niveau_urgence)}">${a.niveau_urgence}</span>
                    <span>${a.assignee || 'Non assignée'}</span>
                </div>
            </div>
        `).join('');
    } catch (error) {
        el.innerHTML = '<p class="text-muted">Erreur chargement</p>';
    }
}

function refreshWidgetHorloge() {
    const elTime = document.getElementById('widget-horloge-time');
    const elDate = document.getElementById('widget-horloge-date');
    
    if (!elTime || !elDate) return;
    
    const now = new Date();
    elTime.textContent = now.toLocaleTimeString('fr-FR');
    elDate.textContent = now.toLocaleDateString('fr-FR', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric'
    });
}

async function refreshWidgetCalendrier() {
    const el = document.getElementById('widget-calendrier-data');
    if (!el) return;
    
    el.innerHTML = '<p class="text-muted">CalDAV non encore intégré (Phase 3)</p>';
}

async function refreshWidgetFabtrackStats() {
    const el = document.getElementById('widget-fabtrack-stats-data');
    if (!el) return;
    
    el.innerHTML = '<p class="text-muted">Fabtrack non encore intégré (Phase 2)</p>';
}

async function refreshWidgetImprimantes() {
    const el = document.getElementById('widget-imprimantes-data');
    if (!el) return;
    
    el.innerHTML = '<p class="text-muted">Imprimantes non encore intégrées (Phase 4)</p>';
}

// ========== HORLOGE GLOBALE ==========
function updateClock() {
    refreshWidgetHorloge();
}
