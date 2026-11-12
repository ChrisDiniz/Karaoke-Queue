# G2 — auditoria independente final (Sol)

Data: 2026-11-12. Escopo: working tree da branch `feature/remote-player-lan-integration-3`, HEAD `75af81822fdc929ea5c011ad6a5efa73bfcf24c2`, incluindo arquivos G2 não commitados. Alterações preexistentes preservadas. Referência normativa: [kq-pair/2](g2-1-final-pairing-profile.md). Revisão de código e contratos; não é auditoria matemática independente do provider. Trade-offs aprovados da G2.1 preservados.

**Estado vigente — reauditoria final:** A4 PASS; A1–A3 PASS; G2.2/G2.3 PASS; auditoria independente PASS. G2 tecnicamente apta para iniciar G3, que não foi iniciada. Produção NÃO homologada. Histórico da correção e do FAIL inicial preservado abaixo.

## Parecer

**Reauditoria final: PASS. G2.2: PASS. G2.3: PASS. G2 tecnicamente apta para iniciar G3: SIM.** A4 foi confirmado corrigido por revisão do coordinator/store e reexecução dos testes relacionados. Não há bloqueador técnico conhecido no escopo auditado. Produção permanece NÃO homologada; G3 não foi iniciada. O FAIL inicial é preservado como histórico.

## Achados e correções

| ID | Gravidade | Causa e evidência | Situação |
| --- | --- | --- | --- |
| A1 | P1 | `PairingAuthorizationAdapter` só lia hash/estado; indisponibilidade do cofre não impedia `authorizeBearer`/`isCurrent`. Teste falhou retornando peer com cofre indisponível. | Corrigido: decifra/verifica token e recovery root, limpa buffers e revalida revisão/fence após awaits. Erro nega autorização. |
| A2 | P1 | `transactUnlocked` sobrescrevia bootId em qualquer escrita; após restart, escrita antes de `reserveAttempt` fazia reservas antigas parecerem locais, e `attemptTimes` ausente as apagava. Teste esperava lockout e admitiu. | Corrigido: preservar bootId anterior enquanto houver reservas sobreviventes; cooldown continua monotônico/conservador. |
| A3 | P1 | Validator de renewal exigia autoridade active mesmo durante revogação: `revokeLocally` com staging falhava com `PAIRING_STORE_INVALID`; após restart a autoridade antiga continuava active. | Corrigido: descartar staging não comprometido no tombstone; preservar promoção comprometida mesmo revogada. Recovery promove identidade sem reativar autoridade. |
| A4 | P1 bloqueante | `controllerBind` aguardava worker/cofre e persistia sem fence de sessão. O cancelamento durante encrypt retornava true, mas a continuação ainda salvava `bound`. | **RESOLVIDO no addendum**: admissão linearizada, cancelamento aguarda/reconcilia escrita e os testes OPAQUE reais passaram. Reauditoria final **PASS**. |

### A4 — reprodução e correção exigida

Na auditoria inicial, `node scripts/pairing-bootstrap-integration.test.cjs --cancel-at-prepare` executou AKE real e confirmação bilateral. Na primeira cifragem, `cancelLocally()` retornava true; depois a asserção `journals.length === 0` falhava (**actual 1, expected 0**). Esse resultado histórico motivou a correção abaixo.

Impacto: cancelamento local confirmado não cerca o pending. A Gestão já pode ter R persistida; não se deve presumir que o erro HTTP posterior impeça recovery/commit. A autoridade não ficou active no reproducer, mas o journal recuperável contradiz o cancelamento e ocupa o slot. Isso viola §6 do perfil.


### A4 — correção e evidências

`PairingBootstrapService` mantém uma admissão volátil e síncrona para o primeiro journal. Antes dela, o cancelamento cerca a sessão, limpa código, fecha o worker e as continuações antigas revalidam sessão/deadline após cada await do worker/cofre. Depois dela, cancelamento não desfaz nem apaga nada: espera o `transact`, lê novamente o store se a Promise falhar e retorna sucesso somente quando a leitura durável confirma ausência do journal daquela sessão/operation/attempt. Se o journal está presente, o Player fica `pending` e não envia `prepare` após uma intenção de cancelamento; se a leitura não resolve o resultado, fica `blocked`/`RESULT_UNCERTAIN`. Escrita admitida junto do fechamento segue a mesma reconciliação. A admissão vence cancelamento posterior, mas nunca concede autorização: só `active` habilita `transport:control`.

Semântica local mantida: `cancelLocally(): Promise<boolean>` retorna `true` apenas quando cancelado com ausência durável confirmada; `false` não autoriza a UI a dizer “cancelado” e requer consultar estado/recovery. Duplicatas compartilham a mesma Promise. O estado persistido não tem rollback artificial. A expiração também deixa de vencer uma escrita já admitida; ainda é verificada imediatamente antes da admissão.

