# F0 — Relatório da auditoria documental

> **Encerramento vigente — 2026-11-11:** Fase F, incluindo F0 e suas subdivisões, concluída e validada pelo proprietário. [Registro consolidado](fase-f-encerramento.md). Este documento preserva contratos, planejamento e evidências históricas; menções a homologação pendente ou F1–F4 não iniciadas estão superadas pelo aceite. Classificações técnicas e lacunas de evidência permanecem inalteradas. Prompts e gates históricos não autorizam novas execuções.

> **Correção estrutural vigente:** gate T2, revogação do protocolo e duas corridas de scan corrigidos e validados em fixtures Linux/Windows. Acervo real não acessado nesta correção; sua campanha anterior permanece histórica. F0 não homologada. Ver adendo final e evidências estruturais.

> **Registro histórico (2026-11-10; sucedido pelos adendos abaixo):** T2 reutilizou o índice real e tornou a UI utilizável antes do fim da reconciliação, mas é **PARTIAL** porque `readdir` já havia retornado 9.311 nomes antes da UI. As assertions de playback T4 passaram com um MP4 real; a classificação geral T4 é **PARTIAL** porque a política Windows permite atualização automática de LastAccessTime e não houve baseline por arquivo. T3 físico, A/V humano e pacote instalado permanecem pendentes; F0 não está homologada. Consulte o adendo final “Campanha Windows real — T2 e T4”.

2026-11-10. Investigação e planejamento concluídos; F0 planejada, não implementada. HEAD bc3d37de09462485caa9ff027341eeabdd4b88cb, branch feature/remote-player-lan-integration-2, árvore inicialmente limpa.

Achados: startup aguarda scan completo com enumeração e abertura de candidatos; índice só em memória; recovery paused antigo bloqueia comandos por contrato; Sequence pode mostrar último idle enquanto bloqueada; disponibilidade depende de snapshots de scan; protocolo já suporta ranges e preload auto. Essas condições são comprovadas no código. A causalidade específica dos minutos após reconexão, o vínculo do JSON preservado ao incidente e a origem de possíveis engasgos continuam sem medição física.

Recomendações: índice Main-only JSON atômico descartável, UI antes da reconciliação, scan incremental com validação seletiva e épocas; startup idle seguro preservando evidências; resolução runtime com contenção confirmada; sonda leve de disponibilidade e atualização por revisão; buffering nativo primeiro. SQLite/Gestão e dados originais preservados.

Documentos: fase-f0-diagnostico-arquitetura.md, fase-f0-lotes.md, fase-f0-testes.md, fase-f0-execucao.md; ticket 0006/0000; roadmap e índice backlog atualizados; dependências F1–F4 adicionadas sem renumeração. Prompts em fase-f0-execucao.md. Lotes: 01 baseline; 02 recovery; 03 convergência; 04 store; 05 bootstrap/incremental; 06 disponibilidade; 07 buffering/regressões. Complexidade média/alta nos serviços compartilhados e corridas; baixo risco imediato porque esta entrega só altera documentos.

Histórico da auditoria inicial: naquele momento P1/P2/P3 eram recomendações. Na consolidação posterior, o proprietário aprovou explicitamente as três políticas (registro vigente abaixo). Continua pendente autorizar primeiro F0-01. F0 exige validação Windows/pacote/HD e aprovação antes de F1. F permanece aberta.

Verificações: links locais dos novos documentos PASS; git diff --check PASS; escopo do diff somente docs, incluindo arquivos novos ainda untracked. Testes de aplicação/compile/Electron/Windows/Doop NOT RUN: entrega documental sem alteração funcional. Não executada campanha E nem teste destrutivo. Nenhum código de produção, SQLite, AppData ou recovery original alterado; sem commit/push/PR/release.

Suspensão: powershell.exe localizado, mas sondagem não destrutiva de versão falhou com WSL UtilBindVsockAnyPort: socket failed 1. Será tentado o comando explicitamente autorizado de SetSuspendState como última ação operacional após apresentação do relatório. Este documento não presume sucesso dessa tentativa.

## Consolidação posterior à revisão do proprietário

P1 (idle seguro no restart), P2 (recuperação runtime com contenção confirmada) e P3 (JSON Main-only e consistência eventual com revalidação seletiva) foram aprovadas pelo proprietário. Em 2026-11-10, o proprietário autorizou execução autônoma sequencial de F0-01–07 e avanço automático pelos gates; aprovação final F0 permanece reservada ao proprietário. P2 não aprova novos elementos visuais; somente o elemento necessário depende de Doop.

31 grupos originais reclassificados com responsabilidade/primeiro PASS/regressões, sem remover cobertura; três grupos INS novos planejados. F0-01 mede e caracteriza bugs, sem exigir correções. F0-04 valida store isolado e não depende de 02/03. 05 integra cache/startup, 06 integra disponibilidade, 07 completa buffering nativo/dados/pacote e repete matriz. Ordem executiva serial 01→02→03→04→05→06→07; dependências reais no handoff.

Variantes físicas USB/áudio/permissões de volume, Windows nativo, pacote e NSIS são distintas; variantes externas ausentes podem aguardar 07 com ledger, sem PASS indevido. Automação local obrigatória ausente impede aceite técnico. Não foram executados compile/testes funcionais nesta consolidação documental. Histórico anterior de suspensão pertence exclusivamente à auditoria anterior; nesta execução não suspender o computador.

Arquivos desta consolidação: diagnóstico, lotes, testes, execução, relatório, roadmap, índice backlog e ticket 0006/0000. Dependências F1–F4 lidas e preservadas. Working tree já continha os documentos/modificações da auditoria anterior; foram preservados. Nenhum código/teste funcional, dado SQLite/AppData, V1 ou Doop alterado; sem commit/push.

Verificação da consolidação: 31 IDs originais únicos/completos, três INS novos planejados, comandos npm conferidos com package.json e dependências sem ciclos: PASS. Links locais atuais do handoff/backlog: PASS. A checagem ampla identificou 12 links históricos do roadmap para capturas temporárias /tmp ausentes; preservados como evidência histórica, sem alegar disponibilidade dessas imagens. Whitespace dos documentos novos e git diff --check: PASS. Testes funcionais/compile/Windows: NOT RUN por escopo documental. Distribuição do primeiro PASS completo dos grupos originais: 02=5, 03=8, 04=1, 05=6, 06=7, 07=4; 01 exige somente INS-01–03, A aplicável e C caracterização.

Fontes executivas vigentes: [matriz canônica](fase-f0-testes.md), [lotes](fase-f0-lotes.md), [prompts](fase-f0-execucao.md), [decisões](fase-f0-diagnostico-arquitetura.md), [ticket](backlog/0006-fase-f-regressao-estabilizacao-pos-instalacao/0000-f0-estabilizacao-critica-standalone.md).

## Execução autorizada da F0 — atualização final de 2026-11-10

Esta seção atualiza o status da auditoria e da consolidação documentadas acima. O proprietário autorizou F0-01–07 em sequência, sem aprovação entre lotes. A execução foi concluída tecnicamente nos trechos possíveis; nenhuma implementação de F1–F4/G/H foi iniciada. A homologação da F0 continua reservada ao proprietário. Não foi tentada suspensão do computador nesta execução, conforme a instrução vigente.

### Resultado por lote

| Lote | Status | Evidência principal | Pendência externa |
|---|---|---|---|
| F0-01 | PARTIAL | Instrumentação opt-in e baselines sintéticos 1k/5k/9k registrados; medições sem caminhos pessoais | A unidade D: não estava montada em `/mnt/d`; acervo real e inicialização nativa Windows não medidos |
| F0-02 | PASS | Recovery/startup unitários, falhas isoladas e produção Electron; P1 sem autoplay e com confirmação antes de liberar comandos | Nenhuma pendência funcional automatizada identificada |
| F0-03 | PASS | Playback/sequence/host/IPC e produção Electron; falhas conhecidas convergem somente após contenção confirmada | Elemento visual novo não foi necessário; Doop não alterado |
| F0-04 | PASS | 9 testes do store e 23 da biblioteca no Linux e no runner Windows; erro inicial de precisão NTFS foi corrigido | Nenhuma pendência funcional automatizada identificada |
| F0-05 | PASS | Cache/restauração, reconciliação fora do caminho crítico, validação seletiva e produção Electron | Tempo real de janela no acervo USB segue NOT RUN |
| F0-06 | PARTIAL | Remoção/reconexão, epochs, estados e publicação validados em filesystem temporário e Electron | USB físico/remoção durante reprodução não executados |
| F0-07 | PARTIAL | 499 testes unitários; E2Es pertinentes; runner Windows completo, produção Electron Windows e build/verificador do pacote candidato | Acervo USB físico, áudio/engasgos no HD, smoke depois de instalar NSIS não executados |

