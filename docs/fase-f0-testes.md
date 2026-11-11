# F0 — Plano de testes e baseline

> **Correção estrutural vigente:** gate T2, revogação do protocolo e duas corridas de scan corrigidos e validados em fixtures Linux/Windows. Acervo real não acessado nesta correção; sua campanha anterior permanece histórica. F0 não homologada. Ver adendo final e evidências estruturais.

> **Atualização vigente:** resultados abaixo incluem históricos por lote. A campanha Windows real T2/T4 de 2026-11-10 está registrada na seção própria da campanha; ela sucede os resultados anteriores que diziam T2/T4 NOT RUN. T2 é PARTIAL porque `readdir` retornou todos os 9.311 nomes antes da UI. As assertions de playback T4 passaram, mas a campanha T4 é PARTIAL porque LastAccessTime automático estava habilitado e não havia baseline. T3 físico segue NOT RUN.

Planejado; nenhum resultado abaixo é PASS executado nesta auditoria. Contratos em [diagnóstico](fase-f0-diagnostico-arquitetura.md); execução em [lotes](fase-f0-lotes.md). Cada caso deve observar snapshot Main, mídia real quando aplicável, DTO recebido e persistência antes/depois. Fixtures temporárias; nunca perfil operacional.

## Política canônica de classificação e aceite

Consolidação: P1/P2/P3 aprovadas; o proprietário autorizou a execução contínua de F0-01–07 com avanço automático pelos gates técnicos. Os 31 grupos originais abaixo foram classificados, sem retirar cenários. Um ID agrupa vários casos parametrizados, não uma contagem de assertions executadas.

Classes: **A** = assertions preexistentes aplicáveis preservadas; **B** = cobertura nova implementada pelo responsável; **C** = caracterização na F0-01; **D** = DEFERRED antes do lote de primeiro PASS; **E** = regressão nos lotes indicados; **F** = variante Windows/hardware sem ambiente; **G** = variante visual/externa aguardando aprovação ou pré-requisito. Classes coexistem por variante: a base A não comprova a extensão B. Cada execução registra ID + variante + classe + ambiente + resultado + evidência. Nenhum grupo completo é declarado preexistente apenas porque há um harness.

**PASS** exige o oráculo da linha original satisfeito em todas as variantes aplicáveis ao lote, execução registrada e ausência de regressão introduzida. **FAIL** é qualquer assertion obrigatória falsa, perda/corrupção, violação de segurança ou contrato, mesmo que outras variantes passem. **DEFERRED** indica dependência de lote futuro, com destino explícito; não integra denominador de PASS atual. **N/A** só para variante objetivamente fora do componente (ex.: store isolado não cria janela), com justificativa; não elimina cenário da integração final. **NOT RUN** é variante aplicável não executada por ambiente/pré-requisito ausente, jamais falha observada escondida.

Nos lotes 01–06, unitário, integração FS/SQLite e Electron aplicáveis são obrigatórios para gate técnico; NOT RUN nesses níveis mantém o lote parcial e bloqueia avanço dependente até executar o teste ou identificar um bloqueador real. Variantes W/H/PK/V podem ser transferidas explicitamente para 07, com motivo, responsável e evidência faltante, sem impedir o trabalho local independente; o lote não recebe PASS Windows/visual/físico. Uma falha conhecida nessas variantes é FAIL, não transferência automática. Na 07 toda variante transferida vence: falta de ambiente mantém validação F0 incompleta; o proprietário pode aceitar uma limitação nomeada sem reclassificá-la como PASS. Os gates técnicos liberam avanço automaticamente; homologação final F0 continua humana.

Para todo ID da tabela de responsabilidade, **PASS = oráculo da matriz de cenários satisfeito; FAIL = sua negação/qualquer violação acima**. Essa regra é normativa por linha. Perfis de NOT RUN (apenas variante indicada): **T** falta de runtime/fixture de automação é bloqueante local; **W** Windows/MP4 nativo indisponível transfere variante nativa a 07; **H** acesso ao USB/hardware/Windows físico indisponível transfere variante física a 07, mas simulação FS/Electron continua obrigatória; **P** falta de pacote/host descartável/autorização de instalação transfere variante instalada a 07; **V** referência Doop/elemento novo não aprovado bloqueia somente variante visual, sem dispensar assertions técnicas. Todos os perfis herdam T para automação local. Dependência futura é D/DEFERRED, não NOT RUN de ambiente.

Ambientes: U = unitário; FS = integração filesystem real; DB = SQLite real; EL = Electron real/IPC e perfil isolado; W = runner Windows oficial em NTFS com fingerprint; H = HD físico/intervenção humana (não equivale a W); PK = pacote e instalação separados; VIS = screenshot Electron/Doop. Onde há H, a variante simulada continua exigível no primeiro PASS; hardware pode aguardar 07 pela política acima.

## Responsabilidade dos 31 grupos

Responsável também é o **primeiro lote que exige PASS do grupo completo automatizável**, exceto variantes externas explicitamente transferidas. Antes disso é D; nos lotes de regressão é E. Cobertura parcial A permanece obrigatória por impacto, e recortes B antecipados estão definidos após a tabela. Não adiantar componentes só para antecipar PASS do grupo completo.

| ID | Responsável / primeiro PASS (F0) | Regressão (F0) | Pré-requisitos técnicos | Existência / B a criar | Ambiente / dependência externa | NOT RUN legítimo |
|---|---|---|---|---|---|---|
| LIB-01 | 04 | 05,06,07 | Store isolado; não depende de startup | Nova; store proposto ainda não existe | U+FS | T |
| LIB-02 | 06 | 07 | 04/05; sondas 06 para atualização automática | Parcial em video-library/options; ampliar persistência e reconexão | U+FS+W+H | H |
| LIB-03 | 05 | 06,07 | 04; integração de configuração/open 05; sem remap automático | Nova cobertura combinada; parser existente não prova volume | U+FS+W+H | H |
| LIB-04 | 05 | 06,07 | 04; reconciliação 05 | Parcial em video-library; ampliar incremental persistente | U+FS | T |
| LIB-05 | 05 | 06,07 | 04/05; cancelamento e publicação por geração | Parcial biblioteca; ampliar cancelamento persistente | U+FS+H | H |
| LIB-06 | 05 | 06,07 | Coordenador de scan 05; availabilityEpoch adicional em 06 | Nova cobertura combinada; coalescência preexistente | U+FS | T |
| REC-01 | 02 | 03,05,06,07 | P1 aprovada; sem necessidade de índice | Ampliar runtime/recovery com nova política Standalone | U+FS+EL+W | W |
| REC-02 | 02 | 03,05,07 | Store recovery existente; política P1 | Parcial recovery.test; ampliar resolução de startup | U+FS | T |
| REC-03 | 02 | 03,04,05,07 | Falhas isoladas por barreiras/processos; store recovery existente | Parcial recovery.test; ampliar política P1 | U+FS+EL | T |
| REC-04 | 02 | 05,06,07 | Raiz ausente/arquivo removido em fixture; não requer detecção dinâmica | Nova combinação sobre runtime/recovery existente | U+FS+EL+W | W |
| PLAY-01 | 03 | 05,06,07 | 02; contenção/timeout runtime; falhas de protocolo injetáveis sem novo buffer | Parcial playback/host; ampliar recuperação | U+EL+W | W |
| PLAY-02 | 03 | 05,06,07 | Reservas/epochs e correlação existentes ampliadas em 03 | Parcial runtime/sequence/host | U+EL | T |
| PLAY-03 | 03 | 05,06,07 | 02; falhas antes/depois de Stop confirmadas | Ampliar sequence/adapter | U+EL | T |
| PLAY-04 | 03 | 05,06,07 | 02; persistência real/IPC e contenção | Parcial recovery/runtime/IPC | U+FS+EL | T |
| PLAY-05 | 03 | 05,06,07 | 02/03; opções existentes, sem disponibilidade automática | Guarda existente options.test; ampliar pós-resolução | U+EL+W | W |
| AV-01 | 06 | 07 | 05; sondas/epochs/subscription 06 | Nova cobertura dinâmica | U+FS+EL+W+H | H |
| AV-02 | 06 | 07 | 03/05/06; falha runtime + scan + sondas | Nova combinação; harnesses apenas base | U+FS+EL+W+H | H |
| BUF-01 | 07 | 07 final após ajuste autorizado | Protocolo existente + integração 05; cancelamento real | Ampliar integração do protocolo; grupo completo novo | FS+EL+W | W |
| BUF-02 | 07 | 07 final após ajuste autorizado | 03/05/06; MP4 real, observações do host | Ampliar host/playback/sequence; grupo completo novo | U+EL+W+H | H |
| DATA-01 | 07 | 07 final após qualquer correção | 02–06 e ambiente manutenção autorizado para variante instalada | Parcial persistence/options/recovery; ampliar comparação integrada | FS+DB+EL+W+PK | P |
| E01 | 05 | 06,07 | 04/05; Welcome e CSV existentes; novo restart com cache | Harness produção existente; cenário cache a criar | EL+W | W |
| E02 | 06 | 07 | 02/05/06; abrir sem HD e sonda de reconexão | Novo cenário completo | EL+W+H | H |
| E03 | 05 | 06,07 | 04/05 e fixture 1k/5k/9k | Novo cenário estrutural de cache | EL+W+H | H |
| E04 | 06 | 07 | 05 preserva geração; 06 reconecta dinamicamente | Novo cenário completo | EL+W+H | H |
| E05 | 06 | 07 | 03 recupera falha; 06 integra detecção/reconexão | Novo cenário completo | EL+W+H | H |
| E06 | 03 | 05,06,07 | 02 resolve startup; 03 converge interação/guarda | Ampliar produção com paused antigo | EL+W | W |
| E07 | 02 | 03,05,06,07 | P1/store e processos isolados; sem cache futuro no primeiro PASS | Ampliar recovery/produção; repeat com índice após 05 | EL+DB+W | W |
| E08 | 03 | 05,06,07 | 02/03; MP4 real e inválido, host recriado | Ampliar playback/integration/produção | EL+W | W |
| E09 | 03 | 05,06,07 | Sequência atual; ampliar não regressão após recuperação 03 | Parcial sequence e E2E existentes; não declarar conjunto completo existente | U+EL+W | W |
| E10 | 06 | 07 | 03 engine, 06 opções; frames existentes ou elemento aprovado | Novo cenário integrado técnico/visual | EL+W+VIS | V |
| E11 | 07 | 07 após novo candidato | 02–06; Windows/pacote/NSIS autorizado em host descartável | Smoke empacotado existe; repetir E01/E06 instalado é novo | W+PK+H | P |

