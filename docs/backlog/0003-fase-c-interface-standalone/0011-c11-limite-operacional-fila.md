# 0003/0011 — C11: Limite operacional da fila

## Identificação

- Ticket: 0003/0011
- Ticket pai: 0003 — Fase C: Interface Standalone
- Etapa canônica: C11
- Status: Concluída e aprovada manualmente pelo proprietário em 2026-11-07, após validação técnica em Linux e Windows nativo. A Fase C continua sem aprovação global devido às pendências independentes de C9.
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Impor limite de 30 músicas pendentes na sequência Standalone, excluindo a música atual, sem alterar a semântica de admissão ou os contratos de playback.

## Escopo

- Aplicar o limite igualmente às entradas por Enter e P.
- Preservar FIFO/LIFO, prioridades, posições e ordem de admissão existentes.
- Serializar admissões concorrentes e preservar a idempotência das tentativas/retries.
- Liberar a vaga após conclusão válida ou remoção de uma pendência.
- Rejeições não podem alterar fila, prioridades, snapshot confirmado, timers ou playback.
- Exibir toast informativo de limite atingido. O proprietário autorizou explicitamente essa exceção visual sem frame Doop; reutilizar o padrão de toast existente e evitar acúmulo.

## Decisões aprovadas

- A capacidade é de até 30 músicas pendentes e não inclui a música atual.
- O limite se aplica a todos os caminhos de admissão cobertos pela interface, sem privilegiar Enter ou P.
- C11 contém exclusivamente o limite operacional da fila. A antiga campanha de performance C11.2–C11.6 foi transferida para H6 e não faz parte deste ticket.
- O toast de limite cheio foi autorizado como exceção à exigência de referência Doop; a autorização não se estende a outros elementos visuais.
- A aprovação manual explícita do proprietário é obrigatória antes de avançar para a Fase D.

## Dependências

- Fase C anterior concluída conforme os critérios do roadmap.
- Não há dependência de frame Doop para o toast especificamente autorizado pelo proprietário.

## Critérios de conclusão

- O limite confirmado é de 30 pendências, com a faixa atual excluída.
- Admissões em validação reservam capacidade na mesma ordem de admissão; o total de pendências confirmadas e vagas reservadas nunca ultrapassa 30.
- Entradas por Enter e P respeitam a mesma capacidade.
- FIFO/LIFO, prioridades, posições protegidas e ordem de admissão não sofrem regressões.
- Admissões concorrentes são serializadas; operações repetidas/retries da mesma intenção preservam idempotência.
- Conclusão válida ou remoção de pendência libera exatamente a capacidade correspondente.
- Rejeição de entrada por capacidade não altera fila, prioridade, snapshot confirmado, timers, estado de playback ou recovery.
- Retry com o mesmo `operationId` retorna o resultado original, inclusive uma rejeição já registrada; uma nova intenção, com novo ID, pode usar a vaga liberada.
- O toast “Fila cheia. O limite é de 30 músicas aguardando.” informa sem modal; novas rejeições substituem o mesmo elemento visual.
- Aprovação manual do proprietário registrada antes da Fase D.

## Validação prevista

- Testar 29, 30 e 31 pendências, incluindo faixa atual em reprodução e pausada.
- Cobrir Enter, P e suas admissões concorrentes; validar retries/repetições, FIFO/LIFO, prioridades e ordem de admissão.
- Verificar liberação de vagas por conclusão válida e remoção de pendência.
- Comparar estado/snapshot/timers/playback antes e depois de rejeições para confirmar ausência de mutação.
- Usar testes unitários para regras puras, integração Main/Sequence/IPC para serialização e idempotência e E2E Electron com SQLite isolado/MP4 quando aplicável.
- Verificar mensagem e coalescência do toast; não atribuir aprovação visual humana ao toast além da autorização explícita de design.

## Riscos

- Contar a faixa atual como pendência pode rejeitar uma admissão válida; confirmá-la fora da capacidade.
- Checagem concorrente antes da serialização pode exceder a capacidade.
- Uma rejeição otimista publicada antes da persistência/validação pode alterar snapshot ou timers indevidamente.

## Histórico de execução

### Implementação e validação técnica — 2026-11-06