PASS/PARTIAL acima descreve os critérios automatizados e ambientais do ticket; não é homologação do produto pelo proprietário.

### Baseline e comparação de performance

Medições em fixtures sintéticas no WSL2/Linux, Node v24.15, x64, Ryzen 7 4800H, quatro CPUs disponíveis. Arquivos são candidatos MP4 vazios; nenhuma amostra leu conteúdo de vídeo. O ambiente não foi limpo entre execuções, filesystem/I/O físico não foi medido, e estes números não representam o HD externo ou Windows nativo.

| Fixture | Baseline inicial: scan completo, 3 amostras | Implementação final: scan completo, 1 amostra | Reinício com índice final: leitura + reconciliação | Contadores principais na reconciliação final |
|---:|---:|---:|---:|---|
| 1.000 | 0,72–0,73 s | 0,78 s | 13,6 + 176,7 ms | 1.001 entradas; 1.000 cache hits; 0 opens |
| 5.000 | 3,53–3,62 s | 3,64 s | 51,8 + 751,4 ms | 5.005 entradas; 5.000 cache hits; 0 opens |
| 9.000 | 6,28–7,32 s | 6,38 s | 102,6 + 1.377,7 ms | 9.009 entradas; 9.000 cache hits; 0 opens |

No scan completo final de 9.000 candidatos foram enumeradas 9.009 entradas, com 18.009 `lstat`, 9.001 `stat`, 9.010 `realpath`, 9.000 pares open/close e zero bytes de vídeo lidos. Na reconciliação após reinício houve 9.009 `lstat`, um `stat`, 10 `realpath`, zero opens e zero bytes lidos. O índice JSON de 9.000 entradas tinha 1.110.295 bytes; escrita 83,03 ms e leitura/parse 63,91 ms. A geração final de performance teve uma amostra por tamanho; não sustenta percentis nem meta percentual. O scan continua enumerando a árvore inteira para encontrar arquivos novos/removidos/renomeados.

Para a amostra final 9k, o scan completo usou 2.331 ms de CPU user + 3.365 ms system; RSS do processo passou de 145.494.016 para 157.519.872 bytes (delta aproximado 11,5 MiB). No processo de store, a leitura/parse do índice 9k reportou heap delta de 3.299.944 bytes e RSS delta de 10.944.512 bytes; a escrita reportou heap delta de 19.330.744 bytes. As amostras de RSS são antes/depois, não pico isolado, e o processo de reconciliação já continha estado das fixtures anteriores. Não equivalem a memória do Electron em Windows/8 GB.

Os tempos de leitura de índice + reconciliação são do serviço de biblioteca; **não medem** criação da janela, primeira interação, latência do Explorer/Windows, cache frio, I/O físico ou startup do aplicativo instalado. O E2E comprova que a janela pode ser criada antes do scan pesado, mas não houve medição temporal do acervo real. A varredura sintética completa foi da mesma ordem do baseline (sem ganho demonstrado); o benefício mensurado é a reutilização do inventário e eliminação das aberturas de cada MP4 inalterado no caminho de reconciliação.

### Testes, fingerprint e artefatos

- `npm run compile`: PASS.
- `npm run test:unit`: PASS, 499 casos em 43 relatórios, zero falhas; inclui as 32 novas declarações unitárias contadas no diff.
- `npm run test:e2e:video-library:headless`: primeira tentativa no sandbox não iniciou Electron (`Process failed to launch`); repetição autorizada fora do sandbox PASS, quatro cenários. Nenhuma assertion funcional falhou.
- E2Es Standalone de playback, recovery, opções, integração e Main de produção Linux: PASS nas execuções focadas registradas no ticket. O E2E de produção Windows foi repetido no snapshot validado `de3e33242ad4c63feb5fc0b4a574e89c19a43ffbbc50ed3bc5293f4e18b091cd` e passou com Electron real, MP4 de amostra local, IPC e SQLite/perfil temporários. Depois dele, nenhum código/teste mudou; somente estes registros documentais foram acrescentados.
- Runner Windows completo `npm run test:e2e:multi-instance:windows -- --approve-untracked`: PASS; compilação nativa, migrações, modos, biblioteca (23 testes), catálogo, Combined/Management, multi-instância e cleanup, sem processo residual.
- Runner Windows de produção `npm run test:e2e:multi-instance:windows -- --standalone-production --approve-untracked`: PASS; ciclo Main/Preload/IPC, playback, prioridades, fila, pausa, shutdown, recovery/crash, MP4 real de fixture local e auditorias da janela.
- `npm run package:windows:candidate -- --approve-untracked` + `npm run verify:windows-build`: PASS para fingerprint de teste/código `de3e33242ad4c63feb5fc0b4a574e89c19a43ffbbc50ed3bc5293f4e18b091cd`, HEAD `bc3d37de09462485caa9ff027341eeabdd4b88cb`. Fingerprint de entrada selado do pacote `0b97722b919743049cabe4e704c51d53dd1a20a46783e68a7f9ade954f5b5dda`; instalador não assinado, SHA-256 `2355437827c330035a6600cf35e6c4ec92818b13a04241f9ac0636c5b7144426`. Não instalado.

### Limites e aprovação

A unidade D: não estava montada no WSL2 (`/mnt/d` indisponível). A biblioteca real não foi enumerada, aberta, medida ou modificada. Os MP4 usados no E2E estavam em fixture local e não equivalem ao acervo do proprietário. Nenhum AppData real, instalação operacional, settings de Windows, workflow, commit ou push foi tocado. O instalador candidato ficou em checkout NTFS isolado e não foi executado/instalado. `npm ci` nativo reportou seis vulnerabilidades moderadas; dependências não foram atualizadas.

F0-01/06/07 permanecem PARTIAL quanto ao hardware/acervo/instalação indicados na tabela, embora seus trechos automatizados tenham passado. Pendências físicas são NOT RUN, não PASS. O proprietário decide se aceita essas limitações ou executa a validação supervisionada com o HD e o pacote instalado. F1–F4 permanecem não iniciadas. A working tree contém implementação funcional autorizada F0 e documentação; não houve commit/push. Branch `feature/remote-player-lan-integration-2`; HEAD `bc3d37de09462485caa9ff027341eeabdd4b88cb`.

## Validação Windows nativa com HD externo — 2026-11-10

Este adendo é o registro vigente da validação solicitada depois da execução F0. Ele corrige qualquer afirmação anterior de que D: não estava acessível: a unidade foi confirmada no Windows nativo, sem usar `/mnt/d` para medir performance. Os resultados anteriores de fixtures e seus fingerprints continuam históricos e não são substituídos por estes resultados.

### Ambiente e segurança

- Windows 11, build 26200; PowerShell 5.1.26100.9711; Node nativo v24.11.0 x64; Electron 45.0.0.
- Unidade D: identificada como volume NTFS em dispositivo USB 3.0 (modelo informado pelo Windows: Exbom USB 3.0; capacidade 500.107.862.016 bytes). A capacidade do volume não é o tamanho dos arquivos de mídia.
- O proprietário estima cerca de 286 GB e 9.000 MP4. A contagem real exata não foi preservada no resultado da campanha; não a declarar como medida.
- A execução Windows usou checkout NTFS descartável e perfis temporários em C:, com cleanup verificado. Não iniciou nem modificou a instalação operacional ou seu AppData. Nenhum arquivo foi escrito no D:, nenhum arquivo de mídia foi movido/renomeado/apagado, e nenhum hash integral foi calculado.
- D: não foi desconectada. Não houve medição nativa do app instalado, teste físico de reconexão, nem leitura integral dos vídeos.

### Resultados por cenário

