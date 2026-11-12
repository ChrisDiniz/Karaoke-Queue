# 0007/0004 — G4: Reconexão e recuperação

## Identificação e estado

- Ticket: 0007/0004
- Etapa canônica: G4; pai 0007 — Comunicação remota segura.
- Status: Planejado / Não iniciado. Atualização de planejamento em 2026-11-11; sem autorização de implementação nesta rodada.
- [Roadmap](../../standalone-player-roadmap.md), [contrato funcional](../../paired-mode-contract.md), [sequência e matriz de testes](../../paired-mode-execution-plan.md), [interfaces/IDs](../../paired-mode-ui-plan.md).

## Objetivo e limite

Reconciliar identidade, estado e operações sem replay cego ou tomada automática de controle.

## Pré-requisitos e dependências

G3.1–G3.4 e G2; sem dependência da implementação H. Política funcional já definida no contrato; suspensão local D2 e restrição de offline D3 são integradas em H; só o destino final da fila suspensa permanece pendente.

## Módulos envolvidos

Ports G3, transporte G1; futuros recovery/reconciliation Main; src/player-playback-recovery*. São pontos existentes ou responsabilidades futuras, não alegação de arquivos novos já implementados. Conferir consumidores antes de editar.

## Lotes incrementais

### G4.1

Implementar handshake de reconexão: snapshot, cursor/eventos, comparação de epochs/revisões e consulta de operação original; não bloquear execução por rede.

### G4.2

Resolver timeout e uncertain; invalidar comandos por sessão/controlEpoch sem apagar resultados antigos; nenhuma nova intenção Avançar no retry.

### G4.3

Expor mecanismo de transição explícita de modo/autoridade e fences; H3 fornece intenção/política de domínio e takeover.

### G4.4

Recuperar após restart sem autoplay, mídia ativa presumida ou perda de resultados; disponibilizar divergência contextual e bloqueio apenas dependente.

## Critérios de aceite

Conexão não implica controle operacional; snapshot e replay convergem mesmo com EOF durante handshake. Comando velho não afeta próxima ocorrência. Não espera ACK segurando lock/transação.

Cada lote entrega diff revisado, testes por impacto e documentação/evidências. Persistência exige preparar → gravar → publicar; sem enfraquecer invariantes ou assertions. Registrar NOT RUN e motivo; PASS técnico não presume aprovação do proprietário.

## Testes obrigatórios

EOF durante reconnect, restart de ambos peers, resultado sem ACK, duplicatas/atrasos, epoch/sessão antiga, falha parcial e corrida entre reconciliação e nova revisão. Rede sintética determinística e integração Main.

Usar relógios/barreiras determinísticos, rede sintética controlada, perfis/bancos isolados e runner Windows oficial quando aplicável. Nenhum sleep arbitrário como sincronização. CI existente recebe somente cenários determinísticos; campanhas físicas/duas máquinas ficam explícitas.

## Interfaces relacionadas

G5 mostra estado; H3/H4 fazem retorno pareado, takeover e decisão de conflito. Não importar fila local.

## Riscos e decisões pendentes

Dependências circulares com H; transporte não deve conhecer política de fila nem interromper playback. D1/D3/D4/D5 resolvidas; D2 parcialmente resolvida (somente descarte definitivo versus retorno da fila suspensa pendente). T1/T2 preservados no contrato; não recriar decisões já aprovadas de autoridade/EOF/pacote.

## Autonomia e conclusão

Implementação apenas com autorização específica do proprietário. Uma autorização de fase não autoriza a próxima. Dentro do lote autorizado, tarefas mecânicas e testes podem ser delegados consecutivamente com ownership exclusivo; parar no gate de decisão técnica/funcional/visual indicado, sem inventar política. Nenhuma etapa foi iniciada por este planejamento.

## Histórico preservado

O ticket anterior era exclusivamente planejado, sem implementação ou validação. A revisão atual detalha esse escopo mantendo ID e posição canônica. A antiga decisão aberta de autoridade em G4 foi resolvida funcionalmente pelo proprietário no contrato pareado; D1–D5 foram posteriormente revisadas pelo proprietário: D1/D3/D4/D5 resolvidas e D2 parcialmente resolvida, conforme o contrato vigente. Não há resultados de testes novos nesta atualização documental.

## Revisão T1 — descoberta/pareamento integral LAN (planejado)

G4.1 acrescenta reconexão automática por vínculo salvo: descoberta/último endpoint como pistas, TLS pinado+bearer antes de confirmar endereço. Um scheduler por peer, backoff 1/2/4/8/16/30 s com jitter e relógio/RNG controlados; cancelar no shutdown e coalescer eventos de rede/Atualizar. Mudança de IP não requer pairing se identidade/certificado permanecem; pin diferente exige UI G2, nunca troca automática. G4.4 cobre resume/DHCP/busy, mensagem antiga e reconstrução de snapshot/eventos/operationId antes de liberar controle. Transporte pode reconectar com Player offline, mas modo/autoridade não mudam automaticamente. Testar queda durante vez, anúncios falsos e recuperação anual.

Referência técnica: [complemento T1 LAN](../../g1-1-t1-lan-pairing.md), ainda aguardando aprovação. Nenhuma implementação/teste de aplicação, alteração Doop ou início automático autorizado. T2/D2 e decisões funcionais aprovadas preservados.
