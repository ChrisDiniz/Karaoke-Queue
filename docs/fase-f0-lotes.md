# F0 — Lotes executáveis

> **Encerramento vigente — 2026-11-11:** Fase F, incluindo F0 e suas subdivisões, concluída e validada pelo proprietário. [Registro consolidado](fase-f-encerramento.md). Este documento preserva contratos, planejamento e evidências históricas; menções a homologação pendente ou F1–F4 não iniciadas estão superadas pelo aceite. Classificações técnicas e lacunas de evidência permanecem inalteradas. Prompts e gates históricos não autorizam novas execuções.

P1/P2/P3 estão aprovadas. O proprietário autorizou executar F0-01→F0-07 em sequência, com avanço automático após os gates técnicos; não é necessária confirmação entre lotes. Novos elementos visuais e pré-requisitos externos continuam sujeitos aos gates específicos. Contratos completos no [diagnóstico](fase-f0-diagnostico-arquitetura.md), oráculos e comandos na [matriz](fase-f0-testes.md). A matriz é canônica; as referências abaixo selecionam o recorte por lote, não todos os oráculos futuros.

## F0-01 — Instrumentação e baseline

1. **Identificador:** F0-01, subdivisão do ticket 0006/0000.
2. **Objetivo:** Medir A/B/D/E antes de alterar comportamento.
3. **Problema:** Medir A/B/D/E antes de alterar comportamento; ver evidências A–E do diagnóstico.
4. **Evidências:** funções e condições comprovadas no diagnóstico; hipóteses físicas permanecem abertas até F0-01.
5. **Dependências:** nenhuma dependência técnica; autorização explícita do lote.
6. **Arquivos de responsabilidade:** main-runtime.ts; src/main-media-runtime.ts; src/video-library-service.ts; src/logging.ts; tests/standalone-player-production-electron.ts. Não editar outros módulos sem rastrear consumidor e justificar no ticket.
7. **Contratos:** V1, códigos sem zeros na entrada/canônico cinco dígitos, CSV opcional; uma sequência Main, IPC restrito; SQLite e Gestão preservados.
8. **Solução escolhida:** seguir arquitetura do diagnóstico e a sequência seguinte; somente gate remanescente interrompe o trecho dependente.
9. **Sequência de implementação:** Adicionar marcas opt-in de fase e contadores agregados; capturar condição recovery sem conteúdo pessoal; executar matriz baseline; anexar resultados e propor metas, sem mudar startup.
10. **Estados/transições:** testar apenas recorte exigível do lote na matriz; antes de editar anotar snapshot anterior, evento, confirmação exigida e snapshot posterior. Não equiparar idle visual a ready operacional.
11. **Erros/extremos:** falha fs, permissão, desconexão, corrupção, shutdown no await e falha de persistência; jamais converter erro em sucesso/vazio.
12. **Concorrência/cancelamento/idempotência:** preservar coordenação existente; aplicar generation/epochs, tentativa e operationId apenas ao componente implementado neste lote, conforme arquitetura. Instrumentação 01 só observa: não cria scanner, store, cancelamento ou sonda futuros. Publicação de persistência somente após confirmação.
13. **Entrada:** Sem dependência técnica; autorização global F0 já concedida. Criar fixtures locais 1k/5k/9k e identificar versão/condição.
14. **B — cobertura e PASS exigível:** INS-01–03; A: logging, main-media-runtime e production nos contratos atuais. Unitários verificam regra; integração usa FS/SQLite reais conforme matriz; grupos E usam Electron/IPC reais. Base A aplicável permanece PASS, sem alegar cobertura nova existente.
15. **C — caracterização:** C: PLAY-01, REC-01/02, LIB-02, E02/E03/E06/E07, AV-01, BUF-02; registrar falhas existentes, sem exigir correção.
16. **D — adiado:** Todos os oráculos funcionais LIB/REC/PLAY/AV/BUF/DATA/E futuros são D até os lotes da matriz. Não implementar componente futuro para antecipar seu teste.
17. **E — regressão:** executar grupos/recortes dos predecessores realmente integrados/afetados, conforme coluna Regressão da matriz; repetir tudo em 07. Em 04 independente, 02/03 ainda não integrados são DEFERRED, não FAIL.
18. **Windows/externos:** usar variante do runner oficial correspondente ao componente (produção/playback/opções/recovery). W/H/PK/V seguem política de transferência explícita da matriz até 07. Nenhum PASS físico por mock. Teste local obrigatório ausente mantém validação local incompleta.
19. **Saída objetiva:** PASS INS-01–03 locais, baseline e contadores auditáveis, instrumentação desligável e sem efeito funcional, registros separados de defeitos conhecidos. Não exigir índice, startup leve, recovery corrigido ou sondas. Ao satisfazer o gate e registrar evidências, liberar F0-02 automaticamente.
20. **Comandos reais focados:** compile; node build/tests/logging.test.js; node build/tests/main-media-runtime.test.js; npm run test:e2e:standalone-production:headless. Compilar antes de Node direto; scripts npm unit/e2e já compilam quando definido no package.json. Não executar testes novos inexistentes como se já existissem.
21. **Bloqueio e PASS/FAIL:** aplicar política canônica da matriz; assertion do lote falsa é FAIL, dependência futura é DEFERRED, ambiente ausente é NOT RUN específico. Custo e causa física permanecem abertos; W/H indisponíveis transferem evidência a 07, não bloqueiam aceite local da instrumentação.
22. **Evidências obrigatórias:** diff, IDs/variantes/classes/resultados separados, comandos/exit codes, logs sanitizados, dados antes/depois, fingerprint Windows quando executado, NOT RUN com destino/responsável; resultado funcional/visual/técnico separado. Defeito antigo documentado na baseline não recebe PASS funcional.
23. **Riscos e aprovações:** preservar V1, códigos/CSV, FIFO/LIFO/30 pendentes, timers, persistência e guardas; não alterar dados reais nem writer Gestão. P1/P2/P3 não são gates pendentes. Gate humano restante: lote/aceite, elemento Doop novo, acesso/instalação externa ou revisão de arquitetura por inviabilidade demonstrada.

