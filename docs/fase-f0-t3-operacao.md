# F0 — T3 físico interativo: procedimento operacional

> **Procedimento vigente ampliado:** a campanha unificada T3 + F0-08 para `testekaraoke` está no adendo ao final. A autorização de mídia descartável é específica desse dispositivo e exige os consentimentos descritos; não representa proteção contra escrita. As regras estritas abaixo continuam válidas para o modo protegido/runner legado. A execução física permanece NOT RUN e exige solicitação posterior.

Status: infraestrutura implementada e validada com fixtures Linux/Windows. **T3 físico NOT RUN; F0 não homologada.** Não executar por iniciativa do agente. Exige solicitação explícita do proprietário e supervisão durante toda intervenção física. P1/P2/P3 permanecem aprovadas.

## Modalidades e comandos

O runner físico é um harness instrumentado que importa o `package.json.main` real, usa Preload/IPC e host Chromium reais. Não é o aplicativo instalado nem substitui o launcher manual oficial do produto. O checkout privado NTFS reutiliza snapshot, bundle, hashes, sincronização, build e lock do runner oficial; não modifica o checkout operacional, manifesto global ou AppData do proprietário. No Main não empacotado, os gates de instalação empacotada não são adquiridos; o userData explícito isola o lock do perfil. Nenhum guard de instalação é desabilitado.

No terminal WSL interativo, a partir do checkout autorizado, após revisar branch/HEAD/diff/untracked:

```bash
npm run test:manual:usb-reconnect -- --authorize-physical-test --scenario B
```

B é prioritário: reconexão **entre execuções**. Para A (app aberto), autorizar e usar `--scenario A`; `--scenario both` executa B→A. Não iniciar A implicitamente se a autorização cobrir só B. O runner lista arquivos novos e solicita `SYNC`; `--approve-untracked` só após revisão efetiva da lista. Exige a frase `AUTORIZO T3 FISICO`. Abre console PowerShell separado, mantendo Node/Electron/dependências nativos Windows. Sem interop, terminal interativo ou Windows disponível, não executa a campanha. CI é recusado.

Testes sintéticos, sem volume USB:

```bash
npm run test:unit:usb-reconnect
npm run test:e2e:usb-reconnect:headless
npm run test:e2e:usb-reconnect:windows -- --approve-untracked
```

O último usa o runner oficial com seletor `--video-library`; configure checkout NTFS/WSLENV conforme [procedimento Windows](windows-native-testing.md). Só `usb-reconnect-synthetic-electron` foi integrado aos runners Linux/Windows e, por consequência, aos workflows existentes. Nenhum workflow foi alterado ou disparado. O comando físico não pertence a npm test, CI ou runner Windows padrão.

## Preflight obrigatório e impedimentos

Antes de informar a pasta, confirmar `PROTECAO VERIFICADA`: a proteção contra escrita deve ter sido validada **externamente** pelo proprietário. O runner não instala nem ativa proteção. O destino de sessão é `%TEMP%\KQ-T3-<UUID>` no disco interno de sistema, sem reparse points; perfis, checkout, caches e relatórios ficam ali. Não usar TEMP em unidade externa. Não escolher AppData/perfil operacional.

Antes de lstat, abrir ou enumerar a biblioteca, o runner consulta exclusivamente a política global de timestamps (`fsutil behavior query disablelastaccess`) e metadados de volume/partição/disco (`Get-Volume`, `Get-Partition`, `Get-Disk`). Se a consulta falhar ou for ambígua, bloqueia. Exige NTFS, USB, disco online, identidade estável verificável e `IsReadOnly=true`, além da confirmação externa. Os valores 0/2 permitem atualização de LastAccess; 1/3 não bastam para garantir ausência de outras escritas do filesystem. Portanto **nenhum valor da política dispensa proteção contra escrita**. Não há opção de ignorar o bloqueio.

`IsReadOnly` é uma verificação necessária, não certificação independente de um bloqueador físico. Se o proprietário não puder assegurar proteção efetiva do meio e preservação de metadados, **NO-GO antes de acessar o acervo**. Opções: preparar externamente meio protegido validado ou biblioteca de ensaio autorizada; mudança no nível de preservação exige decisão explícita fora deste runner. Não alterar política, atributos, ACLs ou timestamps, nem tentar restaurá-los. Nunca executar chkdsk, ejeção ou desmontagem por software neste teste. [Microsoft: LastAccess e timestamps](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfiletime), [fsutil behavior](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/fsutil-behavior).

