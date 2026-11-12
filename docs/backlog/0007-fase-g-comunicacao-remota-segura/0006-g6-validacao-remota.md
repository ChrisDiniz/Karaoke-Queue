# 0007/0006 — G6: Validação remota

## Identificação e estado

- Ticket: 0007/0006
- Etapa canônica: G6; pai 0007 — Comunicação remota segura.
- Status: Planejado / Não iniciado. Atualização de planejamento em 2026-11-11; sem autorização de implementação nesta rodada.
- [Roadmap](../../standalone-player-roadmap.md), [contrato funcional](../../paired-mode-contract.md), [sequência e matriz de testes](../../paired-mode-execution-plan.md), [interfaces/IDs](../../paired-mode-ui-plan.md).

## Objetivo e limite

Homologar mecanismos seguros entre duas máquinas sem declarar integração operacional H pronta.

## Pré-requisitos e dependências

G1–G5 concluídas e aprovadas; dois computadores Windows e perfis isolados.

## Módulos envolvidos

Transporte, autorização, schemas, journal/replay e runners oficiais existentes. São pontos existentes ou responsabilidades futuras, não alegação de arquivos novos já implementados. Conferir consumidores antes de editar.

## Lotes incrementais

### G6.1

Executar matriz determinística Linux/Windows de segurança, protocolo, persistência e falhas de rede.

### G6.2

Validar HTTPS/WSS e vínculo real em dois computadores: desconectar, reiniciar e reconciliar operações sintéticas tipadas, sem fila operacional real.

### G6.3

Registrar versões, fingerprints, logs sanitizados, cleanup e limites; revisão de segurança e aprovação explícita antes de H.

## Critérios de aceite

Nenhuma ação não autorizada, duplicação ou perda de resultado confirmado; replay/epochs e cleanup comprovados nos dois peers. G6 não homologa envio da vez/Round Robin/histórico administrativo/takeover operacional.

Cada lote entrega diff revisado, testes por impacto e documentação/evidências. Persistência exige preparar → gravar → publicar; sem enfraquecer invariantes ou assertions. Registrar NOT RUN e motivo; PASS técnico não presume aprovação do proprietário.

## Testes obrigatórios

Autenticação, peer indevido, ACK perdido, reordenação, timeout e restart; runner Windows oficial; dois computadores reais, sem alegar que dois processos no mesmo host substituem esse gate.

Usar relógios/barreiras determinísticos, rede sintética controlada, perfis/bancos isolados e runner Windows oficial quando aplicável. Nenhum sleep arbitrário como sincronização. CI existente recebe somente cenários determinísticos; campanhas físicas/duas máquinas ficam explícitas.

## Interfaces relacionadas

Somente estados de conexão G5; fluxos operacionais completos em H5.

## Riscos e decisões pendentes

Diferenças de rede/firewall/certificados e ausência de máquinas exigem NOT RUN explícito. D1/D3/D4/D5 resolvidas; D2 parcialmente resolvida (somente descarte definitivo versus retorno da fila suspensa pendente). T1/T2 preservados no contrato; não recriar decisões já aprovadas de autoridade/EOF/pacote.

## Autonomia e conclusão

Implementação apenas com autorização específica do proprietário. Uma autorização de fase não autoriza a próxima. Dentro do lote autorizado, tarefas mecânicas e testes podem ser delegados consecutivamente com ownership exclusivo; parar no gate de decisão técnica/funcional/visual indicado, sem inventar política. Nenhuma etapa foi iniciada por este planejamento.

## Histórico preservado

O ticket anterior era exclusivamente planejado, sem implementação ou validação. A revisão atual detalha esse escopo mantendo ID e posição canônica. A antiga decisão aberta de autoridade em G4 foi resolvida funcionalmente pelo proprietário no contrato pareado; D1–D5 foram posteriormente revisadas pelo proprietário: D1/D3/D4/D5 resolvidas e D2 parcialmente resolvida, conforme o contrato vigente. Não há resultados de testes novos nesta atualização documental.