## F0-02 — Política de startup e recovery Standalone

1. **Identificador:** F0-02, subdivisão do ticket 0006/0000.
2. **Objetivo:** Eliminar bloqueio entre execuções sem restaurar mídia.
3. **Problema:** Eliminar bloqueio entre execuções sem restaurar mídia; ver evidências A–E do diagnóstico.
4. **Evidências:** funções e condições comprovadas no diagnóstico; hipóteses físicas permanecem abertas até F0-01.
5. **Dependências:** 01; P1 aprovada.
6. **Arquivos de responsabilidade:** src/player-playback-recovery.ts; src/player-playback-recovery-store.ts; src/standalone-player-runtime.ts; src/main-media-runtime.ts; tests/player-playback-recovery.test.ts. Não editar outros módulos sem rastrear consumidor e justificar no ticket.
7. **Contratos:** V1, códigos sem zeros na entrada/canônico cinco dígitos, CSV opcional; uma sequência Main, IPC restrito; SQLite e Gestão preservados.
8. **Solução escolhida:** seguir arquitetura do diagnóstico e a sequência seguinte; somente gate remanescente interrompe o trecho dependente.
9. **Sequência de implementação:** Introduzir política explícita Standalone mantendo default compartilhado; preservar evidências com protocolo existente; resolver registro antigo antes de comandos; startup sem mídia; testar kill em cada ponto da escrita; falha de preservação continua bloqueada.
10. **Estados/transições:** testar apenas recorte exigível do lote na matriz; antes de editar anotar snapshot anterior, evento, confirmação exigida e snapshot posterior. Não equiparar idle visual a ready operacional.
11. **Erros/extremos:** falha fs, permissão, desconexão, corrupção, shutdown no await e falha de persistência; jamais converter erro em sucesso/vazio.
12. **Concorrência/cancelamento/idempotência:** preservar coordenação existente; aplicar generation/epochs, tentativa e operationId apenas ao componente implementado neste lote, conforme arquitetura. Instrumentação 01 só observa: não cria scanner, store, cancelamento ou sonda futuros. Publicação de persistência somente após confirmação.
13. **Entrada:** 01 tecnicamente validado/aceito; P1 já aprovada; autorização de 02.
14. **B — cobertura e PASS exigível:** REC-01–04 e E07; recortes E06-startup e DATA-01-recovery. Unitários verificam regra; integração usa FS/SQLite reais conforme matriz; grupos E usam Electron/IPC reais. Base A aplicável permanece PASS, sem alegar cobertura nova existente.
15. **C — caracterização:** C opcional: bloqueio paused anterior capturado em 01; não repetir campanha grande.
16. **D — adiado:** E06 completo em 03; LIB/AV/cache e DATA-01 completo em 07. Não implementar componente futuro para antecipar seu teste.
17. **E — regressão:** executar grupos/recortes dos predecessores realmente integrados/afetados, conforme coluna Regressão da matriz; repetir tudo em 07. Em 04 independente, 02/03 ainda não integrados são DEFERRED, não FAIL.
18. **Windows/externos:** usar variante do runner oficial correspondente ao componente (produção/playback/opções/recovery). W/H/PK/V seguem política de transferência explícita da matriz até 07. Nenhum PASS físico por mock. Teste local obrigatório ausente mantém validação local incompleta.
19. **Saída objetiva:** Startup seguro em cada fase testada, sem autoplay/fila inferida; evidência e dados preservados; falha de persistência continua protegida. Ao satisfazer o gate e registrar evidências, liberar F0-03 automaticamente.
20. **Comandos reais focados:** npm run test:unit:standalone-runtime; node build/tests/player-playback-recovery.test.js; npm run test:e2e:player-recovery:headless; npm run test:e2e:standalone-production:headless. Compilar antes de Node direto; scripts npm unit/e2e já compilam quando definido no package.json. Não executar testes novos inexistentes como se já existissem.
21. **Bloqueio e PASS/FAIL:** aplicar política canônica da matriz; assertion do lote falsa é FAIL, dependência futura é DEFERRED, ambiente ausente é NOT RUN específico. Crash real de processo não comprova BSOD; não mudar default compartilhado. Regressão do store e Gestão por impacto.
22. **Evidências obrigatórias:** diff, IDs/variantes/classes/resultados separados, comandos/exit codes, logs sanitizados, dados antes/depois, fingerprint Windows quando executado, NOT RUN com destino/responsável; resultado funcional/visual/técnico separado. Defeito antigo documentado na baseline não recebe PASS funcional.
23. **Riscos e aprovações:** preservar V1, códigos/CSV, FIFO/LIFO/30 pendentes, timers, persistência e guardas; não alterar dados reais nem writer Gestão. P1/P2/P3 não são gates pendentes. Gate humano restante: lote/aceite, elemento Doop novo, acesso/instalação externa ou revisão de arquitetura por inviabilidade demonstrada.

## F0-03 — Convergência e resolução de falhas de tentativa