A identidade é SHA-256 com salt privado da sessão sobre GUID do volume, UniqueId/serial do disco e offset da partição. O relatório não publica valores brutos. Pasta existente/letra não provam identidade. Outro volume resulta FAIL. Mesmo volume com letra diferente resulta BLOCKED: a F0 não implementa remapeamento automático. Apenas metadados nativos são consultados até identidade/proteção serem confirmadas; o caminho autorizado recusa junctions/symlinks.

## Cenário B — entre execuções

1. Preparar índice no perfil privado; uma indexação inicial é necessária se não existir. A UI/gate devem anteceder o primeiro readdir. Aguardar ready e idle reais, hash do índice/configuração internos e quiescência.
2. Encerrar normalmente pelo fluxo de confirmação. Confirmar saída efetiva e ausência de processos do checkout/perfil antes da mensagem de remoção.
3. Quando solicitado, o proprietário usa **Remover hardware com segurança** no Windows. Só desconectar fisicamente depois de autorização do Windows. Se impedir a remoção, responder `BLOQUEADO`, sem forçar o cabo.
4. Responder `CONFIRMO`. O runner verifica ausência real do volume e preservação do índice/configuração. Confirmação humana sozinha não basta.
5. Reconectar fisicamente o mesmo dispositivo, aguardar reconhecimento do Windows e responder `CONFIRMO`. Revalidar política, proteção, identidade e caminho antes de abrir novamente.
6. Reabrir com o mesmo perfil/cache: exigir cache restaurado, contagem preservada, idle seguro sem autoplay, zero enumeração antes do gate e reconciliação posterior. Submeter um código único sem publicar código/nome; exigir Main playing, currentTime real >=0,25 s, bytes/opens no protocolo, Stop confirmado e recursos liberados.
7. Salvar resumo e encerrar normalmente. Não declarar qualidade perceptível de áudio/vídeo a partir desses sinais.

## Cenário A — app aberto

O harness suspende novas sondas/refresh/comandos e aguarda trabalhos já admitidos terminarem. Só permite a intervenção quando Main/Sequence/engine estão idle, sem fila pendente, scans, I/O, handles, streams ou grants ativos. Depois congela novas operações no caminho da mídia; qualquer acesso indevido é violação, nunca PASS. Isso é **quiescência de teste**, não uma funcionalidade visual do produto nem prova de remoção segura espontânea no app sem instrumentação.

Remoção segura e confirmações seguem as mesmas regras de B. Após ausência nativa confirmada, o harness libera descoberta normal: observa Main e texto existente de Configurações indicando indisponibilidade; índice/configuração devem continuar intactos. Suspende I/O novamente para o checkpoint de reconexão. Após confirmar identidade/proteção, libera o monitor real e exige ready no Main/UI, epochs atuais e exatamente um scan adicional de reconexão. Não injeta eventos Renderer para simular USB.

O Windows pode recusar remoção por recursos de outros processos, cache ou driver, mesmo com os recursos medidos do app zerados: **BLOCKED/NOT RUN**, não contornar. Não desconectar durante playback. O teste não certifica todos os handles de kernel/terceiros.

## Checkpoints, cancelamento e retomada

Cada checkpoint aceita `CONFIRMO`, `CANCELAR` ou `BLOQUEADO`; revisa recursos antes e depois da confirmação e verifica o estado nativo. Ausência de confirmação não avança. `CANCELAR`/Ctrl+C solicita encerramento normal e preserva evidência parcial. Se o encerramento não for confirmado, registra BLOCKED; não mata processos nem libera recursos por inferência de timeout. Não fazer nova remoção se existir processo/cleanup pendente.

Prazo humano: dez minutos; observação de disponibilidade: até 60 s, cobrindo sondas foreground de 5 s e background de 30 s. O foco efetivo é registrado. O relógio de detecção começa na retomada da descoberta, **não mede a latência física da retirada do cabo**. Polling de observação não força sondas. Watchdogs de startup/reconciliação (180 s), confirmação operacional/mídia e drenagem (30 s) encerram com falha/bloqueio; tempo decorrido nunca significa sucesso.

Para retomar, com processos anteriores encerrados e o mesmo código/HEAD/branch:

