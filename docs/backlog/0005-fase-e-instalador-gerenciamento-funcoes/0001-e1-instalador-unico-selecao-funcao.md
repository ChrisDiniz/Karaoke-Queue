# 0005/0001 — E1: Instalador único e seleção no primeiro uso

## Identificação

- Ticket: 0005/0001
- Ticket pai: 0005 — Fase E: Consolidação de funções, instalador e gerenciamento
- Etapa canônica: E1
- Status: Planejado / Não iniciado
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Auditar, aprovar e implementar um único instalador Windows Electron Builder/NSIS e um único executável de produção. A função não é escolhida durante a instalação NSIS: na primeira abertura do aplicativo, o onboarding apresenta Reprodutor (`player`) ou Tudo em um (`combined`) no frame aprovado `rKUlA0rV8m`, seguido pelo frame `gFR_COs4VP` para configurar a biblioteca de vídeos e o catálogo CSV opcional. `controller` é somente compatibilidade transitória e não é opção futura.

## Escopo

- Reutilizar Electron Builder/NSIS existente quando adequado.
- Manter um instalador Windows e um executável; não criar instaladores ou launchers de produção separados por função.
- No primeiro uso, apresentar a escolha Reprodutor/Tudo em um, seguida da configuração da biblioteca e do catálogo CSV opcional. A biblioteca pode ser configurada depois em Opções.
- Persistir a função em local definido pela estratégia E1; reinicializações e updates não repetem seleção nem recriam onboarding já concluído.
- Não oferecer troca de função em Configurações; mudanças posteriores pertencem à manutenção do instalador.
- Antes de mudanças relevantes de instalação, permissões, exclusividade ou migração, auditar e submeter à aprovação explícita a estratégia: instalação por usuário/máquina, múltiplas contas, persistência/localização da função, instalações/modos legados, `userData`, bancos, biblioteca, catálogo, locks, recovery, atualização e manutenção.
- Definir como a escolha e a configuração inicial lidam com falhas parciais; não criar instalação, writer ou autoridade paralela, nem marcar onboarding concluído antes do estado necessário estar confirmado.
- Avaliar permissões para configuração compartilhada e atalhos globais; não exigir privilégios administrativos silenciosamente. Especificar consistência da escolha entre contas conforme o escopo aprovado, sem tratar `userData` por usuário como exclusividade do computador.
- Mapear upgrade, reinstalação, mudança de função, rollback, preservação de dados e recuperação de falha parcial sem presumir conversão de bancos ou fusão de perfis.
- Preservar SQLite, sessões, histórico, biblioteca, catálogo, preferências, recovery e dados de qualquer função anterior.
- Uma função instalada/ativa por computador é a regra de produto; E3 implementa e valida sua garantia técnica no escopo aprovado. E1 não declara a exclusividade técnica concluída.
- Auditar `.github/workflows/` antes de propor CI novo; preferir reutilizar build Windows/NSIS e artifact de PR existente. Artifact de validação deve identificar commit/fingerprint e não publicar Release, fazer deploy/push ou usar credenciais reais de assinatura.

## Dependências

- Fases C e D concluídas e aprovadas.
- [E0 — Consolidação Controller → Combined](0000-e0-consolidacao-controller-combined.md) concluída e aprovada; o alvo E1 parte das duas funções finais `player` e `combined`.
- Autorização explícita do proprietário para iniciar E1.
- Aprovação explícita do proprietário para a estratégia técnica de instalação, função, dados e recuperação antes de implementar o instalador; a auditoria/proposta é parte inicial desta etapa.

## Critérios de conclusão

- Auditoria/estratégia cobrem instalação por usuário/máquina, privilégios, contas Windows, locks, função persistida, modos legados, localização/proteção de dados, upgrades, reinstalação, mudança de função, rollback e falha parcial.
- Estratégia e decisões necessárias foram documentadas com evidências e aprovadas pelo proprietário antes de implementar o instalador.
- Há um instalador e um executável; NSIS não pergunta a função. A primeira abertura apresenta somente Reprodutor e Tudo em um nos frames aprovados, iniciando na função escolhida.
- A função fica persistida e restart/update não repetem a escolha; a biblioteca pode ser configurada depois.
- O fluxo oferece configurar biblioteca de vídeos e catálogo CSV opcional; a configuração da biblioteca permanece disponível posteriormente.
- Configurações não trocam a função; mudanças posteriores usam manutenção do instalador.
- Falhas parciais preservam dados e não criam instalação/autoridade paralela; permissões globais e entre contas seguem estratégia aprovada.
- Instalações existentes e dados recebem o tratamento aprovado, sem conversão/fusão presumida.
- Componentes compartilhados necessários permanecem no pacote.
- E1 não se apresenta como validação da garantia de exclusividade entre contas Windows; a implementação e comprovação pertencem a E3.

## Validação prevista

Auditar workflows e a estratégia; após aprovação explícita, construir/instalar em Windows nativo e usar o launcher manual oficial para testar os dois caminhos de primeiro uso com perfis isolados escolhendo a função dentro do onboarding real. Cobrir função persistida em restart/update, catálogo opcional, biblioteca adiada/configurada depois, dados preservados e falhas de seleção/configuração. Não usar dois launchers de produção nem um override que enfraqueça a exclusividade; testes entre contas e garantia pertencem a E3.

## Decisões preservadas

- Um único instalador, duas opções de função.
- Uma função por computador é a regra aprovada de produto; garantia técnica tem etapa própria E3.
- Não trocar a função pelas Configurações; a escolha inicial em onboarding segue os frames aprovados.
- Updates e mudanças de função devem preservar dados; não presumir conversão de bancos ou fusão de perfis.

## Histórico

Derivado da antiga D1 (auditoria e estratégia, preservada como preflight desta etapa) e da antiga D2 (instalador e seleção). Os frames Welcome aprovados posteriormente definiram a seleção inicial no onboarding, substituindo a proposta anterior de selecionar exclusivamente no instalador; a exclusividade foi separada para E3. Implementação não iniciada.

## Referências

- [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)
- [Ticket E3 — Exclusividade por computador](0003-e3-exclusividade-por-computador.md)
- [Windows release process](../../windows-release-process.md)
- [SQLite persistence safety](../../sqlite-persistence-safety.md)
- [Windows native testing](../../windows-native-testing.md)