1. **Identificador:** F0-03, subdivisão do ticket 0006/0000.
2. **Objetivo:** Impedir bloqueio runtime sem saída segura.
3. **Problema:** Impedir bloqueio runtime sem saída segura; ver evidências A–E do diagnóstico.
4. **Evidências:** funções e condições comprovadas no diagnóstico; hipóteses físicas permanecem abertas até F0-01.
5. **Dependências:** 02; P2 aprovada; somente elemento visual novo exige Doop.
6. **Arquivos de responsabilidade:** src/standalone-player-sequence.ts; src/standalone-player-runtime.ts; src/player-playback-service.ts; src/chromium-playback-host.ts; src/standalone-player-ipc.ts; src/standalone-player-renderer.ts. Não editar outros módulos sem rastrear consumidor e justificar no ticket.
7. **Contratos:** V1, códigos sem zeros na entrada/canônico cinco dígitos, CSV opcional; uma sequência Main, IPC restrito; SQLite e Gestão preservados.
8. **Solução escolhida:** seguir arquitetura do diagnóstico e a sequência seguinte; somente gate remanescente interrompe o trecho dependente.
9. **Sequência de implementação:** Mapear cada reserva/terminal; adicionar resolução correlacionada por tentativa/epoch; conter host antes de liberar; cancelar timers/grants; preservar head após falha da próxima; limitar host readiness; publicar snapshot convergente; usar UI apenas aprovada.
10. **Estados/transições:** testar apenas recorte exigível do lote na matriz; antes de editar anotar snapshot anterior, evento, confirmação exigida e snapshot posterior. Não equiparar idle visual a ready operacional.
11. **Erros/extremos:** falha fs, permissão, desconexão, corrupção, shutdown no await e falha de persistência; jamais converter erro em sucesso/vazio.
12. **Concorrência/cancelamento/idempotência:** preservar coordenação existente; aplicar generation/epochs, tentativa e operationId apenas ao componente implementado neste lote, conforme arquitetura. Instrumentação 01 só observa: não cria scanner, store, cancelamento ou sonda futuros. Publicação de persistência somente após confirmação.
13. **Entrada:** 02 aceito; autorização de 03; P2 aprovada, Doop só para elemento novo.
14. **B — cobertura e PASS exigível:** PLAY-01–05, E06/E08/E09; recortes E05-runtime, E10-técnico e DATA-01-runtime. Unitários verificam regra; integração usa FS/SQLite reais conforme matriz; grupos E usam Electron/IPC reais. Base A aplicável permanece PASS, sem alegar cobertura nova existente.
15. **C — caracterização:** Comparar falha antiga caracterizada com nova contenção; sem novo requisito de desempenho.
16. **D — adiado:** Detecção USB e E05/E10 completos em 06; BUF/DATA completos em 07. Não implementar componente futuro para antecipar seu teste.
17. **E — regressão:** executar grupos/recortes dos predecessores realmente integrados/afetados, conforme coluna Regressão da matriz; repetir tudo em 07. Em 04 independente, 02/03 ainda não integrados são DEFERRED, não FAIL.
18. **Windows/externos:** usar variante do runner oficial correspondente ao componente (produção/playback/opções/recovery). W/H/PK/V seguem política de transferência explícita da matriz até 07. Nenhum PASS físico por mock. Teste local obrigatório ausente mantém validação local incompleta.
19. **Saída objetiva:** Falhas de start recuperáveis, head preservado, mídia contida antes de liberar, eventos antigos inofensivos e guards corretas. Ao satisfazer o gate e registrar evidências, liberar F0-04 automaticamente.
20. **Comandos reais focados:** npm run test:unit:standalone-sequence; npm run test:unit:standalone-runtime; npm run test:unit:standalone-ipc; node build/tests/player-playback.test.js; node build/tests/chromium-playback-host.test.js; npm run test:e2e:standalone-integration:headless; npm run test:e2e:standalone-production:headless. Compilar antes de Node direto; scripts npm unit/e2e já compilam quando definido no package.json. Não executar testes novos inexistentes como se já existissem.
21. **Bloqueio e PASS/FAIL:** aplicar política canônica da matriz; assertion do lote falsa é FAIL, dependência futura é DEFERRED, ambiente ausente é NOT RUN específico. Incerteza não é sucesso. Se UI nova indispensável não tiver frame, manter somente essa entrega aguardando aprovação, continuar núcleo técnico.
22. **Evidências obrigatórias:** diff, IDs/variantes/classes/resultados separados, comandos/exit codes, logs sanitizados, dados antes/depois, fingerprint Windows quando executado, NOT RUN com destino/responsável; resultado funcional/visual/técnico separado. Defeito antigo documentado na baseline não recebe PASS funcional.
23. **Riscos e aprovações:** preservar V1, códigos/CSV, FIFO/LIFO/30 pendentes, timers, persistência e guardas; não alterar dados reais nem writer Gestão. P1/P2/P3 não são gates pendentes. Gate humano restante: lote/aceite, elemento Doop novo, acesso/instalação externa ou revisão de arquitetura por inviabilidade demonstrada.

## F0-04 — Store persistente do inventário

