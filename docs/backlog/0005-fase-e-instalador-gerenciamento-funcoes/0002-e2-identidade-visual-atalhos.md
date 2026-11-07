# 0005/0002 — E2: Identidade visual e atalhos

## Identificação

- Ticket: 0005/0002
- Ticket pai: 0005 — Fase E: Instalador e gerenciamento de funções
- Etapa canônica: E2
- Status: Planejado
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Aplicar a identidade visual adequada à função instalada e manter atalhos coerentes com a função selecionada.

## Escopo

- Criar/aplicar ícones distintos para Reprodutor e Gestão.
- Usar nomes e descrições apropriados a cada função.
- Criar somente os atalhos da função escolhida na área de trabalho e no menu Iniciar.
- Evitar atalhos duplicados, incorretos ou inconsistentes.
- Garantir que atualizações não recriem atalhos da função errada.
- Preservar a configuração de função estabelecida pela E1.

## Dependências

- E1 funcional e função instalada/persistida segundo a estratégia aprovada em E1.
- Autorização explícita do proprietário para iniciar E2.

## Atividades planejadas

- Aplicar os ativos e metadados de identidade definidos para cada função no instalador/pacote.
- Configurar atalhos compatíveis com a função persistida.
- Verificar manutenção/update de atalhos em instalação, atualização e troca de função.
- Validar nomes, ícones e destinos em Windows nativo.

## Critérios de conclusão

- Cada função apresenta nome, descrição e ícone próprios conforme a identidade aprovada.
- Somente atalhos da função escolhida existem após instalação/alteração.
- Atualizações preservam a função e não recriam atalhos incorretos ou duplicados.
- A identidade visual é mantida sem criar um sistema de instalação separado desnecessário.

## Validação prevista

Inspecionar atalhos da área de trabalho e menu Iniciar e iniciar cada destino instalado em Windows nativo. Testar atualização e alternância apenas após E4 implementar o fluxo correspondente.

## Decisões aprovadas

- Reprodutor e Gestão terão identidade visual distinguível.
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