| Cenário | Resultado | Evidência e limite |
|---|---|---|
| T1 — primeira indexação real | PARTIAL (assertions funcionais T1 passaram) | Runner Windows nativo iniciou a varredura usando a biblioteca real. As assertions T1 passaram, incluindo UI utilizável antes do fim da reconciliação e índice populado/coerente com o scan. O caso composto falhou depois, antes de exportar/conservar tempos, contagem exata e contadores. Portanto há evidência funcional parcial, sem medição quantitativa/PASS completo. Nenhuma varredura completa adicional foi feita. |
| T2 — segunda abertura sem desconectar | NOT RUN no acervo real | A campanha real não concluiu uma segunda inicialização limpa com o mesmo perfil: o segundo processo observado foi iniciado com recovery `paused`, portanto pertence a T5. Um harness sintético Windows sem recovery passou e restaurou seu índice, mas não prova desempenho/reutilização no D:. |
| T3 — reconexão física | NOT RUN | Não houve intervenção física supervisionada do proprietário. O dispositivo permaneceu conectado. |
| T4 — playback de MP4 real do HD | NOT RUN | O fluxo composto foi interrompido pelo T2 antes de selecionar/reproduzir um arquivo real. Não há evidência de `playing`, buffering, concorrência de scan ou handles para mídia do D:. E2Es anteriores usaram apenas MP4 de fixture local. |
| T5 — recovery `paused`, Enter e refresh | FAIL parcial / demais oráculos NOT RUN | Reproduzido o bloqueio de criação da janela com recovery `paused` em perfil temporário. Enter, refresh em idle e bloqueio durante playback real não puderam ser testados nessa execução porque a janela não abriu. AppData original não foi acessado. |
| T6 — disponibilidade dinâmica | PASS no E2E de fixture; USB físico NOT RUN | No runner Windows oficial, fixture temporária confirmou remoção lógica, snapshot Main degradado, texto existente “Pasta indisponível”, preservação da configuração/índice e retorno a disponível após recriar a raiz. A primeira execução integrada expirou na espera de reconexão; a repetição isolada do mesmo E2E passou. A causa dessa diferença entre execuções não foi determinada, então registrar a primeira falha e tratar a estabilidade como risco residual. Não equivale a remoção USB física. |

O runner de biblioteca focalizado passou no fingerprint `48326107dc9d957148c0cc3b7e9ed71bb80e0ce12855d9a64fe59a58d7619fc8`, incluindo os 23 testes de biblioteca Windows e os quatro cenários E2E de biblioteca. A execução com a falha T2 não produziu um manifesto/fingerprint final verificável antes de abortar; por isso a evidência do defeito é o resultado observado do processo isolado, sem atribuir-lhe o fingerprint do runner posterior. O runner e as suítes não usaram WSL/DrvFs.

### Causa do T2 e alcance

O defeito de startup foi localizado no caminho real: `main-runtime.ts` chama `createStandaloneSequence` antes de `createStandalonePlayerWindow`; `createStandalonePlayerComposition` chama `resolveStandaloneStartup`; o coordenador exige que `clearFreshStartupRecovery` confirme a contenção; `PlayerPlaybackService.clearFreshStartupRecovery` retorna `false` sem `host`; e `PlayerVideoWindow.attachControlWindow` só anexa o host durante a criação da janela, que ocorre depois da sequência. Com recovery antigo, a confirmação não pode acontecer nesta ordem e a janela não é criada. Esta é uma causa comprovada da falha T5 reproduzida. Não prova que foi a causa única do incidente original do proprietário nem reproduz exatamente a UI visualmente ociosa relatada.

Não remover a guarda nem declarar idle para contornar o ciclo. A correção deve tornar disponível uma superfície de mídia nova e confirmável antes da resolução durável do recovery, preservando contenção segura, evidência e isolamento do default compartilhado da Gestão. Nenhuma correção funcional foi feita nesta campanha.

### Performance e comparação

Não há tempos confiáveis de startup, leitura de cache ou reconciliação para a biblioteca real: o harness falhou antes de exportar as métricas de T1/T2. Assim, não há comparação quantitativa válida entre o comportamento anterior e o corrigido no HD. A campanha anterior mediu fixtures vazias no WSL2/Linux: scan completo de 9.000 entradas em 6,38 s e leitura/parse do JSON em cerca de 103 ms, com reconciliação do serviço em cerca de 1,38 s. Esses dados não representam Windows nativo, cache frio, volume USB, criação da janela, o app instalado ou o acervo real; não inferir que o startup de D: melhorou.

O comportamento real de vários minutos após reconexão não foi testado porque a reconexão física não ocorreu. No cenário de recovery sintético, o comportamento foi pior: a segunda inicialização não chegou à janela. T1 chegou ao fim da varredura no fluxo do teste, porém sem evidência quantitativa conservada. Não foi comprovado o volume de bytes lidos nem o comportamento de cache do Windows.

### Estado vigente e próximos passos

F0-02 fica **FAIL na variante Windows/Electron com recovery `paused`**; F0-01 permanece PARTIAL para acervo real; F0-05 não tem medida real de startup e não pode ser considerada validada no HD; F0-06 passou com fixture Windows, mantendo USB físico NOT RUN; F0-07 fica PARTIAL, pois playback real, reconexão física e pacote instalado continuam sem execução. T2 no HD real permanece NOT RUN; o teste sintético sem recovery não substitui essa variante. Resultados sintéticos anteriores permanecem válidos apenas para seus próprios ambientes. F0 não está homologada; não iniciar F1–F4.

Recomendação: corrigir o ciclo de bootstrap sob o contrato P1, repetir primeiro o caso Windows de recovery `paused` em perfil temporário e depois repetir, uma única vez sob as mesmas condições, T1/T2 no HD real. Fazer T3 e T4 apenas em sessão supervisionada pelo proprietário. Submeter o diff e a evidência de causa/correção a revisão independente read-only antes da homologação.

## Correção autorizada do bootstrap/recovery — 2026-11-10

**Estado vigente: bloqueador T5 corrigido e validado no Main real Linux/Windows; F0 continua PARTIAL quanto a HD físico/instalação e não homologada.** Esta seção sucede o FAIL encontrado na campanha anterior, sem apagá-lo. P1/P2/P3 continuam aprovadas.

A causa era a ordem circular Sequence → resolução do recovery → host → janela → Sequence. A mudança introduz preparação explícita em duas etapas somente no Main Standalone: `MainMediaRuntime` cria a composição com `deferStartupRecovery`; a Sequence nasce bloqueada, sem admissão de comandos; Main cria a janela, instala IPC e anexa/aguarda o host; então chama `resolveStartupRecovery`. Somente após confirmação do coordenador e persistência o gate publica ready/idle. A conclusão é idempotente e não reabre comandos após shutdown. Falhas continuam protegidas; janela destruída interrompe bootstrap e usa o cleanup existente. Fechamento durante inicialização deixou de ser silenciosamente ignorado pelo listener close.

Não houve alteração no recovery compartilhado, schema SQLite, V1, Preload, Doop ou Gestão. Arquivos de produção alterados nesta correção: `main-runtime.ts`, `src/main-media-runtime.ts`, `src/standalone-player-runtime.ts`, `src/standalone-player-sequence.ts`. Testes alterados: `tests/main-media-runtime.test.ts`, `tests/standalone-player-sequence.test.ts`, `tests/chromium-playback-host.test.ts`, `tests/standalone-player-production-electron.ts`, `tests/video-library-electron.ts`.

### Evidência e regressões