1. **Identificador:** F0-04, subdivisão do ticket 0006/0000.
2. **Objetivo:** Evitar perder índice em restart.
3. **Problema:** Evitar perder índice em restart; ver evidências A–E do diagnóstico.
4. **Evidências:** funções e condições comprovadas no diagnóstico; hipóteses físicas permanecem abertas até F0-01.
5. **Dependências:** 01; contrato JSON aprovado em P3; independente de 02/03.
6. **Arquivos de responsabilidade:** src/video-library-service.ts; src/video-library-configuration.ts; novo src/video-library-index-store.ts; tests/video-library.test.ts; novo teste de store. Não editar outros módulos sem rastrear consumidor e justificar no ticket.
7. **Contratos:** V1, códigos sem zeros na entrada/canônico cinco dígitos, CSV opcional; uma sequência Main, IPC restrito; SQLite e Gestão preservados.
8. **Solução escolhida:** seguir arquitetura do diagnóstico e a sequência seguinte; somente gate remanescente interrompe o trecho dependente.
9. **Sequência de implementação:** Implementar schema documentado e limites; fingerprint; leitura sem abrir mídia; escrita atômica somente de geração completa; preservar cache inválido como miss; não integrar startup ainda; testes de falha/rename e roundtrip.
10. **Estados/transições:** testar apenas recorte exigível do lote na matriz; antes de editar anotar snapshot anterior, evento, confirmação exigida e snapshot posterior. Não equiparar idle visual a ready operacional.
11. **Erros/extremos:** falha fs, permissão, desconexão, corrupção, shutdown no await e falha de persistência; jamais converter erro em sucesso/vazio.
12. **Concorrência/cancelamento/idempotência:** preservar coordenação existente; aplicar generation/epochs, tentativa e operationId apenas ao componente implementado neste lote, conforme arquitetura. Instrumentação 01 só observa: não cria scanner, store, cancelamento ou sonda futuros. Publicação de persistência somente após confirmação.
13. **Entrada:** 01 aceito e autorização 04; P3 JSON aprovada; não depende de 02/03.
14. **B — cobertura e PASS exigível:** LIB-01; recortes store LIB-02–06 e DATA-01-store. Unitários verificam regra; integração usa FS/SQLite reais conforme matriz; grupos E usam Electron/IPC reais. Base A aplicável permanece PASS, sem alegar cobertura nova existente.
15. **C — caracterização:** Medir parse/serialize/bytes/memória do snapshot 9k; baseline anterior não tinha índice.
16. **D — adiado:** LIB-02–06 completos em 05/06; zero exigência de bootstrap/E2E playback por cache antes de 05. Não implementar componente futuro para antecipar seu teste.
17. **E — regressão:** executar grupos/recortes dos predecessores realmente integrados/afetados, conforme coluna Regressão da matriz; repetir tudo em 07. Em 04 independente, 02/03 ainda não integrados são DEFERRED, não FAIL.
18. **Windows/externos:** usar variante do runner oficial correspondente ao componente (produção/playback/opções/recovery). W/H/PK/V seguem política de transferência explícita da matriz até 07. Nenhum PASS físico por mock. Teste local obrigatório ausente mantém validação local incompleta.
19. **Saída objetiva:** Roundtrip válido, cache miss seguro, fingerprint correto, escrita atômica só de geração completa e nenhum efeito em DB/config; startup permanece igual. Ao satisfazer o gate e registrar evidências, liberar F0-05 automaticamente.
20. **Comandos reais focados:** npm run compile; node build/tests/video-library.test.js; teste novo de store deve ser criado/registrado/executado neste lote, sem inventar script preexistente. Compilar antes de Node direto; scripts npm unit/e2e já compilam quando definido no package.json. Não executar testes novos inexistentes como se já existissem.
21. **Bloqueio e PASS/FAIL:** aplicar política canônica da matriz; assertion do lote falsa é FAIL, dependência futura é DEFERRED, ambiente ausente é NOT RUN específico. Store isolado não tem janela: E2E de startup é DEFERRED 05. Integração FS real e falhas de escrita são obrigatórias; permissões nativas W transferíveis a 07.
22. **Evidências obrigatórias:** diff, IDs/variantes/classes/resultados separados, comandos/exit codes, logs sanitizados, dados antes/depois, fingerprint Windows quando executado, NOT RUN com destino/responsável; resultado funcional/visual/técnico separado. Defeito antigo documentado na baseline não recebe PASS funcional.
23. **Riscos e aprovações:** preservar V1, códigos/CSV, FIFO/LIFO/30 pendentes, timers, persistência e guardas; não alterar dados reais nem writer Gestão. P1/P2/P3 não são gates pendentes. Gate humano restante: lote/aceite, elemento Doop novo, acesso/instalação externa ou revisão de arquitetura por inviabilidade demonstrada.

## F0-05 — Startup leve e reconciliação incremental

