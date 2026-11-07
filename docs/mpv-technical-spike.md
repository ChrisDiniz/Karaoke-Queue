# Spike técnico de playback: mpv e Chromium/Electron

**Status:** comparação isolada Linux/Windows preservada como histórico; Chromium/Electron foi selecionado pelo responsável do produto para a engine inicial. Na Phase 5B.1, o operador confirmou áudio audível; a decisão aprovada para a Phase 5C registra também sincronização A/V percebida como aceitável. A integração técnica de produção está documentada na seção 14.

> **Direção atual:** referências futuras a “Phase 7” neste registro usam a numeração histórica da arquitetura remota e correspondem à atual Fase H (integração operacional Gestão + Player). Preserve os resultados do spike; consulte o [roadmap atual](standalone-player-roadmap.md) para a sequência A–H.

## 1. Objetivo e limites

Avaliar arquivos de amostra fornecidos pelo operador, parser/decode em ferramentas locais e os contratos de controle/eventos do mpv, comparando com Chrome/Chromium e Electron em Linux. Nenhuma amostra foi alterada. Não houve integração com o app, mudança de banco, tela ou distribuição de binários.

Os resultados distinguem observação do experimento, expectativa documentada e itens não testados. Um teste headless prova parsing/decodificação em determinadas condições, mas não comprova saída audível, apresentação visual em monitor, sincronização A/V nem compatibilidade de um instalador.

## 2. Ambiente e ferramentas

| Item | Ambiente observado |
|---|---|
| Data | 30/10/2026, horário local |
| Sistema | Ubuntu 24.04 x86_64 sob WSL2 |
| mpv | 0.37.0, extraído temporariamente de pacote em diretório temporário |
| FFmpeg/ffprobe | 6.1.1-3ubuntu5, extraídos temporariamente |
| Instalação global | mpv ausente em `dpkg-query`; nenhum pacote instalado no sistema |
| Chrome headless | 154.0.8037.57 com Playwright/CDP |
| Electron isolado | Electron 45.0.0 / Chromium 156.0.8078.48, harness temporário sob Xvfb, GPU desabilitada |

O FFmpeg usado no teste incluía GPL/libx264. Foi ferramenta temporária de análise, não uma build recomendada para distribuição. Os pacotes e artefatos temporários foram removidos ao final. O teste nativo Windows não foi executado devido à limitação de interoperabilidade WSL disponível neste ambiente.

## 3. Amostras e inspeção do CSV

Foram examinados 21 vídeos MP4 e um catálogo CSV local. Não são incluídos caminhos absolutos, nomes de faixa/artistas, dados brutos ou hashes das amostras neste documento.

CSV observado:

| Propriedade | Resultado |
|---|---|
| Encoding | UTF-8 estrito com BOM |
| Delimitador | `;` |
| Cabeçalho | `artista;numero;nome_musica` |
| Registros / linhas físicas | 13.988 registros em 13.989 linhas físicas |
| Estrutura | 3 campos por registro; sem erro estrutural ou newline embutido |
| Aspas e conteúdo | 9 registros com campos citados; 440 campos continham vírgula; nenhum continha `;` |
| Códigos | 1–5 dígitos ASCII, sem zeros iniciais; faixa observada de 4–5 dígitos; sem códigos inválidos ou duplicados |
| Metadados ausentes | 2 registros sem artista e 7 sem título |

**Recomendação para implementação futura:** aceitar BOM, UTF-8 estrito, delimitador semicolon e o cabeçalho `nome_musica`; preservar `numero` como string. Campos descritivos vazios devem produzir diagnóstico, não rejeição do arquivo completo. Essas amostras sustentam as regras `CatalogCode` já registradas na arquitetura.

## 4. Inspeção dos vídeos e matching

Os 21 arquivos tinham prefixos únicos de cinco dígitos, da faixa `01001`–`01021`. Todos correspondem aos códigos CSV `1001`–`1021` aplicando padding à esquerda até cinco dígitos. Nenhum dos 21 vídeos ficou sem metadados CSV, nem houve duplicidade entre os prefixos amostrados. Os 13.967 outros códigos do catálogo não apareceram nesta amostra pequena; isso não demonstra ausência de vídeo no acervo completo.

Todos os 21 arquivos apresentaram as mesmas características de stream:

| Propriedade | Resultado observado |
|---|---|
| Contêiner | MP4 / ISO BMFF |
| Vídeo | Um stream H.264/AVC Main, 1024×768, 30 fps |
| Áudio | Um stream AAC-LC, estéreo, 48 kHz |
| Legendas | Nenhum stream de legenda encontrado |
| Duração | 135,033–241,467 segundos |
| Tamanho | 19.700.322–35.216.550 bytes por arquivo |
| Volume combinado | 619.896.432 bytes, aproximadamente 591 MiB |

**Integridade:** FFmpeg fez full decode de vídeo e áudio em todos os arquivos com `-v error -xerror -err_detect explode`, sem erros (21/21); nenhum arquivo corrompido foi detectado. Hashes antes e depois da inspeção foram idênticos para os 21 MP4 e o CSV (22/22), confirmando que os originais não foram modificados. Full decode não comprova que alto-falantes, monitor ou sincronização A/V funcionem corretamente.

Comando representativo, repetido individualmente para cada arquivo com caminho substituído pelo operador:

```text
ffmpeg -v error -xerror -err_detect explode -i <file> -map 0:v:0 -map 0:a:0 -f null -
```

## 5. Metodologia do mpv — resultados históricos Linux (Phase 1)

O mpv foi iniciado sem configuração do usuário e em modo headless, com saídas nulas, aceleração por hardware desabilitada, sem janela e JSON IPC por socket Unix privado com permissões `0600`. As opções essenciais foram equivalentes a:

