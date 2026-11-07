# 0005/0001 — E1: Instalador único com seleção da função

## Identificação

- Ticket: 0005/0001
- Ticket pai: 0005 — Fase E: Instalador e gerenciamento de funções
- Etapa canônica: E1
- Status: Planejado / Não iniciado
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Implementar um único instalador Windows que permita selecionar Reprodutor (Standalone) ou Gestão (Combined) e inicie diretamente na função escolhida.

## Escopo

- Reutilizar Electron Builder/NSIS existente quando adequado.
- Oferecer ambas as funções no mesmo instalador.
- Não apresentar seleção de função no onboarding nem nas Configurações do aplicativo.
- Como parte de E1 e antes de implementar o instalador, auditar e submeter à aprovação a estratégia de instalação/manutenção: Electron Builder/NSIS, instalação por usuário ou máquina, privilégios e limitações Windows, múltiplas contas, detecção de instalação existente, persistência da função, modos legados `controller`/`player`/`combined`, `userData`, perfis, bancos, biblioteca, catálogo, locks e recovery.
- Mapear upgrade, reinstalação, mudança de função, rollback, preservação de dados e recuperação de falha parcial sem presumir conversão de bancos ou fusão de perfis; registrar testes e decisões ainda pendentes.
- Implementar a seleção de Reprodutor ou Gestão no instalador único e inicializar diretamente na função escolhida, conforme a estratégia aprovada.
- Tratar instalações existentes segundo essa estratégia e preservar componentes compartilhados necessários.
- A garantia de exclusividade por computador, inclusive entre contas Windows conforme a decisão aprovada, é implementada e validada em E3; E1 não declara essa garantia concluída.

## Dependências

- Fases C e D concluídas e aprovadas.
- Autorização explícita do proprietário para iniciar E1.
- Aprovação explícita do proprietário para a estratégia técnica de instalação, função, dados e recuperação antes de implementar o instalador; a auditoria/proposta é parte inicial desta etapa.

## Critérios de conclusão

- Auditoria/estratégia cobrem instalação por usuário/máquina, privilégios, contas Windows, locks, função persistida, modos legados, localização/proteção de dados, upgrades, reinstalação, mudança de função, rollback e falha parcial.
- Estratégia e decisões necessárias foram documentadas com evidências e aprovadas pelo proprietário antes de implementar o instalador.
- Um instalador permite escolher Standalone ou Combined e inicializa diretamente na função escolhida.
- A função não é escolhida/trocada no onboarding ou em Configurações.
- Instalações existentes e dados recebem o tratamento aprovado, sem conversão/fusão presumida.
- Componentes compartilhados necessários permanecem no pacote.
- E1 não se apresenta como validação da garantia de exclusividade entre contas Windows; a implementação e comprovação pertencem a E3.

## Validação prevista

Auditar e revisar proposta/decisões de instalação e dados; após aprovação explícita, executar build e instalação interativa em Windows nativo com perfis temporários isolados, seleção de cada função, inicialização direta, detecção de instalação existente e preservação conforme a estratégia. Testes da garantia entre contas pertencem a E3.

## Decisões preservadas

- Um único instalador, duas opções de função.
- Uma função por computador é a regra aprovada de produto; garantia técnica tem etapa própria E3.
- Não alterar função pelo onboarding ou pelas Configurações.
- Updates e mudanças de função devem preservar dados; não presumir conversão de bancos ou fusão de perfis.

## Histórico

Derivado da antiga D1 (auditoria e estratégia, preservada como preflight desta etapa) e da antiga D2 (instalador e seleção); a implementação da exclusividade foi separada para E3. Nenhuma estratégia nova foi aprovada nesta reorganização; implementação não iniciada.

## Referências

- [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)
- [Ticket E3 — Exclusividade por computador](0003-e3-exclusividade-por-computador.md)
- [Windows release process](../../windows-release-process.md)
- [SQLite persistence safety](../../sqlite-persistence-safety.md)
- [Windows native testing](../../windows-native-testing.md)
