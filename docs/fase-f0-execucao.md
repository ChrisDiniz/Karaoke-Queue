# F0 — Handoff consolidado para o implementador

> **Encerramento vigente — 2026-11-11:** Fase F, incluindo F0 e suas subdivisões, concluída e validada pelo proprietário. [Registro consolidado](fase-f-encerramento.md). Este documento preserva contratos, planejamento e evidências históricas; menções a homologação pendente ou F1–F4 não iniciadas estão superadas pelo aceite. Classificações técnicas e lacunas de evidência permanecem inalteradas. Prompts e gates históricos não autorizam novas execuções.

**P1/P2/P3 aprovadas explicitamente pelo proprietário.** A autorização vigente cobre a execução autônoma sequencial de F0-01 a F0-07, com avanço automático após cada gate técnico aprovado; não perguntar novamente entre esses lotes. Aplicar as políticas do [diagnóstico](fase-f0-diagnostico-arquitetura.md), sem redesenhar a arquitetura. A aprovação final da F0 continua reservada ao proprietário e não autoriza F1–F4/G/H.

Leia AGENTS.md, seção F0 do roadmap, ticket 0006/0000, diagnóstico, [lote autorizado](fase-f0-lotes.md) e [matriz canônica](fase-f0-testes.md). Não recomeçar auditoria completa: conferir Git/HEAD e divergências reais nos módulos do lote basta. V1 e contratos da Gestão/SQLite preservados. Dados/profile/fixtures isolados; nunca apagar AppData ou recovery real, retirar guardas ou mascarar erro com sleep/retry.

Ordem serial autorizada: **01 → 02 → 03 → 04 → 05 → 06 → 07**. Dependências reais: 02←01, 03←02, 04←01, 05←03/04, 06←05, 07←02–06. Embora 04 não dependa de 02/03, preservar a ordem solicitada pelo proprietário nesta execução. Não rodar builds/perfis compartilhados em paralelo. A autorização não inclui commit/push/PR/workflow/instalação operacional.

## Como selecionar testes

A matriz atribui responsável, primeiro PASS, regressões e recortes. Antes do primeiro PASS, o grupo completo é DEFERRED; assertions A preexistentes aplicáveis continuam exigíveis. B = criar cobertura do lote, C = registrar comportamento anterior, E = repetir cobertura integrada, F/G = variante externa indisponível. Use INS-01–03 para validar instrumentação. Nunca exigir solução futura para aceitar 01 ou 04. Não rotular bug reproduzido como PASS funcional. Use somente comandos reais na matriz e no lote; teste novo requer implementação/registro antes da execução. Alterar testes apenas para acrescentar cobertura prevista e manter assertions existentes.

Compile e rode unitários/integração/Electron focados após mudança relevante. Testes locais obrigatórios NOT RUN deixam o lote parcial e não podem ser chamados PASS; registrar o bloqueador e executar trabalho seguro independente. Variantes Windows/HD/pacote/Doop podem ficar em ledger com destino 07 e responsável, sem alegar PASS. Falha observada não vira NOT RUN. Em 07 todas as transferências vencem; F0 incompleta até execução ou aceite nominal da limitação pelo proprietário. Mocks não provam FS/SQLite/runtime reais.

Windows: usar scripts/run-windows-native-tests.cjs via scripts npm confirmados na matriz, checkout NTFS, fingerprint e perfil isolado. Revisar untracked antes da transferência; não usar approve-untracked às cegas. Não substituir runner por execução do checkout WSL. MP4, Windows, USB físico, pacote e NSIS são pré-requisitos diferentes. Não alterar configurações globais/operacionais nem instalar/desinstalar o produto operacional sem autorização específica.

## Gates remanescentes e interrupção

Não solicitar autorização entre lotes: o proprietário autorizou F0-01–07 e avanço automático pelos gates. P2 não aprova novos visuais: localizar frames e contratos existentes; registrar exatamente qual copy/modal/elemento falta e solicitar aprovação específica apenas desse elemento; continuar o núcleo técnico independente, sem inventar UI. Falta de HD físico ou instalação operacional gera pendência específica para 07. Risco novo demonstrável de integridade/segurança ou inviabilidade do JSON requer evidência e revisão antes de trocar a solução; não ignorar defeito para seguir o plano. Não pedir confirmações para escolhas locais já especificadas.

