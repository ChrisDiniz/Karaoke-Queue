# 0008/0006 — H6: Performance, estabilidade e endurance

## Identificação

- Ticket: 0008/0006
- Ticket pai: 0008 — Fase H: Integração operacional Gestão + Player
- Etapa canônica: H6
- Status: Planejado / Não iniciado
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Medir e validar performance e estabilidade da operação integrada após a consolidação da Gestão, integração remota e validação operacional.

## Escopo e subetapas

### H6.1 — Auditoria de recursos e baseline

- Medir Main, Renderer, Chromium/GPU e sistema: RAM/heap/memória externa, CPU, processos, buffers/streams, handles, listeners, timers, IPC, snapshots, caches e retenção de `operationId`/Promises.
- Confirmar por inspeção/profiling o que a indexação retém e quando arquivos são abertos.
- Registrar telemetria por processo a cada 5 minutos, tendências e baseline antes de propor metas.
- Não presumir vazamentos nem metas antes de evidência reproduzível.

### H6.2 — Campanhas prolongadas

- Executar campanhas de 8, 12 e 24 horas em máquinas Windows nativas, priorizando sistemas com 8 GB de RAM, HDD e SSD.
- Cobrir centenas de reproduções e trocas no conjunto das campanhas; no mínimo 200 reproduções concluídas e 200 trocas, com distribuição registrada.
- Coletar telemetria a cada 5 minutos e acompanhar crescimento, liberação de recursos, degradação, travamentos e crashes.

### H6.3 — Acervos grandes

- Medir acervos de 1.000, 5.000 e 15.000 vídeos, incluindo cenário aproximado de 70 GB.
- Priorizar Windows nativo, 8 GB de RAM, HDD e SSD.
- Registrar RAM, CPU, disco, scan/indexação, busca, refresh e responsividade; distinguir tamanho lógico de espaço alocado e usar MP4 real em playback.

### H6.4 — Otimizações baseadas em evidências

- Corrigir somente problemas reproduzíveis observados nas auditorias/campanhas.
- Definir metas somente após coletar e revisar o baseline.
- Preservar arquitetura, idempotência e durabilidade; não introduzir TTL/eviction arbitrário de `operationId` que comprometa retries.

### H6.5 — Validação final de performance e estabilidade

- Repetir medições e testes afetados pelas correções no estado final.
- Confirmar as campanhas, os acervos e as métricas previstas; explicar crescimento residual após aquecimento.
- Registrar ambiente, carga, telemetria, incidentes e evidências.
- A conclusão técnica de H6 é requisito obrigatório para H7.

## Dependências e gates

- H1–H5 concluídas e aprovadas.
- H6.1 estabelece baseline antes da definição de metas ou otimizações.
- H6.2 e H6.3 fornecem evidência para H6.4.
- H6.5 verifica o estado final após as correções.
- H6 concluída antes de H7.

## Critérios de conclusão

- Campanhas de 8, 12 e 24 horas completadas sem travamento não recuperado, com telemetria a cada 5 minutos.
- Pelo menos 200 reproduções concluídas e 200 trocas no conjunto, com distribuição registrada.
- Acervos de 1.000, 5.000 e 15.000 vídeos e cenário aproximado de 70 GB executados nas condições previstas, priorizando Windows 8 GB/HDD/SSD.
- RAM, CPU, disco, scan, busca, refresh e responsividade medidos e documentados; diferenças de ambiente e limitações explícitas.
- Otimizações ligadas a defeitos reproduzíveis; nenhuma hipótese é declarada vazamento sem medição.
- Resultado final e limitações registrados antes de H7.

## Histórico

Transferido da campanha antiga C11.2–C11.6. Performance não pertence mais à C11. Nenhuma auditoria, campanha ou otimização foi iniciada nesta reorganização documental.

## Referências

- [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)
- [Biblioteca local de vídeos](../../video-library.md)
- [Reprodução local Chromium](../../player-playback.md)
- [Remote player architecture](../../remote-player-architecture.md)
- [Windows native testing](../../windows-native-testing.md)