```bash
npm run test:manual:usb-reconnect -- --authorize-physical-test --scenario B --resume UUID-DA-SESSAO
```

Repetir autorização/preflight. Se o volume estiver ausente, o runner solicita reconexão protegida antes de preparar o app. Retoma o perfil/índice; reinicia a preparação do cenário incompleto, sem presumir ações físicas passadas. Cenários já PASS não são repetidos, seus resumos permanecem. Mudança só em docs pode ser aceita; código/testes/package/scripts diferentes bloqueiam retomada. Nova versão exige sessão nova. Não apagar locks nem marcadores manualmente. `APAGAR PERFIL` no final remove apenas perfil privado com posse/caminho/processos verificados; `MANTER` conserva para retomada. Relatórios permanecem em ambos os casos.

## Evidências e interpretação

Salvar progressivamente em `reports/events-<runId>.jsonl`, `scenario-A/B-<runId>.json` com fsync e resumos atômicos. Cada retomada gera segmentos novos sem sobrescrever resultados anteriores. `private-state.json`, `entry-permit.json` e perfil são privados: contêm caminhos necessários, salt/token e logs do aplicativo; **não enviar esses arquivos brutos à auditoria**. Entregar JSONL sanitizados/resumos, fingerprint, exit code e limitações. Preparação falha também deixa evidência; no WSL, falha anterior ao console gera `kq-t3-orchestration-*` em temp interno.

Métricas: janela observada/IPC utilizável pelo driver, marcas Main ready/gate/admissão/readdir, leitura do índice, contadores de scan/I/O, gerações/epochs, foco/sondas, disponibilidade e protocolo/recursos. Distinguir clocks do driver/Main e timestamps de logger. Ausência de medição é null/NÃO MEDIDO. Processo exit 0 não substitui assertions. PASS só após todos os oráculos; FAIL para contrato violado, PARTIAL para cancelamento/trabalho incompleto, BLOCKED para segurança/identidade/recursos incertos, NOT RUN para cenário não executado. T3 físico só terá resultado após intervenção real registrada.

A regressão sintética usa renomeações de diretório descartável e Main/IPC/UI reais. Política, proteção e identidade USB são **mocks explicitamente identificados**. Inclui dois ciclos adicionais, probes duplicadas, resposta ENOENT retida por barreira após geração nova, restart com cache e playback WebM/VP8 real gerado pelo Chromium. Não comprova NTFS/USB físico, MP4, áudio audível, desempenho 9k/cache frio nem app instalado. [Evidências desta entrega](fase-f0-t3-evidencias.json).

## Handoff para o executor

Ler este procedimento, AGENTS.md, [matriz](fase-f0-testes.md) e [ticket F0](backlog/0006-fase-f-regressao-estabilizacao-pos-instalacao/0000-f0-estabilizacao-critica-standalone.md). Executar **somente quando solicitado**, preferindo B primeiro. Não corrigir produção, alterar guardas ou aceitar risco de metadados para obter PASS. Se preflight bloquear, salvar evidência e explicar a condição, sem abrir biblioteca. Registrar cada intervenção/resultado, snapshot e métricas; atualizar ticket/relatório sem substituir histórico. Revisão independente e homologação final continuam com o proprietário; não iniciar F1–F4.

## Campanha unificada T3 + F0-08 — testekaraoke

**Infraestrutura implementada; campanha física NÃO executada nesta entrega.** Esta autorização cobriu criação/testes, não uso real do pendrive. A execução posterior exige solicitação explícita, proprietário presente e intervenção humana em cada checkpoint. D: e seu acervo operacional ficam excluídos, inclusive no modo descartável. Nesta implementação não houve consulta ou acesso a F: nem D:.

### Comandos definitivos

Em terminal WSL interativo no checkout aprovado:

```bash
npm run test:manual:usb-campaign -- --authorize-physical-test --media-mode disposable --scenario all
```

Cenário único, por exemplo o prioritário T3-B:

```bash
npm run test:manual:usb-campaign -- --authorize-physical-test --media-mode disposable --scenario B
```

IDs na ordem: **B → A → playing → paused → countdown → loading → transition → celebration**. Não usar números como argumento; a tabela abaixo faz a correspondência. `all` é o default da nova campanha. O alias chama o **mesmo** `manual-usb-reconnect.cjs` com `--campaign`; não existe segundo launcher de sincronização. O fluxo legado `test:manual:usb-reconnect` continua com A/B e proteção estrita, sem habilitar descartável por flag genérica. O novo B mede somente startup, terminando em idle; playback é cenário independente. A seleção/reprodução adicional do B legado foi preservada.

