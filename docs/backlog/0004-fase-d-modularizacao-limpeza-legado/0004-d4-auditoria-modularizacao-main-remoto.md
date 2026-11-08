# 0004/0004 — D4: Auditoria e modularização orientada à comunicação remota

## Identificação

- Ticket: 0004/0004
- Ticket pai: 0004 — Fase D: Auditoria, limpeza e modularização do Main
- Etapa canônica: D4
- Status: D4.1 concluída; D4.2 aprovada pelo proprietário; D4.3 concluída (lotes 1–8); D5 automatizada PASS e validação manual aprovada pelo proprietário; Fase D concluída e aprovada em 2026-11-07.
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Reduzir o acoplamento entre a composição Electron e os serviços operacionais por meio de uma modularização incremental do Main, preparando fronteiras para a futura comunicação segura da Fase G. O Main continuará sendo o composition root.

A modularização deverá preservar as autoridades atuais de playback, sequência Standalone, Gestão/Combined, persistência e lifecycle. Ela não cria um segundo serviço de playback, uma segunda fila operacional nem uma camada de rede.

**Diretrizes aprovadas pelo proprietário:** filosofia C incremental; `main.ts` permanece composition root; responsabilidades extraídas têm ownership/dependências/lifecycle claros; transporte HTTPS/WSS futuro fica isolado das regras; adapters locais e remotos reutilizam autoridades/casos de uso existentes; evitar abstração especulativa/refatoração sem benefício demonstrável. Na decisão inicial, esses princípios ainda não autorizavam extrações; a aprovação formal posterior da D4.2 e dos oito lotes está registrada abaixo.

## Subetapas e gates

### D4.1 — Auditoria das responsabilidades do Main

- Partir do código estabilizado após D3 e identificar responsabilidades, consumidores, ownership de recursos, ordem de startup/shutdown e contratos IPC/eventos.
- Auditar composição por modo, validação de remetentes, fronteiras Main/Preload/Renderer, janelas/foco, playback/recovery e persistência.
- Identificar quais responsabilidades podem ser extraídas, quais devem permanecer no composition root e quais precisam de mais evidência.
- Produzir evidências e riscos sem alterar código.
- Responder explicitamente como a fronteira de aplicação permitirá executar os mesmos casos de uso locais/remotos sem depender de uma janela Renderer aberta.
- Avaliar como padronizar segurança/autorização de handlers IPC e manter uma fronteira de identidade/autorização própria para dispositivos remotos.
- Definir alternativas para separar recebimento, validação, autorização, execução, confirmação e publicação; resultados publicados precisam corresponder a operações realmente executadas/confirmadas.
- Avaliar necessidade, ownership e alternativas de Outbox/Journal para eventos após falhas ou reinicializações, distinguindo-os do journal de recovery de playback existente.

### D4.2 — Proposta detalhada de separação

- Apresentar árvore/módulos-alvo, contratos internos, consumidores, ownership e sequência de extração.
- Distinguir fronteiras que D4 pode preparar de decisões e implementações reservadas a G/H.
- Incluir efeitos sobre build, Preloads, IPC, testes, empacotamento, segurança, diagnósticos e rollback.
- Comparar alternativas de aplicação host (Main, Renderer ou outro owner), APIs internas compartilhadas por IPC/transporte, sem duplicar `KaraokeApplication` ou contornar invariantes.
- Apresentar alternativas de publicação confiável (snapshot/reconciliação, Outbox transacional, Journal separado ou estado efêmero), com garantias, dependências de persistência, falhas cobertas e custos. Não escolher schema ou política antes das decisões de G/H.
- Submeter a proposta à aprovação explícita do proprietário.

**Gate cumprido:** em 2026-11-07 o proprietário aprovou a proposta D4.2, todos os oito lotes e os requisitos adicionais. D4.3 está autorizada. Não implementar rede, Outbox/Journal, decisões de produto G/H, V1 ou Doop.

### D4.3 — Implementação incremental da proposta aprovada

