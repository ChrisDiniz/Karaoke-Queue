# 0005/0003 — E3: Exclusividade de uma função por computador

## Identificação

- Ticket: 0005/0003
- Ticket pai: 0005 — Fase E: Consolidação de funções, instalador e gerenciamento
- Etapa canônica: E3
- Status: Planejado / Não iniciado
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Implementar e validar a regra aprovada de uma única função instalada/ativa por computador, incluindo os limites entre contas Windows, conforme a estratégia técnica aprovada.

## Escopo

- Auditar/confirmar Electron Builder/NSIS, instalação por usuário ou por máquina, privilégios, múltiplas contas Windows, instalações existentes, locks e perfis antes de implementar exclusividade.
- Verificar o limite do lock atual por `userData`; não tratá-lo como garantia entre contas/perfis.
- Definir e implementar onde a função escolhida fica persistida e como as contas Windows observam uma escolha consistente dentro do escopo aprovado. Não usar `userData` individual como garantia por computador.
- Avaliar ACL/permissões para estado compartilhado, locks e atalhos globais. Não exigir privilégio administrativo silenciosamente; a estratégia E1 define se instalação por usuário ou máquina atende a regra aprovada.
- Aplicar mecanismo que impeça instalações, processos ou autoridades de função paralelos dentro do escopo aprovado para o computador, preservando um único executável e instalador.
- Proteger configuração da função, `userData`, bancos SQLite, biblioteca, catálogo e recovery; detectar cenários existentes e falhas parciais.
- Preservar componentes compartilhados e dados de funções anteriores. Não converter bancos nem fundir perfis sem decisão aprovada.
- Rejeitar ou recuperar estado parcial sem reportar sucesso antes de confirmar função, exclusividade e dados; não remover atalhos/dados ou deixar locks órfãos silenciosamente.
- Documentar incompatibilidades e resultados entre contas Windows quando o mecanismo aprovado os exigir.

## Dependências e gates

- E1 concluída, incluindo estratégia técnica de instalação/exclusividade e preservação de dados explicitamente aprovada.
- E2 concluída conforme a ordem aprovada do fluxo de instalação e identidade.
- Autorização explícita do proprietário para iniciar E3.

## Atividades

- Revisar a estratégia documentada e aprovada, sem substituir decisões pendentes por hipótese.
- Implementar a garantia de exclusividade conforme o escopo de usuário/máquina definido.
- Testar instalação, seleção no primeiro launch, inicialização e concorrência em perfis e contas Windows reais do escopo aprovado, usando o mesmo launcher manual e/ou executável de produção isolado.
- Testar seleção simultânea, instalação/processo já ativo, reinicialização e reanexação; confirmar que não surgem duas funções/autoridades.
- Exercitar falhas parciais nas etapas de persistência/identidade/atalhos/lock, sem deixar função, atalhos, locks ou dados silenciosamente inconsistentes.
- Testar permissões de estado/atalhos compartilhados sem assumir elevação administrativa.

## Critérios de conclusão

- Uma função por computador é garantida no escopo de contas Windows aprovado e testado.
- O resultado não depende somente do lock por perfil quando a regra exige exclusividade entre perfis/contas.
- Todas as contas cobertas leem a mesma função confirmada; apenas uma instalação/processo autorizado opera por computador conforme a estratégia aprovada.
- Instalações existentes, configurações e bancos são preservados conforme a estratégia aprovada.
- Falhas de instalação/ativação mantêm estado recuperável e são reportadas.

## Histórico

Conteúdo redistribuído das antigas etapas D1 (auditoria/estratégia) e D2 (implementação de instalador/exclusividade). Nenhuma estratégia ou implementação foi aprovada/iniciada nesta reorganização documental.

## Referências

- [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)
- [Ticket E1 — Instalador único](0001-e1-instalador-unico-selecao-funcao.md)
- [Windows release process](../../windows-release-process.md)
- [SQLite persistence safety](../../sqlite-persistence-safety.md)
- [Remote player architecture](../../remote-player-architecture.md)
- [Legacy session compatibility](../../legacy-session-compatibility.md)
- [Windows native testing](../../windows-native-testing.md)