A campanha reutiliza snapshot/bundle/lock/compile/manifesto/fingerprint oficiais e importa o package Main através da entrada de observação existente. É um **harness instrumentado**, não o produto instalado nem substituto do launcher manual oficial para homologação do aplicativo. Native Node/npm/Electron/Playwright, perfil/SQLite privados e logs ficam no disco interno `%TEMP%\KQ-T3-<UUID>`. Não mexe em instalação/manifesto/userData operacional. Console Windows separado usa comandos PowerShell, sem mudar ExecutionPolicy ou configuração global.

O script exige terminal interativo e autorização textual `AUTORIZO T3 FISICO`. CI, npm test e runners automáticos não selecionam a modalidade física; as únicas inclusões automáticas novas são unitários e o E2E sintético. `--approve-untracked` só após revisar a lista/hash do snapshot; sem ele, confirmar `SYNC` quando solicitado. O agente não deve responder consentimentos em nome do proprietário.

### Preflight e modos de mídia

A raiz inicial é exclusivamente **F:\musicas**. Não há argumento genérico para escolher outro acervo. Antes de lstat/enumeração/abertura, o runner exige política de timestamps conhecida e consulta metadados nativos **somente da letra autorizada**: nome `testekaraoke`, USB, online, saúde Healthy, filesystem suportado e identidade forte. A identidade usa o mesmo hash com salt de GUID do volume, UniqueId/serial de disco e offset de partição, independente da letra. Outra unidade no F: bloqueia antes da biblioteca; nome/letra sozinhos não bastam. Subst, UNC, junctions/symlinks na raiz, identidade insuficiente ou estado de saúde ambíguo bloqueiam. NTFS/exFAT/FAT32 são aceitos no modo descartável; modo protegido mantém o contrato NTFS anterior.

| Modo | Autorização e garantias |
| --- | --- |
| `--media-mode protected` | Exige `PROTECAO VERIFICADA`, proteção efetiva validada externamente e IsReadOnly=true. Só B/A; cenários ativos são BLOCKED. A política anterior de preservação continua inteira |
| `--media-mode disposable` | Exige nesta sessão as frases `SEM DADOS IMPORTANTES testekaraoke` e `ACEITO RISCO DESCARTAVEL testekaraoke`. Pode operar em pendrive gravável; **não alega proteção contra escrita**. Identidade/nome/raiz/USB/saúde/isolamento continuam obrigatórios |

Aviso exibido: leituras podem alterar LastAccessTime; retirada abrupta pode corromper filesystem, tornar arquivos inacessíveis ou exigir reformatação; não há garantia de integridade dos dados. O runner não altera política, atributo read-only, ACL ou timestamp e nunca formata, repara, otimiza, limpa, ejeta ou desmonta por software. Não aceitar o modo descartável para o HD original. O consentimento é renovado a cada execução/retomada, nunca restaurado de um boolean persistido.

Cada cenário ativo exige ainda `AUTORIZO REMOCAO ABRUPTA <id>` **antes** de preparar playback. Essa frase não manda remover imediatamente: o checkpoint seguinte informará o estado observado e a ação. B/A usam remoção segura permitida pelo Windows e exigem recursos quiescentes; se o Windows negar, `BLOQUEADO`, sem forçar. Nos ativos, pode haver leitura em andamento: só o proprietário intervém, no pendrive descartável já identificado. Autorização geral não substitui o consentimento específico. Contadores de I/O/streams e o método solicitado são registrados; segurança efetiva da ação física depende do proprietário/Windows, não é certificada por uma resposta textual.

**Se houver sinal de erro/instabilidade do filesystem, cancelar e interromper.** Divergência de identidade, saúde inválida, erro de I/O reconhecido ou cleanup não confirmado interrompem o controller; FAIL funcional nunca avança automaticamente. Não aceitar pedido de reparação Windows dentro da campanha. Não tentar contornar com nova flag.

### Cenários e oráculos independentes