- Implementar apenas os lotes aprovados, um grupo coeso por vez, preservando assinaturas e comportamento observável.
- Manter Main responsável por composição e coordenação geral; evitar módulos que importem estado global do Main ou dependências circulares.
- Fazer interfaces estreitas entre transporte futuro, validação/autorização, serviços de aplicação, playback, Gestão, persistência e publicação de eventos. Não implementar o transporte futuro nesta etapa.
- Após cada lote, compilar e executar os testes diretamente afetados; revisar lifecycle, IPC, logs e recursos liberados antes do lote seguinte.
- Registrar evidência e rollback para cada lote; interrupção por regressão impede avançar ao lote subsequente.

## Fronteiras e invariantes

- A futura camada de rede não acessa DOM, `BrowserWindow`, `ipcMain`, SQLite ou regras de fila diretamente.
- Comandos locais e remotos futuros devem usar autoridades/serviços de aplicação apropriados; IPC e transporte são adaptadores de entrada separados.
- Gestão permanece autoridade da fila operacional e publica alteração persistida somente após confirmação da escrita.
- A sequência Standalone permanece domínio independente e volátil; playback/recovery reaproveita os serviços atuais, sem uma segunda engine ou fila.
- A conexão e sua falha não devem alterar por si só fila, sequência local, reprodução, sessão ou estado confirmado.
- Validar remetente, esquema, autorização e limites antes da execução; manter APIs Preload restritas e fronteiras Electron atuais.
- Não decidir nesta etapa autoridade pós-reconexão, transferência de controle, conflito entre controles locais/remotos, sincronização de estado não confirmado, número de Players ou retomada após desconexão longa.

## Dependências

- D1 concluída, incluindo D1.4.
- D2 e a campanha D3 concluídas antes de iniciar D4.1.
- D4.1 e D4.2 concluídas com proposta detalhada antes da aprovação de D4.2.
- D3 concluída e aprovada pelo proprietário; D4.2 aprovada explicitamente em 2026-11-07 antes do início de D4.3.
- D5 é obrigatória após D4.3 e antes da Fase E.

## Critérios de conclusão

- D4.1 documenta composição, autoridades, consumidores, ciclo de vida, IPC, eventos, persistência e riscos com referências ao código real.
- D4.1/D4.2 respondem os quatro requisitos adicionais: aplicação sem janela Renderer, segurança/autorização IPC e fronteira remota, execução/confirmados/publicação, avaliação de Outbox/Journal.
- D4.2 apresenta alternativas, responsabilidades, dependências, riscos e benefícios; identifica o que depende de aprovação de G/H.
- D4.2 entrega uma proposta concreta, incremental e revisável; sua aprovação é registrada sem inferência.
- D4.3, se autorizada, preserva comportamento, contratos, autoridades e recursos; os lotes e suas regressões estão validados.
- Não há implementação HTTPS/WSS, pairing, autenticação de dispositivo, protocolo remoto ou resolução de política de produto em D4.
- A campanha D5 é executada e aprovada separadamente antes de E.

## Testabilidade prevista

- Testes unitários de registro/composição e adapters com dependências falsas, sem inicialização obrigatória do Electron.
- Testes de integração de Main/Preload/IPC real para autorização de origem, frame e payload.
- Testes Electron/Playwright de produção para Gestão e Standalone, com perfis isolados; MP4 real e SQLite isolado onde playback/persistência forem afetados.
- Testes de transporte, rede, mensagens perdidas/duplicadas, ordenação e autorização pertencem à Fase G quando houver implementação real; D4 não cria mocks/stubs que simulem uma rede ainda inexistente.

## Histórico

Registro anterior: a análise preparatória anexada à D1 era contexto inicial e não concluía D4.1/D4.2.

Em 2026-11-07, o proprietário autorizou explicitamente executar D4.1 e D4.2 em sequência, informou D2/D3 executadas e validação manual de Player/Combined no Windows pelo launcher oficial. A auditoria formal e a proposta estão nas seções 14–23 do documento técnico referenciado abaixo. Em autorização posterior, aprovou a proposta, incluindo os lotes 1–8, e autorizou D4.3 seguida por D5 sem gates intermediários.

## Referências

