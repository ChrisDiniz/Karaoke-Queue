# 0005/0000 — E0: Consolidação Controller → Combined

## Identificação

- Ticket: 0005/0000
- Ticket pai: 0005 — Fase E: Consolidação de funções, instalador e gerenciamento
- Etapa canônica: E0
- Status: Planejado / Não iniciado
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Consolidar os caminhos de produto Controller e Combined em uma única função final `combined`, preservando integralmente a Gestão existente e sua autoridade operacional única no Main, estabelecida na D4.3. Ao final da E0, as funções finais de produto serão somente `player` e `combined`.

## Escopo

- Auditar os caminhos atuais `controller` e `combined` antes de qualquer alteração de código, identificando diferenças reais de startup, composição, IPC, janelas, serviços, permissões e persistência.
- Eliminar Controller como função independente selecionável do produto; não remover seu domínio operacional nem tratá-lo como código descartável.
- Preservar mesas, cantores, sessões, histórico, fila, prioridades, Round Robin, regras de conclusão/cancelamento e SQLite.
- Preservar a única autoridade operacional da Gestão no Main; não criar uma segunda aplicação, fila, writer ou caminho concorrente de persistência.
- Manter compatibilidade segura com configurações e instalações legadas `controller`, somente na medida tecnicamente necessária; essa compatibilidade não representa uma terceira função selecionável.
- Não apagar, converter, fundir ou migrar dados automaticamente sem estratégia validada e aprovação aplicável. Registrar como configurações legadas serão lidas e preservadas.
- Adaptar testes, contratos, documentação e launchers existentes conforme consumidores reais identificados pela auditoria.
- Preservar integralmente a operação Standalone (`player`) e seus contratos, sequência e dados.
- Executar regressões automatizadas e validação Windows nativa apropriadas, sem declarar resultados antes da execução.

## Fora de escopo

- Instalador NSIS, onboarding de escolha `player`/`combined`, identidade Windows, exclusividade entre contas e manutenção do instalador: E1–E4, sujeitos aos gates próprios.
- HTTPS/WSS, pairing, autenticação de dispositivos, sincronização e autoridade remota: Fase G.
- Integração de reprodução local à Gestão Combined: H8.
- Alteração das regras de negócio, V1, dados operacionais ou UI sem requisito aprovado.

## Dependências e gates

- Fases C e D concluídas e aprovadas; a D4.3 estabelece o host Main-side e o writer operacional único que devem ser preservados.
- Autorização explícita do proprietário para iniciar a implementação da E0.
- Auditoria comparativa dos caminhos Controller e Combined antes de escolher a estratégia de consolidação.
- E1 somente começa após conclusão e aprovação explícita da E0.

## Atividades planejadas

1. Mapear entry points, modos/capacidades, startup, janela e preload, handlers IPC, licenciamento, serviços, banco, lock e shutdown em ambos os caminhos.
2. Comparar comportamento e contratos, identificando diferenças necessárias, compatibilidade legada e consumidores que dependem de `controller`.
3. Propor e implementar a menor consolidação segura que deixe `combined` como única função de Gestão, sem antecipar E1.
4. Adaptar testes e launchers para não apresentarem Controller como terceira função final, mantendo cobertura de compatibilidade legada necessária.
5. Rodar regressões focadas e completas aplicáveis, incluindo Electron real, persistência isolada e runner Windows nativo oficial.
6. Revisar dados, ownership, authority, shutdown e referências documentais antes de solicitar aprovação de encerramento.

## Critérios de conclusão

- O inventário demonstra as diferenças reais entre os caminhos `controller` e `combined` e documenta as decisões de compatibilidade.
- Apenas `player` e `combined` permanecem como funções finais selecionáveis; qualquer suporte `controller` restante é interno e justificado.
- Mesas, cantores, sessões, histórico, fila, Round Robin, prioridades, persistência e recuperação permanecem operacionais sob `combined`.
- A Gestão continua com uma única `KaraokeApplication`/autoridade Main-side e um único writer operacional; não há coexistência concorrente de produção.
- Configurações legadas `controller` são tratadas sem perda ou conversão automática de dados não aprovada.
- Standalone continua independente da fila operacional e sem regressões.
- Suítes pertinentes e validação Windows nativa executadas, resultados e limitações documentados; critérios funcionais só recebem PASS com evidência.
- A documentação confirma que E1 depende da aprovação da E0 e que H1 não repetirá sua consolidação de função.

## Validação prevista

Usar testes unitários de capacidades/configuração e compatibilidade; integração Main/IPC com Electron real; regressões da Gestão para sessões, fila, prioridades, Round Robin, SQLite, recuperação e shutdown; regressões do Player; perfis/bancos isolados; launcher manual oficial e runner Windows nativo conforme cobertura necessária. Distinguir testes de harness, integração e produção real. Nenhum resultado foi executado ou aprovado nesta etapa documental.

## Decisões preservadas

- Uma única função final de Gestão: `combined`; `controller` não é terceira opção de produto.
- Preservar o domínio Controller e sua implementação operacional necessária à Gestão.
- Preservar a autoridade Main-side e o corte single-writer realizados na D4.3.
- Não antecipar instalação, onboarding, identidade, exclusividade, rede ou reprodução local H8.
- A mudança de escopo transfere para E0 a remoção de Controller como função independente, anteriormente atribuída ao planejamento de H1; H1 permanece responsável pela Gestão no contexto de integração operacional remota.

## Riscos

- Diferenças não inventariadas entre os caminhos podem alterar startup, licenciamento, IPC ou dados de perfis existentes.
- Um alias legado pode ser confundido com uma terceira função ou criar uma segunda autoridade se aplicado fora do Main.
- Testes que assumam somente um modo podem perder cobertura de compatibilidade; testes que mantenham Controller como opção de produto podem mascarar a consolidação incompleta.
- Mudanças de schema, localização de dados, exclusividade por computador e instalação pertencem aos gates E1–E3; não devem ser improvisadas nesta etapa.

## Histórico

Nova etapa aprovada para anteceder E1. O planejamento anterior deixava a retirada de Controller como função final para H1; o proprietário transferiu essa consolidação para E0, antes do instalador, preservando em H1 as atividades próprias da integração operacional remota. A Fase D segue concluída e aprovada; E0 continua planejada, não iniciada.

## Referências

- [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)
- [Ticket E1 — Instalador único e abertura inicial](0001-e1-instalador-unico-selecao-funcao.md)
- [Ticket H1 — Gestão Combined preparada para operação remota](../0008-fase-h-integracao-operacional-gestao-player/0001-h1-gestao-operacional.md)
- [D4 — Auditoria e arquitetura Main](../../d4-main-remote-architecture-preparation.md)
- [Remote Player architecture](../../remote-player-architecture.md)
- [SQLite persistence safety](../../sqlite-persistence-safety.md)
- [Windows native testing](../../windows-native-testing.md)
