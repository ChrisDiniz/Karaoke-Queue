# Prioridade 3 — confirmação e recuperação da persistência SQLite

## Diagnóstico anterior

`KaraokeApplication` alterava o estado publicado e chamava `void this.persist()` em cadastro, edição, cancelamento, conclusão, movimentação/fixação, liberação de pin, promoção, seleção automática, congelamento/liberação, criação inicial de sessão, reset de mesa e ativação de licença. O repositório capturava snapshots e serializava **gravações**, mas não serializava a preparação/publicação das operações. Os handlers limpavam campos, fechavam modais e exibiam sucesso sem aguardar o banco. Uma rejeição podia ficar como Promise não tratada enquanto a UI já mostrava o resultado.

`startNewSession`/`endCurrentSession` aguardavam persistência e restauravam um snapshot anterior no erro. A transação SQLite era atômica, mas essa restauração de memória não protegia outras operações concorrentes. A UI também gravava cadastro/conclusão/cancelamento e seleção do próximo turno em chamadas separadas.

O processo principal já usa SQLite em WAL, `synchronous=FULL`, `busy_timeout=5000` e `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`. Essas garantias foram mantidas. O problema principal não exigia reconstruir o banco nem mudar o schema.

## Estratégia: preparar → gravar → publicar

`KaraokeApplication.enqueue()` serializa **operações inteiras**. Cada operação:

1. Verifica admissão, geração de falha e identidade da sessão.
2. Copia o último estado confirmado para um candidato privado e transitório.
3. Aplica as mesmas regras de negócio nesse candidato.
4. Aguarda `repository.save(candidate)`.
5. Publica o candidato e resolve a Promise com o resultado somente após confirmação.

A UI consulta exclusivamente o estado confirmado. O candidato não é uma segunda fonte de estado operacional: fica privado durante uma única operação, é descartado em rejeições comprovadas e só substitui o estado publicado após confirmação. Não existe rollback de um estado público modificado otimisticamente.

`getPlayOrder()` continua sendo consulta sem gravação ou reordenação. Métodos de mutação passam a retornar Promises. Regras em `queue-rules.ts`, `round-robin-rules.ts`, `debut-cadence-rules.ts`, `fixed-turn-rules.ts` e `frozen-queue-rules.ts` permaneceram idênticas, verificadas por SHA-256.

### Operações cobertas

| Operação | Confirmação/atomicidade |
|---|---|
| Adicionar, editar, cancelar, concluir | Promise resolvida após gravação; validações/no-ops mantidos |
| Cadastro individual na UI | `addEntries([input], true)`: cadastro + seleção inicial no mesmo snapshot |
| Adicionar vários | Todos os registros e seleção inicial em uma transação; preservada a seleção por entrada do fluxo anterior, sem lote parcialmente confirmado |
| Cantou / Cancelar na UI | `completeAndAdvance` / `cancelAndAdvance`: histórico, pendências, ordem, cadência, proteções e próximo atual juntos |
| Seleção automática / promoção manual | Operações serializadas, preservando origem automática/manual |
| Drag-and-drop / pin / soltar | Aguarda confirmação; preview é restaurado no erro; nenhum pin exibido como confirmado antes do banco |
| Congelar / estender / liberar | Prefixo protegido só publicado após confirmação |
| Ordem e fase 2:1 | Parte do snapshot da operação causadora; não há gravação independente parcial |
| Reset de mesa / licença | Mesmo mecanismo de confirmação; somente feedback de sucesso aguardado |
| Nova sessão / encerramento | Mantida a transação existente; publicação agora também é serializada e posterior ao commit |
| Carregamento/migração legada | Estado preparado e salvo antes da publicação; remoção das chaves legadas somente após confirmação |

## Concorrência e falhas

A operação seguinte é preparada a partir do resultado **confirmado** da anterior. Inputs são capturados na admissão, impedindo alteração posterior do objeto fornecido pelo chamador. Não há snapshot antigo preparado em paralelo para sobrescrever um resultado mais recente.

Se uma operação falhar, sua geração é invalidada. As operações já enfileiradas naquela geração são rejeitadas, sem executá-las automaticamente sobre premissas diferentes. O prefixo confirmado permanece íntegro. Uma nova tentativa explícita pode prosseguir após falha comprovadamente sem commit; resultados incertos exigem reconciliação primeiro.

A aplicação distingue:

- **Confirmada:** resposta positiva do SQLite ou leitura posterior comprovando o candidato.
- **Rejeitada antes da escrita:** fechamento em andamento, sessão alterada ou dependência de operação que falhou.
- **Falha comprovada:** leitura posterior corresponde ao estado anterior.
- **Incerta:** leitura indisponível ou diferente tanto do estado anterior quanto do candidato.