### Recortes obrigatórios antes do grupo completo

- F0-01: C de PLAY-01, REC-01/02, LIB-02, E02/E03/E06/E07, AV-01 e BUF-02 somente sobre comportamento existente; sem exigir suas soluções. Medir ausência de índice/sonda é evidência válida. Não executar oráculo futuro esperando sucesso nem mudar expectativa funcional para chamar defeito de PASS.
- F0-02: B de E06 apenas resolução de startup e ausência de autoplay; Enter/guarda convergentes completos vencem em 03. DATA-01 no recorte recovery: comparar CSV/config/SQLite antes/depois, sem exigir índice/manutenção futura.
- F0-03: B de E05 apenas falha de mídia controlada e contenção/nova tentativa, sem detecção de dispositivo; E10 apenas coerência técnica engine/DTO, visual novo depende de Doop e integração opções vence em 06. DATA-01 no recorte runtime. Regredir recortes 02.
- F0-04: B de LIB-01 completo e recortes LIB-02/03/04/05/06 apenas roundtrip, fingerprint, escrita atômica/geração completa e falha de persistência no store isolado. Não exigir root probing, scanner incremental, UI ou playback via cache. DATA-01: store não modifica DB/config. Esses recortes regressam em 05/06/07.
- F0-05: B de LIB-02 sem monitor automático; E02 apenas abrir sem HD/scan bloqueante, sem reconexão dinâmica; E04 apenas cancelamento/preservação por scan parcial; E10 apenas revisão técnica do índice. LIB-06 cobre configurationEpoch/geração; availabilityEpoch vence em 06. DATA-01 no recorte índice/startup. Integrar store já aprovado sem mudar seu schema silenciosamente.
- F0-06: completa LIB-02, AV-01/02, E02/E04/E05/E10; DATA-01 recorte disponibilidade. Nova UI não é implícita na aprovação P2.
- F0-07: completa BUF-01/02, DATA-01 e E11; repete todos os grupos e recortes sobre o mesmo snapshot final. Não implementar buffering adicional por hipótese.

### F0-01 — Cobertura própria da instrumentação (B)

| ID novo | Pré-requisito / ambiente | Assertion e PASS | FAIL | NOT RUN |
|---|---|---|---|---|
| INS-01 | Logger/marcas existentes ampliados; U + FS | Opt-in desligado não registra campanha; ligado produz runId, fases monotônicas e contadores corretos em fixture conhecida; sem paths/códigos pessoais | Contagem incorreta, dados sensíveis ou efeito funcional | Falta runtime/fixture bloqueia aceite técnico |
| INS-02 | EL produção/IPC, perfil isolado; W adicional | Captura processo→janela→IPC utilizável e scan com sucesso ou erro; snapshot/fila/config/DB equivalentes com instrumentação ligada/desligada | Alteração de comportamento/dados ou fase ausente sem justificativa | W transfere para 07; EL ausente mantém validação local incompleta |
| INS-03 | FS 1k/5k/9k; EL + MP4 real para reprodução | Baseline sanitizado reproduzível, três execuções por condição viável, versão/fingerprint e condição declaradas; métricas inexistentes registradas N/A com lote futuro | Relatar futuro como PASS, faltar dimensão obrigatória sem registro, evidência não rastreável | USB/Windows/acervo 275 GB ausente transfere campanha física a 07; baseline local obrigatório |

Responsável e primeiro PASS INS-01–03: 01; regressão 02–07 quando instrumentação for usada/alterada e obrigatória na comparação final 07. São três novos grupos de validação planejados, não testes já criados. Não criar instrumentação permanente de rede. F0-01 entrega PASS da medição separado de defeito conhecido reproduzido, comportamento anterior observado, DEFERRED e NOT RUN. Métricas de leitura de índice/scan incremental/sonda não existem ainda: N/A na baseline inicial e primeira medição em 04/05/06 respectivamente.

## Matriz unitária e integração

| ID | Casos obrigatórios | Oráculo observável | Nível / base existente |
|---|---|---|---|
| LIB-01 | Índice ausente, válido, versão antiga, JSON truncado, traversal, limite excedido | miss seguro ou geração válida; zero exclusão de configuração/CSV; zero abertura MP4 no load | unit store novo + integração filesystem temporário |
| LIB-02 | Raiz acessível, ausente, permissão negada, reconectada | cache anterior preservado; estado correto; nenhuma remoção confirmada por erro | video-library.test.ts + integração |
| LIB-03 | Letra mudou, outra unidade ocupa letra antiga | não remapear por label; mudança explícita invalida cache; arquivo escolhido revalidado | unit paths Windows + Windows real |
| LIB-04 | Adição, remoção, rename, substituição mesmo nome/tamanho, duplicata | mudança detectada na reconciliação; remoção só com raiz completa; ambiguidades não elegíveis | integração FS; mtime/identidade não são hash de conteúdo |
| LIB-05 | Mudança durante scan, erro parcial, remoção USB, cancelamento, close | última geração completa intacta; handles fechados; partial nunca equivale vazio | integração com barreiras determinísticas |
| LIB-06 | Refresh simultâneo, configuração muda, resultado antigo termina depois | só geração/epochs atuais persistem e publicam; coalescência limitada | unit scheduler controlado + integração |
| REC-01 | Restart após idle/countdown/loading/playing/paused/celebration | política P1 aprovada: idle, sem play automático; evidência preservada; CSV/config iguais | runtime/recovery unit + processo separado |
| REC-02 | JSON válido antigo paused, incompleto, corrompido, versão futura | preservação verificável; nunca apagar original sem arquivo confirmado; falha bloqueia explicitamente | store/recovery unit + filesystem |
| REC-03 | Morte em prepared, target rename, committed, resolução parcial | leitura restaura estado permitido; resolução idempotente; revisão não conta músicas | store integração com falhas injetadas |
| REC-04 | HD ausente, música anterior removida | restart não abre música anterior; diagnóstico preservado | unit + Electron |
| PLAY-01 | MP4 inválido, falha open/range, ready nunca chega, host.ready pendente | término limitado da tentativa; contenção antes de idle; nenhuma reprodução fantasma | playback unit + Electron MP4 real/arquivo inválido |
| PLAY-02 | Eventos playing/pause/ended/error tardios, ACK antigo, callback timer antigo | tentativa posterior e fila imutáveis; EOF no máximo uma vez | runtime/sequence/host unit |
| PLAY-03 | Falha no primeiro start e após stop da atual para próxima | sem perda de head/pending; erro recuperável; não simular sucesso | sequence + adapter integração |
| PLAY-04 | Stop falha, write falha, resposta perdida, retry mesma operação/payload divergente | uncertain protegido; sem replay cego; conflito de ID rejeitado | recovery/runtime + IPC |
| PLAY-05 | Refresh em idle, playback, pausa, countdown, loading, celebration, blocked | permitido apenas idle confirmado sem fila/reserva; bloqueio não permanente após resolução confirmada | options + IPC |
| AV-01 | Remover/reconectar, rápida oscilação, reconexão após erro | epochs descartam resposta antiga; uma sonda pendente; UI recebe última revisão | unit fake clock + integração FS |
| AV-02 | Remover durante scan/playback | scan não apaga cache; mídia falha recuperavelmente; sem EOF falso | Electron + Windows físico separado |
| BUF-01 | GET/HEAD/range/suffix/416, cancelamento e erro no stream | bytes corretos, fechamento de handles, ausência de leitura integral forçada | protocolo integração + Electron |
| BUF-02 | waiting/stalled→playing, seek/restart, prioridade muda | não avançar fila nem completar turno por buffering; sem pré-carga obsoleta | host + sequence + MP4 real |
| DATA-01 | SQLite antes/depois de crash, índice, recovery e manutenção | sessões/histórico/pins/frozen/CSV/licença preservados; nenhum writer adicional | SQLite real/IPC e regressão Gestão |

Unitários com mocks comprovam decisões; integração usa fs/SQLite reais. Simular EACCES por adapter é teste de regra; adicionar caso Windows de permissão isolada quando viável, sem ACL global. Windows path tests no Linux não comprovam volumes Windows.

## Matriz E2E

| Grupo | Sequência e asserções | Ambiente |
|---|---|---|
| E01 | Welcome biblioteca + CSV opcional; fechar; segunda abertura; configuração/contagens preservadas; tocar código sem CSV | production-electron + Windows |
| E02 | Sair, tornar raiz indisponível, reabrir; UI utilizável sem scan; reconectar; sonda/revisão atualiza; tocar | FS controlado + Windows físico |
| E03 | Reconectar entre execuções; índice carrega sem enumeração no caminho crítico; confirmar leitura seletiva | production + fixture 1k/5k/9k |
| E04 | Remoção durante scan; geração anterior preservada; reconectar e refresh completa | Electron + físico |
| E05 | Remoção durante playback e loading; falha recuperável, sem áudio fantasma; nova música funciona após resolução | Electron MP4 + físico/audível |
| E06 | Perfil paused antigo com UUID válido; UI e Main convergem; Enter toca nova tentativa; refresh obedece estados | Main de produção, não apenas harness |
| E07 | Encerramento normal e kill de processo isolado em cada fase; reinício; sem autoplay e sem perda SQLite | Electron processo descartável |
| E08 | MP4 inválido/ilegível, host recriado, evento antigo; tentativa seguinte intacta | playback + integration harness e produção |
| E09 | Countdown/pausa/retomada/celebração, prioridade LIFO, normal FIFO, 30 pendentes, Next/restart/atalhos | sequence unit + E2E existentes |
| E10 | Snapshot tardio opções/engine; visual idle não mascara blocked; feedback aprovado Doop | Electron 1280×800 + comparação imagem |
| E11 | Pacote win-unpacked depois NSIS em host descartável autorizado; atalhos e userData real isolado; repetir E01/E06 | Windows nativo/pacote/instalação distintos |