## Prompts fechados por lote

Prefixo obrigatório para cada prompt abaixo:

> Execute exclusivamente o lote indicado dentro da autorização global do proprietário para F0-01–07. Confirme que o gate e as dependências anteriores estão registrados; não solicite autorização individual nem comece o lote seguinte antes do gate e checkpoint atuais. Siga AGENTS.md, docs/fase-f0-diagnostico-arquitetura.md, docs/fase-f0-lotes.md, docs/fase-f0-testes.md e docs/backlog/0006-fase-f-regressao-estabilizacao-pos-instalacao/0000-f0-estabilizacao-critica-standalone.md. P1/P2/P3 estão aprovadas. Preserve working tree, dados e arquitetura. Aplique exatamente o recorte B/A/E exigível; C apenas mede, D não exige implementação agora. Registre variantes F/G e resultados sem falso PASS. Não altere UI sem frame/aprovação específica nem avance para F1–F4/G/H ou faça commit/push. Atualize ticket e entregue relatório.

| Lote | Complemento obrigatório / escopo fechado |
|---|---|
| F0-01 | Instrumente opt-in sem mudar funcionalidade; crie INS-01–03; obtenha baseline local 1k/5k/9k e caracterizações C da matriz; A de logging/runtime/produção preservadas. Não implementar cache/recovery/scan incremental/sonda. Métrica futura é N/A; defeito observado fica conhecido, não PASS funcional. Use compile, logging/main-media-runtime e production headless quando o pré-requisito de mídia existir; transfira somente variantes físicas ausentes a 07. |
| F0-02 | Aplique P1 somente Standalone, preserve default compartilhado e evidências. Crie/amplie REC-01–04/E07 e recortes E06-startup/DATA-recovery. Não exigir cache, monitoramento ou Enter/guarda runtime de 03. Execute runtime/recovery unit, recovery e production Electron. Falha de contenção/persistência não libera comandos. |
| F0-03 | Aplique P2: contenção/correlação, timeout/falha e nova tentativa sem perda de head. PLAY-01–05/E06/E08/E09 e recortes E05-runtime/E10-técnico/DATA-runtime; regredir 02. Não implementar sondas/buffer/store. Doop só bloqueia elemento novo; núcleo técnico prossegue. Execute sequence/runtime/IPC/host/playback e integration/production Electron. |
| F0-04 | Após 01, implemente apenas store JSON Main-only aprovado; LIB-01 e recortes store LIB-02–06/DATA-store. Integração FS real/falhas obrigatória, sem integrar bootstrap ou tocar SQLite operacional. Startup E2E por cache fica DEFERRED 05. Crie e registre teste do store; compile e execute-o junto à base video-library. |
| F0-05 | Após 03/04, integre P3: UI antes de scan, candidato revalidado, reconciliação incremental cancelável/prioridade playback; adaptar scanStatus/revision. LIB-03–06/E01/E03 e recortes 05 da matriz, incluindo LIB-02 sem sonda. Não exigir reconexão automática 06. Execute biblioteca/runtime/playback e video-library/integration/production Electron; comparar baseline 01. |
| F0-06 | Após 05, implementar sonda única/epochs/revisões/reconexão segura. Completar LIB-02/AV-01/02/E02/E04/E05/E10; DATA-disponibilidade. Repetir recortes anteriores por impacto. Sem buffer adicional/remap inseguro. Execute opções/IPC/biblioteca e options/production Electron; variantes visuais/físicas somente com pré-requisitos. |
| F0-07 | Após 02–06, completar BUF-01/02/DATA-01/E11, regredir todos 31 grupos/INS e resolver ledger externo. Comparar baseline no snapshot final; usar runner Windows e distinguir harness, produção, pacote e NSIS. Medir buffering nativo, sem pré-carga especulativa. Corrigir defeito confirmado dentro do escopo F0; risco/alteração fora dos contratos exige registro e interrupção do trecho afetado. Emitir aceite técnico e pedir aprovação F0; não iniciar F1. |