```text
--no-config --idle=yes --ao=null --vo=null --hwdec=no
--terminal=no --force-window=no --osc=no
--input-ipc-server=<socket Unix privado>
```

Foram exercitados carregamento e início, pausa/retomada, restart, troca de arquivo, STOP, EOF acelerado, encerramento gracioso, caminho ausente, conteúdo inválido, comandos rápidos, SIGKILL, novo processo e recuperação. O EOF foi acelerado reproduzindo uma amostra em velocidade 16. Os sinks nulos deliberadamente evitam alegar saída de som ou imagem.

### 5.1 Resultados e eventos observados no Linux (Phase 1)

| Operação | Resultado observado |
|---|---|
| `loadfile` | Resposta IPC `error: success` chega antes de `file-loaded` e `playback-restart`; ACK não prova que mídia carregou. |
| Início | `pause=false` junto com avanço de `time-pos` confirmou playback iniciado. |
| Pause/resume | `time-pos` parou durante pause e voltou a avançar após resume. |
| Restart | `seek 0 absolute exact` enquanto pausado zerou `time-pos` na mesma source; não emitiu `end-file`. |
| Substituição de arquivo | Emissão de `end-file reason=stop` e `playlist_entry_id` para o item substituído. |
| STOP explícito | Também emitiu `end-file reason=stop` com `playlist_entry_id`; por si só não distingue STOP de substituição. |
| EOF acelerado | Emissão de `end-file reason=eof`, `file_error:null` e `playlist_entry_id`. A propriedade `eof-reached` já não estava disponível depois de o Player entrar em idle. Isso descreve o evento observado, não valida que o conteúdo terminou íntegro/completo. |
| Arquivo ausente/inválido | `loadfile` ainda respondeu success; terminal veio como `reason=error`, com `file_error=loading failed` ou `unrecognized file format`. |
| Sequência rápida | Vários comandos receberam ACK success, embora o item subsequente pudesse parar antes de `file-loaded`; correlacionar ACK não basta para inferir a ordem de estados concluídos. |
| SIGKILL | Código de saída -9, sem evento terminal; novo processo ficou idle, `path=null`, sem retomar playback. |
| Nova carga após restart do processo | Começou explicitamente com novo `playlist_entry_id`; processo novo não retomou sozinho. |
| Quit gracioso | Código de saída 0 e `end-file reason=quit`. |

Propriedades observadas incluíram `path`, `duration`, `pause`, `time-pos`, `idle-active`, `video-params`, `audio-params` e `track-list`. `eof-reached` não serviu como fonte após transição a idle. ACK, arquivo carregado, início, pausa, EOF, STOP, erro e encerramento do processo são fatos distintos.

### 5.2 Consequências históricas para contrato e recuperação (Linux, Phase 1)

- O fim de arquivo isolado não é prova de que uma música foi cantada. Mesmo início observado + EOF correlacionado à sessão, apresentação, faixa e `playbackId` + ausência de erro explícito não é suficiente: um arquivo truncado/incompleto pode atingir EOF sem reportar erro. Antes da implementação, definir critério adicional de integridade/fim completo adequado ao engine; duração e erros de decoder são evidências possíveis, mas nenhuma regra é escolhida neste spike. Até existir evidência suficiente, preservar `UNKNOWN` e solicitar resolução operacional.
- `reason=stop` aparece tanto para STOP quanto para substituição; a intenção do Controller e a geração/ID imutável associados à carga precisam contextualizar o evento. Não reinterpretar STOP ou troca como conclusão natural.
- Erro de load deve ser distinguido de ACK de comando. Arquivo inválido/ausente pode ter ACK success seguido por erro terminal.
- O `playlist_entry_id` correlaciona entradas internas do mpv, mas reinicia em contexto/processo e não substitui o `playbackId` do protocolo. Associar cada carga a contexto imutável contendo epoch do Player, playlist entry ID, playbackId, sessionId, presentationId e trackIndex; descartar eventos de geração obsoleta.
- SIGKILL não gera evento terminal. Após crash, sem evidência durável de fim natural, manter resultado incerto e não retomar nem completar automaticamente.
- Um leitor IPC serializado deve associar respostas por `request_id` e eventos por propriedade/contexto. Não tratar ACK de sequência rápida como confirmação de que cada arquivo chegou ao estado carregado/iniciado.

## 6. Comparação Chromium/Electron — resultados históricos Linux (Phase 1)

| Plataforma/engine e escopo | Resultado | Classificação |
|---|---|---|
| Chrome 154 headless, 21 arquivos amostrados | Metadata e `playing`; CDP reportou `FFmpegVideoDecoder`/`FFmpegAudioDecoder`; H.264 Main/AAC estéreo, frames e bytes de áudio decodificados. Pause/resume/restart/troca/limpeza da source funcionaram. Arquivo ausente produziu erro de mídia code 4. Uma faixa atingiu `ended` em playbackRate 16. | **PARCIALMENTE VERIFICADO** |
| Electron 45 / Chromium 156 isolado sob Xvfb, três arquivos representativos | Frames e bytes de áudio decodificados a 1024×768; pause/resume/restart/troca/stop; EOF em speed 16; missing code 4. | **PARCIALMENTE VERIFICADO** |
| A/V audível ou sincronizado, monitor físico, fullscreen com monitor, aceleração por hardware | Não avaliado. Os testes Chrome/Electron estavam muted/headless ou sem monitor físico; GPU desabilitada no Electron. | **NÃO TESTADO** |
| Windows, artefato empacotado e demais contêineres/codecs | Não avaliado. | **NÃO TESTADO** |