Reusar tests/standalone-player-production-electron.ts para main real, standalone-player-integration-electron.ts e standalone-player-playback-electron.ts para fronteiras técnicas, player-playback-recovery-electron.ts para recuperação. Test-only dialog port não prova diálogo nativo. Processo morto não equivale tela azul. Nunca causar BSOD, remover HD de dados em escrita ou instalar/desinstalar produto operacional nesta tarefa.

## Baseline e regressões de performance

F0-01 deve produzir CSV/JSON local temporário sem paths/códigos pessoais: runId, fingerprint, build, hardware/USB/filesystem, tamanho do acervo, condição quente/fria/reconectada, timestamps monotônicos e contadores agregados. Três execuções por condição permitem baseline inicial (não inferir p95 confiável de três amostras); ampliar amostragem antes de estabelecer percentis. Não limpar caches globais Windows para fabricar condição fria.

Fixtures: 1.000, 5.000 e 9.000 nomes válidos com estrutura/subdiretórios; arquivos pequenos para custo de enumeração, subconjunto MP4 real para playback. Isso não reproduz 275 GB; campanha física mede acervo real sem modificá-lo, mediante acesso do proprietário. 15.000 é preparação/referência H6, não nova campanha endurance F0.

Medir conforme componentes disponíveis em cada lote (métricas futuras N/A até sua implementação): processo→janela visível; processo→primeiro comando IPC respondido/entrada utilizável; leitura índice; scan completo/incremental; número readdir/lstat/stat/realpath/open/close; bytes do stream por faixa e bytes de cache; CPU/RSS do Main e renderer; tempo de sonda/indisponibilidade/reconexão; waiting/stalled e duração até playing; readyState/networkState/buffered em amostragem limitada. Bytes do processo não equivalem I/O físico do HD; usar contadores Windows externos só quando disponíveis e identificados.

Assertions estruturais **funcionais da F0-05/06 e regressão 07; nunca aceite F0-01**: startup com cache não enumera entradas nem abre MP4 antes de UI utilizável; cache ausente também não prende criação da janela; no máximo um scan/sonda por raiz; nenhum scan novo durante loading/playback; nenhuma publicação de epoch antiga; nenhuma remoção por scan parcial. Para cenários físicos, registrar tempos absolutos baseline e pós-correção. Metas temporais definitivas dependem do baseline aprovado, não inventar ganho percentual. Falta de medição física é NOT RUN, nunca PASS.

Esperas usam eventos/barreiras e relógio controlado; timeout de teste é limite de falha, não sincronização. Validar conteúdo e estado, não apenas que app abriu. Retenção diagnóstica apenas campanha opt-in, sem telemetria de rede/permanente.

## Comandos reais disponíveis

Executar apenas subconjunto indicado pelo lote após compilar:

```sh
npm run compile
node build/tests/video-library.test.js
node build/tests/main-media-runtime.test.js
node build/tests/player-playback-recovery.test.js
node build/tests/player-playback.test.js
node build/tests/chromium-playback-host.test.js
npm run test:unit:standalone-runtime
npm run test:unit:standalone-sequence
npm run test:unit:standalone-options
npm run test:unit:standalone-ipc
npm run test:e2e:video-library:headless
npm run test:e2e:standalone-integration:headless
npm run test:e2e:standalone-production:headless
npm run test:e2e:player-recovery:headless
npm run test:e2e:standalone-production:windows
npm run test:e2e:standalone-playback:windows
npm run test:e2e:standalone-options:windows
node scripts/run-windows-native-tests.cjs --player-recovery
```

Runner exige pré-requisitos/variáveis MP4 Windows conforme docs/windows-native-testing.md; revisar untracked antes de transferir e registrar fingerprint. Não passar approve-untracked indiscriminadamente. Novos testes devem integrar scripts existentes sem remover cobertura. `npm run test:unit` só na integração final ou mudança compartilhada abrangente; Gestão: persistence/round-robin/cadence/session-close E2E quando contratos compartilhados atingidos. Workflows PR existentes fazem build/verify/smoke e NSIS em hosted runner; release manual não deve ser disparado. A autorização desta F0 cobriu explicitamente build/verificação de candidato; instalação continua NOT RUN. Launcher manual oficial não substitui runner nem pacote instalado.

## Ledger de execução F0 — 2026-11-10

Os oráculos acima continuam canônicos. Esta tabela registra resultados observados e variantes ainda não executadas; PASS de fixture não se estende a USB/acervo físico. Identificadores, assertions e responsáveis permanecem os da matriz de responsabilidade acima. Nenhum grupo `NOT RUN` foi convertido em PASS.

| ID | Resultado observado | Evidência de execução | Variante que permanece pendente |
|---|---|---|---|
| INS-01 | PASS | `tests/f0-diagnostics.test.ts`; `npm run test:unit` | Nenhuma para o oráculo unitário |
| INS-02 | PASS | E2E Main de produção Linux e runner Windows `--standalone-production`; logs sanitizados e perfil temporário | Startup Windows sobre o acervo real NOT RUN |
| INS-03 | PARTIAL | Baselines de biblioteca e índice; fixtures de 1k/5k/9k e índice sintético | HD real e contadores Windows físicos NOT RUN; 15k está fora da F0 |
| LIB-01 | PASS | 9 testes do store e integração FS; Linux e runner Windows completo | Nenhuma para ausência/JSON/schema/uint64 simulados |
| LIB-02 | PARTIAL | Acessibilidade, remoção, permissão simulada e reconexão em filesystem temporário; E2E Electron biblioteca Linux/Windows | Remoção/reconexão USB física NOT RUN |
| LIB-03 | PARTIAL | Configuração/identidade de volume divergente rejeita remapeamento; testes Node e Windows | Troca real de letra D: e outra mídia ocupando D: NOT RUN |
| LIB-04 | PASS | 23 testes `video-library.test.ts`, incluindo adição/remoção, rename e substituição com mesmo tamanho/timestamp | Nenhuma para FS temporário; hash completo não faz parte do contrato |
| LIB-05 | PASS | Falhas parciais, close/cancelamento e preservação de geração em fixtures com barreiras; runner Windows biblioteca | Desconexão física durante scan NOT RUN |
| LIB-06 | PASS | Refresh/configuração concorrentes, epochs e descarte de resultado antigo em testes controlados; Linux/Windows | Nenhuma para o oráculo determinístico |
| REC-01 | PASS automatizado após correção; ver adendo final | Main real Linux com cinco variantes; Windows paused com resolução durável e nova reprodução | Tela azul real não simulada; hardware/pacote não homologados |
| REC-02 | PASS | Recovery store preserva byte a byte JSON inválido/incompatível e impede liberação insegura | Perfil AppData real NOT RUN e não acessado |
| REC-03 | PASS | Escrita/resolução interrompida e retomada idempotente em FS temporário; sem migração real | Falha elétrica/BSOD real não simulada |
| REC-04 | PASS | HD/arquivo ausente em fixture não retoma música anterior; recovery/produção Electron | Música removida do HD físico NOT RUN |
| PLAY-01 | PASS | Erro MP4, timeout e confirmação de containment em unitários e produção Electron | Falha causada por USB físico lento/desconectado NOT RUN |
| PLAY-02 | PASS | Eventos/ACK/EOF antigos e fora de ordem em unitários de sequence/host/runtime | Nenhuma para o oráculo automatizado |
| PLAY-03 | PASS | Falha de start/Next mantém head e tentativas posteriores operáveis; unitários e integração Electron | Nenhuma para falha controlada |
| PLAY-04 | PASS | Stop/persistência incertos permanecem protegidos; retry não repete efeitos; recovery + IPC | Nenhuma para os cenários isolados |
| PLAY-05 | PASS | Refresh respeita playback/transição/uncertain e deixa de bloquear após resolução confirmada; options/IPC/E2E | Nova política visual não necessária |
| AV-01 | PARTIAL | Sonda e epochs em FS temporário passaram; E2E Windows de fixture passou na repetição isolada, mas a primeira execução integrada expirou na espera de reconexão | USB físico NOT RUN; diferença entre primeira execução e repetição não explicada |
| AV-02 | PARTIAL | Remoção simulada durante scan e falha de mídia recuperável em Electron | Remoção física durante playback NOT RUN |
| BUF-01 | PASS | `tests/player-media-protocol.test.ts`; GET/HEAD/range, stream/cancelamento e limpeza de handle; unit + Electron real | Leitura via USB físico sob carga NOT RUN |
| BUF-02 | PARTIAL | MP4 local em Electron real, seek/restart e sequência preservados | `waiting/stalled` sob carga/HD real, áudio e engasgos físicos NOT RUN; sem buffer customizado |
| DATA-01 | PARTIAL | SQLite temporário e regressões Windows de catálogo/Combined/Management passaram | Persistência pós-instalação em perfil dedicado NOT RUN; instalador não foi instalado |
| E01 | PARTIAL para a campanha real | Produção Electron anterior e harness sintético Windows sem recovery passaram; T2 com D: não foi completado com reinício limpo | Segunda abertura real do D: NOT RUN; pacote instalado NOT RUN |
| E02 | PARTIAL | E2E Windows de fixture confirmou a UI “Pasta indisponível” na remoção lógica; reconexão passou em repetição isolada | USB físico e reconexão real NOT RUN; primeira execução integrada expirou |
| E03 | PARTIAL | T1 real iniciou varredura e alcançou verificações posteriores ao scan, mas não conservou métricas/contagem; fixtures 1k/5k/9k permanecem evidência separada | Tempo/cache de segunda abertura real NOT RUN; app instalado NOT RUN |
| E04 | PARTIAL | E2E Windows de fixture passou em repetição isolada: remoção/reconexão, geração/configuração preservadas e atualização da UI | Remoção USB física durante scan NOT RUN; primeira execução integrada expirou |
| E05 | PARTIAL | Erro de arquivo/MP4 e nova tentativa recuperável em Electron com fixture | Playback do D: não alcançado; USB durante playback e validação audível NOT RUN |
| E06 | PASS após correção do bootstrap; ver adendo final | Main real Linux/Windows: recovery paused resolvido, Enter inicia MP4, refresh idle confirmado/ativo bloqueado e Stop seguro | Variante no HD real e aplicativo instalado NOT RUN |
| E07 | PASS | Shutdown e encerramento abrupto de processos Electron isolados; restart não retoma playback nem perde SQLite temporário | Reinicialização Windows/BSOD real não executada |
| E08 | PASS | MP4 inválido, erro/host, eventos antigos e tentativa nova em Electron + unitários | Falha de disco físico NOT RUN |
| E09 | PASS | Fila, prioridade, pausa, countdown, celebração, Next e sequência em unit/E2E produção | Nenhuma regressão automatizada identificada |
| E10 | PASS | Status/options e revisão obsoleta em Electron; interface aprovada não mudou | Comparação Doop NOT APPLICABLE: nenhuma alteração visual nova |
| E11 | PARTIAL | `package:windows:candidate` + `verify:windows-build` PASS no snapshot validado; SHA e manifesto conferidos | Executável/NSIS não instalados; smoke instalado/manutenção NOT RUN |