## Atualização do ticket e relatório

Por lote registrar arquivos, decisão aplicada, ID/variante/classe, comando/exit code, snapshot antes/depois sanitizado, PASS/FAIL/DEFERRED/N/A/NOT RUN e motivo. Ledger externo: teste/variante, pré-requisito ausente, responsável, destino 07 e risco. INS passa não significa que bug antigo passou. Registrar separadamente funcional, técnico, visual, Windows e físico. Se faltar validação local obrigatória, manter parcial e bloquear os dependentes; avançar automaticamente quando o gate estiver satisfeito. Não fechar F/F0 sem aceite apropriado. Nunca remover cobertura não relacionada, reconstruir fila volátil por inferência ou alterar V1.


## Autorização de execução — F0-01 a F0-07

Em 2026-11-10, o proprietário autorizou uma execução contínua e autônoma dos sete lotes F0-01→F0-07, com avanço automático após cada gate técnico satisfeito. Esta autorização substitui a autorização individual entre esses sete lotes; não autoriza F1–F4/G/H, commits, publicação, instalação operacional, mutação de AppData real, operações destrutivas ou alteração de contratos fora da F0. P1/P2/P3 permanecem aprovadas.

Gates: implementação delimitada concluída; assertions aplicáveis passam; regressões relevantes sem falhas introduzidas; segurança/integridade confirmadas; evidências e checkpoint registrados; DEFERRED/NOT RUN/N/A fielmente classificados; dependências atendidas. Interromper somente trecho com falha obrigatória sem solução segura, risco de corrupção/segurança, decisão de produto nova, mudança arquitetural fora do contrato ou pré-requisito de ambiente sem alternativa segura; trabalho independente continua. HD pessoal somente leitura e sem escrita; sem desconexão. Nenhuma validação física ausente vira PASS. Aprovação final/homologação F0 permanece reservada ao proprietário e não inicia F1.

## Resultado do handoff — execução concluída em 2026-11-10

Os prompts fechados acima foram usados como escopo executável na ordem 01→02→03→04→05→06→07. A autorização global do proprietário cobriu todos os sete lotes e avanço automático; não foi pedida nova autorização entre lotes. Os sete checkpoints estão registrados no [ticket 0006/0000](backlog/0006-fase-f-regressao-estabilizacao-pos-instalacao/0000-f0-estabilizacao-critica-standalone.md) e o [ledger de testes](fase-f0-testes.md) diferencia PASS, PARTIAL, NOT RUN e não aplicável.

Estado atual: F0-02/03/04/05 PASS nos gates automatizados; F0-01/06/07 PARTIAL por variantes externas não executadas, apesar do software automatizado aprovado. Unitários finais 499/499; runner Windows completo e produção Standalone, build candidato e verificador passaram no fingerprint descrito no ticket. `npm run test:e2e:video-library:headless` passou fora do sandbox, após falha de inicialização do Electron dentro dele. O HD não estava montado no WSL2, então não há medição do acervo real.

Os prompts permanecem referência histórica para rastreabilidade; não há lote F0 futuro nesta execução. O próximo passo é revisão/homologação do proprietário para F0, incluindo decidir se executará ou aceitará as variantes físicas/instaladas pendentes. F1–F4/G/H não estão autorizadas por este handoff. Nenhuma implementação visual nova foi feita; nenhum frame Doop alterado.

## Handoff após correção estrutural T2/T4

Não reintroduzir scan na inicialização da infraestrutura. Main libera `admitStandaloneReconciliation()` somente depois do documento/IPC/host e recovery confirmado; sondas não contornam a admissão. Não exigir scan ativo na UI nem comparar clocks absolutos entre processos. No protocolo, preservar a revalidação após open e a posse dos streams por capability.

