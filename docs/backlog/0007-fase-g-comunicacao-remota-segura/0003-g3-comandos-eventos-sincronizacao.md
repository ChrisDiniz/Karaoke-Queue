# 0007/0003 — G3: Comandos, eventos e sincronização

## Identificação e estado

- Ticket: 0007/0003
- Etapa canônica: G3; pai 0007 — Comunicação remota segura.
- Status: Planejado / Não iniciado. Atualização de planejamento em 2026-11-11; sem autorização de implementação nesta rodada.
- [Roadmap](../../standalone-player-roadmap.md), [contrato funcional](../../paired-mode-contract.md), [sequência e matriz de testes](../../paired-mode-execution-plan.md), [interfaces/IDs](../../paired-mode-ui-plan.md).

## Objetivo e limite

Fornecer schemas, confirmação de operações e registro durável/replay independentes da Gestão.

## Pré-requisitos e dependências

G1/G2 para tráfego autenticado; G3.1 é contrato sem rede, usado pela proposta G2; T2 antes de G3.2.

## Módulos envolvidos

src/{management,standalone-player,player-playback}-contracts.ts; src/player-playback-recovery*; futuros protocol/journal ports Main. São pontos existentes ou responsabilidades futuras, não alegação de arquivos novos já implementados. Conferir consumidores antes de editar.

## Lotes incrementais

### G3.1

Definir schemas e fixtures versionadas de pacote de vez, comandos, ACK, snapshot, consulta de mídia, journal e cursores; mapear IDs existentes conforme contrato §3.

### G3.2

Projetar e revisar T2; implementar store isolado Main-only, intenção/aceite/resultado, unicidade e replay paginado. Não usar inventário descartável nem persistir fila V1.

### G3.3

Implementar estados not-sent/rejected/accepted/completed/unknown e consulta por operationId; outbox recuperável por port na Gestão; mesmo ID/payload retorna resultado, conflito rejeita.

### G3.4

Implementar ACK durável/cursor contíguo, tombstones/checkpoints e limpeza segura; validar crash, disco cheio e ausência de reexecução após compactação.

## Critérios de aceite

Um comando duplicado não repete efeito. Aceite e resultado só confirmados após persistência. Resultado resiste a restart. Replay após ACK perdido é seguro e limpeza não invalida dedupe. G3 não aplica Round Robin nem conclui apresentações.

Cada lote entrega diff revisado, testes por impacto e documentação/evidências. Persistência exige preparar → gravar → publicar; sem enfraquecer invariantes ou assertions. Registrar NOT RUN e motivo; PASS técnico não presume aprovação do proprietário.

## Testes obrigatórios

ID com payload diferente, mensagens reordenadas, lacuna de sequência, crash antes/depois de commit e efeito físico, falha de escrita/rollback, ACK perdido, resultado persistido não recebido, backup antigo e compactação. SQLite/FS real conforme store escolhido, fixtures isoladas.

Usar relógios/barreiras determinísticos, rede sintética controlada, perfis/bancos isolados e runner Windows oficial quando aplicável. Nenhum sleep arbitrário como sincronização. CI existente recebe somente cenários determinísticos; campanhas físicas/duas máquinas ficam explícitas.

## Interfaces relacionadas

Frames de envio não confirmado e operação incerta são integrados em G5; decisões operacionais H3.

## Riscos e decisões pendentes

Não existe atomicidade entre efeito físico e disco: janela sem prova é incerta. TTL arbitrário perde idempotência. D1/D3/D4/D5 resolvidas; D2 parcialmente resolvida (somente descarte definitivo versus retorno da fila suspensa pendente). T1/T2 preservados no contrato; não recriar decisões já aprovadas de autoridade/EOF/pacote.

## Autonomia e conclusão

Implementação apenas com autorização específica do proprietário. Uma autorização de fase não autoriza a próxima. Dentro do lote autorizado, tarefas mecânicas e testes podem ser delegados consecutivamente com ownership exclusivo; parar no gate de decisão técnica/funcional/visual indicado, sem inventar política. Nenhuma etapa foi iniciada por este planejamento.

## Histórico preservado

O ticket anterior era exclusivamente planejado, sem implementação ou validação. A revisão atual detalha esse escopo mantendo ID e posição canônica. A antiga decisão aberta de autoridade em G4 foi resolvida funcionalmente pelo proprietário no contrato pareado; D1–D5 foram posteriormente revisadas pelo proprietário: D1/D3/D4/D5 resolvidas e D2 parcialmente resolvida, conforme o contrato vigente. Não há resultados de testes novos nesta atualização documental.