| Nº / ID | Setup e prova necessária |
| --- | --- |
| 1 / B | Perfil privado, índice inicial/cache e gate; app fechado/processos zero antes da remoção segura. Ausência nativa → mesmo volume → mesmo perfil/cache; janela, IPC/UI operacional, zero readdir antes do gate, reconciliação posterior e idle. Salva baseline/restauração sem exigir playback incidental |
| 2 / A | Ready/idle, sem scans/I/O/streams/handles/grants; quiescência instrumentada existente antes da remoção segura. Main/UI detectam indisponibilidade, índice/configuração preservados, mesma identidade no retorno e um scan adicional, sem fantasma |
| 3 / playing | Música real avançando, duas ocorrências pendentes (normal + prioridade). Verifica perda nativa e comportamento real. Buffer observado sem recuperação fica PARTIAL, recovery branch NOT REPRODUCED; não espera buffer esgotar. Se houver falha efetiva, exige contenção, mesmo alvo/filas, modal, ausência de EOF falso e recuperação manual com nova attemptId |
| 4 / paused | Playback real → pausa confirmada. Ausência/retorno não retomam; se F0-08 detectar e contiver, exige intenção de pausa, fila e alvo preservados e recuperação manual. Condição não observada é PARTIAL |
| 5 / countdown | Submissão normal, timer real de cinco segundos observado. Não congela artificialmente para a pessoa. Se a perda só for observada depois do countdown, PARTIAL/NOT REPRODUCED; caso observado exige conservação do alvo/tempo e ação manual |
| 6 / loading | Aguarda loading real, sem alongar produção. Janela não observada em prazo controlado resulta PARTIAL, sem pedir remoção às cegas; falha observada exige contenção e recursos revogados antes de recuperar |
| 7 / transition | Música/filas reais, comando existente Next e observação da transição. Sem sincronização humana em milissegundos. Se o alvo/estado avançou legitimamente antes da perda, PARTIAL. Na recuperação observada, próximo head e prioridades não podem ser perdidos |
| 8 / celebration | Aguarda EOF natural, registra sua confirmação e celebração real. Não faz seek/EOF falso, não alonga cinco segundos. Clips longos/janela perdida dão PARTIAL. Falha na próxima exige EOF anterior válido, sem duplicação e com próximo alvo preservado |

Recomendação de fixtures físicas: pelo menos três códigos MP4 únicos e vídeos curtos para o cenário de EOF, preparados previamente pelo proprietário. O runner não cria nada no pendrive. O setup lê o índice para selecionar códigos, sem publicar nomes. Loading/transição têm watchdog de observação de 30 s; EOF/celebração até 180 s. Isso limita a espera e não mantém artificialmente estados em produção. Nenhum evento playing/EOF é injetado na modalidade física.

Cenários ativos começam com perfil novo por tentativa. Na detecção de perda, duas amostras rápidas de mídia e verificações nativas delimitam eventual avanço ainda sem volume; não há espera deliberada para esgotar buffer. Depois, reconectar é solicitado prontamente. O monitor normal do produto detecta retorno (foreground 5 s/background 30 s, observação até 60 s); o físico não força `probeLibraryAvailability` nem erro de mídia. Estado de foco e relógios Main/Renderer/driver separados ficam nos logs.

Só haverá PASS da recuperação após Main/Sequence/coleta de recursos, modal e fila concordarem. O operador confirma o checkpoint de recuperação; só então o runner clica o botão existente. Exige nova attemptId, mesma entryId reservada, filas/prioridades corretas e progresso real. `loadedmetadata.currentTime=0` e playing são observados após o clique; correlação temporal dos eventos DOM é identificada como tal, a identidade autoritativa vem do Main. Não é prova do primeiro frame ou qualidade A/V. A política F0-08 reinicia do início, sem prometer seek/posição anterior. O cleanup termina a sessão de teste explicitamente, verifica Stop/recursos com app aberto e depois saída dos processos.

### Checkpoints, cancelamento, repetição e retomada

Cada cenário começa com `INICIAR / PULAR / CANCELAR`. O checkpoint físico usa `CONFIRMO` para B/A, `REMOVIDO` nos ativos e `CONFIRMO` após reconexão; também aceita `PULAR`, `CANCELAR` e `BLOQUEADO`. A ausência real do volume e a identidade de retorno são verificadas; confirmação humana não equivale a ação bem-sucedida. Timeout humano de dez minutos interrompe com evidência parcial. Não há defaults positivos.