- [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)
- [Preparação arquitetural Main/rede para D4 e G](../../d4-main-remote-architecture-preparation.md)
- [Auditoria e proposta D1](../../d1-src-audit-and-proposal.md)
- [Arquitetura Remote Player](../../remote-player-architecture.md)
- [Player Playback](../../player-playback.md)
- [SQLite persistence safety](../../sqlite-persistence-safety.md)
- [Windows native testing](../../windows-native-testing.md)


## Resultado D4.1/D4.2 — 2026-11-07

- Baseline: branch feature/remote-player-lan-integration, HEAD 5cd541f7a7aa232d73b346e09720c1a5716b4dc7 e working tree preexistente preservado.
- D4.1: concluída por inspeção do Main atual (1.615 linhas), consumidores, Preloads/IPC, aplicação, repository, SQLite, sequência/playback, janelas e caminhos de startup/shutdown.
- Achado principal: src/app.ts instancia KaraokeApplication no Renderer; Main possui SQLite, recebe snapshots e chama funções Renderer para fechamento. Extração de handlers sozinha não resolve aplicação sem janela.
- Outros achados: guards IPC Gestão desiguais; lifecycle distribuído com dependência de idempotência; publicação de snapshots ligada a WebContents; revisão de UI não é cursor durável. Sem exploração externa, perda atual de dados ou ciclo de imports confirmado.
- D4.2: proposta concreta em src atual, mantendo Main composition root. Lotes 1–6 isolam IPC, políticas, factories, runtime e fechamento; lote 7 propõe host único Gestão Main-side com corte conjunto de writer/Preload/cliente/UI e consultas puras compartilhadas; lote 8 consolida. Na proposta original, o lote 7 era apresentado como gate de aprovação; a autorização posterior aprovou explicitamente sua execução integral e corte sem writers simultâneos.
- Avaliada Outbox transacional versus snapshots, eventos efêmeros e Journal separado. Recomendação: não criar schema/journal nesta D4; reservar escolha de garantia de entrega a G/H e manter journal de playback com sua finalidade atual.
- Revisões somente leitura: arquitetura, concorrência/persistência, segurança e QA; achados consolidados na seção 22. Nenhum agente alterou código ou executou testes.
- Entregues árvore, mapa origem/destino, ownership, dependências permitidas, contratos, fluxos local/remoto, confirmação/publicação, plano incremental, rollback por lote e matriz de D5.
- Verificações desta tarefa: integridade documental, links e Git; nenhuma suíte de aplicação executada porque não houve implementação. Resultados finais registrados no documento técnico.
- Registro histórico anterior à aprovação: avaliação explícita D4.2 ainda pendente; filosofia C não equivalia a aprovação das extrações.
- D4.3: não iniciada até a autorização explícita posterior; D5 e fases posteriores não iniciadas naquele registro.

## Registro inicial da execução D4.3 — 2026-11-07 (histórico)

- **D4.2 APROVADA** pelo proprietário, incluindo arquitetura incremental C, todos os lotes, DTOs IPC serializáveis, projeções confirmadas, single-writer Gestão no Lote 7 e não introdução de Outbox/Journal. Decisões HTTPS/WSS e de produto continuam reservadas a G/H.
- **Lote 1 — CONCLUÍDO:** handlers Player extraídos para `src/main-player-ipc.ts`; `main.ts` injeta serviços e mantém composição. Foram preservados canais/gates/resultados e lifecycle. A extração inclui limpeza de registro parcial, dispose idempotente e tipo estreito para fullscreen Standalone.
- Arquivos deste lote: `main.ts`, `src/main-player-ipc.ts`, `tests/main-player-ipc.test.ts`, `package.json` (teste inserido em `test:unit`).
- **PASS:** `npm run compile`; `node build/tests/main-player-ipc.test.js` (4/4); `git diff --check`.
- **NOT RUN:** E2E headless Standalone production sem `KQ_PLAYER_TEST_MEDIA_DIR`; E2E headless operating modes não iniciou Electron/Playwright neste ambiente Linux (`Process failed to launch!`). Não apresentados como validação de produção. Repetir modos reais e Standalone no D5/Windows oficial, com recurso de mídia disponível.
- **Lotes 2–8: ainda não iniciados neste registro histórico.** O resultado posterior da execução completa está documentado abaixo.

