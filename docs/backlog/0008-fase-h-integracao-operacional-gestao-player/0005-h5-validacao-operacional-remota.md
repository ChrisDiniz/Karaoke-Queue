# 0008/0005 — H5: Validação operacional remota

## Identificação e estado

- Ticket: 0008/0005
- Etapa canônica: H5; pai 0008 — Integração operacional Gestão + Player.
- Status: Planejado / Não iniciado. Atualização de planejamento em 2026-11-11; sem autorização de implementação nesta rodada.
- [Roadmap](../../standalone-player-roadmap.md), [contrato funcional](../../paired-mode-contract.md), [sequência e matriz de testes](../../paired-mode-execution-plan.md), [interfaces/IDs](../../paired-mode-ui-plan.md).

## Objetivo e limite

Validar operação pareada completa e obter homologação com Gestão/Player em computadores distintos.

## Pré-requisitos e dependências

G e H1–H4 concluídas/aprovadas; D1/D3/D4/D5 aprovadas; suspensão D2 testada e destinos finais ainda indefinidos explicitamente excluídos/bloqueados; dois computadores; autorização H5.

## Módulos envolvidos

Aplicativo Main real, IPC/SQLite/MP4, journal/outbox e runners Linux/Windows existentes. São pontos existentes ou responsabilidades futuras, não alegação de arquivos novos já implementados. Conferir consumidores antes de editar.

## Lotes incrementais

### H5.1

Executar matriz integrada determinística e Electron real; conferir critérios do contrato ponta a ponta.

### H5.2

Campanha Windows nativa em dois computadores com mídia de teste e perfis isolados: turnos, local/remoto, rede, offline/retorno/takeover e reconciliação.

### H5.3

Registrar ambiente/fingerprints, falhas/correções e resultados funcionais, visuais e técnicos separados; homologação humana antes de H6/H7.

## Critérios de aceite

Zero EOF artificial, avanço/turno/histórico duplicado ou perda de resultado confirmado. Round Robin/2:1 e dados preservados; mídia sem CSV opera. Evidências físicas não inferidas de mocks; NOT RUN explícito.

Cada lote entrega diff revisado, testes por impacto e documentação/evidências. Persistência exige preparar → gravar → publicar; sem enfraquecer invariantes ou assertions. Registrar NOT RUN e motivo; PASS técnico não presume aprovação do proprietário.

## Testes obrigatórios

Todos os cenários da matriz do plano, incluindo segunda indisponível, erro entre músicas, EOF×comandos, duas origens, ACK perdido, restart, fila futura alterada, reconexão em celebração/apresentação, Stop All, offline, takeover e peer não autorizado. Linux + Windows oficial + dois computadores reais.

Usar relógios/barreiras determinísticos, rede sintética controlada, perfis/bancos isolados e runner Windows oficial quando aplicável. Nenhum sleep arbitrário como sincronização. CI existente recebe somente cenários determinísticos; campanhas físicas/duas máquinas ficam explícitas.

## Interfaces relacionadas

Comparação de todos os estados usados e revisão humana dos novos frames; não inicia H6/H7 automaticamente.

## Riscos e decisões pendentes

Homologação operacional não substituída por G6 ou screenshots; diferenças audiovisuais/hardware exigem proprietário. D1/D3/D4/D5 resolvidas; D2 parcialmente resolvida (somente descarte definitivo versus retorno da fila suspensa pendente). T1/T2 preservados no contrato; não recriar decisões já aprovadas de autoridade/EOF/pacote.

## Autonomia e conclusão

Implementação apenas com autorização específica do proprietário. Uma autorização de fase não autoriza a próxima. Dentro do lote autorizado, tarefas mecânicas e testes podem ser delegados consecutivamente com ownership exclusivo; parar no gate de decisão técnica/funcional/visual indicado, sem inventar política. Nenhuma etapa foi iniciada por este planejamento.

## Histórico preservado

O ticket anterior era exclusivamente planejado, sem implementação ou validação. A revisão atual detalha esse escopo mantendo ID e posição canônica. A antiga decisão aberta de autoridade em G4 foi resolvida funcionalmente pelo proprietário no contrato pareado; D1–D5 foram posteriormente revisadas pelo proprietário: D1/D3/D4/D5 resolvidas e D2 parcialmente resolvida, conforme o contrato vigente. Não há resultados de testes novos nesta atualização documental.

## Aceite adicional — decisões funcionais aprovadas

Aplicar os cenários DEC-01–05 da [matriz](../../paired-mode-execution-plan.md) conforme o impacto deste ticket: resultados mistos não alteram rodadas/rotação; takeover suspende a fila local, sem importação ou execução automática; vez ativa impede offline até conclusão ou Stop All explicitamente confirmado; EOF/Avançar da última promovem automaticamente uma vez, Stop All não promove; cadastro inexistente comprovado é bloqueado conectado, e offline aceita registro não verificado com revalidação antes do playback. D1/D3/D4/D5 resolvidas, D2 parcialmente resolvida. Preservar a pendência final de descarte versus retorno da fila suspensa. Testes apenas planejados, sem execução nesta atualização.
