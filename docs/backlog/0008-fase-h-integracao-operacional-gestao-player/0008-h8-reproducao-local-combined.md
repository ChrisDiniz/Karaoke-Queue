# 0008/0008 — H8: Reprodução local integrada ao Combined

## Identificação

- Ticket: 0008/0008
- Ticket pai: 0008 — Fase H: Integração operacional Gestão + Player
- Etapa canônica: H8
- Status: Planejado / Não iniciado
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Depois do primeiro marco de release remoto H7, permitir que a Gestão e o Player reproduzam localmente no mesmo computador.

## Escopo

- Reutilizar engine Chromium, biblioteca, catálogo e serviços técnicos apropriados.
- Integrar comandos/eventos de playback local à autoridade operacional do Combined.
- Preservar fila inteligente, prioridade, apresentação, histórico, SQLite e recovery.
- Reutilizar interfaces aprovadas e manter uma única fila autoritativa e um único writer.
- Integrar controles, estados e falhas locais sem criar sequência/fila concorrente.
- Validar uso local e, quando aplicável/aprovado, tela estendida.

## Dependências

- H7 concluída como marco do primeiro release remoto.
- Contratos de autoridade/sincronização e capacidades de playback aprovados em H2/H3.
- H8 não é dependência de H7 e não pode bloquear o primeiro release remoto.
- Autorização explícita do proprietário para iniciar H8.

## Decisões aprovadas

- Reprodução local integrada é posterior ao primeiro release controlado remoto.
- Uso inicial previsto para testes locais do proprietário; releases futuros dependem de validação própria e autorização.
- Não criar segunda fila operacional nem writer concorrente.
- A UI local já existente será preservada, mas permanece bloqueada/inacessível até esta etapa.

## Pendências

- Definir integração dos controles/eventos locais dentro dos contratos autoritativos validados para H2/H3.
- Identificar frames e descrições Doop aplicáveis se houver mudança visual; não inventar interface.
- Escopo de testes com múltiplos monitores deve ser confirmado conforme disponibilidade e aprovação.

## Riscos

- Playback local criar caminho de estado diferente do remoto ou duplicar fila/writer.
- EOF/Stop/erro local ser correlacionado incorretamente com apresentação/histórico.
- Mudança local introduzir regressão na operação remota já testada em H5/H7.

## Critérios de conclusão

- Gestão controla playback local no mesmo computador sem segunda fila ou writer.
- Playback e eventos seguem a autoridade, correlação, persistência e recovery aprovadas.
- Histórico e fila permanecem íntegros e sem avanço indevido.
- Regressões remotas são verificadas e limitações de release posterior são registradas.
- Qualquer mudança visual é comparada com Doop e aprovada manualmente pelo proprietário.

## Validação prevista

Electron real, IPC, SQLite e MP4 reais; testes de playback/controles/EOF/Stop/falhas, persistência, concorrência, recovery, fila/histórico e regressões remotas. Validar tela estendida quando pertinente e aprovada.

## Histórico de execução

Planejado. Corresponde ao antigo ticket de reprodução local H2, adiado para depois do primeiro release remoto. Nenhuma implementação ou validação foi iniciada.

## Referências

- [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)
- [Ticket H3 — Autoridade e sincronização operacional](0003-h3-autoridade-sincronizacao-operacional.md)
- [Ticket H7 — Primeiro release controlado](0007-h7-primeiro-release-testes-karaoke.md)
- [Remote player architecture](../../remote-player-architecture.md)
- [Player playback](../../player-playback.md)
- [SQLite persistence safety](../../sqlite-persistence-safety.md)

## Complemento do planejamento pareado — 2026-11-11

Status mantido: Planejado / Não iniciado. [Contrato](../../paired-mode-contract.md), [sequência](../../paired-mode-execution-plan.md) e [interfaces](../../paired-mode-ui-plan.md) passam a integrar a referência desta etapa. F permanece encerrada; nenhum teste iniciado.

- Lotes: H8.1 — Adapter local; H8.2 — integração; H8.3 — regressões.
- Escopo adicional diretamente relacionado: Reutilizar os contratos de vez, ocorrência, tentativa, resultados duráveis e autoridade validados remotamente, trocando apenas o adapter de transporte apropriado. Não conectar fila Standalone como segunda fila Gestão.
- Testes e aceite adicionais: MP4/SQLite/IPC reais; EOF/Avançar/troca/Stop All/restart e regressão remota H5. Tela estendida só no escopo aprovado.
- Módulos: adapters/serviços Main de playback, journal/outbox G3, aplicação e projeções Gestão, scripts oficiais de teste/build quando afetados.
- Dependências: H7 concluída e autorização H8; não é gate de H7.
- Riscos: crescimento do ledger/compatibilidade e regressões não podem ser ocultados por limpeza de dados ou enfraquecimento de teste.
- Interfaces: reutilizar referências aprovadas; qualquer variante ainda ausente deve ser desenhada/revisada antes do lote visual.
- Autonomia: executar apenas o lote autorizado; decisões de produto/visual e homologação são do proprietário. Testes por impacto podem ser delegados com ownership isolado; não avançar fase automaticamente.