### Adendo de validação nativa do HD — 2026-11-10

Este adendo é mais recente que o ledger acima e registra a campanha autorizada. Ambiente: Windows 11 build 26200, Node v24.11.0 x64, Electron 45.0.0, runner Windows em checkout NTFS isolado, volume USB D: identificado como NTFS. O perfil temporário ficou em C:. Nenhum dado do AppData operacional foi acessado e nenhuma escrita foi feita no D:. A capacidade do volume observada pelo Windows foi 500.107.862.016 bytes; “286 GB/~9.000 MP4” continua sendo estimativa do proprietário, sem contagem de campanha preservada.

| Caso | IDs associados | Resultado/variante | Oráculo observado | Primeiro resultado/limite | Regressão requerida |
|---|---|---|---|---|---|
| T1 — primeira indexação em D: | INS-03, E03, LIB-02/04/05 | PARTIAL; Windows nativo + HD real | Assertions T1 passaram, incluindo UI utilizável antes do fim da reconciliação e índice populado/coerente com o scan. O caso composto falhou depois, antes de exportar tempo, contagem exata e contadores. Não é PASS de performance. | Quantidade exata, duração e operações: sem registro confiável. Nenhuma nova varredura completa foi feita. | F0-07, uma execução comparável depois da correção, mantendo as mesmas condições quando possível. |
| T2 — segunda abertura limpa no mesmo D: | E01, E03 | NOT RUN na variante real; PASS somente para harness sintético sem recovery | Harness sintético Windows restaurou índice. O processo real subsequente foi preparado com recovery `paused`, então não serve como T2 limpo nem comprova cache/startup do D:. | Janela, tempo de cache e enumeração crítica para T2 real não medidos. | F0-07; repetir uma vez após T5 corrigido, sem semear recovery. |
| T3 — reconexão física | E02/E04, AV-01/02 | NOT RUN; hardware | Unidade permaneceu conectada, sem remoção automatizada. | Depende de intervenção segura e supervisionada pelo proprietário. | F0-07/homologação física. |
| T4 — playback de MP4 real | BUF-02, E05, AV-02, PLAY-01 | NOT RUN; Electron/IPC de produção + D: | Sequência composta parou antes de selecionar mídia do D:. Os E2Es com MP4 usaram fixtures locais. | Sem evento `playing`, medidas waiting/stalled, concorrência, I/O de playback ou inspeção de handle para o HD real. | Após recuperação de T5, executar sob runner isolado; áudio físico permanece humano. |
| T5 — recovery `paused` | REC-01/04, E06/E07 | FAIL reproduzido; Windows nativo, Electron e perfil descartável | Electron não criou janela dentro de 30 s; harness falhou antes da UI. | Enter, refresh em idle e guarda durante playback não exercitados. Não corresponde exatamente à observação de UI visualmente idle do proprietário. | F0-02 e F0-07; exigir recovery resolvido, janela criada, Enter aceita nova tentativa e refresh permitido em idle; playback real continua protegendo refresh. |
| T6 — disponibilidade e reconexão lógica | AV-01/02, E02/E04 | PASS no E2E fixture após repetição isolada; nenhuma prova USB | Remoção lógica atualizou Main/UI para indisponível; configuração/índice permaneceram; recriar a raiz restabeleceu disponibilidade e geração. | Primeira execução integrada expirou na espera de reconexão. A repetição focada passou; estabilidade da diferença não explicada. Fingerprint focado `48326107dc9d957148c0c3b7e9ed71bb80e0ce12855d9a64fe59a58d7619fc8`. | Repetir em F0-07 no runner integrado; USB físico permanece independente/NOT RUN. |

O comando do runner focado que concluiu T6 foi `npm run test:e2e:multi-instance:windows -- --approve-untracked --video-library`; passou com 23 testes de biblioteca Windows e quatro E2Es de biblioteca. A tentativa integrada anterior que expirou é uma falha observada, não apagada pelo retry. O teste que reproduziu T5 terminou antes de produzir um fingerprint/manifeste final verificável; não associar a ele o fingerprint do T6.

### Interpretação das medições

Não há números absolutos da biblioteca real para comparar. A campanha F0 anterior em Linux/WSL2 usou fixtures vazias: scan de 9k em 6,38 s e read/parse do índice em cerca de 103 ms, além de cerca de 1,38 s de reconciliação de serviço. Não são resultados Windows nem hardware. A execução real de T1 não reteve suas métricas e T2 limpo, T3 e T4 não foram executados; não afirmar que a abertura após reconexão melhorou. A campanha não observou bytes de vídeo efetivamente lidos, comportamento de cache frio do Windows ou consumo de I/O durante playback.

O efeito do T5 é reproduzível e corresponde a violação P1; a correção funcional pertence à implementação futura e esta campanha não a alterou. A falha inicial e o retry de T6 devem ser considerados juntos até uma execução integrada estável. Testes físicos, mídia real e pacote instalado continuam NOT RUN, não PASS.

### Resultado integrado e performance

`npm run compile`: PASS. `npm run test:unit`: PASS — 499 casos em 43 relatórios, zero falhas. Foram adicionados 32 casos unitários nomeados no diff (20 em arquivos de teste existentes e 12 em três arquivos novos). `npm run test:e2e:video-library:headless`: Electron não iniciou no sandbox; a repetição fora do sandbox pelo mecanismo aprovado passou nos quatro cenários. Runner Windows completo: PASS no snapshot validado `de3e33242ad4c63feb5fc0b4a574e89c19a43ffbbc50ed3bc5293f4e18b091cd`; runner Windows de produção Standalone: PASS no mesmo snapshot, com Electron, IPC, MP4 local, SQLite/perfil isolado e cleanup. Pacote candidato e verificador também PASS; artefato não instalado. Os registros finais acrescentados depois do runner são documentais; nenhum código ou teste mudou após esse snapshot.

Baseline sintético antes da implementação: scan completo de 9k em três execuções variou de 6,28 a 7,32 s, abrindo/fechando cada um dos 9.000 arquivos sem ler conteúdo. Implementação final: uma execução de scan completo 9k levou 6,38 s; após restart, leitura do JSON levou 102,6 ms e reconciliação 1,38 s, enumerando a árvore toda mas com 9.000 cache hits e zero opens. JSON 9k: 1.110.295 bytes; write 83,03 ms e parse/read 63,91 ms. As medições são WSL2/Linux com MP4 vazios e cache não controlado; não medem janela, I/O físico, Windows nativo nem o HD real. Uma amostra final não permite alegar meta/percentil ou melhora conclusiva do scan completo. O ganho observado é no caminho de revalidação/cache, não em evitar enumeração.

Na amostra final de scan completo 9k, CPU user/system foi 2.331/3.365 ms; RSS do processo medido antes/depois foi 145.494.016/157.519.872 bytes. O parse do JSON 9k mediu heap delta 3.299.944 bytes e RSS delta 10.944.512 bytes; escrita mediu heap delta 19.330.744 bytes. RSS não é pico e as execuções de uma única instância acumulam estado anterior, portanto esses deltas não são previsão de RAM de uma execução Electron em computador de 8 GB. Bytes de MP4 lidos: zero nas medições de scan/cache; I/O físico do Windows não observado.

Nenhum AppData real foi acessado; o HD pessoal não estava montado. Variantes físicas e aplicativo instalado ficam `NOT RUN` para homologação. A F0 está implementada, mas não homologada.

## Revalidação após correção estrutural T5 — 2026-11-10