- Antes: Main Windows com recovery `paused` não chegava à janela em 30 s. Depois: a regressão `KQ_F0_STARTUP_ONLY=1 KQ_F0_SEED_PAUSED_RECOVERY=1` passou no Main real Linux. A assertion antiga `stopped` estava incorreta: o contrato do coordenador/store já persiste `dismissed`, também exigido pelo ramo real-library preexistente. Corrigida para `dismissed`, mantendo evidência `reason` e sem autoplay.
- Main real Linux: perfil sem recovery e reinício; fixtures antigas `paused`, `playing`, `pending`, `uncertain` e JSON inválido passaram. Os cinco estados foram selecionados por `KQ_F0_RECOVERY_STATUS`; perfis isolados e nenhuma mídia anterior retomada. O ramo `KQ_F0_RECOVERY_ONLY=1` exige MP4 local real, resolução durável, Enter, tentativa nova, vídeo avançando, refresh idle/ativo, Stop confirmado e shutdown normal.
- Main produção completo com recovery paused e MP4 de fixture: PASS Linux e Windows. O runner Windows completo de produção passou com fingerprint `6b91396ef8cddc683dbe0c79c489dd46c10ba4e4e5f678e3ef72799bcb2c1dbe`.
- Runner Windows integrado: PASS, fingerprint `183aca5110ce92535b78572471319f72e5f31bf803607d8af0fc2ff8213ab368`; SQLite/migrações, modos, biblioteca, catálogo, multi-instância, Combined/Gestão e quatro E2Es de biblioteca incluindo T6. Cleanup verificado, sem processo residual.
- Snapshot final: runner `--standalone-production` com `KQ_F0_RECOVERY_STATUS=paused` e `KQ_F0_RECOVERY_ONLY=1`: PASS, fingerprint `3f73dc0119ba191c7fc4028895cc0d5c06649acb19fa61b194bce5c171a7d98e`. Main/Sequence/IPC/Renderer/host confirmaram nova reprodução; refresh permitido em idle, bloqueado com `PLAYER_NOT_IDLE` durante playback e permitido após Stop. Este snapshot contém os testes finais; desde o primeiro runner desta correção não houve outra mudança de produção, apenas extensão/correção dos testes. Depois do snapshot final somente documentação foi atualizada.
- `npm run compile`: PASS. Unitários focados: 215/215 (Sequence 76, runtime 20, recovery 38, host 5, MainMediaRuntime 6, biblioteca 23, Management host 7, opções 6, playback 28, shutdown Main 6). Quatro casos unitários nomeados novos (dois Sequence, dois host). Falha de persistência e shutdown durante resolução mantêm gate bloqueado. Host sem ready falha no prazo, rejeita ready tardio e dispose libera IPC; testes usam relógio controlado, sem sleeps para sincronização. Eventos antigos continuam cobertos nas regressões existentes.
- E2E Linux biblioteca: PASS, quatro cenários. Os testes do host tiveram uma assertion inicial corrigida: o ready tardio lança `HOST_TERMINATED` como esperado, e o teste agora exige essa rejeição. Nenhuma guarda/timeout foi removida ou ampliada.

### T6 e evidências de performance

Confirmada uma pré-condição ausente do harness: espera de 20 s aplicada sem exigir janela ativa, enquanto o produto sonda a cada 5 s ativo/30 s inativo. O teste agora foca a janela e exige `document.hasFocus()` antes da remoção/reconexão, registra foco no diagnóstico de falha e mantém os prazos/assertions originais. T6 passou em Linux e dentro do runner Windows integrado. Não há evidência do foco da execução antiga; a causa exata daquele timeout não é retroativamente comprovada. Não foi diagnosticada “instabilidade do ambiente” nem alterado o monitor de produção.

O harness agora emite `F0_T1_PARTIAL_EVIDENCE` assim que dispõe das métricas T1, antes de iniciar etapas posteriores, para que falhas seguintes não eliminem esse resumo da saída capturada. Isso não recupera medições perdidas. **Tempos/contagem/operações do T1 real anterior continuam não comprovados.** Nenhum scan do D:, leitura do acervo externo, instalação operacional ou acesso a AppData real ocorreu nesta correção.

Cobertura de falhas é proporcional ao nível: cinco variantes de recovery e playback/refresh usam Main real; persistência falhando, shutdown durante confirmação e host sem ready usam testes determinísticos de Sequence/coordenador/host. Não se declarou E2E de clique nativo no instante exato do bootstrap nem BSOD. USB físico, reconexão do D:, buffering audível e pacote instalado continuam NOT RUN.

**GO para repetir a campanha local F0 em perfis isolados e acervo somente leitura**, sem homologação. T2 limpo deve ser separado de T5; T3 físico exige proprietário. Recomenda-se revisão independente do gate e do diff antes da homologação. Branch `feature/remote-player-lan-integration-2`, HEAD `bc3d37de09462485caa9ff027341eeabdd4b88cb`, sem commit/push; working tree preexistente preservada. F1–F4 não iniciadas.

## Campanha Windows real — T2 e T4 — 2026-11-10

Este adendo sucede as tabelas anteriores que classificavam T2/T4 como NOT RUN; aquelas entradas descrevem a campanha inicial e permanecem como histórico. A campanha atual usou o runner Windows oficial, checkout NTFS isolado, Electron/Main/Preload/IPC de produção e perfil temporário em C:. Não foi o aplicativo instalado. O volume externo D: permaneceu conectado e somente leitura. T3 não foi executado.

### Snapshot e evidências

- Branch `feature/remote-player-lan-integration-2`, HEAD `bc3d37de09462485caa9ff027341eeabdd4b88cb`.
- Fingerprint Windows do snapshot final testado: `1dce01339cba6f139b7c729a6727ec705b8d5a406ddafd1f9d6ddc670faabe4d`. As alterações posteriores nesta entrega são documentais; nenhuma fonte funcional de produção foi modificada nesta campanha.
- Windows 11 nativo, Node Windows 24.11.0 x64, Electron 45.0.0, Chromium 156.0.8078.48; D: NTFS em dispositivo USB; perfil e relatórios temporários no disco interno C:. Hardware: 16 CPUs reportadas, 33.685.835.776 bytes de RAM reportados pelo sistema.
- O relatório progressivo foi preservado em `%LOCALAPPDATA%\Temp\KQ-F0-T2T4-reports-e45a8eb110d342da8e773b95b3de956c\scenarios.jsonl`. O perfil isolado foi reutilizado entre T2/T4 e removido somente após shutdown e verificação de ausência de processos; os relatórios não foram removidos. Nenhum nome/código de música aparece nos resultados.
- Nenhum comando/harness escreveu conteúdo, renomeou ou removeu arquivos no volume externo; não houve hash integral nem leitura integral dos MP4. Contudo, a política LastAccessTime descrita abaixo significa que uma atualização automática de metadado pode ter sido agendada pelo Windows. Não houve instalação, acesso ao AppData ou uso do banco SQLite operacional; o perfil descartável usou a persistência SQLite real do aplicativo.
- **Risco de metadado LastAccessTime:** consulta read-only `fsutil behavior query disablelastaccess` retornou `DisableLastAccess = 2 (System Managed, Last Access Time Updates ENABLED)`. A listagem de diretórios pode atualizar LastAccessTime da pasta e T4 leu 4.057.641 bytes de um MP4, então o NTFS pode ter agendado atualização de acesso desses itens; a gravação pode ser adiada. A campanha não tinha baseline antes/depois por arquivo e não consegue confirmar se o disco gravou a atualização. Não tentei restaurar timestamp nem acessar o D: novamente; isso seria outra escrita/acesso proibido. A [documentação Microsoft de file times](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfiletime) informa que LastAccessTime corresponde a leitura/execução e que NTFS pode adiar sua atualização por até uma hora; a [documentação Microsoft de fsutil](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/fsutil-behavior) descreve atualização de acesso durante listagem de diretório. Nenhuma escrita foi solicitada pelo harness, mas não é possível certificar que LastAccessTime permaneceu intacto. Eu deveria ter consultado essa política antes de acessar o volume.

### Resultados

| Cenário | Resultado | Evidência observada | Limite/pendência |
|---|---|---|---|
| T1 — preparação única do índice | PASS para a varredura inicial medida | 9.311 entradas/códigos disponíveis; scan 6.409,6 ms; UI utilizável em 1.233 ms; diretórios 1, entradas enumeradas 9.311; lstat 18.622, stat 9.312, realpath 9.312, opens/closes 9.311/9.311, bytes de vídeo lidos 0; índice 1.266.655 bytes. | Uma única medição. Não repetir para criar amostras. Os nomes de 9.311 arquivos foram retornados numa listagem de diretório. Não prova cache frio do Windows nem app instalado. |
| T2 — segunda abertura, mesmo volume/perfil | **PARTIAL** (assertions de reutilização/startup passaram) | Cache `restored`, leitura 105,75 ms; processo→janela visível 1.315 ms; processo→UI utilizável 1.317 ms; snapshot operacional idle em 1.414 ms. Na UI: scan ainda `scanning`, 510/9.311 candidatos processados, 510 cache hits, 511 lstat, 1 stat, 1 realpath, zero opens. Reconciliação concluiu em 2.087 ms após criação do processo, 770 ms após UI; duração 867,2 ms; 9.311 cache hits, 9.311 lstat, 1 stat, 1 realpath, zero opens e zero bytes lidos. | `entriesEnumerated=9311` já na UI utilizável: a chamada única `readdir` devolveu a listagem completa antes desse marco, embora a reconciliação e validação seletiva continuassem em segundo plano. Portanto não declarar PASS do critério estrito “nenhuma enumeração pesada antes da UI”; a interpretação/aceite dessa listagem rápida assíncrona precisa de revisão. Sem comparação de cache frio. |
| T3 — reconexão física | NOT RUN | O dispositivo não foi removido nem reconectado. | Exige procedimento manual assistido posterior pelo proprietário; fixtures não substituem evidência física. |
| T4 — playback de MP4 real | **PARTIAL overall** (playback assertions PASS) | Um vídeo do índice foi revalidado e reproduzido via Main/IPC/Electron. Enter→Main `playing` 6.059 ms; Enter→HTMLMediaElement `playing` 5.249 ms (inclui countdown aprovado); `currentTime` avançou; pause/resume manteve a mesma attemptId; refresh bloqueado durante playback; Stop retornou a idle. Eventos: canplay 1, playing 2 (início e retomada), waiting 1, stalled/error/ended 0. O `waiting` observado terminou em canplay após ~84 ms; buffer nativo informado: ~21,6 s à prontidão. | A política LastAccessTime habilitada torna impossível certificar ausência de alteração automática de metadado. Também não comprova fluidez audiovisual perceptível, qualidade audível, A/V físico nem USB sob desconexão. O único vídeo foi reproduzido por cerca de 0,6 s. |
| Recursos de mídia no T4 | PASS técnico; integridade de timestamp não comprovada | 2 requests, ambos range; 2/2 handles fechados; 2/2 streams fechados; 0 streams ativos após shutdown; 4.057.641 bytes lidos durante a reprodução; shutdown medido em 301 ms. | Não houve medição de I/O do sistema operacional por processo nem baseline LastAccessTime. O snapshot de CPU/RAM é apenas do PID principal e não representa a árvore inteira de processos Chromium. |

