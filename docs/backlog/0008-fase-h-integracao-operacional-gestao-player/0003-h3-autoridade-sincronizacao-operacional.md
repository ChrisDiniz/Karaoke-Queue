# 0008/0003 — H3: Autoridade e sincronização operacional

## Identificação e estado

- Ticket: 0008/0003
- Etapa canônica: H3; pai 0008 — Integração operacional Gestão + Player.
- Status: Planejado / Não iniciado. Atualização de planejamento em 2026-11-11; sem autorização de implementação nesta rodada.
- [Roadmap](../../standalone-player-roadmap.md), [contrato funcional](../../paired-mode-contract.md), [sequência e matriz de testes](../../paired-mode-execution-plan.md), [interfaces/IDs](../../paired-mode-ui-plan.md).

## Objetivo e limite

Aplicar resultados do Player no histórico e conciliar operação/offline/takeover sem dupla autoridade.

## Pré-requisitos e dependências

H2 e G4; D1/D3/D4 aprovadas e suspensão D2 definida; decisão final D2 apenas antes de descartar ou retornar a fila suspensa; autorização H3.

## Módulos envolvidos

src/main-management-host.ts; src/application.ts; src/state-repository.ts; database.ts; journal/outbox ports; paired runtime Main. São pontos existentes ou responsabilidades futuras, não alegação de arquivos novos já implementados. Conferir consumidores antes de editar.

## Lotes incrementais

### H3.1

Consumir resultados/cursor atomicamente e projetar histórico por ocorrência; só depois ACK durável. Aplicar terminal e promoção segundo D1/D4 sem concluir cantada por erro/Stop.

### H3.2

Conciliar snapshot/eventos/outbox e revisar divergências sem interromper execução; resolver comando incerto pelo ID original; origem manual offline explícita.

### H3.3

Implementar confirmação de offline e retorno explícito, fences de autoridade, takeover aguardar/imediato; suspender fila local sem importação/execução automática ao assumir (D2); proibir offline durante vez ativa, aguardando terminal ou Stop All explícito e confirmado (D3). Descarte definitivo/retorno da fila suspensa ainda depende de decisão, sem bloquear os caminhos de suspensão aprovados.

### H3.4

Validar restart, EOF simultâneo à reconexão/takeover, restauração de resultados e pendências locais sem importação automática.

## Critérios de aceite

Histórico não duplica nem sobrescreve silenciosamente. Sem autoplay no restart/retorno da rede. Takeover imediato exige contenção/cancelamento local antes da vez remota; aguardar não deixa fila local competir. Fila Gestão prevalece sem apagar pendências silenciosamente.

Cada lote entrega diff revisado, testes por impacto e documentação/evidências. Persistência exige preparar → gravar → publicar; sem enfraquecer invariantes ou assertions. Registrar NOT RUN e motivo; PASS técnico não presume aprovação do proprietário.

## Testes obrigatórios

Resultado commitado e ACK perdido, crash Gestão antes/depois do cursor, EOF×reconnect/takeover, eventos de sessão antiga, conflito manual×remoto, offline e retorno com fila local. SQLite/Main/IPC/Electron reais; falhas de rede e duas máquinas em H5.

Usar relógios/barreiras determinísticos, rede sintética controlada, perfis/bancos isolados e runner Windows oficial quando aplicável. Nenhum sleep arbitrário como sincronização. CI existente recebe somente cenários determinísticos; campanhas físicas/duas máquinas ficam explícitas.

## Interfaces relacionadas

NZdmSCHivT/yDsRajh7GQ/eghthO89ZV/TuUROWWoPv/kEiJdRV0oQ; aprovação visual em H4.

## Riscos e decisões pendentes

Destino final da fila suspensa D2, reconciliação manual sem evidência suficiente e perda de cursor/dedupe; bloqueio deve ser contextual. D1/D3/D4/D5 resolvidas; D2 parcialmente resolvida (somente descarte definitivo versus retorno da fila suspensa pendente). T1/T2 preservados no contrato; não recriar decisões já aprovadas de autoridade/EOF/pacote.

## Autonomia e conclusão

Implementação apenas com autorização específica do proprietário. Uma autorização de fase não autoriza a próxima. Dentro do lote autorizado, tarefas mecânicas e testes podem ser delegados consecutivamente com ownership exclusivo; parar no gate de decisão técnica/funcional/visual indicado, sem inventar política. Nenhuma etapa foi iniciada por este planejamento.

## Histórico preservado

O ticket anterior era exclusivamente planejado, sem implementação ou validação. A revisão atual detalha esse escopo mantendo ID e posição canônica. A antiga decisão aberta de autoridade em G4 foi resolvida funcionalmente pelo proprietário no contrato pareado; D1–D5 foram posteriormente revisadas pelo proprietário: D1/D3/D4/D5 resolvidas e D2 parcialmente resolvida, conforme o contrato vigente. Não há resultados de testes novos nesta atualização documental.

## Aceite adicional — decisões funcionais aprovadas

Aplicar os cenários DEC-01–05 da [matriz](../../paired-mode-execution-plan.md) conforme o impacto deste ticket: resultados mistos não alteram rodadas/rotação; takeover suspende a fila local, sem importação ou execução automática; vez ativa impede offline até conclusão ou Stop All explicitamente confirmado; EOF/Avançar da última promovem automaticamente uma vez, Stop All não promove; cadastro inexistente comprovado é bloqueado conectado, e offline aceita registro não verificado com revalidação antes do playback. D1/D3/D4/D5 resolvidas, D2 parcialmente resolvida. Preservar a pendência final de descarte versus retorno da fila suspensa. Testes apenas planejados, sem execução nesta atualização.
