# 0005/0002 — E2: Identidade Windows, atalhos e barra de tarefas

## Identificação

- Ticket: 0005/0002
- Ticket pai: 0005 — Fase E: Consolidação de funções, instalador e gerenciamento
- Etapa canônica: E2
- Status: Planejado
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Aplicar a identidade Windows correspondente à função escolhida (Reprodutor ou Tudo em um) mantendo um executável e o instalador comum. A estratégia de ativos, nomes e integração com Windows deve respeitar os frames e aprovações visuais existentes; não inventar ícones ou telas.

## Escopo

- Aplicar o nome apresentado ao usuário e ícone de atalho apropriados à função, mantendo as duas funções no mesmo executável.
- Criar/atualizar somente o atalho correspondente na área de trabalho e no menu Iniciar, conforme a escolha persistida e o escopo de permissões aprovado.
- Aplicar título e ícone da janela e avaliar a identidade da barra de tarefas pelo suporte real do Electron/Windows, incluindo AppUserModelID quando apropriado.
- Testar as APIs disponíveis do Electron/Windows em versão empacotada; documentar quais superfícies aceitam identidade dinâmica.
- O instalador/ícone incorporado ao `.exe` pode manter identidade genérica. Não modificar binários já instalados para trocar o ícone e não presumir que atualizar um atalho altere o executável ou todas as superfícies da taskbar.
- Definir tratamento recuperável/idempotente para falha parcial ao aplicar nome, atalho, ícone, janela ou taskbar; só reportar identidade aplicada quando as superfícies necessárias estiverem confirmadas.
- Evitar atalhos duplicados, incorretos ou inconsistentes.
- Garantir que atualizações não recriem atalhos da função errada.
- Preservar a configuração de função estabelecida pela E1.

## Dependências

- E1 funcional e função instalada/persistida segundo a estratégia aprovada em E1.
- Autorização explícita do proprietário para iniciar E2.

## Atividades planejadas

- Auditar comportamento de AppUserModelID, ícone/título de janela, atalhos e taskbar antes de escolher as APIs; separar identidade genérica do executável da identidade por função.
- Aplicar nome/descrição, ícone de atalho, título/ícone de janela, AppUserModelID/taskbar e destinos de acordo com a função persistida e estratégia E1.
- Testar os dois modos com o launcher manual oficial e perfis isolados; validar atalhos/identidade no Windows nativo sem criar launcher por função.
- Verificar persistência após restart/update e atualização dos atalhos pela manutenção E4, sem modificar `.exe` instalado.
- Injetar falhas nas etapas de atualização de identidade/atalhos e confirmar recuperação sem atalhos duplicados ou estado silenciosamente divergente.

## Critérios de conclusão

- As superfícies Windows que suportam identidade por função (nome, atalho, janela e taskbar conforme APIs testadas) correspondem à função escolhida; limites da identidade genérica incorporada no `.exe` ficam explícitos.
- Somente o atalho da função escolhida existe nos escopos aprovados após configuração/alteração; nenhum atalho paralelo é criado por permissões silenciosas.
- Atualizações preservam a função e não recriam atalhos incorretos ou duplicados.
- A identidade visual é mantida sem criar um sistema de instalação separado desnecessário.

## Validação prevista

Em Windows nativo, inspecionar nome/ícone/destino dos atalhos Desktop e Start Menu, título/ícone da janela e taskbar/AppUserModelID em cada função. Confirmar persistência após restart/update. Testar a troca somente após E4 implementar manutenção. Usar um mesmo launcher manual com perfis separados para os dois cenários de produto; testes automatizados devem usar o modo de produção empacotado e respeitar a estratégia E3.

## Decisões aprovadas

- Reprodutor e Tudo em um terão identidade visual distinguível.
- Só os atalhos da função selecionada serão criados.
- Componentes compartilhados não exigem aplicativos ou instaladores independentes.

## Pendências

- Ativos finais de ícones, nomes e descrições podem depender de aprovação visual do proprietário.
- Comportamento de atualização de atalhos deve seguir a estratégia aprovada na E1 e a função estabelecida na E1.

## Riscos

- Metadados de pacote ou atalhos podem divergir da função efetivamente configurada.
- Uma atualização pode recriar atalhos legados de outra função se o estado de instalação não for consultado corretamente.

## Histórico

Ticket planejado e reorganizado antes do início da antiga Fase D (instalador, agora Fase E). Nenhuma implementação ou validação foi iniciada.

## Referências

- [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)
- [Ticket E1 — Instalador e estratégia](0001-e1-instalador-unico-selecao-funcao.md)
- [Ticket E1 — Instalador e estratégia](0001-e1-instalador-unico-selecao-funcao.md)
- [Windows release process](../../windows-release-process.md)