### Interpretação e histórico do harness

O scan T2 terminou 770 ms depois de a UI estar utilizável. Isso comprova reutilização do índice e que o startup não aguardou toda a reconciliação por arquivo. Entretanto, o contador mostra que o `readdir` único já havia materializado os 9.311 nomes até o marco da UI; a campanha não permite dizer que nenhuma enumeração ocorreu antes dela. O relatório marca esse critério como PARTIAL para revisão independente, sem atribuir à medição uma causa de atraso nem inferir cache do Windows.

A preparação T1 abriu/fechou cada um dos 9.311 candidatos sem ler bytes dos vídeos. Na reconciliação T2 foram contabilizados 9.311 cache hits e nenhum open. O contraste 6,41 s vs. 0,87 s é observado nestas condições e não identifica, por si só, se resulta de índice, cache do filesystem, estado do volume ou outro fator. Os 286 GB não foram lidos integralmente.

**Registro de custo das tentativas:** T1 usou uma única indexação inicial. A primeira tentativa T2, iniciada para cumprir a segunda abertura real, completou uma reconciliação adicional de 9.311 candidatos em 6.409,6 ms, com 9.311 opens/closes e zero bytes lidos; depois a assertion incorreta do harness falhou. As correções do harness exigiram novos processos T2/T4: duas execuções foram encerradas antes de haver registro de scan concluído, e duas completaram reconciliações cache-only de 853,7 ms e 867,2 ms, cada uma com 9.311 cache hits, zero opens e zero bytes. Essas são passagens reais de readdir/lstat causadas pelos retries do teste; não foram rodadas como amostras de estatística. Os retries encerraram após o primeiro resultado composto PASS; não houve outro scan depois dele.

Os relatórios mantêm as tentativas anteriores. A primeira falha T2 era uma assertion incorreta que comparava `entriesEnumerated` com a contagem do scan: uma só chamada `readdir` contabiliza a listagem toda antes de processar os candidatos. Ajustes subsequentes corrigiram a observação do elemento `<video>` criado somente no load, o instante de playback (evento HTML `playing`, depois do countdown) e a expectativa de recovery terminal `stopped` ao retomar o perfil. Esses foram defeitos do harness/oráculo; nenhum produziu evidência de bug de produção. O snapshot final passou as assertions e teve fingerprint próprio acima.

O T4 real não sobrepôs playback à reconciliação: o scan terminou antes do `playing` real, portanto `playbackYieldCount=0` é esperado nesta campanha e não prova contenção sob concorrência física. A política de yield continuou coberta pelo teste determinístico de filesystem `tests/video-library.test.ts`; não se deve alegar que o HD impôs disputa de I/O durante playback.

### Verificações e decisão

- `npm run compile`: PASS no WSL e no build nativo Windows do runner.
- `node scripts/windows-native-runner.test.cjs`: PASS, 37/37.
- `npm run test:e2e:multi-instance:windows -- --approve-untracked --standalone-production`: PASS no Windows nativo, fingerprint acima; suites focadas Standalone/recovery/playback e produção Electron/IPC/SQLite passaram. Suites Combined/Gestão completas não foram executadas nesta campanha focalizada.
- `git diff --check`: PASS. Nenhuma nova implementação funcional foi feita; apenas harness/runner de teste e esta documentação foram ajustados durante a campanha. Sem commit/push/PR/release.

**Recomendação:** GO para revisão independente read-only dos resultados, com atenção a `readdir` dos 9.311 itens antes da UI e à política de LastAccessTime. T2 e a campanha T4 permanecem PARTIAL até o proprietário revisar esses limites. As assertions de playback, ranges e fechamento de recursos passaram. T3 físico, avaliação humana de áudio/tela/engasgos e pacote instalado permanecem NOT RUN. A F0 não está homologada e F1–F4 não foram iniciadas.

## Correção estrutural T2/T4 — implementação e revisão final

**Status vigente:** correções funcionais e regressões automatizadas PASS em fixtures Linux e Windows nativo. A campanha do HD real continua histórica/PARTIAL; não houve qualquer acesso ao D: nesta correção. P1/P2/P3 preservadas. F0 não homologada; F1–F4 não iniciadas.

### Causas e alterações

- T2: reconciliação era agendada antes da janela. Removido o agendamento na infraestrutura; Main admite um único scan após documento/IPC, host e recovery confirmados, composição pronta e APP_READY. Sondas/monitor não antecipam o scan. Zero readdir/opens no marco operacional, com índice e sem índice. Janela visível continua distinta de prontidão operacional.
- Protocolo: abertura física podia retornar depois da revogação sem uma nova verificação. Agora revalida capability/dispose/abort após open, fecha handle tardio e impede resposta de mídia obsoleta; revogação, cancelamento e dispose encerram streams da capability. Origin/token/Range preservados.
- Segunda revisão: dois testes determinísticos comprovaram retomada de scan após idle breve já sucedido por active e publicação de geração durante playback. Permit reavaliado em loop e aplicado também antes da ordenação/publicação, preservando a revisão publicada até idle seguro. Não há buffer personalizado nem interrupção de stream para acelerar scan.
- Harness: removeu a exigência contraditória de scan ativo na UI; registra zero enumeração no gate e admissão posterior. Mede submit/loading/playing diretamente no Main, comandos/eventos no Renderer com attemptId/hostEpoch e primeiro timeupdate positivo. Não subtrai clocks absolutos entre processos. O keydown consumido pelo produto não é observado: o instante Renderer é pré-despacho, e keydown real é NOT_MEASURED. Os 6.059 ms da campanha anterior não eram confirmação inicial Main; permanecem históricos, sem uso como baseline equivalente.

Arquivos funcionais desta correção: `main-runtime.ts`, `src/main-media-runtime.ts`, `src/player-media-protocol.ts`, `src/video-library-service.ts`. Testes/runner: `tests/main-media-runtime.test.ts`, `tests/player-media-protocol.test.ts`, `tests/video-library.test.ts`, `tests/standalone-player-production-electron.ts`, novos `tests/f0-production-validation.ts`, `tests/f0-production-bootstrap-entry.ts`, `tests/f0-bootstrap-electron.ts`, `scripts/run-windows-native-tests.cjs`, `scripts/windows-native-runner.test.cjs` e script npm focado no `package.json`. Nenhuma mudança de UI/Doop, V1, schema ou autoridade de Gestão/SQLite. Alterações preexistentes da working tree preservadas.

### Evidência final