Validação reproduzível com fixture MP4 **interna descartável** contendo `01001.mp4`: `npm run test:e2e:f0-structural:headless` compila e executa Main/playback concorrente e bootstrap/recovery. Windows usa o runner existente `npm run test:e2e:standalone-production:windows -- --approve-untracked`, com `KQ_F0_STRUCTURAL_ONLY=1`, `KQ_PLAYER_TEST_MEDIA_DIR` e `KARAOKE_QUEUE_WIN_CHECKOUT` internos, encaminhados conforme o procedimento WSLENV de [Windows](windows-native-testing.md). A lista revisada de untracked precisa continuar segura antes da aprovação de transferência.

Os novos testes de runtime/protocolo pertencem aos scripts unitários existentes e ao seletor Windows de produção. Resultados/fingerprint e diferenças entre observação direta, pré-despacho e NOT_MEASURED estão na [matriz](fase-f0-testes.md#correção-estrutural-t2t4--ledger-de-regressão). F0 não homologada; não executar T3, acessar D:, reconstruir pacote ou avançar F1–F4 sem a autorização específica correspondente. Planejar T3 é GO técnico, respeitando a proteção de metadados e intervenção física do proprietário.


## Handoff T3 físico — somente sob nova solicitação

A infraestrutura está pronta; executar B primeiro somente mediante solicitação explícita do proprietário, em terminal interativo e sob supervisão. Seguir integralmente [procedimento operacional T3](fase-f0-t3-operacao.md); não executar enquanto apenas lendo este handoff. Comando: `npm run test:manual:usb-reconnect -- --authorize-physical-test --scenario B`. Não alterar segurança/produção para vencer preflight. Se a proteção de escrita exigida não existir, registrar BLOCKED antes de acesso à pasta. O cenário A exige autorização correspondente e quiescência instrumentada. Preservar JSONL/resumos e registrar resultados físicos separadamente dos sintéticos. Não homologa F0 nem autoriza F1–F4. P1/P2/P3 não precisam de nova aprovação.


## F0-08 — execução autorizada e manutenção

O proprietário autorizou implementar a resiliência de sessão e o modal F0-08 diretamente no código sem Doop. [Contrato/estados/invariantes](fase-f0-08-resiliencia.md), [lote](fase-f0-lotes.md#f0-08--resiliência-do-standalone-player-à-indisponibilidade-da-biblioteca-durante-uma-sessão). Não reabrir P1/P2/P3, não criar persistência de fila entre processos, autoplay/seek/buffer novo ou outra autoridade. Usar testes Sequence/playback/protocolo e `test:e2e:storage-resilience:headless`/`:windows`; só fixtures internas. O runner físico T3 continua exclusivamente sob solicitação explícita e preflight de proteção efetiva. Atualizar checkpoint e evidências, não iniciar F1–F4 nem commit/push. Falha de contenção/persistência permanece protegida, nunca forçar idle para passar.

F0-08 concluída tecnicamente no escopo automatizado: [evidências do snapshot](fase-f0-08-evidencias.json) e [resultados](fase-f0-relatorio.md#f0-08--resiliência-a-falhas-de-armazenamento-durante-a-sessão). O executor posterior deve preservar esta política e não executar T3 físico apenas porque testes sintéticos passaram. Solicitação explícita, proteção verificável e supervisão continuam necessárias.

## Handoff — campanha física unificada T3 + F0-08

Infraestrutura concluída; **não executar automaticamente**. O [procedimento vigente](fase-f0-t3-operacao.md#campanha-unificada-t3--f0-08--testekaraoke) contém comandos, consentimentos, checkpoints, seleção, repetição, cancelamento e retomada. Começar por B ou `all` somente conforme solicitação posterior. Nunca responder por conta própria às confirmações do proprietário. Modo descartável é risco aceito exclusivamente para testekaraoke/F:\musicas, sem garantia de metadados/integridade; consultas e validações não podem ser contornadas. Remoção abrupta exige consentimento individual do cenário. D: é excluída. Mudança de letra é reidentificada explicitamente e reinicia cenário/perfil, sem remapear sessão viva. Em falha/instabilidade, preservar evidência e parar, sem reparar/formatar/ejetar. [Ledger validado](fase-f0-usb-campanha-evidencias.json). Não homologar F0, iniciar F1–F4 ou commit/push.