- **Regra/autoridade:** `src/standalone-player-sequence.ts` aplica `STANDALONE_PENDING_QUEUE_LIMIT = 30` em `prepareAdmission()`, a autoridade existente da sequência. A checagem acontece antes de criar ticket/entrada, validar mídia, alterar contadores, publicar snapshot ou disparar timers/playback. `entryOrder` inclui pendências e admissões em voo; a faixa atual sai da contagem após o início confirmado. A reserva em voo serializa a disputa pela última vaga.
- **Idempotência e rejeição:** o coordenador Main existente mantém o resultado por `operationId` sem expiração nova. Retry da mesma intenção retorna a rejeição/aceitação já confirmada, mesmo após mudança de capacidade; um novo ID representa outra intenção. Nenhuma persistência, segunda fila, migração, TTL ou autoridade foi criada. A sequência continua volátil conforme seu contrato.
- **Ordem/liberação:** tickets e regras já existentes conservam FIFO normal e LIFO de prioridades. A vaga abre quando uma pendência deixa de ser pendente após início confirmado (incluindo avanço natural/Next); rejeições não removem entradas. Playback atual e recovery não são alterados por rejeição.
- **Toast:** `src/standalone-player-renderer.ts`, `src/standalone-player.html` e `src/standalone-player.css` reutilizam os estilos e ciclo de vida de toast atuais, com texto “Fila cheia. O limite é de 30 músicas aguardando.” e uma única superfície visual. Na entrada de código, a superfície Chromium de vídeo fica oculta pelo fluxo já existente; o aviso aparece no Renderer de controle. O E2E confirma `WebContentsView.getVisible() === false` no momento da captura, enquanto o MP4 continua avançando. Não abre modal nem bloqueia reprodução. A cópia foi autorizada pelo proprietário como exceção Doop; não se registra aprovação visual humana separada do toast.
- **Arquivos de implementação/teste:** `src/standalone-player-contracts.ts`, `src/standalone-player-sequence.ts`, `src/standalone-player-renderer.ts`, `src/standalone-player.html`, `src/standalone-player.css`, `tests/standalone-player-sequence.test.ts` e `tests/standalone-player-production-electron.ts`.
- **Linux — unitários:** `npm run compile` — PASS; `npm run test:unit:standalone-sequence` — PASS (73, incluindo falha de validação após reserva concorrente); `npm run test:unit:standalone-runtime` — PASS (3 contratos, 19 runtime, 35 recovery); `npm run test:unit:standalone-ui` — PASS (45 interação, 12 preview/metadados, 35 IPC, 5 Opções, 25 catálogo); `npm run test:unit` — PASS na suíte completa após a alteração final.
- **Linux — Electron/integração:** `KQ_PLAYER_TEST_MEDIA_DIR='/mnt/c/Users/Chris/Documents/Video musicas e catalogo' npm run test:e2e:standalone-integration:headless` — PASS com Main/Preload/IPC, MP4/Chromium, recovery e SQLite isolados; `...standalone-playback:headless` — PASS, incluindo EOF natural; `...standalone-production:headless` — PASS com o Main real, C9, fila C11, 30 pendências mais faixa atual, rejeição Enter/P, snapshot imutável, MP4 ativo, shutdown/recovery, restart sem fila e sem processos residuais. O E2E captura o toast no controle e confirma a superfície de vídeo oculta no instante do aviso. O Electron não iniciou na tentativa dentro do sandbox Codex (`sandbox_host_linux: Operation not permitted`); o mesmo comando passou pela via de execução aprovada, sem alterar as assertions.
- **Suíte integrada:** o E2E `standalone-production` também contém as assertions históricas de responsividade C10; foram exercitadas incidentalmente pelo fluxo de produção, sem CSS/layout alterados e sem reabrir C10.
- **Sincronismo do teste de playback:** uma primeira rodada Windows falhou porque o teste amostrou `currentTime` antes do próximo tick de mídia, com `paused=false`. A observação foi sincronizada com o helper existente e passou a exigir avanço de pelo menos 0,1 s tanto antes quanto durante as rejeições; a assertion não foi reduzida. Linux observou avanço de `0,229079` para `0,430099` s.
- **Windows nativo:** `KARAOKE_QUEUE_WIN_CHECKOUT='E:\source\karaoke-queue-win-c11-validation-05' KQ_PLAYER_TEST_MEDIA_DIR='C:\Users\Chris\Documents\Video musicas e catalogo' WSLENV='VSCODE_WSL_EXT_LOCATION/up:KARAOKE_QUEUE_WIN_CHECKOUT/w:KQ_PLAYER_TEST_MEDIA_DIR/w' npm run test:e2e:multi-instance:windows -- --approve-untracked --standalone-production` — PASS pelo runner oficial no clone NTFS novo `E:\source\karaoke-queue-win-c11-validation-05`, preservando o checkout divergente anterior. Compilação nativa, testes de runtime/sequence/IPC/recovery, Electron/Playwright, MP4, SQLite isolado, E2E Main real e cleanup passaram. Snapshot `branch=feature/remote-player-lan-integration`, `HEAD=1404da0d55fb2672cccab065f8af5df0cfa05e5d`, fingerprint `4e947535837535c70cb91887189af57b565be986dc63158eb037aa9f0896bd5e`. O MP4 avançou de `0,263037` para `0,601784` s durante as rejeições. O runner confirmou ausência de processos residuais e cleanup. Uma tentativa anterior parou antes do E2E por falta de `KQ_PLAYER_TEST_MEDIA_DIR`; foi corrigido apenas o encaminhamento do caminho no retry.
- **Capturas:** Linux `/tmp/karaoke-queue-standalone-production-screenshots-71573/c11-full-queue-toast-1280x800.png` e `c11-full-queue-toast-element.png`; Windows `C:\Users\Chris\AppData\Local\Temp\karaoke-queue-standalone-production-screenshots-18164\c11-full-queue-toast-1280x800.png` e `c11-full-queue-toast-element.png`. As capturas foram inspecionadas; mostram a mensagem no topo da superfície de controle, com metadados da faixa ativa.
- **Abrangência confirmada:** 29 pendências aceitam a 30ª; 30 rejeitam a 31ª em Enter e P, incluindo admissões simultâneas; current não é contado; prioridades FIFO/LIFO permanecem; retry preserva o resultado; nova intenção usa vaga liberada após EOF natural; rejeição preserva snapshot/playback; shutdown mantém recuperação `stopped/shutdown-confirmed`, não cria EOF artificial e o restart não recupera a fila volátil.
- **Revisão independente:** arquitetura e concorrência confirmaram que a Sequence é a autoridade única e que `entryOrder` reserva as vagas durante validações em voo. O code review não encontrou defeitos acionáveis; observou que uma intenção concorrente pode receber rejeição enquanto a última vaga está reservada por outra validação que depois falha. Um teste adicional agora comprova que a falha libera a vaga para uma nova intenção, sem reprocessar o `operationId` rejeitado.
- **C9 separada:** o E2E integrado voltou a passar, mas isso não declara aprovação humana de C9. Alt+F4 físico continua NOT RUN; as pendências visuais C9.2/C9.5 permanecem independentes.
- **Status na entrega da implementação — 2026-11-06:** C11 estava implementada e tecnicamente validada; aguardava a aprovação manual antes de D. A campanha de performance transferida a H6 não foi iniciada.