- **Windows PASS:** runner oficial, snapshot `e8b7410e8a9602e67cf6700e68155df08c90947f713bb1f400e71401d30f4e8e`, branch `feature/remote-player-lan-integration-2`, HEAD `bc3d37de09462485caa9ff027341eeabdd4b88cb`. Compile nativo, **313 testes unitários/13 suítes**, quatro cenários Electron de biblioteca/Combined/SQLite e **11 cenários Main** (playback concorrente; cinco gates/falhas; cinco recovery antigos), exit 0. Cleanup e ausência de processos residuais confirmados. Não é app instalado.
- **Linux PASS:** compile, testes focados de biblioteca/store/runtime/recovery/playback/protocolo/host/Sequence/IPC/catálogo/Gestão/ManualPlayback, runner unitário 37/37, Main estrutural/recovery e regressão Standalone de produção completa após a última correção. Novos unitários: **17** (8 runtime, 7 protocolo, 2 biblioteca); protocolo final 10/10, biblioteca 25/25, runtime 14/14.
- **T4 fixture Windows:** dois starts da mesma fixture com attemptId distintos; avanço real de pelo menos 2 s no primeiro, pause/resume, Stop/idle e nova tentativa com eventos antigos ignorados após drenar filas Main/Sequence. Main submit→playing: **6.803,2 ms** e **5.173,7 ms**, incluindo countdown e preparação; são amostras de fixture, sem inferir causa da diferença. Pré-despacho Renderer→HTML playing: **6.779,2 ms** e **5.132,8 ms**. Dois waiting iniciais, zero waiting em playback estabelecido, zero stalled/error. Isso não certifica fluidez perceptível.
- **Recursos antes de shutdown:** primeiro Stop deixou grants/streams ativos zero, handles/streams 2/2 fechados, zero falhas de fechamento; duas requisições range, 2.222.633 bytes lidos da fixture. O scan cedeu (yield > 0, zero lstat por entrada durante playback) e retomou após Stop. Fechamento de resposta mantida ativa é provado separadamente pelos testes reais de protocolo, porque Chromium pode terminar ranges por buffering antes de Stop.

Métricas sanitizadas, transições, identificação do snapshot e hashes atuais de código/testes foram salvos em [fase-f0-evidencias-estruturais.json](fase-f0-evidencias-estruturais.json). Logs finais preservados fora dos perfis: `/tmp/kq-f0-structural-windows-final-guards.log`, `/tmp/kq-f0-structural-electron-final-guards.log`, `/tmp/kq-f0-bootstrap-electron-final-guards.log`, `/tmp/kq-f0-production-regression-final-guards.log`. O ledger registra também os FAILs anteriores, sem substituí-los por PASS: checkout em branch diferente preservado; cleanup de SQLite de teste corrigido; controle de regressão do protocolo com 3 FAIL; duas corridas da biblioteca com 2 FAIL antes/25 PASS depois. Não foram aumentados timeouts nem reduzidas assertions.

### Parecer

**T2 estrutural RESOLVIDO por automação; T4 técnico fortalecido e PASS em fixtures. GO para preparar o procedimento T3 manual assistido**, sem executá-lo. T3 físico, A/V humano, medições USB sob o código novo e pacote novo/instalado são NOT RUN. O instalador candidato anterior não contém estas correções. Não comparar timings de C:/Linux com os números antigos do HD nem afirmar correção física da reconexão.

A segurança de metadados deve ser resolvida no procedimento físico futuro antes do acesso: não alterar a política global LastAccessTime nem restaurar timestamps. Se for exigida preservação absoluta de metadados, preparar proteção de escrita validada ou decisão explícita de requisito; leitura comum num volume gravável não certifica essa garantia. Nesta correção, nenhuma consulta ou leitura do HD externo ocorreu. F0 continua sem homologação. Sem commit/push/PR/release/instalação/suspensão.


## T3 — infraestrutura física interativa e regressão sintética

**Entrega posterior à correção estrutural:** infraestrutura implementada; T3 físico **NOT RUN**, F0 não homologada. Nenhuma consulta de volume/política do dispositivo ou acesso ao D: nesta tarefa. As fontes de produção prioritárias conservam os hashes do snapshot estrutural anterior; alterações desta entrega são scripts, harnesses, seleção de suítes e documentação. [Procedimento operacional](fase-f0-t3-operacao.md), [ledger sanitizado](fase-f0-t3-evidencias.json).

Runner explícito `npm run test:manual:usb-reconnect -- --authorize-physical-test --scenario B`; cenário A ou ambos só por autorização correspondente. Terminal/CI/autorização, sessão interna com posse e perfil privado, nonce de entrada Electron, bundle/snapshot/lock/build compartilhados com runner oficial. B encerra e verifica processos antes de solicitar remoção; A drena e suspende I/O no harness antes dos checkpoints. Nenhuma ejeção automatizada. CONFIRMO exige observação real posterior; CANCELAR/BLOQUEADO/timeout preservam evidências. Retomada mantém perfil e segmentos anteriores, exige código idêntico e novo preflight. Mudança de letra bloqueia remapeamento automático.

Preflight exige consulta conhecida LastAccess + USB/NTFS online/identidade estável e IsReadOnly=true, além de proteção efetiva contra escrita validada externamente. LastAccess desativado ou open read-only não garantem preservação absoluta. Volume gravável bloqueia antes de tocar a pasta. Nenhum ajuste global/atributo/timestamp é feito. Política nativa e identidade só foram testadas com mocks; o parser PowerShell foi validado sem executar comandos de dispositivo.

### Validação desta infraestrutura

| Verificação | Resultado |
| --- | --- |
| Compile Linux / Windows nativo | PASS, exit 0 |
| Segurança/controller/CLI/preflight/cleanup/evidência | Linux 51 PASS + 1 SKIP legítimo (parser Windows); Windows 52/52 PASS |
| Runner oficial (snapshot/seleção/build) | Linux 37/37 PASS |
| Regressões biblioteca Windows | 25/25 unitários + quatro E2Es reais (Player, Combined/SQLite único, Controller legado, configuração inválida preservada) PASS |
| Nova regressão sintética Main/IPC/UI | Linux e Windows PASS, exit 0; A/B lógicos, dois ciclos adicionais, probes duplicados, resposta obsoleta por barreira, reinício/cache e mídia WebM/VP8 real gerada localmente |
| Cleanup nativo | PASS, nenhum processo residual do perfil |
| T3 físico / console humano completo / MP4 USB / A/V perceptível | NOT RUN; proibidos nesta tarefa ou dependentes da futura campanha |

Windows: `npm run test:e2e:multi-instance:windows -- --approve-untracked --video-library`, checkout NTFS interno isolado, Node v24.11.0. Fingerprint **164fabb87e9c03b3ff15914a5917438463530b5859697457d0f8ff221f987e7e**, branch `feature/remote-player-lan-integration-2`, HEAD `bc3d37de09462485caa9ff027341eeabdd4b88cb`. Após esse teste, somente documentos/evidências foram atualizados. A frase genérica TEST PASS do runner não amplia a seleção efetiva acima. Nenhum workflow foi alterado/disparado; os runners comuns só selecionam a variante sintética.

Métricas **sintéticas**, sem equivalência com o HD: restart B, gate utilizável relativo ao Main-ready 170,20 ms Linux / 199,37 ms Windows; leitura do cache 8,53 / 8,70 ms. Os tempos de processo/observação UI, sondas, scans e gerações estão nos resumos do ledger. Não comparar esses valores com 9.311 arquivos USB como ganho comprovado. Ambos exigiram zero enumeração antes do gate, scan posterior e cache restaurado. Confirmaram playing, avanço temporal >=0,25 s e Stop com grants/streams/handles encerrados antes do shutdown.

Logs: `/tmp/kq-t3-compile-final.log`, `/tmp/kq-t3-unit-final.log`, `/tmp/kq-t3-runner-unit-final.log`, `/tmp/kq-t3-synthetic-final.log`, `/tmp/kq-t3-windows-final.log`; journals persistidos em diretórios de evidência fora dos perfis removidos (nomes/hashes no ledger). A primeira tentativa Linux falhou na observação de seleção/Stop; o harness foi fortalecido com espera explícita Main playing, progresso HTML real e confirmação de bytes/handles. Não houve mudança funcional, redução de assertions ou aumento de timeout. A tentativa final e o Windows passaram. EPERM de subprocesso no sandbox do executor foi resolvido executando os testes autorizados fora dele, sem desabilitar o sandbox Chromium. Histórico anterior preservado.

### Segunda passagem crítica

Revisados preflight antes de lstat, validação de permissão da entrada Main, rejeição de links/hardlinks em perfil, ausência de processo antes da retomada, cancelamento dos checkpoints, quiescência/drenagem, epochs e perda/retorno. As barreiras retêm resposta ENOENT velha até uma reconciliação nova estar publicada; o oráculo exige ready/generation atual. Repetição de probes exige um único scan de retorno. Ausência de handle após saída é identificada como consequência do processo encerrado; Stop tem comprovação própria com app aberto. Quiescência A é instrumentação explícita e não certifica handles de outros processos/kernel. Remoção segura continua autoridade do Windows.

