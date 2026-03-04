FROM python:3.12-slim

LABEL maintainer="Fablab Loritz"
LABEL description="FabBoard - Dashboard TV pour Fablab"

# Variables d'environnement
ENV PYTHONUNBUFFERED=1
ENV FABBOARD_PORT=5580

# Répertoire de travail
WORKDIR /app

# Copier les dépendances et les installer
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copier le code source
COPY . .

# Créer le dossier de données
RUN mkdir -p /app/data

# Exposer le port
EXPOSE 5580

# Commande de démarrage
CMD ["python", "app.py"]