### Encerramento e aprovação — 2026-11-07

- O proprietário confirmou que testou e compilou a versão sincronizada no Windows, reportou resultado satisfatório e autorizou registrar C11 como concluída. Essa confirmação encerra a aprovação manual específica da C11; não aprova a Fase C inteira nem as pendências de C9.
- No mesmo snapshot, o runner oficial `npm run test:e2e:multi-instance:windows -- --approve-untracked --standalone-production` — PASS em checkout NTFS `E:\source\karaoke-queue-win-c11-validation-05`, com Node/npm/Electron/Playwright Windows nativos, MP4 real, SQLite/perfil isolados e Main de produção. O fingerprint validado foi `6397b8bbee4813726145edc88fee3d463a300b2ba3e643a8e4b7d0aa069725f2`; compilação, E2E, limpeza de perfil e ausência de processos residuais passaram. O E2E integrou as regressões C9, C10 e C11, inclusive playback ativo durante toast de fila cheia. `WINDOW_FOCUS NOT APPLICABLE` era esperado para o modo focado; não é evidência de teclado físico.
- O proprietário reportou também que a alteração pontual do atalho de fullscreen foi compilada e testada. No Standalone, somente F11 altera fullscreen; Esc continua controlando o menu. A alteração pertence ao registro técnico de playback/C9 e não altera a regra nem a autoridade da fila C11.
- Status final: C11 concluída e aprovada manualmente; C10 concluída e aprovada conforme registrado em seu ticket; Fase C ainda não aprovada globalmente enquanto C9 permanecer pendente. H6 continua futura e não foi iniciada.

## Referências

- [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)
- [Planejamento da interface Standalone](../../standalone-player-ui-plan.md)
- [Reprodução local Chromium](../../player-playback.md)
- [Biblioteca local de vídeos](../../video-library.md)