**Parecer:** GO para revisão independente da infraestrutura e preparação da execução supervisionada. Execução física somente sob nova solicitação, com todos os preflights satisfeitos. Sem proteção de escrita efetiva verificável, NO-GO para acessar o acervo; não alterar a política para contornar. T3 físico, qualidade A/V, desempenho real após reconexão e pacote instalado permanecem pendentes; F0 não homologada. Sem commit/push/PR/release, suspensão ou início de F1–F4.

Verificação documental final: `git diff --check` PASS; JSON e links novos do procedimento PASS; 11 hashes de código/scripts/testes iguais ao snapshot Windows testado. Referências históricas do roadmap a capturas em diretórios temporários não foram reconstituídas nem usadas como evidência desta entrega. Working tree preexistente preservada, com arquivos novos de infraestrutura/documentação ainda não rastreados.

## F0-08 — resiliência a falhas de armazenamento durante a sessão

**Implementação concluída e validada nos ambientes automatizados disponíveis; F0 não homologada.** Autorização específica do proprietário inclui o modal no código sem consultar/alterar Doop. [Contrato, máquina de estados, políticas e limites](fase-f0-08-resiliencia.md), [matriz dos 25 cenários](fase-f0-testes.md#f0-08--matriz-de-resiliência-da-sessão), [evidências/hashes](fase-f0-08-evidencias.json). D: não foi consultada, enumerada ou aberta. Sem T3 físico, instalação operacional, AppData real ou alteração global Windows.

### Diagnóstico anterior e correção

O código anterior já continha falhas conhecidas de mídia e preservava pending em blocked, mas só liberava a sessão pelo Stop All, que limpava toda a fila. Não havia recuperação da ocorrência atual mantendo as demais, congelamento do countdown por raiz indisponível ou watchdog Standalone de progresso. A ausência de raiz, por si só, não comprova falha de um vídeo ainda decodificando buffer; esse princípio foi preservado.

Sequence continua autoridade e usa blocked/uncertain com `storageRecovery`, sem criar estado operacional V1 novo ou segunda fila. A falha mantém ocorrência, filas/prioridades e timers invalidados. Root loss durante playing com progresso não interrompe; erro real ou 15 s sem avanço observado contém via Stop ACK/host termination e revoga recursos. Waiting inicial/stalled isolado não são EOF. Paused preserva intenção, countdown guarda restante, loading/Next guarda alvo, celebração de EOF válido termina uma vez. Reconnect só atualiza disponibilidade.

Novos comandos validados `recover-storage` e `discard-interrupted` usam arbiter/operationId e confirmam contenção, resolução durável e arquivo. Recuperação mantém entryId e cria attemptId nova; descartar atual mantém pending e aguarda operador para a próxima. Ctrl+Espaço mantém confirmação e limpeza total explícita. Falha de persistência, clear ou contenção não vira sucesso. Callbacks de revalidação após Stop/shutdown não rearmam countdown nem publicam ready.

A identidade física capturada por ocorrência é comparada na validação e no handle preparado para o start, inclusive depois do countdown; arquivo substituído/reindexado sob mesmo código/caminho é recusado. Sem seek confirmado no transporte atual, a posição **não é prometida nem restaurada**: o modal explica e oferece reinício do início. A garantia de fila é só nesta sessão viva, sem nova promessa entre processos.

### Modal e revisão

Modal informativo no mesmo documento, estilo existente, texto ligado ao estado Main e ações bloqueadas sem contenção. Mostra causa, disponibilidade, pausa anterior, música/filas preservadas e limitação de posição. Keyboard: foco, Tab/Shift+Tab/Enter/Space; Ctrl+Espaço e saída mantêm prioridade. Capturas reais 1280×800 e 640×480 foram examinadas. Foram corrigidos contrato restrito do Preload, ID duplicado no HTML, stacking/foco de saída e CSS hidden. Nenhuma outra tela aprovada foi redesenhada.

A segunda revisão percorreu startup/sonda, callback de loading/Next × perda, timer × cancelamento, fila × descarte/Stop, recuperação simultânea, validação × shutdown e epoch/attempt antiga. A revalidação tardia após shutdown ganhou fence e regressão. Uncertain só entra na resolução manual após contenção confirmada e usa leaveStopped existente; assert de persistência é repetida depois de resolver/limpar. O default compartilhado e Gestão/SQLite permanecem protegidos.

### Resultados finais e fingerprint

| Validação | Resultado efetivamente executado |
| --- | --- |
| Compile Linux / Windows | PASS, exit 0 |
| Unitários novos | 32 casos: 24 Sequence, 7 playback, 1 protocolo |
| Totais das suítes focadas novas/estendidas | Sequence 100/100; playback 35/35; protocolo 11/11 PASS Linux e Windows |
| Outras regressões Linux | 12 suítes de runtime/IPC/interaction/UI/options, biblioteca/store, recovery/host e Gestão/ManualPlayback PASS; runner unitário 37/37 |
| Bootstrap P1 Main real Linux | Dez cenários PASS (host pronto/falho/retido/fechamento/persistência e estados antigos paused/playing/pending/uncertain/inválido); fixture vazia só para inventário, sem playback |
| Novo E2E F0-08 Main real | PASS Linux/Windows; WebM gerado, progresso após raiz ausente, erro real de recurso Chromium, contenção, fila normal/prioritária, modal/teclado, manual retry, descarte parcial, Stop, shutdown no modal e restart P1 |
| Protocolo com I/O real | EIO injetado após primeiro chunk rejeita leitura com erro, não EOF; handle fecha; revogação continua efetiva |
| Runner Windows oficial | **360 unitários/10 suítes + quatro E2Es biblioteca + T3 sintético + novo E2E F0-08 PASS**, sem processos residuais |
| T3 sintético Linux final | PASS no código final; não é USB físico |
| Física / MP4 do acervo / A/V perceptível / app instalado | NOT RUN nesta tarefa |

Runner Windows: `npm run test:e2e:storage-resilience:windows -- --approve-untracked`, checkout NTFS privado, Node v24.11.0, Electron 45.0.0/Playwright 1.64.1. Fingerprint **f457a17b41aa84b2c2e6e58c730a4b1a7a87483be509301934e103ab2c29621d**, branch `feature/remote-player-lan-integration-2`, HEAD `bc3d37de09462485caa9ff027341eeabdd4b88cb`. Depois do runner, somente docs/evidências foram atualizadas; os 20 hashes de código/testes/scripts estão no ledger. Não atribuir a frase genérica TEST PASS do runner a suítes não selecionadas.

O E2E força erro real de recurso pelo Chromium invalidando a URL de teste, pois recarregar a mesma URL pode reutilizar mídia já decodificada e terminar naturalmente. A perda lógica de raiz é observada separadamente; o EIO físico de stream é comprovado no unitário/integração de protocolo. Nenhum playing/EOF falso foi enviado para fabricar sucesso. A/V percebido e USB/NTFS real não foram comprovados.

Logs finais `/tmp/f008-compile-final.log`, `/tmp/f008-sequence-final.log`, `/tmp/f008-playback-final.log`, `/tmp/f008-protocol-final.log`, `/tmp/f008-regressions-final.log`, `/tmp/f008-bootstrap-regression-2.log`, `/tmp/f008-electron-latest.log`, `/tmp/f008-t3-final.log`, `/tmp/f008-windows-final.log`. JSONL/capturas permanecem em diretórios de evidência separados dos perfis limpos; nomes/hashes no ledger. Falhas intermediárias foram preservadas e explicadas, incluindo predicado assíncrono do harness, schema Preload, modal duplicado/stacking e oráculo técnico de Stop sem attemptId. O oráculo final exige Sequence idle/fila vazia, engine idle ou stopped **sem attemptId** e zero recursos, conforme contrato existente — não basta a janela aparecer. Não houve aumento arbitrário de timeout.

### Riscos e parecer

Watchdog observa progresso reportado pelo host, não diagnostica fisicamente o HD; identidade por metadados não é hash de conteúdo; sem seek, recuperação é do início. Contenção não confirmada/host indisponível ou persistência falhando permanecem bloqueadas, sem false idle. Fila continua volátil entre processos. A campanha histórica completa de MP4 não foi repetida; foram executadas as regressões focadas e Main real acima. Testes físicos, desempenho no acervo, percepção audiovisual e pacote instalado continuam pendentes.

**GO para preparar/solicitar T3 físico supervisionado**, condicionado ao preflight de proteção efetiva do meio e autorização específica para execução. **NO-GO para acessar o acervo se essa proteção não puder ser verificada.** Não houve execução física; F0 permanece não homologada e F1–F4 não iniciadas. Sem commit/push/PR/release/dispatch/suspensão.

## Campanha física T3 + F0-08 — infraestrutura unificada

**Infraestrutura implementada e validada; campanha física NOT RUN.** Nesta entrega não houve consulta/acesso a F: ou D:, remoção/ejeção, instalação operacional ou alteração global. [Procedimento completo](fase-f0-t3-operacao.md#campanha-unificada-t3--f0-08--testekaraoke), [matriz dos 25 requisitos](fase-f0-testes.md#campanha-usb-unificada--cobertura-do-runner-e-regressões), [evidências finais](fase-f0-usb-campanha-evidencias.json).

O alias `test:manual:usb-campaign` estende o mesmo entry point T3, sincronizador oficial, perfil isolado e entrada Main real. `usb-campaign.cjs` acrescenta controller dos oito cenários; `usb-campaign-electron.cjs` estende o adapter existente para observações Main/Renderer, filas/timers/mídia e recuperação. Não há segundo bootstrap nem serviço permanente. Foram alterados apenas scripts/testes/package/docs; os 11 arquivos de produção registrados no ledger F0-08 foram comparados e permanecem idênticos. P1/P2/P3, indexação, protocolo, modal e contratos de fila permanecem preservados.

Modos separados: protegido mantém confirmação externa + IsReadOnly; descartável exige duas frases por sessão, USB testekaraoke saudável, identidade forte e raiz inicial F:\musicas. Autorizações de risco específicas por cenário ativo são adicionais, nunca herdadas da autorização geral. O modo descartável admite risco de LastAccess/corrupção e não afirma write protection. D:/C:/UNC/raiz arbitrária são recusados pelo novo escopo; consultas nativas são target-only na letra explicitamente autorizada, sem enumerar volumes. Mudança de letra exige mesmo ID + confirmação, encerra cenário atual PARTIAL e só permite novo perfil/baseline, sem remapear sessão/cache antigo.

Ordem: B, A, playing, paused, countdown, loading, transition, celebration. B mede startup/cache/gate/idle sem exigir playback incidental; A mantém quiescência antes da remoção segura. Ativos requerem mídia descartável e consentimento individual; não alongam timers ou loading. Janela temporal perdida ou buffer sem recuperação efetiva é PARTIAL/NOT REPRODUCED; não prolongam desconexão para forçar falha. Reconexão não toca música. Só confirmação do operador aciona botão de recuperação, com identidade nova da tentativa/mesma ocorrência, metadata currentTime=0, playing e progresso reais e fila/recursos coerentes. Logs distinguem clocks e observações diretas de inferências.

Cada cenário/tentativa tem resultado e resumo próprios, setup/cleanup e perfil novo (B reutiliza somente entre suas duas aberturas). Cancelar/pular/repetir preservam histórico. FAIL não libera automaticamente próximo cenário; erro de identidade/saúde/I/O reconhecido ou cleanup incerto encerra a sessão. Retomada restaura identidade/histórico/decisões concluídas, nunca estado operacional antigo. Resumos não sobrescrevem versões anteriores e o app encerrado antes de instalar o listener de exit agora é reconhecido pelo exitCode confirmado, evitando falso timeout de cleanup.

### Validação final

- Compile Linux e Windows: PASS exit 0. Novos unitários: 62 casos, Linux 61 PASS/1 SKIP legítimo do parser Windows; Windows 62/62. Legados T3 51 PASS/1 SKIP Linux, 52/52 Windows; runner oficial 37/37 Linux. Seis suítes de domínio Linux PASS.
- CAM-E novo: PASS Linux/Windows com controller real, checkpoints simulados, Main/IPC/Renderer reais e WebM gerado, perda/retorno de diretório temporário, playing/paused, preservação de fila, recuperação manual e cleanup. Os oito cenários de orquestração passam em simulação unitária mockada; isso não é execução física dos oito estados.
- Regressões T3 e F0-08: PASS Linux/Windows após corrigir uma corrida comprovada no harness F0-08. O teste podia pressionar Enter antes do autofocus e acionar Retry em vez de Discard; controle determinístico confirmou o comando no Main. Barreira de frame + tecla direcionada + assertion do comando recebido corrigiram o teste. FAIL intermediário e controle preservados; produção e timeouts não mudaram.
- Runner Windows final `npm run test:e2e:usb-campaign:windows -- --approve-untracked`: **422 unitários/11 suítes + quatro E2Es biblioteca + T3S + F0-08 + CAM-E PASS**, cleanup sem processos residuais. Node v24.11.0, Electron 45.0.0, Playwright 1.64.1; NTFS interno e perfis privados. Não confundir a frase genérica TEST PASS do runner com suítes não selecionadas.
- Fingerprint **7fec73f066441684457b5b9dcd261baeb5de93ccbcce1fb7a59fcffebcfe8d44**, branch `feature/remote-player-lan-integration-2`, HEAD `bc3d37de09462485caa9ff027341eeabdd4b88cb`. Depois desse runner só documentação/evidência mudou. Os 13 hashes de scripts/testes/package e a comparação da produção estão no ledger.

Logs `/tmp/usb-campaign-compile-validated.log`, `usb-campaign-unit-validated.log`, `usb-campaign-domain-regression.log`, `usb-campaign-electron-validated.log`, `usb-campaign-focus-control.log`, `usb-campaign-f008-validated.log`, `usb-campaign-windows-reviewed.log` e complementares ficam preservados fora dos perfis removidos. JSONL Main e resultados de cenário têm diretórios/hashes no ledger. Não há nomes reais de músicas ou dados operacionais nos relatórios publicados.

### Parecer e limites

**GO condicionado para futura execução supervisionada no testekaraoke**, mediante solicitação explícita e preflight real aprovado. Modo descartável depende do consentimento desta sessão e de cada remoção abrupta, não de proteção contra escrita. Metadados reais/identidade, disponibilidade F:, console humano completo, MP4 físico, A/V perceptível e hardware/cache não foram testados, por restrição desta tarefa. Driver sem identidade suficiente/saúde conhecida bloqueia. Janelas curtas podem legitimamente não reproduzir condição física; não transformar em PASS. Perfis físicos privados ficam retidos para auditoria; os processos/handles devem encerrar entre cenários. Nenhum cenário executa reparação ou ejeção por software.

A F0 permanece não homologada; F1–F4 não iniciadas. Sem commit/push/PR/release/dispatch/suspensão. Working tree preexistente preservada.


## Integração F0 no CI existente — 2026-11-11

Inventário, seletores, exclusões manuais, correções de expectativas antigas e evidências locais no [registro de cobertura CI](fase-f0-ci.md). Workflows PR/release preservados; GitHub remoto NOT RUN, sem dispatch/commit/push. F0 continua sem homologação.

## Evidência física posterior e auditoria pré-commit

Na sessão física conduzida pelo proprietário `6a06b09e-a39b-4090-812e-c16d83870628`, o resumo T3-B e o JSONL em disco interno foram inspecionados: B PASS, ausência nativa e retorno da identidade confirmados, 37 arquivos, índice restaurado em 8,75 ms, janela em 404 ms, UI observada operacional em 436,56 ms, reconciliação 30,04 ms com 37 cache hits e zero opens de MP4. O wrapper terminou PARTIAL porque a resposta final foi `PASS. PROXIMO`, não `PROXIMO`; o resultado B permanece PASS. Isso sucede apenas o NOT RUN físico histórico de B, sem homologar os demais cenários ou extrapolar performance para 9.000 vídeos.

O proprietário posteriormente informou execução da campanha completa até countdown, com falha nesse cenário; os logs dessa campanha ainda não foram auditados. A causa dessa falha física não está comprovada e não é convertida em PASS ou em diagnóstico de produção. F0 continua sem homologação.

A [auditoria de integração e pré-commit](fase-f0-ci.md) registra revisão do working tree, gates automatizados e a sincronização corrigida do harness Round Robin. Aprovação de commit local concedida pelo proprietário; avaliação GitHub Actions será feita por ele. Não houve acesso a unidades externas nesta auditoria.