Depois do resultado: `PROXIMO / REPETIR / CANCELAR`. FAIL exige avaliação explícita (`AVALIADO REPETIR`) para repetir e nunca oferece avanço. Identidade/saúde/cleanup incertos são fatais para a sessão, independentemente de resposta. Repetição cria adapter/perfil novo e resumo novo; não sobrescreve a tentativa anterior. Cancelamento/skip fecham o app normalmente; se o volume ficou ausente, nenhum cenário seguinte acessa a pasta sem novo preflight. Se não houver confirmação de cleanup, não fazer outra intervenção física.

Retomar do WSL com o UUID exibido:

```bash
npm run test:manual:usb-campaign -- --authorize-physical-test --media-mode disposable --scenario all --resume UUID
```

Precisa de mesmo código/HEAD/branch (docs isoladamente podem mudar), modo de mídia igual, sessão interna com posse válida e nenhum processo anterior. Valida a estrutura do estado e caminhos de perfis antes de qualquer adoção. Restaura só histórico, decisões concluídas e identidade; **não adota playback, tentativa ou fila volátil antiga**. Cenário incompleto reinicia com perfil novo. B preserva seu perfil exclusivamente entre as duas aberturas do mesmo cenário. Para repetir selecionados já concluídos, acrescentar `--repeat-completed`, mantendo todo o histórico.

Se a letra mudar, não há busca automática por outras unidades. Quando solicitado, o operador informa `LETRA G:` (a real; C:/D: são recusadas). O runner consulta somente essa letra, exige a mesma identidade/nome/saúde e pede `CONFIRMO LETRA G:`. O cenário corrente termina PARTIAL/LETTER_CHANGED_RESTART_REQUIRED; somente cenário/repetição novo, com perfil novo e baseline novo, usa a nova raiz confirmada. **Não é remapeamento automático de biblioteca nem reutilização do cache F: em G:.** A retomada também renova essa confirmação; manter o dispositivo conectado antes de retomar uma sessão já reidentificada.

### Resultados, logs e auditoria

JSONL com fsync é salvo continuamente, inclusive durante checkpoints com app aberto. Cada cenário/tentativa tem resumo próprio PASS/FAIL/PARTIAL/BLOCKED/NOT RUN e causas observadas; janela temporal ou branch não reproduzido é registrado separadamente, nunca promovido a PASS. Resumos repetidos recebem nomes distintos e não apagam os anteriores. `results` é só a última tentativa; **history e arquivos por tentativa são o registro completo**.

Dados ficam em `%TEMP%\KQ-T3-UUID\reports`. Perfis privados por cenário são mantidos para diagnóstico; processo/handles devem encerrar entre cenários. Fixtures/perfis dos testes sintéticos são removidos, evidências ficam fora deles. Não publicar `private-state.json`, permissões/nonce, perfil, checkout ou logs brutos de AppData; entregar JSONL sanitizado, resumos por tentativa, fingerprint/HEAD, limitações e erros. A identidade publicada é hash com salt. Não incluir nomes de músicas. Valores não medidos permanecem null/ausentes, nunca zero inventado.

GO automatizado não é homologação física: [evidências desta infraestrutura](fase-f0-usb-campanha-evidencias.json). A campanha real ainda deve confirmar o comportamento de hardware, cache/latência e a intervenção humana. T3 sintético e F0-08 continuam no CI sem depender de F:/D: ou USB; não executar a campanha física no CI.

### Prompt para o modelo econômico — execução futura

“Execute somente a campanha física solicitada pelo proprietário, começando por B salvo solicitação da campanha completa. Leia AGENTS.md, este procedimento, F0-08, relatório e ticket 0006/0000. Confira Git/snapshot, proprietário presente, pendrive testekaraoke e isolamento. Use o comando com cenário explicitamente solicitado. Não responda consentimentos/ações físicas em nome do proprietário; transporte somente confirmações humanas efetivamente recebidas. Nunca consulte D:, altere políticas/metadados, repare/ejete dispositivos por software ou estenda estados de produção para obter reprodução. Se o intervalo físico não for observado, registre PARTIAL/NOT REPRODUCED. Preserve todos os logs/resultados, relate cada tentativa e não faça correção de produção durante a validação. Pare perante identidade/saúde/cleanup inválidos ou FAIL funcional até avaliação. Não declare F0 homologada nem inicie F1–F4.”
