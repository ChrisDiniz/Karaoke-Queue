# 0005/0005 — E5: Atualizações, migração e validação

## Identificação

- Ticket: 0005/0005
- Ticket pai: 0005 — Fase E: Consolidação de funções, instalador e gerenciamento
- Etapa canônica: E5
- Status: Planejado
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Implementar e validar os fluxos de atualização, migração, rollback e preservação de dados conforme a estratégia definida e aprovada na E3.

## Escopo

- Atualização entre versões, reinstalação e migração de instalações legadas.
- Preservação da função escolhida, `userData`, SQLite, sessões, histórico, filas persistidas quando aplicável, biblioteca, catálogo, preferências e dados de recovery.
- Preservação da escolha persistida em updates/reinstalação sem reexibir a seleção inicial ou redefinir a função; configuração de biblioteca adiada também permanece segura.
- Testes de identidade Windows (atalhos, título/ícone da janela e taskbar conforme suporte), troca via manutenção, reinicialização e isolamento entre perfis/contas conforme E1/E3.
- Rollback e recuperação após falha conforme a estratégia E3.
- Verificação em Windows nativo com perfis isolados.
- Não inventar conversão automática de bancos ou fusão de perfis.
- Usar um único launcher manual oficial e perfis separados para validar Reprodutor e Tudo em um; qualquer override de automação fica restrito a perfis de teste e não enfraquece exclusividade de produção.
- Auditar workflows GitHub Actions existentes antes de adicionar CI; reutilizar o build Windows/NSIS quando aplicável e identificar artifacts de validação por commit/fingerprint.
- Não publicar GitHub Release automaticamente, fazer deploy/push nem usar credenciais reais de assinatura para os artifacts E/F. Distinguir smoke de executável empacotado de teste de instalação NSIS.

## Dependências

- E3: estratégia de migração e preservação documentada e aprovada.
- E1: instalador e seleção/exclusividade funcionais.
- E2: identidade e atalhos funcionais.
- E4: manutenção e alteração de função funcionais.
- Autorização explícita do proprietário para iniciar E5.

## Atividades planejadas

- Implementar os caminhos de update, reinstalação e migração aprovados.
- Validar persistência da função e integridade dos dados antes/depois de cada fluxo.
- Exercitar rollback e recuperação de falhas parciais sem sobrescrever perfis ou apagar evidências.
- Testar troca de função e atualização de atalhos após reinicialização.
- Registrar compatibilidade, limitações e evidências do pacote instalado.

## Critérios de conclusão

- Update e reinstalação preservam função, `userData` e dados cobertos pela estratégia.
- Reinício e update mantêm a função e não repetem onboarding; biblioteca/catálogo e preferências persistem segundo a estratégia aprovada.
- Migração legada segue decisões aprovadas, sem conversão ou fusão presumida.
- Identidade/atalhos seguem a mesma função após update ou manutenção; artifacts automatizados apontam ao commit/fingerprint validado e não criam Releases.
- Rollback/recuperação são exercitados nos cenários definidos em E3 e não causam perda silenciosa de dados.
- Troca de função, atalhos e persistência são verificados após reinicialização.
- Resultados de testes Windows e limites de compatibilidade ficam registrados.

## Validação prevista

Executar instalações/updates/reinstalações e cenários de migração em Windows nativo com perfis e bancos temporários isolados. Inspecionar dados antes/depois, testar rollback e recuperação de falhas, confirmar função/atalhos depois de reiniciar e registrar resultados sem declarar produto Combined completo.

## Decisões aprovadas

- Updates preservam a função escolhida e dados existentes.
- Alterar função não apaga os dados da função anterior.
- Não presumir conversão automática de bancos ou fusão de perfis.
- E3 define a estratégia; E5 implementa e valida os fluxos de dados com dependência de E3–E4.
- O Combined operacional completo permanece na Fase H.

## Pendências

- Cenários legados, compatibilidade e rollback dependem das decisões aprovadas em E3.
- Limitações de versão/instalador que exigirem decisão de produto devem ser apresentadas ao proprietário antes de mudar o escopo.

## Riscos

- Atualizações entre versões e instaladores antigos podem deixar dados divergentes ou inacessíveis.
- Downgrade não é estratégia segura de rollback para um banco já alterado.
- Falha parcial pode interromper instalação ou manutenção; dados anteriores devem permanecer recuperáveis conforme E3.

## Histórico

Ticket planejado e retransferido para a Fase E; não iniciado. Nenhuma implementação, migração ou validação foi iniciada.

## Referências

- [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)
- [Ticket E3 — Exclusividade por computador](0003-e3-exclusividade-por-computador.md)
- [Ticket E1 — Instalador único](0001-e1-instalador-unico-selecao-funcao.md)
- [Ticket E2 — Identidade visual e atalhos](0002-e2-identidade-visual-atalhos.md)
- [Ticket E4 — Manutenção e alteração de função](0004-e4-manutencao-alteracao-funcao.md)
- [Windows release process](../../windows-release-process.md)
- [SQLite persistence safety](../../sqlite-persistence-safety.md)
- [Legacy session compatibility](../../legacy-session-compatibility.md)
- [Windows native testing](../../windows-native-testing.md)
