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
let isRenderingSlides = false; // Flag pour éviter les rendus concurrents
let currentEditingWidgetConfig = null; // Contexte d'édition config avancée

// ========== INIT ==========
document.addEventListener('DOMContentLoaded', () => {
    console.log('[SLIDES] DOM Content Loaded');
    try {
        setupEventListeners();
        loadInitialData();
        
        // Réinitialiser le mode config avancée quand le modal se ferme
        const wcModal = document.getElementById('widgetConfigModal');
        if (wcModal) {
            wcModal.addEventListener('hidden.bs.modal', function() {
                currentEditingWidgetConfig = null;
            });
        }
    } catch (error) {
        console.error('[SLIDES] Erreur fatale lors de l\'initialisation:', error);
        const container = document.getElementById('slidesList');
        if (container) {
            container.innerHTML = '<div class="alert alert-danger m-2">Erreur critique d\'initialisation. Vérifiez la console.</div>';
        }
    }
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
        
        console.log('[SLIDES] Réponses reçues API:', {
            slides: slidesRes,
            layouts: layoutsRes,
            widgets: widgetsRes
        });
        
        // Validation des réponses
        if (!slidesRes || !slidesRes.data) {
            throw new Error('Réponse invalide pour /api/slides');
        }
        if (!layoutsRes || !layoutsRes.data) {
            throw new Error('Réponse invalide pour /api/layouts');
        }
        if (!widgetsRes || !widgetsRes.data) {
            throw new Error('Réponse invalide pour /api/widgets');
        }
        
        currentSlides = Array.isArray(slidesRes.data) ? slidesRes.data : [];
        currentLayouts = Array.isArray(layoutsRes.data) ? layoutsRes.data : [];
        currentWidgets = Array.isArray(widgetsRes.data) ? widgetsRes.data : [];
        
        console.log('[SLIDES] Données chargées avec succès:', {
            slides: currentSlides.length,
            layouts: currentLayouts.length,
            widgets: currentWidgets.length
        });
        
        // Vérifier que currentSlides est un array avant le rendu
        if (!Array.isArray(currentSlides)) {
            console.error('[SLIDES] currentSlides n\'est pas un array:', currentSlides);
            currentSlides = [];
        }
        
        renderSlidesList(); // renderSlidesList appelle initSortable() à la fin
        
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
    // Boutons principaux - avec protection contre les éléments manquants
    const buttons = {
        'btnAddSlide': openAddSlideModal,
        'btnSaveSlide': saveSlide,
        'btnDeleteSlide': deleteCurrentSlide,
        'btnRefreshPreview': refreshPreview,
        'btnFullscreenPreview': openFullscreenPreview,
        'btnSaveWidgetConfig': saveWidgetConfig
    };
    
    for (const [btnId, handler] of Object.entries(buttons)) {
        const btn = document.getElementById(btnId);
        if (btn) {
            btn.addEventListener('click', handler);
        } else {
            console.warn(`[SLIDES] Bouton ${btnId} non trouvé dans le DOM`);
        }
    }
    
    console.log('[SLIDES] Event listeners configurés');
}

// ========== SLIDES LIST ==========
function renderSlidesList() {
    // Éviter les rendus concurrents
    if (isRenderingSlides) {
        console.warn('[SLIDES] Rendu déjà en cours, ignoré');
        return;
    }
    
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
    
    isRenderingSlides = true;
    
    try {
        const items = currentSlides.map((slide, index) => {
            try {
                if (!slide || typeof slide !== 'object') {
                    console.warn('[SLIDES] Slide invalide a l\'index ' + index + ':', slide);
                    return '';
                }
                
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
            } catch (slideError) {
                console.error(`[SLIDES] Erreur rendering slide index ${index}:`, slideError, slide);
                return '';
            }
        });
        
        const htmlContent = items.filter(item => item).join('');
        container.innerHTML = htmlContent || '<div class="text-center text-muted p-4"><i class="bi bi-inbox"></i><p>Aucune slide valide</p></div>';
        
        console.log('[SLIDES] Liste rendue:', currentSlides.length, 'slides');
        
        // Réinitialiser SortableJS après que le DOM soit complètement rendu
        // Utiliser requestAnimationFrame pour s'assurer que innerHTML a fini de s'appliquer
        requestAnimationFrame(() => {
            if (sortableInstance) {
                try {
                    sortableInstance.destroy();
                    sortableInstance = null;
                } catch (e) {
                    console.warn('[SLIDES] Erreur destruction Sortable:', e);
                    sortableInstance = null;
                }
            }
            initSortable();
            // Libérer le flag après l'initialisation de Sortable
            isRenderingSlides = false;
        });
    } catch (e) {
        isRenderingSlides = false; // Libérer le flag en cas d'erreur
        console.error('[SLIDES] Erreur renderSlidesList:', e, 'Stack:', e.stack);
        console.error('[SLIDES] currentSlides:', currentSlides);
        container.innerHTML = '<div class="alert alert-danger m-2"><strong>Erreur d\'affichage des slides:</strong><br/>' + e.message + '</div>';
    }
}

function initSortable() {
    const container = document.getElementById('slidesList');
    
    // Vérifications de sécurité
    if (!container) {
        console.warn('[SLIDES] Container slidesList introuvable pour Sortable');
        return;
    }
    
    if (currentSlides.length === 0) {
        console.log('[SLIDES] Aucune slide, Sortable non initialisé');
        return;
    }
    
    // Vérifier que le conteneur a effectivement des éléments .slide-item
    const slideItems = container.querySelectorAll('.slide-item');
    if (slideItems.length === 0) {
        console.warn('[SLIDES] Aucun élément .slide-item trouvé dans le conteneur');
        return;
    }
    
    // Vérifier que SortableJS est chargé
    if (typeof Sortable === 'undefined') {
        console.warn('[SLIDES] SortableJS n\'est pas chargé. Drag/drop désactivé. Vérifiez le CDN jsdelivr.net');
        return;
    }
    
    // S'assurer qu'il n'y a pas déjà une instance
    if (sortableInstance) {
        try {
            sortableInstance.destroy();
            sortableInstance = null;
        } catch (e) {
            console.warn('[SLIDES] Erreur destruction instance Sortable existante:', e);
            sortableInstance = null;
        }
    }
    
    try {
        sortableInstance = Sortable.create(container, {
            animation: 200,
            handle: '.slide-item-handle',
            ghostClass: 'sortable-ghost',
            draggable: '.slide-item',
            onEnd: handleReorder
        });
        console.log('[SLIDES] SortableJS initialisé avec succès sur', slideItems.length, 'slides');
    } catch (error) {
        console.error('[SLIDES] Erreur lors de l\'initialisation de Sortable:', error);
        sortableInstance = null;
    }
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
    // Mode configuration avancée
    if (currentEditingWidgetConfig) {
        return saveWidgetAdvancedConfig();
    }
    
    // Mode sélection de widget
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

// ========== CONFIGURATION AVANCÉE DES WIDGETS ==========

/**
 * Définitions des options de configuration par type de widget
 */
const WIDGET_CONFIG_DEFINITIONS = {
    horloge: {
        titre: 'Horloge',
        fields: [
            { key: 'format', label: 'Format horaire', type: 'select', options: [
                { value: '24h', label: '24 heures' },
                { value: '12h', label: '12 heures (AM/PM)' }
            ], default: '24h' },
            { key: 'afficher_secondes', label: 'Afficher les secondes', type: 'checkbox', default: true },
            { key: 'afficher_date', label: 'Afficher la date', type: 'checkbox', default: true }
        ]
    },
    texte_libre: {
        titre: 'Texte libre',
        fields: [
            { key: 'titre', label: 'Titre', type: 'text', default: 'Information', placeholder: 'Titre du bloc' },
            { key: 'texte', label: 'Contenu', type: 'textarea', default: '', placeholder: 'Texte à afficher...' },
            { key: 'taille_texte', label: 'Taille du texte', type: 'select', options: [
                { value: 'small', label: 'Petit' },
                { value: 'normal', label: 'Normal' },
                { value: 'large', label: 'Grand' },
                { value: 'xlarge', label: 'Très grand' }
            ], default: 'normal' },
            { key: 'alignement', label: 'Alignement', type: 'select', options: [
                { value: 'left', label: 'Gauche' },
                { value: 'center', label: 'Centré' },
                { value: 'right', label: 'Droite' }
            ], default: 'left' }
        ]
    },
    compteurs: {
        titre: 'Compteurs Fabtrack',
        fields: [
            { key: 'afficher_en_attente', label: 'Afficher "À faire"', type: 'checkbox', default: true },
            { key: 'afficher_en_cours', label: 'Afficher "En cours"', type: 'checkbox', default: true },
            { key: 'afficher_termines', label: 'Afficher "Terminées"', type: 'checkbox', default: true }
        ]
    },
    activites: {
        titre: 'Activités Fabtrack',
        fields: [
            { key: 'nombre_max', label: "Nombre max d'activités", type: 'number', default: 5, min: 1, max: 20 },
            { key: 'filtre_urgence', label: 'Filtrer par urgence', type: 'select', options: [
                { value: '', label: 'Toutes' },
                { value: 'haute', label: 'Haute uniquement' },
                { value: 'moyenne', label: 'Moyenne et +' },
                { value: 'basse', label: 'Basse et +' }
            ], default: '' }
        ]
    },
    calendrier: {
        titre: 'Événements calendrier',
        fields: [
            { key: 'nombre_max', label: "Nombre max d'événements", type: 'number', default: 5, min: 1, max: 15 },
            { key: 'jours_avance', label: "Jours à l'avance", type: 'number', default: 7, min: 1, max: 30 }
        ]
    },
    meteo: {
        titre: 'Météo',
        fields: [
            { key: 'ville', label: 'Ville', type: 'text', default: '', placeholder: 'Ex: Nancy, FR' },
            { key: 'unite', label: 'Unité', type: 'select', options: [
                { value: 'celsius', label: 'Celsius (°C)' },
                { value: 'fahrenheit', label: 'Fahrenheit (°F)' }
            ], default: 'celsius' }
        ]
    },
    fabtrack_stats: {
        titre: 'Stats Fabtrack',
        fields: [
            { key: 'periode', label: 'Période', type: 'select', options: [
                { value: 'jour', label: "Aujourd'hui" },
                { value: 'semaine', label: 'Cette semaine' },
                { value: 'mois', label: 'Ce mois' }
            ], default: 'jour' }
        ]
    },
    fabtrack_machines: {
        titre: 'État machines',
        fields: [
            { key: 'afficher_inactives', label: 'Afficher les machines inactives', type: 'checkbox', default: false }
        ]
    },
    fabtrack_conso: {
        titre: 'Dernières consommations',
        fields: [
            { key: 'nombre_max', label: 'Nombre max', type: 'number', default: 5, min: 1, max: 20 }
        ]
    },
    imprimantes: {
        titre: 'Imprimantes 3D',
        fields: [
            { key: 'afficher_inactives', label: 'Afficher les imprimantes hors-ligne', type: 'checkbox', default: false }
        ]
    }
};

function configureWidget(slideId, position) {
    const slide = currentSlides.find(s => s.id === slideId);
    if (!slide) return;
    
    const widget = slide.widgets.find(w => w.position === position);
    if (!widget) {
        showToast('Aucun widget à cette position', 'warning');
        return;
    }
    
    const widgetCode = widget.widget_code;
    const configDef = WIDGET_CONFIG_DEFINITIONS[widgetCode];
    
    if (!configDef || configDef.fields.length === 0) {
        showToast('Aucune option de configuration pour ce widget', 'info');
        return;
    }
    
    // Charger la config existante
    let currentConfig = {};
    try { currentConfig = JSON.parse(widget.config_json || '{}'); } catch(e) {}
    
    // Stocker le contexte d'édition
    currentEditingWidgetConfig = { slideId, position, widgetCode };
    
    // Construire le formulaire
    const formEl = document.getElementById('widgetConfigForm');
    formEl.innerHTML = buildWidgetConfigForm(configDef, currentConfig);
    
    // Mettre à jour le titre du modal
    const modalTitle = document.querySelector('#widgetConfigModal .modal-title');
    modalTitle.textContent = 'Configurer : ' + configDef.titre;
    
    // Ouvrir le modal
    const modal = new bootstrap.Modal(document.getElementById('widgetConfigModal'));
    modal.show();
}

function buildWidgetConfigForm(configDef, currentConfig) {
    return configDef.fields.map(field => {
        const value = currentConfig[field.key] !== undefined ? currentConfig[field.key] : field.default;
        
        switch (field.type) {
            case 'text':
                return '<div class="mb-3">' +
                    '<label class="form-label">' + escapeHtml(field.label) + '</label>' +
                    '<input type="text" class="form-control" data-config-key="' + field.key + '" ' +
                    'value="' + escapeHtml(String(value || '')) + '" ' +
                    'placeholder="' + escapeHtml(field.placeholder || '') + '">' +
                    '</div>';
            
            case 'number':
                return '<div class="mb-3">' +
                    '<label class="form-label">' + escapeHtml(field.label) + '</label>' +
                    '<input type="number" class="form-control" data-config-key="' + field.key + '" ' +
                    'value="' + value + '" ' +
                    (field.min !== undefined ? 'min="' + field.min + '" ' : '') +
                    (field.max !== undefined ? 'max="' + field.max + '" ' : '') + '>' +
                    '</div>';
            
            case 'textarea':
                return '<div class="mb-3">' +
                    '<label class="form-label">' + escapeHtml(field.label) + '</label>' +
                    '<textarea class="form-control" data-config-key="' + field.key + '" rows="4" ' +
                    'placeholder="' + escapeHtml(field.placeholder || '') + '">' +
                    escapeHtml(String(value || '')) + '</textarea>' +
                    '</div>';
            
            case 'select':
                return '<div class="mb-3">' +
                    '<label class="form-label">' + escapeHtml(field.label) + '</label>' +
                    '<select class="form-select" data-config-key="' + field.key + '">' +
                    field.options.map(function(opt) {
                        return '<option value="' + escapeHtml(opt.value) + '"' +
                            (String(value) === String(opt.value) ? ' selected' : '') + '>' +
                            escapeHtml(opt.label) + '</option>';
                    }).join('') +
                    '</select>' +
                    '</div>';
            
            case 'checkbox':
                return '<div class="mb-3">' +
                    '<div class="form-check form-switch">' +
                    '<input class="form-check-input" type="checkbox" data-config-key="' + field.key + '" ' +
                    (value ? 'checked' : '') + '>' +
                    '<label class="form-check-label">' + escapeHtml(field.label) + '</label>' +
                    '</div>' +
                    '</div>';
            
            default:
                return '';
        }
    }).join('');
}

async function saveWidgetAdvancedConfig() {
    if (!currentEditingWidgetConfig) return;
    
    const { slideId, position, widgetCode } = currentEditingWidgetConfig;
    const configDef = WIDGET_CONFIG_DEFINITIONS[widgetCode];
    if (!configDef) return;
    
    // Collecter les valeurs du formulaire
    const newConfig = {};
    const formEl = document.getElementById('widgetConfigForm');
    
    configDef.fields.forEach(function(field) {
        const input = formEl.querySelector('[data-config-key="' + field.key + '"]');
        if (!input) return;
        
        switch (field.type) {
            case 'checkbox':
                newConfig[field.key] = input.checked;
                break;
            case 'number':
                newConfig[field.key] = parseInt(input.value) || field.default;
                break;
            default:
                newConfig[field.key] = input.value;
                break;
        }
    });
    
    try {
        // Mettre à jour la config du widget dans la slide
        const slide = currentSlides.find(s => s.id === slideId);
        const widget = slide.widgets.find(w => w.position === position);
        widget.config_json = JSON.stringify(newConfig);
        
        // Sauvegarder via l'API
        await apiCall('/api/slides/' + slideId, 'PUT', {
            nom: slide.nom,
            layout_id: slide.layout_id,
            temps_affichage: slide.temps_affichage,
            actif: slide.actif,
            widgets: slide.widgets.map(function(w) {
                return {
                    widget_id: w.widget_id,
                    position: w.position,
                    config: JSON.parse(w.config_json || '{}')
                };
            })
        });
        
        // Rafraîchir les données
        const updatedSlide = await apiCall('/api/slides/' + slideId);
        const index = currentSlides.findIndex(s => s.id === slideId);
        currentSlides[index] = updatedSlide.data;
        
        renderPreview();
        renderConfig();
        
        bootstrap.Modal.getInstance(document.getElementById('widgetConfigModal')).hide();
        showToast('Configuration sauvegardée', 'success');
        
    } catch (error) {
        showToast('Erreur lors de la sauvegarde', 'error');
        console.error(error);
    }
    
    currentEditingWidgetConfig = null;
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
