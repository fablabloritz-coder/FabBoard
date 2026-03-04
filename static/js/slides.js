/**
 * SLIDES.JS — Gestion de l'interface d'administration des slides
 * Phase 1.5 : Système configurable de slides
 */

// ========== HELPERS ==========
/**
 * Échappe le HTML pour éviter les injections XSS
 * Fallback si utils.js n'est pas chargé
 */
function safeEscape(str) {
    if (typeof escapeHtml !== 'undefined') {
        return escapeHtml(str);
    }
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ========== STATE ==========
let currentSlides = [];
let currentLayouts = [];
let currentWidgets = [];
let selectedSlideId = null;
let sortableInstance = null;

// ========== INIT ==========
document.addEventListener('DOMContentLoaded', () => {
    loadInitialData();
    setupEventListeners();
});

async function loadInitialData() {
    try {
        console.log('[SLIDES] Chargement des données...');
        
        // Charger toutes les données en parallèle
        const [slidesRes, layoutsRes, widgetsRes] = await Promise.all([
            apiCall('/api/slides?include_inactive=true'),
            apiCall('/api/layouts'),
            apiCall('/api/widgets')
        ]);
        
        console.log('[SLIDES] Réponses reçues:', { slidesRes, layoutsRes, widgetsRes });
        
        currentSlides = slidesRes.data;
        currentLayouts = layoutsRes.data;
        currentWidgets = widgetsRes.data;
        
        console.log('[SLIDES] Données chargées:', {
            slides: currentSlides.length,
            layouts: currentLayouts.length,
            widgets: currentWidgets.length
        });
        
        renderSlidesList();
        initSortable();
        
        // Sélectionner la première slide par défaut
        if (currentSlides.length > 0) {
            selectSlide(currentSlides[0].id);
            console.log('[SLIDES] Slide sélectionnée:', currentSlides[0].id);
        } else {
            console.warn('[SLIDES] Aucune slide disponible');
        }
        
    } catch (error) {
        console.error('[SLIDES] Erreur lors du chargement:', error);
        showToast('Erreur lors du chargement des données', 'error');
    }
}

function setupEventListeners() {
    // Boutons principaux
    document.getElementById('btnAddSlide').addEventListener('click', openAddSlideModal);
    document.getElementById('btnSaveSlide').addEventListener('click', saveSlide);
    document.getElementById('btnDeleteSlide').addEventListener('click', deleteCurrentSlide);
    document.getElementById('btnRefreshPreview').addEventListener('click', refreshPreview);
    document.getElementById('btnFullscreenPreview').addEventListener('click', openFullscreenPreview);
    document.getElementById('btnSaveWidgetConfig').addEventListener('click', saveWidgetConfig);
}

// ========== SLIDES LIST ==========
function renderSlidesList() {
    const container = document.getElementById('slidesList');
    if (!container) {
        console.error('[SLIDES] Container slidesList introuvable');
        return;
    }
    
    if (currentSlides.length === 0) {
        container.innerHTML = `
            <div class="text-center text-muted p-4">
                <i class="bi bi-inbox"></i>
                <p>Aucune slide créée</p>
            </div>
        `;
        return;
    }
    
    try {
        const items = currentSlides.map(slide => {
            const isActive = slide.id === selectedSlideId;
            const isInactive = !slide.actif;
            const nom = safeEscape(slide.nom || 'Sans nom');
            const layoutNom = slide.layout_nom || 'Gabarit';
            const temps = slide.temps_affichage || 30;
            const ordre = slide.ordre || '';
            
            return `
                <div class="slide-item ${isInactive ? 'inactive' : ''} ${isActive ? 'active' : ''}" 
                     data-slide-id="${slide.id}"
                     onclick="selectSlide(${slide.id})">
                    <div class="slide-item-handle">
                        <i class="bi bi-grip-vertical"></i>
                    </div>
                    <div class="slide-item-order">${ordre}</div>
                    <div class="slide-item-content">
                        <div class="slide-item-title">${nom}</div>
                        <div class="slide-item-meta">
                            <span><i class="bi bi-grid-3x2"></i> ${layoutNom}</span>
                            <span><i class="bi bi-clock"></i> ${temps}s</span>
                        </div>
                    </div>
                </div>
            `;
        });
        
        container.innerHTML = items.join('');
        
        console.log('[SLIDES] Liste rendue:', currentSlides.length, 'slides');
        
        // Réinitialiser SortableJS après le rendu
        if (sortableInstance) {
            sortableInstance.destroy();
        }
        initSortable();
    } catch (e) {
        console.error('[SLIDES] Erreur renderSlidesList:', e);
        container.innerHTML = '<div class="alert alert-danger m-2">Erreur d\'affichage des slides</div>';
    }
}

function initSortable() {
    const container = document.getElementById('slidesList');
    
    // Vérifier qu'il y a des slides avant d'initialiser
    if (!container || currentSlides.length === 0) {
        return;
    }
    
    // S'assurer qu'il n'y a pas déjà une instance
    if (sortableInstance) {
        sortableInstance.destroy();
    }
    
    sortableInstance = Sortable.create(container, {
        animation: 200,
        handle: '.slide-item-handle',
        ghostClass: 'sortable-ghost',
        draggable: '.slide-item',
        onEnd: handleReorder
    });
}

async function handleReorder(evt) {
    const newOrder = Array.from(evt.to.children).map(el => {
        return parseInt(el.getAttribute('data-slide-id'));
    });
    
    try {
        await apiCall('/api/slides/reorder', 'PATCH', { order: newOrder });
        
        // Mettre à jour l'ordre localement
        currentSlides.sort((a, b) => {
            return newOrder.indexOf(a.id) - newOrder.indexOf(b.id);
        });
        currentSlides.forEach((slide, index) => {
            slide.ordre = index + 1;
        });
        
        renderSlidesList();
        showToast('Ordre des slides mis à jour', 'success');
    } catch (error) {
        showToast('Erreur lors de la réorganisation', 'error');
        renderSlidesList(); // Revenir à l'état précédent
    }
}

// ========== SLIDE SELECTION ==========
function selectSlide(slideId) {
    console.log('[SLIDES] Sélection de la slide:', slideId);
    selectedSlideId = slideId;
    renderSlidesList();
    
    try {
        renderPreview();
        console.log('[SLIDES] Aperçu rendu');
    } catch (e) {
        console.error('[SLIDES] Erreur renderPreview:', e);
    }
    
    try {
        renderConfig();
        console.log('[SLIDES] Configuration rendue');
    } catch (e) {
        console.error('[SLIDES] Erreur renderConfig:', e);
    }
    
    // Afficher le bouton de suppression
    const btnDelete = document.getElementById('btnDeleteSlide');
    if (btnDelete) {
       btnDelete.style.display = 'block';
    }
}

// ========== APERÇU ==========
function renderPreview() {
    const slide = currentSlides.find(s => s.id === selectedSlideId);
    if (!slide) return;
    
    const container = document.getElementById('previewContainer');
    const layout = JSON.parse(slide.grille_json);
    const slideWidgets = slide.widgets || [];
    
    // Construire la grille CSS
    const gridStyle = `
        grid-template-columns: repeat(${slide.colonnes}, 1fr);
        grid-template-rows: repeat(${slide.lignes}, 1fr);
    `;
    
    // Construire les widgets
    const widgetsHTML = layout.map((pos, index) => {
        const widget = slideWidgets.find(w => w.position === index);
        
        const style = `
            grid-column: ${pos.x + 1} / span ${pos.w};
            grid-row: ${pos.y + 1} / span ${pos.h};
        `;
        
        if (widget) {
            return `
                <div class="preview-widget" style="${style}">
                    <div class="preview-widget-icon">${widget.icone || '📦'}</div>
                    <div class="preview-widget-name">${widget.widget_nom || 'Widget'}</div>
                </div>
            `;
        } else {
            return `
                <div class="preview-widget preview-widget-empty" style="${style}">
                    <div class="preview-widget-icon">📦</div>
                    <div class="preview-widget-name">Position ${index + 1}</div>
                </div>
            `;
        }
    }).join('');
    
    container.innerHTML = `
        <div class="preview-grid" style="${gridStyle}">
            ${widgetsHTML}
        </div>
    `;
    
    // Mettre à jour les infos
    document.getElementById('previewLayoutName').textContent = slide.layout_nom || 'Gabarit personnalisé';
    document.getElementById('previewDuration').textContent = `Durée : ${slide.temps_affichage}s`;
}

function refreshPreview() {
    renderPreview();
    showToast('Aperçu actualisé', 'info');
}

function openFullscreenPreview() {
    // Ouvrir le dashboard dans un nouvel onglet
    window.open('/', '_blank');
}

// ========== CONFIGURATION ==========
function renderConfig() {
    const container = document.getElementById('configContainer');
    if (!container) {
        console.error('[SLIDES] Container configContainer introuvable');
        return;
    }
    
    const slide = currentSlides.find(s => s.id === selectedSlideId);
    if (!slide) {
        container.innerHTML = `
            <div class="empty-message">
                <p>Sélectionnez une slide pour la configurer</p>
            </div>
        `;
        return;
    }
    
    try {
        const layout = JSON.parse(slide.grille_json || '[]');
        const slideWidgets = slide.widgets || [];
        
        container.innerHTML = `
            <!-- Infos générales -->
            <div class="config-section">
                <div class="config-section-title">
                    <i class="bi bi-info-circle"></i> Informations
                </div>
                <div class="mb-2">
                    <strong>Nom :</strong> ${safeEscape(slide.nom || 'Sans nom')}
                </div>
                <div class="mb-2">
                    <strong>Layout :</strong> ${slide.layout_nom || 'Gabarit personnalisé'}
                </div>
                <div class="mb-2">
                    <strong>Durée :</strong> ${slide.temps_affichage || 30} secondes
                </div>
                <div class="mb-2">
                    <strong>Statut :</strong>
                    <span class="badge ${slide.actif ? 'bg-success' : 'bg-secondary'}">
                        ${slide.actif ? 'Active' : 'Inactive'}
                    </span>
                </div>
                <button class="btn btn-sm btn-outline-primary w-100" onclick="editSlide(${slide.id})">
                    <i class="bi bi-pencil"></i> Modifier
                </button>
            </div>
            
            <!-- Widgets -->
            <div class="config-section">
                <div class="config-section-title">
                    <i class="bi bi-grid-3x3"></i> Widgets (${slideWidgets.length}/${layout.length})
                </div>
                <div class="widget-position-grid">
                    ${layout.map((pos, index) => renderWidgetPosition(slide, index)).join('')}
                </div>
            </div>
        `;
        
        console.log('[SLIDES] Configuration rendue pour slide', slide.id);
    } catch (e) {
        console.error('[SLIDES] Erreur renderConfig:', e);
        container.innerHTML = '<div class="alert alert-danger">Erreur d\'affichage de la configuration</div>';
    }
}

function renderWidgetPosition(slide, position) {
    const slideWidgets = slide.widgets || [];
    const widget = slideWidgets.find(w => w.position === position);
    
    return `
        <div class="widget-position-item" onclick="selectWidgetForPosition(${slide.id}, ${position})">
            <div class="widget-position-header">
                <span class="widget-position-label">Position ${position + 1}</span>
                ${widget ? `
                    <div class="widget-position-actions">
                        <button class="btn btn-xs btn-outline-secondary" onclick="event.stopPropagation(); configureWidget(${slide.id}, ${position})">
                            <i class="bi bi-gear"></i>
                        </button>
                        <button class="btn btn-xs btn-outline-danger" onclick="event.stopPropagation(); removeWidget(${slide.id}, ${position})">
                            <i class="bi bi-x"></i>
                        </button>
                    </div>
                ` : ''}
            </div>
            <div class="widget-position-content">
                ${widget ? `
                    <div class="widget-position-icon">${widget.icone || '📦'}</div>
                    <div class="widget-position-name">${widget.widget_nom || 'Widget'}</div>
                ` : `
                    <div class="widget-position-icon">➕</div>
                    <div class="widget-position-name widget-position-empty">Cliquer pour ajouter</div>
                `}
            </div>
        </div>
    `;
}

// ========== MODAL : Ajouter/Modifier Slide ==========
function openAddSlideModal() {
    document.getElementById('slideModalTitle').textContent = 'Nouvelle Slide';
    document.getElementById('slideId').value = '';
    document.getElementById('slideName').value = '';
    document.getElementById('slideDuration').value = '30';
    document.getElementById('slideActive').checked = true;
    
    renderLayoutSelector();
    
    const modal = new bootstrap.Modal(document.getElementById('slideModal'));
    modal.show();
}

function editSlide(slideId) {
    const slide = currentSlides.find(s => s.id === slideId);
    if (!slide) return;
    
    document.getElementById('slideModalTitle').textContent = 'Modifier la Slide';
    document.getElementById('slideId').value = slide.id;
    document.getElementById('slideName').value = slide.nom;
    document.getElementById('slideDuration').value = slide.temps_affichage;
    document.getElementById('slideActive').checked = slide.actif === 1;
    
    renderLayoutSelector(slide.layout_id);
    
    const modal = new bootstrap.Modal(document.getElementById('slideModal'));
    modal.show();
}

function renderLayoutSelector(selectedLayoutId = null) {
    const container = document.getElementById('layoutSelector');
    
    container.innerHTML = currentLayouts.map(layout => {
        const grille = JSON.parse(layout.grille_json);
        const gridStyle = `
            grid-template-columns: repeat(${layout.colonnes}, 1fr);
            grid-template-rows: repeat(${layout.lignes}, 1fr);
        `;
        
        const cellsHTML = grille.map(pos => `
            <div class="layout-preview-cell" style="
                grid-column: ${pos.x + 1} / span ${pos.w};
                grid-row: ${pos.y + 1} / span ${pos.h};
            "></div>
        `).join('');
        
        return `
            <div class="layout-option ${layout.id === selectedLayoutId ? 'selected' : ''}" 
                 data-layout-id="${layout.id}"
                 onclick="selectLayout(${layout.id})">
                <div class="layout-preview" style="${gridStyle}">
                    ${cellsHTML}
                </div>
                <div class="layout-name">${layout.nom}</div>
            </div>
        `;
    }).join('');
}

function selectLayout(layoutId) {
    // Retirer la sélection précédente
    document.querySelectorAll('.layout-option').forEach(el => {
        el.classList.remove('selected');
    });
    
    // Ajouter la sélection
    document.querySelector(`[data-layout-id="${layoutId}"]`).classList.add('selected');
}

async function saveSlide() {
    const slideId = document.getElementById('slideId').value;
    const nom = document.getElementById('slideName').value.trim();
    const temps_affichage = parseInt(document.getElementById('slideDuration').value);
    const actif = document.getElementById('slideActive').checked ? 1 : 0;
    
    // Récupérer le layout sélectionné
    const selectedLayout = document.querySelector('.layout-option.selected');
    if (!selectedLayout) {
        showToast('Veuillez sélectionner un gabarit', 'warning');
        return;
    }
    
    const layout_id = parseInt(selectedLayout.getAttribute('data-layout-id'));
    
    if (!nom) {
        showToast('Le nom est requis', 'warning');
        return;
    }
    
    try {
        const data = { nom, layout_id, temps_affichage, actif };
        let result;
        let newSlideId;
        
        if (slideId) {
            // Modification
            result = await apiCall(`/api/slides/${slideId}`, 'PUT', data);
            const index = currentSlides.findIndex(s => s.id == slideId);
            currentSlides[index] = result.data;
            newSlideId = slideId;
            showToast('Slide modifiée avec succès', 'success');
        } else {
            // Création
            result = await apiCall('/api/slides', 'POST', data);
            currentSlides.push(result.data);
            newSlideId = result.data.id;
            showToast('Slide créée avec succès', 'success');
        }
        
        renderSlidesList();
        selectSlide(parseInt(newSlideId));
        
        // Fermer le modal
        bootstrap.Modal.getInstance(document.getElementById('slideModal')).hide();
        
    } catch (error) {
        showToast('Erreur lors de l\'enregistrement', 'error');
        console.error(error);
    }
}

async function deleteCurrentSlide() {
    if (!selectedSlideId) return;
    
    if (!confirm('Voulez-vous vraiment supprimer cette slide ?')) {
        return;
    }
    
    try {
        await apiCall(`/api/slides/${selectedSlideId}`, 'DELETE');
        
        currentSlides = currentSlides.filter(s => s.id !== selectedSlideId);
        selectedSlideId = null;
        
        renderSlidesList();
        document.getElementById('configContainer').innerHTML = `
            <div class="config-placeholder">
                <i class="bi bi-info-circle"></i>
                <p>Slide supprimée</p>
            </div>
        `;
        document.getElementById('previewContainer').innerHTML = `
            <div class="preview-placeholder">
                <i class="bi bi-tv-fill"></i>
                <p>Sélectionnez une slide</p>
            </div>
        `;
        document.getElementById('btnDeleteSlide').style.display = 'none';
        
        showToast('Slide supprimée', 'success');
        
        // Sélectionner une autre slide si disponible
        if (currentSlides.length > 0) {
            selectSlide(currentSlides[0].id);
        }
        
    } catch (error) {
        showToast('Erreur lors de la suppression', 'error');
        console.error(error);
    }
}

// ========== GESTION DES WIDGETS ==========
let currentEditingPosition = null;

function selectWidgetForPosition(slideId, position) {
    currentEditingPosition = { slideId, position };
    
    const container = document.getElementById('widgetConfigForm');
    
    container.innerHTML = `
        <div class="mb-3">
            <label class="form-label">Choisir un widget</label>
            <div class="widget-selector">
                ${currentWidgets.map(widget => `
                    <div class="widget-option" data-widget-id="${widget.id}" onclick="selectWidget(${widget.id})">
                        <div class="widget-option-icon">${widget.icone}</div>
                        <div class="widget-option-name">${widget.nom}</div>
                    </div>
                `).join('')}
            </div>
        </div>
    `;
    
    const modal = new bootstrap.Modal(document.getElementById('widgetConfigModal'));
    modal.show();
}

function selectWidget(widgetId) {
    document.querySelectorAll('.widget-option').forEach(el => el.classList.remove('selected'));
    document.querySelector(`[data-widget-id="${widgetId}"]`).classList.add('selected');
}

async function saveWidgetConfig() {
    if (!currentEditingPosition) return;
    
    const selectedWidget = document.querySelector('.widget-option.selected');
    if (!selectedWidget) {
        showToast('Veuillez sélectionner un widget', 'warning');
        return;
    }
    
    const widgetId = parseInt(selectedWidget.getAttribute('data-widget-id'));
    const { slideId, position } = currentEditingPosition;
    
    try {
        // Récupérer la slide actuelle
        const slide = currentSlides.find(s => s.id === slideId);
        
        // Mettre à jour ou ajouter le widget
        const existingWidgetIndex = slide.widgets.findIndex(w => w.position === position);
        if (existingWidgetIndex >= 0) {
            slide.widgets[existingWidgetIndex] = {
                ...slide.widgets[existingWidgetIndex],
                widget_id: widgetId,
                position: position
            };
        } else {
            slide.widgets.push({
                slide_id: slideId,
                widget_id: widgetId,
                position: position,
                config_json: '{}'
            });
        }
        
        // Sauvegarder via l'API
        await apiCall(`/api/slides/${slideId}`, 'PUT', {
            nom: slide.nom,
            layout_id: slide.layout_id,
            temps_affichage: slide.temps_affichage,
            actif: slide.actif,
            widgets: slide.widgets.map(w => ({
                widget_id: w.widget_id,
                position: w.position,
                config: JSON.parse(w.config_json || '{}')
            }))
        });
        
        // Rafraîchir l'affichage
        const updatedSlide = await apiCall(`/api/slides/${slideId}`);
        const index = currentSlides.findIndex(s => s.id === slideId);
        currentSlides[index] = updatedSlide.data;
        
        renderPreview();
        renderConfig();
        
        bootstrap.Modal.getInstance(document.getElementById('widgetConfigModal')).hide();
        showToast('Widget ajouté avec succès', 'success');
        
    } catch (error) {
        showToast('Erreur lors de l\'ajout du widget', 'error');
        console.error(error);
    }
}

function configureWidget(slideId, position) {
    // TODO: Ouvrir modal de configuration avancée du widget
    showToast('Configuration avancée à venir', 'info');
}

async function removeWidget(slideId, position) {
    if (!confirm('Retirer ce widget ?')) return;
    
    try {
        const slide = currentSlides.find(s => s.id === slideId);
        slide.widgets = slide.widgets.filter(w => w.position !== position);
        
        // Sauvegarder
        await apiCall(`/api/slides/${slideId}`, 'PUT', {
            nom: slide.nom,
            layout_id: slide.layout_id,
            temps_affichage: slide.temps_affichage,
            actif: slide.actif,
            widgets: slide.widgets.map(w => ({
                widget_id: w.widget_id,
                position: w.position,
                config: JSON.parse(w.config_json || '{}')
            }))
        });
        
        // Rafraîchir
        const updatedSlide = await apiCall(`/api/slides/${slideId}`);
        const index = currentSlides.findIndex(s => s.id === slideId);
        currentSlides[index] = updatedSlide.data;
        
        renderPreview();
        renderConfig();
        showToast('Widget retiré', 'success');
        
    } catch (error) {
        showToast('Erreur lors de la suppression', 'error');
        console.error(error);
    }
}