1. **Identificador:** F0-05, subdivisão do ticket 0006/0000.
2. **Objetivo:** Retirar scan pesado do caminho crítico.
3. **Problema:** Retirar scan pesado do caminho crítico; ver evidências A–E do diagnóstico.
4. **Evidências:** funções e condições comprovadas no diagnóstico; hipóteses físicas permanecem abertas até F0-01.
5. **Dependências:** 03,04; P3 aprovada.
6. **Arquivos de responsabilidade:** src/main-media-runtime.ts; main-runtime.ts; src/video-library-service.ts; src/player-playback-service.ts; src/player-media-protocol.ts; src/music-catalog-service.ts; tests/main-media-runtime.test.ts. Não editar outros módulos sem rastrear consumidor e justificar no ticket.
7. **Contratos:** V1, códigos sem zeros na entrada/canônico cinco dígitos, CSV opcional; uma sequência Main, IPC restrito; SQLite e Gestão preservados.
8. **Solução escolhida:** seguir arquitetura do diagnóstico e a sequência seguinte; somente gate remanescente interrompe o trecho dependente.
9. **Sequência de implementação:** Carregar cache; criar UI/host/IPC antes de reconciliar; separar elegibilidade cache/raiz de scanStatus; adaptar validações revision do protocolo sem invalidar stream ativo por revisão não relacionada; um coordenador cancelável; reutilizar metadados inalterados; reconciliar enumeração sem opens desnecessários; pausar scan no loading/playback.
10. **Estados/transições:** testar apenas recorte exigível do lote na matriz; antes de editar anotar snapshot anterior, evento, confirmação exigida e snapshot posterior. Não equiparar idle visual a ready operacional.
11. **Erros/extremos:** falha fs, permissão, desconexão, corrupção, shutdown no await e falha de persistência; jamais converter erro em sucesso/vazio.
12. **Concorrência/cancelamento/idempotência:** preservar coordenação existente; aplicar generation/epochs, tentativa e operationId apenas ao componente implementado neste lote, conforme arquitetura. Instrumentação 01 só observa: não cria scanner, store, cancelamento ou sonda futuros. Publicação de persistência somente após confirmação.
13. **Entrada:** 03 e 04 aceitos; autorização 05; P3 aprovada.
14. **B — cobertura e PASS exigível:** LIB-03–06, E01/E03; recortes LIB-02, E02-abertura, E04-scan, E10-índice e DATA-01-startup. Unitários verificam regra; integração usa FS/SQLite reais conforme matriz; grupos E usam Electron/IPC reais. Base A aplicável permanece PASS, sem alegar cobertura nova existente.
15. **C — caracterização:** Comparar métricas de scan/bootstrap com 01; primeira medição incremental.
16. **D — adiado:** Monitor automático LIB-02/AV e E02/E04/E05/E10 completos em 06; BUF e instalado em 07. Não implementar componente futuro para antecipar seu teste.
17. **E — regressão:** executar grupos/recortes dos predecessores realmente integrados/afetados, conforme coluna Regressão da matriz; repetir tudo em 07. Em 04 independente, 02/03 ainda não integrados são DEFERRED, não FAIL.
18. **Windows/externos:** usar variante do runner oficial correspondente ao componente (produção/playback/opções/recovery). W/H/PK/V seguem política de transferência explícita da matriz até 07. Nenhum PASS físico por mock. Teste local obrigatório ausente mantém validação local incompleta.
19. **Saída objetiva:** UI utilizável antes de enumeração pesada com e sem cache; candidato conhecido revalidado antes de tocar; scan não compete com playback; nenhuma geração obsoleta publica. Ao satisfazer o gate e registrar evidências, liberar F0-06 automaticamente.
20. **Comandos reais focados:** npm run compile; node build/tests/main-media-runtime.test.js; node build/tests/video-library.test.js; node build/tests/player-playback.test.js; npm run test:e2e:video-library:headless; npm run test:e2e:standalone-integration:headless; npm run test:e2e:standalone-production:headless. Compilar antes de Node direto; scripts npm unit/e2e já compilam quando definido no package.json. Não executar testes novos inexistentes como se já existissem.
21. **Bloqueio e PASS/FAIL:** aplicar política canônica da matriz; assertion do lote falsa é FAIL, dependência futura é DEFERRED, ambiente ausente é NOT RUN específico. Scanner externo não é snapshot transacional. Não exigir reconexão automática por sondas ainda ausentes; playback não pode usar cache como autorização.
22. **Evidências obrigatórias:** diff, IDs/variantes/classes/resultados separados, comandos/exit codes, logs sanitizados, dados antes/depois, fingerprint Windows quando executado, NOT RUN com destino/responsável; resultado funcional/visual/técnico separado. Defeito antigo documentado na baseline não recebe PASS funcional.
23. **Riscos e aprovações:** preservar V1, códigos/CSV, FIFO/LIFO/30 pendentes, timers, persistência e guardas; não alterar dados reais nem writer Gestão. P1/P2/P3 não são gates pendentes. Gate humano restante: lote/aceite, elemento Doop novo, acesso/instalação externa ou revisão de arquitetura por inviabilidade demonstrada.

## F0-06 — Disponibilidade dinâmica e reconexão

