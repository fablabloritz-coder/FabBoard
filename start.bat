@echo off
REM Script de lancement rapide pour Windows
REM Lance FabBoard en mode développement

echo ============================================================
echo   FabBoard - Tableau de bord Fablab
echo ============================================================
echo.

REM Vérifier si Python est installé
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERREUR] Python n'est pas installé ou pas dans le PATH
    echo Téléchargez Python sur https://www.python.org/downloads/
    pause
    exit /b 1
)

REM Aller dans le dossier fabboard
cd /d "%~dp0"

REM Vérifier si l'environnement virtuel existe
if not exist "venv\" (
    echo Creation de l'environnement virtuel...
    python -m venv venv
    call venv\Scripts\activate
    echo Installation des dependances...
    pip install -r requirements.txt
) else (
    call venv\Scripts\activate
)

REM Lancer l'application
echo.
echo Demarrage de l'application sur http://localhost:5580
echo Appuyez sur Ctrl+C pour arreter
echo.

set FLASK_ENV=development
python app.py

pause