Este adendo prevalece para o estado corrente das variantes corrigidas; o FAIL anterior permanece evidência histórica. Detalhes/fingerprints no [relatório](fase-f0-relatorio.md#correção-autorizada-do-bootstraprecovery--2026-11-10).

| IDs/variante | Evidência atual | Resultado e limite |
|---|---|---|
| REC-01/02/04, E06-startup | Main real Linux com perfil novo e `KQ_F0_RECOVERY_STATUS=paused/playing/pending/uncertain/invalid`; segundo restart/cache separado | PASS para fixtures; nenhum autoplay/fila inferida; registro resolvido antes de idle; AppData operacional não usado |
| E06 completo, PLAY-05 | Main real Linux/Windows, `KQ_F0_RECOVERY_ONLY=1`, MP4 local, recovery paused | PASS: Enter → nova tentativa → vídeo avançando; refresh confirmado idle, bloqueado ativo, confirmado após Stop; shutdown confirmado |
| REC-01, PLAY-04 — falha de persistência | Teste Sequence com resolver rejeitando `RECOVERY_PERSISTENCE_FAILED`, mais coordenador/store existentes | PASS unitário/integração focada; gate não publica ready; não é injeção E2E de erro de disco no Main |
| REC-01, E07 — host sem ready/fechamento bootstrap | Host com timer virtual; dispose durante ready; Sequence shutdown enquanto resolver aguarda confirmação | PASS determinístico: rejeição, handlers removidos, nenhum ready pós-shutdown; instante exato de fechamento nativo durante bootstrap não exercitado como E2E |
| PLAY-02, E07/E09 | Sequence/runtime/recovery/host e produção completo | PASS: correlação, EOF/ACK atrasado, fila, pausa, shutdown e nova tentativa preservados |
| AV-01, E02/E04, T6 fixture | Foco ativo exigido pelo harness, sem aumentar 20 s; Electron Linux e runner integrado Windows | PASS no fluxo integrado; USB físico NOT RUN; foco original não registrado impede provar a causa exata do timeout antigo |
| INS-03/T1 real | Saída antecipada `F0_T1_PARTIAL_EVIDENCE` adicionada ao harness | Registro corrigido; campanha real não repetida. Métricas anteriores permanecem não comprovadas |

Unitários focados 215/215 e compile PASS; quatro novos casos nomeados. Fingerprint Windows final `3f73dc0119ba191c7fc4028895cc0d5c06649acb19fa61b194bce5c171a7d98e`; integrado T6/Gestão `183aca5110ce92535b78572471319f72e5f31bf803607d8af0fc2ff8213ab368`; produção completo `6b91396ef8cddc683dbe0c79c489dd46c10ba4e4e5f678e3ef72799bcb2c1dbe`. Entre esses snapshots só os testes foram estendidos/corrigidos, sem mudança das fontes de produção. Depois do último runner apenas documentos mudaram. Todos usaram checkout NTFS e perfis temporários, sem processos residuais.

T2 real limpo, T3 USB físico, T4 no acervo externo e E11 instalado continuam NOT RUN; P1/P2/P3 não são pendências. F0 ainda não homologada. O caso paused anteriormente falho só recebeu PASS depois de executar a nova ordem com Main real e playback/guardas confirmados.

### Campanha Windows real — T2 e T4 — atualização vigente 2026-11-10

Esta matriz de resultados complementa/sucede as linhas históricas acima sem apagá-las. Execução em Windows 11 nativo pelo runner oficial, checkout NTFS isolado, Electron 45.0.0/Chromium 156.0.8078.48, Node Windows 24.11.0; índice e perfil em disco interno C:, biblioteca real no volume NTFS D: USB. Fingerprint testado `1dce01339cba6f139b7c729a6727ec705b8d5a406ddafd1f9d6ddc670faabe4d`; branch/HEAD preservados. O aplicativo foi o Main de produção executado pelo runner, não o produto instalado. O relatório progressivo permaneceu em `%LOCALAPPDATA%\Temp\KQ-F0-T2T4-reports-e45a8eb110d342da8e773b95b3de956c\scenarios.jsonl`.

| Teste/IDs | Resultado observado | Assertion/oráculo e evidência | Ambiente, limitação e regressão |
|---|---|---|---|
| T1 preparação única / INS-03 / E03 / LIB-02/04/05 | PASS para a varredura inicial medida | Scan completo único: 9.311 entradas/códigos, 6.409,6 ms; UI utilizável 1.233 ms; lstat 18.622, stat 9.312, realpath 9.312, opens/closes 9.311, bytes lidos 0; índice 1.266.655 bytes. | Runner/Electron Windows + D: read-only; preparação, não uma nova amostra de performance. Sem leitura integral do vídeo. Histórico das falhas T2 continua no JSONL. |
| T2 / E01 / E03 / LIB-02 | **PARTIAL executivo**; assertions de cache/UI do runner PASS | Índice `restored` em 105,75 ms; janela visível 1.315 ms; UI utilizável 1.317 ms; snapshot idle 1.414 ms. No marco: `scanInProgress=true`, status scanning, 510 candidatos e cache hits, 0 opens; reconciliação terminou 770 ms após UI (867 ms de scan), com 9.311 cache hits e 0 opens/bytes. | Mesmo perfil/index entre processos. `entriesEnumerated=9311` no marco de UI: a chamada única `readdir` já entregou todos os nomes; candidatos ainda estavam sendo validados. Critério “sem enumeração pesada antes da UI” não é comprovado e requer revisão; não afirmar zero enumeração. Não foi teste de app instalado/cache frio. Repetir em 07 somente se a revisão exigir aceitação ou alteração do comportamento. |
| T4 playback / PLAY-01/05 / BUF-01/02 / E05 | **PARTIAL geral**; assertions de playback PASS com 1 MP4 real | Revalidação do caminho, Main/IPC/HTML `playing` correlacionado, `currentTime` avançou; Enter→HTML playing 5.249 ms e Enter→Main playing 6.059 ms; pausa/retomada na mesma attemptId; refresh ativo bloqueado; Stop→idle. Eventos canplay=1, playing=2, waiting=1 (~84 ms até canplay), stalled/error/ended=0; buffer observado ~21,6 s. | LastAccessTime estava habilitado e sem baseline, portanto preservação de metadado não pode ser certificada. Uma faixa, cerca de 0,6 s de progresso antes de pause/stop; sem avaliação visual/audível humana. Playback real ocorreu após terminar a reconciliação, então competição/`yield` não foi exercitada neste cenário. |
| T4 handles/ranges / BUF-01 | PASS | 2 requests, 2 range requests; handles 2/2 fechados; streams 2/2 fechados; ativos após shutdown 0; 4.057.641 bytes lidos; shutdown 301 ms. | Electron/Chromium real e arquivo D: acessado em streaming; sem medir I/O total de processo/OS. Não foi instalada a aplicação. |
| T3 USB físico / AV-01/02 | NOT RUN | Sem remoção nem reconexão física; teste sintético não é prova física. | Fora desta autorização; exige sessão manual assistida do proprietário. |
| A/V perceptível / BUF-02 | NOT RUN | Eventos Chromium e `buffered` são evidência técnica, não observação física de áudio/tela. | Requer validação humana; sem desconectar o volume durante playback. |

**Classificação final dos resultados:** o runner reportou T2/T4 PASS porque todos os seus oráculos corrigidos passaram. A classificação executiva mantém T2 e a campanha T4 como **PARTIAL**: T2 observou 9.311 entradas enumeradas antes da UI, sem provar ausência dessa listagem; a função de playback T4 passou, mas LastAccessTime automático estava habilitado e não houve baseline para certificar preservação. `playbackYieldCount=0` é correto porque o scan acabou antes do evento HTML `playing`; `tests/video-library.test.ts` cobre de forma determinística o yield quando playback realmente está ativo.

O histórico de harness foi preservado no mesmo arquivo de evidência: primeira T2 falhou por comparar incorretamente `entriesEnumerated`; houve assertion de elemento `<video>` inexistente em idle (o elemento nasce ao carregar), timestamp de concorrência tomado no Enter antes do countdown e recuperação do perfil terminal `stopped` ao retomar testes. O harness corrigiu cada oráculo e a execução final foi PASS. Essas falhas intermediárias não foram convertidas em PASS nem atribuídas à produção. A unidade real não foi lida integralmente; a primeira varredura abriu/fechou candidatos, mas `bytesRead=0`.

Para transparência de I/O: houve uma única indexação T1; a primeira segunda abertura T2 completou mais uma varredura de metadados de 9.311 candidatos (6.409,6 ms, 9.311 opens/closes, zero bytes) antes de falhar no oráculo. Os retries posteriores foram necessários para corrigir o harness: dois foram interrompidos antes de registrar scan concluído e dois completaram reconciliação cache-only (853,7/867,2 ms, 9.311 cache hits, zero opens/bytes). Esses retries reenumeraram/validaram a árvore; não foram campanhas de performance, e não houve novas passagens depois do resultado composto final PASS.

Runner final: `npm run test:e2e:multi-instance:windows -- --approve-untracked --standalone-production`, PASS com fingerprint acima; compile nativo PASS; `node scripts/windows-native-runner.test.cjs` PASS 37/37; `git diff --check` PASS. Suites de Gestão/Combined completas, T3, áudio/tela física e pacote instalado não foram executados. Os relatórios persistem; o perfil temporário foi limpo após confirmar shutdown/processos. F0 não homologada.

**Limitação de timestamps do volume:** consulta read-only `fsutil behavior query disablelastaccess` retornou `DisableLastAccess = 2 (System Managed, Last Access Time Updates ENABLED)`. A listagem pode atualizar LastAccessTime do diretório e T4 leu 4.057.641 bytes de um MP4; uma atualização NTFS pode ter sido agendada e pode ser adiada. Não houve baseline por arquivo antes/depois, logo não se pode certificar que o último acesso permaneceu intacto. Nenhuma operação de escrita foi solicitada e nenhum timestamp foi restaurado; nenhum novo acesso ao D: ocorreu após essa constatação. Eu deveria ter consultado a política antes do teste. [Microsoft GetFileTime](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfiletime) e [fsutil behavior](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/fsutil-behavior).

## Correção estrutural T2/T4 — ledger de regressão

Este ledger sucede os resultados de ordenação anteriores **na variante automatizada com fixtures**. T2/T4 do HD real não foram repetidos; seu PARTIAL histórico, a questão LastAccessTime e as limitações audiovisuais não são convertidos em PASS. P1/P2/P3 permanecem aprovadas. Evidência persistente: [JSON sanitizado com hashes de código e timings](fase-f0-evidencias-estruturais.json).

Windows final: branch `feature/remote-player-lan-integration-2`, HEAD `bc3d37de09462485caa9ff027341eeabdd4b88cb`, fingerprint `e8b7410e8a9602e67cf6700e68155df08c90947f713bb1f400e71401d30f4e8e`. Runner oficial, checkout NTFS novo, Node Windows 24.11.0, Electron 45, perfis/SQLite/MP4 descartáveis em C:. Não é app instalado. Todos os registros posteriores ao runner são documentais/evidência; os hashes do JSON permitem conferir o código/testes atuais.

| IDs / lote corretivo | Cenário e teste observável | Oráculo e resultado |
|---|---|---|
| INS-02, E01/E03, LIB-02 / 05 | `main-media-runtime.test.ts`: índice válido/ausente e barreira real de readdir | Nenhum readdir antes do gate; UI lógica ready enquanto scan aguarda; prontidão duplicada admite um scan; shutdown invalida admissão/callback tardio. PASS Linux/Windows |
| REC-01/03, E06/E07 / 02/05 | Runtime real + recovery pausado/playing/pending/uncertain com ACK clear retido | Antes de contenção: Sequence bloqueada, admissão false, sonda sem FS. Depois: evidência dismissed durável e admissão única. Falta de contenção mantém paused original e bloqueio. PASS Linux/Windows |
| REC-01/03, E01/E06/E07 / 02/05/07 | `f0-bootstrap-electron.ts` → `f0-production-bootstrap-entry.ts` → package Main real: ready, cached-ready, host-failed, close-before-ready, persistence-failure | Host Chromium real alcança barreira; janela visível e IPC refresh bloqueado; zero enumeração. Release permite gate; rejeição/falha de escrita alcança APP_INITIALIZATION_FAILED sem gate; fechar com prontidão nunca liberada encerra processo. PASS Linux/Windows |
| REC-01/02, E01/E06/E07 / 02/05/07 | Mesmo executor: Main real com paused, playing, pending, uncertain e JSON inválido; dois startups por caso | Sem autoplay/fila inferida; resolução durável; segunda execução restaura índice; zero enumeração no gate. Espera scan inicial confirmado antes de fechar para preparar o índice, sem sleep. PASS Linux/Windows |
| PLAY-01/02/04, BUF-01, E05/E08 / 03/07 | `player-media-protocol.test.ts`: open físico com barreira × revoke/abort/dispose; abertura falhando após revoke | Resposta não autorizada, sem corpo; handle tardio fecha (stat rejeita com closed/EBADF); grant antigo não é reutilizável após revoke. PASS 10/10 incluindo testes existentes |
| BUF-01, PLAY-04 / 03/07 | Resposta de arquivo real mantida ativa × revoke/abort/dispose | Stream/handle fecham por evento close sem shutdown; Origin inseguro rejeitado; GET/HEAD/ranges/cancelamento continuam cobertos. PASS Linux/Windows |
| PLAY-02/05, BUF-02, E05/E09 / 03/05/07 | `f0-production-validation.ts` executado pelo Main real: readdir pendente, playback real, liberar syscall pendente durante playback | currentTime chega a pelo menos 2 s; scan continua suspenso, yield > 0 e zero lstat por entrada; pause/resume; Stop→idle; scan retoma. PASS Linux/Windows |
| PLAY-02/04, BUF-01, E08/E09 / 03/07 | Mesmo E2E: Stop com app aberto, nova tentativa, playing/pause/EOF e ACK da antiga | Grants e streams ativos zero após Stop; handles abertos=fechados; tentativa nova distinta; drenar filas reais de playback e arbiter antes da assertion; estado permanece playing da nova tentativa. PASS Linux/Windows |
| LIB-05/06, AV-01/02 / 05/06 | 25 testes `video-library.test.ts` (23 anteriores + 2 regressões determinísticas) + 9 store; root/configurationEpoch, scans/resultados atrasados, reconfiguração, disponibilidade | Geração antiga não publica, falha temporária preserva inventário, reconciliação respeita prioridade e novo fingerprint. PASS Linux/Windows; USB físico NOT RUN |
| PLAY-02 / 03/07 | `chromium-playback-host.test.ts` e `player-playback.test.ts` | Ready ausente/deadline e ready tardio, fechamento antes de ready, ACK antigo, hostEpoch/attempt/sequence obsoletos e pausa/playing fora de ordem permanecem protegidos. PASS Linux/Windows |
| DATA-01 / 07 | `main-management-host.test.ts`, `manual-playback.test.ts`, catálogo e suites de serviço | SQLite real temporário, autoridade Gestão, fila/manual e contratos compartilhados preservados. Host Gestão 7/7 e ManualPlayback 43/43 também no runner Windows. Campanha Combined completa não repetida |

Foram acrescentados **17 casos unitários** nesta correção (8 runtime, 7 protocolo, 2 biblioteca) e **11 cenários E2E Main**: um de playback concorrente, cinco de barreira/falha bootstrap e cinco de estados antigos de recovery. O wrapper de bootstrap injeta retenção/rejeição e erro de persistência antes de carregar o Main real; o cenário de playback usa diretamente o package Main com observação instalada depois do bootstrap. Nenhum evento playing sintético substitui mídia real; somente eventos deliberadamente antigos são injetados para testar rejeição.

### Execuções e limites

- Compile WSL/Windows: PASS. Testes focados Linux de runtime, biblioteca/store, protocolo, playback/host/recovery, Sequence/runtime/IPC, Gestão/SQLite, ManualPlayback e catálogo: PASS. Runtime final 14/14; protocolo 10/10; testes do runner 37/37.
- Regressão completa do E2E Standalone de produção Linux: PASS (`/tmp/kq-f0-production-regression-final-guards.log`), incluindo fila/prioridade/pausa/countdown/celebração/recovery/shutdown. Código funcional igual ao snapshot final; alterações de harness posteriores fortaleceram métricas e casos focados.
- Main Linux final: PASS em `/tmp/kq-f0-structural-electron-final-guards.log` e `/tmp/kq-f0-bootstrap-electron-final-guards.log`. Startup anterior de duas execuções com paused sem autoplay também PASS. Primeira tentativa Electron dentro do sandbox do executor não iniciou; execução autorizada fora dele passou com sandbox Chromium habilitado. Nenhum timeout foi ampliado.
- Runner `npm run test:e2e:standalone-production:windows -- --approve-untracked`, com `KQ_F0_STRUCTURAL_ONLY=1`, fixture interna e variáveis encaminhadas por WSLENV: **PASS**, 313 testes unitários em 13 suítes + 11 cenários Main; cleanup/processos PASS. Log final `/tmp/kq-f0-structural-windows-final-guards.log`.
- Antes: sem a verificação pós-open (controle de mutação no build descartável, mantendo outras proteções), três regressões de revogação/abort/dispose falharam; 7/10 passaram. Build corrigido: 10/10. Esse controle não é atribuído a uma execução integral do código histórico. Log `/tmp/kq-f0-protocol-before.log`.
- FAILs intermediários preservados: checkout antigo com branch divergente (não alterado); primeiro runner encontrou 9 falhas de cleanup dos unitários por repositórios SQLite de teste sem close. Corrigida a posse no harness, sem sleep/retry/permissões/alteração da camada operacional. Observador de submit no Renderer não via keydown consumido; agora mede pré-despacho e marca keydown real NOT_MEASURED. Instantes Main diretos continuam distintos de timeupdate.
- NOT RUN nesta correção: HD real, T3, app instalado/novo pacote, A/V físico, benchmark 9k ou cache frio. Candidato antigo não contém estas correções. Baseline USB anterior não foi repetido nem usado como prova do código novo. Qualidade perceptível e segurança física continuam humanas.

### Complemento da segunda revisão — scan × tentativa/publicação

Dois testes novos `video-library.test.ts` reproduziram defeitos reais antes de corrigi-los: waiter de idle retomava root I/O quando playback já estava ativo novamente; último candidato privado publicava revisão nova durante playback. Resultado anterior: 23/25 PASS, 2 FAIL (`/tmp/kq-f0-library-races-before.log`). Permit em loop, proteção após readdir e antes de publicar: **25/25 PASS** Linux/Windows. Mapear a LIB-05/06, PLAY-02 e E03, responsáveis 05/07. Geração publicada anterior fica mantida até idle, epochs/dispose são verificados novamente após esperar. Syscall/trabalho já admitido não é preemptado; reprodução contínua pode adiar a reconciliação.

O runner final também executou quatro E2Es de biblioteca existentes, com Main real: Player/restart/disponibilidade, Combined com SQLite único, Controller legado→Combined e preservação de SQLite/configuração inválida. Todos PASS. A campanha completa da Gestão fora dessas regressões não foi repetida. No total final: 313 unitários/13 suítes, 11 cenários Main estruturais/recovery/playback e esses quatro cenários de biblioteca. Os últimos logs e hashes são os do JSON de evidências, prevalecendo sobre snapshots intermediários deste trabalho.


## T3 — matriz da infraestrutura manual e da regressão sintética

Complemento F0-06/07, sem substituir resultados históricos. [Operação física](fase-f0-t3-operacao.md), [resultados/fingerprint/hashes](fase-f0-t3-evidencias.json). T3 físico não integra o primeiro PASS automatizado de E02/AV; os cenários lógicos abaixo são cobertura E de regressão, não homologação USB.

| ID / vínculo canônico | Responsável / primeiro PASS / regressão | Ambiente e implementação | Oráculo PASS / FAIL | NOT RUN / gate |
| --- | --- | --- | --- | --- |
| T3-INF-01 / DATA-01 | infraestrutura T3, 07; repetir ao mudar runner | `usb-reconnect.test.cjs`: preflight mockado; Linux/Windows | Política antes de pasta; USB/NTFS online + identidade + proteção exigidos; bloquear gravável/ambíguo antes de start. Falha se tocar root primeiro | Consulta real proibida nesta criação; preflight físico só sob solicitação |
| T3-INF-02 / E02 | infraestrutura T3, 07; regressão de CLI | mesmo teste, subprocesso e parser PowerShell | CI/non-TTY/sem autorização recusados; runner comum nunca seleciona físico; entry exige nonce/perfil de sessão. Parser sem erro | Parser SKIP no Linux; Windows executado. Fluxo de console com pessoa NOT RUN |
| T3-INF-03 / AV-01/02 | infraestrutura T3, 07; mudança de identidade | provider nativo com executor fake | Volume incorreto FAIL; mesmo volume/letra diferente BLOCKED, identidade não depende só da letra | DeviceId real e remoção física NOT RUN |
| T3-INF-04 / PLAY-04, DATA-01 | infraestrutura T3, 07; regressão | controller com fixtures | Zero mídia/scans/I/O antes de prompt; cancelamento em cada checkpoint, ausência de confirmação, timeout e remoção não feita não passam | Nenhum hardware necessário; falha executada é FAIL, não NOT RUN |
| T3-INF-05 / DATA-01 | infraestrutura T3, 07; regressão | filesystem interno real, marker e links | Evidências incrementais sobrevivem falha/retomada; cleanup recusa perfil errado/link/ativo; metadados/processos vazios não equivalem a sucesso | Sem precondição externa; suite obrigatória disponível |
| T3-SYN-01 / LIB-02/04, REC-01, E01/E02/E06 | 06/07; primeiro PASS infraestrutura T3; integração final | `usb-reconnect-synthetic-electron.ts`, Main de produção importado, SQLite/IPC/UI reais | A/B lógicos: cache/configuração persistem após ausência/restart; idle seguro, zero readdir no gate, scan posterior, cache restaurado. Qualquer perda/autoplay/scan antecipado FAIL | Linux/Windows viáveis: PASS ambos; não exige USB |
| T3-SYN-02 / AV-01/02/03, LIB-06 | 06/07; integração final | mesmo E2E, diretório temporário renomeado, monitor real | Indisponível→ready Main/UI, dois ciclos, probes duplicados não duplicam scan; resposta antiga por barreira não desfaz estado novo | Sem USB; não aceitar evento Renderer injetado como prova |
| T3-SYN-03 / PLAY-01/04, BUF-01, E05/E09 | 03/06/07; integração final | mesmo E2E, WebM/VP8 gerado localmente | Playback restaurado: Main playing + currentTime >=0,25 + protocolo bytes/opens; Stop→idle, grants/streams zero, handles fechados com app aberto | Não é prova de MP4/áudio/USB; variantes físicas continuam NOT RUN |
| T3-PHY-B / E02, LIB-04, AV-02 | 07; primeiro PASS após campanha física | runner manual, Windows USB protegido, pessoa | Saída processos→remoção segura confirmada→ausência nativa→mesmo volume→restart/cache/gate/scan/seleção real. Todos oráculos necessários | **NOT RUN nesta entrega**; segurança pode BLOCKED, cancelamento PARTIAL. Autorização explícita/proteção/supervisão obrigatórias |
| T3-PHY-A / AV-01/02, E02 | 07; primeiro PASS após campanha física | runner manual com quiescência instrumentada | Sem recursos antes da remoção segura; ausência/retorno nativos e Main/UI, índice preservado, scan único, sem estado fantasma | **NOT RUN**; Windows recusando remoção implica BLOCKED. Não testar retirada durante playback |

52 testes novos de infraestrutura (51 PASS/1 SKIP Linux; 52 PASS Windows), mais um executor E2E com cenários e subassertions acima. O E2E sintético foi integrado a `test:e2e:linux`, seletores Windows padrão/`--video-library`; unitários a `test:unit`. Workflows existentes já consomem esses scripts e não foram alterados. Comandos focados e critérios de execução física estão no procedimento. Não exigir T3-PHY como PASS de suite CI. Nenhuma assertion física é satisfeita por mocks.

## F0-08 — matriz de resiliência da sessão

Lote responsável/primeiro PASS: **F0-08**, integração posterior repete estes grupos; não retroage critérios de F0-01–07. Contrato no [documento F0-08](fase-f0-08-resiliencia.md), [ledger de resultados/hashes](fase-f0-08-evidencias.json). SU = testes determinísticos `standalone-player-sequence.test.ts`; PB = `player-playback.test.ts`; PR = `player-media-protocol.test.ts`; BI = `video-library.test.ts`; ME = `storage-resilience-electron.ts` com Main/IPC/Preload/Renderer reais; T3S = `usb-reconnect-synthetic-electron.ts`. Todos existem; os testes novos somam **32 unitários** (24 SU, 7 PB, 1 PR) e um executor E2E integrado com vários oráculos. Não usar testes futuros como gate anterior.

| Caso / vínculo | Cenário e oráculo observável | Cobertura executada / ambiente |
| --- | --- | --- |
| S01 / AV-01 | Idle: seleção ausente rejeitada, índice/configuração preservados, nenhum current/attempt fantasma | SU idle + T3S Main/UI/fs real Linux/Windows |
| S02 / PLAY-01 | Playing: falha contém tentativa, preserva entryId e pending, nenhum Next/EOF por erro | SU media failure + ME erro real de recurso Chromium Linux/Windows |
| S03 / BUF-02 | Raiz ausente mas currentTime ainda avança: não enviar Stop | SU root loss, PB buffer-advancing + ME progresso real após rename temporário |
| S04 / BUF-02 | Waiting inicial não é falha nem EOF; sem watchdog antes de playing | PB initial-waiting Linux/Windows |
| S05 / BUF-02 | Stalled com 15 s sem progresso confirmado pelo relógio: failed contido, grants zero, sem EOF; playing duplicado não adia prazo | PB stalled/duplicate-playing, relógio controlado Linux/Windows |
| S06 / BUF-01 | EIO após primeiro chunk real: leitura rejeita erro, não EOF; stream fecha, handle stat dá closed/EBADF; grant revogado não é reutilizado | PR stream EIO com filesystem real Linux/Windows. Não atribuir essa injeção ao ME |
| S07 / PLAY-02 | Paused: intenção/música preservadas; Stop/clear e ausência de resume automático | SU paused loss e failure paused; PB paused, Linux/Windows |
| S08 / REC-01 | Countdown: tempo restante congelado, timer velho inócuo; só comando explícito rearma restante | SU fake scheduler, Linux/Windows |
| S09 / PLAY-03 | Loading: perda invalida geração; conclusão/ACK antigo não inicia tentativa; alvo continua pendente | SU loading com barreira + PR revogação/open tardio preexistente, Linux/Windows |
| S10 / PLAY-03 | Next/transição interrompida: head e prioridade mantidos; sem consumir outro item | SU next com barreira e missing next, Linux/Windows |
| S11 / REC-01 | Celebração: EOF já confirmado continua válido; timer encerra uma vez; próxima ausente não é descartada | SU celebration + missing priority next, Linux/Windows |
| S12 / AV-02 | Reconexão rápida não é autoplay nem duplicação de recovery | SU intermitência e T3S ciclos reais de fixture, Linux/Windows |
| S13 / AV-02 | Retorno após longa ausência não dispara timers antigos, preserva pending | SU scheduler avançado 60/90 s sem dormir; T3S Main/UI, Linux/Windows |
| S14 / AV-03 | Dez alterações repetidas não mudam entry/pending nem criam starts; probes concorrentes não duplicam scans | SU intermitência + T3S dup probes e BI coalescência, Linux/Windows |
| S15 / LIB-04 | Arquivo ainda ausente após retorno: revalidação falha, continua bloqueado e mantém fila | SU failed revalidation MEDIA_UNAVAILABLE + PB/BI disponibilidade física, Linux/Windows |
| S16 / LIB-04 | Arquivo substituído/reindexado: identidade anterior rejeitada antes de grant/load | PB replaced file com filesystem real + SU MEDIA_CHANGED, Linux/Windows |
| S17 / PLAY-04 | Encerrar somente atual: mantém pending/order, sem iniciar próximo | SU discard scope + ME botão pelo teclado e Main pending, Linux/Windows |
| S18 / PLAY-04 | Ctrl+Espaço durante recuperação exige confirmação distinta; só confirmação Stop All limpa tudo | SU stop-all/race + ME confirmação real no Renderer/Main, Linux/Windows |
| S19 / REC-01 | Shutdown com modal aberto e callback de validação tardio: sem countdown/ready após fechamento; novo processo P1 idle sem autoplay | SU shutdown + validation-after-close; ME close/restart mesmo perfil, Linux/Windows |
| S20 / PLAY-02 | ACK/evento/EOF antigo não modifica nova tentativa/ocorrência | SU old EOF + PB/host/recovery regressões; ME nova attemptId e mesma entryId, Linux/Windows (host unitário adicional Linux) |
| S21 / LIB-05 | Scan respeita prioridade de playback, não publica geração obsoleta; stream ativo não é destruído para acelerar scan | BI 25 testes com filesystem/barreiras/permit, Linux/Windows. E2E estrutural anterior é histórico; ME novo não alega disputa física de I/O |
| S22 / PLAY-03 | Normal FIFO/prioridade conservam ordem e IDs durante falha e recuperação | SU normal/priority, ME duas filas preservadas antes/depois, Linux/Windows |
| S23 / PLAY-01 | Só operador recupera; revalidação válida + countdown → nova attemptId, mesma entryId, currentTime real | SU retry + ME Enter no botão e tempo >=0,5 s, Linux/Windows |
| S24 / LIB-04, DATA-01 | Revalidação/clear/persistência falhando não libera sucesso nem descarta fila; uncertain sem contenção desabilita mutação | SU failed validations, unconfirmed containment, uncertainty explicit resolution e três falhas de persistência; recovery/PR existentes, Linux/Windows |
| S25 / AV-01 | Ausência permanente permanece protegida, sem retry infinito/autoplay ou perda da fila | SU unavailable retry e clock 90 s; T3S índice preservado, Linux/Windows |

PASS exige os oráculos descritos e evidência do ambiente indicado. FAIL inclui resultado executado incorreto, perda/mudança de fila, EOF falso, grant/handle residual, comandos antes de contenção ou persistência falha tratada como sucesso. NOT RUN deve trazer motivo específico; não equivale a PASS nem a comportamento ausente. Variantes **USB físico, MP4 do acervo, áudio/tela física, desempenho 9k e pacote instalado: NOT RUN**, proibidos nesta tarefa ou dependentes de homologação. Não misturar clocks nem atribuir WebM a MP4/USB. Não existe assertion de retomada por posição: alternativa aprovada implementada informa limitação e reinicia do início explicitamente.

### Execução final F0-08

- Compile Linux/Windows PASS (exit 0). SU **100/100**, PB **35/35**, PR **11/11**; runner unitário **37/37**. Mais 12 suítes focadas Linux (runtime, IPC, UI/interaction/options, biblioteca/store, recovery/host, ManualPlayback e Gestão/SQLite) PASS.
- Main Linux: ME novo PASS, com modal único, botão informativo oculto em recuperação, foco/Tab/Shift+Tab/Enter, 1280×800 e 640×480, descarte parcial, Stop com app aberto, shutdown com modal e restart P1. Dez cenários bootstrap Main existentes PASS com fixture MP4 **vazia só para inventário, sem playback**; primeira invocação sem fixture falhou no pré-requisito, não ocultada.
- Windows oficial `npm run test:e2e:storage-resilience:windows -- --approve-untracked`: **360 unitários/10 suítes + quatro E2Es biblioteca + T3S + ME novo PASS**. Código atual validado no fingerprint `f457a17b41aa84b2c2e6e58c730a4b1a7a87483be509301934e103ab2c29621d`. Cleanup/perfis/processos PASS. T3S também repetido no Linux final: PASS. Workflows não alterados nem disparados; só modalidade sintética integrada aos runners.
- Capturas reais foram examinadas; corrigidos duplicação de ID, stacking com saída e CSS hidden do botão informativo. O novo modal foi autorizado sem Doop; isso não constitui homologação visual do proprietário. Nenhum outro layout aprovado foi redesenhado.
- Não repetida a campanha histórica completa com MP4 de produção: nova prova é Main/Electron real com WebM gerado, mais regressões focadas/boot/filas/timers e Windows acima. A/V perceptível, física e app instalado permanecem externos. Logs, falhas intermediárias e hashes preservados no ledger; nenhuma falha foi transformada em PASS por aumento de timeout.

## Campanha USB unificada — cobertura do runner e regressões

Contrato operacional no [adendo T3 + F0-08](fase-f0-t3-operacao.md#campanha-unificada-t3--f0-08--testekaraoke); [ledger do snapshot final](fase-f0-usb-campanha-evidencias.json). Teste físico **NOT RUN**: nenhuma consulta/acesso a F: ou D:. Responsabilidade deste complemento: infraestrutura T3/F0-08; primeiro PASS é dos testes sintéticos abaixo, não do hardware. Não acrescenta gate retroativo aos lotes F0-01–07.

`USB-CAM` = `scripts/usb-campaign.test.cjs` (62 casos); `T3-U` = 52 testes existentes `usb-reconnect.test.cjs`; `CAM-E` = novo `usb-campaign-electron.ts`, Main/IPC/Renderer e mídia gerada reais; `F008-E` = `storage-resilience-electron.ts`; `SU/PB/PR/BI` mantêm os significados da matriz F0-08. Mocks de volume e consentimento não são prova de preflight físico.

| Nº requerido | Verificação/oráculo | Cobertura existente executada |
| --- | --- | --- |
| 1 | Oito cenários em ordem, cada resultado independente, physical=false no sintético | USB-CAM campanha completa mockada; CAM-E integração real playing/paused |
| 2 | Seleção individual só executa ID escolhido, B não dispara playback incidental | USB-CAM IDs individuais e startup-only B |
| 3 | Cancelar em start/risco/remove/reconnect/recuperação salva resultado e fecha app | USB-CAM cinco checkpoints + T3-U |
| 4 | Pular não vira PASS nem inicia operação física | USB-CAM skip em cinco checkpoints |
| 5 | Repetir cria adapter/perfil novo e outro resumo, sem perder resultado anterior | USB-CAM repeat/history e journal múltiplo |
| 6 | Confirmação ausente/ação não realizada não libera passo seguinte | USB-CAM noConfirm/noRemoval + T3-U |
| 7 | Volume ausente bloqueia antes de leitura da pasta | USB-CAM preflight/ausência, provider mockado |
| 8 | Nome/USB/raiz incorretos não passam, inclusive outra unidade no F: | USB-CAM scope/preflight e Native provider target-only |
| 9 | ID diferente após retorno encerra campanha; nova letra só com mesmo ID e binding explícito | USB-CAM wrongReturn/letter-change; D: não é consultada pelo provider novo |
| 10 | Consentimento descartável ausente bloqueia, mesmo se houver histórico de sessão | USB-CAM consent vazio; consentimentos são variáveis locais do worker, não restaurados |
| 11 | Protegido sem IsReadOnly/attestation bloqueia | USB-CAM protected/preflight + T3-U |
| 12 | Descartável autorizado aceita gravável sem afirmar write protection | USB-CAM writable/explicit consent e CAM-E mocks identificados |
| 13 | D:/UNC/root diferente recusados antes do executor nativo | USB-CAM scope/path/target helper; nenhuma consulta real feita |
| 14 | App/processo ainda ativo impede prompt seguro B/A | USB-CAM resources/processes e T3-U quiescent-before-prompt |
| 15 | Handle/stream/scan pendente não é recurso liberado | USB-CAM resources e T3-U guardas; CAM-E e F008-E medem recursos reais |
| 16 | Shutdown/cleanup falho bloqueia avanço; exit já observado não espera evento perdido | USB-CAM cleanup-failure/already-exited-process; runner Windows residual-process-check |
| 17 | Sem avanço de currentTime não há PASS de playback/buffer | USB-CAM frozen/buffer oracles; CAM-E requer avanço real; PB watchdog |
| 18 | Modal ausente quando recuperação é alegada gera FAIL | USB-CAM noModal; CAM-E/F008-E DOM + Main reais |
| 19 | Mudança indevida de ordem/ID/prioridade gera FAIL | USB-CAM badQueue; CAM-E compara IDs/ordem com Main, SU filas |
| 20 | Tentativa antiga não satisfaz retomada; eventos/ACKs obsoletos preservam nova tentativa | USB-CAM lateAttempt; CAM-E nova attemptId e mesma entryId; SU/PB/PR preexistentes |
| 21 | Erro ainda executa cleanup e preserva causa, cleanup incerto é fatal | USB-CAM failure/cleanup; E2Es finally + Native residual check |
| 22 | JSONL/resumos sobrevivem interrupção e não são sobrescritos | USB-CAM journal repeat + T3-U progressive failure evidence |
| 23 | Retomada mantém histórico, rejeita caminhos operacionais/externos e não adota tentativa velha | USB-CAM resume/state validation; worker novo perfil por tentativa |
| 24 | Sem terminal interativo não começa físico | T3-U assertInteractive, mesmo entry point do alias novo |
| 25 | CI bloqueia comando físico antes do preflight | USB-CAM subprocesso com --campaign/CI + T3-U; seletores incluem só sintéticos |

Todos os unitários novos passaram Linux/Windows: **61 PASS + 1 SKIP no Linux** (parser PowerShell); **62 PASS no Windows**, incluindo parse sintático de consulta target-only e launcher sem executar comandos de dispositivo. T3-U Linux 51 PASS/1 SKIP e Windows 52 PASS; testes do runner oficial 37/37 Linux. Compile Linux/Windows PASS. Regressões de domínio Linux: seis suítes (Sequence, playback, protocolo, runtime, recovery e biblioteca) PASS.

Runner oficial final: **422 unitários/11 suítes + quatro E2Es biblioteca, T3 sintético, F0-08 e novo CAM-E PASS**. Fingerprint `7fec73f066441684457b5b9dcd261baeb5de93ccbcce1fb7a59fcffebcfe8d44`; código/testes/scripts com hashes no ledger. Windows efetivo, Node v24.11.0, Electron 45.0.0 e Playwright 1.64.1, checkout NTFS e perfis descartáveis internos; sem processos residuais. As antigas campanhas/valores continuam históricos, não substituídos.

### Correção do harness F0-08 encontrada nesta regressão

A execução `/tmp/usb-campaign-f008-regression.log` falhou `DISCARD_NOT_CONFIRMED`. Seu último snapshot mostrou Main idle/fila esgotada por conclusão natural, em vez do estado esperado de descarte atual com pending; ela não registrava o comando efetivamente recebido. Um controle determinístico reteve o frame de autofocus do modal, reproduziu a sequência antiga de foco/Enter e confirmou no Main `recover-storage` em vez de `discard-interrupted`. Isso comprova a corrida permitida pelo harness antigo; não atribui falha de dados ao produto ou ao HD.

Correção **somente no teste**: esperar modal visível/habilitado e ciclo de autofocus do Renderer por barreira de animation frame, enviar Enter ao botão específico e exigir que o Main tenha recebido `discard-interrupted`. Não há sleep, aumento de timeout ou assertion removida. Controle antigo `/tmp/usb-campaign-focus-control.log` PASS (caracterização negativa), E2E corrigido `/tmp/usb-campaign-f008-validated.log` e Windows final PASS. O modo de controle é exclusivamente sintético e não entra na campanha física.

### Gates remanescentes

Aprovação física não está comprovada. Fluxo humano/console completo e metadados reais do testekaraoke continuam NOT RUN por proibição desta tarefa; áudio, MP4 do pendrive, estabilidade do hardware e desempenho frio são externos. PASS exige oráculos e ambiente indicados; falha executada é FAIL; janela física perdida/branch de recuperação não observado é PARTIAL/NOT REPRODUCED; segurança/identidade/cleanup incertos são BLOCKED; skip é NOT RUN. Não avançar de FAIL funcional sem avaliação. T3 físico não entra em CI, workflows não foram alterados/disparados e os runners não dependem de F:/D:.


## Integração F0 no CI existente — 2026-11-11

Inventário, seletores, exclusões manuais, correções de expectativas antigas e evidências locais no [registro de cobertura CI](fase-f0-ci.md). Workflows PR/release preservados; GitHub remoto NOT RUN, sem dispatch/commit/push. F0 continua sem homologação.


### Evidência física posterior B — pré-commit

O [adendo do relatório](fase-f0-relatorio.md#evidência-física-posterior-e-auditoria-pré-commit) registra T3-B físico PASS na sessão `6a06b09e-a39b-4090-812e-c16d83870628`, com 37 arquivos e startup usando cache após ausência/retorno nativos. O wrapper terminou PARTIAL por resposta final inválida, sem desfazer B PASS. Essa evidência não corresponde à campanha física posterior cujo countdown foi relatado como FAIL; os logs dela ainda não foram revisados. Nenhum resultado físico é inferido dos testes sintéticos.