## Resultado da execução integral D4.3 — 2026-11-07

Todos os oito lotes aprovados foram implementados em ordem. `main.ts` permaneceu composition root. A migração do lote 7 foi feita como corte coordenado: somente o Main instancia `KaraokeApplication` operacional; Renderer usa cliente de DTOs serializáveis e projeções confirmadas congeladas; não há writer operacional Renderer paralelo nem endpoint de produção `app-data:save/load`.

- **Lote 1 — CONCLUÍDO:** handlers Player em `src/main-player-ipc.ts`, com canais, gates, descarte idempotente e rollback de registro parcial preservados. Testes de registro e dispose passaram.
- **Lote 2 — CONCLUÍDO:** política `src/main-ipc-policy.ts` e handlers Controller em `src/main-controller-ipc.ts`; validação de owner/WebContents, frame principal, URL e capacidade/mode antes de efeitos. Testes negativos confirmam rejeição sem mutação/efeitos.
- **Lote 3 — CONCLUÍDO:** factories Welcome, Gestão e Standalone em `src/main-window-factories.ts`; dimensões, paths, Preloads e preferências de segurança preservados. Testes de opções de janela passaram.
- **Lote 4 — CONCLUÍDO:** composição de mídia em `src/main-media-runtime.ts`, com uma instância por serviço, ownership de recursos adquiridos e descarte/recovery cobertos por teste. Testes focados e integrações de biblioteca, catálogo e playback passaram.
- **Lote 5 — CONCLUÍDO:** coordenação Standalone em `src/main-standalone-shutdown.ts`; saída/cancelamento, drain, estado de playback, recovery e fences validados pelos testes do módulo, IPC de saída e E2E de produção C9.
- **Lote 6 — CONCLUÍDO:** fechamento Gestão em `src/main-management-close.ts`, com portas explícitas e sem `executeJavaScript`; testes focados, session-close e persistência passaram.
- **Lote 7 — CONCLUÍDO:** `src/main-management-host.ts`, `management-contracts.ts`, `management-ipc.ts`, `management-client.ts`, `management-projections.ts` e `persistence-contracts.ts`; `main.ts`, `preload.ts`, `types.d.ts`, `src/app.ts`, `src/application.ts`, `src/state-repository.ts`, UI e build ajustados. O host inicializa sem Renderer, mantém `hostEpoch/revision`, snapshots DTO isolados, idempotência process-local, confirmação após persistência, inscrição antes do snapshot e recuperação do Renderer sem repetir inicialização. Consultas síncronas são projeções puras compartilhadas. Importação localStorage só é limpa após commit confirmado. Testes com SQLite isolado, falha SQLite injetada, retry, concorrência, fechamento e IPC passaram; E2Es reais cobriram importação legada, validação, reload, modos e persistência.
- **Lote 8 — CONCLUÍDO:** removido o adapter auxiliar não utilizado; revisados imports, consumidores, referências de produção e ownership. Não há import de `main.ts` por módulos, referência de production `app-data:save/load`, instância de aplicação no Renderer, Outbox/Journal ou código de rede introduzidos.

**Testes focados dos módulos D4 — PASS:** `npm run compile`; `node --test build/tests/main-player-ipc.test.js build/tests/main-ipc-policy.test.js build/tests/main-controller-ipc.test.js build/tests/main-window-factories.test.js build/tests/main-media-runtime.test.js build/tests/main-standalone-shutdown.test.js build/tests/main-management-close.test.js build/tests/main-management-host.test.js build/tests/main-management-ipc.test.js build/tests/management-client.test.js` (10 arquivos de teste, todos aprovados). A suíte unitária agregada e cada script unitário Standalone também passaram na campanha D5.

**Resultado:** D4.3 concluída. Não foram antecipados HTTPS/WSS, pairing, identidade remota, protocolo, Outbox/Journal, autoridade/reconciliação entre dispositivos, mudanças V1/Doop ou fases E/G/H.