Pedidos duplicados de conclusão retornam `null` após a primeira conclusão; não duplicam histórico. A UI evita ações críticas duplicadas em andamento. No cadastro, somente os campos/botão daquele formulário ficam temporariamente em processamento; o restante da aplicação não é desabilitado.

## Reconciliação, retry e recuperação

Após erro/rejeição de `save`, o repositório lê o SQLite via IPC. A comparação considera conteúdo, ordem pendente por sessão, ordem histórica dentro da sessão, metadados e proteções; normaliza apenas a representação de campos opcionais e o agrupamento de histórico feito na leitura do SQLite.

Se o candidato está no banco, confirma o resultado sem reenviar a escrita. Isso cobre o commit concluído cuja resposta IPC foi perdida. Se o estado anterior está no banco, a alteração não ocorreu. Se nenhum dos dois puder ser comprovado, gravações ficam bloqueadas; a fila não é apagada nem substituída por uma leitura divergente.

Retry automático é limitado a **duas tentativas adicionais**, com intervalos de 100 e 200 ms, somente para `SQLITE_BUSY`/`SQLITE_LOCKED`/mensagem equivalente e **depois de comprovar que o estado anterior permanece no banco**. O `busy_timeout` SQLite existente continua aplicável a cada tentativa. READONLY, FULL, IOERR, permissão e falhas IPC não são repetidos cegamente.

O aviso persistente oferece **Verificar armazenamento**. A ação realiza somente reconciliação, não reaplica comandos rejeitados. Se uma escrita incerta for confirmada, publica o candidato e informa que não é necessário repetir a operação. Se não houve commit, libera uma nova tentativa explícita. Falhas na própria recuperação também mantêm novas gravações bloqueadas.

Cadastro e lote não são limpos no erro. O cadastro individual confirmado tardiamente pela recuperação limpa os campos apenas quando ainda correspondem ao que foi submetido, evitando uma repetição acidental. Ações de edição/conclusão/cancelamento/congelamento não exibem toasts de sucesso antes da confirmação.

No backend, uma transação falha invalida o cache usado pelas escritas diferenciais; a próxima escrita reconstrói esse cache por leitura. Uma conexão ainda dentro de transação não resolvida não pode fornecer uma falsa leitura de confirmação. Nessa situação crítica, a recuperação exige reabrir o aplicativo/banco, sem limpar dados.

## Fechamento e sessões

Antes de calcular o resumo e abrir a confirmação nativa, `prepareToClose()` bloqueia novas mutações e aguarda as já aceitas. Navegação e leitura não são bloqueadas. Falha ou resultado incerto impede a saída normal. Cancelar ou falhar no fluxo devolve a admissão à aplicação; o bloqueio por incerteza de armazenamento permanece até recuperação.

O encerramento autorizado é admitido através dessa barreira, grava/arquiva na transação já existente e só então permite fechar. Sair sem encerrar apenas aguarda a durabilidade. Não há novo comportamento por horário, meia-noite, inatividade ou crash. A sessão aberta continua aberta após encerramento inesperado do processo.

## IPC e logs

Nenhum schema/migração ou contrato `app-data:load` / `app-data:save` foi alterado. `preload.ts` não precisou mudar. Foram acrescentados os hooks internos `window.__kqueue.prepareToClose/cancelClose` para coordenar main/renderer.

O canal existente de diagnóstico reconhece eventos `PERSISTENCE_*`: falha de escrita/operação, retry, incerteza, recuperação de resposta e reconciliação. Os registros carregam tipo técnico de operação/sessionId quando aplicável; o logger existente acrescenta runId/timestamp. Não são enviados nomes, músicas nem snapshots. Falhas do próprio envio de diagnóstico não interrompem a recuperação.

## Testes

### Unitários e regressão

- Baseline: **99 testes/grupos aprovados**.
- Após a implementação: **126 testes/grupos aprovados**, incluindo **27 novos testes de persistência**.
- Log: `/tmp/persistence-unit-final.log`.
- Mantidas as asserções de Round Robin 5/3/2, distribuição 34/33/33 em 100 conclusões, 120 eventos mistos, cenário Duda e 128 eventos de reset de cadência.

Os novos testes cobrem publicação após confirmação, mutação do input, conclusão duplicada, falhas em cadastro/lote/edição/conclusão/cancelamento/pin/congelamento/liberações/promoção/seleção/sessões, cinco operações concorrentes, falha na primeira e na terceira, retry limitado, falhas permanentes, resposta perdida após commit, resultado incerto, recuperação sem commit, leitura divergente, falha da própria recuperação, fechamento aguardando escrita, SQLite somente leitura real e rollback real no meio de transação.

