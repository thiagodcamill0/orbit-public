# Orbit — leitor dos controles de mídia do Windows (o painel das teclas de volume), para o midia.mjs.
# Fica vivo enquanto o midia.mjs quiser: lê o estado a cada ~1 s e manda uma linha só quando muda.
#  - saída: cada linha é um JSON em UTF-8, em base64 (o console do PowerShell usa a página de código local);
#      { nenhum = $true }                       nenhuma sessão de mídia
#      { app, estado, titulo, artista, album, play, prox, ant, capa }   capa = base64 da imagem ou ''
#      { erro = '...' }                         a leitura falhou (o midia.mjs registra uma vez)
#  - entrada: uma linha por comando, "acao<TAB>app". Ações: alternar, tocar, pausar, proxima, anterior,
#    abrir-spotify, fixar (o midia.mjs diz qual app está na tela ao subir). O app só escolhe entre as sessões
#    que existem; nada da entrada vira código.
# Escolha da sessão: só o que está tocando (Spotify > o app já na tela > a "atual" do Windows). Nada tocando:
# a sessão do app que estava na tela, pausada; sem ela, { nenhum }. Abas e players pausados nunca entram.
# Depois de um comando, lê de 120 em 120 ms por 2 s: o widget muda logo depois do clique.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$metodos = [System.WindowsRuntimeSystemExtensions].GetMethods()
$asOp = ($metodos | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Esperar($op, [Type]$tipo) {
  $t = $asOp.MakeGenericMethod($tipo).Invoke($null, @($op))
  if (-not $t.Wait(4000)) { throw 'o Windows demorou a responder' }
  $t.Result
}
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.IInputStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
$TGer = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$TProps = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
$TFluxo = [Windows.Storage.Streams.IRandomAccessStreamWithContentType]
# No PowerShell 5.1 a imagem chega como __ComObject: a conversão para Stream só vai por reflexão.
$paraStream = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStreamForRead', [Type[]]@([Windows.Storage.Streams.IInputStream]))
$ger = Esperar ($TGer::RequestAsync()) $TGer
$utf8 = New-Object System.Text.UTF8Encoding $false

function Enviar($o) {
  $j = $o | ConvertTo-Json -Compress -Depth 3
  [Console]::Out.WriteLine([Convert]::ToBase64String($utf8.GetBytes($j)))
  [Console]::Out.Flush()
}

function EstadoDe($s) {
  switch ("$($s.GetPlaybackInfo().PlaybackStatus)") { 'Playing' { 'tocando' } 'Paused' { 'pausado' } default { 'parado' } }
}

$script:fixo = '' # app da sessão na tela

function Escolher {
  $ss = @($ger.GetSessions())
  if ($ss.Count -eq 0) { return $null }
  $atual = $ger.GetCurrentSession()
  $idAtual = if ($atual) { $atual.SourceAppUserModelId } else { '' }
  $melhor = $null; $nota = -1; $doFixo = $null
  foreach ($s in $ss) {
    $app = $s.SourceAppUserModelId
    if ($script:fixo -and $app -eq $script:fixo) { $doFixo = $s }
    if ((EstadoDe $s) -ne 'tocando') { continue }
    $n = 0
    if ($app -match 'spotify') { $n += 20 }
    if ($script:fixo -and $app -eq $script:fixo) { $n += 10 }
    if ($app -eq $idAtual) { $n += 5 }
    if ($n -gt $nota) { $melhor = $s; $nota = $n }
  }
  if ($melhor) { $script:fixo = $melhor.SourceAppUserModelId; return $melhor }
  $doFixo
}

$script:ultimo = ''
$script:capaDe = ''
$script:capa = ''
$script:tentativas = 0

function Ler {
  $s = Escolher
  if (-not $s) { $o = [ordered]@{ nenhum = $true } }
  else {
    $p = Esperar ($s.TryGetMediaPropertiesAsync()) $TProps
    $c = $s.GetPlaybackInfo().Controls
    $chave = "$($s.SourceAppUserModelId)|$($p.Title)|$($p.Artist)|$($p.AlbumTitle)"
    if ($chave -ne $script:capaDe) { $script:capaDe = $chave; $script:capa = ''; $script:tentativas = 0 }
    # O navegador às vezes manda a capa um pouco depois do título: tenta de novo algumas vezes.
    if (-not $script:capa -and $script:tentativas -lt 15 -and $p.Thumbnail) {
      $script:tentativas++
      try {
        $fluxo = Esperar ($p.Thumbnail.OpenReadAsync()) $TFluxo
        $st = $paraStream.Invoke($null, @($fluxo))
        $ms = New-Object System.IO.MemoryStream
        $st.CopyTo($ms)
        $st.Dispose()
        if ($ms.Length -gt 0 -and $ms.Length -le 1MB) { $script:capa = [Convert]::ToBase64String($ms.ToArray()) }
      } catch {}
    }
    $o = [ordered]@{
      app = "$($s.SourceAppUserModelId)"; estado = (EstadoDe $s)
      titulo = "$($p.Title)"; artista = "$($p.Artist)"; album = "$($p.AlbumTitle)"
      play = [bool]($c.IsPlayPauseToggleEnabled -or $c.IsPlayEnabled -or $c.IsPauseEnabled)
      prox = [bool]$c.IsNextEnabled; ant = [bool]$c.IsPreviousEnabled
      capa = $script:capa
    }
  }
  $j = $o | ConvertTo-Json -Compress -Depth 3
  if ($j -ne $script:ultimo) { $script:ultimo = $j; Enviar $o }
}

function Comando($linha) {
  $partes = "$linha".Split("`t")
  $acao = $partes[0]
  if ($acao -eq 'abrir-spotify') { Start-Process 'spotify:'; return }
  $app = if ($partes.Count -gt 1) { $partes[1] } else { '' }
  if ($acao -eq 'fixar') { $script:fixo = $app; return }
  $s = $null
  foreach ($x in $ger.GetSessions()) { if ($x.SourceAppUserModelId -eq $app) { $s = $x } }
  if (-not $s) { $s = Escolher }
  if (-not $s) { return }
  $op = switch ($acao) {
    'alternar' { $s.TryTogglePlayPauseAsync() }
    'tocar' { $s.TryPlayAsync() }
    'pausar' { $s.TryPauseAsync() }
    'proxima' { $s.TrySkipNextAsync() }
    'anterior' { $s.TrySkipPreviousAsync() }
    default { $null }
  }
  if ($op) { [void](Esperar $op ([bool])) }
}

# O Console.In do .NET Framework lê de forma síncrona até no ReadLineAsync: um StreamReader próprio não trava o laço.
$entrada = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
$pedido = $entrada.ReadLineAsync()
$proxima = [DateTime]::MinValue
$rapidoAte = [DateTime]::MinValue
while ($true) {
  if ($pedido.IsCompleted) {
    $linha = $pedido.Result
    if ($null -eq $linha) { break } # o midia.mjs fechou a entrada: fim
    try { Comando $linha } catch { Enviar @{ erro = 'comando: ' + $_.Exception.Message } }
    $pedido = $entrada.ReadLineAsync()
    $rapidoAte = (Get-Date).AddMilliseconds(2000)
    $proxima = (Get-Date).AddMilliseconds(100)
  }
  if ((Get-Date) -ge $proxima) {
    try { Ler } catch { Enviar @{ erro = $_.Exception.Message } }
    $proxima = (Get-Date).AddMilliseconds($(if ((Get-Date) -lt $rapidoAte) { 120 } else { 1000 }))
  }
  Start-Sleep -Milliseconds 40
}
