@echo off
rem Desliga o servidor do Orbit. O proximo evento de qualquer sessao sobe ele de novo.
powershell -NoProfile -Command "try { Invoke-RestMethod http://127.0.0.1:47821/desligar -Method Post -Headers @{ 'x-gerenciador' = '1' } -UserAgent 'parar.cmd' -TimeoutSec 2 | Out-Null; 'Servidor desligado.' } catch { 'O servidor nao estava no ar.' }"