1. **Identificador:** F0-06, subdivisão do ticket 0006/0000.
2. **Objetivo:** Atualizar snapshot sem apagar inventário.
3. **Problema:** Atualizar snapshot sem apagar inventário; ver evidências A–E do diagnóstico.
4. **Evidências:** funções e condições comprovadas no diagnóstico; hipóteses físicas permanecem abertas até F0-01.
5. **Dependências:** 05.
6. **Arquivos de responsabilidade:** src/video-library-service.ts; src/standalone-player-options.ts; src/standalone-player-ipc.ts; src/standalone-player-renderer.ts; tests/standalone-player-options.test.ts. Não editar outros módulos sem rastrear consumidor e justificar no ticket.
7. **Contratos:** V1, códigos sem zeros na entrada/canônico cinco dígitos, CSV opcional; uma sequência Main, IPC restrito; SQLite e Gestão preservados.
8. **Solução escolhida:** seguir arquitetura do diagnóstico e a sequência seguinte; somente gate remanescente interrompe o trecho dependente.
9. **Sequência de implementação:** Implementar sondas e epochs separados conforme arquitetura; integrar foco/erro; apenas uma sonda pendente; subscription Main→UI; reconexão agenda reconciliação; erros de acesso preservam índice; descartar resultados antigos; nenhum remap automático.
10. **Estados/transições:** testar apenas recorte exigível do lote na matriz; antes de editar anotar snapshot anterior, evento, confirmação exigida e snapshot posterior. Não equiparar idle visual a ready operacional.
11. **Erros/extremos:** falha fs, permissão, desconexão, corrupção, shutdown no await e falha de persistência; jamais converter erro em sucesso/vazio.
12. **Concorrência/cancelamento/idempotência:** preservar coordenação existente; aplicar generation/epochs, tentativa e operationId apenas ao componente implementado neste lote, conforme arquitetura. Instrumentação 01 só observa: não cria scanner, store, cancelamento ou sonda futuros. Publicação de persistência somente após confirmação.
13. **Entrada:** 05 aceito e autorização 06; Doop somente se novo visual necessário.
14. **B — cobertura e PASS exigível:** LIB-02, AV-01/02, E02/E04/E05/E10; DATA-01-disponibilidade. Unitários verificam regra; integração usa FS/SQLite reais conforme matriz; grupos E usam Electron/IPC reais. Base A aplicável permanece PASS, sem alegar cobertura nova existente.
15. **C — caracterização:** Medir latência sonda/reconexão pela primeira vez; comparar observação estática 01.
16. **D — adiado:** BUF-01/02, DATA-01 completo e E11 em 07; variantes H/V ausentes transferidas explicitamente. Não implementar componente futuro para antecipar seu teste.
17. **E — regressão:** executar grupos/recortes dos predecessores realmente integrados/afetados, conforme coluna Regressão da matriz; repetir tudo em 07. Em 04 independente, 02/03 ainda não integrados são DEFERRED, não FAIL.
18. **Windows/externos:** usar variante do runner oficial correspondente ao componente (produção/playback/opções/recovery). W/H/PK/V seguem política de transferência explícita da matriz até 07. Nenhum PASS físico por mock. Teste local obrigatório ausente mantém validação local incompleta.
19. **Saída objetiva:** Sonda concluída atualiza revisão atual, reconexão sem restart, zero exclusão por erro parcial; uma sonda pendente por raiz e eventos antigos descartados. Ao satisfazer o gate e registrar evidências, liberar F0-07 automaticamente.
20. **Comandos reais focados:** npm run test:unit:standalone-options; npm run test:unit:standalone-ipc; node build/tests/video-library.test.js; npm run test:e2e:standalone-options:headless; npm run test:e2e:standalone-production:headless. Compilar antes de Node direto; scripts npm unit/e2e já compilam quando definido no package.json. Não executar testes novos inexistentes como se já existissem.
21. **Bloqueio e PASS/FAIL:** aplicar política canônica da matriz; assertion do lote falsa é FAIL, dependência futura é DEFERRED, ambiente ausente é NOT RUN específico. SO pode bloquear syscall; medir atraso sem prometer deadline física. Simulação FS não prova USB/áudio físico.
22. **Evidências obrigatórias:** diff, IDs/variantes/classes/resultados separados, comandos/exit codes, logs sanitizados, dados antes/depois, fingerprint Windows quando executado, NOT RUN com destino/responsável; resultado funcional/visual/técnico separado. Defeito antigo documentado na baseline não recebe PASS funcional.
23. **Riscos e aprovações:** preservar V1, códigos/CSV, FIFO/LIFO/30 pendentes, timers, persistência e guardas; não alterar dados reais nem writer Gestão. P1/P2/P3 não são gates pendentes. Gate humano restante: lote/aceite, elemento Doop novo, acesso/instalação externa ou revisão de arquitetura por inviabilidade demonstrada.

## F0-07 — Validar buffering nativo e fechar regressões críticas

1. **Identificador:** F0-07, subdivisão do ticket 0006/0000.
2. **Objetivo:** Comprovar estabilidade sem buffer especulativo.
3. **Problema:** Comprovar estabilidade sem buffer especulativo; ver evidências A–E do diagnóstico.
4. **Evidências:** funções e condições comprovadas no diagnóstico; hipóteses físicas permanecem abertas até F0-01.
5. **Dependências:** 02 a 06.
6. **Arquivos de responsabilidade:** src/player-media-protocol.ts; src/player-playback-renderer.ts; tests/player-playback-electron.ts; tests/standalone-player-production-electron.ts; scripts/run-windows-native-tests.cjs somente se novo cenário exigir. Não editar outros módulos sem rastrear consumidor e justificar no ticket.
7. **Contratos:** V1, códigos sem zeros na entrada/canônico cinco dígitos, CSV opcional; uma sequência Main, IPC restrito; SQLite e Gestão preservados.
8. **Solução escolhida:** seguir arquitetura do diagnóstico e a sequência seguinte; somente gate remanescente interrompe o trecho dependente.
9. **Sequência de implementação:** Medir waiting/stalled e I/O com scan suspenso; testar ranges/stream abort/handles; corrigir somente defeitos demonstrados autorizados separadamente; comparar baseline; rodar regressões Gestão afetadas; validar pacote e HD físico com autorização; entregar aceite F0. Não implementar pré-carga nem buffer adicional sem nova proposta.
10. **Estados/transições:** testar apenas recorte exigível do lote na matriz; antes de editar anotar snapshot anterior, evento, confirmação exigida e snapshot posterior. Não equiparar idle visual a ready operacional.
11. **Erros/extremos:** falha fs, permissão, desconexão, corrupção, shutdown no await e falha de persistência; jamais converter erro em sucesso/vazio.
12. **Concorrência/cancelamento/idempotência:** preservar coordenação existente; aplicar generation/epochs, tentativa e operationId apenas ao componente implementado neste lote, conforme arquitetura. Instrumentação 01 só observa: não cria scanner, store, cancelamento ou sonda futuros. Publicação de persistência somente após confirmação.
13. **Entrada:** 02–06 aceitos tecnicamente; autorização 07; ambiente Windows/MP4/host descartável e autorizações externas.
14. **B — cobertura e PASS exigível:** BUF-01/02, DATA-01 e E11; regressão E de todos os 31 grupos e INS-01–03. Unitários verificam regra; integração usa FS/SQLite reais conforme matriz; grupos E usam Electron/IPC reais. Base A aplicável permanece PASS, sem alegar cobertura nova existente.
15. **C — caracterização:** Comparação final baseline versus mesmo snapshot final; buffering nativo sem otimização especulativa.
16. **D — adiado:** Nenhum caso interno adiado a lote posterior; H6 endurance/15k continua fora do escopo F0. Não implementar componente futuro para antecipar seu teste.
17. **E — regressão:** executar grupos/recortes dos predecessores realmente integrados/afetados, conforme coluna Regressão da matriz; repetir tudo em 07. Em 04 independente, 02/03 ainda não integrados são DEFERRED, não FAIL.
18. **Windows/externos:** usar variante do runner oficial correspondente ao componente (produção/playback/opções/recovery). W/H/PK/V seguem política de transferência explícita da matriz até 07. Nenhum PASS físico por mock. Teste local obrigatório ausente mantém validação local incompleta.
19. **Saída objetiva:** Todos os oráculos aplicáveis passam; pendências transferidas são resolvidas ou permanecem explicitamente NOT RUN para homologação do proprietário, sem falso PASS. O lote pode encerrar tecnicamente, mas a aprovação final F0 continua pendente e F1 não inicia.
20. **Comandos reais focados:** npm run compile; npm run test:unit; suites focadas Electron da matriz; npm run test:e2e:standalone-production:windows; npm run test:e2e:standalone-playback:windows; npm run test:e2e:standalone-options:windows; node scripts/run-windows-native-tests.cjs --player-recovery. Compilar antes de Node direto; scripts npm unit/e2e já compilam quando definido no package.json. Não executar testes novos inexistentes como se já existissem.
21. **Bloqueio e PASS/FAIL:** aplicar política canônica da matriz; assertion do lote falsa é FAIL, dependência futura é DEFERRED, ambiente ausente é NOT RUN específico. Sem Windows/HD/pacote a F0 permanece em validação incompleta. Defeito novo requer autorização de correção delimitada, não redesenhar buffer.
22. **Evidências obrigatórias:** diff, IDs/variantes/classes/resultados separados, comandos/exit codes, logs sanitizados, dados antes/depois, fingerprint Windows quando executado, NOT RUN com destino/responsável; resultado funcional/visual/técnico separado. Defeito antigo documentado na baseline não recebe PASS funcional.
23. **Riscos e aprovações:** preservar V1, códigos/CSV, FIFO/LIFO/30 pendentes, timers, persistência e guardas; não alterar dados reais nem writer Gestão. P1/P2/P3 não são gates pendentes. Gate humano restante: lote/aceite, elemento Doop novo, acesso/instalação externa ou revisão de arquitetura por inviabilidade demonstrada.