Chrome cobriu 21/21 em Linux; Electron cobriu apenas os três arquivos representativos. Os resultados mostram decode no build Linux exato, não garantem que todas as distribuições Electron carreguem os mesmos codecs. Chromium informa ressalvas para H.264/AAC conforme build e distribuição; a opção alternate FFmpeg do electron-builder remove codecs proprietários. A matriz é, portanto, específica ao artefato e deve ser repetida no build distribuído.

## 7. mpv versus Chromium — avaliação prática histórica Linux (Phase 1)

| Critério | Chromium/Electron | mpv sidecar |
|---|---|---|
| Compatibilidade observada | H.264/AAC das amostras decodificou nos builds Linux testados; não há evidência de Windows/build de release. | Os arquivos decodificaram via ferramenta FFmpeg e os controles/eventos foram exercitados com mpv headless. Isso não prova saída A/V real. |
| Controles e eventos | APIs HTMLMediaElement familiares; lifecycle de `playing`, `pause`, `ended`, `error`; retorno ao app em processo Renderer. | JSON IPC estruturado e muitas propriedades/eventos; requer ciclo de vida, correlação, leitores serializados e manejo de comandos assíncronos. |
| Isolamento operacional | Decoder dentro do runtime Electron/Chromium. | Processo separado facilita gestão/restart, mas não é sandbox e adiciona dependência operacional. |
| Distribuição | Runtime já incluído; codecs variam conforme build e FFmpeg. | Binário, bibliotecas, atualizações, tamanho, assinatura/packaging e inventário de licenças adicionais. |
| Saída real e plataforma primária | Não testadas em Windows nem com monitor/áudio real. | Não testadas em Windows nem com monitor/áudio real. |

## 8. Distribuição e licenças — análise documental histórica (Phase 1, anterior ao ensaio Windows)

**Documentado por fontes upstream, não validado em build distribuível:** documentação do mpv descreve compilação Windows via MinGW/Windows SDK e opções de builds portáveis estáticas ou libmpv. Dependências, recursos e obrigações de licença variam pelo artefato e precisam ser inventariados para o binário exato a distribuir.

- mpv é GPLv2+ por padrão. Builds LGPL podem ser possíveis sob condições específicas; definir `-Dgpl=false` isoladamente não constitui conclusão de licença.
- O FFmpeg usado aqui incluía GPL/libx264 e foi apenas uma ferramenta temporária de teste. Não é recomendação de build distributiva.
- FFmpeg publica informação sobre licenças; codec e patentes podem ter obrigações próprias por jurisdição. Requer revisão de compliance/jurídica; este documento não oferece interpretação legal.
- Chromium documenta limitações de codecs e indica H.264/AAC como restritos ao Google Chrome; Electron pode variar conforme build. electron-builder oferece alternate FFmpeg sem esses codecs.
- Atualização de binários e DLLs, tamanho, assinatura, segurança e compatibilidade do instalador Windows não foram avaliados neste spike.