Com OPAQUE real e barreiras, passaram: reproducer original `--cancel-at-prepare`; cancelamento durante cofre pendente; cancelamento após a segunda operação do cofre e antes da admissão; cancelamento logo após admissão; cancelamento depois de rename/fsync mas antes do retorno do writer; falha antes do commit com releitura comprovando ausência; ACK perdido depois de rename/fsync com releitura encontrando journal e restart preservando-o; negação de bearer em journal `bound`; chamadas duplicadas; fechamento durante escrita sem apagar journal; revogação concorrente com shutdown após autoridade ativa; e revogação durante uma renovação cujo journal já havia sido admitido. Neste último caso, a revogação foi durável, o receipt seguinte não avançou o journal e o bearer antigo foi negado. O journal `bound` é preservado e ocupa o slot para recuperação/revogação local explícita; não é apagado. Nenhum cancelamento confirmado sobreviveu a restart com journal, e nenhum cenário de cancelamento devolveu `response/prepare`. Sem sleeps. O caso de ACK perdido preservou `bound` e recuperação; não declarou cancelamento.

Regressões do teste `test:unit:pairing`: A1–A3 **3/3 PASS**; store **4/4 PASS**; renewal/revogação **1/1 PASS**; crypto **2/2 PASS**; wire/state **3/3 PASS**; worker OPAQUE real, bootstrap integral e os nove modos de barreira/concorrência **PASS**. Compilação **PASS**. O processo independente final foi `NOT RUN` por ausência de interface IPv4 RFC1918 neste ambiente; não é necessário para esta correção de serialização local. Não houve alteração Windows específica nem repetição dos smokes Windows.

`git diff --check`: **PASS** após a atualização documental final. `package.json` validado como JSON.

## Conformidade e fronteiras verificadas

- Provider real `@serenity-kit/opaque@1.1.0` fixado no manifest/lock, registro inteiramente local no Player, perfil/KSF fixos, worker Main-owned. Setup/record/K permanecem no worker; Main recebe R/transcript para persistência protegida. Limpeza de memória é best-effort.
- CTX/identifiers incluem roles, IDs, nonces, versão, finalidade e DER fingerprint; transcript e HKDF/HMAC seguem o perfil. Receipts usam chaves derivadas de R desde o início; vetores independentes existentes continuam aplicáveis. Descoberta/certificado candidato não concedem autoridade e não há fallback SRP/SAS.
- Cinco receipts e journals precedem respostas duráveis; recovery autentica nonce, fase, cadeia e prepare perdido. Slot único e revisões cercam concorrência; respostas perdidas mantêm estado recuperável. A4 foi corrigido e confirmado na reauditoria focal.
- Código uniforme por `randomInt`, 120 segundos, quotas 3/5, persistência no mesmo arquivo. A2 corrigiu a lacuna de restart com escrita intermediária.
- Revogação usa fence imediato e tombstone; A3 cobre staging/promoting. Cofre/disco/corrupção negam os caminhos verificados. Lock por caminho é intraprocesso; continua dependente do único writer por perfil, sem promessa contra administrador/rollback de perfil.
- Não há integração de segredos persistentes em Renderer/Preload nem fixture de consentimento conectada ao produto. `approvedForProduction` é uma precondição Main-side, não mecanismo de autorização remota. Sem presentation port real G5, open fica desabilitado; recovery de transações existentes permanece autenticado.
- G2 concede somente `transport:control`; não cria rotas operacionais H, fila, SQLite operacional ou reconexão G4. Nenhuma alteração em Doop/F/playback/fila nesta auditoria.

## Testes e Windows

Antes das correções A1–A3: regressões novas **0/3 PASS**, com três falhas reproduzidas. Depois: **3/3 PASS**; store **4/4**, renovação com falha de promoção e revogação antes de recovery **1/1**, crypto/vetores **2/2**, wire/estados **3/3**, worker OPAQUE real e bootstrap completo **PASS**. Compilação **PASS**; runner unitário **39/39 PASS**.

Na execução anterior à correção A4, reexecutamos apenas o modo remoto oficial Windows devido às correções de persistência/autorização: **PASS**, fingerprint `83c7783afed07048c2184926fb240e77768ae261fc3ebec818f1b143385a4301`, Node Windows `24.11.0`, npm `11.6.1`, Electron `45.0.0`. Incluiu regressões A1–A3, promoção revogada, processo Player/Management, DPAPI/restart, 18/18 transporte (incluindo shutdown EBADF), 7/7 descoberta e cleanup sem processos residuais. Multicast opt-in foi skipped. A4 foi reproduzido depois, somente Linux/Node; o modo normal do bootstrap passou, mas o cenário novo de cancelamento **falhou**, originando este addendum.

Os 3/3 smokes Windows históricos são evidência válida nos seus alcances. Conferidos scripts/fixture DPAPI, fixture OPAQUE/worker/ASAR, relatório PACKAGE PASS e selo em NTFS: candidato SHA-256 `8af6dec349330b3daa51aeaf1fde11bc099b81379173f8c6dd31178f63ddc9a0`, fingerprint de execução `20634474b8589f71a493aa77e450b61a93d9f51841648935061bcbfc21b67932`. O candidato é anterior às correções desta auditoria, não artifact de release destas mudanças. Não foi reempacotado nem instalado.

