# 0008/0005 — H5: Validação operacional remota

## Identificação

- Ticket: 0008/0005
- Ticket pai: 0008 — Fase H: Integração operacional Gestão + Player
- Etapa canônica: H5
- Status: Planejado / Não iniciado
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Determinar, com evidências integradas, se a operação remota da Gestão está pronta para o primeiro release controlado de H7.

## Escopo

- Gestão operacional, mesas/cantores, fila inteligente, prioridades e histórico.
- Controles e Player remoto, estados/eventos e metadados disponíveis.
- Persistência, desconexão/reconexão, recovery e consistência entre dois computadores.
- Regressões diretamente relacionadas aos caminhos integrados.
- A validação desta etapa é remota; não inclui a reprodução local integrada de H8.

## Dependências

- H1–H4 concluídas e aprovadas.
- Fase G e contratos/capacidades remotas relevantes aprovados.
- Decisão G4 resolvida para os cenários testados que exijam política de autoridade/reconciliação.
- Autorização explícita do proprietário para iniciar H5.

## Decisões aprovadas

- Prioridade é Gestão (Combined) em um computador e Player (Standalone) em outro.
- G6 valida transporte/estado, mas não substitui a operação integrada H5.
- H5 fornece evidências para H7; não declara aprovação humana automática.
- Playback local integrado não é requisito nem cenário de aceite de H5.

## Pendências

- Disponibilidade de dois computadores Windows, rede local, MP4, perfis e bancos isolados.
- Critérios de decisões G4 que dependam de aprovação específica.
- Validação presencial do proprietário ocorre após a disponibilização controlada, conforme H7.

## Riscos

- Diferença entre testes isolados de transporte e condições reais de rede/uso.
- Perda ou duplicação de apresentação, avanço indevido, estado visual divergente ou dados não persistidos.
- Resultados técnicos automatizados podem não revelar problemas operacionais do estabelecimento.

## Critérios de conclusão

- Eventos/comandos correlacionados e sem perda/duplicação de apresentações.
- Nenhum avanço indevido; Stop/erro/desconexão não são conclusão natural.
- Controles e estados visuais correspondem ao playback observado e a contratos aprovados.
- Falhas de rede e recovery preservam a integridade dos dados operacionais.
- Evidências, ambiente, falhas, limitações e regressões são registradas para decisão do proprietário sobre H7.

## Validação prevista

Dois computadores reais na rede local, Electron e IPC reais, MP4 real, SQLite real, gestão de fila/histórico, metadados e cenários de desconexão/reconexão/recovery. Separar resultados técnicos dos testes humanos e audiovisuais do proprietário.

## Histórico de execução

Ticket planejado. O antigo ticket H5 incluía cenários locais e remotos; a organização atual limita este ticket à operação remota. Nenhuma validação foi iniciada.

## Referências

- [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)
- [Ticket H1 — Gestão Combined preparada para operação remota](0001-h1-gestao-operacional.md)
- [Ticket H2 — Player remoto](0002-h2-integracao-player-remoto.md)
- [Ticket H3 — Autoridade e sincronização](0003-h3-autoridade-sincronizacao-operacional.md)
- [Ticket H4 — UI da Gestão](0004-h4-melhorias-interface-gestao.md)
- [Ticket G6 — Validação remota](../0007-fase-g-comunicacao-remota-segura/0006-g6-validacao-remota.md)
- [Windows native testing](../../windows-native-testing.md)
