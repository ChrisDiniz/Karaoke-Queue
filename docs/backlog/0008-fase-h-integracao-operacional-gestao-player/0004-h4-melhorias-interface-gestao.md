# 0008/0004 — H4: Melhorias da interface de Gestão

## Identificação

- Ticket: 0008/0004
- Ticket pai: 0008 — Fase H: Integração operacional Gestão + Player
- Etapa canônica: H4
- Status: Planejado / Não iniciado
- Roadmap: [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)

## Objetivo

Adaptar pontualmente a interface existente de Gestão para operar com o Player remoto, preservando amplamente a UI atual da fila.

## Escopo

- Ajustes aprovados na tela “Vez atual”.
- Informações de música, artista e outros metadados somente conforme os frames e os dados disponíveis no catálogo opcional.
- Controles de reprodução, informações adicionais em itens da fila e estados reais de playback conforme o design aprovado.
- Reutilizar componentes existentes quando não houver mudança aprovada.
- Não reconstruir a interface da Gestão nem inventar layout, metadados, controles ou comportamentos.

## Dependências

- Contratos de comandos/eventos e estados de H2/H3 definidos e aprovados.
- Frames correspondentes existentes no Doop identificados, com descrições e referências aprovadas para os estados implementados.
- Autorização explícita do proprietário para iniciar H4.

## Decisões aprovadas

- A UI atual da fila será amplamente preservada; o escopo é de melhorias pontuais.
- Doop e suas descrições aprovadas são a fonte de verdade visual.
- Catálogo é opcional; não presumir título/artista para todas as músicas.
- Não implementar parte cujo frame esteja ausente, ambíguo ou sem aprovação; solicitar a referência.

## Pendências

- Identificar no Doop, no início da implementação, os frames específicos de Vez atual, controles, itens de fila e estados remotos aplicáveis.
- Confirmar quais metadados e estados cada frame cobre; lacunas permanecem fora da implementação até aprovação.

## Riscos

- Expandir o escopo funcional a partir de uma lista descritiva sem suporte no Doop.
- Alterar composição/comportamento da fila aprovada ou exibir metadados não disponíveis.
- Divergência visual entre Electron renderizado e Doop apesar de equivalência estrutural do DOM/CSS.

## Critérios de conclusão

- Somente diferenças previstas em frames/descrições aprovados foram implementadas.
- Componentes e comportamentos sem alteração de design permanecem preservados.
- Estados e controles refletem contratos reais de H2/H3.
- Comparação visual renderizada Electron × Doop e regressões funcionais foram registradas separadamente.
- Aprovação visual manual do proprietário permanece um gate explícito.

## Validação prevista

Identificar e rever frames/descrições e HTML editável no Doop; comparar screenshots reais do Electron e Doop em 1280×800 ou dimensão de referência; testar interação, estados, comandos, metadados ausentes/disponíveis e regressões da fila. Aprovação manual do proprietário.

## Histórico de execução

Ticket planejado. Os frames correspondentes foram informados como existentes, mas não foram identificados nem validados para implementação nesta reorganização documental. Nenhuma implementação começou.

## Referências

- [Roadmap Standalone/Combined](../../standalone-player-roadmap.md)
- [Standalone player UI plan](../../standalone-player-ui-plan.md)
- [Remote player architecture](../../remote-player-architecture.md)
- [Player playback](../../player-playback.md)
- [Music catalog](../../music-catalog.md)