A exceção do runner exige caminho exato + hash LF/CRLF revisado + tracked/adopted; não libera arquivos untracked, conteúdo novo, outros nomes sensíveis ou exclusões. A normalização `path.join` na extração ASAR está correta para a API e tem regressão POSIX/Windows. Shutdown agora destrói sockets durante fechamento, inclusive no catch de autorização abortada; a regressão Windows passou novamente.

## Gates restantes

A4 e regressões A1–A3 **PASS** na reauditoria focal. G2.2/G2.3 e auditoria independente **PASS**; G2 tecnicamente apta para iniciar G3 **SIM**. G3 não foi iniciada. A revogação concorrente depois da admissão de um journal de renovação é fail-closed, mas preserva `bound` e ocupa o slot até recuperação/revogação local explícita conforme o perfil. G5 deve integrar apresentação local real aprovada, IPC restrita e código fora da TV; G4/H seguem reconciliação/offline explícito e escopos operacionais. G6/H5 valida dois computadores físicos/LAN. Riscos aceitos do provider, observação física, endpoints comprometidos e ausência de garantia universal de apagamento/timing permanecem documentados na G2.1.

Sem commit/push/PR. `git diff --check`: PASS na conclusão. G3 não iniciada.


## Reauditoria focal final A4 — 2026-11-12

Revisão de `cancelLocally`, admissão síncrona, writer e releitura sob lock por caminho: não há await entre o último fence e a decisão de admitir. Cancelamento antes dela cerca definitivamente a sessão; depois dela espera a mesma operação e só confirma ausência após reconciliação. Journal presente mantém pending; releitura inconclusiva mantém blocked. Não há rollback ou exclusão para fabricar sucesso. Nenhuma autorização operacional deriva desses estados. Não foi encontrado ciclo de espera entre o cancelamento e a fila de requests: o writer resolve independentemente da Promise de cancelamento. I/O do sistema ainda pode demorar; não se transforma timeout de I/O em cancelamento confirmado.

Reexecutado `npm run test:unit:pairing`: reproducer original e nove modos de barreira/concorrência PASS, worker/bootstrap real PASS, lifecycle 1/1, crypto 2/2, store 4/4, A1–A3 3/3, wire 3/3 e renovação 1/1 PASS. Integração LAN entre processos NOT RUN por ausência de interface RFC1918; evidência anterior não foi invalidada. Adicionada e executada regressão focal `--cancel-after-write-unreadable`: escrita falha e arquivo não pode ser relido, cancelamento retorna false, resposta RESULT_UNCERTAIN/blocked, restart recusa o arquivo, autorização é negada e os bytes são preservados. PASS com OPAQUE real. A regressão foi incorporada aos scripts unitários.

Nenhum defeito adicional de produção demonstrado; nenhuma correção de produção necessária nesta reauditoria. Windows/ASAR não repetidos, pois seus componentes não foram afetados. Os testes de restart usam nova instância do store e falhas determinísticas; não representam corte físico de energia. Journal bound retido em revogação concorrente continua fail-closed e pode ocupar o slot, conforme a política de recuperação explícita. G5 deve fornecer apresentação segura e tratar false como cancelamento não confirmado; G6/H5 mantém homologação em computadores físicos. Produção NÃO homologada. `git diff --check`: PASS. Sem commit/push/PR e sem iniciar G3.

## Revisão final para checkpoint — guarda de inicialização do Player

Na auditoria da working tree para o checkpoint G2 foi encontrado um defeito adicional P2 no composition root: `startPlayer()` verificava apenas uma inicialização em andamento, embora após sucesso `playerStartTask` seja limpa e `server`/`advertiser` continuem ativos. Uma segunda chamada poderia iniciar e substituir essas referências, deixando o primeiro listener sem dono. A guarda foi restaurada para recusar início quando há inicialização em andamento, servidor ou anúncio ativo. A renovação guiada continua usando o caminho interno explícito de parada/reinício.

Regressão em `tests/remote-infrastructure.test.ts` prova que, depois do primeiro listener HTTPS ativo, a segunda chamada é recusada e `close()` encerra o único anúncio. `npm run compile`: **PASS**; `node --test build/tests/remote-infrastructure.test.js`: **19/19 PASS**; `npm run test:unit:pairing`: **PASS**, incluindo OPAQUE real, cancelamento A4, lockout, revogação e renovação. O subprocesso de integração LAN imprimiu **NOT RUN** nesta execução por ausência de interface IPv4 RFC1918; a evidência anterior aprovada de processos independentes permanece registrada e não foi afetada pela guarda local. Não foram repetidos os smokes Windows, pois a correção não altera código específico de plataforma, worker, ASAR ou safeStorage.

Sem mudança no parecer: G2.2/G2.3 e auditoria **PASS**, G2 tecnicamente apta para iniciar G3, G3 não iniciada, produção não homologada; G5 e G6/H5 continuam pendentes.