No teste SQLite de conclusão de estreia, um trigger aborta a atualização de `app_state` após as alterações das entradas. Fila, histórico, Vez atual e fase 2 permanecem intactos; após remoção da falha, conclusão e fase 0 são persistidas juntas e recuperadas por um novo controlador.

### Electron real / Playwright / Xvfb / SQLite via IPC

Todos os perfis/bancos são temporários e isolados; nenhuma validação substituiu Electron/SQLite por browser/localStorage.

| Suíte | Resultado |
|---|---|
| Persistência e recuperação | Aprovada: falha real em transação, cadastro individual e lote preservados, conclusão/cancelamento/congelamento/pin rejeitados, restauração do preview, fechamento bloqueado, encerramento rejeitado, IPC perdido após commit, resultado incerto, sequência rápida com falha intermediária, reinício e fechamento aguardando gravação atrasada |
| Round Robin | Aprovada: ordem visual/SQLite 5/3/2, drag-and-drop, pin, congelamento/liberação, cancelamento, cadência e reinício |
| Cadência/Duda | Aprovada: estabilidade e recuperação via SQLite |
| Fechamento de sessões | Aprovada: cancelar, sair sem encerrar, encerrar, reabrir, crash recovery e pendências arquivadas |
| Sessões anteriores | Aprovada: transição explícita, pesquisa atravessando madrugada, detalhes somente leitura e recuperação |
| Autocomplete/cadastro | Aprovada: sugestões por mesa/sessão, teclado/mouse, pendentes/concluídas e reinício |
| E2E completo | Interrompido na falha já conhecida de drag-and-drop sintético: `tests/electron-smoke.ts:636`, esperando `#manual-move-modal`; os cenários posteriores NÃO foram executados |

Logs: `/tmp/persistence-e2e-verified.log`, `/tmp/persistence-final-round-robin-electron.log`, `/tmp/persistence-final-debut-cadence-electron.log`, `/tmp/persistence-final-session-close-electron.log`, `/tmp/persistence-previous-sessions-electron.log`, `/tmp/persistence-final-singer-autocomplete-electron.log`, `/tmp/persistence-electron-smoke.log`.

Evidências visuais de erro/recuperação: `/tmp/karaoke-persistence-B6EifK/` (1280×800). O teste focado registra também o diretório da última execução em seu log.

## Arquivos desta entrega

- `src/application.ts`: serialização, candidatos privados, confirmação, bloqueio/recuperação, operações compostas e barreira de fechamento.
- `src/state-repository.ts`: resultados, reconciliação, retry limitado e bloqueio de escrita incerta.
- `database.ts`: proteção de leitura em transação não resolvida e invalidação do cache após falha.
- `main.ts`, `types.d.ts`: coordenação do fechamento e eventos de diagnóstico.
- `src/app.ts`, `src/ui/dom.ts`, `src/style.css`: aviso persistente e recuperação, sem redesenho dos cards.
- `src/ui/queue-interactions.ts`, `src/ui/queue-view.ts`, `src/ui/table-dialog.ts`, `src/ui/app-shell.ts`: handlers aguardando confirmação e feedback compatível.
- `tests/persistence.test.ts`, `tests/persistence-electron.ts`: novos testes de falha e recuperação.
- `tests/application.test.ts`, `tests/round-robin-application.test.ts`, `tests/round-robin-simulation.ts`, `tests/cadence-reset-simulation.ts`: aguardam as novas APIs assíncronas; expectativas das regras preservadas.
- `package.json`: inclusão da suíte unitária e `test:e2e:persistence:headless`.
- Este relatório.

## Limitações e riscos remanescentes

- Validação executada em Linux/Xvfb; build Windows empacotada não foi validada nesta etapa.
- Read-only foi exercitado com SQLite real; disco cheio, permissão, IOERR e perda de IPC foram injetados de forma controlada, sem encher disco nem alterar permissões do perfil real.
- A serialização garante a ordem dentro do controlador/processo do aplicativo. Não implementa coordenação de escritores independentes ou edições externas concorrentes no mesmo arquivo SQLite. Divergências detectadas na recuperação bloqueiam, em vez de sobrescrever, os dados.
- Uma conexão permanentemente indisponível ou transação sem resolução pode exigir reinício/intervenção no armazenamento. Não há retry infinito, reset de fila ou recuperação destrutiva.
- Encerramento forçado pode interromper operações ainda não confirmadas; não é possível prometer durabilidade de dados que nunca receberam commit. O aplicativo restaura os dados efetivamente persistidos, sem inventar conclusão/encerramento.
- Snapshots continuam incluindo o estado carregado; não foi introduzida uma refatoração para comandos SQL individuais ou paginação de histórico.
- E2E completo não passou integralmente; a falha sintética conhecida foi mantida separada dos testes focados aprovados.