## Regras permanentes de execução

Um lote por vez na ordem autorizada; 04 tem dependência técnica somente de 01, mas nesta execução ocorre depois de 03 conforme solicitado. Ao fechar gate, avançar automaticamente sem consultar o proprietário. Atualizar 0006/0000 por subdivisão, não criar novos tickets principais para cada teste. Sem apagar AppData/recovery real, remover guardas, enfraquecer testes, sleeps arbitrários, mudar V1/UI sem aprovação Doop específica, antecipar G/H ou fazer commit/push/PR/release. Mocks não são integração. F0 não encerra F; aprovação final do proprietário permanece necessária antes de F1–F4.

## Ordem executiva definitiva

Ordem executiva desta autorização: **01 → 02 → 03 → 04 → 05 → 06 → 07**. Dependências técnicas: 02←01, 03←02, 04←01, 05←03/04, 06←05, 07←02–06. Embora 04 possa ocorrer após 01 independentemente de 02/03, a ordem sequencial acima fica definida para esta execução. Nenhuma aresta aponta a lote futuro; testes futuros não criam novas dependências.

## Checkpoint de execução — 2026-11-10

Todos os sete lotes tiveram implementação e gate técnico executados conforme a autorização global. Resultado local por lote (a homologação do hardware e do produto instalado permanece separada):

| Lote | Resultado | Dependência satisfeita | Testes que liberaram o próximo lote | Pendência/riscos residuais |
|---|---|---|---|---|
| F0-01 | PARTIAL (instrumentação/baseline sintético PASS) | Nenhuma | INS-01–03 local, compile e baseline 1k/5k/9k; defeitos anteriores registrados como observação, não PASS funcional | D: real e inicialização Windows física NOT RUN |
| F0-02 | PASS | 01 | Recovery/runtime unit e processo Electron descartável; P1, idle confirmado e sem autoplay | Nenhuma falha funcional automatizada; AppData real não acessado |
| F0-03 | PASS | 02 | Playback/sequence/host/IPC, produção Electron; contenção antes de liberar estado | Nenhuma UI nova necessária; P2 não alterou Doop |
| F0-04 | PASS | 01 | 9 testes do store, 23 da biblioteca e runner Windows; identities NTFS corrigidas com uint64 decimal | SQLite operacional não tocado |
| F0-05 | PASS | 03 e 04 | Restauro de índice, reconciliação, biblioteca/catálogo e produção Electron; scan não bloqueia a janela | Tempo sobre HD real NOT RUN |
| F0-06 | PARTIAL (automação FS/Electron PASS) | 05 | Sonda/epoch/estado e E2E de biblioteca/opções; atualizações de revisão corretas | USB físico, remoção durante playback e latência física NOT RUN |
| F0-07 | PARTIAL (campanha disponível PASS) | 02–06 | `npm run test:unit` 499/499; E2E Linux pertinente; runner Windows completo e produção; candidato/verificador Windows | HD/áudio e smoke pós-instalação NOT RUN |

