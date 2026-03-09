// FabBoard — Paramètres

/**
 * Initialisation de la page
 */
document.addEventListener('DOMContentLoaded', () => {
    loadParametres();
    loadSources();
    setupEventListeners();
});

const FONT_FAMILY_MAP = {
    inter: "'Inter', sans-serif",
    system: "system-ui, -apple-system, 'Segoe UI', sans-serif",
    serif: "Georgia, 'Times New Roman', serif",
    mono: "'Consolas', 'Courier New', monospace"
};

function applyFontFamily(fontFamilyKey) {
    const key = FONT_FAMILY_MAP[fontFamilyKey] ? fontFamilyKey : 'inter';
    document.documentElement.style.setProperty('--app-font-family', FONT_FAMILY_MAP[key]);
}

/**
 * Configure les écouteurs d'événements
 */
function setupEventListeners() {
    // Formulaire paramètres généraux
    document.getElementById('form-params-general').addEventListener('submit', (e) => {
        e.preventDefault();
        saveParametres();
    });
    
    // Formulaire ajout source
    document.getElementById('btn-save-source').addEventListener('click', saveSource);
}

/**
 * Charge les paramètres depuis l'API
 */
async function loadParametres() {
    try {
        const params = await apiCall('/api/parametres');
        
        document.getElementById('param-fablab-name').value = params.fablab_name || "Loritz'Lab";
        document.getElementById('param-refresh').value = params.refresh_interval || 30;
        document.getElementById('param-theme').value = params.theme || 'dark';
        document.getElementById('param-font-family').value = params.font_family || 'inter';
        applyFontFamily(params.font_family || 'inter');
    } catch (error) {
        console.error('Erreur chargement paramètres:', error);
    }
}

/**
 * Sauvegarde les paramètres
 */
async function saveParametres() {
    const params = {
        fablab_name: document.getElementById('param-fablab-name').value,
        refresh_interval: document.getElementById('param-refresh').value,
        theme: document.getElementById('param-theme').value,
        font_family: document.getElementById('param-font-family').value
    };
    
    try {
        await Promise.all([
            apiCall('/api/parametres/fablab_name', {
                method: 'PUT',
                body: JSON.stringify({ valeur: params.fablab_name })
            }),
            apiCall('/api/parametres/refresh_interval', {
                method: 'PUT',
                body: JSON.stringify({ valeur: params.refresh_interval })
            }),
            apiCall('/api/parametres/theme', {
                method: 'PUT',
                body: JSON.stringify({ valeur: params.theme })
            }),
            apiCall('/api/parametres/font_family', {
                method: 'PUT',
                body: JSON.stringify({ valeur: params.font_family })
            })
        ]);

        applyFontFamily(params.font_family);
        
        showToast('Paramètres enregistrés avec succès', 'success');
    } catch (error) {
        showToast(`Erreur : ${error.message}`, 'error');
    }
}

/**
 * Charge les sources de données
 */
async function loadSources() {
    const container = document.getElementById('sources-list');
    container.innerHTML = '<div class="text-center py-3"><div class="spinner-border text-primary"></div></div>';
    
    try {
        const data = await apiCall('/api/sources');
        
        if (data.data.length === 0) {
            container.innerHTML = '<p class="text-muted text-center py-3">Aucune source configurée</p>';
            return;
        }
        
        container.innerHTML = data.data.map(source => {
            const typeIcons = {
                'fabtrack': 'activity',
                'repetier': 'printer',
                'nextcloud_caldav': 'calendar',
                'prusalink': 'printer-fill'
            };
            const icon = typeIcons[source.type] || 'database';
            const lastSync = source.derniere_sync ? `Dernier test: ${escapeHtml(source.derniere_sync)}` : 'Jamais testé';
            const errorInfo = source.derniere_erreur ? `<br><small class="text-danger">${escapeHtml(source.derniere_erreur)}</small>` : '';
            
            return `
                <div class="list-group-item d-flex justify-content-between align-items-center">
                    <div>
                        <i class="bi bi-${icon}"></i>
                        <strong>${escapeHtml(source.nom)}</strong>
                        <br>
                        <small class="text-muted">${escapeHtml(source.url)}</small>
                        <br>
                        <small class="text-muted">${lastSync}</small>
                        ${errorInfo}
                    </div>
                    <div>
                        <span class="badge ${source.actif ? 'bg-success' : 'bg-secondary'}">
                            ${source.actif ? 'Actif' : 'Inactif'}
                        </span>
                        <button class="btn btn-sm btn-outline-primary ms-2" onclick="testSource(${source.id})">
                            <i class="bi bi-plug"></i>
                        </button>
                        <button class="btn btn-sm btn-outline-danger ms-2" onclick="deleteSource(${source.id})">
                            <i class="bi bi-trash"></i>
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    } catch (error) {
        container.innerHTML = `<p class="text-danger text-center">Erreur : ${error.message}</p>`;
    }
}

/**
 * Sauvegarde une nouvelle source
 */
async function saveSource() {
    const nom = document.getElementById('source-nom').value.trim();
    const type = document.getElementById('source-type').value;
    const url = document.getElementById('source-url').value.trim();
    const apikey = document.getElementById('source-apikey').value.trim();
    
    if (!nom || !type || !url) {
        showToast('Tous les champs obligatoires doivent être remplis', 'error');
        return;
    }
    
    const sourceData = {
        nom,
        type,
        url,
        credentials: {
            apikey: apikey || ''
        },
        actif: 1
    };
    
    try {
        await apiCall('/api/sources', {
            method: 'POST',
            body: JSON.stringify(sourceData)
        });
        
        showToast('Source ajoutée avec succès', 'success');
        
        // Fermer le modal et recharger
        bootstrap.Modal.getInstance(document.getElementById('modalSource')).hide();
        document.getElementById('form-source').reset();
        loadSources();
    } catch (error) {
        showToast(`Erreur : ${error.message}`, 'error');
    }
}

/**
 * Supprime une source
 */
async function deleteSource(id) {
    if (!confirm('Êtes-vous sûr de vouloir supprimer cette source ?')) {
        return;
    }
    
    try {
        await apiCall(`/api/sources/${id}`, { method: 'DELETE' });
        showToast('Source supprimée avec succès', 'success');
        loadSources();
    } catch (error) {
        showToast(`Erreur : ${error.message}`, 'error');
    }
}

/**
 * Teste la connectivité d'une source
 */
async function testSource(id) {
    try {
        const result = await apiCall(`/api/sources/${id}/test`, { method: 'POST' });
        if (result.success) {
            showToast('Connexion OK', 'success');
        } else {
            showToast(`Test échoué: ${result.error || 'Erreur inconnue'}`, 'warning');
        }
    } catch (error) {
        showToast(`Erreur test: ${error.message}`, 'error');
    } finally {
        loadSources();
    }
}