Referências: [manual mpv](https://mpv.io/manual/stable/), [mpv Windows build v0.41](https://github.com/mpv-player/mpv/blob/v0.41.0/DOCS/compile-windows.md), [mpv Copyright v0.41](https://github.com/mpv-player/mpv/blob/v0.41.0/Copyright), [mpv release v0.41](https://github.com/mpv-player/mpv/releases/tag/v0.41.0), [FFmpeg legal](https://ffmpeg.org/legal.html), [Chromium Audio/Video](https://www.chromium.org/audio-video/), [electron-builder alternate FFmpeg](https://www.electron.build/docs/api/app-builder-lib.interface.commonconfiguration/).

## 9. Integração potencial e segurança — análise histórica Linux (Phase 1)

Manter uma interface `PlaybackEngine` e `PlayerService`; o Controller não deve se acoplar a propriedades/eventos proprietários do mpv. Um processo mpv gerenciado pelo Main do Player é uma possibilidade experimental, não uma implementação escolhida. Comunicação do processo deve permanecer local por socket Unix ou named pipe com permissões/ACL restritas. O harness Linux da Phase 1 usou `--no-config`, mas não testou a desativação de scripts. Separadamente, o harness Windows da Phase 5B usou `--load-scripts=no`; portanto, esse comportamento foi exercitado apenas nesse harness. Em produção, desabilitar configuração e scripts externos explicitamente. JSON IPC não tem autenticação/criptografia e pode expor comandos amplos; nunca expor o socket como TCP, relay genérico ou passagem direta de JSON remoto.

O modo `0600` observado limita o acesso de outros usuários do sistema, mas não isola processos maliciosos executados sob o mesmo UID. A integração deve criar o socket em diretório privado controlado e gerenciar seu ciclo de vida/limpeza. Em Windows, a implementação deve validar explicitamente a DACL aplicada ao named pipe.

O futuro supervisor deve iniciar executável absoluto em caminho protegido com `shell: false`, argumentos fixos e sem herdar opções de engine do Controller. Desligar config/scripts externos e carregar apenas caminhos canônicos dentro das raízes autorizadas pelo Player. Validar e correlacionar todos os eventos; nunca confiar só em `playlist_entry_id` sem o contexto do playback. Crash resulta em estado incerto. Essas medidas reduzem risco de controle local/remoto indevido, mas mpv sidecar não isola vulnerabilidades do decoder.

O spike Linux da Phase 1 não avaliou fullscreen multi-monitor, escolha do monitor de destino, janela/GUI Player integrada, consumo sustentado, aceleração por hardware, instalador, assinatura ou atualizações. Esses testes de janela e monitor precisam ocorrer antes da seleção final do engine. Não houve download/bundle de dependência de produção.

## 10. Conclusão histórica Linux (Phase 1)

**Veredicto histórico da Phase 1: mpv é viável com limitações importantes.** O teste demonstrou funcionamento de comandos, IPC, estados e EOF em Linux com mpv 0.37.0 em sinks nulos, e decode headless das amostras nos builds Linux exatos de Chrome/Electron. Os dados não provam playback A/V audível/visual sincronizado, suporte Windows, formatos além do MP4 H.264/AAC amostrado, nem conformidade do binário a distribuir. A avaliação Windows posterior e o veredicto atual estão na seção 11.

O parágrafo de licença nesta seção é contexto histórico da análise da Phase 1; não valida a licença do binário Windows avaliado depois.

> **Precedência:** as seções 5–10 preservam resultados históricos da Phase 1 executados em Linux. A seção 11 registra a comparação nativa Windows da Phase 5B e conserva seu veredicto como registro daquele momento. A decisão posterior do responsável e os testes complementares da Phase 5B.1 estão na seção 12 e têm precedência para o engine do produto.

## 11. Comparação nativa no Windows — Phase 5B

Esta seção registra uma execução posterior em Windows 11. Ela complementa os resultados Linux acima; não os substitui. O experimento foi isolado e não integrou engine, janela ou serviço ao aplicativo de produção.

### 11.1 Ambiente e reprodutibilidade

| Item | Observação |
|---|---|
| Data | 31/10/2026 |
| Sistema nativo | Windows 11, build 26200; uma tela detectada |
| Runtime | Node.js 24.11.0; Electron 45.0.0; Chromium 156.0.8078.48 |
| mpv | `mpv v0.41.0-dev-g9e2ed65eb`, build de 30/10/2026; libplacebo 7.387.0; FFmpeg `git-2026-10-30-a3c5339` |
| Integridade e inventário do mpv | Asset upstream `mpv-v0.41.0-dev-g9e2ed65eb-41103006513-x86_64-w64-mingw32-full.zip`; SHA-256 do ZIP: `24a5ac969219767c617f5d109761d4e24db8ba05dee30db485ea756415dc63b4`; SHA-256 de `mpv.exe`: `f93efa00f908ac36c9d1caa7ad2206f4d38a561fdd4445c12038ff3fe46b79b3`; ZIP: 65.588.591 bytes; continha `LICENSE.GPL`, `mpv.exe` (159.409.152 bytes), `mpv.com`, dois JARs libbluray 1.5.1 e scripts `register`/`unregister`. Extração temporária, sem instalação ou distribuição. |
| Amostras | 21 MP4 detectados; os códigos 01001 e 01002 foram usados nos testes interativos |
| Integridade das amostras | SHA-256 dos 21 originais e das 21 cópias Windows comparados com o manifesto e iguais. O harness também conferiu hash, tamanho e timestamp antes/depois dos dois arquivos interativos; não houve alteração. |
| Checkout e snapshot | Runner oficial, checkout NTFS isolado, branch `feature/remote-player-lan-integration`, HEAD `b7516bdaf092a03d841ea8efe3b41785eccdfeb1`, fingerprint final `9aaef3ef2a7d911c26994aee139de6e654bf6b8a5704dcd32b87eaf868017368`; build e testes nativos reportaram PASS |

O harness [scripts/playback-engine-evaluation.cjs](../scripts/playback-engine-evaluation.cjs) usa Electron/Playwright do projeto, cria janelas técnicas temporárias, perfil isolado e arquivos inválidos temporários. Não acessa userData ou SQLite de produção. O mpv é iniciado diretamente, sem shell, com argumentos fixos e pipe nomeado local; não é aberto listener TCP. A captura de tela é feita por janela e compara hashes de múltiplos frames. O loopback de áudio usa captura WASAPI do sistema. O código do harness e seus testes estão em [scripts/playback-engine-evaluation.test.cjs](../scripts/playback-engine-evaluation.test.cjs).

Com os caminhos locais substituídos por diretórios de teste, a execução foi feita pelo runner oficial a partir do WSL2:

```bash
WSLENV="${WSLENV:+${WSLENV}:}KARAOKE_QUEUE_WIN_CHECKOUT/w:KQ_P5B_MEDIA_DIR/w:KQ_P5B_MPV_EXE/w" \\
KARAOKE_QUEUE_WIN_CHECKOUT='<checkout NTFS autorizado>' \\
KQ_P5B_MEDIA_DIR='<diretório local temporário das amostras>' \\
KQ_P5B_MPV_EXE='<mpv.exe temporário revisado>' \\
npm run test:e2e:multi-instance:windows -- --approve-untracked --playback-evaluation
```

O runner verificou o branch, HEAD, fingerprint, conteúdo sincronizado e alterações da origem antes do build e dos testes. O run final terminou com código 0, `WINDOWS REPORT PASS`; o relatório do harness foi `COMPLETED_WITH_UNVERIFIED_MEASUREMENTS`, pois áudio atribuível a cada engine e sincronização A/V não foram comprovados. O perfil/janelas temporários foram removidos e o runner confirmou ausência de processos Electron/mpv residuais. `npm ci` emitiu 15 advisories moderados; nenhuma correção de dependências foi aplicada nesta fase.

### 11.2 Resultados observados

| Critério | Chromium/Electron | mpv | Classificação e limite |
|---|---|---|---|
| Evidência por amostra: primeiro frame / parâmetros de stream | Callback de primeiro frame observado em 21/21; metadados de vídeo 1024×768 | 21/21 carregaram e expuseram parâmetros de vídeo 1024×768 e áudio float, estéreo, 48 kHz; o nome do codec não foi exposto. Parâmetros não comprovam decodificação visual completa por amostra. | **PASS** para os callbacks/parâmetros observados; não comprova reprodução integral de 21 faixas nem decodificação visual completa pelo mpv |
| Vídeo visível em janela | Em reprodução: 431 frames observados, 125 hashes distintos em 4,503 s; fullscreen: 236 frames, 123 hashes distintos | Em reprodução: 452 frames, 131 hashes distintos em 4,51 s; fullscreen: 235 frames, 132 hashes distintos | **PASS** para vídeo visível e variando no primeiro arquivo interativo, incluindo fullscreen |
| Play, pause, resume, restart | Eventos e estado do elemento de mídia confirmados | Comandos IPC e propriedades/eventos confirmados | **PASS** |
| Substituição manual | O item anterior não emitiu `ended` ao ser substituído | O item anterior terminou com `end-file reason=stop`; a nova entrada recebeu identidade diferente | **PASS** para distinguir a substituição no contexto do comando |
| Stop | Source removida e evento de encerramento sem `ended` | `end-file reason=stop` | **PASS** para o ensaio. `stop` isolado do mpv não revela a intenção; a intenção do comando e a entrada ativa são necessárias |
| Fim natural | `ended` observado a playbackRate 16, após progresso e confirmação da taxa | `end-file reason=eof`, correlacionado por `playlist_entry_id` | **PASS** para sinal de fim; somente candidato de conclusão, sem prova de integridade da faixa inteira |
| Mídia inválida | `HTMLMediaElement.error.code = 4` | `end-file reason=error` | **PASS** |
| Crash/interrupção | Renderer crash observado (`reason=crashed`, `exitCode=2`), sem `ended` posterior; encerramento forçado do processo Electron host não foi executado | Processo mpv terminado durante playback com `SIGTERM`, sem evento terminal EOF; cleanup confirmou processo encerrado | **PASS** para os cenários executados; host Electron force-kill: **NOT RUN** |
| Fullscreen e continuidade visual | Entrar/sair confirmados e captura variável | Propriedades fullscreen e janela visível confirmadas; captura variável | **PASS**; teste com mais de um monitor: **NOT RUN** (um monitor disponível) |
| Loopback de áudio | Sinal não nulo capturado pelo WASAPI | Sinal não nulo capturado pelo WASAPI | **NOT VERIFIED** quanto a saída física audível e atribuição exclusiva ao engine |
| Sincronização A/V | Sem fixture com marcadores sincronizados | Sem fixture com marcadores sincronizados | **NOT VERIFIED** |
| Inicialização medida | 116 ms em uma execução | 895 ms em uma execução | Observação única, sem repetição/intervalo estatístico; comparação de performance: **NOT VERIFIED** |
| Memória, CPU e aceleração por hardware | `getAppMetrics` (working set por processo, kB): amostra 1 `[101604, 99276, 52780, 88644, 82036, 82808]`, soma 507.148 kB; amostra 2 `[139972, 155712, 52896, 107692, 477632, 84400]`, soma 1.018.304 kB. Inclui player, janela auxiliar de captura, GPU e utilitários; a janela de captura pode crescer durante o ensaio. CPU é percentagem por processo no intervalo desde a chamada anterior. | Working set: 173.993.984 → 176.680.960 bytes; private bytes: 197.963.776 → 199.987.200 bytes; CPU acumulada: 0,734375 → 1,796875 s nos pontos amostrados. | Amostras ilustrativas, não benchmark comparável: escopos e intervalos são diferentes, e o total Chromium inclui a janela auxiliar de captura. Consumo sustentado e hardware decoding comparável: **NOT VERIFIED** |
| Outros contêineres/codecs | Sem teste | Sem teste | **NOT RUN** |
| Empacotamento de produção | Nenhuma alteração no runtime Electron; artefato de release não foi testado | Nenhum bundle; revisão da build exata e obrigações de redistribuição incompleta | Chromium dependências de runtime de release: **NOT VERIFIED**; distribuição mpv: **NOT VERIFIED** |

O experimento priorizou os MP4/H.264 Main/AAC-LC do catálogo. A captura de janela com frames variáveis foi feita no primeiro arquivo interativo para cada engine; não se deve inferir captura visual dos outros códigos a partir dos resultados de parâmetros/callbacks. Chromium observou callback de primeiro frame para 21/21 amostras. mpv obteve parâmetros de stream para 21/21, mas isso não equivale à captura visual ou à reprodução integral de todas elas. Nenhuma dessas observações demonstra suporte a MKV, AVI, MOV, WMV, WebM ou MPEG/MPG.

O valor de áudio observado é apenas atividade no dispositivo de loopback do sistema. O harness usou a captura de áudio loopback disponibilizada pelo Electron `desktopCapturer`; o sinal pode incluir outra fonte e não demonstra saída em alto-falantes, audibilidade ou atribuição ao engine em avaliação ([documentação Electron `desktopCapturer`](https://www.electronjs.org/docs/latest/api/desktop-capturer)). `ffmpeg` e `ffprobe` não estavam disponíveis no `PATH` do host, portanto não foi criada uma fixture com marcadores de áudio/vídeo sincronizados. A sincronização A/V permanece **NOT VERIFIED**; nenhum limiar ou medida foi inventado.

### 11.3 Eventos, correlação e recuperação

- **Chromium:** a sequência observada incluiu `loadedmetadata` → `playing`; pausa/retomada emitiu `pause`/`playing`; restart produziu `seeked` para zero na mesma seleção. Uma substituição manual criou nova tentativa sem `ended` para a tentativa substituída. `ended` ocorreu no teste acelerado; erro de mídia inválida produziu código 4.
- **mpv:** o ACK de comando não foi usado como prova de carga. `start-file` forneceu `playlist_entry_id`; `file-loaded` e `playback-restart` indicaram progresso de carga/início. Substituição e Stop emitiram `end-file reason=stop`; fim natural emitiu `reason=eof`; arquivo inválido emitiu `reason=error`. A terminação forçada observada encerrou o processo sem `end-file` EOF.
- Em ambas as opções, os eventos devem ser correlacionados à tentativa ativa e à intenção do comando. Um EOF correlacionado é somente candidato: não prova que o arquivo continha uma faixa completa nem que todo o trecho foi reproduzido. Nenhum evento desta avaliação atualiza apresentação ou histórico.
- O harness confirmou encerramento controlado e cleanup, mas não simulou perda de energia. O Chromium host não foi morto à força por não haver garantia segura de limpeza da árvore de processos neste runner. Reinício real do sistema e recuperação de produção permanecem **NOT RUN**.

### 11.4 Segurança e distribuição

**Observado no harness Windows da Phase 5B:** Chromium usou `contextIsolation`, `nodeIntegration: false` e sandbox do Renderer; as páginas carregaram arquivos locais selecionados por um mapa restrito do harness. Isso não autoriza expor caminhos arbitrários por IPC em produção. mpv foi iniciado com executável explícito, `shell: false`, `--no-config`, `--load-scripts=no` e pipe nomeado local, sem TCP. A comunicação JSON IPC não tem autenticação de aplicação; a avaliação não verificou a ACL/DACL efetiva do named pipe em execução, nem testou acesso por outro usuário/processo.

Os dois engines processam arquivos locais potencialmente não confiáveis. Chromium mantém os controles de sandbox do Electron no ensaio; mpv roda como processo separado, o que oferece uma fronteira de processo, mas não constitui por si só sandbox. Em uma integração, o Player deve resolver código pelo índice validado e manter caminhos na fronteira privilegiada; não encaminhar caminhos arbitrários do Renderer ou rede. Também permanecem riscos TOCTOU se outro processo local substituir o arquivo entre validação e abertura.

O binário mpv foi obtido do asset Windows de desenvolvimento do projeto upstream `mpv` (`git-release`), extraído para uso temporário e não instalado nem distribuído. O ZIP continha `LICENSE.GPL`, cujo texto indica GPL versão 2; isso não constitui inventário das licenças de todos os componentes vinculados. O upstream descreve esses builds automáticos como não testados e separa variantes Windows; portanto a versão testada não é uma candidata de distribuição estável. O projeto mpv informa GPLv2+ por padrão e permite build LGPL apenas sob condições específicas, sem que `-Dgpl=false` por si só determine a licença do resultado. A licença dos componentes vinculados depende da configuração/build do FFmpeg e das demais dependências. O binário avaliado não veio acompanhado de inventário completo de dependências, fontes correspondentes e avisos suficiente para aprovar redistribuição. Esta é uma avaliação técnica, não parecer jurídico: antes de bundling, revisar exatamente o artefato, fontes/avisos, configuração das dependências, atualizações e obrigações aplicáveis com responsáveis de compliance/jurídico. [mpv releases e aviso de builds dev](https://github.com/mpv-player/mpv/releases/tag/git-release), [Copyright do mpv no commit testado](https://github.com/mpv-player/mpv/blob/9e2ed65eb0c02f99a352dfa1ad3c85ecceefe005/Copyright), [IPC do mpv no commit testado](https://github.com/mpv-player/mpv/blob/9e2ed65eb0c02f99a352dfa1ad3c85ecceefe005/DOCS/man/ipc.rst), [considerações legais do FFmpeg](https://ffmpeg.org/legal.html).

O Electron já é dependência de execução do app, então Chromium não adiciona um executável de player separado. Isso reduz uma etapa de distribuição, mas não comprova codec disponível em cada build/licença de codecs nem remove a necessidade de validar o artefato final. **Inferência de arquitetura:** para somente o MP4/H.264/AAC atualmente observado, Chromium parece exigir menos supervisão/processos e empacotamento do que um mpv sidecar; ainda faltam testes de áudio atribuível, sincronização e do instalador para validar essa preferência.

### 11.5 Matriz resumida e decisão

| Requisito | Chromium/Electron | mpv |
|---|---|---|
| Execução nativa Windows e renderização dos arquivos interativos | **PASS** | **PASS** |
| MP4/H.264/AAC: carregamento das 21 amostras | **PASS** (primeiro frame) | **PASS** (parâmetros de vídeo/áudio) |
| Áudio audível e sincronização A/V | **NOT VERIFIED** | **NOT VERIFIED** |
| Controles e sinais EOF/stop/erro nos cenários executados | **PASS** | **PASS** |
| Crash do Renderer / processo engine | Renderer: **PASS**; host Electron: **NOT RUN** | Processo mpv: **PASS** para ausência de EOF no término testado |
| Fullscreen e vídeo contínuo | **PASS** | **PASS** |
| Multi-monitor | **NOT RUN** | **NOT RUN** |
| Outros formatos/codecs, performance sustentada e hardware decode comparável | **NOT RUN / NOT VERIFIED** | **NOT RUN / NOT VERIFIED** |
| Distribuição/licença do artefato final | **NOT VERIFIED** | **NOT VERIFIED**; build específica não aprovada para bundling |

**Decisão registrada na Phase 5B, antes da seleção do responsável: `DECISION BLOCKED`.** Naquele ponto, Chromium era candidato provisório, pois áudio e sincronização não estavam comprovados. Essa decisão histórica foi supersedida pela escolha explícita do responsável registrada na seção 12; a pendência de observação humana continua separada da escolha técnica.

## 12. Validação final Chromium — Phase 5B.1

### 12.1 Decisão do produto e limites

O responsável selecionou **Chromium/Electron** como engine de playback inicial, sujeito apenas à descoberta de incompatibilidade crítica. A seleção é uma decisão aprovada do produto e não uma conclusão de que todos os codecs, artefatos de distribuição ou cenários de saída A/V foram verificados.

Esta etapa reutiliza o harness isolado da seção 11. Ela não integra serviço ou tela de produção, não inicia mpv e não altera fila ou histórico. O harness interativo temporário oferece seleção de amostra pelo código, Play selected, Pause, Resume, Restart, Stop e Fullscreen. A saída normal do elemento de mídia usa volume do próprio elemento; configurações globais de áudio do Windows não são alteradas.

### 12.2 Evidência automatizada no Windows

| Item | Resultado |
|---|---|
| Checkout, HEAD e fingerprint | **PASS**; runner oficial, branch `feature/remote-player-lan-integration`, HEAD `b7516bdaf092a03d841ea8efe3b41785eccdfeb1`, fingerprint `626ed739e4ae1f91cf985ba0545d3fe40e178c1799a8e9d7b53304c66b19a129` antes do build/teste e revalidado ao final |
| Ambiente nativo | **PASS**; Windows 11 build 26200, Node.js 24.11.0, Electron 45.0.0 / Chromium 156.0.8078.48; uma tela detectada |
| Reprodução automatizada a 1× até `ended` | **PASS**; código 01001, duração 198,767 s, progresso observado, `playbackRate=1` e evento `ended` em `currentTime=198,767` |
| Metadados e frames | **PASS** para os dois códigos interativos: `loadedmetadata` e callback de primeiro frame; `01001` reportou 1024×768. Captura visível em avanço: 433 frames / 121 hashes distintos em 4,508 s; fullscreen: 240 frames / 123 hashes em 4,513 s |
| Pause/resume/restart/stop/substituição e erro de mídia | **PASS** automatizado via Playwright. Os controles também passaram pela janela interativa temporária: Play selected, Pause, Resume, Restart, Fullscreen enter/exit, substituição 01001→01002 e Stop. STOP observou `emptied` sem `ended`; substituir a tentativa ativa não produziu `ended`; mídia inválida reportou `HTMLMediaElement.error.code=4` |
| Integridade dos vídeos interativos | **PASS** para 01001 e 01002; hashes das cópias Windows coincidiram com os dois originais antes/depois. O harness não rehashou as outras 19 amostras nesta etapa |
| Áudio e sincronização | O operador reportou áudio claramente audível na janela durante a reprodução real: **PASS por observação do operador**. O relatório automatizado deixou sincronização percebida como PENDING naquele momento; a decisão aprovada antes da Phase 5C registra a sincronia como aceitável. Loopback WASAPI capturou sinal do sistema, mas não é usado como prova de audibilidade |
| Limpeza | **PASS**; Electron encerrou controladamente, perfil temporário removido e runner confirmou ausência de processo Electron residual associado ao perfil |
| Cobertura multi-monitor | **NOT RUN**; somente uma tela detectada |

O runner terminou com código 0 e `WINDOWS REPORT PASS`; executou os 17 testes do harness e a validação focada Chromium, sem rodar regressões alheias a playback. Além da automação por API do harness, a janela temporária interativa foi operada pelo Playwright para validar os próprios botões e a seleção de amostra. O relatório automático ficou `COMPLETED_WITH_UNVERIFIED_MEASUREMENTS`: provou evento de mídia e atividade de loopback, não sincronização percebida. O operador confirmou audibilidade; a sincronia percebida, pendente no relatório técnico naquele momento, foi posteriormente aceita pelo responsável na decisão da Phase 5C. O mpv não foi executado nesta etapa. Uma primeira repetição anterior executou a faixa, mas falhou ao serializar o bloco de amostras de mpv intencionalmente ausente no modo Chromium-only; a serialização foi corrigida, coberta por teste unitário e o ensaio completo foi repetido com sucesso no fingerprint acima.

O ensaio de reprodução completa usa uma faixa amostrada e espera o evento real `HTMLMediaElement.ended` com playbackRate 1. Um timeout, `pause`, `emptied` ou ausência de progresso não é aceito como EOF. O evento continua sendo evidência de playback, não uma decisão de apresentação concluída.

### 12.3 Verificação humana de áudio e sincronização

**Áudio audível: PASS por relato do operador. Sincronização A/V percebida: aceita pelo responsável antes da Phase 5C.** O relatório de medição Phase 5B.1 não observou nem mediu a percepção humana de sincronia; ela foi registrada como decisão do produto. As métricas de loopback do Windows indicam apenas atividade capturada do sistema e não são a base da confirmação de áudio.

O procedimento final usa a opção `--playback-chromium-interactive` do runner Windows oficial. O operador seleciona primeiro a amostra principal, confirma áudio/vídeo, experimenta Pause/Resume/Restart/Stop/Fullscreen, e deixa uma reprodução inteira atingir EOF; a segunda amostra serve para verificar substituição manual. O resumo do harness é emitido ao fechar a janela e não declara audibilidade ou sincronização humana.

### 12.4 Manutenção da compatibilidade

Na atualização do Electron/Chromium, repetir a validação automatizada focada com a versão candidata do runtime e a amostra H.264/AAC de referência, além de verificar o artefato Windows de release quando suas dependências/runtime mudarem. Repetir a observação humana após mudanças de runtime, codecs, saída de áudio, configuração de janela ou caminho de renderização. Nenhuma matriz além dos MP4/H.264 Main/AAC-LC amostrados é aprovada por estes testes.

## 13. Estado após as avaliações Phase 5B e 5B.1

- **Implementado somente para avaliação:** harnesses temporários Chromium/mpv, coleta de eventos/métricas, reprodução normal até EOF, modo interativo temporário Chromium-only e testes do próprio harness. O runner verificado aceita `--playback-chromium-final` e `--playback-chromium-interactive` sem remover as barreiras de branch, snapshot, fingerprint ou cleanup.
- **Não implementado:** serviço de playback de produção, integração permanente de engine, recuperação persistida, controles/telas do Player, janela de produção, queue/history, HTTP/WebSocket e empacotamento mpv.
- **Validação da Phase 5B.1:** `node scripts/playback-engine-evaluation.test.cjs` passou com 17/17 testes; `node scripts/windows-native-runner.test.cjs` passou com 18/18; `npm run compile` e `npm run test:unit` passaram. O runner Windows oficial terminou com código 0 no fingerprint desta seção; executou os 17 testes do harness e a avaliação Chromium focada, não as regressões não relacionadas. A avaliação confirmou EOF a 1× e os controles pela API e pela janela interativa. Os hashes dos dois arquivos interativos permaneceram iguais aos originais.
- **Seleção do produto:** Chromium/Electron foi aprovado pelo responsável como engine inicial. Isso não transforma o resultado de loopback ou a captura de frames em aprovação humana de áudio/sincronia.
- **Estado registrado ao finalizar originalmente a Phase 5B.1:** áudio audível havia sido confirmado e sincronização ainda aparecia como pendente naquele relatório. Essa pendência foi superada pela confirmação do responsável refletida na decisão aprovada da Phase 5C: a sincronização percebida foi considerada aceitável.
- **Outras limitações:** multi-monitor **NOT RUN**; encerramento forçado do host Electron e recuperação após reboot **NOT RUN**; formatos fora de MP4/H.264/AAC **NOT RUN**; compatibilidade do instalador final **NOT VERIFIED**. Nenhuma alteração foi feita em `docs/licensing.md`.

O relatório descreve apenas testes técnicos. Nenhuma modificação foi feita em `docs/licensing.md`, no banco operacional ou nas telas de produção.

## 14. Engine de produção — Phase 5C

### Decisão e escopo implementado

Chromium/Electron permanece a engine aprovada. A Phase 5C adicionou o serviço de playback Main-owned, host Chromium ligado por IPC restrito, Renderer técnico com `HTMLVideoElement`, Preload dedicado e scheme local `kq-media`. A janela usada pelos testes é isolada; o startup normal ainda não cria nem anexa uma janela Player de produção, e nenhum layout/controle operator-facing foi implementado.

O serviço carrega códigos canônicos de cinco dígitos pela biblioteca existente, não inicia até `play()` explícito, e implementa Pause/Resume, Restart e Stop. Não implementa entrada numérica, sequência Next/Previous, Controller queue/history, LAN, avanço automático ou recuperação persistida. Restart e substituição criam nova identidade de tentativa; stop, crash e timeout não geram conclusão natural.

### Estado, segurança e semântica de fim

Main serializa transições curtas e correlaciona observações por `hostEpoch`, `attemptId` e `sequenceNumber`. ACK significa que o Renderer aceitou o comando, não que a mídia carregou ou iniciou. `loadedmetadata`, `playing`, pausa e `ended` são observações separadas. Um EOF só produz `natural-end-candidate` se a tentativa ainda for atual, `playing` já foi observado e duração/posição forem finitas e coerentes. Esse evento é um candidato técnico, não prova independente de que o vídeo completo foi cantado nem uma conclusão de apresentação; Controller deverá decidir sua aceitação na Phase 7.

O Main emite URL com token aleatório opaco vinculado ao código/revisão do índice. O protocolo permite GET/HEAD e Range, revalida a mídia e serve por handle sem revelar path ao Renderer. Main verifica o WebContents e frame principal; Preload não expõe filesystem ou SQLite. A CSP do host restringe scripts, origem de mídia e conexões. A futura BrowserWindow de produção ainda precisa preservar o modelo seguro de Electron.

Riscos residuais: observações e ended são produzidos pelo Renderer e não resistiriam a um Renderer comprometido; alterações locais concorrentes do arquivo mantêm um limite TOCTOU; após timeout, Stop é best-effort e, se não chegar, o host futuro precisará ser encerrado para impedir mídia tocando sem estado confiável no Main. Nenhum desses eventos modifica fila ou histórico na Phase 5C.

### Validação técnica

`npm run compile`, `npm run test:unit` e `git diff --check` passaram. `tests/player-playback.test.ts` passou 13/13. `npm run test:e2e:player-playback:headless` passou em Linux, incluindo reprodução de 01001 até EOF em 199 s e crash do Renderer classificado como incerto.

O runner oficial Windows `npm run test:e2e:multi-instance:windows -- --approve-untracked --player-playback` passou em clone NTFS isolado. Fingerprint: `9a8a3c2be3e9607186e4a6ebca8bca33cface494b65170ff1502fb4e693fb874`; branch `feature/remote-player-lan-integration`, HEAD `b7516bdaf092a03d841ea8efe3b41785eccdfeb1`. O Electron Windows real chegou ao EOF para 01001 em 199 s, classificou o crash do Renderer como incerto e confirmou perfil limpo e ausência de processos residuais. Este foi um modo focado e não executou o conjunto padrão de regressões Windows.

Formatos além dos MP4 H.264/AAC amostrados, janela de produção, múltiplos monitores, política de gesto da futura UI e instalação final permanecem não verificados. A atualização de Electron/Chromium deve repetir as regressões de playback; não há aprovação de codec universal.