F0-01/06/07 avançaram automaticamente porque seus gates de software e as medições substitutas autorizadas passaram; as variantes externas foram mantidas explicitamente pendentes, sem bloquear trabalho independente. Os 32 novos casos unitários passam no snapshot validado. O runner Windows completo, runner Windows de produção Standalone e package candidate/verify passaram sobre o snapshot `de3e33242ad4c63feb5fc0b4a574e89c19a43ffbbc50ed3bc5293f4e18b091cd`, HEAD `bc3d37de09462485caa9ff027341eeabdd4b88cb`; apenas documentação foi atualizada depois.

Os prompts acima são registros do handoff usado durante a implementação. A execução autorizada terminou; eles não autorizam F1–F4. A F0 permanece sem homologação do proprietário. Sem commits ou pushes.

## Checkpoint corretivo T2/T4 — admissão e recursos

F0-02/03/05/07 receberam correções autorizadas após a revisão independente, sem reabrir P1/P2/P3. Em 05 a ordem é agora efetivamente cache → documento/IPC/host → recovery confirmado → gate operacional → admissão idempotente de scan. Sondas/monitor não antecipam refresh. O oráculo anterior que exigia scan ativo/cache hits na UI foi substituído por zero enumeração/opens no gate e marco posterior de admissão; terminar um scan rápido antes do polling do harness não é falha.

Em 03/07 a capability é revalidada após abertura e acompanha streams para revogação/abort/dispose. Stop é validado com app ainda aberto, seguido de nova tentativa e eventos antigos. Critérios funcionais dos lotes permanecem; os PASS de fixtures não homologam o HD. Execução Windows final, interleavings e falhas corrigidas estão no [ledger canônico](fase-f0-testes.md#correção-estrutural-t2t4--ledger-de-regressão). Pacote anterior e campanha USB não são evidência deste snapshot. F0 continua sem homologação.

Na segunda revisão, o lote 05 também passou a reavaliar playback ao acordar de idle e a esperar antes da publicação de geração privada. Duas regressões antes FAIL passaram (biblioteca 25/25); critérios de preservar revisão de playback e descartar epochs antigos não foram relaxados. Snapshot final e regressões estão no ledger/JSON. O lote 07 permanece sem homologação física/pacote novo.


## F0-08 — Resiliência do Standalone Player à indisponibilidade da biblioteca durante uma sessão

1. **Autorização:** explícita do proprietário, incluindo modal no código sem Doop, apenas F0-08. Não autoriza T3 físico nem F1–F4.
2. **Dependências:** F0-02/03/05/06 e correções estruturais, infraestrutura T3. Preservar gates de bootstrap/P1/P2/P3 e testes anteriores.
3. **Objetivo:** preservar sessão viva, ocorrência atual e filas normal/prioritária sob falha de acesso/mídia; sem EOF/avance/autoplay por falha ou reconexão.
4. **Contrato e estados:** [especificação implementada](fase-f0-08-resiliencia.md). Blocked/uncertain + metadado storageRecovery; sem nova fila/SQLite ou estado operacional V1. Countdown congelado; buffer em progresso não é interrompido por sonda; falha conhecida contém e aguarda operador.
5. **Módulos:** Sequence/runtime/contracts; PlayerPlaybackService/contracts; MainMediaRuntime; bridge IPC e Preload; renderer/HTML/CSS restritos ao modal; testes Sequence/playback/protocolo e storage-resilience-electron; runners existentes.
6. **Passos:** caracterizar bloqueio anterior, reservar alvo e invalidar timer, verificar contenção, manter pending/order, revalidar identidade antes de recuperar, criar tentativa nova, modal conectado ao Main, testes determinísticos e E2E, revisão/Windows/documentação.
7. **Persistência/erros:** usar recovery existente; não liberar após WRITE_FAILED ou contenção incerta; manter evidências. Sem garantia nova de fila entre processos. Arquivo alterado não pode substituir alvo por código igual.
8. **Comandos:** recuperar manualmente do início, encerrar só atual sem avançar sozinho; Stop All mantém confirmação e limpeza explícita total. Sem seek confirmado, não prometer posição restaurada.
9. **Gate:** compile, suítes afetadas, E2E real Linux/Windows e regressão sintética T3 disponíveis devem passar; sem afirmação de físico/MP4/A/V. FAIL impede declarar conclusão técnica. NOT RUN externo não é PASS; pendências físicas permanecem para homologação.
10. **Evidência:** relatório/matriz/checkpoint e ledger F0-08 com hashes, fingerprint, logs, telas, causas de falhas intermediárias e limitações. Comandos focados: `npm run test:e2e:storage-resilience:headless`; `npm run test:e2e:storage-resilience:windows -- --approve-untracked`; compile e testes unitários nomeados na matriz.
11. **Riscos/gates finais:** watchdog mede evidência de progresso, identificação por metadados não hash de conteúdo, ausência de seek, impossibilidade de conter host exige bloqueio. Novo contrato fora deste escopo depende do proprietário. F0 não homologada.

## Complemento de validação F0-07/F0-08 — campanha física unificada

Infraestrutura implementada/testada sob autorização específica, sem criar F1 ou renumerar lotes. [Procedimento e escopos](fase-f0-t3-operacao.md#campanha-unificada-t3--f0-08--testekaraoke), [matriz do runner](fase-f0-testes.md#campanha-usb-unificada--cobertura-do-runner-e-regressões), [ledger](fase-f0-usb-campanha-evidencias.json). O gate automatizado concluiu a infraestrutura, não o T3 físico. Testes físicos futuros precisam de solicitação explícita, testekaraoke verificado e consentimentos próprios de risco/remoção. Não interpretar o modo descartável como permissão de tocar D: ou reparar/ejetar/formatar. F0 continua não homologada; demais fases não foram autorizadas.
