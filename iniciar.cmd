@echo off
rem Sobe o servidor do Orbit em segundo plano (se ainda nao estiver no ar) e abre a pagina.
rem Com a tarefa de logon instalada (node logon.mjs instalar), sobe por ela: o servidor nasce fora
rem do VS Code. Sem a tarefa, o lancador.mjs sobe direto.
cd /d "%~dp0"
if exist "%~dp0logon.json" (
  schtasks /run /tn "Orbit Public - Claude Code" >nul 2>&1 || node "%~dp0lancador.mjs"
) else (
  node "%~dp0lancador.mjs"
)
powershell -NoProfile -Command "for ($i = 0; $i -lt 20; $i++) { try { Invoke-RestMethod http://127.0.0.1:47821/saude -TimeoutSec 1 | Out-Null; break } catch { Start-Sleep -Milliseconds 250 } }"
start "" http://127.0.0.1:47821
